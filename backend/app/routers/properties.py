from pydantic import BaseModel, Field
from fastapi import APIRouter, HTTPException, Header
from app.database import DatabaseManager
from app.routers.sessions import require_session
from typing import Optional

router = APIRouter(prefix="/api/properties", tags=["properties"])

PROP_HOST_PASSWORD    = "host_password"
PROP_VIEWER_PASSWORD  = "viewer_password"
PROP_CLIENT_ALLOW_ADD = "client_allow_add_participant"
ALLOWED_KEYS = {PROP_HOST_PASSWORD, PROP_VIEWER_PASSWORD, PROP_CLIENT_ALLOW_ADD}

_MAX_PW = 64


class PropertiesUpdate(BaseModel):
    host_password:               Optional[str] = Field(default=None, max_length=_MAX_PW)
    viewer_password:             Optional[str] = Field(default=None, max_length=_MAX_PW)
    client_allow_add_participant: Optional[str] = Field(default=None, max_length=8)


@router.get("/{code}")
async def get_properties(code: str, x_session_id: Optional[str] = Header(None)):
    """Get auth/settings properties. Requires host session."""
    db = DatabaseManager(code)
    if not db.exists():
        raise HTTPException(status_code=404, detail="Event not found")
    await require_session(db, "host", "default", x_session_id)

    async with db.get_connection() as conn:
        cursor = await conn.execute("SELECT key, value FROM properties")
        rows = await cursor.fetchall()

    props = {r[0]: r[1] for r in rows}
    return {
        PROP_HOST_PASSWORD:    props.get(PROP_HOST_PASSWORD, ""),
        PROP_VIEWER_PASSWORD:  props.get(PROP_VIEWER_PASSWORD, ""),
        PROP_CLIENT_ALLOW_ADD: props.get(PROP_CLIENT_ALLOW_ADD, "true"),
    }


@router.patch("/{code}")
async def update_properties(
    code: str,
    data: PropertiesUpdate,
    x_session_id: Optional[str] = Header(None),
):
    """Update auth/settings properties. Requires host session."""
    db = DatabaseManager(code)
    if not db.exists():
        raise HTTPException(status_code=404, detail="Event not found")
    await require_session(db, "host", "default", x_session_id)

    updates = {
        PROP_HOST_PASSWORD:    data.host_password,
        PROP_VIEWER_PASSWORD:  data.viewer_password,
        PROP_CLIENT_ALLOW_ADD: data.client_allow_add_participant,
    }

    async with db.get_connection() as conn:
        for key, value in updates.items():
            if value is None:
                continue
            await conn.execute(
                "INSERT OR REPLACE INTO properties (key, value) VALUES (?, ?)",
                (key, str(value).strip()),
            )
        await conn.commit()

    return {"message": "Properties updated"}


@router.get("/{code}/public")
async def get_public_properties(code: str):
    """Public: client_allow_add_participant. No auth."""
    db = DatabaseManager(code)
    if not db.exists():
        raise HTTPException(status_code=404, detail="Event not found")

    async with db.get_connection() as conn:
        cursor = await conn.execute(
            "SELECT value FROM properties WHERE key=?", (PROP_CLIENT_ALLOW_ADD,)
        )
        row = await cursor.fetchone()

    allow_add = (row[0] if row else "true").lower() not in ("false", "0", "")
    return {"client_allow_add_participant": allow_add}
