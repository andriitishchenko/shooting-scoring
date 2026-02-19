// Client JavaScript
let currentCode = null;
let currentLane = null;
let currentParticipant = null;
let eventData = null;
let distances = [];        // all distances for this event
let participants = [];
let results = [];          // shots for ACTIVE distance only
let participantState = null; // full state from server (per-distance summaries)
let wsClient = null;

// ============================================
// INIT
// ============================================

window.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    const urlCode = params.get('code');
    if (urlCode) {
        params.delete('code');
        history.replaceState(null, '', window.location.pathname + (params.toString() ? '?' + params.toString() : ''));
        Storage.clearEventCode('client');
        Storage.clearLane();
        document.getElementById('code-input').value = urlCode.toUpperCase();
        clientEnter();
        return;
    }

    const savedCode = Storage.getEventCode('client');
    const savedLane = Storage.getLane();
    if (savedCode && savedLane) {
        currentCode = savedCode;
        currentLane = savedLane;
        clientRestoreConnections();
        document.getElementById('code-screen').classList.add('hidden');
        document.getElementById('lane-screen').classList.remove('hidden');
        loadLaneParticipants();
    }
});

async function clientRestoreConnections() {
    try {
        eventData = await api.getEvent(currentCode);
        distances = await api.getDistances(currentCode);
        wsClient = new WSClient(currentCode);
        wsClient.connect();
        wsClient.on('event_status', handleEventStatus);
        wsClient.on('refresh', () => loadLaneParticipants());
    } catch (error) {
        alert('Event not found: ' + error.message);
    }
}

async function clientEnter() {
    const code = document.getElementById('code-input').value.trim().toUpperCase();
    if (code.length !== CONFIG.CODE_LENGTH) { alert('Invalid code length'); return; }
    try {
        eventData = await api.getEvent(code);
        distances = await api.getDistances(code);
        currentCode = code;
        Storage.saveEventCode(code, 'client');
        showLaneSelection();
        wsClient = new WSClient(currentCode);
        wsClient.connect();
        wsClient.on('event_status', handleEventStatus);
        wsClient.on('refresh', () => loadLaneParticipants());
    } catch (error) {
        alert('Event not found: ' + error.message);
    }
}

// ============================================
// LANE SELECTION
// ============================================

function showLaneSelection() {
    document.getElementById('code-screen').classList.add('hidden');
    document.getElementById('lane-screen').classList.remove('hidden');
    const container = document.getElementById('lane-buttons');
    container.innerHTML = '';
    container.className = 'lane-buttons';
    for (let i = 1; i <= 20; i++) {
        const btn = document.createElement('button');
        btn.className = 'btn btn-secondary lane-btn';
        btn.textContent = i;
        btn.onclick = () => selectLane(i);
        container.appendChild(btn);
    }
}

async function selectLane(laneNumber) {
    currentLane = laneNumber;
    Storage.saveLane(laneNumber);
    Storage.clearAllParticipantResults();
    eventData = await api.getEvent(currentCode);
    distances = await api.getDistances(currentCode);
    participants = await api.getParticipants(currentCode, currentLane);

    // Pre-load state for all participants so list shows correct scores immediately
    await refreshAllParticipantStates();

    await loadLaneParticipants();
}

async function loadLaneParticipants() {
    try {
        eventData = await api.getEvent(currentCode);
        distances = await api.getDistances(currentCode);
        participants = await api.getParticipants(currentCode, currentLane);

        // Refresh states if any distance changed status (handles distance activation/finish)
        await refreshAllParticipantStates();

        document.getElementById('lane-screen').classList.add('hidden');
        document.getElementById('participants-screen').classList.remove('hidden');
        document.getElementById('current-lane').textContent = currentLane;
        renderParticipantsList();
        renderAddParticipantButton();
    } catch (error) {
        alert('Error loading participants: ' + error.message);
    }
}

