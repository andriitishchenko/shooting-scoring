// A lane that has a password can ask the host for a reset. The host approves or denies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startApp, connectSocket, waitFor, wait } from "./helpers.js";

const base = (code, lane) => `/api/sessions/${code}/lane/${lane}`;

async function setup(t, overrides = {}) {
  const ctx = await startApp(t, overrides);
  const event = await ctx.createEvent("RST001", 6);
  const lane = (await ctx.request("POST", base(event.code, 1), {})).data;
  await ctx.request("POST", `/api/participants/${event.code}`, { name: "Archer", lane_number: 1, shift: "A" }, event.host);
  const ask = (laneNumber = 1) => ctx.request("POST", `${base(event.code, laneNumber)}/reset-request`, {});
  const status = (id, laneNumber = 1) => ctx.request("POST", `${base(event.code, laneNumber)}/reset-request/status`, { request_id: id });
  const decide = (verdict, session = event.host, laneNumber = 1) =>
    ctx.request("POST", `${base(event.code, laneNumber)}/reset-request/${verdict}`, {}, session);
  const lanes = () => ctx.request("GET", `/api/sessions/${event.code}/lanes`, undefined, event.host);
  return { ...ctx, event, lane, ask, status, decide, lanes };
}

test("a lane asks for a reset and gets a secret request id", async (t) => {
  const { ask, status } = await setup(t);
  const answer = await ask();
  assert.equal(answer.status, 200);
  assert.equal(answer.data.status, "pending");
  assert.ok(answer.data.request_id.length >= 40);
  assert.deepEqual((await status(answer.data.request_id)).data, { status: "pending" });
});

