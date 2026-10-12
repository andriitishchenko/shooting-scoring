# 🎯 Shooting Scoring System - Setup Guide

## Quick Start

### Linux/Mac
```bash
chmod +x start.sh
./start.sh
```

The repository's `start.sh` is a local development convenience: it activates
`backend/venv`, installs `backend/requirements.txt`, and starts Uvicorn with
auto-reload. For production, use the deployment guidance in `README.md` and
the server's process manager. This repository does not include `start.bat`.

Then open your browser to `http://localhost:8000`

---

## Manual Setup

### Step 1: Install Python Dependencies

```bash
cd backend
python3 -m venv venv

# Activate virtual environment
# Linux/Mac:
source venv/bin/activate
# Windows:
venv\Scripts\activate

# Install packages
pip install -r requirements.txt
```

### Step 2: Start the Server

```bash
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### Step 3: Access the Application

Open your browser to:
- **Application**: http://localhost:8000
- **API Documentation**: http://localhost:8000/docs
- **Health Check**: http://localhost:8000/api/health

---

## First Time Usage

### Create Your First Event

1. Open http://localhost:8000 and click **HOST**.
2. Enter a six-character uppercase letter/digit code (for example, `TEST01`)
   and create the event.
3. Copy and safely store the generated eight-character host password outside
   the browser. The badge stays visible while this browser retains its local
   copy; clearing browser storage removes that copy.
4. Add participants and configure distances before starting the event.
5. When the roster is ready, click **Start**. Lane clients can then
   enter scores on the active distance.

### Add Participants (CLIENT)

1. On another device/browser, open http://localhost:8000
2. Click **"CLIENT"**
3. Enter the same code (`TEST01`)
4. Select lane number
5. Click **"Add Participant"** (only before competition starts)
6. Fill in participant details:
   - Name (required)
   - Shift letter (A, B, C, etc.)
   - Gender, age category, shooting type (optional)

### Enter Scores

1. From the lane view, tap on a participant's name
2. You'll see the score entry screen with:
   - Series rows (groups of 3 shots)
   - Score buttons at bottom
3. Tap score buttons to record each shot
4. Scores auto-save locally and sync to server
5. Tap **"← Back"** when done

### View Leaderboard (VIEWER)

1. On display device, open http://localhost:8000
2. Click **"VIEWER"**
3. Enter the code (`TEST01`)
4. Leaderboard displays automatically
5. Auto-scrolls if many participants
6. Groups by gender and shooting type

---

## Score Button Guide

| Button | Value | Color |
|--------|-------|-------|
| X | 10 (bullseye) | Yellow |
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

## Data Storage

### Local Storage (Browser)
- Pending score changes are saved in browser LocalStorage and survive reloads.
- Each pending set is tied to the lane session that recorded it. A new lane
  session will not restore or send scores left by an older session.
- Once the server confirms the replacement, the pending copy is removed.

### Server Storage
- Each event creates a SQLite database: `backend/databases/event_{CODE}.db`
- Stores all participants and results
- Can be backed up separately

### Export Results (HOST)

1. In HOST panel, click **"Export CSV"**
2. Downloads file: `results_CODE_YYYY-MM-DD.csv`
3. Opens in Excel, Google Sheets, etc.

---

## Troubleshooting

### Server Won't Start

**Error**: `Address already in use`
- Another process is using port 8000
- Solution: Kill process or use different port:
```bash
python -m uvicorn app.main:app --reload --port 8001
```

**Error**: `Module not found`
- Virtual environment not activated
- Solution: Run `source venv/bin/activate` first

### Browser Issues

**Can't connect to server**
- Check server is running
- Verify URL: http://localhost:8000
- Check firewall settings

**Data not saving**
- Check browser allows LocalStorage
- Check console for errors (F12)
- Verify WebSocket connection

**Scores not syncing**
- Check network connection
- Verify WebSocket is connected
- Check backend logs

### Mobile Device Access

To access from phones or tablets on the same network:

1. Find the server computer's IP address:
```bash
# Linux/Mac
ifconfig | grep "inet "
# Windows
ipconfig
```

2. Open `http://YOUR_IP:8000` on each device. The API and WebSocket URLs are
   derived automatically from the page address; no source edit is needed.

