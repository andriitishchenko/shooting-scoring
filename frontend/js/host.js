// HOST JavaScript - Complete redesign with tabs
let currentCode = null;
let currentEventData = null;
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
    
    // Setup ESC key handler for modal
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            const modal = document.getElementById('participant-modal');
            if (modal && !modal.classList.contains('hidden')) {
                closeParticipantModal();
            }
        }
    });
});

// ============================================
// TAB SWITCHING
// ============================================

function switchTab(tabName) {
    console.log('Switching to tab:', tabName);
    
    // Update tab buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    document.getElementById('tab-btn-' + tabName).classList.add('active');
    
    // Update tab content
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    document.getElementById('tab-' + tabName).classList.add('active');
    
    // Auto-refresh data for the tab
    if (tabName === 'participants') {
        loadParticipants();
    } else if (tabName === 'results') {
        loadResults();
    }
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
        const event = await api.getEvent(code);
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

    loadEventData();
    
    wsClient = new WSClient(currentCode);
    wsClient.connect();
    wsClient.on('result_update', () => {
        loadParticipants();
        if (document.getElementById('tab-results').classList.contains('active')) {
            loadResults();
        }
    });
    wsClient.on('refresh', () => loadParticipants());
}

async function loadEventData() {
    try {
        const event = await api.getEvent(currentCode);
        currentEventData = event;
        
        document.getElementById('shots-count').value = event.shots_count;
        updateStatusDisplay(event.status);
        
        // Control buttons based on status
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
        
        // Load participants by default
        await loadParticipants();
    } catch (error) {
        console.error('Error loading event:', error);
    }
}

function updateStatusDisplay(status) {
    let statusBadge = document.getElementById('status-badge');
    
    if (!statusBadge) {
        const header = document.querySelector('.admin-header');
        statusBadge = document.createElement('div');
        statusBadge.id = 'status-badge';
        header.appendChild(statusBadge);
    }
    
    statusBadge.className = `status-badge ${status}`;
    
    const statusText = {
        'created': 'Not Started',
        'started': 'In Progress',
        'finished': 'Finished'
    };
    
    statusBadge.textContent = statusText[status] || status;
}

async function updateSettings() {
    // Check if competition has started
    if (currentEventData && currentEventData.status !== 'created') {
        alert('Cannot update settings after competition has started');
        return;
    }
    
    const shotsCount = parseInt(document.getElementById('shots-count').value);
    
    if (shotsCount < 1 || shotsCount > 200) {
        alert('Shots count must be between 1 and 200');
        return;
    }
    
    try {
        await api.updateEvent(currentCode, { shots_count: shotsCount });
        alert('Settings updated successfully');
    } catch (error) {
        alert('Error updating settings: ' + error.message);
    }
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
        wsClient.send({ type: 'event_status', status: 'started' });
        
        alert('Competition started!');
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
        wsClient.send({ type: 'event_status', status: 'finished' });
        
        alert('Competition finished!');
    } catch (error) {
        alert('Error finishing: ' + error.message);
    }
}

// ============================================
// PARTICIPANTS TAB
// ============================================

async function loadParticipants() {
    console.log('Loading participants...');
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
        container.innerHTML = `
            <div style="text-align: center; padding: 40px; color: #999;">
                <p style="font-size: 18px; margin-bottom: 8px;">No participants yet</p>
                <p>Click "Add Participant" button to add participants</p>
            </div>
        `;
        return;
    }
    
    // Sort by lane and shift
    participants.sort((a, b) => {
        if (a.lane_number !== b.lane_number) return a.lane_number - b.lane_number;
        return a.shift.localeCompare(b.shift);
    });
    
    // Group by lane
    const groupedByLane = {};
    participants.forEach(p => {
        if (!groupedByLane[p.lane_number]) {
            groupedByLane[p.lane_number] = [];
        }
        groupedByLane[p.lane_number].push(p);
    });
    
    // Render grouped lanes
    let html = '';
    
    for (const [lane, laneParticipants] of Object.entries(groupedByLane)) {
        html += `
            <div class="lane-group">
                <div class="lane-group-header">Lane ${lane}</div>
                <div class="lane-participants">
                    ${laneParticipants.map(p => `
                        <div class="participant-row">
                            <div class="participant-lane-shift">${p.lane_number}${p.shift}</div>
                            <div class="participant-details">
                                <div class="participant-name-inline">${p.name}</div>
                                <div class="participant-meta">
                                    ${p.gender ? `<span class="meta-badge">${p.gender}</span>` : ''}
                                    ${p.personal_number ? `<span class="meta-badge">№${p.personal_number}</span>` : ''}
                                    ${p.shooting_type ? `<span class="meta-badge">${p.shooting_type}</span>` : ''}
                                </div>
                            </div>
                            <button class="btn-edit-inline" onclick="editParticipant(${p.id})" title="Edit">
                                ✎ Edit
                            </button>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }
    
    container.innerHTML = html;
}

