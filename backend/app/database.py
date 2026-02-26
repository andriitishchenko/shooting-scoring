import aiosqlite
import os
from pathlib import Path
from contextlib import asynccontextmanager
from app.config import settings


class DatabaseManager:
    def __init__(self, code: str):
        Path(settings.DATABASE_DIR).mkdir(parents=True, exist_ok=True)
        self.db_path = f"{settings.DATABASE_DIR}/event_{code}.db"
        self.code = code

    async def init_db(self):
        """Initialize a fresh database. No event table — all event fields live in properties."""
        async with aiosqlite.connect(self.db_path) as db:
            # Key-value store: holds event fields + auth settings
            # Event keys: event_code, event_status, event_shots_count,
            #             event_created_at, event_started_at, event_finished_at
            # Auth keys:  host_password, viewer_password, client_allow_add_participant
            await db.execute("""
                CREATE TABLE IF NOT EXISTS properties (
                    key   TEXT PRIMARY KEY NOT NULL,
                    value TEXT
                )
            """)

            # Distances — no event_id FK, single event per DB
            await db.execute("""
                CREATE TABLE IF NOT EXISTS distances (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    title       TEXT    NOT NULL,
                    shots_count INTEGER NOT NULL DEFAULT 30,
                    sort_order  INTEGER NOT NULL DEFAULT 0,
                    status      TEXT    NOT NULL DEFAULT 'pending'
                )
            """)

            # Participants — no event_id FK
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

            # Sessions: role + identifier → session_id + password
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
