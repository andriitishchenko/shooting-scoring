# Shooting Scoring System

Web application for managing and scoring archery/shooting competitions.
Each competition runs as an isolated event with its own SQLite database.
Three distinct roles — **HOST**, **CLIENT**, **VIEWER** — access the same
event via a shared code.

---

## Features

- **Session-based auth** — host, viewer and each lane have independent
  sessions stored in `localStorage`; credentials are not embedded in static
  page source or URLs
- **Single-event databases** — one SQLite file per event code; new databases
  use the current schema, and existing databases gain the notification table
  automatically when opened
- **Role separation** — host controls everything; clients enter scores for
  their own lane; viewers display the live leaderboard
- **Multi-distance support** — unlimited ordered distances per event
  (e.g. 18 m → 25 m → 30 m), each activated / finished independently
- **Pre-competition roster** — viewer shows participant list sorted by lane
  and shift before the competition starts; switches to ranked leaderboard
  automatically once host starts the event
- **Real-time sync** — authenticated WebSockets receive server-side updates
  for event and distance status, roster changes, scores, and lane resets
- **Offline score recovery** — score changes stay in the lane browser until
  the server confirms them, then retry when connectivity returns
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
│   │   ├── websocket_manager.py  # Per-event WS connections and DB-backed fan-out
│   │   └── routers/
│   │       ├── events.py         # CRUD + event lifecycle; event fields
│   │       │                     #   stored as properties (no event table)
│   │       ├── distances.py      # Distances CRUD + status transitions
│   │       ├── participants.py   # Participants CRUD + allow_add check
│   │       ├── results.py        # Shot saving, leaderboard, state restore
│   │       ├── properties.py     # Auth settings (passwords, allow_add)
│   │       ├── sessions.py       # Host/viewer/lane session management
│   │       └── websocket.py      # Authenticated WS endpoint
│   ├── databases/                # Created at runtime — one .db per event
│   └── requirements.txt
└── frontend/
    ├── index.html                # Landing page (role selection)
    ├── host.html                 # Host admin panel
    ├── client.html               # Lane scoring interface
    ├── viewer.html               # Live leaderboard display
    ├── js/
    │   ├── config.js             # API_BASE_URL, WS_BASE_URL (auto-detected)
    │   ├── storage.js            # localStorage helpers (sessions, codes)
    │   ├── api.js                # REST client (APIClient class)
    │   ├── websocket.js          # WSClient class
    │   ├── host.js               # Host UI and result corrections
    │   ├── client.js             # Lane scoring and offline recovery
    │   └── viewer.js             # Leaderboard UI
    ├── css/
        ├── reset.css
        ├── variables.css         # Design tokens
        ├── main.css
        ├── host.css
        ├── client.css
        └── viewer.css
    └── tests/
        ├── client.test.js        # Client reconnect and offline score tests
        └── host.test.js          # Host result editing regression tests
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
| `event_notifications` | Server-generated updates shared across server workers |

The notification table is also created automatically when an existing event
database is opened. Other schema changes do not have a general migration
system.

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
| `GET` | `/api/health` | — | Health status |

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
| `GET` | `/api/results/{code}/state/{pid}` | — | Participant state for restore; shot details are omitted for finished distances |
| `GET` | `/api/results/{code}/detail/{pid}/{did}` | — | Series detail for host popup |
| `POST` | `/api/results/{code}` | Lane client or Host | Save a non-empty shot batch; an empty batch returns `422` |
| `PUT` | `/api/results/{code}/participant/{pid}/distance/{did}` | Participant's lane or Host | Replace `{ "shots": [...] }`; `{ "shots": [] }` clears the series |
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

After opening the socket, send `{"type":"authenticate","session_id":"…"}`.
The server validates the event session and replies with
`{"type":"authenticated","role":"…"}`. The server owns room notifications;
client messages cannot publish updates. Notifications are stored per event so
connections on separate server workers receive the same updates.

Lane clients keep pending score changes in browser storage and retry the full
distance score set when the event is started and the server is reachable. Each
pending set is tied to the lane session that created it; data left by an older
session is not merged into or sent by a new session. A successful replacement
removes the pending local copy. A finished event rejects client score changes;
the host can still correct scores through the results detail view. Empty cells
for active or finished distances can be opened to add a missed result.

| `type` | Direction | Payload |
|--------|-----------|---------|
| `event_status` | server → all | `{ status }` |
| `distance_update` | server → all | `{ distance_id, status }` |
| `refresh` | server → all | — |
| `lane_session_reset` | server → all | `{ lane_number }` |
| `result_update` | server → all | `{ participant_id, total_score }` |

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
DATABASE_DIR    = "./databases"
ALLOWED_ORIGINS = ["*"]          # restrict in production
```

**`frontend/js/config.js`** — auto-detects from `window.location`:
```js
API_BASE_URL = "http://<host>:<port>/api"
WS_BASE_URL  = "ws://<host>:<port>"
CODE_LENGTH  = 6
```

The browser interface requires a six-character event code by default. The API
accepts uppercase letters and digits from 1 to 16 characters.

`DATABASE_DIR` and `ALLOWED_ORIGINS` can be set as environment variables or in
a `.env` file in the server's working directory. For a public deployment, set
CORS to the exact origin serving the browser application. `ALLOWED_ORIGINS` is
a JSON array:

```bash
export ALLOWED_ORIGINS='["https://scores.example.org"]'
export DATABASE_DIR='/srv/shooting-scoring/databases'
```

---

## Tests

Run the backend API regression tests from `backend/` with the project's Python
dependencies installed, then run all frontend regression tests from the
repository root:

```bash
cd backend
python -m pytest -q tests
cd ..
node --test frontend/tests/*.test.js
```

---

## Deployment (Production)

```bash
# Run from backend/ without the development auto-reloader.
# Use a process manager or service unit to keep the server running.
cd backend
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Nginx reverse proxy example (replace the certificate paths with your TLS
certificate paths):

```nginx
server {
    listen 80;
    server_name scores.example.org;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name scores.example.org;
    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}
```

Recommendations:
- Enable HTTPS (required for secure WebSocket `wss://`)
- Set `ALLOWED_ORIGINS` to the exact application origin
- Keep `DATABASE_DIR` on persistent storage and restrict access to database files
- Back up event databases regularly; use SQLite's online backup while the server is running
- Audit pinned and resolved Python dependencies for known security issues; retest after dependency updates
- Smoke-test the deployed server, including WebSocket connection and score entry
