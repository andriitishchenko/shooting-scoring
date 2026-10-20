import { test } from "node:test";
import assert from "node:assert/strict";
import { startApp } from "./helpers.js";

test("the host reads the settings and never a password", async (t) => {
  const { request, createEvent } = await startApp(t);
  const { code, host, password } = await createEvent();
  const answer = await request("GET", `/api/properties/${code}`, undefined, host);
  assert.deepEqual(answer.data, {
    host_password_configured: true,
    viewer_password_configured: false,
    client_allow_add_participant: true,
    lane_count: 28,
  });
  assert.equal(JSON.stringify(answer.data).includes(password), false);
  assert.equal((await request("GET", `/api/properties/${code}`)).status, 401);
});

test("the public settings need no session and show only the allow flag", async (t) => {
  const { request, createEvent } = await startApp(t);
  const { code } = await createEvent();
  assert.deepEqual((await request("GET", `/api/properties/${code}/public`)).data, { client_allow_add_participant: true, lane_count: 28 });
});

test("the host sets and removes the viewer password", async (t) => {
  const { request, createEvent } = await startApp(t);
  const { code, host } = await createEvent();
  await request("PATCH", `/api/properties/${code}`, { viewer_password: "  viewer-password-1  " }, host);
  assert.equal((await request("GET", `/api/properties/${code}`, undefined, host)).data.viewer_password_configured, true);
  const login = await request("POST", `/api/sessions/${code}/viewer`, { password: "viewer-password-1" });
  assert.equal(login.status, 200);
  await request("PATCH", `/api/properties/${code}`, { viewer_password: "" }, host);
  assert.equal((await request("GET", `/api/properties/${code}`, undefined, host)).data.viewer_password_configured, false);
});

for (const [name, body] of [
  ["a short host password", { host_password: "short" }],
  ["an empty host password", { host_password: "" }],
  ["a host password of spaces", { host_password: "              " }],
  ["a long host password", { host_password: "x".repeat(65) }],
  ["a short viewer password", { viewer_password: "short" }],
  ["a long viewer password", { viewer_password: "x".repeat(65) }],
  ["a text allow flag", { client_allow_add_participant: "false" }],
  ["a number allow flag", { client_allow_add_participant: 0 }],
]) {
  test(`the settings are rejected for ${name}`, async (t) => {
    const { request, createEvent } = await startApp(t);
    const { code, host } = await createEvent();
    assert.equal((await request("PATCH", `/api/properties/${code}`, body, host)).status, 422);
  });
}

test("a change without fields changes nothing and an empty body is rejected", async (t) => {
  const { request, createEvent } = await startApp(t);
  const { code, host, password } = await createEvent();
  assert.equal((await request("PATCH", `/api/properties/${code}`, {}, host)).status, 200);
  assert.equal((await request("POST", `/api/sessions/${code}/host`, { password })).status, 200);
  assert.equal((await request("PATCH", `/api/properties/${code}`, undefined, host)).status, 422);
});

test("changing settings needs the host", async (t) => {
  const { request, createEvent } = await startApp(t);
  const { code } = await createEvent();
  const lane = (await request("POST", `/api/sessions/${code}/lane/1`, {})).data;
  assert.equal((await request("PATCH", `/api/properties/${code}`, { client_allow_add_participant: false })).status, 401);
  assert.equal((await request("PATCH", `/api/properties/${code}`, { client_allow_add_participant: false }, lane.session_id)).status, 401);
});

test("the host sets the number of lanes", async (t) => {
  const { request, createEvent } = await startApp(t);
  const { code, host } = await createEvent();
  assert.equal((await request("PATCH", `/api/properties/${code}`, { lane_count: 12 }, host)).status, 200);
  assert.equal((await request("GET", `/api/properties/${code}/public`)).data.lane_count, 12);
  for (const value of [0, 1000, 1.5, "5"])
    assert.equal((await request("PATCH", `/api/properties/${code}`, { lane_count: value }, host)).status, 422);
});
