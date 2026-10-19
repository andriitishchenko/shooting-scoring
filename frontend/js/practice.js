// PRACTICE — count the score of one person on this device. No server is used.
// The list is saved in the browser, so a reload keeps it.
'use strict';

const PRACTICE_DEFAULT_ARROWS = 30;
const PRACTICE_MAX_ARROWS     = 300;

let practice         = null; // { shots, results: [{ shot, score, is_x }] }
let _practiceCurrent = null; // the slot that gets the next score
let _practiceLast    = null; // the value that the user entered last, for the delete button

window.addEventListener('DOMContentLoaded', () => {
    const saved = AppStorage.getPractice();
    if (!saved) return;
    practice = { shots: saved.shots, results: sortSeries(saved.results) };
    _showPracticeScore();
});

// ── Start ──────────────────────────────────────────────────────────────────
function startPractice() {
    const error = document.getElementById('practice-error');
    const text  = document.getElementById('arrows-input').value.trim();
    const shots = text === '' ? PRACTICE_DEFAULT_ARROWS : (/^\d{1,3}$/.test(text) ? Number(text) : 0);
    if (shots < 1 || shots > PRACTICE_MAX_ARROWS) {
        error.textContent = `Enter a whole number from 1 to ${PRACTICE_MAX_ARROWS}.`;
        error.classList.remove('hidden');
        return;
    }
    error.classList.add('hidden');
    practice = { shots, results: [] };
    _practiceLast = null;
    _savePractice();
    _showPracticeScore();
}

function _showPracticeScore() {
    document.getElementById('practice-setup').classList.add('hidden');
    document.getElementById('practice-screen').classList.remove('hidden');
    _practiceCurrent = _practiceNext();
    renderPracticeGrid();
    _updatePracticeTotals();
}

// Leave the list and go back to the start screen. The user confirms first.
function newPractice() {
    if (practice?.results.length && !confirm('Delete this list and start a new one?')) return;
    practice = null;
    _practiceLast = null;
    AppStorage.clearPractice();
    document.getElementById('practice-screen').classList.add('hidden');
    document.getElementById('practice-setup').classList.remove('hidden');
}

// ── Grid ───────────────────────────────────────────────────────────────────
function _practiceNext() {
    if (!practice) return null;
    for (let shot = 1; shot <= practice.shots; shot++) {
        if (!practice.results.some(result => result.shot === shot)) {
            const series = Math.ceil(shot / CONFIG.SERIES_SIZE);
            return { series, shot: shot - (series - 1) * CONFIG.SERIES_SIZE, shotNum: shot };
        }
    }
    return null;
}

function renderPracticeGrid() {
    const grid = document.getElementById('score-grid');
    grid.innerHTML = '';
    if (!practice) return;
    const size = CONFIG.SERIES_SIZE;
    for (let s = 1; s <= Math.ceil(practice.shots / size); s++) {
        const row = document.createElement('div');
        row.className = 'series-row';
        row.id = `series-${s}`;

        const num = document.createElement('div');
        num.textContent = s;
        row.appendChild(num);

        for (let sh = 1; sh <= size; sh++) {
            const shotNum = (s - 1) * size + sh;
            if (shotNum > practice.shots) break;
            const btn = document.createElement('button');
            btn.className      = 'shot-btn';
            btn.dataset.series = s;
            btn.dataset.shot   = sh;
            btn.onclick = event => selectPracticeShot(s, sh, event);
            const result = practice.results.find(item => item.shot === shotNum);
            if (result) { btn.textContent = shotLabel(result); btn.classList.add('filled'); }
            if (!result && _practiceCurrent?.shotNum === shotNum) btn.classList.add('selected');
            row.appendChild(btn);
        }

        const total = document.createElement('div');
        total.className = 'series-total';
        total.innerHTML = `${seriesScore(practice.results, s)}<br>${cumScore(practice.results, s)}`;
        row.appendChild(total);
        grid.appendChild(row);
    }
    if (_practiceCurrent) document.getElementById(`series-${_practiceCurrent.series}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function _updatePracticeTotals() {
    const results = practice?.results ?? [];
    const tens = results.filter(result => result.score === 10).length;
    document.getElementById('total-score').textContent = results.reduce((sum, result) => sum + result.score, 0);
    document.getElementById('practice-status').textContent = `${results.length} / ${practice?.shots ?? 0} arrows`;
    document.getElementById('practice-stats').textContent = `10: ${tens} · X: ${results.filter(result => result.is_x).length}`;
}

function _savePractice() {
    const saved = AppStorage.savePractice({ shots: practice.shots, results: practice.results });
    document.getElementById('practice-note').textContent = saved ? '' : 'Not saved on this device. Do not reload the page.';
}

// ── Input ──────────────────────────────────────────────────────────────────
function selectPracticeShot(series, shot, event) {
    const shotNum = (series - 1) * CONFIG.SERIES_SIZE + shot;
    const button  = event.currentTarget;
    if (practice.results.some(result => result.shot === shotNum) && button.classList.contains('selected')) {
        if (!confirm('Clear this score?')) return;
        practice.results = sortSeries(practice.results.filter(result => result.shot !== shotNum));
        _practiceLast = null;
        _afterPracticeChange();
        return;
    }
    _practiceCurrent = { series, shot, shotNum };
    document.querySelectorAll('.shot-btn').forEach(item => item.classList.remove('selected'));
    button.classList.add('selected');
}

function practiceScore(score, isX = false) {
    if (!practice) return;
    const next    = _practiceNext();
    const editing = _practiceCurrent && practice.results.some(result => result.shot === _practiceCurrent.shotNum);
    if (!next && !editing) { alert('All arrows are filled.'); return; }
    if (_practiceCurrent && !editing && _practiceCurrent.shotNum !== next.shotNum) {
        alert(`Fill in order. Next: Series ${next.series}, Shot ${next.shot}`);
        _practiceCurrent = next;
        renderPracticeGrid();
        return;
    }
    const target = _practiceCurrent ?? next;
    practice.results = sortSeries([
        ...practice.results.filter(result => result.shot !== target.shotNum),
        { shot: target.shotNum, score, is_x: Boolean(isX) },
    ]);
    _practiceLast = { score, is_x: Boolean(isX) };
    _afterPracticeChange();
}

function deletePracticeScore() {
    if (!practice?.results.length) return;
    practice.results = removeLastShot(practice.results, _practiceLast);
    _practiceLast = null;
    _afterPracticeChange();
}

function _afterPracticeChange() {
    _practiceCurrent = _practiceNext();
    _savePractice();
    renderPracticeGrid();
    _updatePracticeTotals();
}

// ============================================================
// ACTIONS (the page has no inline handlers; see actions.js)
// ============================================================
registerActions({
    startPractice: () => startPractice(),
    practiceScore: (score, isX) => practiceScore(score, isX === true),
    deletePracticeScore: () => deletePracticeScore(),
    newPractice: () => newPractice(),
});
