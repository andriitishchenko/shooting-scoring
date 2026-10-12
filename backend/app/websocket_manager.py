from fastapi import WebSocket
import asyncio
import json
from typing import Dict, List


class ConnectionManager:
    def __init__(self):
        # {code: [websocket1, websocket2, ...]}
        self.active_connections: Dict[str, List[WebSocket]] = {}
        self._poll_tasks: Dict[str, asyncio.Task] = {}
        self._poll_cursors: Dict[str, int] = {}
        self._room_locks: Dict[str, asyncio.Lock] = {}

    async def connect(self, websocket: WebSocket, code: str):
        lock = self._room_locks.setdefault(code, asyncio.Lock())
        async with lock:
            if code not in self.active_connections:
                from app.database import DatabaseManager
                db = DatabaseManager(code)
                async with db.get_connection() as conn:
                    cursor = await conn.execute("SELECT COALESCE(MAX(id), 0) FROM event_notifications")
                    self._poll_cursors[code] = (await cursor.fetchone())[0]
                self.active_connections[code] = []
            self.active_connections[code].append(websocket)
            if code not in self._poll_tasks:
                self._poll_tasks[code] = asyncio.create_task(self._poll_room(code))

    def disconnect(self, websocket: WebSocket, code: str):
        if code in self.active_connections:
            if websocket in self.active_connections[code]:
                self.active_connections[code].remove(websocket)
            if len(self.active_connections[code]) == 0:
                del self.active_connections[code]
                task = self._poll_tasks.pop(code, None)
                if task:
                    task.cancel()
                self._poll_cursors.pop(code, None)

    async def _poll_room(self, code: str):
        from app.database import DatabaseManager
        db = DatabaseManager(code)
        try:
            while code in self.active_connections:
                async with db.get_connection() as conn:
                    cursor = await conn.execute(
                        "SELECT id, payload FROM event_notifications WHERE id>? ORDER BY id",
                        (self._poll_cursors.get(code, 0),),
                    )
                    rows = await cursor.fetchall()

                for notification_id, payload in rows:
                    self._poll_cursors[code] = notification_id
                    await self._broadcast_local(code, json.loads(payload))

                await asyncio.sleep(0.25)
        except asyncio.CancelledError:
            raise
        finally:
            if self._poll_tasks.get(code) is asyncio.current_task():
                self._poll_tasks.pop(code, None)
                self._poll_cursors.pop(code, None)

    async def broadcast(self, code: str, message: dict):
        """Store once so every server worker can deliver the same notification."""
        from app.database import DatabaseManager
        db = DatabaseManager(code)
        async with db.get_connection() as conn:
            await conn.execute(
                "INSERT INTO event_notifications (payload) VALUES (?)",
                (json.dumps(message),),
            )
            await conn.commit()

    async def _broadcast_local(self, code: str, message: dict):
        if code in self.active_connections:
            for connection in list(self.active_connections[code]):
                try:
                    await connection.send_json(message)
                except Exception:
                    self.disconnect(connection, code)


manager = ConnectionManager()
