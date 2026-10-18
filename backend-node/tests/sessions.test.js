import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { startApp, connectSocket } from "./helpers.js";

const login = (request, code, role, body = {}) => request("POST", `/api/sessions/${code}/${role}`, body);

test("the host logs in with the password and gets a new session", async (t) => {
  const { request, createEvent } = await startApp(t);
  const { code, host, password } = await createEvent();
  const answer = await login(request, code, "host", { password });
  assert.equal(answer.status, 200);
  assert.equal(answer.data.ok, true);
  assert.notEqual(answer.data.session_id, host);
  assert.equal((await request("PATCH", `/api/events/${code}`, { shots_count: 7 }, answer.data.session_id)).status, 200);
});

test("a wrong host password is rejected, and the password has no spaces cut", async (t) => {
  const { request, createEvent } = await startApp(t);
  const { code, password } = await createEvent();
  const wrong = await login(request, code, "host", { password: "wrong" });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.data.detail, "Invalid admin password");
  assert.equal((await login(request, code, "host", {})).status, 401);
  assert.equal((await login(request, code, "host", { password: "x".repeat(65) })).status, 422);
  assert.equal((await login(request, code, "host", { password: 12 })).status, 422);
  assert.equal((await login(request, code, "host", { password: password.toLowerCase() })).status, 401);
});

test("a saved host session logs in again without the password and stays valid", async (t) => {
  const { request, createEvent } = await startApp(t);
  const { code, host } = await createEvent();
  const answer = await login(request, code, "host", { session_id: host });
  assert.deepEqual(answer.data, { ok: true, session_id: host });
  assert.equal((await login(request, code, "host", { session_id: "unknown-session-value-1" })).status, 401);
});

test("a second host login does not end the first session", async (t) => {
  const { request, createEvent } = await startApp(t);
  const { code, host, password } = await createEvent();
  const second = (await login(request, code, "host", { password })).data.session_id;
  assert.equal((await request("GET", `/api/properties/${code}`, undefined, host)).status, 200);
  assert.equal((await request("GET", `/api/properties/${code}`, undefined, second)).status, 200);
});

test("a session of another role is not a host session", async (t) => {
  const { request, createEvent } = await startApp(t);
  const { code } = await createEvent();
  const viewer = (await login(request, code, "viewer")).data.session_id;
  const lane = (await login(request, code, "lane/1")).data.session_id;
  for (const session of [viewer, lane]) {
    assert.equal((await request("GET", `/api/properties/${code}`, undefined, session)).status, 401);
    assert.equal((await login(request, code, "host", { session_id: session })).status, 401);
  }
});

test("a viewer needs no password until the host sets one", async (t) => {
  const { request, createEvent } = await startApp(t);
  const { code, host } = await createEvent();
  const open = await login(request, code, "viewer");
  assert.deepEqual([open.status, open.data.ok, open.data.has_password], [200, true, false]);
  await request("PATCH", `/api/properties/${code}`, { viewer_password: "viewer-password-1" }, host);
  const closed = await login(request, code, "viewer", { password: "wrong" });
  assert.deepEqual([closed.status, closed.data.detail], [401, "Invalid viewer password"]);
  assert.equal((await login(request, code, "viewer")).status, 401);
  const good = await login(request, code, "viewer", { password: "viewer-password-1" });
  assert.deepEqual([good.status, good.data.has_password], [200, true]);
  assert.deepEqual((await login(request, code, "viewer", { session_id: good.data.session_id })).data.session_id, good.data.session_id);
  await request("PATCH", `/api/properties/${code}`, { viewer_password: "" }, host);
  assert.equal((await login(request, code, "viewer")).data.has_password, false);
});