// Load and cache pstate for all participants in current lane
async function refreshAllParticipantStates() {
    if (!participants || participants.length === 0) return;
    await Promise.all(participants.map(async p => {
        try {
            const state = await api.getParticipantState(currentCode, p.id);
            Storage.set(`pstate_${p.id}`, state);
        } catch (e) {
            console.error(`Failed to load state for participant ${p.id}:`, e);
        }
    }));
}

function renderAddParticipantButton() {
    const addBtn = document.getElementById('add-participant-btn');
    if (addBtn) {
        addBtn.classList.toggle('hidden', !(eventData && eventData.status === 'created'));
    }
}

// ── Participants list with per-distance summaries ───────────────────────────

function renderParticipantsList() {
    const container = document.getElementById('participants-list');
    const sorted = [...participants].sort((a, b) => a.shift.localeCompare(b.shift));
    const finishedDists = distances.filter(d => d.status === 'finished');
    const activeDist = distances.find(d => d.status === 'active');

    container.innerHTML = sorted.map(p => {
        // Saved state for this participant
        const state = Storage.get(`pstate_${p.id}`);

        // Build distance summary row
        let distSummary = '';
        if (distances.length > 0) {
            const tags = distances.map(d => {
                let score = '—';
                if (d.status === 'finished' && state) {
                    const ds = state.distances.find(x => x.distance_id === d.id);
                    score = ds && ds.total_score !== null ? ds.total_score : '—';
                } else if (d.status === 'active' && state) {
                    const ds = state.distances.find(x => x.distance_id === d.id);
                    score = ds && ds.total_score !== null ? ds.total_score : '—';
                }
                const cls = d.status === 'active' ? 'dist-tag-active' : (d.status === 'finished' ? 'dist-tag-done' : 'dist-tag-pending');
                return `<span class="dist-tag ${cls}">${d.title}: ${score}</span>`;
            }).join('');
            distSummary = `<div class="participant-dist-summary">${tags}</div>`;
        }

        // Total cumulative
        let totalScore = 0;
        if (state) {
            state.distances.forEach(ds => { if (ds.total_score !== null) totalScore += ds.total_score; });
        }

        return `
        <div class="participant-card" onclick="openScoreInput(${p.id})">
            <div class="participant-info">${p.lane_number}${p.shift}</div>
            <div class="participant-name">${p.name}${distSummary}</div>
            <div class="participant-score">${totalScore}</div>
        </div>`;
    }).join('');
}

// ============================================
// ADD PARTICIPANT
// ============================================

function showAddParticipant() {
    document.getElementById('participants-screen').classList.add('hidden');
    document.getElementById('add-participant-screen').classList.remove('hidden');
}

function hideAddParticipant() {
    document.getElementById('add-participant-screen').classList.add('hidden');
    document.getElementById('participants-screen').classList.remove('hidden');
}

async function submitParticipant(e) {
    e.preventDefault();
    const participant = {
        name: document.getElementById('p-name').value,
        lane_number: currentLane,
        shift: document.getElementById('p-shift').value.toUpperCase(),
        gender: document.getElementById('p-gender').value || null,
        age_category: document.getElementById('p-age-category').value || null,
        shooting_type: document.getElementById('p-shooting-type').value || null,
        group_type: document.getElementById('p-group').value || null,
        personal_number: document.getElementById('p-number').value || null
    };
    try {
        await api.addParticipant(currentCode, participant);
        wsClient.send({ type: 'refresh' });
        await loadLaneParticipants();
        hideAddParticipant();
        document.getElementById('participant-form').reset();
    } catch (error) {
        alert('Error adding participant: ' + error.message);
    }
}

// ============================================
// SCORE INPUT
// ============================================

