@echo off
REM Runs Notes straight from this folder, without installing it.
setlocal
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
if exist "release\win-unpacked\Notes.exe" (
  start "" "%~dp0release\win-unpacked\Notes.exe"
  exit /b 0
)
if not exist "node_modules" call npm install --no-audit --no-fund
if not exist "dist\index.html" call npm run build
start "" /b npx electron .
exit /b 0
