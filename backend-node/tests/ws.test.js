import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";
import { runningEvent, startApp, connectSocket, waitFor, wait } from "./helpers.js";

const messagesOf = (socket) => socket.messages.filter((m) => m.type !== "authenticated");

test("a socket authenticates with a session and gets its role", async (t) => {
  const { base, event, lane } = await runningEvent(t);
  const host = await connectSocket(base, event.code, event.host);
  const laneSocket = await connectSocket(base, event.code, lane.session_id);
  t.after(() => [host, laneSocket].forEach((s) => s.terminate()));
  assert.deepEqual(host.messages, [{ type: "authenticated", role: "host" }]);
  assert.deepEqual(laneSocket.messages, [{ type: "authenticated", role: "lane" }]);
});

test("a socket is refused for a wrong session, a wrong message, or an unknown event", async (t) => {
  const { base, event } = await runningEvent(t);
  for (const [code, payload] of [
    [event.code, { type: "authenticate", session_id: "wrong-session-value-123" }],
    [event.code, { type: "authenticate" }],
    [event.code, { type: "authenticate", session_id: 5 }],
    [event.code, { type: "hello", session_id: event.host }],
    [event.code, [event.host]],
    ["NOPE01", { type: "authenticate", session_id: event.host }],
  ]) {
    const socket = await connectSocket(base, code);
    t.after(() => socket.terminate());
    socket.send(JSON.stringify(payload));
    assert.equal(await socket.closed, 1008, JSON.stringify(payload));
  }
  const text = await connectSocket(base, event.code);
  text.send("not json");
  assert.equal(await text.closed, 1008);
  const binary = await connectSocket(base, event.code);
  binary.send(Buffer.from([1, 2, 3]));
  assert.equal(await binary.closed, 1008);
});

test("a session of another event does not open a socket", async (t) => {
  const { base, event, createEvent } = await runningEvent(t);
  const other = await createEvent("OTH001");
  const socket = await connectSocket(base, event.code);
  socket.send(JSON.stringify({ type: "authenticate", session_id: other.host }));
  assert.equal(await socket.closed, 1008);
});

