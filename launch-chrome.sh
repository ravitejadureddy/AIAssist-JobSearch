#!/bin/bash
# Launches a dedicated Chrome window for career-ops Fill Agent.
# Always opens a fresh window — kills any existing Fill Agent Chrome,
# clears stale locks and session files, then starts clean.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROFILE_DIR="$SCRIPT_DIR/data/chrome-profile"
DASHBOARD="http://127.0.0.1:3000"

if [ ! -f "$CHROME" ]; then
  echo "Google Chrome not found at: $CHROME"
  exit 1
fi

mkdir -p "$PROFILE_DIR"

# Kill any existing Fill Agent Chrome
if curl -s --max-time 1 http://localhost:9222/json/version >/dev/null 2>&1; then
  echo "Closing existing Fill Agent Chrome..."
  pkill -f "remote-debugging-port=9222" 2>/dev/null
  sleep 1
fi

# Clear stale singleton locks (left behind by pkill) and session files (prevent restore)
rm -f  "$PROFILE_DIR/SingletonLock" \
       "$PROFILE_DIR/SingletonCookie" \
       "$PROFILE_DIR/SingletonSocket" 2>/dev/null
rm -f  "$PROFILE_DIR/Default/Last Session" \
       "$PROFILE_DIR/Default/Last Tabs" 2>/dev/null
rm -rf "$PROFILE_DIR/Default/Sessions" 2>/dev/null

echo "Launching Fill Agent Chrome..."
echo "  Profile: $PROFILE_DIR"

# Run the Chrome binary directly with the dedicated profile.
# Different user-data-dir from regular Chrome → Chrome creates a new independent process.
# No URL argument — dashboard is opened via CDP once Chrome is ready.
"$CHROME" \
  --remote-debugging-port=9222 \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --disable-sync \
  --disable-features=TranslateUI \
  --disable-session-crashed-bubble \
  2>/dev/null &

# Wait for CDP to come up (up to 15 seconds), then open dashboard tab
for i in $(seq 1 30); do
  if curl -s --max-time 1 http://localhost:9222/json/version >/dev/null 2>&1; then
    sleep 1  # let Chrome finish initializing before creating a tab
    curl -s -X PUT "http://localhost:9222/json/new?$DASHBOARD" >/dev/null 2>&1
    # Close the initial blank/newtab tab Chrome opens on startup
    sleep 0.3
    TABS=$(curl -s http://localhost:9222/json 2>/dev/null)
    BLANK_ID=$(echo "$TABS" | python3 -c "
import sys, json
tabs = json.load(sys.stdin)
for t in tabs:
    if t.get('url','') in ('chrome://newtab/', 'about:blank', ''):
        print(t['id']); break
" 2>/dev/null)
    if [ -n "$BLANK_ID" ]; then
      curl -s "http://localhost:9222/json/close/$BLANK_ID" >/dev/null 2>&1
    fi
    echo "Fill Agent Chrome ready — dashboard tab opened."
    exit 0
  fi
  sleep 0.5
done

echo "Warning: CDP port 9222 not responding after 15s."
