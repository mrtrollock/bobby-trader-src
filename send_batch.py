#!/usr/bin/env python3
"""Bobby Trader — batched Telegram proposals (one message per platform, one Mini App button per trade).

    python3 send_batch.py send proposals.json [--dry]   # proposals.json = JSON list of trade dicts (make_proposal.py fields)
    python3 send_batch.py check [--dry] [--watch SECONDS] [--every 60]
    python3 send_batch.py done <proposal_id> [--dry]    # manual override (marks one trade executed)
    python3 send_batch.py status
    python3 send_batch.py test [--dry]                  # harmless demo batch (cancels of fake order ids: the app blocks them)

Each trade may also carry "line" (custom text line) and "btn" (custom button label); both are stripped from the link.
Grouping: pf "arcus" -> 🏹 ARCUS message; pf "hl" with market "io:XXX" -> 🤖 ENTROPY message; other hl -> 🤖 HYPERLIQUID.

Execution detection (no server needed): the Mini App is opened from an inline button, so Telegram's WebApp.sendData
is not available (keyboard-button only) and answerWebAppQuery would need a server. Instead `check` compares each
proposal with the LIVE account state read from the public Arcus / Hyperliquid read endpoints, relative to a baseline
snapshot taken when the batch was sent:
  open market  -> position moved in the proposal's direction by >= 50 % of sz
  open limit   -> a new (non-baseline) resting order on that market/side at px (±0.5 %), or the position moved as above
  tpsl         -> live TP/SL trigger orders on that market at the proposed sl / tp
  cancel       -> the order id (present at send time) is gone
When every trade of a message is executed, the message is edited (editMessageText): green ✅ header, ✅ on each line,
buttons removed. Lines are ticked one by one as trades are detected. Expired, unexecuted trades get ⌛.
Config (env): TELEGRAM_BOT_TOKEN (never printed), TELEGRAM_CHAT_ID, BOBBY_ACCOUNT_ADDRESS (public address read for
execution detection), BOBBY_APP_URL (where the Mini App is hosted), optional ARCUS_ACCOUNT_INDEX.
State: batches.json next to this script (chmod 600): message_id, proposal ids, baselines, done flags.
"""
import argparse, html, json, os, sys, time, urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from make_proposal import make_url  # noqa: E402

BASE_URL = os.environ.get("BOBBY_APP_URL", "https://example.github.io/bobby-trader/")
STATE = Path(__file__).with_name("batches.json")
ADDRESS = os.environ.get("BOBBY_ACCOUNT_ADDRESS", "")   # Arcus owner address = Hyperliquid master (public, read-only use)
ARCUS_SUB = int(os.environ.get("ARCUS_ACCOUNT_INDEX", "0"))
ARCUS = "https://api.arcus.xyz"
HL = "https://api.hyperliquid.xyz/info"
NUM = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"]
STRIP = ("line", "btn")


# ------------------------------------------------------------------ http helpers
def _get(url, params=None):
    if params:
        url += "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "bobby-batch"}), timeout=20) as r:
        return json.load(r)

def _post(url, body):
    req = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)

def tg(method, payload):
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token:
        sys.exit("TELEGRAM_BOT_TOKEN is not set")
    try:
        res = _post(f"https://api.telegram.org/bot{token}/{method}", payload)
    except urllib.error.HTTPError as e:   # never echo the URL (it contains the token)
        res = json.loads(e.read().decode() or "{}")
    if not res.get("ok"):
        desc = str(res.get("description", "unknown error"))
        if "message is not modified" in desc:
            return None
        raise RuntimeError(f"Telegram {method} failed: {desc}")
    return res["result"]

import urllib.parse  # noqa: E402  (after tg() so the module reads top-down)


# ------------------------------------------------------------------ live state
def arcus_state():
    pos = _get(ARCUS + "/v1/positions", {"address": ADDRESS, "accountIndex": ARCUS_SUB}).get("positions") or []
    pos = pos if isinstance(pos, list) else list(pos.values())
    oo = _get(ARCUS + "/v1/openOrders", {"address": ADDRESS, "accountIndex": ARCUS_SUB}).get("orders") or []
    sizes = {}
    for p in pos:
        sz = abs(float(p.get("size") or 0))
        sizes[p["marketDisplayName"].upper()] = sz if str(p.get("side", "")).upper() in ("LONG", "BUY") else -sz
    orders = [{"id": str(o["orderId"]), "m": o["marketDisplayName"].upper(), "side": "buy" if o.get("side") == "BUY" else "sell",
               "px": float(o.get("price") or 0), "trig": float(o["triggerPrice"]) if o.get("triggerPrice") else None,
               "kind": o.get("tpslType") or "LIMIT"} for o in oo]
    return {"sizes": sizes, "orders": orders}

