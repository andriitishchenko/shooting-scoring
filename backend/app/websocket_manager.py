from fastapi import WebSocket
from typing import Dict, List


class ConnectionManager:
    def __init__(self):
        # {code: [websocket1, websocket2, ...]}
        self.active_connections: Dict[str, List[WebSocket]] = {}
    
    async def connect(self, websocket: WebSocket, code: str):
        await websocket.accept()
        if code not in self.active_connections:
            self.active_connections[code] = []
        self.active_connections[code].append(websocket)
        print(f"Client connected to room {code}. Total connections: {len(self.active_connections[code])}")
    
    def disconnect(self, websocket: WebSocket, code: str):
        if code in self.active_connections:
            self.active_connections[code].remove(websocket)
            print(f"Client disconnected from room {code}. Remaining: {len(self.active_connections[code])}")
            
            # Clean up empty rooms
            if len(self.active_connections[code]) == 0:
                del self.active_connections[code]
    
    async def broadcast(self, code: str, message: dict):
        """Send message to all clients connected to a specific code"""
        if code in self.active_connections:
            dead_connections = []
            for connection in self.active_connections[code]:
                try:
                    await connection.send_json(message)
                except Exception as e:
                    print(f"Error sending message: {e}")
                    dead_connections.append(connection)
            
            # Remove dead connections
            for connection in dead_connections:
                self.disconnect(connection, code)


manager = ConnectionManager()
