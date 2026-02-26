import secrets
import string
from pydantic import BaseModel, Field
from fastapi import APIRouter, HTTPException, Header
from app.database import DatabaseManager
from typing import Optional

router = APIRouter(prefix="/api/sessions", tags=["sessions"])

_MAX_PW  = 64
_MAX_SID = 128


def _gen_password(length: int = 6) -> str:
    chars = string.ascii_uppercase + string.digits
    return ''.join(secrets.choice(chars) for _ in range(length))


def _gen_session_id() -> str:
    return secrets.token_hex(20)


# ── Input models (replaces raw dict) ──────────────────────────────────────

class LoginRequest(BaseModel):
    password:   str = Field(default='', max_length=_MAX_PW)
    session_id: Optional[str] = Field(default=None, max_length=_MAX_SID)


class LaneLoginRequest(BaseModel):
    password:   Optional[str] = Field(default=None, max_length=_MAX_PW)
    session_id: Optional[str] = Field(default=None, max_length=_MAX_SID)


# ── Helpers ────────────────────────────────────────────────────────────────

async def _verify_session(db: DatabaseManager, role: str, identifier: str, session_id: str) -> bool:
    """Constant-time-safe session check (compare full token)."""
    async with db.get_connection() as conn:
        cursor = await conn.execute(
            "SELECT session_id FROM sessions WHERE role=? AND identifier=?",
            (role, identifier),
        )
        row = await cursor.fetchone()
    if row is None:
        return False
    # Use secrets.compare_digest to prevent timing attacks
    return secrets.compare_digest(row[0], session_id)


async def require_session(db: DatabaseManager, role: str, identifier: str, session_id: Optional[str]):
    if not session_id:
        raise HTTPException(status_code=401, detail="Session ID required")
    if not await _verify_session(db, role, identifier, session_id):
        raise HTTPException(status_code=401, detail="Invalid or expired session")


# ── Host ───────────────────────────────────────────────────────────────────

@router.post("/{code}/host")
async def host_login(code: str, req: LoginRequest):
    db = DatabaseManager(code)
    if not db.exists():
        raise HTTPException(status_code=404, detail="Event not found")

    async with db.get_connection() as conn:
        cursor = await conn.execute("SELECT value FROM properties WHERE key='host_password'")
        row = await cursor.fetchone()
        stored_pw = (row[0] if row else "") or ""

        cursor = await conn.execute(
            "SELECT session_id FROM sessions WHERE role='host' AND identifier='default'"
        )
        sess_row = await cursor.fetchone()

        # Auto-login with saved session_id (timing-safe)
        if sess_row and req.session_id:
            if secrets.compare_digest(sess_row[0], req.session_id):
                return {"ok": True, "session_id": sess_row[0]}

        # Password verification (timing-safe, constant-time even when stored_pw is empty)
        if stored_pw:
            if not secrets.compare_digest(stored_pw, req.password):
                raise HTTPException(status_code=401, detail="Invalid admin password")

        new_sid = _gen_session_id()
        if sess_row:
            await conn.execute(
                "UPDATE sessions SET session_id=? WHERE role='host' AND identifier='default'",
                (new_sid,),
            )
        else:
            await conn.execute(
                "INSERT INTO sessions (role, identifier, session_id, password) VALUES ('host','default',?,?)",
                (new_sid, stored_pw or ""),
            )
        await conn.commit()

    return {"ok": True, "session_id": new_sid}


# ── Viewer ─────────────────────────────────────────────────────────────────

