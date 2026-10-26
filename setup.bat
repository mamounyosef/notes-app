@echo off
setlocal
title Notes setup

REM One click setup and update: pulls the latest version, installs what is
REM needed, builds and packages the app, puts a
REM Notes icon on the desktop and in the start menu, and starts it.
REM Run it again any time to update. No admin rights needed.
REM Settings, Update runs it hidden with NOTES_QUIET=1 (scripts\update-runner.mjs):
REM it never waits for a key then, and the runner starts Notes again after.

cd /d "%~dp0"

REM Code editor terminals set this and it stops Electron from starting.
set ELECTRON_RUN_AS_NODE=

echo.
echo   Notes setup
echo   ================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js was not found. Installing it with winget.
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  set "PATH=%PATH%;%ProgramFiles%\nodejs"
)
where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js could not be installed automatically.
  echo   Install the LTS version from https://nodejs.org and run this file again.
  echo.
  if not defined NOTES_QUIET pause
  exit /b 1
)

REM Latest code first, when this folder is a git checkout. If that changed
REM anything, start over with the new copy of this file (Windows reads a
REM running batch file as it goes, so it must not continue on the old one).
if "%~1"=="pulled" goto pulled
if not exist ".git" goto pulled
where git >nul 2>nul
if errorlevel 1 goto pulled
echo   [1/7] Getting the latest version.
for /f %%h in ('git rev-parse HEAD') do set "BEFORE=%%h"
REM npm install can rewrite package-lock.json, which would block the pull.
REM This setup made that change, so it is safe to drop it.
git diff --quiet -- package-lock.json
if errorlevel 1 git checkout -- package-lock.json
git pull --ff-only
if errorlevel 1 if defined NOTES_QUIET call :forcepull
if errorlevel 1 (
  echo   Could not pull the latest version. git status:
  git status --short --branch
  REM From Settings, Update: building the old version again would only look like an update.
  if defined NOTES_QUIET goto failed
  echo   Building what is here.
)
for /f %%h in ('git rev-parse HEAD') do set "AFTER=%%h"
if not "%BEFORE%"=="%AFTER%" (call "%~f0" pulled & exit /b)
echo.
:pulled

echo   [2/7] Closing Notes if it is open.
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\close-notes.ps1"

echo.
echo   [3/7] Installing packages. The first run takes a few minutes.
call npm install --no-audit --no-fund
if errorlevel 1 goto failed

echo.
echo   [4/7] Drawing the app icon.
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\make-icon.ps1"
if errorlevel 1 goto failed

echo.
echo   [5/7] Building the app.
call npm run build
if errorlevel 1 goto failed
REM The packaged app in release\win-unpacked (what a pinned taskbar icon starts).
REM The old copy goes first, so a failed packaging never leaves a stale app behind.
if exist "release\win-unpacked" rmdir /s /q "release\win-unpacked"
REM Its signing tool cache first: unpacked by electron-builder itself it fails
REM without admin rights or developer mode.
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\fix-wincodesign.ps1"
call npx electron-builder --win --dir
if errorlevel 1 echo   Packaging failed. The shortcuts will run Notes from this folder instead.

REM scripts\test-update.mjs updates a throwaway copy: your shortcuts and speech engine stay as they are.
if defined NOTES_UPDATE_TEST goto extrasdone
echo.
echo   [6/7] Pointing every Notes shortcut (desktop, start menu, taskbar) at this version.
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\make-shortcut.ps1"
if errorlevel 1 goto failed

echo.
echo   [7/7] Voice mode's speech engine (skipped where the weekly planner has one).
powershell -NoProfile -ExecutionPolicy Bypass -File "speech-engine\setup-speech.ps1"
:extrasdone

echo.
REM From Settings, Update: scripts\update-runner.mjs starts Notes when this ends.
if defined NOTES_RUNNER (
  echo   Done.
  exit /b 0
)
echo   Done. Starting Notes.
REM The Update button of an older Notes (no runner): it ran this hidden and
REM starts nothing after, so Notes starts here, with its own empty handles.
if defined NOTES_QUIET if exist "release\win-unpacked\Notes.exe" (
  start "" "%~dp0release\win-unpacked\Notes.exe" <nul >nul 2>nul
  exit /b 0
)
if exist "release\win-unpacked\Notes.exe" (
  start "" "%~dp0release\win-unpacked\Notes.exe"
) else (
  start "" "%~dp0run-notes.bat"
)

:done
exit /b 0

:failed
echo.
echo   Something failed above. Copy the message and check it, then run this again.
echo.
if not defined NOTES_QUIET pause
REM An older Notes' Update button: Notes was closed for the update, so open what is there again.
if defined NOTES_QUIET if not defined NOTES_RUNNER if exist "release\win-unpacked\Notes.exe" start "" "%~dp0release\win-unpacked\Notes.exe" <nul >nul 2>nul
exit /b 1

REM Settings, Update when "git pull" failed. Nothing is lost on the way:
REM 1. Edits or new files in this folder that block the pull go to git stash
REM    (git stash list shows them), then it pulls again.
REM 2. If this copy has commits of its own (or the history was rewritten), they
REM    stay on a branch notes-backup-<commit> and this copy takes the latest version.
:forcepull
git status --porcelain | findstr . >nul
if errorlevel 1 goto forcepull_history
echo   Local changes in this folder blocked the update. Keeping them in git stash.
git -c user.name=Notes -c user.email=notes@localhost stash push --include-untracked -m "Kept by Notes update"
git pull --ff-only
if not errorlevel 1 exit /b 0
:forcepull_history
git fetch origin
if errorlevel 1 exit /b 1
git merge-base --is-ancestor HEAD @{u}
if not errorlevel 1 exit /b 1
for /f %%h in ('git rev-parse --short HEAD') do set "OLDHEAD=%%h"
echo   This copy's history differs from the latest version. Keeping it on branch notes-backup-%OLDHEAD%.
git branch -f notes-backup-%OLDHEAD% HEAD
if errorlevel 1 exit /b 1
git reset --hard @{u}
exit /b
