from fastapi import APIRouter, HTTPException, Header
from app.database import DatabaseManager
from app.models import ParticipantCreate, ParticipantResponse
from app.routers.sessions import require_session, _verify_session
from app.routers.events import get_event_status
from typing import List, Optional

router = APIRouter(prefix="/api/participants", tags=["participants"])

PROP_CLIENT_ALLOW_ADD = "client_allow_add_participant"


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
    """Add participant. Requires host session, OR valid client lane session
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

    # Non-host clients are blocked when self-registration is disabled
    if is_client and not is_host:
        async with db.get_connection() as conn:
            allow_add = await _get_allow_add(conn)
        if not allow_add:
            raise HTTPException(
                status_code=403,
                detail="Self-registration is disabled by the host"
            )

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
        participant_id = cursor.lastrowid

    return {"id": participant_id, "message": "Participant added"}


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
