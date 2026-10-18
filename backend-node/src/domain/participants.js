import { fail } from "../errors.js";
import { eventStatus } from "./events.js";
import { parseCsv } from "./csv.js";

const COLUMNS =
  "id, name, lane AS lane_number, shift, gender, age_category, shooting_type, group_type, personal_number";
const FIELDS = ["name", "lane_number", "shift", "gender", "age_category", "shooting_type", "group_type", "personal_number"];
const values = (person) => FIELDS.map((field) => person[field]);

export function listParticipants(db, lane) {
  return lane === undefined
    ? db.all(`SELECT ${COLUMNS} FROM participants ORDER BY lane, shift, id`)
    : db.all(`SELECT ${COLUMNS} FROM participants WHERE lane = ? ORDER BY shift, id`, lane);
}

const insert = (db, person) =>
  db.run(
    "INSERT INTO participants (name, lane, shift, gender, age_category, shooting_type, group_type, personal_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ...values(person),
  );

// The host adds a participant to any lane. A lane adds a participant to its own lane.
export function addParticipant(db, auth, token, person) {
  return db.tx(() => {
    if (!token) fail(401, "Session required");
    const host = auth?.role === "host";
    const lane = auth?.role === "lane" && auth.lane === person.lane_number;
    if (!host && !lane) fail(401, "Valid session required to add participant");
    if (!host && !db.get("SELECT allow_lane_add AS allowed FROM event").allowed)
      fail(403, "Self-registration is disabled by the host");
    if (eventStatus(db) !== "created")
      fail(403, "Participants can only be added before the event starts");
    const { lastInsertRowid } = insert(db, person);
    db.notify({ type: "refresh" });
    return { id: Number(lastInsertRowid), message: "Participant added" };
  });
}

function requireEditable(db, verb) {
  if (eventStatus(db) !== "created")
    fail(403, `Participants can only be ${verb} before the event starts`);
}

export function updateParticipant(db, id, person) {
  return db.tx(() => {
    requireEditable(db, "edited");
    if (!db.get("SELECT 1 AS found FROM participants WHERE id = ?", id)) fail(404, "Participant not found");
    db.run(
      "UPDATE participants SET name = ?, lane = ?, shift = ?, gender = ?, age_category = ?, shooting_type = ?, group_type = ?, personal_number = ? WHERE id = ?",
      ...values(person),
      id,
    );
    db.notify({ type: "refresh" });
    return { message: "Participant updated", id };
  });
}

export function deleteParticipant(db, id) {
  return db.tx(() => {
    requireEditable(db, "deleted");
    if (!db.get("SELECT 1 AS found FROM participants WHERE id = ?", id)) fail(404, "Participant not found");
    db.run("DELETE FROM participants WHERE id = ?", id);
    db.notify({ type: "refresh" });
    return { message: "Participant deleted" };
  });
}

const clean = (value, max = 60) => [...String(value ?? "").trim()].slice(0, max).join("") || null;

// Add participants from CSV text. The header needs the columns name, lane, and
// shift. A row with an error is skipped and reported.
export function importParticipants(db, csv) {
  return db.tx(() => {
    if (eventStatus(db) !== "created")
      fail(403, "Can only import participants before the competition starts");
    const rows = parseCsv(csv);
    if (!rows.length) fail(400, "Invalid CSV: the file has no header row");
    const headers = rows.shift().map((name) => name.trim().toLowerCase());
    if (!["name", "lane", "shift"].every((name) => headers.includes(name)))
      fail(400, `CSV must contain the columns name, lane, and shift. Found: ${headers.join(", ")}`);
    if (rows.length > 500) fail(400, "Too many rows (max 500)");
    let added = 0;
    const errors = [];
    rows.forEach((row, index) => {
      const cell = Object.fromEntries(headers.map((name, column) => [name, row[column] ?? ""]));
      const name = cell.name.trim();
      const lane = cell.lane.trim();
      const shift = cell.shift.trim().toUpperCase();
      let error;
      if (!name) error = "name is required";
      else if ([...name].length > 120) error = "name too long";
      else if (!shift) error = "shift is required";
      else if (!/^\d{1,3}$/.test(lane) || Number(lane) < 1 || Number(lane) > 999)
        error = `lane must be from 1 to 999, got '${lane}'`;
      if (error) return errors.push(`Row ${index + 2}: ${error}`);
      insert(db, {
        name,
        lane_number: Number(lane),
        shift: [...shift].slice(0, 4).join(""),
        gender: clean(cell.gender),
        age_category: clean(cell.age_category),
        shooting_type: clean(cell.shooting_type),
        group_type: clean(cell.group),
        personal_number: clean(cell.personal_number, 32),
      });
      added++;
    });
    if (added) db.notify({ type: "refresh" });
    return { added, failed: errors.length, errors: errors.slice(0, 50) };
  });
}
