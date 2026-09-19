@echo off
REM Runs Notes straight from this folder, without installing it.
setlocal
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
if not exist "node_modules" call npm install --no-audit --no-fund
if not exist "dist\index.html" call npm run build
start "" /b npx electron .
exit /b 0
