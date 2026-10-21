#!/usr/bin/env bash
# Refresh + ENCRYPT + publish the private web-app data. Only *.enc.json files are ever committed.
#   tools/publish.sh            # balances only (python3 balances.py) -> public/balances.enc.json
#   tools/publish.sh briefing   # briefing only (python3 briefing.py) -> public/briefing.enc.json
#   tools/publish.sh all        # balances + briefing (+ public/proposals.enc.json if send_batch.py changed it)
#   tools/publish.sh inbox      # just commit/push public/proposals.enc.json written by send_batch.py
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
  balances) python3 balances.py; files=(public/balances.enc.json) ;;
  briefing) python3 briefing.py; files=(public/briefing.enc.json) ;;
  all)      python3 balances.py; python3 briefing.py; files=(public/balances.enc.json public/briefing.enc.json public/proposals.enc.json) ;;
  inbox)    files=(public/proposals.enc.json) ;;
  *) echo "usage: tools/publish.sh [balances|briefing|all|inbox]" >&2; exit 64 ;;
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
name=$(git log -1 --format=%an); mail=$(git log -1 --format=%ae)
git -c user.name="$name" -c user.email="$mail" commit -q -m "data: refresh encrypted $what ($(TZ=Europe/Berlin date '+%Y-%m-%d %H:%M %Z'))" -- "${files[@]}"
git push -q fork HEAD:web-app
echo "published: ${files[*]} (encrypted) -> fork/web-app"
