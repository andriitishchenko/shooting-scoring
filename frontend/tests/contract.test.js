// Contract tests: the real client scripts run against the real Node server.
const assert = require('node:assert/strict');
const test = require('node:test');
const { CODE, wait, waitFor, stack, loginToLane, openScoring } = require('./stack');

test('first lane login keeps the password on screen while the socket authenticates', async t => {
    const s = await stack(t);
    const b = s.makeClient();
    await loginToLane(s, b);
    assert.equal(b.visible(), 'lane-password-screen');
    assert.match(b.get('lane-pw-display').textContent, /^[A-Z0-9]{6}$/);
    await waitFor(() => b.run('wsClient?.authenticated'), 'socket authenticated');
    await wait(500);
    assert.equal(b.visible(), 'lane-password-screen');
    await b.run('proceedAfterPassword()');
    assert.equal(b.visible(), 'participants-screen');
    assert.match(b.get('participants-list').innerHTML, /Archer/);
    assert.equal(b.get('lane-pw-display').textContent, '');
});

test('a reload restores the saved lane session without a password', async t => {
    const s = await stack(t);
    const first = s.makeClient();
    await loginToLane(s, first);
    await first.run('proceedAfterPassword()');
    const second = s.makeClient(first.values);
    await Promise.all([...second.windowListeners.DOMContentLoaded].map(fn => fn()));
    assert.equal(second.visible(), 'participants-screen');
    assert.match(second.get('participants-list').innerHTML, /Archer/);
});

test('another device needs the lane password and a wrong password is rejected', async t => {
    const s = await stack(t);
    const first = s.makeClient();
    await loginToLane(s, first);
    const password = first.get('lane-pw-display').textContent;
    const second = s.makeClient();
    second.get('code-input').value = CODE;
    await second.run('clientEnter()');
    await second.run('selectLane(1)');
    assert.equal(second.visible(), 'lane-auth-screen');
    second.get('lane-pw-input').value = 'WRONGPASSWORD';
    await second.run('submitLanePassword()');
    assert.match(second.get('lane-pw-error').textContent, /Invalid password/);
    assert.equal(second.visible(), 'lane-auth-screen');
    second.get('lane-pw-input').value = password.toLowerCase();
    await second.run('submitLanePassword()');
    assert.equal(second.visible(), 'participants-screen');
});

test('deleting scores after reopening them replaces the saved server results', async t => {
    const s = await stack(t);
    const b = s.makeClient();
    await openScoring(s, b);
    for (const [score, x] of [[10, true], [9, false], [8, false], [7, false], [6, false], [5, false]]) b.run(`inputScore(${score}, ${x})`);
    await waitFor(async () => (await s.state()).shots.length === 6, 'six shots stored');
    assert.equal((await s.state()).total_score, 45);

    await b.run('backToParticipants()');
    assert.equal(b.visible(), 'participants-screen');
    await b.run(`openScoreInput(${s.participant})`);
    assert.equal(b.run('results.length'), 6);

    await b.run('deleteLastScore()');
    await b.run('deleteLastScore()');
    await waitFor(async () => (await s.state()).shots.length === 4, 'two shots removed on the server');
    const state = await s.state();
    assert.equal(state.total_score, 34);
    assert.deepEqual(state.shots.map(shot => shot.shot), [1, 2, 3, 4]);
    assert.equal(b.run("AppStorage.getPendingResults('CNTR01', 1).length"), 0);
    assert.equal(b.get('total-score').textContent, 34);
});

test('deleting every score clears the distance on the server', async t => {
    const s = await stack(t);
    const b = s.makeClient();
    await openScoring(s, b);
    b.run('inputScore(9)');
    await waitFor(async () => (await s.state()).shots.length === 1, 'one shot stored');
    await b.run('deleteLastScore()');
    await waitFor(async () => (await s.state()).shots.length === 0, 'shot removed on the server');
    assert.equal((await s.state()).total_score, null);
});

