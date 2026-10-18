// The lane password reset request: the client page, the host page, and the API methods.
const assert = require('node:assert/strict');
const test = require('node:test');
const { browserContext, deferred, tick } = require('./helpers');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const plain = value => JSON.parse(JSON.stringify(value));

// ── API ──────────────────────────────────────────────────────────────────────
test('the API methods for a reset use the right paths, bodies, and sessions', async () => {
    const calls = [];
    const b = browserContext();
    b.context.fetch = async (url, options) => { calls.push({ url, method: options.method, body: options.body, session: options.headers['X-Session-Id'] }); return new Response('{}'); };
    b.load('api.js');
    b.storage.saveHostSession('host-token');
    await b.run(`api.requestLaneReset('ABC123', 4)`);
    await b.run(`api.laneResetStatus('ABC123', 4, 'secret id')`);
    await b.run(`api.approveLaneReset('ABC123', 4)`);
    await b.run(`api.denyLaneReset('ABC123', 4)`);
    assert.deepEqual(calls.map(call => [call.method, call.url, call.session]), [
        ['POST', '/api/sessions/ABC123/lane/4/reset-request', undefined],
        ['POST', '/api/sessions/ABC123/lane/4/reset-request/status', undefined],
        ['POST', '/api/sessions/ABC123/lane/4/reset-request/approve', 'host-token'],
        ['POST', '/api/sessions/ABC123/lane/4/reset-request/deny', 'host-token'],
    ]);
    assert.equal(calls[0].body, '{}');
    assert.deepEqual(JSON.parse(calls[1].body), { request_id: 'secret id' });
});

// ── Host page ────────────────────────────────────────────────────────────────
function hostContext(overrides = {}) {
    const b = browserContext();
    const calls = [];
    b.context.api = {
        async getEvent() { return { status: 'created' }; },
        async getDistances() { return []; },
        async getParticipants() { return [{ id: 1, name: 'Anna', lane_number: 3, shift: 'A' }]; },
        async listLaneSessions() { return { lanes: [3, 5], passwords: { 3: 'ABC123', 5: 'ZXC789' }, requests: { 3: '2026-10-18T10:15:00.000Z' } }; },
        async approveLaneReset(code, lane) { calls.push(['approve', code, lane]); return {}; },
        async denyLaneReset(code, lane) { calls.push(['deny', code, lane]); return {}; },
        ...overrides,
    };
    b.load('ranking.js');
    b.load('actions.js');
    b.load('host.js');
    b.run(`currentCode = 'HOST01'; currentEventData = { status: 'created' };`);
    return { b, calls };
}

test('the host sees a request next to its lane, with the approve and deny buttons', async () => {
    const { b } = hostContext();
    await b.run('loadParticipants()');
    const html = b.get('participants-container').innerHTML;
    const lane3 = html.slice(html.indexOf('Lane 3'), html.indexOf('Lane 5'));
    const lane5 = html.slice(html.indexOf('Lane 5'));
    assert.match(lane3, /class="lane-request"/);
    assert.match(lane3, /Reset requested/);
    assert.match(lane3, /data-click="approveLaneReset" data-args="\[3\]"/);
    assert.match(lane3, /data-click="denyLaneReset" data-args="\[3\]"/);
    assert.doesNotMatch(lane5, /lane-request|approveLaneReset/);
});

test('the host sees a banner while a request waits, and no banner without a request', async () => {
    let requests = { 3: '2026-10-18T10:15:00.000Z', 5: '2026-10-18T10:16:00.000Z' };
    const { b } = hostContext({ async listLaneSessions() { return { lanes: [3, 5], passwords: {}, requests }; } });
    await b.run('loadParticipants()');
    assert.equal(b.get('reset-banner').classList.contains('hidden'), false);
    assert.match(b.get('reset-banner').textContent, /2 lanes ask for a password reset/);
    requests = { 5: '2026-10-18T10:16:00.000Z' };
    await b.run('loadParticipants()');
    assert.match(b.get('reset-banner').textContent, /Lane 5 asks for a password reset/);
    requests = {};
    await b.run('loadParticipants()');
    assert.equal(b.get('reset-banner').classList.contains('hidden'), true);
});

