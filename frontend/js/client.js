// Keep session credentials out of HTML attributes.
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
let currentDistanceId   = null;
let laneCount           = 0;
const resultSaveQueue   = new Map();

let lanePassword = '';
let copyPasswordTimer = null;
let participantSubmitting = false;
let laneSubmitting = false;
let entering = false;
let contextVersion = 0;
let navigationVersion = 0;
let reconcileQueue = Promise.resolve();
let scoreOpenVersion = 0;
const scoreVersions = new Map();
const _scoreVersion = (code, participantId) => scoreVersions.get(`${code}:${participantId}`) || 0;

function _notice(message, recovery = false) {
    const notice = document.getElementById('client-notice');
    if (notice) {
        notice.textContent = message;
        notice.classList.remove('hidden');
    }
    const download = document.getElementById('recovery-download');
    if (download && recovery) download.classList.remove('hidden');
}

function _reportError(message, error) {
    console.warn(message, error);
    _notice(`${message} ${error.message}`);
}

function _context() {
    return { code: currentCode, lane: currentLane, version: contextVersion };
}

function _isCurrent(context) {
    return context.code === currentCode && context.lane === currentLane && context.version === contextVersion;
}

function _visibleScreen() {
    return document.querySelector('.screen:not(.hidden)')?.id;
}

function _validCode(code) {
    return new RegExp(`^[A-Z0-9]{${CONFIG.CODE_LENGTH}}$`).test(code);
}

window.addEventListener('DOMContentLoaded', async () => {
    _bindClientControls();
    window.addEventListener('online', () => {
        if (currentCode && currentLane) _reconcile();
    });
    const params = new URLSearchParams(window.location.search);
    const urlCode = params.get('code');
    if (urlCode !== null) {
        params.delete('code');
        history.replaceState(null, '', window.location.pathname + (params.toString() ? '?' + params : ''));
        const code = urlCode.trim().toUpperCase();
        document.getElementById('code-input').value = code;
        if (!_validCode(code)) {
            _notice(`Enter ${CONFIG.CODE_LENGTH} letters or numbers for the event code.`);
            return;
        }
        AppStorage.clearEventCode('client');
        AppStorage.clearLane();
        await clientEnter();
        return;
    }
    const savedCode = AppStorage.getEventCode('client');
    const savedLane = AppStorage.getLane();
    const savedSid = savedLane ? AppStorage.getLaneSession(savedLane) : null;
    if (savedCode) document.getElementById('code-input').value = savedCode;
    if (savedCode && _validCode(savedCode) && savedLane && savedSid) {
        currentCode = savedCode;
        currentLane = savedLane;
        try {
            await _initConnections();
            await _tryAutoLogin(savedLane, savedSid);
        } catch (error) {
            _reportError('Could not load the event. Try again.', error);
        }
    }
    if (AppStorage.getRecoveryResults().length) {
        _notice('Unsent scores from an earlier lane session are kept on this device. Download them for recovery.', true);
    }
});

function _bindClientControls() {
    const actions = {
        enter: clientEnter,
        home: () => { location.href = 'index.html'; },
        'back-code': backToCode,
        'back-lane': backToLane,
        'copy-password': copyLanePassword,
        'continue-password': proceedAfterPassword,
        'submit-password': submitLanePassword,
        'request-reset': requestLaneReset,
        'add-participant': showAddParticipant,
        'cancel-participant': hideAddParticipant,
        'back-participants': backToParticipants,
        'delete-score': deleteLastScore,
        'download-recovery': downloadPendingRecovery,
    };
    document.addEventListener('click', event => {
        const action = event.target.closest('[data-action]');
        if (action && actions[action.dataset.action]) {
            Promise.resolve(actions[action.dataset.action]()).catch(error => _reportError('The action failed.', error));
            return;
        }
        const score = event.target.closest('[data-score]');
        if (score) { inputScore(Number(score.dataset.score), score.dataset.x === 'true'); return; }
        const participant = event.target.closest('.participant-card[data-pid]');
        if (participant) openScoreInput(Number(participant.dataset.pid)).catch(error => _reportError('Could not open the scores.', error));
    });
    document.getElementById('participant-form').addEventListener('submit', submitParticipant);
    document.getElementById('lane-pw-input').addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); submitLanePassword(); }
    });
    document.getElementById('code-input').addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); clientEnter(); }
    });
}

