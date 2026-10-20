# Shooting Scoring System — Documentation

> Combined Technical Reference & User Guide  
> Version 7 · Updated October 2026 · Node.js server

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

- **First time** — enter a new six-character code using uppercase letters or digits and click **Create**. A fresh event database is created. The system generates a 16-character host password shown as a clickable badge in the header. Copy it and store it safely outside the browser. The password is saved in this browser's local storage and the badge remains visible while that local copy exists; clearing browser storage removes the local copy. The backend API accepts codes from 1 to 16 characters, but the browser interface uses six characters by default (`CODE_LENGTH` in `frontend/js/config.js`).
- Before creating, the page checks whether the code already exists. A `404 Event not found` for a new code is expected and opens the create confirmation. If you expect an existing event, check the code and that the page is connected to the server holding its database.
- **Returning** — the page auto-logs in using the saved session in browser storage. If storage was cleared, enter the code and password manually.

### 2.2 Header Bar

Once logged in, the header shows:

| Element | Description |
|---------|-------------|
| `Code: XXXXXX` badge | Click to copy the event code to clipboard |
| `🔑` password badge | Click to copy the host password to clipboard |
| Event status pill | `Not Started` / `In Progress` / `Finished` |
| **⚙ Settings** | Open the settings modal |
| **Share Links** | Copy direct URLs for CLIENT and VIEWER |
| **Exit** | Clear session and return to login |

### 2.3 Tabs

The admin panel has four tabs:

#### Participants Tab

Shows all registered participants grouped by lane. Lanes that have a password (a client opened them) are highlighted with a 🔑 badge even if they have no participants yet. The lane password (6 characters) shows next to the badge, so you can give it to a person who lost it.

**Actions:**
- **Add Participant** — opens a modal form. Fields: Name (required), Lane Number (required), Shift (required, one character in the form), Gender, Age Category, Bow Type, Group, Personal Number.
- **✎ Edit** — edit any participant's details.
- **🗑** — delete a participant and all their results.
- **Reset Session** (per lane) — removes that lane's session; the connected client is sent back to lane selection.
- **Lane password** — shows next to the 🔑 badge. Double-click it to copy it.
- **Reset requested** — a lane that lost its password asks for a reset. A banner at the top of the tab and a yellow label at the lane show the request. **Approve** asks for confirmation. The lane gets a new password, and the devices that use the lane now are disconnected. **Deny** changes nothing. Only approve a request when you know that a person at the lane asked.
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

Shows a ranked table grouped by gender + bow type. Columns: Rank, Name, Lane, per-distance scores, Total, Avg, X-count, 10-count. During a started or finished event, the host table also includes participants who have no saved scores yet. Clicking a per-distance score cell opens a **detail popup** showing the full series breakdown. Empty cells for active or finished distances are clickable, so the host can enter a missed result. The host can correct or clear a shot from this popup, including after the competition has finished. The UI serializes full-series replacements so two rapid corrections cannot submit competing snapshots.

#### Distances / Status Controls

- **▶ Start** — transitions status from `created` to `started`. Clients can now activate distances and enter scores.
- **⏹ Finish Event** — transitions to `finished`. All active distances are auto-finished. Lane clients can no longer change scores; the host can still correct them from the results detail popup. The event cannot be restarted.

### 2.4 Settings Modal

| Setting | Description |
|---------|-------------|
| Host Password | Enter a new password of at least 12 characters; leave blank to keep the current password. Host password protection is always enabled. A new password ends the host sessions on all other devices. |
| Viewer Password | Enter a new password of at least 12 characters, or enable public viewing. Leave blank to keep the current setting. A new password ends the viewer sessions. The viewers must enter the new password. |
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
| **New lane** | A session is created. A password screen appears showing your lane password (6 characters). Write it down — you will need it if you reload the page or switch devices. Tap the password to copy it. |
| **Your lane** (session remembered) | Auto-login — you go straight to the participants screen. |
| **Lane occupied** | A password prompt appears. Enter the password shown when you first connected. If you lost it, tap **Request password**. The page waits while the host decides. If the host approves, the page shows a new password, like on the first entry. If the host denies, or the request ends after 15 minutes, the page says so and you can ask again. A reload does not cancel the request. The other devices on this lane are disconnected after an approval. |