test('approving asks first, then calls the API and reloads the lanes', async () => {
    const { b, calls } = hostContext();
    const questions = [];
    b.context.confirm = question => { questions.push(question); return true; };
    await b.run('approveLaneReset(3)');
    assert.deepEqual(calls, [['approve', 'HOST01', 3]]);
    assert.match(questions[0], /Lane 3/);
    assert.match(questions[0], /disconnect/i);
    assert.match(b.alerts.at(-1), /Lane 3/);
});

test('a refused question does not approve', async () => {
    const { b, calls } = hostContext();
    b.context.confirm = () => false;
    await b.run('approveLaneReset(3)');
    assert.deepEqual(calls, []);
    assert.equal(b.alerts.length, 0);
});

test('denying calls the API at once and reloads the lanes', async () => {
    const { b, calls } = hostContext();
    b.context.confirm = () => { throw new Error('No question expected'); };
    await b.run('denyLaneReset(3)');
    assert.deepEqual(calls, [['deny', 'HOST01', 3]]);
});

test('a failed decision shows the reason', async () => {
    const { b } = hostContext({ async approveLaneReset() { throw new Error('There is no reset request for this lane.'); } });
    b.context.confirm = () => true;
    await b.run('approveLaneReset(3)');
    assert.match(b.alerts.at(-1), /no reset request/);
    const denied = hostContext({ async denyLaneReset() { throw new Error('boom'); } });
    await denied.b.run('denyLaneReset(3)');
    assert.match(denied.b.alerts.at(-1), /boom/);
});

test('the host page follows a request that arrives through the socket', () => {
    const { b } = hostContext();
    b.context.WSClient = class { constructor() { this.handlers = {}; } on(type, fn) { this.handlers[type] = fn; } connect() {} disconnect() {} };
    b.storage.saveHostSession('token');
    b.run('_connectWS()');
    const handlers = b.run('wsClient.handlers');
    assert.equal(typeof handlers.lane_reset_requested, 'function');
    assert.equal(typeof handlers.lane_session_reset, 'function');
});

// ── Client page ──────────────────────────────────────────────────────────────
function clientContext(overrides = {}) {
    const b = browserContext();
    b.context.CONFIG.RESET_POLL_MS = 10;
    const calls = { request: 0, status: [] };
    const script = { statuses: [{ status: 'pending' }] };
    b.context.api = {
        async requestLaneReset(code, lane) { calls.request++; return { request_id: 'secret-id-value', status: 'pending' }; },
        async laneResetStatus(code, lane, id) { calls.status.push([code, lane, id]); return script.statuses.length > 1 ? script.statuses.shift() : script.statuses[0]; },
        async getEvent() { return { status: 'created' }; },
        async getDistances() { return []; },
        async getPublicProperties() { return { client_allow_add_participant: true }; },
        async getParticipants() { return []; },
        async getParticipantState() { return { distances: [] }; },
        ...overrides,
    };
    b.context.WSClient = class { constructor(code, session) { this.session = session; globalThis.__last = this; } on() {} connect() { this.connected = true; } disconnect() { this.stopped = true; } };
    b.load('client.js');
    b.run(`currentCode = 'EVENT1'; currentLane = 3; _showLaneAuthScreen(3);`);
    return { b, calls, script };
}
const visible = (b, id) => !b.get(id).classList.contains('hidden');

test('the password screen offers to ask the host for a reset', () => {
    const { b } = clientContext();
    assert.equal(b.visible(), 'lane-auth-screen');
    assert.equal(visible(b, 'lane-reset-btn'), true);
    assert.equal(visible(b, 'lane-reset-cancel'), false);
    assert.equal(visible(b, 'lane-reset-status'), false);
});

