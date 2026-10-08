import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { startSignalingServer } from "../../scripts/signaling-server.mjs";

async function client(url, roomId) {
  const socket = new WebSocket(url);
  const messages = [];
  socket.on("message", bytes => messages.push(JSON.parse(bytes.toString())));
  socket.on("error", () => {});
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  socket.send(JSON.stringify({ kind: "join", roomId }));
  return { socket, messages, async wait(kind) {
    const end = Date.now() + 3000;
    while (Date.now() < end) {
      const message = messages.find(message => message.kind === kind);
      if (message) return message;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${kind}`);
  } };
}

test("signaling routes opaque bodies only within a two-peer room", async t => {
  const server = await startSignalingServer({ port: 0 });
  t.after(() => server.close());
  const room = randomUUID();
  const a = await client(server.url, room);
  await a.wait("waiting");
  const b = await client(server.url, room);
  const [pairA, pairB] = await Promise.all([a.wait("paired"), b.wait("paired")]);
  assert.equal(pairA.session, pairB.session);
  assert.equal(pairA.offerer, true);
  assert.equal(pairB.offerer, false);
  const unrelated = await client(server.url, randomUUID());
  await unrelated.wait("waiting");
  const body = "opaque body which is deliberately NOT valid JSON";
  a.socket.send(JSON.stringify({ kind: "signal", session: pairA.session, body }));
  assert.equal((await b.wait("signal")).body, body);
  assert.equal(unrelated.messages.some(message => message.kind === "signal"), false);
  const third = new WebSocket(server.url);
  third.on("error", () => {});
  const closed = new Promise(resolve => third.once("close", code => resolve(code)));
  await new Promise(resolve => third.once("open", resolve));
  third.send(JSON.stringify({ kind: "join", roomId: room }));
  assert.equal(await closed, 4403);
});
