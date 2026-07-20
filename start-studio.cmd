@echo off
title DRAMATIS Studio
cd /d "%~dp0"
echo Starting DRAMATIS Studio...
start "" "http://localhost:4600"
node studio\server.mjs
pause
