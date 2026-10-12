# Shooting Scoring System — Documentation

> Combined Technical Reference & User Guide  
> Version 6 · Updated October 2026

---

## Table of Contents

1. [Overview](#1-overview)
2. [User Guide — HOST](#2-user-guide--host)
3. [User Guide — CLIENT](#3-user-guide--client)
4. [User Guide — VIEWER](#4-user-guide--viewer)
5. [Architecture](#5-architecture)
6. [Database Schema](#6-database-schema)
7. [API Reference](#7-api-reference)
8. [Security Model](#8-security-model)
9. [Deployment](#9-deployment)
10. [CSV Format](#10-csv-format)
11. [Regression Tests](#11-regression-tests)

---

## 1. Overview

The Shooting Scoring System is a web application for managing archery and shooting competitions in real time. Each competition runs as an isolated **event** identified by a short alphanumeric code. Three roles access the event through different browser interfaces:

| Role | Interface | Purpose |
|------|-----------|---------|
| **HOST** | `host.html` | Creates and controls the competition |
| **CLIENT** | `client.html` | Enters shot scores on a specific lane |
| **VIEWER** | `viewer.html` | Displays the live leaderboard on a big screen |

All three interfaces auto-detect the backend URL from `window.location` — no configuration needed after deployment.

---

## 2. User Guide — HOST

### 2.1 Opening Screen

Open `host.html` in a browser, or choose **Host** from the root page. The host screen has two fields: **Event Code** and **Password**.

- **First time** — enter a new six-character code using uppercase letters or digits and click **Create**. A fresh event database is created. The system generates a random admin password shown as a clickable badge in the header — **copy it immediately** and store it safely; it is not shown again. The backend API accepts codes from 1 to 16 characters, but the browser interface uses six characters by default (`CODE_LENGTH` in `frontend/js/config.js`).
- Before creating, the page checks whether the code already exists. A `404 Event not found` for a new code is expected and opens the create confirmation. If you expect an existing event, check the code and that the page is connected to the server holding its database.
- **Returning** — the page auto-logs in using the saved session in browser storage. If storage was cleared, enter the code and password manually.

### 2.2 Header Bar

Once logged in, the header shows:

| Element | Description |
|---------|-------------|
| `Code: XXXXXX` badge | Click to copy the event code to clipboard |
| `🔑 XXXXXXXX` badge | Click to copy the host password to clipboard |
| Event status pill | `Not Started` / `In Progress` / `Finished` |
| **⚙ Settings** | Open the settings modal |
| **Share Links** | Copy direct URLs for CLIENT and VIEWER |
| **Exit** | Clear session and return to login |

### 2.3 Tabs

The admin panel has four tabs:

#### Participants Tab

Shows all registered participants grouped by lane. Lanes that have an active client session are highlighted with a 🔑 badge even if they have no participants yet.

**Actions:**
- **Add Participant** — opens a modal form. Fields: Name (required), Lane Number (required), Shift (required, one character in the form), Gender, Age Category, Bow Type, Group, Personal Number.
- **✎ Edit** — edit any participant's details.
- **🗑** — delete a participant and all their results.
- **Reset Session** (per lane) — removes that lane's session; the connected client is sent back to lane selection.
- **Import CSV** — parse a CSV file on the server in one request; all valid rows are inserted in a single transaction (see §10 for format).
- **Export CSV** — download all participants (including those with no scores) as a CSV file. Scored participants have rank and score columns filled; unscored participants have those columns empty.

#### Distances Tab

Distances define the shooting stages of the event. At least one distance always exists.

**Lifecycle:** `pending` → `active` → `finished`. A finished distance cannot be reactivated.

- **Add Distance** — adds a new pending distance at the end.
- **Edit title / shots count** — only allowed while the distance is `pending`.
- **Activate** — marks the distance as `active` (only one can be active at a time; activating automatically finishes any previously active distance). Requires the event to be `started`.
- **Finish** — marks the active distance as `finished`. Lane clients cannot edit it after the competition finishes; the host can correct its scores from the results detail popup.
- **Delete** — only pending distances can be deleted; the last distance cannot be removed.

#### Results Tab

Shows a ranked table grouped by gender + bow type. Columns: Rank, Name, Lane, per-distance scores, Total, Avg, X-count, 10-count. Clicking a per-distance score cell opens a **detail popup** showing the full series breakdown. The host can correct an existing score, enter a missed shot, or clear a shot from this popup, including after the competition has finished.

#### Distances / Status Controls

- **▶ Start Event** — transitions status from `created` to `started`. Clients can now activate distances and enter scores.
- **⏹ Finish Event** — transitions to `finished`. All active distances are auto-finished. Lane clients can no longer change scores; the host can still correct them from the results detail popup. The event cannot be restarted.

### 2.4 Settings Modal

| Setting | Description |
|---------|-------------|
| Host Password | Password required to log in as host. Clear to disable authentication (not recommended). |
| Viewer Password | If set, viewers must enter this password. Clear for a public leaderboard. |
| Allow clients to self-register | When unchecked, clients cannot add participants on their own lane — only the host can add participants. Enforced server-side. |

After saving, a WebSocket `refresh` message is broadcast so connected hosts and lane clients re-fetch the setting.

---

## 3. User Guide — CLIENT

### 3.1 Opening Screen

Open `client.html`. Enter the event code (given by the host) and tap **Enter Event**.

### 3.2 Lane Selection

A grid of lane buttons is shown. Tap the lane you are sitting on.

**Three outcomes:**

| Outcome | What happens |
|---------|-------------|
| **New lane** | A session is created. A password screen appears showing your 6-character lane password. Write it down — you will need it if you reload the page or switch devices. Tap the password to copy it. |
| **Your lane** (session remembered) | Auto-login — you go straight to the participants screen. |
| **Lane occupied** | A password prompt appears. Enter the password shown when you first connected. |

### 3.3 Participants Screen

Lists all participants on your lane with their current scores per distance. Tap a participant's card to open the score entry screen.

- **Add Participant** — visible only before the competition starts and only if the host allows self-registration. Fill in name (required), shift, and optional details.
- **Back** — return to lane selection (does not reset your session).

### 3.4 Score Entry Screen

Shows a grid of shot slots organised in series of 3.

- Tap an **empty slot** to select it (highlighted in blue).
- Tap a **score button** (M, 1–10, X) to record the score. The slot fills, the series total and cumulative total update.
- Tap a **filled slot** to re-select it, then tap a different score button to correct it.
- **X** counts as 10 points with the X flag set.
- **M** counts as 0 (miss).
- Each score change is saved in the browser and sent to the server as a replacement of the full distance score set. If the connection drops, pending scores remain on that device and retry when the connection returns while the event is started.
- When the host finishes the last active distance, the screen returns to the participants list. Finishing the event also displays an alert. Pending unsent scores remain on the device for recovery; lane clients cannot submit them after the event is finished.

---

## 4. User Guide — VIEWER

### 4.1 Opening Screen

Open `viewer.html`. Enter the event code and tap **Enter**. If a viewer password is set, a password prompt appears.

The page auto-reconnects from browser storage on refresh.

### 4.2 Pre-Competition Roster

While the event status is `created` (not yet started), the viewer displays all registered participants sorted by **lane number** then **shift**. Each participant shows name, lane/shift, and optional metadata (gender, bow type, etc.). This is useful for projecting on a screen in the shooting hall before the competition begins.

### 4.3 Live Leaderboard

Once the host starts the event, the display switches automatically (within 2 minutes) to the ranked leaderboard. There is no WebSocket connection in the viewer — the page polls every **2 minutes**.

**Layout:**

- Participants are grouped by gender + bow type (e.g., "MEN - RECURVE").
- Within each group, participants are ranked by **total score** descending.
- Top 3 rows in each group are highlighted with a gold left border.
- If multiple distances are active/finished, per-distance scores appear inline.
- Shots taken vs. maximum (e.g., `18/30`) are shown for each distance.
- The page auto-scrolls continuously; it resets to the top when it reaches the bottom.

### 4.4 Exit

Tap the **Exit** button (top right) to return to the code entry screen.

---

## 5. Architecture

### Technology Stack

| Layer | Technology |
|-------|-----------|
| Backend runtime | Python 3.12+ |
| Web framework | FastAPI (async) |
| Database | SQLite via `aiosqlite` |
| Real-time | Authenticated WebSockets for event sessions; the viewer page polls |
| Data validation | Pydantic v2 with field validators |
| Frontend | Vanilla HTML5 + ES2020 + CSS3 |
| State persistence | `localStorage` |

### File Layout

```
shooting-scoring/
├── backend/
│   ├── app/
│   │   ├── main.py               # App factory, router registration, CORS
│   │   ├── config.py             # DATABASE_DIR, ALLOWED_ORIGINS (env-configurable)
│   │   ├── database.py           # DatabaseManager + path-traversal guard
│   │   ├── models.py             # Pydantic models with full validation
│   │   ├── websocket_manager.py  # Per-event sockets and DB-backed worker fan-out
│   │   └── routers/
│   │       ├── events.py         # Event lifecycle; event fields in properties table
│   │       ├── distances.py      # Distance CRUD + status transitions
│   │       ├── participants.py   # Participant CRUD + bulk CSV import + allow_add guard
│   │       ├── results.py        # Shot saving, leaderboard, state restore, detail
│   │       ├── properties.py     # Auth settings (typed Pydantic model)
│   │       ├── sessions.py       # Host/viewer/lane sessions; timing-safe compares
│   │       └── websocket.py      # Authenticated WS endpoint
│   ├── databases/                # One .db file per event (created at runtime)
│   └── requirements.txt
└── frontend/
    ├── index.html                # Role selection landing page
    ├── host.html / host.js       # Host admin panel
    ├── client.html / client.js   # Lane scoring interface
    ├── viewer.html / viewer.js   # Leaderboard display
    ├── js/
        ├── config.js             # Auto-detects API_BASE_URL and WS_BASE_URL
        ├── storage.js            # localStorage helpers (never exposes tokens in DOM)
        ├── api.js                # APIClient class (all REST calls)
        └── websocket.js          # Authenticated WSClient class
    └── tests/
        └── client.test.js        # Score recovery regression tests
```

### Request Flow

```
Browser                          FastAPI                        SQLite
  │                                 │                              │
  │── POST /api/events/create ──────▶│  init_db(), write props      │
  │◀─ { code, host_password,        │─────────────────────────────▶│
  │     session_id }                │                              │
  │                                 │                              │
  │── POST /api/sessions/{c}/host ──▶│  compare_digest(pw)          │
  │◀─ { ok, session_id }            │─────────────────────────────▶│
  │                                 │                              │
  │── PATCH /api/events/{c}         │                              │
  │   X-Session-Id: <token> ────────▶│  require_session() → UPDATE  │
  │◀─ { message }                   │─────────────────────────────▶│
  │                                 │                              │
  │── WS /ws/{code} ────────────────▶│  validate session token      │
  │   {type: authenticate,          │  manager.connect()           │
  │    session_id: …}               │                              │
  │◀─ {type: authenticated, role}   │                              │
  │                                 │  DB notification → workers   │
  │                                 │  → connected clients         │
```

### WebSocket Message Types

The first client frame must authenticate the socket with a valid session token
for that event. The server sends notifications after authorized API changes;
client frames cannot publish room notifications. Notifications are stored in
the event database and polled by each server worker, so connected clients on
different workers receive the same updates.

| `type` | Sent by | Payload fields | Client reaction |
|--------|---------|---------------|-----------------|
| `event_status` | Server | `status` | Re-fetch distances, update UI, show/hide controls |
| `distance_update` | Server | `distance_id`, `status` | Re-fetch distances and refresh the score grid |
| `refresh` | Server | — | Re-fetch participants and public properties |
| `lane_session_reset` | Server | `lane_number` | Affected client clears its session and returns to lane selection |
| `result_update` | Server | `participant_id`, `total_score` | Refresh affected scores |

---

## 6. Database Schema

Each event has its own SQLite file at `databases/event_{CODE}.db`. New files are created with the current schema. When any event database is opened, the application also ensures the `event_notifications` table exists so existing databases can use cross-worker WebSocket updates. There is no general schema migration framework.

### `properties` (key-value store)

| Key | Type | Description |
|-----|------|-------------|
| `event_code` | TEXT | The event code |
| `event_status` | TEXT | `created` / `started` / `finished` |
| `event_shots_count` | TEXT | Default shots per distance |
| `event_created_at` | TEXT | ISO 8601 timestamp |
| `event_started_at` | TEXT | ISO 8601 timestamp |
| `event_finished_at` | TEXT | ISO 8601 timestamp |
| `host_password` | TEXT | Admin password (plaintext, bcrypt not required at this scale) |
| `viewer_password` | TEXT | Viewer password (empty = public) |
| `client_allow_add_participant` | TEXT | `"true"` / `"false"` |

### `distances`

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | INTEGER | PK AUTOINCREMENT |
| `title` | TEXT | NOT NULL |
| `shots_count` | INTEGER | NOT NULL DEFAULT 30 |
| `sort_order` | INTEGER | NOT NULL DEFAULT 0 |
| `status` | TEXT | `pending` / `active` / `finished` |

### `participants`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER | PK AUTOINCREMENT |
| `name` | TEXT | NOT NULL, max 120 chars |
| `lane_number` | INTEGER | 1–999 |
| `shift` | TEXT | 1–4 chars, uppercase |
| `gender` | TEXT | optional |
| `age_category` | TEXT | optional |
| `shooting_type` | TEXT | optional (bow type) |
| `group_type` | TEXT | optional |
| `personal_number` | TEXT | optional, max 32 chars |

### `results`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER | PK AUTOINCREMENT |
| `participant_id` | INTEGER | FK → participants |
| `distance_id` | INTEGER | FK → distances |
| `shot_number` | INTEGER | 1–300 |
| `score` | INTEGER | 0–10 |
| `is_x` | BOOLEAN | 1 if X (10 with X flag) |
| `created_at` | TIMESTAMP | auto |
| UNIQUE | — | `(participant_id, distance_id, shot_number)` — upserted for individual saves; full sets can be replaced |

### `sessions`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER | PK |
| `role` | TEXT | `host` / `viewer` / `client` |
| `identifier` | TEXT | `default` for host/viewer; lane number for client |
| `session_id` | TEXT | 40-char hex token (UNIQUE) |
| `password` | TEXT | stored for reference |
| UNIQUE | — | `(role, identifier)` — one session per role+lane |

### `event_notifications`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER | PK AUTOINCREMENT, used as each worker's polling cursor |
| `payload` | TEXT | JSON server notification |
| `created_at` | TIMESTAMP | auto |

Each worker reads new notification rows and forwards them to its connected
clients. The table is created automatically when an existing event database
is opened.

---

## 7. API Reference

All endpoints are prefixed `/api`. Auth is via the `X-Session-Id` header.

### Events

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/events/create` | — | Create event, returns `{ code, host_password, session_id }` |
| GET | `/events/{code}` | — | Get event info |
| PATCH | `/events/{code}` | Host | Update `status` and/or `shots_count` |
| GET | `/health` | — | Health status |

### Sessions

| Method | Path | Auth | Body | Description |
|--------|------|------|------|-------------|
| POST | `/sessions/{code}/host` | — | `{ password?, session_id? }` | Login; session_id for auto-login |
| POST | `/sessions/{code}/viewer` | — | `{ password?, session_id? }` | Login; returns `has_password` |
| POST | `/sessions/{code}/lane/{n}` | — | `{ password?, session_id? }` | Create or join lane session |
| GET | `/sessions/{code}/lanes` | Host | — | List lane numbers with active sessions |
| DELETE | `/sessions/{code}/lane/{n}` | Host | — | Reset lane session |

Lane session response has `status`:
- `"created"` — new session, returns `session_id` + `password`
- `"ok"` — auto-login succeeded, returns `session_id`
- `"password_required"` — lane exists, password needed

### Distances

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/distances/{code}` | — | List all distances |
| POST | `/distances/{code}` | Host | Add distance `{ title, shots_count }` |
| PATCH | `/distances/{code}/{id}` | Host | Update a pending distance's title/shot count or transition its status |
| DELETE | `/distances/{code}/{id}` | Host | Delete a pending distance with no scores when another distance remains |

### Participants

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/participants/{code}` | — | List all (optional `?lane_number=N`) |
| POST | `/participants/{code}` | Host or lane client* | Add one participant before the event starts |
| POST | `/participants/{code}/import` | Host | Bulk import `{ csv_content: "..." }` |
| PUT | `/participants/{code}/{id}` | Host | Update participant before the event starts |
| DELETE | `/participants/{code}/{id}` | Host | Delete participant + results before the event starts |

\* Client POST returns `403` if `client_allow_add_participant = false`

Bulk import response: `{ added: N, failed: N, errors: ["Row 3: ..."] }`

### Results

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/results/{code}/leaderboard` | — | Grouped leaderboard (participants with scores only) |
| GET | `/results/{code}/state/{pid}` | — | Per-distance state for client restore; shot details are omitted for finished distances |
| GET | `/results/{code}/detail/{pid}/{did}` | — | Read-only series detail used by the host editor |
| POST | `/results/{code}` | Participant's lane or Host | Upsert shots `[{ participant_id, distance_id, shot_number, score, is_x }]` during a started event; the host can also submit after it finishes |
| PUT | `/results/{code}/participant/{pid}/distance/{did}` | Participant's lane or Host | Replace the full set with `{"shots": [...]}`; `{"shots": []}` clears the series. Host can edit after event finish. |
| DELETE | `/results/{code}/{pid}` | Host | Clear all results for a participant |

### Properties

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/properties/{code}` | Host | Get `host_password`, `viewer_password`, `client_allow_add_participant` |
| PATCH | `/properties/{code}` | Host | Update any of the above |
| GET | `/properties/{code}/public` | — | Get `client_allow_add_participant` only |

### WebSocket

```
WS  /ws/{code}
```

Authenticate the first frame with `{"type":"authenticate","session_id":"…"}`.
The server replies with the authenticated role and sends authorized event
notifications to all connections in the room. Client frames do not trigger
broadcasts. A valid host, viewer, or lane session for the event is required.
See §5 for message types.

---

## 8. Security Model

### Session Tokens

- Generated with `secrets.token_hex(20)` — 40 hex characters, 160 bits of entropy.
- Stored only in `localStorage` (never in HTML attributes, URL query strings, or cookies).
- Validated on every mutating request via `X-Session-Id` header.
- All comparisons use `secrets.compare_digest()` to prevent timing attacks.

### Password Storage

Host and viewer passwords are stored in plaintext in the `properties` table; lane passwords are stored in plaintext in `sessions`. Protect the event database files accordingly.

### Input Validation

All inputs are validated with Pydantic v2 before reaching business logic:

| Field | Constraint |
|-------|-----------|
| Event code | Regex `^[A-Z0-9]{1,16}$` — no path traversal possible |
| Name | max 120 chars, trimmed |
| Passwords | max 64 chars |
| `shots_count` | 1–300 |
| `lane_number` | 1–999 |
| `shift` | 1–4 characters; uppercased |
| `score` | 0–10 |
| `shot_number` | 1–300 |
| CSV content | max 500 KB, max 500 rows |

### Path Traversal Prevention

`DatabaseManager.__init__` validates the event code against the regex allowlist AND resolves `os.path.realpath()` on the constructed path, asserting it starts with the `DATABASE_DIR` prefix. Both checks must pass.

### XSS Prevention

All user-supplied strings rendered via `innerHTML` are passed through `escHtml()` (escapes `&`, `<`, `>`, `"`, `'`). Event delegation is used instead of inline `onclick` attribute strings to avoid JS injection via participant names.

### CSV Formula Injection

The `csvField()` function in the export logic prefixes formula-trigger characters (`=`, `+`, `-`, `@`, TAB, CR) with a literal `'` so spreadsheet applications do not interpret them as formulas.

### `client_allow_add_participant`

Enforced on the server in `POST /participants/{code}`. A client with a valid lane session receives `403 Self-registration is disabled by the host` regardless of what the client-side UI shows.

---

## 9. Deployment

### Local Development

```bash
cd backend
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
# Open http://localhost:8000
```

Interactive API docs at `http://localhost:8000/docs`.

### Production

```bash
# Run without the development auto-reloader
cd backend
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

**Nginx reverse proxy** (required for WebSocket upgrade):

```nginx
server {
    listen 80;
    server_name your.domain.com;

    location / {
        proxy_pass         http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_read_timeout 3600s;
    }
}
```

### Configuration

**`backend/app/config.py`** (or environment variables):

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_DIR` | `./databases` | Directory for SQLite files |
| `ALLOWED_ORIGINS` | `["*"]` | CORS allowed origins — restrict in production |

Settings can also be read from a `.env` file in the process working directory.

**`frontend/js/config.js`** auto-derives URLs from `window.location`. No manual configuration needed. `CODE_LENGTH` defaults to 6.

---

### Database Backup

```bash
# Simple: copy the databases directory
cp -r databases/ backup/databases_$(date +%Y%m%d)/

# Or use SQLite's online backup tool
sqlite3 databases/event_MYCODE.db ".backup backup/event_MYCODE_$(date +%Y%m%d).db"
```

---

## 10. CSV Format

### Import (Participants)

The CSV must have a **header row**. Column order is fixed. Whitespace around values is stripped.

```
name,lane,shift,gender,age_category,shooting_type,group,personal_number
Alice Smith,1,A,female,senior,recurve,club,101
Bob Jones,2,A,male,junior,compound,,
Carol Brown,2,B,female,,barebow,,
```

| Column | Required | Max length | Notes |
|--------|----------|-----------|-------|
| `name` | ✅ | 120 | Any text |
| `lane` | ✅ | — | Integer 1–999 |
| `shift` | ✅ | 4 | Uppercased automatically |
| `gender` | — | 60 | e.g. `male`, `female` |
| `age_category` | — | 60 | e.g. `senior`, `junior` |
| `shooting_type` | — | 60 | e.g. `recurve`, `compound`, `barebow` |
| `group` | — | 60 | Imported into the participant's `group_type` field |
| `personal_number` | — | 32 | Athlete ID |

Limits: max **500 KB** file size, max **500 rows** per request. The server processes all valid rows in one database transaction and returns `{ added, failed, errors }`. Headers are case-insensitive and surrounding spaces are trimmed. The results export is a separate report format and is not directly accepted as an import file.

### Export (Results)

All participants are exported regardless of whether scores have been entered. Sorted by lane number, then shift.

```
Rank,Name,Lane,Shift,Gender,BowType,Group,AgeCategory,PersonalNo,[Distance cols...],Total,Avg,X,10
1,"Alice Smith",1,A,female,recurve,club,senior,101,285,287,572,9.53,8,12
,"Bob Jones",2,A,male,compound,,,,,,,,,
```

- **Rank** — position within the participant's gender+bow group; blank if no scores.
- **Distance columns** — one column per active/finished distance; blank if not scored.
- **Total / Avg / X / 10** — blank for unscored participants.
- File is UTF-8 with BOM so Excel opens it correctly without import dialogs.

---

## 11. Regression Tests

Run the API and score recovery tests from the repository root. Install the
Python dependencies from `backend/requirements.txt` in the Python environment
used for development before running pytest. The frontend tests use Node's
built-in test runner.

```bash
cd backend
python -m pytest -q tests/test_backend.py
cd ..
node --test frontend/tests/client.test.js
```

The backend suite covers event and distance lifecycle rules, session and
WebSocket authorization, participant restrictions, and result replacement.
The frontend suite covers queued score saves, including offline and cleared
series behavior.
