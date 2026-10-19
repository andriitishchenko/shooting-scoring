import { fail } from "../errors.js";
import { hashToken, newToken, randomCode } from "../security/passwords.js";

const MAX_ENTRIES = 5000;
const PASSWORD_LENGTH = 6;

// A lane that has a password can ask the host for a reset. The request waits in
// memory (the server is one process). The host approves or denies it. After an
// approval the lane gets a new password and a new session. The lane collects
// them with its secret request id, one time. A request, and a result that
// nobody collected, end after `ttlMs`.
export function createLaneResets({ sessions, hasher, throttle, ttlMs, now = Date.now }) {
  const entries = new Map(); // "CODE:lane" -> { idHash, createdAt, status, decidedAt, result }
  const keyOf = (code, lane) => `${code}:${lane}`;

  function sweep() {
    const time = now();
    for (const [key, record] of entries)
      if (record.status !== "deciding" && time - (record.decidedAt ?? record.createdAt) > ttlMs) entries.delete(key);
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
  }

  return {
    get size() {
      return entries.size;
    },

    // The lane asks. The answer has the secret id that the lane needs to ask for the result.
    request(db, lane, address) {
      sweep();
      if (!db.get("SELECT 1 AS found FROM lanes WHERE lane = ?", lane))
        fail(409, "This lane has no password yet. Open the lane to get one.");
      throttle.reserve("reset", `${db.code}:${lane}`, address);
      const id = newToken();
      entries.set(keyOf(db.code, lane), { idHash: hashToken(id), createdAt: now(), status: "pending" });
      db.notify({ type: "lane_reset_requested", lane_number: lane });
      return { request_id: id, status: "pending" };
    },

    // The lane asks for the result. An answer with a decision comes one time.
    status(db, lane, requestId) {
      sweep();
      const key = keyOf(db.code, lane);
      const record = entries.get(key);
      if (!record || record.idHash !== hashToken(requestId)) return { status: "expired" };
      if (record.status === "pending" || record.status === "deciding") return { status: "pending" };
      entries.delete(key);
      if (record.status === "denied") return { status: "denied" };
      return { status: "approved", ...record.result, lane_number: lane };
    },

    // The requests that wait, for the host: lane number -> time of the request.
    pending(db) {
      sweep();
      const result = {};
      const prefix = `${db.code}:`;
      for (const [key, record] of entries)
        if (key.startsWith(prefix) && record.status !== "approved" && record.status !== "denied")
          result[key.slice(prefix.length)] = new Date(record.createdAt).toISOString();
      return result;
    },

    // The host approves. The lane gets a new password. The sessions of the lane end.
    async approve(db, lane) {
      sweep();
      const key = keyOf(db.code, lane);
      const record = entries.get(key);
      if (!record || record.status !== "pending") fail(404, "There is no reset request for this lane.");
      record.status = "deciding"; // A second decision must not start while the hash runs.
      try {
        const password = randomCode(PASSWORD_LENGTH);
        const hash = await hasher.hash(password);
        record.result = db.tx(() => {
          if (entries.get(key) !== record) fail(409, "The request ended. Ask again.");
          const session_id = sessions.recreateLane(db, lane, password, hash);
          db.notify({ type: "refresh" });
          return { session_id, password };
        });
      } catch (error) {
        if (entries.get(key) === record) record.status = "pending";
        throw error;
      }
      record.status = "approved";
      record.decidedAt = now();
      return { message: `Reset of lane ${lane} approved` };
    },

    // The host denies. Nothing changes for the lane.
    deny(db, lane) {
      sweep();
      const record = entries.get(keyOf(db.code, lane));
      if (!record || record.status !== "pending") fail(404, "There is no reset request for this lane.");
      record.status = "denied";
      record.decidedAt = now();
      db.notify({ type: "refresh" });
      return { message: `Reset of lane ${lane} denied` };
    },

    // The host reset the lane. A request for it has no meaning now.
    clear(code, lane) {
      entries.delete(keyOf(code, lane));
    },
  };
}
