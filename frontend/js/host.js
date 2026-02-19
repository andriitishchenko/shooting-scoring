// HOST JavaScript
let currentCode = null;
let currentEventData = null;
let currentDistances = [];
let wsClient = null;
let allParticipants = [];
let allResults = {};

// ============================================
// INITIALIZATION
// ============================================

window.addEventListener('DOMContentLoaded', () => {
    const savedCode = Storage.getEventCode('host');
    if (savedCode) {
        currentCode = savedCode;
        loadAdminPanel();
    }
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            const participantModal = document.getElementById('participant-modal');
            if (participantModal && !participantModal.classList.contains('hidden')) {
                closeParticipantModal();
                return;
            }
            const detailModal = document.getElementById('detail-modal');
            if (detailModal && !detailModal.classList.contains('hidden')) {
                closeDetailModal();
            }
        }
    });
});

// ============================================
// TAB SWITCHING
// ============================================

function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById('tab-btn-' + tabName).classList.add('active');
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById('tab-' + tabName).classList.add('active');
    if (tabName === 'participants') loadParticipants();
    else if (tabName === 'results') loadResults();
}

// ============================================
// EVENT MANAGEMENT
// ============================================

async function hostEnter() {
    const code = document.getElementById('code-input').value.trim().toUpperCase();
    if (code.length !== CONFIG.CODE_LENGTH) {
        alert(`Code must be ${CONFIG.CODE_LENGTH} characters`);
        return;
    }
    try {
        await api.getEvent(code);
        currentCode = code;
        Storage.saveEventCode(code, 'host');
        loadAdminPanel();
    } catch (error) {
        const create = confirm('Event not found. Create new event?');
        if (create) {
            try {
                await api.createEvent(code);
                currentCode = code;
                Storage.saveEventCode(code, 'host');
                loadAdminPanel();
            } catch (err) {
                alert('Error creating event: ' + err.message);
            }
        }
    }
}

function loadAdminPanel() {
    document.getElementById('code-screen').classList.add('hidden');
    document.getElementById('admin-screen').classList.remove('hidden');
    document.getElementById('event-code-display').textContent = `Code: ${currentCode}`;
    document.getElementById('copy-link-buttons').style.display = 'flex';

    loadEventData();

    wsClient = new WSClient(currentCode);
    wsClient.connect();
    wsClient.on('result_update', () => {
        loadParticipants();
        if (document.getElementById('tab-results').classList.contains('active')) loadResults();
    });
    wsClient.on('refresh', () => loadParticipants());
}

async function loadEventData() {
    try {
        const event = await api.getEvent(currentCode);
        currentEventData = event;
        updateStatusDisplay(event.status);

        const addBtn = document.getElementById('add-participant-btn');
        if (event.status === 'created') {
            addBtn.disabled = false;
            addBtn.title = '';
        } else {
            addBtn.disabled = true;
            addBtn.title = 'Cannot add participants after competition started';
        }

        if (event.status === 'started') {
            document.getElementById('start-btn').classList.add('hidden');
            document.getElementById('finish-btn').classList.remove('hidden');
        } else if (event.status === 'finished') {
            document.getElementById('start-btn').classList.add('hidden');
            document.getElementById('finish-btn').classList.add('hidden');
        }

        await loadDistances();
        await loadParticipants();
    } catch (error) {
        console.error('Error loading event:', error);
    }
}

function updateStatusDisplay(status) {
    const statusBadge = document.getElementById('status-badge');
    statusBadge.className = `status-badge ${status}`;
    const statusText = { 'created': 'Not Started', 'started': 'In Progress', 'finished': 'Finished' };
    statusBadge.textContent = statusText[status] || status;
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
    } catch (error) {
        alert('Error starting: ' + error.message);
    }
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
    } catch (error) {
        alert('Error finishing: ' + error.message);
    }
}

// ============================================
// DISTANCES MANAGEMENT
// ============================================

async function loadDistances() {
    try {
        currentDistances = await api.getDistances(currentCode);
        renderDistances();
    } catch (error) {
        console.error('Error loading distances:', error);
    }
}

