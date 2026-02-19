from fastapi import APIRouter, HTTPException
from app.database import DatabaseManager
from app.models import EventCreate, EventUpdate, EventResponse

router = APIRouter(prefix="/api/events", tags=["events"])


@router.post("/create")
async def create_event(event: EventCreate):
    db = DatabaseManager(event.code)
    if db.exists():
        raise HTTPException(status_code=400, detail="Code already exists")

    await db.init_db()

    async with db.get_connection() as conn:
        cursor = await conn.execute(
            "INSERT INTO event (code, shots_count) VALUES (?, ?)",
            (event.code, event.shots_count)
        )
        event_id = cursor.lastrowid

        # Create default distance
        await conn.execute(
            "INSERT INTO distances (event_id, title, shots_count, sort_order, status) VALUES (?, ?, ?, ?, ?)",
            (event_id, "Distance 1", event.shots_count, 0, "pending")
        )
        await conn.commit()

    return {"message": "Event created", "code": event.code}


@router.get("/{code}", response_model=EventResponse)
async def get_event(code: str):
    db = DatabaseManager(code)
    if not db.exists():
        raise HTTPException(status_code=404, detail="Event not found")

    await db.init_db()

    async with db.get_connection() as conn:
        cursor = await conn.execute(
            "SELECT id, code, shots_count, status, created_at, started_at, finished_at FROM event WHERE code = ?",
            (code,)
        )
        row = await cursor.fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="Event not found")

    return EventResponse(
        id=row[0], code=row[1], shots_count=row[2], status=row[3],
        created_at=row[4], started_at=row[5], finished_at=row[6]
    )


@router.patch("/{code}")
async def update_event(code: str, update: EventUpdate):
    db = DatabaseManager(code)
    if not db.exists():
        raise HTTPException(status_code=404, detail="Event not found")

    async with db.get_connection() as conn:
        if update.status:
            if update.status == 'started':
                await conn.execute(
                    "UPDATE event SET status=?, started_at=CURRENT_TIMESTAMP WHERE code=?",
                    (update.status, code)
                )
            elif update.status == 'finished':
                # Also mark any active distance as finished
                cursor = await conn.execute("SELECT id FROM event WHERE code=?", (code,))
                ev = await cursor.fetchone()
                if ev:
                    await conn.execute(
                        "UPDATE distances SET status='finished' WHERE event_id=? AND status='active'",
                        (ev[0],)
                    )
                await conn.execute(
                    "UPDATE event SET status=?, finished_at=CURRENT_TIMESTAMP WHERE code=?",
                    (update.status, code)
                )
            else:
                await conn.execute("UPDATE event SET status=? WHERE code=?", (update.status, code))

        if update.shots_count:
            await conn.execute("UPDATE event SET shots_count=? WHERE code=?", (update.shots_count, code))

        await conn.commit()

    return {"message": "Event updated"}
