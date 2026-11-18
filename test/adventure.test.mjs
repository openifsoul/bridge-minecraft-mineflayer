import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createAdventure } from "../src/adventure.mjs";
import { createForestReservations } from "../src/resources.mjs";

const region = { min: { x: 0, y: 0, z: 0 }, max: { x: 30, y: 30, z: 30 } };
const forest = { dimension: "overworld", resources: ["oak_log"], region, harvestRegion: region };
const names = ["Cranky", "Hunger", "Giggly"];

test("local public input can use allowed private routing without global vanilla egress", async () => {
  const calls = [];
  const lines = [];
  let replies;
  let permitted = true;
  let loseTrackingDuringProof = false;
  const members = new Map(names.map((name) => [name, {
    ready: true,
    capability: { providerId: name, expiresAt: Date.now() + 30000, manifest: { revision: "1" },
      channelPolicy: { channels: ["public", "private"].map((channel) =>
      ({ channel, listen: true, react: true, speak: true })) } },
    bot: {
      game: { dimension: "overworld" },
      player: { uuid: name },
      players: { Player: { uuid: "bound-player", entity: { position: { x: 1, y: 1, z: 1 } } } },
      pathfinder: {},
      entity: { position: { x: 1, y: 1, z: 1, clone: () => ({ x: 1, y: 1, z: 1 }) } },
      chat: (line) => lines.push([name, "public", line]),
      whisper: (player, line) => lines.push([name, player, line]),
    },
  }]));
  const group = { player: { uuid: "bound-player", name: "Player" }, botNames: names, publicChat: true };
  const host = createAdventure({ publicChat: true, forest }, {
    members,
    server: { host: "127.0.0.1", port: 25565 },
    playerSeen: () => true,
    active: () => true,
    signal: new AbortController().signal,
    group: () => group,
    revision: () => 1,
    receipt() {},
    async call(body) {
      calls.push(body);
      if (body.operation === "adventure-capabilities") return { capability: {
        ...members.get(body.name).capability, manifest: body.capabilityManifest,
      } };
      if (body.operation === "adventure-delivery-check") {
        if (loseTrackingDuringProof) delete members.get(body.name).bot.players.Player.entity;
        return { authorized: permitted };
      }
      return { replies: replies ?? [
        { name: "Cranky", speech: "Hello." },
        { name: "Hunger", speech: "Morning.", recipient: "Giggly" },
      ] };
    },
  });
  const packet = { sender: "bound-player", type: 0, plainMessage: "Hello everyone" };
  host.playerMessage("Cranky", { ...packet, sender: "other-player" });
  host.playerMessage("Cranky", { ...packet, sender: "npc-sender" });
  host.playerMessage("Cranky", { ...packet, type: 3, targetName: "Cranky" });
  host.playerMessage("Hunger", packet);
  group.publicChat = false;
  host.playerMessage("Cranky", packet);
  assert.deepEqual(calls, []);
  group.publicChat = true;
  const bound = members.get("Cranky").bot.players.Player;
  const tracked = bound.entity;
  delete bound.entity;
  host.playerMessage("Cranky", packet);
  assert.deepEqual(calls, []);
  bound.entity = tracked;
  host.playerMessage("Cranky", packet);
  host.playerMessage("Hunger", packet);
  await setImmediate();
  assert.equal(calls.filter(({ operation }) => operation === "adventure-dialogue").length, 1);
  assert.equal(calls.find(({ operation }) => operation === "adventure-dialogue").audience, "public");
  assert.deepEqual(lines, []);
  const publicDescriptor = calls.find(({ operation }) => operation === "adventure-capabilities")
    .capabilityManifest.channels.find(({ channel }) => channel === "public");
  assert.deepEqual(publicDescriptor, { channel: "public", listen: true, react: true, speak: false });
  assert(!calls.some(({ operation }) => operation === "adventure-delivery-check"));
  lines.length = 0;
  host.playerMessage("Cranky", { ...packet, type: 2, plainMessage: "A private question" });
  await setImmediate();
  assert.deepEqual(lines, [["Cranky", "Player", "Hello."]]);
  lines.length = 0;
  replies = [{ name: "Giggly", speech: "I can answer privately.", destination: "private" }];
  host.playerMessage("Cranky", packet);
  await setImmediate();
  assert.deepEqual(lines, [["Giggly", "Player", "I can answer privately."]]);
  loseTrackingDuringProof = true;
  lines.length = 0;
  const speaker = members.get("Giggly").bot.players.Player;
  const speakerTracking = speaker.entity;
  host.playerMessage("Cranky", packet);
  await setImmediate();
  assert.deepEqual(lines, []);
  speaker.entity = speakerTracking;
  loseTrackingDuringProof = false;
  permitted = false;
  lines.length = 0;
  host.playerMessage("Cranky", packet);
  await setImmediate();
  assert.deepEqual(lines, []);
});

test("forest actor reservations exclude nearby drops until the claim is released", () => {
  const reservations = createForestReservations();
  const point = (x) => ({ x, distanceTo: (other) => Math.abs(x - other.x) });
  const release = reservations.claim(point(10));
  assert.equal(typeof release, "function");
  assert.equal(reservations.claim(point(14)), undefined);
  const remoteRelease = reservations.claim(point(15));
  assert.equal(typeof remoteRelease, "function");
  release();
  assert.equal(reservations.available(point(10)), true);
  remoteRelease();
});
