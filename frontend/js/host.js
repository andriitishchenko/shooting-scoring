// HOST JavaScript — all sensitive data in Storage, never in HTML attributes
'use strict';

let currentCode        = null;
let currentEventData   = null;
let currentDistances   = [];
let wsClient           = null;
let allParticipants    = [];
let allResults         = {};
// detail modal context (stored in closure, not DOM)
let _detailContext = null;
let _detailSaving = false;

// ============================================================
// INIT
// ============================================================
window.addEventListener('DOMContentLoaded', () => {
    const savedCode = AppStorage.getEventCode('host');
    const savedSid  = AppStorage.getHostSession();
    if (savedCode && savedSid) {
        currentCode = savedCode;
        loadAdminPanel();
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        ['settings-modal', 'participant-modal', 'detail-modal'].some(id => {
            const el = document.getElementById(id);
            if (el && !el.classList.contains('hidden')) {
                if (id === 'detail-modal') closeDetailModal();
                else el.classList.add('hidden');
                return true;
            }
            return false;
        });
    });

    // Touch/click-to-copy badges — touchstart eliminates 300ms tap delay on mobile
    function _addCopyListener(id, getText, msg) {
        const el = document.getElementById(id);
        let _didTouch = false;
        el.addEventListener('touchstart', (e) => {
            e.preventDefault();
            _didTouch = true;
            copyToClipboard(getText(), id, msg);
        }, { passive: false });
        el.addEventListener('click', () => {
            if (_didTouch) { _didTouch = false; return; }
            copyToClipboard(getText(), id, msg);
        });
    }
    _addCopyListener('event-code-display',     () => currentCode,               'Code copied!');
    _addCopyListener('event-password-display', () => AppStorage.getHostPassword(), 'Password copied!');
});

// ============================================================
// LOGIN
// ============================================================
async function hostEnter() {
    const code     = document.getElementById('code-input').value.trim().toUpperCase();
    const password = document.getElementById('password-input').value.trim();

    if (code.length !== CONFIG.CODE_LENGTH) {
        alert(`Code must be ${CONFIG.CODE_LENGTH} characters`);
        return;
    }

    // Try to see if the event exists first
    let eventExists = true;
    try { await api.getEvent(code); }
    catch (err) {
        if (err.status !== 404) { alert('Could not check the event: ' + err.message); return; }
        eventExists = false;
    }

    if (!eventExists) {
        if (!confirm('Event not found. Create new event?')) return;
        try {
            const res = await api.createEvent(code);
            // res: { code, host_password, session_id }
            AppStorage.saveEventCode(code, 'host');
            AppStorage.saveHostSession(res.session_id);
            AppStorage.saveHostPassword(res.host_password);
            currentCode = code;
            loadAdminPanel();
        } catch (err) {
            alert('Error creating event: ' + err.message);
        }
        return;
    }

    // Event exists — log in via sessions endpoint
    const savedSid = AppStorage.getHostSession();
    try {
        const res = await api.hostLogin(code, password, savedSid);
        AppStorage.saveEventCode(code, 'host');
        AppStorage.saveHostSession(res.session_id);
        if (password) AppStorage.saveHostPassword(password);
        currentCode = code;
        loadAdminPanel();
    } catch (err) {
        alert('Login failed: ' + err.message);
    }
}

function loadAdminPanel() {
    document.getElementById('code-screen').classList.add('hidden');
    document.getElementById('admin-screen').classList.remove('hidden');

    _updateHeaderDisplay();
    loadEventData();
    _connectWS();
}

function _updateHeaderDisplay() {
    const codeEl = document.getElementById('event-code-display');
    const pwEl   = document.getElementById('event-password-display');
    codeEl.textContent = `Code: ${currentCode}`;
    const pw = AppStorage.getHostPassword();
    if (pw) {
        pwEl.textContent = `🔑 ${pw}`;
        pwEl.classList.remove('hidden');
    } else {
        pwEl.classList.add('hidden');
    }
}

function _connectWS() {
    if (wsClient) wsClient.disconnect();
    wsClient = new WSClient(currentCode, AppStorage.getHostSession());
    wsClient.connect();
    wsClient.on('result_update', () => _scheduleReload(true));
    wsClient.on('refresh', () => _scheduleReload(false));
    // Another admin device can start the event or a distance.
    wsClient.on('event_status', () => _scheduleReload(false, true));
    wsClient.on('distance_update', () => _scheduleReload(false, true));
    wsClient.on('authenticated', () => loadEventData());
    wsClient.on('session_rejected', _sessionEnded);
    // A lane asks for a reset, or a lane password changes.
    wsClient.on('lane_reset_requested', () => _scheduleReload(false));
    wsClient.on('lane_session_reset', () => _scheduleReload(false));
}

// The server ended the session, for example after a password change on another device.
function _sessionEnded() {
    if (wsClient) wsClient.disconnect();
    AppStorage.clearHostSession();
    document.getElementById('admin-screen').classList.add('hidden');
    document.getElementById('code-screen').classList.remove('hidden');
    document.getElementById('code-input').value = currentCode ?? '';
    document.getElementById('password-input').value = '';
    alert('Your admin session ended. Log in again with the admin password.');
}

// Many score updates arrive together. Reload once for all of them.
let _reloadTimer = null;
let _reloadResults = false;
let _reloadEvent = false;
function _scheduleReload(includeResults, includeEvent = false) {
    if (includeResults) _reloadResults = true;
    if (includeEvent) _reloadEvent = true;
    if (_reloadTimer) return;
    _reloadTimer = setTimeout(async () => {
        _reloadTimer = null;
        const withResults = _reloadResults;
        const withEvent = _reloadEvent;
        _reloadResults = _reloadEvent = false;
        if (withEvent) await loadEventData();   // the event, the distances, and the participants
        else await loadParticipants();
        if (withResults && document.getElementById('tab-results').classList.contains('active')) await loadResults();
    }, 300);
}

