import { test } from "node:test";
import assert from "node:assert/strict";
import { startApp } from "./helpers.js";

async function setup(t) {
  const ctx = await startApp(t);
  const event = await ctx.createEvent("PART01", 6);
  const url = (suffix = "") => `/api/participants/${event.code}${suffix}`;
  return { ...ctx, event, host: event.host, url };
}
const person = (extra = {}) => ({ name: "Anna", lane_number: 1, shift: "a", ...extra });

test("the host adds a participant and the data is cleaned", async (t) => {
  const { request, url, host } = await setup(t);
  const added = await request(
    "POST",
    url(),
    person({ name: "  Anna Archer ", gender: " female ", personal_number: "  42 ", group_type: "   ", shooting_type: "recurve" }),
    host,
  );
  assert.deepEqual(added.data, { id: 1, message: "Participant added" });
  const [stored] = (await request("GET", url())).data;
  assert.deepEqual(stored, {
    id: 1, name: "Anna Archer", lane_number: 1, shift: "A", gender: "female", age_category: null,
    shooting_type: "recurve", group_type: null, personal_number: "42",
  });
});

test("long optional text is cut and not rejected", async (t) => {
  const { request, url, host } = await setup(t);
  await request("POST", url(), person({ gender: "g".repeat(80), personal_number: "9".repeat(50) }), host);
  const [stored] = (await request("GET", url())).data;
  assert.equal(stored.gender.length, 60);
  assert.equal(stored.personal_number.length, 32);
});

for (const [name, body] of [
  ["no name", { lane_number: 1, shift: "A" }],
  ["a blank name", person({ name: "   " })],
  ["a long name", person({ name: "N".repeat(121) })],
  ["a long emoji name", person({ name: "😀".repeat(121) })],
  ["lane 0", person({ lane_number: 0 })],
  ["lane 1000", person({ lane_number: 1000 })],
  ["a text lane", person({ lane_number: "1" })],
  ["a fraction lane", person({ lane_number: 1.5 })],
  ["a boolean lane", person({ lane_number: true })],
  ["no shift", { name: "A", lane_number: 1 }],
  ["a blank shift", person({ shift: "  " })],
  ["a long shift", person({ shift: "abcde" })],
  ["a number gender", person({ gender: 12 })],
  ["an object gender", person({ gender: {} })],
]) {
  test(`adding a participant is rejected for ${name}`, async (t) => {
    const { request, url, host } = await setup(t);
    assert.equal((await request("POST", url(), body, host)).status, 422);
  });
}

test("an emoji name of the largest size is accepted", async (t) => {
  const { request, url, host } = await setup(t);
  assert.equal((await request("POST", url(), person({ name: "😀".repeat(120) }), host)).status, 200);
});

test("participants are listed by lane and shift, and a lane filter works", async (t) => {
  const { request, url, host } = await setup(t);
  for (const [lane, shift, name] of [[2, "A", "c"], [1, "B", "b"], [1, "A", "a"]])
    await request("POST", url(), { name, lane_number: lane, shift }, host);
  assert.deepEqual((await request("GET", url())).data.map((p) => p.name), ["a", "b", "c"]);
  assert.deepEqual((await request("GET", url("?lane_number=1"))).data.map((p) => p.name), ["a", "b"]);
  assert.deepEqual((await request("GET", url("?lane_number=7"))).data, []);
  assert.deepEqual((await request("GET", url("?lane_number=2&lane_number=1"))).data.map((p) => p.name), ["a", "b"]);
  for (const bad of ["abc", "0", "1000", "-1", "1.5", ""]) assert.equal((await request("GET", url(`?lane_number=${bad}`))).status, 422, bad);
});

test("a lane adds participants to its own lane only", async (t) => {
  const { request, url, event } = await setup(t);
  const lane = (await request("POST", `/api/sessions/${event.code}/lane/3`, {})).data;
  assert.equal((await request("POST", url(), person({ lane_number: 3 }), lane.session_id)).status, 200);
  const other = await request("POST", url(), person({ lane_number: 4 }), lane.session_id);
  assert.equal(other.status, 401);
  assert.equal(other.data.detail, "Valid session required to add participant");
  assert.equal((await request("POST", url(), person())).data.detail, "Session required");
  assert.equal((await request("POST", url(), person(), "wrong-token-value-123")).status, 401);
});

test("the host can turn off self-registration for lanes", async (t) => {
  const { request, url, host, event } = await setup(t);
  const lane = (await request("POST", `/api/sessions/${event.code}/lane/3`, {})).data;
  assert.equal((await request("GET", `/api/properties/${event.code}/public`)).data.client_allow_add_participant, true);
  await request("PATCH", `/api/properties/${event.code}`, { client_allow_add_participant: false }, host);
  assert.equal((await request("GET", `/api/properties/${event.code}/public`)).data.client_allow_add_participant, false);
  const denied = await request("POST", url(), person({ lane_number: 3 }), lane.session_id);
  assert.equal(denied.status, 403);
  assert.equal(denied.data.detail, "Self-registration is disabled by the host");
  assert.equal((await request("POST", url(), person({ lane_number: 3 }), host)).status, 200);
});

