@echo off
rem Forwards 127.0.0.1:80 -> 127.0.0.1:4001 (the isolated demo-test server).
set "FORWARD_TARGET_PORT=4001"
node "%~dp0port80-forwarder.mjs"
