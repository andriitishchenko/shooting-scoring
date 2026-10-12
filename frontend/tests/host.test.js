const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const hostScript = fs.readFileSync(path.join(__dirname, '../js/host.js'), 'utf8');

function createHostContext() {
    const resultsContainer = {
        innerHTML: '',
        querySelectorAll: () => [],
    };
    const context = vm.createContext({
        window: { addEventListener() {}, prompt: () => '9' },
        document: {
            getElementById(id) {
                if (id === 'results-container') return resultsContainer;
                if (id === 'detail-modal-title') return { textContent: 'Archer' };
                return { innerHTML: '', textContent: '', classList: { add() {}, remove() {} } };
            },
        },
        Storage: { getHostSession: () => 'host-token' },
        alert() {},
        console: { warn() {} },
    });
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
