import csv
import io
from fastapi import APIRouter, HTTPException, Header
from app.database import DatabaseManager
from app.models import (
    ParticipantCreate, ParticipantResponse,
    ParticipantImportRequest, ParticipantImportResult,
)
from app.routers.sessions import require_session, _verify_session
from app.routers.events import get_event_status
from typing import List, Optional

router = APIRouter(prefix="/api/participants", tags=["participants"])

PROP_CLIENT_ALLOW_ADD = "client_allow_add_participant"
_MAX_BATCH = 500   # maximum participants per CSV import


async def _get_allow_add(conn) -> bool:
    cursor = await conn.execute(
        "SELECT value FROM properties WHERE key=?", (PROP_CLIENT_ALLOW_ADD,)
    )
    row = await cursor.fetchone()
    val = (row[0] if row else "true") or "true"
    return val.lower() not in ("false", "0")


@router.post("/{code}")
async def add_participant(
    code: str,
    participant: ParticipantCreate,
    x_session_id: Optional[str] = Header(None),
):
    """Add one participant. Requires host, OR valid client lane session
    when client_allow_add_participant is enabled."""
    db = DatabaseManager(code)
    if not db.exists():
        raise HTTPException(status_code=404, detail="Event not found")

    if not x_session_id:
        raise HTTPException(status_code=401, detail="Session required")

    is_host   = await _verify_session(db, "host",   "default",                   x_session_id)
    is_client = await _verify_session(db, "client", str(participant.lane_number), x_session_id)
    if not is_host and not is_client:
        raise HTTPException(status_code=401, detail="Valid session required to add participant")

    # Non-host clients blocked when self-registration is disabled
    if is_client and not is_host:
        async with db.get_connection() as conn:
            if not await _get_allow_add(conn):
                raise HTTPException(status_code=403, detail="Self-registration is disabled by the host")

    event_status = await get_event_status(db)
    if event_status == "finished":
        raise HTTPException(status_code=403, detail="Event has finished and cannot be modified.")

    async with db.get_connection() as conn:
        cursor = await conn.execute("""
            INSERT INTO participants
                (name, lane_number, shift, gender, age_category, shooting_type, group_type, personal_number)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            participant.name, participant.lane_number, participant.shift,
            participant.gender, participant.age_category, participant.shooting_type,
            participant.group_type, participant.personal_number,
        ))
        await conn.commit()

    return {"id": cursor.lastrowid, "message": "Participant added"}


@router.post("/{code}/import", response_model=ParticipantImportResult)
async def import_participants_csv(
    code: str,
    body: ParticipantImportRequest,
    x_session_id: Optional[str] = Header(None),
):
    """Bulk import participants from CSV content. Host session required.

    Expected CSV format (header row required):
      name,lane_number,shift[,gender,age_category,shooting_type,group_type,personal_number]

    Returns count of added/failed rows and per-row error messages.
    """
    db = DatabaseManager(code)
    if not db.exists():
        raise HTTPException(status_code=404, detail="Event not found")

    await require_session(db, "host", "default", x_session_id)

    event_status = await get_event_status(db)
    if event_status != "created":
        raise HTTPException(status_code=403, detail="Can only import participants before the competition starts")

    added = 0
    failed = 0
    errors: List[str] = []

    try:
        reader = csv.DictReader(io.StringIO(body.csv_content))
        # Normalize headers: strip whitespace and lower
        if reader.fieldnames is None:
            raise HTTPException(status_code=400, detail="CSV has no header row")
        reader.fieldnames = [f.strip().lower() for f in reader.fieldnames]
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid CSV: {e}")

    required = {'name', 'lane', 'shift'}
    if not required.issubset(set(reader.fieldnames)):
        raise HTTPException(
            status_code=400,
            detail=f"CSV must contain columns: name, lane, shift. Got: {reader.fieldnames}"
        )

    rows = list(reader)
    if len(rows) > _MAX_BATCH:
        raise HTTPException(status_code=400, detail=f"Too many rows (max {_MAX_BATCH})")

    async with db.get_connection() as conn:
        for i, row in enumerate(rows, start=2):   # row 1 is header
            try:
                raw_name  = (row.get('name') or '').strip()
                raw_lane  = (row.get('lane') or '').strip()
                raw_shift = (row.get('shift') or '').strip().upper()

                if not raw_name:
                    errors.append(f"Row {i}: name is required")
                    failed += 1
                    continue
                if len(raw_name) > 120:
                    errors.append(f"Row {i}: name too long")
                    failed += 1
                    continue
                if not raw_shift:
                    errors.append(f"Row {i}: shift is required")
                    failed += 1
                    continue
                try:
                    lane_number = int(raw_lane)
                    if not (1 <= lane_number <= 999):
                        raise ValueError
                except ValueError:
                    errors.append(f"Row {i}: lane_number must be 1-999, got {raw_lane!r}")
                    failed += 1
                    continue

                # Optional fields — silently truncate
                def _opt(key: str, max_len: int = 60) -> Optional[str]:
                    v = (row.get(key) or '').strip()[:max_len]
                    return v or None

                await conn.execute("""
                    INSERT INTO participants
                        (name, lane_number, shift, gender, age_category,
                         shooting_type, group_type, personal_number)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    raw_name[:120], lane_number, raw_shift[:4],
                    _opt('gender'), _opt('age_category'),
                    _opt('shooting_type'), _opt('group'),
                    _opt('personal_number', 32),
                ))
                added += 1

            except Exception as e:
                errors.append(f"Row {i}: {e}")
                failed += 1

        if added:
            await conn.commit()

    return ParticipantImportResult(added=added, failed=failed, errors=errors[:50])


