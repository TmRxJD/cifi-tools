#!/bin/bash
# Double-clickable launcher installed by the CIFI Bridge .pkg.
set -u

# Homebrew and nvm live outside a Finder-launched shell's minimal PATH.
for p in /opt/homebrew/bin /usr/local/bin; do
  [ -d "$p" ] && export PATH="$p:$PATH"
done
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required but was not found."
  echo "Install it from https://nodejs.org and run this again."
  read -r -p "Press return to close..." _
  exit 1
fi

# --foreground --skip-intro serves immediately with no prompts. Without
# --skip-intro the CLI waits at an interactive question and never opens the
# port, so the site cannot connect.
args=("$@")
[ ${#args[@]} -eq 0 ] && args=(--foreground --skip-intro)

if command -v cifi-bridge >/dev/null 2>&1; then
  cifi-bridge "${args[@]}"
else
  npx -y cifi-bridge@latest "${args[@]}"
fi

echo
echo "CIFI Bridge has stopped. You can close this window."
read -r -p "Press return to close..." _