function renderDistances() {
    const list = document.getElementById('distances-list');
    const eventStatus = currentEventData ? currentEventData.status : 'created';

    // Add distance button visibility
    const addBtn = document.getElementById('add-distance-btn');
    if (addBtn) addBtn.style.display = eventStatus === 'finished' ? 'none' : '';

    if (currentDistances.length === 0) {
        list.innerHTML = '<p style="color:#999;padding:12px 0;">No distances configured</p>';
        return;
    }

    list.innerHTML = currentDistances.map(d => {
        const isPending  = d.status === 'pending';
        const isActive   = d.status === 'active';
        const isFinished = d.status === 'finished';
        const canEdit    = isPending && eventStatus !== 'finished';
        const canDelete  = isPending && currentDistances.length > 1 && eventStatus !== 'finished';

        let startStopBtn = '';
        if (eventStatus === 'started') {
            if (isPending) {
                startStopBtn = `<button class="btn btn-sm btn-success dist-btn" onclick="startDistance(${d.id})">▶ Start</button>`;
            } else if (isActive) {
                startStopBtn = `<button class="btn btn-sm btn-danger dist-btn" onclick="stopDistance(${d.id})">■ Stop</button>`;
            }
        }

        const statusLabel = {
            pending: '<span class="dist-status dist-pending">Pending</span>',
            active:  '<span class="dist-status dist-active">● Active</span>',
            finished:'<span class="dist-status dist-finished">✓ Done</span>'
        }[d.status];

        return `
        <div class="dist-row ${isActive ? 'dist-row-active' : ''} ${isFinished ? 'dist-row-finished' : ''}">
            <div class="dist-title-cell">
                ${canEdit
                    ? `<input class="dist-title-input" value="${escHtml(d.title)}" onblur="updateDistTitle(${d.id}, this.value)" onkeydown="if(event.key==='Enter')this.blur()">`
                    : `<span class="dist-title-static">${escHtml(d.title)}</span>`
                }
            </div>
            <div class="dist-shots-cell">
                ${canEdit
                    ? `<button class="btn-shots" onclick="changeShots(${d.id}, -1)">−</button>
                       <span class="shots-val" id="shots-val-${d.id}">${d.shots_count}</span>
                       <button class="btn-shots" onclick="changeShots(${d.id}, 1)">+</button>`
                    : `<span class="shots-val">${d.shots_count} shots</span>`
                }
            </div>
            <div class="dist-status-cell">${statusLabel}</div>
            <div class="dist-actions-cell">
                ${startStopBtn}
                ${canDelete ? `<button class="btn btn-sm btn-danger dist-btn" onclick="deleteDistance(${d.id})">✕</button>` : ''}
            </div>
        </div>`;
    }).join('');
}

function escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function addDistance() {
    const newDist = { title: `Distance ${currentDistances.length + 1}`, shots_count: 30 };
    try {
        await api.addDistance(currentCode, newDist);
        await loadDistances();
    } catch (error) {
        alert('Error adding distance: ' + error.message);
    }
}

async function updateDistTitle(distId, newTitle) {
    if (!newTitle.trim()) return;
    const dist = currentDistances.find(d => d.id === distId);
    if (dist && dist.title === newTitle.trim()) return;
    try {
        await api.updateDistance(currentCode, distId, { title: newTitle.trim() });
        await loadDistances();
    } catch (error) {
        alert('Error updating title: ' + error.message);
    }
}

async function changeShots(distId, delta) {
    const dist = currentDistances.find(d => d.id === distId);
    if (!dist) return;
    const newCount = Math.max(1, Math.min(200, dist.shots_count + delta));
    if (newCount === dist.shots_count) return;
    try {
        await api.updateDistance(currentCode, distId, { shots_count: newCount });
        // Optimistic UI update
        dist.shots_count = newCount;
        const el = document.getElementById(`shots-val-${distId}`);
        if (el) el.textContent = newCount;
    } catch (error) {
        alert('Error updating shots: ' + error.message);
    }
}

async function startDistance(distId) {
    const dist = currentDistances.find(d => d.id === distId);
    const activeOne = currentDistances.find(d => d.status === 'active');
    let msg = `Start "${dist ? dist.title : distId}"?`;
    if (activeOne) msg += `\n\n⚠️ "${activeOne.title}" will be marked as FINISHED.`;
    if (!confirm(msg)) return;
    try {
        await api.updateDistance(currentCode, distId, { status: 'active' });
        await loadDistances();
        wsClient.send({ type: 'event_status', status: 'started', active_distance_id: distId });
    } catch (error) {
        alert('Error: ' + error.message);
    }
}

