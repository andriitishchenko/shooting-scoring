# Shooting Scoring System

A web application to manage and score archery and shooting competitions.
Each competition is an event with its own SQLite database. Three roles use the
same event with a shared code: **HOST** (administrator), **CLIENT** (lane that
enters scores), and **VIEWER** (live leaderboard).

## Quick start

Install [Node.js](https://nodejs.org) 24 or later. Run this command from the
project directory:

```sh
./start.sh
```

On Windows, run `start.bat`. The server prints the addresses to open:

```
Shooting Scoring System v4.0.0
  http://localhost:8000
  http://192.168.178.213:8000
  Data: /path/to/backend-node/data
```

Open the address in a browser. Use the network address on phones and tablets
that are in the same network. See [SETUP.md](SETUP.md) for the first steps,
[DOCUMENTATION.md](DOCUMENTATION.md) for the user guide, and
[backend-node/README.md](backend-node/README.md) for the server.

## Features

- **Sessions for each role** — host, viewer, and each lane have their own
  sessions in `localStorage`. Passwords are not in the page source or in URLs.
- **One database for each event** — one SQLite file for each event code.
- **Role separation** — the host controls the event. A lane enters the scores of
  its own participants. A viewer shows the leaderboard.
- **Many distances** — an event has any number of ordered distances (for
  example 18 m, 25 m, 30 m). The host starts and finishes each distance.
- **Roster before the start** — the viewer shows the participants by lane and
  shift. After the host starts the event, it shows the ranked leaderboard.
- **Live updates** — the server sends a message after each change. The host,
  the lanes, and the viewers update by themselves.
- **Offline score recovery** — a lane keeps the scores in the browser until the
  server confirms them. Unsent scores go to a file for recovery when the event
  or the lane session ended before the server received them.
- **Self-registration control** — the host can allow or block lanes that add
  participants.
- **QR codes** — the host page makes the QR code in the browser. The link does
  not go to another service.
- **No configuration of addresses** — `config.js` takes the API and WebSocket
  addresses from the address of the page.

## Technology

| Part | Technology |
| --- | --- |
| Server | Node.js 24, one process |
| HTTP and files | The `node:http` module and our own small router |
| Database | SQLite (`node:sqlite`), one file for each event, WAL mode |
| Live updates | WebSocket (`ws`) |
| Password hashes | scrypt |
| Browser | HTML, JavaScript (ES2020), CSS. No build step. |
| Browser storage | `localStorage` |

## Project structure

```
shooting-scoring/
├── backend-node/          The server
│   ├── src/               Source code (see backend-node/README.md)
│   ├── tests/             Tests of the server
│   ├── docs/API.md        API reference
│   └── scripts/backup.js  Backup of the event databases
├── frontend/              The browser pages (served by the server)
│   ├── index.html host.html client.html viewer.html
│   ├── js/                config, storage, api, websocket, host, client, viewer
│   ├── css/
│   └── tests/             Tests of the browser scripts
├── backend/               Old FastAPI server. The Node.js server does not use it.
├── start.sh start.bat     Quick start
├── start_node.sh          Start the server
├── start_node_watch.sh    Start for development (restart on change)
└── start_server.sh        Production start
```

The folder `backend` has the old FastAPI server. The Node.js server does not
use it and does not read its databases. The folder will be removed.

## API and live updates

The full description is in [backend-node/docs/API.md](backend-node/docs/API.md).
These are the main routes:

| Area | Routes |
| --- | --- |
| Events | `POST /api/events/create`, `GET`/`PATCH /api/events/{code}` |
| Sessions | `POST /api/sessions/{code}/host`, `…/viewer`, `…/lane/{n}`; `GET …/lanes`; `DELETE …/lane/{n}` |
| Distances | `GET`/`POST /api/distances/{code}`, `PATCH`/`DELETE …/{id}` |
| Participants | `GET`/`POST /api/participants/{code}`, `POST …/import`, `PUT`/`DELETE …/{id}` |
| Results | `GET …/leaderboard`, `…/state/{pid}`, `…/detail/{pid}/{did}`; `PUT …/participant/{pid}/distance/{did}`; `POST`; `DELETE …/{pid}` |
| Settings | `GET`/`PATCH /api/properties/{code}`, `GET …/public` |

For live updates, the client opens `WS /ws/{code}` and sends
`{"type":"authenticate","session_id":"…"}` as the first message. The server
sends `event_status`, `distance_update`, `refresh`, `result_update`, and
`lane_session_reset` messages.

## Sessions

```
HOST creates an event
  The server makes the database, the host password, and a host session.
  The answer has { code, host_password, session_id }.

HOST logs in again
  POST /api/sessions/{code}/host { session_id }  - the saved session
  POST /api/sessions/{code}/host { password }    - a new session

CLIENT selects lane N
  POST /api/sessions/{code}/lane/N {}
    The lane is new            -> { status: "created", session_id, password }
                                  The screen shows the password of 6 characters.
    The saved session is valid -> { status: "ok" }
    Other cases                -> { status: "password_required" }

HOST resets lane N
  DELETE /api/sessions/{code}/lane/N
  The server deletes the password and the sessions of the lane, sends
  { type: "lane_session_reset" }, and closes the sockets of the lane.
```

A login does not end the other sessions. A second device can log in at the same
time. A new host password ends the other host sessions.

## Configuration

The server reads environment variables and `backend-node/.env`. The full list is
in [backend-node/README.md](backend-node/README.md#configuration). The most
important variables:

| Variable | Default | Function |
| --- | --- | --- |
| `PORT` | `8000` | Port |
| `HOST` | `0.0.0.0` | Address to listen on |
| `DATA_DIR` | `backend-node/data` | Folder for the event databases |
| `ALLOWED_ORIGINS` | `[]` | JSON list of origins for CORS (not needed for the browser pages) |
| `TRUSTED_PROXIES` | `[]` | JSON list of proxy addresses (needed behind a reverse proxy) |

`frontend/js/config.js` sets `CODE_LENGTH` (6), `LANE_COUNT` (28), `SERIES_SIZE`
(3), and `REQUEST_TIMEOUT_MS`. The browser pages need an event code of 6
characters. The API accepts 1 to 16 characters.

## Scoring application

Select **Scoring** on the home page to open the separate Archery Scoring
application at `/scoring/`. Its files are in `frontend/scoring`.
See [Scoring setup](SCORING.md) for the build and server changes.

## Tests

```sh
cd backend-node
npm run test:all
```

This runs the tests of the server and of the browser scripts. The tests of the
browser scripts start the real server and run the real pages against it.
`npm test` runs only the tests of the server.

## Deployment

Run `./start_server.sh` (or `node src/server.js` in `backend-node`) under a
process manager. Use one process. The server stops in an orderly way on
`SIGTERM`. Example for `systemd`:

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

Example for an nginx reverse proxy. Replace the certificate paths with your
own paths:

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
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Recommendations:

- Use HTTPS. The browser needs it for `wss://` and for the copy button.
- Set `TRUSTED_PROXIES` to the address of the proxy. Then the login limit works
  for each client, not for all clients together.
- Keep `DATA_DIR` on persistent storage. Only the user of the server may read it.
- Make backups with `node backend-node/scripts/backup.js <folder>` while the
  server runs. Do not copy the `.db` files alone.
- Test the deployed server with a WebSocket connection and with score entry.