def hl_state(dex):
    body = {"type": "clearinghouseState", "user": ADDRESS}
    if dex:
        body["dex"] = dex
    st = _post(HL, body)
    oo = _post(HL, {**body, "type": "frontendOpenOrders"})
    sizes = {p["position"]["coin"]: float(p["position"]["szi"]) for p in st.get("assetPositions", [])}
    orders = []
    for o in oo:
        ot = str(o.get("orderType", ""))
        kind = "STOP_LOSS" if ot.startswith("Stop") else "TAKE_PROFIT" if ot.startswith("Take Profit") else "LIMIT"
        orders.append({"id": str(o["oid"]), "m": o["coin"], "side": "buy" if o.get("side") == "B" else "sell",
                       "px": float(o.get("limitPx") or 0), "trig": float(o["triggerPx"]) if o.get("isTrigger") else None, "kind": kind})
    return {"sizes": sizes, "orders": orders}

def arcus_key(m):
    m = m.upper()
    return m if m.endswith("-USD") else m + "-USD"

def state_for(trades):
    """Fetch only the venues these trades need. Returns {venue: state}."""
    need, out = set(), {}
    for t in trades:
        need.add("arcus" if t["pf"] == "arcus" else "hl:" + (t["m"].split(":")[0] if ":" in t["m"] else ""))
    for v in need:
        out[v] = arcus_state() if v == "arcus" else hl_state(v[3:])
    return out

def venue(t):
    return "arcus" if t["pf"] == "arcus" else "hl:" + (t["m"].split(":")[0] if ":" in t["m"] else "")

def mkey(t):
    return arcus_key(t["m"]) if t["pf"] == "arcus" else t["m"]

def baseline(t, st):
    s = st[venue(t)]
    return {"size": s["sizes"].get(mkey(t), 0.0), "orders": [o["id"] for o in s["orders"]]}

def near(a, b, rel):
    return a is not None and b is not None and abs(float(a) - float(b)) <= rel * abs(float(b)) + 1e-12

def executed(t, base, st):
    s = st[venue(t)]
    m, act = mkey(t), t.get("act", "open")
    mine = [o for o in s["orders"] if o["m"] == m]
    if act == "cancel":
        oid = str(t.get("oid"))
        return oid in base["orders"] and all(o["id"] != oid for o in s["orders"])
    if act == "tpsl":
        ok_sl = t.get("sl") is None or any(o["kind"] == "STOP_LOSS" and near(o["trig"], t["sl"], 1e-4) for o in mine)
        ok_tp = t.get("tp") is None or any(o["kind"] == "TAKE_PROFIT" and near(o["trig"], t["tp"], 1e-4) for o in mine)
        return ok_sl and ok_tp
    sign = 1 if t["sd"] == "long" else -1
    moved = (s["sizes"].get(m, 0.0) - base["size"]) * sign
    if moved >= 0.5 * float(t["sz"]):
        return True
    if t.get("et") == "limit":
        side = "buy" if sign > 0 else "sell"
        return any(o["id"] not in base["orders"] and o["kind"] == "LIMIT" and o["side"] == side and near(o["px"], t["px"], 0.005) for o in mine)
    return False


# ------------------------------------------------------------------ message rendering
def group_of(t):
    if t["pf"] == "arcus":
        return "arcus"
    return "entropy" if t["m"].startswith("io:") else "hl"

TITLE = {"arcus": "🏹 ARCUS", "entropy": "🤖 ENTROPY", "hl": "🤖 HYPERLIQUID"}

def short(m):
    return m.split(":")[-1].replace("-USD", "")

def fmt(x):
    return f"{float(x):,.6g}".replace(",", " ")

