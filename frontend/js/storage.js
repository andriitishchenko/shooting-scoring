// LocalStorage Wrapper
class Storage {
    static set(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (e) {
            console.error('LocalStorage save error:', e);
        }
    }

    static get(key, defaultValue = null) {
        try {
            const item = localStorage.getItem(key);
            return item ? JSON.parse(item) : defaultValue;
        } catch (e) {
            console.error('LocalStorage get error:', e);
            return defaultValue;
        }
    }

    static remove(key) {
        try {
            localStorage.removeItem(key);
        } catch (e) {
            console.error('LocalStorage remove error:', e);
        }
    }

    static clear() {
        try {
            localStorage.clear();
        } catch (e) {
            console.error('LocalStorage clear error:', e);
        }
    }

    // Application-specific methods
    static saveEventCode(code, role = 'host') {
        this.set(`${role}_code`, code);
    }

    static getEventCode(role = 'host') {
        return this.get(`${role}_code`);
    }

    static clearEventCode(role = 'host') {
        this.remove(`${role}_code`);
    }

    static saveResults(participantId, results) {
        const key = `results_${participantId}`;
        this.set(key, results);
    }

    static getResults(participantId) {
        const key = `results_${participantId}`;
        return this.get(key, []);
    }

    static clearResults(participantId) {
        const key = `results_${participantId}`;
        this.remove(key);
    }

    static clearAllParticipantResults() {
        try {
            const keysToRemove = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.startsWith('results_')) {
                    keysToRemove.push(key);
                }
            }
            keysToRemove.forEach(key => localStorage.removeItem(key));
        } catch (e) {
            console.error('LocalStorage clear all results error:', e);
        }
    }

    static saveLane(lane) {
        this.set('client_lane', lane);
    }

    static getLane() {
        return this.get('client_lane');
    }

    static clearLane() {
        this.remove('client_lane');
    }
}
