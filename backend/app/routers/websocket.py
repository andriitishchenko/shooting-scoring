from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from app.websocket_manager import manager


router = APIRouter()


@router.websocket("/ws/{code}")
async def websocket_endpoint(websocket: WebSocket, code: str):
    """WebSocket endpoint for real-time updates"""
    await manager.connect(websocket, code)
    
    try:
        while True:
            # Receive message from client
            data = await websocket.receive_json()
            
            # Broadcast to all clients in the room
            if data.get("type") == "result_update":
                await manager.broadcast(code, {
                    "type": "result_update",
                    "participant_id": data.get("participant_id"),
                    "total_score": data.get("total_score")
                })
            
            elif data.get("type") == "event_status":
                await manager.broadcast(code, {
                    "type": "event_status",
                    "status": data.get("status")
                })
            
            elif data.get("type") == "participant_added":
                await manager.broadcast(code, {
                    "type": "participant_added",
                    "participant": data.get("participant")
                })
            
            elif data.get("type") == "refresh":
                # Signal all clients to refresh their data
                await manager.broadcast(code, {
                    "type": "refresh"
                })
                
    except WebSocketDisconnect:
        manager.disconnect(websocket, code)
    except Exception as e:
        print(f"WebSocket error: {e}")
        manager.disconnect(websocket, code)
