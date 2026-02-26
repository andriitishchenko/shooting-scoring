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

// ============================================================
// INIT
// ============================================================
window.addEventListener('DOMContentLoaded', () => {
    const savedCode = Storage.getEventCode('host');
    const savedSid  = Storage.getHostSession();
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
                el.classList.add('hidden');
                return true;
            }
            return false;
        });
    });

    // Click-to-copy badges
    document.getElementById('event-code-display').addEventListener('click', () => {
        copyToClipboard(currentCode, 'event-code-display', 'Code copied!');
    });
    document.getElementById('event-password-display').addEventListener('click', () => {
        copyToClipboard(Storage.getHostPassword(), 'event-password-display', 'Password copied!');
    });
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
    try { await api.getEvent(code); } catch { eventExists = false; }

    if (!eventExists) {
        if (!confirm('Event not found. Create new event?')) return;
        try {
            const res = await api.createEvent(code);
            // res: { code, host_password, session_id }
            Storage.saveEventCode(code, 'host');
            Storage.saveHostSession(res.session_id);
            Storage.saveHostPassword(res.host_password);
            currentCode = code;
            loadAdminPanel();
        } catch (err) {
            alert('Error creating event: ' + err.message);
        }
        return;
    }

    // Event exists — log in via sessions endpoint
    const savedSid = Storage.getHostSession();
    try {
        const res = await api.hostLogin(code, password, savedSid);
        Storage.saveEventCode(code, 'host');
        Storage.saveHostSession(res.session_id);
        if (password) Storage.saveHostPassword(password);
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
    const pw = Storage.getHostPassword();
    if (pw) {
        pwEl.textContent = `🔑 ${pw}`;
        pwEl.classList.remove('hidden');
    } else {
        pwEl.classList.add('hidden');
    }
}

