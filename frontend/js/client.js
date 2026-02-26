// CLIENT JavaScript — session IDs/passwords never appear in HTML attributes
'use strict';

function _esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

let currentCode         = null;
let currentLane         = null;
let currentParticipant  = null;
let eventData           = null;
let distances           = [];
let participants        = [];
let results             = [];
let participantState    = null;
let wsClient            = null;
let allowAddParticipant = true;

// ============================================================
// INIT
// ============================================================
window.addEventListener('DOMContentLoaded', async () => {
    // Handle ?code= URL param
    const params  = new URLSearchParams(window.location.search);
    const urlCode = params.get('code');
    if (urlCode) {
        params.delete('code');
        history.replaceState(null, '', window.location.pathname + (params.toString() ? '?' + params : ''));
        Storage.clearEventCode('client');
        Storage.clearLane();
        document.getElementById('code-input').value = urlCode.toUpperCase();
        clientEnter();
        return;
    }

    // Restore saved session
    const savedCode = Storage.getEventCode('client');
    const savedLane = Storage.getLane();
    const savedSid  = savedLane ? Storage.getLaneSession(savedLane) : null;

    if (savedCode && savedLane && savedSid) {
        currentCode = savedCode;
        currentLane = savedLane;
        await _initConnections();
        // Try auto-login with saved session
        await _tryAutoLogin(savedLane, savedSid);
    }
});

async function _initConnections() {
    try {
        eventData  = await api.getEvent(currentCode);
        distances  = await api.getDistances(currentCode);
        const pub  = await api.getPublicProperties(currentCode);
        allowAddParticipant = pub.client_allow_add_participant !== false;

        if (wsClient) wsClient.disconnect();
        wsClient = new WSClient(currentCode);
        wsClient.connect();
        wsClient.on('event_status',      handleEventStatus);
        wsClient.on('distance_update',   handleDistanceUpdate);
        wsClient.on('refresh',           () => loadLaneParticipants());
        wsClient.on('lane_session_reset', handleLaneSessionReset);
        wsClient.on('result_update',     () => {});
    } catch (err) {
        alert('Event not found: ' + err.message);
    }
}

async function _tryAutoLogin(lane, sessionId) {
    try {
        const res = await api.laneLogin(currentCode, lane, sessionId);
        if (res.status === 'ok') {
            // Session still valid
            Storage.saveLaneSession(lane, res.session_id);
            await loadLaneParticipants();
        } else {
            // Session expired — go to lane selection
            Storage.clearLane();
            currentLane = null;
            showLaneSelection();
        }
    } catch {
        Storage.clearLane();
        currentLane = null;
        showLaneSelection();
    }
}

// ============================================================
// ENTRY
// ============================================================
async function clientEnter() {
    const code = document.getElementById('code-input').value.trim().toUpperCase();
    if (code.length !== CONFIG.CODE_LENGTH) { alert('Invalid code length'); return; }
    try {
        currentCode = code;
        await _initConnections();
        Storage.saveEventCode(code, 'client');
        showLaneSelection();
    } catch (err) { alert('Event not found: ' + err.message); }
}

// ============================================================
// LANE SELECTION
// ============================================================
function showLaneSelection() {
    _showScreen('lane-screen');
    const container = document.getElementById('lane-buttons');
    container.innerHTML = '';
    for (let i = 1; i <= 28; i++) {
        const btn = document.createElement('button');
        btn.className   = 'btn btn-secondary lane-btn';
        btn.textContent = i;
        btn.dataset.lane = i;
        btn.onclick = () => selectLane(i);
        container.appendChild(btn);
    }
}

async function selectLane(laneNumber) {
    const savedSid = Storage.getLaneSession(laneNumber);
    try {
        const res = await api.laneLogin(currentCode, laneNumber, savedSid);
        await _handleLaneLoginResult(res, laneNumber);
    } catch (err) {
        alert('Error accessing lane: ' + err.message);
    }
}

