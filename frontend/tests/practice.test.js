// The practice page counts the score of one person on one device. It needs no server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { browserContext } = require('./helpers');
const plain = value => JSON.parse(JSON.stringify(value));
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function practicePage(values) {
    const b = browserContext();
    if (values) for (const [key, value] of values) b.values.set(key, value);
    b.context.window.location.pathname = '/practice.html';
    b.load('scoring.js');
    b.load('actions.js');
    b.load('practice.js');
    b.get('practice-setup').className = 'screen';
    b.get('practice-screen').className = 'screen hidden';
    b.get('arrows-input').value = '30';
    for (const handler of b.windowListeners.DOMContentLoaded ?? []) handler();
    return b;
}
const screenOf = b => (b.get('practice-screen').classList.contains('hidden') ? 'setup' : 'score');
const shown = b => b.document.querySelectorAll('.shot-btn').map(button => String(button.textContent));
const start = (b, count) => { b.get('arrows-input').value = String(count); b.run('startPractice()'); };
const enter = (b, ...scores) => scores.forEach(score => b.run(score === 'X' ? 'practiceScore(10, true)' : `practiceScore(${score}, false)`));

test('the page opens on the start screen, and the page has no code that talks to a server', () => {
    const b = practicePage();
    assert.equal(screenOf(b), 'setup');
    const code = read('js/practice.js') + read('js/scoring.js');
    for (const word of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'api.', 'sendBeacon'])
        assert.equal(code.includes(word), false, `practice code uses ${word}`);
    assert.match(read('practice.html'), /id="arrows-input"[^>]*value="30"/, 'the default is 30 arrows');
    assert.doesNotMatch(read('practice.html'), /js\/(api|websocket)\.js/);
});

test('the user starts with the number of arrows, and the score form shows the series', () => {
    const b = practicePage();
    start(b, 12);
    assert.equal(screenOf(b), 'score');
    assert.equal(shown(b).length, 12);
    assert.equal(b.get('total-score').textContent, 0);
    assert.equal(b.get('practice-status').textContent, '0 / 12 arrows');
    assert.deepEqual(plain(b.storage.getPractice()), { shots: 12, results: [] });
});

test('an empty field means 30 arrows', () => {
    const b = practicePage();
    start(b, '');
    assert.equal(shown(b).length, 30);
});

test('a number that is not valid is refused with a message, and nothing starts', () => {
    for (const value of ['0', '-3', '301', '2.5', 'abc', '1e2']) {
        const b = practicePage();
        start(b, value);
        assert.equal(screenOf(b), 'setup', `value ${value}`);
        assert.equal(b.storage.getPractice(), null, `value ${value}`);
        assert.equal(b.get('practice-error').classList.contains('hidden'), false, `value ${value}`);
    }
    const b = practicePage();
    start(b, 1);
    assert.equal(shown(b).length, 1);
    const c = practicePage();
    start(c, 300);
    assert.equal(shown(c).length, 300);
});

test('the buttons enter the shots, and each series is ordered from the highest to the lowest', () => {
    const b = practicePage();
    start(b, 6);
    enter(b, 5, 9, 10, 0, 2, 'X');
    assert.deepEqual(shown(b), ['10', '9', '5', 'X', '2', '0']);
    assert.equal(b.get('total-score').textContent, 36);
    assert.equal(b.get('practice-status').textContent, '6 / 6 arrows');
});

test('the score is saved on the device after each shot', () => {
    const b = practicePage();
    start(b, 3);
    enter(b, 4, 8);
    assert.deepEqual(plain(b.storage.getPractice()), { shots: 3, results: [{ shot: 1, score: 8, is_x: false }, { shot: 2, score: 4, is_x: false }] });
});

test('after a reload the page shows the same score form', () => {
    const first = practicePage();
    start(first, 6);
    enter(first, 7, 'X', 3);
    const second = practicePage(first.values);
    assert.equal(screenOf(second), 'score');
    assert.deepEqual(shown(second), ['X', '7', '3', '', '', '']);
    assert.equal(second.get('total-score').textContent, 20);
});

test('the last shot cannot be exceeded, and the page says that the list is full', () => {
    const b = practicePage();
    start(b, 3);
    enter(b, 9, 9, 9);
    b.run('practiceScore(10, true)');
    assert.deepEqual(shown(b), ['9', '9', '9']);
    assert.equal(b.get('total-score').textContent, 27);
    assert.ok(b.alerts.length >= 1);
});

test('the delete button removes the shot that the user entered last', () => {
    const b = practicePage();
    start(b, 3);
    enter(b, 9, 10); // The 10 is a mistake.
    b.run('deletePracticeScore()');
    assert.deepEqual(shown(b), ['9', '', '']);
    assert.equal(b.get('total-score').textContent, 9);
    b.run('deletePracticeScore()');
    b.run('deletePracticeScore()'); // Nothing left: no error.
    assert.deepEqual(shown(b), ['', '', '']);
    assert.deepEqual(plain(b.storage.getPractice().results), []);
});

