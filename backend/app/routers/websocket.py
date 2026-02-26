from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from app.websocket_manager import manager

router = APIRouter()


@router.websocket("/ws/{code}")
async def websocket_endpoint(websocket: WebSocket, code: str):
    await manager.connect(websocket, code)
    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")

            if msg_type == "result_update":
                await manager.broadcast(code, {
                    "type": "result_update",
                    "participant_id": data.get("participant_id"),
                    "total_score": data.get("total_score")
                })
            elif msg_type == "event_status":
                await manager.broadcast(code, {
                    "type": "event_status",
                    "status": data.get("status"),
                    "active_distance_id": data.get("active_distance_id")
                })
            elif msg_type == "refresh":
                await manager.broadcast(code, {"type": "refresh"})
            elif msg_type == "lane_session_reset":
                # Notify a specific lane that its session was reset
                await manager.broadcast(code, {
                    "type": "lane_session_reset",
                    "lane_number": data.get("lane_number")
                })
            elif msg_type == "distance_update":
                await manager.broadcast(code, {
                    "type": "distance_update",
                    "distance_id": data.get("distance_id"),
                    "status": data.get("status")
                })

    except WebSocketDisconnect:
        manager.disconnect(websocket, code)
    except Exception as e:
        print(f"WebSocket error: {e}")
        manager.disconnect(websocket, code)