// ============================================
// PARTICIPANT MODAL
// ============================================

function showAddParticipantModal() {
    console.log('Opening add participant modal');
    
    document.getElementById('modal-title').textContent = 'Add Participant';
    document.getElementById('submit-participant-btn').textContent = 'Add Participant';
    document.getElementById('edit-participant-id').value = '';
    
    // Clear all form fields
    document.getElementById('participant-form').reset();
    
    // Show modal
    document.getElementById('participant-modal').classList.remove('hidden');
    
    // Focus first input
    setTimeout(() => {
        document.getElementById('p-name').focus();
    }, 100);
}

function editParticipant(participantId) {
    console.log('Editing participant:', participantId);
    
    const participant = allParticipants.find(p => p.id === participantId);
    if (!participant) return;
    
    document.getElementById('modal-title').textContent = 'Edit Participant';
    document.getElementById('submit-participant-btn').textContent = 'Update Participant';
    document.getElementById('edit-participant-id').value = participantId;
    
    document.getElementById('p-name').value = participant.name;
    document.getElementById('p-lane').value = participant.lane_number;
    document.getElementById('p-shift').value = participant.shift;
    document.getElementById('p-gender').value = participant.gender || '';
    document.getElementById('p-age-category').value = participant.age_category || '';
    document.getElementById('p-shooting-type').value = participant.shooting_type || '';
    document.getElementById('p-skill').value = participant.skill_type || '';
    document.getElementById('p-number').value = participant.personal_number || '';
    
    document.getElementById('participant-modal').classList.remove('hidden');
    
    // Focus first input
    setTimeout(() => {
        document.getElementById('p-name').focus();
    }, 100);
}

function closeParticipantModal() {
    console.log('Closing modal');
    
    document.getElementById('participant-modal').classList.add('hidden');
    document.getElementById('participant-form').reset();
    document.getElementById('edit-participant-id').value = '';
}

async function submitParticipant(e) {
    e.preventDefault();
    
    console.log('Submitting participant...');
    
    const participantId = document.getElementById('edit-participant-id').value;
    const participant = {
        name: document.getElementById('p-name').value,
        lane_number: parseInt(document.getElementById('p-lane').value),
        shift: document.getElementById('p-shift').value.toUpperCase(),
        gender: document.getElementById('p-gender').value || null,
        age_category: document.getElementById('p-age-category').value || null,
        shooting_type: document.getElementById('p-shooting-type').value || null,
        skill_type: document.getElementById('p-skill').value || null,
        personal_number: document.getElementById('p-number').value || null
    };
    
    try {
        if (participantId) {
            // Edit mode - check if competition started
            if (currentEventData && currentEventData.status !== 'created') {
                alert('Cannot edit participants after competition has started');
                return;
            }
            
            // Update existing participant
            await api.updateParticipant(currentCode, participantId, participant);
            wsClient.send({ type: 'refresh' });
            
            console.log('Participant updated successfully');
            
            // Clear form
            document.getElementById('participant-form').reset();
            closeParticipantModal();
            await loadParticipants();
            
            alert('Participant updated successfully!');
        } else {
            // Add new participant
            await api.addParticipant(currentCode, participant);
            wsClient.send({ type: 'refresh' });
            
            console.log('Participant added successfully');
            
            // Clear form
            document.getElementById('participant-form').reset();
            closeParticipantModal();
            await loadParticipants();
            
            alert('Participant added successfully!');
        }
    } catch (error) {
        console.error('Error submitting participant:', error);
        alert('Error: ' + error.message);
    }
}

// ============================================
// RESULTS TAB
// ============================================

async function loadResults() {
    console.log('Loading results...');
    try {
        const leaderboard = await api.getLeaderboard(currentCode);
        allResults = leaderboard;
        filterResults();
    } catch (error) {
        console.error('Error loading results:', error);
        document.getElementById('results-container').innerHTML = 
            '<p style="text-align: center; color: #999; padding: 40px;">Error loading results</p>';
    }
}

function filterResults() {
    const genderFilter = document.getElementById('filter-gender').value;
    const typeFilter = document.getElementById('filter-type').value;
    
    let filtered = {};
    
    for (const [key, entries] of Object.entries(allResults)) {
        const [gender, type] = key.split('_');
        
        if (genderFilter && gender !== genderFilter) continue;
        if (typeFilter && type !== typeFilter) continue;
        
        filtered[key] = entries;
    }
    
    renderResults(filtered);
}

