import { test } from "node:test";
import assert from "node:assert/strict";
import { runningEvent } from "./helpers.js";

async function setup(t) {
  const ctx = await runningEvent(t);
  const { event, participant, distance } = ctx;
  const urls = {
    replace: `/api/results/${event.code}/participant/${participant}/distance/${distance}`,
    state: `/api/results/${event.code}/state/${participant}`,
    detail: `/api/results/${event.code}/detail/${participant}/${distance}`,
    board: `/api/results/${event.code}/leaderboard`,
    save: `/api/results/${event.code}`,
  };
  const shot = (number, score = 9, is_x = false) => ({ shot_number: number, score, is_x });
  const batch = (...shots) => shots.map((s) => ({ participant_id: participant, distance_id: distance, ...s }));
  return { ...ctx, urls, shot, batch, laneSession: ctx.lane.session_id, host: event.host };
}

test("a lane replaces the shots of its participant and the state shows them", async (t) => {
  const { request, urls, shot, laneSession } = await setup(t);
  const saved = await request("PUT", urls.replace, { shots: [shot(1, 10, true), shot(2, 9), shot(3, 0)] }, laneSession);
  assert.deepEqual(saved.data, { message: "Results replaced", count: 3 });
  const state = (await request("GET", urls.state)).data.distances[0];
  assert.equal(state.total_score, 19);
  assert.equal(state.x_count, 1);
  assert.deepEqual(state.shots, [
    { shot: 1, score: 10, is_x: true },
    { shot: 2, score: 9, is_x: false },
    { shot: 3, score: 0, is_x: false },
  ]);
});

test("a replacement deletes the shots that are not in the list, also all of them", async (t) => {
  const { request, urls, shot, laneSession } = await setup(t);
  await request("PUT", urls.replace, { shots: [shot(1), shot(2), shot(3), shot(4)] }, laneSession);
  await request("PUT", urls.replace, { shots: [shot(1), shot(2)] }, laneSession);
  assert.equal((await request("GET", urls.state)).data.distances[0].shots.length, 2);
  await request("PUT", urls.replace, { shots: [] }, laneSession);
  const state = (await request("GET", urls.state)).data.distances[0];
  assert.deepEqual([state.total_score, state.x_count, state.shots], [null, 0, []]);
});

for (const [name, shots] of [
  ["a score above 10", [{ shot_number: 1, score: 11 }]],
  ["a negative score", [{ shot_number: 1, score: -1 }]],
  ["a fraction score", [{ shot_number: 1, score: 9.5 }]],
  ["a shot number 0", [{ shot_number: 0, score: 5 }]],
  ["a shot number 301", [{ shot_number: 301, score: 5 }]],
  ["an X with a score of 9", [{ shot_number: 1, score: 9, is_x: true }]],
  ["a text X", [{ shot_number: 1, score: 10, is_x: "yes" }]],
  ["the same shot two times", [{ shot_number: 1, score: 5 }, { shot_number: 1, score: 6 }]],
  ["a missing score", [{ shot_number: 1 }]],
  ["a shot that is not an object", [5]],
]) {
  test(`a replacement is rejected for ${name}`, async (t) => {
    const { request, urls, laneSession } = await setup(t);
    assert.equal((await request("PUT", urls.replace, { shots }, laneSession)).status, 422);
  });
}

test("a replacement cannot have more than 300 shots or lack the list", async (t) => {
  const { request, urls, laneSession } = await setup(t);
  const many = Array.from({ length: 301 }, (_, i) => ({ shot_number: Math.min(i + 1, 300), score: 1 }));
  assert.equal((await request("PUT", urls.replace, { shots: many }, laneSession)).status, 422);
  assert.equal((await request("PUT", urls.replace, {}, laneSession)).status, 422);
  assert.equal((await request("PUT", urls.replace, { shots: "x" }, laneSession)).status, 422);
});

