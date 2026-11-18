import { randomUUID } from "node:crypto";
import { createGameBridge } from "@ifsoul/adapter-sdk/bridge";
import { createActions } from "./actions.mjs";
import { createResourceActions, nativeIntent } from "./capabilities.mjs";
export function attachConnector(bot, config, transport, receipt = () => {}) {
  let epoch = 0,
    bridge,
    controller,
    ready = false,
    stopped = false,
    active = false;
  let lastAccepted = -Infinity,
    calls = 0,
    dimension;
  let updatingConsent = false;
  const queue = [],
    history = [],
    listeners = [];
  const record = (event, data = {}) => receipt({ event, epoch, ...data });
  const on = (name, fn) => {
    bot.on(name, fn);
    listeners.push([name, fn]);
  };
  async function whisper(name, text) {
    const before = epoch;
    if (config.canSpeak && !(await config.canSpeak())) return;
    if (before === epoch && ready && !stopped && binding(name)) bot.whisper(name, text);
  }

  let actionRevision = 0;
  let typedMovement;
  const actions = createActions(bot, config, (action, result) => {
    record("action-outcome", { action, result });
    const observation = {
      id: randomUUID(),
      summary: `Minecraft host ended ${action}: ${result}.`,
      kind: "outcome",
      actor: "agent",
      observer: "host",
      recipient: "user",
    };
    bridge?.report(observation);
    const typed = typedMovement;
    if (typed?.movement === action) {
      typedMovement = undefined;
      void config.reportCapability({
        id: typed.request.id,
        reportId: observation.id,
        providerId: typed.request.providerId,
        intentId: typed.request.intentId,
        status: ["arrived", "target-died"].includes(result)
          ? "succeeded"
          : ["stopped", "interrupted"].includes(result) ? "cancelled" : "failed",
        steps: [{ stepId: "native-result", summary: observation.summary }],
      }).catch(() => config.capabilityReportFailed?.(typed.request.id));
    }
    if (!typed) void config
      .reportAction?.({ id: observation.id, action, result })
      .catch(() => {
        record("action-outcome-report-failed", { action, result });
      });
    if (
      ready &&
      binding(config.playerName) &&
      ["arrived", "target-died", "expired", "unreachable"].includes(result)
    )
      void whisper(config.playerName, observation.summary);
  });
  const resources = createResourceActions(bot, config, (line) => { void whisper(config.playerName, line); });
  const invalidate = (reason) => {
    actionRevision++;
    epoch++;
    ready = false;
    actions.stop();
    resources.stop(reason);
    queue.length = 0;
    controller?.abort();
    bridge?.dispose();
    bridge = undefined;
    record("invalidated", { reason });
  };
  const binding = (name) =>
    name === config.playerName &&
    name !== bot.username &&
    bot.players?.[name]?.uuid === config.playerUuid;
  const permission = (id) => {
    const session = config.capabilitySession?.();
    if (!session) return true;
    const intentId = nativeIntent(id);
    return session.expiresAt > Date.now() &&
      session.allowedIntentIds.includes(intentId) &&
      session.manifest.capabilities.some((row) =>
        row.intentId === intentId && row.readiness === "ready");
  };
  async function checkMovement(job) {
    if (!job) {
      await config.validateActions?.();
      return;
    }
    const authorized = await config.checkCapability({
      ...job.request, checkpoint: ++job.checkpoint,
    });
    if (!authorized) throw Error("stale");
  }

  function reportUnstarted(job, status, summary) {
    if (!job) return;
    void config.reportCapability({
      id: job.request.id,
      reportId: randomUUID(),
      providerId: job.request.providerId,
      intentId: job.request.intentId,
      status,
      steps: [{ stepId: "native-result", summary }],
    }).catch(() => config.capabilityReportFailed?.(job.request.id));
  }

  async function drain() {
    if (active || stopped) return;
    active = true;
    try {
      while (ready && queue.length) {
        const item = queue.shift(),
          current = bridge;
        if (
          item.epoch !== epoch ||
          Date.now() >= item.deadline ||
          !binding(item.name)
        )
          continue;
        let timer;
        try {
          const options = resources.acting ? [] : actions.snapshot().filter(({ id }) => permission(id));
          const boundPlayer = actions.player();
          const revision = actionRevision;
          calls++;
          const decision = options.length
            ? current.decide({
                requestId: item.id,
                context: item.message,
                choices: [
                  { id: "none", label: "Reply without taking any action" },
                  ...options.map(({ id, label }) => ({ id, label })),
                ],
                fallbackChoiceId: "none",
              })
            : current.chat(item.message);
          const reply = await Promise.race([
            decision,
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(Error("deadline")),
                item.deadline - Date.now(),
              );
            }),
          ]);
          if (
            !ready ||
            stopped ||
            item.epoch !== epoch ||
            Date.now() >= item.deadline ||
            !binding(item.name)
          ) {
            record("dropped", { reason: "stale" });
            if (item.epoch === epoch && Date.now() >= item.deadline)
              invalidate("deadline");
            continue;
          }
          if (revision !== actionRevision) continue;
          if (reply.source === "fallback") {
            invalidate("fallback");
            continue;
          }
          const choice = options.find(({ id }) => id === reply.choiceId);
          if (choice && revision === actionRevision) {
            const session = config.capabilitySession?.();
            const pendingMovement = session && {
              movement: choice.id,
              checkpoint: 0,
              request: {
                id: item.id,
                providerId: session.providerId,
                manifestRevision: session.manifest.revision,
                policyRevision: session.policyRevision,
                intentId: nativeIntent(choice.id),
                arguments: [],
              },
            };
            if (!permission(choice.id) || (config.canReact && !config.canReact())) continue;
            try {
              await checkMovement(pendingMovement);
            } catch {
              void whisper(item.name, "Game action permission was denied.");
              continue;
            }
            if (
              ready &&
              !stopped &&
              item.epoch === epoch &&
              revision === actionRevision &&
              Date.now() < item.deadline &&
              binding(item.name) &&
              !resources.acting
            ) {
              typedMovement = pendingMovement;
              const started = actions.execute(choice, boundPlayer);
              if (!started && typedMovement && pendingMovement === typedMovement) {
                typedMovement = undefined;
                reportUnstarted(pendingMovement, "failed", "Minecraft host could not start the selected action.");
              }
              void whisper(
                item.name,
                started ? "Action started." : "Action could not start.",
              );
              continue;
            }
            reportUnstarted(pendingMovement, "cancelled", "Minecraft host stopped the pending action before execution.");
          }
          if (choice) continue;
          const text = reply.speech;
          if (
            typeof text !== "string" ||
            !text.trim() ||
            text.length > 180 ||
            /^\s*\//u.test(text) ||
            /[\p{Cc}\p{Cf}§]/u.test(text)
          ) {
            record("dropped", { reason: "unsafe-output" });
            continue;
          }
          if (config.canSpeak && !(await config.canSpeak())) continue;
          if (!ready || stopped || item.epoch !== epoch || !binding(item.name)) continue;
          bot.whisper(item.name, text);
          current.report({
            id: randomUUID(),
            summary:
              "Host accepted a private reply send; delivery and reading unknown.",
            kind: "outcome",
            actor: "agent",
            observer: "host",
            recipient: "user",
          });
          record("send-accepted", { request: item.id, source: reply.source });
        } catch {
          record("request-failed", { request: item.id });
          if (item.epoch === epoch) invalidate("request-failed");
        } finally {
          clearTimeout(timer);
        }
      }
    } finally {
      active = false;
      if (ready && queue.length) void drain();
    }
  }
  const activate = () => {
    invalidate("spawn");
    if (stopped || !bot.player?.uuid || bot.player.uuid === config.playerUuid)
      return;
    controller = new AbortController();
    ready = true;
    bridge = createGameBridge({
      hostId: config.worldId,
      memoryId: config.memoryId,
      character: config.character,
      signal: controller.signal,
      requestTimeoutMs: config.deadlineMs,
      limits: config.bridgeLimits,
      transport,
      history: () => history,
      onObservation: (event) => {
        history.push(event);
        if (history.length > 12) history.shift();
      },
      onSpeech: () => {},
    });
    record("ready");
  };
  on("physicsTick", actions.tick);
  on("goal_reached", actions.reached);
  on("path_update", actions.path);
  on("entityDead", actions.dead);
  on("spawn", activate);
  for (const event of ["death", "respawn", "end", "kicked", "error"])
    on(event, () => invalidate(event));
  on("game", () => {
    const next = bot.game?.dimension;
    if (dimension !== undefined && dimension !== next) invalidate("dimension");
    dimension = next;
  });
  on("playerLeft", (player) => {
    if (player.uuid === config.playerUuid) invalidate("recipient-left");
  });
  on("whisper", async (name, message) => {
    if (
      !ready ||
      stopped ||
      !binding(name) ||
      typeof message !== "string" ||
      !message.trim() ||
      message.length > 500 ||
      /[\p{Cc}\p{Cf}]/u.test(message)
    )
      return;
    if (
      (config.actions?.includes("movement") || config.resourcePolicy) &&
      ["!ifsoul stop", "!ifsoul wait"].includes(message)
    ) {
      actionRevision++;
      queue.length = 0;
      actions.stop();
      resources.stop();
      void whisper(name, config.resourcePolicy ? "Game action stopped." : "Movement stopped.");
      return;
    }
    const commandEpoch = epoch;
    if (config.canListen && !(await config.canListen())) return;
    if (commandEpoch !== epoch || !ready || stopped || !binding(name)) return;
    const boundEntity = bot.players[name]?.entity;
    if ((!config.canReact || config.canReact()) && resources.command(
      message,
      () => ready && !stopped && commandEpoch === epoch && binding(name) &&
        boundEntity?.isValid && bot.players[name]?.entity === boundEntity,
      () => !actions.acting && !active,
    )) return;
    const command = /^!ifsoul (allow|deny)-(history|app-chat)$/.exec(message);
    if (command) {
      const consent = command[1] === "allow";
      const history = command[2] === "history";
      const update = history ? config.historyConsent : config.continuityConsent;
      if (!update) return;
      if (updatingConsent) return;
      updatingConsent = true;
      const consentEpoch = epoch;
      void update(consent)
        .then(
          () => {
            if (ready && !stopped && epoch === consentEpoch && binding(name))
              void whisper(
                name,
                history
                  ? consent
                    ? "App owner history inspection enabled for this connection."
                    : "App owner history inspection disabled for this connection."
                  : consent
                    ? "App Conversation can use this connection’s memories and continue as you. Linked chat can update your relationship with the bot."
                    : "App Conversation can no longer continue as you for this connection.",
              );
          },
          () => {
            if (ready && !stopped && epoch === consentEpoch && binding(name))
              void whisper(
                name,
                history
                  ? "The history permission could not be changed."
                  : "The App Conversation permission could not be changed.",
              );
          },
        )
        .finally(() => {
          updatingConsent = false;
        });
      return;
    }
    if (
      calls + queue.length >= config.maxCalls ||
      Date.now() - lastAccepted < config.cooldownMs ||
      queue.length >= 2
    ) {
      record("rejected", { reason: "budget" });
      return;
    }
    lastAccepted = Date.now();
    queue.push({
      id: randomUUID(),
      epoch,
      name,
      message,
      deadline: Date.now() + config.deadlineMs,
    });
    void drain();
  });
  return {
    start() {
      activate();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      invalidate("stop");
      for (const [name, fn] of listeners) bot.removeListener(name, fn);
    },
    validateActiveMovement: () => checkMovement(typedMovement),
    status() {
      return {
        epoch,
        ready,
        queued: queue.length,
        active,
        calls,
        ...(config.actions ? { acting: actions.acting } : {}),
      };
    },
  };
}