---

## Network Configuration

### Same Device
- HOST, CLIENT, VIEWER all on one computer
- Use: http://localhost:8000

### Local Network
- Multiple devices can connect over the same Wi-Fi.
- Open the server computer's address, for example `http://192.168.1.20:8000`.
- Configure the firewall to allow the selected server port.

### Internet Access
- Deploy behind a reverse proxy with HTTPS; HTTPS is required for secure
  `wss://` WebSocket connections.
- Set `ALLOWED_ORIGINS` to the exact browser origin as a JSON array, for
  example `ALLOWED_ORIGINS='["https://scores.example.org"]'`.
- Keep the database directory on persistent storage and arrange regular backups.

---

## Advanced Configuration

### Change Number of Lanes

The lane picker currently displays lanes 1–28. This range is set in
`showLaneSelection()` in `frontend/js/client.js`.
```javascript
for (let i = 1; i <= 28; i++) {
```

### Change Shots Per Series

Currently fixed at 3 shots per series. To modify:
- Edit `frontend/js/client.js`
- Find `shotsPerSeries = 3`
- Change to desired value

### Disable Auto-Scroll (Viewer)

In `frontend/js/viewer.js`, comment out:
```javascript
// startAutoScroll();
```

---

## Security Notes

### Production Deployment

The application already has host and lane session authentication. For
production deployments:

1. Serve the application over HTTPS behind a reverse proxy. This also enables
   secure `wss://` WebSocket connections.
2. Set `ALLOWED_ORIGINS` to the exact browser origin, for example
   `ALLOWED_ORIGINS='["https://scores.example.org"]'`.
3. Run Uvicorn without `--reload` under a process manager or service unit.
4. Keep the database directory on persistent storage, restrict file access,
   and schedule backups.
5. Monitor server logs and test the deployed API, browser pages, and WebSocket.

### Code Security

- The browser accepts six-character uppercase letter/digit event codes. The
  API accepts 1–16 characters. A code identifies an event; it does not grant
  permission to change it.
- Host actions require a host session. A newly created event receives an
  eight-character host password; lane sessions use six-character passwords.
- Viewer access is public unless a viewer password is set. Public event and
  result endpoints can be read by someone who knows the event code.
- Host, viewer, and lane passwords are stored in plaintext in the event SQLite
  database. Protect the database directory and its backups.
- Use HTTPS on shared or public networks. The initial lane password is shown
  in the client screen and remains in that page's DOM until it is closed or
  reloaded so the user can copy it.

---

## Backup and Recovery

### Backup Databases

```bash
# Make an online, consistent backup of one event while the server is running.
mkdir -p /path/to/backup
sqlite3 backend/databases/event_TEST01.db \
  ".backup '/path/to/backup/event_TEST01.db'"
```

For a raw directory copy, stop the server first. Back up the database before
upgrading: existing databases get the `event_notifications` table
automatically, but the application has no general schema migration system.

### Restore Database

```bash
# Stop the server before replacing a database file.
cp /path/to/backup/event_TEST01.db backend/databases/
```

### Export Before Deleting

Always export CSV before removing old events!

---

## Performance Tips

### For Large Competitions

- Use dedicated device for VIEWER display
- Limit participants per lane to 6-8
- Export and archive old events
- Clear browser cache if slow

### Mobile Optimization

- Disable zoom (already configured)
- Use landscape mode for score entry
- Ensure stable WiFi connection
- Keep screen on during competition

---

## Support

### Check Logs

Backend logs appear in terminal where server runs.

Browser console (F12) shows frontend errors.

### Common Issues

1. **WebSocket disconnects**: Check network stability
2. **Slow performance**: Clear old LocalStorage data
3. **Scores not appearing**: Verify participant was saved
4. **Export empty**: Make sure competition has results

---

## Next Steps

1. ✅ Test with sample data
2. ✅ Configure for your network
3. ✅ Train staff on each role
4. ✅ Run practice competition
5. ✅ Set up backup routine
6. ✅ Deploy for real event

---

**Ready to score! 🎯**
