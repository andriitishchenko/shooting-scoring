// Client JavaScript
let currentCode = null;
let currentLane = null;
let currentParticipant = null;
let eventData = null;
let participants = [];
let results = [];
let wsClient = null;

window.addEventListener('DOMContentLoaded', () => {
    // Restore state
    const savedCode = Storage.getEventCode('client');
    const savedLane = Storage.getLane();
    
    if (savedCode && savedLane) {
        currentCode = savedCode;
        currentLane = savedLane;
        loadLaneParticipants();
    }
});

async function clientEnter() {
    const code = document.getElementById('code-input').value.trim().toUpperCase();
    
    if (code.length !== CONFIG.CODE_LENGTH) {
        alert('Invalid code length');
        return;
    }

    try {
        eventData = await api.getEvent(code);
        currentCode = code;
        Storage.saveEventCode(code, 'client');
        
        showLaneSelection();
        
        // WebSocket
        wsClient = new WSClient(code);
        wsClient.connect();
        wsClient.on('event_status', handleEventStatus);
        wsClient.on('refresh', () => loadLaneParticipants());
    } catch (error) {
        alert('Event not found: ' + error.message);
    }
}

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
    await loadLaneParticipants();
}

async function loadLaneParticipants() {
    try {
        // Refresh event data to get current status
        eventData = await api.getEvent(currentCode);
        
        participants = await api.getParticipants(currentCode, currentLane);
        
        document.getElementById('lane-screen').classList.add('hidden');
        document.getElementById('participants-screen').classList.remove('hidden');
        document.getElementById('current-lane').textContent = currentLane;
        
        // Show add button only if event not started
        const addBtn = document.getElementById('add-participant-btn');
        if (eventData && eventData.status === 'created') {
            addBtn.classList.remove('hidden');
        } else {
            addBtn.classList.add('hidden');
        }
        
        renderParticipantsList();
    } catch (error) {
        console.error('Error loading participants:', error);
        alert('Error loading participants');
    }
}

function renderParticipantsList() {
    const container = document.getElementById('participants-list');
    
    const sorted = participants.sort((a, b) => a.shift.localeCompare(b.shift));
    
    container.innerHTML = sorted.map(p => {
        const totalScore = calculateTotalScore(p.id);
        return `
            <div class="participant-card" onclick="openScoreInput(${p.id})">
                <div class="participant-name">${p.name}</div>
                <div class="participant-info">Lane ${p.lane_number} - Shift ${p.shift}</div>
                <div class="participant-score">${totalScore} points</div>
            </div>
        `;
    }).join('');
}

function calculateTotalScore(participantId) {
    const savedResults = Storage.getResults(participantId);
    return savedResults.reduce((sum, r) => sum + r.score, 0);
}

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
        skill_type: document.getElementById('p-skill').value || null,
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

// Score input
async function openScoreInput(participantId) {
    // Check if competition has started
    if (eventData && eventData.status !== 'started') {
        alert('Competition has not started yet. Please wait for the host to start the competition.');
        return;
    }

    if (eventData && eventData.status === 'finished') {
        alert('Competition has finished.');
        return;
    }
    
    currentParticipant = participants.find(p => p.id === participantId);
    
    // Fetch results from server
    try {
        results = await api.getParticipantResults(currentCode, participantId);
        Storage.saveResults(participantId, results);
    } catch (error) {
        console.error('Error fetching results:', error);
        results = Storage.getResults(participantId); // Fallback to local
    }

    document.getElementById('participants-screen').classList.add('hidden');
    document.getElementById('score-screen').classList.remove('hidden');
    document.getElementById('participant-name').textContent = currentParticipant.name;
    
    renderScoreGrid();
    updateTotalScore();
}