// ============================================================
// TAB SWITCHING
// ============================================================
function switchTab(name) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`tab-btn-${name}`).classList.add('active');
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById(`tab-${name}`).classList.add('active');
    if (name === 'participants') loadParticipants();
    else if (name === 'results') loadResults();
}

// ============================================================
// EVENT DATA
// ============================================================
async function loadEventData() {
    try {
        const event = await api.getEvent(currentCode);
        currentEventData = event;
        updateStatusDisplay(event.status);

        const addBtn = document.getElementById('add-participant-btn');
        addBtn.disabled = event.status !== 'created';
        addBtn.title = event.status !== 'created' ? 'Cannot add participants after competition started' : '';

        if (event.status === 'started') {
            document.getElementById('start-btn').classList.add('hidden');
            document.getElementById('finish-btn').classList.remove('hidden');
        } else if (event.status === 'finished') {
            document.getElementById('start-btn').classList.add('hidden');
            document.getElementById('finish-btn').classList.add('hidden');
        }

        await loadDistances();
        await loadParticipants();
    } catch (err) {
        console.error('Error loading event:', err);
    }
}

function updateStatusDisplay(status) {
    const el = document.getElementById('status-badge');
    el.className = `status-badge ${status}`;
    el.textContent = { created: 'Not Started', started: 'In Progress', finished: 'Finished' }[status] || status;
}

async function startEvent() {
    if (!confirm('Start the competition? Participants cannot be added after start.')) return;
    try {
        await api.updateEvent(currentCode, { status: 'started' });
        currentEventData.status = 'started';
        document.getElementById('start-btn').classList.add('hidden');
        document.getElementById('finish-btn').classList.remove('hidden');
        document.getElementById('add-participant-btn').disabled = true;
        updateStatusDisplay('started');
        renderDistances();
        alert('Competition started! Use distance buttons to start each distance.');
    } catch (err) { alert('Error: ' + err.message); }
}

async function finishEvent() {
    if (!confirm('Finish the competition? This action cannot be undone.')) return;
    try {
        await api.updateEvent(currentCode, { status: 'finished' });
        currentEventData.status = 'finished';
        document.getElementById('finish-btn').classList.add('hidden');
        updateStatusDisplay('finished');
        await loadDistances();
        alert('Competition finished!');
    } catch (err) { alert('Error: ' + err.message); }
}

// ============================================================
// DISTANCES
// ============================================================
async function loadDistances() {
    currentDistances = await api.getDistances(currentCode);
    renderDistances();
}

function renderDistances() {
    const list = document.getElementById('distances-list');
    const evStatus = currentEventData ? currentEventData.status : 'created';
    const addBtn = document.getElementById('add-distance-btn');
    if (addBtn) addBtn.style.display = evStatus === 'finished' ? 'none' : '';

    if (!currentDistances.length) {
        list.innerHTML = '<p class="empty-text">No distances configured</p>';
        return;
    }

    list.innerHTML = currentDistances.map((d, idx) => {
        const isPending  = d.status === 'pending';
        const isActive   = d.status === 'active';
        const isFinished = d.status === 'finished';
        const canEdit    = isPending && evStatus !== 'finished';
        const canDelete  = isPending && currentDistances.length > 1 && evStatus !== 'finished';

        let actionBtn = '';
        if (evStatus === 'started') {
            if (isPending)  actionBtn = `<button class="btn btn-sm btn-success dist-btn" data-click="startDistance" data-args="[${d.id}]">▶ Start</button>`;
            else if (isActive) actionBtn = `<button class="btn btn-sm btn-danger dist-btn" data-click="stopDistance" data-args="[${d.id}]">■ Stop</button>`;
        }

        const statusLabel = {
            pending:  '<span class="dist-status dist-pending">Pending</span>',
            active:   '<span class="dist-status dist-active">● Active</span>',
            finished: '<span class="dist-status dist-finished">✓ Done</span>'
        }[d.status];

        return `
        <div class="dist-row ${isActive ? 'dist-row-active' : ''} ${isFinished ? 'dist-row-finished' : ''}">
            <div class="dist-title-cell">
                ${canEdit
                    ? `<input class="dist-title-input" data-dist-id="${d.id}" value="${escHtml(d.title)}"
                              data-blur="updateDistTitle" data-args="[${d.id}]"
                              data-enter="blurElement">`
                    : `<span class="dist-title-static">${escHtml(d.title)}</span>`}
            </div>
            <div class="dist-shots-cell">
                ${canEdit
                    ? `<button class="btn-shots" data-click="changeShots" data-args="[${d.id},-1]">−</button>
                       <span class="shots-val" id="shots-val-${d.id}">${d.shots_count}</span>
                       <button class="btn-shots" data-click="changeShots" data-args="[${d.id},1]">+</button>`
                    : `<span class="shots-val">${d.shots_count} shots</span>`}
            </div>
            <div class="dist-status-cell">${statusLabel}</div>
            <div class="dist-actions-cell">
                ${actionBtn}
                ${canDelete ? `<button class="btn btn-sm btn-danger dist-btn" data-click="deleteDistance" data-args="[${d.id}]">✕</button>` : ''}
            </div>
        </div>`;
    }).join('');
}