def default_line(t):
    act = t.get("act", "open")
    if act == "cancel":
        return f"❌ Annuler l’ordre {short(t['m'])} (oid {t.get('oid')})"
    if act == "tpsl":
        parts = [f"SL {fmt(t['sl'])}" if t.get("sl") is not None else None, f"TP {fmt(t['tp'])}" if t.get("tp") is not None else None]
        return f"🎯 TP/SL {short(t['m'])} : " + " · ".join(p for p in parts if p)
    side = "🟢 LONG" if t["sd"] == "long" else "🔴 SHORT"
    entry = "market" if t["et"] == "market" else f"limite {fmt(t['px'])}"
    bits = [f"{side} {short(t['m'])} {fmt(t['sz'])} · {t['lev']}× · {entry}"]
    if t.get("sl") is not None:
        bits.append(f"SL {fmt(t['sl'])}")
    if t.get("tp") is not None:
        bits.append(f"TP {fmt(t['tp'])}")
    return " · ".join(bits)

def default_btn(t):
    act = t.get("act", "open")
    if act == "cancel":
        return f"Annuler {short(t['m'])}"
    if act == "tpsl":
        return f"TP/SL {short(t['m'])}"
    return f"{'LONG' if t['sd'] == 'long' else 'SHORT'} {short(t['m'])}"

def render(b, now=None):
    now = now or time.time()
    done = [p["done"] for p in b["proposals"]]
    lines = []
    for i, p in enumerate(b["proposals"]):
        t = p["trade"]
        mark = "✅" if p["done"] else ("⌛" if t.get("exp") and now > t["exp"] else NUM[i] if i < len(NUM) else f"{i + 1}.")
        note = f"\n    <i>{html.escape(t['n'])}</i>" if t.get("n") else ""
        lines.append(f"{mark} {html.escape(p['line'])}{note}")
    head = f"<b>{TITLE[b['group']]}</b> · {len(done)} trade{'s' if len(done) > 1 else ''}"
    if all(done):
        head = f"✅ <b>{TITLE[b['group']]}</b> · tout est exécuté"
    elif any(done):
        head += f" · {sum(done)}/{len(done)} exécuté{'s' if sum(done) > 1 else ''}"
    text = head + "\n\n" + "\n".join(lines)
    if not all(done) and not b.get("closed"):
        text += "\n\n<i>Appuie sur un bouton pour vérifier et approuver dans l’app.</i>"
    rows, row = [], []
    for i, p in enumerate(b["proposals"]):
        t = p["trade"]
        if p["done"] or (t.get("exp") and now > t["exp"]):
            continue
        row.append({"text": f"{NUM[i] if i < len(NUM) else i + 1} {p['btn']}", "web_app": {"url": p["url"]}})
        if len(row) == 2:
            rows.append(row); row = []
    if row:
        rows.append(row)
    return text, {"inline_keyboard": rows}


# ------------------------------------------------------------------ state
def load():
    return json.loads(STATE.read_text()) if STATE.exists() else {"batches": []}

def save(s):
    STATE.write_text(json.dumps(s, indent=1, ensure_ascii=False))
    os.chmod(STATE, 0o600)

def chat_id():
    cid = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    if not cid:
        sys.exit("TELEGRAM_CHAT_ID is not set")
    return cid


# ------------------------------------------------------------------ commands
def cmd_send(trades, dry=False, base_url=BASE_URL):
    groups = {}
    for t in trades:
        groups.setdefault(group_of(t), []).append(t)
    st = state_for(trades)
    s, sent = load(), []
    for g in ("arcus", "entropy", "hl"):
        if g not in groups:
            continue
        props = []
        for t in groups[g]:
            clean = {k: v for k, v in t.items() if k not in STRIP}
            url = make_url(base_url, clean)
            tok = url.split("#p=")[1]
            decoded = json.loads(__import__("base64").urlsafe_b64decode(tok.split(".")[1] + "==="))
            props.append({"id": decoded["id"], "trade": decoded, "url": url, "line": t.get("line") or default_line(decoded),
                          "btn": t.get("btn") or default_btn(decoded), "baseline": baseline(decoded, st), "done": False, "done_at": None})
        b = {"group": g, "chat_id": chat_id() if not dry else "DRY", "message_id": None, "created": int(time.time()),
             "closed": False, "proposals": props}
        text, kb = render(b)
        if dry:
            print(f"--- [DRY] message {TITLE[g]}\n{text}\nbuttons: {[[x['text'] for x in r] for r in kb['inline_keyboard']]}\n")
        else:
            msg = tg("sendMessage", {"chat_id": b["chat_id"], "text": text, "parse_mode": "HTML", "reply_markup": kb,
                                     "disable_web_page_preview": True})
            b["message_id"] = msg["message_id"]
            s["batches"].append(b)
        sent.append({"group": g, "message_id": b["message_id"], "ids": [p["id"] for p in props]})
    if not dry:
        save(s)
    return sent

