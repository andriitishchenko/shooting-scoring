// API Client — session IDs always sent as headers, never in URLs or body
class APIClient {
    constructor(baseURL) { this.baseURL = baseURL; }

    async request(endpoint, options = {}) {
        const url = `${this.baseURL}${endpoint}`;
        try {
            const response = await fetch(url, {
                ...options,
                headers: { 'Content-Type': 'application/json', ...options.headers }
            });
            if (!response.ok) {
                const err = await response.json().catch(() => ({ detail: 'Request failed' }));
                throw new Error(err.detail || 'Request failed');
            }
            return await response.json();
        } catch (error) {
            console.error('API Error:', error);
            throw error;
        }
    }

    // Helper: inject session header
    _sessionHeader(sessionId) {
        return sessionId ? { 'X-Session-Id': sessionId } : {};
    }

    // ── Events ──────────────────────────────────────────────────────────────
    async createEvent(code, shotsCount = 30) {
        return this.request('/events/create', {
            method: 'POST',
            body: JSON.stringify({ code, shots_count: shotsCount })
        });
    }

    async getEvent(code) {
        return this.request(`/events/${code}`);
    }

    async updateEvent(code, data) {
        const sid = Storage.getHostSession();
        return this.request(`/events/${code}`, {
            method: 'PATCH',
            body: JSON.stringify(data),
            headers: this._sessionHeader(sid)
        });
    }

    // ── Distances ────────────────────────────────────────────────────────────
    async getDistances(code) {
        return this.request(`/distances/${code}`);
    }

    async addDistance(code, dist) {
        const sid = Storage.getHostSession();
        return this.request(`/distances/${code}`, {
            method: 'POST',
            body: JSON.stringify(dist),
            headers: this._sessionHeader(sid)
        });
    }

    async updateDistance(code, distanceId, data) {
        const sid = Storage.getHostSession();
        return this.request(`/distances/${code}/${distanceId}`, {
            method: 'PATCH',
            body: JSON.stringify(data),
            headers: this._sessionHeader(sid)
        });
    }

    async deleteDistance(code, distanceId) {
        const sid = Storage.getHostSession();
        return this.request(`/distances/${code}/${distanceId}`, {
            method: 'DELETE',
            headers: this._sessionHeader(sid)
        });
    }

    // ── Participants ─────────────────────────────────────────────────────────
    async addParticipant(code, participant, laneSessionId = null) {
        const sid = laneSessionId || Storage.getHostSession();
        return this.request(`/participants/${code}`, {
            method: 'POST',
            body: JSON.stringify(participant),
            headers: this._sessionHeader(sid)
        });
    }

    async getParticipants(code, laneNumber = null) {
        const q = laneNumber !== null ? `?lane_number=${laneNumber}` : '';
        return this.request(`/participants/${code}${q}`);
    }

    async updateParticipant(code, participantId, participant) {
        const sid = Storage.getHostSession();
        return this.request(`/participants/${code}/${participantId}`, {
            method: 'PUT',
            body: JSON.stringify(participant),
            headers: this._sessionHeader(sid)
        });
    }

    async deleteParticipant(code, participantId) {
        const sid = Storage.getHostSession();
        return this.request(`/participants/${code}/${participantId}`, {
            method: 'DELETE',
            headers: this._sessionHeader(sid)
        });
    }

    // ── Results ──────────────────────────────────────────────────────────────
    async saveResults(code, results, laneSessionId) {
        return this.request(`/results/${code}`, {
            method: 'POST',
            body: JSON.stringify(results),
            headers: this._sessionHeader(laneSessionId)
        });
    }

    async getParticipantState(code, participantId) {
        return this.request(`/results/${code}/state/${participantId}`);
    }

    async getDistanceDetail(code, participantId, distanceId) {
        return this.request(`/results/${code}/detail/${participantId}/${distanceId}`);
    }

    async getLeaderboard(code) {
        return this.request(`/results/${code}/leaderboard`);
    }

    async deleteParticipantResults(code, participantId) {
        const sid = Storage.getHostSession();
        return this.request(`/results/${code}/${participantId}`, {
            method: 'DELETE',
            headers: this._sessionHeader(sid)
        });
    }

    // ── Properties ───────────────────────────────────────────────────────────
    async getProperties(code) {
        const sid = Storage.getHostSession();
        return this.request(`/properties/${code}`, {
            headers: this._sessionHeader(sid)
        });
    }

    async updateProperties(code, data) {
        const sid = Storage.getHostSession();
        return this.request(`/properties/${code}`, {
            method: 'PATCH',
            body: JSON.stringify(data),
            headers: this._sessionHeader(sid)
        });
    }

    async getPublicProperties(code) {
        return this.request(`/properties/${code}/public`);
    }

    // ── Sessions ─────────────────────────────────────────────────────────────
    async hostLogin(code, password, sessionId = null) {
        const body = { password: password || '' };
        if (sessionId) body.session_id = sessionId;
        return this.request(`/sessions/${code}/host`, {
            method: 'POST',
            body: JSON.stringify(body)
        });
    }

    async viewerLogin(code, password, sessionId = null) {
        const body = { password: password || '' };
        if (sessionId) body.session_id = sessionId;
        return this.request(`/sessions/${code}/viewer`, {
            method: 'POST',
            body: JSON.stringify(body)
        });
    }

    async laneLogin(code, laneNumber, sessionId = null, password = null) {
        const body = {};
        if (sessionId) body.session_id = sessionId;
        if (password)  body.password   = password;
        return this.request(`/sessions/${code}/lane/${laneNumber}`, {
            method: 'POST',
            body: JSON.stringify(body)
        });
    }

    async resetLaneSession(code, laneNumber) {
        const sid = Storage.getHostSession();
        return this.request(`/sessions/${code}/lane/${laneNumber}`, {
            method: 'DELETE',
            headers: this._sessionHeader(sid)
        });
    }
    // ── Additional session helpers ────────────────────────────────────────────
    async listLaneSessions(code) {
        const sid = Storage.getHostSession();
        return this.request(`/sessions/${code}/lanes`, {
            headers: this._sessionHeader(sid)
        });
    }
}

const api = new APIClient(CONFIG.API_BASE_URL);
