# Node.js server

This server is the back end of the Shooting Scoring System. It serves the
browser pages in `frontend`, the HTTP API, and the WebSocket updates. It is
one Node.js process with its own SQLite databases. It does not need Python.

The API is in [docs/API.md](docs/API.md).

## Requirements

- Node.js 24 or later (the server uses `node:sqlite`).
- Two npm packages: `ws` (WebSocket) and `qrcode-generator` (QR code script for
  the host page). `npm ci` installs them.

Node.js 24 can show a warning for the experimental SQLite module. This is normal.

## Start the server

Run these commands from the project directory:

```sh
./start.sh
```

The script checks Node.js, installs the packages, and starts the server. On
Windows, run `start.bat`. The server prints the addresses to open, for example:

```
Shooting Scoring System v4.0.0
  http://localhost:8000
  http://192.168.178.213:8000
  Data: /path/to/backend-node/data
```

Other ways to start:

| Command | Purpose |
| --- | --- |
| `./start_node.sh` (Windows: `start_node.bat`) | Start the server. |
| `./start_node_watch.sh` (Windows: `start_node_watch.bat`) | Development. The server restarts when a file in `backend-node/src` changes. A change in `frontend` needs only a page reload. |
| `cd backend-node && npm start` | Start the server from the service folder. |
| `./start_server.sh` | Production. Reads `IP`, `PORT`, and `DATA_DIR` from the environment. |

Stop the server with `Ctrl+C` or with `SIGTERM`. The server finishes the open
requests, closes the sockets and the databases, and then stops.

## Configuration

Set environment variables before you start the server. You can also write them
in `backend-node/.env`. An environment variable has priority over `.env`. The
server refuses to start when a value is not valid.

| Variable | Default | Function |
| --- | --- | --- |
| `PORT` | `8000` | Port for HTTP and WebSocket. |
| `HOST` | `0.0.0.0` | Network address to listen on. Use `127.0.0.1` to accept only this computer. `IP` is the old name of `HOST`. |
| `DATA_DIR` | `backend-node/data` | Folder for the databases. One file for each event. |
| `ALLOWED_ORIGINS` | `[]` | JSON list of origins for CORS. The browser pages use the same origin and need no entry. The server rejects `*`. |
| `TRUSTED_PROXIES` | `[]` | JSON list of reverse proxy addresses, for example `["127.0.0.1"]`. The server reads `X-Forwarded-For` only from these addresses. |
| `LOGIN_FAILURE_LIMIT` | `100` | Failed logins of one address in 15 minutes, all accounts together. |
| `EVENT_CREATE_LIMIT` | `60` | Events that one address can create in one hour. `0` turns the limit off. |
| `SESSION_DAYS` | `14` | Lifetime of a session. |
| `MAX_BODY_BYTES` | `262144` | Largest request body. The participant import has its own limit, `IMPORT_BODY_BYTES` (`2097152`). |
| `MAX_SOCKETS` | `5000` | Largest number of WebSocket connections. |
| `OPEN_DATABASES` | `32` | Number of event databases that the server keeps open. |
| `LANE_RESET_MINUTES` | `15` | How long a request for a lane password reset waits for the host. |
| `HASH_QUEUE` | `50` | Number of password checks that can wait. More get status `503` and the header `Retry-After`. This protects the memory of the server. |
| `LOCK_WAIT_MS` | `5000` | How long a start waits for another server that holds the data folder. |
| `CONTENT_SECURITY_POLICY` | strict policy | Value of the `Content-Security-Policy` header. `off` turns the header off. |
| `PASSWORD_COST` | `15` | Cost of the password hash (base 2 logarithm of the scrypt parameter N). Each step doubles the time and the memory. |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, or `debug`. `debug` writes one line for each request. |

Example:

```sh
PORT=8080 HOST=127.0.0.1 DATA_DIR=/srv/scores ./start_node.sh
```

## How it works

### One process

The server is one Node.js process. This design uses the strength of Node.js:
one event loop that handles many connections, and `node:sqlite`, which runs a
query in microseconds. Because the process is the only writer, the server
keeps the state in memory where this helps:

- WebSocket messages go from memory to memory. There is no polling and no
  notification table.
- The limits for logins and for event creation are counters in memory.
- The leaderboard is calculated one time for each change of the data.

A lock file (`.server.lock` in the data folder) stops a second server process
on the same folder. The file has the process id and a time. The server writes
the time again every 5 seconds. A lock is stale, and the next start takes it at
once, when the file is damaged, when the process does not run any more (a
crash, `kill -9`, a restart of the computer), or when the time is older than
15 seconds (a program uses the process id now). Nobody must delete the file.
If a real server runs, the second start waits up to 5 seconds (`LOCK_WAIT_MS`)
for it to stop and then fails. To use more than one process, the design must change. One
process is enough for the competitions that this system is made for.

### Layers

```
src/
  server.js        Start, signals, orderly stop
  app.js           Builds the server from the parts below
  config.js        Settings from the environment and .env
  routes.js        Routes, input schemas, and who may call each route
  http/            Router, body reader, validation, CORS, static files
  domain/          The rules of the competition (events, distances, participants,
                   results, sessions, settings). No HTTP code.
  db/              Database pool, migrations, transactions
  security/        Password hashes (scrypt), login limits
  ws/              WebSocket hub
```

A request goes through these steps: check the numbers in the path, read and
check the body, open the event database, check the session, run the handler.
A handler that changes data does it in one synchronous transaction. The
notification messages wait for the commit. If the transaction fails, nothing
is saved and nothing is sent.

### Data

Each event has its own file: `DATA_DIR/<CODE>.db`. The database uses WAL mode,
foreign keys, and `user_version` migrations (`src/db/migrations.js`). The server
runs the missing migrations when it opens a database. A database from a newer
version of the server is refused.

