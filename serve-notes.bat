@echo off
REM Serves Notes at http://localhost:5299 using the same notes folder as the app.
setlocal
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
if not exist "dist\index.html" call npm run build
start "" http://localhost:5299
node server\server.mjs --port 5299
