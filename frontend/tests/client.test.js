const assert = require('node:assert/strict');
const test = require('node:test');
const { browserContext, deferred, tick } = require('./helpers');
const plain = value => JSON.parse(JSON.stringify(value));

function clientContext() {
    const browser = browserContext();
    const data = {
        event: { status: 'started' },
        distances: [{ id: 7, title: '18m', status: 'active', shots_count: 3 }],
        participants: [{ id: 4, name: 'Archer', lane_number: 1, shift: 'A' }],
        state: { distances: [{ distance_id: 7, status: 'active', total_score: 9, shots: [{ shot: 1, score: 9, is_x: false }] }] },
        saves: [],
    };
    browser.context.api = {
        async getEvent() { return structuredClone(data.event); },
        async getDistances() { return structuredClone(data.distances); },
        async getPublicProperties() { return { client_allow_add_participant: true }; },
        async getParticipants() { return structuredClone(data.participants); },
        async getParticipantState() { return structuredClone(data.state); },
        async replaceDistanceResults(code, participantId, distanceId, shots) { data.saves.push({ code, participantId, distanceId, shots: plain(shots) }); },
    };
    browser.load('scoring.js');
    browser.load('client.js');
    browser.storage.saveLaneSession(1, 'lane-token');
    browser.storage.saveLane(1);
    browser.run(`
        currentCode = 'EVENT1'; currentLane = 1;
        currentParticipant = { id: 4, name: 'Archer' }; currentDistanceId = 7;
        eventData = { status: 'started' };
        distances = [{ id: 7, status: 'active', shots_count: 3 }];
        participants = [{ id: 4, name: 'Archer', lane_number: 1, shift: 'A' }];
        results = [{ participant_id: 4, distance_id: 7, shot: 1, score: 9, is_x: false }];
        _showScreen('score-screen');
    `);
    return { ...browser, data };
}

test('reconnect refresh keeps the active scoring screen open', async () => {
    const b = clientContext();
    await b.run('_reconcile()');
    assert.equal(b.visible(), 'score-screen');
    assert.equal(b.data.saves.length, 0);
    assert.equal(b.get('total-score').textContent, 9);
});

test('reconnect refresh saves and opens a newly active distance', async () => {
    const b = clientContext();
    b.data.distances = [{ id: 7, status: 'finished', shots_count: 3 }, { id: 8, status: 'active', shots_count: 3 }];
    b.data.state.distances[0].status = 'finished';
    b.data.state.distances[0].shots = [];
    b.data.state.distances.push({ distance_id: 8, status: 'active', total_score: null, shots: [] });
    await b.run('_reconcile()');
    assert.equal(b.data.saves[0].distanceId, 7);
    assert.equal(b.run('currentDistanceId'), 8);
    assert.equal(b.visible(), 'score-screen');
});

test('simultaneous finish events save once and show one alert', async () => {
    const b = clientContext();
    b.data.event.status = 'finished';
    b.data.distances[0].status = 'finished';
    await Promise.all([b.run('handleEventStatus()'), b.run('handleDistanceUpdate()'), b.run('_reconcile()')]);
    assert.equal(b.data.saves.length, 1);
    assert.equal(b.alerts.length, 1);
    assert.equal(b.visible(), 'participants-screen');
});

for (const screen of ['lane-password-screen', 'lane-auth-screen', 'add-participant-screen', 'lane-screen', 'code-screen']) {
    test(`automatic refresh keeps ${screen} open`, async () => {
        const b = clientContext();
        b.run(`_showScreen('${screen}')`);
        await b.run('_reconcile()');
        assert.equal(b.visible(), screen);
    });
}

test('pending sync is serialized with newer edits so stale shots cannot win', async () => {
    const b = clientContext();
    const hold = deferred();
    const sent = [];
    b.context.api.replaceDistanceResults = async (code, pid, did, shots) => {
        sent.push(plain(shots));
        if (sent.length === 1) await hold.promise;
    };
    b.storage.savePendingResults('EVENT1', 4, 7, 1, 'lane-token', [{ shot_number: 1, score: 9, is_x: false }]);
    const sync = b.run('_syncPendingResults()');
    await tick();
    b.run('results[0].score = 8');
    const save = b.run('_saveCurrentResults()');
    hold.resolve();
    await Promise.all([sync, save]);
    assert.deepEqual(sent.map(shots => shots[0].score), [9, 8]);
    assert.equal(b.storage.getPendingResult('EVENT1', 4, 7), null);
});

test('an offline-cleared series remains unscored instead of displaying zero', () => {
    const b = clientContext();
    b.storage.savePendingResults('EVENT1', 4, 7, 1, 'lane-token', []);
    const state = b.run(`_mergePendingResults(4, { distances: [{ distance_id: 7, total_score: 19, shots: [{ shot: 1, score: 10, is_x: true }] }] })`);
    assert.equal(state.distances[0].total_score, null);
    assert.deepEqual(plain(state.distances[0].shots), []);
});