test("a shot number above the distance size is rejected", async (t) => {
  const { request, urls, shot, laneSession } = await setup(t);
  const answer = await request("PUT", urls.replace, { shots: [shot(7)] }, laneSession);
  assert.equal(answer.status, 422);
  assert.equal(answer.data.detail, "Shot number exceeds the distance limit");
  assert.equal((await request("PUT", urls.replace, { shots: [shot(6)] }, laneSession)).status, 200);
});

test("a lane cannot write for another lane, and a request without a session is rejected", async (t) => {
  const { request, urls, shot, event, participant, host } = await setup(t);
  const other = (await request("POST", `/api/sessions/${event.code}/lane/2`, {})).data;
  const denied = await request("PUT", urls.replace, { shots: [shot(1)] }, other.session_id);
  assert.equal(denied.status, 401);
  assert.equal(denied.data.detail, "Invalid session for participant lane");
  assert.equal((await request("PUT", urls.replace, { shots: [shot(1)] })).data.detail, "Session ID required");
  assert.equal((await request("PUT", urls.replace, { shots: [shot(1)] }, "wrong-token-value-123")).status, 401);
  const viewer = (await request("POST", `/api/sessions/${event.code}/viewer`, {})).data;
  assert.equal((await request("PUT", urls.replace, { shots: [shot(1)] }, viewer.session_id)).status, 401);
  assert.equal((await request("GET", urls.state)).data.distances[0].shots.length, 0);
  assert.equal(participant > 0 && Boolean(host), true);
});

test("a missing participant or distance gives 404 before the lane check", async (t) => {
  const { request, event, shot, laneSession, distance, participant } = await setup(t);
  const put = (p, d, session = laneSession) =>
    request("PUT", `/api/results/${event.code}/participant/${p}/distance/${d}`, { shots: [shot(1)] }, session);
  assert.equal((await put(999, distance)).data.detail, "Participant not found");
  assert.equal((await put(participant, 999)).data.detail, "Distance not found");
  assert.equal((await put(0, distance)).status, 422);
  assert.equal((await put("x", distance)).status, 422);
});

test("a lane can write only to a distance that started", async (t) => {
  const { request, event, host, participant, shot, laneSession } = await setup(t);
  await request("POST", `/api/distances/${event.code}`, { title: "Later", shots_count: 6 }, host);
  const later = `/api/results/${event.code}/participant/${participant}/distance/2`;
  const denied = await request("PUT", later, { shots: [shot(1)] }, laneSession);
  assert.equal(denied.status, 403);
  assert.equal(denied.data.detail, "Distance has not started");
});

test("a finished distance accepts a lane replacement while the event runs", async (t) => {
  const { request, event, host, urls, shot, laneSession } = await setup(t);
  await request("POST", `/api/distances/${event.code}`, { title: "B", shots_count: 6 }, host);
  await request("PATCH", `/api/distances/${event.code}/2`, { status: "active" }, host);
  assert.equal((await request("GET", `/api/distances/${event.code}`)).data[0].status, "finished");
  assert.equal((await request("PUT", urls.replace, { shots: [shot(1, 7)] }, laneSession)).status, 200);
  const state = (await request("GET", urls.state)).data.distances[0];
  assert.deepEqual([state.status, state.total_score, state.shots], ["finished", 7, []]);
});

test("after the event finishes, only the host can change a result", async (t) => {
  const { request, event, host, urls, shot, laneSession } = await setup(t);
  await request("PUT", urls.replace, { shots: [shot(1, 5), shot(2, 6)] }, laneSession);
  await request("PATCH", `/api/events/${event.code}`, { status: "finished" }, host);
  const denied = await request("PUT", urls.replace, { shots: [shot(1)] }, laneSession);
  assert.equal(denied.status, 403);
  assert.equal(denied.data.detail, "The event has finished");
  assert.equal((await request("PUT", urls.replace, { shots: [shot(1, 8)] }, host)).status, 200);
  const detail = (await request("GET", urls.detail)).data;
  assert.equal(detail.total_score, 8);
  assert.equal(detail.series[0].shots[1].score, null);
  const missed = await request("POST", urls.save, [{ participant_id: 1, distance_id: 1, shot_number: 2, score: 0 }], host);
  assert.equal(missed.status, 200);
  assert.equal((await request("GET", urls.detail)).data.series[0].shots[1].score, 0);
  assert.equal((await request("POST", urls.save, [{ participant_id: 1, distance_id: 1, shot_number: 3, score: 1 }], laneSession)).status, 403);
});

