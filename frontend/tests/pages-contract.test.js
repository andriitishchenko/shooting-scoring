// Contract tests: every API method, and the host and viewer pages, against the real Node server.
const assert = require('node:assert/strict');
const test = require('node:test');
const { wait, waitFor, stack } = require('./stack');

const plain = value => JSON.parse(JSON.stringify(value));
const unwrap = async promise => plain(await promise);
const textOf = element => [element.textContent, element.innerHTML, ...element.children.map(textOf)].join(' ');

test('every API method works against the Node server', async t => {
    const s = await stack(t);
    const b = s.makePage(['api.js']);
    b.run(`globalThis.__called = new Set();
        for (const name of Object.getOwnPropertyNames(APIClient.prototype)) {
            if (name === 'constructor' || name === 'request' || name.startsWith('_')) continue;
            const original = api[name];
            api[name] = function (...args) { __called.add(name); return original.apply(this, args); };
        }`);
    const api = expression => unwrap(b.run(`api.${expression}`));
    const code = 'APIC01';

    const created = await api(`createEvent('${code}', 6)`);
    assert.deepEqual(Object.keys(created).sort(), ['code', 'host_password', 'message', 'session_id']);
    b.storage.saveHostSession(created.session_id);

    assert.deepEqual(await api(`getEvent('${code}')`), {
        code, shots_count: 6, status: 'created', created_at: (await api(`getEvent('${code}')`)).created_at, started_at: null, finished_at: null,
    });
    assert.equal((await api(`updateEvent('${code}', { shots_count: 6 })`)).message, 'Event updated');

    const first = (await api(`getDistances('${code}')`))[0];
    assert.deepEqual(Object.keys(first).sort(), ['id', 'shots_count', 'sort_order', 'status', 'title']);
    const extra = await api(`addDistance('${code}', { title: 'Second', shots_count: 6 })`);
    assert.equal((await api(`updateDistance('${code}', ${extra.id}, { title: 'Renamed' })`)).title, 'Renamed');
    assert.equal((await api(`deleteDistance('${code}', ${extra.id})`)).message, 'Distance deleted');

    const added = await api(`addParticipant('${code}', { name: 'Anna', lane_number: 1, shift: 'A' })`);
    assert.equal(typeof added.id, 'number');
    assert.equal((await api(`getParticipants('${code}')`)).length, 1);
    assert.equal((await api(`getParticipants('${code}', 1)`)).length, 1);
    assert.equal((await api(`getParticipants('${code}', 2)`)).length, 0);
    await api(`updateParticipant('${code}', ${added.id}, { name: 'Anna B', lane_number: 1, shift: 'A' })`);
    assert.equal((await api(`getParticipants('${code}', 1)`))[0].name, 'Anna B');
    const imported = await api(`importParticipantsCSV('${code}', 'name,lane,shift\\nBob,2,B\\n')`);
    assert.deepEqual(imported, { added: 1, failed: 0, errors: [] });
    const bob = (await api(`getParticipants('${code}', 2)`))[0];
    assert.equal((await api(`deleteParticipant('${code}', ${bob.id})`)).message, 'Participant deleted');

    const properties = await api(`getProperties('${code}')`);
    assert.equal(properties.host_password_configured, true);
    assert.equal(properties.client_allow_add_participant, true);
    await api(`updateProperties('${code}', { client_allow_add_participant: false })`);
    assert.deepEqual(await api(`getPublicProperties('${code}')`), { client_allow_add_participant: false, lane_count: 28 });
    await api(`updateProperties('${code}', { client_allow_add_participant: true })`);

    const hostLogin = await api(`hostLogin('${code}', '${created.host_password}')`);
    assert.equal(hostLogin.ok, true);
    assert.notEqual(hostLogin.session_id, created.session_id);
    // A second login does not end the first session.
    assert.equal((await api(`updateEvent('${code}', { shots_count: 6 })`)).message, 'Event updated');
    b.storage.saveHostSession(hostLogin.session_id);
    assert.equal((await api(`viewerLogin('${code}', '')`)).ok, true);
    const lane = await api(`laneLogin('${code}', 1)`);
    assert.equal(lane.status, 'created');
    assert.equal((await api(`laneLogin('${code}', 1, '${lane.session_id}')`)).status, 'ok');
    assert.deepEqual((await api(`listLaneSessions('${code}')`)).lanes, [1]);
    // A lane that lost its password asks for a reset. The host decides.
    const asked = await api(`requestLaneReset('${code}', 1)`);
    assert.equal(asked.status, 'pending');
    assert.deepEqual(await api(`laneResetStatus('${code}', 1, '${asked.request_id}')`), { status: 'pending' });
    assert.deepEqual(Object.keys((await api(`listLaneSessions('${code}')`)).requests), ['1']);
    assert.equal((await api(`denyLaneReset('${code}', 1)`)).message, 'Reset of lane 1 denied');
    assert.deepEqual(await api(`laneResetStatus('${code}', 1, '${asked.request_id}')`), { status: 'denied' });
    const again = await api(`requestLaneReset('${code}', 1)`);
    assert.equal((await api(`approveLaneReset('${code}', 1)`)).message, 'Reset of lane 1 approved');
    const granted = await api(`laneResetStatus('${code}', 1, '${again.request_id}')`);
    assert.equal(granted.status, 'approved');
    assert.match(granted.password, /^[A-Z0-9]{6}$/);
    lane.session_id = granted.session_id;

    await api(`updateEvent('${code}', { status: 'started' })`);
    await api(`updateDistance('${code}', ${first.id}, { status: 'active' })`);
    await api(`saveResults('${code}', [{ participant_id: ${added.id}, distance_id: ${first.id}, shot_number: 1, score: 10, is_x: true }], '${lane.session_id}')`);
    const replaced = await api(`replaceDistanceResults('${code}', ${added.id}, ${first.id}, [{ shot_number: 1, score: 9, is_x: false }, { shot_number: 2, score: 8, is_x: false }], '${lane.session_id}')`);
    assert.equal(replaced.count, 2);

    const state = await api(`getParticipantState('${code}', ${added.id})`);
    assert.deepEqual(state.distances[0].shots.map(shot => [shot.shot, shot.score, shot.is_x]), [[1, 9, false], [2, 8, false]]);
    assert.equal(state.distances[0].total_score, 17);
    const detail = await api(`getDistanceDetail('${code}', ${added.id}, ${first.id})`);
    assert.equal(detail.total_score, 17);
    assert.deepEqual(detail.series[0].shots.map(shot => shot.score), [9, 8, null]);
    const board = await api(`getLeaderboard('${code}')`);
    const entry = board.unknown_unknown[0];
    assert.equal(entry.name, 'Anna B');
    assert.equal(entry.lane_shift, '1A');
    assert.equal(entry.total_score, 17);
    assert.equal(entry.distance_scores[0].shots_taken, 2);

    assert.equal((await api(`deleteParticipantResults('${code}', ${added.id})`)).message, 'Results deleted');
    assert.equal((await api(`resetLaneSession('${code}', 1)`)).message, 'Session for lane 1 reset');

    const methods = b.run(`Object.getOwnPropertyNames(APIClient.prototype).filter(name => name !== 'constructor' && name !== 'request' && !name.startsWith('_')).sort()`);
    assert.deepEqual([...b.run('__called')].sort(), plain(methods));
});