test('old session scores are archived, excluded from sync, and reported to the user', async () => {
    const b = clientContext();
    b.storage.savePendingResults('EVENT1', 4, 7, 1, 'old-token', [{ shot_number: 1, score: 2, is_x: false }]);
    await b.run('_syncPendingResults()');
    assert.equal(b.data.saves.length, 0);
    assert.equal(b.storage.getPendingResult('EVENT1', 4, 7), null);
    const recovered = b.storage.getRecoveryResults();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].shots[0].score, 2);
    assert.equal('session_id' in recovered[0], false);
    assert.match(b.get('client-notice').textContent, /earlier lane session/);
    assert.equal(b.get('recovery-download').classList.contains('hidden'), false);
});

test('deletions replace the complete distance, including an empty distance', async () => {
    const b = clientContext();
    b.run(`results.push({ participant_id: 4, distance_id: 7, shot: 2, score: 10, is_x: true });`);
    await b.run('deleteLastScore()');
    await b.run('deleteLastScore()');
    assert.deepEqual(b.data.saves.map(save => save.shots.map(shot => shot.shot_number)), [[1], []]);
});

test('shot buttons show the shots as they are, and a cleared score is removed, the rest is ordered', async () => {
    const b = clientContext();
    b.run(`results = [8, 10, 9].map((score, index) => ({ participant_id: 4, distance_id: 7, shot: index + 1, score, is_x: false })); renderScoreGrid();`);
    const buttons = b.document.querySelectorAll('.shot-btn');
    assert.deepEqual(buttons.map(button => button.textContent), [8, 10, 9]);
    b.context.clicked = buttons[1];
    b.run('selectShot(1, 2, { currentTarget: clicked }); selectShot(1, 2, { currentTarget: clicked });');
    await tick();
    assert.deepEqual(plain(b.run('results.map(result => result.shot)')), [1, 2]);
    assert.deepEqual(b.data.saves[0].shots.map(shot => shot.score), [9, 8]);
});

test('a filled series can be corrected without changing another shot', async () => {
    const b = clientContext();
    b.run(`results = [8, 10, 9].map((score, index) => ({ participant_id: 4, distance_id: 7, shot: index + 1, score, is_x: false })); renderScoreGrid();`);
    b.context.clicked = b.document.querySelectorAll('.shot-btn')[1];
    b.run('selectShot(1, 2, { currentTarget: clicked }); inputScore(7);');
    await tick();
    assert.deepEqual(b.data.saves[0].shots.sort((a, b) => a.shot_number - b.shot_number).map(shot => shot.score), [9, 8, 7]);
});

// ── The shots of a series are ordered from the highest to the lowest ────────
function distanceOf(b, count) {
    b.run(`distances = [{ id: 7, status: 'active', shots_count: ${count} }]; results = []; _currentShot = null; _lastEntry = null; renderScoreGrid();`);
}
const shown = b => b.document.querySelectorAll('.shot-btn').map(button => String(button.textContent));

test('each series shows its shots from the highest to the lowest while the user enters them', async () => {
    const b = clientContext();
    distanceOf(b, 6);
    for (const [score, isX] of [[5, false], [9, false], [10, false], [0, false], [2, false], [5, false]]) b.run(`inputScore(${score}, ${isX})`);
    await tick();
    assert.deepEqual(shown(b), ['10', '9', '5', '5', '2', '0']);
    assert.deepEqual(plain(b.run('results.map(result => result.shot + ":" + result.score)')), ['1:10', '2:9', '3:5', '4:5', '5:2', '6:0']);
});

test('an X is shown before the 10s of its series', async () => {
    const b = clientContext();
    distanceOf(b, 3);
    b.run('inputScore(10, false); inputScore(10, false); inputScore(10, true);');
    await tick();
    assert.deepEqual(shown(b), ['X', '10', '10']);
});

test('the saved shots are in the same order as the shots on the screen', async () => {
    const b = clientContext();
    distanceOf(b, 3);
    b.run('inputScore(3); inputScore(8); inputScore(6);');
    await tick();
    const last = b.data.saves.at(-1);
    assert.deepEqual(last.shots.map(item => [item.shot_number, item.score]), [[1, 8], [2, 6], [3, 3]]);
});

test('a score that the user clears makes the next shots move up, so the series has no gap', async () => {
    const b = clientContext();
    distanceOf(b, 3);
    b.run('inputScore(9); inputScore(7); inputScore(5);');
    b.context.clicked = b.document.querySelectorAll('.shot-btn')[0];
    b.run('selectShot(1, 1, { currentTarget: clicked }); selectShot(1, 1, { currentTarget: clicked });');
    await tick();
    assert.deepEqual(plain(b.run('results.map(result => result.shot + ":" + result.score)')), ['1:7', '2:5']);
    assert.deepEqual(shown(b), ['7', '5', '']);
    b.run('inputScore(8)');
    assert.deepEqual(shown(b), ['8', '7', '5']);
});

