@echo off
setlocal
rem Regular TradeSense server on port 4000 using portable Node 24 (this window only). Does not change .env or any trading flag.
if exist "C:\node24\node-v24.16.0-win-x64\node.exe" set "PATH=C:\node24\node-v24.16.0-win-x64;%PATH%"
node -e "process.exit(Number(process.versions.node.split(String.fromCharCode(46))[0])>=24?0:1)"
if errorlevel 1 (
  echo Node 24 or newer is required. Found:
  node --version
  exit /b 1
)
node --version
set "CLIENT_ORIGIN=http://localhost:5173"
rem Approved by user 2026-10-16: lets the scanner engine start from the dashboard. Execution/autonomy flags are NOT changed.
set "AUTOPILOT_DISABLED=false"
cd /d "%~dp0..\.."
npm run start
