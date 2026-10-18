export function getProperties(db) {
  return {
    host_password_configured: true,
    viewer_password_configured: Boolean(db.get("SELECT 1 AS found FROM credentials WHERE role = 'viewer'")),
    client_allow_add_participant: Boolean(db.get("SELECT allow_lane_add AS allowed FROM event").allowed),
  };
}

export const getPublicProperties = (db) => ({
  client_allow_add_participant: Boolean(db.get("SELECT allow_lane_add AS allowed FROM event").allowed),
});

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
    db.notify({ type: "refresh" });
    return { message: "Properties updated" };
  });
}
