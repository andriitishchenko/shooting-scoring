# 🎯 Shooting Scoring System - Setup Guide

## Quick Start

### Linux/Mac
```bash
chmod +x start.sh
./start.sh
```

### Windows
```bash
start.bat
```

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
cd backend
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

1. Open http://localhost:8000
2. Click **"HOST"**
3. Enter a 4-digit code (e.g., `TEST`)
4. Click "Create new event" when prompted
5. Configure settings:
   - Number of shots (default: 30)
6. Click **"Start Competition"**

### Add Participants (CLIENT)

1. On another device/browser, open http://localhost:8000
2. Click **"CLIENT"**
3. Enter the same code (`TEST`)
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
3. Enter the code (`TEST`)
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
- All score entry is saved to browser LocalStorage
- Survives page refresh/close
- Syncs to server when online

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

To access from phones/tablets on same network:

1. Find your computer's IP address:
```bash
# Linux/Mac
ifconfig | grep "inet "
# Windows
ipconfig
```

2. Update `frontend/js/config.js`:
```javascript
const CONFIG = {
    API_BASE_URL: 'http://YOUR_IP:8000/api',
    WS_BASE_URL: 'ws://YOUR_IP:8000/ws',
    CODE_LENGTH: 4
};
```

3. Access from mobile: `http://YOUR_IP:8000`

---

## Network Configuration

### Same Device
- HOST, CLIENT, VIEWER all on one computer
- Use: http://localhost:8000

### Local Network
- Multiple devices on same WiFi
- Use computer's IP address
- Update config.js as shown above

### Internet Access
- Requires port forwarding or VPS
- Set up nginx reverse proxy
- Enable HTTPS (recommended)

---

## Advanced Configuration

### Change Number of Lanes

In `frontend/js/client.js`, line ~70:
```javascript
for (let i = 1; i <= 20; i++) {  // Change 20 to desired number
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

⚠️ **This is a development setup. For production:**

1. Use environment variables for secrets
2. Enable HTTPS with SSL certificates
3. Add authentication/authorization
4. Use production WSGI server (gunicorn)
5. Set up nginx reverse proxy
6. Configure firewall rules
7. Regular database backups
8. Monitor logs and errors

### Code Security

- Codes are 4 characters (simple for local use)
- No authentication required
- Anyone with code can access event
- Consider adding passwords for sensitive competitions

---

## Backup and Recovery

### Backup Databases

```bash
# Backup all events
cp -r backend/databases /path/to/backup/

# Backup specific event
cp backend/databases/event_TEST.db /path/to/backup/
```

### Restore Database

```bash
cp /path/to/backup/event_TEST.db backend/databases/
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
