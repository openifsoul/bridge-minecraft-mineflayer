import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createAdventure } from "../src/adventure.mjs";

const names = ["Cranky", "Hunger", "Giggly"];
const region = { min: { x: 0, y: 0, z: 0 }, max: { x: 30, y: 30, z: 30 } };
const forest = { dimension: "overworld", resources: ["oak_log"], region, harvestRegion: region };

test("group chat routes only to bound player and verified authorized members", async () => {
  const calls = [];
  const sent = [];
  const players = Object.fromEntries(names.map((name) => [name, { uuid: name }]));
  const members = new Map(names.map((name) => [name, {
    ready: true,
    bot: {
      game: { dimension: "overworld" }, player: { uuid: name }, players, pathfinder: {},
      entity: { position: { x: 1, y: 1, z: 1, clone: () => ({ x: 1, y: 1, z: 1 }) } },
      chat() { throw Error("Group speech must stay out of public chat"); },
      whisper: (recipient, line) => sent.push([name, recipient, line]),
    },
  }]));
  const group = { player: { uuid: "bound-player", name: "Player" }, botNames: names, publicChat: false };
  let listeners = ["Hunger"];
  const host = createAdventure({ forest }, {
    members, group: () => group, revision: () => 1, playerSeen: () => true, active: () => true,
    server: { host: "127.0.0.1", port: 25565 },
    signal: new AbortController().signal, receipt() {},
    async call(body) {
      calls.push(body);
      if (["adventure-ready", "adventure-capabilities"].includes(body.operation)) return {
        capability: {
          providerId: body.name, expiresAt: Date.now() + 30000, manifest: body.capabilityManifest,
          channelPolicy: { channels: [{ channel: "group", listen: true, react: true, speak: true }] },
        },
      };
      if (body.operation === "adventure-delivery-check") return { authorized: true, listeners, recipient: "Hunger" };
      return { replies: [{ name: "Cranky", speech: "Let's go.", destination: "group", recipient: "Hunger" }] };
    },
  });
  const packet = { sender: "bound-player", type: 2, plainMessage: "!group Talk to one another." };
  host.playerMessage("Hunger", packet);
  host.playerMessage("Cranky", { ...packet, sender: "unrelated" });
  host.playerMessage("Cranky", { ...packet, sender: "Hunger" });
  await setImmediate();
  assert.deepEqual(calls, []);
  host.playerMessage("Cranky", packet);
  await setImmediate();
  assert.equal(calls.find(({ operation }) => operation === "adventure-dialogue").audience, "group");
  assert.deepEqual(sent, [
    ["Cranky", "Player", "[Group] Hunger: Let's go."],
    ["Cranky", "Hunger", "[Group] Hunger: Let's go."],
  ]);
  sent.length = 0;
  listeners = [];
  host.playerMessage("Cranky", packet);
  await setImmediate();
  assert.deepEqual(sent, []);
});
