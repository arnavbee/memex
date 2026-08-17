#!/bin/bash
# Installs the OmniContext daemon as a macOS launchd agent so it starts at
# login and restarts if it crashes.
set -euo pipefail

LABEL="com.omnicontext.daemon"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node)"
LOG_DIR="$HOME/.omnicontext"

if [ ! -f "$PROJECT_DIR/dist/index.js" ]; then
  echo "dist/index.js not found — run 'npm run build' first." >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$PROJECT_DIR/dist/index.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/daemon.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/daemon.log</string>
</dict>
</plist>
EOF

# Reload if already installed
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "Installed and started $LABEL"
echo "  plist: $PLIST"
echo "  logs:  $LOG_DIR/daemon.log"
echo ""
echo "NOTE: for Safari history + Apple Notes capture, grant Full Disk Access"
echo "to $NODE_BIN in System Settings > Privacy & Security."