test('scores typed while the server is unreachable are sent after the connection returns', async t => {
    const s = await stack(t);
    const b = s.makeClient();
    await openScoring(s, b);
    s.control.down = true;
    b.run('inputScore(9)');
    b.run('inputScore(8)');
    await waitFor(() => b.get('save-status').textContent === 'Saved on device; waiting to sync', 'offline status shown');
    assert.equal(b.run("AppStorage.getPendingResults('CNTR01', 1).length"), 1);
    assert.equal((await s.state()).shots.length, 0);
    s.control.down = false;
    await b.run('_reconcile()');
    assert.deepEqual((await s.state()).shots.map(shot => shot.score), [9, 8]);
    assert.equal(b.run("AppStorage.getPendingResults('CNTR01', 1).length"), 0);
});

test('saving a shot does not reload the whole lane', async t => {
    const s = await stack(t);
    const b = s.makeClient();
    await openScoring(s, b);
    await wait(600);
    s.control.log.length = 0;
    b.run('inputScore(9)');
    await waitFor(async () => (await s.state()).shots.length === 1, 'shot stored');
    b.run('inputScore(8)');
    await waitFor(async () => (await s.state()).shots.length === 2, 'second shot stored');
    await wait(800);
    const reloads = s.control.log.filter(url => /^\/api\/(participants|events|distances|properties)\//.test(url));
    assert.deepEqual(reloads, []);
    assert.equal(b.get('total-score').textContent, 17);
});

test('the host can correct results after the event finishes, but the lane cannot', async t => {
    const s = await stack(t);
    const b = s.makeClient();
    await openScoring(s, b);
    b.run('inputScore(9)');
    await waitFor(async () => (await s.state()).shots.length === 1, 'shot stored');
    await s.call('PATCH', `/api/events/${CODE}`, { status: 'finished' }, s.host);
    const lane = b.storage.getLaneSession(1);
    const edit = `api.replaceDistanceResults('${CODE}', ${s.participant}, ${s.distance}, [{ shot_number: 1, score: 7, is_x: false }], `;
    const denied = await b.run(edit + `'${lane}')`).then(() => null, error => error);
    assert.equal(denied.status, 403);
    assert.equal(denied.message, 'The event has finished');
    await b.run(edit + `'${s.host}')`);
    const detail = await b.run(`api.getDistanceDetail('${CODE}', ${s.participant}, ${s.distance})`);
    assert.equal(detail.total_score, 7);
    assert.equal(detail.series[0].shots[0].score, 7);
});

test('scores typed offline are archived for download when the event finished meanwhile', async t => {
    const s = await stack(t);
    const b = s.makeClient();
    await openScoring(s, b);
    s.control.down = true;
    b.run('inputScore(9)');
    await waitFor(() => b.get('save-status').textContent === 'Saved on device; waiting to sync', 'offline status shown');
    await s.call('PATCH', `/api/events/${CODE}`, { status: 'finished' }, s.host);
    s.control.down = false;
    await b.run('_reconcile()');
    assert.equal(b.visible(), 'participants-screen');
    assert.equal((await s.state()).shots.length, 0);
    assert.equal(b.run("AppStorage.getPendingResults('CNTR01', 1).length"), 0);
    const recovered = b.run('AppStorage.getRecoveryResults()');
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].reason, 'event_finished');
    assert.equal(recovered[0].shots[0].score, 9);
    assert.equal(b.get('recovery-download').classList.contains('hidden'), false);
});

test('a lane reset by the host sends the client back to lane selection', async t => {
    const s = await stack(t);
    const b = s.makeClient();
    await loginToLane(s, b);
    await b.run('proceedAfterPassword()');
    await waitFor(() => b.run('wsClient?.authenticated'), 'socket authenticated');
    await s.call('DELETE', `/api/sessions/${CODE}/lane/1`, undefined, s.host);
    await waitFor(() => b.visible() === 'lane-screen', 'client returned to lane selection');
    assert.equal(b.storage.getLaneSession(1), null);
    assert.equal(b.storage.getLane(), null);
    assert.match(b.alerts.at(-1), /reset/);
    await b.run('selectLane(1)');
    assert.equal(b.visible(), 'lane-password-screen');
});

