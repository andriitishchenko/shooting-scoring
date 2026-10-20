# Regression Testing Guide

Manual test plan for the Shooting Scoring System.
Run these scenarios after any code change before deploying.

---

## Prerequisites

- Server running on `http://localhost:8000` (run `./start.sh`)
- Three browser windows (or tabs) open: **HOST**, **CLIENT**, **VIEWER**
- Open browser DevTools console in each window to watch for JS errors

## Automated Tests

Run these from `backend-node`. The tests use the built-in Node.js test runner.
They start their own server on a free port and use a temporary data folder.

```bash
cd backend-node
npm run test:all
```

`npm test` runs only the tests of the server.

---

## 1. Event Creation & Host Login

### 1.1 Create a new event

| Step | Action | Expected result |
|------|--------|-----------------|
| 1 | Open `HOST` window → `host.html` | Login screen shown |
| 2 | Enter code `TEST01`, click **Create** | Admin panel opens |
| 3 | Note the generated password displayed as a clickable badge | Password is 8 chars, uppercase alphanum |
| 4 | Click the password badge | Toast "Copied!" appears; clipboard contains the password |
| 5 | Click the event code badge | Toast "Copied!" appears; clipboard contains `TEST01` |

### 1.2 Re-login with saved session

| Step | Action | Expected result |
|------|--------|-----------------|
| 1 | Refresh HOST window | Admin panel re-opens automatically (auto-login via saved `session_id`) |

### 1.3 Re-login with password after clearing storage

| Step | Action | Expected result |
|------|--------|-----------------|
| 1 | Open DevTools → Application → localStorage → clear all items | — |
| 2 | Refresh HOST window | Login screen appears |
| 3 | Enter `TEST01` + correct password → **Enter** | Admin panel opens |
| 4 | Enter wrong password → **Enter** | Error message shown, stays on login |

---

## 2. Settings

### 2.1 Change host password

| Step | Action | Expected result |
|------|--------|-----------------|
| 1 | HOST → ⚙ Settings → set **Host Password** to `NEWPWD01` → Save | "Settings saved!" alert |
| 2 | Refresh HOST, clear localStorage | Login screen |
| 3 | Login with old password | Error |
| 4 | Login with `NEWPWD01` | Admin panel opens |
| 5 | A second HOST window that was logged in before the change | The window returns to the login screen (its session ended) |

### 2.2 Set viewer password

| Step | Action | Expected result |
|------|--------|-----------------|
| 1 | HOST → Settings → set **Viewer Password** to `VIEW01` → Save | Saved |
| 2 | VIEWER window → enter `TEST01` → Enter | Password prompt appears |
| 3 | Enter wrong password | Error "Invalid password" |
| 4 | Enter `VIEW01` | Leaderboard / roster screen opens |
| 5 | HOST → Settings → clear **Viewer Password** → Save | — |
| 6 | VIEWER → new window → `TEST01` → Enter | Opens without password prompt |
| 7 | A VIEWER window that was open before step 1 | It showed the password prompt after step 1 and it needs the new password |

### 2.3 Allow self-registration toggle

| Step | Action | Expected result |
|------|--------|-----------------|
| 1 | HOST → Settings → uncheck **Allow clients to self-register** → Save | "Settings saved!" |
| 2 | CLIENT → select lane 1 (create lane session) | Participant screen shown |
| 3 | CLIENT → tap **Add Participant** (if button is visible) | Button should be **hidden** |
| 4 | CLIENT → attempt `POST /api/participants/TEST01` directly via DevTools fetch with valid lane session | `403 Self-registration is disabled` |
| 5 | HOST → Settings → re-enable → Save | — |
| 6 | CLIENT → refresh or wait for WS `refresh` event | **Add Participant** button appears |

---

## 3. Distances

### 3.1 Default distance created

| Step | Action | Expected result |
|------|--------|-----------------|
| 1 | HOST → **Distances** tab | "Distance 1" listed, status `pending`, 30 shots |

### 3.2 Add / edit / delete distances

| Step | Action | Expected result |
|------|--------|-----------------|
| 1 | HOST → Distances → **Add Distance** → title "18m", shots 18 | New row appears |
| 2 | Edit "Distance 1" title to "25m" | Title updates |
| 3 | Delete "18m" | Row removed |
| 4 | Attempt delete when only 1 distance remains | Error "Cannot delete the last distance" |

