import { fail } from "../errors.js";
import { eventStatus } from "./events.js";

const COLUMNS = "id, title, shots_count, sort_order, status";

export const listDistances = (db) =>
  db.all(`SELECT ${COLUMNS} FROM distances ORDER BY sort_order`);

function requireOpenEvent(db) {
  const status = eventStatus(db);
  if (status === "finished") fail(403, "Event is finished");
  return status;
}

export function createDistance(db, { title, shots_count }) {
  return db.tx(() => {
    requireOpenEvent(db);
    const order = db.get("SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM distances").value;
    const { lastInsertRowid } = db.run(
      "INSERT INTO distances (title, shots_count, sort_order) VALUES (?, ?, ?)",
      title,
      shots_count,
      order,
    );
    db.notify({ type: "refresh" });
    return db.get(`SELECT ${COLUMNS} FROM distances WHERE id = ?`, Number(lastInsertRowid));
  });
}

export function updateDistance(db, id, update) {
  return db.tx(() => {
    const eventState = requireOpenEvent(db);
    const distance = db.get(`SELECT ${COLUMNS} FROM distances WHERE id = ?`, id);
    if (!distance) fail(404, "Distance not found");
    if (update.status === "active") {
      if (eventState === "created") fail(403, "Start the event first");
      if (distance.status === "finished") fail(403, "Finished distance cannot be reactivated");
      db.run("UPDATE distances SET status = 'finished' WHERE status = 'active' AND id != ?", id);
      db.run("UPDATE distances SET status = 'active' WHERE id = ?", id);
    } else if (update.status === "pending" && distance.status !== "pending") {
      fail(403, "Started distances cannot return to pending");
    } else if (update.status === "finished" && distance.status !== "finished") {
      if (distance.status !== "active") fail(403, "Only active distance can be finished");
      db.run("UPDATE distances SET status = 'finished' WHERE id = ?", id);
    }
    for (const [key, noun] of [["title", "title"], ["shots_count", "shots"]]) {
      if (update[key] === null) continue;
      if (distance.status !== "pending" || (update.status !== null && update.status !== "pending"))
        fail(403, `Can only edit ${noun} of pending distances`);
      db.run(`UPDATE distances SET ${key} = ? WHERE id = ?`, update[key], id);
    }
    const row = db.get(`SELECT ${COLUMNS} FROM distances WHERE id = ?`, id);
    db.notify(
      update.status !== null
        ? { type: "distance_update", distance_id: id, status: row.status }
        : { type: "refresh" },
    );
    return row;
  });
}

export function deleteDistance(db, id) {
  return db.tx(() => {
    requireOpenEvent(db);
    const distance = db.get("SELECT status FROM distances WHERE id = ?", id);
    if (!distance) fail(404, "Distance not found");
    if (distance.status !== "pending") fail(403, "Cannot delete active or finished distance");
    if (db.get("SELECT COUNT(*) AS count FROM distances").count <= 1)
      fail(403, "Cannot delete the last distance");
    db.run("DELETE FROM distances WHERE id = ?", id);
    db.notify({ type: "refresh" });
    return { message: "Distance deleted" };
  });
}
