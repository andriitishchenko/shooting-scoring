const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const hostScript = fs.readFileSync(path.join(__dirname, '../js/host.js'), 'utf8');
const rankingScript = fs.readFileSync(path.join(__dirname, '../js/ranking.js'), 'utf8');
const scoringScript = fs.readFileSync(path.join(__dirname, '../js/scoring.js'), 'utf8');
const actionsScript = fs.readFileSync(path.join(__dirname, '../js/actions.js'), 'utf8');

function createHostContext() {
    const resultsContainer = {
        innerHTML: '',
        querySelectorAll: () => [],
    };
    const context = vm.createContext({
        window: { addEventListener() {}, prompt: () => '9' },
        CONFIG: { SERIES_SIZE: 3 },
        document: {
            addEventListener() {},
            getElementById(id) {
                if (id === 'results-container') return resultsContainer;
                if (id === 'detail-modal-title') return { textContent: 'Archer' };
                return { innerHTML: '', textContent: '', classList: { add() {}, remove() {} } };
            },
        },
        AppStorage: { getHostSession: () => 'host-token' },
        alert() {},
        console: { warn() {} },
    });
    vm.runInContext(rankingScript, context, { filename: 'ranking.js' });
    vm.runInContext(scoringScript, context, { filename: 'scoring.js' });
    vm.runInContext(actionsScript, context, { filename: 'actions.js' });
    vm.runInContext(hostScript, context, { filename: 'host.js' });
    return { context, resultsContainer };
}

test('host can open an empty cell for a distance that has started', () => {
    const { context, resultsContainer } = createHostContext();
    vm.runInContext(`
        currentEventData = { status: 'started' };
        currentDistances = [
            { id: 10, title: 'Active distance', status: 'active' },
            { id: 11, title: 'Upcoming distance', status: 'pending' },
        ];
    `, context);

    context.renderResults({ male: [{
        id: 4, name: 'Archer', lane_shift: '1A', total_score: 10,
        avg_score: 10, x_count: 0, ten_count: 1, distance_scores: [],
    }] });

    assert.match(resultsContainer.innerHTML, /class="dist-score-link score-empty" data-pid="4" data-did="10"[^>]*>—<\/span>/);
    assert.match(resultsContainer.innerHTML, /<td class="score-empty">—<\/td>/);
});

test('host results include unscored participants so a first missed result can be entered', async () => {
    const { context, resultsContainer } = createHostContext();
    context.api = {
        async getLeaderboard() { return {}; },
        async getParticipants() {
            return [{
                id: 9, name: 'No score yet', lane_number: 3, shift: 'B',
                gender: 'female', shooting_type: 'recurve',
            }];
        },
    };
    vm.runInContext(`
        currentCode = 'EVENT';
        currentEventData = { status: 'started' };
        currentDistances = [{ id: 10, title: 'Active distance', status: 'active', shots_count: 3 }];
    `, context);

    await vm.runInContext('loadResults()', context);

    assert.match(resultsContainer.innerHTML, /No score yet/);
    assert.match(resultsContainer.innerHTML, /class="dist-score-link score-empty" data-pid="9" data-did="10"[^>]*>—<\/span>/);
});

test('host serializes full-series edits while a replacement request is in flight', async () => {
    const { context } = createHostContext();
    let releaseRequest;
    const requestHold = new Promise(resolve => { releaseRequest = resolve; });
    const replacements = [];
    context.api = {
        async replaceDistanceResults(code, participantId, distanceId, shots) {
            replacements.push({ code, participantId, distanceId, shots });
            await requestHold;
        },
    };
    context.loadParticipants = async () => {};
    context.loadResults = async () => {};
    vm.runInContext(`
        currentCode = 'EVENT';
        _detailContext = {
            participantId: 4, distanceId: 10,
            shots: [{ shot_number: 1, score: 8, is_x: false }],
        };
    `, context);

    const firstEdit = vm.runInContext('editDetailShot(1)', context);
    await new Promise(resolve => setImmediate(resolve));
    const secondEdit = vm.runInContext('editDetailShot(2)', context);
    vm.runInContext(`_detailContext = { participantId: 5, distanceId: 10, shots: [] };`, context);
    releaseRequest();
    await Promise.all([firstEdit, secondEdit]);

    assert.equal(replacements.length, 1);
    assert.equal(replacements[0].participantId, 4);
    assert.deepEqual(JSON.parse(JSON.stringify(replacements[0].shots)), [
        { shot_number: 1, score: 9, is_x: false },
    ]);
});