test("an upgrade to a path that is not an event is refused and does not stop the server", async (t) => {
  const { base, port } = await startApp(t);
  for (const target of ["/ws/%ZZ", "/ws/", "/ws/bad-code", "/other", "/ws/ABC/extra", "/ws/" + "A".repeat(40)]) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${target}`);
    socket.on("error", () => {});
    const [status] = await Promise.race([once(socket, "unexpected-response").then(([, response]) => [response.statusCode]), once(socket, "open").then(() => [101])]);
    assert.notEqual(status, 101, target);
  }
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});

test("a socket that does not authenticate in time is closed", async (t) => {
  const { base, event } = await runningEvent(t, { authTimeoutMs: 100 });
  const socket = await connectSocket(base, event.code);
  t.after(() => socket.terminate());
  // Not 1008: the client must not take a slow start for a rejected session.
  assert.equal(await socket.closed, 4002);
});

test("a large first message closes the socket", async (t) => {
  const { base, event } = await runningEvent(t);
  const socket = await connectSocket(base, event.code);
  socket.send("x".repeat(8192));
  assert.equal(await socket.closed, 1009);
});

test("every event change reaches the sockets of that event once", async (t) => {
  const { base, event, lane, participant, distance, request, createEvent } = await runningEvent(t);
  const other = await createEvent("OTH002");
  const sockets = await Promise.all([
    connectSocket(base, event.code, event.host),
    connectSocket(base, event.code, lane.session_id),
    connectSocket(base, other.code, other.host),
  ]);
  t.after(() => sockets.forEach((s) => s.terminate()));
  await request("PUT", `/api/results/${event.code}/participant/${participant}/distance/${distance}`, { shots: [{ shot_number: 1, score: 8 }, { shot_number: 2, score: 9 }] }, lane.session_id);
  await waitFor(() => messagesOf(sockets[0]).length && messagesOf(sockets[1]).length, "messages");
  const expected = [{ type: "result_update", participant_id: participant, total_score: 17 }];
  assert.deepEqual(messagesOf(sockets[0]), expected);
  assert.deepEqual(messagesOf(sockets[1]), expected);
  await wait(50);
  assert.deepEqual(messagesOf(sockets[2]), []);
});

test("each kind of change sends its message", async (t) => {
  const { base, event, request } = await runningEvent(t);
  const socket = await connectSocket(base, event.code, event.host);
  t.after(() => socket.terminate());
  const { code, host } = event;
  await request("POST", `/api/distances/${code}`, { title: "B", shots_count: 3 }, host);
  await request("PATCH", `/api/distances/${code}/2`, { status: "active" }, host);
  await request("POST", `/api/sessions/${code}/lane/9`, {});
  await request("DELETE", `/api/sessions/${code}/lane/9`, undefined, host);
  await request("PATCH", `/api/properties/${code}`, { client_allow_add_participant: false }, host);
  await request("PATCH", `/api/events/${code}`, { status: "finished" }, host);
  await waitFor(() => messagesOf(socket).length >= 5, "five messages");
  await wait(50);
  assert.deepEqual(messagesOf(socket), [
    { type: "refresh" },
    { type: "distance_update", distance_id: 2, status: "active" },
    { type: "lane_session_reset", lane_number: 9 },
    { type: "refresh" },
    { type: "event_status", status: "finished" },
  ]);
});

test("a message from a client is not sent to other clients", async (t) => {
  const { base, event } = await runningEvent(t);
  const [one, two] = await Promise.all([connectSocket(base, event.code, event.host), connectSocket(base, event.code, event.host)]);
  t.after(() => [one, two].forEach((s) => s.terminate()));
  one.send(JSON.stringify({ type: "event_status", status: "forged" }));
  await wait(100);
  assert.deepEqual(messagesOf(two), []);
  assert.equal(one.readyState, WebSocket.OPEN);
});

test("a change that is rolled back sends no message", async (t) => {
  const { base, event, request } = await runningEvent(t);
  const socket = await connectSocket(base, event.code, event.host);
  t.after(() => socket.terminate());
  const rejected = await request("PATCH", `/api/distances/${event.code}/1`, { status: "pending" }, event.host);
  assert.equal(rejected.status, 403);
  await wait(100);
  assert.deepEqual(messagesOf(socket), []);
});

test("a reset closes the sockets of that lane after the message", async (t) => {
  const { base, event, lane, request } = await runningEvent(t);
  const laneSocket = await connectSocket(base, event.code, lane.session_id);
  const hostSocket = await connectSocket(base, event.code, event.host);
  t.after(() => [laneSocket, hostSocket].forEach((s) => s.terminate()));
  await request("DELETE", `/api/sessions/${event.code}/lane/1`, undefined, event.host);
  assert.equal(await laneSocket.closed, 4001);
  assert.deepEqual(messagesOf(laneSocket), [{ type: "lane_session_reset", lane_number: 1 }]);
  assert.equal(hostSocket.readyState, WebSocket.OPEN);
});

test("a password change closes the sockets of the sessions that ended", async (t) => {
  const { base, event, request } = await runningEvent(t);
  const second = (await request("POST", `/api/sessions/${event.code}/host`, { password: event.password })).data.session_id;
  const current = await connectSocket(base, event.code, event.host);
  const other = await connectSocket(base, event.code, second);
  t.after(() => [current, other].forEach((s) => s.terminate()));
  await request("PATCH", `/api/properties/${event.code}`, { host_password: "another-host-password" }, event.host);
  assert.equal(await other.closed, 4001);
  assert.equal(current.readyState, WebSocket.OPEN);
});

test("the server drops a socket that does not answer pings and keeps a live one", async (t) => {
  const { base, event } = await runningEvent(t, { heartbeatMs: 100 });
  const silent = await connectSocket(base, event.code, event.host, { autoPong: false });
  const live = await connectSocket(base, event.code, event.host);
  t.after(() => [silent, live].forEach((s) => s.terminate()));
  await Promise.race([silent.closed, wait(3000).then(() => assert.fail("The silent socket stayed open"))]);
  await wait(400);
  assert.equal(live.readyState, WebSocket.OPEN);
});

test("the server limits the number of sockets", async (t) => {
  const { base, event } = await runningEvent(t, { maxSockets: 2 });
  const first = await connectSocket(base, event.code, event.host);
  const second = await connectSocket(base, event.code, event.host);
  t.after(() => [first, second].forEach((s) => s.terminate()));
  const third = new WebSocket(`${base.replace("http:", "ws:")}/ws/${event.code}`);
  third.on("error", () => {});
  const [, response] = await once(third, "unexpected-response");
  assert.equal(response.statusCode, 503);
  first.close();
  await first.closed;
  const fourth = await connectSocket(base, event.code, event.host);
  fourth.terminate();
});

test("a socket that reads too slowly is dropped and does not fill the memory", async (t) => {
  const { app, base, event } = await runningEvent(t);
  const socket = await connectSocket(base, event.code, event.host);
  t.after(() => socket.terminate());
  const [server] = app.hub.sockets(event.code);
  Object.defineProperty(server, "bufferedAmount", { value: 5 * 1024 * 1024 });
  app.hub.publish(event.code, { type: "refresh" });
  assert.equal(await socket.closed, 1006);
});

test("a database error during authentication closes the socket with 1011", async (t) => {
  const { app, base, event, errors } = await runningEvent(t);
  app.pool.get = () => {
    throw new Error("database failure");
  };
  const socket = await connectSocket(base, event.code);
  socket.send(JSON.stringify({ type: "authenticate", session_id: event.host }));
  assert.equal(await socket.closed, 1011);
  assert.equal(errors.length, 1);
});

test("the server closes all sockets when it stops", async (t) => {
  const { app, base, event } = await runningEvent(t);
  const socket = await connectSocket(base, event.code, event.host);
  await app.close();
  assert.equal(await socket.closed, 1001);
});