async function stopDistance(distId) {
    const dist = currentDistances.find(d => d.id === distId);
    if (!confirm(`Finish "${dist ? dist.title : distId}"? This cannot be undone.`)) return;
    try {
        await api.updateDistance(currentCode, distId, { status: 'finished' });
        await loadDistances();
        wsClient.send({ type: 'event_status', status: 'started', active_distance_id: null });
    } catch (error) {
        alert('Error: ' + error.message);
    }
}

async function deleteDistance(distId) {
    if (!confirm('Delete this distance?')) return;
    try {
        await api.deleteDistance(currentCode, distId);
        await loadDistances();
    } catch (error) {
        alert('Error: ' + error.message);
    }
}

// ============================================
// PARTICIPANTS TAB
// ============================================

async function loadParticipants() {
    try {
        const participants = await api.getParticipants(currentCode);
        allParticipants = participants;
        renderParticipants(participants);
    } catch (error) {
        console.error('Error loading participants:', error);
        document.getElementById('participants-container').innerHTML =
            '<p style="text-align: center; color: #999;">Error loading participants</p>';
    }
}

function renderParticipants(participants) {
    const container = document.getElementById('participants-container');
    if (participants.length === 0) {
        container.innerHTML = `<div style="text-align:center;padding:40px;color:#999;"><p style="font-size:18px;margin-bottom:8px;">No participants yet</p><p>Click "Add Participant" to add</p></div>`;
        return;
    }
    participants.sort((a, b) => a.lane_number !== b.lane_number ? a.lane_number - b.lane_number : a.shift.localeCompare(b.shift));
    const groupedByLane = {};
    participants.forEach(p => { (groupedByLane[p.lane_number] = groupedByLane[p.lane_number] || []).push(p); });

    let html = '';
    for (const [lane, lanePs] of Object.entries(groupedByLane)) {
        html += `<div class="lane-group"><div class="lane-group-header">Lane ${lane}</div><div class="lane-participants">`;
        html += lanePs.map(p => `
            <div class="participant-row">
                <div class="participant-lane-shift">${p.lane_number}${p.shift}</div>
                <div class="participant-details">
                    <div class="participant-name-inline">${p.name}</div>
                    <div class="participant-meta">
                        ${p.gender ? `<span class="meta-badge">${p.gender}</span>` : ''}
                        ${p.personal_number ? `<span class="meta-badge">№${p.personal_number}</span>` : ''}
                        ${p.shooting_type ? `<span class="meta-badge">${p.shooting_type}</span>` : ''}
                        ${p.group_type ? `<span class="meta-badge">${p.group_type}</span>` : ''}
                        ${p.age_category ? `<span class="meta-badge">${p.age_category}</span>` : ''}
                    </div>
                </div>
                <div class="participant-actions">
                    <button class="btn-edit-inline" onclick="editParticipant(${p.id})">✎ Edit</button>
                    <button class="btn btn-sm btn-danger" onclick="removeParticipant(${p.id})">🗑️ Remove</button>
                </div>
            </div>`).join('');
        html += `</div></div>`;
    }
    container.innerHTML = html;
}

// ============================================
// PARTICIPANT MODAL
// ============================================

function showAddParticipantModal() {
    document.getElementById('modal-title').textContent = 'Add Participant';
    document.getElementById('submit-participant-btn').textContent = 'Add Participant';
    document.getElementById('edit-participant-id').value = '';
    document.getElementById('participant-form').reset();
    document.getElementById('participant-modal').classList.remove('hidden');
    setTimeout(() => document.getElementById('p-name').focus(), 100);
}

function editParticipant(participantId) {
    const p = allParticipants.find(p => p.id === participantId);
    if (!p) return;
    document.getElementById('modal-title').textContent = 'Edit Participant';
    document.getElementById('submit-participant-btn').textContent = 'Update Participant';
    document.getElementById('edit-participant-id').value = participantId;
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
    const participantId = document.getElementById('edit-participant-id').value;
    const participant = {
        name: document.getElementById('p-name').value,
        lane_number: parseInt(document.getElementById('p-lane').value),
        shift: document.getElementById('p-shift').value.toUpperCase(),
        gender: document.getElementById('p-gender').value || null,
        age_category: document.getElementById('p-age-category').value || null,
        shooting_type: document.getElementById('p-shooting-type').value || null,
        group_type: document.getElementById('p-group').value || null,
        personal_number: document.getElementById('p-number').value || null
    };
    try {
        if (participantId) {
            await api.updateParticipant(currentCode, participantId, participant);
        } else {
            await api.addParticipant(currentCode, participant);
        }
        wsClient.send({ type: 'refresh' });
        closeParticipantModal();
        await loadParticipants();
        alert(participantId ? 'Participant updated!' : 'Participant added!');
    } catch (error) {
        alert('Error: ' + error.message);
    }
}

