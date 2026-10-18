class APIError extends Error {
    constructor(message, status = 0, retryAfter = null, kind = 'http') {
        super(message);
        this.name = 'APIError';
        this.status = status;
        this.retryAfter = retryAfter;
        this.kind = kind;
    }
}

// Send session IDs in headers.
// Text for a waiting time, for example "15 minutes".
function waitText(seconds) {
    if (seconds >= 60) {
        const minutes = Math.ceil(seconds / 60);
        return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    }
    return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

class APIClient {
    constructor(baseURL) { this.baseURL = baseURL; }

    async request(endpoint, options = {}) {
        const controller = new AbortController();
        const externalSignal = options.signal;
        const abort = () => controller.abort();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, CONFIG.REQUEST_TIMEOUT_MS);
        if (externalSignal?.aborted) abort();
        else externalSignal?.addEventListener('abort', abort, { once: true });
        try {
            const response = await fetch(`${this.baseURL}${endpoint}`, {
                ...options,
                signal: controller.signal,
                headers: { 'Content-Type': 'application/json', ...options.headers }
            });
            const text = await response.text();
            let data = null;
            if (text) {
                try { data = JSON.parse(text); }
                catch {
                    if (response.ok) throw new APIError('Invalid server response.', response.status);
                }
            }
            if (!response.ok) {
                const detail = data?.detail;
                const message = Array.isArray(detail)
                    ? detail.map(item => {
                        const field = (item.loc || []).filter(part => part !== 'body').join('.');
                        return `${field ? field + ': ' : ''}${item.msg || 'Invalid value'}`;
                    }).join('; ')
                    : typeof detail === 'string' ? detail : `Request failed (${response.status}).`;
                const retryAfter = response.headers.get('Retry-After');
                const wait = response.status === 429 && /^\d+$/.test(retryAfter ?? '') ? ` Wait ${waitText(Number(retryAfter))}.` : '';
                throw new APIError(message + wait, response.status, retryAfter);
            }
            return data;
        } catch (error) {
            if (controller.signal.aborted) {
                throw new APIError(timedOut ? 'The request timed out. Try again.' : 'The request was cancelled.', 0, null, timedOut ? 'timeout' : 'cancelled');
            }
            throw error;
        } finally {
            clearTimeout(timer);
            externalSignal?.removeEventListener('abort', abort);
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
        return this.request(`/events/${encodeURIComponent(code)}`);
    }

    async updateEvent(code, data) {
        const sid = AppStorage.getHostSession();
        return this.request(`/events/${encodeURIComponent(code)}`, {
            method: 'PATCH',
            body: JSON.stringify(data),
            headers: this._sessionHeader(sid)
        });
    }

    // ── Distances ────────────────────────────────────────────────────────────
    async getDistances(code) {
        return this.request(`/distances/${encodeURIComponent(code)}`);
    }

    async addDistance(code, dist) {
        const sid = AppStorage.getHostSession();
        return this.request(`/distances/${encodeURIComponent(code)}`, {
            method: 'POST',
            body: JSON.stringify(dist),
            headers: this._sessionHeader(sid)
        });
    }

    async updateDistance(code, distanceId, data) {
        const sid = AppStorage.getHostSession();
        return this.request(`/distances/${encodeURIComponent(code)}/${distanceId}`, {
            method: 'PATCH',
            body: JSON.stringify(data),
            headers: this._sessionHeader(sid)
        });
    }

    async deleteDistance(code, distanceId) {
        const sid = AppStorage.getHostSession();
        return this.request(`/distances/${encodeURIComponent(code)}/${distanceId}`, {
            method: 'DELETE',
            headers: this._sessionHeader(sid)
        });
    }

    // ── Participants ─────────────────────────────────────────────────────────
    async addParticipant(code, participant, laneSessionId = null) {
        const sid = laneSessionId || AppStorage.getHostSession();
        return this.request(`/participants/${encodeURIComponent(code)}`, {
            method: 'POST',
            body: JSON.stringify(participant),
            headers: this._sessionHeader(sid)
        });
    }

    async getParticipants(code, laneNumber = null) {
        const q = laneNumber !== null ? `?lane_number=${laneNumber}` : '';
        return this.request(`/participants/${encodeURIComponent(code)}${q}`);
    }

    async updateParticipant(code, participantId, participant) {
        const sid = AppStorage.getHostSession();
        return this.request(`/participants/${encodeURIComponent(code)}/${participantId}`, {
            method: 'PUT',
            body: JSON.stringify(participant),
            headers: this._sessionHeader(sid)
        });
    }

    async deleteParticipant(code, participantId) {
        const sid = AppStorage.getHostSession();
        return this.request(`/participants/${encodeURIComponent(code)}/${participantId}`, {
            method: 'DELETE',
            headers: this._sessionHeader(sid)
        });
    }

    // ── Results ──────────────────────────────────────────────────────────────
    async saveResults(code, results, laneSessionId) {
        return this.request(`/results/${encodeURIComponent(code)}`, {
            method: 'POST',
            body: JSON.stringify(results),
            headers: this._sessionHeader(laneSessionId)
        });
    }

    async replaceDistanceResults(code, participantId, distanceId, shots, sessionId) {
        return this.request(`/results/${encodeURIComponent(code)}/participant/${participantId}/distance/${distanceId}`, {
            method: 'PUT',
            body: JSON.stringify({ shots }),
            headers: this._sessionHeader(sessionId)
        });
    }

    async getParticipantState(code, participantId) {
        return this.request(`/results/${encodeURIComponent(code)}/state/${participantId}`);
    }

    async getDistanceDetail(code, participantId, distanceId) {
        return this.request(`/results/${encodeURIComponent(code)}/detail/${participantId}/${distanceId}`);
    }

    async getLeaderboard(code) {
        return this.request(`/results/${encodeURIComponent(code)}/leaderboard`);
    }

    async deleteParticipantResults(code, participantId) {
        const sid = AppStorage.getHostSession();
        return this.request(`/results/${encodeURIComponent(code)}/${participantId}`, {
            method: 'DELETE',
            headers: this._sessionHeader(sid)
        });
    }

    // ── Properties ───────────────────────────────────────────────────────────
    async getProperties(code) {
        const sid = AppStorage.getHostSession();
        return this.request(`/properties/${encodeURIComponent(code)}`, {
            headers: this._sessionHeader(sid)
        });
    }

    async updateProperties(code, data) {
        const sid = AppStorage.getHostSession();
        return this.request(`/properties/${encodeURIComponent(code)}`, {
            method: 'PATCH',
            body: JSON.stringify(data),
            headers: this._sessionHeader(sid)
        });
    }

    async getPublicProperties(code) {
        return this.request(`/properties/${encodeURIComponent(code)}/public`);
    }

    // ── Sessions ─────────────────────────────────────────────────────────────
    async hostLogin(code, password, sessionId = null) {
        const body = { password: password || '' };
        if (sessionId) body.session_id = sessionId;
        return this.request(`/sessions/${encodeURIComponent(code)}/host`, {
            method: 'POST',
            body: JSON.stringify(body)
        });
    }

    async viewerLogin(code, password, sessionId = null) {
        const body = { password: password || '' };
        if (sessionId) body.session_id = sessionId;
        return this.request(`/sessions/${encodeURIComponent(code)}/viewer`, {
            method: 'POST',
            body: JSON.stringify(body)
        });
    }

    async laneLogin(code, laneNumber, sessionId = null, password = null) {
        const body = {};
        if (sessionId) body.session_id = sessionId;
        if (password)  body.password   = password;
        return this.request(`/sessions/${encodeURIComponent(code)}/lane/${laneNumber}`, {
            method: 'POST',
            body: JSON.stringify(body)
        });
    }

    async resetLaneSession(code, laneNumber) {
        const sid = AppStorage.getHostSession();
        return this.request(`/sessions/${encodeURIComponent(code)}/lane/${laneNumber}`, {
            method: 'DELETE',
            headers: this._sessionHeader(sid)
        });
    }
    // A lane that lost its password asks the host for a reset.
    async requestLaneReset(code, laneNumber) {
        return this.request(`/sessions/${encodeURIComponent(code)}/lane/${laneNumber}/reset-request`, {
            method: 'POST',
            body: JSON.stringify({})
        });
    }

    async laneResetStatus(code, laneNumber, requestId) {
        return this.request(`/sessions/${encodeURIComponent(code)}/lane/${laneNumber}/reset-request/status`, {
            method: 'POST',
            body: JSON.stringify({ request_id: requestId })
        });
    }

    async approveLaneReset(code, laneNumber) {
        const sid = AppStorage.getHostSession();
        return this.request(`/sessions/${encodeURIComponent(code)}/lane/${laneNumber}/reset-request/approve`, {
            method: 'POST',
            body: JSON.stringify({}),
            headers: this._sessionHeader(sid)
        });
    }

    async denyLaneReset(code, laneNumber) {
        const sid = AppStorage.getHostSession();
        return this.request(`/sessions/${encodeURIComponent(code)}/lane/${laneNumber}/reset-request/deny`, {
            method: 'POST',
            body: JSON.stringify({}),
            headers: this._sessionHeader(sid)
        });
    }

    // ── Additional session helpers ────────────────────────────────────────────
    async listLaneSessions(code) {
        const sid = AppStorage.getHostSession();
        return this.request(`/sessions/${encodeURIComponent(code)}/lanes`, {
            headers: this._sessionHeader(sid)
        });
    }

    // ── Bulk CSV import ───────────────────────────────────────────────────────
    async importParticipantsCSV(code, csvContent) {
        const sid = AppStorage.getHostSession();
        return this.request(`/participants/${encodeURIComponent(code)}/import`, {
            method: 'POST',
            body: JSON.stringify({ csv_content: csvContent }),
            headers: this._sessionHeader(sid)
        });
    }
}

const api = new APIClient(CONFIG.API_BASE_URL);
