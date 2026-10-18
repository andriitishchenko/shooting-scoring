import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireLock } from "../src/lock.js";

const DEAD_PID = 999_999_999;
const OTHER_LIVE_PID = process.ppid; // The test runner parent runs, and it is not this process.

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shooting-lock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, ".server.lock");
  const write = (content) => fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
  return { dir, file, write, read };
}
const quick = { waitMs: 300, staleMs: 15_000, heartbeatMs: 60_000 };

test("the lock file has the process id and the time, and release removes it", async (t) => {
  const { dir, file, read } = setup(t);
  const before = Date.now();
  const lock = await acquireLock(dir, quick);
  assert.equal(read().pid, process.pid);
  assert.ok(read().time >= before);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  lock.release();
  assert.equal(fs.existsSync(file), false);
  lock.release();
});

test("a lock from a process that no longer runs does not block the start", async (t) => {
  const { dir, write, read } = setup(t);
  write({ pid: DEAD_PID, time: Date.now() });
  const lock = await acquireLock(dir, quick);
  assert.equal(read().pid, process.pid);
  lock.release();
});

test("a lock of a running server with a fresh time keeps a second start out", async (t) => {
  const { dir, write, read } = setup(t);
  const owned = { pid: OTHER_LIVE_PID, time: Date.now() };
  write(owned);
  const started = Date.now();
  await assert.rejects(acquireLock(dir, quick), /Another server \(process \d+\) uses the data directory/);
  assert.ok(Date.now() - started >= 250, "The start waits for the other server");
  assert.deepEqual(read(), owned);
});

test("the error says that the lock goes away by itself", async (t) => {
  const { dir, write } = setup(t);
  write({ pid: OTHER_LIVE_PID, time: Date.now() });
  await assert.rejects(acquireLock(dir, quick), /wait 15 seconds/i);
});

test("a lock with an old time is stale, also when the process id runs now", async (t) => {
  const { dir, write, read } = setup(t);
  write({ pid: OTHER_LIVE_PID, time: Date.now() - 60_000 });
  const lock = await acquireLock(dir, quick);
  assert.equal(read().pid, process.pid);
  lock.release();
});

test("a lock with a time far in the future is stale (the clock changed)", async (t) => {
  const { dir, write, read } = setup(t);
  write({ pid: OTHER_LIVE_PID, time: Date.now() + 3_600_000 });
  const lock = await acquireLock(dir, quick);
  assert.equal(read().pid, process.pid);
  lock.release();
});

for (const [name, content] of [
  ["an empty file", ""],
  ["text that is not JSON", "12345"],
  ["JSON without a process id", '{"time": 1}'],
  ["JSON with a wrong type", '{"pid": "x", "time": "y"}'],
  ["a list", "[1,2]"],
  ["the old format (only a process id)", String(OTHER_LIVE_PID)],
]) {
  test(`a lock file with ${name} does not block the start`, async (t) => {
    const { dir, write, read } = setup(t);
    write(content);
    const lock = await acquireLock(dir, quick);
    assert.equal(read().pid, process.pid);
    lock.release();
  });
}

test("the start waits for a server that stops, and then takes the lock", async (t) => {
  const { dir, write, read } = setup(t);
  write({ pid: OTHER_LIVE_PID, time: Date.now() });
  setTimeout(() => write({ pid: DEAD_PID, time: Date.now() }), 100);
  const lock = await acquireLock(dir, { ...quick, waitMs: 2000 });
  assert.equal(read().pid, process.pid);
  lock.release();
});

test("the start takes the lock when the file is deleted while it waits", async (t) => {
  const { dir, file, write } = setup(t);
  write({ pid: OTHER_LIVE_PID, time: Date.now() });
  setTimeout(() => fs.rmSync(file), 100);
  const lock = await acquireLock(dir, { ...quick, waitMs: 2000 });
  lock.release();
});

test("a second use of a directory in one process is refused", async (t) => {
  const { dir } = setup(t);
  const lock = await acquireLock(dir, quick);
  await assert.rejects(acquireLock(dir, quick), /already uses the data directory/);
  lock.release();
  (await acquireLock(dir, quick)).release();
});

test("parallel starts on a stale lock give the lock to one start only", async (t) => {
  const { dir, write } = setup(t);
  write({ pid: DEAD_PID, time: Date.now() });
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => acquireLock(dir, { ...quick, waitMs: 100 })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  results.find((r) => r.status === "fulfilled").value.release();
});

test("release does not delete the lock of another server", async (t) => {
  const { dir, file, write } = setup(t);
  const lock = await acquireLock(dir, quick);
  write({ pid: OTHER_LIVE_PID, time: Date.now() });
  lock.release();
  assert.equal(fs.existsSync(file), true);
});

test("the server renews the time of the lock, so a live server never looks stale", async (t) => {
  const { dir, read } = setup(t);
  const lock = await acquireLock(dir, { ...quick, heartbeatMs: 50 });
  const first = read().time;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(read().time > first);
  lock.release();
});

test("the server writes the lock file again when someone deletes it", async (t) => {
  const { dir, file, read } = setup(t);
  const lock = await acquireLock(dir, { ...quick, heartbeatMs: 50 });
  fs.rmSync(file);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(read().pid, process.pid);
  lock.release();
});

test("the server does not take the lock back from another server", async (t) => {
  const { dir, write, read } = setup(t);
  const lock = await acquireLock(dir, { ...quick, heartbeatMs: 50 });
  const other = { pid: OTHER_LIVE_PID, time: Date.now() };
  write(other);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(read(), other);
  lock.release();
});

test("the lock timer does not keep the process alive", async (t) => {
  const { dir } = setup(t);
  const lock = await acquireLock(dir, { ...quick, heartbeatMs: 20 });
  assert.equal(lock.timer.hasRef(), false);
  lock.release();
});
