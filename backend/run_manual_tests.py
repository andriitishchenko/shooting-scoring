#!/usr/bin/env python3
"""
Simple Manual Testing Script
Tests backend functionality without requiring pytest
"""

import asyncio
import sys
import os

# Add app to path
sys.path.insert(0, os.path.dirname(__file__))

print("=" * 60)
print("Shooting Scoring System - Manual Tests")
print("=" * 60)
print()

async def test_database():
    """Test database creation and operations"""
    print("1. Testing Database Creation...")
    try:
        from app.database import DatabaseManager
        
        db_manager = DatabaseManager("MANUAL")
        
        # Clean up if exists
        if db_manager.exists():
            os.remove(db_manager.db_path)
            print("   - Removed existing test database")
        
        # Create database
        await db_manager.init_db()
        print("   ✓ Database created successfully")
        
        # Check tables
        async with db_manager.get_connection() as db:
            cursor = await db.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
            tables = await cursor.fetchall()
            table_names = [t[0] for t in tables]
            
            print(f"   ✓ Tables created: {', '.join(table_names)}")
            
            expected = ['event', 'participants', 'results']
            for table in expected:
                if table not in table_names:
                    print(f"   ✗ Missing table: {table}")
                    return False
        
        # Clean up
        if db_manager.exists():
            os.remove(db_manager.db_path)
            print("   ✓ Cleaned up test database")
        
        return True
        
    except Exception as e:
        print(f"   ✗ Error: {e}")
        import traceback
        traceback.print_exc()
        return False

async def test_event_operations():
    """Test event CRUD operations"""
    print("\n2. Testing Event Operations...")
    try:
        from app.database import DatabaseManager
        
        db_manager = DatabaseManager("EVT01")
        
        # Clean up if exists
        if db_manager.exists():
            os.remove(db_manager.db_path)
        
        await db_manager.init_db()
        
        # Create event
        async with db_manager.get_connection() as db:
            await db.execute(
                "INSERT INTO event (code, shots_count) VALUES (?, ?)",
                ("EVT01", 30)
            )
            await db.commit()
            print("   ✓ Event created")
            
            # Read event
            cursor = await db.execute(
                "SELECT code, shots_count, status FROM event WHERE code = ?",
                ("EVT01",)
            )
            event = await cursor.fetchone()
            
            if event:
                print(f"   ✓ Event retrieved: {event[0]}, shots={event[1]}, status={event[2]}")
            else:
                print("   ✗ Event not found after creation")
                return False
            
            # Update event
            await db.execute(
                "UPDATE event SET status = 'started' WHERE code = ?",
                ("EVT01",)
            )
            await db.commit()
            
            cursor = await db.execute(
                "SELECT status FROM event WHERE code = ?",
                ("EVT01",)
            )
            status = (await cursor.fetchone())[0]
            
            if status == 'started':
                print("   ✓ Event updated successfully")
            else:
                print(f"   ✗ Event status not updated: {status}")
                return False
        
        # Clean up
        if db_manager.exists():
            os.remove(db_manager.db_path)
        
        return True
        
    except Exception as e:
        print(f"   ✗ Error: {e}")
        import traceback
        traceback.print_exc()
        return False

