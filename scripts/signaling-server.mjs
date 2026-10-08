import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

/** No persistent state: room membership and pair epochs live only for connected sockets. */
export async function startSignalingServer({ port = 8787, host = "127.0.0.1", maxRooms = 1024 } = {}) {
  const rooms = new Map();
  const wss = new WebSocketServer({ port, host, maxPayload: 256 * 1024, perMessageDeflate: false });
  let stopping = false;
  const send = (socket, message) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 512 * 1024) { socket.terminate(); return; }
    socket.send(JSON.stringify(message));
  };
  wss.on("connection", socket => {
    let roomId;
    let alive = true;
    const deadline = setTimeout(() => socket.close(4400, "Join timeout"), 5000);
    deadline.unref();
    socket.on("error", () => {}); // Never log payloads, SDP, IPs or room IDs.
    socket.on("pong", () => { alive = true; });
    socket.isAlive = () => alive;
    socket.markPing = () => { alive = false; };
    socket.on("message", (bytes, binary) => {
      if (stopping) return;
      try {
        if (binary) throw new Error("Text envelope required");
        const message = JSON.parse(bytes.toString());
        if (!roomId) {
          if (message.kind !== "join" || typeof message.roomId !== "string" ||
              !/^[A-Za-z0-9_-]{22,128}$/.test(message.roomId)) throw new Error("Invalid room token");
          if (!rooms.has(message.roomId) && rooms.size >= maxRooms) {
            socket.close(4403, "Capacity reached"); return;
          }
          const room = rooms.get(message.roomId) ?? { sockets: new Set(), session: undefined };
          if (room.sockets.size >= 2) { socket.close(4403, "Room already has two peers"); return; }
          roomId = message.roomId;
          clearTimeout(deadline);
          room.sockets.add(socket);
          rooms.set(roomId, room);
          send(socket, { kind: "joined" });
          if (room.sockets.size === 2) {
            room.session = randomUUID();
            const [first, second] = [...room.sockets];
            send(first, { kind: "paired", session: room.session, offerer: true });
            send(second, { kind: "paired", session: room.session, offerer: false });
          } else send(socket, { kind: "waiting" });
          return;
        }
        const room = rooms.get(roomId);
        // Parse only the routing envelope; body is an OPAQUE string, never parsed or retained.
        if (message.kind !== "signal" || typeof message.body !== "string" ||
            message.body.length > 128 * 1024) throw new Error("Invalid routing envelope");
        if (message.session !== room?.session || !room?.session) return; // Stale pair messages.
        for (const peer of room.sockets) {
          if (peer !== socket) send(peer, { kind: "signal", session: room.session, body: message.body });
        }
      } catch { socket.close(4400, "Invalid signaling envelope"); }
    });
    socket.on("close", () => {
      clearTimeout(deadline);
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;
      room.sockets.delete(socket);
      room.session = undefined;
      if (!room.sockets.size) rooms.delete(roomId);
      else if (!stopping) for (const peer of room.sockets) send(peer, { kind: "waiting" });
    });
  });
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive()) socket.terminate();
      else { socket.markPing(); socket.ping(); }
    }
  }, 15000);
  heartbeat.unref();
  await new Promise((resolve, reject) => { wss.once("listening", resolve); wss.once("error", reject); });
  const address = wss.address();
  return {
    port: address.port,
    url: `ws://${host}:${address.port}`,
    async close() {
      stopping = true;
      clearInterval(heartbeat);
      for (const socket of wss.clients) socket.terminate();
      await new Promise((resolve, reject) => wss.close(error => error ? reject(error) : resolve()));
      rooms.clear();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startSignalingServer({
    port: Number(process.env.LOCAL_CORE_SIGNALING_PORT ?? 8787),
    host: process.env.LOCAL_CORE_SIGNALING_HOST ?? "127.0.0.1",
  });
  console.log(`Signaling listening: ${server.url}`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await server.close(); process.exit(0); });
}