function renderResults(grouped) {
    const container = document.getElementById('results-container');
    
    if (!grouped || Object.keys(grouped).length === 0) {
        container.innerHTML = `
            <div style="text-align: center; padding: 40px; color: #999;">
                <p style="font-size: 18px; margin-bottom: 8px;">No results found</p>
                <p>Try changing the filters or wait for participants to submit scores</p>
            </div>
        `;
        return;
    }
    
    let html = '';
    
    for (const [groupKey, entries] of Object.entries(grouped)) {
        const [gender, shootingType] = groupKey.split('_');
        
        // Sort by score descending
        const sortedEntries = entries.sort((a, b) => b.total_score - a.total_score);
        
        html += `
            <div class="results-group">
                <div class="results-group-title">${formatGroupTitle(gender, shootingType)}</div>
                <table class="results-table">
                    <thead>
                        <tr>
                            <th style="width: 60px;">Rank</th>
                            <th>Name</th>
                            <th style="width: 100px;">Lane</th>
                            <th style="width: 100px;">Score</th>
                            <th style="width: 100px;">Shots</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${sortedEntries.map((entry, index) => `
                            <tr class="${index < 3 ? 'top-3' : ''}">
                                <td><span class="result-rank rank-${index + 1}">${index + 1}</span></td>
                                <td><strong>${entry.name}</strong></td>
                                <td>${entry.lane_shift}</td>
                                <td><span class="result-score">${entry.total_score}</span></td>
                                <td>${entry.shots_taken}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }
    
    container.innerHTML = html;
}

function formatGroupTitle(gender, shootingType) {
    const genderMap = {
        'male': 'Men',
        'female': 'Women',
        'unknown': 'Unspecified Gender'
    };
    
    const shootingMap = {
        'compound': 'Compound Bow',
        'barebow': 'Barebow',
        'recurve': 'Recurve',
        'unknown': 'Unspecified Type'
    };
    
    return `${genderMap[gender] || gender} - ${shootingMap[shootingType] || shootingType}`;
}

// ============================================
// CSV IMPORT/EXPORT
// ============================================

async function importCSV(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    // Check if competition has started
    if (currentEventData && currentEventData.status !== 'created') {
        alert('Cannot import participants after competition has started');
        event.target.value = ''; // Reset file input
        return;
    }
    
    try {
        const text = await file.text();
        const lines = text.split('\n');
        
        // Skip header row
        const dataLines = lines.slice(1).filter(line => line.trim());
        
        if (dataLines.length === 0) {
            alert('CSV file is empty');
            return;
        }
        
        let successCount = 0;
        let errorCount = 0;
        
        for (const line of dataLines) {
            // Parse CSV line (handle quotes)
            const values = line.match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g) || [];
            const cleanValues = values.map(v => v.replace(/^"|"$/g, '').trim());
            
            if (cleanValues.length < 3) {
                errorCount++;
                continue;
            }
            
            const [name, lane, shift, gender, ageCategory, shootingType, skill, personalNumber] = cleanValues;
            
            const participant = {
                name: name || '',
                lane_number: parseInt(lane) || 0,
                shift: (shift || '').toUpperCase(),
                gender: gender || null,
                age_category: ageCategory || null,
                shooting_type: shootingType || null,
                skill_type: skill || null,
                personal_number: personalNumber || null
            };
            
            // Validate required fields
            if (!participant.name || !participant.lane_number || !participant.shift) {
                errorCount++;
                continue;
            }
            
            try {
                await api.addParticipant(currentCode, participant);
                successCount++;
            } catch (error) {
                console.error('Error adding participant:', error);
                errorCount++;
            }
        }
        
        // Notify user
        let message = `Import complete!\n`;
        message += `✓ Successfully added: ${successCount}\n`;
        if (errorCount > 0) {
            message += `✗ Failed: ${errorCount}`;
        }
        alert(message);
        
        // Reload participants
        wsClient.send({ type: 'refresh' });
        await loadParticipants();
        
        // Reset file input
        event.target.value = '';
        
    } catch (error) {
        console.error('CSV import error:', error);
        alert('Error reading CSV file: ' + error.message);
        event.target.value = '';
    }
}

async function exportCSV() {
    try {
        const participants = await api.getParticipants(currentCode);
        const leaderboard = await api.getLeaderboard(currentCode);

        let csv = 'Rank,Name,Lane,Shift,Gender,Shooting Type,Score,Shots\n';
        
        for (const [groupKey, entries] of Object.entries(leaderboard)) {
            const [gender, shootingType] = groupKey.split('_');
            const sortedEntries = entries.sort((a, b) => b.total_score - a.total_score);
            
            sortedEntries.forEach((entry, index) => {
                const participant = participants.find(p => p.id === entry.id);
                if (participant) {
                    csv += `${index + 1},"${participant.name}",${participant.lane_number},"${participant.shift}","${gender}","${shootingType}",${entry.total_score},${entry.shots_taken}\n`;
                }
            });
        }

        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `results_${currentCode}_${new Date().toISOString().split('T')[0]}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        
        alert('CSV exported successfully!');
    } catch (error) {
        alert('Export error: ' + error.message);
    }
}

function exitHost() {
    if (confirm('Exit admin panel and clear session?')) {
        Storage.clearEventCode('host');
        if (wsClient) wsClient.disconnect();
        location.href = 'index.html';
    }
}
