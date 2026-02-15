"""
Backend Tests for Shooting Scoring System

Run with: pytest tests/test_backend.py
Or: python -m pytest tests/test_backend.py -v
"""

import pytest
import asyncio
import sys
import os
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.database import DatabaseManager
from app.models import (
    EventCreate, EventUpdate, ParticipantCreate, 
    ResultCreate, EventResponse, ParticipantResponse
)
from app.config import settings


class TestDatabaseManager:
    """Test DatabaseManager functionality"""
    
    @pytest.fixture
    async def db_manager(self):
        """Create a test database manager"""
        test_code = "TEST"
        db_manager = DatabaseManager(test_code)
        
        # Clean up if exists
        if db_manager.exists():
            os.remove(db_manager.db_path)
        
        await db_manager.init_db()
        yield db_manager
        
        # Cleanup
        if db_manager.exists():
            os.remove(db_manager.db_path)
    
    @pytest.mark.asyncio
    async def test_database_creation(self, db_manager):
        """Test that database is created successfully"""
        assert db_manager.exists()
        assert os.path.exists(db_manager.db_path)
    
    @pytest.mark.asyncio
    async def test_database_tables(self, db_manager):
        """Test that all tables are created"""
        async with db_manager.get_connection() as db:
            cursor = await db.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
            tables = await cursor.fetchall()
            table_names = [t[0] for t in tables]
            
            assert 'event' in table_names
            assert 'participants' in table_names
            assert 'results' in table_names


class TestEventOperations:
    """Test event-related operations"""
    
    @pytest.fixture
    async def setup_db(self):
        """Setup test database"""
        test_code = "EVNT"
        db_manager = DatabaseManager(test_code)
        
        if db_manager.exists():
            os.remove(db_manager.db_path)
        
        await db_manager.init_db()
        yield db_manager, test_code
        
        if db_manager.exists():
            os.remove(db_manager.db_path)
    
    @pytest.mark.asyncio
    async def test_create_event(self, setup_db):
        """Test creating an event"""
        db_manager, test_code = setup_db
        
        async with db_manager.get_connection() as db:
            await db.execute(
                "INSERT INTO event (code, shots_count) VALUES (?, ?)",
                (test_code, 30)
            )
            await db.commit()
            
            cursor = await db.execute(
                "SELECT code, shots_count, status FROM event WHERE code = ?",
                (test_code,)
            )
            event = await cursor.fetchone()
            
            assert event[0] == test_code
            assert event[1] == 30
            assert event[2] == 'created'
    
    @pytest.mark.asyncio
    async def test_update_event_status(self, setup_db):
        """Test updating event status"""
        db_manager, test_code = setup_db
        
        async with db_manager.get_connection() as db:
            # Insert event
            await db.execute(
                "INSERT INTO event (code, shots_count) VALUES (?, ?)",
                (test_code, 30)
            )
            await db.commit()
            
            # Update status
            await db.execute(
                "UPDATE event SET status = ?, started_at = CURRENT_TIMESTAMP WHERE code = ?",
                ('started', test_code)
            )
            await db.commit()
            
            # Check update
            cursor = await db.execute(
                "SELECT status, started_at FROM event WHERE code = ?",
                (test_code,)
            )
            event = await cursor.fetchone()
            
            assert event[0] == 'started'
            assert event[1] is not None


