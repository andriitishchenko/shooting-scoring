// Unit tests for the host and viewer pages with fake timers and a fake API.
const assert = require('node:assert/strict');
const test = require('node:test');
const { browserContext, deferred, tick } = require('./helpers');

function fakeTimers(b) {
    const pending = new Map();
    let next = 0;
    b.context.setTimeout = (fn, ms) => { pending.set(++next, { fn, ms, interval: false }); return next; };
    b.context.setInterval = (fn, ms) => { pending.set(++next, { fn, ms, interval: true }); return next; };
    b.context.clearTimeout = b.context.clearInterval = id => pending.delete(id);
    return {
        pending,
        count: filter => [...pending.values()].filter(filter).length,
        async fire(filter = () => true) {
            for (const [id, timer] of [...pending]) {
                if (!filter(timer)) continue;
                if (!timer.interval) pending.delete(id);
                await timer.fn();
            }
            await tick();
        },
    };
}

function viewerContext(overrides = {}) {
    const b = browserContext();
    const calls = { event: 0, participants: 0 };
    b.context.api = {
        async getEvent() { calls.event++; return { status: 'created' }; },
        async getDistances() { return []; },
        async getParticipants() { calls.participants++; return []; },
        async getLeaderboard() { return {}; },
        async viewerLogin() { return { ok: true, session_id: 'viewer-token' }; },
        ...overrides,
    };
    const sockets = [];
    b.context.WSClient = class {
        constructor(code, session) { this.code = code; this.session = session; this.handlers = {}; this.stopped = false; sockets.push(this); }
        on(type, fn) { this.handlers[type] = fn; }
        connect() { this.connected = true; }
        disconnect() { this.stopped = true; }
    };
    b.load('ranking.js');
    b.load('actions.js');
    b.load('viewer.js');
    return { b, calls, sockets, timers: fakeTimers(b) };
}

test('viewer keeps one retry timer while the server is down', async () => {
    const { b, calls, timers } = viewerContext({ async getEvent() { throw new Error('down'); } });
    b.run(`currentCode = 'ABC123'`);
    await b.run('_loadAndRender()');
    await b.run('_loadAndRender()');
    await b.run('_loadAndRender()');
    assert.equal(timers.count(timer => timer.ms === 15000), 1);
    assert.equal(calls.event, 0);
});

test('viewer sends no request after exit, even when a retry was scheduled', async () => {
    let requests = 0;
    const { b, timers } = viewerContext({ async getEvent() { requests++; throw new Error('down'); } });
    b.run(`currentCode = 'ABC123'`);
    await b.run('_loadAndRender()');
    assert.equal(requests, 1);
    b.run('exitViewer(true)');
    await timers.fire();
    assert.equal(requests, 1);
    assert.equal(timers.pending.size, 0);
});

test('viewer entering twice keeps one refresh timer and one scroll timer', async () => {
    const { b, timers } = viewerContext();
    await b.run(`_enterViewer('ABC123', 'token')`);
    await b.run(`_enterViewer('ABC123', 'token')`);
    assert.equal(timers.count(timer => timer.interval), 2);
    b.run('exitViewer(true)');
    assert.equal(timers.pending.size, 0);
});

function hostContext(overrides = {}) {
    const b = browserContext();
    const calls = { participants: 0, leaderboard: 0, lanes: 0 };
    b.context.api = {
        async getEvent() { return { status: 'started' }; },
        async getDistances() { return []; },
        async getParticipants() { calls.participants++; return []; },
        async listLaneSessions() { calls.lanes++; return { lanes: [] }; },
        async getLeaderboard() { calls.leaderboard++; return {}; },
        async getProperties() { return { viewer_password_configured: false, client_allow_add_participant: 'false' }; },
        async createEvent() { return { session_id: 's', host_password: 'p' }; },
        async hostLogin() { return { session_id: 's' }; },
        async updateProperties() { return {}; },
        ...overrides,
    };
    b.load('ranking.js');
    b.load('actions.js');
    b.load('host.js');
    b.run(`currentCode = 'HOST01'; currentEventData = { status: 'started' };`);
    return { b, calls, timers: fakeTimers(b) };
}

