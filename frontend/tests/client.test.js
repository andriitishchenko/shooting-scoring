const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const clientScript = fs.readFileSync(path.join(__dirname, '../js/client.js'), 'utf8');

function createClientContext() {
    const scoreScreen = { classList: { contains: () => false } };
    const context = vm.createContext({
        window: { addEventListener() {} },
        document: { getElementById: () => scoreScreen },
        Storage: {
            getParticipantState: () => ({ distances: [] }),
            getLaneSession: () => 'lane-token',
            getPendingResults: () => [],
        },
        record: { renders: 0, saved: 0, screens: [], openedParticipant: null, alerts: [] },
        console: { warn() {} },
        alert: message => context.record.alerts.push(message),
    });
    vm.runInContext(clientScript, context, { filename: 'client.js' });
    vm.runInContext(`
        currentCode = 'EVENT';
        currentLane = 1;
        currentParticipant = { id: 4 };
        currentDistanceId = 7;
        participants = [{ id: 4 }];
        _refreshLaneData = async () => {
            eventData = { status: 'started' };
            distances = [{ id: 7, status: 'active', shots_count: 3 }];
        };
        _autoSave = async () => { record.saved++; };
        renderScoreGrid = () => { record.renders++; };
        updateTotalScore = () => {};
        _showScreen = screen => { record.screens.push(screen); };
        loadLaneParticipants = async () => { record.screens.push('participants-screen'); };
        openScoreInput = async participantId => { record.openedParticipant = participantId; };
    `, context);
    return context;
}

test('reconnect refresh keeps the active scoring screen open', async () => {
    const context = createClientContext();
    await vm.runInContext('_refreshClientState()', context);

    assert.equal(context.record.renders, 1);
    assert.deepEqual(context.record.screens, []);
    assert.equal(context.record.saved, 0);
});

test('reconnect refresh saves and opens a newly active distance', async () => {
    const context = createClientContext();
    vm.runInContext(`_refreshLaneData = async () => {
        eventData = { status: 'started' };
        distances = [{ id: 8, status: 'active', shots_count: 3 }];
    };`, context);

    await vm.runInContext('_refreshClientState()', context);

    assert.equal(context.record.saved, 1);
    assert.equal(context.record.openedParticipant, 4);
    assert.deepEqual(context.record.screens, []);
});

test('reconnect refresh exits scoring when the event has finished', async () => {
    const context = createClientContext();
    vm.runInContext(`_refreshLaneData = async () => {
        eventData = { status: 'finished' };
        distances = [{ id: 7, status: 'finished', shots_count: 3 }];
    };`, context);

    await vm.runInContext('_refreshClientState()', context);

    assert.equal(context.record.saved, 1);
    assert.deepEqual(context.record.screens, ['score-screen-hidden', 'participants-screen']);
    assert.equal(context.record.alerts.length, 1);
});

