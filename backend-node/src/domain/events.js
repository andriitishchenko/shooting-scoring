import { fail } from "../errors.js";
import { hashToken, newToken, randomCode } from "../security/passwords.js";

const now = () => new Date().toISOString();

export function getEvent(db) {
  return db.get(
    "SELECT code, shots_count, status, created_at, started_at, finished_at FROM event",
  );
}
export const eventStatus = (db) => db.get("SELECT status FROM event").status;

// Create the event, the first distance, and the host login. The host password
// appears in the answer one time. The server keeps only a hash.
export async function createEvent({ pool, hasher, sessionDays }, { code, shots_count }) {
  const password = randomCode(16);
  const token = newToken();
  const hash = await hasher.hash(password);
  pool.create(code, (db) => {
    db.run(
      "INSERT INTO event (id, code, shots_count, created_at) VALUES (1, ?, ?, ?)",
      code,
      shots_count,
      now(),
    );
    db.run("INSERT INTO credentials (role, hash) VALUES ('host', ?)", hash);
    db.run(
      "INSERT INTO distances (title, shots_count, sort_order) VALUES ('Distance 1', ?, 0)",
      shots_count,
    );
    const time = Date.now();
    db.run(
      "INSERT INTO sessions (token_hash, role, lane, created_at, expires_at) VALUES (?, 'host', NULL, ?, ?)",
      hashToken(token),
      time,
      time + sessionDays * 86_400_000,
    );
  });
  return { message: "Event created", code, host_password: password, session_id: token };
}

export function updateEvent(db, update) {
  return db.tx(() => {
    const event = db.get("SELECT status FROM event");
    if (update.status !== null) {
      const current = event.status;
      const allowed =
        update.status === current ||
        (current === "created" && update.status === "started") ||
        (current === "started" && update.status === "finished");
      if (!allowed) fail(403, `Cannot change event status from ${current} to ${update.status}`);
      if (update.status !== current) {
        db.run("UPDATE event SET status = ? WHERE id = 1", update.status);
        if (update.status === "started") db.run("UPDATE event SET started_at = ? WHERE id = 1", now());
        if (update.status === "finished") {
          db.run("UPDATE event SET finished_at = ? WHERE id = 1", now());
          db.run("UPDATE distances SET status = 'finished' WHERE status = 'active'");
        }
      }
      db.notify({ type: "event_status", status: update.status });
    }
    if (update.shots_count !== null) {
      db.run("UPDATE event SET shots_count = ? WHERE id = 1", update.shots_count);
      db.notify({ type: "refresh" });
    }
    return { message: "Event updated" };
  });
}