async function _initConnections() {
    const context = _context();
    const [event, loadedDistances, properties, everyone] = await Promise.all([
        api.getEvent(context.code), api.getDistances(context.code), api.getPublicProperties(context.code),
        api.getParticipants(context.code).catch(() => [])
    ]);
    if (!_isCurrent(context)) return;
    laneCount = Math.max(0, ...everyone.map(participant => participant.lane_number));
    eventData = event;
    distances = loadedDistances;
    allowAddParticipant = properties.client_allow_add_participant !== false;
}

async function _tryAutoLogin(lane, sessionId) {
    const context = _context();
    try {
        const res = await api.laneLogin(context.code, lane, sessionId);
        if (!_isCurrent(context)) return;
        if (res.status === 'password_required') {
            AppStorage.clearLaneSession(lane);
            AppStorage.clearLane();
        }
        await _handleLaneLoginResult(res, lane);
    } catch (error) {
        if (!_isCurrent(context)) return;
        if (error.status === 401 || error.status === 403) {
            AppStorage.clearLaneSession(lane);
            AppStorage.clearLane();
            _showLaneAuthScreen(lane);
        } else {
            _reportError('Could not restore the lane. Your saved session is kept. Try again.', error);
        }
    }
}

async function clientEnter() {
    if (entering) return;
    const code = document.getElementById('code-input').value.trim().toUpperCase();
    if (!_validCode(code)) { _notice(`Enter ${CONFIG.CODE_LENGTH} letters or numbers for the event code.`); return; }
    entering = true;
    contextVersion++;
    currentCode = code;
    currentLane = null;
    const context = _context();
    try {
        await _initConnections();
        if (!_isCurrent(context)) return;
        AppStorage.saveEventCode(code, 'client');
        showLaneSelection();
    } catch (error) {
        if (_isCurrent(context)) _reportError('Could not load the event.', error);
    } finally { entering = false; }
}

function showLaneSelection() {
    _stopResetWatch();
    _showScreen('lane-screen');
    const container = document.getElementById('lane-buttons');
    container.innerHTML = '';
    for (let i = 1; i <= Math.max(CONFIG.LANE_COUNT, laneCount); i++) {
        const btn = document.createElement('button');
        btn.className = 'btn btn-secondary lane-btn';
        btn.textContent = i;
        btn.dataset.lane = i;
        btn.addEventListener('click', () => selectLane(i));
        container.appendChild(btn);
    }
}

async function selectLane(laneNumber) {
    if (laneSubmitting) return;
    _stopResetWatch();
    laneSubmitting = true;
    contextVersion++;
    wsClient?.disconnect();
    currentLane = laneNumber;
    const context = _context();
    try {
        const res = await api.laneLogin(context.code, laneNumber, AppStorage.getLaneSession(laneNumber));
        if (_isCurrent(context)) await _handleLaneLoginResult(res, laneNumber);
    } catch (error) {
        if (_isCurrent(context)) _reportError('Could not access the lane.', error);
    } finally { laneSubmitting = false; }
}

async function _handleLaneLoginResult(res, laneNumber) {
    if (res.status === 'created' || res.status === 'ok') {
        currentLane = laneNumber;
        AppStorage.saveLane(laneNumber);
        AppStorage.saveLaneSession(laneNumber, res.session_id);
        AppStorage.clearAllParticipantStates();
        const context = _context();
        if (res.status === 'created') {
            _showLanePassword(laneNumber, res.password);
            _connectClientWS(res.session_id);
        } else {
            try { await loadLaneParticipants({ show: true }); }
            finally { if (_isCurrent(context)) _connectClientWS(res.session_id); }
        }
        return;
    }
    if (res.status === 'password_required') { _showLaneAuthScreen(laneNumber); return; }
    throw new Error('The server returned an unknown lane status. Try again.');
}

function _showLanePassword(laneNumber, password) {
    lanePassword = password;
    document.getElementById('lane-pw-screen-title').textContent = `Lane ${laneNumber} — Your Password`;
    document.getElementById('lane-pw-display').textContent = password;
    _showScreen('lane-password-screen');
}

function _fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try {
        if (!document.execCommand('copy')) throw new Error('Copy command failed');
        done();
    } catch (error) { _reportError('Could not copy the password. Copy it manually.', error); }
    finally { document.body.removeChild(ta); }
}

function copyLanePassword() {
    const pw = lanePassword;
    if (!pw) return;
    const box = document.getElementById('lane-pw-display');
    const done = () => {
        if (lanePassword !== pw) return;
        box.textContent = 'Copied';
        clearTimeout(copyPasswordTimer);
        copyPasswordTimer = setTimeout(() => {
            if (lanePassword === pw) box.textContent = pw;
        }, 1500);
    };
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(pw).then(done).catch(() => {
            if (lanePassword === pw) _fallbackCopy(pw, done);
        });
    } else { _fallbackCopy(pw, done); }
}

