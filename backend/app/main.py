from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from app.routers import events, participants, results, websocket, distances, properties, sessions
from app.config import settings
import os

app = FastAPI(
    title="Shooting Scoring System",
    description="Web application for managing shooting competition scores",
    version="3.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(events.router)
app.include_router(participants.router)
app.include_router(results.router)
app.include_router(distances.router)
app.include_router(websocket.router)
app.include_router(properties.router)
app.include_router(sessions.router)


@app.get("/api/health")
async def health_check():
    return {"status": "ok", "message": "Shooting Scoring System v3"}


@app.exception_handler(ValueError)
async def invalid_event_code_handler(request, exc):
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=422, content={"detail": str(exc)})


frontend_path = os.path.join(os.path.dirname(__file__), "../../frontend")
if os.path.exists(frontend_path):
    app.mount("/", StaticFiles(directory=frontend_path, html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