### 3.3 Distance status lifecycle

| Step | Action | Expected result |
|------|--------|-----------------|
| 1 | Start event first (§4) | — |
| 2 | HOST → Distances → **Activate** "25m" | Status `active` (pulsing green badge) |
| 3 | CLIENT → participant → score screen | Active distance shots grid shown |
| 4 | HOST → **Finish** "25m" | Status `finished` |
| 5 | HOST → activate "Distance 1" | "25m" auto-finished, "Distance 1" goes active |
| 6 | Try to re-activate finished distance | Error "Finished distance cannot be reactivated" |

---

## 4. Event Lifecycle

### 4.1 Start event

| Step | Action | Expected result |
|------|--------|-----------------|
| 1 | HOST → **Start** | Status badge changes to `STARTED` |
| 2 | CLIENT: score screen buttons become active | — |
| 3 | VIEWER: switches from participant roster to leaderboard (after next poll, ≤2 min) |

### 4.2 Finish event

| Step | Action | Expected result |
|------|--------|-----------------|
| 1 | HOST → **Finish Event** | Status badge `FINISHED`; all active distances set to `finished` |
| 2 | CLIENT: cannot save new results | Error "Event has finished" |
| 3 | HOST: cannot add participants | Error "Event has finished" |
| 4 | VIEWER: leaderboard remains, shows final rankings |

---

## 5. Client — Lane Sessions

### 5.1 First entry to lane (create session)

| Step | Action | Expected result |
|------|--------|-----------------|
| 1 | CLIENT window → enter code `TEST01` → **Enter** | Lane selection grid shown |
| 2 | Tap **Lane 1** | "Lane Password" screen shown with 6-char password |
| 3 | Tap the password box | "Copied!" — password is in clipboard |
| 4 | Tap **Continue** | Participants screen for Lane 1 |

### 5.2 Auto-login on return

| Step | Action | Expected result |
|------|--------|-----------------|
| 1 | Refresh CLIENT window | Participants screen for Lane 1 opens immediately (session restored) |

### 5.3 Lane occupied — password prompt

| Step | Action | Expected result |
|------|--------|-----------------|
| 1 | Open a second CLIENT tab → `TEST01` → Lane 1 | Password prompt shown |
| 2 | Enter wrong password | Error "Invalid password" |
| 3 | Enter correct password | Participants screen for Lane 1 |
| 4 | First CLIENT tab | It still works. A second login does not end the first session. |

### 5.4 Host resets lane session

| Step | Action | Expected result |
|------|--------|-----------------|
| 1 | HOST → Participants → Lane 1 header → **Reset Session** | Confirm dialog |
| 2 | Confirm | Lane 1 row still visible in host (session removed, no participants) |
| 3 | CLIENT on Lane 1 (all devices on this lane) | WS `lane_session_reset` received → redirected to lane selection |
| 4 | CLIENT selects Lane 1 again | New session created, new password shown |

### 5.5 Host sees the lane password

| Step | Action | Expected result |
|------|--------|-----------------|
| 1 | CLIENT opens Lane 1 and writes down the password | The password has 6 characters |
| 2 | HOST → Participants tab | The Lane 1 header shows 🔑 and the same password |
| 3 | HOST → **Reset Session** for Lane 1, then CLIENT opens Lane 1 again | The host sees the new password |

### 5.6 Lane password lost: request, approve, deny

| Step | Action | Expected result |
|------|--------|-----------------|
| 1 | CLIENT A opens Lane 1 (new lane) and continues | Participants screen |
| 2 | CLIENT B (other browser) → code → Lane 1 | Password prompt with the button **Request password** |
| 3 | CLIENT B → tap the button | "Waiting for the host to approve the reset…". The page has no button to cancel the request. |
| 4 | HOST → Participants tab | Yellow banner "Lane 1 asks for a password reset". The Lane 1 header shows **Approve** and **Deny** |
| 5 | CLIENT B → reload the page, select Lane 1 again | The page continues to wait (no second request needed) |
| 6 | HOST → **Deny** | CLIENT B shows "The host denied the request." and the button again. CLIENT A is not disturbed. The banner is gone. |
| 7 | CLIENT B → ask again. HOST → **Approve** → confirm | CLIENT B shows the "Lane Password" screen with a new password. CLIENT A returns to lane selection. |
| 8 | HOST → lane header | The new password shows next to Lane 1. The yellow label is gone. |
| 9 | CLIENT B → **Continue** | Participants screen. The old password does not work. The new password works. |