function _clearLanePassword() {
    lanePassword = '';
    clearTimeout(copyPasswordTimer);
    document.getElementById('lane-pw-display').textContent = '';
}

async function proceedAfterPassword() {
    await loadLaneParticipants({ show: true });
    _clearLanePassword();
}

function _showLaneAuthScreen(laneNumber) {
    currentLane = laneNumber;
    document.getElementById('lane-auth-title').textContent = `Lane ${laneNumber} — Password Required`;
    document.getElementById('lane-pw-input').value = '';
    document.getElementById('lane-pw-error').classList.add('hidden');
    _showScreen('lane-auth-screen');
    _stopResetWatch();
    _setResetState('idle');
    // A request that was sent before a reload is still valid. Continue to wait for it.
    const saved = AppStorage.getResetRequest(currentCode, laneNumber);
    if (saved) _watchReset(_context(), laneNumber, saved, 0);
}

// ============================================================
// RESET REQUEST (a lane that lost its password asks the host)
// ============================================================
let resetWatch = null;       // { context, lane, id, timer } while a request waits
let resetRequesting = false; // the request is on its way

// `idle`: the button shows (with a message). `waiting`: the status shows.
function _setResetState(mode, message = '') {
    document.getElementById('lane-reset-btn').classList.toggle('hidden', mode === 'waiting');
    const status = document.getElementById('lane-reset-status');
    status.textContent = message;
    status.classList.toggle('hidden', !message);
}

// Stop asking for the result. The saved request stays, unless `forget` is set.
function _stopResetWatch(forget = false) {
    if (!resetWatch) return;
    clearTimeout(resetWatch.timer);
    if (forget) AppStorage.clearResetRequest(resetWatch.context.code, resetWatch.lane);
    resetWatch = null;
}

function _watchReset(context, lane, id, firstDelay = CONFIG.RESET_POLL_MS) {
    _stopResetWatch();
    const watch = resetWatch = { context, lane, id, timer: null };
    _setResetState('waiting', 'Waiting for the host to approve the reset…');
    const poll = async () => {
        if (resetWatch !== watch || !_isCurrent(context)) return;
        try {
            const result = await api.laneResetStatus(context.code, lane, id);
            if (resetWatch !== watch || !_isCurrent(context)) return;
            if (result.status === 'approved') {
                _stopResetWatch(true);
                // The lane gets the new password like on the first entry.
                await _handleLaneLoginResult({ status: 'created', session_id: result.session_id, password: result.password, lane_number: lane }, lane);
                return;
            }
            if (result.status === 'denied') {
                _stopResetWatch(true);
                _setResetState('idle', 'The host denied the request.');
                return;
            }
            if (result.status === 'expired') {
                _stopResetWatch(true);
                _setResetState('idle', 'The request ended. Ask again.');
                return;
            }
        } catch (error) {
            // A network problem. The request is still valid. Ask again later.
            if (resetWatch !== watch) return;
        }
        watch.timer = setTimeout(poll, CONFIG.RESET_POLL_MS);
    };
    watch.timer = setTimeout(poll, firstDelay);
}

async function requestLaneReset() {
    if (resetWatch || resetRequesting) return;
    resetRequesting = true;
    const context = _context();
    const lane = currentLane;
    _setResetState('idle', 'Sending the request…');
    try {
        const result = await api.requestLaneReset(context.code, lane);
        // Save the request also when the user left the screen. The page continues to wait when the lane opens again.
        AppStorage.saveResetRequest(context.code, lane, result.request_id);
        if (!_isCurrent(context)) return;
        _watchReset(context, lane, result.request_id);
    } catch (error) {
        if (_isCurrent(context)) _setResetState('idle', error.message);
    } finally {
        resetRequesting = false;
    }
}

