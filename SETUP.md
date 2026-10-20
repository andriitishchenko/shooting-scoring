# Shooting Scoring System - Setup Guide

## Quick start

1. Install [Node.js](https://nodejs.org) 24 or later.
2. Run this command from the project directory:

```bash
./start.sh
```

On Windows, run `start.bat`. The script installs the packages and starts the
server. The server prints the addresses to open:

```
  http://localhost:8000
  http://192.168.178.213:8000
```

3. Open `http://localhost:8000` in a browser.

To restart the server automatically when you change the server code, run
`./start_node_watch.sh` (Windows: `start_node_watch.bat`).

Stop the server with `Ctrl+C`.

---

## Start the server by hand

```bash
cd backend-node
npm ci
npm start
```

Use these addresses:

- **Application**: http://localhost:8000
- **Health check**: http://localhost:8000/api/health

To change the port, the address, or the data folder, set an environment
variable. For example:

```bash
PORT=8080 DATA_DIR=/srv/scores ./start_node.sh
```

The full list of settings is in [backend-node/README.md](backend-node/README.md#configuration).

---

## First use

### Create your first event

1. Open http://localhost:8000 and click **HOST**.
2. Enter a code of six letters or digits (for example, `TEST01`). Create the event.
3. Write down the host password (16 characters). Keep it outside the browser.
   The badge shows the password while this browser has its copy. If you clear
   the browser storage, the copy is lost.
4. Add participants and set the distances before you start the event.
5. When the list is ready, click **Start**. The lanes can then enter scores on
   the active distance.

### Add participants (CLIENT)

1. On another device, open http://localhost:8000.
2. Click **CLIENT**.
3. Enter the same code (`TEST01`).
4. Select a lane number. A new lane shows a password of 6 characters. Write it
   down. You need it to open this lane on another device. If you lose it, the
   host sees the password in the host panel, next to the lane. A person at the
   lane can also tap **Request password** on the
   password screen. The host approves in the host panel, and the page shows a
   new password.
5. Click **Add** (only before the competition starts).
6. Enter the data of the participant:
   - Name (required)
   - Shift letter (A, B, C, and so on)
   - Gender, age category, shooting type (optional)

### Enter scores

1. In the lane view, tap the name of a participant.
2. The score screen shows the series (3 shots each) and the score buttons.
3. Tap a button for each shot. Each series shows its shots from the highest to the lowest.
4. The score is saved on the device and sent to the server.
5. Tap **Back** when you finish.

### Count the score without a server (PRACTICE)

PRACTICE needs no event code, no password, and no session on the server.

1. Open the home page and tap **PRACTICE**.
2. Enter the number of arrows (30 is the default) and tap **Start**.
3. Tap a button for each shot. The form is the same as in the CLIENT.
4. The browser keeps the list. A reload does not delete it.
5. To end the count, tap **New** and confirm. The list is deleted.

To open the page without a network, open it one time with a connection. This
works only on HTTPS or on `localhost`.

### Show the leaderboard (VIEWER)

1. On the display device, open http://localhost:8000.
2. Click **VIEWER**.
3. Enter the code (`TEST01`).
4. The leaderboard shows and updates by itself.
5. The page scrolls by itself when there are many participants. Use the switch **Auto-scroll** to turn it off.
6. The leaderboard has groups by gender and shooting type. Participants with
   the same points are ranked by the number of 10s (an X is a 10), and then by
   the number of X. Participants that are equal in all three values share a rank.

---

## Score buttons

| Button | Value | Color |
|--------|-------|-------|
| X | 10 (center) | Yellow |
| 10 | 10 | Yellow |
| 9 | 9 | Yellow |
| 8 | 8 | Red |
| 7 | 7 | Red |
| 6 | 6 | Blue |
| 5 | 5 | Blue |
| 4 | 4 | Black |
| 3 | 3 | Black |
| 2 | 2 | White |
| 1 | 1 | White |
| M | 0 (miss) | Gray |

---

## Data storage

### In the browser

- The browser keeps the changes that the server did not confirm. They stay
  after a reload.
- Each saved set belongs to the lane session that made it. A new lane session
  does not send the scores of an old session.
- When the server confirms the scores, the browser deletes its copy.
- When the event ended or the lane session ended before the server received the
  scores, the browser moves them to an archive. The page shows the button
  **Download unsent scores**. The button saves a JSON file.

### On the server

- Each event has one SQLite file: `backend-node/data/<CODE>.db`. The folder is
  `DATA_DIR`.
- The file has the participants, the results, and the sessions.
- The server process is the only user of the data folder. Do not start a second
  server on the same folder.

### Export the results (HOST)

1. In the host panel, click **Export CSV**.
2. The browser saves `results_CODE_YYYY-MM-DD.csv`.
3. Open the file in Excel, Google Sheets, or a similar program.

---

## Troubleshooting

### The server does not start

**Message**: `Another server (process N) uses the data directory`
- Another server uses the same data folder.
- Stop that server. If no server runs, wait 15 seconds and start again. You do
  not need to delete the file `.server.lock`. The server ignores a lock of a
  server that stopped or crashed.

**Message**: `EADDRINUSE`
- Another program uses port 8000.
- Use another port: `PORT=8001 ./start_node.sh`.

**Message**: `Node.js ... is too old`
- Install Node.js 24 or later.

### Browser problems

**The page does not open**
- Make sure that the server runs.
- Check the address. Use the address that the server printed.
- Check the firewall of the server computer.

**The data does not stay**
- Make sure that the browser allows `localStorage`.
- Open the console (F12) and look for errors.

**The scores do not reach the server**
- Check the network connection.
- Look at the status text on the score screen. "Saved on device; waiting to
  sync" means that the server was not reachable. The page sends the scores
  again when the connection returns.

### Access from phones and tablets

1. Use the network address that the server prints at the start. You can also
   find the address of the computer:
```bash
# Linux/Mac
ifconfig | grep "inet "
# Windows
ipconfig
```
2. Open `http://ADDRESS:8000` on each device. The pages take the API and
   WebSocket addresses from the page address. You do not change any source file.

---

## Network configuration

### One device

- HOST, CLIENT, and VIEWER on one computer.
- Use http://localhost:8000.

### Local network

- Many devices can connect through the same Wi-Fi.
- Open the address of the server computer, for example `http://192.168.1.20:8000`.
- Allow the port in the firewall of the server computer.
- By default, the server listens on all network interfaces (`HOST=0.0.0.0`).
  Set `HOST=127.0.0.1` to accept only this computer.

### Internet

- Put the server behind a reverse proxy with HTTPS. The browser needs HTTPS for
  secure `wss://` connections.
- Set `TRUSTED_PROXIES` to the address of the proxy.
- Keep the data folder on persistent storage and make regular backups.
- The examples for nginx and `systemd` are in [README.md](README.md#deployment).

---

## Advanced settings

### Number of lanes

The host sets the number of lanes in **⚙️ Event Settings**, in the field
**Number of lanes**. The value is from 1 to 999. The default is 28. The lane list
of the client shows lanes 1 to this number. If a participant is on a higher lane,
the list shows lanes up to that lane. `LANE_COUNT` in `frontend/js/config.js` is
the value that the client uses when the server does not send a number.

A CSV import of participants raises the number of lanes to the highest imported
lane. The import never lowers the number. A client that shows the lane list gets
the new number in a few seconds.

### Shots in a series

The series has 3 shots. To change it, edit `SERIES_SIZE` in
`frontend/js/config.js`. The server uses 3 shots for the series in the detail
view (`SERIES` in `backend-node/src/domain/results.js`). Change both values.

### Scroll of the viewer page

To stop the automatic scroll, click the switch **Auto-scroll** at the top of the
leaderboard. Then scroll to a section by hand. Click the switch again to start
the scroll from the current position. The browser keeps the choice.

---

## Security notes

### Production

1. Use HTTPS behind a reverse proxy.
2. Set `TRUSTED_PROXIES` to the address of the proxy.
3. The default CORS setting accepts only the same origin. To host the pages on
   another origin, set `ALLOWED_ORIGINS` to a JSON list of exact origins.
   The server lets these origins read the `Retry-After` header. The pages
   use this header to show the waiting time after status 429.
4. Run one server process under a process manager or a service unit.
5. Keep the data folder on persistent storage. Only the user of the server
   may read it. Make backups on a schedule.
6. Read the server log and test the deployed pages and the WebSocket.

### About the code and the passwords

- The browser pages need an event code of six letters or digits. The API
  accepts 1 to 16 characters. A code selects an event. It does not give
  permission to change it.
- A change needs a session. A new event gets a host password of 16 characters.
  A new lane gets a password of 6 characters.
- The server keeps only hashes of the passwords (scrypt) and of the session
  tokens. The server limits failed logins.
- A login does not end the other sessions. A new host password ends the other
  host sessions. A lane reset ends the sessions of that lane.
- The viewer is public until the host sets a viewer password. A person who
  knows the event code can read the public data of the event.
- Protect the data folder and the backups. They have the data of the
  participants and the passwords of the lanes (the host can read them).
- The password of a new lane stays on the screen of the lane page until the
  user continues or reloads the page. Use HTTPS on shared networks.

---

## Backup and restore

### Backup

Make a consistent copy while the server runs:

```bash
cd backend-node
node scripts/backup.js /path/to/backups            # all events
node scripts/backup.js /path/to/backups TEST01     # one event
```

The script sets the permission of each copy to the owner only. A copy has the
lane passwords in the clear.

Do not copy the `.db` files alone while the server runs. Some data can be in
the `.db-wal` file.

### Restore

```bash
# Stop the server first.
cp /path/to/backups/TEST01.db backend-node/data/
rm -f backend-node/data/TEST01.db-wal backend-node/data/TEST01.db-shm
```

Then start the server.

### Export before you delete

Export the results as CSV before you delete old events.

---

## Performance

### Large competitions

- Use a dedicated device for the VIEWER display.
- Put 6 to 8 participants on one lane at most.
- Export and archive old events.
- One server process handles hundreds of devices. You do not need more.

### Mobile devices

- The pages already block zoom.
- Use the landscape orientation for score entry.
- Use a stable Wi-Fi connection.
- Keep the screen on during the competition.

---

## Support

### Logs

The server writes its log to the terminal where it runs. Set `LOG_LEVEL=debug`
for one line for each request. The browser console (F12) shows errors in the
pages.

### Common problems

1. **The WebSocket disconnects**: Check the network. The page connects again by
   itself.
2. **The scores do not show**: Make sure that the participant exists and that
   the distance is active.
3. **The export is empty**: Make sure that the competition has results.
4. **Many `429` errors**: A limit is reached. See `LOGIN_FAILURE_LIMIT` and
   `EVENT_CREATE_LIMIT` in [backend-node/README.md](backend-node/README.md#configuration).

---

## Next steps

1. Test with sample data.
2. Set the network for your event.
3. Train the staff for each role.
4. Run a practice competition.
5. Set up the backups.
6. Use it for the real event.
