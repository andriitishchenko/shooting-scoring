// A busy event, like a real competition: 28 lanes with 3 participants each score
// at the same time, a host and many viewers follow, and the data stays correct.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startApp, connectSocket, waitFor, wait } from "./helpers.js";

const LANES = 28;
const PER_LANE = 3;
const SHOTS = 30;

test("28 lanes score at the same time while the host and the viewers follow", { timeout: 60_000 }, async (t) => {
  const { request, createEvent, base, app, errors } = await startApp(t, { loginFailureLimit: 100_000 });
  const event = await createEvent("BIG001", SHOTS);
  const { code, host } = event;
  let id = 0;
  const people = [];
  for (let lane = 1; lane <= LANES; lane++)
    for (let n = 0; n < PER_LANE; n++) {
      const added = await request("POST", `/api/participants/${code}`, { name: `P${++id}`, lane_number: lane, shift: "A", gender: id % 2 ? "male" : "female", shooting_type: "recurve" }, host);
      people.push({ id: added.data.id, lane });
    }
  const sessions = new Map();
  await Promise.all(Array.from({ length: LANES }, (_, i) => request("POST", `/api/sessions/${code}/lane/${i + 1}`, {}).then((a) => sessions.set(i + 1, a.data.session_id))));
  await request("PATCH", `/api/events/${code}`, { status: "started" }, host);
  await request("PATCH", `/api/distances/${code}/1`, { status: "active" }, host);

  const viewers = await Promise.all(Array.from({ length: 20 }, async () => connectSocket(base, code, (await request("POST", `/api/sessions/${code}/viewer`, {})).data.session_id)));
  const hostSocket = await connectSocket(base, code, host);
  t.after(() => [...viewers, hostSocket].forEach((socket) => socket.terminate()));

  // Each lane enters the shots one by one: every shot sends the complete list so far.
  const expected = new Map(people.map((p) => [p.id, 0]));
  const score = (person, shot) => (person.id * 7 + shot * 3) % 11;
  const started = performance.now();
  let writes = 0;
  await Promise.all(
    Array.from({ length: LANES }, async (_, index) => {
      const lane = index + 1;
      const mine = people.filter((p) => p.lane === lane);
      for (let shot = 1; shot <= SHOTS; shot++)
        for (const person of mine) {
          const shots = Array.from({ length: shot }, (_, i) => ({ shot_number: i + 1, score: score(person, i + 1) }));
          const answer = await request("PUT", `/api/results/${code}/participant/${person.id}/distance/1`, { shots }, sessions.get(lane));
          assert.equal(answer.status, 200, JSON.stringify(answer.data));
          writes++;
        }
    }),
  );
  const seconds = (performance.now() - started) / 1000;
  for (const person of people) expected.set(person.id, Array.from({ length: SHOTS }, (_, i) => score(person, i + 1)).reduce((a, b) => a + b, 0));

  // The data: each participant has all shots, and the totals are right.
  const board = (await request("GET", `/api/results/${code}/leaderboard`)).data;
  const entries = Object.values(board).flat();
  assert.equal(entries.length, people.length);
  for (const entry of entries) assert.equal(entry.total_score, expected.get(entry.id), entry.name);
  for (const list of Object.values(board))
    for (let i = 1; i < list.length; i++)
      assert.ok(list[i - 1].total_score >= list[i].total_score, "The group is in ranking order");
  for (const person of people) {
    const state = (await request("GET", `/api/results/${code}/state/${person.id}`)).data.distances[0];
    assert.equal(state.shots.length, SHOTS);
    assert.equal(state.total_score, expected.get(person.id));
  }

  // The messages: each socket got every result_update, and the last total of each participant is right.
  await waitFor(() => viewers.every((socket) => socket.messages.filter((m) => m.type === "result_update").length >= writes), "all messages arrive", 15_000);
  for (const socket of [...viewers, hostSocket]) {
    const updates = socket.messages.filter((m) => m.type === "result_update");
    assert.equal(updates.length, writes);
    const last = new Map();
    for (const message of updates) last.set(message.participant_id, message.total_score);
    for (const [pid, total] of expected) assert.equal(last.get(pid), total);
  }
  assert.deepEqual(errors, []);
  assert.ok(app.pool.open.size <= 32);
  console.log(`soak: ${writes} writes in ${seconds.toFixed(1)} s (${Math.round(writes / seconds)} per second), ${viewers.length + 1} sockets, heap ${Math.round(process.memoryUsage().heapUsed / 1048576)} MB`);
  await wait(10);
});
