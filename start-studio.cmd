@echo off
title Audio Movie Studio
cd /d "%~dp0"
echo Starting Audio Movie Studio...
start "" "http://localhost:4600"
node studio\server.mjs
pause
