import secrets
import string
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Header
from app.database import DatabaseManager
from app.models import EventCreate, EventUpdate, EventResponse
from app.routers.sessions import require_session
from typing import Optional

router = APIRouter(prefix="/api/events", tags=["events"])

# ── Property key constants ─────────────────────────────────────────────────
PROP_CODE         = "event_code"
PROP_STATUS       = "event_status"
PROP_SHOTS        = "event_shots_count"
PROP_CREATED_AT   = "event_created_at"
PROP_STARTED_AT   = "event_started_at"
PROP_FINISHED_AT  = "event_finished_at"


def _gen_password(length: int = 8) -> str:
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
    if db.exists():
        raise HTTPException(status_code=400, detail="Code already exists")

    await db.init_db()

    default_password = _gen_password()
    new_session_id   = _gen_session_id()

    async with db.get_connection() as conn:
        # Store all event fields as properties
        for key, val in [
            (PROP_CODE,        event.code),
            (PROP_STATUS,      "created"),
            (PROP_SHOTS,       str(event.shots_count)),
            (PROP_CREATED_AT,  _now()),
            ("host_password",  default_password),
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
            (new_session_id, default_password)
        )
        await conn.commit()

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
            await _set_prop(conn, PROP_STATUS, update.status)
            if update.status == "started":
                await _set_prop(conn, PROP_STARTED_AT, _now())
            elif update.status == "finished":
                await _set_prop(conn, PROP_FINISHED_AT, _now())
                # Finish any active distance
                await conn.execute(
                    "UPDATE distances SET status='finished' WHERE status='active'"
                )

        if update.shots_count:
            await _set_prop(conn, PROP_SHOTS, str(update.shots_count))

        await conn.commit()

    return {"message": "Event updated"}
