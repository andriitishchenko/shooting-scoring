from fastapi import APIRouter, HTTPException
from app.database import DatabaseManager
from app.models import ParticipantCreate, ParticipantResponse
from typing import List, Optional


router = APIRouter(prefix="/api/participants", tags=["participants"])


@router.post("/{code}")
async def add_participant(code: str, participant: ParticipantCreate):
    """Add participant to event"""
    db_manager = DatabaseManager(code)
    
    if not db_manager.exists():
        raise HTTPException(status_code=404, detail="Event not found")
    
    async with db_manager.get_connection() as db:
        # Get event ID and status
        cursor = await db.execute("SELECT id, status FROM event WHERE code = ?", (code,))
        event = await cursor.fetchone()
        
        if not event:
            raise HTTPException(status_code=404, detail="Event not found")

        if event[1] == 'finished':
            raise HTTPException(status_code=403, detail="Event has finished and cannot be modified.")
        
        # Insert participant
        cursor = await db.execute("""
            INSERT INTO participants 
            (event_id, name, lane_number, shift, gender, age_category, 
             shooting_type, weapon_type, personal_number)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            event[0], participant.name, participant.lane_number, 
            participant.shift, participant.gender, participant.age_category,
            participant.shooting_type, participant.weapon_type, 
            participant.personal_number
        ))
        
        await db.commit()
        participant_id = cursor.lastrowid
    
    return {"id": participant_id, "message": "Participant added"}


@router.get("/{code}", response_model=List[ParticipantResponse])
async def get_participants(code: str, lane_number: Optional[int] = None):
    """Get list of participants (optionally filtered by lane)"""
    db_manager = DatabaseManager(code)
    
    if not db_manager.exists():
        raise HTTPException(status_code=404, detail="Event not found")
    
    query = """
        SELECT id, name, lane_number, shift, gender, age_category, 
               shooting_type, weapon_type, personal_number
        FROM participants 
        WHERE event_id = (SELECT id FROM event WHERE code = ?)
    """
    params = [code]
    
    if lane_number is not None:
        query += " AND lane_number = ?"
        params.append(lane_number)
    
    query += " ORDER BY lane_number, shift"
    
    async with db_manager.get_connection() as db:
        cursor = await db.execute(query, params)
        participants = await cursor.fetchall()
    
    return [
        ParticipantResponse(
            id=p[0],
            name=p[1],
            lane_number=p[2],
            shift=p[3],
            gender=p[4],
            age_category=p[5],
            shooting_type=p[6],
            weapon_type=p[7],
            personal_number=p[8]
        )
        for p in participants
    ]


@router.delete("/{code}/{participant_id}")
async def delete_participant(code: str, participant_id: int):
    """Delete participant"""
    db_manager = DatabaseManager(code)
    
    if not db_manager.exists():
        raise HTTPException(status_code=404, detail="Event not found")
    
    async with db_manager.get_connection() as db:
        cursor = await db.execute("SELECT status FROM event WHERE code = ?", (code,))
        event = await cursor.fetchone()
        if event and event[0] == 'finished':
            raise HTTPException(status_code=403, detail="Event has finished and cannot be modified.")

        # Delete results first (foreign key)
        await db.execute(
            "DELETE FROM results WHERE participant_id = ?",
            (participant_id,)
        )
        
        # Delete participant
        await db.execute(
            "DELETE FROM participants WHERE id = ?",
            (participant_id,)
        )
        
        await db.commit()
    
    return {"message": "Participant deleted"}


@router.put("/{code}/{participant_id}")
async def update_participant(code: str, participant_id: int, participant: ParticipantCreate):
    """Update participant details"""
    db_manager = DatabaseManager(code)
    
    if not db_manager.exists():
        raise HTTPException(status_code=404, detail="Event not found")
    
    async with db_manager.get_connection() as db:
        # Check if participant exists
        cursor = await db.execute(
            "SELECT id FROM participants WHERE id = ?",
            (participant_id,)
        )
        existing = await cursor.fetchone()
        
        if not existing:
            raise HTTPException(status_code=404, detail="Participant not found")
        
        # Update participant
        await db.execute("""
            UPDATE participants 
            SET name = ?, lane_number = ?, shift = ?, gender = ?,
                age_category = ?, shooting_type = ?, weapon_type = ?, 
                personal_number = ?
            WHERE id = ?
        """, (
            participant.name,
            participant.lane_number,
            participant.shift,
            participant.gender,
            participant.age_category,
            participant.shooting_type,
            participant.weapon_type,
            participant.personal_number,
            participant_id
        ))
        
        await db.commit()
    
    return {"message": "Participant updated", "id": participant_id}