async def test_participant_operations():
    """Test participant operations"""
    print("\n3. Testing Participant Operations...")
    try:
        from app.database import DatabaseManager
        
        db_manager = DatabaseManager("PRT01")
        
        if db_manager.exists():
            os.remove(db_manager.db_path)
        
        await db_manager.init_db()
        
        async with db_manager.get_connection() as db:
            # Create event first
            await db.execute(
                "INSERT INTO event (code, shots_count) VALUES (?, ?)",
                ("PRT01", 30)
            )
            await db.commit()
            
            cursor = await db.execute("SELECT id FROM event WHERE code = ?", ("PRT01",))
            event_id = (await cursor.fetchone())[0]
            print(f"   ✓ Event created with ID: {event_id}")
            
            # Add participant
            await db.execute("""
                INSERT INTO participants 
                (event_id, name, lane_number, shift, gender, shooting_type)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (event_id, "Test Shooter", 3, "A", "male", "compound"))
            await db.commit()
            print("   ✓ Participant added")
            
            # Retrieve participant
            cursor = await db.execute(
                "SELECT name, lane_number, shift FROM participants WHERE event_id = ?",
                (event_id,)
            )
            participant = await cursor.fetchone()
            
            if participant:
                print(f"   ✓ Participant retrieved: {participant[0]}, Lane {participant[1]}{participant[2]}")
            else:
                print("   ✗ Participant not found")
                return False
        
        if db_manager.exists():
            os.remove(db_manager.db_path)
        
        return True
        
    except Exception as e:
        print(f"   ✗ Error: {e}")
        import traceback
        traceback.print_exc()
        return False

async def test_result_operations():
    """Test result operations"""
    print("\n4. Testing Result Operations...")
    try:
        from app.database import DatabaseManager
        
        db_manager = DatabaseManager("RST01")
        
        if db_manager.exists():
            os.remove(db_manager.db_path)
        
        await db_manager.init_db()
        
        async with db_manager.get_connection() as db:
            # Setup event and participant
            await db.execute(
                "INSERT INTO event (code, shots_count) VALUES (?, ?)",
                ("RST01", 30)
            )
            await db.commit()
            
            cursor = await db.execute("SELECT id FROM event WHERE code = ?", ("RST01",))
            event_id = (await cursor.fetchone())[0]
            
            await db.execute("""
                INSERT INTO participants (event_id, name, lane_number, shift)
                VALUES (?, ?, ?, ?)
            """, (event_id, "Test Shooter", 1, "A"))
            await db.commit()
            
            cursor = await db.execute("SELECT id FROM participants WHERE event_id = ?", (event_id,))
            participant_id = (await cursor.fetchone())[0]
            print(f"   ✓ Setup complete: participant ID {participant_id}")
            
            # Add results
            results = [
                (participant_id, 1, 1, 10, True),
                (participant_id, 1, 2, 9, False),
                (participant_id, 1, 3, 8, False),
            ]
            
            for result in results:
                await db.execute("""
                    INSERT INTO results 
                    (participant_id, series_number, shot_number, score, is_x)
                    VALUES (?, ?, ?, ?, ?)
                """, result)
            await db.commit()
            print("   ✓ Results added")
            
            # Calculate total
            cursor = await db.execute(
                "SELECT SUM(score) FROM results WHERE participant_id = ?",
                (participant_id,)
            )
            total = (await cursor.fetchone())[0]
            
            if total == 27:  # 10 + 9 + 8
                print(f"   ✓ Total score calculated correctly: {total}")
            else:
                print(f"   ✗ Total score incorrect: {total} (expected 27)")
                return False
            
            # Test INSERT OR REPLACE
            await db.execute("""
                INSERT OR REPLACE INTO results 
                (participant_id, series_number, shot_number, score, is_x)
                VALUES (?, ?, ?, ?, ?)
            """, (participant_id, 1, 1, 5, False))
            await db.commit()
            
            cursor = await db.execute(
                "SELECT score FROM results WHERE participant_id = ? AND series_number = 1 AND shot_number = 1",
                (participant_id,)
            )
            new_score = (await cursor.fetchone())[0]
            
            if new_score == 5:
                print("   ✓ Result replacement works")
            else:
                print(f"   ✗ Result replacement failed: {new_score}")
                return False
        
        if db_manager.exists():
            os.remove(db_manager.db_path)
        
        return True
        
    except Exception as e:
        print(f"   ✗ Error: {e}")
        import traceback
        traceback.print_exc()
        return False

async def test_models():
    """Test Pydantic models"""
    print("\n5. Testing Pydantic Models...")
    try:
        from app.models import (
            EventCreate, ParticipantCreate, ResultCreate
        )
        
        # Test EventCreate
        event = EventCreate(code="TEST", shots_count=30)
        assert event.code == "TEST"
        assert event.shots_count == 30
        print("   ✓ EventCreate model works")
        
        # Test ParticipantCreate
        participant = ParticipantCreate(
            name="John Doe",
            lane_number=3,
            shift="A",
            gender="male",
            shooting_type="compound"
        )
        assert participant.name == "John Doe"
        print("   ✓ ParticipantCreate model works")
        
        # Test ResultCreate
        result = ResultCreate(
            participant_id=1,
            series_number=1,
            shot_number=1,
            score=10,
            is_x=True
        )
        assert result.score == 10
        print("   ✓ ResultCreate model works")
        
        return True
        
    except Exception as e:
        print(f"   ✗ Error: {e}")
        import traceback
        traceback.print_exc()
        return False

async def main():
    """Run all tests"""
    tests = [
        ("Database", test_database),
        ("Events", test_event_operations),
        ("Participants", test_participant_operations),
        ("Results", test_result_operations),
        ("Models", test_models),
    ]
    
    results = []
    for name, test_func in tests:
        try:
            result = await test_func()
            results.append((name, result))
        except Exception as e:
            print(f"\n✗ {name} test crashed: {e}")
            results.append((name, False))
    
    # Summary
    print("\n" + "=" * 60)
    print("Test Summary")
    print("=" * 60)
    
    passed = sum(1 for _, result in results if result)
    total = len(results)
    
    for name, result in results:
        status = "✓ PASS" if result else "✗ FAIL"
        print(f"{status}: {name}")
    
    print()
    print(f"Results: {passed}/{total} tests passed")
    
    if passed == total:
        print("\n✅ All tests passed! Backend is working correctly.")
        return 0
    else:
        print(f"\n❌ {total - passed} test(s) failed. Check errors above.")
        return 1

if __name__ == "__main__":
    try:
        exit_code = asyncio.run(main())
        sys.exit(exit_code)
    except KeyboardInterrupt:
        print("\n\nTests interrupted by user")
        sys.exit(1)
    except Exception as e:
        print(f"\n\nFatal error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
