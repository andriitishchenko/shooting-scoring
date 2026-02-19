@echo off
echo 🎯 Shooting Scoring System - Quick Start
echo ========================================
echo.

REM Check if virtual environment exists
if not exist "backend\venv" (
    echo 📦 Creating virtual environment...
    cd backend
    python -m venv venv
    cd ..
)

REM Activate virtual environment
echo 🔧 Activating virtual environment...
call backend\venv\Scripts\activate.bat

REM Install dependencies
echo 📥 Installing dependencies...
pip install -q -r backend\requirements.txt

REM Start the server
echo 🚀 Starting server...
echo.
echo ✅ Server will be available at:
echo    Frontend: http://localhost:8000
echo    API Docs: http://localhost:8000/docs
echo.
echo Press Ctrl+C to stop the server
echo.

cd backend
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