### 3.3 Participants Screen

Lists all participants on your lane with their current scores per distance. Each distance tag shows the score and the number of results that are entered, for example `18 m: 87 · 9/30` (9 of 30 shots). A distance that did not start shows `—` and `0/30`. Tap a participant's card to open the score entry screen.

- **Add Participant** — visible only before the competition starts and only if the host allows self-registration. Fill in name (required), shift, and optional details.
- **Back** — return to lane selection (does not reset your session).

### 3.4 Score Entry Screen

Shows a grid of shot slots organised in series of 3.

- Tap an **empty slot** to select it (highlighted in blue).
- Tap a **score button** (M, 1–10, X) to record the score. The slot fills, the series total and cumulative total update.
- Tap a **filled slot** to re-select it, then tap a different score button to correct it. Tap the selected slot again to clear it.
- The **⌫** button deletes the shot that the user entered last.
- Each series shows its shots in order from the highest to the lowest (for example `10 9 5`, `5 2 0`, or `X 10 10`). An X is above a 10. When the user enters or clears a shot, the series is ordered again, and the shots use the first places of the series. Shots that come from the server and corrections of the host (in the results details) follow the same rule.
- **X** counts as 10 points with the X flag set.
- **M** counts as 0 (miss).
- Each score change is saved in the browser and sent to the server as a replacement of the full distance score set. If the connection drops, pending scores remain on that device and retry when the connection returns while the event is started. Pending sets are tied to the lane session that recorded them; a new session ignores unsent data from an older session.
- When the host finishes the last active distance, the screen returns to the participants list. Finishing the event also displays an alert. The server does not accept scores from a lane after the event finished. The page moves the unsent scores to an archive on the device and shows the button **Download unsent scores**. The button saves them as a JSON file for recovery. The host can enter them again in the results view.

---

### 3.5 Practice (no server)

PRACTICE counts the score of one person on one device. It does not use a server.
It needs no event code, no password, and no session. It sends no data to a server.

1. On the home page, tap **PRACTICE**. The page `practice.html` opens.
2. Enter the number of arrows. The default is 30. The limit is 300.
3. Tap **Start**. The score form is the same as the CLIENT form: series of 3
   shots, the score buttons, **⌫**, and the same ordering of each series.
4. Tap the score buttons to enter the shots.
5. The page shows the total, the number of 10s, the number of X, and the number
   of arrows that the user entered.

The browser saves the list after each shot. When the user reloads or closes the
page, the list stays. The list stays until the user ends the count. To end the
count, tap **New** and confirm. The list is deleted and the start screen shows.

The page can also open without a network. Open the home page or the practice
page one time with a connection. The service worker `sw.js` then keeps the
files of these two pages on the device. A service worker works only on HTTPS
or on `localhost`. On a plain HTTP address (for example `http://192.168.1.10:8000`),
the page needs the network to open.

If the network does not answer in 3 seconds, or the server returns an error,
the page opens from the saved files. Other pages and the API are not affected.

---

## 4. User Guide — VIEWER

### 4.1 Opening Screen

Open `viewer.html`. Enter the event code and tap **Enter**. If a viewer password is set, a password prompt appears.

The page logs in again from the browser storage after a reload. If the host changes the viewer password, the page asks for the new password.

### 4.2 Pre-Competition Roster

While the event status is `created` (not yet started), the viewer displays all registered participants sorted by **lane number** then **shift**. Each participant shows name, lane/shift, and optional metadata (gender, bow type, etc.). This is useful for projecting on a screen in the shooting hall before the competition begins.