async function removeParticipant(participantId) {
    if (!confirm('Remove this participant?')) return;
    if (currentEventData && currentEventData.status === 'finished') {
        alert('Cannot remove participants after competition has finished.');
        return;
    }
    try {
        await api.deleteParticipant(currentCode, participantId);
        wsClient.send({ type: 'refresh' });
        await loadParticipants();
    } catch (error) {
        alert('Error: ' + error.message);
    }
}

// ============================================
// RESULTS TAB
// ============================================

async function loadResults() {
    try {
        const leaderboard = await api.getLeaderboard(currentCode);
        allResults = leaderboard;
        filterResults();
    } catch (error) {
        console.error('Error loading results:', error);
        document.getElementById('results-container').innerHTML =
            '<p style="text-align:center;color:#999;padding:40px;">Error loading results</p>';
    }
}

function filterResults() {
    const genderFilter = document.getElementById('filter-gender').value;
    const typeFilter = document.getElementById('filter-type').value;
    let filtered = {};
    for (const [key, entries] of Object.entries(allResults)) {
        const parts = key.split('_');
        if (genderFilter && !parts.includes(genderFilter)) continue;
        if (typeFilter && !parts.includes(typeFilter)) continue;
        filtered[key] = entries;
    }
    renderResults(filtered);
}