test('the delete button removes the shot that the user entered last', async () => {
    const b = clientContext();
    distanceOf(b, 3);
    b.run('inputScore(9); inputScore(10);'); // The user meant 9 and then made a mistake with the 10.
    await b.run('deleteLastScore()');
    assert.deepEqual(plain(b.run('results.map(result => result.score)')), [9]);
    assert.deepEqual(shown(b), ['9', '', '']);
    assert.equal(b.get('total-score').textContent, 9);
});

test('the delete button works again after the first delete, and with no shot entered in this session', async () => {
    const b = clientContext();
    distanceOf(b, 3);
    b.run(`results = [10, 9, 5].map((score, index) => ({ participant_id: 4, distance_id: 7, shot: index + 1, score, is_x: false })); renderScoreGrid();`);
    await b.run('deleteLastScore()');
    assert.deepEqual(plain(b.run('results.map(result => result.score)')), [10, 9]);
    await b.run('deleteLastScore()');
    await b.run('deleteLastScore()');
    assert.deepEqual(plain(b.run('results')), []);
});

test('the shots that the server keeps in another order are shown in order when the user opens them', async () => {
    const b = clientContext();
    b.data.state.distances[0].shots = [{ shot: 1, score: 5, is_x: false }, { shot: 2, score: 10, is_x: true }, { shot: 3, score: 9, is_x: false }];
    await b.run('openScoreInput(4)');
    assert.deepEqual(shown(b), ['X', '9', '5']);
});

test('a failed event load stops entry and does not save the event code', async () => {
    const b = clientContext();
    b.run(`_showScreen('code-screen'); currentCode = null; currentLane = null;`);
    b.get('code-input').value = 'EVENT1';
    b.context.api.getEvent = async () => { throw new Error('Network unavailable'); };
    await b.run('clientEnter()');
    assert.equal(b.visible(), 'code-screen');
    assert.equal(b.storage.getEventCode('client'), null);
    assert.match(b.get('client-notice').textContent, /Network unavailable/);
});

for (const status of [0, 500, 429]) {
    test(`auto-login keeps a saved session after error ${status}`, async () => {
        const b = clientContext();
        b.context.api.laneLogin = async () => { throw Object.assign(new Error('Temporary failure'), { status }); };
        await b.run(`_tryAutoLogin(1, 'lane-token')`);
        assert.equal(b.storage.getLane(), 1);
        assert.equal(b.storage.getLaneSession(1), 'lane-token');
        assert.match(b.get('client-notice').textContent, /saved session is kept/);
    });
}

test('auto-login clears a rejected token and shows the password screen', async () => {
    const b = clientContext();
    b.context.api.laneLogin = async () => ({ status: 'password_required' });
    await b.run(`_tryAutoLogin(1, 'lane-token')`);
    assert.equal(b.storage.getLaneSession(1), null);
    assert.equal(b.visible(), 'lane-auth-screen');
});

test('participant double submit sends one request and keeps the button disabled', async () => {
    const b = clientContext();
    const hold = deferred(); let requests = 0;
    b.get('p-name').value = 'New Archer'; b.get('p-shift').value = 'B';
    b.context.api.addParticipant = async () => { requests++; await hold.promise; };
    const first = b.run('submitParticipant({ preventDefault() {} })');
    await b.run('submitParticipant({ preventDefault() {} })');
    assert.equal(b.get('participant-submit').disabled, true);
    assert.equal(requests, 1);
    hold.resolve(); await first;
    assert.equal(b.get('participant-submit').disabled, false);
    assert.equal(b.visible(), 'participants-screen');
});

test('opening the auth screen repeatedly does not add key handlers', () => {
    const b = clientContext();
    b.run(`_bindClientControls(); _showLaneAuthScreen(1); _showLaneAuthScreen(1); _showLaneAuthScreen(1);`);
    assert.equal(b.get('lane-pw-input').listeners.keydown.length, 1);
});

for (const status of ['password_required', 'unexpected', 'network']) {
    test(`lane password submission reports ${status}`, async () => {
        const b = clientContext();
        b.context.api.laneLogin = async () => {
            if (status === 'network') throw new Error('The request timed out. Try again.');
            return { status };
        };
        b.get('lane-pw-input').value = 'KEEPTHIS1234';
        await b.run('submitLanePassword()');
        assert.ok(b.get('lane-pw-error').textContent);
        assert.doesNotMatch(b.get('lane-pw-error').textContent, /Invalid password/);
        assert.equal(b.get('lane-pw-input').value, 'KEEPTHIS1234');
    });
}

