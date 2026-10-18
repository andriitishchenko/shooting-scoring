const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const frontend = path.join(__dirname, '..');

// A small fake page. An element has a parent, data attributes, and `closest`.
function node(dataset = {}, parent = null) {
    const element = { dataset, parent, closest(selector) {
        const key = /^\[data-([a-z]+)\]$/.exec(selector)[1];
        for (let current = this; current; current = current.parent) if (key in current.dataset) return current;
        return null;
    } };
    return element;
}

function page() {
    const listeners = {};
    const calls = [];
    const warnings = [];
    const context = vm.createContext({
        document: { addEventListener: (type, fn) => (listeners[type] ||= []).push(fn) },
        location: { href: 'start' },
        console: { error: (...args) => warnings.push(args) },
    });
    vm.runInContext(fs.readFileSync(path.join(frontend, 'js/actions.js'), 'utf8'), context, { filename: 'actions.js' });
    const fire = (type, target, extra = {}) => {
        const event = { target, key: extra.key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
        for (const listener of listeners[type] || []) listener(event);
        return event;
    };
    context.record = (name) => (...args) => calls.push([name, ...args]);
    return { context, calls, warnings, fire, listeners };
}

test('a click runs the registered action with the arguments from the element', () => {
    const p = page();
    vm.runInContext(`registerActions({ add: record('add'), noArgs: record('noArgs') })`, p.context);
    const button = node({ click: 'add', args: '[7, -1, "x"]' });
    p.fire('click', button);
    p.fire('click', node({ click: 'noArgs' }));
    assert.deepEqual(p.calls[0].slice(0, 4), ['add', 7, -1, 'x']);
    assert.equal(p.calls[0][4], button);
    assert.deepEqual(p.calls[1].slice(0, 1), ['noArgs']);
    assert.equal(p.calls[1].length, 3);
});

test('a click on a child of the element runs the action of the element', () => {
    const p = page();
    vm.runInContext(`registerActions({ go: record('go') })`, p.context);
    const button = node({ click: 'go' });
    p.fire('click', node({}, node({}, button)));
    assert.equal(p.calls.length, 1);
});

test('an action that is not registered, or has bad arguments, does nothing', () => {
    const p = page();
    vm.runInContext(`registerActions({ known: record('known') })`, p.context);
    p.fire('click', node({ click: 'unknown' }));
    p.fire('click', node({ click: 'toString' }));
    p.fire('click', node({ click: 'constructor' }));
    p.fire('click', node({ click: '__proto__' }));
    p.fire('click', node({ click: 'known', args: '{broken' }));
    p.fire('click', node({}));
    assert.deepEqual(p.calls, []);
});

test('an argument that is not a list is one argument', () => {
    const p = page();
    vm.runInContext(`registerActions({ one: record('one') })`, p.context);
    p.fire('click', node({ click: 'one', args: '"client"' }));
    assert.equal(p.calls[0][1], 'client');
});

test('a click on the background runs the action, and a click inside does not', () => {
    const p = page();
    vm.runInContext(`registerActions({ close: record('close') })`, p.context);
    const backdrop = node({ backdrop: 'close' });
    const content = node({}, backdrop);
    p.fire('click', content);
    assert.equal(p.calls.length, 0);
    p.fire('click', backdrop);
    assert.equal(p.calls.length, 1);
});

test('a double click runs the double click action, and a single click does not', () => {
    const p = page();
    vm.runInContext(`registerActions({ copy: record('copy') })`, p.context);
    const element = node({ dblclick: 'copy', args: '["ABC123"]' });
    p.fire('click', element);
    assert.equal(p.calls.length, 0);
    p.fire('dblclick', node({}, element));
    assert.equal(p.calls.length, 1);
    assert.equal(p.calls[0][1], 'ABC123');
    assert.equal(p.calls[0][2], element);
    p.fire('dblclick', node({}));
    assert.equal(p.calls.length, 1);
});

test('change, focus out, Enter, and submit have their own attributes', () => {
    const p = page();
    vm.runInContext(`registerActions({ onChange: record('change'), onBlur: record('blur'), onEnter: record('enter'), onSubmit: record('submit') })`, p.context);
    p.fire('change', node({ change: 'onChange' }));
    p.fire('focusout', node({ blur: 'onBlur', args: '[3]' }));
    p.fire('keydown', node({ enter: 'onEnter' }), { key: 'a' });
    assert.deepEqual(p.calls.map(call => call[0]), ['change', 'blur']);
    p.fire('keydown', node({ enter: 'onEnter' }), { key: 'Enter' });
    const submit = p.fire('submit', node({ submit: 'onSubmit' }));
    assert.deepEqual(p.calls.map(call => call[0]), ['change', 'blur', 'enter', 'submit']);
    assert.equal(submit.defaultPrevented, true);
    assert.equal(p.fire('submit', node({})).defaultPrevented, false);
});

test('the action gets the element and the event as the last arguments', () => {
    const p = page();
    vm.runInContext(`registerActions({ see: record('see') })`, p.context);
    const element = node({ click: 'see', args: '[1]' });
    const event = p.fire('click', element);
    assert.equal(p.calls[0][2], element);
    assert.equal(p.calls[0][3].target, element);
    assert.equal(event.target, element);
});

test('a rejected promise of an action is logged and does not stop the page', async () => {
    const p = page();
    vm.runInContext(`registerActions({ fail: () => Promise.reject(new Error('broken')) })`, p.context);
    p.fire('click', node({ click: 'fail' }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(p.warnings.length, 1);
    assert.match(String(p.warnings[0][2]), /broken/);
});

test('an action that throws is logged and does not stop the page', () => {
    const p = page();
    vm.runInContext(`registerActions({ boom: () => { throw new Error('boom'); } })`, p.context);
    assert.doesNotThrow(() => p.fire('click', node({ click: 'boom' })));
    assert.equal(p.warnings.length, 1);
});

test('the built-in action goes to a page of the application only', () => {
    const p = page();
    p.fire('click', node({ click: 'navigate', args: '["host.html"]' }));
    assert.equal(p.context.location.href, 'host.html');
    for (const bad of ['//evil.example', 'https://evil.example/x.html', 'javascript:alert(1)', '../x.html', 'a/b.html', 'host.html?x=1']) {
        p.context.location.href = 'start';
        p.fire('click', node({ click: 'navigate', args: JSON.stringify([bad]) }));
        assert.equal(p.context.location.href, 'start', bad);
    }
});

test('registering again adds to the actions and replaces a name', () => {
    const p = page();
    vm.runInContext(`registerActions({ a: record('first') }); registerActions({ a: record('second'), b: record('b') })`, p.context);
    p.fire('click', node({ click: 'a' }));
    p.fire('click', node({ click: 'b' }));
    assert.deepEqual(p.calls.map(call => call[0]), ['second', 'b']);
});
