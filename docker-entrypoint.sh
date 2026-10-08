#!/bin/sh
# Fly mounts a fresh volume owned by root. The container starts as root only
# long enough to hand /app/data to the node user, then drops privileges for
# the real command (the app, or the migrator as the release command).
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p /app/data
  chown -R node:node /app/data
  exec runuser -u node -- "$@"
fi
exec "$@"
