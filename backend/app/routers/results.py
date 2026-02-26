from fastapi import APIRouter, HTTPException, Header
from app.database import DatabaseManager
from app.models import ResultCreate, ParticipantState, DistanceResult, ShotDetail
from app.routers.sessions import require_session, _verify_session
from app.routers.events import get_event_status
from typing import List, Optional

router = APIRouter(prefix="/api/results", tags=["results"])


@router.get("/{code}/leaderboard")
async def get_leaderboard(code: str):
    """Leaderboard. Public."""
    db = DatabaseManager(code)
    if not db.exists():
        raise HTTPException(status_code=404, detail="Event not found")

    event_status = await get_event_status(db)

    async with db.get_connection() as conn:
        cursor = await conn.execute(
            "SELECT id, title, shots_count, status FROM distances ORDER BY sort_order"
        )
        distances = await cursor.fetchall()
        dist_map = {d[0]: {"title": d[1], "shots_count": d[2], "status": d[3]} for d in distances}

        cursor = await conn.execute("""
            SELECT id, name, lane_number, shift,
                   COALESCE(age_category,'unknown'), COALESCE(group_type,'unknown'),
                   COALESCE(gender,'unknown'),       COALESCE(shooting_type,'unknown')
            FROM participants
        """)
        participants = await cursor.fetchall()

        cursor = await conn.execute("""
            SELECT r.participant_id, r.distance_id,
                   SUM(r.score), COUNT(r.id),
                   COUNT(CASE WHEN r.is_x=1 THEN 1 END),
                   COUNT(CASE WHEN r.score=10 THEN 1 END)
            FROM results r
            GROUP BY r.participant_id, r.distance_id
        """)
        raw_results = await cursor.fetchall()

    results_map: dict = {}
    for pid, did, total, count, x_cnt, ten_cnt in raw_results:
        results_map.setdefault(pid, {})[did] = {
            "total": total or 0, "count": count or 0,
            "x_count": x_cnt or 0, "ten_count": ten_cnt or 0,
        }

    grouped: dict = {}
    for p in participants:
        pid, name, lane, shift, age_cat, group_type, gender, shooting_type = p
        p_results = results_map.get(pid, {})
        if not p_results:
            continue

        total_score = x_count = ten_count = shots_taken = 0
        dist_scores = []

        for did, dinfo in dist_map.items():
            dr = p_results.get(did)
            if dinfo["status"] not in ("active", "finished"):
                continue
            if dr:
                total_score  += dr["total"]
                x_count      += dr["x_count"]
                ten_count    += dr["ten_count"]
                shots_taken  += dr["count"]
                dist_scores.append({
                    "distance_id": did, "title": dinfo["title"],
                    "score": dr["total"], "shots_count": dinfo["shots_count"],
                    "shots_taken": dr["count"],
                })
            else:
                dist_scores.append({
                    "distance_id": did, "title": dinfo["title"],
                    "score": None,  "shots_count": dinfo["shots_count"],
                    "shots_taken": 0,
                })

        avg_score = total_score / shots_taken if shots_taken else 0.0
        group_key = f"{gender}_{shooting_type}"
        grouped.setdefault(group_key, []).append({
            "id": pid, "name": name, "lane_shift": f"{lane}{shift}",
            "gender": gender, "shooting_type": shooting_type,
            "group_type": group_type, "age_category": age_cat,
            "total_score": total_score, "x_count": x_count,
            "ten_count": ten_count, "avg_score": avg_score,
            "distance_scores": dist_scores,
        })

    return grouped


@router.get("/{code}/detail/{participant_id}/{distance_id}")
async def get_distance_detail(code: str, participant_id: int, distance_id: int):
    """Distance detail popup. Public (read-only)."""
    db = DatabaseManager(code)
    if not db.exists():
        raise HTTPException(status_code=404, detail="Event not found")

    async with db.get_connection() as conn:
        cursor = await conn.execute(
            "SELECT title, shots_count FROM distances WHERE id=?", (distance_id,)
        )
        dist = await cursor.fetchone()
        if not dist:
            raise HTTPException(status_code=404, detail="Distance not found")
        title, shots_count = dist

        cursor = await conn.execute(
            "SELECT shot_number, score, is_x FROM results WHERE participant_id=? AND distance_id=? ORDER BY shot_number",
            (participant_id, distance_id),
        )
        shots = await cursor.fetchall()

    shots_per_series = 3
    shots_map   = {s[0]: {"score": s[1], "is_x": bool(s[2])} for s in shots}
    total_score = sum(s[1] for s in shots)
    x_count     = sum(1 for s in shots if s[2])
    ten_count   = sum(1 for s in shots if s[1] == 10)
    taken       = len(shots)
    avg_score   = total_score / taken if taken else 0.0
    total_series = (shots_count + shots_per_series - 1) // shots_per_series

    series_list = []
    for series in range(1, total_series + 1):
        series_shots = []
        series_total = 0
        for shot in range(1, shots_per_series + 1):
            shot_num = (series - 1) * shots_per_series + shot
            if shot_num > shots_count:
                break
            sd = shots_map.get(shot_num)
            if sd:
                series_shots.append({"shot": shot_num, "score": sd["score"], "is_x": sd["is_x"]})
                series_total += sd["score"]
            else:
                series_shots.append({"shot": shot_num, "score": None, "is_x": False})
        taken_in = [s for s in series_shots if s["score"] is not None]
        avg = sum(s["score"] for s in taken_in) / len(taken_in) if taken_in else 0.0
        series_list.append({"series": series, "shots": series_shots, "total": series_total, "avg": avg})

    return {
        "title": title, "shots_count": shots_count,
        "total_score": total_score, "x_count": x_count,
        "ten_count": ten_count, "avg_score": avg_score,
        "series": series_list,
    }