test('host page runs a full competition against the Node server', async t => {
    const s = await stack(t);
    const b = s.makeHost();
    const host = b.context;
    host.window.prompt = () => '7';
    b.get('code-input').value = 'HOST01';
    b.get('password-input').value = '';
    await b.run('hostEnter()');
    assert.equal(b.storage.getEventCode('host'), 'HOST01');
    assert.ok(b.storage.getHostSession());
    assert.match(b.storage.getHostPassword(), /^[A-Z0-9]{16}$/);

    await waitFor(() => b.run('currentEventData?.status') === 'created', 'event loaded');
    const hostSession = b.storage.getHostSession();
    const call = (method, url, data) => fetch(s.base + url, {
        method, headers: { 'Content-Type': 'application/json', 'X-Session-Id': hostSession }, body: data && JSON.stringify(data),
    }).then(response => response.json());

    b.get('p-name').value = 'Anna';
    b.get('p-lane').value = '1';
    b.get('p-shift').value = 'a';
    await b.run('submitParticipant({ preventDefault() {} })');
    assert.equal(b.alerts.at(-1), 'Participant added!');
    await waitFor(() => /Anna/.test(b.get('participants-container').innerHTML), 'participant rendered');

    const csv = 'name,lane,shift\nBob,2,B\n';
    await b.run(`importCSV({ target: { files: [{ text: async () => ${JSON.stringify(csv)} }], value: 'x' } })`);
    assert.match(b.alerts.at(-1), /Added: 1/);
    assert.match(b.get('participants-container').innerHTML, /Bob/);

    await b.run('startEvent()');
    assert.equal(b.run('currentEventData.status'), 'started');
    await b.run('loadDistances()');
    const distanceId = b.run('currentDistances[0].id');
    await b.run(`startDistance(${distanceId})`);
    assert.equal(b.run('currentDistances[0].status'), 'active');

    const participants = await (await fetch(`${s.base}/api/participants/HOST01`)).json();
    const anna = participants.find(p => p.name === 'Anna').id;
    await call('PUT', `/api/results/HOST01/participant/${anna}/distance/${distanceId}`, {
        shots: [{ shot_number: 1, score: 10, is_x: true }, { shot_number: 2, score: 9, is_x: false }],
    });
    await b.run('loadResults()');
    const results = b.get('results-container').innerHTML;
    assert.match(results, /Anna/);
    assert.match(results, /Bob/);
    assert.match(results, /class="result-score">19</);
    assert.match(results, /X\(1\) 10\(1\)/);

    await b.run(`openDetailModal(${anna}, ${distanceId}, 'Anna')`);
    assert.match(b.get('detail-modal-body').innerHTML, /data-edit-shot="2"/);
    assert.match(b.get('detail-modal-subtitle').innerHTML, /Total: <strong>19<\/strong>/);
    await b.run('editDetailShot(2)');
    assert.equal(b.alerts.filter(text => /Could not update/.test(text)).length, 0);
    const state = await (await fetch(`${s.base}/api/results/HOST01/state/${anna}`)).json();
    assert.deepEqual(state.distances[0].shots.map(shot => shot.score), [10, 7]);

    await b.run('openSettingsModal()');
    assert.equal(b.get('setting-allow-add').checked, true);
    b.get('setting-allow-add').checked = false;
    b.get('setting-viewer-public').checked = true;
    await b.run('saveSettings()');
    assert.equal(b.alerts.at(-1), 'Settings saved!');
    assert.deepEqual(await (await fetch(`${s.base}/api/properties/HOST01/public`)).json(), { client_allow_add_participant: false, lane_count: 28 });

    await fetch(`${s.base}/api/sessions/HOST01/lane/1`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    await b.run('loadParticipants()');
    assert.match(b.get('participants-container').innerHTML, /lane-session-active/);
    await b.run('resetLaneSession(1)');
    assert.match(b.alerts.at(-1), /has been reset/);

    await b.run('exportCSV()');
    assert.equal(b.alerts.filter(text => /Export error/.test(text)).length, 0);

    await b.run('finishEvent()');
    assert.equal(b.alerts.at(-1), 'Competition finished!');
    assert.equal(b.run('currentEventData.status'), 'finished');
    await b.run('loadDistances()');
    assert.equal(b.run('currentDistances[0].status'), 'finished');
});

test('viewer page shows the roster, then the leaderboard, and supports a password', async t => {
    const s = await stack(t);
    const b = s.makeViewer();
    b.get('code-input').value = 'cntr01';
    await b.run('viewerEnter()');
    assert.equal(b.run('currentCode'), 'CNTR01');
    assert.equal(b.get('results-screen').classList.contains('hidden'), false);
    assert.match(textOf(b.get('leaderboard')), /Pre-Competition[\s\S]*Lane 1[\s\S]*Archer/);

    await s.start();
    await s.call('PUT', `/api/results/CNTR01/participant/${s.participant}/distance/${s.distance}`, {
        shots: [{ shot_number: 1, score: 10, is_x: true }, { shot_number: 2, score: 8, is_x: false }],
    }, s.host);
    await b.run('_loadAndRender()');
    const html = textOf(b.get('leaderboard'));
    assert.match(html, /Archer/);
    assert.match(html, /class="lb-score">18/);
    assert.match(html, /X1/);

    await s.call('PATCH', '/api/properties/CNTR01', { viewer_password: 'viewer-password-1' }, s.host);
    b.run('exitViewer(true)');
    b.get('code-input').value = 'CNTR01';
    await b.run('viewerEnter()');
    assert.equal(b.get('viewer-pw-screen').classList.contains('hidden'), false);
    b.get('viewer-pw-input').value = 'wrong';
    await b.run('submitViewerPassword()');
    assert.equal(b.get('viewer-pw-error').classList.contains('hidden'), false);
    b.get('viewer-pw-input').value = 'viewer-password-1';
    await b.run('submitViewerPassword()');
    assert.equal(b.get('results-screen').classList.contains('hidden'), false);
    assert.ok(b.storage.getViewerSession());
    await wait(10);
});

test('the host page makes a real QR code with the library that the server provides', async t => {
    const s = await stack(t);
    const b = s.makeHost();
    const response = await fetch(`${s.base}/vendor/qrcode.js`);
    assert.equal(response.status, 200);
    b.context.window.location.href = 'http://scores.test/host.html';
    b.context.eval = undefined;
    require('node:vm').runInContext(await response.text(), b.context);
    b.get('qr-modal-body').childElementCount = 0;
    b.run(`currentCode = 'QRCODE'; showQR('viewer')`);
    const image = b.get('qr-modal-body').children[0];
    assert.match(image.src, /^data:image\/svg\+xml;charset=utf-8,/);
    const svg = decodeURIComponent(image.src.split(',')[1]);
    assert.match(svg, /^<svg [^>]*viewBox="0 0 \d+ \d+"/);
    assert.match(svg, /<path d="M\d+,\d+l/);
    assert.equal(b.alerts.length, 0);
});

test('the viewer page updates by itself when a score changes on the server', async t => {
    const s = await stack(t);
    const b = s.makeViewer();
    b.get('code-input').value = 'CNTR01';
    await b.run('viewerEnter()');
    await s.start();
    await waitFor(() => b.run('socket?.authenticated'), 'viewer socket authenticated');
    await s.call('PUT', `/api/results/CNTR01/participant/${s.participant}/distance/${s.distance}`, {
        shots: [{ shot_number: 1, score: 10, is_x: true }, { shot_number: 2, score: 9 }],
    }, s.host);
    await waitFor(() => /class="lb-score">19/.test(textOf(b.get('leaderboard'))), 'leaderboard shows 19');
    await s.call('PUT', `/api/results/CNTR01/participant/${s.participant}/distance/${s.distance}`, {
        shots: [{ shot_number: 1, score: 10, is_x: true }, { shot_number: 2, score: 9 }, { shot_number: 3, score: 8 }],
    }, s.host);
    await waitFor(() => /class="lb-score">27/.test(textOf(b.get('leaderboard'))), 'leaderboard shows 27');
});

test('the viewer page asks for the password again when the host changes it', async t => {
    const s = await stack(t);
    const b = s.makeViewer();
    b.get('code-input').value = 'CNTR01';
    await b.run('viewerEnter()');
    await waitFor(() => b.run('socket?.authenticated'), 'viewer socket authenticated');
    await s.call('PATCH', '/api/properties/CNTR01', { viewer_password: 'a-new-viewer-password' }, s.host);
    await waitFor(() => b.get('viewer-pw-screen').classList.contains('hidden') === false, 'password screen shown');
    assert.equal(b.get('results-screen').classList.contains('hidden'), true);
    b.get('viewer-pw-input').value = 'a-new-viewer-password';
    await b.run('submitViewerPassword()');
    assert.equal(b.get('results-screen').classList.contains('hidden'), false);
});

test('the host page returns to the login screen when another device changes the password', async t => {
    const s = await stack(t);
    const b = s.makeHost();
    b.get('code-input').value = 'CNTR01';
    b.get('password-input').value = s.hostPassword;
    await b.run('hostEnter()');
    await waitFor(() => b.run('wsClient?.authenticated'), 'host socket authenticated');
    const other = (await s.call('POST', '/api/sessions/CNTR01/host', { password: s.hostPassword })).data.session_id;
    await s.call('PATCH', '/api/properties/CNTR01', { host_password: 'another-host-password' }, other);
    await waitFor(() => b.alerts.some(text => /session ended/.test(text)), 'session ended alert');
    assert.equal(b.get('code-screen').classList.contains('hidden'), false);
    assert.equal(b.get('admin-screen').classList.contains('hidden'), true);
    assert.equal(b.storage.getHostSession(), null);
});

test('a login lock shows how long to wait', async t => {
    const s = await stack(t);
    const b = s.makePage(['api.js']);
    const attempt = () => b.run(`api.hostLogin('CNTR01', 'wrong-password')`).then(() => null, error => error);
    for (let i = 0; i < 10; i++) assert.equal((await attempt()).status, 401);
    const locked = await attempt();
    assert.equal(locked.status, 429);
    assert.match(locked.message, /Too many failed login attempts\. Try again later\. Wait 15 minutes\.$/);
});

test('the host page shows the password that a lane received', async t => {
    const s = await stack(t);
    const b = s.makeHost();
    b.get('code-input').value = 'CNTR01';
    b.get('password-input').value = s.hostPassword;
    await b.run('hostEnter()');
    const lane = (await s.call('POST', '/api/sessions/CNTR01/lane/1', {})).data;
    await b.run('loadParticipants()');
    await waitFor(() => new RegExp(`class="lane-password"[^>]*>${lane.password}<`).test(b.get('participants-container').innerHTML), 'lane password shown');
});