test("a new lane gets a password of six characters and the user sees it one time", async (t) => {
  const { request, createEvent } = await startApp(t);
  const { code } = await createEvent();
  const created = await login(request, code, "lane/3");
  assert.equal(created.data.status, "created");
  assert.equal(created.data.lane_number, 3);
  assert.match(created.data.password, /^[A-Z0-9]{6}$/);
  const again = await login(request, code, "lane/3");
  assert.deepEqual(again.data, { status: "password_required", lane_number: 3 });
});

test("a lane logs in with the password in any case, and with a saved session", async (t) => {
  const { request, createEvent } = await startApp(t);
  const { code } = await createEvent();
  const created = (await login(request, code, "lane/3")).data;
  const other = await login(request, code, "lane/3", { password: created.password.toLowerCase() });
  assert.equal(other.data.status, "ok");
  assert.notEqual(other.data.session_id, created.session_id);
  const saved = await login(request, code, "lane/3", { session_id: created.session_id });
  assert.deepEqual(saved.data, { status: "ok", session_id: created.session_id, lane_number: 3 });
  const wrong = await login(request, code, "lane/3", { password: "ZZZZZZ" });
  assert.deepEqual([wrong.status, wrong.data.detail], [401, "Invalid lane password"]);
  assert.equal((await login(request, code, "lane/3", { session_id: "unknown-session-value-1" })).data.status, "password_required");
});

test("both lane sessions work after a second login", async (t) => {
  const { request, createEvent } = await startApp(t);
  const { code, host } = await createEvent();
  await request("POST", `/api/participants/${code}`, { name: "A", lane_number: 3, shift: "A" }, host);
  const first = (await login(request, code, "lane/3")).data;
  const second = (await login(request, code, "lane/3", { password: first.password })).data;
  for (const session of [first.session_id, second.session_id])
    assert.equal((await request("POST", `/api/participants/${code}`, { name: "B", lane_number: 3, shift: "B" }, session)).status, 200);
});

test("a lane session works only for its own lane", async (t) => {
  const { request, createEvent } = await startApp(t);
  const { code } = await createEvent();
  const lane3 = (await login(request, code, "lane/3")).data;
  assert.equal((await login(request, code, "lane/4", { session_id: lane3.session_id })).data.status, "created");
});

for (const lane of ["0", "1000", "abc", "-1", "1.5"]) {
  test(`lane ${lane} is not a lane`, async (t) => {
    const { request, createEvent } = await startApp(t);
    const { code, host } = await createEvent();
    assert.equal((await login(request, code, `lane/${lane}`)).status, 422);
    assert.equal((await request("DELETE", `/api/sessions/${code}/lane/${lane}`, undefined, host)).status, 422);
  });
}

test("the host lists lanes and resets a lane", async (t) => {
  const { request, createEvent } = await startApp(t);
  const { code, host } = await createEvent();
  await login(request, code, "lane/5");
  await login(request, code, "lane/2");
  assert.deepEqual((await request("GET", `/api/sessions/${code}/lanes`, undefined, host)).data.lanes, [2, 5]);
  assert.equal((await request("GET", `/api/sessions/${code}/lanes`)).status, 401);
  const old = (await login(request, code, "lane/2", { password: "x" })).status;
  assert.equal(old, 401);
  const reset = await request("DELETE", `/api/sessions/${code}/lane/2`, undefined, host);
  assert.deepEqual(reset.data, { message: "Session for lane 2 reset" });
  assert.deepEqual((await request("GET", `/api/sessions/${code}/lanes`, undefined, host)).data.lanes, [5]);
  assert.equal((await login(request, code, "lane/2")).data.status, "created");
  assert.equal((await request("DELETE", `/api/sessions/${code}/lane/2`)).status, 401);
});