test('host changes reach an idle client screen through the socket', async t => {
    const s = await stack(t);
    const b = s.makeClient();
    await loginToLane(s, b);
    await b.run('proceedAfterPassword()');
    await waitFor(() => b.run('wsClient?.authenticated'), 'socket authenticated');
    await s.start();
    await waitFor(() => /dist-tag-active/.test(b.get('participants-list').innerHTML), 'active distance rendered');
    assert.equal(b.run("eventData?.status"), 'started');
});

test('API errors from the Node server reach the client as readable messages', async t => {
    const s = await stack(t);
    const b = s.makeClient();
    const failure = promise => promise.then(() => assert.fail('The request should fail'), error => error);
    let error = await failure(b.run("api.getEvent('NOPE01')"));
    assert.equal(error.status, 404);
    assert.equal(error.message, 'Event not found');
    error = await failure(b.run(`api.addParticipant('${CODE}', { name: '', lane_number: 1, shift: 'A' }, '${s.host}')`));
    assert.equal(error.status, 422);
    assert.match(error.message, /name/);
    error = await failure(b.run(`api.replaceDistanceResults('${CODE}', ${s.participant}, ${s.distance}, [], 'bad-session')`));
    assert.equal(error.status, 401);
    assert.equal(error.message, 'Invalid session for participant lane');
});

test('the socket client is told when the server rejects its session', async t => {
    const s = await stack(t);
    const b = s.makeClient();
    const rejected = new Promise(resolve => {
        b.run(`(() => { const client = new WSClient('${CODE}', 'not-a-session'); client.on('session_rejected', () => ${'resolve'}()); globalThis.__probe = client; return client; })()`);
        b.context.resolve = resolve;
    });
    b.run('__probe.connect()');
    await rejected;
    assert.equal(b.run('__probe.stopped'), true);
});

// ── A lane that lost its password asks the host for a reset ──────────────────
async function secondDevice(s, owner) {
    const b = s.makeClient();
    b.get('code-input').value = CODE;
    await b.run('clientEnter()');
    await b.run('selectLane(1)');
    assert.equal(b.visible(), 'lane-auth-screen');
    return b;
}
async function hostPanel(s) {
    const h = s.makeHost();
    h.get('code-input').value = CODE;
    h.get('password-input').value = s.hostPassword;
    h.context.confirm = () => true;
    await h.run('hostEnter()');
    await waitFor(() => h.run('currentEventData?.status'), 'host panel loaded');
    return h;
}
const requestShown = h => /Reset requested/.test(h.get('participants-container').innerHTML);

