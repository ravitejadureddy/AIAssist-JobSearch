#!/bin/bash
# Single entry-point called by CareerOps.app.
# Starts dashboard-server.mjs, launches Fill Agent Chrome with the dashboard
# tab, then STAYS RUNNING as a lifecycle monitor:
#   - If the user closes the dashboard tab, the server's SSE-disconnect
#     handler fullShutdown()s after ~3 seconds. start.sh sees the server
#     died → cleans up Chrome → exits → CareerOps.app icon goes away.
#   - If the user quits the CareerOps app (Cmd+Q on dock icon), the trap
#     fires → kills the server + Chrome → exits cleanly.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="/usr/local/bin/node"
LOG="/tmp/careeropsdashboard.log"
DASHBOARD="http://127.0.0.1:3000"

# Verify prerequisites
if [ ! -d "$SCRIPT_DIR" ]; then
  echo "ERROR: career-ops directory not found at $SCRIPT_DIR" >&2; exit 1
fi
if [ ! -f "$NODE" ]; then
  echo "ERROR: Node.js not found at $NODE" >&2; exit 1
fi

# Start dashboard server if not already running
if ! curl -s --max-time 1 "$DASHBOARD" >/dev/null 2>&1; then
  cd "$SCRIPT_DIR"
  # </dev/null + nohup ensures the process survives after the calling shell exits
  nohup "$NODE" dashboard-server.mjs >> "$LOG" 2>&1 </dev/null &
  SERVER_PID=$!

  # Wait up to 15 seconds for server to respond
  for i in $(seq 1 30); do
    sleep 0.5
    curl -s --max-time 1 "$DASHBOARD" >/dev/null 2>&1 && break
    # Bail early if the process already died
    kill -0 "$SERVER_PID" 2>/dev/null || {
      echo "ERROR: dashboard-server crashed on startup. Check $LOG" >&2; exit 1
    }
  done

  if ! curl -s --max-time 1 "$DASHBOARD" >/dev/null 2>&1; then
    echo "ERROR: Server did not respond within 15 s. Check $LOG" >&2; exit 1
  fi
fi

# Launch Fill Agent Chrome (kills old instance, opens fresh window with dashboard tab)
bash "$SCRIPT_DIR/launch-chrome.sh"

# Discover the actually-running dashboard server PID (covers the case where
# someone else started it before us).
SERVER_PID=$(pgrep -f "node dashboard-server.mjs" | head -1)
if [ -z "$SERVER_PID" ]; then
  echo "ERROR: dashboard-server.mjs PID not found after startup" >&2; exit 1
fi

# Trap: when this script exits for any reason (user quits the app via dock,
# SIGTERM from macOS shutdown, etc.) → kill the server + Chrome. The server's
# own SIGTERM handler runs fullShutdown() which is idempotent with this.
cleanup() {
  pkill -f "remote-debugging-port=9222" 2>/dev/null
  kill "$SERVER_PID" 2>/dev/null
  exit 0
}
trap cleanup SIGTERM SIGINT EXIT

# Long-running monitor: stay alive as long as the dashboard server is alive.
# This keeps the CareerOps.app dock icon present during the session, and
# disappears when the server quits (via SSE-disconnect, watchdog, or signal).
while kill -0 "$SERVER_PID" 2>/dev/null; do
  sleep 2
done

# Server died on its own → trap (EXIT) will clean up Chrome and exit.
