// WebSocket Client
class WSClient {
    constructor(code, sessionId) {
        this.code = code;
        this.sessionId = sessionId;
        this.ws = null;
        this.reconnectInterval = 3000;
        this.listeners = {};
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.authenticated = false;
    }

    connect() {
        const url = `${CONFIG.WS_BASE_URL}/${this.code}`;
        
        try {
            this.ws = new WebSocket(url);

            this.ws.onopen = () => {
                console.log('WebSocket connected');
                this.ws.send(JSON.stringify({ type: 'authenticate', session_id: this.sessionId }));
            };

            this.ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                if (data.type === 'authenticated') {
                    this.authenticated = true;
                    this.reconnectAttempts = 0;
                }
                this.handleMessage(data);
            };

            this.ws.onclose = (event) => {
                console.log('WebSocket disconnected');
                this.authenticated = false;
                if (event.code !== 1008 && this.reconnectAttempts < this.maxReconnectAttempts) {
                    this.reconnectAttempts++;
                    console.log(`Reconnecting... (attempt ${this.reconnectAttempts})`);
                    setTimeout(() => this.connect(), this.reconnectInterval);
                }
            };

            this.ws.onerror = (error) => {
                console.error('WebSocket error:', error);
            };
        } catch (error) {
            console.error('Failed to create WebSocket:', error);
        }
    }

    handleMessage(data) {
        const type = data.type;
        if (this.listeners[type]) {
            this.listeners[type].forEach(callback => callback(data));
        }
    }

    on(type, callback) {
        if (!this.listeners[type]) {
            this.listeners[type] = [];
        }
        this.listeners[type].push(callback);
    }

    disconnect() {
        if (this.ws) {
            this.reconnectAttempts = this.maxReconnectAttempts; // Prevent reconnection
            this.ws.close();
            this.ws = null;
        }
    }
}
