// The service worker of the practice page, and the script that registers it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function worker({ network = () => ({ ok: true, clone() { return { copy: true }; }, tag: 'network' }) } = {}) {
    const listeners = {};
    const store = new Map();
    const timers = [];
    const log = { skipped: 0, claimed: 0, added: null, deleted: [], puts: [], fetched: [] };
    const caches = {
        open: async () => ({ addAll: async files => { log.added = files; }, put: async (request, response) => { log.puts.push([request.url, response]); store.set(request.url, response); } }),
        keys: async () => ['practice-v1', 'old-v0', 'other'],
        delete: async key => { log.deleted.push(key); },
        match: async request => store.get(request.url),
    };
    const context = vm.createContext({
        URL, Promise, console,
        setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {},
        self: {
            registration: { scope: 'https://scores.test/' },
            addEventListener: (type, fn) => { listeners[type] = fn; },
            skipWaiting: () => { log.skipped++; },
            clients: { claim: async () => { log.claimed++; } },
        },
        caches,
        fetch: async request => { log.fetched.push(request.url); const value = network(request); if (value instanceof Error) throw value; return value; },
    });
    vm.runInContext(read('sw.js'), context, { filename: 'sw.js' });
    const run = async request => {
        let answer; let handled = false;
        const waiting = [];
        listeners.fetch({ request, respondWith: promise => { handled = true; answer = promise; }, waitUntil: promise => waiting.push(promise) });
        return { handled, answer: handled ? await answer : undefined, waiting };
    };
    // Start a request without waiting for the answer.
    const start = request => {
        const state = { handled: false, done: false };
        listeners.fetch({ request, respondWith: promise => { state.handled = true; state.answer = promise.then(value => { state.done = true; return value; }); }, waitUntil: () => {} });
        return state;
    };
    return { listeners, log, store, run, start, timers };
}
const get = url => ({ method: 'GET', url });

test('the install step keeps all the files of the pages', async () => {
    const w = worker();
    let waited;
    w.listeners.install({ waitUntil: promise => { waited = promise; } });
    await waited;
    assert.ok(w.log.added.includes('practice.html') && w.log.added.includes('js/practice.js') && w.log.added.includes('index.html'));
    assert.equal(w.log.skipped, 1);
});

test('the activate step deletes the old caches and keeps the current cache', async () => {
    const w = worker();
    let waited;
    w.listeners.activate({ waitUntil: promise => { waited = promise; } });
    await waited;
    assert.deepEqual(w.log.deleted, ['old-v0', 'other']);
    assert.equal(w.log.claimed, 1);
});

test('the worker does not touch other requests: API, WebSocket, other pages, other methods, other origins', async () => {
    const w = worker();
    for (const request of [
        get('https://scores.test/api/events/ABC123'), get('https://scores.test/ws/ABC123'), get('https://scores.test/host.html'),
        get('https://scores.test/js/host.js'), get('https://scores.test/js/client.js'), get('https://other.test/practice.html'),
        { method: 'POST', url: 'https://scores.test/practice.html' }, { method: 'PUT', url: 'https://scores.test/js/practice.js' },
    ]) assert.equal((await w.run(request)).handled, false, request.url);
    assert.deepEqual(w.log.fetched, []);
});

test('a listed file loads from the network, and the worker keeps a copy', async () => {
    const w = worker();
    for (const url of ['https://scores.test/practice.html', 'https://scores.test/', 'https://scores.test/index.html', 'https://scores.test/js/scoring.js']) {
        const result = await w.run(get(url));
        assert.equal(result.handled, true, url);
        assert.equal(result.answer.tag, 'network', url);
    }
    assert.equal(w.log.puts.length, 4);
});

test('a listed file with a query is handled like the file', async () => {
    const w = worker();
    assert.equal((await w.run(get('https://scores.test/practice.html?x=1#top'))).handled, true);
});

test('without a network the worker answers with the copy', async () => {
    let offline = false;
    const w = worker({ network: () => (offline ? new Error('offline') : { ok: true, clone: () => ({ copy: true }), tag: 'network' }) });
    await w.run(get('https://scores.test/practice.html'));
    offline = true;
    const result = await w.run(get('https://scores.test/practice.html'));
    assert.deepEqual(result.answer, { copy: true });
});

test('an answer with an error status is not kept', async () => {
    const w = worker({ network: () => ({ ok: false, status: 404, clone: () => ({ copy: true }) }) });
    await w.run(get('https://scores.test/practice.html'));
    assert.deepEqual(w.log.puts, []);
});