test("saving a batch adds and updates shots without deleting the others", async (t) => {
  const { request, urls, batch, shot, laneSession } = await setup(t);
  await request("PUT", urls.replace, { shots: [shot(1, 5), shot(2, 6)] }, laneSession);
  const saved = await request("POST", urls.save, batch({ shot_number: 2, score: 9 }, { shot_number: 3, score: 10, is_x: true }), laneSession);
  assert.deepEqual(saved.data, { message: "Results saved", count: 2 });
  const state = (await request("GET", urls.state)).data.distances[0];
  assert.deepEqual(state.shots.map((s) => [s.shot, s.score, s.is_x]), [[1, 5, false], [2, 9, false], [3, 10, true]]);
});

test("a batch is rejected when it is empty, mixed, or not valid", async (t) => {
  const { request, urls, batch, participant, distance, laneSession } = await setup(t);
  assert.equal((await request("POST", urls.save, [], laneSession)).data.detail, "At least one result is required");
  const mixed = [{ participant_id: participant, distance_id: distance, shot_number: 1, score: 1 }, { participant_id: participant + 1, distance_id: distance, shot_number: 2, score: 1 }];
  assert.equal((await request("POST", urls.save, mixed, laneSession)).data.detail, "A save request may only contain one participant and distance");
  assert.equal((await request("POST", urls.save, batch({ shot_number: 1, score: 11 }), laneSession)).status, 422);
  assert.equal((await request("POST", urls.save, batch({ shot_number: 1, score: 9, is_x: true }), laneSession)).status, 422);
  assert.equal((await request("POST", urls.save, { not: "a list" }, laneSession)).status, 422);
  assert.equal((await request("POST", urls.save, batch({ shot_number: 7, score: 1 }), laneSession)).data.detail, "Shot number exceeds the distance limit");
  assert.equal((await request("POST", urls.save, batch({ shot_number: 1, score: 1 }))).status, 401);
});

test("a batch for a participant that does not exist is rejected with 404", async (t) => {
  const { request, urls, distance, laneSession } = await setup(t);
  const missing = [{ participant_id: 999, distance_id: distance, shot_number: 1, score: 1 }];
  assert.equal((await request("POST", urls.save, missing, laneSession)).status, 404);
});

test("the detail shows series of three and handles a distance that is not a multiple of three", async (t) => {
  const { request, urls, shot, laneSession, event, host, participant } = await setup(t);
  await request("PUT", urls.replace, { shots: [shot(1, 10, true), shot(2, 10), shot(3, 8), shot(5, 4)] }, laneSession);
  const detail = (await request("GET", urls.detail)).data;
  assert.equal(detail.title, "Distance 1");
  assert.equal(detail.total_score, 32);
  assert.equal(detail.x_count, 1);
  assert.equal(detail.ten_count, 2);
  assert.equal(detail.avg_score, 8);
  assert.equal(detail.series.length, 2);
  assert.deepEqual(detail.series[0], {
    series: 1,
    shots: [{ shot: 1, score: 10, is_x: true }, { shot: 2, score: 10, is_x: false }, { shot: 3, score: 8, is_x: false }],
    total: 28,
    avg: 28 / 3,
  });
  assert.deepEqual(detail.series[1].shots.map((s) => s.score), [null, 4, null]);
  assert.equal(detail.series[1].avg, 4);
});