async function submitLanePassword() {
    if (laneSubmitting) return;
    laneSubmitting = true;
    const pw = document.getElementById('lane-pw-input').value.trim().toUpperCase();
    const errorElement = document.getElementById('lane-pw-error');
    const button = document.querySelector('[data-action="submit-password"]');
    if (button) button.disabled = true;
    errorElement.classList.add('hidden');
    const context = _context();
    try {
        const res = await api.laneLogin(context.code, context.lane, null, pw);
        if (!_isCurrent(context)) return;
        if (res.status === 'password_required') throw new Error('Enter the lane password.');
        await _handleLaneLoginResult(res, context.lane);
    } catch (error) {
        if (_isCurrent(context)) {
            errorElement.textContent = error.status === 401 ? 'Invalid password. Try again.' : error.message;
            errorElement.classList.remove('hidden');
            if (error.status === 401) document.getElementById('lane-pw-input').value = '';
        }
    } finally {
        laneSubmitting = false;
        if (button) button.disabled = false;
    }
}

function _connectClientWS(sessionId = AppStorage.getLaneSession(currentLane)) {
    if (!sessionId || !currentLane) return;
    wsClient?.disconnect();
    const context = _context();
    wsClient = new WSClient(context.code, sessionId);
    for (const type of ['event_status', 'distance_update', 'refresh', 'authenticated']) {
        wsClient.on(type, () => { if (_isCurrent(context)) return _reconcile(); });
    }
    wsClient.on('lane_session_reset', data => { if (_isCurrent(context)) handleLaneSessionReset(data); });
    wsClient.on('session_rejected', () => {
        if (_isCurrent(context)) return _tryAutoLogin(context.lane, sessionId);
    });
    wsClient.on('result_update', data => {
        if (_isCurrent(context) && participants.some(p => p.id === data.participant_id)) {
            return _refreshParticipantState(data.participant_id, context);
        }
    });
    wsClient.connect();
}

function _reconcile() {
    const context = _context();
    const task = reconcileQueue.then(async () => {
        if (!_isCurrent(context) || !context.code || !context.lane || !AppStorage.getLaneSession(context.lane)) return;
        const screen = _visibleScreen();
        const navigation = navigationVersion;
        const participantId = currentParticipant?.id;
        const distanceId = currentDistanceId;
        const scoreVersion = _scoreVersion(context.code, participantId);
        await loadLaneParticipants();
        if (!_isCurrent(context) || navigation !== navigationVersion) return;
        if (screen !== 'score-screen' || !participantId) return;
        const activeDistance = distances.find(distance => distance.status === 'active');
        if (eventData?.status !== 'started' || !activeDistance) {
            await _autoSave();
            if (eventData?.status === 'finished') {
                for (const pending of AppStorage.getPendingResults(context.code, context.lane)) _archiveFinishedPending(pending);
            }
            if (!_isCurrent(context) || navigation !== navigationVersion) return;
            alert('Competition stopped. Any unsent scores are saved on this device for recovery.');
            currentParticipant = null;
            currentDistanceId = null;
            results = [];
            _showScreen('participants-screen');
            renderParticipantsList();
            return;
        }
        if (activeDistance.id !== distanceId) {
            await _autoSave();
            if (_isCurrent(context) && navigation === navigationVersion) await openScoreInput(participantId);
            return;
        }
        currentParticipant = participants.find(participant => participant.id === participantId);
        if (!currentParticipant) {
            currentDistanceId = null;
            results = [];
            _showScreen('participants-screen');
            return;
        }
        participantState = AppStorage.getParticipantState(participantId) || participantState;
        const state = participantState?.distances.find(distance => distance.distance_id === distanceId);
        if (state && scoreVersion === _scoreVersion(context.code, participantId)) {
            const shots = sortSeries(state.shots.map(shot => ({ participant_id: participantId, distance_id: distanceId, ...shot })));
            // Other shots than the shots of this device: the hint of the delete button is old.
            if (_shotKey(shots) !== _shotKey(results)) _lastEntry = null;
            results = shots;
        }
        renderScoreGrid();
        updateTotalScore();
    });
    reconcileQueue = task.catch(error => {
        if (_isCurrent(context)) _reportError('Could not refresh lane data. Try again.', error);
    });
    return reconcileQueue;
}

const _shotKey = list => JSON.stringify(list.map(({ shot, score, is_x }) => [shot, score, Boolean(is_x)]).sort((a, b) => a[0] - b[0]));

