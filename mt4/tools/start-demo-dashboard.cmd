@echo off
rem Dashboard on http://localhost:5174 wired to the isolated demo-test server (4001).
if exist "C:\node24\node-v24.16.0-win-x64\node.exe" set "PATH=C:\node24\node-v24.16.0-win-x64;%PATH%"
set "VITE_API_BASE_URL=http://localhost:4001"
cd /d "%~dp0..\.."
npm run dev --workspace client -- --port 5174 --strictPort
