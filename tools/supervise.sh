#!/usr/bin/env bash
# Supervisor for Bobby's autotrader loop (portable: box, Hetzner VM, systemd ExecStart=; no machine-specific paths).
#   setsid nohup bash tools/supervise.sh >> autotrader/logs/supervisor.out 2>&1 < /dev/null &
# - runs `node autotrader/cli.js loop` with the trading env from BOBBY_ENV_FILE (~/.bobby-autotrader.env, chmod 600;
#   never printed, never copied)
# - restarts the loop when it exits, or when no tick has completed for BOBBY_STALL_RESTART_S (600 s): the loop writes
#   AUTOTRADER_HEARTBEAT_FILE after every finished tick. A restart is a graceful SIGTERM (the loop stops after its
#   current tick, so no order action is cut in half), SIGKILL only after BOBBY_TERM_WAIT_S (120 s).
# - exit code 2 = key/permission check failed: NOT restarted (needs a human); the loop already wrote autotrader/ALERT
# - a suspended machine (this script's own sleep took far longer than asked) is not a stall: the heartbeat clock is
#   reset on resume so a healthy loop is not killed just because the whole box was frozen
# - restart backoff 10 s .. 5 min; stop: kill the pid in BOBBY_SUPERVISOR_PID (default autotrader/logs/supervisor.pid)
set -uo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
ENV_FILE=${BOBBY_ENV_FILE:-$HOME/.bobby-autotrader.env}
LOGDIR=${BOBBY_LOG_DIR:-$REPO/autotrader/logs}
LOOP_LOG=${BOBBY_LOOP_LOG:-$LOGDIR/loop.out}
PIDF=${BOBBY_SUPERVISOR_PID:-$LOGDIR/supervisor.pid}
export AUTOTRADER_HEARTBEAT_FILE=${AUTOTRADER_HEARTBEAT_FILE:-$LOGDIR/heartbeat}
STALL=${BOBBY_STALL_RESTART_S:-600}
CHECK=${BOBBY_CHECK_S:-30}
TERM_WAIT=${BOBBY_TERM_WAIT_S:-120}
NODE=${NODE:-node}
LOOP_CMD=${BOBBY_LOOP_CMD:-"$NODE autotrader/cli.js loop"}   # override only for tests
mkdir -p "$LOGDIR"
say() { echo "$(date -u +%FT%TZ) supervisor: $*"; }
ALERT_FILE=${BOBBY_ALERT_FILE:-$REPO/autotrader/ALERT}
alert() { printf '{"t":"%s","pf":"loop","kind":"%s","reason":"%s"}\n' "$(date -u +%FT%T.000Z)" "$1" "$2" >> "$ALERT_FILE"; }
echo $$ > "$PIDF"
child=0; stopping=0
stop_child() { # graceful: SIGTERM, wait, then SIGKILL
  [ "$child" -gt 0 ] && kill -0 "$child" 2>/dev/null || return 0
  kill -TERM "$child" 2>/dev/null
  for ((i = 0; i < TERM_WAIT; i++)); do kill -0 "$child" 2>/dev/null || break; sleep 1; done
  kill -0 "$child" 2>/dev/null && { say "loop $child did not stop after ${TERM_WAIT}s: SIGKILL"; kill -KILL "$child" 2>/dev/null; }
  wait "$child" 2>/dev/null; return 0
}
trap 'stopping=1; say "stopping (signal)"; stop_child; rm -f "$PIDF"; exit 0' TERM INT
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }
BACKOFF0=${BOBBY_RESTART_BACKOFF_S:-10}
backoff=$BACKOFF0
cd "$REPO"
while [ "$stopping" -eq 0 ]; do
  [ -f "$ENV_FILE" ] || { say "env file missing ($ENV_FILE): not starting"; alert supervisor "env file missing"; exit 1; }
  started=$(date +%s)
  ( set -a; . "$ENV_FILE"; set +a; exec $LOOP_CMD ) >> "$LOOP_LOG" 2>&1 &
  child=$!
  say "loop started (pid $child)"
  base=$started                 # heartbeat must be newer than max(base, last resume)
  last=$(date +%s); reason=""
  while kill -0 "$child" 2>/dev/null; do
    sleep "$CHECK" & wait $! 2>/dev/null
    now=$(date +%s)
    if [ $((now - last)) -gt $((CHECK * 4)) ]; then say "machine was suspended for $(( (now - last) / 60 )) min: stall clock reset"; base=$now; fi
    last=$now
    hb=$(mtime "$AUTOTRADER_HEARTBEAT_FILE"); [ "$hb" -lt "$base" ] && hb=$base
    if [ $((now - hb)) -gt "$STALL" ]; then reason="no tick completed for $(( (now - hb) / 60 )) min"; break; fi
  done
  if [ -n "$reason" ]; then
    say "STALL: $reason: restarting the loop"; alert supervisor-restart "$reason: loop restarted by the supervisor"
    stop_child
  fi
  wait "$child" 2>/dev/null; code=$?
  [ "$stopping" -eq 1 ] && break
  if [ "$code" -eq 2 ] && [ -z "$reason" ]; then say "loop exited with code 2 (key/permission check failed): NOT restarting"; alert supervisor "loop aborted on a key check (exit 2): not restarted"; rm -f "$PIDF"; exit 2; fi
  ran=$(( $(date +%s) - started ))
  [ "$ran" -gt 600 ] && backoff=$BACKOFF0
  say "loop exited (code $code, ran ${ran}s${reason:+, $reason}): restart in ${backoff}s"
  sleep "$backoff" & wait $!
  backoff=$(( backoff * 2 > 300 ? 300 : backoff * 2 ))
done