async function _handleLaneLoginResult(res, laneNumber) {
    if (res.status === 'created') {
        // First entry — show password screen (password from server, not in HTML)
        currentLane = laneNumber;
        Storage.saveLane(laneNumber);
        Storage.saveLaneSession(laneNumber, res.session_id);
        Storage.clearAllParticipantStates();
        _showLanePassword(laneNumber, res.password);
        return;
    }

    if (res.status === 'ok') {
        // Auto-login
        currentLane = laneNumber;
        Storage.saveLane(laneNumber);
        Storage.saveLaneSession(laneNumber, res.session_id);
        Storage.clearAllParticipantStates();
        await _refreshLaneData();
        await loadLaneParticipants();
        return;
    }

    if (res.status === 'password_required') {
        _showLaneAuthScreen(laneNumber);
    }
}

function _showLanePassword(laneNumber, password) {
    // Password is kept in memory briefly for display; never in HTML attributes
    document.getElementById('lane-pw-screen-title').textContent = `Lane ${laneNumber} — Your Password`;
    const box = document.getElementById('lane-pw-display');
    box.textContent = password;
    // Store temporarily so copyLanePassword() can read it
    box.dataset.pw = password;
    _showScreen('lane-password-screen');
}

function _fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try { document.execCommand('copy'); done(); } catch (_) {}
    document.body.removeChild(ta);
}

function copyLanePassword() {
    const box = document.getElementById('lane-pw-display');
    const pw  = box.dataset.pw || box.textContent;
    if (!pw) return;
    const done = () => {
        box.textContent = '✓ Copied!';
        setTimeout(() => { box.textContent = pw; }, 1500);
    };
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(pw).then(done).catch(() => _fallbackCopy(pw, done));
    } else {
        _fallbackCopy(pw, done);
    }
}

async function proceedAfterPassword() {
    // Clear pw from dataset now that we're moving on
    const box = document.getElementById('lane-pw-display');
    delete box.dataset.pw;
    await _refreshLaneData();
    await loadLaneParticipants();
}

function _showLaneAuthScreen(laneNumber) {
    // Store lane number in memory, not as HTML data attr
    currentLane = laneNumber;
    document.getElementById('lane-auth-title').textContent = `Lane ${laneNumber} — Password Required`;
    document.getElementById('lane-pw-input').value = '';
    document.getElementById('lane-pw-error').classList.add('hidden');
    _showScreen('lane-auth-screen');

    document.getElementById('lane-pw-input').addEventListener('keydown', function handler(e) {
        if (e.key === 'Enter') {
            submitLanePassword();
            this.removeEventListener('keydown', handler);
        }
    });
}

async function submitLanePassword() {
    const pw    = document.getElementById('lane-pw-input').value.trim().toUpperCase();
    const errEl = document.getElementById('lane-pw-error');
    errEl.classList.add('hidden');
    try {
        const res = await api.laneLogin(currentCode, currentLane, null, pw);
        if (res.status === 'ok') {
            Storage.saveLane(currentLane);
            Storage.saveLaneSession(currentLane, res.session_id);
            Storage.clearAllParticipantStates();
            await _refreshLaneData();
            await loadLaneParticipants();
        }
    } catch {
        errEl.textContent = 'Invalid password. Try again.';
        errEl.classList.remove('hidden');
        document.getElementById('lane-pw-input').value = '';
    }
}

async function _refreshLaneData() {
    eventData  = await api.getEvent(currentCode);
    distances  = await api.getDistances(currentCode);
    participants = await api.getParticipants(currentCode, currentLane);
    const pub  = await api.getPublicProperties(currentCode);
    allowAddParticipant = pub.client_allow_add_participant !== false;
    await _refreshAllParticipantStates();
}

