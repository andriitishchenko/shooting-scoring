from fastapi import APIRouter, HTTPException
from app.database import DatabaseManager
from app.models import DistanceCreate, DistanceUpdate, DistanceResponse
from typing import List

router = APIRouter(prefix="/api/distances", tags=["distances"])


async def _get_event_id(conn, code: str) -> int:
    cursor = await conn.execute("SELECT id, status FROM event WHERE code=?", (code,))
    row = await cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Event not found")
    return row[0], row[1]


@router.get("/{code}", response_model=List[DistanceResponse])
async def list_distances(code: str):
    db = DatabaseManager(code)
    if not db.exists():
        raise HTTPException(status_code=404, detail="Event not found")

    async with db.get_connection() as conn:
        event_id, _ = await _get_event_id(conn, code)
        cursor = await conn.execute(
            "SELECT id, event_id, title, shots_count, sort_order, status FROM distances WHERE event_id=? ORDER BY sort_order",
            (event_id,)
        )
        rows = await cursor.fetchall()

    return [DistanceResponse(id=r[0], event_id=r[1], title=r[2], shots_count=r[3], sort_order=r[4], status=r[5]) for r in rows]


@router.post("/{code}", response_model=DistanceResponse)
async def add_distance(code: str, dist: DistanceCreate):
    db = DatabaseManager(code)
    if not db.exists():
        raise HTTPException(status_code=404, detail="Event not found")

    async with db.get_connection() as conn:
        event_id, event_status = await _get_event_id(conn, code)
        if event_status == 'finished':
            raise HTTPException(status_code=403, detail="Event is finished")

        cursor = await conn.execute(
            "SELECT COALESCE(MAX(sort_order), -1) FROM distances WHERE event_id=?", (event_id,)
        )
        max_order = (await cursor.fetchone())[0]

        cursor = await conn.execute(
            "INSERT INTO distances (event_id, title, shots_count, sort_order, status) VALUES (?, ?, ?, ?, 'pending')",
            (event_id, dist.title, dist.shots_count, max_order + 1)
        )
        await conn.commit()
        dist_id = cursor.lastrowid

        cursor = await conn.execute(
            "SELECT id, event_id, title, shots_count, sort_order, status FROM distances WHERE id=?", (dist_id,)
        )
        row = await cursor.fetchone()

    return DistanceResponse(id=row[0], event_id=row[1], title=row[2], shots_count=row[3], sort_order=row[4], status=row[5])


@router.patch("/{code}/{distance_id}", response_model=DistanceResponse)
async def update_distance(code: str, distance_id: int, update: DistanceUpdate):
    db = DatabaseManager(code)
    if not db.exists():
        raise HTTPException(status_code=404, detail="Event not found")

    async with db.get_connection() as conn:
        event_id, event_status = await _get_event_id(conn, code)

        cursor = await conn.execute(
            "SELECT id, status FROM distances WHERE id=? AND event_id=?", (distance_id, event_id)
        )
        dist_row = await cursor.fetchone()
        if not dist_row:
            raise HTTPException(status_code=404, detail="Distance not found")

        current_status = dist_row[1]

        # Status transition logic
        if update.status:
            new_status = update.status

            if new_status == 'active':
                if event_status == 'created':
                    raise HTTPException(status_code=403, detail="Start the event first")
                if event_status == 'finished':
                    raise HTTPException(status_code=403, detail="Event is finished")
                if current_status == 'finished':
                    raise HTTPException(status_code=403, detail="Finished distance cannot be reactivated")
                # Finish any currently active distance before activating new one
                await conn.execute(
                    "UPDATE distances SET status='finished' WHERE event_id=? AND status='active' AND id!=?",
                    (event_id, distance_id)
                )
                await conn.execute("UPDATE distances SET status='active' WHERE id=?", (distance_id,))

            elif new_status == 'pending':
                if current_status == 'finished':
                    raise HTTPException(status_code=403, detail="Finished distance cannot go back to pending")
                await conn.execute("UPDATE distances SET status='pending' WHERE id=?", (distance_id,))

            elif new_status == 'finished':
                if current_status != 'active':
                    raise HTTPException(status_code=403, detail="Only active distance can be finished")
                await conn.execute("UPDATE distances SET status='finished' WHERE id=?", (distance_id,))

        if update.title:
            if current_status != 'pending':
                raise HTTPException(status_code=403, detail="Can only edit title of pending distances")
            await conn.execute("UPDATE distances SET title=? WHERE id=?", (update.title, distance_id))

        if update.shots_count:
            if current_status != 'pending':
                raise HTTPException(status_code=403, detail="Can only edit shots of pending distances")
            await conn.execute("UPDATE distances SET shots_count=? WHERE id=?", (update.shots_count, distance_id))

        await conn.commit()

        cursor = await conn.execute(
            "SELECT id, event_id, title, shots_count, sort_order, status FROM distances WHERE id=?", (distance_id,)
        )
        row = await cursor.fetchone()

    return DistanceResponse(id=row[0], event_id=row[1], title=row[2], shots_count=row[3], sort_order=row[4], status=row[5])


@router.delete("/{code}/{distance_id}")
async def delete_distance(code: str, distance_id: int):
    db = DatabaseManager(code)
    if not db.exists():
        raise HTTPException(status_code=404, detail="Event not found")

    async with db.get_connection() as conn:
        event_id, event_status = await _get_event_id(conn, code)

        cursor = await conn.execute(
            "SELECT status FROM distances WHERE id=? AND event_id=?", (distance_id, event_id)
        )
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Distance not found")

        if row[0] in ('active', 'finished'):
            raise HTTPException(status_code=403, detail="Cannot delete active or finished distance")

        # Check at least one distance remains
        cursor = await conn.execute("SELECT COUNT(*) FROM distances WHERE event_id=?", (event_id,))
        count = (await cursor.fetchone())[0]
        if count <= 1:
            raise HTTPException(status_code=403, detail="Cannot delete the last distance")

        await conn.execute("DELETE FROM distances WHERE id=?", (distance_id,))
        await conn.commit()

    return {"message": "Distance deleted"}