async function openScoreInput(participantId) {
    if (!eventData) return;
    if (eventData.status === 'created') {
        alert('Competition has not started yet.');
        return;
    }
    if (eventData.status === 'finished') {
        alert('Competition has finished.');
        return;
    }

    const activeDist = distances.find(d => d.status === 'active');
    if (!activeDist) {
        alert('No active distance. Wait for the host to start a distance.');
        return;
    }

    currentParticipant = participants.find(p => p.id === participantId);

    // Fetch full participant state from server
    try {
        participantState = await api.getParticipantState(currentCode, participantId);
        // Cache for list rendering
        Storage.set(`pstate_${participantId}`, participantState);
    } catch (error) {
        console.error('Error fetching state:', error);
        participantState = Storage.get(`pstate_${participantId}`) || { distances: [] };
    }

    // Extract results for the active distance
    const activeDistState = participantState.distances.find(d => d.distance_id === activeDist.id);
    results = activeDistState ? activeDistState.shots.map(s => ({
        participant_id: participantId,
        distance_id: activeDist.id,
        shot: s.shot,
        score: s.score,
        is_x: s.is_x
    })) : [];

    document.getElementById('participants-screen').classList.add('hidden');
    document.getElementById('score-screen').classList.remove('hidden');
    document.getElementById('participant-name').textContent = currentParticipant.name;

    renderScoreGrid();
    updateTotalScore();
}

function getActiveDist() {
    return distances.find(d => d.status === 'active') || null;
}

// ── Score Grid ──────────────────────────────────────────────────────────────

function renderScoreGrid() {
    const grid = document.getElementById('score-grid');
    const activeDist = getActiveDist();
    const shotsPerSeries = 3;
    grid.innerHTML = '';

    if (!activeDist) {
        grid.innerHTML = '<p style="text-align:center;color:#999;padding:20px;">No active distance</p>';
        return;
    }

    const totalShots = activeDist.shots_count;
    const seriesCount = Math.ceil(totalShots / shotsPerSeries);

    for (let series = 1; series <= seriesCount; series++) {
        const row = document.createElement('div');
        row.className = 'series-row';
        row.id = `series-${series}`;

        const seriesNum = document.createElement('div');
        seriesNum.textContent = series;
        row.appendChild(seriesNum);

        // Results for this series sorted desc for display
        const seriesResults = results
            .filter(r => Math.ceil(r.shot / shotsPerSeries) === series)
            .sort((a, b) => b.score - a.score);

        for (let shot = 1; shot <= shotsPerSeries; shot++) {
            const shotIndex = (series - 1) * shotsPerSeries + shot;
            if (shotIndex > totalShots) break;

            const btn = document.createElement('button');
            btn.className = 'shot-btn';
            btn.dataset.series = series;
            btn.dataset.shot = shot;
            btn.onclick = (e) => selectShot(series, shot, e);

            const result = seriesResults[shot - 1];
            if (result) {
                btn.textContent = result.is_x ? 'X' : result.score;
                btn.classList.add('filled');
            }
            row.appendChild(btn);
        }

        const seriesTotal = document.createElement('div');
        seriesTotal.className = 'series-total';
        const sSc = calculateSeriesScore(series);
        const cumSc = calculateCumulativeScore(series);
        seriesTotal.innerHTML = `${sSc}<br>${cumSc}`;
        row.appendChild(seriesTotal);

        grid.appendChild(row);
    }

    scrollToNextEmpty();
}

// Map "series" (row index) to actual shot range in results
function shotNumberForCell(series, shot) {
    return (series - 1) * 3 + shot;
}

let currentShotSelection = null;

