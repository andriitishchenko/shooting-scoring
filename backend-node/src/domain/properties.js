const readEvent = (db) => db.get("SELECT allow_lane_add AS allowed, lane_count AS lanes FROM event");

export function getProperties(db) {
  const event = readEvent(db);
  return {
    host_password_configured: true,
    viewer_password_configured: Boolean(db.get("SELECT 1 AS found FROM credentials WHERE role = 'viewer'")),
    client_allow_add_participant: Boolean(event.allowed),
    lane_count: event.lanes,
  };
}

export const getPublicProperties = (db) => {
  const event = readEvent(db);
  return { client_allow_add_participant: Boolean(event.allowed), lane_count: event.lanes };
};

// Change the passwords and the settings. `hashes` has the new password hashes.
// A new password ends the other sessions of that role. The session that sent the
// request (`current`) stays.
export function updateProperties(db, sessions, update, hashes, current) {
  return db.tx(() => {
    for (const role of ["host", "viewer"]) {
      const value = update[`${role}_password`];
      if (value === null) continue;
      if (value === "") db.run("DELETE FROM credentials WHERE role = ?", role);
      else
        db.run(
          "INSERT INTO credentials (role, hash) VALUES (?, ?) ON CONFLICT (role) DO UPDATE SET hash = excluded.hash",
          role,
          hashes[role],
        );
      sessions.revoke(db, "role = ? AND token_hash != ?", role, current);
    }
    if (update.client_allow_add_participant !== null)
      db.run("UPDATE event SET allow_lane_add = ? WHERE id = 1", update.client_allow_add_participant ? 1 : 0);
    if (update.lane_count !== null) db.run("UPDATE event SET lane_count = ? WHERE id = 1", update.lane_count);
    db.notify({ type: "refresh" });
    return { message: "Properties updated" };
  });
}