@router.post("/{code}/viewer")
async def viewer_login(code: str, req: LoginRequest):
    db = DatabaseManager(code)
    if not db.exists():
        raise HTTPException(status_code=404, detail="Event not found")

    async with db.get_connection() as conn:
        cursor = await conn.execute("SELECT value FROM properties WHERE key='viewer_password'")
        row = await cursor.fetchone()
        stored_pw = (row[0] if row else "") or ""

        cursor = await conn.execute(
            "SELECT session_id FROM sessions WHERE role='viewer' AND identifier='default'"
        )
        sess_row = await cursor.fetchone()

        if sess_row and req.session_id:
            if secrets.compare_digest(sess_row[0], req.session_id):
                return {"ok": True, "session_id": sess_row[0]}

        if stored_pw:
            if not secrets.compare_digest(stored_pw, req.password):
                raise HTTPException(status_code=401, detail="Invalid viewer password")

        new_sid = _gen_session_id()
        if sess_row:
            await conn.execute(
                "UPDATE sessions SET session_id=? WHERE role='viewer' AND identifier='default'",
                (new_sid,),
            )
        else:
            await conn.execute(
                "INSERT INTO sessions (role, identifier, session_id, password) VALUES ('viewer','default',?,?)",
                (new_sid, stored_pw or ""),
            )
        await conn.commit()

    return {"ok": True, "has_password": bool(stored_pw), "session_id": new_sid}


# ── Client lane ────────────────────────────────────────────────────────────

@router.post("/{code}/lane/{lane_number}")
async def get_or_create_lane_session(code: str, lane_number: int, req: LaneLoginRequest = None):
    if req is None:
        req = LaneLoginRequest()

    db = DatabaseManager(code)
    if not db.exists():
        raise HTTPException(status_code=404, detail="Event not found")

    identifier = str(lane_number)

    async with db.get_connection() as conn:
        cursor = await conn.execute(
            "SELECT session_id, password FROM sessions WHERE role='client' AND identifier=?",
            (identifier,),
        )
        row = await cursor.fetchone()

        if row is None:
            new_pw  = _gen_password()
            new_sid = _gen_session_id()
            await conn.execute(
                "INSERT INTO sessions (role, identifier, session_id, password) VALUES ('client',?,?,?)",
                (identifier, new_sid, new_pw),
            )
            await conn.commit()
            return {"status": "created", "session_id": new_sid, "password": new_pw, "lane_number": lane_number}

        stored_sid, stored_pw = row

        if req.session_id and secrets.compare_digest(stored_sid, req.session_id):
            return {"status": "ok", "session_id": stored_sid, "lane_number": lane_number}

        if not req.password:
            return {"status": "password_required", "lane_number": lane_number}

        if not secrets.compare_digest(stored_pw, req.password.upper()):
            raise HTTPException(status_code=401, detail="Invalid lane password")

        return {"status": "ok", "session_id": stored_sid, "lane_number": lane_number}


# ── Host: list lane sessions ───────────────────────────────────────────────

@router.get("/{code}/lanes")
async def list_lane_sessions(code: str, x_session_id: Optional[str] = Header(None)):
    """Return lane numbers with active sessions. Requires host session."""
    db = DatabaseManager(code)
    if not db.exists():
        raise HTTPException(status_code=404, detail="Event not found")
    await require_session(db, "host", "default", x_session_id)

    async with db.get_connection() as conn:
        cursor = await conn.execute(
            "SELECT identifier FROM sessions WHERE role='client' ORDER BY CAST(identifier AS INTEGER)"
        )
        rows = await cursor.fetchall()

    return {"lanes": [int(r[0]) for r in rows]}


# ── Host: reset lane session ───────────────────────────────────────────────

@router.delete("/{code}/lane/{lane_number}")
async def reset_lane_session(
    code: str,
    lane_number: int,
    x_session_id: Optional[str] = Header(None),
):
    db = DatabaseManager(code)
    if not db.exists():
        raise HTTPException(status_code=404, detail="Event not found")
    await require_session(db, "host", "default", x_session_id)

    async with db.get_connection() as conn:
        await conn.execute(
            "DELETE FROM sessions WHERE role='client' AND identifier=?", (str(lane_number),)
        )
        await conn.commit()

    return {"message": f"Session for lane {lane_number} reset"}
