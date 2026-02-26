# Shooting Scoring System

Web application for managing and scoring archery/shooting competitions.
Each competition runs as an isolated event with its own SQLite database.
Three distinct roles — **HOST**, **CLIENT**, **VIEWER** — access the same
event via a shared code.

---

## Features

- **Session-based auth** — host, viewer and each lane have independent
  sessions stored in `localStorage`; no passwords appear in HTML or URLs
- **Single-event databases** — one SQLite file per event code; no migrations,
  always created fresh from the current schema
- **Role separation** — host controls everything; clients enter scores for
  their own lane; viewers display the live leaderboard
- **Multi-distance support** — unlimited ordered distances per event
  (e.g. 18 m → 25 m → 30 m), each activated / finished independently
- **Pre-competition roster** — viewer shows participant list sorted by lane
  and shift before the competition starts; switches to ranked leaderboard
  automatically once host starts the event
- **Real-time sync** — WebSocket broadcast from host keeps all clients
  updated on event/distance status and session resets
- **Self-registration control** — host can allow or block clients from
  adding participants; enforced on both server and client side
- **Click-to-copy** — event code and passwords are copyable badges
- **Auto-detect backend** — `config.js` derives API/WS URLs from
  `window.location`; no hard-coded IPs needed

---

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Backend runtime | Python 3.12+ |
| Web framework | FastAPI (async) |
| Database | SQLite via `aiosqlite` |
| Real-time | WebSockets (FastAPI native) |
| Data validation | Pydantic v2 |
| Frontend | Vanilla HTML5 + JS (ES2020) + CSS3 |
| State persistence | `localStorage` |

---

## Project Structure

```
shooting-scoring/
├── backend/
│   ├── app/
│   │   ├── main.py               # FastAPI app, router registration
│   │   ├── config.py             # DATABASE_DIR, ALLOWED_ORIGINS
│   │   ├── database.py           # DatabaseManager, init_db()
│   │   ├── models.py             # Pydantic request/response models
│   │   ├── websocket_manager.py  # In-memory WS connection pool
│   │   └── routers/
│   │       ├── events.py         # CRUD + event lifecycle; event fields
│   │       │                     #   stored as properties (no event table)
│   │       ├── distances.py      # Distances CRUD + status transitions
│   │       ├── participants.py   # Participants CRUD + allow_add check
│   │       ├── results.py        # Shot saving, leaderboard, state restore
│   │       ├── properties.py     # Auth settings (passwords, allow_add)
│   │       ├── sessions.py       # Host/viewer/lane session management
│   │       └── websocket.py      # WS endpoint + message relay
│   ├── databases/                # Created at runtime — one .db per event
│   └── requirements.txt
└── frontend/
    ├── index.html                # Landing page (role selection)
    ├── host.html / host.js       # Host admin panel
    ├── client.html / client.js   # Lane scoring interface
    ├── viewer.html / viewer.js   # Live leaderboard display
    ├── js/
    │   ├── config.js             # API_BASE_URL, WS_BASE_URL (auto-detected)
    │   ├── storage.js            # localStorage helpers (sessions, codes)
    │   ├── api.js                # REST client (APIClient class)
    │   └── websocket.js          # WSClient class
    └── css/
        ├── reset.css
        ├── variables.css         # Design tokens
        ├── main.css
        ├── host.css
        ├── client.css
        └── viewer.css
```

---

## Database Schema

Each event creates `databases/event_{CODE}.db` with these tables:

| Table | Purpose |
|-------|---------|
| `properties` | All event fields + auth settings as key-value pairs |
| `distances` | Ordered distances with `pending / active / finished` status |
| `participants` | Competitor info (name, lane, shift, gender, bow type…) |
| `results` | Individual shot scores (`participant_id, distance_id, shot_number, score, is_x`) |
| `sessions` | Auth tokens per role+identifier (`host/default`, `viewer/default`, `client/{lane}`) |

### Properties keys

| Key | Description |
|-----|-------------|
| `event_code` | Event code (e.g. `ABC123`) |
| `event_status` | `created` / `started` / `finished` |
| `event_shots_count` | Default shots per distance |
| `event_created_at` | ISO timestamp |
| `event_started_at` | ISO timestamp |
| `event_finished_at` | ISO timestamp |
| `host_password` | Required to log in as host |
| `viewer_password` | Optional; blank = public leaderboard |
| `client_allow_add_participant` | `"true"` / `"false"` |

---

## API Reference