// A score update changes one participant. Load only that participant, not the whole lane.
async function _refreshParticipantState(participantId, context) {
    const version = _scoreVersion(context.code, participantId);
    const state = await api.getParticipantState(context.code, participantId);
    if (!_isCurrent(context) || version !== _scoreVersion(context.code, participantId)) return;
    const merged = _mergePendingResults(participantId, state);
    AppStorage.saveParticipantState(participantId, merged);
    const screen = _visibleScreen();
    if (screen === 'participants-screen') {
        renderParticipantsList();
    } else if (screen === 'score-screen' && currentParticipant?.id === participantId) {
        participantState = merged;
        const active = merged.distances.find(distance => distance.distance_id === currentDistanceId);
        if (active?.status === 'active') {
            const shots = sortSeries(active.shots.map(shot => ({ participant_id: participantId, distance_id: currentDistanceId, ...shot })));
            if (_shotKey(shots) !== _shotKey(results)) {
                results = shots;
                _lastEntry = null;
                renderScoreGrid();
            }
        }
        updateTotalScore();
    }
}

async function loadLaneParticipants({ show = false } = {}) {
    const context = _context();
    const navigation = navigationVersion;
    const [event, loadedDistances, loadedParticipants, properties] = await Promise.all([
        api.getEvent(context.code), api.getDistances(context.code),
        api.getParticipants(context.code, context.lane), api.getPublicProperties(context.code)
    ]);
    if (!_isCurrent(context)) return;
    eventData = event;
    distances = loadedDistances;
    participants = loadedParticipants;
    allowAddParticipant = properties.client_allow_add_participant !== false;
    await _syncPendingResults();
    if (!_isCurrent(context)) return;
    await _refreshAllParticipantStates();
    if (!_isCurrent(context)) return;
    document.getElementById('lane-badge').textContent = currentLane;
    _renderAddParticipantButton();
    renderParticipantsList();
    if (show && navigation === navigationVersion) _showScreen('participants-screen');
}

function downloadPendingRecovery() {
    const records = AppStorage.getRecoveryResults();
    if (!records.length) { _notice('There are no archived scores on this device.'); return; }
    const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'unsent-scores.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function _archivePending(record, reason, message) {
    AppStorage.archivePendingResults(record, reason);
    _notice(message, true);
}

function _archiveStalePending(record) {
    _archivePending(record, 'session_changed', 'Unsent scores from an earlier lane session are kept on this device. They were not sent. Download them for recovery.');
}

function _archiveFinishedPending(record) {
    _archivePending(record, 'event_finished', 'The competition finished before some scores were sent. They are kept on this device. Download them for recovery.');
}

async function _refreshAllParticipantStates() {
    const context = _context();
    const loaded = await Promise.allSettled(participants.map(async participant => {
        const version = _scoreVersion(context.code, participant.id);
        return { id: participant.id, version, state: await api.getParticipantState(context.code, participant.id) };
    }));
    if (!_isCurrent(context)) return;
    let failed = 0;
    for (const item of loaded) {
        if (item.status === 'rejected') { failed++; continue; }
        const participant = item.value;
        if (participant.version === _scoreVersion(context.code, participant.id)) {
            AppStorage.saveParticipantState(participant.id, _mergePendingResults(participant.id, participant.state));
        }
    }
    if (failed) _notice(`Could not refresh the scores of ${failed} participant${failed === 1 ? '' : 's'}. The saved scores are shown.`);
}

function _mergePendingResults(participantId, serverState) {
    const state = JSON.parse(JSON.stringify(serverState));
    const sessionId = AppStorage.getLaneSession(currentLane);
    if (!sessionId) return state;
    for (const pending of AppStorage.getPendingResults(currentCode, currentLane)) {
        if (pending.session_id !== sessionId) continue;
        if (pending.participant_id !== participantId) continue;
        const distance = state.distances.find(d => d.distance_id === pending.distance_id);
        if (!distance) continue;
        distance.shots = pending.shots
            .map(shot => ({ shot: shot.shot_number, score: shot.score, is_x: shot.is_x }))
            .sort((a, b) => a.shot - b.shot);
        distance.total_score = distance.shots.length
            ? distance.shots.reduce((sum, shot) => sum + shot.score, 0)
            : null;
        distance.x_count = distance.shots.filter(shot => shot.is_x).length;
        distance.shots_taken = distance.shots.length;
    }
    return state;
}