| Table | Content |
| --- | --- |
| `event` | One row: code, status, shot count, setting for lane registration, times |
| `credentials` | Hash of the host password. Hash of the viewer password, if set. |
| `lanes` | Hash of the password of each lane. The password itself, so that the host can read it. |
| `sessions` | Hash of each session token, role, lane, lifetime |
| `distances` | Ordered distances with status |
| `participants` | Participants |
| `results` | One row for each shot. The database checks the score (0 to 10), the X rule, and the references. |

The pool keeps the recent databases open (`OPEN_DATABASES`) and closes the
others. It closes a database that nobody used for one minute. Prepared
statements stay in memory for each open database.

### Security

- Passwords use scrypt. Session tokens are random (256 bits). The database keeps
  only hashes. A password check runs in the thread pool and does not stop the
  server.
- A failed login counts before the check starts, so parallel requests cannot
  pass the limit. See [Limits for failed logins](docs/API.md#limits-for-failed-logins).
- The server sets `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
  `Permissions-Policy`, and a strict `Content-Security-Policy`: scripts only from
  the same origin, no inline script, no outside resource. The browser pages have
  no inline event attributes. They use `data-click` and similar attributes with
  the registered actions in `frontend/js/actions.js`. Answers of the API have `Cache-Control: no-store`.
- The static file server rejects paths with `..`, with backslashes, or with a
  null character. It does not follow a link out of the `frontend` folder.
- The server limits the size of each request, the size of a WebSocket message,
  the number of sockets, and the memory of a slow WebSocket client.
- The host can read the lane passwords (they have 6 characters). So the
  database keeps each lane password in the clear, in the column `lanes.password`.
  The passwords of the host and the viewer are only hashes. Protect the data
  folder and the backups.
- The database files and the data folder are private to the user that runs the
  server (`0600` and `0700`).

## Backup and restore

Make a copy while the server runs. The script uses the SQLite backup function,
so the copy is consistent:

```sh
cd backend-node
node scripts/backup.js /path/to/backups            # all events
node scripts/backup.js /path/to/backups ABC123     # one event
```

To restore, stop the server. Copy the `.db` file into the data folder. Delete the
files `<CODE>.db-wal` and `<CODE>.db-shm` if they exist. Start the server.

Do not copy a `.db` file alone while the server runs. A part of the data can be
in the `.db-wal` file.

## Tests

```sh
cd backend-node
npm test                       # tests of the server
npm run test:all               # tests of the server and of the browser scripts
```

The browser tests in `frontend/tests` also start this server. The files
`contract.test.js` and `pages-contract.test.js` run the real browser scripts
against the real server.

| File | Content |
| --- | --- |
| `events`, `distances`, `participants`, `results`, `properties` | The rules of the API, the values that are not valid, the status codes |
| `sessions` | Logins, passwords, session lifetime, revocation, limits, restart |
| `ws` | WebSocket login, messages, close codes, ping, limits |
| `http` | Headers, CORS, body limit, malformed requests, static files |
| `db`, `security`, `validate`, `config` | The parts of the server, one by one |
| `lock` | The lock file: stale locks, waiting, heartbeat, parallel starts |
| `lane-reset` | The request for a lane password reset: ask, wait, approve, deny, expiry, limits, messages |
| `review` | Defects that the final review found: a database that a request uses is not closed, sockets that wait for the login count, the queue of password checks |
| `soak` | 28 lanes score at the same time, with a host and 20 viewers. Checks the data and every message. |
| `lifecycle` | The server process, stop, port in use, crash and restart, backup script |

## Load test

The script `scripts/load.js` starts a real server process. It makes an event with
50 lanes and 4 participants on each lane (200 participants). Then it connects
the viewers and sends scores:

```bash
node scripts/load.js 1000 30 1   # 1000 viewers, 30 seconds, each participant writes every 1 second
```

The viewers refresh like `viewer.js`. The output shows the time of the writes
and of the viewer refresh, the memory, the CPU, and the errors. A measurement on a
development computer (12 cores):

| Viewers | Writes | Write p95 | Viewer refresh p95 | Peak memory | Peak CPU | Errors |
| --- | --- | --- | --- | --- | --- | --- |
| 300 | 20 per second | 44 ms | 82 ms | 177 MB | 29% | 0 |
| 300 | 198 per second | 38 ms | 70 ms | 252 MB | 61% | 0 |
| 1000 | 19 per second | 116 ms | 284 ms | 308 MB | 48% | 0 |
| 1000 | 157 per second | 441 ms | 529 ms | 307 MB | 97% | 0 |

The last row is far above a real competition: each participant sends a
score every second, and 1000 viewers refresh twice every second.

## Speed

A measurement on a development computer (one process, 40 requests in parallel,
60 participants with 30 shots each):

| Request | Requests per second |
| --- | --- |
| `GET /api/events/{code}` | about 19 000 |
| `GET /api/results/{code}/leaderboard` | about 18 000 |
| `PUT` of 30 shots | about 8 000 |

The values depend on the computer. The server uses about 115 MB of memory.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| `Another server (process N) uses the data directory` | Another server runs on this folder. Stop it. If no server runs, wait 15 seconds and start again. You do not need to delete the lock file. |
| `EADDRINUSE` | Another program uses the port. Set another `PORT`. |
| The page does not open from another device | The default `HOST` is `0.0.0.0`. Check the address in the start message and the firewall of the computer. |
| `A database from a newer version of the server` | Update the server. |
| Many `429` answers for all users behind a proxy | Set `TRUSTED_PROXIES` to the address of the proxy. |
| The WebSocket does not connect behind nginx | Set the upgrade headers. See the root `README.md`. The server sends a ping every 30 seconds, so the connection stays open. |
