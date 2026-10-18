// Tests for the defects that the final code review found.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { startApp, connectSocket, wait } from "./helpers.js";

test("a database in use is not closed when the pool needs room for another event", async (t) => {
  const { request, createEvent, app } = await startApp(t, { openDatabases: 1, passwordCost: 15 });
  const first = await createEvent("EVT001");
  const second = await createEvent("EVT002");
  assert.equal(app.pool.open.size, 1);
  // The login waits for the slow password hash while another event takes the place in the pool.
  const slow = request("POST", "/api/sessions/EVT001/host", { password: first.password });
  await wait(20);
  assert.equal((await request("GET", "/api/events/EVT002")).status, 200);
  assert.equal((await request("GET", "/api/distances/EVT002")).status, 200);
  const answer = await slow;
  assert.equal(answer.status, 200, JSON.stringify(answer.data));
  assert.equal(second.code, "EVT002");
  assert.equal((await request("GET", "/api/events/EVT001")).status, 200);
});

test("sockets that did not authenticate yet count toward the socket limit", async (t) => {
  const { base, port } = await startApp(t, { maxSockets: 2 });
  const open = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/ABC123`);
    socket.on("error", () => {});
    t.after(() => socket.terminate());
    return socket;
  };
  const first = await open();
  const second = await open();
  await Promise.all([once(first, "open"), once(second, "open")]);
  const third = new WebSocket(`ws://127.0.0.1:${port}/ws/ABC123`);
  third.on("error", () => {});
  t.after(() => third.terminate());
  const outcome = await Promise.race([
    once(third, "unexpected-response").then(([, response]) => response.statusCode),
    once(third, "open").then(() => "accepted"),
    wait(2000).then(() => "timeout"),
  ]);
  assert.equal(outcome, 503);
  assert.equal(base.startsWith("http"), true);
});

test("the files of the database stay private, also the WAL files", async (t) => {
  const { request, createEvent, dataDir } = await startApp(t);
  const { code } = await createEvent("PRIV01");
  await request("POST", `/api/sessions/${code}/lane/1`, {});
  const names = fs.readdirSync(dataDir).filter((name) => name.startsWith("PRIV01.db"));
  assert.ok(names.length >= 1);
  for (const name of names) assert.equal(fs.statSync(path.join(dataDir, name)).mode & 0o077, 0, `${name} is not private`);
});

test("too many waiting logins get status 503 and do not fill the memory", async (t) => {
  const { request, createEvent, app } = await startApp(t, { passwordCost: 14, loginFailureLimit: 10_000 });
  const { code } = await createEvent("QUEUE1");
  const attempts = Array.from({ length: 120 }, (_, i) =>
    request("POST", `/api/sessions/${code}/lane/${(i % 900) + 1}`, {}),
  );
  const answers = await Promise.all(attempts);
  const busy = answers.filter((answer) => answer.status === 503);
  assert.ok(busy.length > 0, "The server has no limit for waiting hashes");
  assert.equal(busy[0].data.detail, "The server is busy. Try again in a few seconds.");
  assert.ok(Number(busy[0].headers.get("retry-after")) > 0);
  assert.ok(answers.some((answer) => answer.status === 200));
  assert.equal(app.pool.open.size, 1);
});

test("a busy server still answers a request that needs no password check", async (t) => {
  const { request, createEvent } = await startApp(t, { passwordCost: 14 });
  const { code, host } = await createEvent("QUEUE2");
  const flood = Array.from({ length: 80 }, (_, i) => request("POST", `/api/sessions/${code}/lane/${i + 1}`, {}));
  const started = performance.now();
  const answer = await request("GET", `/api/events/${code}`);
  assert.equal(answer.status, 200);
  assert.ok(performance.now() - started < 1000, "A request without hashing waited for the queue");
  assert.equal((await request("GET", `/api/properties/${code}`, undefined, host)).status, 200);
  await Promise.all(flood);
  assert.equal(typeof connectSocket, "function");
});
