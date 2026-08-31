@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo TradeSense - Resolving open ledger entries
echo ============================================
echo.

call npm run ledger:resolve --workspace server

echo.
echo ============================================
echo Done.
echo ============================================
pause
