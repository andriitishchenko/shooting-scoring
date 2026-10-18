// Load test against a real server process.
// Usage: node scripts/load.js [viewers] [seconds] [secondsPerWrite]
//   viewers          WebSocket viewers that behave like viewer.js (default 300)
//   seconds          length of the scoring phase (default 30)
//   secondsPerWrite  each of the 200 participants sends one write this often (default 10)
// The event has 50 lanes with 4 participants. The server uses a temporary data folder.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const [viewerCount = 300, seconds = 30, every = 10] = process.argv.slice(2).map(Number);
const LANES = 50, PER_LANE = 4, SHOTS = 30, PORT = 18000 + Math.floor(Math.random() * 1000);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "shooting-load-"));
const base = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, ["src/server.js"], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR: dataDir, LOGIN_FAILURE_LIMIT: "100000", EVENT_CREATE_LIMIT: "1000", LOG_LEVEL: "warn" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
const stop = () => { server.kill("SIGTERM"); };
process.on("exit", stop);

const call = async (method, url, data, session) => {
  const started = performance.now();
  let status = 0, body = null;
  try {
    const r = await fetch(base + url, {
      method,
      headers: { ...(data === undefined ? {} : { "Content-Type": "application/json" }), ...(session ? { "X-Session-Id": session } : {}) },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    status = r.status;
    body = await r.json().catch(() => null);
  } catch (e) { status = -1; }
  return { status, body, ms: performance.now() - started };
};
const stats = (list) => {
  if (!list.length) return "none";
  const s = [...list].sort((a, b) => a - b), at = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return `n=${s.length} p50=${at(0.5).toFixed(0)}ms p95=${at(0.95).toFixed(0)}ms p99=${at(0.99).toFixed(0)}ms max=${s.at(-1).toFixed(0)}ms`;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sample = () => {
  const [rss, cpu] = execFileSync("ps", ["-o", "rss=,%cpu=", "-p", String(server.pid)]).toString().trim().split(/\s+/).map(Number);
  return { rssMb: rss / 1024, cpu };
};

for (let i = 0; i < 100 && !/http:/.test(serverLog); i++) await sleep(100);
const bad = {};
const count = (res, what) => { if (res.status !== 200) bad[`${what} ${res.status}`] = (bad[`${what} ${res.status}`] ?? 0) + 1; return res; };

// Setup: event, 200 participants, 50 lane logins (real password cost), start.
const created = (await call("POST", "/api/events/create", { code: "LOAD01", shots_count: SHOTS })).body;
const code = "LOAD01", host = created.session_id;
const people = [];
for (let lane = 1; lane <= LANES; lane++) for (let n = 0; n < PER_LANE; n++) {
  const r = await call("POST", `/api/participants/${code}`, { name: `P${people.length + 1}`, lane_number: lane, shift: "A", gender: people.length % 2 ? "male" : "female", shooting_type: people.length % 3 ? "recurve" : "compound" }, host);
  people.push({ id: r.body.id, lane });
}
const t0 = performance.now();
const laneSessions = new Map();
await Promise.all(Array.from({ length: LANES }, async (_, i) => laneSessions.set(i + 1, (await call("POST", `/api/sessions/${code}/lane/${i + 1}`, {})).body.session_id)));
console.log(`setup: ${people.length} participants, ${LANES} lane logins in ${(performance.now() - t0).toFixed(0)} ms`);
await call("PATCH", `/api/events/${code}`, { status: "started" }, host);
await call("PATCH", `/api/distances/${code}/1`, { status: "active" }, host);

// Viewers: log in, open a socket, and refresh (event + distances + leaderboard) 500 ms after a message, like viewer.js.
const viewerLogin = [], refresh = [], connectMs = [];
let messages = 0, closed = 0, refused = 0;
const sockets = [];
async function viewer() {
  const login = await call("POST", `/api/sessions/${code}/viewer`, {});
  viewerLogin.push(login.ms);
  if (login.status !== 200) { count(login, "viewer login"); return; }
  const started = performance.now();
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws/${code}`);
  sockets.push(socket);
  let timer = null;
  const load = async () => {
    timer = null;
    const t = performance.now();
    const rs = await Promise.all([call("GET", `/api/events/${code}`), call("GET", `/api/distances/${code}`), call("GET", `/api/results/${code}/leaderboard`)]);
    rs.forEach((r) => count(r, "viewer refresh"));
    refresh.push(performance.now() - t);
  };
  socket.on("open", () => { connectMs.push(performance.now() - started); socket.send(JSON.stringify({ type: "authenticate", session_id: login.body.session_id })); });
  socket.on("message", () => { messages++; timer ??= setTimeout(load, 500); });
  socket.on("close", (c) => { closed++; if (c === 1008) refused++; });
  socket.on("error", () => {});
}
const tv = performance.now();
for (let i = 0; i < viewerCount; i += 50) await Promise.all(Array.from({ length: Math.min(50, viewerCount - i) }, viewer));
await sleep(500);
console.log(`viewers: ${viewerCount} logins ${stats(viewerLogin)}; sockets open ${sockets.filter((s) => s.readyState === 1).length}, connect ${stats(connectMs)} (${(performance.now() - tv).toFixed(0)} ms total)`);

// Scoring: each participant sends a full shot list every `every` seconds; lanes start at random offsets.
const writes = [], peak = { rss: 0, cpu: 0 };
let stopAt = performance.now() + seconds * 1000, sent = 0;
const sampler = setInterval(() => { const s = sample(); peak.rss = Math.max(peak.rss, s.rssMb); peak.cpu = Math.max(peak.cpu, s.cpu); }, 500);
const lag = []; let last = performance.now();
const lagTimer = setInterval(() => { const now = performance.now(); lag.push(now - last - 100); last = now; }, 100);
await Promise.all(people.map(async (p, index) => {
  await sleep(Math.random() * every * 1000);
  for (let shot = 1; performance.now() < stopAt; shot = shot % SHOTS + 1) {
    const shots = Array.from({ length: shot }, (_, i) => ({ shot_number: i + 1, score: (p.id * 7 + i * 3) % 11 }));
    const r = count(await call("PUT", `/api/results/${code}/participant/${p.id}/distance/1`, { shots }, laneSessions.get(p.lane)), "write");
    writes.push(r.ms); sent++;
    await sleep(every * 1000);
  }
}));
await sleep(1500);
clearInterval(sampler); clearInterval(lagTimer);

const final = sample();
console.log(`scoring: ${sent} writes in ${seconds} s (${(sent / seconds).toFixed(0)}/s) ${stats(writes)}`);
console.log(`viewer refresh (3 requests): ${stats(refresh)}`);
console.log(`messages received by viewers: ${messages}; sockets closed ${closed} (refused ${refused})`);
console.log(`generator event-loop lag: max ${Math.max(...lag).toFixed(0)} ms (a high value means the test machine, not the server, is the limit)`);
console.log(`server: peak rss ${peak.rss.toFixed(0)} MB, peak cpu ${peak.cpu.toFixed(0)}%, rss at end ${final.rssMb.toFixed(0)} MB`);
console.log(`errors: ${JSON.stringify(bad)}; server log: ${serverLog.split("\n").filter((l) => /warn|error/i.test(l)).slice(0, 5).join(" | ") || "clean"}`);
for (const s of sockets) s.terminate();
stop();
await sleep(500);
fs.rmSync(dataDir, { recursive: true, force: true });