test('many score updates cause one reload of the participants and the results', async () => {
    const { b, calls, timers } = hostContext();
    b.get('tab-results').classList.add('active');
    for (let i = 0; i < 20; i++) b.run('_scheduleReload(true)');
    assert.equal(timers.pending.size, 1);
    await timers.fire();
    assert.equal(calls.participants >= 1, true);
    assert.equal(calls.participants <= 2, true);
    assert.equal(calls.leaderboard, 1);
    assert.equal(timers.pending.size, 0);
});

test('a reload for a lane refresh does not load the results', async () => {
    const { b, calls, timers } = hostContext();
    b.get('tab-results').classList.add('active');
    b.run('_scheduleReload(false)');
    await timers.fire();
    assert.equal(calls.leaderboard, 0);
    assert.equal(calls.participants, 1);
});

test('an older participant response cannot replace a newer one', async () => {
    const first = deferred();
    let call = 0;
    const { b } = hostContext({
        async getParticipants() {
            const mine = ++call;
            if (mine === 1) await first.promise;
            return [{ id: mine, name: mine === 1 ? 'Old' : 'New', lane_number: 1, shift: 'A' }];
        },
    });
    const slow = b.run('loadParticipants()');
    await tick();
    await b.run('loadParticipants()');
    first.resolve();
    await slow;
    assert.deepEqual(b.run('allParticipants.map(p => p.name)'), ['New']);
    assert.match(b.get('participants-container').innerHTML, /New/);
    assert.doesNotMatch(b.get('participants-container').innerHTML, /Old/);
});

test('an older results response cannot replace a newer one', async () => {
    const first = deferred();
    let call = 0;
    const { b } = hostContext({
        async getLeaderboard() {
            const mine = ++call;
            if (mine === 1) await first.promise;
            return { unknown_unknown: [{ id: 1, name: mine === 1 ? 'Old' : 'New', lane_shift: '1A', total_score: 1, avg_score: 1, x_count: 0, ten_count: 0, distance_scores: [] }] };
        },
        async getParticipants() { return [{ id: 1, name: 'Whoever', lane_number: 1, shift: 'A' }]; },
    });
    const slow = b.run('loadResults()');
    await tick();
    await b.run('loadResults()');
    first.resolve();
    await slow;
    assert.match(b.get('results-container').innerHTML, /New/);
    assert.doesNotMatch(b.get('results-container').innerHTML, /Old/);
});

test('a network error at login does not offer to create a new event', async () => {
    let confirmed = 0, created = 0;
    const { b } = hostContext({
        async getEvent() { const error = new Error('Network down'); error.status = 0; throw error; },
        async createEvent() { created++; return {}; },
    });
    b.context.confirm = () => { confirmed++; return true; };
    b.get('code-input').value = 'ABC123';
    b.get('password-input').value = '';
    await b.run('hostEnter()');
    assert.equal(confirmed, 0);
    assert.equal(created, 0);
    assert.match(b.alerts.at(-1), /Network down/);
});

test('only a missing event offers to create a new event', async () => {
    let confirmed = 0, created = 0;
    const { b } = hostContext({
        async getEvent() { const error = new Error('Event not found'); error.status = 404; throw error; },
        async createEvent() { created++; return { session_id: 's', host_password: 'p' }; },
    });
    b.context.confirm = () => { confirmed++; return true; };
    b.get('code-input').value = 'ABC123';
    await b.run('hostEnter()');
    assert.equal(confirmed, 1);
    assert.equal(created, 1);
});

test('settings do not open with default values when they cannot be loaded', async () => {
    const { b } = hostContext({ async getProperties() { throw new Error('Network down'); } });
    b.get('settings-modal').classList.add('hidden');
    await b.run('openSettingsModal()');
    assert.equal(b.get('settings-modal').classList.contains('hidden'), true);
    assert.match(b.alerts.at(-1), /Network down/);
});

