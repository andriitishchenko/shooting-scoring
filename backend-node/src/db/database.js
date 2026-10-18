// One open event database. It caches prepared statements and runs transactions.
// Notifications and session revocations wait for the commit. An error that
// rolls back the transaction also drops them.
export class Database {
  constructor(connection, { code, publish = () => {}, revoke = () => {} }) {
    this.connection = connection;
    this.code = code;
    this.publish = publish;
    this.revoke = revoke;
    this.statements = new Map();
    this.hooks = [];
    this.depth = 0;
    this.revision = 0; // Increases with each change. Readers use it as a cache key.
    this.memo = new Map();
    this.pins = 0; // Requests that use this database now
    this.retired = false; // The pool wants to close it as soon as nobody uses it
    this.closed = false;
  }

  // A request that waits for something (a password check) keeps the database
  // open. The pool closes a retired database when the last request lets it go.
  pin() {
    this.pins++;
  }
  unpin() {
    if (--this.pins === 0 && this.retired) this.close();
  }

  prepare(sql) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.connection.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
  get(sql, ...values) {
    return this.prepare(sql).get(...values);
  }
  all(sql, ...values) {
    return this.prepare(sql).all(...values);
  }
  run(sql, ...values) {
    this.revision++;
    return this.prepare(sql).run(...values);
  }

  // Run `fn` in one transaction. A nested call joins the outer transaction.
  tx(fn) {
    if (this.depth > 0) return fn();
    this.connection.exec("BEGIN IMMEDIATE");
    this.depth = 1;
    let value;
    try {
      value = fn();
      if (value && typeof value.then === "function")
        throw new TypeError("A transaction must be synchronous");
      this.connection.exec("COMMIT");
    } catch (error) {
      this.depth = 0;
      this.hooks.length = 0;
      try {
        this.connection.exec("ROLLBACK");
      } catch {
        // The transaction already ended.
      }
      throw error;
    }
    this.depth = 0;
    for (const hook of this.hooks.splice(0)) hook();
    return value;
  }

  afterCommit(hook) {
    if (this.depth > 0) this.hooks.push(hook);
    else hook();
  }
  notify(message) {
    this.afterCommit(() => this.publish(this.code, message));
  }
  revokeSessions(tokenHashes) {
    if (tokenHashes.length) this.afterCommit(() => this.revoke(this.code, tokenHashes));
  }

  // Calculate a value from the data. Keep it until the data changes.
  memoize(key, compute) {
    const entry = this.memo.get(key);
    if (entry && entry.revision === this.revision) return entry.value;
    const value = compute();
    this.memo.set(key, { revision: this.revision, value });
    return value;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.memo.clear();
    this.connection.close();
  }
}
