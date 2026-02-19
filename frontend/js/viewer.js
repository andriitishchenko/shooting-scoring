let currentCode = null;
let scrollInterval = null;
let refreshInterval = null;
let event = null;

window.addEventListener('DOMContentLoaded', () => {
    // Check for code in URL params
    const params = new URLSearchParams(window.location.search);
    const urlCode = params.get('code');
    if (urlCode) {
        // Remove code from URL without reload
        params.delete('code');
        const newUrl = window.location.pathname + (params.toString() ? '?' + params.toString() : '');
        history.replaceState(null, '', newUrl);

        // If there's an active session, exit it silently first
        if (currentCode) {
            if (refreshInterval) clearInterval(refreshInterval);
            if (scrollInterval) clearInterval(scrollInterval);
            Storage.clearEventCode('viewer');
            document.getElementById('results-screen').classList.add('hidden');
            document.getElementById('code-screen').classList.remove('hidden');
            currentCode = null;
        }

        document.getElementById('code-input').value = urlCode.toUpperCase();
        viewerEnter();
        return;
    }

    // Restore saved code
    const savedCode = Storage.getEventCode('viewer');
    if (savedCode) {
        document.getElementById('code-input').value = savedCode;
        // Auto-connect
        viewerEnter();
    }
});

async function viewerEnter() {
    const code = document.getElementById('code-input').value.trim().toUpperCase();
    
    if (code.length !== CONFIG.CODE_LENGTH) {
        alert('Invalid code');
        return;
    }

    try {
        event = await api.getEvent(code);
        currentCode = code;
        Storage.saveEventCode(code, 'viewer');
        
        document.getElementById('code-screen').classList.add('hidden');
        document.getElementById('results-screen').classList.remove('hidden');
                
        // Initial load
        await loadLeaderboard();
        
        // Auto-refresh every 2 minutes
        refreshInterval = setInterval(() => loadLeaderboard(), 2*60*1000);
        
        // Start auto-scroll
        startAutoScroll();
    } catch (error) {
        alert('Event not found: ' + error.message);
    }
}

function exitViewer(silent = false) {
    if (!silent && !confirm('Exit viewer mode?')) return;

    // Clear intervals
    if (refreshInterval) clearInterval(refreshInterval);
    if (scrollInterval) clearInterval(scrollInterval);
    
    // Clear saved code
    Storage.clearEventCode('viewer');
    
    // Reset UI
    document.getElementById('results-screen').classList.add('hidden');
    document.getElementById('code-screen').classList.remove('hidden');
    document.getElementById('code-input').value = '';
    
    currentCode = null;
}

async function loadLeaderboard() {
    try {
        event = await api.getEvent(currentCode);
        const leaderboard = await api.getLeaderboard(currentCode);
        renderLeaderboard(leaderboard);
    } catch (error) {
        console.error('Error loading leaderboard:', error);
        // Retry after 2 seconds
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
                <p style="margin-top: 16px; font-size: 14px;">Code: ${currentCode}</p>
            </div>
        `;
        return;
    }

    const eventStateRank = event.status === 'created';
    
    container.innerHTML = '';
    
    const sortedGroups = Object.entries(grouped).sort((a, b) => {
        const [keyA] = a;
        const [keyB] = b;
        return keyA.localeCompare(keyB);
    });
    
    sortedGroups.forEach(([groupKey, entries]) => {
        if (!entries || entries.length === 0) return;
        const titleArray = groupKey.split('_');
        
        const groupDiv = document.createElement('div');
        groupDiv.className = 'leaderboard-group';
        
        const title = document.createElement('div');
        title.className = 'group-title';
        title.textContent = formatGroupTitle(titleArray);
        groupDiv.appendChild(title);
        
        const table = document.createElement('div');
        table.className = 'leaderboard-table';
        
        // Sort entries by score descending
        const sortedEntries = entries.sort((a, b) => b.total_score - a.total_score);
        
        sortedEntries.forEach((entry, index) => {
            const row = document.createElement('div');
            row.className = 'leaderboard-row';

            if (!eventStateRank){
                if (index < 3) row.classList.add('top-3');
            }
            
            row.innerHTML = `
                <div class="position">${ eventStateRank ? '' : index + 1}</div>
                <div class="lane-shift">${entry.lane_shift}</div>
                <div class="name">${entry.name}</div>
                <div class="score-info"><span class="x-count">X-${entry.x_count}</span> <span class="ten-count">10-${entry.ten_count}</span></div>
                <div class="score">${entry.total_score}</div>
            `;
            
            table.appendChild(row);
        });
        
        groupDiv.appendChild(table);
        container.appendChild(groupDiv);
    });
}

function formatGroupTitle(titleArray) {
    const generalMap = {
        'male': 'MEN',
        'female': 'WOMEN',
        'compound': 'COMPOUND BOW',
        'barebow': 'BAREBOW',
        'recurve': 'RECURVE'
    };
    titleArray = titleArray.filter(item => item !== 'unknown');
    return titleArray.map(item => generalMap[item] || item).join(' - ');
}

function startAutoScroll() {
    const container = document.getElementById('leaderboard');
    let scrollPosition = 0;
    const scrollSpeed = 0.5;
    
    scrollInterval = setInterval(() => {
        scrollPosition += scrollSpeed;
        
        const maxScroll = container.scrollHeight - window.innerHeight;
        
        if (maxScroll <= 0) {
            return;
        }
        
        if (scrollPosition >= maxScroll) {
            scrollPosition = 0;
        }
        
        window.scrollTo(0, scrollPosition);
    }, 1000 / 60);
}
