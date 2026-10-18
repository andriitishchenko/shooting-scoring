import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startApp } from "./helpers.js";

test("health answers without an event", async (t) => {
  const { request, app } = await startApp(t);
  const answer = await request("GET", "/api/health");
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.data, { status: "ok", service: "shooting-scoring", version: app.version });
});

test("an event starts with one pending distance and a host session", async (t) => {
  const { request } = await startApp(t);
  const created = await request("POST", "/api/events/create", { code: " abc123 ", shots_count: 12 });
  assert.equal(created.status, 200);
  assert.equal(created.data.code, "ABC123");
  assert.equal(created.data.message, "Event created");
  assert.match(created.data.host_password, /^[A-Z0-9]{16}$/);
  assert.ok(created.data.session_id.length >= 32);

  const event = (await request("GET", "/api/events/ABC123")).data;
  assert.equal(event.code, "ABC123");
  assert.equal(event.shots_count, 12);
  assert.equal(event.status, "created");
  assert.equal(event.started_at, null);
  assert.match(event.created_at, /^\d{4}-\d\d-\d\dT/);
  const distances = (await request("GET", "/api/distances/ABC123")).data;
  assert.deepEqual(distances, [{ id: 1, title: "Distance 1", shots_count: 12, sort_order: 0, status: "pending" }]);
});

test("the shot count defaults to 30", async (t) => {
  const { request } = await startApp(t);
  await request("POST", "/api/events/create", { code: "DEF030" });
  assert.equal((await request("GET", "/api/events/DEF030")).data.shots_count, 30);
});

for (const [name, body] of [
  ["no code", {}],
  ["empty code", { code: "" }],
  ["spaces only", { code: "   " }],
  ["a symbol", { code: "AB-12" }],
  ["a long code", { code: "A".repeat(17) }],
  ["a number code", { code: 123456 }],
  ["zero shots", { code: "ABC123", shots_count: 0 }],
  ["too many shots", { code: "ABC123", shots_count: 301 }],
  ["text shots", { code: "ABC123", shots_count: "6" }],
  ["fraction shots", { code: "ABC123", shots_count: 1.5 }],
  ["boolean shots", { code: "ABC123", shots_count: true }],
]) {
  test(`creating an event is rejected for ${name}`, async (t) => {
    const { request } = await startApp(t);
    const answer = await request("POST", "/api/events/create", body);
    assert.equal(answer.status, 422);
    assert.ok(Array.isArray(answer.data.detail));
    assert.ok(answer.data.detail.every((item) => Array.isArray(item.loc) && typeof item.msg === "string"));
  });
}

test("a body that is not an object is rejected", async (t) => {
  const { request } = await startApp(t);
  assert.equal((await request("POST", "/api/events/create", "[]")).status, 422);
  assert.equal((await request("POST", "/api/events/create", "null")).status, 422);
  assert.equal((await request("POST", "/api/events/create", "{broken")).status, 400);
  assert.equal((await request("POST", "/api/events/create")).status, 422);
});

test("an event code is created only one time, also in parallel", async (t) => {
  const { request, dataDir } = await startApp(t);
  const answers = await Promise.all(
    Array.from({ length: 8 }, () => request("POST", "/api/events/create", { code: "RACE01" })),
  );
  assert.equal(answers.filter((a) => a.status === 200).length, 1);
  assert.equal(answers.filter((a) => a.status === 400).length, 7);
  assert.equal(answers.find((a) => a.status === 400).data.detail, "Code already exists");
  assert.deepEqual(fs.readdirSync(dataDir).filter((name) => name.endsWith(".db")), ["RACE01.db"]);
});

test("a failed start releases the code", async (t) => {
  const { app, request, dataDir } = await startApp(t);
  const original = app.pool.attach.bind(app.pool);
  app.pool.attach = () => {
    throw new Error("disk failure");
  };
  assert.equal((await request("POST", "/api/events/create", { code: "FAIL01" })).status, 500);
  assert.equal(fs.existsSync(path.join(dataDir, "FAIL01.db")), false);
  app.pool.attach = original;
  assert.equal((await request("POST", "/api/events/create", { code: "FAIL01" })).status, 200);
});

test("an unknown or invalid code gives the right error", async (t) => {
  const { request } = await startApp(t);
  const missing = await request("GET", "/api/events/NOPE01");
  assert.equal(missing.status, 404);
  assert.equal(missing.data.detail, "Event not found");
  assert.equal((await request("GET", "/api/events/bad-code")).status, 422);
  assert.equal((await request("GET", "/api/events/lower")).status, 422);
  assert.equal((await request("GET", `/api/events/${"A".repeat(40)}`)).status, 422);
  assert.equal((await request("GET", "/api/events/%ZZ")).status, 404);
});

