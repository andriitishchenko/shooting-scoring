// Store browser data in localStorage.
class AppStorage {
    static set(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); return true; }
        catch (e) { console.error('AppStorage.set error:', e); return false; }
    }

    static get(key, defaultValue = null) {
        try {
            const item = localStorage.getItem(key);
            return item !== null ? JSON.parse(item) : defaultValue;
        } catch (e) {
            console.error('AppStorage.get error:', e);
            return defaultValue;
        }
    }

    static remove(key) {
        try { localStorage.removeItem(key); }
        catch (e) { console.error('AppStorage.remove error:', e); }
    }

    // ── Event code ──────────────────────────────────────────────────────────
    static saveEventCode(code, role = 'host')  { this.set(`${role}_code`, code); }
    static getEventCode(role = 'host')          { return this.get(`${role}_code`); }
    static clearEventCode(role = 'host')        { this.remove(`${role}_code`); }

    // ── Host session ────────────────────────────────────────────────────────
    static saveHostSession(sessionId)   { this.set('host_session_id', sessionId); }
    static getHostSession()             { return this.get('host_session_id'); }
    static clearHostSession()           { this.remove('host_session_id'); }

    // ── Host password (displayed in UI, cleared on exit) ───────────────────
    static saveHostPassword(pw)         { this.set('host_password', pw); }
    static getHostPassword()            { return this.get('host_password', ''); }
    static clearHostPassword()          { this.remove('host_password'); }

    // ── Viewer session ──────────────────────────────────────────────────────
    static saveViewerSession(sessionId) { this.set('viewer_session_id', sessionId); }
    static getViewerSession()           { return this.get('viewer_session_id'); }
    static clearViewerSession()         { this.remove('viewer_session_id'); }

    // ── Practice list (the practice page works without a server) ───────────
    // The saved list is `{ shots, results: [{ shot, score, is_x }] }`. Return null
    // when nothing is saved or the saved data is not valid.
    static savePractice(session)        { return this.set('practice_session', session); }
    static clearPractice()              { this.remove('practice_session'); }
    static getPractice() {
        const saved = this.get('practice_session');
        if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null;
        const { shots, results } = saved;
        if (!Number.isInteger(shots) || shots < 1 || shots > 300 || !Array.isArray(results)) return null;
        const used = new Set();
        for (const item of results) {
            if (!item || typeof item !== 'object') return null;
            const { shot, score, is_x } = item;
            if (!Number.isInteger(shot) || shot < 1 || shot > shots || used.has(shot)) return null;
            if (!Number.isInteger(score) || score < 0 || score > 10 || typeof is_x !== 'boolean') return null;
            if (is_x && score !== 10) return null;
            used.add(shot);
        }
        return { shots, results: results.map(({ shot, score, is_x }) => ({ shot, score, is_x })) };
    }

    // ── Viewer auto-scroll switch (on unless the saved value is exactly false) ─
    static saveViewerAutoScroll(on)     { this.set('viewer_autoscroll', Boolean(on)); }
    static getViewerAutoScroll()        { return this.get('viewer_autoscroll') !== false; }

    // ── Client lane ─────────────────────────────────────────────────────────
    static saveLane(lane)               { this.set('client_lane', lane); }
    static getLane()                    { return this.get('client_lane'); }
    static clearLane()                  { this.remove('client_lane'); }

    // ── Client lane session ──────────────────────────────────────────────────
    static saveLaneSession(lane, sid)   { this.set(`lane_session_${lane}`, sid); }
    static getLaneSession(lane)         { return this.get(`lane_session_${lane}`); }
    static clearLaneSession(lane)       { this.remove(`lane_session_${lane}`); }

    // ── Participant state cache ──────────────────────────────────────────────
    static saveParticipantState(pid, state) { this.set(`pstate_${pid}`, state); }
    static getParticipantState(pid)         { return this.get(`pstate_${pid}`); }
    static _pendingResultKey(code, pid, did) { return `pending_results_${code}_${pid}_${did}`; }
    static savePendingResults(code, pid, did, lane, sessionId, shots) {
        const saved = this.set(this._pendingResultKey(code, pid, did), {
            code, participant_id: pid, distance_id: did, lane_number: lane,
            session_id: sessionId, shots
        });
        if (!saved) throw new Error('Could not save scores on this device. Free browser storage and try again.');
    }
    static getPendingResults(code, lane) {
        try {
            const prefix = `pending_results_${code}_`;
            const rows = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (!key?.startsWith(prefix)) continue;
                const value = this.get(key);
                if (value && (lane === undefined || value.lane_number === lane)) rows.push(value);
            }
            return rows;
        } catch (e) {
            console.error('AppStorage.getPendingResults error:', e);
            return [];
        }
    }
    static getPendingResult(code, pid, did) {
        return this.get(this._pendingResultKey(code, pid, did));
    }
    static clearPendingResults(code, pid, did) {
        this.remove(this._pendingResultKey(code, pid, did));
    }
    static archivePendingResults(record, reason = 'session_changed') {
        const prefix = `recovery_results_${record.code}_${record.participant_id}_${record.distance_id}_`;
        const shots = JSON.stringify(record.shots);
        for (let i = 0; i < localStorage.length; i++) {
            const existing = localStorage.key(i);
            if (existing?.startsWith(prefix) && JSON.stringify(this.get(existing)?.shots) === shots) {
                this.clearPendingResults(record.code, record.participant_id, record.distance_id);
                return;
            }
        }
        let key, attempt = 0;
        do { key = `${prefix}${Date.now()}${attempt ? '_' + attempt : ''}`; attempt++; }
        while (localStorage.getItem(key) !== null);
        const { session_id, ...recovery } = record;
        this.set(key, { ...recovery, reason });
        if (!this.get(key)) throw new Error('Could not keep the unsent scores on this device.');
        this.clearPendingResults(record.code, record.participant_id, record.distance_id);
    }
    static getRecoveryResults() {
        const rows = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key?.startsWith('recovery_results_')) {
                const value = this.get(key);
                if (value) rows.push(value);
            }
        }
        return rows;
    }
    // A request for a new lane password that waits for the host.
    static _resetKey(code, lane) { return `reset_request_${code}_${lane}`; }
    static saveResetRequest(code, lane, id) { this.set(this._resetKey(code, lane), id); }
    static getResetRequest(code, lane) { return this.get(this._resetKey(code, lane)); }
    static clearResetRequest(code, lane) { this.remove(this._resetKey(code, lane)); }
    static clearAllParticipantStates() {
        try {
            const keys = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && (k.startsWith('pstate_') || k.startsWith('results_'))) keys.push(k);
            }
            keys.forEach(k => localStorage.removeItem(k));
        } catch (e) { console.error('clearAllParticipantStates error:', e); }
    }
}