test('asking sends one request, saves the secret id, and shows the waiting state', async () => {
    const { b, calls } = clientContext();
    await Promise.all([b.run('requestLaneReset()'), b.run('requestLaneReset()')]);
    assert.equal(calls.request, 1);
    assert.equal(b.storage.getResetRequest('EVENT1', 3), 'secret-id-value');
    assert.equal(visible(b, 'lane-reset-btn'), false);
    assert.equal(visible(b, 'lane-reset-cancel'), true);
    assert.match(b.get('lane-reset-status').textContent, /Waiting for the host/);
    b.run('cancelLaneReset()');
});

test('the page asks for the result until the host decides', async () => {
    const { b, calls, script } = clientContext();
    script.statuses = [{ status: 'pending' }, { status: 'pending' }, { status: 'pending' }];
    await b.run('requestLaneReset()');
    await wait(80);
    assert.ok(calls.status.length >= 3, `status calls: ${calls.status.length}`);
    assert.deepEqual(calls.status[0], ['EVENT1', 3, 'secret-id-value']);
    assert.equal(b.visible(), 'lane-auth-screen');
    b.run('cancelLaneReset()');
});

test('an approval shows the new password like the first entry to a lane', async () => {
    const { b, script } = clientContext();
    script.statuses = [{ status: 'pending' }, { status: 'approved', session_id: 'fresh-session', password: 'NEW123', lane_number: 3 }];
    await b.run('requestLaneReset()');
    await wait(80);
    assert.equal(b.visible(), 'lane-password-screen');
    assert.equal(b.get('lane-pw-display').textContent, 'NEW123');
    assert.equal(b.storage.getLaneSession(3), 'fresh-session');
    assert.equal(b.storage.getLane(), 3);
    assert.equal(b.storage.getResetRequest('EVENT1', 3), null);
    assert.equal(b.run('wsClient.connected'), true);
});

test('a denial is reported, the request is forgotten, and the page can ask again', async () => {
    const { b, calls, script } = clientContext();
    script.statuses = [{ status: 'denied' }];
    await b.run('requestLaneReset()');
    await wait(60);
    assert.equal(b.visible(), 'lane-auth-screen');
    assert.match(b.get('lane-reset-status').textContent, /host denied/i);
    assert.equal(visible(b, 'lane-reset-btn'), true);
    assert.equal(visible(b, 'lane-reset-cancel'), false);
    assert.equal(b.storage.getResetRequest('EVENT1', 3), null);
    const polled = calls.status.length;
    await wait(60);
    assert.equal(calls.status.length, polled, 'The page stops asking');
});

test('an ended request is reported and can be sent again', async () => {
    const { b, script } = clientContext();
    script.statuses = [{ status: 'expired' }];
    await b.run('requestLaneReset()');
    await wait(60);
    assert.match(b.get('lane-reset-status').textContent, /request ended/i);
    assert.equal(visible(b, 'lane-reset-btn'), true);
    assert.equal(b.storage.getResetRequest('EVENT1', 3), null);
});

test('a network problem while the page waits does not end the request', async () => {
    let failures = 2;
    const { b, calls } = clientContext({
        async laneResetStatus(code, lane, id) {
            calls.status.push([id]);
            if (failures-- > 0) throw new Error('Network down');
            return { status: 'approved', session_id: 'fresh', password: 'AFTER1', lane_number: 3 };
        },
    });
    await b.run('requestLaneReset()');
    await wait(120);
    assert.equal(b.visible(), 'lane-password-screen');
    assert.equal(b.get('lane-pw-display').textContent, 'AFTER1');
});

test('a request that fails shows the reason and the page can ask again', async () => {
    for (const [status, message, expected] of [[409, 'This lane has no password yet. Open the lane to get one.', /no password yet/], [429, 'Too many failed login attempts. Try again later. Wait 15 minutes.', /Wait 15 minutes/], [0, 'The request timed out. Try again.', /timed out/]]) {
        const { b } = clientContext({ async requestLaneReset() { const error = new Error(message); error.status = status; throw error; } });
        await b.run('requestLaneReset()');
        assert.match(b.get('lane-reset-status').textContent, expected, String(status));
        assert.equal(visible(b, 'lane-reset-btn'), true);
        assert.equal(b.storage.getResetRequest('EVENT1', 3), null);
    }
});