### 5.7 Lane password: copy

| Step | Action | Expected result |
|------|--------|-----------------|
| 1 | HOST → Participants → double-click the password at a lane | The label shows "✓ Copied" and then the password again. Paste somewhere to check the text. |

### 5.8 Lane visible in HOST even without participants

| Step | Action | Expected result |
|------|--------|-----------------|
| 1 | CLIENT creates session for Lane 3 (no participant added) | — |
| 2 | HOST → Participants tab | Lane 3 group visible with "No participants on this lane yet" |
| 3 | 🔑 badge shown in Lane 3 header | Active session indicator present |

---

## 6. Participants

### 6.1 Add participant as host

| Step | Action | Expected result |
|------|--------|-----------------|
| 1 | HOST → Participants → **Add Participant** | Modal opens |
| 2 | Fill: name "Alice", lane 1, shift A, gender Female, type Recurve → **Save** | Row appears in Lane 1 group |

### 6.2 Add participant as client

| Step | Action | Expected result |
|------|--------|-----------------|
| 1 | CLIENT (Lane 2 session) → **Add Participant** | Form shown |
| 2 | Fill name "Bob", lane 2, shift A → **Save** | Bob appears in list |
| 3 | CLIENT tries to add participant for Lane 3 | `401 Valid session required` (wrong lane session) |

### 6.3 Edit / delete participant

| Step | Action | Expected result |
|------|--------|-----------------|
| 1 | HOST → ✎ Edit Alice → change name to "Alice Smith" → Save | Name updates in list |
| 2 | HOST → 🗑 delete Alice Smith | Participant removed; results also deleted |

---

## 7. Score Entry

### 7.0 Results count in the participant card

| Step | Action | Expected result |
|------|--------|-----------------|
| 1 | CLIENT → participants screen of a lane with an active distance | Each distance tag shows the score and `entered/shots`, for example `Distance 1: — · 0/30` |
| 2 | Enter 2 shots, tap **Back** | The tag shows `Distance 1: 19 · 2/30` |
| 3 | HOST finishes the distance | The tag keeps the count (`… · 2/30`) |

### 7.1 Enter scores

| Step | Action | Expected result |
|------|--------|-----------------|
| 1 | Event started, distance active | — |
| 2 | CLIENT → Lane 1 → tap **Bob** | Score grid shows empty shot slots |
| 3 | Tap score buttons (e.g. X, 10, 9) for series 1 | Slots fill; series total updates |
| 4 | Complete all shots | Score auto-saves; total visible in header |
| 5 | VIEWER leaderboard (≤2 min poll) | Bob's score appears |

### 7.2 Edit a shot

| Step | Action | Expected result |
|------|--------|-----------------|
| 1 | CLIENT → score grid → tap a filled slot | Slot highlighted (selected) |
| 2 | Tap a different score button | Slot updates; total recalculates |

### 7.3 Score boundary validation

| Step | Action | Expected result |
|------|--------|-----------------|
| 1 | Attempt `POST /api/results/TEST01` with `score: 11` | `422` validation error |

### 7.4 Recovering after a lane session reset

| Step | Action | Expected result |
|------|--------|-----------------|
| 1 | With Lane 1 scoring, disconnect the API long enough for a score change to remain pending in browser storage | The UI reports that the score is saved on the device and waiting to sync |
| 2 | HOST resets Lane 1, then the client reconnects and creates or joins the new lane session | The client uses a new session ID |
| 3 | Refresh participant state or reopen the affected participant | The older pending score is not merged into the new session's view or sent to the server |
| 4 | Enter a new score in the new session and restore connectivity | Only the new session's score set is submitted |

### 7.5 Host edits for empty distances and rapid corrections

| Step | Action | Expected result |
|------|--------|-----------------|
| 1 | Score a participant on one distance, finish it, then activate another distance | The participant appears in the Results table; the new distance cell is blank |
| 2 | Click the blank cell for the active distance | The detail popup opens with empty shot slots |
| 3 | Enter a score for an empty slot and save | The score appears in the distance column and detail popup |
| 4 | Correct one shot, then immediately try to correct another while the first save is pending | The second full-series replacement is ignored until the first request completes |

