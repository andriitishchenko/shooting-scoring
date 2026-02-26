// VIEWER — polling only (no WebSocket), refreshes every 2 minutes
'use strict';

let currentCode     = null;
let refreshInterval = null;
let scrollInterval  = null;
let eventObj        = null;
let distancesInfo   = [];
let _pendingCode    = null;

window.addEventListener('DOMContentLoaded', () => {
    const params  = new URLSearchParams(window.location.search);
    const urlCode = params.get('code');
    if (urlCode) {
        params.delete('code');
        history.replaceState(null, '', window.location.pathname + (params.toString() ? '?' + params : ''));
        document.getElementById('code-input').value = urlCode.toUpperCase();
        viewerEnter();
        return;
    }
    const savedCode = Storage.getEventCode('viewer');
    const savedSid  = Storage.getViewerSession();
    if (savedCode && savedSid) {
        document.getElementById('code-input').value = savedCode;
        viewerEnter();
    }
});

// ── Entry ──────────────────────────────────────────────────────────────────
async function viewerEnter() {
    const code = document.getElementById('code-input').value.trim().toUpperCase();
    if (code.length !== CONFIG.CODE_LENGTH) { alert('Invalid code'); return; }

    try { eventObj = await api.getEvent(code); }
    catch (err) { alert('Event not found: ' + err.message); return; }

    const savedSid = Storage.getViewerSession();
    try {
        const res = await api.viewerLogin(code, '', savedSid);
        if (res.ok) { await _enterViewer(code, res.session_id); return; }
    } catch (err) {
        if (err.message && err.message.toLowerCase().includes('password')) {
            _pendingCode = code;
            _showPasswordScreen();
            return;
        }
        alert('Error: ' + err.message);
    }
}

function _showPasswordScreen() {
    document.getElementById('code-screen').classList.add('hidden');
    document.getElementById('viewer-pw-screen').classList.remove('hidden');
    document.getElementById('viewer-pw-input').value = '';
    document.getElementById('viewer-pw-error').classList.add('hidden');
    setTimeout(() => document.getElementById('viewer-pw-input').focus(), 100);
    document.getElementById('viewer-pw-input').onkeydown = e => {
        if (e.key === 'Enter') submitViewerPassword();
    };
}

async function submitViewerPassword() {
    const code  = _pendingCode;
    const pw    = document.getElementById('viewer-pw-input').value;
    const errEl = document.getElementById('viewer-pw-error');
    errEl.classList.add('hidden');
    try {
        const res = await api.viewerLogin(code, pw);
        if (res.ok) { await _enterViewer(code, res.session_id); }
    } catch {
        errEl.textContent = 'Invalid password. Try again.';
        errEl.classList.remove('hidden');
        document.getElementById('viewer-pw-input').value = '';
        document.getElementById('viewer-pw-input').focus();
    }
}

async function _enterViewer(code, sessionId) {
    Storage.saveEventCode(code, 'viewer');
    Storage.saveViewerSession(sessionId);
    currentCode  = code;
    _pendingCode = null;

    document.getElementById('code-screen').classList.add('hidden');
    document.getElementById('viewer-pw-screen').classList.add('hidden');
    document.getElementById('results-screen').classList.remove('hidden');

    await _loadAndRender();
    refreshInterval = setInterval(() => _loadAndRender(), 2 * 60 * 1000);
    startAutoScroll();
}

function exitViewer(silent = false) {
    if (!silent && !confirm('Exit viewer?')) return;
    if (refreshInterval) clearInterval(refreshInterval);
    if (scrollInterval)  clearInterval(scrollInterval);
    Storage.clearEventCode('viewer');
    Storage.clearViewerSession();
    currentCode = null;
    document.getElementById('results-screen').classList.add('hidden');
    document.getElementById('viewer-pw-screen').classList.add('hidden');
    document.getElementById('code-screen').classList.remove('hidden');
}

// ── Load + route ─────────────────────────────────────────────────────────
async function _loadAndRender() {
    try {
        [eventObj, distancesInfo] = await Promise.all([
            api.getEvent(currentCode),
            api.getDistances(currentCode),
        ]);

        if (eventObj.status === 'created') {
            // Pre-competition: show participant roster by lane + shift
            const participants = await api.getParticipants(currentCode);
            renderParticipantRoster(participants);
        } else {
            // Competition running or finished: show ranked leaderboard
            const leaderboard = await api.getLeaderboard(currentCode);
            renderLeaderboard(leaderboard);
        }
    } catch (err) {
        console.error('Viewer error:', err);
        setTimeout(() => _loadAndRender(), 15000);
    }
}

