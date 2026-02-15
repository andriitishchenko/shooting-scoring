// API Client
class APIClient {
    constructor(baseURL) {
        this.baseURL = baseURL;
    }

    async request(endpoint, options = {}) {
        const url = `${this.baseURL}${endpoint}`;
        
        try {
            const response = await fetch(url, {
                ...options,
                headers: {
                    'Content-Type': 'application/json',
                    ...options.headers
                }
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.detail || 'Request failed');
            }

            return await response.json();
        } catch (error) {
            console.error('API Error:', error);
            throw error;
        }
    }

    // Events
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
        return this.request(`/events/${code}`, {
            method: 'PATCH',
            body: JSON.stringify(data)
        });
    }

    // Participants
    async addParticipant(code, participant) {
        return this.request(`/participants/${code}`, {
            method: 'POST',
            body: JSON.stringify(participant)
        });
    }

    async getParticipants(code, laneNumber = null) {
        const query = laneNumber !== null ? `?lane_number=${laneNumber}` : '';
        return this.request(`/participants/${code}${query}`);
    }

    async updateParticipant(code, participantId, participant) {
        return this.request(`/participants/${code}/${participantId}`, {
            method: 'PUT',
            body: JSON.stringify(participant)
        });
    }

    async deleteParticipant(code, participantId) {
        return this.request(`/participants/${code}/${participantId}`, {
            method: 'DELETE'
        });
    }

    // Results
    async saveResults(code, results) {
        return this.request(`/results/${code}`, {
            method: 'POST',
            body: JSON.stringify(results)
        });
    }

    async getParticipantResults(code, participantId) {
        return this.request(`/results/${code}/${participantId}`);
    }

    async getLeaderboard(code) {
        return this.request(`/results/${code}/leaderboard`);
    }

    async deleteParticipantResults(code, participantId) {
        return this.request(`/results/${code}/${participantId}`, {
            method: 'DELETE'
        });
    }
}

// Initialize API client
const api = new APIClient(CONFIG.API_BASE_URL);
