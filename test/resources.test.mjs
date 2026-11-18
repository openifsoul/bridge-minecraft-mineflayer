import assert from "node:assert/strict";
import { once, EventEmitter } from "node:events";
import test from "node:test";
import { createResourceActions, GATHER, mineflayerManifest } from "../src/capabilities.mjs";
import { validateResourcePolicy } from "../src/resources.mjs";

const policy = validateResourcePolicy({
  dimension: "overworld",
  region: { min: { x: -10, y: 0, z: -10 }, max: { x: 10, y: 12, z: 10 } },
  resources: ["oak_log"],
  containers: [{ id: "main", position: { x: 4, y: 8, z: 2 } }],
});
const minecraft = { host: "127.0.0.1", port: 25742 };

function fixture() {
  const bot = new EventEmitter();
  const position = { x: 1, y: 8, z: 2, distanceTo: () => 0 };
  bot.game = { dimension: "overworld" };
  bot.player = { uuid: "0958e5f5-2a93-4bc5-b13b-1e6aa11da71a" };
  bot.entity = { position };
  bot.pathfinder = { setGoal: () => {} };
  bot.stopDigging = () => {};
  bot.clearControlStates = () => {};
  const player = { entity: { isValid: true, position } };
  return { bot, player };
}

test("resource manifest reflects selected actor, dimension and configured tool parameters", () => {
  const { bot, player } = fixture();
  const manifest = mineflayerManifest(bot, minecraft, policy, 1, player);
  assert.equal(manifest.embodimentId, bot.player.uuid);
  assert.equal(manifest.capabilities[0].intentId, GATHER);
  assert.equal(manifest.capabilities[0].readiness, "ready");
  assert.deepEqual(manifest.capabilities[0].parameters.at(-1).choices, ["main"]);
  const unavailable = mineflayerManifest(bot, minecraft, policy, 2, undefined);
  assert.equal(unavailable.capabilities[0].readiness, "unavailable");
  assert.equal(manifest.worldId, unavailable.worldId);
  assert.throws(() => validateResourcePolicy({ ...policy, resources: ["bedrock"] }));
  assert.throws(() => validateResourcePolicy({
    ...policy, containers: [{ id: "outside", position: { x: 20, y: 8, z: 1 } }],
  }));
});

test("private gather rejects unsupported input and aborts before effects during a pending authorization", async () => {
  const { bot, player } = fixture();
  const reports = new EventEmitter();
  const checkpoints = [];
  const notices = [];
  let authorize;
  const manifest = mineflayerManifest(bot, minecraft, policy, 1, player);
  const actions = createResourceActions(bot, {
    resourcePolicy: policy,
    capabilitySession: () => ({
      providerId: "provider",
      manifest,
      allowedIntentIds: [GATHER],
      policyRevision: 2,
      expiresAt: Date.now() + 5000,
    }),
    checkCapability: (input) => {
      checkpoints.push(input);
      return new Promise((resolve) => { authorize = resolve; });
    },
    reportCapability: async (report) => { reports.emit("report", report); },
  }, (line) => notices.push(line));
  assert.ok(actions.command("!ifsoul gather oak_log 99 main", () => true, () => true));
  assert.equal(actions.acting, false);
  assert.ok(actions.command("!ifsoul gather oak_log 8 arbitrary", () => true, () => true));
  assert.equal(actions.acting, false);
  assert.ok(actions.command("!ifsoul gather oak_log 8 main", () => true, () => true));
  assert.ok(actions.acting);
  await Promise.resolve();
  actions.stop();
  const observed = once(reports, "report");
  authorize(true);
  const [report] = await observed;
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].checkpoint, 1);
  assert.equal(report.id, checkpoints[0].id);
  assert.equal(report.status, "cancelled");
  assert.deepEqual(report.steps.map(({ stepId }) => stepId), ["ended"]);
  assert.ok(notices.every((line) => !line.includes("deposited 8")));
});