test('cancelling stops the asking, forgets the request, and shows the button', async () => {
    const { b, calls } = clientContext();
    await b.run('requestLaneReset()');
    await wait(30);
    b.run('cancelLaneReset()');
    const polled = calls.status.length;
    await wait(60);
    assert.equal(calls.status.length, polled);
    assert.equal(b.storage.getResetRequest('EVENT1', 3), null);
    assert.equal(visible(b, 'lane-reset-btn'), true);
    assert.equal(visible(b, 'lane-reset-cancel'), false);
    assert.equal(visible(b, 'lane-reset-status'), false);
});

test('a page that opens again continues to wait for a saved request', async () => {
    const { b, calls, script } = clientContext();
    b.storage.saveResetRequest('EVENT1', 3, 'saved-secret-id');
    script.statuses = [{ status: 'pending' }, { status: 'approved', session_id: 'later', password: 'LATER1', lane_number: 3 }];
    b.run(`_showLaneAuthScreen(3)`);
    assert.match(b.get('lane-reset-status').textContent, /Waiting for the host/);
    await wait(80);
    assert.equal(calls.status[0][2], 'saved-secret-id');
    assert.equal(b.visible(), 'lane-password-screen');
    assert.equal(b.get('lane-pw-display').textContent, 'LATER1');
});

test('a saved request of another lane or event is not used', async () => {
    const { b, calls } = clientContext();
    b.storage.saveResetRequest('EVENT1', 4, 'other-lane-id');
    b.storage.saveResetRequest('OTHER9', 3, 'other-event-id');
    b.run(`_showLaneAuthScreen(3)`);
    await wait(40);
    assert.equal(calls.status.length, 0);
    assert.equal(visible(b, 'lane-reset-btn'), true);
});

test('leaving the password screen stops the asking but keeps the request for later', async () => {
    const { b, calls } = clientContext();
    await b.run('requestLaneReset()');
    await wait(30);
    b.run('backToLane()');
    const polled = calls.status.length;
    await wait(60);
    assert.equal(calls.status.length, polled);
    assert.equal(b.storage.getResetRequest('EVENT1', 3), 'secret-id-value');
});

test('an approval that arrives after the user went to another lane does not take over the page', async () => {
    const gate = deferred();
    const { b } = clientContext({ async laneResetStatus() { await gate.promise; return { status: 'approved', session_id: 'late', password: 'LATE11', lane_number: 3 }; } });
    await b.run('requestLaneReset()');
    await wait(30);
    b.run('backToLane()');
    gate.resolve();
    await wait(40);
    assert.notEqual(b.visible(), 'lane-password-screen');
    assert.equal(b.storage.getLaneSession(3), null);
});

test('the buttons on the password screen are connected to the actions', async () => {
    const { b, calls } = clientContext();
    b.run('_bindClientControls()');
    const click = [...(b.document.listeners.click || [])][0];
    const fake = action => ({ target: { closest: selector => (selector === '[data-action]' ? { dataset: { action } } : null) } });
    click(fake('request-reset'));
    await wait(30);
    assert.equal(calls.request, 1);
    click(fake('cancel-reset'));
    assert.equal(visible(b, 'lane-reset-btn'), true);
});

test('the storage keeps a request for each event and lane', () => {
    const b = browserContext();
    assert.equal(b.storage.getResetRequest('ABC123', 1), null);
    b.storage.saveResetRequest('ABC123', 1, 'one');
    b.storage.saveResetRequest('ABC123', 2, 'two');
    assert.equal(b.storage.getResetRequest('ABC123', 1), 'one');
    b.storage.clearResetRequest('ABC123', 1);
    assert.equal(b.storage.getResetRequest('ABC123', 1), null);
    assert.equal(b.storage.getResetRequest('ABC123', 2), 'two');
});
