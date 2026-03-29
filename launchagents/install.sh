#!/bin/bash
# Install and load ironline-context-mcp LaunchAgent
# Run once: bash launchagents/install.sh
# Re-run after OS updates, new machines, or config changes.

set -e

AGENTS_DIR="$(cd "$(dirname "$0")" && pwd)"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
mkdir -p "$LAUNCH_AGENTS"
mkdir -p "$HOME/Library/Logs/ironline"

# Load secrets from ~/.bashrc
# shellcheck disable=SC1090
source "$HOME/.bashrc" 2>/dev/null || true

if [ -z "$LANCE_DB_DEFAULT_API_KEY" ]; then
  echo "ERROR: LANCE_DB_DEFAULT_API_KEY not found in ~/.bashrc"
  exit 1
fi

if [ -z "$OPENAI_API_KEY_AMANDA_IRONLINE_AGENT" ]; then
  echo "ERROR: OPENAI_API_KEY_AMANDA_IRONLINE_AGENT not found in ~/.bashrc"
  exit 1
fi

install_plist() {
  local plist="$1"
  local src="$AGENTS_DIR/$plist"
  local dst="$LAUNCH_AGENTS/$plist"

  sed \
    -e "s|YOUR_LANCE_DB_API_KEY_HERE|$LANCE_DB_DEFAULT_API_KEY|g" \
    -e "s|YOUR_OPENAI_API_KEY_HERE|$OPENAI_API_KEY_AMANDA_IRONLINE_AGENT|g" \
    "$src" > "$dst"

  launchctl unload "$dst" 2>/dev/null || true
  launchctl load "$dst"
  echo "✓ $plist"
}

install_plist "app.ironline.context-mcp.plist"

echo ""
echo "All agents loaded. Check status with:"
echo "  launchctl list | grep ironline"
echo ""
echo "Logs at: ~/Library/Logs/ironline/"
echo "  tail -f ~/Library/Logs/ironline/context-mcp.log"