function renderScoreGrid() {
    const grid = document.getElementById('score-grid');
    const shotsPerSeries = 3;
    const totalShots = eventData.shots_count;
    const seriesCount = Math.ceil(totalShots / shotsPerSeries);
    
    grid.innerHTML = '';
    
    for (let series = 1; series <= seriesCount; series++) {
        const row = document.createElement('div');
        row.className = 'series-row';
        row.id = `series-${series}`;
        
        const seriesNum = document.createElement('div');
        seriesNum.textContent = series;
        row.appendChild(seriesNum);
        
        // Get results for this series and sort by score descending
        const seriesResults = results
            .filter(r => r.series_number === series)
            .sort((a, b) => b.score - a.score); // Sort descending
        
        for (let shot = 1; shot <= shotsPerSeries; shot++) {
            const shotIndex = (series - 1) * shotsPerSeries + shot;
            if (shotIndex > totalShots) break;
            
            const btn = document.createElement('button');
            btn.className = 'shot-btn';
            btn.dataset.series = series;
            btn.dataset.shot = shot;
            btn.onclick = (e) => selectShot(series, shot, e);
            
            // Show sorted result
            const result = seriesResults[shot - 1]; // Get from sorted array
            if (result) {
                btn.textContent = result.is_x ? 'X' : result.score;
                btn.classList.add('filled');
            }
            
            row.appendChild(btn);
        }
        
        const seriesTotal = document.createElement('div');
        seriesTotal.className = 'series-total';
        const seriesScore = calculateSeriesScore(series);
        const cumulativeScore = calculateCumulativeScore(series);
        seriesTotal.innerHTML = `${seriesScore}<br>${cumulativeScore}`;
        row.appendChild(seriesTotal);
        
        grid.appendChild(row);
    }
    
    scrollToNextEmpty();
}

let currentShotSelection = null;

function selectShot(series, shot, event) {
    const btn = event.target;
    
    // Check if this cell is already filled and selected
    const existingResult = results.find(r => r.series_number === series && r.shot_number === shot);
    
    if (existingResult && btn.classList.contains('selected')) {
        // Double-click on already selected filled cell - clear it
        if (confirm('Clear this score?')) {
            results = results.filter(r => !(r.series_number === series && r.shot_number === shot));
            Storage.saveResults(currentParticipant.id, results);
            
            // Re-render to show cleared cell
            renderScoreGrid();
            updateTotalScore();
            updateSeriesTotal(series);
        }
        return;
    }
    
    // Normal selection
    currentShotSelection = { series, shot };
    
    document.querySelectorAll('.shot-btn').forEach(btn => {
        btn.classList.remove('selected');
    });
    btn.classList.add('selected');
}

