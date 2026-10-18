import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DatabasePool } from "../src/db/pool.js";
import { migrate, migrations } from "../src/db/migrations.js";
import { HttpError } from "../src/errors.js";

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shooting-db-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const init = (db) =>
  db.run("INSERT INTO event (id, code, shots_count, created_at) VALUES (1, 'X', 6, 'now')");
function makePool(t, options = {}) {
  const published = [];
  const revoked = [];
  const pool = new DatabasePool({
    dir: tempDir(t),
    publish: (code, message) => published.push([code, message]),
    revoke: (code, hashes) => revoked.push([code, hashes]),
    ...options,
  });
  t.after(() => pool.closeAll());
  return { pool, published, revoked };
}

test("a new database has the schema, WAL mode, foreign keys, and private files", (t) => {
  const { pool } = makePool(t);
  const db = pool.create("ABC1", init);
  assert.equal(db.get("PRAGMA user_version").user_version, migrations.length);
  assert.equal(db.get("PRAGMA journal_mode").journal_mode, "wal");
  assert.equal(db.get("PRAGMA foreign_keys").foreign_keys, 1);
  assert.equal(fs.statSync(path.join(pool.dir, "ABC1.db")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(pool.dir).mode & 0o777, 0o700);
});

test("the pool returns the same open database and knows missing events", (t) => {
  const { pool } = makePool(t);
  const created = pool.create("ABC1", init);
  assert.equal(pool.get("ABC1"), created);
  assert.equal(pool.exists("ABC1"), true);
  assert.equal(pool.exists("ZZZ9"), false);
  assert.throws(() => pool.get("ZZZ9"), (error) => error instanceof HttpError && error.status === 404);
  for (const bad of ["", "lower", "A B", "A/B", "../x", "A".repeat(17), 5, null])
    assert.throws(() => pool.get(bad), (error) => error instanceof HttpError && error.status === 422, String(bad));
});

test("a code is claimed once and a failed start removes the files", (t) => {
  const { pool } = makePool(t);
  pool.create("ABC1", init);
  assert.throws(() => pool.create("ABC1", init), (error) => error.status === 400);
  assert.throws(() => pool.create("BAD1", () => { throw new Error("no"); }), /no/);
  assert.deepEqual(fs.readdirSync(pool.dir).filter((name) => name.startsWith("BAD1")), []);
  assert.equal(pool.create("BAD1", init).get("SELECT code FROM event").code, "X");
});

test("the pool closes the least recent database above the limit and reopens it", (t) => {
  const { pool } = makePool(t, { max: 2 });
  for (const code of ["ONE1", "TWO2"]) pool.create(code, init);
  pool.get("ONE1");
  pool.create("TRE3", init);
  assert.deepEqual([...pool.open.keys()].sort(), ["ONE1", "TRE3"]);
  assert.equal(pool.get("TWO2").get("SELECT code FROM event").code, "X");
  assert.equal(pool.open.size, 2);
});

test("the pool closes a database that is idle", async (t) => {
  const { pool } = makePool(t, { idleMs: 50 });
  pool.create("ABC1", init);
  await new Promise((resolve) => setTimeout(resolve, 80));
  pool.closeIdle();
  assert.equal(pool.open.size, 0);
  assert.equal(pool.get("ABC1").get("SELECT code FROM event").code, "X");
});

test("a transaction commits, rolls back on an error, and nests", (t) => {
  const { pool } = makePool(t);
  const db = pool.create("ABC1", init);
  const count = () => db.get("SELECT COUNT(*) AS n FROM distances").n;
  const add = (title) => db.run("INSERT INTO distances (title, shots_count, sort_order) VALUES (?, 3, 0)", title);
  db.tx(() => {
    add("a");
    db.tx(() => add("b"));
  });
  assert.equal(count(), 2);
  assert.throws(() =>
    db.tx(() => {
      add("c");
      db.tx(() => {
        add("d");
        throw new Error("inner");
      });
    }), /inner/);
  assert.equal(count(), 2);
  db.tx(() => add("e"));
  assert.equal(count(), 3);
});

test("a transaction callback must be synchronous", (t) => {
  const { pool } = makePool(t);
  const db = pool.create("ABC1", init);
  assert.throws(() => db.tx(async () => db.run("INSERT INTO distances (title, shots_count, sort_order) VALUES ('x', 3, 0)")), /synchronous/);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM distances").n, 0);
});

test("messages and revocations wait for the commit and go away after a rollback", (t) => {
  const { pool, published, revoked } = makePool(t);
  const db = pool.create("ABC1", init);
  published.length = 0;
  db.tx(() => {
    db.notify({ type: "a" });
    db.revokeSessions(["h1"]);
    assert.deepEqual([published.length, revoked.length], [0, 0]);
  });
  assert.deepEqual(published, [["ABC1", { type: "a" }]]);
  assert.deepEqual(revoked, [["ABC1", ["h1"]]]);
  assert.throws(() =>
    db.tx(() => {
      db.notify({ type: "b" });
      throw new Error("stop");
    }), /stop/);
  assert.equal(published.length, 1);
  db.notify({ type: "outside" });
  assert.equal(published.length, 2);
  db.revokeSessions([]);
  assert.equal(revoked.length, 1);
});

test("the database keeps a revision and memoizes a value until the next change", (t) => {
  const { pool } = makePool(t);
  const db = pool.create("ABC1", init);
  let computed = 0;
  const value = () => db.memoize("k", () => ++computed);
  assert.deepEqual([value(), value()], [1, 1]);
  db.run("INSERT INTO distances (title, shots_count, sort_order) VALUES ('x', 3, 0)");
  assert.equal(value(), 2);
  db.get("SELECT 1");
  assert.equal(value(), 2);
});

test("prepared statements are kept and used again", (t) => {
  const { pool } = makePool(t);
  const db = pool.create("ABC1", init);
  const first = db.prepare("SELECT 1 AS one");
  assert.equal(db.prepare("SELECT 1 AS one"), first);
  assert.equal(db.get("SELECT 1 AS one").one, 1);
});

test("the schema enforces the rules of the data", (t) => {
  const { pool } = makePool(t);
  const db = pool.create("ABC1", init);
  db.run("INSERT INTO participants (name, lane, shift) VALUES ('A', 1, 'A')");
  db.run("INSERT INTO distances (title, shots_count, sort_order) VALUES ('D', 3, 0)");
  const shot = (shotNumber, score, isX) => db.run("INSERT INTO results VALUES (1, 1, ?, ?, ?)", shotNumber, score, isX);
  assert.throws(() => shot(1, 11, 0), /CHECK/);
  assert.throws(() => shot(1, 9, 1), /CHECK/);
  shot(1, 10, 1);
  assert.throws(() => shot(1, 5, 0), /UNIQUE|PRIMARY/);
  assert.throws(() => db.run("INSERT INTO results VALUES (99, 1, 1, 5, 0)"), /FOREIGN/);
  assert.throws(() => db.run("INSERT INTO participants (name, lane, shift) VALUES ('B', 1000, 'A')"), /CHECK/);
  assert.throws(() => db.run("UPDATE event SET status = 'later'"), /CHECK/);
  db.run("DELETE FROM participants WHERE id = 1");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM results").n, 0);
});

test("deleting a lane deletes its sessions", (t) => {
  const { pool } = makePool(t);
  const db = pool.create("ABC1", init);
  db.run("INSERT INTO lanes (lane, password_hash, created_at, password) VALUES (3, 'h', 'now', 'ABC123')");
  db.run("INSERT INTO sessions VALUES ('t', 'lane', 3, 1, 2)");
  db.run("DELETE FROM lanes WHERE lane = 3");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM sessions").n, 0);
});

test("migrations run once, in order, and refuse a newer database", (t) => {
  const dir = tempDir(t);
  const connection = new DatabaseSync(path.join(dir, "m.db"));
  t.after(() => connection.close());
  migrate(connection);
  migrate(connection);
  assert.equal(connection.prepare("PRAGMA user_version").get().user_version, migrations.length);
  connection.exec(`PRAGMA user_version = ${migrations.length + 1}`);
  assert.throws(() => migrate(connection), /newer version/);
});

test("a lane needs its password, and the schema is one migration", (t) => {
  const { pool } = makePool(t);
  const db = pool.create("ABC1", init);
  assert.equal(migrations.length, 1);
  assert.throws(() => db.run("INSERT INTO lanes (lane, password_hash, created_at) VALUES (4, 'h', 'now')"), /NOT NULL/);
  db.run("INSERT INTO lanes (lane, password_hash, created_at, password) VALUES (4, 'h', 'now', 'ABC123')");
  assert.equal(db.get("SELECT password FROM lanes WHERE lane = 4").password, "ABC123");
});

test("a failed migration changes nothing", (t) => {
  const dir = tempDir(t);
  const connection = new DatabaseSync(path.join(dir, "m.db"));
  t.after(() => connection.close());
  const saved = migrations.splice(0, migrations.length, "CREATE TABLE ok (a); CREATE TABLE ok (a);");
  t.after(() => migrations.splice(0, migrations.length, ...saved));
  assert.throws(() => migrate(connection));
  assert.equal(connection.prepare("PRAGMA user_version").get().user_version, 0);
  assert.equal(connection.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'ok'").get().n, 0);
});

test("a database that a request uses closes when the request ends, not before", (t) => {
  const { pool } = makePool(t, { max: 1 });
  const first = pool.create("ONE1", init);
  first.pin();
  pool.create("TWO2", init);
  assert.equal(first.retired, true);
  assert.equal(first.closed, false);
  assert.equal(first.get("SELECT code FROM event").code, "X");
  first.unpin();
  assert.equal(first.closed, true);
  assert.equal(pool.get("ONE1").get("SELECT code FROM event").code, "X");
});

test("the pool closes every database at stop, also a pinned one, and a double close is safe", (t) => {
  const { pool } = makePool(t);
  const db = pool.create("ABC1", init);
  db.pin();
  pool.closeAll();
  assert.equal(db.closed, true);
  db.close();
  db.unpin();
});
