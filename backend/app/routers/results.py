from fastapi import APIRouter, HTTPException
from app.database import DatabaseManager
from app.models import ResultCreate, ResultResponse, ParticipantState, DistanceResult, ShotDetail
from typing import List, Dict

router = APIRouter(prefix="/api/results", tags=["results"])


@router.get("/{code}/leaderboard")
async def get_leaderboard(code: str):
    """Leaderboard grouped by category. Returns cumulative totals + per-distance breakdown."""
    db = DatabaseManager(code)
    if not db.exists():
        raise HTTPException(status_code=404, detail="Event not found")

    try:
        async with db.get_connection() as conn:
            cursor = await conn.execute("SELECT id, status FROM event WHERE code=?", (code,))
            ev = await cursor.fetchone()
            if not ev:
                raise HTTPException(status_code=404, detail="Event not found")
            event_id, event_status = ev

            cursor = await conn.execute(
                "SELECT id, title, shots_count, status FROM distances WHERE event_id=? ORDER BY sort_order",
                (event_id,)
            )
            distances = await cursor.fetchall()
            dist_map = {d[0]: {"title": d[1], "shots_count": d[2], "status": d[3]} for d in distances}

            cursor = await conn.execute("""
                SELECT p.id, p.name, p.lane_number, p.shift,
                       COALESCE(p.age_category,'unknown'), COALESCE(p.group_type,'unknown'),
                       COALESCE(p.gender,'unknown'), COALESCE(p.shooting_type,'unknown')
                FROM participants p WHERE p.event_id=?
            """, (event_id,))
            participants = await cursor.fetchall()

            # Per-participant, per-distance aggregates including shots_taken
            cursor = await conn.execute("""
                SELECT r.participant_id, r.distance_id,
                       SUM(r.score),
                       COUNT(r.id),
                       COUNT(CASE WHEN r.is_x=1 THEN 1 END),
                       COUNT(CASE WHEN r.score=10 THEN 1 END),
                       COUNT(CASE WHEN r.score=0 THEN 1 END)
                FROM results r
                JOIN participants p ON p.id=r.participant_id
                WHERE p.event_id=?
                GROUP BY r.participant_id, r.distance_id
            """, (event_id,))
            agg_rows = await cursor.fetchall()

        agg: Dict[int, Dict[int, dict]] = {}
        for pid, did, total, shots_taken, xc, tc, mc in agg_rows:
            agg.setdefault(pid, {})[did] = {
                "total": total, "shots_taken": shots_taken,
                "x_count": xc, "ten_count": tc, "m_count": mc
            }

        grouped: Dict[str, List[dict]] = {}

        for p in participants:
            pid, name, lane, shift, age_cat, group_t, gender, shoot_t = p
            key = f"{age_cat}_{group_t}_{gender}_{shoot_t}"

            dist_scores = []
            total_score = 0
            total_shots = 0
            total_x = 0
            total_10 = 0
            total_m = 0

            for did, dinfo in dist_map.items():
                da = agg.get(pid, {}).get(did)
                dist_scores.append({
                    "distance_id": did,
                    "title": dinfo["title"],
                    "shots_count": dinfo["shots_count"],
                    "score": da["total"] if da else None,
                    "shots_taken": da["shots_taken"] if da else 0,
                    "x_count": da["x_count"] if da else 0,
                    "status": dinfo["status"]
                })
                if da:
                    total_score += da["total"]
                    total_shots += da["shots_taken"]
                    total_x += da["x_count"]
                    total_10 += da["ten_count"]
                    total_m += da["m_count"]

            avg_score = round(total_score / total_shots, 2) if total_shots > 0 else 0.0

            grouped.setdefault(key, []).append({
                "id": pid,
                "name": name,
                "lane_shift": f"{lane}{shift}",
                "total_score": total_score,
                "shots_taken": total_shots,
                "avg_score": avg_score,
                "x_count": total_x,
                "ten_count": total_10,
                "m_count": total_m,
                "age_category": age_cat,
                "group_type": group_t,
                "gender": gender,
                "shooting_type": shoot_t,
                "distance_scores": dist_scores
            })

        for key in grouped:
            grouped[key].sort(key=lambda x: (x["total_score"], x["x_count"], x["ten_count"]), reverse=True)

        return grouped

    except HTTPException:
        raise
    except Exception as e:
        print(f"Leaderboard error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{code}/detail/{participant_id}/{distance_id}")
async def get_distance_detail(code: str, participant_id: int, distance_id: int):
    """Full shot-by-shot results for one participant on one distance (for host popup)."""
    db = DatabaseManager(code)
    if not db.exists():
        raise HTTPException(status_code=404, detail="Event not found")

    async with db.get_connection() as conn:
        cursor = await conn.execute("SELECT id FROM event WHERE code=?", (code,))
        ev = await cursor.fetchone()
        if not ev:
            raise HTTPException(status_code=404, detail="Event not found")
        event_id = ev[0]

        cursor = await conn.execute(
            "SELECT id, title, shots_count, status FROM distances WHERE id=? AND event_id=?",
            (distance_id, event_id)
        )
        dist = await cursor.fetchone()
        if not dist:
            raise HTTPException(status_code=404, detail="Distance not found")

        cursor = await conn.execute(
            "SELECT shot_number, score, is_x FROM results WHERE participant_id=? AND distance_id=? ORDER BY shot_number",
            (participant_id, distance_id)
        )
        shots = await cursor.fetchall()

    shots_per_series = 3
    total_shots = dist[2]
    total_series = (total_shots + shots_per_series - 1) // shots_per_series

    # Build series breakdown
    series_list = []
    shot_map = {s[0]: {"score": s[1], "is_x": bool(s[2])} for s in shots}

    for s in range(1, total_series + 1):
        series_shots = []
        series_total = 0
        for sh in range(1, shots_per_series + 1):
            shot_num = (s - 1) * shots_per_series + sh
            if shot_num > total_shots:
                break
            shot_data = shot_map.get(shot_num)
            if shot_data:
                series_shots.append({
                    "shot_number": shot_num,
                    "score": shot_data["score"],
                    "is_x": shot_data["is_x"]
                })
                series_total += shot_data["score"]
            else:
                series_shots.append({"shot_number": shot_num, "score": None, "is_x": False})

        filled = [sh for sh in series_shots if sh["score"] is not None]
        series_avg = round(series_total / len(filled), 2) if filled else 0.0
        series_list.append({
            "series": s,
            "shots": series_shots,
            "total": series_total,
            "avg": series_avg
        })

    all_scores = [s[1] for s in shots]
    grand_total = sum(all_scores)
    grand_avg = round(grand_total / len(all_scores), 2) if all_scores else 0.0

    return {
        "distance_id": dist[0],
        "title": dist[1],
        "shots_count": dist[2],
        "status": dist[3],
        "total_score": grand_total,
        "avg_score": grand_avg,
        "x_count": sum(1 for s in shots if s[2]),
        "ten_count": sum(1 for s in shots if s[1] == 10),
        "series": series_list
    }