test("the detail and the state reject an unknown participant or distance", async (t) => {
  const { request, event, distance } = await setup(t);
  assert.equal((await request("GET", `/api/results/${event.code}/state/999`)).status, 404);
  assert.equal((await request("GET", `/api/results/${event.code}/detail/999/${distance}`)).data.detail, "Participant not found");
  assert.equal((await request("GET", `/api/results/${event.code}/detail/1/999`)).data.detail, "Distance not found");
  assert.equal((await request("GET", `/api/results/${event.code}/state/abc`)).status, 422);
});

test("the leaderboard groups scored participants and counts X and 10", async (t) => {
  const { request, urls, shot, laneSession, event, host } = await setup(t);
  assert.deepEqual((await request("GET", urls.board)).data, {});
  await request("PUT", urls.replace, { shots: [shot(1, 10, true), shot(2, 10), shot(3, 7)] }, laneSession);
  const board = (await request("GET", urls.board)).data;
  assert.deepEqual(Object.keys(board), ["unknown_unknown"]);
  assert.deepEqual(board.unknown_unknown, [{
    id: 1, name: "Archer", lane_shift: "1A", gender: "unknown", shooting_type: "unknown", group_type: "unknown",
    age_category: "unknown", total_score: 27, x_count: 1, ten_count: 2, avg_score: 9,
    distance_scores: [{ distance_id: 1, title: "Distance 1", score: 27, shots_count: 6, shots_taken: 3 }],
  }]);
});

test("the leaderboard follows each change and is cached between changes", async (t) => {
  const { request, urls, shot, laneSession, app, event } = await setup(t);
  await request("PUT", urls.replace, { shots: [shot(1, 5)] }, laneSession);
  const first = (await request("GET", urls.board)).data;
  const db = app.pool.get(event.code);
  const revision = db.revision;
  assert.deepEqual((await request("GET", urls.board)).data, first);
  assert.equal(db.revision, revision);
  await request("PUT", urls.replace, { shots: [shot(1, 6)] }, laneSession);
  assert.equal((await request("GET", urls.board)).data.unknown_unknown[0].total_score, 6);
});

test("the leaderboard shows only distances that started and groups by gender and type", async (t) => {
  const ctx = await setup(t);
  const { request, urls, shot, laneSession, event, host } = ctx;
  await request("POST", `/api/distances/${event.code}`, { title: "B", shots_count: 6 }, host);
  await request("PUT", urls.replace, { shots: [shot(1, 5)] }, laneSession);
  let entry = (await request("GET", urls.board)).data.unknown_unknown[0];
  assert.deepEqual(entry.distance_scores.map((d) => d.distance_id), [1]);
  await request("PATCH", `/api/distances/${event.code}/2`, { status: "active" }, host);
  entry = (await request("GET", urls.board)).data.unknown_unknown[0];
  assert.deepEqual(entry.distance_scores.map((d) => [d.distance_id, d.score]), [[1, 5], [2, null]]);
});

test("a participant with a gender and a type has its own group", async (t) => {
  const ctx = await startAppWithGroups(t);
  assert.deepEqual(Object.keys(ctx.board).sort(), ["female_recurve", "male_compound"]);
});

async function startAppWithGroups(t) {
  const { startApp } = await import("./helpers.js");
  const ctx = await startApp(t);
  const event = await ctx.createEvent("GRP001", 3);
  const add = (name, gender, shooting_type, lane) =>
    ctx.request("POST", `/api/participants/GRP001`, { name, lane_number: lane, shift: "A", gender, shooting_type }, event.host);
  await add("A", "male", "compound", 1);
  await add("B", "female", "recurve", 2);
  await ctx.request("PATCH", "/api/events/GRP001", { status: "started" }, event.host);
  await ctx.request("PATCH", "/api/distances/GRP001/1", { status: "active" }, event.host);
  for (const id of [1, 2])
    await ctx.request("PUT", `/api/results/GRP001/participant/${id}/distance/1`, { shots: [{ shot_number: 1, score: id }] }, event.host);
  return { board: (await ctx.request("GET", "/api/results/GRP001/leaderboard")).data };
}

