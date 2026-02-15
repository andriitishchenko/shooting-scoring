# Shooting Scoring System

Web application for managing and tracking scores in shooting competitions with real-time leaderboard display.

## Features

- **Private Room System**: Each event has a unique 4-digit code
- **Three User Roles**:
  - **HOST**: Create and manage events, control competition flow, export results
  - **CLIENT**: Enter scores for participants on specific lanes
  - **VIEWER**: Display live leaderboard with auto-scroll for large displays
- **Real-time Updates**: WebSocket-based live synchronization
- **Offline Support**: LocalStorage ensures data persistence even after page reload
- **Mobile Optimized**: Touch-friendly interface with disabled zoom/gestures

## Technology Stack

### Backend
- Python 3.12
- FastAPI (async web framework)
- SQLite (separate database per event)
- WebSockets for real-time communication
- Pydantic for data validation

### Frontend
- Pure HTML5
- Vanilla JavaScript (ES6+)
- CSS3 (Grid, Flexbox, Custom Properties)
- No frameworks or dependencies

## Project Structure

```
shooting-scoring/
├── backend/
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py              # FastAPI app
│   │   ├── config.py            # Configuration
│   │   ├── database.py          # Database manager
│   │   ├── models.py            # Pydantic models
│   │   ├── websocket_manager.py # WebSocket handler
│   │   └── routers/
│   │       ├── events.py        # Event endpoints
│   │       ├── participants.py  # Participant endpoints
│   │       ├── results.py       # Results endpoints
│   │       └── websocket.py     # WebSocket endpoint
│   ├── databases/               # SQLite databases (created at runtime)
│   └── requirements.txt
└── frontend/
    ├── index.html               # Main entry page
    ├── host.html                # Host admin panel
    ├── client.html              # Client score entry
    ├── viewer.html              # Leaderboard viewer
    ├── css/
    │   ├── reset.css
    │   ├── variables.css
    │   ├── main.css
    │   ├── host.css
    │   ├── client.css
    │   └── viewer.css
    └── js/
        ├── config.js            # Configuration
        ├── api.js               # API client
        ├── websocket.js         # WebSocket client
        ├── storage.js           # LocalStorage wrapper
        ├── host.js              # Host logic
        ├── client.js            # Client logic
        └── viewer.js            # Viewer logic
```

## Installation

### Prerequisites
- Python 3.12 or higher
- pip (Python package manager)

### Backend Setup

1. Navigate to backend directory:
```bash
cd backend
```

2. Create virtual environment:
```bash
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
```

3. Install dependencies:
```bash
pip install -r requirements.txt
```

4. Run the server:
```bash
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

The API will be available at `http://localhost:8000`
API documentation at `http://localhost:8000/docs`

### Frontend Access

The frontend is served by the FastAPI backend at `http://localhost:8000`

Alternatively, you can serve it separately:
```bash
cd frontend
python -m http.server 8080
```
Then access at `http://localhost:8080`

## Usage

### As HOST

1. Open the application
2. Click "HOST"
3. Enter a 4-digit code (e.g., "ABCD")
4. Configure number of shots
5. Click "Start Competition"
6. Monitor progress and export CSV when done

### As CLIENT

1. Open the application
2. Click "CLIENT"
3. Enter the code provided by HOST
4. Select your lane number
5. Add participants (before competition starts)
6. Select participant to enter scores
7. Tap score buttons to record shots
8. Results auto-save and sync

### As VIEWER

1. Open the application
2. Click "VIEWER"
3. Enter the code provided by HOST
4. Watch live leaderboard with auto-scroll
5. Results grouped by gender and shooting type

## Score Entry

### Score Values
- **X**: 10 points (bullseye)
- **10-1**: Standard scores
- **M**: Miss (0 points)

### Color Coding
- Yellow: X, 10, 9
- Red: 8, 7
- Blue: 6, 5
- Black: 4, 3
- White: 2, 1
- Gray: M (miss)

### Features
- Auto-scroll to next empty shot
- Series totals and cumulative scores
- Edit previous shots by tapping
- LocalStorage backup of all data

## Database Schema

Each event creates a SQLite database (`event_{CODE}.db`) with:

### Tables
- **event**: Event configuration and status
- **participants**: Competitor information
- **results**: Individual shot scores

## API Endpoints

### Events
- `POST /api/events/create` - Create new event
- `GET /api/events/{code}` - Get event info
- `PATCH /api/events/{code}` - Update event

### Participants
- `POST /api/participants/{code}` - Add participant
- `GET /api/participants/{code}` - List participants
- `DELETE /api/participants/{code}/{id}` - Delete participant

### Results
- `POST /api/results/{code}` - Save results
- `GET /api/results/{code}/{participant_id}` - Get participant results
- `GET /api/results/{code}/leaderboard` - Get leaderboard

### WebSocket
- `WS /ws/{code}` - Real-time updates

## Configuration

Edit `frontend/js/config.js` to change:
- API_BASE_URL: Backend API URL
- WS_BASE_URL: WebSocket URL
- CODE_LENGTH: Code length (default: 4)

Edit `backend/app/config.py` for backend settings:
- DATABASE_DIR: Database storage location
- ALLOWED_ORIGINS: CORS allowed origins

## Development

### Running in Development
```bash
# Terminal 1 - Backend
cd backend
source venv/bin/activate
uvicorn app.main:app --reload

# Access at http://localhost:8000
```

### Testing API
Visit `http://localhost:8000/docs` for interactive API documentation

## Deployment

### Production Considerations
- Use proper WSGI server (gunicorn/uvicorn)
- Set up reverse proxy (nginx)
- Enable HTTPS
- Configure firewall
- Regular database backups
- Set proper CORS origins

## License

MIT License

## Support

For issues or questions, please create an issue in the repository.