test("event codes are separate", async (t) => {
  const { request, createEvent } = await startApp(t);
  const one = await createEvent("ONE001");
  const two = await createEvent("TWO002");
  await request("POST", "/api/participants/ONE001", { name: "A", lane_number: 1, shift: "A" }, one.host);
  assert.equal((await request("GET", "/api/participants/ONE001")).data.length, 1);
  assert.equal((await request("GET", "/api/participants/TWO002")).data.length, 0);
  assert.equal(
    (await request("POST", "/api/participants/TWO002", { name: "B", lane_number: 1, shift: "A" }, one.host)).status,
    401,
  );
  assert.equal((await request("PATCH", "/api/events/TWO002", { status: "started" }, one.host)).status, 401);
  assert.equal((await request("PATCH", "/api/events/TWO002", { status: "started" }, two.host)).status, 200);
});

test("the host controls the event status in one direction", async (t) => {
  const { request, createEvent } = await startApp(t);
  const { code, host } = await createEvent();
  const patch = (body, session = host) => request("PATCH", `/api/events/${code}`, body, session);
  assert.equal((await patch({ status: "finished" })).data.detail, "Cannot change event status from created to finished");
  assert.equal((await patch({ status: "started" })).status, 200);
  const started = (await request("GET", `/api/events/${code}`)).data;
  assert.equal(started.status, "started");
  assert.ok(started.started_at);
  assert.equal((await patch({ status: "created" })).status, 403);
  assert.equal((await patch({ status: "started" })).status, 200);
  assert.equal((await patch({ status: "finished" })).status, 200);
  const finished = (await request("GET", `/api/events/${code}`)).data;
  assert.ok(finished.finished_at);
  assert.equal((await patch({ status: "started" })).status, 403);
  assert.equal((await patch({ status: "later" })).status, 422);
  assert.equal((await patch({})).status, 200);
});

test("finishing the event finishes the active distance", async (t) => {
  const { request, createEvent } = await startApp(t);
  const { code, host } = await createEvent();
  await request("PATCH", `/api/events/${code}`, { status: "started" }, host);
  await request("PATCH", `/api/distances/${code}/1`, { status: "active" }, host);
  await request("PATCH", `/api/events/${code}`, { status: "finished" }, host);
  assert.equal((await request("GET", `/api/distances/${code}`)).data[0].status, "finished");
});

test("the shot count of the event can change", async (t) => {
  const { request, createEvent } = await startApp(t);
  const { code, host } = await createEvent();
  assert.equal((await request("PATCH", `/api/events/${code}`, { shots_count: 40 }, host)).status, 200);
  assert.equal((await request("GET", `/api/events/${code}`)).data.shots_count, 40);
  assert.equal((await request("PATCH", `/api/events/${code}`, { shots_count: 0 }, host)).status, 422);
});

test("changing an event needs a valid host session", async (t) => {
  const { request, createEvent } = await startApp(t);
  const { code } = await createEvent();
  assert.equal((await request("PATCH", `/api/events/${code}`, { status: "started" })).data.detail, "Session ID required");
  assert.equal((await request("PATCH", `/api/events/${code}`, { status: "started" }, "wrong-token-value-123")).data.detail, "Invalid or expired session");
  const lane = (await request("POST", `/api/sessions/${code}/lane/1`, {})).data;
  assert.equal((await request("PATCH", `/api/events/${code}`, { status: "started" }, lane.session_id)).status, 401);
});

test("event creation is limited for each address", async (t) => {
  const { request } = await startApp(t, { eventCreateLimit: 3 });
  const create = (code, shots = 3) => request("POST", "/api/events/create", { code, shots_count: shots });
  assert.equal((await create("ONE1")).status, 200);
  assert.equal((await create("BAD", 0)).status, 422);
  assert.equal((await create("ONE1")).status, 400);
  assert.equal((await create("TWO2")).status, 200);
  assert.equal((await create("TRE3")).status, 200);
  const limited = await create("FOU4");
  assert.equal(limited.status, 429);
  assert.deepEqual(limited.data, { detail: "Too many events created. Try again later." });
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
});

test("parallel event creation cannot pass the creation limit", async (t) => {
  const { request } = await startApp(t, { eventCreateLimit: 4 });
  const answers = await Promise.all(
    Array.from({ length: 10 }, (_, i) => request("POST", "/api/events/create", { code: `PAR${i}`, shots_count: 3 })),
  );
  assert.equal(answers.filter((a) => a.status === 200).length, 4);
  assert.equal(answers.filter((a) => a.status === 429).length, 6);
});

test("the event creation limit can be turned off", async (t) => {
  const { request } = await startApp(t, { eventCreateLimit: 0 });
  for (let i = 0; i < 6; i++)
    assert.equal((await request("POST", "/api/events/create", { code: `OFF${i}`, shots_count: 3 })).status, 200);
});