### 4.3 Live Leaderboard

Once the host starts the event, the display switches automatically to the ranked leaderboard. The viewer page receives a message from the server after each change and loads the data again (many messages cause one load). As a backup, the page also loads the data every **2 minutes**.

**Layout:**

- Participants are grouped by gender + bow type (e.g., "MEN - RECURVE").
- Within each group, participants are ranked by **total score** descending. Equal scores are ranked by the number of **10s** (an X is a 10), then by the number of **X**. Participants that are equal in all three values share a rank (1, 1, 3).
- Top 3 rows in each group are highlighted with a gold left border.
- If multiple distances are active/finished, per-distance scores appear inline.
- Shots taken vs. maximum (e.g., `18/30`) are shown for each distance.
- The page scrolls by itself. It goes back to the top when it reaches the bottom.
- The switch **Auto-scroll** (next to **Exit**) turns the scroll off. Then the user can scroll to a section and read it. The browser keeps the choice. When the user turns the scroll on, it continues from the current position.

### 4.4 Exit

Tap the **Exit** button (top right) to return to the code entry screen.

---

## 5. Architecture

### Technology Stack

| Layer | Technology |
|-------|-----------|
| Server runtime | Node.js 24, one process |
| HTTP | `node:http` with a small router (`src/http/router.js`) |
| Database | SQLite (`node:sqlite`), one file for each event, WAL mode |
| Live updates | WebSocket (`ws`) |
| Input checks | Schemas in `src/routes.js` and `src/http/validate.js` |
| Password hashes | scrypt (`node:crypto`) |
| Frontend | HTML, JavaScript (ES2020), CSS. No build step. |
| Browser storage | `localStorage` |

### File Layout

```
backend-node/
├── src/
│   ├── server.js          Start, signals, orderly stop
│   ├── app.js             Builds the server from the parts
│   ├── config.js          Settings (environment and .env)
│   ├── routes.js          Routes, schemas, and the role that each route needs
│   ├── errors.js          HttpError
│   ├── log.js             Logger
│   ├── lock.js            Lock file for the data folder
│   ├── http/              router, body, validate, cors, address, static
│   ├── domain/            events, distances, participants, results, sessions,
│   │                      properties, csv (the rules of the competition)
│   ├── db/                pool, database, migrations
│   ├── security/          passwords (scrypt), throttle (limits)
│   └── ws/hub.js          WebSocket hub
├── tests/                 Tests of the server
├── docs/API.md            API reference
└── scripts/backup.js      Backup of the event databases
frontend/
├── index.html host.html client.html viewer.html practice.html
├── sw.js                  Service worker of the practice page
├── js/                    config, storage, api, websocket, scoring, host, client, viewer, practice, offline
├── css/
└── tests/                 Tests of the browser scripts
```

### Request Flow

```
Browser                       Server
   |  HTTP request               |
   |---------------------------->|  1. Check the numbers in the path and the query
   |                             |  2. Read the body (size limit) and check it
   |                             |  3. Open the event database (404 if missing)
   |                             |  4. Check the session and the role (401)
   |                             |  5. Run the handler: the rules (403), then
   |                             |     one synchronous transaction
   |  JSON answer                |  6. After the commit: send the WebSocket message
   |<----------------------------|
```

The domain code (`src/domain`) has no HTTP code. A handler that changes data
runs in one transaction. If the transaction fails, the server saves nothing and
sends no message.

The server is one process. Messages go from the handler to the sockets in
memory. The counters for the login limits are in memory. The leaderboard is in
memory until the data changes. A lock file stops a second process on the same
data folder. The file has the process id and a time that the server renews. The
next start ignores the lock of a server that stopped or crashed, so nobody must
delete the file.

### WebSocket Message Types