test("a reset ends the sessions of the lane and no other session", async (t) => {
  const { request, createEvent } = await startApp(t);
  const { code, host } = await createEvent();
  await request("POST", `/api/participants/${code}`, { name: "A", lane_number: 2, shift: "A" }, host);
  const one = (await login(request, code, "lane/1")).data;
  const two = (await login(request, code, "lane/2")).data;
  await request("DELETE", `/api/sessions/${code}/lane/2`, undefined, host);
  const add = (session, lane) => request("POST", `/api/participants/${code}`, { name: "N", lane_number: lane, shift: "B" }, session);
  assert.equal((await add(two.session_id, 2)).status, 401);
  assert.equal((await add(one.session_id, 1)).status, 200);
  assert.equal((await request("GET", `/api/properties/${code}`, undefined, host)).status, 200);
});

test("a changed host password ends the other host sessions and keeps the current one", async (t) => {
  const { request, createEvent } = await startApp(t);
  const { code, host, password } = await createEvent();
  const other = (await login(request, code, "host", { password })).data.session_id;
  const changed = await request("PATCH", `/api/properties/${code}`, { host_password: "new-host-password-1" }, host);
  assert.equal(changed.status, 200);
  assert.equal((await request("GET", `/api/properties/${code}`, undefined, host)).status, 200);
  assert.equal((await request("GET", `/api/properties/${code}`, undefined, other)).status, 401);
  assert.equal((await login(request, code, "host", { password })).status, 401);
  assert.equal((await login(request, code, "host", { password: "new-host-password-1" })).status, 200);
});

test("a changed viewer password ends the viewer sessions", async (t) => {
  const { request, createEvent } = await startApp(t);
  const { code, host } = await createEvent();
  const viewer = (await login(request, code, "viewer")).data.session_id;
  await request("PATCH", `/api/properties/${code}`, { viewer_password: "viewer-password-1" }, host);
  assert.equal((await login(request, code, "viewer", { session_id: viewer })).status, 401);
});

test("a session ends after its lifetime", async (t) => {
  const ctx = await startApp(t);
  const { request, createEvent, app } = ctx;
  const { code, host } = await createEvent();
  assert.equal((await request("GET", `/api/properties/${code}`, undefined, host)).status, 200);
  app.pool.get(code).run("UPDATE sessions SET expires_at = ?", Date.now() - 1000);
  const expired = await request("GET", `/api/properties/${code}`, undefined, host);
  assert.deepEqual([expired.status, expired.data.detail], [401, "Invalid or expired session"]);
  assert.equal((await login(request, code, "host", { session_id: host })).status, 401);
});

test("a login renews the lifetime of a saved session", async (t) => {
  const { request, createEvent, app } = await startApp(t, { sessionDays: 2 });
  const { code, host } = await createEvent();
  const db = app.pool.get(code);
  db.run("UPDATE sessions SET expires_at = ?", Date.now() + 1000);
  await login(request, code, "host", { session_id: host });
  assert.ok(db.get("SELECT expires_at FROM sessions").expires_at > Date.now() + 86_400_000);
});

test("a role keeps at most twenty sessions, the newest ones", async (t) => {
  const { request, createEvent, app } = await startApp(t);
  const { code, password } = await createEvent();
  const tokens = [];
  for (let i = 0; i < 22; i++) tokens.push((await login(request, code, "host", { password })).data.session_id);
  const db = app.pool.get(code);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM sessions WHERE role = 'host'").n, 20);
  assert.equal((await request("GET", `/api/properties/${code}`, undefined, tokens.at(-1))).status, 200);
});

test("many viewers can be logged in at the same time, none of them loses the session", async (t) => {
  const { request, createEvent, app, base } = await startApp(t);
  const { code } = await createEvent();
  const tokens = [];
  for (let i = 0; i < 300; i++) tokens.push((await login(request, code, "viewer")).data.session_id);
  assert.equal(app.pool.get(code).get("SELECT COUNT(*) AS n FROM sessions WHERE role = 'viewer'").n, 300);
  const first = await connectSocket(base, code, tokens[0]);
  t.after(() => first.terminate());
  assert.equal(first.messages[0]?.type, "authenticated");
});

