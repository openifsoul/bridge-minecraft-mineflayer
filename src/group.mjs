import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import mineflayer from "mineflayer";
import { createActions, loadActionPlugins } from "./actions.mjs";
import { createAdventure } from "./adventure.mjs";

const names = /^[A-Za-z0-9_]{3,16}$/;
const moves = new Set(["north", "south", "east", "west"]);
class RevisionChanged extends Error {}
class ReplyUnavailable extends Error {}
class GroupRequestRejected extends Error {
  constructor(operation, status) {
    super("The group authorization ended.");
    this.operation = operation;
    this.status = status;
  }
}
function localService(value) {
  const u = new URL(value);
  if (
    u.protocol !== "http:" ||
    u.hostname !== "127.0.0.1" ||
    !u.port ||
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash
  )
    throw Error("Choose the IfSoul service loopback address and port.");
  return new URL("/api/game/device/group", u);
}

/** Each actor has a single host-owned action executor and its own event identity. */
export async function runMineflayerGroup(
  options,
  {
    makeBot = mineflayer.createBot,
    loadPlugins = loadActionPlugins,
    fetcher = fetch,
    receipt = () => {},
    signal: stopSignal,
  } = {},
) {
  const endpoint = localService(options.ifsoul);
  if (
    !options.server ||
    typeof options.server.host !== "string" ||
    !Number.isInteger(options.server.port) ||
    options.server.port < 1024 ||
    options.server.port > 65535 ||
    !/^[A-Za-z0-9_-]{24}$/.test(options.code)
  )
    throw Error("Choose the approved server and a fresh group setup code.");
  const stop = new AbortController();
  const signal = stopSignal
    ? AbortSignal.any([stopSignal, stop.signal])
    : stop.signal;
  let token, revision, group;
  async function call(data, activeSignal = signal) {
    const response = await fetcher(endpoint, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.any([
        AbortSignal.timeout(["dialogue", "adventure-dialogue"].includes(data.operation) ? 65000 : 4000),
        activeSignal,
      ]),
      headers: {
        "Content-Type": "application/json",
        ...(token && { Authorization: "Bearer " + token }),
      },
      body: JSON.stringify({ ...data, ...(revision && { revision }) }),
    });
    if (response.status === 409) throw new RevisionChanged();
    if (data.operation === "dialogue" && response.status >= 500)
      throw new ReplyUnavailable();
    if (!response.ok) throw new GroupRequestRejected(data.operation, response.status);
    return response.json();
  }
  const members = new Map();
  const pendingReports = [];
  let shutdown;
  const end = (reason, detail = {}) => {
    if (stop.signal.aborted) return;
    shutdown = { reason, ...detail };
    stop.abort();
  };
  let leaseUntil = 0;
  let authorizeMovement = false;
  let busyDialogue = false;
  let chatAfter = 0;
  const running = () =>
    !signal.aborted && authorizeMovement && Date.now() < leaseUntil;
  const playerSeen = (bot) =>
    !!group.player &&
    bot.players?.[group.player.name]?.uuid === group.player.uuid;
  const adventure = createAdventure(options.adventure, {
    members, call, signal, playerSeen, receipt,
    server: options.server,
    group: () => group,
    revision: () => revision,
    active: () => !signal.aborted && Date.now() < leaseUntil,
    isRevisionChange: (error) => error instanceof RevisionChanged,
  });
  const pauseForRevision = () => {
    authorizeMovement = false;
    leaseUntil = 0;
    for (const actor of members.values()) actor.actions.stop();
    pendingReports.length = 0;
  };
  function updateMembers(pulse) {
    if (pulse.revision === undefined) return false;
    if (
      !Number.isSafeInteger(pulse.revision) ||
      pulse.revision <= revision ||
      !Array.isArray(pulse.botNames) ||
      !pulse.botNames.length ||
      pulse.botNames.length >= members.size ||
      new Set(pulse.botNames).size !== pulse.botNames.length ||
      pulse.botNames.some((name) => !members.has(name))
    )
      throw Error("The revised group authorization is invalid.");
    pauseForRevision();
    revision = pulse.revision;
    group.botNames = pulse.botNames;
    for (const [name, actor] of members) {
      if (pulse.botNames.includes(name)) continue;
      members.delete(name);
      adventure?.stop(actor, "member-revoked");
      actor.bot.quit();
      receipt({ event: "member-revoked", name, revision });
    }
    return true;
  }
  function attach(name) {
    const bot = makeBot({
      host: options.server.host,
      port: options.server.port,
      username: name,
      version: "1.20.2",
      auth: "offline",
    });
    loadPlugins(bot);
    const actor = {
      actions: undefined,
      bot,
      ready: false,
      assignment: undefined,
    };
    members.set(name, actor);
    actor.actions = createActions(
      bot,
      { actions: ["movement"] },
      (action, status) => {
        const assignment = actor.assignment;
        if (!assignment || assignment.direction !== action) return;
        actor.assignment = undefined;
        pendingReports.push({
          operation: "outcome",
          claimId: assignment.claimId,
          assignmentId: assignment.id,
          status,
        });
        receipt({
          event: "outcome",
          name,
          action,
          status,
          position: bot.entity?.position?.floored(),
        });
      },
    );
    bot.once("spawn", () => {
      actor.ready = true;
      receipt({ event: "ready", name });
    });
    bot.on("physicsTick", () => actor.actions.tick());
    bot.on("goal_reached", (goal) => actor.actions.reached(goal));
    bot.on("path_update", (result) => actor.actions.path(result));
    const lost = (reason) => {
      if (members.has(name)) end(reason, { name });
    };
    bot.on("end", () => lost("member-disconnected"));
    bot.on("error", () => lost("member-connection-error"));
    bot.on("death", () => lost("member-died"));
    bot.on("respawn", () => {
      if (actor.ready) lost("member-world-changed");
    });
    if (adventure && bot._client) bot._client.on("playerChat", (packet) => {
      adventure.playerMessage(name, packet);
    });
    bot.on("whisper", (username, message) => {
      if (adventure) return;
      if (
        !members.has(name) ||
        username !== group.player?.name ||
        !playerSeen(bot) ||
        signal.aborted ||
        busyDialogue ||
        Date.now() < chatAfter ||
        typeof message !== "string" ||
        message.length > 187
      )
        return;
      const groupMessage = /^!group\s+(.+)$/u.exec(message);
      if (groupMessage && name !== group.botNames[0]) return;
      const text = groupMessage?.[1] ?? message;
      if (
        !text.trim() ||
        text.length > 180 ||
        /^\s*\//u.test(text) ||
        /[\p{Cc}\p{Cf}§]/u.test(text)
      )
        return;
      busyDialogue = true;
      chatAfter = Date.now() + 1000;
      const dialogueRevision = revision;
      const survey = groupMessage && text.trim().toLowerCase() === "survey";
      const canReply = () =>
        !signal.aborted &&
        dialogueRevision === revision &&
        members.has(name) &&
        Date.now() < leaseUntil &&
        playerSeen(bot);
      void call(
        survey
          ? { operation: "request-survey", playerUuid: group.player.uuid }
          : {
              operation: "dialogue",
              text,
              addressedTo: groupMessage ? "group" : name,
              playerUuid: group.player.uuid,
              eventId: randomUUID(),
            },
      )
        .then((reply) => {
          if (reply.unavailable === true) throw new ReplyUnavailable();
          if (
            canReply() &&
            reply.name === name &&
            typeof reply.speech === "string" &&
            reply.speech.length <= 180 &&
            !/^\s*\//u.test(reply.speech) &&
            !/[\p{Cc}\p{Cf}§]/u.test(reply.speech)
          )
            bot.whisper(username, reply.speech);
        })
        .catch(async (error) => {
          if (
            survey ||
            !canReply() ||
            !(
              error instanceof ReplyUnavailable ||
              error instanceof TypeError ||
              error?.name === "TimeoutError"
            )
          )
            return;
          // Confirm the grant without renewing it or scheduling any work.
          const permission = await call({
            operation: "dialogue-status",
            addressedTo: name,
            playerUuid: group.player.uuid,
          }).catch(() => null);
          if (permission?.ok === true && canReply())
            bot.whisper(username, "Service reply unavailable. Try again.");
        })
        .finally(() => {
          busyDialogue = false;
        });
    });
  }
  try {
    group = await call({
      operation: "redeem",
      code: options.code,
      server: options.server,
    });
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(group.token) ||
      !Number.isSafeInteger(group.revision) ||
      group.revision < 1 ||
      !Array.isArray(group.botNames) ||
      group.botNames.length < 1 ||
      group.botNames.length > 3 ||
      group.botNames.some((name) => !names.test(name)) ||
      new Set(group.botNames.map((name) => name.toLowerCase())).size !==
        group.botNames.length
    )
      throw Error("The group grant is invalid.");
    if (adventure && group.botNames.length !== 3) throw Error("Choose an adventure group with three NPCs.");
    token = group.token;
    revision = group.revision;
    for (const name of group.botNames) attach(name);
    const readyBy = Date.now() + 25000;
    while (![...members.values()].every((actor) => actor.ready)) {
      if (Date.now() >= readyBy)
        throw Error("Group members did not join the server.");
      await delay(100, undefined, { signal });
    }
    while (!signal.aborted) {
      try {
        const player = [...members.values()].every(({ bot }) =>
          playerSeen(bot),
        );
        const receivedAt = Date.now();
        const pulse = await call({
          operation: "pulse",
          readyNames: group.botNames,
          ...(player && { playerUuid: group.player.uuid }),
        });
        if (updateMembers(pulse)) continue;
        if (
          !Number.isInteger(pulse.leaseMs) ||
          pulse.leaseMs < 1000 ||
          pulse.leaseMs > 5000
        )
          throw Error("Group lease is unavailable.");
        leaseUntil = receivedAt + pulse.leaseMs;
        authorizeMovement = pulse.canMove === true;
        for (const [name, actor] of members) {
          if (adventure) void adventure.sync(name, actor);
        }
        if (!running())
          for (const actor of members.values()) actor.actions.stop();
        while (pendingReports.length) {
          await call(pendingReports[0]);
          pendingReports.shift();
        }
        if (running() && !adventure) {
          const proposal = await call({ operation: "assignment" });
          if (
            !Array.isArray(proposal.assignments) ||
            proposal.assignments.length > members.size ||
            new Set(proposal.assignments.map((assignment) => assignment.name))
              .size !== proposal.assignments.length ||
            new Set(
              proposal.assignments.map((assignment) => assignment.direction),
            ).size !== proposal.assignments.length
          )
            throw Error("Group assignments are invalid.");
          for (const assignment of proposal.assignments) {
            const actor = members.get(assignment.name);
            if (
              !actor ||
              actor.assignment ||
              !moves.has(assignment.direction) ||
              typeof proposal.claimId !== "string" ||
              typeof assignment.id !== "string"
            )
              throw Error("A group assignment was not authorized.");
            actor.assignment = { ...assignment, claimId: proposal.claimId };
            if (
              !actor.actions.survey(
                assignment.direction,
                () =>
                  running() &&
                  (player || group.autonomous) &&
                  (group.autonomous || playerSeen(actor.bot)),
              )
            ) {
              actor.assignment = undefined;
              pendingReports.push({
                operation: "outcome",
                claimId: proposal.claimId,
                assignmentId: assignment.id,
                status: "failed",
              });
            } else {
              receipt({
                event: "assignment",
                name: assignment.name,
                direction: assignment.direction,
                position: actor.bot.entity.position.floored(),
              });
            }
          }
        }
      } catch (error) {
        if (!(error instanceof RevisionChanged)) throw error;
        pauseForRevision();
      }
      await delay(500, undefined, { signal });
    }
  } catch (error) {
    if (!signal.aborted) {
      if (error instanceof GroupRequestRejected) {
        end("app-request-rejected", { operation: error.operation, status: error.status });
      } else {
        end("runner-failed");
      }
      throw error;
    }
  } finally {
    const externalReason = ["SIGINT", "SIGTERM"].includes(stopSignal?.reason) ? stopSignal.reason : "external-abort";
    end(stopSignal?.aborted ? externalReason : "completed");
    receipt({ event: "stopped", ...shutdown });
    for (const actor of members.values()) {
      actor.actions?.stop();
      adventure?.stop(actor, "stopped");
      actor.bot.quit();
    }
    await adventure?.drain();
    if (token)
      await call({ operation: "disconnect" }, AbortSignal.timeout(1000)).catch(
        () => {},
      );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort("SIGINT"));
  process.once("SIGTERM", () => stop.abort("SIGTERM"));
  try {
    const options = JSON.parse(await readFile(process.argv[2], "utf8"));
    await runMineflayerGroup(options, {
      signal: stop.signal,
      receipt: (event) => process.stdout.write(JSON.stringify(event) + "\n"),
    });
  } catch (error) {
    console.error(
      typeof error?.message === "string" && error.message.startsWith("Choose ")
        ? error.message
        : "Could not connect the group. Check the App grant and Minecraft server.",
    );
    process.exitCode = 1;
  }
}