test('the QR code is made without a request to an outside service', () => {
    const { b } = hostContext();
    b.context.window.location.href = 'https://scores.example/host.html';
    b.get('qr-modal-body').childElementCount = 0;
    b.get('qr-modal').classList.add('hidden');
    b.context.confirm = () => { throw new Error('No question expected'); };
    b.context.qrcode = () => ({ addData() {}, make() {}, createSvgTag: () => '<svg></svg>' });
    b.run('showQR("viewer")');
    assert.equal(b.get('qr-modal-body').children.length, 1);
    assert.doesNotMatch(b.get('qr-modal-body').children[0].src, /^https?:/);
    assert.equal(b.get('qr-modal').classList.contains('hidden'), false);
});

test('the QR code reports a missing generator and does not open an empty window', () => {
    const { b } = hostContext();
    b.context.window.location.href = 'https://scores.example/host.html';
    b.get('qr-modal-body').childElementCount = 0;
    b.get('qr-modal').classList.add('hidden');
    b.run('showQR("viewer")');
    assert.match(b.alerts.at(-1), /QR generator/);
    assert.equal(b.get('qr-modal').classList.contains('hidden'), true);
});

// The server sends and accepts the allow-add flag as a boolean.
test('host settings read and write the allow-add flag as a boolean', async () => {
    const saved = [];
    const { b } = hostContext({
        async getProperties() { return { viewer_password_configured: true, client_allow_add_participant: false }; },
        async updateProperties(code, update) { saved.push(update); return {}; },
    });
    await b.run('openSettingsModal()');
    assert.equal(b.get('setting-allow-add').checked, false);
    assert.equal(b.get('setting-viewer-public').checked, false);
    b.get('setting-allow-add').checked = true;
    b.get('setting-host-pw').value = '';
    b.get('setting-viewer-pw').value = '';
    await b.run('saveSettings()');
    assert.deepEqual(JSON.parse(JSON.stringify(saved)), [{ client_allow_add_participant: true }]);
    b.get('setting-allow-add').checked = false;
    await b.run('saveSettings()');
    assert.deepEqual(JSON.parse(JSON.stringify(saved.at(-1))), { client_allow_add_participant: false });
});

function hostSocket(b) {
    b.context.WSClient = class {
        constructor(code, session) { this.code = code; this.session = session; this.handlers = {}; this.stopped = false; globalThis.__host_ws = this; }
        on(type, fn) { this.handlers[type] = fn; }
        connect() {}
        disconnect() { this.stopped = true; }
    };
    b.storage.saveHostSession('token');
    b.run('_connectWS()');
    return b.run('wsClient');
}

test('the host page returns to the login screen when the socket rejects its session', () => {
    const { b } = hostContext();
    const socket = hostSocket(b);
    assert.deepEqual(Object.keys(socket.handlers).sort(), ['authenticated', 'distance_update', 'event_status', 'lane_reset_requested', 'lane_session_reset', 'refresh', 'result_update', 'session_rejected']);
    b.get('admin-screen').classList.remove('hidden');
    b.get('code-screen').classList.add('hidden');
    socket.handlers.session_rejected({ type: 'session_rejected' });
    assert.equal(socket.stopped, true);
    assert.equal(b.storage.getHostSession(), null);
    assert.equal(b.get('admin-screen').classList.contains('hidden'), true);
    assert.equal(b.get('code-screen').classList.contains('hidden'), false);
    assert.equal(b.get('code-input').value, 'HOST01');
    assert.equal(b.alerts.length, 1);
    assert.match(b.alerts[0], /session ended/);
});

test('the viewer follows live updates from the socket and keeps polling as a backup', async () => {
    const { b, calls, sockets, timers } = viewerContext();
    await b.run(`_enterViewer('ABC123', 'viewer-token')`);
    const [socket] = sockets;
    assert.equal(socket.code, 'ABC123');
    assert.equal(socket.session, 'viewer-token');
    assert.equal(socket.connected, true);
    assert.equal(timers.count(timer => timer.interval && timer.ms === 120000), 1);
    const before = calls.participants;
    for (let i = 0; i < 10; i++) socket.handlers.result_update({ type: 'result_update' });
    socket.handlers.event_status({ type: 'event_status' });
    socket.handlers.distance_update({ type: 'distance_update' });
    assert.equal(timers.count(timer => !timer.interval && timer.ms === 500), 1);
    await timers.fire(timer => timer.ms === 500);
    assert.equal(calls.participants, before + 1);
});

