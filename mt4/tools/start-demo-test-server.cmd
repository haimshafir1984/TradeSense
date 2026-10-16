@echo off
setlocal
call "%~dp0demo-test-env.cmd"
set "PORT=4001"
node -e "process.exit(Number(process.versions.node.split('.')[0])>=24?0:1)"
if errorlevel 1 (
  echo Node 24 or newer is required for the server. Found:
  node --version
  exit /b 1
)
if not exist "%~dp0demo-test-data" mkdir "%~dp0demo-test-data"
echo.
echo ISOLATED demo-test server on port 4001 (separate database; the real app and .env are untouched).
echo Broker account id for this test: %EXECUTION_BROKER_ACCOUNT_ID%
echo.
cd /d "%~dp0..\.."
npm run start