// ── Pre-competition roster ─────────────────────────────────────────────────
function renderParticipantRoster(participants) {
    const container = document.getElementById('leaderboard');

    if (!participants?.length) {
        container.innerHTML = `
            <div class="empty-state">
                <h3>Waiting for participants…</h3>
                <p>Competition has not started yet.</p>
            </div>`;
        return;
    }

    // Sort: lane_number asc, shift asc
    const sorted = [...participants].sort((a, b) =>
        a.lane_number !== b.lane_number
            ? a.lane_number - b.lane_number
            : a.shift.localeCompare(b.shift)
    );

    // Group by lane
    const byLane = {};
    sorted.forEach(p => { (byLane[p.lane_number] = byLane[p.lane_number] || []).push(p); });

    container.innerHTML = '';

    const banner = document.createElement('div');
    banner.className   = 'roster-banner';
    banner.textContent = '⏳ Pre-Competition — Participant List';
    container.appendChild(banner);

    Object.entries(byLane).forEach(([lane, ps]) => {
        const group = document.createElement('div');
        group.className = 'leaderboard-group';

        const titleEl = document.createElement('div');
        titleEl.className   = 'group-title roster-group-title';
        titleEl.textContent = `Lane ${lane}`;
        group.appendChild(titleEl);

        ps.forEach(p => {
            const row = document.createElement('div');
            row.className = 'leaderboard-row roster-row';

            const meta = [p.gender, p.age_category, p.shooting_type, p.group_type]
                .filter(Boolean).join(' · ');

            row.innerHTML = `
                <span class="lb-lane roster-lane-shift">${p.lane_number}${p.shift}</span>
                <span class="lb-name roster-name">
                    ${_esc(p.name)}
                    ${meta ? `<span class="roster-meta">${_esc(meta)}</span>` : ''}
                </span>
                ${p.personal_number ? `<span class="roster-num">#${_esc(p.personal_number)}</span>` : ''}`;
            group.appendChild(row);
        });

        container.appendChild(group);
    });
}

// ── Leaderboard (started / finished) ──────────────────────────────────────
function renderLeaderboard(grouped) {
    const container = document.getElementById('leaderboard');

    if (!grouped || !Object.keys(grouped).length) {
        container.innerHTML = `
            <div class="empty-state">
                <h3>No results yet</h3>
                <p>Waiting for participants to submit scores…</p>
            </div>`;
        return;
    }

    const showRank    = eventObj && eventObj.status !== 'created';
    const activeDists = distancesInfo.filter(d => d.status === 'active' || d.status === 'finished');
    const hasMulti    = activeDists.length > 1;

    container.innerHTML = '';

    Object.entries(grouped)
        .sort(([a], [b]) => a.localeCompare(b))
        .forEach(([groupKey, entries]) => {
            if (!entries?.length) return;
            const sorted = [...entries].sort((a, b) => b.total_score - a.total_score);

            const groupDiv = document.createElement('div');
            groupDiv.className = 'leaderboard-group';

            const titleEl = document.createElement('div');
            titleEl.className   = 'group-title';
            titleEl.textContent = _formatGroupTitle(groupKey.split('_'));
            groupDiv.appendChild(titleEl);

            sorted.forEach((entry, index) => {
                const row = document.createElement('div');
                row.className = 'leaderboard-row';
                if (showRank && index < 3) row.classList.add('top-3');

                let distHtml = '';
                if (hasMulti) {
                    const parts = activeDists.map(d => {
                        const ds = (entry.distance_scores || []).find(s => s.distance_id === d.id);
                        if (!ds) return `<span class="lb-dist-item"><span class="lb-dist-label">${_esc(d.title)}</span><span class="lb-dist-val">—</span></span>`;
                        const taken = ds.shots_taken ?? 0;
                        const score = ds.score !== null ? ds.score : '—';
                        return `<span class="lb-dist-item"><span class="lb-dist-label">${_esc(d.title)}</span><span class="lb-dist-val">${score}<sup class="lb-dist-shots">${taken}/${d.shots_count}</sup></span></span>`;
                    }).join('');
                    if (parts) distHtml = `<span class="lb-dist-breakdown">${parts}</span>`;
                }

                let shotsHtml = '';
                if (!hasMulti && activeDists.length === 1) {
                    const ds = (entry.distance_scores || [])[0];
                    if (ds) {
                        shotsHtml = `<span class="lb-shots">${ds.shots_taken ?? 0}/${activeDists[0].shots_count}</span>`;
                    }
                }

                row.innerHTML = `
                    <span class="lb-rank">${showRank ? index + 1 : ''}</span>
                    <span class="lb-lane">${entry.lane_shift}</span>
                    <span class="lb-name">${_esc(entry.name)}${distHtml}</span>
                    <span class="lb-xten"><span class="x-count">X${entry.x_count}</span><span class="ten-count"> 10·${entry.ten_count}</span></span>
                    <span class="lb-score">${entry.total_score}${shotsHtml}</span>`;

                groupDiv.appendChild(row);
            });

            container.appendChild(groupDiv);
        });
}

// ── Helpers ────────────────────────────────────────────────────────────────
function _esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _formatGroupTitle(arr) {
    const m = { male: 'MEN', female: 'WOMEN', unknown: 'UNSPECIFIED', compound: 'COMPOUND BOW', barebow: 'BAREBOW', recurve: 'RECURVE' };
    return arr.filter(i => i !== 'unknown').map(i => m[i] || i).join(' - ');
}

function startAutoScroll() {
    let pos = 0;
    scrollInterval = setInterval(() => {
        pos += 0.5;
        const max = document.documentElement.scrollHeight - window.innerHeight;
        if (max <= 0) return;
        if (pos >= max) pos = 0;
        window.scrollTo(0, pos);
    }, 1000 / 60);
}
