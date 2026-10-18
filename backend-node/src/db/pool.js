import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fail } from "../errors.js";
import { Database } from "./database.js";
import { migrate } from "./migrations.js";

const CODE = /^[A-Z0-9]{1,16}$/;

// The databases of all events. Each event has its own file. The pool keeps the
// recent connections open and closes the others. Only one server process may
// use a data directory, so the pool does not handle outside writers.
export class DatabasePool {
  constructor({ dir, max = 32, idleMs = 60_000, publish, revoke, log }) {
    this.dir = dir;
    this.max = max;
    this.idleMs = idleMs;
    this.publish = publish;
    this.revoke = revoke;
    this.log = log;
    this.open = new Map(); // code -> { database, used }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.timer = setInterval(() => this.closeIdle(), Math.max(1000, Math.floor(idleMs / 2)));
    this.timer.unref();
  }

  static validCode(code) {
    return typeof code === "string" && CODE.test(code);
  }
  file(code) {
    if (!DatabasePool.validCode(code)) fail(422, "Invalid event code");
    return path.join(this.dir, `${code}.db`);
  }
  exists(code) {
    return fs.existsSync(this.file(code));
  }

  // Return the database of an event. Status 404 when the event does not exist.
  get(code) {
    const file = this.file(code);
    const entry = this.open.get(code);
    if (entry) {
      entry.used = Date.now();
      this.open.delete(code);
      this.open.set(code, entry);
      return entry.database;
    }
    if (!fs.existsSync(file)) fail(404, "Event not found");
    return this.attach(code, file);
  }

  // Create the database of a new event. `init` writes the first data.
  // Status 400 when the code is in use.
  create(code, init) {
    const file = this.file(code);
    try {
      fs.closeSync(fs.openSync(file, "wx", 0o600));
    } catch (error) {
      if (error.code === "EEXIST") fail(400, "Code already exists");
      throw error;
    }
    let database;
    try {
      database = this.attach(code, file);
      database.tx(() => init(database));
      return database;
    } catch (error) {
      this.forget(code);
      for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
      throw error;
    }
  }

  attach(code, file) {
    const connection = new DatabaseSync(file);
    try {
      connection.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA temp_store=MEMORY;",
      );
      migrate(connection);
      fs.chmodSync(file, 0o600);
    } catch (error) {
      connection.close();
      throw error;
    }
    const database = new Database(connection, { code, publish: this.publish, revoke: this.revoke });
    this.open.set(code, { database, used: Date.now() });
    while (this.open.size > this.max) this.forget(this.open.keys().next().value);
    return database;
  }

  // Remove a database from the pool and close it. A database that a request uses
  // now closes when that request ends. Use `force` when no request runs (at stop).
  forget(code, force = false) {
    const entry = this.open.get(code);
    if (!entry) return;
    this.open.delete(code);
    const { database } = entry;
    try {
      if (database.pins > 0 && !force) database.retired = true;
      else database.close();
    } catch (error) {
      this.log?.warn("Could not close a database", error);
    }
  }

  closeIdle() {
    const limit = Date.now() - this.idleMs;
    for (const [code, entry] of this.open) if (entry.used < limit) this.forget(code);
  }

  closeAll() {
    clearInterval(this.timer);
    for (const code of [...this.open.keys()]) this.forget(code, true);
  }
}
