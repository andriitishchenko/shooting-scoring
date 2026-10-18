@echo off
echo Shooting Scoring System - quick start
echo =====================================

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js is not installed. Install Node.js 24 or later from https://nodejs.org
    exit /b 1
)
for /f %%v in ('node -p "process.versions.node.split('.')[0]"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 24 (
    echo Node.js is too old. Install Node.js 24 or later.
    exit /b 1
)

call "%~dp0start_node.bat"
