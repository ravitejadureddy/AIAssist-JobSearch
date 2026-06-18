#!/bin/bash
# Single entry-point called by CareerOps.app.
# Starts dashboard-server.mjs if needed, then launches Fill Agent Chrome.

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

  # Wait up to 15 seconds
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
