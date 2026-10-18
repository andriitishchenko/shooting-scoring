import { test } from "node:test";
import assert from "node:assert/strict";
import { startApp } from "./helpers.js";

async function setup(t) {
  const ctx = await startApp(t);
  const event = await ctx.createEvent("DIST01", 9);
  const url = (suffix = "") => `/api/distances/${event.code}${suffix}`;
  return { ...ctx, event, url, host: event.host };
}

test("the host adds, renames, and deletes a pending distance", async (t) => {
  const { request, url, host } = await setup(t);
  const added = await request("POST", url(), { title: "  Second  ", shots_count: 12 }, host);
  assert.equal(added.status, 200);
  assert.deepEqual(added.data, { id: 2, title: "Second", shots_count: 12, sort_order: 1, status: "pending" });
  const renamed = await request("PATCH", url("/2"), { title: "Final", shots_count: 18 }, host);
  assert.equal(renamed.data.title, "Final");
  assert.equal(renamed.data.shots_count, 18);
  assert.equal((await request("DELETE", url("/2"), undefined, host)).data.message, "Distance deleted");
  assert.equal((await request("GET", url())).data.length, 1);
});

test("a new distance gets the next sort order and the default shot count", async (t) => {
  const { request, url, host } = await setup(t);
  await request("POST", url(), { title: "B" }, host);
  await request("POST", url(), { title: "C" }, host);
  const list = (await request("GET", url())).data;
  assert.deepEqual(list.map((d) => [d.sort_order, d.shots_count]), [[0, 9], [1, 30], [2, 30]]);
});

for (const [name, body] of [
  ["no title", { shots_count: 6 }],
  ["a blank title", { title: "   " }],
  ["a long title", { title: "x".repeat(61) }],
  ["a number title", { title: 12 }],
  ["zero shots", { title: "A", shots_count: 0 }],
  ["too many shots", { title: "A", shots_count: 301 }],
  ["text shots", { title: "A", shots_count: "5" }],
]) {
  test(`adding a distance is rejected for ${name}`, async (t) => {
    const { request, url, host } = await setup(t);
    assert.equal((await request("POST", url(), body, host)).status, 422);
  });
}

test("changing distances needs the host", async (t) => {
  const { request, url } = await setup(t);
  assert.equal((await request("POST", url(), { title: "A" })).status, 401);
  assert.equal((await request("PATCH", url("/1"), { title: "A" }, "wrong-token-value-123")).status, 401);
  assert.equal((await request("DELETE", url("/1"))).status, 401);
});

test("a distance has the right errors for a missing id", async (t) => {
  const { request, url, host } = await setup(t);
  assert.equal((await request("PATCH", url("/99"), { title: "A" }, host)).data.detail, "Distance not found");
  assert.equal((await request("DELETE", url("/99"), undefined, host)).status, 404);
  assert.equal((await request("PATCH", url("/abc"), { title: "A" }, host)).status, 422);
  assert.equal((await request("PATCH", url("/0"), { title: "A" }, host)).status, 422);
});

test("a distance can start only after the event starts, and only one is active", async (t) => {
  const { request, url, host, event } = await setup(t);
  await request("POST", url(), { title: "B" }, host);
  assert.equal((await request("PATCH", url("/1"), { status: "active" }, host)).data.detail, "Start the event first");
  await request("PATCH", `/api/events/${event.code}`, { status: "started" }, host);
  assert.equal((await request("PATCH", url("/1"), { status: "active" }, host)).data.status, "active");
  assert.equal((await request("PATCH", url("/2"), { status: "active" }, host)).data.status, "active");
  const list = (await request("GET", url())).data;
  assert.deepEqual(list.map((d) => d.status), ["finished", "active"]);
});

test("a distance state cannot go back", async (t) => {
  const { request, url, host, event } = await setup(t);
  await request("PATCH", `/api/events/${event.code}`, { status: "started" }, host);
  assert.equal((await request("PATCH", url("/1"), { status: "finished" }, host)).data.detail, "Only active distance can be finished");
  await request("PATCH", url("/1"), { status: "active" }, host);
  assert.equal((await request("PATCH", url("/1"), { status: "pending" }, host)).data.detail, "Started distances cannot return to pending");
  assert.equal((await request("PATCH", url("/1"), { status: "finished" }, host)).data.status, "finished");
  assert.equal((await request("PATCH", url("/1"), { status: "active" }, host)).data.detail, "Finished distance cannot be reactivated");
  assert.equal((await request("PATCH", url("/1"), { status: "finished" }, host)).status, 200);
});

test("only a pending distance can be edited or deleted", async (t) => {
  const { request, url, host, event } = await setup(t);
  await request("POST", url(), { title: "B" }, host);
  await request("PATCH", `/api/events/${event.code}`, { status: "started" }, host);
  await request("PATCH", url("/1"), { status: "active" }, host);
  assert.equal((await request("PATCH", url("/1"), { title: "New" }, host)).data.detail, "Can only edit title of pending distances");
  assert.equal((await request("PATCH", url("/1"), { shots_count: 3 }, host)).data.detail, "Can only edit shots of pending distances");
  assert.equal((await request("DELETE", url("/1"), undefined, host)).data.detail, "Cannot delete active or finished distance");
  assert.equal((await request("PATCH", url("/2"), { title: "Edited" }, host)).status, 200);
});

test("the last distance cannot be deleted", async (t) => {
  const { request, url, host } = await setup(t);
  assert.equal((await request("DELETE", url("/1"), undefined, host)).data.detail, "Cannot delete the last distance");
});

test("a rejected compound change rolls back all changes", async (t) => {
  const { request, url, host, event } = await setup(t);
  await request("POST", url(), { title: "B" }, host);
  await request("PATCH", `/api/events/${event.code}`, { status: "started" }, host);
  await request("PATCH", url("/1"), { status: "active" }, host);
  const rejected = await request("PATCH", url("/2"), { status: "active", title: "Changed" }, host);
  assert.equal(rejected.status, 403);
  const list = (await request("GET", url())).data;
  assert.deepEqual(list.map((d) => [d.title, d.status]), [["Distance 1", "active"], ["B", "pending"]]);
});

test("a finished event allows no change of distances", async (t) => {
  const { request, url, host, event } = await setup(t);
  await request("POST", url(), { title: "B" }, host);
  await request("PATCH", `/api/events/${event.code}`, { status: "started" }, host);
  await request("PATCH", `/api/events/${event.code}`, { status: "finished" }, host);
  assert.equal((await request("POST", url(), { title: "C" }, host)).data.detail, "Event is finished");
  assert.equal((await request("PATCH", url("/2"), { title: "C" }, host)).status, 403);
  assert.equal((await request("DELETE", url("/2"), undefined, host)).status, 403);
});

test("a distance with scores cannot be deleted", async (t) => {
  const { request, url, host, event } = await setup(t);
  await request("POST", `/api/participants/${event.code}`, { name: "A", lane_number: 1, shift: "A" }, host);
  await request("PATCH", `/api/events/${event.code}`, { status: "started" }, host);
  await request("PATCH", url("/1"), { status: "active" }, host);
  await request("PUT", `/api/results/${event.code}/participant/1/distance/1`, { shots: [{ shot_number: 1, score: 5 }] }, host);
  assert.equal((await request("DELETE", url("/1"), undefined, host)).status, 403);
  assert.equal((await request("GET", `/api/results/${event.code}/state/1`)).data.distances[0].total_score, 5);
});
