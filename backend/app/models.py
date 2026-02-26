from pydantic import BaseModel
from typing import Optional, Literal, List


# ── Event (now stored as properties) ──────────────────────────────────────

class EventCreate(BaseModel):
    code: str
    shots_count: int = 30


class EventUpdate(BaseModel):
    shots_count: Optional[int] = None
    status: Optional[Literal['created', 'started', 'finished']] = None


class EventResponse(BaseModel):
    code: str
    shots_count: int
    status: str
    created_at: Optional[str] = None
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
    title: str
    shots_count: int
    sort_order: int
    status: str


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
    score: int
    is_x: bool = False


class ShotDetail(BaseModel):
    shot: int
    score: int
    is_x: bool


class DistanceResult(BaseModel):
    distance_id: int
    title: str
    shots_count: int
    status: str
    total_score: Optional[int]
    x_count: int
    shots: List[ShotDetail]


class ParticipantState(BaseModel):
    distances: List[DistanceResult]