// ── offline.js ──────────────────────────────────────────────────────────────
function registrar(navigator) {
    const listeners = {};
    const context = vm.createContext({ console: { warn() {} }, navigator, window: { addEventListener: (type, fn) => { listeners[type] = fn; } } });
    vm.runInContext(read('js/offline.js'), context, { filename: 'offline.js' });
    return listeners;
}

test('the page registers the worker after it loads', async () => {
    const calls = [];
    const listeners = registrar({ serviceWorker: { register: async file => { calls.push(file); } } });
    assert.deepEqual(calls, []);
    listeners.load();
    assert.deepEqual(calls, ['sw.js']);
});

test('a refused registration and a browser without workers do not stop the page', async () => {
    const refused = registrar({ serviceWorker: { register: () => Promise.reject(new Error('refused')) } });
    refused.load();
    await tick();
    assert.deepEqual(registrar({}), {});
});

// ── A slow network: the page must open ──────────────────────────────────────
test('a network that does not answer gives the copy after a short time', async () => {
    const w = worker();
    await w.run(get('https://scores.test/practice.html')); // The worker keeps a copy.
    const hang = new Promise(() => {});
    const slow = worker({ network: () => hang });
    slow.store.set('https://scores.test/practice.html', { copy: 'old' });
    const state = slow.start(get('https://scores.test/practice.html'));
    await tick(); await tick();
    assert.equal(state.done, false, 'the worker waits for the network at first');
    const timeout = slow.timers.find(timer => timer.ms >= 1000 && timer.ms <= 5000);
    assert.ok(timeout, 'the worker sets a time limit of a few seconds');
    timeout.fn();
    assert.deepEqual(await state.answer, { copy: 'old' });
});

test('a slow network without a copy: the page waits for the network', async () => {
    let answer;
    const network = new Promise(resolve => { answer = resolve; });
    const w = worker({ network: () => network });
    const state = w.start(get('https://scores.test/practice.html'));
    await tick(); await tick();
    w.timers.find(timer => timer.ms >= 1000 && timer.ms <= 5000).fn();
    await tick(); await tick();
    assert.equal(state.done, false);
    answer({ ok: true, clone: () => ({ copy: true }), tag: 'late' });
    assert.equal((await state.answer).tag, 'late');
});

test('a fast network answer is used, and it does not wait for the time limit', async () => {
    const w = worker();
    const result = await w.run(get('https://scores.test/practice.html'));
    assert.equal(result.answer.tag, 'network');
});

test('a server error answer (the server is down behind a proxy) gives the copy', async () => {
    let down = false;
    const w = worker({ network: () => (down ? { ok: false, status: 502, clone: () => ({}) } : { ok: true, clone: () => ({ copy: 'good' }), tag: 'network' }) });
    await w.run(get('https://scores.test/practice.html'));
    down = true;
    assert.deepEqual((await w.run(get('https://scores.test/practice.html'))).answer, { copy: 'good' });
});

test('a server error answer without a copy is shown, and an error of the client (404) is not replaced', async () => {
    const w = worker({ network: () => ({ ok: false, status: 502, clone: () => ({}) }) });
    assert.equal((await w.run(get('https://scores.test/practice.html'))).answer.status, 502);
    const missing = worker({ network: () => ({ ok: false, status: 404, clone: () => ({}) }) });
    missing.store.set('https://scores.test/practice.html', { copy: 'old' });
    assert.equal((await missing.run(get('https://scores.test/practice.html'))).answer.status, 404);
});

test('every file that the worker keeps exists, so the install does not fail', () => {
    const list = read('sw.js').match(/const FILES = \[([\s\S]*?)\];/)[1];
    const files = [...list.matchAll(/'([^']+)'/g)].map(match => match[1]).filter(file => file !== './');
    assert.ok(files.length > 5);
    for (const file of files) assert.ok(fs.existsSync(path.join(__dirname, '..', file)), `missing: ${file}`);
});

test('the worker keeps every script and stylesheet of the home page and of the practice page', () => {
    const list = read('sw.js').match(/const FILES = \[([\s\S]*?)\];/)[1];
    const files = new Set([...list.matchAll(/'([^']+)'/g)].map(match => match[1]));
    for (const page of ['index.html', 'practice.html']) {
        assert.ok(files.has(page), `${page} is not kept`);
        const html = read(page);
        const used = [...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*\shref)="([^"]+)"/g)].map(match => match[1]).filter(url => !/^(https?:)?\/\//.test(url));
        assert.ok(used.length > 3, `${page}: no assets found`);
        for (const url of used) assert.ok(files.has(url), `${page} uses ${url}, and sw.js does not keep it`);
    }
});
