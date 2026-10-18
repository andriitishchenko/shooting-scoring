import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/server.js");

function start(t, dataDir, extra = {}) {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: "0", DATA_DIR: dataDir, PASSWORD_COST: "10", ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  const output = { out: "", err: "" };
  child.stdout.on("data", (chunk) => (output.out += chunk));
  child.stderr.on("data", (chunk) => (output.err += chunk));
  const ready = new Promise((resolve) => {
    const check = setInterval(() => {
      const match = output.out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearInterval(check);
        resolve(Number(match[1]));
      }
    }, 10);
    child.once("exit", () => clearInterval(check) || resolve(null));
  });
  return { child, output, ready };
}

// Wait for the end of a process. Return its exit code.
const exited = (child) =>
  child.exitCode !== null ? Promise.resolve(child.exitCode) : once(child, "exit").then(([code]) => code);

const tempDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shooting-life-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("the server process starts, prints its address, and stops cleanly on SIGTERM", async (t) => {
  const dir = tempDir(t);
  const { child, output, ready } = start(t, dir);
  const port = await ready;
  assert.ok(port > 0, output.err);
  assert.match(output.out, /Shooting Scoring System v/);
  assert.match(output.out, new RegExp(`Data: ${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const answer = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(answer.status, 200);
  child.kill("SIGTERM");
  assert.equal(await exited(child), 0);
  assert.equal(fs.existsSync(path.join(dir, ".server.lock")), false);
});

test("a second process for the same data directory does not start", async (t) => {
  const dir = tempDir(t);
  const first = start(t, dir);
  assert.ok(await first.ready);
  const second = start(t, dir, { LOCK_WAIT_MS: "300" });
  assert.equal(await second.ready, null);
  assert.equal(await exited(second.child), 1);
  assert.match(second.output.err, /Another server .* uses the data directory/);
  assert.match(second.output.err, /wait 15 seconds/);
  const stillRunning = await fetch(`http://127.0.0.1:${await first.ready}/api/health`);
  assert.equal(stillRunning.status, 200);
});

test("a stopped process leaves no lock that blocks the next start", async (t) => {
  const dir = tempDir(t);
  const first = start(t, dir);
  assert.ok(await first.ready);
  first.child.kill("SIGKILL");
  await exited(first.child);
  assert.equal(fs.existsSync(path.join(dir, ".server.lock")), true);
  const second = start(t, dir);
  assert.ok(await second.ready, second.output.err);
});

test("the server refuses a port that is in use", async (t) => {
  const dir = tempDir(t);
  const first = start(t, dir);
  const port = await first.ready;
  const second = start(t, tempDir(t), { PORT: String(port) });
  assert.equal(await second.ready, null);
  assert.equal(await exited(second.child), 1);
  assert.match(second.output.err, /EADDRINUSE|address already in use/i);
});

test("the server does not start with a wrong setting", async (t) => {
  const { child, output, ready } = start(t, tempDir(t), { PORT: "abc" });
  assert.equal(await ready, null);
  assert.equal(await exited(child), 1);
  assert.match(output.err, /PORT/);
});

test("in one process the app can stop and start again on the same directory", async (t) => {
  const dir = tempDir(t);
  const one = createApp({ dataDir: dir, passwordCost: 10, logLevel: "error" });
  await one.listen(0, "127.0.0.1");
  await one.close();
  const two = createApp({ dataDir: dir, passwordCost: 10, logLevel: "error" });
  await two.listen(0, "127.0.0.1");
  await two.close();
  await two.close();
});

test("stopping the app closes the databases and keeps the data", async (t) => {
  const dir = tempDir(t);
  const app = createApp({ dataDir: dir, passwordCost: 10, logLevel: "error" });
  const port = await app.listen(0, "127.0.0.1");
  const created = await fetch(`http://127.0.0.1:${port}/api/events/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "KEEP01" }),
  });
  assert.equal(created.status, 200);
  assert.equal(app.pool.open.size, 1);
  await app.close();
  assert.equal(app.pool.open.size, 0);
  assert.equal(fs.existsSync(path.join(dir, "KEEP01.db")), true);
});

test("the server finishes an open request while it stops", async (t) => {
  const dir = tempDir(t);
  const app = createApp({ dataDir: dir, passwordCost: 16, logLevel: "error" });
  const port = await app.listen(0, "127.0.0.1");
  const arrived = once(app.server, "request");
  const pending = fetch(`http://127.0.0.1:${port}/api/events/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "OPEN01" }),
  });
  await arrived;
  const closing = app.close();
  assert.equal((await pending).status, 200);
  await closing;
  assert.equal(fs.existsSync(path.join(dir, "OPEN01.db")), true);
});

test("the backup script copies events while the server runs", async (t) => {
  const dir = tempDir(t);
  const target = path.join(tempDir(t), "copies");
  const first = start(t, dir);
  const port = await first.ready;
  const create = (code) =>
    fetch(`http://127.0.0.1:${port}/api/events/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
  assert.equal((await create("COPY01")).status, 200);
  assert.equal((await create("COPY02")).status, 200);
  const script = path.join(path.dirname(entry), "../scripts/backup.js");
  const run = (...args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, DATA_DIR: dir } });
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      child.on("exit", (code) => resolve({ code, output }));
    });
  const all = await run(target);
  assert.equal(all.code, 0, all.output);
  assert.match(all.output, /2 of 2 copied/);
  assert.deepEqual(fs.readdirSync(target).sort(), ["COPY01.db", "COPY02.db"]);
  const { DatabaseSync } = await import("node:sqlite");
  const copy = new DatabaseSync(path.join(target, "COPY01.db"));
  assert.equal(copy.prepare("SELECT code FROM event").get().code, "COPY01");
  copy.close();
  const one = await run(path.join(target, "one"), "copy02");
  assert.equal(one.code, 0, one.output);
  assert.deepEqual(fs.readdirSync(path.join(target, "one")), ["COPY02.db"]);
  const missing = await run(target, "NOPE01");
  assert.equal(missing.code, 1);
  assert.match(missing.output, /not found/);
  assert.equal((await run()).code, 2);
});

test("a server that was killed does not block the restart, also at once", async (t) => {
  const dir = tempDir(t);
  const first = start(t, dir);
  assert.ok(await first.ready);
  first.child.kill("SIGKILL");
  await exited(first.child);
  const started = Date.now();
  const second = start(t, dir);
  const port = await second.ready;
  assert.ok(port, second.output.err);
  assert.ok(Date.now() - started < 4000, "The restart did not wait for the old lock");
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
});

test("a lock file that a crash left in any state does not block the start", async (t) => {
  for (const content of ["", "garbage", "12345", '{"pid":1,"time":1}', '{"pid":999999999,"time":' + Date.now() + "}"]) {
    const dir = tempDir(t);
    fs.writeFileSync(path.join(dir, ".server.lock"), content);
    const run = start(t, dir);
    assert.ok(await run.ready, `${JSON.stringify(content)}: ${run.output.err}`);
    run.child.kill("SIGTERM");
    await exited(run.child);
  }
});
