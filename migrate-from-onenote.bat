@echo off
setlocal enabledelayedexpansion
title Migrate OneNote into Notes

REM Reads your OneNote notebooks and writes a Notes folder from them.
REM It never writes to OneNote, and it never touches your existing notes:
REM everything lands in a brand new folder that you choose below.

cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=

echo.
echo   Migrate OneNote into Notes
echo   ==========================
echo.
echo   This reads OneNote and writes a new notes folder.
echo   Nothing in OneNote is changed.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js was not found. Install the LTS build from https://nodejs.org
  pause
  exit /b 1
)
if not exist "node_modules" call npm install --no-audit --no-fund

set "NBROOT=%USERPROFILE%\OneDrive\Documents\OneNote Notebooks"
echo   Where are your OneNote notebooks?
echo   Press Enter for: %NBROOT%
set /p "INPUT=  Folder: "
if not "%INPUT%"=="" set "NBROOT=%INPUT%"

set "TARGET=%USERPROFILE%\Documents\MyNotes-OneNote"
echo.
echo   Where should the imported notes go?
echo   Press Enter for: %TARGET%
set /p "INPUT2=  Folder: "
if not "%INPUT2%"=="" set "TARGET=%INPUT2%"

echo.
echo   [1/3] Reading OneNote. It will open every notebook it finds, which
echo         can take a while the first time.
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\export-onenote.ps1" -Out ".onenote-export" -NotebookRoot "%NBROOT%"
if errorlevel 1 goto failed

echo.
echo   [2/3] Converting into notes.
call node scripts\import-onenote.mjs --export ".onenote-export" --out "%TARGET%"
if errorlevel 1 goto failed

echo.
echo   [3/3] Checking every page against OneNote, word by word.
call node scripts\verify-import.mjs --export ".onenote-export" --out "%TARGET%"

echo.
echo   Imported into: %TARGET%
echo.
echo   Open Notes, go to Settings, Storage, Change, and pick that folder.
echo   Your OneNote notebooks are untouched.
echo.
pause
exit /b 0

:failed
echo.
echo   Something failed above. Nothing in OneNote was changed.
echo.
pause
exit /b 1
