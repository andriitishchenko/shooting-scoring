// The rules for the shots of a series. The client and the practice page use them.
// A shot is `{ shot, score, is_x }`. The shots of a series are in order from the
// highest to the lowest: X, 10, 9, ... 1, 0.

const _seriesOf = (shot, size) => Math.ceil(shot / size);

// The value that orders the shots. An X is above a 10.
const _shotValue = result => (result.is_x ? 11 : result.score);

// A new list. In each series the shots are ordered from the highest to the lowest,
// and they use the first places of the series. The input list does not change.
function sortSeries(results, size = CONFIG.SERIES_SIZE) {
    const bySeries = new Map();
    for (const result of results) {
        const series = _seriesOf(result.shot, size);
        if (!bySeries.has(series)) bySeries.set(series, []);
        bySeries.get(series).push(result);
    }
    const sorted = [];
    for (const series of [...bySeries.keys()].sort((a, b) => a - b)) {
        bySeries.get(series)
            .sort((a, b) => _shotValue(b) - _shotValue(a) || a.shot - b.shot)
            .forEach((result, index) => sorted.push({ ...result, shot: (series - 1) * size + index + 1 }));
    }
    return sorted;
}

// A new list without the shot that the user entered last. `last` is `{ score, is_x }`
// or null. Look in the last series that has shots. If no shot has the value of `last`,
// remove the lowest shot. The series is ordered again.
function removeLastShot(results, last, size = CONFIG.SERIES_SIZE) {
    if (!results.length) return [];
    const lastSeries = _seriesOf(Math.max(...results.map(result => result.shot)), size);
    const inSeries = results.filter(result => _seriesOf(result.shot, size) === lastSeries);
    const match = last && inSeries.filter(result => result.score === last.score && Boolean(result.is_x) === Boolean(last.is_x));
    const target = (match?.length ? match : inSeries).reduce((best, result) => (result.shot > best.shot ? result : best));
    return sortSeries(results.filter(result => result !== target), size);
}

function seriesScore(results, series, size = CONFIG.SERIES_SIZE) {
    return results.filter(result => _seriesOf(result.shot, size) === series).reduce((sum, result) => sum + result.score, 0);
}

function cumScore(results, upToSeries, size = CONFIG.SERIES_SIZE) {
    return results.filter(result => result.shot <= upToSeries * size).reduce((sum, result) => sum + result.score, 0);
}

function shotLabel(result) {
    return result.is_x ? 'X' : String(result.score);
}
