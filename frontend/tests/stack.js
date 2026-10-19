// Shared stack: the real Node server, with a browser context for the real scripts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { browserContext } = require('./helpers');

const CODE = 'CNTR01';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, message, timeout = 4000) {
    const end = Date.now() + timeout;
    for (;;) {
        const value = await check();
        if (value) return value;
        if (Date.now() > end) assert.fail(`Timed out: ${message}`);
        await wait(25);
    }
}

async function stack(t, { shots = 6 } = {}) {
    const { createApp } = await import('../../backend-node/src/app.js');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'client-contract-'));
    const app = createApp({ dataDir: directory, origins: [], passwordCost: 10, logLevel: 'error' });
    const port = await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${port}`;
    const clients = [];
    t.after(() => {
        for (const client of clients) client.run('typeof wsClient !== "undefined" && wsClient?.disconnect(); typeof exitViewer === "function" && exitViewer(true)');
        return app.close().then(() => fs.rmSync(directory, { recursive: true, force: true }));
    });
    const call = async (method, url, data, sid) => {
        const response = await fetch(base + url, {
            method,
            headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...(sid ? { 'X-Session-Id': sid } : {}) },
            body: data === undefined ? undefined : JSON.stringify(data),
        });
        return { status: response.status, data: await response.json() };
    };
    const created = (await call('POST', '/api/events/create', { code: CODE, shots_count: shots })).data;
    const host = created.session_id;
    const participant = (await call('POST', `/api/participants/${CODE}`, { name: 'Archer', lane_number: 1, shift: 'A' }, host)).data.id;
    const distance = (await call('GET', `/api/distances/${CODE}`)).data[0].id;
    const start = async () => {
        await call('PATCH', `/api/events/${CODE}`, { status: 'started' }, host);
        await call('PATCH', `/api/distances/${CODE}/${distance}`, { status: 'active' }, host);
    };
    const state = async () => (await call('GET', `/api/results/${CODE}/state/${participant}`)).data.distances[0];
    const control = { down: false, log: [] };
    const makePage = (files, values = null) => {
        const b = browserContext();
        b.context.CONFIG = {
            CODE_LENGTH: 6, LANE_COUNT: 28, SERIES_SIZE: 3, REQUEST_TIMEOUT_MS: 5000, RESET_POLL_MS: 40,
            API_BASE_URL: `${base}/api`, WS_BASE_URL: `${base.replace('http', 'ws')}/ws`,
        };
        b.context.fetch = (url, ...args) => {
            control.log.push(String(url).replace(base, ''));
            return control.down ? Promise.reject(new TypeError('fetch failed')) : fetch(url, ...args);
        };
        b.context.WebSocket = WebSocket;
        for (const file of files) b.load(file);
        if (values) for (const [key, value] of values) b.values.set(key, value);
        clients.push(b);
        return b;
    };
    const makeClient = values => makePage(['api.js', 'websocket.js', 'scoring.js', 'client.js'], values);
    const makeHost = () => makePage(['api.js', 'websocket.js', 'ranking.js', 'scoring.js', 'actions.js', 'host.js']);
    const makeViewer = () => makePage(['api.js', 'websocket.js', 'ranking.js', 'actions.js', 'viewer.js']);
    return { call, host, hostPassword: created.host_password, participant, distance, start, state, makeClient, makeHost, makeViewer, makePage, base, control };
}

async function loginToLane(s, b) {
    b.get('code-input').value = CODE;
    await b.run('clientEnter()');
    assert.equal(b.visible(), 'lane-screen');
    await b.run('selectLane(1)');
}

async function openScoring(s, b) {
    await loginToLane(s, b);
    await b.run('proceedAfterPassword()');
    await s.start();
    await waitFor(() => b.run("eventData?.status === 'started' && distances.some(d => d.status === 'active')"), 'client sees the started event');
    await b.run(`openScoreInput(${s.participant})`);
    assert.equal(b.visible(), 'score-screen');
}


module.exports = { CODE, wait, waitFor, stack, loginToLane, openScoring };