test('the viewer closes the socket on exit and asks for a password when the session ends', async () => {
    let logins = 0;
    const { b, sockets, timers } = viewerContext({ async viewerLogin() { logins++; return { ok: true, session_id: 'again' }; } });
    await b.run(`_enterViewer('ABC123', 'viewer-token')`);
    const [socket] = sockets;
    await socket.handlers.session_rejected({ type: 'session_rejected' });
    assert.equal(socket.stopped, true);
    assert.equal(logins, 1);
    assert.equal(sockets.length, 2);
    b.run('exitViewer(true)');
    assert.equal(sockets[1].stopped, true);
    assert.equal(timers.pending.size, 0);
});

test('the host page follows the event and distance changes of another admin device', async () => {
    let events = 0, distances = 0;
    const { b, timers } = hostContext({
        async getEvent() { events++; return { status: 'started' }; },
        async getDistances() { distances++; return []; },
    });
    const socket = hostSocket(b);
    for (let i = 0; i < 5; i++) socket.handlers.event_status({ type: 'event_status', status: 'started' });
    socket.handlers.distance_update({ type: 'distance_update', distance_id: 1, status: 'active' });
    assert.equal(timers.count(timer => !timer.interval && timer.ms === 300), 1);
    await timers.fire(timer => timer.ms === 300);
    assert.equal(events, 1);
    assert.equal(distances, 1);
});

const tied = () => ({ male_recurve: [
    { id: 1, name: 'Plain', lane_shift: '1A', total_score: 27, ten_count: 2, x_count: 0, avg_score: 9, distance_scores: [] },
    { id: 2, name: 'More tens', lane_shift: '2A', total_score: 27, ten_count: 3, x_count: 0, avg_score: 9, distance_scores: [] },
    { id: 3, name: 'Same as plain', lane_shift: '3A', total_score: 27, ten_count: 2, x_count: 0, avg_score: 9, distance_scores: [] },
    { id: 4, name: 'More X', lane_shift: '4A', total_score: 27, ten_count: 2, x_count: 1, avg_score: 9, distance_scores: [] },
] });

test('the viewer ranks equal points by 10s, then by X, and shows shared ranks', () => {
    const { b } = viewerContext();
    b.run(`eventObj = { status: 'started' }; distancesInfo = [];`);
    b.context.grouped = tied();
    b.run('renderLeaderboard(grouped)');
    const rows = [];
    const walk = element => { if (/leaderboard-row/.test(element.className)) rows.push(element); element.children.forEach(walk); };
    walk(b.get('leaderboard'));
    const read = row => [/lb-rank">(\d*)</.exec(row.innerHTML)[1], /lb-name">([^<]*)/.exec(row.innerHTML)[1].trim()];
    assert.deepEqual(rows.map(read), [['1', 'More tens'], ['2', 'More X'], ['3', 'Plain'], ['3', 'Same as plain']]);
    assert.equal(rows[2].classList.contains('top-3'), true);
});