function renderResults(grouped) {
    const container = document.getElementById('results-container');
    if (!grouped || Object.keys(grouped).length === 0) {
        container.innerHTML = `<div style="text-align:center;padding:40px;color:#999;"><p style="font-size:18px;margin-bottom:8px;">No results found</p><p>Try changing the filters or wait for scores</p></div>`;
        return;
    }

    const distOrder = currentDistances.map(d => ({ id: d.id, title: d.title }));

    let html = '';
    for (const [groupKey, entries] of Object.entries(grouped)) {
        const sortedEntries = [...entries].sort((a, b) => b.total_score - a.total_score);
        const distHeaders = distOrder.map(d => `<th class="th-dist">${escHtml(d.title)}</th>`).join('');

        html += `
        <div class="results-group">
            <div class="results-group-title">${formatGroupTitle(groupKey.split('_'))}</div>
            <table class="results-table">
                <thead>
                    <tr>
                        <th style="width:46px;">Rank</th>
                        <th>Name</th>
                        <th style="width:70px;">Lane</th>
                        ${distHeaders}
                        <th style="width:68px;">Total</th>
                        <th style="width:68px;">Avg</th>
                        <th style="width:100px;">X / 10</th>
                    </tr>
                </thead>
                <tbody>
                    ${sortedEntries.map((entry, i) => {
                        const distCells = distOrder.map(d => {
                            const ds = (entry.distance_scores || []).find(s => s.distance_id === d.id);
                            if (ds && ds.score !== null) {
                                return `<td><span class="dist-score-link" onclick="openDetailModal(${entry.id},'${entry.name.replace(/'/g,"\\'")}',${d.id})">${ds.score}</span></td>`;
                            }
                            return '<td class="score-empty">—</td>';
                        }).join('');
                        const avg = entry.avg_score > 0 ? entry.avg_score.toFixed(2) : '—';
                        return `
                        <tr>
                            <td><span class="result-rank rank-${i+1}">${i+1}</span></td>
                            <td><strong>${entry.name}</strong></td>
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
}

// ── Distance detail popup ───────────────────────────────────────────────────

async function openDetailModal(participantId, participantName, distanceId) {
    const modal = document.getElementById('detail-modal');
    const titleEl = document.getElementById('detail-modal-title');
    const subtitle = document.getElementById('detail-modal-subtitle');
    const body = document.getElementById('detail-modal-body');

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
                const cls = sh.is_x ? 'filled shot-x' : 'filled';
                return `<button class="shot-btn ${cls}" disabled>${sh.is_x ? 'X' : sh.score}</button>`;
            }).join('');
            const hasShots = s.shots.some(sh => sh.score !== null);
            const avgStr = hasShots ? s.avg.toFixed(2) : '—';
            return `
            <div class="series-row detail-series-row">
                <div class="detail-series-num">${s.series}</div>
                ${shotBtns}
                <div class="series-total">
                    ${s.total}<br><span class="detail-avg-label">avg ${avgStr}</span>
                </div>
            </div>`;
        }).join('');

        body.innerHTML = `<div class="detail-score-grid">${seriesHTML}</div>`;
    } catch (err) {
        body.innerHTML = `<p style="color:#e74c3c;padding:20px;">Error: ${err.message}</p>`;
        subtitle.textContent = '';
    }
}

function closeDetailModal() {
    document.getElementById('detail-modal').classList.add('hidden');
}

function formatGroupTitle(titleArray) {
    const map = { male:'MEN', female:'WOMEN', unknown:'UNSPECIFIED', compound:'COMPOUND BOW', barebow:'BAREBOW', recurve:'RECURVE' };
    return titleArray.filter(i => i !== 'unknown').map(i => map[i] || i).join(' - ');
}

// ============================================
// CSV IMPORT / EXPORT
// ============================================

async function importCSV(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (currentEventData && currentEventData.status !== 'created') {
        alert('Cannot import participants after competition has started');
        event.target.value = '';
        return;
    }
    try {
        const text = await file.text();
        const lines = text.split('\n').slice(1).filter(l => l.trim());
        if (!lines.length) { alert('CSV file is empty'); return; }
        let ok = 0, fail = 0;
        for (const line of lines) {
            const values = line.match(/(\".*?\"|[^\",]+)(?=\s*,|\s*$)/g) || [];
            const v = values.map(x => x.replace(/^\"|\"$/g,'').trim());
            if (v.length < 3) { fail++; continue; }
            const [name, lane, shift, gender, ageCategory, shootingType, group, personalNumber] = v;
            const p = { name, lane_number: parseInt(lane)||0, shift:(shift||'').toUpperCase(), gender:gender||null, age_category:ageCategory||null, shooting_type:shootingType||null, group_type:group||null, personal_number:personalNumber||null };
            if (!p.name || !p.lane_number || !p.shift) { fail++; continue; }
            try { await api.addParticipant(currentCode, p); ok++; } catch { fail++; }
        }
        alert(`Import complete!\n✓ Added: ${ok}${fail ? `\n✗ Failed: ${fail}` : ''}`);
        wsClient.send({ type: 'refresh' });
        await loadParticipants();
        event.target.value = '';
    } catch (error) {
        alert('Error reading CSV: ' + error.message);
        event.target.value = '';
    }
}

async function exportCSV() {
    try {
        const participants = await api.getParticipants(currentCode);
        const leaderboard = await api.getLeaderboard(currentCode);
        const distHeaders = currentDistances.map(d => `"${d.title}"`).join(',');
        let csv = `Rank,Name,Lane,Shift,Gender,Type,Group,${distHeaders},Total,Avg,X,10\n`;
        for (const [, entries] of Object.entries(leaderboard)) {
            [...entries].sort((a,b) => b.total_score - a.total_score).forEach((entry, i) => {
                const p = participants.find(x => x.id === entry.id);
                if (!p) return;
                const distCols = currentDistances.map(d => {
                    const ds = (entry.distance_scores || []).find(s => s.distance_id === d.id);
                    return ds && ds.score !== null ? ds.score : '';
                }).join(',');
                const avg = entry.avg_score > 0 ? entry.avg_score.toFixed(2) : '0.00';
                csv += `${i+1},"${p.name}",${p.lane_number},"${p.shift}","${entry.gender}","${entry.shooting_type}","${entry.group_type}",${distCols},${entry.total_score},${avg},${entry.x_count},${entry.ten_count}\n`;
            });
        }
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `results_${currentCode}_${new Date().toISOString().split('T')[0]}.csv`;
        a.click(); URL.revokeObjectURL(url);
    } catch (error) {
        alert('Export error: ' + error.message);
    }
}

// ============================================
// MISC
// ============================================

function exitHost() {
    if (confirm('Exit admin panel and clear session?')) {
        Storage.clearEventCode('host');
        if (wsClient) wsClient.disconnect();
        location.href = 'index.html';
    }
}

function copyLink(role) {
    if (!currentCode) return;
    const base = window.location.href.replace(/\/[^/]*$/, '/');
    const url = `${base}${role}.html?code=${currentCode}`;
    navigator.clipboard.writeText(url).then(() => {
        const btn = document.getElementById(`btn-copy-${role}`);
        const orig = btn.textContent;
        btn.textContent = '✓ Copied!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 2000);
    }).catch(() => prompt('Copy this link:', url));
}
