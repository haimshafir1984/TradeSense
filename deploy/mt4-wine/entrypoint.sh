#!/bin/bash
set -u
mkdir -p /data
Xvfb :1 -screen 0 1280x800x24 -nolisten tcp &
sleep 2
fluxbox >/dev/null 2>&1 &
x11vnc -display :1 -forever -shared -nopw -localhost -rfbport 5901 -quiet &
websockify --web /usr/share/novnc 6080 localhost:5901 >/dev/null 2>&1 &

[ -d "$WINEPREFIX" ] || wineboot -i >/dev/null 2>&1

find_terminal() { find "$WINEPREFIX/drive_c" -iname terminal.exe -path "*MT4*" 2>/dev/null | head -1; }
TERMINAL="$(find_terminal)"
if [ -z "$TERMINAL" ]; then
  if [ -z "${MT4_INSTALLER_URL:-}" ]; then echo "MT4_INSTALLER_URL is not set and MT4 is not installed yet"; sleep 3600; exit 1; fi
  wget -q -O /data/mt4setup.exe "$MT4_INSTALLER_URL" || { echo "installer download failed"; sleep 3600; exit 1; }
  wine /data/mt4setup.exe /auto
  sleep 5
  TERMINAL="$(find_terminal)"
fi
[ -n "$TERMINAL" ] || { echo "terminal.exe not found after install; open the desktop through the tunnel and finish the installer by hand"; sleep 86400; exit 1; }

# Copy the EA sources placed in /ea and compile them with MetaEditor, so no Windows machine is needed.
DIR="$(dirname "$TERMINAL")"
if ls /ea/*.mq4 >/dev/null 2>&1; then
  mkdir -p "$DIR/MQL4/Experts"
  cp /ea/*.mq4 /ea/*.mqh "$DIR/MQL4/Experts/" 2>/dev/null
  EDITOR="$(find "$DIR" -maxdepth 1 -iname metaeditor.exe | head -1)"
  [ -n "$EDITOR" ] && wine "$EDITOR" /compile:"$DIR/MQL4/Experts/TradeSenseExecutionEA.mq4" /log >/dev/null 2>&1
fi

# Keep the terminal running; restart it if it exits.
while true; do
  wine "$TERMINAL" >/dev/null 2>&1
  sleep 10
done
