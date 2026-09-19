@echo off
setlocal
title Notes setup

REM One click setup: installs what is needed, builds the app, and puts a
REM Notes icon on the desktop and in the start menu. No admin rights needed.

cd /d "%~dp0"

REM Code editor terminals set this and it stops Electron from starting.
set ELECTRON_RUN_AS_NODE=

echo.
echo   Notes setup
echo   ================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js was not found.
  echo   Install the LTS version from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b 1
)

echo   [1/4] Installing packages. The first run takes a few minutes.
call npm install --no-audit --no-fund
if errorlevel 1 goto failed

echo.
echo   [2/4] Drawing the app icon.
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\make-icon.ps1"
if errorlevel 1 goto failed

echo.
echo   [3/4] Building the app.
call npm run build
if errorlevel 1 goto failed

echo.
echo   [4/4] Creating the desktop and start menu shortcuts.
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\make-shortcut.ps1"
if errorlevel 1 goto failed

echo.
echo   Done.
echo.
echo   Start Notes from the desktop icon, or from run-notes.bat here.
echo   Notes live in Documents\MyNotes by default. To sync this machine with
echo   your other one, open Settings, Storage, and point both at the same
echo   folder inside OneDrive, Google Drive or Dropbox.
echo.
echo   To use it in a browser as well, run serve-notes.bat and open
echo   http://localhost:5299 . It reads and writes the same notes folder.
echo.
choice /c YN /m "   Start Notes now"
if errorlevel 2 goto done
start "" "%~dp0run-notes.bat"

:done
exit /b 0

:failed
echo.
echo   Something failed above. Copy the message and check it, then run this again.
echo.
pause
exit /b 1
