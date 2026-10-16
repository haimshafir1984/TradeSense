@echo off
setlocal
call "%~dp0demo-test-env.cmd"
node "%~dp0enqueue-demo-order.cjs" %*
