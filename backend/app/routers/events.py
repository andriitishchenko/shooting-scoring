from fastapi import APIRouter, HTTPException
from app.database import DatabaseManager
from app.models import EventCreate, EventUpdate, EventResponse
from datetime import datetime


router = APIRouter(prefix="/api/events", tags=["events"])


@router.post("/create")
async def create_event(event: EventCreate):
    """Create new event (HOST)"""
    db_manager = DatabaseManager(event.code)
    
    # Check if code already exists
    if db_manager.exists():
        raise HTTPException(status_code=400, detail="Code already exists")
    
    # Initialize database
    await db_manager.init_db()
    
    # Insert event
    async with db_manager.get_connection() as db:
        await db.execute(
            "INSERT INTO event (code, shots_count) VALUES (?, ?)",
            (event.code, event.shots_count)
        )
        await db.commit()
    
    return {"message": "Event created", "code": event.code}


@router.get("/{code}", response_model=EventResponse)
async def get_event(code: str):
    """Get event information"""
    db_manager = DatabaseManager(code)
    
    if not db_manager.exists():
        raise HTTPException(status_code=404, detail="Event not found")
    
    async with db_manager.get_connection() as db:
        cursor = await db.execute(
            "SELECT id, code, shots_count, status, created_at, started_at, finished_at FROM event WHERE code = ?",
            (code,)
        )
        event = await cursor.fetchone()
        
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    
    return EventResponse(
        id=event[0],
        code=event[1],
        shots_count=event[2],
        status=event[3],
        created_at=event[4],
        started_at=event[5],
        finished_at=event[6]
    )


@router.patch("/{code}")
async def update_event(code: str, update: EventUpdate):
    """Update event (start/stop/settings)"""
    db_manager = DatabaseManager(code)
    
    if not db_manager.exists():
        raise HTTPException(status_code=404, detail="Event not found")
    
    async with db_manager.get_connection() as db:
        # Update status
        if update.status:
            if update.status == 'started':
                await db.execute(
                    "UPDATE event SET status = ?, started_at = CURRENT_TIMESTAMP WHERE code = ?",
                    (update.status, code)
                )
            elif update.status == 'finished':
                await db.execute(
                    "UPDATE event SET status = ?, finished_at = CURRENT_TIMESTAMP WHERE code = ?",
                    (update.status, code)
                )
            else:
                await db.execute(
                    "UPDATE event SET status = ? WHERE code = ?",
                    (update.status, code)
                )
        
        # Update shots count
        if update.shots_count:
            await db.execute(
                "UPDATE event SET shots_count = ? WHERE code = ?",
                (update.shots_count, code)
            )
        
        await db.commit()
    
    return {"message": "Event updated"}