test('password copy does not use HTML attributes and does not report a failed copy as success', () => {
    const b = clientContext();
    b.document.execCommand = () => false;
    b.run(`_showLanePassword(1, 'SECRET123456'); copyLanePassword();`);
    assert.equal(b.get('lane-pw-display').dataset.pw, undefined);
    assert.equal(b.get('lane-pw-display').textContent, 'SECRET123456');
    assert.match(b.get('client-notice').textContent, /Could not copy/);
    b.run('_showScreen("participants-screen")');
    assert.equal(b.get('lane-pw-display').textContent, '');
});

test('navigation during a refresh cannot reopen the scoring screen', async () => {
    const b = clientContext(); const hold = deferred();
    b.context.api.getEvent = async () => { await hold.promise; return b.data.event; };
    const refresh = b.run('_reconcile()'); await tick();
    b.run(`_showScreen('add-participant-screen')`);
    hold.resolve(); await refresh;
    assert.equal(b.visible(), 'add-participant-screen');
});

test('an older refresh cannot replace scores edited while it was loading', async () => {
    const b = clientContext(); const hold = deferred();
    b.context.api.getParticipantState = async () => { const snapshot = structuredClone(b.data.state); await hold.promise; return snapshot; };
    const refresh = b.run('_reconcile()'); await tick();
    b.run('results[0].score = 8');
    const save = b.run('_saveCurrentResults()');
    hold.resolve(); await Promise.all([refresh, save]);
    assert.equal(b.run('results[0].score'), 8);
});

test('a storage failure is reported before a score request is sent', async () => {
    const b = clientContext();
    b.context.localStorage.setItem = () => { throw new Error('Quota exceeded'); };
    assert.equal(await b.run('_saveCurrentResults()'), false);
    assert.equal(b.data.saves.length, 0);
    assert.match(b.get('client-notice').textContent, /not saved on this device/);
});

test('invalid URL event codes do not start requests or clear the saved session', async () => {
    const b = clientContext(); let calls = 0;
    b.context.window.location.search = '?code=BAD%2FXX';
    b.context.api.getEvent = async () => { calls++; };
    await [...b.windowListeners.DOMContentLoaded][0]();
    assert.equal(calls, 0);
    assert.equal(b.storage.getLaneSession(1), 'lane-token');
    assert.match(b.get('client-notice').textContent, /letters or numbers/);
});

function refreshContext() {
    const b = clientContext();
    b.data.state.distances[0].shots = [{ shot: 1, score: 9, is_x: false }];
    b.run(`globalThis.__renders = 0; const __grid = renderScoreGrid; renderScoreGrid = () => { __renders++; return __grid(); }; globalThis.__context = _context();`);
    return b;
}