@router.get("/{code}", response_model=List[ParticipantResponse])
async def get_participants(code: str, lane_number: Optional[int] = None):
    """Get participants. Public."""
    db = DatabaseManager(code)
    if not db.exists():
        raise HTTPException(status_code=404, detail="Event not found")

    query  = "SELECT id, name, lane_number, shift, gender, age_category, shooting_type, group_type, personal_number FROM participants"
    params: list = []
    if lane_number is not None:
        query += " WHERE lane_number=?"
        params.append(lane_number)
    query += " ORDER BY lane_number, shift"

    async with db.get_connection() as conn:
        cursor = await conn.execute(query, params)
        rows   = await cursor.fetchall()

    return [
        ParticipantResponse(
            id=p[0], name=p[1], lane_number=p[2], shift=p[3],
            gender=p[4], age_category=p[5], shooting_type=p[6],
            group_type=p[7], personal_number=p[8],
        )
        for p in rows
    ]


@router.delete("/{code}/{participant_id}")
async def delete_participant(
    code: str,
    participant_id: int,
    x_session_id: Optional[str] = Header(None),
):
    db = DatabaseManager(code)
    if not db.exists():
        raise HTTPException(status_code=404, detail="Event not found")
    await require_session(db, "host", "default", x_session_id)

    event_status = await get_event_status(db)
    if event_status == "finished":
        raise HTTPException(status_code=403, detail="Event has finished and cannot be modified.")

    async with db.get_connection() as conn:
        await conn.execute("DELETE FROM results WHERE participant_id=?",  (participant_id,))
        await conn.execute("DELETE FROM participants WHERE id=?", (participant_id,))
        await conn.commit()

    return {"message": "Participant deleted"}


@router.put("/{code}/{participant_id}")
async def update_participant(
    code: str,
    participant_id: int,
    participant: ParticipantCreate,
    x_session_id: Optional[str] = Header(None),
):
    db = DatabaseManager(code)
    if not db.exists():
        raise HTTPException(status_code=404, detail="Event not found")
    await require_session(db, "host", "default", x_session_id)

    async with db.get_connection() as conn:
        cursor = await conn.execute("SELECT id FROM participants WHERE id=?", (participant_id,))
        if not await cursor.fetchone():
            raise HTTPException(status_code=404, detail="Participant not found")
        await conn.execute("""
            UPDATE participants
            SET name=?, lane_number=?, shift=?, gender=?,
                age_category=?, shooting_type=?, group_type=?, personal_number=?
            WHERE id=?
        """, (
            participant.name, participant.lane_number, participant.shift, participant.gender,
            participant.age_category, participant.shooting_type, participant.group_type,
            participant.personal_number, participant_id,
        ))
        await conn.commit()

    return {"message": "Participant updated", "id": participant_id}