test('a second tap on a shot clears it, and the shots below it move up', () => {
    const b = practicePage();
    start(b, 3);
    enter(b, 9, 7, 5);
    b.context.clicked = b.document.querySelectorAll('.shot-btn')[0];
    b.run('selectPracticeShot(1, 1, { currentTarget: clicked }); selectPracticeShot(1, 1, { currentTarget: clicked });');
    assert.deepEqual(shown(b), ['7', '5', '']);
    assert.equal(b.get('total-score').textContent, 12);
});

test('a second tap does not clear when the user does not confirm', () => {
    const b = practicePage();
    start(b, 3);
    enter(b, 9, 7);
    b.context.confirm = () => false;
    b.context.clicked = b.document.querySelectorAll('.shot-btn')[0];
    b.run('selectPracticeShot(1, 1, { currentTarget: clicked }); selectPracticeShot(1, 1, { currentTarget: clicked });');
    assert.deepEqual(shown(b), ['9', '7', '']);
});

test('the user can change a shot: the new value takes its place and the series is ordered', () => {
    const b = practicePage();
    start(b, 3);
    enter(b, 9, 7, 5);
    b.context.clicked = b.document.querySelectorAll('.shot-btn')[2];
    b.run('selectPracticeShot(1, 3, { currentTarget: clicked }); practiceScore(10, false);');
    assert.deepEqual(shown(b), ['10', '9', '7']);
});

test('the user can not skip the order of the shots', () => {
    const b = practicePage();
    start(b, 6);
    enter(b, 9, 8, 7);
    b.context.clicked = b.document.querySelectorAll('.shot-btn')[5];
    b.run('selectPracticeShot(2, 3, { currentTarget: clicked }); practiceScore(5, false);');
    assert.deepEqual(shown(b), ['9', '8', '7', '', '', '']);
    assert.ok(b.alerts.length >= 1);
});

test('a new count starts a new list after the user confirms, and the old list is deleted', () => {
    const b = practicePage();
    start(b, 6);
    enter(b, 9);
    b.context.confirm = () => false;
    b.run('newPractice()');
    assert.equal(screenOf(b), 'score');
    assert.notEqual(b.storage.getPractice(), null);
    b.context.confirm = () => true;
    b.run('newPractice()');
    assert.equal(screenOf(b), 'setup');
    assert.equal(b.storage.getPractice(), null);
    start(b, 3);
    assert.deepEqual(shown(b), ['', '', '']);
});

test('a damaged saved list is ignored', () => {
    const bad = [
        '{broken', 'null', '"text"', '[]', '{"shots":0,"results":[]}', '{"shots":301,"results":[]}', '{"shots":"6","results":[]}',
        '{"shots":3,"results":"no"}', '{"shots":3,"results":[{"shot":4,"score":5,"is_x":false}]}',
        '{"shots":3,"results":[{"shot":1,"score":11,"is_x":false}]}', '{"shots":3,"results":[{"shot":1,"score":9,"is_x":true}]}',
        '{"shots":3,"results":[{"shot":1,"score":5,"is_x":false},{"shot":1,"score":6,"is_x":false}]}',
        '{"shots":3,"results":[{"shot":1.5,"score":5,"is_x":false}]}', '{"shots":3,"results":[null]}',
    ];
    for (const text of bad) {
        const b = practicePage(new Map([['practice_session', text]]));
        assert.equal(screenOf(b), 'setup', text);
        start(b, 3);
        assert.deepEqual(shown(b), ['', '', ''], text);
    }
});

test('the page keeps working when the device does not save data', () => {
    const b = practicePage();
    b.context.localStorage.setItem = () => { throw new Error('full'); };
    start(b, 3);
    enter(b, 9, 8);
    assert.deepEqual(shown(b), ['9', '8', '']);
    assert.equal(b.get('total-score').textContent, 17);
});

test('the page registers its actions, and each action name in the page exists', () => {
    const html = read('practice.html') + read('js/practice.js');
    const names = new Set([...html.matchAll(/data-(?:click|dblclick|change|blur|enter|submit|backdrop)="([A-Za-z]+)"/g)].map(match => match[1]));
    const registered = new Set([...read('js/practice.js').matchAll(/registerActions\(\{([\s\S]*?)\n\}\);/g)].flatMap(match => [...match[1].matchAll(/^\s{4}([A-Za-z]+):/gm)].map(item => item[1])));
    assert.ok(names.size >= 4);
    for (const name of names) assert.ok(name === 'navigate' || registered.has(name), `"${name}" is not registered`);
});