function _connectWS() {
    if (wsClient) wsClient.disconnect();
    wsClient = new WSClient(currentCode);
    wsClient.connect();
    wsClient.on('result_update', () => {
        loadParticipants();
        if (document.getElementById('tab-results').classList.contains('active')) loadResults();
    });
    wsClient.on('refresh', () => loadParticipants());
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
        wsClient.send({ type: 'event_status', status: 'started' });
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
        wsClient.send({ type: 'event_status', status: 'finished' });
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
            if (isPending)  actionBtn = `<button class="btn btn-sm btn-success dist-btn" onclick="startDistance(${d.id})">▶ Start</button>`;
            else if (isActive) actionBtn = `<button class="btn btn-sm btn-danger dist-btn" onclick="stopDistance(${d.id})">■ Stop</button>`;
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
                              onblur="updateDistTitle(${d.id}, this.value)"
                              onkeydown="if(event.key==='Enter')this.blur()">`
                    : `<span class="dist-title-static">${escHtml(d.title)}</span>`}
            </div>
            <div class="dist-shots-cell">
                ${canEdit
                    ? `<button class="btn-shots" onclick="changeShots(${d.id},-1)">−</button>
                       <span class="shots-val" id="shots-val-${d.id}">${d.shots_count}</span>
                       <button class="btn-shots" onclick="changeShots(${d.id},1)">+</button>`
                    : `<span class="shots-val">${d.shots_count} shots</span>`}
            </div>
            <div class="dist-status-cell">${statusLabel}</div>
            <div class="dist-actions-cell">
                ${actionBtn}
                ${canDelete ? `<button class="btn btn-sm btn-danger dist-btn" onclick="deleteDistance(${d.id})">✕</button>` : ''}
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
        wsClient.send({ type: 'refresh' });
    } catch (err) { alert(err.message); }
}

async function updateDistTitle(distId, newTitle) {
    if (!newTitle.trim()) return;
    const d = currentDistances.find(x => x.id === distId);
    if (d && d.title === newTitle.trim()) return;
    try {
        await api.updateDistance(currentCode, distId, { title: newTitle.trim() });
        await loadDistances();
        wsClient.send({ type: 'refresh' });
    } catch (err) { alert(err.message); }
}

async function changeShots(distId, delta) {
    const d = currentDistances.find(x => x.id === distId);
    if (!d) return;
    const newCount = Math.max(1, Math.min(200, d.shots_count + delta));
    if (newCount === d.shots_count) return;
    try {
        await api.updateDistance(currentCode, distId, { shots_count: newCount });
        d.shots_count = newCount;
        const el = document.getElementById(`shots-val-${distId}`);
        if (el) el.textContent = newCount;
        wsClient.send({ type: 'refresh' });
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
        wsClient.send({ type: 'event_status', status: 'started', active_distance_id: distId });
        wsClient.send({ type: 'distance_update', distance_id: distId, status: 'active' });
    } catch (err) { alert(err.message); }
}

async function stopDistance(distId) {
    const d = currentDistances.find(x => x.id === distId);
    if (!confirm(`Finish "${d ? d.title : distId}"? Cannot be undone.`)) return;
    try {
        await api.updateDistance(currentCode, distId, { status: 'finished' });
        await loadDistances();
        wsClient.send({ type: 'event_status', status: 'started', active_distance_id: null });
        wsClient.send({ type: 'distance_update', distance_id: distId, status: 'finished' });
    } catch (err) { alert(err.message); }
}

async function deleteDistance(distId) {
    if (!confirm('Delete this distance?')) return;
    try {
        await api.deleteDistance(currentCode, distId);
        await loadDistances();
        wsClient.send({ type: 'refresh' });
    } catch (err) { alert(err.message); }
}

// ============================================================
// PARTICIPANTS
// ============================================================
async function loadParticipants() {
    try {
        const [parts, lanesResp] = await Promise.all([
            api.getParticipants(currentCode),
            api.listLaneSessions(currentCode).catch(() => ({ lanes: [] }))
        ]);
        allParticipants = parts;
        renderParticipants(allParticipants, lanesResp.lanes || []);
    } catch (err) {
        document.getElementById('participants-container').innerHTML =
            '<p class="empty-text">Error loading participants</p>';
    }
}

function renderParticipants(participants, sessionLanes = []) {
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

    container.innerHTML = allLanes.map(lane => {
        const ps = byLane[lane] || [];
        const hasSession = sessionLanes.includes(lane);
        const sessionTag = hasSession
            ? '<span class="lane-session-active" title="Active session">🔑</span>'
            : '';
        const participantRows = ps.map(p => `
            <div class="participant-row">
                <div class="participant-lane-shift">${p.lane_number}${p.shift}</div>
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
                    <button class="btn-edit-inline" data-pid="${p.id}" onclick="editParticipant(${p.id})">✎ Edit</button>
                    <button class="btn btn-sm btn-danger" data-pid="${p.id}" onclick="removeParticipant(${p.id})">🗑️</button>
                </div>
            </div>`).join('');

        const emptyMsg = ps.length === 0
            ? '<div class="lane-empty-msg">No participants on this lane yet</div>'
            : '';

        return `
        <div class="lane-group${hasSession ? ' lane-group-has-session' : ''}">
            <div class="lane-group-header">
                <span>Lane ${lane} ${sessionTag}</span>
                <button class="btn btn-sm btn-danger lane-reset-btn" onclick="resetLaneSession(${lane})">Reset Session</button>
            </div>
            <div class="lane-participants">
                ${participantRows}
                ${emptyMsg}
            </div>
        </div>`;
    }).join('');
}

async function resetLaneSession(laneNumber) {
    if (!confirm(`Reset session for Lane ${laneNumber}?\nThe client on this lane will be disconnected.`)) return;
    try {
        await api.resetLaneSession(currentCode, laneNumber);
        // Notify client on that lane via WS
        wsClient.send({ type: 'lane_session_reset', lane_number: laneNumber });
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
        wsClient.send({ type: 'refresh' });
        closeParticipantModal();
        await loadParticipants();
        alert(pid ? 'Participant updated!' : 'Participant added!');
    } catch (err) { alert('Error: ' + err.message); }
}

async function removeParticipant(pid) {
    if (!confirm('Remove this participant?')) return;
    if (currentEventData?.status === 'finished') { alert('Cannot remove after competition finished.'); return; }
    try {
        await api.deleteParticipant(currentCode, pid);
        wsClient.send({ type: 'refresh' });
        await loadParticipants();
    } catch (err) { alert('Error: ' + err.message); }
}

// ============================================================
// SETTINGS
// ============================================================
async function openSettingsModal() {
    try {
        const props = await api.getProperties(currentCode);
        document.getElementById('setting-host-pw').value   = props.host_password || '';
        document.getElementById('setting-viewer-pw').value = props.viewer_password || '';
        document.getElementById('setting-allow-add').checked =
            (props.client_allow_add_participant || 'true').toLowerCase() !== 'false';
    } catch {
        document.getElementById('setting-host-pw').value   = '';
        document.getElementById('setting-viewer-pw').value = '';
        document.getElementById('setting-allow-add').checked = true;
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
    const errEl     = document.getElementById('settings-error');
    errEl.classList.add('hidden');

    try {
        await api.updateProperties(currentCode, {
            host_password:               hostPw,
            viewer_password:             viewerPw,
            client_allow_add_participant: allowAdd ? 'true' : 'false'
        });
        if (hostPw) Storage.saveHostPassword(hostPw);
        else Storage.clearHostPassword();
        _updateHeaderDisplay();
        // Notify all clients to re-fetch public properties (allow_add may have changed)
        if (wsClient) wsClient.send({ type: 'refresh' });
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
    try {
        allResults = await api.getLeaderboard(currentCode);
        filterResults();
    } catch (err) {
        document.getElementById('results-container').innerHTML =
            '<p class="empty-text">Error loading results</p>';
    }
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
    const distOrder = currentDistances.map(d => ({ id: d.id, title: d.title }));
    let html = '';

    for (const [groupKey, entries] of Object.entries(grouped)) {
        const sorted = [...entries].sort((a, b) => b.total_score - a.total_score);
        const distHeaders = distOrder.map(d => `<th class="th-dist">${escHtml(d.title)}</th>`).join('');
        html += `
        <div class="results-group">
            <div class="results-group-title">${formatGroupTitle(groupKey.split('_'))}</div>
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
                ${sorted.map((entry, i) => {
                    const distCells = distOrder.map(d => {
                        const ds = (entry.distance_scores || []).find(s => s.distance_id === d.id);
                        if (ds && ds.score !== null) {
                            return `<td><span class="dist-score-link" data-pid="${entry.id}" data-did="${d.id}" data-name="${escHtml(entry.name)}">${ds.score}</span></td>`;
                        }
                        return '<td class="score-empty">—</td>';
                    }).join('');
                    const avg = entry.avg_score > 0 ? entry.avg_score.toFixed(2) : '—';
                    return `
                    <tr>
                        <td><span class="result-rank rank-${i+1}">${i+1}</span></td>
                        <td><strong>${escHtml(entry.name)}</strong></td>
                        <td>${entry.lane_shift}</td>
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
    _detailContext = { participantId, distanceId };
    const modal    = document.getElementById('detail-modal');
    const titleEl  = document.getElementById('detail-modal-title');
    const subtitle = document.getElementById('detail-modal-subtitle');
    const body     = document.getElementById('detail-modal-body');

    titleEl.textContent = participantName;
    subtitle.textContent = 'Loading…';
    body.innerHTML = '<div class="detail-loading">Loading…</div>';
    modal.classList.remove('hidden');

    try {
        const detail = await api.getDistanceDetail(currentCode, participantId, distanceId);
        subtitle.innerHTML = `
            <span class="detail-dist-name">${escHtml(detail.title)}</span>
            &nbsp;·&nbsp; Total: <strong>${detail.total_score}</strong>
            &nbsp;·&nbsp; Avg: <strong>${detail.avg_score.toFixed(2)}</strong>
            &nbsp;·&nbsp; X: <strong>${detail.x_count}</strong>
            &nbsp;·&nbsp; 10: <strong>${detail.ten_count}</strong>`;

        const seriesHTML = detail.series.map(s => {
            const shotBtns = s.shots.map(sh => {
                if (sh.score === null) return `<button class="shot-btn" disabled></button>`;
                const cls = _shotColorClass(sh.score, sh.is_x);
                return `<button class="shot-btn filled ${cls}" disabled>${sh.is_x ? 'X' : sh.score}</button>`;
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

        body.innerHTML = `<div class="detail-score-grid">${seriesHTML}</div>`;
    } catch (err) {
        body.innerHTML = `<p class="error-text">Error: ${err.message}</p>`;
        subtitle.textContent = '';
    }
}

function closeDetailModal() {
    document.getElementById('detail-modal').classList.add('hidden');
    _detailContext = null;
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
            wsClient.send({ type: 'refresh' });
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
            const sorted = [...entries].sort((a, b) => b.total_score - a.total_score);
            sorted.forEach((e, i) => {
                scoreMap[e.id] = e;
                rankMap[e.id]  = i + 1;
            });
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
        URL.revokeObjectURL(url);
    } catch (err) { alert('Export error: ' + err.message); }
}

// ============================================================
// MISC
// ============================================================
function exitHost() {
    if (!confirm('Exit admin panel and clear session?')) return;
    Storage.clearEventCode('host');
    Storage.clearHostSession();
    Storage.clearHostPassword();
    if (wsClient) wsClient.disconnect();
    location.href = 'index.html';
}

function copyLink(role) {
    const base = window.location.href.replace(/\/[^/]*(\?.*)?$/, '/');
    const url  = `${base}${role}.html?code=${currentCode}`;
    navigator.clipboard.writeText(url).then(() => {
        const btn = document.getElementById(`btn-copy-${role}`);
        const orig = btn.textContent;
        btn.textContent = '✓ Copied!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 2000);
    }).catch(() => prompt('Copy this link:', url));
}

function copyToClipboard(text, elementId, successMsg) {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
        const el = document.getElementById(elementId);
        const orig = el.textContent;
        el.textContent = `✓ ${successMsg}`;
        setTimeout(() => { el.textContent = orig; }, 1500);
    }).catch(() => {});
}
