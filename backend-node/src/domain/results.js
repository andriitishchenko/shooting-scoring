import { fail } from "../errors.js";
import { eventStatus } from "./events.js";

const SERIES = 3;

function participantExists(db, id) {
  if (!db.get("SELECT 1 AS found FROM participants WHERE id = ?", id)) fail(404, "Participant not found");
}
function findDistance(db, id) {
  const distance = db.get("SELECT id, title, shots_count, status FROM distances WHERE id = ?", id);
  if (!distance) fail(404, "Distance not found");
  return distance;
}

// The host edits any result. A lane edits the results of its own participants.
// Return true for the host.
function authorize(db, auth, token, participantId, distanceId) {
  if (!token) fail(401, "Session ID required");
  const participant = db.get("SELECT lane FROM participants WHERE id = ?", participantId);
  if (!participant) fail(404, "Participant not found");
  findDistance(db, distanceId);
  if (auth?.role === "host") return true;
  if (auth?.role === "lane" && auth.lane === participant.lane) return false;
  fail(401, "Invalid session for participant lane");
}

function broadcast(db, participantId) {
  const { total } = db.get(
    "SELECT COALESCE(SUM(score), 0) AS total FROM results WHERE participant_id = ?",
    participantId,
  );
  db.notify({ type: "result_update", participant_id: participantId, total_score: total });
}

// Write the shots of one participant on one distance. With `replace`, the shots
// that are not in the list are deleted.
function write(db, participantId, distance, shots, replace) {
  if (replace) db.run("DELETE FROM results WHERE participant_id = ? AND distance_id = ?", participantId, distance.id);
  for (const shot of shots)
    db.run(
      "INSERT INTO results (participant_id, distance_id, shot, score, is_x) VALUES (?, ?, ?, ?, ?) ON CONFLICT (participant_id, distance_id, shot) DO UPDATE SET score = excluded.score, is_x = excluded.is_x",
      participantId,
      distance.id,
      shot.shot_number,
      shot.score,
      shot.is_x ? 1 : 0,
    );
}

// Save shots without a delete. All shots belong to one participant and one distance.
export function saveResults(db, auth, token, batch) {
  return db.tx(() => {
    if (!batch.length) fail(422, "At least one result is required");
    const first = batch[0];
    if (batch.some((r) => r.participant_id !== first.participant_id || r.distance_id !== first.distance_id))
      fail(422, "A save request may only contain one participant and distance");
    const host = authorize(db, auth, token, first.participant_id, first.distance_id);
    const status = eventStatus(db);
    if (status !== "started" && !(status === "finished" && host))
      fail(403, "Results may only be changed during a started event");
    const distance = findDistance(db, first.distance_id);
    if (distance.status === "pending") fail(403, "Distance has not started");
    if (batch.some((r) => r.shot_number > distance.shots_count))
      fail(422, "Shot number exceeds the distance limit");
    write(db, first.participant_id, distance, batch, false);
    broadcast(db, first.participant_id);
    return { message: "Results saved", count: batch.length };
  });
}

// Replace all the shots of one participant on one distance.
export function replaceResults(db, auth, token, participantId, distanceId, shots) {
  return db.tx(() => {
    const host = authorize(db, auth, token, participantId, distanceId);
    const status = eventStatus(db);
    if (status === "finished" && !host) fail(403, "The event has finished");
    const distance = findDistance(db, distanceId);
    if (distance.status === "pending") fail(403, "Distance has not started");
    if (distance.status === "finished" && !host && status !== "started")
      fail(403, "Only the host may edit this distance");
    if (shots.some((s) => s.shot_number > distance.shots_count))
      fail(422, "Shot number exceeds the distance limit");
    write(db, participantId, distance, shots, true);
    broadcast(db, participantId);
    return { message: "Results replaced", count: shots.length };
  });
}

export function deleteResults(db, participantId) {
  return db.tx(() => {
    participantExists(db, participantId);
    db.run("DELETE FROM results WHERE participant_id = ?", participantId);
    broadcast(db, participantId);
    return { message: "Results deleted" };
  });
}

