import aiosqlite
import os
import re
from pathlib import Path
from contextlib import asynccontextmanager
from app.config import settings

# Strict allowlist: 1-16 uppercase alphanumeric characters only
_SAFE_CODE_RE = re.compile(r'^[A-Z0-9]{1,16}$')


def _validate_code(code: str) -> str:
    """Raise ValueError if code is not safe for use in a filesystem path."""
    if not _SAFE_CODE_RE.match(code):
        raise ValueError(f"Invalid event code: {code!r}")
    return code


class DatabaseManager:
    def __init__(self, code: str):
        _validate_code(code)          # hard stop — no path traversal possible
        Path(settings.DATABASE_DIR).mkdir(parents=True, exist_ok=True)
        # Use os.path.join so the path is always inside DATABASE_DIR
        base = os.path.realpath(settings.DATABASE_DIR)
        self.db_path = os.path.join(base, f"event_{code}.db")
        # Paranoia: ensure resolved path is still inside the databases dir
        if not self.db_path.startswith(base + os.sep) and self.db_path != base:
            raise ValueError("Resolved database path escapes DATABASE_DIR")
        self.code = code

    async def init_db(self):
        """Initialize a fresh database. No event table — all event fields live in properties."""
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("""
                CREATE TABLE IF NOT EXISTS properties (
                    key   TEXT PRIMARY KEY NOT NULL,
                    value TEXT
                )
            """)
            await db.execute("""
                CREATE TABLE IF NOT EXISTS distances (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    title       TEXT    NOT NULL,
                    shots_count INTEGER NOT NULL DEFAULT 30,
                    sort_order  INTEGER NOT NULL DEFAULT 0,
                    status      TEXT    NOT NULL DEFAULT 'pending'
                )
            """)
            await db.execute("""
                CREATE TABLE IF NOT EXISTS participants (
                    id              INTEGER PRIMARY KEY AUTOINCREMENT,
                    name            TEXT    NOT NULL,
                    lane_number     INTEGER NOT NULL,
                    shift           TEXT    NOT NULL,
                    gender          TEXT,
                    age_category    TEXT,
                    shooting_type   TEXT,
                    group_type      TEXT,
                    personal_number TEXT
                )
            """)
            await db.execute("""
                CREATE TABLE IF NOT EXISTS results (
                    id             INTEGER PRIMARY KEY AUTOINCREMENT,
                    participant_id INTEGER NOT NULL,
                    distance_id    INTEGER NOT NULL,
                    shot_number    INTEGER NOT NULL,
                    score          INTEGER NOT NULL,
                    is_x           BOOLEAN DEFAULT 0,
                    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(participant_id, distance_id, shot_number),
                    FOREIGN KEY (participant_id) REFERENCES participants(id),
                    FOREIGN KEY (distance_id)    REFERENCES distances(id)
                )
            """)
            await db.execute("""
                CREATE TABLE IF NOT EXISTS sessions (
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    role       TEXT NOT NULL,
                    identifier TEXT NOT NULL,
                    session_id TEXT NOT NULL UNIQUE,
                    password   TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(role, identifier)
                )
            """)
            await db.commit()

    def exists(self) -> bool:
        return os.path.exists(self.db_path)

    @asynccontextmanager
    async def get_connection(self):
        conn = await aiosqlite.connect(self.db_path)
        try:
            yield conn
        finally:
            await conn.close()