| `type` | Direction | Payload |
|--------|-----------|---------|
| `authenticate` | client → server | `{ session_id }` (first message) |
| `authenticated` | server → client | `{ role }` |
| `event_status` | server → all | `{ status }` |
| `distance_update` | server → all | `{ distance_id, status }` |
| `refresh` | server → all | — |
| `result_update` | server → all | `{ participant_id, total_score }` |
| `lane_session_reset` | server → all | `{ lane_number }` |

The browser pages react in this way:

- The lane client loads the data again after `event_status`, `distance_update`,
  `refresh`, and a reconnect. After `result_update` it loads only the one
  participant.
- The host page loads the participants, and the event and distances after
  `event_status` and `distance_update`. Many messages cause one load.
- The viewer page loads the leaderboard after each message.
- A socket that the server closes with code `1008` (session rejected) makes the
  page ask for the login again.

---

## 6. Database Schema

The server makes one file for each event: `DATA_DIR/<CODE>.db`. The server runs
the migrations in `src/db/migrations.js` when it opens a file. The database
has WAL mode and foreign keys. The server needs a new migration for each schema
change. A file from a newer server version is refused.

### `event` (one row)

| Column | Notes |
|--------|-------|
| `code` | Event code |
| `status` | `created`, `started`, `finished` |
| `shots_count` | Default shots for a distance (1 to 300) |
| `allow_lane_add` | 1 when lanes can add participants |
| `created_at`, `started_at`, `finished_at` | ISO 8601 times |

### `credentials`

| Column | Notes |
|--------|-------|
| `role` | `host` or `viewer` (a row for `viewer` exists only when the host set a password) |
| `hash` | scrypt hash: `scrypt$<cost>$<salt>$<key>` |

### `lanes`

| Column | Notes |
|--------|-------|
| `lane` | 1 to 999 |
| `password_hash` | scrypt hash of the lane password (used to check logins) |
| `password` | The lane password in the clear, so that the host can read it |
| `created_at` | ISO 8601 time |

### `sessions`

| Column | Notes |
|--------|-------|
| `token_hash` | SHA-256 of the session token (primary key) |
| `role` | `host`, `viewer`, `lane` |
| `lane` | The lane for a lane session. The row goes away when the lane is deleted. |
| `created_at`, `expires_at` | Times in milliseconds |

### `distances`

| Column | Notes |
|--------|-------|
| `id` | Primary key |
| `title` | Text (1 to 60 characters) |
| `shots_count` | 1 to 300 |
| `sort_order` | Order in the event |
| `status` | `pending`, `active`, `finished` |

### `participants`

| Column | Notes |
|--------|-------|
| `id` | Primary key |
| `name`, `lane`, `shift` | Required. `lane` is 1 to 999. |
| `gender`, `age_category`, `shooting_type`, `group_type`, `personal_number` | Optional |

### `results`

One row for each shot. The primary key is `(participant_id, distance_id, shot)`.
The columns `score` (0 to 10) and `is_x` follow the rules in the database: an X
needs score 10. A deleted participant or distance deletes its results.

---

## 7. API Reference

The complete description is in [backend-node/docs/API.md](backend-node/docs/API.md).
The browser pages use these routes:

| Area | Method and path | Auth |
|------|-----------------|------|
| Health | `GET /api/health` | — |
| Events | `POST /api/events/create` | — |
| | `GET /api/events/{code}` | — |
| | `PATCH /api/events/{code}` | Host |
| Sessions | `POST /api/sessions/{code}/host`, `/viewer`, `/lane/{n}` | — |
| | `GET /api/sessions/{code}/lanes` | Host |
| | `DELETE /api/sessions/{code}/lane/{n}` | Host |
| Distances | `GET /api/distances/{code}` | — |
| | `POST`, `PATCH /{id}`, `DELETE /{id}` | Host |
| Participants | `GET /api/participants/{code}` (query `lane_number`) | — |
| | `POST /api/participants/{code}` | Host, or the lane |
| | `POST …/import`, `PUT …/{id}`, `DELETE …/{id}` | Host |
| Results | `GET …/leaderboard`, `…/state/{pid}`, `…/detail/{pid}/{did}` | — |
| | `PUT …/participant/{pid}/distance/{did}`, `POST …/{code}` | Host, or the lane of the participant |
| | `DELETE …/{pid}` | Host |
| Settings | `GET`, `PATCH /api/properties/{code}` | Host |
| | `GET /api/properties/{code}/public` | — |