// All the distances and shots of one participant. The shots of a finished
// distance are not in the list, because the client needs only the total.
export function participantState(db, id) {
  participantExists(db, id);
  const shots = db.all(
    "SELECT distance_id, shot, score, is_x FROM results WHERE participant_id = ? ORDER BY distance_id, shot",
    id,
  );
  const byDistance = Map.groupBy(shots, (row) => row.distance_id);
  return {
    distances: db.all("SELECT id, title, shots_count, status FROM distances ORDER BY sort_order").map((d) => {
      const rows = byDistance.get(d.id) ?? [];
      return {
        distance_id: d.id,
        title: d.title,
        shots_count: d.shots_count,
        status: d.status,
        total_score: rows.length ? rows.reduce((sum, row) => sum + row.score, 0) : null,
        x_count: rows.filter((row) => row.is_x).length,
        shots_taken: rows.length,
        shots:
          d.status === "finished"
            ? []
            : rows.map((row) => ({ shot: row.shot, score: row.score, is_x: Boolean(row.is_x) })),
      };
    }),
  };
}

// The shots of one participant on one distance, grouped in series.
export function distanceDetail(db, participantId, distanceId) {
  participantExists(db, participantId);
  const distance = findDistance(db, distanceId);
  const shots = db.all(
    "SELECT shot, score, is_x FROM results WHERE participant_id = ? AND distance_id = ? ORDER BY shot",
    participantId,
    distanceId,
  );
  const byShot = new Map(shots.map((row) => [row.shot, row]));
  const series = [];
  for (let number = 1; number <= Math.ceil(distance.shots_count / SERIES); number++) {
    const values = [];
    for (let shot = (number - 1) * SERIES + 1; shot <= Math.min(number * SERIES, distance.shots_count); shot++) {
      const row = byShot.get(shot);
      values.push({ shot, score: row?.score ?? null, is_x: Boolean(row?.is_x) });
    }
    const taken = values.filter((value) => value.score !== null);
    const total = taken.reduce((sum, value) => sum + value.score, 0);
    series.push({ series: number, shots: values, total, avg: taken.length ? total / taken.length : 0 });
  }
  const total = shots.reduce((sum, row) => sum + row.score, 0);
  return {
    title: distance.title,
    shots_count: distance.shots_count,
    total_score: total,
    x_count: shots.filter((row) => row.is_x).length,
    ten_count: shots.filter((row) => row.score === 10).length,
    avg_score: shots.length ? total / shots.length : 0,
    series,
  };
}

// Participants with scores, in groups by gender and shooting type. Each group is
// in ranking order. The result stays in memory until a change in the data.
export function leaderboard(db) {
  return db.memoize("leaderboard", () => {
    const distances = db.all("SELECT id, title, shots_count, status FROM distances ORDER BY sort_order");
    const totals = Map.groupBy(
      db.all(
        "SELECT participant_id, distance_id, SUM(score) AS total, COUNT(*) AS count, SUM(is_x) AS x_count, SUM(score = 10) AS ten_count FROM results GROUP BY participant_id, distance_id",
      ),
      (row) => row.participant_id,
    );
    const grouped = {};
    for (const p of db.all(
      "SELECT id, name, lane, shift, COALESCE(age_category, 'unknown') AS age_category, COALESCE(group_type, 'unknown') AS group_type, COALESCE(gender, 'unknown') AS gender, COALESCE(shooting_type, 'unknown') AS shooting_type FROM participants",
    )) {
      const rows = totals.get(p.id);
      if (!rows) continue;
      const byDistance = new Map(rows.map((row) => [row.distance_id, row]));
      let total = 0, xs = 0, tens = 0, count = 0;
      const scores = [];
      for (const d of distances) {
        if (d.status === "pending") continue;
        const row = byDistance.get(d.id);
        if (row) {
          total += row.total;
          xs += row.x_count;
          tens += row.ten_count;
          count += row.count;
        }
        scores.push({
          distance_id: d.id,
          title: d.title,
          score: row?.total ?? null,
          shots_count: d.shots_count,
          shots_taken: row?.count ?? 0,
        });
      }
      (grouped[`${p.gender}_${p.shooting_type}`] ??= []).push({
        id: p.id,
        name: p.name,
        lane_shift: `${p.lane}${p.shift}`,
        gender: p.gender,
        shooting_type: p.shooting_type,
        group_type: p.group_type,
        age_category: p.age_category,
        total_score: total,
        x_count: xs,
        ten_count: tens,
        avg_score: count ? total / count : 0,
        distance_scores: scores,
      });
    }
    // The ranking rule: more points, then more 10s (an X is a 10), then more X.
    for (const list of Object.values(grouped))
      list.sort((a, b) => b.total_score - a.total_score || b.ten_count - a.ten_count || b.x_count - a.x_count || a.id - b.id);
    return grouped;
  });
}