function inputScore(score, isX = false) {
    // Find the actual next empty shot
    const nextEmpty = findNextEmptyShot();
    
    if (!nextEmpty) {
        alert('All shots filled');
        return;
    }
    
    // If user selected a shot manually, check if it's valid
    if (currentShotSelection) {
        const { series, shot } = currentShotSelection;
        
        // Check if this is the next empty shot
        if (series !== nextEmpty.series || shot !== nextEmpty.shot) {
            alert('Please fill shots in sequential order. Next shot is Series ' + nextEmpty.series + ', Shot ' + nextEmpty.shot);
            // Force select the correct next shot
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
        // Auto-select next empty
        currentShotSelection = nextEmpty;
    }
    
    const { series, shot } = currentShotSelection;
    
    // Remove old result if exists
    results = results.filter(r => !(r.series_number === series && r.shot_number === shot));
    
    // Add new result
    results.push({
        participant_id: currentParticipant.id,
        series_number: series,
        shot_number: shot,
        score: score,
        is_x: isX
    });
    
    // Save locally immediately
    Storage.saveResults(currentParticipant.id, results);
    
    // Update UI - but don't re-render entire grid yet
    const btn = document.querySelector(`[data-series="${series}"][data-shot="${shot}"]`);
    if (btn) {
        btn.textContent = isX ? 'X' : score;
        btn.classList.add('filled');
        btn.classList.remove('selected');
    }
    
    updateTotalScore();
    updateSeriesTotal(series);
    
    // Check if series is complete (3 shots)
    const seriesResults = results.filter(r => r.series_number === series);
    if (seriesResults.length === 3) {
        // Series complete - re-render to sort
        renderScoreGrid();
        // Auto-save to server
        autoSaveResults();
    }
    
    // Auto-advance to next
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
    const shotsPerSeries = 3;
    const totalShots = eventData.shots_count;
    const seriesCount = Math.ceil(totalShots / shotsPerSeries);
    
    for (let series = 1; series <= seriesCount; series++) {
        for (let shot = 1; shot <= shotsPerSeries; shot++) {
            const shotIndex = (series - 1) * shotsPerSeries + shot;
            if (shotIndex > totalShots) return null;
            
            const exists = results.find(r => r.series_number === series && r.shot_number === shot);
            if (!exists) {
                return { series, shot };
            }
        }
    }
    return null;
}

function scrollToShot(series) {
    const row = document.getElementById(`series-${series}`);
    if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function scrollToNextEmpty() {
    const next = findNextEmptyShot();
    if (next) {
        // Auto-select the next empty shot
        currentShotSelection = next;
        
        setTimeout(() => {
            scrollToShot(next.series);
            
            // Highlight the selected shot
            const btn = document.querySelector(`[data-series="${next.series}"][data-shot="${next.shot}"]`);
            if (btn) {
                document.querySelectorAll('.shot-btn').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
            }
        }, 100);
    }
}

function calculateSeriesScore(series) {
    return results
        .filter(r => r.series_number === series)
        .reduce((sum, r) => sum + r.score, 0);
}

function calculateCumulativeScore(upToSeries) {
    return results
        .filter(r => r.series_number <= upToSeries)
        .reduce((sum, r) => sum + r.score, 0);
}

function updateSeriesTotal(series) {
    const seriesTotal = document.querySelector(`#series-${series} .series-total`);
    if (seriesTotal) {
        const seriesScore = calculateSeriesScore(series);
        const cumulativeScore = calculateCumulativeScore(series);
        seriesTotal.innerHTML = `${seriesScore}<br>${cumulativeScore}`;
    }
}

function updateTotalScore() {
    const total = results.reduce((sum, r) => sum + r.score, 0);
    document.getElementById('total-score').textContent = total;
}

async function backToParticipants() {
    // Validate that shots are in multiples of 3
    const shotsPerSeries = 3;
    const totalResults = results.length;
    
    if (totalResults > 0 && totalResults % shotsPerSeries !== 0) {
        const incomplete = totalResults % shotsPerSeries;
        const missing = shotsPerSeries - incomplete;
        
        if (!confirm(`Incomplete series! You have ${incomplete} shot(s) in the current series. You need ${missing} more shot(s) to complete it.\n\nDo you want to exit anyway? (Results will be saved but series is incomplete)`)) {
            return;
        }
    }
    
    // Always send results to server
    try {
        if (results.length > 0) {
            await api.saveResults(currentCode, results);
            
            const totalScore = results.reduce((sum, r) => sum + r.score, 0);
            wsClient.send({
                type: 'result_update',
                participant_id: currentParticipant.id,
                total_score: totalScore
            });
        }
    } catch (error) {
        console.error('Error saving results:', error);
        alert('Error saving results to server. They are saved locally and will sync later.');
    }
    
    document.getElementById('score-screen').classList.add('hidden');
    await loadLaneParticipants();
}

// Auto-save results to server after each complete series
async function autoSaveResults() {
    if (!currentParticipant || results.length === 0) return;
    
    try {
        await api.saveResults(currentCode, results);
        console.log('Results auto-saved to server');
    } catch (error) {
        console.error('Auto-save failed:', error);
        // Don't alert - just log it, LocalStorage has backup
    }
}

function handleEventStatus(data) {
    if (eventData) {
        eventData.status = data.status;
        if (data.status != 'created') {
            const addBtn = document.getElementById('add-participant-btn');
            if (addBtn) addBtn.classList.add('hidden');
        }
    }
}

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
