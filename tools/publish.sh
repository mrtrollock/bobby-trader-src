#!/usr/bin/env bash
# Refresh + ENCRYPT + publish the private web-app data. Only *.enc.json files are ever committed.
#   tools/publish.sh            # balances only (python3 balances.py) -> public/balances.enc.json
#   tools/publish.sh briefing   # briefing only (python3 briefing.py) -> public/briefing.enc.json
#   tools/publish.sh all        # balances + briefing (+ public/proposals.enc.json if send_batch.py changed it)
#   tools/publish.sh inbox      # just commit/push public/proposals.enc.json written by send_batch.py
#   tools/publish.sh positions  # open positions + Bobby status only (python3 positions.py) -> public/positions.enc.json
#   (balances / all also refresh public/positions.enc.json; tools/positions_loop.sh publishes it every 5 min from a separate worktree)
# Loads ~/.bobby-autotrader.env (override with BOBBY_ENV_FILE). Refuses without BOBBY_VIEW_PASSPHRASE.
# Commits ONLY those files (path-limited commit) and pushes the web-app branch to the `fork` remote.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE=${BOBBY_ENV_FILE:-$HOME/.bobby-autotrader.env}
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
if [ -z "${BOBBY_VIEW_PASSPHRASE:-}" ]; then echo "refusing to publish: BOBBY_VIEW_PASSPHRASE is not set" >&2; exit 2; fi
what=${1:-balances}
files=()
case "$what" in
  balances) python3 balances.py; files=(public/balances.enc.json public/positions.enc.json) ;;
  positions) python3 positions.py; files=(public/positions.enc.json) ;;
  briefing) python3 briefing.py; files=(public/briefing.enc.json) ;;
  all)      python3 balances.py; python3 briefing.py; files=(public/balances.enc.json public/briefing.enc.json public/proposals.enc.json public/positions.enc.json) ;;
  inbox)    files=(public/proposals.enc.json) ;;
  *) echo "usage: tools/publish.sh [balances|briefing|all|inbox|positions]" >&2; exit 64 ;;
esac
# guard: every file must be an encrypted envelope (nothing else is allowed onto the public site)
python3 - "${files[@]}" <<'PY'
import json, sys
for p in sys.argv[1:]:
    o = json.load(open(p))
    if not p.endswith(".enc.json") or sorted(o) != sorted(["v", "alg", "kdf", "it", "aad", "salt", "iv", "ct"]) or o["alg"] != "AES-256-GCM":
        sys.exit(f"refusing to publish: {p} is not an encrypted envelope")
PY
[ "$(git branch --show-current)" = web-app ] || { echo "refusing: not on the web-app branch" >&2; exit 3; }
git add -- "${files[@]}"
if git diff --cached --quiet -- "${files[@]}"; then echo "nothing changed"; exit 0; fi
# author: the repo-local identity (git config user.name / user.email, shared by every worktree); refuse without one
git config user.name >/dev/null && git config user.email >/dev/null || { echo "publish FAILED: no repo-local git identity (git config user.name/user.email)" >&2; exit 4; }
fail() { echo "publish FAILED: $1 (nothing reported as published)" >&2; git rebase --abort >/dev/null 2>&1 || true; exit 5; }
git commit -q -m "data: refresh encrypted $what ($(TZ=Europe/Berlin date '+%Y-%m-%d %H:%M %Z'))" -- "${files[@]}" || fail "commit failed"
# the positions loop pushes too: on a non-fast-forward, rebase onto fork/web-app (our encrypted files win) and retry
if ! git push -q fork HEAD:web-app 2>/dev/null; then
  git pull -q --rebase --autostash -X theirs fork web-app || fail "rebase onto fork/web-app failed"
  git push -q fork HEAD:web-app || fail "push failed"
fi
[ "$(git rev-parse HEAD)" = "$(git rev-parse fork/web-app)" ] || fail "fork/web-app does not match HEAD after push"
[ "$(git branch --show-current)" = web-app ] || fail "not back on the web-app branch"
echo "published: ${files[*]} (encrypted) -> fork/web-app"
