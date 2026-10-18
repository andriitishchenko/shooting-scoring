const assert = require('node:assert/strict');
const test = require('node:test');
const { browserContext, tick } = require('./helpers');
function sockets() {
    const b = browserContext();
    const timers = new Map(); let next = 0;
    b.context.setTimeout = (fn, delay) => { const id = ++next; timers.set(id, { fn, delay }); return id; };
    b.context.clearTimeout = id => timers.delete(id);
    const created = [];
    class Socket {
        constructor(url) { this.url = url; this.readyState = 0; this.sent = []; created.push(this); }
        send(value) { this.sent.push(JSON.parse(value)); }
        open() { this.readyState = 1; this.onopen?.(); }
        message(value) { this.onmessage?.({ data: value }); }
        close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
    }
    b.context.WebSocket = Socket;
    b.load('websocket.js');
    b.run(`client = new WSClient('EVENT/1', 'session-token')`);
    const client = b.run('client');
    return { ...b, timers, created, client, fire() { const [id, timer] = [...timers][0]; timers.delete(id); timer.fn(); } };
}

test('disconnect cancels a scheduled reconnect and removes the online handler', () => {
    const b = sockets(); b.client.connect(); b.created[0].close(1006);
    assert.equal(b.timers.size, 1);
    b.client.disconnect();
    assert.equal(b.timers.size, 0);
    assert.equal(b.windowListeners.online.size, 0);
    assert.equal(b.created.length, 1);
});
test('reconnect continues past ten failures with a bounded delay', () => {
    const b = sockets(); b.client.connect();
    for (let i = 0; i < 25; i++) {
        b.created.at(-1).close(1006);
        assert.equal(b.timers.size, 1);
        assert.ok([...b.timers.values()][0].delay <= 30000);
        b.fire();
    }
    assert.equal(b.created.length, 26);
    b.client.disconnect();
});
test('online reconnects immediately without making duplicate sockets', () => {
    const b = sockets(); b.client.connect(); b.created[0].close(1006);
    [...b.windowListeners.online][0]();
    assert.equal(b.timers.size, 0);
    assert.equal(b.created.length, 2);
    b.client.connect();
    assert.equal(b.created.length, 2);
    b.client.disconnect();
});
test('malformed messages do not prevent later valid messages', () => {
    const b = sockets(); let received = 0;
    b.client.on('refresh', () => received++); b.client.connect();
    b.created[0].message('{bad'); b.created[0].message('null'); b.created[0].message('[]');
    b.created[0].message('{"type":"refresh"}');
    assert.equal(received, 1);
    assert.equal(b.warnings.length, 3);
    b.client.disconnect();
});
test('a failing listener cannot block other listeners', async () => {
    const b = sockets(); let received = 0;
    b.client.on('refresh', () => { throw new Error('Sync error'); });
    b.client.on('refresh', async () => { throw new Error('Async error'); });
    b.client.on('refresh', () => received++);
    b.client.handleMessage({ type: 'refresh' }); await tick();
    assert.equal(received, 1);
    assert.equal(b.warnings.length, 2);
});
test('authentication rejection stops retries and reports the rejected session', () => {
    const b = sockets(); let rejections = 0;
    b.client.on('session_rejected', () => rejections++);
    b.client.connect(); b.created[0].close(1008);
    assert.equal(rejections, 1);
    assert.equal(b.timers.size, 0);
    assert.equal(b.client.stopped, true);
});
test('WebSocket authenticates with a header-free message and encodes the event path', () => {
    const b = sockets(); b.client.connect(); b.created[0].open();
    assert.match(b.created[0].url, /EVENT%2F1$/);
    assert.deepEqual(b.created[0].sent, [{ type: 'authenticate', session_id: 'session-token' }]);
    b.created[0].message('{"type":"authenticated","role":"client"}');
    assert.equal(b.client.authenticated, true);
    b.client.disconnect();
});
test('constructor failures use the same reconnect path', () => {
    const b = sockets(); b.context.WebSocket = class { constructor() { throw new Error('Offline'); } };
    b.client.connect();
    assert.equal(b.timers.size, 1);
    b.fire();
    assert.equal(b.timers.size, 1);
    b.client.disconnect();
});
