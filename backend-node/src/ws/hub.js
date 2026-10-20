import { WebSocketServer, WebSocket } from "ws";
import { HttpError } from "../errors.js";
import { DatabasePool } from "../db/pool.js";

export const CLOSE_REVOKED = 4001;
export const CLOSE_AUTH_TIMEOUT = 4002; // The client reconnects. It is not a rejected session (1008).
const MAX_BUFFERED = 1024 * 1024;

// The WebSocket clients of all events. A change in an event goes to the clients
// of that event. The server is one process, so the hub sends the message
// directly after the commit.
export function createHub({ log }) {
  const rooms = new Map(); // code -> Set<{ socket, tokenHash }>

  const hub = {
    get size() {
      let total = 0;
      for (const room of rooms.values()) total += room.size;
      return total;
    },
    join(code, client) {
      if (!rooms.has(code)) rooms.set(code, new Set());
      rooms.get(code).add(client);
    },
    leave(code, client) {
      const room = rooms.get(code);
      if (!room) return;
      room.delete(client);
      if (!room.size) rooms.delete(code);
    },
    // Send a message to all the clients of an event.
    publish(code, message) {
      const room = rooms.get(code);
      if (!room) return;
      const payload = JSON.stringify(message);
      for (const { socket } of room) {
        if (socket.readyState !== WebSocket.OPEN) continue;
        // A slow client must not make the server keep a large queue.
        if (socket.bufferedAmount > MAX_BUFFERED) socket.terminate();
        else socket.send(payload, (error) => error && log.debug("Could not send a message", error));
      }
    },
    // Close the sockets of sessions that ended.
    revoke(code, tokenHashes) {
      const hashes = new Set(tokenHashes);
      for (const client of [...(rooms.get(code) ?? [])])
        if (hashes.has(client.tokenHash)) client.socket.close(CLOSE_REVOKED, "Session ended");
    },
    // The sockets of an event. Used by tests and by diagnostics.
    sockets(code) {
      return [...(rooms.get(code) ?? [])].map((client) => client.socket);
    },
  };
  return hub;
}

// Accept WebSocket connections at `/ws/<code>`. The first message from the client
// must be `{ type: "authenticate", session_id }`. The server does not read other messages.
export function attachWebSockets(server, { hub, pool, sessions, config, log }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.isAlive === false) socket.terminate();
      else {
        socket.isAlive = false;
        socket.ping();
      }
    }
  }, config.heartbeatMs);
  heartbeat.unref();

  server.on("upgrade", (request, socket, head) => {
    socket.on("error", () => {});
    let code = null;
    try {
      const match = new URL(request.url, "http://localhost").pathname.match(/^\/ws\/([^/]+)$/);
      if (match) code = decodeURIComponent(match[1]);
    } catch {
      // The URL is not valid.
    }
    if (!code || !DatabasePool.validCode(code)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    // All sockets count, also those that did not authenticate yet.
    if (wss.clients.size >= config.maxSockets) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, code));
  });

  wss.on("connection", (socket, code) => {
    let client = null;
    socket.isAlive = true;
    socket.on("pong", () => (socket.isAlive = true));
    socket.on("error", () => {});
    const timer = setTimeout(() => socket.close(CLOSE_AUTH_TIMEOUT, "Authentication timeout"), config.authTimeoutMs);
    socket.on("close", () => {
      clearTimeout(timer);
      if (client) hub.leave(code, client);
    });
    socket.once("message", (raw, binary) => {
      clearTimeout(timer);
      try {
        const data = binary ? null : JSON.parse(raw.toString());
        if (!data || Array.isArray(data) || data.type !== "authenticate" || typeof data.session_id !== "string")
          return socket.close(1008);
        const auth = sessions.authenticate(pool.get(code), data.session_id);
        if (!auth) return socket.close(1008);
        if (socket.readyState !== WebSocket.OPEN) return;
        client = { socket, tokenHash: auth.tokenHash };
        hub.join(code, client);
        socket.send(JSON.stringify({ type: "authenticated", role: auth.role }));
      } catch (error) {
        const rejected = error instanceof HttpError || error instanceof SyntaxError;
        if (!rejected) log.error("WebSocket authentication failed", error);
        socket.close(rejected ? 1008 : 1011);
      }
    });
  });

  // Close all sockets with code 1001. Wait a short time for the clients to answer.
  return async function close(graceMs = 500) {
    clearInterval(heartbeat);
    for (const socket of wss.clients) socket.close(1001, "Server stopping");
    const end = Date.now() + graceMs;
    while (wss.clients.size && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
    for (const socket of wss.clients) socket.terminate();
    wss.close();
  };
}
