import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createApp } from "../src/app.js";

// Start a server on a free port with a new data directory. Stop it at the end of the test.
export async function startApp(t, overrides = {}) {
  const ownDir = !overrides.dataDir;
  const dataDir = overrides.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "shooting-test-"));
  const errors = [];
  const app = createApp({
    origins: [],
    passwordCost: 10,
    logLevel: "error",
    log: { error: (...args) => errors.push(args), warn() {}, info() {}, debug() {} },
    ...overrides,
    dataDir,
  });
  const port = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await app.close();
    if (ownDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // Send a request. The answer has `status`, `data`, and `headers`.
  const request = async (method, url, data, session, headers = {}) => {
    const response = await fetch(base + url, {
      method,
      headers: {
        ...(data === undefined ? {} : { "Content-Type": "application/json" }),
        ...(session ? { "X-Session-Id": session } : {}),
        ...headers,
      },
      body: data === undefined ? undefined : typeof data === "string" ? data : JSON.stringify(data),
    });
    const text = await response.text();
    let body = text;
    try {
      body = JSON.parse(text);
    } catch {
      // The answer is not JSON.
    }
    return { status: response.status, data: body, headers: response.headers };
  };

  // Make an event. Return its code, the host session, and the host password.
  const createEvent = async (code = "TEST01", shots = 6) => {
    const { data } = await request("POST", "/api/events/create", { code, shots_count: shots });
    return { code: data.code, host: data.session_id, password: data.host_password };
  };
  return { app, base, dataDir, request, createEvent, errors, port };
}

// A complete event: a host, a participant on lane 1, a lane session, and a started distance.
export async function runningEvent(t, overrides = {}) {
  const ctx = await startApp(t, overrides);
  const event = await ctx.createEvent("RUN001", 6);
  const { request } = ctx;
  const person = await request(
    "POST",
    `/api/participants/${event.code}`,
    { name: "Archer", lane_number: 1, shift: "A" },
    event.host,
  );
  const lane = (await request("POST", `/api/sessions/${event.code}/lane/1`, {})).data;
  await request("PATCH", `/api/events/${event.code}`, { status: "started" }, event.host);
  const distances = (await request("GET", `/api/distances/${event.code}`)).data;
  await request("PATCH", `/api/distances/${event.code}/${distances[0].id}`, { status: "active" }, event.host);
  return { ...ctx, event, participant: person.data.id, distance: distances[0].id, lane };
}

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(check, message = "condition", timeout = 3000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out: ${message}`);
    await wait(10);
  }
}

// A WebSocket client that keeps every message.
export async function connectSocket(base, code, session, options = {}) {
  const socket = new WebSocket(`${base.replace("http:", "ws:")}/ws/${code}`, options);
  socket.messages = [];
  socket.on("message", (raw) => socket.messages.push(JSON.parse(raw.toString())));
  socket.closed = new Promise((resolve) => socket.once("close", (code) => resolve(code)));
  await once(socket, "open");
  if (session !== undefined) {
    socket.send(JSON.stringify({ type: "authenticate", session_id: session }));
    await waitFor(() => socket.messages.length || socket.readyState !== WebSocket.OPEN, "authentication answer");
  }
  return socket;
}
