# MT4 (Colmex demo) under Wine, with a virtual screen reachable only through an SSH tunnel (noVNC).
# Not officially supported by the broker: keep the terminal installer URL in MT4_INSTALLER_URL.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN dpkg --add-architecture i386 \
 && apt-get update \
 && apt-get install -y --no-install-recommends wine wine32:i386 wine64 winbind cabextract wget ca-certificates \
      xvfb x11vnc fluxbox novnc websockify xdotool procps \
 && rm -rf /var/lib/apt/lists/*
ENV WINEPREFIX=/data/wine WINEARCH=win32 WINEDEBUG=-all DISPLAY=:1
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 6080
ENTRYPOINT ["/entrypoint.sh"]
