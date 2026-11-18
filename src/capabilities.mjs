import { createHash, randomUUID } from "node:crypto";
import { gatherAndDeposit } from "./resources.mjs";

export const GATHER = "minecraft.gather-deposit";

const MOVEMENT = {
  come: "Walk to the selected player's current block.",
  follow: "Follow the selected player briefly.",
  north: "Walk five blocks north.",
  south: "Walk five blocks south.",
  east: "Walk five blocks east.",
  west: "Walk five blocks west.",
};

export const nativeIntent = (choice) => `minecraft.${choice}`;

export function mineflayerManifest(bot, minecraft, policy, revision, player, configuredActions = []) {
  const dimension = bot.game?.dimension;
  const worldId = createHash("sha256")
    .update(JSON.stringify([minecraft.host, minecraft.port, dimension]))
    .digest("hex");
  const embodimentId = bot.player.uuid;
  const position = bot.entity?.position;
  const available =
    Boolean(policy && position && bot.pathfinder && player?.entity?.isValid) &&
    dimension === policy.dimension &&
    ["x", "y", "z"].every(
      (axis) => position[axis] >= policy.region.min[axis] && position[axis] < policy.region.max[axis] + 1,
    );
  const capabilities = [];
  const nearPlayer =
    Boolean(position && player?.entity?.isValid) &&
    position.distanceTo(player.entity.position) <= 24;
  if (configuredActions.includes("movement") && bot.pathfinder) {
    for (const [choice, description] of Object.entries(MOVEMENT)) {
      capabilities.push({
        intentId: nativeIntent(choice),
        category: "minecraft.movement",
        description,
        parameters: [],
        cancellable: true,
        support: "partial",
        readiness: nearPlayer ? "ready" : "unavailable",
        reason: nearPlayer
          ? "Bounded movement near the selected player."
          : "Requires the selected player nearby.",
      });
    }
    if (configuredActions.includes("defense") && bot.pvp) {
      capabilities.push({
        intentId: nativeIntent("defend"),
        category: "minecraft.combat",
        description: "Defend against a supported nearby hostile mob.",
        parameters: [],
        cancellable: true,
        support: "partial",
        readiness: nearPlayer ? "ready" : "unavailable",
        reason: nearPlayer
          ? "One supported hostile mob in range must be observed before execution."
          : "Requires the selected player nearby.",
      });
    }
  }
  if (policy) {
    capabilities.push({
      intentId: GATHER,
      category: "minecraft.resources",
      description: "Gather configured logs and deposit the collected amount in an approved chest.",
      parameters: [
        { name: "resource", type: "choice", required: true, choices: policy.resources },
        { name: "count", type: "quantity", required: true, unit: "items", minimum: 1, maximum: 32 },
        { name: "container", type: "choice", required: true, choices: policy.containers.map(({ id }) => id) },
      ],
      cancellable: true,
      support: "partial",
      readiness: available ? "ready" : "unavailable",
      reason: available
        ? "Approved log types and configured single chests only."
        : "Requires the bound player online and the bot inside the approved dimension and region.",
    });
  }
  return {
    revision: String(revision), worldId, embodimentId, capabilities,
    channels: [{ channel: "private", listen: true, react: true, speak: true }],
  };
}

export function createResourceActions(bot, config, notify) {
  let running;
  function stop(code = "stopped") {
    if (running) running.controller.abort(Object.assign(new Error(code), { code }));
  }

  async function act(input, job) {
    const { request, controller } = job;
    const evidence = new Map();
    const report = (status) => config.reportCapability({
      id: request.id,
      reportId: randomUUID(),
      providerId: request.providerId,
      intentId: GATHER,
      status,
      steps: [...evidence.values()],
    });
    let checking;
    let checkpoint = 0;
    const authorize = () => {
      checking ??= Promise.resolve().then(() => config.checkCapability({ ...request, checkpoint: ++checkpoint }))
        .catch(() => false)
        .finally(() => { checking = undefined; });
      return checking;
    };
    if (!(await authorize())) {
      if (job.isCurrent()) notify("Game action permission was denied.");
      return;
    }
    const timer = setInterval(async () => {
      if (!(await authorize()) && running === job) stop("authorization-lost");
    }, 1000);
    timer.unref();
    try {
      const outcome = await gatherAndDeposit(bot, config.resourcePolicy, input, {
        signal: controller.signal,
        authorize,
        isCurrent: job.isCurrent,
        observe({ stepId, count }) {
          evidence.set(stepId, {
            stepId,
            count,
            summary: stepId === "collect"
              ? `Host verified the bot collected ${count} ${input.resource}.`
              : `Host verified ${count} ${input.resource} deposited into chest ${input.container}.`,
          });
        },
      });
      if (outcome.reason) {
        evidence.set("ended", { stepId: "ended", summary: `Resource action ended: ${outcome.reason}.` });
      }
      try {
        await report(outcome.status);
      } catch {
        config.capabilityReportFailed?.(request.id);
      }
      if (job.isCurrent()) {
        notify(`Resource action ${outcome.status}. Collected ${outcome.gathered}; deposited ${outcome.deposited}.${outcome.reason ? " " + outcome.reason : ""}`);
      }
    } finally {
      clearInterval(timer);
    }
  }

  return {
    get acting() { return Boolean(running); },
    stop,
    command(message, isCurrent, canStart) {
      if (!config.resourcePolicy || !message.startsWith("!ifsoul gather")) return false;
      const parsed = /^!ifsoul gather ([a-z_]{1,32}) ([1-9][0-9]?) ([a-z][a-z0-9-]{0,31})$/u.exec(message);
      if (!parsed) {
        notify("Use !ifsoul gather <resource> <count> <container>.");
        return true;
      }
      const [, resource, amount, container] = parsed;
      const input = { resource, count: Number(amount), container };
      const session = config.capabilitySession();
      const capability = session?.manifest?.capabilities.find((row) => row.intentId === GATHER);
      if (
        !session ||
        Date.now() >= session.expiresAt ||
        !session.allowedIntentIds.includes(GATHER) ||
        capability?.readiness !== "ready" ||
        !config.resourcePolicy.resources.includes(resource) ||
        !config.resourcePolicy.containers.some((entry) => entry.id === container) ||
        input.count > 32
      ) {
        notify("The resource, count, chest or action permission is unavailable.");
        return true;
      }
      if (running || !canStart()) {
        notify("Another game action is active.");
        return true;
      }
      const request = {
        id: randomUUID(),
        providerId: session.providerId,
        manifestRevision: session.manifest.revision,
        policyRevision: session.policyRevision,
        intentId: GATHER,
        arguments: Object.entries(input).map(([name, value]) => ({ name, value })),
      };
      const job = { controller: new AbortController(), isCurrent, request };
      running = job;
      void act(input, job).catch(() => {
        if (isCurrent()) notify("The resource action failed.");
      }).finally(() => {
        if (running === job) running = undefined;
      });
      return true;
    },
  };
}