// ============================================================
// PARTICIPANTS SCREEN
// ============================================================
async function loadLaneParticipants() {
    try {
        eventData    = await api.getEvent(currentCode);
        distances    = await api.getDistances(currentCode);
        participants = await api.getParticipants(currentCode, currentLane);
        const pub    = await api.getPublicProperties(currentCode);
        allowAddParticipant = pub.client_allow_add_participant !== false;
        await _refreshAllParticipantStates();

        document.getElementById('lane-badge').textContent = currentLane;
        _renderAddParticipantButton();
        renderParticipantsList();
        _showScreen('participants-screen');
    } catch (err) {
        alert('Error loading participants: ' + err.message);
    }
}

async function _refreshAllParticipantStates() {
    if (!participants?.length) return;
    await Promise.all(participants.map(async p => {
        try {
            const state = await api.getParticipantState(currentCode, p.id);
            Storage.saveParticipantState(p.id, state);
        } catch {}
    }));
}

function _renderAddParticipantButton() {
    const btn = document.getElementById('add-participant-btn');
    if (btn) {
        const show = eventData?.status === 'created' && allowAddParticipant;
        btn.classList.toggle('hidden', !show);
    }
}

function renderParticipantsList() {
    const container = document.getElementById('participants-list');
    const sorted = [...participants].sort((a, b) => a.shift.localeCompare(b.shift));

    container.innerHTML = sorted.map(p => {
        const state = Storage.getParticipantState(p.id);
        let distSummary = '';
        if (distances.length) {
            const tags = distances.map(d => {
                let score = '—';
                if ((d.status === 'finished' || d.status === 'active') && state) {
                    const ds = state.distances.find(x => x.distance_id === d.id);
                    score = ds?.total_score !== null && ds?.total_score !== undefined ? ds.total_score : '—';
                }
                const cls = d.status === 'active' ? 'dist-tag-active' : (d.status === 'finished' ? 'dist-tag-done' : 'dist-tag-pending');
                return `<span class="dist-tag ${cls}">${_esc(d.title)}: ${score}</span>`;
            }).join('');
            distSummary = `<div class="participant-dist-summary">${tags}</div>`;
        }
        let total = 0;
        state?.distances.forEach(ds => { if (ds.total_score !== null) total += ds.total_score; });
        return `
        <div class="participant-card" data-pid="${p.id}" onclick="openScoreInput(${p.id})">
            <div class="participant-info">${p.lane_number}${_esc(p.shift)}</div>
            <div class="participant-name">${_esc(p.name)}${distSummary}</div>
            <div class="participant-score">${total}</div>
        </div>`;
    }).join('');
}

// ============================================================
// ADD PARTICIPANT
// ============================================================
function showAddParticipant() {
    _showScreen('add-participant-screen');
}

function hideAddParticipant() {
    _showScreen('participants-screen');
}

async function submitParticipant(e) {
    e.preventDefault();
    const sid = Storage.getLaneSession(currentLane);
    const participant = {
        name:            document.getElementById('p-name').value,
        lane_number:     currentLane,
        shift:           document.getElementById('p-shift').value.toUpperCase(),
        gender:          document.getElementById('p-gender').value || null,
        age_category:    document.getElementById('p-age-category').value || null,
        shooting_type:   document.getElementById('p-shooting-type').value || null,
        group_type:      document.getElementById('p-group').value || null,
        personal_number: document.getElementById('p-number').value || null
    };
    try {
        await api.addParticipant(currentCode, participant, sid);
        wsClient.send({ type: 'refresh' });
        await loadLaneParticipants();
        hideAddParticipant();
        document.getElementById('participant-form').reset();
    } catch (err) { alert('Error: ' + err.message); }
}