test("the server stores hashes of passwords and sessions, and only the lane password in the clear", async (t) => {
  const { request, createEvent, dataDir } = await startApp(t);
  const { code, host, password } = await createEvent();
  const lane = (await login(request, code, "lane/1")).data;
  const raw = new DatabaseSync(path.join(dataDir, `${code}.db`), { readOnly: true });
  const dump = (sql) => JSON.stringify(raw.prepare(sql).all());
  const secured = dump("SELECT * FROM credentials") + dump("SELECT * FROM sessions") + dump("SELECT lane, password_hash, created_at FROM lanes");
  const lanes = dump("SELECT * FROM lanes");
  raw.close();
  for (const secret of [host, password, lane.password, lane.session_id]) assert.equal(secured.includes(secret), false);
  assert.match(secured, /scrypt\$/);
  assert.equal(lanes.includes(lane.password), true, "The host can read the lane password");
  const properties = JSON.stringify((await request("GET", `/api/properties/${code}`, undefined, host)).data);
  assert.equal(properties.includes(password), false);
});

test("the host sees the password of each lane in the list of lanes", async (t) => {
  const { request, createEvent } = await startApp(t);
  const { code, host } = await createEvent();
  const one = (await login(request, code, "lane/1")).data;
  const five = (await login(request, code, "lane/5")).data;
  const list = (await request("GET", `/api/sessions/${code}/lanes`, undefined, host)).data;
  assert.deepEqual(list, { lanes: [1, 5], passwords: { 1: one.password, 5: five.password }, requests: {} });
  assert.equal((await login(request, code, "lane/1", { password: list.passwords[1] })).data.status, "ok");
  assert.equal((await request("GET", `/api/sessions/${code}/lanes`, undefined, one.session_id)).status, 401);
  assert.equal((await request("GET", `/api/sessions/${code}/lanes`)).status, 401);
  await request("DELETE", `/api/sessions/${code}/lane/1`, undefined, host);
  const after = (await request("GET", `/api/sessions/${code}/lanes`, undefined, host)).data;
  assert.deepEqual(after, { lanes: [5], passwords: { 5: five.password }, requests: {} });
  const again = (await login(request, code, "lane/1")).data;
  assert.notEqual(again.password, one.password);
  assert.equal((await request("GET", `/api/sessions/${code}/lanes`, undefined, host)).data.passwords[1], again.password);
});

test("no public answer shows a lane password", async (t) => {
  const { request, createEvent } = await startApp(t);
  const { code } = await createEvent();
  const lane = (await login(request, code, "lane/2")).data;
  for (const url of [`/api/events/${code}`, `/api/distances/${code}`, `/api/participants/${code}`, `/api/properties/${code}/public`, `/api/results/${code}/leaderboard`])
    assert.equal(JSON.stringify((await request("GET", url)).data).includes(lane.password), false, url);
  assert.equal(JSON.stringify((await login(request, code, "lane/2")).data).includes(lane.password), false);
});


test("failed logins are limited for each account and the lock lasts", async (t) => {
  const { request, createEvent } = await startApp(t);
  const { code, password } = await createEvent();
  const wrong = () => login(request, code, "host", { password: "wrong-password" });
  for (let i = 0; i < 10; i++) assert.equal((await wrong()).status, 401, `attempt ${i + 1}`);
  const locked = await wrong();
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get("retry-after")) > 800);
  assert.equal((await login(request, code, "host", { password })).status, 429);
  assert.equal((await login(request, code, "viewer")).status, 200);
});

test("a saved valid session logs in while the account is locked", async (t) => {
  const { request, createEvent } = await startApp(t);
  const { code, host } = await createEvent();
  for (let i = 0; i < 11; i++) await login(request, code, "host", { password: "wrong-password" });
  assert.equal((await login(request, code, "host", { session_id: host })).status, 200);
});