class TestParticipantOperations:
    """Test participant-related operations"""
    
    @pytest.fixture
    async def setup_with_event(self):
        """Setup database with event"""
        test_code = "PART"
        db_manager = DatabaseManager(test_code)
        
        if db_manager.exists():
            os.remove(db_manager.db_path)
        
        await db_manager.init_db()
        
        # Create event
        async with db_manager.get_connection() as db:
            await db.execute(
                "INSERT INTO event (code, shots_count) VALUES (?, ?)",
                (test_code, 30)
            )
            await db.commit()
            
            cursor = await db.execute("SELECT id FROM event WHERE code = ?", (test_code,))
            event_id = (await cursor.fetchone())[0]
        
        yield db_manager, test_code, event_id
        
        if db_manager.exists():
            os.remove(db_manager.db_path)
    
    @pytest.mark.asyncio
    async def test_add_participant(self, setup_with_event):
        """Test adding a participant"""
        db_manager, test_code, event_id = setup_with_event
        
        async with db_manager.get_connection() as db:
            await db.execute("""
                INSERT INTO participants 
                (event_id, name, lane_number, shift, gender, shooting_type)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (event_id, "John Doe", 3, "A", "male", "compound"))
            await db.commit()
            
            cursor = await db.execute(
                "SELECT name, lane_number, shift FROM participants WHERE event_id = ?",
                (event_id,)
            )
            participant = await cursor.fetchone()
            
            assert participant[0] == "John Doe"
            assert participant[1] == 3
            assert participant[2] == "A"
    
    @pytest.mark.asyncio
    async def test_get_participants_by_lane(self, setup_with_event):
        """Test filtering participants by lane"""
        db_manager, test_code, event_id = setup_with_event
        
        async with db_manager.get_connection() as db:
            # Add multiple participants
            await db.execute("""
                INSERT INTO participants (event_id, name, lane_number, shift)
                VALUES (?, ?, ?, ?)
            """, (event_id, "John Doe", 3, "A"))
            
            await db.execute("""
                INSERT INTO participants (event_id, name, lane_number, shift)
                VALUES (?, ?, ?, ?)
            """, (event_id, "Jane Smith", 5, "B"))
            
            await db.commit()
            
            # Get lane 3 participants
            cursor = await db.execute("""
                SELECT name FROM participants 
                WHERE event_id = ? AND lane_number = ?
            """, (event_id, 3))
            participants = await cursor.fetchall()
            
            assert len(participants) == 1
            assert participants[0][0] == "John Doe"


class TestResultOperations:
    """Test result-related operations"""
    
    @pytest.fixture
    async def setup_with_participant(self):
        """Setup database with event and participant"""
        test_code = "RSLT"
        db_manager = DatabaseManager(test_code)
        
        if db_manager.exists():
            os.remove(db_manager.db_path)
        
        await db_manager.init_db()
        
        async with db_manager.get_connection() as db:
            # Create event
            await db.execute(
                "INSERT INTO event (code, shots_count) VALUES (?, ?)",
                (test_code, 30)
            )
            await db.commit()
            
            cursor = await db.execute("SELECT id FROM event WHERE code = ?", (test_code,))
            event_id = (await cursor.fetchone())[0]
            
            # Create participant
            await db.execute("""
                INSERT INTO participants (event_id, name, lane_number, shift)
                VALUES (?, ?, ?, ?)
            """, (event_id, "Test Shooter", 1, "A"))
            await db.commit()
            
            cursor = await db.execute("SELECT id FROM participants WHERE event_id = ?", (event_id,))
            participant_id = (await cursor.fetchone())[0]
        
        yield db_manager, test_code, participant_id
        
        if db_manager.exists():
            os.remove(db_manager.db_path)
    
    @pytest.mark.asyncio
    async def test_save_result(self, setup_with_participant):
        """Test saving a shot result"""
        db_manager, test_code, participant_id = setup_with_participant
        
        async with db_manager.get_connection() as db:
            await db.execute("""
                INSERT INTO results 
                (participant_id, series_number, shot_number, score, is_x)
                VALUES (?, ?, ?, ?, ?)
            """, (participant_id, 1, 1, 10, True))
            await db.commit()
            
            cursor = await db.execute(
                "SELECT score, is_x FROM results WHERE participant_id = ?",
                (participant_id,)
            )
            result = await cursor.fetchone()
            
            assert result[0] == 10
            assert result[1] == 1  # SQLite stores True as 1
    
    @pytest.mark.asyncio
    async def test_calculate_total_score(self, setup_with_participant):
        """Test calculating total score"""
        db_manager, test_code, participant_id = setup_with_participant
        
        async with db_manager.get_connection() as db:
            # Add multiple results
            results = [
                (participant_id, 1, 1, 10, True),
                (participant_id, 1, 2, 9, False),
                (participant_id, 1, 3, 8, False),
                (participant_id, 2, 1, 10, False),
                (participant_id, 2, 2, 10, True),
            ]
            
            for result in results:
                await db.execute("""
                    INSERT INTO results 
                    (participant_id, series_number, shot_number, score, is_x)
                    VALUES (?, ?, ?, ?, ?)
                """, result)
            await db.commit()
            
            # Calculate total
            cursor = await db.execute(
                "SELECT SUM(score) FROM results WHERE participant_id = ?",
                (participant_id,)
            )
            total = (await cursor.fetchone())[0]
            
            assert total == 47  # 10+9+8+10+10
    
    @pytest.mark.asyncio
    async def test_replace_result(self, setup_with_participant):
        """Test INSERT OR REPLACE for updating results"""
        db_manager, test_code, participant_id = setup_with_participant
        
        async with db_manager.get_connection() as db:
            # Insert initial result
            await db.execute("""
                INSERT INTO results 
                (participant_id, series_number, shot_number, score, is_x)
                VALUES (?, ?, ?, ?, ?)
            """, (participant_id, 1, 1, 8, False))
            await db.commit()
            
            # Replace with better score
            await db.execute("""
                INSERT OR REPLACE INTO results 
                (participant_id, series_number, shot_number, score, is_x)
                VALUES (?, ?, ?, ?, ?)
            """, (participant_id, 1, 1, 10, True))
            await db.commit()
            
            cursor = await db.execute("""
                SELECT score, is_x FROM results 
                WHERE participant_id = ? AND series_number = ? AND shot_number = ?
            """, (participant_id, 1, 1))
            result = await cursor.fetchone()
            
            assert result[0] == 10
            assert result[1] == 1


class TestLeaderboardGeneration:
    """Test leaderboard generation logic"""
    
    @pytest.fixture
    async def setup_leaderboard_data(self):
        """Setup database with multiple participants and results"""
        test_code = "LEAD"
        db_manager = DatabaseManager(test_code)
        
        if db_manager.exists():
            os.remove(db_manager.db_path)
        
        await db_manager.init_db()
        
        async with db_manager.get_connection() as db:
            # Create event
            await db.execute(
                "INSERT INTO event (code, shots_count) VALUES (?, ?)",
                (test_code, 30)
            )
            await db.commit()
            
            cursor = await db.execute("SELECT id FROM event WHERE code = ?", (test_code,))
            event_id = (await cursor.fetchone())[0]
            
            # Create participants with different categories
            participants_data = [
                (event_id, "John Doe", 1, "A", "male", "compound"),
                (event_id, "Jane Smith", 2, "A", "female", "compound"),
                (event_id, "Bob Wilson", 3, "B", "male", "barebow"),
                (event_id, "Alice Brown", 4, "B", "female", "olympic"),
            ]
            
            participant_ids = []
            for p in participants_data:
                await db.execute("""
                    INSERT INTO participants 
                    (event_id, name, lane_number, shift, gender, shooting_type)
                    VALUES (?, ?, ?, ?, ?, ?)
                """, p)
                await db.commit()
                
                cursor = await db.execute("SELECT last_insert_rowid()")
                participant_ids.append((await cursor.fetchone())[0])
            
            # Add results
            results_data = [
                (participant_ids[0], 10, 9, 10),  # John: 29
                (participant_ids[1], 10, 10, 9),  # Jane: 29
                (participant_ids[2], 8, 7, 9),    # Bob: 24
                (participant_ids[3], 10, 10, 10), # Alice: 30
            ]
            
            for pid, s1, s2, s3 in results_data:
                await db.execute("""
                    INSERT INTO results 
                    (participant_id, series_number, shot_number, score, is_x)
                    VALUES (?, 1, 1, ?, 0)
                """, (pid, s1))
                await db.execute("""
                    INSERT INTO results 
                    (participant_id, series_number, shot_number, score, is_x)
                    VALUES (?, 1, 2, ?, 0)
                """, (pid, s2))
                await db.execute("""
                    INSERT INTO results 
                    (participant_id, series_number, shot_number, score, is_x)
                    VALUES (?, 1, 3, ?, 0)
                """, (pid, s3))
            
            await db.commit()
        
        yield db_manager, test_code, event_id
        
        if db_manager.exists():
            os.remove(db_manager.db_path)
    
    @pytest.mark.asyncio
    async def test_leaderboard_grouping(self, setup_leaderboard_data):
        """Test leaderboard grouping by gender and shooting type"""
        db_manager, test_code, event_id = setup_leaderboard_data
        
        async with db_manager.get_connection() as db:
            cursor = await db.execute("""
                SELECT 
                    p.name,
                    COALESCE(p.gender, 'unknown') as gender,
                    COALESCE(p.shooting_type, 'unknown') as shooting_type,
                    COALESCE(SUM(r.score), 0) as total_score
                FROM participants p
                LEFT JOIN results r ON p.id = r.participant_id
                WHERE p.event_id = ?
                GROUP BY p.id
                ORDER BY total_score DESC
            """, (event_id,))
            
            results = await cursor.fetchall()
            
            # Group by category
            groups = {}
            for name, gender, shooting_type, score in results:
                key = f"{gender}_{shooting_type}"
                if key not in groups:
                    groups[key] = []
                groups[key].append((name, score))
            
            # Verify groups exist
            assert 'male_compound' in groups
            assert 'female_compound' in groups
            assert 'male_barebow' in groups
            assert 'female_olympic' in groups
            
            # Verify scores
            male_compound = groups['male_compound'][0]
            assert male_compound[0] == "John Doe"
            assert male_compound[1] == 29
            
            female_olympic = groups['female_olympic'][0]
            assert female_olympic[0] == "Alice Brown"
            assert female_olympic[1] == 30


class TestModelValidation:
    """Test Pydantic model validation"""
    
    def test_event_create_valid(self):
        """Test valid event creation"""
        event = EventCreate(code="TEST", shots_count=30)
        assert event.code == "TEST"
        assert event.shots_count == 30
    
    def test_participant_create_valid(self):
        """Test valid participant creation"""
        participant = ParticipantCreate(
            name="John Doe",
            lane_number=3,
            shift="A",
            gender="male",
            shooting_type="compound"
        )
        assert participant.name == "John Doe"
        assert participant.lane_number == 3
        assert participant.shift == "A"
    
    def test_result_create_valid(self):
        """Test valid result creation"""
        result = ResultCreate(
            participant_id=1,
            series_number=1,
            shot_number=1,
            score=10,
            is_x=True
        )
        assert result.score == 10
        assert result.is_x == True
    
    def test_result_score_validation(self):
        """Test that score validation would work (if we added validators)"""
        # This would require adding Pydantic validators
        result = ResultCreate(
            participant_id=1,
            series_number=1,
            shot_number=1,
            score=10,
            is_x=False
        )
        assert 0 <= result.score <= 10


if __name__ == "__main__":
    print("Run tests with: pytest tests/test_backend.py -v")
    print("Or: python -m pytest tests/test_backend.py -v")