### Events
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/events/create` | — | Create event, returns `host_password` + `session_id` |
| `GET` | `/api/events/{code}` | — | Event info |
| `PATCH` | `/api/events/{code}` | Host | Update status / shots_count |

### Sessions
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/sessions/{code}/host` | — | Host login (password or saved session_id) |
| `POST` | `/api/sessions/{code}/viewer` | — | Viewer login |
| `POST` | `/api/sessions/{code}/lane/{n}` | — | Lane session create / auto-login |
| `GET` | `/api/sessions/{code}/lanes` | Host | List lanes with active sessions |
| `DELETE` | `/api/sessions/{code}/lane/{n}` | Host | Reset lane session |

### Distances
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/distances/{code}` | — | List distances |
| `POST` | `/api/distances/{code}` | Host | Add distance |
| `PATCH` | `/api/distances/{code}/{id}` | Host | Update title / shots / status |
| `DELETE` | `/api/distances/{code}/{id}` | Host | Delete pending distance |

### Participants
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/participants/{code}` | — | List (optional `?lane_number=N`) |
| `POST` | `/api/participants/{code}` | Host or lane client* | Add participant |
| `PUT` | `/api/participants/{code}/{id}` | Host | Edit participant |
| `DELETE` | `/api/participants/{code}/{id}` | Host | Delete participant + results |

\* Client POST is rejected with `403` if `client_allow_add_participant = false`

### Results
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/results/{code}/leaderboard` | — | Grouped ranked leaderboard |
| `GET` | `/api/results/{code}/state/{pid}` | — | Full participant state for restore |
| `GET` | `/api/results/{code}/detail/{pid}/{did}` | — | Series detail for host popup |
| `POST` | `/api/results/{code}` | Lane client or Host | Save shots |
| `DELETE` | `/api/results/{code}/{pid}` | Host | Clear participant results |

### Properties
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/properties/{code}` | Host | All settings |
| `PATCH` | `/api/properties/{code}` | Host | Update settings |
| `GET` | `/api/properties/{code}/public` | — | `client_allow_add_participant` |

### WebSocket
```
WS /ws/{code}
```
Messages relayed to all room members:

| `type` | Direction | Payload |
|--------|-----------|---------|
| `event_status` | host → all | `{ status, active_distance_id }` |
| `distance_update` | host → all | `{ distance_id, status }` |
| `refresh` | host → all | — |
| `lane_session_reset` | host → all | `{ lane_number }` |
| `result_update` | client → all | `{ participant_id, total_score }` |

---

## Session Flow

```
HOST creates event
  └─ DB created, host_password generated, host session stored
  └─ Returns: { code, host_password, session_id }

HOST logs in later
  └─ POST /sessions/{code}/host  { session_id: saved }   → auto-login
  └─ POST /sessions/{code}/host  { password: "..." }      → new session_id

CLIENT selects lane N
  └─ POST /sessions/{code}/lane/N  {}
       ├─ No session exists → { status: "created", session_id, password }
       │    CLIENT shows password screen, user writes down password
       ├─ Session exists + saved session_id matches → { status: "ok" }
       └─ Session exists + no match → { status: "password_required" }
            CLIENT prompts for password

HOST resets lane N
  └─ DELETE /sessions/{code}/lane/N   (host session required)
  └─ WS broadcast: { type: "lane_session_reset", lane_number: N }
  └─ CLIENT on lane N clears localStorage, returns to lane selection
```

---

## Running Locally

```bash
# Backend
cd backend
python -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# Frontend is served by FastAPI from /
# Open http://localhost:8000
```

Interactive API docs: `http://localhost:8000/docs`

---

## Configuration

**`backend/app/config.py`**
```python
DATABASE_DIR    = "databases"
ALLOWED_ORIGINS = ["*"]          # restrict in production
```

**`frontend/js/config.js`** — auto-detects from `window.location`:
```js
API_BASE_URL = "http://<host>:<port>/api"
WS_BASE_URL  = "ws://<host>:<port>"
CODE_LENGTH  = 6
```

---

## Deployment (Production)

```bash
# Serve with gunicorn + uvicorn workers
gunicorn app.main:app \
  -w 4 -k uvicorn.workers.UvicornWorker \
  --bind 0.0.0.0:8000

# Reverse proxy (nginx example)
location / {
    proxy_pass http://127.0.0.1:8000;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";   # required for WebSocket
}
```

Recommendations:
- Enable HTTPS (required for secure WebSocket `wss://`)
- Set `ALLOWED_ORIGINS` to your domain
- Schedule periodic backup of `databases/` directory
- Use `loguru` or structured logging for production observability