// ============================================================
// SCORE INPUT
// ============================================================
async function openScoreInput(participantId) {
    if (!eventData) return;
    if (eventData.status === 'created')  { alert('Competition has not started yet.'); return; }
    if (eventData.status === 'finished') { alert('Competition has finished.'); return; }

    const activeDist = distances.find(d => d.status === 'active');
    if (!activeDist) { alert('No active distance. Wait for the host to start a distance.'); return; }

    currentParticipant = participants.find(p => p.id === participantId);
    try {
        participantState = await api.getParticipantState(currentCode, participantId);
        Storage.saveParticipantState(participantId, participantState);
    } catch {
        participantState = Storage.getParticipantState(participantId) || { distances: [] };
    }

    const activeState = participantState.distances.find(d => d.distance_id === activeDist.id);
    results = activeState ? activeState.shots.map(s => ({
        participant_id: participantId,
        distance_id:    activeDist.id,
        shot:           s.shot,
        score:          s.score,
        is_x:           s.is_x
    })) : [];

    _showScreen('score-screen');
    document.getElementById('participant-name').textContent = currentParticipant.name;
    renderScoreGrid();
    updateTotalScore();
}

function _getActiveDist() { return distances.find(d => d.status === 'active') || null; }

function renderScoreGrid() {
    const grid = document.getElementById('score-grid');
    const ad   = _getActiveDist();
    grid.innerHTML = '';
    if (!ad) {
        grid.innerHTML = '<p class="empty-text">No active distance</p>';
        return;
    }
    const total  = ad.shots_count;
    const series = Math.ceil(total / 3);
    for (let s = 1; s <= series; s++) {
        const row = document.createElement('div');
        row.className = 'series-row';
        row.id = `series-${s}`;

        const num = document.createElement('div');
        num.textContent = s;
        row.appendChild(num);

        const seriesRes = results
            .filter(r => Math.ceil(r.shot / 3) === s)
            .sort((a, b) => b.score - a.score);

        for (let sh = 1; sh <= 3; sh++) {
            const idx = (s - 1) * 3 + sh;
            if (idx > total) break;
            const btn    = document.createElement('button');
            btn.className      = 'shot-btn';
            btn.dataset.series = s;
            btn.dataset.shot   = sh;
            btn.onclick = ev => selectShot(s, sh, ev);
            const res = seriesRes[sh - 1];
            if (res) { btn.textContent = res.is_x ? 'X' : res.score; btn.classList.add('filled'); }
            row.appendChild(btn);
        }

        const tot = document.createElement('div');
        tot.className = 'series-total';
        tot.innerHTML = `${_seriesScore(s)}<br>${_cumScore(s)}`;
        row.appendChild(tot);
        grid.appendChild(row);
    }
    _scrollToNextEmpty();
}

let _currentShot = null;

