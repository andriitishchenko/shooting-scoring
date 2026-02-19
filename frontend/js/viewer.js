let currentCode = null;
let scrollInterval = null;
let refreshInterval = null;
let eventObj = null;
let distancesInfo = [];

window.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    const urlCode = params.get('code');
    if (urlCode) {
        params.delete('code');
        history.replaceState(null, '', window.location.pathname + (params.toString() ? '?' + params.toString() : ''));
        if (currentCode) exitViewer(true);
        document.getElementById('code-input').value = urlCode.toUpperCase();
        viewerEnter();
        return;
    }
    const savedCode = Storage.getEventCode('viewer');
    if (savedCode) {
        document.getElementById('code-input').value = savedCode;
        viewerEnter();
    }
});

async function viewerEnter() {
    const code = document.getElementById('code-input').value.trim().toUpperCase();
    if (code.length !== CONFIG.CODE_LENGTH) { alert('Invalid code'); return; }
    try {
        eventObj = await api.getEvent(code);
        distancesInfo = await api.getDistances(code);
        currentCode = code;
        Storage.saveEventCode(code, 'viewer');
        document.getElementById('code-screen').classList.add('hidden');
        document.getElementById('results-screen').classList.remove('hidden');
        await loadLeaderboard();
        refreshInterval = setInterval(() => loadLeaderboard(), 2 * 60 * 1000);
        startAutoScroll();
    } catch (error) {
        alert('Event not found: ' + error.message);
    }
}

function exitViewer(silent = false) {
    if (!silent && !confirm('Exit viewer mode?')) return;
    if (refreshInterval) clearInterval(refreshInterval);
    if (scrollInterval) clearInterval(scrollInterval);
    Storage.clearEventCode('viewer');
    document.getElementById('results-screen').classList.add('hidden');
    document.getElementById('code-screen').classList.remove('hidden');
    document.getElementById('code-input').value = '';
    currentCode = null;
}

async function loadLeaderboard() {
    try {
        eventObj = await api.getEvent(currentCode);
        distancesInfo = await api.getDistances(currentCode);
        const leaderboard = await api.getLeaderboard(currentCode);
        renderLeaderboard(leaderboard);
    } catch (error) {
        console.error('Leaderboard error:', error);
        setTimeout(() => loadLeaderboard(), 10000);
    }
}

function renderLeaderboard(grouped) {
    const container = document.getElementById('leaderboard');

    if (!grouped || Object.keys(grouped).length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <h3>No results yet</h3>
                <p>Waiting for participants to submit scores...</p>
                <p style="margin-top:16px;font-size:14px;">Code: ${currentCode}</p>
            </div>`;
        return;
    }

    const eventStateRank = eventObj && eventObj.status === 'created';
    const hasMultipleDist = distancesInfo.length > 1;

    container.innerHTML = '';

    Object.entries(grouped)
        .sort(([a], [b]) => a.localeCompare(b))
        .forEach(([groupKey, entries]) => {
            if (!entries || entries.length === 0) return;

            const groupDiv = document.createElement('div');
            groupDiv.className = 'leaderboard-group';

            const title = document.createElement('div');
            title.className = 'group-title';
            title.textContent = formatGroupTitle(groupKey.split('_'));
            groupDiv.appendChild(title);

            const table = document.createElement('div');
            table.className = 'leaderboard-table';

            [...entries].sort((a, b) => b.total_score - a.total_score).forEach((entry, index) => {
                const row = document.createElement('div');
                row.className = 'leaderboard-row';
                if (!eventStateRank && index < 3) row.classList.add('top-3');

                // Distance breakdown (only active+finished distances with scores)
                let distHtml = '';
                if (hasMultipleDist) {
                    const parts = (entry.distance_scores || [])
                        .filter(s => s.score !== null)
                        .map(s => `<span class="viewer-series-score">${s.title}:${s.score}</span>`)
                        .join('');
                    if (parts) distHtml = `<div class="viewer-series-scores">${parts}</div>`;
                }

                row.innerHTML = `
                    <div class="position">${eventStateRank ? '' : index + 1}</div>
                    <div class="lane-shift">${entry.lane_shift}</div>
                    <div class="name">${entry.name}${distHtml}</div>
                    <div class="score-info"><span class="x-count">X-${entry.x_count}</span> <span class="ten-count">10-${entry.ten_count}</span></div>
                    <div class="score">${entry.total_score}</div>`;

                table.appendChild(row);
            });

            groupDiv.appendChild(table);
            container.appendChild(groupDiv);
        });
}

function formatGroupTitle(titleArray) {
    const map = { male:'MEN', female:'WOMEN', compound:'COMPOUND BOW', barebow:'BAREBOW', recurve:'RECURVE' };
    return titleArray.filter(i => i !== 'unknown').map(i => map[i] || i).join(' - ');
}

function startAutoScroll() {
    const container = document.getElementById('leaderboard');
    let pos = 0;
    scrollInterval = setInterval(() => {
        pos += 0.5;
        const maxScroll = container.scrollHeight - window.innerHeight;
        if (maxScroll <= 0) return;
        if (pos >= maxScroll) pos = 0;
        window.scrollTo(0, pos);
    }, 1000 / 60);
}
