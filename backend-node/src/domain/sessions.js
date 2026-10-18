import { fail } from "../errors.js";
import { hashToken, newToken, randomCode } from "../security/passwords.js";

// The newest sessions that a role (or a lane) keeps. Each viewer device has its own
// session, so the limit for viewers is high. A low limit would end the sessions of
// real viewers, and they would log in again and end the sessions of each other.
const MAX_SESSIONS = { host: 20, lane: 20, viewer: 5000 };
const LANE_PASSWORD_LENGTH = 6;

// Logins, sessions, and lanes. A session is a random token. The database keeps
// only its hash. A login does not end the other sessions of the same role.
export function createSessions({ hasher, throttle, sessionDays, now = Date.now }) {
  const lifetime = sessionDays * 86_400_000;

  // Find the session of a token. Return `null` when the token is unknown or old.
  function authenticate(db, token) {
    if (typeof token !== "string" || token.length < 16 || token.length > 128) return null;
    const hash = hashToken(token);
    const row = db.get("SELECT role, lane, expires_at FROM sessions WHERE token_hash = ?", hash);
    if (!row || row.expires_at <= now()) return null;
    return { role: row.role, lane: row.lane, tokenHash: hash };
  }

  // Make a session. Delete the old sessions and keep the newest ones.
  function issue(db, role, lane = null) {
    const token = newToken();
    const time = now();
    db.run("DELETE FROM sessions WHERE expires_at <= ?", time);
    db.run(
      "INSERT INTO sessions (token_hash, role, lane, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      hashToken(token),
      role,
      lane,
      time,
      time + lifetime,
    );
    const old = db.all(
      "SELECT token_hash FROM sessions WHERE role = ? AND lane IS ? ORDER BY created_at DESC, token_hash LIMIT -1 OFFSET ?",
      role,
      lane,
      MAX_SESSIONS[role] ?? 20,
    );
    for (const { token_hash } of old) db.run("DELETE FROM sessions WHERE token_hash = ?", token_hash);
    db.revokeSessions(old.map((row) => row.token_hash));
    return token;
  }

  // Delete sessions. The sockets of these sessions close after the commit.
  function revoke(db, where, ...values) {
    const hashes = db.all(`SELECT token_hash FROM sessions WHERE ${where}`, ...values).map((row) => row.token_hash);
    db.run(`DELETE FROM sessions WHERE ${where}`, ...values);
    db.revokeSessions(hashes);
  }

  function requireRole(auth, token, role) {
    if (!token) fail(401, "Session ID required");
    if (auth?.role !== role) fail(401, "Invalid or expired session");
  }

  const credential = (db, role) => db.get("SELECT hash FROM credentials WHERE role = ?", role)?.hash ?? null;
  const renew = (db, hash) =>
    db.run("UPDATE sessions SET expires_at = ? WHERE token_hash = ?", now() + lifetime, hash);

  // Check a password with the limits. The attempt counts before the check.
  async function checkPassword(role, id, address, password, stored, message) {
    throttle.reserve(role, id, address);
    let matches;
    try {
      matches = await hasher.verify(password, stored);
    } catch (error) {
      throttle.release(role, id, address); // The check did not run.
      throw error;
    }
    if (!matches) fail(401, message);
    throttle.succeed(role, id, address);
  }

  // The login of the host or of a viewer.
  async function login(db, role, { password, session_id }, address) {
    const answer = (token, stored) =>
      role === "viewer" ? { ok: true, has_password: Boolean(stored), session_id: token } : { ok: true, session_id: token };
    const stored = credential(db, role);
    const known = authenticate(db, session_id);
    if (known?.role === role) {
      db.tx(() => renew(db, known.tokenHash));
      return answer(session_id, stored);
    }
    if (stored)
      await checkPassword(role, "-", address, password ?? "", stored, `Invalid ${role === "host" ? "admin" : "viewer"} password`);
    return db.tx(() => {
      if (credential(db, role) !== stored) fail(401, "The password changed. Try again.");
      return answer(issue(db, role), stored);
    });
  }

  // The login of a lane. A new lane gets a password. The user sees it one time.
  async function loginLane(db, lane, { password, session_id }, address) {
    const known = authenticate(db, session_id);
    if (known?.role === "lane" && known.lane === lane) {
      db.tx(() => renew(db, known.tokenHash));
      return { status: "ok", session_id, lane_number: lane };
    }
    const row = db.get("SELECT password_hash FROM lanes WHERE lane = ?", lane);
    if (!row) {
      const generated = randomCode(LANE_PASSWORD_LENGTH);
      const hash = await hasher.hash(generated);
      return db.tx(() => {
        if (db.get("SELECT 1 AS found FROM lanes WHERE lane = ?", lane))
          return { status: "password_required", lane_number: lane };
        db.run(
          "INSERT INTO lanes (lane, password_hash, created_at, password) VALUES (?, ?, ?, ?)",
          lane,
          hash,
          new Date().toISOString(),
          generated,
        );
        return { status: "created", session_id: issue(db, "lane", lane), password: generated, lane_number: lane };
      });
    }
    if (!password) return { status: "password_required", lane_number: lane };
    await checkPassword("lane", String(lane), address, password.toUpperCase(), row.password_hash, "Invalid lane password");
    return db.tx(() => {
      if (!db.get("SELECT 1 AS found FROM lanes WHERE lane = ?", lane))
        fail(409, "The lane session was reset. Try again.");
      return { status: "ok", session_id: issue(db, "lane", lane), lane_number: lane };
    });
  }

  // The lanes and their passwords, for the host.
  function listLanes(db) {
    const rows = db.all("SELECT lane, password FROM lanes ORDER BY lane");
    return {
      lanes: rows.map((row) => row.lane),
      passwords: Object.fromEntries(rows.map((row) => [row.lane, row.password])),
    };
  }

  // Delete the password and the sessions of a lane. The next login makes a new password.
  function resetLane(db, lane) {
    return db.tx(() => {
      // The message goes first. Then the sockets of the lane close.
      db.notify({ type: "lane_session_reset", lane_number: lane });
      revoke(db, "role = 'lane' AND lane = ?", lane);
      db.run("DELETE FROM lanes WHERE lane = ?", lane);
      return { message: `Session for lane ${lane} reset` };
    });
  }

  // Give a lane a new password, and a session for the device that asked. The old sessions end.
  // Call it inside a transaction.
  function recreateLane(db, lane, password, hash) {
    db.notify({ type: "lane_session_reset", lane_number: lane });
    revoke(db, "role = 'lane' AND lane = ?", lane);
    db.run("DELETE FROM lanes WHERE lane = ?", lane);
    db.run(
      "INSERT INTO lanes (lane, password_hash, created_at, password) VALUES (?, ?, ?, ?)",
      lane,
      hash,
      new Date().toISOString(),
      password,
    );
    return issue(db, "lane", lane);
  }

  return { authenticate, requireRole, login, loginLane, listLanes, resetLane, recreateLane, revoke };
}