test('host renders API error messages as text instead of executable HTML', async () => {
    const elements = {
        'detail-modal-title': { textContent: '' },
        'detail-modal-subtitle': { textContent: '' },
        'detail-modal-body': {
            replaceChildren(child) { this.child = child; },
        },
        'detail-modal': { classList: { remove() {} } },
    };
    const context = vm.createContext({
        window: { addEventListener() {} },
        document: {
            addEventListener() {},
            getElementById: id => elements[id],
            createElement: tag => ({ tagName: tag, textContent: '' }),
        },
        api: { async getDistanceDetail() { throw new Error('<img src=x onerror=alert(1)>'); } },
        console: { warn() {} },
    });
    vm.runInContext(actionsScript, context, { filename: 'actions.js' });
    vm.runInContext(hostScript, context, { filename: 'host.js' });

    await vm.runInContext("openDetailModal(1, 2, 'Archer')", context);

    assert.equal(elements['detail-modal-body'].child.tagName, 'p');
    assert.equal(elements['detail-modal-body'].child.textContent, 'Error: <img src=x onerror=alert(1)>');
});

test('host builds the QR code in the browser from the shared event URL', () => {
    const elements = {
        'qr-modal-body': {
            childElementCount: 0,
            replaceChildren(child) { this.child = child; this.childElementCount = 1; },
        },
        'qr-modal': { classList: { remove() {} } },
    };
    const encoded = [];
    const context = vm.createContext({
        window: { addEventListener() {}, location: { href: 'https://scores.example/host.html' } },
        document: {
            addEventListener() {},
            getElementById: id => elements[id],
            createElement: tag => ({ tagName: tag }),
        },
        qrcode: () => ({
            addData: text => encoded.push(text),
            make() {},
            createSvgTag: options => `<svg data-scalable="${options.scalable}"></svg>`,
        }),
        alert() { throw new Error('No alert expected'); },
    });
    vm.runInContext(actionsScript, context, { filename: 'actions.js' });
    vm.runInContext(hostScript, context, { filename: 'host.js' });
    vm.runInContext("currentCode = 'ABC123'; showQR('viewer')", context);

    const image = elements['qr-modal-body'].child;
    assert.deepEqual(encoded, ['https://scores.example/viewer.html?code=ABC123']);
    assert.equal(image.tagName, 'img');
    assert.match(image.src, /^data:image\/svg\+xml;charset=utf-8,/);
    assert.equal(decodeURIComponent(image.src.split(',')[1]), '<svg data-scalable="true"></svg>');
    assert.equal(image.title, 'scan to open client');
});

test('a correction of the host keeps each series ordered from the highest to the lowest', async () => {
    const { context } = createHostContext();
    const replacements = [];
    context.api = { async replaceDistanceResults(code, participantId, distanceId, shots) { replacements.push(JSON.parse(JSON.stringify(shots))); } };
    context.loadParticipants = async () => {};
    context.loadResults = async () => {};
    context.window.prompt = () => '10';
    vm.runInContext(`
        currentCode = 'EVENT';
        _detailContext = { participantId: 4, distanceId: 10, shots: [{ shot_number: 1, score: 9, is_x: false }, { shot_number: 2, score: 5, is_x: false }, { shot_number: 4, score: 3, is_x: false }] };
    `, context);
    await vm.runInContext('editDetailShot(3)', context);
    assert.deepEqual(replacements[0], [
        { shot_number: 1, score: 10, is_x: false }, { shot_number: 2, score: 9, is_x: false }, { shot_number: 3, score: 5, is_x: false },
        { shot_number: 4, score: 3, is_x: false },
    ]);
});

test('a correction of the host that lowers a shot moves it down in its series', async () => {
    const { context } = createHostContext();
    const replacements = [];
    context.api = { async replaceDistanceResults(code, participantId, distanceId, shots) { replacements.push(JSON.parse(JSON.stringify(shots))); } };
    context.loadParticipants = async () => {};
    context.loadResults = async () => {};
    context.window.prompt = () => '2';
    vm.runInContext(`
        currentCode = 'EVENT';
        _detailContext = { participantId: 4, distanceId: 10, shots: [{ shot_number: 1, score: 10, is_x: true }, { shot_number: 2, score: 9, is_x: false }, { shot_number: 3, score: 5, is_x: false }] };
    `, context);
    await vm.runInContext('editDetailShot(1)', context);
    assert.deepEqual(replacements[0].map(shot => [shot.shot_number, shot.score, shot.is_x]), [[1, 9, false], [2, 5, false], [3, 2, false]]);
});
