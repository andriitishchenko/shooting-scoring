import re
from pydantic import BaseModel, field_validator, Field
from typing import Optional, Literal, List

# Allowed characters for event codes - alphanumeric uppercase only
_CODE_RE = re.compile(r'^[A-Z0-9]{1,16}$')

# Max lengths for free-text fields
_MAX_NAME   = 120
_MAX_STR    = 60
_MAX_PW     = 64
_MAX_NUMBER = 32

def _clean(s: Optional[str], max_len: int = _MAX_STR) -> Optional[str]:
    """Strip, truncate, return None if empty."""
    if s is None:
        return None
    s = str(s).strip()[:max_len]
    return s or None


# ── Event ──────────────────────────────────────────────────────────────────

class EventCreate(BaseModel):
    code: str
    shots_count: int = Field(default=30, ge=1, le=300)

    @field_validator('code')
    @classmethod
    def validate_code(cls, v: str) -> str:
        v = v.strip().upper()
        if not _CODE_RE.match(v):
            raise ValueError('Code must be 1-16 uppercase alphanumeric characters')
        return v


class EventUpdate(BaseModel):
    shots_count: Optional[int] = Field(default=None, ge=1, le=300)
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
    title: str = Field(min_length=1, max_length=_MAX_STR)
    shots_count: int = Field(default=30, ge=1, le=300)

    @field_validator('title')
    @classmethod
    def clean_title(cls, v: str) -> str:
        return v.strip()[:_MAX_STR]


class DistanceUpdate(BaseModel):
    title: Optional[str] = Field(default=None, max_length=_MAX_STR)
    shots_count: Optional[int] = Field(default=None, ge=1, le=300)
    status: Optional[Literal['pending', 'active', 'finished']] = None

    @field_validator('title')
    @classmethod
    def clean_title(cls, v: Optional[str]) -> Optional[str]:
        return _clean(v)


class DistanceResponse(BaseModel):
    id: int
    title: str
    shots_count: int
    sort_order: int
    status: str


# ── Participant ─────────────────────────────────────────────────────────────

class ParticipantCreate(BaseModel):
    name: str = Field(min_length=1, max_length=_MAX_NAME)
    lane_number: int = Field(ge=1, le=999)
    shift: str = Field(min_length=1, max_length=4)
    gender: Optional[str] = Field(default=None, max_length=_MAX_STR)
    age_category: Optional[str] = Field(default=None, max_length=_MAX_STR)
    shooting_type: Optional[str] = Field(default=None, max_length=_MAX_STR)
    group_type: Optional[str] = Field(default=None, max_length=_MAX_STR)
    personal_number: Optional[str] = Field(default=None, max_length=_MAX_NUMBER)

    @field_validator('name')
    @classmethod
    def clean_name(cls, v: str) -> str:
        return v.strip()

    @field_validator('shift')
    @classmethod
    def clean_shift(cls, v: str) -> str:
        return v.strip().upper()

    @field_validator('gender', 'age_category', 'shooting_type', 'group_type', 'personal_number', mode='before')
    @classmethod
    def clean_optional(cls, v: Optional[str]) -> Optional[str]:
        return _clean(v)


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


# ── Bulk participant import ─────────────────────────────────────────────────

class ParticipantImportRequest(BaseModel):
    """CSV file content sent as a single request body."""
    csv_content: str = Field(min_length=1, max_length=500_000)  # ~500 KB max


class ParticipantImportResult(BaseModel):
    added: int
    failed: int
    errors: List[str]


# ── Results ─────────────────────────────────────────────────────────────────

class ResultCreate(BaseModel):
    participant_id: int = Field(ge=1)
    distance_id: int = Field(ge=1)
    shot_number: int = Field(ge=1, le=300)
    score: int = Field(ge=0, le=10)
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
