import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { runMineflayerGroup } from "../src/group.mjs";

test("a revised host pulse disconnects only the revoked Mineflayer member", async () => {
  const all = ["FirBot", "AshBot", "PineBot"];
  const survivors = ["FirBot", "PineBot"];
  const bots = new Map();
  const receipts = [];
  const controller = new AbortController();
  let revision = 1;
  const issued = new EventEmitter();
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    const send = (value) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (message.operation === "redeem") {
      send({
        revision: 1,
        token: "T".repeat(43),
        autonomous: false,
        botNames: all,
      });
    } else if (message.operation === "pulse" && message.revision < revision) {
      send({ revision, botNames: survivors, canMove: false });
    } else if (message.operation === "pulse") {
      send({ leaseMs: 3000, canMove: false });
      issued.emit("pulse", message);
    } else {
      send({ ok: true });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const task = runMineflayerGroup(
    {
      ifsoul: "http://127.0.0.1:" + server.address().port,
      server: { host: "127.0.0.1", port: 25565 },
      code: "A".repeat(24),
    },
    {
      signal: controller.signal,
      loadPlugins() {},
      makeBot({ username }) {
        const bot = new EventEmitter();
        bot.players = {};
        bot.closed = 0;
        bot.quit = () => {
          bot.closed++;
          bot.emit("end");
        };
        bots.set(username, bot);
        queueMicrotask(() => bot.emit("spawn"));
        return bot;
      },
      receipt: (event) => receipts.push(event),
    },
  );
  try {
    const timeout = AbortSignal.timeout(4000);
    const [first] = await once(issued, "pulse", { signal: timeout });
    assert.deepEqual(first.readyNames, all);
    revision = 2;
    const [revised] = await once(issued, "pulse", { signal: timeout });
    assert.equal(revised.revision, 2);
    assert.deepEqual(revised.readyNames, survivors);
    assert.equal(bots.get("AshBot").closed, 1);
    assert.equal(bots.get("FirBot").closed, 0);
    assert.equal(bots.get("PineBot").closed, 0);
    assert.deepEqual(
      receipts.filter((event) => event.event === "member-revoked"),
      [{ event: "member-revoked", name: "AshBot", revision: 2 }],
    );
  } finally {
    controller.abort();
    await task;
    assert.deepEqual(receipts.filter((event) => event.event === "stopped"), [
      { event: "stopped", reason: "external-abort" },
    ]);
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a dialogue transport timeout whispers only to an authorized player", async () => {
  for (const revoked of [false, true]) {
    const controller = new AbortController();
    const received = new EventEmitter();
    const whispers = [];
    const requests = [];
    const bots = new Map();
    const player = { name: "Tester", uuid: "subscription-fixture" };
    let failDialogue;
    const task = runMineflayerGroup(
      {
        ifsoul: "http://127.0.0.1:8788",
        server: { host: "127.0.0.1", port: 25565 },
        code: "A".repeat(24),
      },
      {
        signal: controller.signal,
        loadPlugins() {},
        makeBot({ username }) {
          const bot = new EventEmitter();
          bots.set(username, bot);
          bot.players = { [player.name]: { uuid: player.uuid } };
          bot.whisper = (...args) => {
            whispers.push(args);
            received.emit("whisper");
          };
          bot.chat = () => assert.fail("Unexpected public chat");
          bot.quit = () => bot.emit("end");
          queueMicrotask(() => bot.emit("spawn"));
          return bot;
        },
        async fetcher(_url, init) {
          const body = JSON.parse(init.body);
          requests.push(body);
          switch (body.operation) {
            case "redeem":
              return Response.json({
                revision: 1,
                token: "T".repeat(43),
                autonomous: false,
                botNames: ["FirBot", "PineBot"],
                player,
              });
            case "pulse":
              queueMicrotask(() => received.emit("pulse"));
              return Response.json({ leaseMs: 3000, canMove: false });
            case "dialogue":
              return new Promise((_, reject) => {
                failDialogue = () =>
                  reject(
                    new DOMException("Synthetic deadline", "TimeoutError"),
                  );
                received.emit("dialogue");
              });
            case "dialogue-status":
              setImmediate(() => received.emit("checked"));
              return revoked
                ? new Response(null, { status: 409 })
                : Response.json({ ok: true });
            case "disconnect":
              return Response.json({ ok: true });
            default:
              assert.fail("Unexpected game operation");
          }
        },
      },
    );
    try {
      const deadline = AbortSignal.timeout(4000);
      await once(received, "pulse", { signal: deadline });
      // The control loop has received the live lease before the player speaks.
      await new Promise((resolve) => setImmediate(resolve));
      const dialogue = once(received, "dialogue", { signal: deadline });
      bots.get("FirBot").emit("whisper", player.name, "Hello");
      await dialogue;
      const checked = once(received, "checked", { signal: deadline });
      failDialogue();
      await checked;
      assert.deepEqual(
        whispers,
        revoked ? [] : [[player.name, "Service reply unavailable. Try again."]],
      );
      const permission = requests.find(
        (body) => body.operation === "dialogue-status",
      );
      assert.deepEqual(permission, {
        operation: "dialogue-status",
        revision: 1,
        addressedTo: "FirBot",
        playerUuid: player.uuid,
      });
    } finally {
      controller.abort();
      await task;
    }
  }
});
