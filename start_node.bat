@echo off
setlocal
cd /d "%~dp0backend-node"
if not exist node_modules\ws (
    call npm ci --no-fund --no-audit
    if errorlevel 1 exit /b 1
)
node src\server.js
