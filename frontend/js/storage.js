// LocalStorage Wrapper — all sensitive data stays here, never in HTML
class Storage {
    static set(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); }
        catch (e) { console.error('Storage.set error:', e); }
    }

    static get(key, defaultValue = null) {
        try {
            const item = localStorage.getItem(key);
            return item !== null ? JSON.parse(item) : defaultValue;
        } catch (e) {
            console.error('Storage.get error:', e);
            return defaultValue;
        }
    }

    static remove(key) {
        try { localStorage.removeItem(key); }
        catch (e) { console.error('Storage.remove error:', e); }
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
