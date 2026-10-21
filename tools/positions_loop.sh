#!/usr/bin/env bash
# Publish open positions + Bobby status (public/positions.enc.json, ENCRYPTED) every POSITIONS_EVERY_S seconds (default 300).
# Read-only: runs positions.py (no trading code, no signing keys) and pushes ONLY that file from a separate git worktree,
# so the main working tree (other edits in progress) is never touched.  Stop: kill the pid in /tmp/bobby-positions-loop.pid
set -uo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
WT=${POSITIONS_WORKTREE:-/workspace/.bobby-positions-wt}
EVERY=${POSITIONS_EVERY_S:-300}
ENV_FILE=${BOBBY_ENV_FILE:-$HOME/.bobby-autotrader.env}
echo $$ > /tmp/bobby-positions-loop.pid
cd "$REPO"
[ -d "$WT" ] || git worktree add -q --detach "$WT" fork/web-app
once() {
  set -a; [ -f "$ENV_FILE" ] && . "$ENV_FILE"; set +a
  [ -n "${BOBBY_VIEW_PASSPHRASE:-}" ] || { echo "no passphrase"; return 1; }
  git -C "$WT" fetch -q fork web-app && git -C "$WT" reset -q --hard FETCH_HEAD || return 1
  ( cd "$REPO" && python3 positions.py --out "$WT/public/positions.enc.json" ) || return 1
  python3 - "$WT/public/positions.enc.json" <<'PY' || return 1
import json, sys
o = json.load(open(sys.argv[1]))
if sorted(o) != sorted(["v", "alg", "kdf", "it", "aad", "salt", "iv", "ct"]) or o["alg"] != "AES-256-GCM":
    sys.exit("refusing: not an encrypted envelope")
PY
  git -C "$WT" add -- public/positions.enc.json
  git -C "$WT" diff --cached --quiet && return 0
  name=$(git -C "$WT" log -1 --format=%an); mail=$(git -C "$WT" log -1 --format=%ae)
  git -C "$WT" -c user.name="$name" -c user.email="$mail" commit -q -m "data: refresh encrypted positions ($(TZ=Europe/Berlin date '+%Y-%m-%d %H:%M %Z'))" -- public/positions.enc.json
  git -C "$WT" push -q fork HEAD:web-app
}
while true; do
  once >/dev/null 2>/tmp/bobby-positions-loop.err && echo "$(date '+%F %T') ok" >> /tmp/bobby-positions-loop.log || echo "$(date '+%F %T') failed: $(tail -c 300 /tmp/bobby-positions-loop.err)" >> /tmp/bobby-positions-loop.log
  sleep "$EVERY"
done
