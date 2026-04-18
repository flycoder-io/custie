#!/usr/bin/env bash
# Custie health check — prints a structured status report.
# Exits 0 if healthy, 1 if any critical check fails.

set -u

LABEL="io.flycoder.custie"
LOG_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/custie/logs"
LOG_FILE="$LOG_DIR/custie.log"
ERR_FILE="$LOG_DIR/custie-error.log"
CONFIG_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/custie/config.env"

# How many recent error-log lines to surface
ERR_TAIL="${ERR_TAIL:-20}"
# How far back in the main log to scan for "error" hits
LOG_SCAN="${LOG_SCAN:-500}"

fail=0
uname_s="$(uname -s)"

section() { printf '\n=== %s ===\n' "$1"; }

section "Service"
pid=""
case "$uname_s" in
  Darwin)
    status_line=$(launchctl list 2>/dev/null | awk -v l="$LABEL" '$3==l {print}')
    if [ -n "$status_line" ]; then
      pid=$(printf '%s' "$status_line" | awk '{print $1}')
      exit_code=$(printf '%s' "$status_line" | awk '{print $2}')
      if [ "$pid" = "-" ]; then
        echo "NOT RUNNING (label=$LABEL, last exit=$exit_code)"
        fail=1
        pid=""
      else
        started=$(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//')
        elapsed=$(ps -o etime= -p "$pid" 2>/dev/null | sed 's/^ *//')
        echo "running  pid=$pid  last_exit=$exit_code  label=$LABEL"
        echo "started  $started  (uptime $elapsed)"
      fi
    else
      echo "NOT LOADED (no launchd entry for $LABEL). Try: custie install"
      fail=1
    fi
    ;;
  Linux)
    if command -v systemctl >/dev/null 2>&1; then
      if systemctl --user is-active --quiet custie 2>/dev/null; then
        echo "running (systemd --user: custie)"
        systemctl --user status custie --no-pager -n 0 2>/dev/null | sed -n '1,5p'
      else
        echo "NOT RUNNING (systemd --user: custie)"
        systemctl --user status custie --no-pager -n 0 2>/dev/null | sed -n '1,5p'
        fail=1
      fi
    else
      echo "systemctl not found — cannot check service state"
      fail=1
    fi
    ;;
  *)
    echo "Unsupported platform: $uname_s"
    fail=1
    ;;
esac

section "Config"
if [ -f "$CONFIG_FILE" ]; then
  echo "config: $CONFIG_FILE"
  missing=""
  for key in SLACK_BOT_TOKEN SLACK_APP_TOKEN SLACK_SIGNING_SECRET; do
    if ! grep -qE "^\s*${key}\s*=\s*\S" "$CONFIG_FILE"; then
      missing="$missing $key"
    fi
  done
  if [ -n "$missing" ]; then
    echo "MISSING required keys:$missing"
    fail=1
  else
    echo "required Slack keys present"
  fi
  if command -v custie >/dev/null 2>&1; then
    if ! custie config >/dev/null 2>&1; then
      echo "\`custie config\` failed — config not loadable"
      fail=1
    fi
  fi
else
  echo "config file missing: $CONFIG_FILE"
  fail=1
fi

section "Logs"
if [ -f "$LOG_FILE" ]; then
  mtime=$(stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "$LOG_FILE" 2>/dev/null \
          || stat -c '%y' "$LOG_FILE" 2>/dev/null)
  echo "$LOG_FILE (last write: $mtime)"
  # Note: when stdout is redirected to a file by launchd, Node may buffer
  # writes until a chunk fills up. A stale mtime on a running service is
  # not by itself an error — cross-check with the uptime above.
else
  echo "stdout log missing: $LOG_FILE"
fi

if [ -f "$ERR_FILE" ]; then
  size=$(wc -c < "$ERR_FILE" | tr -d ' ')
  echo "$ERR_FILE (${size} bytes)"
  if [ "$size" -gt 0 ]; then
    echo "--- last $ERR_TAIL lines of stderr ---"
    tail -n "$ERR_TAIL" "$ERR_FILE"
  fi
else
  echo "stderr log missing: $ERR_FILE"
fi

section "Recent connection events"
# Pulls lines written by src/index.ts for startup / socket connect / reconnect /
# disconnect / shutdown. This is the signal for "when did custie last come
# online after the laptop was off or asleep?" — much more useful than the
# raw file mtime on a buffered stdout.
if [ -f "$LOG_FILE" ]; then
  events=$(grep -E '\[custie\] (starting|started|shutting down|socket (connected|reconnecting|disconnected))' "$LOG_FILE" \
           | tail -n 10)
  if [ -n "$events" ]; then
    printf '%s\n' "$events"
  else
    echo "no lifecycle events recorded yet (older build? run \`pnpm run build\` and restart the service)"
  fi
fi

section "Recent errors in stdout log"
if [ -f "$LOG_FILE" ]; then
  hits=$(tail -n "$LOG_SCAN" "$LOG_FILE" \
         | grep -iE '\b(error|fatal|exception|unhandled|uncaught)\b' \
         | tail -n 10)
  if [ -n "$hits" ]; then
    printf '%s\n' "$hits"
  else
    echo "none in last $LOG_SCAN lines"
  fi
fi

section "Summary"
if [ "$fail" -eq 0 ]; then
  echo "OK"
else
  echo "ISSUES DETECTED — see sections above"
fi
exit "$fail"