---

## 7a. Practice — Counting without a server

| Step | Action | Expected result |
|------|--------|-----------------|
| 1 | Open the home page | The button **PRACTICE** shows |
| 2 | Tap **PRACTICE** | The start screen shows 30 arrows |
| 3 | Enter 0, 301, or text, and tap **Start** | A message shows. The list does not start. |
| 4 | Enter 12 and tap **Start** | The score form shows 4 series of 3 shots |
| 5 | Enter 5, 9, 10 | The series shows `10 9 5` |
| 6 | Enter 0, 2, X | The next series shows `X 2 0` |
| 7 | Tap **⌫** after a wrong score | The shot that the user entered last goes. The series stays in order. |
| 7a | Correct a shot in series 1, then tap **⌫** | The corrected shot goes. The shots of the later series stay. |
| 8 | Reload the page | The list stays. The page asks for no event code and no password. |
| 9 | Stop the server and reload the page (after one visit with a connection, on `localhost` or HTTPS) | The page opens, and the list stays |
| 9a | Close the tab and open the page again | The list stays |
| 10 | Tap **New** and confirm | The list goes, and the start screen shows. A reload now shows the start screen. |
| 11 | Open the page on a phone (width 320, 375, and landscape 667x375) | All buttons show without a scroll of the page. The delete button is wide. The grid scrolls above the buttons. |

---

## 8. Viewer — Pre-competition Roster

| Step | Action | Expected result |
|------|--------|-----------------|
| 1 | Event status is `created` (not started) | VIEWER shows "⏳ Pre-Competition — Participant List" banner |
| 2 | Participants exist on multiple lanes | Groups by lane (Lane 1, Lane 2…) sorted numerically |
| 3 | Within each lane group | Participants sorted by shift (A, B, C…) |
| 4 | HOST starts event | VIEWER switches to the ranked leaderboard within one second |

---

## 9. Viewer — Leaderboard

| Step | Action | Expected result |
|------|--------|-----------------|
| 1 | Event started, scores entered | Leaderboard shows groups by gender + bow type |
| 2 | Within group | Sorted by `total_score` descending. Equal scores: more 10s first (an X is a 10), then more X. |
| 2a | Two participants with equal points, 10s, and X | Both show the same rank (for example 1, 1, 3) |
| 3 | Top 3 | Gold left-border highlight |
| 4 | Event `created` (pre-start) | No rank numbers shown |
| 5 | Multiple active/finished distances | Per-distance scores shown inline with shots c/max |
| 6 | Auto-scroll | Page scrolls slowly; resets to top when reaching bottom |
| 6a | Auto-scroll switch | Switch off: the page stops. Scroll by hand: the page stays. Switch on: the scroll continues from there. Reload: the switch keeps its state |
| 7 | A new score arrives | The leaderboard updates within one second. The page also loads the data every 2 minutes as a backup. |
| 8 | Stop the server for 10 seconds and start it again | The viewer shows the data again without a reload |

---

## 10. WebSocket Propagation

| Scenario | WS message | CLIENT reaction |
|----------|-----------|-----------------|
| HOST starts event | `event_status {status:"started"}` | Score buttons activate; Add Participant hidden |
| HOST finishes event | `event_status {status:"finished"}` | Alert "Event finished"; can't save results |
| HOST activates distance | `distance_update {status:"active"}` | Score grid refreshes |
| HOST finishes distance | `distance_update {status:"finished"}` | Alert if on score screen; back to participants |
| HOST saves settings (allow_add changed) | `refresh` | CLIENT re-fetches public properties; button shown/hidden |
| HOST resets lane session | `lane_session_reset {lane_number:N}` | Affected CLIENT clears session, returns to lane selection |
| HOST (device A) starts the event or a distance | `event_status` / `distance_update` | HOST on device B shows the new status without a reload |
| Any score changes | `result_update {participant_id,total_score}` | HOST reloads the lists once for many messages. VIEWER loads the leaderboard. |
| Another device changes the host password | The socket closes with code `1008` | HOST shows an alert and the login screen |

---

## 11. Security Checks

