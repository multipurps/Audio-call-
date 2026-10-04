#!/bin/sh
set -e
mkdir -p "$SIGNAL_DATA_DIR" /tmp/runtime
chown -R app:app "$SIGNAL_DATA_DIR" /tmp/runtime
chmod 700 /tmp/runtime
export XDG_RUNTIME_DIR=/tmp/runtime HOME=/home/app
# PulseAudio must run before any call (the tunnel creates virtual devices per call).
runuser -u app -- pulseaudio --daemonize=yes --exit-idle-time=-1 --disallow-exit --log-target=stderr
exec runuser -u app -- node /app/server.mjs
