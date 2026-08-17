#!/bin/bash
# Stops and removes the OmniContext launchd agent. The database is untouched.
set -euo pipefail

LABEL="com.omnicontext.daemon"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "Uninstalled $LABEL (database in ~/.omnicontext is untouched)."
