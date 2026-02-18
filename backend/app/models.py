from pydantic import BaseModel
from typing import Optional, Literal, List
from datetime import datetime


class EventCreate(BaseModel):
    code: str
    shots_count: int = 30


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


class ResultCreate(BaseModel):
    participant_id: int
    series_number: int
    shot_number: int
    score: int  # 0-10
    is_x: bool = False


class ResultResponse(BaseModel):
    series: int
    shot: int
    score: int
    is_x: bool


class LeaderboardEntry(BaseModel):
    id: int
    name: str
    lane_shift: str
    total_score: int
    shots_taken: int