test("the host deletes the results of a participant", async (t) => {
  const { request, urls, shot, laneSession, event, host } = await setup(t);
  await request("PUT", urls.replace, { shots: [shot(1, 5)] }, laneSession);
  const answer = await request("DELETE", `/api/results/${event.code}/1`, undefined, host);
  assert.deepEqual(answer.data, { message: "Results deleted" });
  assert.deepEqual((await request("GET", urls.board)).data, {});
  assert.equal((await request("DELETE", `/api/results/${event.code}/1`, undefined, laneSession)).status, 401);
  assert.equal((await request("DELETE", `/api/results/${event.code}/999`, undefined, host)).status, 404);
});

test("parallel replacements of one participant end with one complete list", async (t) => {
  const { request, urls, laneSession } = await setup(t);
  const lists = Array.from({ length: 12 }, (_, i) => [{ shot_number: 1, score: i % 11 }, { shot_number: 2, score: (i + 1) % 11 }]);
  await Promise.all(lists.map((shots) => request("PUT", urls.replace, { shots }, laneSession)));
  const state = (await request("GET", urls.state)).data.distances[0];
  assert.equal(state.shots.length, 2);
  const scores = state.shots.map((s) => s.score);
  assert.ok(lists.some((shots) => shots.every((s, i) => s.score === scores[i])), "The shots come from one request");
});

test("the leaderboard orders each group by points, then 10s, then X", async (t) => {
  const { startApp } = await import("./helpers.js");
  const ctx = await startApp(t);
  const event = await ctx.createEvent("TIE001", 6);
  const names = ["Plain", "More tens", "More X", "Fewer points", "Same as plain", "Most points"];
  for (const [index, name] of names.entries())
    await ctx.request("POST", "/api/participants/TIE001", { name, lane_number: index + 1, shift: "A" }, event.host);
  await ctx.request("PATCH", "/api/events/TIE001", { status: "started" }, event.host);
  await ctx.request("PATCH", "/api/distances/TIE001/1", { status: "active" }, event.host);
  const X = { score: 10, is_x: true };
  const ten = { score: 10 };
  const shots = {
    1: [ten, ten, { score: 7 }],        // 27, two 10s, no X
    2: [ten, ten, ten],                 // 30, three 10s
    3: [X, ten, { score: 7 }],          // 27, two 10s, one X
    4: [{ score: 9 }, { score: 9 }, { score: 8 }], // 26
    5: [ten, ten, { score: 7 }],        // 27, two 10s, no X (same as 1)
    6: [X, X, X],                       // 30, three 10s, three X
  };
  for (const [id, list] of Object.entries(shots))
    await ctx.request("PUT", `/api/results/TIE001/participant/${id}/distance/1`, { shots: list.map((s, i) => ({ shot_number: i + 1, ...s })) }, event.host);
  const board = (await ctx.request("GET", "/api/results/TIE001/leaderboard")).data;
  assert.deepEqual(board.unknown_unknown.map((e) => e.name), ["Most points", "More tens", "More X", "Plain", "Same as plain", "Fewer points"]);
});

test("the state counts the shots that were taken, also for a finished distance", async (t) => {
  const { request, urls, shot, laneSession, event, host } = await setup(t);
  assert.equal((await request("GET", urls.state)).data.distances[0].shots_taken, 0);
  await request("PUT", urls.replace, { shots: [shot(1, 5), shot(2, 6), shot(4, 7)] }, laneSession);
  let state = (await request("GET", urls.state)).data.distances[0];
  assert.deepEqual([state.shots_taken, state.shots.length], [3, 3]);
  await request("POST", `/api/distances/${event.code}`, { title: "B", shots_count: 3 }, host);
  await request("PATCH", `/api/distances/${event.code}/2`, { status: "active" }, host);
  state = (await request("GET", urls.state)).data.distances;
  assert.deepEqual([state[0].status, state[0].shots, state[0].shots_taken], ["finished", [], 3]);
  assert.deepEqual([state[1].status, state[1].shots_taken], ["active", 0]);
});
