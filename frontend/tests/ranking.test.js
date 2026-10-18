const assert = require('node:assert/strict');
const test = require('node:test');
const { browserContext } = require('./helpers');

function ranking() {
    const b = browserContext();
    b.load('ranking.js');
    return b;
}
const entry = (name, total, tens, xs) => ({ name, total_score: total, ten_count: tens, x_count: xs });
const names = list => list.map(item => item.entry.name);
const plain = value => JSON.parse(JSON.stringify(value));

test('more points rank first, then more 10s, then more X', () => {
    const b = ranking();
    b.context.list = [entry('plain', 27, 2, 0), entry('tens', 27, 3, 0), entry('x', 27, 2, 1), entry('top', 30, 0, 0), entry('low', 20, 9, 9)];
    const ranked = plain(b.run('rankEntries(list)'));
    assert.deepEqual(names(ranked), ['top', 'tens', 'x', 'plain', 'low']);
    assert.deepEqual(ranked.map(item => item.rank), [1, 2, 3, 4, 5]);
});

test('entries that are equal in all three values share a rank, and the next rank skips', () => {
    const b = ranking();
    b.context.list = [entry('a', 27, 2, 1), entry('b', 27, 2, 1), entry('c', 27, 2, 1), entry('d', 26, 9, 9), entry('e', 25, 0, 0), entry('f', 25, 0, 0)];
    assert.deepEqual(plain(b.run('rankEntries(list)')).map(item => item.rank), [1, 1, 1, 4, 5, 5]);
});

test('equal entries keep the order of the list', () => {
    const b = ranking();
    b.context.list = [entry('first', 10, 1, 0), entry('second', 10, 1, 0), entry('third', 10, 1, 0)];
    assert.deepEqual(names(plain(b.run('rankEntries(list)'))), ['first', 'second', 'third']);
});

test('missing counts are zero, and the list does not change', () => {
    const b = ranking();
    b.context.list = [{ name: 'none', total_score: 5 }, entry('some', 5, 1, 0)];
    const before = JSON.stringify(b.context.list);
    assert.deepEqual(names(plain(b.run('rankEntries(list)'))), ['some', 'none']);
    assert.equal(JSON.stringify(b.context.list), before);
    assert.deepEqual(plain(b.run('rankEntries([])')), []);
});

test('the comparison gives a negative, zero, or positive number', () => {
    const b = ranking();
    assert.ok(b.run('compareEntries({ total_score: 9 }, { total_score: 8 })') < 0);
    assert.ok(b.run('compareEntries({ total_score: 8 }, { total_score: 9 })') > 0);
    assert.equal(b.run('compareEntries({ total_score: 9, ten_count: 1, x_count: 1 }, { total_score: 9, ten_count: 1, x_count: 1 })'), 0);
    assert.ok(b.run('compareEntries({ total_score: 9, ten_count: 2 }, { total_score: 9, ten_count: 1, x_count: 5 })') < 0);
});