function escHtml(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function csvField(s) {
    // Escape for CSV: wrap in quotes, escape inner quotes.
    // Prefix formula-injection characters (=, +, -, @, TAB, CR) with a single quote.
    const str = String(s ?? '').replace(/"/g, '""');
    const safe = /^[=+\-@\t\r]/.test(str) ? "'" + str : str;
    return `"${safe}"`;
}

async function addDistance() {
    try {
        await api.addDistance(currentCode, { title: `Distance ${currentDistances.length + 1}`, shots_count: 30 });
        await loadDistances();
    } catch (err) { alert(err.message); }
}

async function updateDistTitle(distId, newTitle) {
    if (!newTitle.trim()) return;
    const d = currentDistances.find(x => x.id === distId);
    if (d && d.title === newTitle.trim()) return;
    try {
        await api.updateDistance(currentCode, distId, { title: newTitle.trim() });
        await loadDistances();
    } catch (err) { alert(err.message); }
}

async function changeShots(distId, delta) {
    const d = currentDistances.find(x => x.id === distId);
    if (!d) return;
    // The server allows 1 to 300 shots. A cap of 200 cut a longer distance back to 200.
    const newCount = Math.max(1, Math.min(300, d.shots_count + delta));
    if (newCount === d.shots_count) return;
    try {
        await api.updateDistance(currentCode, distId, { shots_count: newCount });
        d.shots_count = newCount;
        const el = document.getElementById(`shots-val-${distId}`);
        if (el) el.textContent = newCount;
    } catch (err) { alert(err.message); }
}

async function startDistance(distId) {
    const d = currentDistances.find(x => x.id === distId);
    const active = currentDistances.find(x => x.status === 'active');
    let msg = `Start "${d ? d.title : distId}"?`;
    if (active) msg += `\n\n⚠️ "${active.title}" will be marked FINISHED.`;
    if (!confirm(msg)) return;
    try {
        await api.updateDistance(currentCode, distId, { status: 'active' });
        await loadDistances();
    } catch (err) { alert(err.message); }
}

async function stopDistance(distId) {
    const d = currentDistances.find(x => x.id === distId);
    if (!confirm(`Finish "${d ? d.title : distId}"? Cannot be undone.`)) return;
    try {
        await api.updateDistance(currentCode, distId, { status: 'finished' });
        await loadDistances();
    } catch (err) { alert(err.message); }
}

async function deleteDistance(distId) {
    if (!confirm('Delete this distance?')) return;
    try {
        await api.deleteDistance(currentCode, distId);
        await loadDistances();
    } catch (err) { alert(err.message); }
}

// ============================================================
// PARTICIPANTS
// ============================================================
let _participantsRequest = 0;
let _resultsRequest = 0;
async function loadParticipants() {
    const request = ++_participantsRequest;
    try {
        const [parts, lanesResp] = await Promise.all([
            api.getParticipants(currentCode),
            api.listLaneSessions(currentCode).catch(() => ({ lanes: [] }))
        ]);
        if (request !== _participantsRequest) return;
        allParticipants = parts;
        const requests = lanesResp.requests || {};
        renderParticipants(allParticipants, lanesResp.lanes || [], lanesResp.passwords || {}, requests);
        _updateResetBanner(requests);
    } catch (err) {
        if (request !== _participantsRequest) return;
        document.getElementById('participants-container').innerHTML =
            '<p class="empty-text">Error loading participants</p>';
    }
}

// The banner shows while a lane waits for the host to decide about a password reset.
function _updateResetBanner(requests) {
    const banner = document.getElementById('reset-banner');
    if (!banner) return;
    const lanes = Object.keys(requests);
    banner.textContent = lanes.length === 1
        ? `🔔 Lane ${lanes[0]} asks for a password reset`
        : `🔔 ${lanes.length} lanes ask for a password reset`;
    banner.classList.toggle('hidden', lanes.length === 0);
}

function renderParticipants(participants, sessionLanes = [], passwords = {}, requests = {}) {
    const container = document.getElementById('participants-container');

    // Merge participant lanes with session-only lanes
    const participantLanes = new Set(participants.map(p => p.lane_number));
    const allLanes = [...new Set([...participantLanes, ...sessionLanes])].sort((a, b) => a - b);

    if (!allLanes.length) {
        container.innerHTML = `<div class="empty-state-box"><p>No participants yet</p><p>Click "Add Participant" to add the first one.</p></div>`;
        return;
    }

    participants.sort((a, b) => a.lane_number - b.lane_number || a.shift.localeCompare(b.shift));
    const byLane = {};
    participants.forEach(p => { (byLane[p.lane_number] = byLane[p.lane_number] || []).push(p); });
    const canManageParticipants = currentEventData?.status === 'created';

    container.innerHTML = allLanes.map(lane => {
        const ps = byLane[lane] || [];
        const hasSession = sessionLanes.includes(lane);
        const sessionTag = hasSession
            ? '<span class="lane-session-active" title="Active session">🔑</span>'
            : '';
        const passwordTag = passwords[lane]
            ? `<span class="lane-password" title="Double-click to copy" data-dblclick="copyLanePassword" data-args="${escHtml(JSON.stringify([passwords[lane]]))}">${escHtml(passwords[lane])}</span>`
            : '';
        const requestBox = requests[lane]
            ? `<span class="lane-request-box">
                   <span class="lane-request" title="Asked at ${escHtml(requests[lane])}">🔔 Reset requested</span>
                   <button class="btn btn-sm btn-success" data-click="approveLaneReset" data-args="[${lane}]">Approve</button>
                   <button class="btn btn-sm btn-secondary" data-click="denyLaneReset" data-args="[${lane}]">Deny</button>
               </span>`
            : '';
        const participantRows = ps.map(p => `
            <div class="participant-row">
                <div class="participant-lane-shift">${p.lane_number}${escHtml(p.shift)}</div>
                <div class="participant-details">
                    <div class="participant-name-inline">${escHtml(p.name)}</div>
                    <div class="participant-meta">
                        ${p.gender          ? `<span class="meta-badge">${escHtml(p.gender)}</span>` : ''}
                        ${p.personal_number ? `<span class="meta-badge">№${escHtml(p.personal_number)}</span>` : ''}
                        ${p.shooting_type   ? `<span class="meta-badge">${escHtml(p.shooting_type)}</span>` : ''}
                        ${p.group_type      ? `<span class="meta-badge">${escHtml(p.group_type)}</span>` : ''}
                        ${p.age_category    ? `<span class="meta-badge">${escHtml(p.age_category)}</span>` : ''}
                    </div>
                </div>
                <div class="participant-actions">
                    ${canManageParticipants ? `
                        <button class="btn-edit-inline" data-pid="${p.id}" data-click="editParticipant" data-args="[${p.id}]">✎ Edit</button>
                        <button class="btn btn-sm btn-danger" data-pid="${p.id}" data-click="removeParticipant" data-args="[${p.id}]">🗑️</button>
                    ` : ''}
                </div>
            </div>`).join('');

        const emptyMsg = ps.length === 0
            ? '<div class="lane-empty-msg">No participants on this lane yet</div>'
            : '';

        return `
        <div class="lane-group${hasSession ? ' lane-group-has-session' : ''}">
            <div class="lane-group-header">
                <span>Lane ${lane} ${sessionTag} ${passwordTag}</span>
                ${requestBox}
                <button class="btn btn-sm btn-danger lane-reset-btn" data-click="resetLaneSession" data-args="[${lane}]">Reset Session</button>
            </div>
            <div class="lane-participants">
                ${participantRows}
                ${emptyMsg}
            </div>
        </div>`;
    }).join('');
}

// The host approves the request of a lane. The lane gets a new password. The old sessions end.
async function approveLaneReset(lane) {
    if (!confirm(`Approve the password reset for Lane ${lane}?\n\nThe devices that use this lane now are disconnected. The device that asked gets a new password.`)) return;
    try {
        await api.approveLaneReset(currentCode, lane);
        await loadParticipants();
        alert(`Lane ${lane} has a new password. The password shows next to the lane.`);
    } catch (err) { alert('Error: ' + err.message); }
}

async function denyLaneReset(lane) {
    try {
        await api.denyLaneReset(currentCode, lane);
        await loadParticipants();
    } catch (err) { alert('Error: ' + err.message); }
}

async function resetLaneSession(laneNumber) {
    if (!confirm(`Reset session for Lane ${laneNumber}?\nThe client on this lane will be disconnected.`)) return;
    try {
        await api.resetLaneSession(currentCode, laneNumber);
        // Notify client on that lane via WS
        alert(`Session for Lane ${laneNumber} has been reset.`);
        await loadParticipants();
    } catch (err) { alert('Error resetting session: ' + err.message); }
}

// ============================================================
// PARTICIPANT MODAL
// ============================================================
function showAddParticipantModal() {
    document.getElementById('modal-title').textContent = 'Add Participant';
    document.getElementById('submit-participant-btn').textContent = 'Add Participant';
    document.getElementById('edit-participant-id').value = '';
    document.getElementById('participant-form').reset();
    document.getElementById('participant-modal').classList.remove('hidden');
    setTimeout(() => document.getElementById('p-name').focus(), 100);
}

function editParticipant(pid) {
    if (currentEventData?.status !== 'created') return;
    const p = allParticipants.find(x => x.id === pid);
    if (!p) return;
    document.getElementById('modal-title').textContent = 'Edit Participant';
    document.getElementById('submit-participant-btn').textContent = 'Update Participant';
    document.getElementById('edit-participant-id').value = pid;
    document.getElementById('p-name').value = p.name;
    document.getElementById('p-lane').value = p.lane_number;
    document.getElementById('p-shift').value = p.shift;
    document.getElementById('p-gender').value = p.gender || '';
    document.getElementById('p-age-category').value = p.age_category || '';
    document.getElementById('p-shooting-type').value = p.shooting_type || '';
    document.getElementById('p-group').value = p.group_type || '';
    document.getElementById('p-number').value = p.personal_number || '';
    document.getElementById('participant-modal').classList.remove('hidden');
    setTimeout(() => document.getElementById('p-name').focus(), 100);
}

function closeParticipantModal() {
    document.getElementById('participant-modal').classList.add('hidden');
    document.getElementById('participant-form').reset();
    document.getElementById('edit-participant-id').value = '';
}

async function submitParticipant(e) {
    e.preventDefault();
    const pid = document.getElementById('edit-participant-id').value;
    const data = {
        name:            document.getElementById('p-name').value,
        lane_number:     parseInt(document.getElementById('p-lane').value),
        shift:           document.getElementById('p-shift').value.toUpperCase(),
        gender:          document.getElementById('p-gender').value || null,
        age_category:    document.getElementById('p-age-category').value || null,
        shooting_type:   document.getElementById('p-shooting-type').value || null,
        group_type:      document.getElementById('p-group').value || null,
        personal_number: document.getElementById('p-number').value || null
    };
    try {
        if (pid) await api.updateParticipant(currentCode, pid, data);
        else     await api.addParticipant(currentCode, data);
        closeParticipantModal();
        await loadParticipants();
        alert(pid ? 'Participant updated!' : 'Participant added!');
    } catch (err) { alert('Error: ' + err.message); }
}

async function removeParticipant(pid) {
    if (!confirm('Remove this participant?')) return;
    if (currentEventData?.status !== 'created') { alert('Participants can only be removed before the competition starts.'); return; }
    try {
        await api.deleteParticipant(currentCode, pid);
        await loadParticipants();
    } catch (err) { alert('Error: ' + err.message); }
}

// ============================================================
// SETTINGS
// ============================================================
async function openSettingsModal() {
    try {
        const props = await api.getProperties(currentCode);
        document.getElementById('setting-host-pw').value = '';
        document.getElementById('setting-viewer-pw').value = '';
        document.getElementById('setting-viewer-public').checked = !props.viewer_password_configured;
        document.getElementById('setting-allow-add').checked = props.client_allow_add_participant !== false;
        document.getElementById('setting-lane-count').value = props.lane_count ?? CONFIG.LANE_COUNT;
    } catch (err) {
        alert('Could not load the settings: ' + err.message);
        return;
    }
    document.getElementById('settings-error').classList.add('hidden');
    document.getElementById('settings-modal').classList.remove('hidden');
}

function closeSettingsModal() {
    document.getElementById('settings-modal').classList.add('hidden');
}

async function saveSettings() {
    const hostPw    = document.getElementById('setting-host-pw').value.trim();
    const viewerPw  = document.getElementById('setting-viewer-pw').value.trim();
    const allowAdd  = document.getElementById('setting-allow-add').checked;
    const laneCount = Number(document.getElementById('setting-lane-count').value);
    const errEl     = document.getElementById('settings-error');
    errEl.classList.add('hidden');

    try {
        if (!Number.isInteger(laneCount) || laneCount < 1 || laneCount > 999)
            throw new Error('The number of lanes must be from 1 to 999.');
        const updates = {
            client_allow_add_participant: allowAdd,
            lane_count: laneCount
        };
        if (hostPw) updates.host_password = hostPw;
        if (viewerPw) updates.viewer_password = viewerPw;
        else if (document.getElementById('setting-viewer-public').checked) updates.viewer_password = '';

        await api.updateProperties(currentCode, updates);
        if (hostPw) AppStorage.saveHostPassword(hostPw);
        _updateHeaderDisplay();
        // Notify all clients to re-fetch public properties (allow_add may have changed)
        closeSettingsModal();
        alert('Settings saved!');
    } catch (err) {
        errEl.textContent = 'Error: ' + err.message;
        errEl.classList.remove('hidden');
    }
}

// ============================================================
// RESULTS
// ============================================================
async function loadResults() {
    const request = ++_resultsRequest;
    try {
        const [leaderboard, participants] = await Promise.all([
            api.getLeaderboard(currentCode),
            api.getParticipants(currentCode),
        ]);
        if (request !== _resultsRequest) return;
        allParticipants = participants;
        allResults = ['started', 'finished'].includes(currentEventData?.status)
            ? _includeUnscoredParticipants(leaderboard, participants)
            : leaderboard;
        filterResults();
    } catch (err) {
        if (request !== _resultsRequest) return;
        document.getElementById('results-container').innerHTML =
            '<p class="empty-text">Error loading results</p>';
    }
}

function _includeUnscoredParticipants(grouped, participants) {
    const results = Object.fromEntries(
        Object.entries(grouped || {}).map(([key, entries]) => [key, [...entries]])
    );
    const scoredIds = new Set(Object.values(results).flat().map(entry => entry.id));

    for (const participant of participants) {
        if (scoredIds.has(participant.id)) continue;

        const gender = participant.gender || 'unknown';
        const shootingType = participant.shooting_type || 'unknown';
        const key = `${gender}_${shootingType}`;
        const distanceScores = currentDistances.map(distance => ({
            distance_id: distance.id,
            title: distance.title,
            score: null,
            shots_count: distance.shots_count,
            shots_taken: 0,
        }));
        (results[key] ||= []).push({
            id: participant.id,
            name: participant.name,
            lane_shift: `${participant.lane_number}${participant.shift}`,
            gender,
            shooting_type: shootingType,
            group_type: participant.group_type || 'unknown',
            age_category: participant.age_category || 'unknown',
            total_score: 0,
            x_count: 0,
            ten_count: 0,
            avg_score: 0,
            distance_scores: distanceScores,
        });
    }
    return results;
}

function filterResults() {
    const g = document.getElementById('filter-gender').value;
    const t = document.getElementById('filter-type').value;
    const filtered = {};
    for (const [key, entries] of Object.entries(allResults)) {
        const parts = key.split('_');
        if (g && !parts.includes(g)) continue;
        if (t && !parts.includes(t)) continue;
        filtered[key] = entries;
    }
    renderResults(filtered);
}

function renderResults(grouped) {
    const container = document.getElementById('results-container');
    if (!grouped || !Object.keys(grouped).length) {
        container.innerHTML = `<div class="empty-state-box"><p>No results found</p><p>Try changing the filters or wait for scores</p></div>`;
        return;
    }
    const distOrder = currentDistances.map(d => ({ id: d.id, title: d.title, status: d.status }));
    let html = '';

    for (const [groupKey, entries] of Object.entries(grouped)) {
        const ranked = rankEntries(entries);
        const distHeaders = distOrder.map(d => `<th class="th-dist">${escHtml(d.title)}</th>`).join('');
        html += `
        <div class="results-group">
            <div class="results-group-title">${escHtml(formatGroupTitle(groupKey.split('_')))}</div>
            <table class="results-table">
                <thead><tr>
                    <th style="width:46px;">Rank</th>
                    <th>Name</th>
                    <th style="width:70px;">Lane</th>
                    ${distHeaders}
                    <th style="width:68px;">Total</th>
                    <th style="width:68px;">Avg</th>
                    <th style="width:100px;">X / 10</th>
                </tr></thead>
                <tbody>
                ${ranked.map(({ entry, rank }) => {
                    const distCells = distOrder.map(d => {
                        const ds = (entry.distance_scores || []).find(s => s.distance_id === d.id);
                        const hasScore = ds && ds.score !== null;
                        const canEdit = ['started', 'finished'].includes(currentEventData?.status)
                            && ['active', 'finished'].includes(d.status);
                        if (hasScore || canEdit) {
                            const emptyClass = hasScore ? '' : ' score-empty';
                            return `<td><span class="dist-score-link${emptyClass}" data-pid="${entry.id}" data-did="${d.id}" data-name="${escHtml(entry.name)}">${hasScore ? ds.score : '—'}</span></td>`;
                        }
                        return '<td class="score-empty">—</td>';
                    }).join('');
                    const avg = entry.avg_score > 0 ? entry.avg_score.toFixed(2) : '—';
                    return `
                    <tr>
                        <td><span class="result-rank rank-${rank}">${rank}</span></td>
                        <td><strong>${escHtml(entry.name)}</strong></td>
                        <td>${escHtml(entry.lane_shift)}</td>
                        ${distCells}
                        <td><span class="result-score">${entry.total_score}</span></td>
                        <td class="avg-score-cell">${avg}</td>
                        <td class="xten-cell">X(${entry.x_count}) 10(${entry.ten_count})</td>
                    </tr>`;
                }).join('')}
                </tbody>
            </table>
        </div>`;
    }
    container.innerHTML = html;
    // Use event delegation — avoids onclick string injection with user-controlled names
    container.querySelectorAll('.dist-score-link').forEach(el => {
        el.addEventListener('click', () => {
            const pid  = parseInt(el.dataset.pid,  10);
            const did  = parseInt(el.dataset.did,  10);
            const name = el.dataset.name;
            openDetailModal(pid, did, name);
        });
    });
}

// ── Detail popup ─────────────────────────────────────────────────────────────
// IDs stored in closure, not DOM attributes, to avoid leaking internal data
async function openDetailModal(participantId, distanceId, participantName) {
    const detailContext = { participantId, distanceId, code: currentCode, participantName };
    _detailContext = detailContext;
    const modal    = document.getElementById('detail-modal');
    const titleEl  = document.getElementById('detail-modal-title');
    const subtitle = document.getElementById('detail-modal-subtitle');
    const body     = document.getElementById('detail-modal-body');

    titleEl.textContent = participantName;
    subtitle.textContent = 'Loading…';
    body.innerHTML = '<div class="detail-loading">Loading…</div>';
    modal.classList.remove('hidden');

    try {
        const detail = await api.getDistanceDetail(detailContext.code, participantId, distanceId);
        if (_detailContext !== detailContext || currentCode !== detailContext.code) return;
        subtitle.innerHTML = `
            <span class="detail-dist-name">${escHtml(detail.title)}</span>
            &nbsp;·&nbsp; Total: <strong>${detail.total_score}</strong>
            &nbsp;·&nbsp; Avg: <strong>${detail.avg_score.toFixed(2)}</strong>
            &nbsp;·&nbsp; X: <strong>${detail.x_count}</strong>
            &nbsp;·&nbsp; 10: <strong>${detail.ten_count}</strong>`;

        const distanceStatus = currentDistances.find(distance => distance.id === distanceId)?.status;
        const editable = ['started', 'finished'].includes(currentEventData?.status)
            && ['active', 'finished'].includes(distanceStatus);
        const seriesHTML = detail.series.map(s => {
            const shotBtns = s.shots.map(sh => {
                const empty = sh.score === null;
                const cls = empty ? '' : _shotColorClass(sh.score, sh.is_x);
                const value = empty ? '' : (sh.is_x ? 'X' : sh.score);
                return `<button class="shot-btn ${empty ? '' : `filled ${cls}`}" type="button" data-edit-shot="${sh.shot}" title="${empty ? 'Enter' : 'Edit'} shot ${sh.shot}" ${editable ? '' : 'disabled'}>${value}</button>`;
            }).join('');
            const hasShots = s.shots.some(sh => sh.score !== null);
            const avg = hasShots ? s.avg.toFixed(2) : '—';
            return `
            <div class="series-row detail-series-row">
                <div class="detail-series-num">${s.series}</div>
                ${shotBtns}
                <div class="series-total">${s.total}<br><span class="detail-avg-label">avg ${avg}</span></div>
            </div>`;
        }).join('');

        detailContext.shots = detail.series.flatMap(s => s.shots
            .filter(sh => sh.score !== null)
            .map(sh => ({shot_number: sh.shot, score: sh.score, is_x: sh.is_x})));
        body.innerHTML = `<div class="detail-score-grid ${editable ? 'detail-score-grid-editable' : ''}">${seriesHTML}</div>`;
        if (editable) {
            body.querySelectorAll('[data-edit-shot]').forEach(button => {
                button.addEventListener('click', () => editDetailShot(Number(button.dataset.editShot)));
            });
            body.insertAdjacentHTML('beforeend', '<p class="detail-edit-hint">Select a shot to correct its score. Leave the score blank to clear it.</p>');
        }
    } catch (err) {
        if (_detailContext !== detailContext) return;
        const error = document.createElement('p');
        error.className = 'error-text';
        error.textContent = `Error: ${err.message}`;
        body.replaceChildren(error);
        subtitle.textContent = '';
    }
}

function closeDetailModal() {
    document.getElementById('detail-modal').classList.add('hidden');
    _detailContext = null;
}

async function editDetailShot(shotNumber) {
    if (!_detailContext || _detailSaving) return;
    _detailSaving = true;
    try {
        const detailContext = _detailContext;
        const previous = detailContext.shots.find(shot => shot.shot_number === shotNumber);
        const initial = previous ? (previous.is_x ? 'X' : String(previous.score)) : '';
        const entered = window.prompt(`Correct shot ${shotNumber}. Enter 0–10 or X; leave blank to clear.`, initial);
        if (entered === null) return;

        const value = entered.trim().toUpperCase();
        const shots = detailContext.shots.filter(shot => shot.shot_number !== shotNumber);
        if (value) {
            if (value !== 'X' && !/^(10|[0-9])$/.test(value)) {
                alert('Enter a score from 0 to 10, X, or leave the field blank to clear this shot.');
                return;
            }
            shots.push({shot_number: shotNumber, score: value === 'X' ? 10 : Number(value), is_x: value === 'X'});
        } else if (!previous) {
            return;
        }
        // Each series is in order from the highest to the lowest, like on the lane page.
        const ordered = sortSeries(shots, CONFIG.SERIES_SIZE, 'shot_number');

        const {participantId, distanceId} = detailContext;
        const code = detailContext.code ?? currentCode;
        await api.replaceDistanceResults(code, participantId, distanceId, ordered, AppStorage.getHostSession());
        const participantName = detailContext.participantName ?? document.getElementById('detail-modal-title').textContent;
        await Promise.all([loadParticipants(), loadResults()]);
        if (_detailContext === detailContext && currentCode === code) {
            await openDetailModal(participantId, distanceId, participantName);
        }
    } catch (err) {
        alert(`Could not update shot: ${err.message}`);
    } finally {
        _detailSaving = false;
    }
}

function closeQRModal() {
    document.getElementById('qr-modal').classList.add('hidden');
}

function _shotColorClass(score, isX) {
    if (isX || score >= 9) return 'shot-score-yellow';
    if (score >= 7)        return 'shot-score-red';
    if (score >= 5)        return 'shot-score-blue';
    if (score >= 3)        return 'shot-score-black';
    return 'shot-score-white';
}

function formatGroupTitle(arr) {
    const m = { male:'MEN', female:'WOMEN', unknown:'UNSPECIFIED', compound:'COMPOUND BOW', barebow:'BAREBOW', recurve:'RECURVE' };
    return arr.filter(i => i !== 'unknown').map(i => m[i] || i).join(' - ');
}

// ============================================================
// CSV
// ============================================================
async function importCSV(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (currentEventData?.status !== 'created') {
        alert('Cannot import after competition started');
        event.target.value = '';
        return;
    }
    try {
        const text = await file.text();
        if (!text.trim()) { alert('CSV is empty'); event.target.value = ''; return; }

        // Send the whole file to the backend in one request — server parses and validates
        const result = await api.importParticipantsCSV(currentCode, text);

        const msg = [`✓ Added: ${result.added}`];
        if (result.failed)  msg.push(`✗ Failed: ${result.failed}`);
        if (result.errors?.length) msg.push('', 'Errors:', ...result.errors.slice(0, 10));
        alert('Import complete!\n' + msg.join('\n'));

        if (result.added > 0) {
            await loadParticipants();
        }
        event.target.value = '';
    } catch (err) {
        alert('Error importing CSV: ' + err.message);
        event.target.value = '';
    }
}

async function exportCSV() {
    try {
        const [participants, leaderboard] = await Promise.all([
            api.getParticipants(currentCode),
            api.getLeaderboard(currentCode)
        ]);

        // Flatten leaderboard into lookup map by participant id
        const scoreMap = {};   // id -> leaderboard entry
        const rankMap  = {};   // id -> rank within group (1-based)
        for (const entries of Object.values(leaderboard || {})) {
            for (const { entry, rank } of rankEntries(entries)) {
                scoreMap[entry.id] = entry;
                rankMap[entry.id]  = rank;
            }
        }

        // Only export distances that are active or finished
        const exportDists = currentDistances.filter(d => d.status === 'active' || d.status === 'finished');
        const distHeaders = exportDists.map(d => csvField(d.title)).join(',');
        const hasDists    = exportDists.length > 0;

        let csv = 'Rank,Name,Lane,Shift,Gender,BowType,Group,AgeCategory,PersonalNo';
        if (hasDists) csv += ',' + distHeaders;
        csv += ',Total,Avg,X,10\n';

        // ALL participants sorted by lane then shift — unscored rows included
        const sorted = [...participants].sort((a, b) =>
            a.lane_number !== b.lane_number
                ? a.lane_number - b.lane_number
                : a.shift.localeCompare(b.shift)
        );

        for (const p of sorted) {
            const entry = scoreMap[p.id] || null;

            let distCols = '';
            if (hasDists) {
                distCols = ',' + exportDists.map(d => {
                    if (!entry) return '';
                    const ds = (entry.distance_scores || []).find(s => s.distance_id === d.id);
                    return ds && ds.score !== null ? ds.score : '';
                }).join(',');
            }

            const rank  = entry ? rankMap[p.id] : '';
            const total = entry ? entry.total_score : '';
            const avg   = (entry && entry.avg_score > 0) ? entry.avg_score.toFixed(2) : '';
            const xCnt  = entry ? entry.x_count  : '';
            const tenCt = entry ? entry.ten_count : '';

            csv += [
                rank,
                csvField(p.name),
                p.lane_number,
                csvField(p.shift),
                csvField(p.gender),
                csvField(p.shooting_type),
                csvField(p.group_type),
                csvField(p.age_category),
                csvField(p.personal_number),
            ].join(',') + distCols + `,${total},${avg},${xCnt},${tenCt}\n`;
        }

        // BOM for Excel UTF-8 recognition
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url;
        a.download = `results_${currentCode}_${new Date().toISOString().split('T')[0]}.csv`;
        a.click();
        // Some browsers need the address to stay valid after the click.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) { alert('Export error: ' + err.message); }
}

// ============================================================
// MISC
// ============================================================
function exitHost() {
    if (!confirm('Exit admin panel and clear session?')) return;
    AppStorage.clearEventCode('host');
    AppStorage.clearHostSession();
    AppStorage.clearHostPassword();
    if (wsClient) wsClient.disconnect();
    location.href = 'index.html';
}

function copyLink(role) {
    const base = window.location.href.replace(/\/[^/]*(\?.*)?$/, '/');
    const url  = `${base}${role}.html?code=${currentCode}`;
    const btn  = document.getElementById(`btn-copy-${role}`);
    // A second click during the message must not keep the message as the label.
    const done = () => {
        if (!btn._copyTimer) btn._copyText = btn.textContent;
        clearTimeout(btn._copyTimer);
        btn.textContent = '✓ Copied!';
        btn.classList.add('copied');
        btn._copyTimer = setTimeout(() => {
            btn._copyTimer = null;
            btn.textContent = btn._copyText;
            btn.classList.remove('copied');
        }, 2000);
    };
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(url).then(done).catch(() => _fallbackCopy(url, done));
    } else {
        _fallbackCopy(url, done);
    }
}

function showQR(role="viewer") {
    const modal    = document.getElementById('qr-modal');
    const body     = document.getElementById('qr-modal-body');
    if (body.childElementCount == 0){
        if (typeof qrcode !== 'function') { alert('The QR generator is not available. Use the copy link button.'); return; }
        const base = window.location.href.replace(/\/[^/]*(\?.*)?$/, '/');
        const url  = `${base}${role}.html?code=${currentCode}`;
        const qr = qrcode(0, 'M');
        qr.addData(url);
        qr.make();
        const image = document.createElement('img');
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true }))}`;
        image.alt = '';
        image.title = 'scan to open client';
        body.replaceChildren(image);
    }
    modal.classList.remove('hidden');
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

// Copy a lane password. The element shows "Copied" for a moment, and then the password again.
function copyLanePassword(password, element) {
    const done = () => {
        element.textContent = '✓ Copied';
        clearTimeout(element._copyTimer);
        element._copyTimer = setTimeout(() => { element.textContent = password; }, 1500);
    };
    const failed = () => alert('Could not copy the password. Select it and copy it by hand.');
    const byCommand = () => {
        const ta = document.createElement('textarea');
        ta.value = password;
        ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        let copied = false;
        try { copied = document.execCommand('copy'); } catch (_) { copied = false; }
        document.body.removeChild(ta);
        if (copied) done(); else failed();
    };
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(password).then(done).catch(byCommand);
    } else {
        byCommand();
    }
}

function copyToClipboard(text, elementId, successMsg) {
    if (!text) return;
    const el   = document.getElementById(elementId);
    // A second tap during the message must not keep the message on the badge.
    const done = () => {
        if (!el._copyTimer) el._copyText = el.textContent;
        clearTimeout(el._copyTimer);
        el.textContent = `✓ ${successMsg}`;
        el._copyTimer = setTimeout(() => { el._copyTimer = null; el.textContent = el._copyText; }, 1500);
    };
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done).catch(() => _fallbackCopy(text, done));
    } else {
        _fallbackCopy(text, done);
    }
}

// ============================================================
// ACTIONS (the page has no inline handlers; see actions.js)
// ============================================================
registerActions({
    hostEnter: () => hostEnter(),
    copyLink: role => copyLink(role),
    showQR: role => showQR(role),
    openSettingsModal: () => openSettingsModal(),
    saveSettings: () => saveSettings(),
    startEvent: () => startEvent(),
    finishEvent: () => finishEvent(),
    exportCSV: () => exportCSV(),
    exitHost: () => exitHost(),
    pickCsv: () => document.getElementById('csv-import').click(),
    importCsv: (element, event) => importCSV(event),
    addDistance: () => addDistance(),
    switchTab: name => switchTab(name),
    showAddParticipantModal: () => showAddParticipantModal(),
    loadResults: () => loadResults(),
    filterResults: () => filterResults(),
    closeParticipantModal: () => closeParticipantModal(),
    closeDetailModal: () => closeDetailModal(),
    closeQRModal: () => closeQRModal(),
    closeSettingsModal: () => closeSettingsModal(),
    submitParticipant: (element, event) => submitParticipant(event),
    startDistance: id => startDistance(id),
    stopDistance: id => stopDistance(id),
    deleteDistance: id => deleteDistance(id),
    changeShots: (id, delta) => changeShots(id, delta),
    updateDistTitle: (id, element) => updateDistTitle(id, element.value),
    // An action gets its arguments, then the element, then the event.
    blurElement: (...rest) => rest.at(-2).blur(),
    editParticipant: id => editParticipant(id),
    removeParticipant: id => removeParticipant(id),
    resetLaneSession: lane => resetLaneSession(lane),
    copyLanePassword: (password, element) => copyLanePassword(password, element),
    approveLaneReset: lane => approveLaneReset(lane),
    denyLaneReset: lane => denyLaneReset(lane),
    showParticipantsTab: () => switchTab('participants'),
});