test('a lane that lost its password gets a new one after the host approves', async t => {
    const s = await stack(t);
    const owner = s.makeClient();
    await loginToLane(s, owner);
    const oldPassword = owner.get('lane-pw-display').textContent;
    await owner.run('proceedAfterPassword()');
    await waitFor(() => owner.run('wsClient?.authenticated'), 'owner socket authenticated');

    const lost = await secondDevice(s);
    await lost.run('requestLaneReset()');
    assert.match(lost.get('lane-reset-status').textContent, /Waiting for the host/);

    const host = await hostPanel(s);
    await waitFor(() => requestShown(host), 'request shown to the host');
    assert.equal(host.get('reset-banner').classList.contains('hidden'), false);
    assert.match(host.get('reset-banner').textContent, /Lane 1 asks for a password reset/);
    assert.match(host.get('participants-container').innerHTML, new RegExp(`>${oldPassword}<`));

    await host.run('approveLaneReset(1)');
    await waitFor(() => lost.visible() === 'lane-password-screen', 'the lane shows the new password');
    const newPassword = lost.get('lane-pw-display').textContent;
    assert.match(newPassword, /^[A-Z0-9]{6}$/);
    assert.notEqual(newPassword, oldPassword);
    assert.equal(lost.storage.getResetRequest(CODE, 1), null);
    assert.ok(lost.storage.getLaneSession(1));

    // The device that used the lane before is sent back to the lane selection.
    await waitFor(() => owner.visible() === 'lane-screen', 'the old device returns to lane selection');
    // The host sees the new password, and the request is gone.
    await waitFor(() => !requestShown(host) && new RegExp(`>${newPassword}<`).test(host.get('participants-container').innerHTML), 'host list updated');
    assert.equal(host.get('reset-banner').classList.contains('hidden'), true);
    // The old password does not work. The new one does.
    assert.equal((await s.call('POST', `/api/sessions/${CODE}/lane/1`, { password: oldPassword })).status, 401);
    assert.equal((await s.call('POST', `/api/sessions/${CODE}/lane/1`, { password: newPassword })).data.status, 'ok');
    // The new device continues like after a first entry.
    await lost.run('proceedAfterPassword()');
    assert.equal(lost.visible(), 'participants-screen');
    assert.match(lost.get('participants-list').innerHTML, /Archer/);
    assert.equal(lost.get('lane-pw-display').textContent, '');
});

test('a denied request leaves the lane as it was, and the lane is told', async t => {
    const s = await stack(t);
    const owner = s.makeClient();
    await loginToLane(s, owner);
    const password = owner.get('lane-pw-display').textContent;
    await owner.run('proceedAfterPassword()');
    await waitFor(() => owner.run('wsClient?.authenticated'), 'owner socket authenticated');

    const lost = await secondDevice(s);
    await lost.run('requestLaneReset()');
    const host = await hostPanel(s);
    await waitFor(() => requestShown(host), 'request shown to the host');
    await host.run('denyLaneReset(1)');
    await waitFor(() => /denied/i.test(lost.get('lane-reset-status').textContent), 'the lane hears the denial');
    assert.equal(lost.visible(), 'lane-auth-screen');
    assert.equal(lost.get('lane-reset-btn').classList.contains('hidden'), false);
    await waitFor(() => !requestShown(host), 'request gone from the host list');
    assert.equal(owner.visible(), 'participants-screen');
    assert.match(host.get('participants-container').innerHTML, new RegExp(`>${password}<`));
    assert.equal((await s.call('POST', `/api/sessions/${CODE}/lane/1`, { password })).data.status, 'ok');
});

test('a device that was reloaded while it waited still gets the new password', async t => {
    const s = await stack(t);
    const owner = s.makeClient();
    await loginToLane(s, owner);
    await owner.run('proceedAfterPassword()');

    const lost = await secondDevice(s);
    await lost.run('requestLaneReset()');
    assert.ok(lost.storage.getResetRequest(CODE, 1));
    lost.run('backToLane()');

    // The page is open again: same storage, new scripts.
    const reopened = s.makeClient(lost.values);
    reopened.get('code-input').value = CODE;
    await reopened.run('clientEnter()');
    await reopened.run('selectLane(1)');
    assert.match(reopened.get('lane-reset-status').textContent, /Waiting for the host/);

    const host = await hostPanel(s);
    await waitFor(() => requestShown(host), 'request shown to the host');
    await host.run('approveLaneReset(1)');
    await waitFor(() => reopened.visible() === 'lane-password-screen', 'the reopened page shows the new password');
    assert.match(reopened.get('lane-pw-display').textContent, /^[A-Z0-9]{6}$/);
});

test('a request is refused for a lane that has no password, with a clear message', async t => {
    const s = await stack(t);
    const device = s.makeClient();
    device.get('code-input').value = CODE;
    await device.run('clientEnter()');
    device.run(`currentLane = 9; _showLaneAuthScreen(9)`);
    await device.run('requestLaneReset()');
    assert.match(device.get('lane-reset-status').textContent, /no password yet/);
    assert.equal(device.get('lane-reset-btn').classList.contains('hidden'), false);
});