test("the host sees the request with its time, and the list of lanes keeps working", async (t) => {
  const { ask, lanes, lane } = await setup(t);
  assert.deepEqual((await lanes()).data.requests, {});
  await ask();
  const list = (await lanes()).data;
  assert.deepEqual(list.lanes, [1]);
  assert.equal(list.passwords[1], lane.password);
  assert.deepEqual(Object.keys(list.requests), ["1"]);
  assert.match(list.requests[1], /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
});

test("an approved request gives the lane a new password and a session, one time", async (t) => {
  const { ask, status, decide, request, event, lane, lanes } = await setup(t);
  const { request_id } = (await ask()).data;
  const approved = await decide("approve");
  assert.equal(approved.status, 200);
  const result = (await status(request_id)).data;
  assert.equal(result.status, "approved");
  assert.equal(result.lane_number, 1);
  assert.match(result.password, /^[A-Z0-9]{6}$/);
  assert.notEqual(result.password, lane.password);
  assert.ok(result.session_id.length >= 40);
  // The new session works. The old password and the old session do not.
  const add = (session) => request("POST", `/api/participants/${event.code}`, { name: "N", lane_number: 1, shift: "B" }, session);
  assert.equal((await add(result.session_id)).status, 200);
  assert.equal((await add(lane.session_id)).status, 401);
  assert.equal((await request("POST", base(event.code, 1), { password: lane.password })).status, 401);
  assert.equal((await request("POST", base(event.code, 1), { password: result.password.toLowerCase() })).data.status, "ok");
  // The password goes out one time.
  assert.deepEqual((await status(request_id)).data, { status: "expired" });
  const list = (await lanes()).data;
  assert.deepEqual([list.passwords[1], list.requests], [result.password, {}]);
});

test("a denied request changes nothing, and the lane hears it one time", async (t) => {
  const { ask, status, decide, request, event, lane, lanes } = await setup(t);
  const { request_id } = (await ask()).data;
  assert.equal((await decide("deny")).status, 200);
  assert.deepEqual((await status(request_id)).data, { status: "denied" });
  assert.deepEqual((await status(request_id)).data, { status: "expired" });
  assert.deepEqual((await lanes()).data.requests, {});
  assert.equal((await lanes()).data.passwords[1], lane.password);
  assert.equal((await request("POST", base(event.code, 1), { session_id: lane.session_id })).data.status, "ok");
  assert.equal((await request("POST", base(event.code, 1), { password: lane.password })).data.status, "ok");
});

test("a new request replaces the old one", async (t) => {
  const { ask, status, decide, lanes } = await setup(t);
  const first = (await ask()).data.request_id;
  const second = (await ask()).data.request_id;
  assert.notEqual(first, second);
  assert.deepEqual((await status(first)).data, { status: "expired" });
  assert.deepEqual((await status(second)).data, { status: "pending" });
  assert.equal(Object.keys((await lanes()).data.requests).length, 1);
  await decide("approve");
  assert.equal((await status(second)).data.status, "approved");
});

test("a request id works only for its own lane and event", async (t) => {
  const { ask, status, request, createEvent, event } = await setup(t);
  await request("POST", base(event.code, 2), {});
  const { request_id } = (await ask()).data;
  assert.deepEqual((await status(request_id, 2)).data, { status: "expired" });
  const other = await createEvent("RST002");
  await request("POST", base(other.code, 1), {});
  assert.deepEqual((await request("POST", `${base(other.code, 1)}/reset-request/status`, { request_id })).data, { status: "expired" });
  for (const wrong of ["", "x", "a".repeat(40), request_id.slice(0, -1) + "A"])
    assert.ok([200, 422].includes((await status(wrong)).status));
  assert.deepEqual((await status("a".repeat(40))).data, { status: "expired" });
  assert.deepEqual((await status(request_id)).data, { status: "pending" });
});

test("only the host decides, and only about a request that exists", async (t) => {
  const { ask, decide, lane, event, request } = await setup(t);
  assert.equal((await decide("approve")).status, 404);
  assert.equal((await decide("deny")).status, 404);
  await ask();
  assert.equal((await decide("approve", lane.session_id)).status, 401);
  assert.equal((await decide("deny", "")).status, 401);
  assert.equal((await decide("approve", "wrong-token-value-123")).status, 401);
  const viewer = (await request("POST", `/api/sessions/${event.code}/viewer`, {})).data.session_id;
  assert.equal((await decide("approve", viewer)).status, 401);
  assert.equal((await decide("approve")).status, 200);
  assert.equal((await decide("approve")).status, 404);
  assert.equal((await decide("deny")).status, 404);
});

test("a lane without a password cannot ask, and the numbers are checked", async (t) => {
  const { ask, request, event } = await setup(t);
  const missing = await ask(7);
  assert.equal(missing.status, 409);
  assert.match(missing.data.detail, /no password/i);
  for (const lane of ["0", "1000", "abc"])
    assert.equal((await request("POST", `${base(event.code, lane)}/reset-request`, {})).status, 422);
  assert.equal((await request("POST", "/api/sessions/NOPE01/lane/1/reset-request", {})).status, 404);
  assert.equal((await request("POST", `${base(event.code, 1)}/reset-request/status`, {})).status, 422);
  assert.equal((await request("POST", `${base(event.code, 1)}/reset-request/status`, { request_id: 5 })).status, 422);
});

test("a request ends after its time, and so does a result that nobody collected", async (t) => {
  const { ask, status, decide, lanes, request, event } = await setup(t, { resetTtlMs: 150 });
  const pending = (await ask()).data.request_id;
  await wait(250);
  assert.deepEqual((await status(pending)).data, { status: "expired" });
  assert.deepEqual((await lanes()).data.requests, {});
  assert.equal((await decide("approve")).status, 404);
  const second = (await ask()).data.request_id;
  await decide("approve");
  await wait(250);
  assert.deepEqual((await status(second)).data, { status: "expired" });
  const list = (await lanes()).data;
  assert.match(list.passwords[1], /^[A-Z0-9]{6}$/);
  assert.equal((await request("POST", base(event.code, 1), { password: list.passwords[1] })).data.status, "ok");
});

test("a reset by the host removes a request that waits", async (t) => {
  const { ask, status, request, event } = await setup(t);
  const { request_id } = (await ask()).data;
  await request("DELETE", base(event.code, 1), undefined, event.host);
  assert.deepEqual((await status(request_id)).data, { status: "expired" });
  assert.equal((await request("GET", `/api/sessions/${event.code}/lanes`, undefined, event.host)).data.requests[1], undefined);
});

test("the host hears about a request, and the lane devices are disconnected after an approval", async (t) => {
  const { ask, decide, event, lane, base: server } = await setup(t);
  const hostSocket = await connectSocket(server, event.code, event.host);
  const laneSocket = await connectSocket(server, event.code, lane.session_id);
  t.after(() => [hostSocket, laneSocket].forEach((socket) => socket.terminate()));
  const messages = () => hostSocket.messages.filter((m) => m.type !== "authenticated");
  await ask();
  await waitFor(() => messages().length >= 1, "request message");
  assert.deepEqual(messages()[0], { type: "lane_reset_requested", lane_number: 1 });
  await decide("approve");
  assert.equal(await laneSocket.closed, 4001);
  await waitFor(() => messages().some((m) => m.type === "lane_session_reset"), "reset message");
  assert.ok(messages().some((m) => m.type === "refresh"));
});

test("a denial sends a refresh to the host devices", async (t) => {
  const { ask, decide, event, base: server } = await setup(t);
  const hostSocket = await connectSocket(server, event.code, event.host);
  t.after(() => hostSocket.terminate());
  await ask();
  await decide("deny");
  await waitFor(() => hostSocket.messages.filter((m) => m.type === "refresh").length >= 1, "refresh message");
});

test("requests from one address are limited, and the limit is per lane", async (t) => {
  const { ask, request, event } = await setup(t, { loginFailureLimit: 10_000 });
  await request("POST", base(event.code, 2), {});
  for (let i = 0; i < 10; i++) assert.equal((await ask()).status, 200, `request ${i + 1}`);
  const limited = await ask();
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.equal((await ask(2)).status, 200);
});

test("parallel approvals give one new password only", async (t) => {
  const { ask, status, decide, lanes } = await setup(t);
  const { request_id } = (await ask()).data;
  const answers = await Promise.all([decide("approve"), decide("approve"), decide("approve"), decide("deny")]);
  assert.equal(answers.filter((a) => a.status === 200).length, 1);
  const result = (await status(request_id)).data;
  if (result.status === "approved") assert.equal((await lanes()).data.passwords[1], result.password);
  else assert.equal(result.status, "denied");
});

test("no public answer shows a request id or a password", async (t) => {
  const { ask, request, event, lane } = await setup(t);
  const { request_id } = (await ask()).data;
  for (const url of [`/api/events/${event.code}`, `/api/distances/${event.code}`, `/api/participants/${event.code}`, `/api/properties/${event.code}/public`, `/api/results/${event.code}/leaderboard`]) {
    const text = JSON.stringify((await request("GET", url)).data);
    assert.equal(text.includes(request_id) || text.includes(lane.password), false, url);
  }
  assert.equal((await request("GET", `/api/sessions/${event.code}/lanes`)).status, 401);
});

test("a stopped request list does not grow without limit", async (t) => {
  const { app, request, event } = await setup(t, { resetTtlMs: 50, loginFailureLimit: 10_000 });
  for (let lane = 2; lane <= 40; lane++) {
    await request("POST", base(event.code, lane), {});
    await request("POST", `${base(event.code, lane)}/reset-request`, {});
  }
  await wait(120);
  await request("POST", `${base(event.code, 1)}/reset-request`, {});
  assert.ok(app.resets.size <= 2, `The list has ${app.resets.size} entries`);
});