test('a score update on the participants screen refreshes one participant only', async () => {
    const b = refreshContext(); const calls = [];
    b.run(`_showScreen('participants-screen')`);
    b.context.api.getEvent = async () => { calls.push('event'); return b.data.event; };
    b.context.api.getDistances = async () => { calls.push('distances'); return b.data.distances; };
    b.data.state.distances[0].total_score = 27;
    await b.run(`_refreshParticipantState(4, __context)`);
    assert.deepEqual(calls, []);
    assert.match(b.get('participants-list').innerHTML, /dist-tag-active">: 27/);
    assert.equal(b.storage.getParticipantState(4).distances[0].total_score, 27);
});

test('a host edit removes the hint of the delete button, and an echo of our own save keeps it', async () => {
    const b = refreshContext();
    b.run(`_lastEntry = { score: 9, is_x: false, series: 1 }`);
    await b.run(`_refreshParticipantState(4, __context)`);
    assert.deepEqual(plain(b.run('_lastEntry')), { score: 9, is_x: false, series: 1 });
    b.data.state.distances[0].shots = [{ shot: 1, score: 9, is_x: false }, { shot: 2, score: 7, is_x: false }];
    await b.run(`_refreshParticipantState(4, __context)`);
    assert.equal(b.run('_lastEntry'), null);
});

test('a host edit of the open participant replaces the grid, and an echo of our own save does not', async () => {
    const b = refreshContext();
    await b.run(`_refreshParticipantState(4, __context)`);
    assert.equal(b.run('__renders'), 0);
    b.data.state.distances[0].shots = [{ shot: 1, score: 9, is_x: false }, { shot: 2, score: 7, is_x: false }];
    await b.run(`_refreshParticipantState(4, __context)`);
    assert.equal(b.run('__renders'), 1);
    assert.deepEqual(plain(b.run('results.map(r => [r.shot, r.score])')), [[1, 9], [2, 7]]);
    assert.equal(b.get('total-score').textContent, 16);
});

test('a score update never replaces scores typed while it was loading', async () => {
    const b = refreshContext(); const hold = deferred();
    b.context.api.getParticipantState = async () => { const snapshot = structuredClone(b.data.state); await hold.promise; return snapshot; };
    b.data.state.distances[0].shots = [{ shot: 1, score: 2, is_x: false }];
    const refresh = b.run(`_refreshParticipantState(4, __context)`); await tick();
    b.run('results[0].score = 8');
    const save = b.run('_saveCurrentResults()');
    hold.resolve(); await Promise.all([refresh, save]);
    assert.equal(b.run('results[0].score'), 8);
});

test('a score update that reports a finished distance keeps the scores on screen', async () => {
    const b = refreshContext();
    b.data.state.distances[0].status = 'finished';
    b.data.state.distances[0].shots = [];
    await b.run(`_refreshParticipantState(4, __context)`);
    assert.equal(b.run('results.length'), 1);
    assert.equal(b.run('__renders'), 0);
});

test('a score update from an earlier lane context is ignored', async () => {
    const b = refreshContext(); let calls = 0;
    b.context.api.getParticipantState = async () => { calls++; return structuredClone(b.data.state); };
    b.run('contextVersion++');
    await b.run(`_refreshParticipantState(4, __context)`);
    assert.equal(b.storage.getParticipantState(4)?.distances[0].total_score ?? null, null);
    assert.equal(calls, 1);
});

function twoParticipants(b) {
    b.data.participants = [
        { id: 4, name: 'Archer', lane_number: 1, shift: 'A' },
        { id: 5, name: 'Second', lane_number: 1, shift: 'B' },
    ];
}

test('one failed participant request does not block the lane list', async () => {
    const b = clientContext(); twoParticipants(b);
    b.storage.saveParticipantState(5, { distances: [{ distance_id: 7, status: 'active', total_score: 5, shots: [] }] });
    b.data.state.distances[0].total_score = 9;
    b.context.api.getParticipantState = async (code, id) => {
        if (id === 5) throw new Error('network');
        return structuredClone(b.data.state);
    };
    await b.run('loadLaneParticipants({ show: true })');
    assert.equal(b.visible(), 'participants-screen');
    assert.equal(b.storage.getParticipantState(4).distances[0].total_score, 9);
    assert.equal(b.storage.getParticipantState(5).distances[0].total_score, 5);
    assert.match(b.get('participants-list').innerHTML, /Second/);
    assert.match(b.get('client-notice').textContent, /Could not refresh/);
});

test('a lane load still fails when the lane data itself cannot be loaded', async () => {
    const b = clientContext();
    b.context.api.getParticipants = async () => { throw new Error('network'); };
    await assert.rejects(b.run('loadLaneParticipants({ show: true })'), /network/);
});

test('unsent scores of a finished event move to the recovery archive and can be downloaded', async () => {
    const b = clientContext();
    b.storage.savePendingResults('EVENT1', 4, 7, 1, 'lane-token', [{ shot_number: 1, score: 9, is_x: false }]);
    b.data.event.status = 'finished';
    await b.run('loadLaneParticipants({ show: true })');
    assert.equal(b.data.saves.length, 0);
    assert.equal(b.storage.getPendingResult('EVENT1', 4, 7), null);
    const recovered = b.storage.getRecoveryResults();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].reason, 'event_finished');
    assert.equal(recovered[0].shots[0].score, 9);
    assert.match(b.get('client-notice').textContent, /finished/);
    assert.equal(b.get('recovery-download').classList.contains('hidden'), false);
});

test('scores that cannot be sent when the event finishes are archived from the scoring screen', async () => {
    const b = clientContext();
    b.data.event.status = 'finished';
    b.context.api.replaceDistanceResults = async () => { const error = new Error('The event has finished'); error.status = 403; throw error; };
    await b.run('_reconcile()');
    assert.equal(b.visible(), 'participants-screen');
    assert.equal(b.storage.getPendingResults('EVENT1', 1).length, 0);
    const recovered = b.storage.getRecoveryResults();
    assert.equal(recovered.length, 1);
    assert.deepEqual(plain(recovered[0].shots), [{ shot_number: 1, score: 9, is_x: false }]);
    assert.equal(b.get('recovery-download').classList.contains('hidden'), false);
});

test('scores cannot be deleted after the event finished', async () => {
    const b = clientContext();
    b.run(`eventData.status = 'finished'`);
    await b.run('deleteLastScore()');
    assert.equal(b.run('results.length'), 1);
    assert.equal(b.storage.getPendingResults('EVENT1', 1).length, 0);
    assert.equal(b.alerts.length, 1);
});

test('the socket connects even when the first lane load fails after login', async () => {
    const b = clientContext();
    b.run(`globalThis.WSClient = class { constructor(code, sid) { this.code = code; this.sid = sid; globalThis.__ws = this; } on() {} connect() { this.connected = true; } disconnect() { this.stopped = true; } }`);
    b.context.api.getParticipants = async () => { throw new Error('network'); };
    await assert.rejects(b.run(`_handleLaneLoginResult({ status: 'ok', session_id: 'fresh' }, 1)`), /network/);
    assert.equal(b.run('__ws.connected'), true);
    assert.equal(b.run('__ws.sid'), 'fresh');
    assert.equal(b.storage.getLaneSession(1), 'fresh');
});

