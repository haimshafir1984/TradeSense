@echo off
rem TradeSense: one click start (regular server 4000, port-80 forwarder for MT4, dashboard 5173, browser).
rem Does not change .env or any trading flag. Close the three windows to stop everything.
set "ROOT=%~dp0..\.."
set "NODEDIR=C:\node24\node-v24.16.0-win-x64"
if exist "%NODEDIR%\node.exe" set "PATH=%NODEDIR%;%PATH%"
start "TradeSense Server" cmd /k "%~dp0start-regular-server.cmd"
timeout /t 6 /nobreak >nul
start "TradeSense Forwarder (MT4)" cmd /k "cd /d %ROOT% && node mt4\tools\port80-forwarder.mjs"
start "TradeSense Dashboard" cmd /k "cd /d %ROOT% && npm run dev --workspace client"
timeout /t 8 /nobreak >nul
start "" "http://localhost:5173/"
