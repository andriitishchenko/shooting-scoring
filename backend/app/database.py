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
        """Initialize database with all tables (fresh install only, no migration)."""
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("""
                CREATE TABLE IF NOT EXISTS event (
                    id INTEGER PRIMARY KEY,
                    code TEXT UNIQUE NOT NULL,
                    shots_count INTEGER DEFAULT 30,
                    status TEXT DEFAULT 'created',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    started_at TIMESTAMP,
                    finished_at TIMESTAMP
                )
            """)
            await db.execute("""
                CREATE TABLE IF NOT EXISTS distances (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_id INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    shots_count INTEGER NOT NULL DEFAULT 30,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'pending',
                    FOREIGN KEY (event_id) REFERENCES event(id)
                )
            """)
            await db.execute("""
                CREATE TABLE IF NOT EXISTS participants (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_id INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    lane_number INTEGER NOT NULL,
                    shift TEXT NOT NULL,
                    gender TEXT,
                    age_category TEXT,
                    shooting_type TEXT,
                    group_type TEXT,
                    personal_number TEXT,
                    FOREIGN KEY (event_id) REFERENCES event(id)
                )
            """)
            await db.execute("""
                CREATE TABLE IF NOT EXISTS results (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    participant_id INTEGER NOT NULL,
                    distance_id INTEGER NOT NULL,
                    shot_number INTEGER NOT NULL,
                    score INTEGER NOT NULL,
                    is_x BOOLEAN DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(participant_id, distance_id, shot_number),
                    FOREIGN KEY (participant_id) REFERENCES participants(id),
                    FOREIGN KEY (distance_id) REFERENCES distances(id)
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
