import asyncio
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from app.database import DatabaseManager
from app.websocket_manager import manager

router = APIRouter()


@router.websocket("/ws/{code}")
async def websocket_endpoint(websocket: WebSocket, code: str):
    await websocket.accept()
    connected = False
    try:
        data = await asyncio.wait_for(websocket.receive_json(), timeout=10)
        if not isinstance(data, dict):
            await websocket.close(code=1008)
            return
        session_id = data.get("session_id")
        if data.get("type") != "authenticate" or not isinstance(session_id, str):
            await websocket.close(code=1008)
            return

        try:
            db = DatabaseManager(code)
        except ValueError:
            await websocket.close(code=1008)
            return
        if not db.exists():
            await websocket.close(code=1008)
            return

        async with db.get_connection() as conn:
            cursor = await conn.execute(
                "SELECT role, identifier FROM sessions WHERE session_id=?", (session_id,)
            )
            session = await cursor.fetchone()

        if session is None:
            await websocket.close(code=1008)
            return

        role, identifier = session
        await websocket.send_json({"type": "authenticated", "role": role})
        await manager.connect(websocket, code)
        connected = True

        while True:
            await websocket.receive()
    except WebSocketDisconnect:
        pass
    except asyncio.TimeoutError:
        try:
            await websocket.close(code=1008)
        except RuntimeError:
            pass
    finally:
        if connected:
            manager.disconnect(websocket, code)