@router.get("/{code}/state/{participant_id}", response_model=ParticipantState)
async def get_participant_state(code: str, participant_id: int):
    """Full state for client restore. Public."""
    db = DatabaseManager(code)
    if not db.exists():
        raise HTTPException(status_code=404, detail="Event not found")

    async with db.get_connection() as conn:
        cursor = await conn.execute(
            "SELECT id, title, shots_count, status FROM distances ORDER BY sort_order"
        )
        distances = await cursor.fetchall()

        cursor = await conn.execute(
            "SELECT distance_id, shot_number, score, is_x FROM results WHERE participant_id=? ORDER BY distance_id, shot_number",
            (participant_id,),
        )
        all_shots = await cursor.fetchall()

    shots_by_dist: dict = {}
    for did, shot_num, score, is_x in all_shots:
        shots_by_dist.setdefault(did, []).append(
            ShotDetail(shot=shot_num, score=score, is_x=bool(is_x))
        )

    dist_results = []
    for did, title, shots_count, status in distances:
        shots  = shots_by_dist.get(did, [])
        total  = sum(s.score for s in shots) if shots else None
        x_count = sum(1 for s in shots if s.is_x)
        dist_results.append(DistanceResult(
            distance_id=did, title=title, shots_count=shots_count, status=status,
            total_score=total, x_count=x_count,
            shots=[] if status == "finished" else shots,
        ))

    return ParticipantState(distances=dist_results)


@router.post("/{code}")
async def save_results(
    code: str,
    results: List[ResultCreate],
    x_session_id: Optional[str] = Header(None),
):
    """Save shots. Requires valid client lane OR host session."""
    db = DatabaseManager(code)
    if not db.exists():
        raise HTTPException(status_code=404, detail="Event not found")

    if not x_session_id:
        raise HTTPException(status_code=401, detail="Session ID required")

    event_status = await get_event_status(db)
    if event_status == "finished":
        raise HTTPException(status_code=403, detail="Event has finished")
    if event_status != "started":
        raise HTTPException(status_code=403, detail="Event has not started yet")

    if results:
        async with db.get_connection() as conn:
            cursor = await conn.execute(
                "SELECT lane_number FROM participants WHERE id=?", (results[0].participant_id,)
            )
            p_row = await cursor.fetchone()

        if p_row:
            lane_str = str(p_row[0])
            ok = await _verify_session(db, "client", lane_str, x_session_id)
            if not ok:
                ok = await _verify_session(db, "host", "default", x_session_id)
            if not ok:
                raise HTTPException(status_code=401, detail="Invalid session")

    async with db.get_connection() as conn:
        dist_ids = {r.distance_id for r in results}
        for did in dist_ids:
            cursor = await conn.execute("SELECT status FROM distances WHERE id=?", (did,))
            row = await cursor.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail=f"Distance {did} not found")
            if row[0] != "active":
                raise HTTPException(status_code=403, detail=f"Distance {did} is not active")

        for r in results:
            if r.score < 0 or r.score > 10:
                raise HTTPException(status_code=400, detail="Score must be 0-10")
            await conn.execute("""
                INSERT OR REPLACE INTO results
                    (participant_id, distance_id, shot_number, score, is_x)
                VALUES (?, ?, ?, ?, ?)
            """, (r.participant_id, r.distance_id, r.shot_number, r.score, r.is_x))

        await conn.commit()

    return {"message": "Results saved", "count": len(results)}


@router.delete("/{code}/{participant_id}")
async def delete_participant_results(
    code: str,
    participant_id: int,
    x_session_id: Optional[str] = Header(None),
):
    db = DatabaseManager(code)
    if not db.exists():
        raise HTTPException(status_code=404, detail="Event not found")
    await require_session(db, "host", "default", x_session_id)

    async with db.get_connection() as conn:
        await conn.execute("DELETE FROM results WHERE participant_id=?", (participant_id,))
        await conn.commit()

    return {"message": "Results deleted"}