test('the host results rank equal points by 10s, then by X, and show shared ranks', () => {
    const { b } = hostContext();
    b.context.grouped = tied();
    b.run('renderResults(grouped)');
    const html = b.get('results-container').innerHTML;
    const ranks = [...html.matchAll(/result-rank rank-(\d+)">(\d+)<\/span><\/td>\s*<td><strong>([^<]*)/g)].map(m => [m[2], m[3]]);
    assert.deepEqual(ranks, [['1', 'More tens'], ['2', 'More X'], ['3', 'Plain'], ['3', 'Same as plain']]);
});

test('the host export uses the same ranking', async () => {
    let blob;
    const { b } = hostContext({
        async getParticipants() { return tied().male_recurve.map(e => ({ id: e.id, name: e.name, lane_number: e.id, shift: 'A' })); },
        async getLeaderboard() { return tied(); },
    });
    b.context.URL = { createObjectURL: value => { blob = value; return 'blob:x'; }, revokeObjectURL() {} };
    await b.run('exportCSV()');
    const lines = (await blob.text()).replace('\uFEFF', '').trim().split('\n').slice(1);
    const rankOf = name => lines.find(line => line.includes(`"${name}"`)).split(',')[0];
    assert.deepEqual(['More tens', 'More X', 'Plain', 'Same as plain'].map(rankOf), ['1', '2', '3', '3']);
});

test('the host sees the lane password next to the lane, and only for lanes that have one', () => {
    const { b } = hostContext();
    b.run(`currentEventData = { status: 'created' };`);
    b.context.people = [{ id: 1, name: 'Anna', lane_number: 1, shift: 'A' }];
    b.run('renderParticipants(people, [1, 3], { 1: "ABC123" })');
    const html = b.get('participants-container').innerHTML;
    const lane1 = html.slice(html.indexOf('Lane 1'), html.indexOf('Lane 3'));
    const lane3 = html.slice(html.indexOf('Lane 3'));
    assert.match(lane1, /class="lane-password"[^>]*>ABC123</);
    assert.doesNotMatch(lane3, /lane-password/);
    b.run('renderParticipants(people, [1], undefined)');
    assert.doesNotMatch(b.get('participants-container').innerHTML, /lane-password/);
});

test('the host page text for a lane password cannot run code', () => {
    const { b } = hostContext();
    b.run(`currentEventData = { status: 'created' };`);
    b.context.people = [{ id: 1, name: 'Anna', lane_number: 1, shift: 'A' }];
    b.run('renderParticipants(people, [1], { 1: "<img src=x onerror=alert(1)>" })');
    assert.doesNotMatch(b.get('participants-container').innerHTML, /<img/);
});

test('the host loads the lane passwords with the lanes', async () => {
    const { b } = hostContext({
        async getParticipants() { return [{ id: 1, name: 'Anna', lane_number: 2, shift: 'A' }]; },
        async listLaneSessions() { return { lanes: [2], passwords: { 2: 'ZXCV12' } }; },
    });
    await b.run('loadParticipants()');
    assert.match(b.get('participants-container').innerHTML, /class="lane-password"[^>]*>ZXCV12</);
});

// Run each action that the host templates write, the way the browser would.
function templateActions(html) {
    const found = [];
    for (const tag of html.matchAll(/<(button|input|span|div)\b[^>]*>/g)) {
        const text = tag[0];
        const data = Object.fromEntries([...text.matchAll(/data-([a-z-]+)="([^"]*)"/g)].map(match => [match[1], match[2].replace(/&quot;/g, '"')]));
        for (const kind of ['click', 'dblclick', 'blur', 'enter', 'change', 'submit', 'backdrop']) if (data[kind]) found.push({ kind, name: data[kind], data });
    }
    return found;
}

test('every action that the host templates write runs without an error', async () => {
    const errors = [];
    const { b } = hostContext({
        async getParticipants() { return [{ id: 1, name: 'Anna', lane_number: 1, shift: 'A' }]; },
        async updateDistance() { return {}; },
        async deleteDistance() { return {}; },
        async deleteParticipant() { return {}; },
        async resetLaneSession() { return {}; },
    });
    b.context.console.error = (...args) => errors.push(args);
    b.context.confirm = () => true;
    b.run(`currentEventData = { status: 'started' };
        currentDistances = [
            { id: 1, title: 'Pending', status: 'pending', shots_count: 6 },
            { id: 2, title: 'Active', status: 'active', shots_count: 6 },
            { id: 3, title: 'Other', status: 'pending', shots_count: 6 },
        ];
        renderDistances();`);
    const distances = templateActions(b.get('distances-list').innerHTML);
    b.run(`currentEventData = { status: 'created' }; renderParticipants([{ id: 1, name: 'Anna', lane_number: 1, shift: 'A' }], [1], { 1: 'ABC123' });`);
    const people = templateActions(b.get('participants-container').innerHTML);
    const all = [...distances, ...people];
    assert.ok(all.length >= 10, 'The templates write actions');
    assert.deepEqual([...new Set(all.map(item => item.kind))].sort(), ['blur', 'click', 'dblclick', 'enter']);
    for (const { name, data } of all) {
        let blurred = false;
        const element = { dataset: { args: data.args }, value: 'New title', blur() { blurred = true; } };
        b.context.__element = element;
        b.run(`_runAction(${JSON.stringify(name)}, __element, { target: __element })`);
        if (name === 'blurElement') assert.equal(blurred, true, 'Enter takes the focus away');
    }
    await tick();
    assert.deepEqual(errors, []);
});

test('the viewer shows the real reason when the password check does not run', async () => {
    const reasons = [
        [401, 'Invalid viewer password', /Invalid password/],
        [429, 'Too many failed login attempts. Try again later. Wait 15 minutes.', /Wait 15 minutes/],
        [0, 'The request timed out. Try again.', /timed out/],
    ];
    for (const [status, message, expected] of reasons) {
        const { b } = viewerContext({ async viewerLogin() { const error = new Error(message); error.status = status; throw error; } });
        b.run(`_pendingCode = 'ABC123'`);
        await b.run('submitViewerPassword()');
        assert.match(b.get('viewer-pw-error').textContent, expected, String(status));
        assert.equal(b.get('viewer-pw-error').classList.contains('hidden'), false);
    }
});

test('the lane password has a double click action with the password as its argument', () => {
    const { b } = hostContext();
    b.run(`currentEventData = { status: 'created' };`);
    b.context.people = [{ id: 1, name: 'Anna', lane_number: 1, shift: 'A' }];
    b.run('renderParticipants(people, [1], { 1: "ABC123" })');
    const tag = /<span class="lane-password"[^>]*>/.exec(b.get('participants-container').innerHTML)[0];
    assert.match(tag, /data-dblclick="copyLanePassword"/);
    assert.match(tag, /title="Double-click to copy"/);
    const args = /data-args="([^"]*)"/.exec(tag)[1].replace(/&quot;/g, '"');
    assert.deepEqual(JSON.parse(args), ['ABC123']);
});

function clipboardContext({ clipboard = true, execCommand = true } = {}) {
    const { b, timers } = hostContext();
    const copied = [];
    b.context.window.isSecureContext = clipboard;
    b.context.navigator = clipboard ? { clipboard: { writeText: async text => { copied.push(text); } } } : {};
    b.context.document.execCommand = command => { copied.push(`exec:${command}`); return execCommand; };
    return { b, timers, copied };
}

test('a double click copies the lane password and shows that it was copied', async () => {
    const { b, timers, copied } = clipboardContext();
    const element = { textContent: 'ABC123' };
    b.context.__el = element;
    b.run('copyLanePassword("ABC123", __el)');
    await tick();
    assert.deepEqual(copied, ['ABC123']);
    assert.equal(element.textContent, '✓ Copied');
    await timers.fire(timer => timer.ms === 1500);
    assert.equal(element.textContent, 'ABC123');
});

test('the lane password is copied without the clipboard interface too', async () => {
    const { b, timers, copied } = clipboardContext({ clipboard: false });
    const element = { textContent: 'XYZ789' };
    b.context.__el = element;
    b.run('copyLanePassword("XYZ789", __el)');
    await tick();
    assert.deepEqual(copied, ['exec:copy']);
    assert.equal(element.textContent, '✓ Copied');
    await timers.fire(timer => timer.ms === 1500);
    assert.equal(element.textContent, 'XYZ789');
});

test('a failed copy tells the user to copy by hand and keeps the password on screen', async () => {
    const { b } = clipboardContext({ clipboard: false, execCommand: false });
    const element = { textContent: 'XYZ789' };
    b.context.__el = element;
    b.run('copyLanePassword("XYZ789", __el)');
    await tick();
    assert.equal(element.textContent, 'XYZ789');
    assert.match(b.alerts.at(-1), /copy it by hand/i);
});

test('two quick double clicks do not leave the label wrong', async () => {
    const { b, timers } = clipboardContext();
    const element = { textContent: 'ABC123' };
    b.context.__el = element;
    b.run('copyLanePassword("ABC123", __el)');
    await tick();
    b.run('copyLanePassword("ABC123", __el)');
    await tick();
    await timers.fire(timer => timer.ms === 1500);
    assert.equal(element.textContent, 'ABC123');
});

// ── The switch for the automatic scroll of the viewer page ──────────────────
function scrollContext(overrides = {}) {
    const ctx = viewerContext(overrides);
    const scrolls = [];
    ctx.b.context.window.scrollY = 0;
    ctx.b.context.window.scrollTo = (x, y) => { scrolls.push(y); ctx.b.context.window.scrollY = y; };
    ctx.b.context.document.documentElement.scrollHeight = 5000;
    ctx.b.context.window.innerHeight = 1000;
    return { ...ctx, scrolls, scrollTimers: () => ctx.timers.count(timer => timer.interval && timer.ms < 100) };
}
const switchState = b => [b.get('autoscroll-toggle').getAttribute?.('aria-checked') ?? b.get('autoscroll-toggle').attributes?.['aria-checked'], b.get('autoscroll-toggle').classList.contains('is-on')];

test('the viewer page scrolls by itself at the start, and the switch shows it', async () => {
    const { b, timers, scrolls, scrollTimers } = scrollContext();
    await b.run(`_enterViewer('ABC123', 'token')`);
    assert.equal(scrollTimers(), 1);
    assert.deepEqual(switchState(b), ['true', true]);
    await timers.fire(timer => timer.interval && timer.ms < 100);
    assert.ok(scrolls.length >= 1 && scrolls[0] > 0);
});

test('the switch turns the automatic scroll off, so that the user can scroll by hand', async () => {
    const { b, timers, scrolls, scrollTimers } = scrollContext();
    await b.run(`_enterViewer('ABC123', 'token')`);
    b.run('toggleAutoScroll()');
    assert.equal(scrollTimers(), 0);
    assert.deepEqual(switchState(b), ['false', false]);
    assert.equal(b.storage.getViewerAutoScroll(), false);
    const before = scrolls.length;
    b.context.window.scrollY = 1234; // The user scrolls to a position.
    await timers.fire(timer => timer.interval && timer.ms < 100);
    assert.equal(scrolls.length, before, 'The page does not move the scroll position');
    assert.equal(b.context.window.scrollY, 1234);
});

test('the switch turns the scroll on again, and it continues from the position of the user', async () => {
    const { b, timers, scrolls, scrollTimers } = scrollContext();
    await b.run(`_enterViewer('ABC123', 'token')`);
    b.run('toggleAutoScroll()');
    b.context.window.scrollY = 1200;
    b.run('toggleAutoScroll()');
    assert.equal(scrollTimers(), 1);
    assert.deepEqual(switchState(b), ['true', true]);
    assert.equal(b.storage.getViewerAutoScroll(), true);
    await timers.fire(timer => timer.interval && timer.ms < 100);
    assert.ok(Math.abs(scrolls.at(-1) - 1200.5) < 1, `The scroll continued at ${scrolls.at(-1)}`);
});

test('quick switching never leaves two scroll timers', async () => {
    const { b, scrollTimers } = scrollContext();
    await b.run(`_enterViewer('ABC123', 'token')`);
    for (let i = 0; i < 7; i++) b.run('toggleAutoScroll()');
    assert.equal(scrollTimers(), 0);
    b.run('toggleAutoScroll()');
    assert.equal(scrollTimers(), 1);
});

test('a page that opens with the scroll turned off does not scroll, and the switch shows it', async () => {
    const { b, scrolls, scrollTimers, timers } = scrollContext();
    b.storage.saveViewerAutoScroll(false);
    await b.run(`_enterViewer('ABC123', 'token')`);
    assert.equal(scrollTimers(), 0);
    assert.deepEqual(switchState(b), ['false', false]);
    await timers.fire(timer => timer.interval && timer.ms < 100);
    assert.deepEqual(scrolls, []);
});

test('the switch keeps its state when the viewer leaves and enters again', async () => {
    const { b, scrollTimers } = scrollContext();
    await b.run(`_enterViewer('ABC123', 'token')`);
    b.run('toggleAutoScroll()');
    b.run('exitViewer(true)');
    assert.equal(scrollTimers(), 0);
    await b.run(`_enterViewer('ABC123', 'token')`);
    assert.equal(scrollTimers(), 0);
    assert.deepEqual(switchState(b), ['false', false]);
    b.run('toggleAutoScroll()');
    assert.equal(scrollTimers(), 1);
});

test('the switch works without a login, and it only saves the choice', () => {
    const { b, scrollTimers } = scrollContext();
    b.run('toggleAutoScroll()');
    assert.equal(b.storage.getViewerAutoScroll(), false);
    b.run('toggleAutoScroll()');
    assert.equal(b.storage.getViewerAutoScroll(), true);
    assert.equal(scrollTimers(), 0);
});

test('a damaged saved choice means that the scroll is on', async () => {
    const { b, scrollTimers } = scrollContext();
    b.values.set('viewer_autoscroll', '{broken');
    assert.equal(b.storage.getViewerAutoScroll(), true);
    b.values.set('viewer_autoscroll', '"no"');
    assert.equal(b.storage.getViewerAutoScroll(), true);
    await b.run(`_enterViewer('ABC123', 'token')`);
    assert.equal(scrollTimers(), 1);
});

test('the viewer page has the switch with the right attributes', () => {
    const fs = require('node:fs');
    const html = fs.readFileSync(require('node:path').join(__dirname, '../viewer.html'), 'utf8');
    const tag = /<button[^>]*id="autoscroll-toggle"[^>]*>/.exec(html)?.[0];
    assert.ok(tag, 'the page has the switch');
    assert.match(tag, /role="switch"/);
    assert.match(tag, /aria-checked="true"/);
    assert.match(tag, /data-click="toggleAutoScroll"/);
    assert.ok(html.indexOf('id="autoscroll-toggle"') > html.indexOf('id="results-screen"'), 'the switch is on the leaderboard screen');
});

// A double tap on "Enter" starts two entries at the same time.
test('viewer entering twice at the same time keeps one live socket and one refresh timer', async () => {
    const gate = deferred();
    const { b, sockets, timers } = viewerContext({
        async getEvent() { await gate.promise; return { status: 'created' }; },
    });
    const first = b.run(`_enterViewer('ABC123', 'token')`);
    const second = b.run(`_enterViewer('ABC123', 'token')`);
    gate.resolve();
    await Promise.all([first, second]);
    assert.equal(sockets.filter(socket => !socket.stopped).length, 1);
    assert.equal(timers.count(timer => timer.interval && timer.ms === 2 * 60 * 1000), 1);
    b.run('exitViewer(true)');
    assert.equal(sockets.filter(socket => !socket.stopped).length, 0);
    assert.equal(timers.pending.size, 0);
});

// A second tap during the "Copied" message must not keep the message on the badge.
test('a fast second tap on the event code badge shows the code again after the message', async () => {
    const { b, timers } = hostContext();
    b.get('event-code-display').textContent = 'Code: HOST01';
    b.run(`copyToClipboard('HOST01', 'event-code-display', 'Code copied!')`);
    b.run(`copyToClipboard('HOST01', 'event-code-display', 'Code copied!')`);
    assert.equal(b.get('event-code-display').textContent, '✓ Code copied!');
    await timers.fire();
    assert.equal(b.get('event-code-display').textContent, 'Code: HOST01');
});

test('a fast second click on a copy link button shows the label again after the message', async () => {
    const { b, timers } = hostContext();
    b.context.window.location.href = 'https://scores.example/host.html';
    b.get('btn-copy-viewer').textContent = 'Copy viewer link';
    b.run(`copyLink('viewer')`);
    b.run(`copyLink('viewer')`);
    assert.equal(b.get('btn-copy-viewer').textContent, '✓ Copied!');
    await timers.fire();
    assert.equal(b.get('btn-copy-viewer').textContent, 'Copy viewer link');
    assert.equal(b.get('btn-copy-viewer').classList.contains('copied'), false);
});
