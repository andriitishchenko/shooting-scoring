const assert = require('node:assert/strict');
const test = require('node:test');
const { browserContext } = require('./helpers');

function scoring() {
    const b = browserContext();
    b.load('scoring.js');
    return b;
}
const plain = value => JSON.parse(JSON.stringify(value));
const shot = (number, score, isX = false) => ({ participant_id: 4, shot: number, score, is_x: isX });
const labels = list => list.map(item => `${item.shot}:${item.is_x ? 'X' : item.score}`);

test('the shots of a series are ordered from the highest to the lowest', () => {
    const b = scoring();
    b.context.input = [shot(1, 9), shot(2, 10), shot(3, 5)];
    assert.deepEqual(labels(plain(b.run('sortSeries(input)'))), ['1:10', '2:9', '3:5']);
    b.context.input = [shot(1, 0), shot(2, 5), shot(3, 2)];
    assert.deepEqual(labels(plain(b.run('sortSeries(input)'))), ['1:5', '2:2', '3:0']);
});

test('an X comes before a 10, and equal shots stay together', () => {
    const b = scoring();
    b.context.input = [shot(1, 10), shot(2, 10, true), shot(3, 10)];
    assert.deepEqual(labels(plain(b.run('sortSeries(input)'))), ['1:X', '2:10', '3:10']);
    b.context.input = [shot(1, 7), shot(2, 7), shot(3, 8)];
    assert.deepEqual(labels(plain(b.run('sortSeries(input)'))), ['1:8', '2:7', '3:7']);
});

test('each series is ordered alone, and a shot stays in its own series', () => {
    const b = scoring();
    b.context.input = [shot(1, 1), shot(2, 2), shot(3, 3), shot(4, 6), shot(5, 9), shot(6, 0), shot(7, 4)];
    assert.deepEqual(labels(plain(b.run('sortSeries(input)'))), ['1:3', '2:2', '3:1', '4:9', '5:6', '6:0', '7:4']);
});

test('a series that is not full has its shots at the start', () => {
    const b = scoring();
    b.context.input = [shot(2, 9), shot(3, 5), shot(6, 10)];
    assert.deepEqual(labels(plain(b.run('sortSeries(input)'))), ['1:9', '2:5', '4:10']);
});

test('sorting does not change the list, keeps the other fields, and accepts an empty list', () => {
    const b = scoring();
    b.context.input = [shot(1, 5), shot(2, 9)];
    const before = JSON.stringify(b.context.input);
    const sorted = plain(b.run('sortSeries(input)'));
    assert.equal(JSON.stringify(b.context.input), before);
    assert.ok(sorted.every(item => item.participant_id === 4));
    assert.deepEqual(plain(b.run('sortSeries([])')), []);
});

test('the score of a series and the score up to a series', () => {
    const b = scoring();
    b.context.input = [shot(1, 10), shot(2, 9), shot(3, 5), shot(4, 8), shot(5, 1)];
    assert.equal(b.run('seriesScore(input, 1)'), 24);
    assert.equal(b.run('seriesScore(input, 2)'), 9);
    assert.equal(b.run('cumScore(input, 1)'), 24);
    assert.equal(b.run('cumScore(input, 2)'), 33);
});

test('removing the last shot removes the shot that the user entered last', () => {
    const b = scoring();
    b.context.input = [shot(1, 10), shot(2, 9), shot(3, 5)];
    // The user entered 9 last: the other shots stay, and the series is ordered again.
    assert.deepEqual(labels(plain(b.run('removeLastShot(input, { score: 9, is_x: false })'))), ['1:10', '2:5']);
    // Without a hint, or when no shot of the last series matches, the lowest shot goes.
    assert.deepEqual(labels(plain(b.run('removeLastShot(input, null)'))), ['1:10', '2:9']);
    assert.deepEqual(labels(plain(b.run('removeLastShot(input, { score: 3, is_x: false })'))), ['1:10', '2:9']);
});

test('removing the last shot works in the last series that has shots, and with an X', () => {
    const b = scoring();
    b.context.input = [shot(1, 10), shot(2, 9), shot(3, 8), shot(4, 10, true), shot(5, 10)];
    assert.deepEqual(labels(plain(b.run('removeLastShot(input, { score: 10, is_x: true })'))), ['1:10', '2:9', '3:8', '4:10']);
    assert.deepEqual(labels(plain(b.run('removeLastShot(input, { score: 10, is_x: false })'))), ['1:10', '2:9', '3:8', '4:X']);
    assert.deepEqual(plain(b.run('removeLastShot([], null)')), []);
});

test('the label of a shot is X or the number, and a miss is 0', () => {
    const b = scoring();
    assert.equal(b.run('shotLabel({ score: 10, is_x: true })'), 'X');
    assert.equal(b.run('shotLabel({ score: 9, is_x: false })'), '9');
    assert.equal(b.run('shotLabel({ score: 0, is_x: false })'), '0');
});