Send the session in the header `X-Session-Id`. An error answer is
`{ "detail": "…" }`. For status `422`, `detail` is a list of
`{ "loc": [...], "msg": "…" }`.

### WebSocket

```
WS /ws/{code}
```

After the connection opens, send `{"type":"authenticate","session_id":"…"}`. The
server answers `{"type":"authenticated","role":"…"}`. The server does not read
other messages from the client. The close codes are in the API reference.

---

## 8. Security Model

### Session Tokens

A session token is a random value of 256 bits. The database keeps only its
SHA-256 hash. A session has a lifetime of 14 days (`SESSION_DAYS`). A login
does not end the other sessions. A host or a lane keeps its 20 newest sessions. The viewer role keeps 5000.
A new host password ends the other host sessions. A new viewer password ends
all viewer sessions. A lane reset ends the lane sessions and closes their sockets.

### Password Storage

Passwords use scrypt with a random salt (`PASSWORD_COST`, default 15). A new
event gets a host password of 16 characters. A new lane gets a password of 6
characters. A lane that lost its password can ask the host for a reset. The
server keeps the request in memory for 15 minutes. The request id is a secret
of 256 bits that only the asking device has. Each request counts like a failed
login in the login limits. The host must approve, and the approval ends all
other sessions of the lane. The host can read the lane passwords in the host panel, so the
database also keeps each lane password in the clear (column `lanes.password`).
The host and viewer passwords are only hashes. Manual passwords need at least 12 characters. The server shows a
generated password one time. The server runs the hash in the thread pool, so a
login check does not stop other requests.

### Limits

- Ten failed logins for one account and one address in 15 minutes lock the
  account for 15 minutes. All accounts together can fail `LOGIN_FAILURE_LIMIT`
  times (default 100) for one address. The server counts an attempt before it
  checks the password. A login with a valid saved session is not limited.
- One address can create `EVENT_CREATE_LIMIT` events (default 60) in one hour.
- The server limits the request body (256 KiB, the import 2 MiB), the size of
  the first WebSocket message (4096 bytes), the number of sockets
  (`MAX_SOCKETS`), and the output queue of a slow socket (1 MiB).
- Behind a proxy, set `TRUSTED_PROXIES`. Without it, all users share the
  address of the proxy and share the limits.

### Input Validation

Each route has a schema (`src/routes.js`). The server checks the type and the
length of each value. It rejects a value of the wrong type and does not convert
it (a text "6" is not a number). It trims names and codes and changes shifts and
codes to uppercase. The database also enforces the ranges and the references.
All SQL statements use parameters.

### Path Traversal Prevention

The static file server rejects paths that have `..`, a backslash, or a null
character. It resolves links and refuses a file outside the `frontend` folder.
The route `/vendor/` serves only `qrcode.js`.

### XSS Prevention