test('archiving the same unsent scores twice keeps one recovery record', () => {
    const b = clientContext();
    const record = { code: 'EVENT1', participant_id: 4, distance_id: 7, lane_number: 1, session_id: 'lane-token', shots: [{ shot_number: 1, score: 9, is_x: false }] };
    b.storage.savePendingResults('EVENT1', 4, 7, 1, 'lane-token', record.shots);
    b.storage.archivePendingResults(record, 'event_finished');
    b.storage.savePendingResults('EVENT1', 4, 7, 1, 'lane-token', record.shots);
    b.storage.archivePendingResults(record, 'event_finished');
    assert.equal(b.storage.getRecoveryResults().length, 1);
    assert.equal(b.storage.getPendingResult('EVENT1', 4, 7), null);
    const changed = { ...record, shots: [{ shot_number: 1, score: 8, is_x: false }] };
    b.storage.savePendingResults('EVENT1', 4, 7, 1, 'lane-token', changed.shots);
    b.storage.archivePendingResults(changed, 'event_finished');
    assert.deepEqual(plain(b.storage.getRecoveryResults().map(row => row.shots[0].score).sort()), [8, 9]);
});

test('a distance with an uneven last series can be left without a warning', async () => {
    const b = clientContext(); const questions = [];
    b.context.confirm = question => { questions.push(question); return true; };
    b.run(`distances = [{ id: 7, status: 'active', shots_count: 10 }];
        results = Array.from({ length: 10 }, (_, i) => ({ participant_id: 4, distance_id: 7, shot: i + 1, score: 5, is_x: false }));`);
    await b.run('backToParticipants()');
    assert.deepEqual(questions, []);
});

test('an unfinished series is still reported, also for an uneven last series', async () => {
    const b = clientContext(); const questions = [];
    b.context.confirm = question => { questions.push(question); return false; };
    b.run(`distances = [{ id: 7, status: 'active', shots_count: 10 }];
        results = [1, 2].map(shot => ({ participant_id: 4, distance_id: 7, shot, score: 5, is_x: false }));`);
    await b.run('backToParticipants()');
    assert.equal(questions.length, 1);
    assert.match(questions[0], /Series 1 incomplete \(2\/3\)/);
    assert.equal(b.visible(), 'score-screen');
});

test('a last series is complete when it has all the shots the distance needs', async () => {
    const b = clientContext(); const questions = [];
    b.context.confirm = question => { questions.push(question); return false; };
    b.run(`distances = [{ id: 7, status: 'active', shots_count: 11 }];
        results = [10, 11].map(shot => ({ participant_id: 4, distance_id: 7, shot, score: 5, is_x: false }));`);
    await b.run('backToParticipants()');
    assert.deepEqual(questions, []);
    b.run(`distances = [{ id: 7, status: 'active', shots_count: 11 }];
        results = [10].map(shot => ({ participant_id: 4, distance_id: 7, shot, score: 5, is_x: false }));`);
    await b.run('backToParticipants()');
    assert.match(questions[0], /Series 4 incomplete \(1\/2\)/);
});

test('lanes above the default count can be selected when participants use them', async () => {
    const b = clientContext();
    b.context.api.getParticipants = async () => [
        { id: 4, name: 'A', lane_number: 1, shift: 'A' },
        { id: 9, name: 'Far', lane_number: 40, shift: 'A' },
    ];
    b.run(`currentCode = 'EVENT1'`);
    await b.run('_initConnections()');
    b.run('showLaneSelection()');
    assert.equal(b.get('lane-buttons').children.length, 40);
});

test('the default lane count stays when the participant list cannot be loaded', async () => {
    const b = clientContext();
    b.context.api.getParticipants = async () => { throw new Error('network'); };
    b.run(`currentCode = 'EVENT1'`);
    await b.run('_initConnections()');
    b.run('showLaneSelection()');
    assert.equal(b.get('lane-buttons').children.length, 28);
});

test('the lane list follows the lane count of the server', async () => {
    const b = clientContext();
    b.context.api.getPublicProperties = async () => ({ client_allow_add_participant: true, lane_count: 12 });
    b.run(`currentCode = 'EVENT1'`);
    await b.run('_initConnections()');
    b.run('showLaneSelection()');
    assert.equal(b.get('lane-buttons').children.length, 12);
});

