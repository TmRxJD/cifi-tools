#!/bin/bash
# Runs after the .deb/.rpm lays its files down. Best effort: the launcher falls
# back to npx when a global install is not possible.
set -u

if command -v npm >/dev/null 2>&1; then
  npm install -g cifi-bridge@latest --no-audit --no-fund --loglevel=error \
    || echo "[cifi-bridge] global install failed; the launcher will use npx"
else
  echo "[cifi-bridge] npm not found; the launcher will use npx"
fi

exit 0
