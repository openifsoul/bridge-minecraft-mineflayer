import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate as next } from "node:timers/promises";
import test from "node:test";
import { attachConnector } from "../src/connector.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const requireMineflayer = createRequire(require.resolve("mineflayer"));
const { Vec3 } = requireMineflayer("vec3");
const registry = requireMineflayer("prismarine-registry")("1.20.2");

function fixture(actions = ["movement"]) {
  const bot = new EventEmitter();
  const recipient = { id: 2, isValid: true, position: new Vec3(4, 0, 0) };
  const messages = [];
  const events = [];
  const requests = [];
  const reported = [];
  const controller = {
    release: undefined,
    reply: {
      choiceId: "east",
      speech: "The model cannot report a result.",
      source: "llm",
    },
  };
  Object.assign(bot, {
    username: "bot",
    player: { uuid: "other" },
    players: { player: { uuid: "approved", entity: recipient } },
    entities: { 2: recipient },
    entity: { position: new Vec3(0, 0, 0) },
    registry,
    pathfinder: {
      setGoal(goal) {
        this.goal = goal;
      },
      setMovements(config) {
        this.movements = config;
      },
    },
    clearControlStates() {},
    whisper(name, message) {
      messages.push({ name, message });
    },
  });
  const connector = attachConnector(
    bot,
    {
      playerName: "player",
      playerUuid: "approved",
      worldId: "world",
      character: { id: "test", name: "Test", temperament: "Helpful" },
      deadlineMs: 1000,
      maxCalls: 10,
      cooldownMs: 0,
      actions,
      reportAction: async (outcome) => {
        reported.push(outcome);
      },
    },
    async (request) => {
      requests.push(request);
      if (controller.pending) await controller.pending;
      return controller.reply;
    },
    (event) => events.push(event),
  );
  connector.start();
  const message = (text) => bot.emit("whisper", "player", text);
  return {
    bot,
    connector,
    controller,
    events,
    message,
    messages,
    requests,
    reported,
  };
}

test("structured decision drives a walking-only goal and produces an observed result", async () => {
  const f = fixture();
  try {
    f.message("Walk five blocks east");
    await next();
    assert.equal(f.requests[0].operation, "decide");
    assert.equal(f.requests[0].fallbackChoiceId, "none");
    const path = f.bot.pathfinder;
    assert.equal(path.goal.x, 5);
    assert.equal(path.movements.canDig, false);
    assert.deepEqual(path.movements.scafoldingBlocks, []);
    assert.equal(f.reported.length, 0);
    f.bot.emit("goal_reached", path.goal);
    assert.equal(f.reported.length, 0);
    f.bot.entity.position = new Vec3(5, 0, 0);
    f.bot.emit("goal_reached", path.goal);
    assert.equal(f.reported[0].result, "arrived");
    assert.equal(path.goal, null);
  } finally {
    f.connector.stop();
  }
});

test("wait fences pending decisions without model and identity loss interrupts active navigation", async () => {
  const f = fixture();
  try {
    f.controller.pending = new Promise((resolve) => {
      f.controller.release = resolve;
    });
    f.message("Walk east");
    await next();
    f.message("!ifsoul wait");
    f.controller.release();
    await next();
    assert.equal(f.requests.length, 1);
    assert.equal(f.bot.pathfinder.goal, undefined);
    f.message("Walk east");
    await next();
    assert.ok(f.bot.pathfinder.goal);
    f.bot.players.player.entity = { ...f.bot.players.player.entity };
    f.bot.emit("physicsTick");
    assert.equal(f.bot.pathfinder.goal, null);
    assert.equal(f.reported[0].result, "interrupted");
  } finally {
    f.connector.stop();
  }
});

test("dialogue-only grant cannot execute a choice, and speech alone cannot move", async () => {
  const legacy = fixture([]);
  const enabled = fixture();
  try {
    legacy.controller.reply = {
      choiceId: "",
      speech: "Walk east",
      source: "llm",
    };
    enabled.controller.reply = {
      choiceId: "none",
      speech: "Walk east",
      source: "llm",
    };
    legacy.message("Walk east");
    enabled.message("Walk east");
    await next();
    assert.equal(legacy.requests[0].operation, "chat");
    assert.equal(enabled.requests[0].operation, "decide");
    assert.equal(legacy.bot.pathfinder.goal, undefined);
    assert.equal(enabled.bot.pathfinder.goal, undefined);
  } finally {
    legacy.connector.stop();
    enabled.connector.stop();
  }
});
