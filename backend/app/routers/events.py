import asyncio
import os
import secrets
import string
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Header
from app.database import DatabaseManager
from app.models import EventCreate, EventUpdate, EventResponse
from app.routers.sessions import require_session
from app.websocket_manager import manager
from app.security import hash_password, hash_session_id
from typing import Optional

router = APIRouter(prefix="/api/events", tags=["events"])

# ── Property key constants ─────────────────────────────────────────────────
PROP_CODE         = "event_code"
PROP_STATUS       = "event_status"
PROP_SHOTS        = "event_shots_count"
PROP_CREATED_AT   = "event_created_at"
PROP_STARTED_AT   = "event_started_at"
PROP_FINISHED_AT  = "event_finished_at"


def _gen_password(length: int = 16) -> str:
    chars = string.ascii_uppercase + string.digits
    return ''.join(secrets.choice(chars) for _ in range(length))


def _gen_session_id() -> str:
    return secrets.token_hex(20)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _get_props(conn) -> dict:
    """Read all properties into a dict."""
    cursor = await conn.execute("SELECT key, value FROM properties")
    rows = await cursor.fetchall()
    return {r[0]: r[1] for r in rows}


async def _set_prop(conn, key: str, value: str):
    await conn.execute(
        "INSERT OR REPLACE INTO properties (key, value) VALUES (?, ?)",
        (key, value or "")
    )


# ── Helpers used by other routers ──────────────────────────────────────────

async def get_event_status(db: DatabaseManager) -> str:
    """Return current event status ('created'|'started'|'finished')."""
    async with db.get_connection() as conn:
        props = await _get_props(conn)
    return props.get(PROP_STATUS, "created")


# ── Endpoints ──────────────────────────────────────────────────────────────

@router.post("/create")
async def create_event(event: EventCreate):
    """
    Create a new event DB.
    Returns host_password + session_id — save them, they won't be shown again.
    """
    db = DatabaseManager(event.code)
    try:
        # Claim the code atomically so two simultaneous create requests cannot
        # both initialize the same event and return conflicting credentials.
        fd = os.open(db.db_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        raise HTTPException(status_code=400, detail="Code already exists")
    os.close(fd)

    try:
        await db.init_db()
        default_password = _gen_password()
        new_session_id   = _gen_session_id()
        password_hash = await asyncio.to_thread(hash_password, default_password)

        async with db.get_connection() as conn:
            # Store all event fields as properties
            for key, val in [
                (PROP_CODE,        event.code),
                (PROP_STATUS,      "created"),
                (PROP_SHOTS,       str(event.shots_count)),
                (PROP_CREATED_AT,  _now()),
                ("host_password",  password_hash),
                ("client_allow_add_participant", "true"),
            ]:
                await _set_prop(conn, key, val)

            # Default first distance
            await conn.execute(
                "INSERT INTO distances (title, shots_count, sort_order, status) VALUES (?, ?, ?, 'pending')",
                ("Distance 1", event.shots_count, 0)
            )
            # Host session
            await conn.execute(
                "INSERT INTO sessions (role, identifier, session_id, password) VALUES ('host','default',?,?)",
                (hash_session_id(new_session_id), password_hash)
            )
            await conn.commit()
    except BaseException:
        try:
            os.unlink(db.db_path)
        except OSError:
            pass
        raise

    return {
        "message":       "Event created",
        "code":          event.code,
        "host_password": default_password,
        "session_id":    new_session_id,
    }


@router.get("/{code}", response_model=EventResponse)
async def get_event(code: str):
    """Get event info. Public — no auth required."""
    db = DatabaseManager(code)
    if not db.exists():
        raise HTTPException(status_code=404, detail="Event not found")

    async with db.get_connection() as conn:
        props = await _get_props(conn)

    stored_code = props.get(PROP_CODE)
    if not stored_code:
        raise HTTPException(status_code=404, detail="Event not found")

    return EventResponse(
        code        = props.get(PROP_CODE, code),
        shots_count = int(props.get(PROP_SHOTS, 30)),
        status      = props.get(PROP_STATUS, "created"),
        created_at  = props.get(PROP_CREATED_AT),
        started_at  = props.get(PROP_STARTED_AT),
        finished_at = props.get(PROP_FINISHED_AT),
    )


@router.patch("/{code}")
async def update_event(
    code: str,
    update: EventUpdate,
    x_session_id: Optional[str] = Header(None),
):
    """Update event status / shots_count. Requires valid host session."""
    db = DatabaseManager(code)
    if not db.exists():
        raise HTTPException(status_code=404, detail="Event not found")

    await require_session(db, "host", "default", x_session_id)

    async with db.get_connection() as conn:
        if update.status:
            cursor = await conn.execute(
                "SELECT value FROM properties WHERE key=?", (PROP_STATUS,)
            )
            row = await cursor.fetchone()
            current_status = row[0] if row else "created"
            allowed_transition = (
                (current_status == "created" and update.status == "started")
                or (current_status == "started" and update.status == "finished")
            )
            if update.status != current_status and not allowed_transition:
                raise HTTPException(
                    status_code=403,
                    detail=f"Cannot change event status from {current_status} to {update.status}",
                )

            if update.status != current_status:
                await _set_prop(conn, PROP_STATUS, update.status)
            if update.status == "started" and current_status == "created":
                await _set_prop(conn, PROP_STARTED_AT, _now())
            elif update.status == "finished" and current_status == "started":
                await _set_prop(conn, PROP_FINISHED_AT, _now())
                # Finish any active distance
                await conn.execute(
                    "UPDATE distances SET status='finished' WHERE status='active'"
                )

        if update.shots_count is not None:
            await _set_prop(conn, PROP_SHOTS, str(update.shots_count))

        await conn.commit()

    if update.status:
        await manager.broadcast(code, {"type": "event_status", "status": update.status})
    if update.shots_count is not None:
        await manager.broadcast(code, {"type": "refresh"})
    return {"message": "Event updated"}