function selectShot(series, shot, ev) {
    const btn     = ev.currentTarget;
    const shotNum = (series - 1) * 3 + shot;
    const exist   = results.find(r => r.shot === shotNum);

    if (exist && btn.classList.contains('selected')) {
        if (confirm('Clear this score?')) {
            results = results.filter(r => r.shot !== shotNum);
            renderScoreGrid();
            updateTotalScore();
        }
        return;
    }
    _currentShot = { series, shot, shotNum };
    document.querySelectorAll('.shot-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
}

function inputScore(score, isX = false) {
    const ad = _getActiveDist();
    if (!ad) { alert('No active distance.'); return; }

    const next = _findNextEmpty();
    if (!next) { alert('All shots filled'); return; }

    if (_currentShot && (_currentShot.series !== next.series || _currentShot.shot !== next.shot)) {
        alert(`Fill in order. Next: Series ${next.series}, Shot ${next.shot}`);
        _currentShot = next;
        const b = document.querySelector(`[data-series="${next.series}"][data-shot="${next.shot}"]`);
        if (b) { document.querySelectorAll('.shot-btn').forEach(x => x.classList.remove('selected')); b.classList.add('selected'); _scrollToSeries(next.series); }
        return;
    }

    if (!_currentShot) _currentShot = next;
    const { series, shot, shotNum } = _currentShot;

    results = results.filter(r => r.shot !== shotNum);
    results.push({ participant_id: currentParticipant.id, distance_id: ad.id, shot: shotNum, score, is_x: isX });

    const b = document.querySelector(`[data-series="${series}"][data-shot="${shot}"]`);
    if (b) { b.textContent = isX ? 'X' : score; b.classList.add('filled'); b.classList.remove('selected'); }

    updateTotalScore();
    _updateSeriesTotal(series);

    const seriesCount = results.filter(r => Math.ceil(r.shot / 3) === series).length;
    if (seriesCount === 3) { renderScoreGrid(); _autoSave(); }

    _currentShot = _findNextEmpty();
    if (_currentShot) {
        _scrollToSeries(_currentShot.series);
        const nb = document.querySelector(`[data-series="${_currentShot.series}"][data-shot="${_currentShot.shot}"]`);
        if (nb) { document.querySelectorAll('.shot-btn').forEach(x => x.classList.remove('selected')); nb.classList.add('selected'); }
    }
}

function _findNextEmpty() {
    const ad = _getActiveDist();
    if (!ad) return null;
    for (let s = 1; s <= Math.ceil(ad.shots_count / 3); s++) {
        for (let sh = 1; sh <= 3; sh++) {
            const num = (s - 1) * 3 + sh;
            if (num > ad.shots_count) return null;
            if (!results.find(r => r.shot === num)) return { series: s, shot: sh, shotNum: num };
        }
    }
    return null;
}

function _scrollToSeries(s) {
    const row = document.getElementById(`series-${s}`);
    if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function _scrollToNextEmpty() {
    const next = _findNextEmpty();
    if (!next) return;
    _currentShot = next;
    setTimeout(() => {
        _scrollToSeries(next.series);
        const b = document.querySelector(`[data-series="${next.series}"][data-shot="${next.shot}"]`);
        if (b) { document.querySelectorAll('.shot-btn').forEach(x => x.classList.remove('selected')); b.classList.add('selected'); }
    }, 100);
}
// Delete the last filled shot for the current participant/distance and move focus back
async function deleteLastScore() {
    const ad = _getActiveDist();
    if (!ad) return;
    if (!results.length) return;

    // Find the highest shot number currently filled
    const maxShot = Math.max(...results.map(r => r.shot));
    results = results.filter(r => r.shot !== maxShot);

    // Determine which series it belonged to
    const series = Math.ceil(maxShot / 3);
    const shot   = maxShot - (series - 1) * 3;

    // Clear the visual slot
    const btn = document.querySelector(`[data-series="${series}"][data-shot="${shot}"]`);
    if (btn) {
        btn.textContent = '';
        btn.classList.remove('filled', 'selected');
    }

    updateTotalScore();
    _updateSeriesTotal(series);

    // Set focus to the now-empty slot
    _currentShot = { series, shot, shotNum: maxShot };
    document.querySelectorAll('.shot-btn').forEach(b => b.classList.remove('selected'));
    if (btn) {
        btn.classList.add('selected');
        _scrollToSeries(series);
    }

    // Persist immediately
    await _autoSave();
}

function _seriesScore(s) {
    return results.filter(r => Math.ceil(r.shot / 3) === s).reduce((acc, r) => acc + r.score, 0);
}

function _cumScore(upTo) {
    return results.filter(r => r.shot <= upTo * 3).reduce((acc, r) => acc + r.score, 0);
}

function _updateSeriesTotal(s) {
    const el = document.querySelector(`#series-${s} .series-total`);
    if (el) el.innerHTML = `${_seriesScore(s)}<br>${_cumScore(s)}`;
}

function updateTotalScore() {
    let total = results.reduce((a, r) => a + r.score, 0);
    participantState?.distances.forEach(ds => {
        if (ds.status === 'finished' && ds.total_score !== null) total += ds.total_score;
    });
    document.getElementById('total-score').textContent = total;
}

function _mapForApi() {
    return results.map(r => ({
        participant_id: r.participant_id,
        distance_id:    r.distance_id,
        shot_number:    r.shot,
        score:          r.score,
        is_x:           r.is_x
    }));
}

async function _autoSave() {
    if (!currentParticipant || !results.length) return;
    const sid = Storage.getLaneSession(currentLane);
    try { await api.saveResults(currentCode, _mapForApi(), sid); }
    catch (err) { console.error('Auto-save failed:', err); }
}

async function backToParticipants() {
    const ad = _getActiveDist();
    if (ad) {
        const totalSeries = Math.ceil(ad.shots_count / 3);
        for (let s = 1; s <= totalSeries; s++) {
            const shots = results.filter(r => Math.ceil(r.shot / 3) === s);
            if (shots.length && shots.length < 3) {
                if (!confirm(`Series ${s} incomplete (${shots.length}/3). Exit anyway?`)) return;
                break;
            }
        }
    }
    const sid = Storage.getLaneSession(currentLane);
    try {
        if (results.length) {
            await api.saveResults(currentCode, _mapForApi(), sid);
            const total = results.reduce((a, r) => a + r.score, 0);
            wsClient.send({ type: 'result_update', participant_id: currentParticipant.id, total_score: total });
        }
        if (currentParticipant) {
            try {
                const fresh = await api.getParticipantState(currentCode, currentParticipant.id);
                Storage.saveParticipantState(currentParticipant.id, fresh);
            } catch {}
        }
    } catch (err) {
        console.error('Save error:', err);
        alert('Error saving. Reconnect and try again.');
    }
    _showScreen('score-screen-hidden');
    await loadLaneParticipants();
}

// ============================================================
// EVENT / DISTANCE STATUS HANDLERS
// ============================================================
function handleEventStatus(data) {
    if (!eventData) return;
    eventData.status = data.status;
    api.getDistances(currentCode).then(async d => {
        const prev = distances;
        distances = d;
        _renderAddParticipantButton();

        const changed = d.some(nd => {
            const od = prev.find(x => x.id === nd.id);
            return !od || od.status !== nd.status;
        });
        if (changed && participants?.length) await _refreshAllParticipantStates();

        const scoreVisible = !document.getElementById('score-screen').classList.contains('hidden');
        const ad = distances.find(x => x.status === 'active');
        if (scoreVisible) {
            if (!ad) { alert('Active distance stopped by host. Results saved.'); await backToParticipants(); }
            else if (changed) renderScoreGrid();
        } else if (changed) { renderParticipantsList(); }
    }).catch(() => {});
}

function handleDistanceUpdate(data) {
    api.getDistances(currentCode).then(async d => {
        distances = d;
        renderParticipantsList();
    }).catch(() => {});
}

function handleLaneSessionReset(data) {
    if (data.lane_number !== currentLane) return;
    alert('Your lane session has been reset by the admin. You will be redirected to lane selection.');
    Storage.clearLaneSession(currentLane);
    Storage.clearLane();
    currentLane = null;
    currentParticipant = null;
    results = [];
    showLaneSelection();
}

// ============================================================
// NAVIGATION
// ============================================================
function backToCode() {
    if (!confirm('Exit and clear saved state?')) return;
    Storage.clearEventCode('client');
    Storage.clearLane();
    if (wsClient) wsClient.disconnect();
    location.reload();
}

function backToLane() {
    Storage.clearLane();
    currentLane = null;
    _showScreen('lane-screen');
    showLaneSelection();
}

// ============================================================
// HELPERS
// ============================================================
function _showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    // Handle special "go back to participants" case
    if (screenId === 'score-screen-hidden') {
        document.getElementById('participants-screen').classList.remove('hidden');
        return;
    }
    const el = document.getElementById(screenId);
    if (el) el.classList.remove('hidden');
}