def _edit(b, dry, now=None):
    text, kb = render(b, now)
    if dry:
        print(f"--- [DRY] edit {b['message_id']}\n{text}\n")
        return
    tg("editMessageText", {"chat_id": b["chat_id"], "message_id": b["message_id"], "text": text, "parse_mode": "HTML",
                           "reply_markup": kb, "disable_web_page_preview": True})

def cmd_check(dry=False, now=None, fetch=state_for):
    now = now or time.time()
    s = load()
    open_b = [b for b in s["batches"] if not b.get("closed")]
    if not open_b:
        return []
    st = fetch([p["trade"] for b in open_b for p in b["proposals"] if not p["done"]] or [open_b[0]["proposals"][0]["trade"]])
    report = []
    for b in open_b:
        changed = False
        for p in b["proposals"]:
            if not p["done"] and executed(p["trade"], p["baseline"], st):
                p["done"], p["done_at"], changed = True, int(now), True
        expired = all(p["done"] or (p["trade"].get("exp") and now > p["trade"]["exp"]) for p in b["proposals"])
        if expired:
            b["closed"], changed = True, True
        if changed:
            _edit(b, dry, now)
        report.append({"message_id": b["message_id"], "group": b["group"], "done": sum(p["done"] for p in b["proposals"]),
                       "total": len(b["proposals"]), "closed": b["closed"]})
    if not dry:
        save(s)
    return report

def cmd_done(pid, dry=False):
    s = load()
    for b in s["batches"]:
        for p in b["proposals"]:
            if p["id"] == pid:
                p["done"], p["done_at"] = True, int(time.time())
                if all(x["done"] for x in b["proposals"]):
                    b["closed"] = True
                _edit(b, dry)
                if not dry:
                    save(s)
                return b
    sys.exit(f"unknown proposal id {pid}")

def test_trades():
    exp = int(time.time()) + 3600
    return [
        {"id": "test-a1", "pf": "arcus", "m": "NVDA-USD", "act": "cancel", "oid": "test0000000000a1", "exp": exp, "n": "TEST, l’app doit bloquer (ordre introuvable)"},
        {"id": "test-a2", "pf": "arcus", "m": "GLD-USD", "act": "cancel", "oid": "test0000000000a2", "exp": exp, "n": "TEST, rien ne sera envoyé"},
        {"id": "test-e1", "pf": "hl", "m": "io:ANTH", "act": "cancel", "oid": 1, "exp": exp, "n": "TEST, l’app doit bloquer (ordre introuvable)"},
    ]

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("send"); a.add_argument("file"); a.add_argument("--dry", action="store_true"); a.add_argument("--base", default=BASE_URL)
    a = sub.add_parser("check"); a.add_argument("--dry", action="store_true"); a.add_argument("--watch", type=int, default=0); a.add_argument("--every", type=int, default=60)
    a = sub.add_parser("done"); a.add_argument("id"); a.add_argument("--dry", action="store_true")
    sub.add_parser("status")
    a = sub.add_parser("test"); a.add_argument("--dry", action="store_true")
    o = ap.parse_args()
    if o.cmd == "send":
        print(json.dumps(cmd_send(json.loads(Path(o.file).read_text()), o.dry, o.base), ensure_ascii=False))
    elif o.cmd == "test":
        print(json.dumps(cmd_send(test_trades(), o.dry), ensure_ascii=False))
    elif o.cmd == "check":
        end = time.time() + o.watch
        while True:
            rep = cmd_check(o.dry)
            print(json.dumps(rep, ensure_ascii=False), flush=True)
            if time.time() >= end or not any(not r["closed"] for r in rep):
                break
            time.sleep(o.every)
    elif o.cmd == "done":
        cmd_done(o.id, o.dry); print("ok")
    elif o.cmd == "status":
        for b in load()["batches"]:
            print(b["group"], b["message_id"], "closed" if b.get("closed") else "open",
                  [(p["id"], "✅" if p["done"] else "…") for p in b["proposals"]])

if __name__ == "__main__":
    main()
