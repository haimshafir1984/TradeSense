@echo off
rem Shared settings for the ISOLATED demo end-to-end test.
rem Nothing here touches the real app database or the .env file.
if exist "C:\node24\node-v24.16.0-win-x64\node.exe" set "PATH=C:\node24\node-v24.16.0-win-x64;%PATH%"
set "AUTOPILOT_DB_PATH=%~dp0demo-test-data\autopilot-demo-test.sqlite"
if not defined EXECUTION_BROKER_ACCOUNT_ID set "EXECUTION_BROKER_ACCOUNT_ID=102992"
set "EXECUTION_QUEUE_ENABLED=true"
set "EXECUTION_AUTONOMY_ENABLED=false"
set "AUTOPILOT_DISABLED=true"