test("parallel failed logins cannot pass the limit", async (t) => {
  const { request, createEvent } = await startApp(t);
  const { code } = await createEvent();
  const statuses = (await Promise.all(Array.from({ length: 25 }, () => login(request, code, "host", { password: "wrong-password" })))).map((a) => a.status);
  assert.equal(statuses.filter((s) => s === 401).length, 10);
  assert.equal(statuses.filter((s) => s === 429).length, 15);
});

test("a correct login removes the failure count", async (t) => {
  const { request, createEvent } = await startApp(t);
  const { code, password } = await createEvent();
  const wrong = () => login(request, code, "host", { password: "wrong-password" });
  for (let i = 0; i < 9; i++) assert.equal((await wrong()).status, 401);
  assert.equal((await login(request, code, "host", { password })).status, 200);
  for (let i = 0; i < 9; i++) assert.equal((await wrong()).status, 401);
});

test("failed logins from one address are limited across all lanes and roles", async (t) => {
  const { request, createEvent } = await startApp(t, { loginFailureLimit: 3 });
  const { code } = await createEvent();
  const lanes = [];
  for (const lane of [1, 2, 3]) lanes.push((await login(request, code, `lane/${lane}`)).data);
  for (const lane of [1, 2, 3]) assert.equal((await login(request, code, `lane/${lane}`, { password: "WRONGPASSWORD" })).status, 401);
  const locked = await login(request, code, "lane/1", { password: "WRONGPASSWORD" });
  assert.equal(locked.status, 429);
  assert.equal((await login(request, code, "host", { password: "wrong-password" })).status, 429);
  const saved = await login(request, code, "lane/1", { session_id: lanes[0].session_id });
  assert.equal(saved.data.status, "ok");
});

test("two devices that open a new lane at once get one password", async (t) => {
  const { request, createEvent } = await startApp(t);
  const { code } = await createEvent();
  const answers = await Promise.all(Array.from({ length: 5 }, () => login(request, code, "lane/5")));
  assert.deepEqual(answers.map((a) => a.status), [200, 200, 200, 200, 200]);
  assert.equal(answers.filter((a) => a.data.status === "created").length, 1);
  assert.equal(answers.filter((a) => a.data.status === "password_required").length, 4);
});

test("the login limit uses the forwarded address only for a trusted proxy", async (t) => {
  const post = (base, code, forwarded) =>
    fetch(`${base}/api/sessions/${code}/host`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(forwarded ? { "X-Forwarded-For": forwarded } : {}) },
      body: JSON.stringify({ password: "wrong-password" }),
    }).then((r) => r.status);
  const direct = await startApp(t);
  const one = await direct.createEvent("DIR001");
  for (let i = 0; i < 10; i++) assert.equal(await post(direct.base, one.code, `203.0.113.${i}`), 401);
  assert.equal(await post(direct.base, one.code, "203.0.113.200"), 429);

  const proxied = await startApp(t, { trustedProxies: ["127.0.0.1"] });
  const two = await proxied.createEvent("PRX001");
  for (let i = 0; i < 10; i++) assert.equal(await post(proxied.base, two.code, `10.0.0.${i}, 198.51.100.7`), 401);
  assert.equal(await post(proxied.base, two.code, "10.9.9.9, 198.51.100.7"), 429);
  assert.equal(await post(proxied.base, two.code, "198.51.100.8"), 401);
});

test("sessions and data stay after a restart", async (t) => {
  const first = await startApp(t, { dataDir: undefined });
  const { code, host } = await first.createEvent();
  await first.request("POST", `/api/participants/${code}`, { name: "Kept", lane_number: 1, shift: "A" }, host);
  const lane = (await login(first.request, code, "lane/1")).data;
  await first.app.close();
  const second = await startApp(t, { dataDir: first.dataDir });
  assert.equal((await second.request("GET", `/api/participants/${code}`)).data[0].name, "Kept");
  assert.equal((await login(second.request, code, "host", { session_id: host })).status, 200);
  assert.equal((await login(second.request, code, "lane/1", { session_id: lane.session_id })).data.status, "ok");
});
