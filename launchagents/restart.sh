#!/bin/bash
# Restart ironline-context-mcp LaunchAgent
# Usage: bash launchagents/restart.sh

set -e

LAUNCH_AGENTS="$HOME/Library/LaunchAgents"

restart_plist() {
  local plist="$LAUNCH_AGENTS/$1"
  launchctl unload "$plist" 2>/dev/null || true
  launchctl load "$plist"
  echo "✓ $1"
}

restart_plist "app.ironline.context-mcp.plist"

echo ""
echo "Logs at: ~/Library/Logs/ironline/"
echo "  tail -f ~/Library/Logs/ironline/context-mcp.log"