async function _syncPendingResults() {
    const code = currentCode;
    const lane = currentLane;
    const sessionId = AppStorage.getLaneSession(lane);
    if (!sessionId) return;
    for (const pending of AppStorage.getPendingResults(code, lane)) {
        if (pending.session_id !== sessionId) { _archiveStalePending(pending); continue; }
        if (eventData?.status === 'finished') { _archiveFinishedPending(pending); continue; }
        if (eventData?.status !== 'started') continue;
        try {
            await _queueResultReplacement(
                code, pending.participant_id, pending.distance_id, lane, sessionId,
                pending.shots, true
            );
        } catch (err) {
            _reportError('Unsent scores remain on this device. Could not sync them.', err);
        }
    }
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
        const state = AppStorage.getParticipantState(p.id);
        let distSummary = '';
        if (distances.length) {
            const tags = distances.map(d => {
                const ds = state?.distances.find(x => x.distance_id === d.id);
                let score = '—';
                if (d.status === 'finished' || d.status === 'active') {
                    score = ds?.total_score !== null && ds?.total_score !== undefined ? ds.total_score : '—';
                }
                // The number of results that are entered, out of the shots of the distance.
                const taken = ds ? (ds.shots_taken ?? ds.shots?.length ?? 0) : 0;
                const count = d.shots_count ? `${taken}/${d.shots_count}` : `${taken}`;
                const cls = d.status === 'active' ? 'dist-tag-active' : (d.status === 'finished' ? 'dist-tag-done' : 'dist-tag-pending');
                return `<span class="dist-tag ${cls}">${_esc(d.title)}: ${score} · ${count}</span>`;
            }).join('');
            distSummary = `<div class="participant-dist-summary">${tags}</div>`;
        }
        let total = 0;
        state?.distances.forEach(ds => { if (ds.total_score !== null) total += ds.total_score; });
        return `
        <div class="participant-card" data-pid="${p.id}">
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
    if (participantSubmitting) return;
    participantSubmitting = true;
    const context = _context();
    const button = document.querySelector('#participant-form button[type="submit"]');
    if (button) button.disabled = true;
    const sid = AppStorage.getLaneSession(currentLane);
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
        await api.addParticipant(context.code, participant, sid);
        if (!_isCurrent(context)) return;
        document.getElementById('participant-form').reset();
        await loadLaneParticipants({ show: true });
    } catch (error) {
        if (_isCurrent(context)) _reportError('Could not add the participant.', error);
    } finally {
        participantSubmitting = false;
        if (button) button.disabled = false;
    }
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

    const participant = participants.find(p => p.id === participantId);
    if (!participant) throw new Error('Participant not found. Refresh the lane.');
    const context = _context();
    const navigation = navigationVersion;
    const opening = ++scoreOpenVersion;
    let state;
    try {
        state = await api.getParticipantState(context.code, participantId);
    } catch (error) {
        state = AppStorage.getParticipantState(participantId);
        if (!state) throw error;
        _reportError('Could not load current scores. The saved scores on this device are shown.', error);
    }
    if (!_isCurrent(context) || navigation !== navigationVersion || opening !== scoreOpenVersion) return;
    if (eventData.status !== 'started' || _getActiveDist()?.id !== activeDist.id) return _reconcile();
    currentParticipant = participant;
    participantState = _mergePendingResults(participantId, state);
    AppStorage.saveParticipantState(participantId, participantState);

    const activeState = participantState.distances.find(d => d.distance_id === activeDist.id);
    currentDistanceId = activeDist.id;
    results = activeState ? activeState.shots.map(s => ({
        participant_id: participantId,
        distance_id:    activeDist.id,
        shot:           s.shot,
        score:          s.score,
        is_x:           s.is_x
    })) : [];
    results = sortSeries(results);
    _lastEntry = null;

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
    const series = Math.ceil(total / CONFIG.SERIES_SIZE);
    for (let s = 1; s <= series; s++) {
        const row = document.createElement('div');
        row.className = 'series-row';
        row.id = `series-${s}`;

        const num = document.createElement('div');
        num.textContent = s;
        row.appendChild(num);

        const seriesRes = results
            .filter(r => Math.ceil(r.shot / CONFIG.SERIES_SIZE) === s)
            .sort((a, b) => a.shot - b.shot);

        for (let sh = 1; sh <= CONFIG.SERIES_SIZE; sh++) {
            const idx = (s - 1) * CONFIG.SERIES_SIZE + sh;
            if (idx > total) break;
            const btn    = document.createElement('button');
            btn.className      = 'shot-btn';
            btn.dataset.series = s;
            btn.dataset.shot   = sh;
            btn.onclick = ev => selectShot(s, sh, ev);
            const res = seriesRes.find(result => result.shot === idx);
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
let _lastEntry   = null; // the value and series that the user entered last, for the delete button

function _scoresEditable() {
    if (eventData?.status === 'started') return true;
    alert('Scores can only be changed while the competition is running. Your saved scores remain on this device.');
    return false;
}

function selectShot(series, shot, ev) {
    const btn     = ev.currentTarget;
    const shotNum = (series - 1) * CONFIG.SERIES_SIZE + shot;
    const exist   = results.find(r => r.shot === shotNum);

    if (exist && btn.classList.contains('selected')) {
        if (!_scoresEditable()) return;
        if (confirm('Clear this score?')) {
            results = sortSeries(results.filter(r => r.shot !== shotNum));
            _lastEntry = null;
            renderScoreGrid();
            updateTotalScore();
            _saveCurrentResults();
        }
        return;
    }
    _currentShot = { series, shot, shotNum };
    document.querySelectorAll('.shot-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
}

function inputScore(score, isX = false) {
    if (eventData?.status !== 'started') {
        alert('Scores can only be entered while the competition is running. Your saved scores remain on this device.');
        return;
    }
    const ad = _getActiveDist();
    if (!ad) { alert('No active distance.'); return; }

    const next = _findNextEmpty();
    const editing = _currentShot && results.some(result => result.shot === _currentShot.shotNum);
    if (!next && !editing) { alert('All shots filled'); return; }

    if (_currentShot && !editing && (_currentShot.series !== next.series || _currentShot.shot !== next.shot)) {
        alert(`Fill in order. Next: Series ${next.series}, Shot ${next.shot}`);
        _currentShot = next;
        const b = document.querySelector(`[data-series="${next.series}"][data-shot="${next.shot}"]`);
        if (b) { document.querySelectorAll('.shot-btn').forEach(x => x.classList.remove('selected')); b.classList.add('selected'); _scrollToSeries(next.series); }
        return;
    }

    if (!_currentShot) _currentShot = next;
    const { shotNum, series } = _currentShot;

    results = results.filter(r => r.shot !== shotNum);
    results.push({ participant_id: currentParticipant.id, distance_id: ad.id, shot: shotNum, score, is_x: isX });
    // The shots of a series are in order from the highest to the lowest, so a new shot can move.
    results = sortSeries(results);
    _lastEntry = { score, is_x: isX, series };

    renderScoreGrid();
    updateTotalScore();
    _saveCurrentResults();

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
    for (let s = 1; s <= Math.ceil(ad.shots_count / CONFIG.SERIES_SIZE); s++) {
        for (let sh = 1; sh <= CONFIG.SERIES_SIZE; sh++) {
            const num = (s - 1) * CONFIG.SERIES_SIZE + sh;
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
    _currentShot = next;
    if (!next) return;
    const participantId = currentParticipant?.id;
    const distanceId = currentDistanceId;
    setTimeout(() => {
        if (currentParticipant?.id !== participantId || currentDistanceId !== distanceId || _currentShot?.shotNum !== next.shotNum) return;
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
    if (!_scoresEditable()) return;

    // Remove the shot that the user entered last. The series stays in order.
    results = removeLastShot(results, _lastEntry);
    _lastEntry = null;

    // Show the grid, and select the first empty slot
    renderScoreGrid();
    updateTotalScore();

    await _saveCurrentResults();
}

const _seriesScore = s => seriesScore(results, s);
const _cumScore    = upTo => cumScore(results, upTo);

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
    if (!currentParticipant || !currentDistanceId) return true;
    return _saveCurrentResults();
}

async function _saveCurrentResults() {
    if (!currentParticipant || !currentDistanceId) return false;
    const code = currentCode;
    const participantId = currentParticipant.id;
    const distanceId = currentDistanceId;
    const lane = currentLane;
    const sessionId = AppStorage.getLaneSession(lane);
    const version = _scoreVersion(code, participantId) + 1;
    scoreVersions.set(`${code}:${participantId}`, version);
    const snapshot = _mapForApi().map(({shot_number, score, is_x}) => ({shot_number, score, is_x}));
    try { AppStorage.savePendingResults(code, participantId, distanceId, lane, sessionId, snapshot); }
    catch (error) { _reportError('Scores are not saved on this device.', error); return false; }
    const status = document.getElementById('save-status');
    if (status && currentParticipant?.id === participantId) status.textContent = 'Saving…';

    try {
        const result = await _queueResultReplacement(
            code, participantId, distanceId, lane, sessionId, snapshot
        );
        if (result.cleared) {
            try {
                const fresh = await api.getParticipantState(code, participantId);
                if (currentCode === code && currentLane === lane && _scoreVersion(code, participantId) === version) {
                    AppStorage.saveParticipantState(participantId, _mergePendingResults(participantId, fresh));
                }
            } catch (error) { _reportError('Scores were saved. Could not refresh the totals.', error); }
        }
        if (result.cleared && currentCode === code && currentParticipant?.id === participantId
            && currentDistanceId === distanceId && status) {
            status.textContent = 'Saved';
        }
        return result.sent;
    } catch (err) {
        console.warn('Results remain saved on this device and will retry when the connection returns:', err);
        if (currentCode === code && currentParticipant?.id === participantId
            && currentDistanceId === distanceId && status) {
            status.textContent = 'Saved on device; waiting to sync';
        }
        return false;
    }
}

async function _queueResultReplacement(code, participantId, distanceId, lane, sessionId, fallbackShots, onlyIfPending = false) {
    const key = `${code}:${participantId}:${distanceId}`;
    const previous = resultSaveQueue.get(key) || Promise.resolve();
    const task = previous.catch(error => console.warn('Previous score save failed. Retrying:', error)).then(async () => {
        const pending = AppStorage.getPendingResult(code, participantId, distanceId);
        if (onlyIfPending && !pending) return { sent: false, cleared: false };
        if (pending && (!sessionId || pending.session_id !== sessionId)) {
            _archiveStalePending(pending);
            return { sent: false, cleared: false };
        }
        if (!sessionId || AppStorage.getLaneSession(lane) !== sessionId) return { sent: false, cleared: false };
        const latestShots = pending?.shots ?? fallbackShots;
        await api.replaceDistanceResults(
            code, participantId, distanceId, latestShots, sessionId
        );
        const latest = AppStorage.getPendingResult(code, participantId, distanceId);
        const cleared = !latest || (latest.session_id === sessionId && JSON.stringify(latest.shots) === JSON.stringify(latestShots));
        if (latest && cleared) {
            AppStorage.clearPendingResults(code, participantId, distanceId);
        }
        return { sent: true, cleared };
    });
    resultSaveQueue.set(key, task);
    try {
        return await task;
    } finally {
        if (resultSaveQueue.get(key) === task) resultSaveQueue.delete(key);
    }
}

async function backToParticipants() {
    const ad = _getActiveDist();
    if (ad) {
        const totalSeries = Math.ceil(ad.shots_count / CONFIG.SERIES_SIZE);
        for (let s = 1; s <= totalSeries; s++) {
            const shots = results.filter(r => Math.ceil(r.shot / CONFIG.SERIES_SIZE) === s);
            const expected = Math.min(CONFIG.SERIES_SIZE, ad.shots_count - (s - 1) * CONFIG.SERIES_SIZE);
            if (shots.length && shots.length < expected) {
                if (!confirm(`Series ${s} incomplete (${shots.length}/${expected}). Exit anyway?`)) return;
                break;
            }
        }
    }
    if (results.length || AppStorage.getPendingResult(currentCode, currentParticipant?.id, currentDistanceId)) {
        await _autoSave();
    }
    currentParticipant = null;
    currentDistanceId = null;
    results = [];
    _showScreen('participants-screen');
    try { await loadLaneParticipants(); }
    catch (error) { _reportError('Could not load the participants.', error); }
}

// ============================================================
// EVENT / DISTANCE STATUS HANDLERS
// ============================================================
function handleEventStatus() { return _reconcile(); }
function handleDistanceUpdate() { return _reconcile(); }

function handleLaneSessionReset(data) {
    if (data.lane_number !== currentLane) return;
    alert('Your lane session has been reset by the admin. You will be redirected to lane selection.');
    if (wsClient) {
        wsClient.disconnect();
        wsClient = null;
    }
    for (const pending of AppStorage.getPendingResults(currentCode, currentLane)) _archiveStalePending(pending);
    contextVersion++;
    AppStorage.clearLaneSession(currentLane);
    AppStorage.clearLane();
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
    _stopResetWatch();
    contextVersion++;
    _clearLanePassword();
    AppStorage.clearEventCode('client');
    AppStorage.clearLane();
    if (wsClient) wsClient.disconnect();
    location.reload();
}

function backToLane() {
    _stopResetWatch();
    contextVersion++;
    _clearLanePassword();
    currentParticipant = null;
    currentDistanceId = null;
    results = [];
    if (wsClient) wsClient.disconnect();
    AppStorage.clearLane();
    currentLane = null;
    showLaneSelection();
}

// ============================================================
// HELPERS
// ============================================================
function _showScreen(screenId) {
    navigationVersion++;
    if (screenId !== 'lane-password-screen' && lanePassword) _clearLanePassword();
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    const el = document.getElementById(screenId);
    if (el) el.classList.remove('hidden');
}
