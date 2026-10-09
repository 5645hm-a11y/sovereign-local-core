import { WebSocketServer, WebSocket } from "ws";

/** NIP-01-shaped blind routing fixture. It never decrypts or interprets SDP/ICE. */
export async function startMockNostrRelay() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise(resolve => server.once("listening", resolve));
  const subscriptions = new Map(), events = [], errors = [];
  server.on("connection", socket => {
    socket.on("error", error => errors.push(error.message));
    socket.on("message", bytes => {
      const m = JSON.parse(bytes.toString());
      if (m[0] === "REQ") { subscriptions.set(socket, { id: m[1], topic: m[2]["#t"][0], kind: m[2].kinds[0] }); socket.send(JSON.stringify(["EOSE", m[1]])); }
      else if (m[0] === "EVENT") {
        const e = m[1]; events.push(e);
        for (const [target, sub] of subscriptions) if (target.readyState === WebSocket.OPEN && e.kind === sub.kind && e.tags.some(t => t[0] === "t" && t[1] === sub.topic)) target.send(JSON.stringify(["EVENT", sub.id, e]));
        socket.send(JSON.stringify(["OK", e.id, true, ""]));
      }
    });
    socket.on("close", () => subscriptions.delete(socket));
  });
  return {
    url: `ws://127.0.0.1:${server.address().port}`, events, errors,
    broadcast(event) { for (const [socket, sub] of subscriptions) socket.send(JSON.stringify(["EVENT", sub.id, event])); },
    disconnect() { for (const socket of server.clients) socket.close(); },
    async close() { for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); },
  };
}
