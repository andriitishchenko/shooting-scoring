import asyncio
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketDisconnected
from app.database import DatabaseManager
from app.security import hash_session_id, verify_session_id
from app.routers.sessions import _upgrade_stored_password
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
                """SELECT role, identifier, session_id, password FROM sessions
                   WHERE session_id IN (?, ?) LIMIT 1""",
                (hash_session_id(session_id), session_id),
            )
            session = await cursor.fetchone()
            if session is not None:
                valid, sid_needs_upgrade = verify_session_id(session_id, session[2])
                if not valid:
                    session = None
                else:
                    if sid_needs_upgrade:
                        await conn.execute(
                            "UPDATE sessions SET session_id=? WHERE role=? AND identifier=?",
                            (hash_session_id(session_id), session[0], session[1]),
                        )
                    await _upgrade_stored_password(conn, session[0], session[3], session[1])
                    await conn.commit()

        if session is None:
            await websocket.close(code=1008)
            return

        role, identifier = session[0], session[1]
        await websocket.send_json({"type": "authenticated", "role": role})
        await manager.connect(websocket, code)
        connected = True

        while True:
            await websocket.receive()
    except (WebSocketDisconnect, WebSocketDisconnected):
        pass
    except asyncio.TimeoutError:
        try:
            await websocket.close(code=1008)
        except RuntimeError:
            pass
    finally:
        if connected:
            manager.disconnect(websocket, code)