test('pending sync is serialized with newer edits so stale shots cannot win', async () => {
    const context = createClientContext();
    let pending = null;
    let serverShots = [];
    let releaseFirstRequest;
    const firstRequestHold = new Promise(resolve => { releaseFirstRequest = resolve; });
    const sentSnapshots = [];
    const storage = {
        savePendingResults(code, participantId, distanceId, lane, sessionId, shots) {
            pending = {
                code, participant_id: participantId, distance_id: distanceId,
                lane_number: lane, session_id: sessionId, shots
            };
        },
        getPendingResults(code, lane) {
            return pending && pending.code === code && pending.lane_number === lane ? [pending] : [];
        },
        getPendingResult() { return pending; },
        clearPendingResults() { pending = null; },
        getLaneSession() { return 'lane-token'; },
        getParticipantState() { return null; },
        saveParticipantState() {},
    };
    context.Storage = storage;
    context.api = {
        async replaceDistanceResults(code, participantId, distanceId, shots) {
            const snapshot = JSON.parse(JSON.stringify(shots));
            sentSnapshots.push(snapshot);
            if (sentSnapshots.length === 1) await firstRequestHold;
            serverShots = snapshot;
        },
        async getParticipantState() { return { distances: [] }; },
    };
    vm.runInContext(`
        eventData = { status: 'started' };
        currentCode = 'EVENT';
        currentLane = 1;
        currentParticipant = { id: 4 };
        currentDistanceId = 7;
        results = [{ participant_id: 4, distance_id: 7, shot: 1, score: 9, is_x: false }];
    `, context);
    storage.savePendingResults('EVENT', 4, 7, 1, 'lane-token', [{ shot_number: 1, score: 9, is_x: false }]);

    const sync = vm.runInContext('_syncPendingResults()', context);
    await new Promise(resolve => setImmediate(resolve));
    vm.runInContext(`results = [{ participant_id: 4, distance_id: 7, shot: 1, score: 8, is_x: false }];`, context);
    const newerSave = vm.runInContext('_saveCurrentResults()', context);
    releaseFirstRequest();
    await Promise.all([sync, newerSave]);

    assert.deepEqual(sentSnapshots.map(snapshot => snapshot[0].score), [9, 8]);
    assert.deepEqual(serverShots.map(shot => shot.score), [8]);
    assert.equal(pending, null);
});

test('an offline-cleared series remains unscored instead of displaying zero', () => {
    const context = createClientContext();
    context.Storage = {
        getLaneSession: () => 'lane-token',
        getPendingResults: () => [{ participant_id: 4, distance_id: 7, session_id: 'lane-token', shots: [] }],
    };
    vm.runInContext(`currentCode = 'EVENT'; currentLane = 1;`, context);

    const state = vm.runInContext(`_mergePendingResults(4, {
        distances: [{
            distance_id: 7, total_score: 19, x_count: 1,
            shots: [{ shot: 1, score: 10, is_x: true }]
        }]
    })`, context);

    assert.equal(state.distances[0].total_score, null);
    assert.deepEqual(JSON.parse(JSON.stringify(state.distances[0].shots)), []);
});

test('pending results from an earlier lane session are not merged or replayed', async () => {
    const context = createClientContext();
    const oldPending = {
        code: 'EVENT', participant_id: 4, distance_id: 7, lane_number: 1,
        session_id: 'old-token', shots: [{ shot_number: 1, score: 2, is_x: false }],
    };
    const legacyPending = {
        code: 'EVENT', participant_id: 4, distance_id: 8, lane_number: 1,
        shots: [{ shot_number: 1, score: 3, is_x: false }],
    };
    let replaceCalls = 0;
    context.Storage = {
        getLaneSession: () => 'new-token',
        getPendingResults: () => [oldPending, legacyPending],
        getPendingResult: () => oldPending,
        clearPendingResults() { throw new Error('stale pending result must not be cleared'); },
    };
    context.api = {
        async replaceDistanceResults() { replaceCalls++; },
    };
    vm.runInContext(`
        eventData = { status: 'started' };
        currentCode = 'EVENT';
        currentLane = 1;
    `, context);

    await vm.runInContext('_syncPendingResults()', context);
    const replacement = await vm.runInContext(
        `_queueResultReplacement('EVENT', 4, 7, 1, 'new-token', [], true)`,
        context
    );
    const state = vm.runInContext(`_mergePendingResults(4, {
        distances: [{
            distance_id: 7, total_score: 8, x_count: 0,
            shots: [{ shot: 1, score: 8, is_x: false }]
        }, {
            distance_id: 8, total_score: 7, x_count: 0,
            shots: [{ shot: 1, score: 7, is_x: false }]
        }]
    })`, context);

    assert.equal(replaceCalls, 0);
    assert.equal(replacement.sent, false);
    assert.equal(replacement.cleared, false);
    assert.equal(state.distances[0].total_score, 8);
    assert.equal(state.distances[0].shots[0].score, 8);
    assert.equal(state.distances[1].total_score, 7);
});
