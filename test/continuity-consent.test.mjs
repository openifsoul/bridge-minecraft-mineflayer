import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { attachConnector } from "../src/connector.mjs";

test("verified player can grant and withdraw App Conversation consent separately", async () => {
  const bot = new EventEmitter();
  bot.username = "GuardianBot";
  bot.player = { uuid: "bot-fixture" };
  bot.players = { Tester: { uuid: "verified-player" } };
  bot.game = { dimension: "overworld" };
  const sent = [];
  bot.whisper = (...args) => sent.push(args);
  const consent = [];
  const connector = attachConnector(
    bot,
    {
      playerName: "Tester",
      playerUuid: "verified-player",
      worldId: "local",
      memoryId: "memory",
      character: { id: "guardian", name: "Guardian", temperament: "Quiet" },
      deadlineMs: 50,
      cooldownMs: 0,
      maxCalls: 3,
      historyConsent: async (allowed) => consent.push(["history", allowed]),
      continuityConsent: async (allowed) =>
        consent.push(["conversation", allowed]),
    },
    () => assert.fail("Consent commands must not generate an NPC message"),
  );
  try {
    bot.emit("spawn");
    bot.emit("chat", "Tester", "!ifsoul allow-app-chat");
    bot.emit("whisper", "Outsider", "!ifsoul allow-app-chat");
    bot.emit("whisper", "Tester", "!ifsoul allow-history");
    await setImmediate();
    assert.deepEqual(consent, [["history", true]]);
    bot.emit("whisper", "Tester", "!ifsoul allow-app-chat");
    await setImmediate();
    bot.emit("whisper", "Tester", "!ifsoul deny-app-chat");
    await setImmediate();
    assert.deepEqual(consent, [
      ["history", true],
      ["conversation", true],
      ["conversation", false],
    ]);
    assert(sent.every(([recipient]) => recipient === "Tester"));
    assert.match(sent[1][1], /continue as you.*relationship/);
    assert.match(sent[2][1], /can no longer continue/);
  } finally {
    connector.stop();
  }
});
