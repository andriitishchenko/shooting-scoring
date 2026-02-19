from pydantic import BaseModel
from typing import Optional, Literal, List
from datetime import datetime


# ── Event ──────────────────────────────────────────────────────────────────

class EventCreate(BaseModel):
    code: str
    shots_count: int = 30   # kept for legacy / default distance


class EventUpdate(BaseModel):
    shots_count: Optional[int] = None
    status: Optional[Literal['created', 'started', 'finished']] = None


class EventResponse(BaseModel):
    id: int
    code: str
    shots_count: int
    status: str
    created_at: str
    started_at: Optional[str] = None
    finished_at: Optional[str] = None


# ── Distance ────────────────────────────────────────────────────────────────

class DistanceCreate(BaseModel):
    title: str
    shots_count: int = 30


class DistanceUpdate(BaseModel):
    title: Optional[str] = None
    shots_count: Optional[int] = None
    status: Optional[Literal['pending', 'active', 'finished']] = None


class DistanceResponse(BaseModel):
    id: int
    event_id: int
    title: str
    shots_count: int
    sort_order: int
    status: str   # pending | active | finished


# ── Participant ─────────────────────────────────────────────────────────────

class ParticipantCreate(BaseModel):
    name: str
    lane_number: int
    shift: str
    gender: Optional[str] = None
    age_category: Optional[str] = None
    shooting_type: Optional[str] = None
    group_type: Optional[str] = None
    personal_number: Optional[str] = None


class ParticipantResponse(BaseModel):
    id: int
    name: str
    lane_number: int
    shift: str
    gender: Optional[str] = None
    age_category: Optional[str] = None
    shooting_type: Optional[str] = None
    group_type: Optional[str] = None
    personal_number: Optional[str] = None


# ── Results ─────────────────────────────────────────────────────────────────

class ResultCreate(BaseModel):
    participant_id: int
    distance_id: int
    shot_number: int
    score: int       # 0-10
    is_x: bool = False


class ResultResponse(BaseModel):
    distance_id: int
    shot: int
    score: int
    is_x: bool


class ShotDetail(BaseModel):
    shot: int
    score: int
    is_x: bool


class DistanceResult(BaseModel):
    """Per-distance result summary for client state restore"""
    distance_id: int
    title: str
    shots_count: int
    status: str                    # pending | active | finished
    total_score: Optional[int]     # None if no shots yet
    x_count: int
    shots: List[ShotDetail]        # empty for finished distances (summary only)


class ParticipantState(BaseModel):
    """Full state for client to restore"""
    distances: List[DistanceResult]