test("the host edits and removes participants only before the start", async (t) => {
  const { request, url, host, event } = await setup(t);
  await request("POST", url(), person(), host);
  const changed = await request("PUT", url("/1"), person({ name: "Anna B", lane_number: 2, shift: "b" }), host);
  assert.deepEqual(changed.data, { message: "Participant updated", id: 1 });
  assert.deepEqual((await request("GET", url())).data[0].lane_number, 2);
  assert.equal((await request("PUT", url("/9"), person(), host)).data.detail, "Participant not found");
  assert.equal((await request("DELETE", url("/9"), undefined, host)).status, 404);
  assert.equal((await request("PUT", url("/1"), person())).status, 401);
  assert.equal((await request("DELETE", url("/1"))).status, 401);
  await request("POST", url(), person({ name: "Second" }), host);
  assert.equal((await request("DELETE", url("/2"), undefined, host)).data.message, "Participant deleted");
  await request("PATCH", `/api/events/${event.code}`, { status: "started" }, host);
  assert.equal((await request("PUT", url("/1"), person(), host)).data.detail, "Participants can only be edited before the event starts");
  assert.equal((await request("DELETE", url("/1"), undefined, host)).data.detail, "Participants can only be deleted before the event starts");
  assert.equal((await request("POST", url(), person(), host)).data.detail, "Participants can only be added before the event starts");
});

test("deleting a participant needs a valid id", async (t) => {
  const { request, url, host } = await setup(t);
  assert.equal((await request("DELETE", url("/abc"), undefined, host)).status, 422);
  assert.equal((await request("DELETE", url("/0"), undefined, host)).status, 422);
});

const csv = (text) => ({ csv_content: text });

test("the host imports participants from CSV", async (t) => {
  const { request, url, host } = await setup(t);
  const text = 'name,lane,shift,group,personal_number,gender\n"Smith, Anna",1,a,Juniors,7,female\n"Quote ""Q""",2,B\nPlain,3,c,,,\n';
  const result = await request("POST", url("/import"), csv(text), host);
  assert.deepEqual(result.data, { added: 3, failed: 0, errors: [] });
  const people = (await request("GET", url())).data;
  assert.deepEqual(people.map((p) => p.name), ["Smith, Anna", 'Quote "Q"', "Plain"]);
  assert.equal(people[0].group_type, "Juniors");
  assert.equal(people[0].personal_number, "7");
  assert.equal(people[0].shift, "A");
});

test("a CSV import reports the rows with errors and adds the other rows", async (t) => {
  const { request, url, host } = await setup(t);
  const text = "name,lane,shift\nOK,1,A\n,2,B\nBad lane,0,A\nWord lane,x,A\nNo shift,4,\n" + `${"N".repeat(121)},5,A\nLast,6,F\n`;
  const result = (await request("POST", url("/import"), csv(text), host)).data;
  assert.equal(result.added, 2);
  assert.equal(result.failed, 5);
  assert.deepEqual(result.errors.map((e) => e.split(":")[0]), ["Row 3", "Row 4", "Row 5", "Row 6", "Row 7"]);
  assert.match(result.errors[0], /name is required/);
  assert.match(result.errors[1], /lane must be from 1 to 999/);
});

test("a CSV import checks the header, the size, and the status", async (t) => {
  const { request, url, host, event } = await setup(t);
  assert.equal((await request("POST", url("/import"), csv("name,shift\nA,A\n"), host)).status, 400);
  assert.equal((await request("POST", url("/import"), csv("\n\n"), host)).status, 400);
  assert.equal((await request("POST", url("/import"), csv("name,lane,shift\n" + "A,1,A\n".repeat(501)), host)).data.detail, "Too many rows (max 500)");
  assert.equal((await request("POST", url("/import"), csv(""), host)).status, 422);
  assert.equal((await request("POST", url("/import"), { csv_content: "x".repeat(500_001) }, host)).status, 422);
  assert.equal((await request("POST", url("/import"), csv("name,lane,shift\nA,1,A\n"))).status, 401);
  await request("PATCH", `/api/events/${event.code}`, { status: "started" }, host);
  assert.equal((await request("POST", url("/import"), csv("name,lane,shift\nA,1,A\n"), host)).status, 403);
});

test("the largest CSV import fits in the body limit", async (t) => {
  const { request, url, host } = await setup(t);
  const text = "name,lane,shift\n" + "A,1,A\n".repeat(83_330);
  assert.ok(text.length <= 500_000);
  assert.equal((await request("POST", url("/import"), csv(text), host)).data.detail, "Too many rows (max 500)");
});

test("a CSV line break works with Windows line ends and empty lines", async (t) => {
  const { request, url, host } = await setup(t);
  const result = await request("POST", url("/import"), csv("name,lane,shift\r\nAnna,1,A\r\n\r\nBoris,2,B\r\n"), host);
  assert.equal(result.data.added, 2);
});
