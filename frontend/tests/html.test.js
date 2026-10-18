// Checks of the pages that a Content-Security-Policy needs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const frontend = path.join(__dirname, '..');
const pages = fs.readdirSync(frontend).filter(name => name.endsWith('.html'));
const scripts = fs.readdirSync(path.join(frontend, 'js')).filter(name => name.endsWith('.js'));
const read = file => fs.readFileSync(path.join(frontend, file), 'utf8');

test('the pages have no inline event attribute, no inline script, and no javascript URL', () => {
    for (const file of [...pages, ...scripts.map(name => `js/${name}`)]) {
        const text = read(file);
        assert.doesNotMatch(text, /\son[a-z]+\s*=\s*["']/i, `${file} has an inline event attribute`);
        assert.doesNotMatch(text, /<script(?![^>]*\ssrc=)[^>]*>/i, `${file} has an inline script`);
        assert.doesNotMatch(text, /javascript:/i, `${file} has a javascript: URL`);
    }
});

test('each page loads config.js first and its own script last', () => {
    for (const page of ['host', 'client', 'viewer']) {
        const list = [...read(`${page}.html`).matchAll(/<script src="js\/([a-z]+\.js)"><\/script>/g)].map(match => match[1]);
        assert.equal(list[0], 'config.js', page);
        assert.equal(list.at(-1), `${page}.js`, page);
        assert.equal(new Set(list).size, list.length, `${page} loads a script two times`);
    }
});

test('each page loads the scripts that its script needs, before it', () => {
    const needs = {
        host: ['storage.js', 'api.js', 'websocket.js', 'ranking.js', 'actions.js'],
        client: ['storage.js', 'api.js', 'websocket.js'],
        viewer: ['storage.js', 'api.js', 'websocket.js', 'ranking.js', 'actions.js'],
    };
    for (const [page, required] of Object.entries(needs)) {
        const list = [...read(`${page}.html`).matchAll(/<script src="js\/([a-z]+\.js)"><\/script>/g)].map(match => match[1]);
        for (const name of required) assert.ok(list.includes(name) && list.indexOf(name) < list.indexOf(`${page}.js`), `${page}.html needs ${name} before ${page}.js`);
    }
    const index = [...read('index.html').matchAll(/<script src="js\/([a-z]+\.js)"><\/script>/g)].map(match => match[1]);
    assert.ok(index.includes('actions.js'), 'index.html needs actions.js');
});

test('every action name in a page is registered by the script of that page', () => {
    for (const page of ['host', 'viewer', 'index']) {
        const html = read(`${page}.html`);
        const script = page === 'index' ? '' : read(`js/${page}.js`);
        const names = new Set([...(html + script).matchAll(/data-(?:click|dblclick|change|blur|enter|submit|backdrop)="([A-Za-z]+)"/g)].map(match => match[1]));
        const registered = new Set([...script.matchAll(/registerActions\(\{([\s\S]*?)\n\}\);/g)].flatMap(match => [...match[1].matchAll(/^\s{4}([A-Za-z]+):/gm)].map(item => item[1])));
        for (const name of names) assert.ok(name === 'navigate' || registered.has(name), `${page}: "${name}" is not registered`);
    }
});