test('a lane with a participant shows when the lane count is lower', async () => {
    const b = clientContext();
    b.context.api.getPublicProperties = async () => ({ client_allow_add_participant: true, lane_count: 5 });
    b.context.api.getParticipants = async () => [{ id: 9, name: 'Far', lane_number: 8, shift: 'A' }];
    b.run(`currentCode = 'EVENT1'`);
    await b.run('_initConnections()');
    b.run('showLaneSelection()');
    assert.equal(b.get('lane-buttons').children.length, 8);
});

test('the lane list changes while it is open when the host changes the lane count', async () => {
    const b = clientContext();
    let lanes = 12;
    b.context.CONFIG.RESET_POLL_MS = 5;
    b.context.api.getPublicProperties = async () => ({ client_allow_add_participant: true, lane_count: lanes });
    b.run(`currentCode = 'EVENT1'; currentLane = null`);
    await b.run('_initConnections()');
    b.run('showLaneSelection()');
    assert.equal(b.get('lane-buttons').children.length, 12);
    lanes = 20;
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(b.get('lane-buttons').children.length, 20);
    b.run(`_showScreen('participants-screen')`);
    lanes = 30;
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(b.get('lane-buttons').children.length, 20);
});

test('a reconnect refresh updates the lane count for the next lane selection', async () => {
    const b = clientContext();
    b.context.api.getPublicProperties = async () => ({ client_allow_add_participant: true, lane_count: 33 });
    await b.run('_reconcile()');
    b.run('showLaneSelection()');
    assert.equal(b.get('lane-buttons').children.length, 33);
    b.run(`_showScreen('participants-screen')`);
});

test('damaged saved data is ignored and does not stop the lane', async () => {
    const b = clientContext();
    b.values.set('pending_results_EVENT1_4_7', '{broken');
    b.values.set('pstate_4', 'not json');
    b.values.set('recovery_results_EVENT1_4_7_1', '{broken');
    assert.deepEqual(plain(b.storage.getPendingResults('EVENT1', 1)), []);
    assert.equal(b.storage.getParticipantState(4), null);
    assert.deepEqual(plain(b.storage.getRecoveryResults()), []);
    await b.run('loadLaneParticipants({ show: true })');
    assert.equal(b.visible(), 'participants-screen');
});

test('a participant list with no participants shows an empty lane', async () => {
    const b = clientContext(); b.data.participants = [];
    await b.run('loadLaneParticipants({ show: true })');
    assert.equal(b.get('participants-list').innerHTML, '');
    assert.equal(b.visible(), 'participants-screen');
});

test('a score cannot be added when every shot has a score', () => {
    const b = clientContext();
    b.run(`results = [1, 2, 3].map(shot => ({ participant_id: 4, distance_id: 7, shot, score: 5, is_x: false })); _currentShot = null;`);
    b.run('inputScore(10)');
    assert.equal(b.alerts.at(-1), 'All shots filled');
    assert.equal(b.run('results.length'), 3);
});

test('a lane reset for another lane does not disturb this lane', () => {
    const b = clientContext();
    b.run('handleLaneSessionReset({ lane_number: 2 })');
    assert.equal(b.alerts.length, 0);
    assert.equal(b.storage.getLaneSession(1), 'lane-token');
    assert.equal(b.visible(), 'score-screen');
});

test('a score update for a participant on another lane is ignored by the socket handler', async () => {
    const b = clientContext();
    const handlers = {};
    b.run(`globalThis.WSClient = class { constructor() { globalThis.__handlers = this.handlers = {}; } on(type, fn) { this.handlers[type] = fn; } connect() {} disconnect() {} }`);
    b.run('_connectClientWS("lane-token")');
    let calls = 0;
    b.context.api.getParticipantState = async () => { calls++; return structuredClone(b.data.state); };
    await b.run('__handlers.result_update({ participant_id: 99 })');
    assert.equal(calls, 0);
    await b.run('__handlers.result_update({ participant_id: 4 })');
    assert.equal(calls, 1);
});

test('an unknown lane login status is reported and keeps the user on lane selection', async () => {
    const b = clientContext();
    b.run(`_showScreen('lane-screen')`);
    b.context.api.laneLogin = async () => ({ status: 'surprise' });
    await b.run('selectLane(3)');
    assert.equal(b.visible(), 'lane-screen');
    assert.match(b.get('client-notice').textContent, /unknown lane status/);
});