| Check | Expected |
|-------|----------|
| Unauthenticated `PATCH /api/events/TEST01` | `401 Session ID required` |
| Wrong session ID for host endpoint | `401 Invalid or expired session` |
| Client lane session used on wrong lane's `POST /participants` | `401 Valid session required` |
| Client `POST /participants` when `client_allow_add_participant=false` | `403 Self-registration is disabled` |
| Client `POST /results` against a pending distance | `403 Distance has not started` |
| Client `POST /results` after event finished | `403 Results may only be changed during a started event` |
| Client `PUT /results/…` after event finished | `403 The event has finished` |
| 11 wrong host passwords from one address | `429` with a `Retry-After` header. A login with a saved valid session still works. |
| Request body above 256 KiB | `413 Request body too large` |
| Response headers of any page | `Content-Security-Policy` with `script-src 'self'`. The browser console shows no policy violation on the host, client, and viewer pages. |
| `kill -9` the server, then start it again at once | The server starts. You do not delete `.server.lock`. |
| Empty `POST /api/results/TEST01` batch | `422 At least one result is required` |
| No `session_id` anywhere in HTML source or URL | ✅ All in `localStorage` only |
| Lane password during first login | Shown in the client page for the user to copy; it is not part of the static page source or URL |

---

## 12. Edge Cases

| Scenario | Expected |
|----------|----------|
| Enter code for non-existent event | "Event not found" alert |
| Two clients on same lane simultaneously | Both have a session. Both can view and add. The last write wins for a shot. |
| Distance deleted while client has score screen open | On next refresh — distance missing; grid adjusts |
| Refresh CLIENT page mid-scoring | State fully restored from `GET /results/{code}/state/{pid}` |
| Pending score belongs to a lane session that was reset | It is ignored by the new session and is not replayed |
| HOST clears results for participant | Participant still listed; score grid empty |
| All shots for a distance entered; host finishes distance | Shots preserved; shown as read-only summary |

---

## Automated Smoke Test (curl)

The script needs `curl` and Node.js. It reads the answers with `node -p`.

```bash
CODE="SMOK01"
BASE="http://localhost:8000/api"
json() { node -p "JSON.parse(require('fs').readFileSync(0, 'utf8'))$1"; }

# Create event
RESP=$(curl -s -X POST "$BASE/events/create" \
  -H "Content-Type: application/json" \
  -d "{\"code\":\"$CODE\",\"shots_count\":3}")
echo "$RESP"
SID=$(echo "$RESP" | json .session_id)

# Get event
curl -s "$BASE/events/$CODE"; echo

# Create lane session
LANE_RESP=$(curl -s -X POST "$BASE/sessions/$CODE/lane/1" \
  -H "Content-Type: application/json" -d '{}')
echo "$LANE_RESP"
LANE_SID=$(echo "$LANE_RESP" | json .session_id)

# Add participant (before the start)
PID_RESP=$(curl -s -X POST "$BASE/participants/$CODE" \
  -H "Content-Type: application/json" \
  -H "X-Session-Id: $LANE_SID" \
  -d '{"name":"Test Archer","lane_number":1,"shift":"A"}')
echo "$PID_RESP"
PID=$(echo "$PID_RESP" | json .id)

# Start event
curl -s -X PATCH "$BASE/events/$CODE" \
  -H "Content-Type: application/json" \
  -H "X-Session-Id: $SID" \
  -d '{"status":"started"}'; echo

# Activate distance 1
DID=$(curl -s "$BASE/distances/$CODE" | json "[0].id")
curl -s -X PATCH "$BASE/distances/$CODE/$DID" \
  -H "Content-Type: application/json" \
  -H "X-Session-Id: $SID" \
  -d '{"status":"active"}'; echo

# Save 3 shots
curl -s -X POST "$BASE/results/$CODE" \
  -H "Content-Type: application/json" \
  -H "X-Session-Id: $LANE_SID" \
  -d "[
    {\"participant_id\":$PID,\"distance_id\":$DID,\"shot_number\":1,\"score\":10,\"is_x\":true},
    {\"participant_id\":$PID,\"distance_id\":$DID,\"shot_number\":2,\"score\":9,\"is_x\":false},
    {\"participant_id\":$PID,\"distance_id\":$DID,\"shot_number\":3,\"score\":8,\"is_x\":false}
  ]"; echo

# Leaderboard
curl -s "$BASE/results/$CODE/leaderboard"; echo

echo "Smoke test complete."
```
