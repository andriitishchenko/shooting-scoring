const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function element(id = '') {
    const el = {
        id, className: '', dataset: {}, textContent: '', value: '', disabled: false,
        children: [], listeners: {}, style: {},
        appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
        removeChild(child) { this.children = this.children.filter(item => item !== child); },
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
        removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(item => item !== fn); },
        dispatch(type, event = {}) { return Promise.all((this.listeners[type] || []).map(fn => fn({ target: this, currentTarget: this, preventDefault() {}, ...event }))); },
        attributes: {}, setAttribute(name, value) { this.attributes[name] = String(value); }, getAttribute(name) { return this.attributes[name] ?? null; },
        focus() {}, select() {}, scrollIntoView() {}, reset() { this.resets = (this.resets || 0) + 1; },
        click() { return this.dispatch('click'); },
        replaceChildren(...children) { this.children = children; },
        insertAdjacentHTML(position, html) { this._html = (this._html || '') + html; },
        querySelectorAll() { return []; },
    };
    el.classList = {
        contains: name => el.className.split(' ').includes(name),
        add(...names) { el.className = [...new Set([...el.className.split(' ').filter(Boolean), ...names])].join(' '); },
        remove(...names) { el.className = el.className.split(' ').filter(name => !names.includes(name)).join(' '); },
        toggle(name, enabled) { const on = enabled ?? !this.contains(name); if (on) this.add(name); else this.remove(name); },
    };
    Object.defineProperty(el, 'innerHTML', {
        get: () => el._html || '',
        set: value => { el._html = value; el.children = []; },
    });
    return el;
}

function browserContext() {
    const elements = new Map();
    const get = id => { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); };
    const screens = ['code-screen', 'lane-screen', 'lane-password-screen', 'lane-auth-screen', 'participants-screen', 'add-participant-screen', 'score-screen'];
    screens.forEach(id => { get(id).className = 'screen' + (id === 'code-screen' ? '' : ' hidden'); });
    const windowListeners = {};
    const walk = el => [el, ...el.children.flatMap(walk)];
    const buttons = () => walk(get('score-grid')).filter(el => el.classList.contains('shot-btn'));
    const document = {
        listeners: {}, documentElement: { scrollHeight: 0 },
        getElementById(id) { return elements.get(id) || walk(get('score-grid')).find(el => el.id === id) || get(id); },
        createElement: () => element(), body: element(),
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
        querySelectorAll(selector) {
            if (selector === '.screen') return screens.map(get);
            if (selector === '.shot-btn') return buttons();
            return [];
        },
        querySelector(selector) {
            if (selector === '.screen:not(.hidden)') return screens.map(get).find(el => !el.classList.contains('hidden'));
            const shot = /data-series="(\d+)".*data-shot="(\d+)"/.exec(selector);
            if (shot) return buttons().find(el => Number(el.dataset.series) === Number(shot[1]) && Number(el.dataset.shot) === Number(shot[2]));
            if (selector.includes('button[type="submit"]')) return get('participant-submit');
            if (selector.includes('submit-password')) return get('password-submit');
            const series = /#series-(\d+) .series-total/.exec(selector);
            if (series) return walk(get('score-grid')).find(el => el.id === `series-${series[1]}`)?.children.find(el => el.classList.contains('series-total'));
            return null;
        },
        execCommand: () => true,
    };
    const values = new Map();
    const localStorage = {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: key => values.delete(key),
        key: i => [...values.keys()][i] ?? null,
        get length() { return values.size; },
    };
    const warnings = [], alerts = [];
    const context = vm.createContext({
        window: {
            location: { search: '', pathname: '/client.html' },
            addEventListener(type, fn) { (windowListeners[type] ||= new Set()).add(fn); },
            removeEventListener(type, fn) { windowListeners[type]?.delete(fn); },
            scrollTo() {}, innerHeight: 800,
        },
        document, localStorage, navigator: {}, history: { replaceState() {} },
        console: { warn: (...args) => warnings.push(args), error: (...args) => warnings.push(args) },
        alert: text => alerts.push(text), confirm: () => true,
        CONFIG: { CODE_LENGTH: 6, LANE_COUNT: 28, SERIES_SIZE: 3, REQUEST_TIMEOUT_MS: 15, RESET_POLL_MS: 3000, API_BASE_URL: '/api', WS_BASE_URL: 'ws://scores.test/ws' },
        // A timer of the page must not keep the test process alive (the lane list polls until it is closed).
        setTimeout: (...args) => { const timer = setTimeout(...args); timer.unref?.(); return timer; },
        clearTimeout, setInterval, clearInterval, AbortController, URLSearchParams, URL, Blob,
    });
    const run = script => vm.runInContext(script, context);
    const load = file => vm.runInContext(fs.readFileSync(path.join(__dirname, '../js', file), 'utf8'), context, { filename: file });
    load('storage.js');
    return { context, document, elements, get, values, run, load, windowListeners, warnings, alerts, storage: run('AppStorage'), visible: () => document.querySelector('.screen:not(.hidden)')?.id };
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const tick = () => new Promise(resolve => setImmediate(resolve));
module.exports = { browserContext, deferred, tick, element };