The pages write user text with `textContent` or with an escape function. The
server sets `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
`Permissions-Policy`, and a strict `Content-Security-Policy`: scripts only from
the same origin, no inline script, no outside resource, no framing. The pages
have no inline event attributes. An element names its action in a `data-click`
attribute (or `data-change`, `data-blur`, `data-enter`, `data-submit`,
`data-backdrop`). The script `frontend/js/actions.js` runs the action that the
page registered with that name, so page text cannot call any other function.
`style-src` allows inline styles. Set `CONTENT_SECURITY_POLICY=off` to turn the
header off.

### CSV Formula Injection

The export prefixes a cell that starts with `=`, `+`, `-`, `@`, a tab, or a
carriage return with a single quote.

### `client_allow_add_participant`

When the host turns this setting off, a lane cannot add participants. The server
enforces this. The page hides the button.

---

## 9. Deployment

### Local Development

```bash
./start_node_watch.sh      # restarts when a file in backend-node/src changes
# Open http://localhost:8000
```

### Production

```bash
cd backend-node
npm ci --omit=dev
HOST=127.0.0.1 PORT=8000 DATA_DIR=/var/lib/shooting-scoring node src/server.js
```

Run one process under a process manager. The server stops in an orderly way on
`SIGTERM` and `SIGINT`. A second process on the same data folder does not start.
`start_server.sh` is a start script for a server that sets `IP`, `PORT`, and
`DATA_DIR` in the environment.

Example for `systemd`:

```ini
[Unit]
Description=Shooting Scoring System
After=network.target

[Service]
User=scoring
WorkingDirectory=/opt/shooting-scoring/backend-node
Environment=HOST=127.0.0.1 PORT=8000 DATA_DIR=/var/lib/shooting-scoring
Environment=TRUSTED_PROXIES=["127.0.0.1"]
ExecStart=/usr/bin/node src/server.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

**Nginx reverse proxy** (replace the certificate paths with your own):

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
        proxy_pass         http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
    }
}
```

### Configuration

| Variable | Default | Function |
|----------|---------|----------|
| `PORT` | `8000` | Port |
| `HOST` | `0.0.0.0` | Address to listen on |
| `DATA_DIR` | `backend-node/data` | Folder for the event databases |
| `ALLOWED_ORIGINS` | `[]` | JSON list of origins for CORS |
| `TRUSTED_PROXIES` | `[]` | JSON list of proxy addresses |
| `LOGIN_FAILURE_LIMIT` | `100` | Failed logins for one address in 15 minutes |
| `EVENT_CREATE_LIMIT` | `60` | Events that one address can create in one hour (`0` = no limit) |
| `SESSION_DAYS` | `14` | Lifetime of a session |
| `MAX_BODY_BYTES` | `262144` | Largest request body |
| `MAX_SOCKETS` | `5000` | Largest number of WebSocket connections (also those that did not authenticate yet) |
| `HASH_QUEUE` | `50` | Number of waiting password checks. More get status `503`. |
| `PASSWORD_COST` | `15` | Cost of the password hash |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug` |

Set the variables in the environment or in `backend-node/.env`. A value that is
not valid stops the start. The other settings are in
[backend-node/README.md](backend-node/README.md#configuration).

### Database Backup

```bash
# Make a consistent copy while the server runs.
cd backend-node
node scripts/backup.js /path/to/backups            # all events
node scripts/backup.js /path/to/backups ABC123     # one event
```

To restore a file, stop the server, copy the `.db` file into the data folder,
delete `<CODE>.db-wal` and `<CODE>.db-shm`, and start the server. Do not copy a
`.db` file alone while the server runs.

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

Run all tests from `backend-node`. The tests use the built-in Node.js test
runner. They need no extra tool.

```bash
cd backend-node
npm test             # the server
npm run test:all     # the server and the browser scripts
```

The tests of the server cover the rules of the API (events, distances,
participants, results, settings), the values that are not valid, logins and
sessions (hashes, lifetime, revocation, limits, restart), WebSocket delivery
and close codes, headers, CORS, body limits and malformed requests, static
files, the database layer (migrations, transactions, pool), the process
(lock, orderly stop, port in use), and the backup script.

The tests of the browser scripts cover reconnect state, offline queues that
belong to a session, the archive of unsent scores, the host and viewer pages
(reload once for many messages, live updates, session end), and safe error
text. Contract tests run the real scripts against the real server and call each
method of `api.js`.
