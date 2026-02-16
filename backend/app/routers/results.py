from fastapi import APIRouter, HTTPException
from app.database import DatabaseManager
from app.models import ResultCreate, ResultResponse, LeaderboardEntry
from typing import List, Dict


router = APIRouter(prefix="/api/results", tags=["results"])

@router.get("/{code}/leaderboard")
async def get_leaderboard(code: str):
    """Get leaderboard grouped by age_category, skill_type, gender, and shooting type"""
    db_manager = DatabaseManager(code)
    
    if not db_manager.exists():
        raise HTTPException(status_code=404, detail="Event not found")
    
    try:
        async with db_manager.get_connection() as db:
            # Check if event exists
            cursor = await db.execute("SELECT id FROM event WHERE code = ?", (code,))
            event = await cursor.fetchone()
            
            if not event:
                raise HTTPException(status_code=404, detail="Event not found")
            
            event_id = event[0]
            
            cursor = await db.execute("""
                SELECT 
                    p.id,
                    p.name,
                    p.lane_number,
                    p.shift,
                    COALESCE(p.age_category, 'unknown') as age_category,
                    COALESCE(p.skill_type, 'unknown') as skill_type,
                    COALESCE(p.gender, 'unknown') as gender,
                    COALESCE(p.shooting_type, 'unknown') as shooting_type,
                    COALESCE(SUM(r.score), 0) as total_score,
                    COUNT(CASE WHEN r.is_x = 1 THEN 1 END) as x_count,
                    COUNT(CASE WHEN r.score = 10 THEN 1 END) as ten_count,
                    COUNT(CASE WHEN r.score = 0 THEN 1 END) as m_count
                FROM participants p
                LEFT JOIN results r ON p.id = r.participant_id
                WHERE p.event_id = ?
                GROUP BY p.id
                ORDER BY total_score DESC, x_count DESC, ten_count DESC
            """, (event_id,))
            
            leaderboard = await cursor.fetchall()
        
        # Group by categories
        grouped: Dict[str, List[Dict]] = {}
        
        for entry in leaderboard:
            age_category = entry[4]
            skill_type = entry[5]
            gender = entry[6]
            shooting_type = entry[7]
            key = f"{age_category}_{skill_type}_{gender}_{shooting_type}"
            
            if key not in grouped:
                grouped[key] = []
            
            grouped[key].append({
                "id": entry[0],
                "name": entry[1],
                "lane_shift": f"{entry[2]}{entry[3]}",
                "total_score": entry[8],
                "x_count": entry[9],
                "ten_count": entry[10],
                "m_count": entry[11],
                "age_category": age_category,
                "skill_type": skill_type,
                "gender": gender,
                "shooting_type": shooting_type
            })
        
        # Sort each group by score, then X's, then 10s
        for key in grouped:
            grouped[key].sort(key=lambda x: (x['total_score'], x['x_count'], x['ten_count']), reverse=True)
        
        return grouped
    except HTTPException:
        raise
    except Exception as e:
        print(f"Leaderboard error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{code}")
async def save_results(code: str, results: List[ResultCreate]):
    """Save shooting results"""
    db_manager = DatabaseManager(code)
    
    if not db_manager.exists():
        raise HTTPException(status_code=404, detail="Event not found")
    
    async with db_manager.get_connection() as db:
        cursor = await db.execute("SELECT status FROM event WHERE code = ?", (code,))
        event = await cursor.fetchone()
        if event and event[0] == 'finished':
            raise HTTPException(status_code=403, detail="Event has finished and cannot be modified.")

        for result in results:
            # Validate score
            if result.score < 0 or result.score > 10:
                raise HTTPException(status_code=400, detail="Score must be between 0 and 10")
            
            # Insert or replace result
            await db.execute("""
                INSERT OR REPLACE INTO results 
                (participant_id, series_number, shot_number, score, is_x)
                VALUES (?, ?, ?, ?, ?)
            """, (
                result.participant_id, 
                result.series_number, 
                result.shot_number, 
                result.score, 
                result.is_x
            ))
        
        await db.commit()
    
    return {"message": "Results saved", "count": len(results)}


@router.get("/{code}/{participant_id}", response_model=List[ResultResponse])
async def get_participant_results(code: str, participant_id: int):
    """Get results for specific participant"""
    db_manager = DatabaseManager(code)
    
    if not db_manager.exists():
        raise HTTPException(status_code=404, detail="Event not found")
    
    async with db_manager.get_connection() as db:
        cursor = await db.execute("""
            SELECT series_number, shot_number, score, is_x
            FROM results
            WHERE participant_id = ?
            ORDER BY series_number, shot_number
        """, (participant_id,))
        results = await cursor.fetchall()
    
    return [
        ResultResponse(
            series=r[0],
            shot=r[1],
            score=r[2],
            is_x=bool(r[3])
        )
        for r in results
    ]

@router.delete("/{code}/{participant_id}")
async def delete_participant_results(code: str, participant_id: int):
    """Delete all results for a participant"""
    db_manager = DatabaseManager(code)
    
    if not db_manager.exists():
        raise HTTPException(status_code=404, detail="Event not found")
    
    async with db_manager.get_connection() as db:
        cursor = await db.execute("SELECT status FROM event WHERE code = ?", (code,))
        event = await cursor.fetchone()
        if event and event[0] == 'finished':
            raise HTTPException(status_code=403, detail="Event has finished and cannot be modified.")

        await db.execute(
            "DELETE FROM results WHERE participant_id = ?",
            (participant_id,)
        )
        await db.commit()
    
    return {"message": "Results deleted"}