@router.get("/{code}/state/{participant_id}", response_model=ParticipantState)
async def get_participant_state(code: str, participant_id: int):
    """Full state for client restore: shots for active distance, summaries for finished."""
    db = DatabaseManager(code)
    if not db.exists():
        raise HTTPException(status_code=404, detail="Event not found")

    async with db.get_connection() as conn:
        cursor = await conn.execute("SELECT id FROM event WHERE code=?", (code,))
        ev = await cursor.fetchone()
        if not ev:
            raise HTTPException(status_code=404, detail="Event not found")
        event_id = ev[0]

        cursor = await conn.execute(
            "SELECT id, title, shots_count, status FROM distances WHERE event_id=? ORDER BY sort_order",
            (event_id,)
        )
        distances = await cursor.fetchall()

        dist_results: List[DistanceResult] = []
        for did, title, shots_count, status in distances:
            if status == 'finished':
                cursor = await conn.execute(
                    "SELECT SUM(score), COUNT(CASE WHEN is_x=1 THEN 1 END) FROM results WHERE participant_id=? AND distance_id=?",
                    (participant_id, did)
                )
                row = await cursor.fetchone()
                dist_results.append(DistanceResult(
                    distance_id=did, title=title, shots_count=shots_count, status=status,
                    total_score=row[0] if row[0] is not None else 0,
                    x_count=row[1] or 0, shots=[]
                ))
            elif status == 'active':
                cursor = await conn.execute(
                    "SELECT shot_number, score, is_x FROM results WHERE participant_id=? AND distance_id=? ORDER BY shot_number",
                    (participant_id, did)
                )
                raw = await cursor.fetchall()
                total = sum(s[1] for s in raw)
                xc = sum(1 for s in raw if s[2])
                dist_results.append(DistanceResult(
                    distance_id=did, title=title, shots_count=shots_count, status=status,
                    total_score=total if raw else None, x_count=xc,
                    shots=[ShotDetail(shot=s[0], score=s[1], is_x=bool(s[2])) for s in raw]
                ))
            else:
                dist_results.append(DistanceResult(
                    distance_id=did, title=title, shots_count=shots_count, status=status,
                    total_score=None, x_count=0, shots=[]
                ))

    return ParticipantState(distances=dist_results)


@router.post("/{code}")
async def save_results(code: str, results: List[ResultCreate]):
    """Save shots. Only allowed when event is started and target distance is active."""
    db = DatabaseManager(code)
    if not db.exists():
        raise HTTPException(status_code=404, detail="Event not found")

    async with db.get_connection() as conn:
        cursor = await conn.execute("SELECT id, status FROM event WHERE code=?", (code,))
        ev = await cursor.fetchone()
        if not ev:
            raise HTTPException(status_code=404, detail="Event not found")
        event_id, event_status = ev

        if event_status == 'finished':
            raise HTTPException(status_code=403, detail="Event has finished")
        if event_status != 'started':
            raise HTTPException(status_code=403, detail="Event has not started yet")

        dist_ids = {r.distance_id for r in results}
        for did in dist_ids:
            cursor = await conn.execute(
                "SELECT status FROM distances WHERE id=? AND event_id=?", (did, event_id)
            )
            row = await cursor.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail=f"Distance {did} not found")
            if row[0] != 'active':
                raise HTTPException(status_code=403, detail=f"Distance {did} is not active (status: {row[0]})")

        for r in results:
            if r.score < 0 or r.score > 10:
                raise HTTPException(status_code=400, detail="Score must be 0-10")
            await conn.execute("""
                INSERT OR REPLACE INTO results (participant_id, distance_id, shot_number, score, is_x)
                VALUES (?, ?, ?, ?, ?)
            """, (r.participant_id, r.distance_id, r.shot_number, r.score, r.is_x))

        await conn.commit()

    return {"message": "Results saved", "count": len(results)}


@router.delete("/{code}/{participant_id}")
async def delete_participant_results(code: str, participant_id: int):
    db = DatabaseManager(code)
    if not db.exists():
        raise HTTPException(status_code=404, detail="Event not found")

    async with db.get_connection() as conn:
        cursor = await conn.execute("SELECT status FROM event WHERE code=?", (code,))
        ev = await cursor.fetchone()
        if ev and ev[0] == 'finished':
            raise HTTPException(status_code=403, detail="Event has finished")
        await conn.execute("DELETE FROM results WHERE participant_id=?", (participant_id,))
        await conn.commit()

    return {"message": "Results deleted"}
