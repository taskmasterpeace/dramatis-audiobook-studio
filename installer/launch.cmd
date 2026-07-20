@echo off
rem DRAMATIS Studio launcher — the Start Menu shortcut points here.
rem Finishes first-run setup if it never completed, then starts the local
rem Studio server and opens it in your browser. Closing this window stops
rem the Studio.
title DRAMATIS Studio
cd /d "%~dp0"
set "PATH=%~dp0runtime\node;%~dp0runtime\ffmpeg\bin;%PATH%"

if not exist "%~dp0.bootstrap-done" (
  echo First run - downloading engines and voice models. This happens once.
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\bootstrap.ps1"
  if errorlevel 1 (
    echo.
    echo Setup did not finish - see the messages above, then run this again.
    pause
    exit /b 1
  )
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Run installer\bootstrap.ps1 and try again.
  pause
  exit /b 1
)

echo Starting DRAMATIS Studio at http://localhost:4600 ...
start "" http://localhost:4600
node studio\server.mjs
echo.
echo Studio stopped.
pause
