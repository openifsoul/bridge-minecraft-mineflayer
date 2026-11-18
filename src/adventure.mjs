import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createForestReservations, gatherLogs, returnFromForest, validateResourcePolicy } from "./resources.mjs";

const GATHER = "minecraft.gather-logs";
const RETURN = "minecraft.return-from-forest";
const safeText = (text) => typeof text === "string" && text.trim().length > 0 &&
  text.length <= 180 && !/^\s*\//u.test(text) && !/[\p{Cc}\p{Cf}§]/u.test(text);
const STOP = /^(?:!group\s+stop|!ifsoul\s+(?:stop|wait))$/iu;

export function createAdventure(options, context) {
  if (!options) return;
  const policy = validateResourcePolicy(options.forest, { forest: true });
  const inside = (position) => position && ["x", "y", "z"].every((axis) =>
    Number.isFinite(position[axis]) && position[axis] >= policy.region.min[axis] &&
    position[axis] < policy.region.max[axis] + 1);
  const returnPoints = options.returnPoints ?? {};
  if (Object.entries(returnPoints).some(([name, point]) =>
    !/^[A-Za-z0-9_]{3,16}$/u.test(name) || !inside(point))) {
    throw Error("Choose return points within the approved forest travel region.");
  }
  const reservations = createForestReservations();
  const jobs = new Set();
  const seen = new Set();
  let busy = false;
  let chatEpoch = 0;

  function availability(actor) {
    const { bot } = actor;
    const position = bot.entity?.position;
    return context.playerSeen(bot) && Boolean(bot.pathfinder) &&
      bot.game?.dimension === policy.dimension && inside(position);
  }

  function channels() {
    return [
      { channel: "private", listen: true, react: true, speak: true },
      { channel: "group", listen: true, react: true, speak: true },
      ...(options.publicChat === true && context.group().publicChat === true
        ? [{ channel: "public", listen: true, react: true, speak: false }] : []),
    ];
  }

  function channelPolicy(actor, channel, ...permissions) {
    if (actor?.capability?.expiresAt <= Date.now()) return false;
    const row = actor?.capability?.channelPolicy?.channels.find((candidate) =>
      candidate.channel === channel);
    return permissions.every((permission) => row?.[permission] === true);
  }

  function manifest(actor, revision) {
    const ready = availability(actor);
    return {
      revision: String(revision),
      worldId: createHash("sha256").update(JSON.stringify([
        context.server.host, context.server.port, policy.dimension,
      ])).digest("hex"),
      embodimentId: actor.bot.player.uuid,
      channels: channels(),
      capabilities: [{
        intentId: GATHER,
        category: "minecraft.resources",
        description: "Travel through the approved region and collect logs from the forest.",
        parameters: [
          { name: "resource", type: "choice", required: true, choices: policy.resources },
          { name: "count", type: "quantity", required: true, unit: "items", minimum: 1, maximum: 32 },
        ],
        cancellable: true,
        support: "partial",
        readiness: ready ? "ready" : "unavailable",
        reason: ready
          ? "Configured forest logs only; the NPC retains its own collected items."
          : "The bound player and this NPC must be present in the configured region and dimension.",
      }, {
        intentId: RETURN,
        category: "minecraft.movement",
        description: "Return to this NPC's recorded starting point inside the approved area.",
        parameters: [],
        cancellable: true,
        support: "partial",
        readiness: ready && actor.home ? "ready" : "unavailable",
        reason: "The native route is bounded to the approved region and the recorded start.",
      }],
    };
  }

  async function sync(name, actor, fresh = false) {
    if (!actor.ready || !context.playerSeen(actor.bot)) return false;
    if (actor.syncing) return actor.syncing;
    if (!fresh && Date.now() < (actor.nextSync ?? 0)) return true;
    if (!actor.home && availability(actor)) actor.home = returnPoints[name] ?? actor.bot.entity.position.clone();
    const pending = (async () => {
      try {
        const current = actor.capability;
        if (!current || current.expiresAt <= Date.now()) {
          const reply = await context.call({
            operation: "adventure-ready", name, playerUuid: context.group().player.uuid,
            capabilityManifest: manifest(actor, 1),
          });
          actor.capability = reply.capability;
        } else {
          const next = manifest(actor, Number(current.manifest.revision));
          if (JSON.stringify(next) !== JSON.stringify(current.manifest)) {
            next.revision = String(Number(current.manifest.revision) + 1);
          }
          const reply = await context.call({
            operation: "adventure-capabilities", name, providerId: current.providerId,
            capabilityManifest: next,
          });
          actor.capability = reply.capability;
        }
        return true;
      } catch {
        return false;
      } finally {
        actor.syncing = undefined;
        actor.nextSync = Date.now() + 5000;
      }
    })();
    actor.syncing = pending;
    return pending;
  }

  function stop(actor, reason) {
    if (actor && reason !== "return-requested") actor.queuedReturn = undefined;
    actor?.resourceJob?.controller.abort(Object.assign(new Error(reason), { code: reason }));
  }

  function launch(assignment) {
    if (!assignment || typeof assignment.id !== "string" || seen.has(assignment.id) ||
      ![GATHER, RETURN].includes(assignment.intentId) || seen.size >= 512) return;
    const { name, id, providerId, manifestRevision, policyRevision, intentId, arguments: args } = assignment;
    const actor = context.members.get(name);
    const capability = actor?.capability;
    if (!actor || actor.assignment || !capability ||
      capability.providerId !== providerId || !availability(actor) ||
      !Array.isArray(args)) return;
    const returning = intentId === RETURN;
    if (returning ? !actor.home || args.length !== 0 : args.length !== 2 ||
      args.some((argument) => !argument || !["resource", "count"].includes(argument.name))) return;
    const input = Object.fromEntries(args.map(({ name, value }) => [name, value]));
    if (!returning && (!policy.resources.includes(input.resource) ||
      !Number.isInteger(input.count) || input.count < 1 || input.count > 32)) return;
    if (actor.resourceJob) {
      if (returning && actor.resourceJob.intentId === GATHER && !actor.queuedReturn) {
        actor.queuedReturn = assignment;
        stop(actor, "return-requested");
      }
      return;
    }
    seen.add(id);
    const controller = new AbortController();
    const job = { controller, intentId };
    const request = { id, providerId, manifestRevision, policyRevision, intentId, arguments: args };
    actor.resourceJob = job;
    let checkpoint = 0;
    const evidence = new Map();
    let chain = Promise.resolve();
    let pendingCheck;
    const serialize = (run) => {
      const result = chain.then(run);
      chain = result.catch(() => {});
      return result;
    };
    const current = () => !context.signal.aborted && context.active() &&
      context.members.get(name) === actor && availability(actor);
    const authorize = () => {
      pendingCheck ??= serialize(async () => {
        if (!current() || controller.signal.aborted) return false;
        const requestedAt = context.revision();
        const body = { operation: "adventure-action-check", name, ...request, checkpoint: ++checkpoint };
        try {
          const reply = await context.call(body);
          return current() && reply.authorized === true;
        } catch (error) {
          if (!context.isRevisionChange(error)) return false;
          const until = Date.now() + 2000;
          while (current() && context.revision() === requestedAt && Date.now() < until) {
            await delay(75);
          }
          if (!current() || controller.signal.aborted || context.revision() === requestedAt) return false;
          const retry = await context.call(body).catch(() => null);
          return current() && retry?.authorized === true;
        }
      }).finally(() => { pendingCheck = undefined; });
      return pendingCheck;
    };
    const report = (status, steps) => serialize(() => context.call({
      operation: "adventure-action-report", name, id, providerId, intentId,
      reportId: randomUUID(), status, steps,
    }, AbortSignal.timeout(4000)));
    async function run() {
      if (!(await authorize())) return;
      const timer = setInterval(async () => {
        if (!(await authorize())) stop(actor, "authorization-lost");
      }, 1000);
      timer.unref();
      try {
        const controls = {
          signal: controller.signal, reservations, authorize, isCurrent: current,
          diagnostic(details) {
            context.receipt({ event: "adventure-native-diagnostic", name, id, ...details });
          },
          observe({ stepId, count }) {
            const step = {
              stepId, count,
              summary: stepId === "travel"
                ? `${name} moved ${count} blocks from the start toward the approved forest.`
                : stepId === "return" ? `${name} reached their starting point.`
                  : `${name} picked up ${count} ${input.resource} from the approved forest.`,
            };
            evidence.set(stepId, step);
            context.receipt({ event: "adventure-progress", name, id, stepId, count, resource: input.resource });
            void report("progress", [step]).catch(() => {});
          },
        };
        const result = returning ? await returnFromForest(actor.bot, policy, actor.home, controls)
          : await gatherLogs(actor.bot, policy, input, controls);
        clearInterval(timer);
        if (result.reason) evidence.set("ended", {
          stepId: "ended", summary: `${name}'s forest task ended: ${result.reason}.`,
        });
        await report(result.status, [...evidence.values()]).catch(() => {
          context.receipt({ event: "adventure-report-failed", name, id });
        });
        context.receipt({ event: "adventure-outcome", name, id, ...result });
      } finally {
        clearInterval(timer);
      }
    }
    const running = run().catch(() => {
      context.receipt({ event: "adventure-report-failed", name, id });
    }).finally(() => {
      jobs.delete(running);
      if (actor.resourceJob === job) actor.resourceJob = undefined;
      const queued = actor.queuedReturn;
      actor.queuedReturn = undefined;
      if (queued && current()) launch(queued);
    });
    jobs.add(running);
  }

  function canHearPublic(actor, player) {
    const tracked = actor?.bot?.players?.[player?.name];
    return !!tracked?.entity?.position && tracked.entity.isValid !== false
      && tracked.uuid === player.uuid && actor.bot.game?.dimension === policy.dimension;
  }

  async function chat(name, text, audience) {
    const group = context.group();
    const actor = context.members.get(name);
    const shared = audience !== "private";
    if (!actor || !context.playerSeen(actor.bot) || !context.active() || !safeText(text) ||
      (shared && name !== group.botNames[0]) ||
      (audience === "public" && (options.publicChat !== true || group.publicChat !== true ||
        !canHearPublic(actor, group.player)))) return;
    if (STOP.test(text)) {
      for (const [memberName, member] of context.members) {
        if (shared || memberName === name) stop(member, "stopped");
      }
      actor.chatEpoch = (actor.chatEpoch ?? 0) + 1;
      if (shared) {
        chatEpoch++;
        await context.call({ operation: "adventure-stop", playerUuid: group.player.uuid }).catch(() => {});
      }
      return;
    }
    if (busy) return;
    busy = true;
    const revision = context.revision();
    const turn = chatEpoch;
    const actorTurn = actor.chatEpoch;
    const currentTurn = () => !context.signal.aborted && turn === chatEpoch &&
      actorTurn === actor.chatEpoch && revision === context.revision() && context.active() &&
      (audience !== "public" || canHearPublic(actor, group.player));
    try {
      const candidates = [...context.members.entries()].filter(([, member]) => shared || member === actor);
      const listeners = await Promise.all(candidates.map(async ([memberName, member]) =>
        (await sync(memberName, member, true)) && channelPolicy(member, audience, "listen")));
      if (!listeners.some(Boolean) || !currentTurn()) return;
      const eventId = randomUUID();
      const response = await context.call({
        operation: "adventure-dialogue", eventId, playerUuid: group.player.uuid,
        text, audience, ...(!shared && { addressedTo: name }),
      });
      if (response.cancelled && shared) {
        for (const member of context.members.values()) stop(member, "stopped");
      }
      if (!currentTurn()) return;
      const replies = response.replies;
      if (Array.isArray(replies) && replies.length <= 6) {
        for (const reply of replies) {
          const speaker = context.members.get(reply?.name);
          if (!speaker || (!shared && reply.name !== name) || !safeText(reply.speech) ||
            !context.playerSeen(speaker.bot) ||
            (audience === "public" && !canHearPublic(speaker, group.player))) continue;
          const destination = reply.destination ?? audience;
          if (!["private", "group"].includes(destination) ||
            (destination !== "private" && destination !== audience) ||
            (destination === "private" && reply.recipient) ||
            (reply.recipient && !context.members.has(reply.recipient))) continue;
          const proof = await context.call({
            operation: "adventure-delivery-check", name: reply.name, eventId,
            destination, playerUuid: group.player.uuid,
          }).catch(() => null);
          if (proof?.authorized !== true || !currentTurn() ||
            context.members.get(reply.name) !== speaker || !context.playerSeen(speaker.bot) ||
            (audience === "public" && !canHearPublic(speaker, group.player))) continue;
          if (destination === "private") {
            speaker.bot.whisper(group.player.name, reply.speech);
          } else if (destination === "group") {
            if (!Array.isArray(proof.listeners) || proof.listeners.length > context.members.size ||
              (proof.recipient ?? undefined) !== (reply.recipient ?? undefined)) continue;
            const knownListener = (listenerName) => {
              const listener = context.members.get(listenerName);
              return listener?.ready && context.playerSeen(listener.bot) &&
                listener.bot.player?.uuid &&
                speaker.bot.players?.[listenerName]?.uuid === listener.bot.player.uuid;
            };
            if (proof.recipient && (!proof.listeners.includes(proof.recipient) ||
              !knownListener(proof.recipient))) continue;
            const line = reply.recipient ? `[Group] ${reply.recipient}: ${reply.speech}` : `[Group] ${reply.speech}`;
            speaker.bot.whisper(group.player.name, line);
            for (const listenerName of new Set(proof.listeners)) {
              const listener = context.members.get(listenerName);
              if (listener !== speaker && knownListener(listenerName)) {
                speaker.bot.whisper(listenerName, line);
              }
            }
          }
        }
      }
      if (!currentTurn()) return;
      if (Array.isArray(response.assignments) && response.assignments.length <= context.members.size &&
        new Set(response.assignments.map((request) => request?.name)).size === response.assignments.length) {
        for (const request of response.assignments) {
          if (shared || request?.name === name) launch(request);
        }
      }
    } catch {
      context.receipt({ event: "adventure-dialogue-unavailable" });
    } finally {
      busy = false;
    }
  }

  return {
    sync,
    stop,
    chat,
    async drain() { await Promise.allSettled(jobs); },
    playerMessage(name, packet) {
      const { player } = context.group();
      const type = packet?.type?.chatType ?? packet?.type;
      if (!player || packet?.sender !== player.uuid) return;
      if (type === 0 && packet.targetName == null) void chat(name, packet.plainMessage, "public");
      if (type !== 2) return;
      const groupText = typeof packet.plainMessage === "string" &&
        /^!group\s+(.+)$/u.exec(packet.plainMessage);
      if (groupText) {
        if (name === context.group().botNames[0]) {
          void chat(name, /^stop$/iu.test(groupText[1]) ? "!group stop" : groupText[1], "group");
        }
      } else {
        void chat(name, packet.plainMessage, "private");
      }
    },
  };
}
