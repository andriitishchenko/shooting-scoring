from fastapi import APIRouter, HTTPException, Header
from app.database import DatabaseManager
from app.models import DistanceCreate, DistanceUpdate, DistanceResponse
from app.routers.sessions import require_session
from app.routers.events import get_event_status
from typing import List, Optional

router = APIRouter(prefix="/api/distances", tags=["distances"])


@router.get("/{code}", response_model=List[DistanceResponse])
async def list_distances(code: str):
    """List distances. Public."""
    db = DatabaseManager(code)
    if not db.exists():
        raise HTTPException(status_code=404, detail="Event not found")

    async with db.get_connection() as conn:
        cursor = await conn.execute(
            "SELECT id, title, shots_count, sort_order, status FROM distances ORDER BY sort_order"
        )
        rows = await cursor.fetchall()

    return [
        DistanceResponse(id=r[0], title=r[1], shots_count=r[2], sort_order=r[3], status=r[4])
        for r in rows
    ]


@router.post("/{code}", response_model=DistanceResponse)
async def add_distance(
    code: str,
    dist: DistanceCreate,
    x_session_id: Optional[str] = Header(None),
):
    db = DatabaseManager(code)
    if not db.exists():
        raise HTTPException(status_code=404, detail="Event not found")
    await require_session(db, "host", "default", x_session_id)

    event_status = await get_event_status(db)
    if event_status == "finished":
        raise HTTPException(status_code=403, detail="Event is finished")

    async with db.get_connection() as conn:
        cursor = await conn.execute("SELECT COALESCE(MAX(sort_order), -1) FROM distances")
        max_order = (await cursor.fetchone())[0]
        cursor = await conn.execute(
            "INSERT INTO distances (title, shots_count, sort_order, status) VALUES (?, ?, ?, 'pending')",
            (dist.title, dist.shots_count, max_order + 1),
        )
        await conn.commit()
        dist_id = cursor.lastrowid
        cursor = await conn.execute(
            "SELECT id, title, shots_count, sort_order, status FROM distances WHERE id=?",
            (dist_id,),
        )
        row = await cursor.fetchone()

    return DistanceResponse(id=row[0], title=row[1], shots_count=row[2], sort_order=row[3], status=row[4])


@router.patch("/{code}/{distance_id}", response_model=DistanceResponse)
async def update_distance(
    code: str,
    distance_id: int,
    update: DistanceUpdate,
    x_session_id: Optional[str] = Header(None),
):
    db = DatabaseManager(code)
    if not db.exists():
        raise HTTPException(status_code=404, detail="Event not found")
    await require_session(db, "host", "default", x_session_id)

    event_status = await get_event_status(db)

    async with db.get_connection() as conn:
        cursor = await conn.execute(
            "SELECT id, status FROM distances WHERE id=?", (distance_id,)
        )
        dist_row = await cursor.fetchone()
        if not dist_row:
            raise HTTPException(status_code=404, detail="Distance not found")
        current_status = dist_row[1]

        if update.status:
            ns = update.status
            if ns == "active":
                if event_status == "created":
                    raise HTTPException(status_code=403, detail="Start the event first")
                if event_status == "finished":
                    raise HTTPException(status_code=403, detail="Event is finished")
                if current_status == "finished":
                    raise HTTPException(status_code=403, detail="Finished distance cannot be reactivated")
                await conn.execute(
                    "UPDATE distances SET status='finished' WHERE status='active' AND id!=?",
                    (distance_id,),
                )
                await conn.execute("UPDATE distances SET status='active' WHERE id=?", (distance_id,))
            elif ns == "pending":
                if current_status == "finished":
                    raise HTTPException(status_code=403, detail="Finished distance cannot go back to pending")
                await conn.execute("UPDATE distances SET status='pending' WHERE id=?", (distance_id,))
            elif ns == "finished":
                if current_status != "active":
                    raise HTTPException(status_code=403, detail="Only active distance can be finished")
                await conn.execute("UPDATE distances SET status='finished' WHERE id=?", (distance_id,))

        if update.title is not None:
            if current_status != "pending":
                raise HTTPException(status_code=403, detail="Can only edit title of pending distances")
            await conn.execute("UPDATE distances SET title=? WHERE id=?", (update.title, distance_id))

        if update.shots_count is not None:
            if current_status != "pending":
                raise HTTPException(status_code=403, detail="Can only edit shots of pending distances")
            await conn.execute("UPDATE distances SET shots_count=? WHERE id=?", (update.shots_count, distance_id))

        await conn.commit()
        cursor = await conn.execute(
            "SELECT id, title, shots_count, sort_order, status FROM distances WHERE id=?",
            (distance_id,),
        )
        row = await cursor.fetchone()

    return DistanceResponse(id=row[0], title=row[1], shots_count=row[2], sort_order=row[3], status=row[4])


@router.delete("/{code}/{distance_id}")
async def delete_distance(
    code: str,
    distance_id: int,
    x_session_id: Optional[str] = Header(None),
):
    db = DatabaseManager(code)
    if not db.exists():
        raise HTTPException(status_code=404, detail="Event not found")
    await require_session(db, "host", "default", x_session_id)

    async with db.get_connection() as conn:
        cursor = await conn.execute("SELECT status FROM distances WHERE id=?", (distance_id,))
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Distance not found")
        if row[0] in ("active", "finished"):
            raise HTTPException(status_code=403, detail="Cannot delete active or finished distance")
        cursor = await conn.execute("SELECT COUNT(*) FROM distances")
        if (await cursor.fetchone())[0] <= 1:
            raise HTTPException(status_code=403, detail="Cannot delete the last distance")
        await conn.execute("DELETE FROM distances WHERE id=?", (distance_id,))
        await conn.commit()

    return {"message": "Distance deleted"}
