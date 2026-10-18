import asyncio
import secrets
import string
import time
from math import ceil
from pydantic import BaseModel, Field
from fastapi import APIRouter, HTTPException, Header, Path, Request
from app.database import DatabaseManager
from typing import Optional
from app.websocket_manager import manager
from app.security import (
    hash_password, hash_session_id, is_password_hash,
    verify_password, verify_session_id,
)

router = APIRouter(prefix="/api/sessions", tags=["sessions"])

_MAX_PW  = 64
_MAX_SID = 128
_LOGIN_WINDOW_SECONDS = 15 * 60
_LOGIN_LOCK_SECONDS = 15 * 60
_LOGIN_MAX_FAILURES = 10


def _gen_password(length: int = 12) -> str:
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
    """Verify a token and transparently hash legacy plaintext tokens at rest."""
    async with db.get_connection() as conn:
        cursor = await conn.execute(
            "SELECT session_id FROM sessions WHERE role=? AND identifier=?",
            (role, identifier),
        )
        row = await cursor.fetchone()
        if row is None:
            return False
        valid, needs_upgrade = verify_session_id(session_id, row[0])
        if valid and needs_upgrade:
            await conn.execute(
                "UPDATE sessions SET session_id=? WHERE role=? AND identifier=?",
                (hash_session_id(session_id), role, identifier),
            )
            await conn.commit()
        return valid


async def require_session(db: DatabaseManager, role: str, identifier: str, session_id: Optional[str]):
    if not session_id:
        raise HTTPException(status_code=401, detail="Session ID required")
    if not await _verify_session(db, role, identifier, session_id):
        raise HTTPException(status_code=401, detail="Invalid or expired session")


def _client_address(request: Request) -> str:
    # Use the ASGI peer address. Uvicorn only applies forwarded headers from
    # configured trusted proxies; never trust X-Forwarded-For in this app.
    return (request.client.host if request.client else "unknown")[:64]


async def _check_login_throttle(db: DatabaseManager, role: str, identifier: str, address: str):
    now = time.time()
    async with db.get_connection() as conn:
        await conn.execute(
            "DELETE FROM login_attempts WHERE window_started < ? AND locked_until <= ?",
            (now - 4 * _LOGIN_WINDOW_SECONDS, now),
        )
        cursor = await conn.execute(
            """SELECT locked_until FROM login_attempts
               WHERE role=? AND identifier=? AND client_address=?""",
            (role, identifier, address),
        )
        row = await cursor.fetchone()
        await conn.commit()

    if row and row[0] > now:
        retry_after = max(1, ceil(row[0] - now))
        raise HTTPException(
            status_code=429,
            detail="Too many failed login attempts. Try again later.",
            headers={"Retry-After": str(retry_after)},
        )


