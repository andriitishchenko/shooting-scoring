const assert = require('node:assert/strict');
const test = require('node:test');
const { browserContext } = require('./helpers');
function apiContext(fetch) {
    const b = browserContext(); b.context.fetch = fetch;
    b.load('api.js'); return b;
}

test('API errors show validation fields and retain the HTTP status', async () => {
    const b = apiContext(async () => new Response(JSON.stringify({ detail: [{ loc: ['body', 'shots', 0, 'score'], msg: 'Input should be less than or equal to 10' }] }), { status: 422 }));
    await assert.rejects(b.run(`api.getEvent('ABC123')`), error => error.status === 422 && /shots.0.score: Input/.test(error.message));
});
test('API accepts an empty success response', async () => {
    const b = apiContext(async () => new Response(null, { status: 204 }));
    assert.equal(await b.run(`api.getEvent('ABC123')`), null);
});
test('API errors without JSON remain readable and retain Retry-After', async () => {
    const b = apiContext(async () => new Response('Service unavailable', { status: 503, headers: { 'Retry-After': '30' } }));
    await assert.rejects(b.run(`api.getEvent('ABC123')`), error => error.status === 503 && error.retryAfter === '30' && /503/.test(error.message));
});
test('API request timeout aborts a stuck request and releases the next request', async () => {
    let requests = 0, aborted = 0;
    const b = apiContext(async (url, options) => {
        if (++requests > 1) return new Response('{}');
        return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => { aborted++; reject(new Error('Aborted')); }));
    });
    await assert.rejects(b.run(`api.getEvent('ABC123')`), error => error.kind === 'timeout');
    assert.equal(aborted, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(await b.run(`api.getEvent('ABC123')`))), {});
});
test('API caller cancellation remains separate from timeout', async () => {
    const b = apiContext((url, options) => new Promise((resolve, reject) => {
        if (options.signal.aborted) reject(new Error('Aborted'));
        else options.signal.addEventListener('abort', () => reject(new Error('Aborted')));
    }));
    b.context.cancel = new AbortController();
    const pending = b.run(`api.request('/health', { signal: cancel.signal })`);
    b.context.cancel.abort();
    await assert.rejects(pending, error => error.kind === 'cancelled');
});
test('all API methods encode the event code in the URL path', async () => {
    const urls = [];
    const b = apiContext(async url => { urls.push(url); return new Response('{}'); });
    await b.run(`Promise.all([
        api.getEvent('A/B?'), api.getDistances('A/B?'), api.getParticipants('A/B?'),
        api.getParticipantState('A/B?', 1), api.getDistanceDetail('A/B?', 1, 2),
        api.getLeaderboard('A/B?'), api.getPublicProperties('A/B?'),
        api.laneLogin('A/B?', 1), api.hostLogin('A/B?', ''), api.viewerLogin('A/B?', ''),
        api.replaceDistanceResults('A/B?', 1, 2, [], 'token'), api.getProperties('A/B?')
    ])`);
    assert.equal(urls.length, 12);
    for (const url of urls) assert.match(url, /A%2FB%3F/);
});
test('renamed storage preserves existing browser keys and the native Storage constructor', () => {
    const b = browserContext();
    b.context.Storage = function NativeStorage() {};
    b.storage.saveHostSession('saved-token');
    assert.equal(b.values.get('host_session_id'), '"saved-token"');
    assert.equal(b.context.Storage.name, 'NativeStorage');
});

test('a rate limit answer tells the user how long to wait', async () => {
    const answer = seconds => new Response(JSON.stringify({ detail: 'Too many failed login attempts. Try again later.' }), { status: 429, headers: { 'Retry-After': String(seconds) } });
    let b = apiContext(async () => answer(900));
    await assert.rejects(b.run(`api.getEvent('ABC123')`), error => error.status === 429 && error.message === 'Too many failed login attempts. Try again later. Wait 15 minutes.');
    b = apiContext(async () => answer(45));
    await assert.rejects(b.run(`api.getEvent('ABC123')`), error => /Wait 45 seconds\.$/.test(error.message));
    b = apiContext(async () => answer(1));
    await assert.rejects(b.run(`api.getEvent('ABC123')`), error => /Wait 1 second\.$/.test(error.message));
    b = apiContext(async () => answer(61));
    await assert.rejects(b.run(`api.getEvent('ABC123')`), error => /Wait 2 minutes\.$/.test(error.message));
    b = apiContext(async () => new Response(JSON.stringify({ detail: 'Too many requests.' }), { status: 429 }));
    await assert.rejects(b.run(`api.getEvent('ABC123')`), error => error.message === 'Too many requests.');
});