function selectShot(series, shot, event) {
    const btn = event.target;
    const shotNum = shotNumberForCell(series, shot);
    const existingResult = results.find(r => r.shot === shotNum);

    if (existingResult && btn.classList.contains('selected')) {
        if (confirm('Clear this score?')) {
            results = results.filter(r => r.shot !== shotNum);
            renderScoreGrid();
            updateTotalScore();
        }
        return;
    }

    currentShotSelection = { series, shot, shotNum };
    document.querySelectorAll('.shot-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
}

function inputScore(score, isX = false) {
    const activeDist = getActiveDist();
    if (!activeDist) { alert('No active distance.'); return; }

    const nextEmpty = findNextEmptyShot();
    if (!nextEmpty) { alert('All shots filled for this distance'); return; }

    if (currentShotSelection) {
        const { series, shot } = currentShotSelection;
        if (series !== nextEmpty.series || shot !== nextEmpty.shot) {
            alert(`Fill shots in order. Next: Series ${nextEmpty.series}, Shot ${nextEmpty.shot}`);
            currentShotSelection = nextEmpty;
            const btn = document.querySelector(`[data-series="${nextEmpty.series}"][data-shot="${nextEmpty.shot}"]`);
            if (btn) {
                document.querySelectorAll('.shot-btn').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                scrollToShot(nextEmpty.series);
            }
            return;
        }
    } else {
        currentShotSelection = nextEmpty;
    }

    const { series, shot, shotNum } = currentShotSelection;
    results = results.filter(r => r.shot !== shotNum);
    results.push({ participant_id: currentParticipant.id, distance_id: activeDist.id, shot: shotNum, score, is_x: isX });

    const btn = document.querySelector(`[data-series="${series}"][data-shot="${shot}"]`);
    if (btn) { btn.textContent = isX ? 'X' : score; btn.classList.add('filled'); btn.classList.remove('selected'); }

    updateTotalScore();
    updateSeriesTotal(series);

    const seriesResults = results.filter(r => Math.ceil(r.shot / 3) === series);
    if (seriesResults.length === 3) {
        renderScoreGrid();
        autoSaveResults();
    }

    currentShotSelection = findNextEmptyShot();
    if (currentShotSelection) {
        scrollToShot(currentShotSelection.series);
        const nextBtn = document.querySelector(`[data-series="${currentShotSelection.series}"][data-shot="${currentShotSelection.shot}"]`);
        if (nextBtn) {
            document.querySelectorAll('.shot-btn').forEach(b => b.classList.remove('selected'));
            nextBtn.classList.add('selected');
        }
    }
}

function findNextEmptyShot() {
    const activeDist = getActiveDist();
    if (!activeDist) return null;
    const shotsPerSeries = 3;
    const totalShots = activeDist.shots_count;
    const totalSeries = Math.ceil(totalShots / shotsPerSeries);

    for (let series = 1; series <= totalSeries; series++) {
        for (let shot = 1; shot <= shotsPerSeries; shot++) {
            const shotNum = shotNumberForCell(series, shot);
            if (shotNum > totalShots) return null;
            if (!results.find(r => r.shot === shotNum)) return { series, shot, shotNum };
        }
    }
    return null;
}

function scrollToShot(series) {
    const row = document.getElementById(`series-${series}`);
    if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function scrollToNextEmpty() {
    const next = findNextEmptyShot();
    if (next) {
        currentShotSelection = next;
        setTimeout(() => {
            scrollToShot(next.series);
            const btn = document.querySelector(`[data-series="${next.series}"][data-shot="${next.shot}"]`);
            if (btn) { document.querySelectorAll('.shot-btn').forEach(b => b.classList.remove('selected')); btn.classList.add('selected'); }
        }, 100);
    }
}

function calculateSeriesScore(series) {
    const shotsPerSeries = 3;
    return results.filter(r => Math.ceil(r.shot / shotsPerSeries) === series).reduce((s, r) => s + r.score, 0);
}

function calculateCumulativeScore(upToSeries) {
    const shotsPerSeries = 3;
    const maxShot = upToSeries * shotsPerSeries;
    return results.filter(r => r.shot <= maxShot).reduce((s, r) => s + r.score, 0);
}

function updateSeriesTotal(series) {
    const el = document.querySelector(`#series-${series} .series-total`);
    if (el) el.innerHTML = `${calculateSeriesScore(series)}<br>${calculateCumulativeScore(series)}`;
}

function updateTotalScore() {
    const distTotal = results.reduce((s, r) => s + r.score, 0);
    // Add finished distances totals
    let cumTotal = distTotal;
    if (participantState) {
        participantState.distances.forEach(ds => {
            if (ds.status === 'finished' && ds.total_score !== null) cumTotal += ds.total_score;
        });
    }
    document.getElementById('total-score').textContent = cumTotal;
}

// ── Save ────────────────────────────────────────────────────────────────────

function mapResultsForApi() {
    return results.map(r => ({
        participant_id: r.participant_id,
        distance_id: r.distance_id,
        shot_number: r.shot,
        score: r.score,
        is_x: r.is_x
    }));
}

async function autoSaveResults() {
    if (!currentParticipant || results.length === 0) return;
    try {
        await api.saveResults(currentCode, mapResultsForApi());
        console.log('Auto-saved');
    } catch (error) {
        console.error('Auto-save failed:', error);
    }
}

async function backToParticipants() {
    const shotsPerSeries = 3;
    const activeDist = getActiveDist();
    if (activeDist) {
        const totalSeries = Math.ceil(activeDist.shots_count / shotsPerSeries);
        for (let s = 1; s <= totalSeries; s++) {
            const seriesShots = results.filter(r => Math.ceil(r.shot / shotsPerSeries) === s);
            if (seriesShots.length > 0 && seriesShots.length < shotsPerSeries) {
                if (!confirm(`Series ${s} is incomplete (${seriesShots.length}/${shotsPerSeries} shots). Exit anyway?`)) return;
                break;
            }
        }
    }

    try {
        if (results.length > 0) {
            await api.saveResults(currentCode, mapResultsForApi());
            const totalScore = results.reduce((s, r) => s + r.score, 0);
            wsClient.send({ type: 'result_update', participant_id: currentParticipant.id, total_score: totalScore });
        }
        // Refresh state cache
        if (currentParticipant) {
            try {
                const freshState = await api.getParticipantState(currentCode, currentParticipant.id);
                Storage.set(`pstate_${currentParticipant.id}`, freshState);
            } catch {}
        }
    } catch (error) {
        console.error('Save error:', error);
        alert('Error saving results. Stored locally.');
    }

    document.getElementById('score-screen').classList.add('hidden');
    // loadLaneParticipants already calls refreshAllParticipantStates
    await loadLaneParticipants();
}

// ============================================
// EVENT STATUS HANDLER
// ============================================

function handleEventStatus(data) {
    if (!eventData) return;
    const prevStatus = eventData.status;
    eventData.status = data.status;

    api.getDistances(currentCode).then(async d => {
        const prevDistances = distances;
        distances = d;

        const addBtn = document.getElementById('add-participant-btn');
        if (addBtn && data.status !== 'created') addBtn.classList.add('hidden');

        // Check if any distance changed status — if so, refresh all pstates
        const distancesChanged = d.some((nd, i) => {
            const od = prevDistances.find(x => x.id === nd.id);
            return !od || od.status !== nd.status;
        });

        if (distancesChanged && participants && participants.length > 0) {
            await refreshAllParticipantStates();
        }

        const scoreScreen = document.getElementById('score-screen');
        if (scoreScreen && !scoreScreen.classList.contains('hidden')) {
            const activeDist = distances.find(x => x.status === 'active');
            if (!activeDist) {
                alert('The active distance was stopped by the host. Your results have been saved.');
                await backToParticipants();
            } else if (distancesChanged) {
                // Re-render grid in case active distance changed
                renderScoreGrid();
            }
        } else if (distancesChanged) {
            // Refresh participants list to show updated scores
            renderParticipantsList();
        }
    }).catch(() => {});
}

// ============================================
// NAVIGATION
// ============================================

function backToCode() {
    if (confirm('Exit and clear saved state?')) {
        Storage.clearEventCode('client');
        Storage.clearLane();
        if (wsClient) wsClient.disconnect();
        location.reload();
    }
}

function backToLane() {
    Storage.clearLane();
    currentLane = null;
    document.getElementById('participants-screen').classList.add('hidden');
    showLaneSelection();
}