async def _record_login_failure(db: DatabaseManager, role: str, identifier: str, address: str):
    now = time.time()
    async with db.get_connection() as conn:
        await conn.execute("BEGIN IMMEDIATE")
        cursor = await conn.execute(
            """SELECT failure_count, window_started, locked_until FROM login_attempts
               WHERE role=? AND identifier=? AND client_address=?""",
            (role, identifier, address),
        )
        row = await cursor.fetchone()
        if row is None or now - row[1] >= _LOGIN_WINDOW_SECONDS:
            failure_count, window_started, locked_until = 1, now, 0
        else:
            failure_count, window_started, locked_until = row[0] + 1, row[1], row[2]
        if failure_count >= _LOGIN_MAX_FAILURES:
            locked_until = now + _LOGIN_LOCK_SECONDS

        await conn.execute(
            """INSERT OR REPLACE INTO login_attempts
               (role, identifier, client_address, failure_count, window_started, locked_until)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (role, identifier, address, failure_count, window_started, locked_until),
        )
        await conn.commit()


async def _clear_login_failures(db: DatabaseManager, role: str, identifier: str, address: str):
    async with db.get_connection() as conn:
        await conn.execute(
            "DELETE FROM login_attempts WHERE role=? AND identifier=? AND client_address=?",
            (role, identifier, address),
        )
        await conn.commit()


async def _upgrade_stored_password(
    conn, role: str, password: str, identifier: str = "default"
) -> Optional[str]:
    """Upgrade a legacy plaintext password and its compatibility copy."""
    if not password or is_password_hash(password):
        return None
    password_hash = await asyncio.to_thread(hash_password, password)
    property_key = {"host": "host_password", "viewer": "viewer_password"}.get(role)
    if property_key:
        await conn.execute(
            "UPDATE properties SET value=? WHERE key=?", (password_hash, property_key)
        )
    await conn.execute(
        "UPDATE sessions SET password=? WHERE role=? AND identifier=?",
        (password_hash, role, identifier),
    )
    return password_hash


# ── Host ───────────────────────────────────────────────────────────────────

@router.post("/{code}/host")
async def host_login(code: str, req: LoginRequest, request: Request):
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

        # Auto-login with the saved token. Migrate legacy plaintext tokens.
        if sess_row and req.session_id:
            valid, sid_needs_upgrade = verify_session_id(req.session_id, sess_row[0])
            if valid:
                if sid_needs_upgrade:
                    await conn.execute(
                        "UPDATE sessions SET session_id=? WHERE role='host' AND identifier='default'",
                        (hash_session_id(req.session_id),),
                    )
                await _upgrade_stored_password(conn, "host", stored_pw)
                await conn.commit()
                return {"ok": True, "session_id": req.session_id}

    address = _client_address(request)
    await _check_login_throttle(db, "host", "default", address)
    password_matches, needs_rehash = await asyncio.to_thread(
        verify_password, req.password, stored_pw
    )
    if not password_matches:
        await _record_login_failure(db, "host", "default", address)
        raise HTTPException(status_code=401, detail="Invalid admin password")
    await _clear_login_failures(db, "host", "default", address)

    async with db.get_connection() as conn:
        if needs_rehash:
            hashed_password = await asyncio.to_thread(hash_password, req.password)
            stored_pw = hashed_password
            await conn.execute(
                "UPDATE properties SET value=? WHERE key='host_password'", (hashed_password,)
            )
            await conn.execute(
                "UPDATE sessions SET password=? WHERE role='host' AND identifier='default'",
                (hashed_password,),
            )
        new_sid = _gen_session_id()
        if sess_row:
            await conn.execute(
                "UPDATE sessions SET session_id=? WHERE role='host' AND identifier='default'",
                (hash_session_id(new_sid),),
            )
        else:
            await conn.execute(
                "INSERT INTO sessions (role, identifier, session_id, password) VALUES ('host','default',?,?)",
                (hash_session_id(new_sid), stored_pw or ""),
            )
        await conn.commit()

    return {"ok": True, "session_id": new_sid}


# ── Viewer ─────────────────────────────────────────────────────────────────

@router.post("/{code}/viewer")
async def viewer_login(code: str, req: LoginRequest, request: Request):
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
            valid, sid_needs_upgrade = verify_session_id(req.session_id, sess_row[0])
            if valid:
                if sid_needs_upgrade:
                    await conn.execute(
                        "UPDATE sessions SET session_id=? WHERE role='viewer' AND identifier='default'",
                        (hash_session_id(req.session_id),),
                    )
                await _upgrade_stored_password(conn, "viewer", stored_pw)
                await conn.commit()
                return {"ok": True, "has_password": bool(stored_pw), "session_id": req.session_id}

    address = _client_address(request)
    needs_rehash = False
    if stored_pw:
        await _check_login_throttle(db, "viewer", "default", address)
        password_matches, needs_rehash = await asyncio.to_thread(
            verify_password, req.password, stored_pw
        )
        if not password_matches:
            await _record_login_failure(db, "viewer", "default", address)
            raise HTTPException(status_code=401, detail="Invalid viewer password")
        await _clear_login_failures(db, "viewer", "default", address)

    async with db.get_connection() as conn:
        if needs_rehash:
            hashed_password = await asyncio.to_thread(hash_password, req.password)
            stored_pw = hashed_password
            await conn.execute(
                "UPDATE properties SET value=? WHERE key='viewer_password'", (hashed_password,)
            )
            await conn.execute(
                "UPDATE sessions SET password=? WHERE role='viewer' AND identifier='default'",
                (hashed_password,),
            )
        new_sid = _gen_session_id()
        if sess_row:
            await conn.execute(
                "UPDATE sessions SET session_id=? WHERE role='viewer' AND identifier='default'",
                (hash_session_id(new_sid),),
            )
        else:
            await conn.execute(
                "INSERT INTO sessions (role, identifier, session_id, password) VALUES ('viewer','default',?,?)",
                (hash_session_id(new_sid), stored_pw or ""),
            )
        await conn.commit()

    return {"ok": True, "has_password": bool(stored_pw), "session_id": new_sid}


# ── Client lane ────────────────────────────────────────────────────────────

@router.post("/{code}/lane/{lane_number}")
async def get_or_create_lane_session(
    code: str,
    request: Request,
    lane_number: int = Path(ge=1, le=999),
    req: LaneLoginRequest = None,
):
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
            new_pw  = _gen_password(12)
            new_sid = _gen_session_id()
            password_hash = await asyncio.to_thread(hash_password, new_pw)
            await conn.execute(
                "INSERT INTO sessions (role, identifier, session_id, password) VALUES ('client',?,?,?)",
                (identifier, hash_session_id(new_sid), password_hash),
            )
            await conn.commit()
            return {"status": "created", "session_id": new_sid, "password": new_pw, "lane_number": lane_number}

        stored_sid, stored_pw = row

        if req.session_id:
            valid, sid_needs_upgrade = verify_session_id(req.session_id, stored_sid)
            if valid:
                if sid_needs_upgrade:
                    await conn.execute(
                        "UPDATE sessions SET session_id=? WHERE role='client' AND identifier=?",
                        (hash_session_id(req.session_id), identifier),
                    )
                await _upgrade_stored_password(conn, "client", stored_pw, identifier)
                await conn.commit()
                return {"status": "ok", "session_id": req.session_id, "lane_number": lane_number}

        if not req.password:
            return {"status": "password_required", "lane_number": lane_number}

        address = _client_address(request)
        await _check_login_throttle(db, "client", identifier, address)
        password_matches, needs_rehash = await asyncio.to_thread(
            verify_password, req.password.upper(), stored_pw
        )
        if not password_matches:
            await _record_login_failure(db, "client", identifier, address)
            raise HTTPException(status_code=401, detail="Invalid lane password")

        await _clear_login_failures(db, "client", identifier, address)
        password_hash = (
            await asyncio.to_thread(hash_password, req.password.upper())
            if needs_rehash else stored_pw
        )
        new_sid = _gen_session_id()
        await conn.execute(
            "UPDATE sessions SET session_id=?, password=? WHERE role='client' AND identifier=?",
            (hash_session_id(new_sid), password_hash, identifier),
        )
        await conn.commit()

    return {"status": "ok", "session_id": new_sid, "lane_number": lane_number}


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
    lane_number: int = Path(ge=1, le=999),
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

    await manager.broadcast(code, {"type": "lane_session_reset", "lane_number": lane_number})
    return {"message": f"Session for lane {lane_number} reset"}
