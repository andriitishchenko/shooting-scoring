// The rules for the shots of a series. The client and the practice page use them.
// A shot is `{ shot, score, is_x }`. The shots of a series are in order from the
// highest to the lowest: X, 10, 9, ... 1, 0. `key` names the field with the shot number.

const _seriesOf = (shot, size) => Math.ceil(shot / size);

// The value that orders the shots. An X is above a 10.
const _shotValue = result => (result.is_x ? 11 : result.score);

// A new list. In each series the shots are ordered from the highest to the lowest,
// and they use the first places of the series. The input list does not change.
function sortSeries(results, size = CONFIG.SERIES_SIZE, key = 'shot') {
    const bySeries = new Map();
    for (const result of results) {
        const series = _seriesOf(result[key], size);
        if (!bySeries.has(series)) bySeries.set(series, []);
        bySeries.get(series).push(result);
    }
    const sorted = [];
    for (const series of [...bySeries.keys()].sort((a, b) => a - b)) {
        bySeries.get(series)
            .sort((a, b) => _shotValue(b) - _shotValue(a) || a[key] - b[key])
            .forEach((result, index) => sorted.push({ ...result, [key]: (series - 1) * size + index + 1 }));
    }
    return sorted;
}

// A new list without the shot that the user entered last. `last` is
// `{ score, is_x, series }` or null. Look in `last.series`. Without `last`, or when that
// series has no shots, look in the last series that has shots. If no shot has the value
// of `last`, remove the lowest shot. The series is ordered again.
function removeLastShot(results, last, size = CONFIG.SERIES_SIZE) {
    if (!results.length) return [];
    const inSeriesOf = series => results.filter(result => _seriesOf(result.shot, size) === series);
    let inSeries = last?.series ? inSeriesOf(last.series) : [];
    if (!inSeries.length) inSeries = inSeriesOf(_seriesOf(Math.max(...results.map(result => result.shot)), size));
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
