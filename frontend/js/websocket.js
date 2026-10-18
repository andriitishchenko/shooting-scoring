class WSClient {
    constructor(code, sessionId) {
        this.code = code;
        this.sessionId = sessionId;
        this.ws = null;
        this.listeners = {};
        this.reconnectAttempts = 0;
        this.reconnectTimer = null;
        this.authenticated = false;
        this.stopped = true;
        this._online = () => {
            if (this.stopped || this.authenticated) return;
            this._cancelReconnect();
            if (this.ws) {
                const socket = this.ws;
                this.ws = null;
                socket.close();
            }
            this.connect();
        };
    }

    connect() {
        if (this.ws && this.ws.readyState <= 1) return;
        if (this.stopped) {
            this.stopped = false;
            window.addEventListener('online', this._online);
        }
        this._cancelReconnect();
        try {
            const socket = new WebSocket(`${CONFIG.WS_BASE_URL}/${encodeURIComponent(this.code)}`);
            this.ws = socket;
            socket.onopen = () => {
                if (this.stopped || this.ws !== socket) return;
                socket.send(JSON.stringify({ type: 'authenticate', session_id: this.sessionId }));
            };
            socket.onmessage = event => {
                if (this.stopped || this.ws !== socket) return;
                let data;
                try {
                    data = JSON.parse(event.data);
                    if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.type !== 'string') {
                        throw new Error('Invalid WebSocket message');
                    }
                } catch (error) {
                    console.warn('Could not read WebSocket message:', error);
                    return;
                }
                if (data.type === 'authenticated') {
                    this.authenticated = true;
                    this.reconnectAttempts = 0;
                }
                this.handleMessage(data);
            };
            socket.onclose = event => {
                if (this.ws !== socket) return;
                this.ws = null;
                this.authenticated = false;
                if (event.code === 1008) {
                    this.disconnect();
                    this.handleMessage({ type: 'session_rejected' });
                    return;
                }
                this._scheduleReconnect();
            };
            socket.onerror = error => console.warn('WebSocket error:', error);
        } catch (error) {
            this.ws = null;
            console.warn('Could not connect WebSocket:', error);
            this._scheduleReconnect();
        }
    }

    _cancelReconnect() {
        if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
    }

    _scheduleReconnect() {
        if (this.stopped || this.reconnectTimer !== null) return;
        const delay = Math.min(1000 * 2 ** Math.min(this.reconnectAttempts++, 6), 30000);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.stopped) this.connect();
        }, delay);
    }

    handleMessage(data) {
        for (const callback of [...(this.listeners[data.type] || [])]) {
            try {
                Promise.resolve(callback(data)).catch(error => console.error('WebSocket listener failed:', error));
            } catch (error) {
                console.error('WebSocket listener failed:', error);
            }
        }
    }

    on(type, callback) {
        (this.listeners[type] ||= []).push(callback);
    }

    disconnect() {
        this.stopped = true;
        this.authenticated = false;
        this._cancelReconnect();
        window.removeEventListener('online', this._online);
        const socket = this.ws;
        this.ws = null;
        if (socket) socket.close();
    }
}
