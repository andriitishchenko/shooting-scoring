from fastapi import APIRouter, HTTPException
from app.database import DatabaseManager
from app.models import ResultCreate, ResultResponse, LeaderboardEntry
from typing import List, Dict


router = APIRouter(prefix="/api/results", tags=["results"])

@router.get("/{code}/leaderboard")
async def get_leaderboard(code: str):
    """Get leaderboard grouped by gender and shooting type"""
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
                    COALESCE(p.gender, 'unknown') as gender,
                    COALESCE(p.shooting_type, 'unknown') as shooting_type,
                    COALESCE(SUM(r.score), 0) as total_score,
                    COUNT(r.id) as shots_taken
                FROM participants p
                LEFT JOIN results r ON p.id = r.participant_id
                WHERE p.event_id = ?
                GROUP BY p.id
                ORDER BY total_score DESC
            """, (event_id,))
            
            leaderboard = await cursor.fetchall()
        
        # Group by gender and shooting type
        grouped: Dict[str, List[Dict]] = {}
        
        for entry in leaderboard:
            gender = entry[4]
            shooting_type = entry[5]
            key = f"{gender}_{shooting_type}"
            
            if key not in grouped:
                grouped[key] = []
            
            grouped[key].append({
                "id": entry[0],
                "name": entry[1],
                "lane_shift": f"{entry[2]}{entry[3]}",
                "total_score": entry[6],
                "shots_taken": entry[7]
            })
        
        # Sort each group by score
        for key in grouped:
            grouped[key].sort(key=lambda x: x['total_score'], reverse=True)
        
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
        await db.execute(
            "DELETE FROM results WHERE participant_id = ?",
            (participant_id,)
        )
        await db.commit()
    
    return {"message": "Results deleted"}