function cardContext() {
    const b = clientContext();
    b.run(`distances = [
        { id: 7, title: 'Pending', status: 'pending', shots_count: 30 },
        { id: 8, title: 'Active', status: 'active', shots_count: 6 },
        { id: 9, title: 'Done', status: 'finished', shots_count: 30 },
    ];
    participants = [{ id: 4, name: 'Archer', lane_number: 1, shift: 'A' }];`);
    return b;
}
const tagTexts = b => [...b.get('participants-list').innerHTML.matchAll(/<span class="dist-tag [^"]*">([^<]*)<\/span>/g)].map(match => match[1]);

test('each participant card shows how many results are entered for each distance', () => {
    const b = cardContext();
    b.storage.saveParticipantState(4, { distances: [
        { distance_id: 7, status: 'pending', total_score: null, shots_taken: 0, shots: [] },
        { distance_id: 8, status: 'active', total_score: 19, shots_taken: 2, shots: [{ shot: 1, score: 10, is_x: true }, { shot: 2, score: 9, is_x: false }] },
        { distance_id: 9, status: 'finished', total_score: 250, shots_taken: 30, shots: [] },
    ] });
    b.run('renderParticipantsList()');
    assert.deepEqual(tagTexts(b), ['Pending: — · 0/30', 'Active: 19 · 2/6', 'Done: 250 · 30/30']);
});

test('the count falls back to the listed shots when the server sends no count', () => {
    const b = cardContext();
    b.storage.saveParticipantState(4, { distances: [
        { distance_id: 8, status: 'active', total_score: 5, shots: [{ shot: 1, score: 5, is_x: false }, { shot: 2, score: 0, is_x: false }] },
    ] });
    b.run('renderParticipantsList()');
    assert.deepEqual(tagTexts(b), ['Pending: — · 0/30', 'Active: 5 · 2/6', 'Done: — · 0/30']);
});

test('unsent shots count in the card, and a card without a saved state shows zero', () => {
    const b = cardContext();
    b.storage.savePendingResults('EVENT1', 4, 8, 1, 'lane-token', [1, 2, 3].map(shot => ({ shot_number: shot, score: 9, is_x: false })));
    const merged = b.run(`_mergePendingResults(4, { distances: [{ distance_id: 8, status: 'active', total_score: null, shots_taken: 0, shots: [] }] })`);
    assert.equal(merged.distances[0].shots_taken, 3);
    assert.equal(merged.distances[0].total_score, 27);
    b.storage.saveParticipantState(4, merged);
    b.run('renderParticipantsList()');
    assert.ok(tagTexts(b).includes('Active: 27 · 3/6'));
    b.values.delete('pstate_4');
    b.run('renderParticipantsList()');
    assert.deepEqual(tagTexts(b), ['Pending: — · 0/30', 'Active: — · 0/6', 'Done: — · 0/30']);
});

test('the count of a series that was cleared offline is zero', () => {
    const b = cardContext();
    b.storage.savePendingResults('EVENT1', 4, 8, 1, 'lane-token', []);
    const merged = b.run(`_mergePendingResults(4, { distances: [{ distance_id: 8, status: 'active', total_score: 19, shots_taken: 2, shots: [{ shot: 1, score: 10, is_x: true }] }] })`);
    assert.equal(merged.distances[0].shots_taken, 0);
    assert.equal(merged.distances[0].total_score, null);
});

// ── Shots that come from the server are shown in order ──────────────────────
test('shots from a live update of the server are shown in order', async () => {
    const b = clientContext();
    distanceOf(b, 3);
    b.data.state.distances[0].shots = [{ shot: 1, score: 5, is_x: false }, { shot: 2, score: 10, is_x: true }, { shot: 3, score: 9, is_x: false }];
    await b.run('_refreshParticipantState(4, _context())');
    assert.deepEqual(shown(b), ['X', '9', '5']);
    assert.deepEqual(plain(b.run('results.map(result => result.shot + ":" + result.score)')), ['1:10', '2:9', '3:5']);
});

test('the same live update does not draw the grid again when nothing changed', async () => {
    const b = clientContext();
    distanceOf(b, 3);
    b.data.state.distances[0].shots = [{ shot: 1, score: 5, is_x: false }, { shot: 2, score: 10, is_x: false }];
    await b.run('_refreshParticipantState(4, _context())');
    const first = b.document.querySelectorAll('.shot-btn');
    await b.run('_refreshParticipantState(4, _context())');
    assert.equal(b.document.querySelectorAll('.shot-btn')[0], first[0]);
});

test('shots in the saved state are shown in order after a reconnect', async () => {
    const b = clientContext();
    b.data.state.distances[0].shots = [{ shot: 1, score: 2, is_x: false }, { shot: 2, score: 8, is_x: false }, { shot: 3, score: 6, is_x: false }];
    await b.run('_reconcile()');
    assert.deepEqual(shown(b), ['8', '6', '2']);
});

test('clearing a shot removes the hint of the delete button', () => {
    const b = clientContext();
    distanceOf(b, 3);
    b.run('inputScore(9); inputScore(9);');
    assert.deepEqual(plain(b.run('_lastEntry')), { score: 9, is_x: false, series: 1 });
    b.context.clicked = b.document.querySelectorAll('.shot-btn')[0];
    b.run('selectShot(1, 1, { currentTarget: clicked }); selectShot(1, 1, { currentTarget: clicked });');
    assert.equal(b.run('_lastEntry'), null);
});
