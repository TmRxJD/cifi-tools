#!/bin/bash
# Launcher installed to /usr/bin by the .deb / .rpm.
set -u

[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required but was not found."
  echo "Install it with your package manager or from https://nodejs.org"
  exit 1
fi

# --foreground --skip-intro serves immediately with no prompts. Without
# --skip-intro the CLI waits at an interactive question and never opens the
# port, so the site cannot connect.
args=("$@")
[ ${#args[@]} -eq 0 ] && args=(--foreground --skip-intro)

if command -v cifi-bridge >/dev/null 2>&1; then
  exec cifi-bridge "${args[@]}"
else
  exec npx -y cifi-bridge@latest "${args[@]}"
fi
