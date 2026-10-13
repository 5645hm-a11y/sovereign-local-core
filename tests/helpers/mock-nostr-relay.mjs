import { WebSocketServer, WebSocket } from "ws";

/** NIP-01-shaped blind routing fixture. It never decrypts or interprets SDP/ICE. */
export async function startMockNostrRelay({ route = () => true } = {}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise(resolve => server.once("listening", resolve));
  const subscriptions = new Map(), events = [], errors = [], addresses = new Map(), requests = [], deliveries = [];
  server.on("connection", (socket, request) => {
    addresses.set(socket, request.url);
    socket.on("error", error => errors.push(error.message));
    socket.on("message", bytes => {
      const m = JSON.parse(bytes.toString());
      if (m[0] === "REQ") {
        if (!subscriptions.has(socket)) subscriptions.set(socket, new Map());
        subscriptions.get(socket).set(m[1], { id: m[1], topics: new Set(m[2]["#t"]), kind: m[2].kinds[0] });
        requests.push({ address: request.url, id: m[1], topics: m[2]["#t"] });
        socket.send(JSON.stringify(["EOSE", m[1]]));
      }
      else if (m[0] === "CLOSE") subscriptions.get(socket)?.delete(m[1]);
      else if (m[0] === "EVENT") {
        const e = m[1]; events.push(e);
        for (const [target, subs] of subscriptions) for (const sub of subs.values()) if (target.readyState === WebSocket.OPEN && route(request.url, addresses.get(target)) && e.kind === sub.kind && e.tags.some(t => t[0] === "t" && sub.topics.has(t[1]))) {
          deliveries.push({ address: addresses.get(target), id: e.id, subscription: sub.id }); target.send(JSON.stringify(["EVENT", sub.id, e]));
        }
        socket.send(JSON.stringify(["OK", e.id, true, ""]));
      }
    });
    socket.on("close", () => { subscriptions.delete(socket); addresses.delete(socket); });
  });
  return {
    url: `ws://127.0.0.1:${server.address().port}`, events, errors, requests, deliveries,
    get activeSubscriptions() { return [...subscriptions.values()].reduce((n, subs) => n + subs.size, 0); },
    broadcast(event) { for (const [socket, subs] of subscriptions) for (const sub of subs.values()) socket.send(JSON.stringify(["EVENT", sub.id, event])); },
    inject(address, subscription, event) { for (const [socket, value] of addresses) if (value === address) socket.send(JSON.stringify(["EVENT", subscription, event])); },
    disconnect() { for (const socket of server.clients) socket.close(); },
    async close() { for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); },
  };
}
