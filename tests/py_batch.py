# Offline checks for send_batch.py: grouping, policy refusal, inbox JSON, execution detection. No network, no Telegram.
import json, sys, tempfile, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import send_batch as SB

tmp = Path(tempfile.mkdtemp())
SB.STATE = tmp / "batches.json"
SB.INBOX = tmp / "proposals.json"
assert not hasattr(SB, "tg") and "TELEGRAM" not in Path(SB.__file__).read_text()
inbox = lambda: json.loads(SB.INBOX.read_text())

now = time.time()
ar0 = {"sizes": {"NVDA-USD": -10.0}, "orders": [{"id": "old1", "m": "NVDA-USD", "side": "buy", "px": 107.1, "trig": 102.0, "kind": "STOP_LOSS"}]}
io0 = {"sizes": {"io:ANTH": -1.0}, "orders": [{"id": "77", "m": "io:ANTH", "side": "buy", "px": 1100, "trig": None, "kind": "LIMIT"}]}
tx0 = {"sizes": {}, "orders": []}
state = {"arcus": ar0, "hl:io": io0, "txflow": tx0}
SB.state_for = lambda trades: state

# policy: market entry, 3x leverage, missing SL are refused before anything is written
for bad in ({"id": "b1", "pf": "arcus", "m": "TSLA-USD", "sd": "long", "sz": 1, "lev": 1, "et": "market", "ref": 400, "sl": 390},
            {"id": "b2", "pf": "hl", "m": "io:OAI", "sd": "short", "sz": 1, "lev": 3, "et": "limit", "px": 900, "sl": 950},
            {"id": "b3", "pf": "txflow", "m": "BTC-USDC", "sd": "long", "sz": 0.001, "lev": 1, "et": "limit", "px": 60000}):
    try:
        SB.cmd_send([bad]); raise AssertionError("policy not enforced for " + bad["id"])
    except SystemExit as e:
        assert "refused by policy" in str(e) and bad["id"] in str(e), e
assert not SB.INBOX.exists() and not SB.STATE.exists()

trades = [
    {"id": "a1", "pf": "arcus", "m": "TSLA-USD", "sd": "long", "sz": 0.5, "lev": 1, "et": "limit", "px": 398, "sl": 393, "tp": 410, "exp": now + 3600},
    {"id": "a2", "pf": "arcus", "m": "NVDA-USD", "act": "tpsl", "sl": 101, "exp": now + 3600},
    {"id": "e1", "pf": "hl", "m": "io:ANTH", "act": "cancel", "oid": 77, "exp": now + 3600},
    {"id": "e2", "pf": "hl", "m": "io:OAI", "sd": "short", "sz": 0.3, "lev": 1, "et": "limit", "px": 900, "sl": 909, "exp": now + 3600},
    {"id": "t1", "pf": "txflow", "m": "BTC-USDC", "sd": "long", "sz": 0.004, "lev": 1, "et": "limit", "px": 60000, "sl": 59400, "exp": now + 3600},
]
sent = SB.cmd_send(trades)
assert [s["group"] for s in sent] == ["arcus", "entropy", "txflow"], sent
j = inbox()
assert [b["title"] for b in j["batches"]] == ["🏹 Arcus", "🤖 Entropy", "🌊 TxFlow (manuel)"], j
p0 = j["batches"][0]["proposals"][0]
assert p0["token"].startswith("v1.") and p0["status"] == "pending" and "LONG TSLA" in p0["line"]
assert "baseline" not in json.dumps(j), "baselines must stay local"

# TSLA limit resting + ANTH order cancelled; NVDA SL still old; OAI not placed; TxFlow nothing yet
state = {"arcus": {"sizes": {"NVDA-USD": -10.0}, "orders": ar0["orders"] + [{"id": "n1", "m": "TSLA-USD", "side": "buy", "px": 398.0, "trig": None, "kind": "LIMIT"}]},
         "hl:io": {"sizes": {"io:ANTH": -1.0}, "orders": []}, "txflow": tx0}
rep = SB.cmd_check(fetch=lambda t: state)
assert {r["group"]: r["done"] for r in rep} == {"arcus": 1, "entropy": 1, "txflow": 0}, rep
st = {p["id"]: p["status"] for b in inbox()["batches"] for p in b["proposals"]}
assert st == {"a1": "done", "a2": "pending", "e1": "done", "e2": "pending", "t1": "pending"}, st

# NVDA SL replaced, OAI resting, TxFlow position opened -> all batches closed
state["arcus"]["orders"] = [{"id": "n2", "m": "NVDA-USD", "side": "buy", "px": 106.0, "trig": 101.0, "kind": "STOP_LOSS"}]
state["hl:io"]["orders"] = [{"id": "88", "m": "io:OAI", "side": "sell", "px": 900.0, "trig": None, "kind": "LIMIT"}]
state["txflow"] = {"sizes": {"BTC-USDC": 0.004}, "orders": []}
rep = SB.cmd_check(fetch=lambda t: state)
assert all(r["closed"] and r["done"] == r["total"] for r in rep), rep
assert all(b["closed"] for b in inbox()["batches"])
assert SB.cmd_check(fetch=lambda t: state) == []

# expiry: an unexecuted, expired trade is shown as expired and closes its batch
SB.STATE.unlink()
SB.cmd_send([{"id": "x1", "pf": "arcus", "m": "NVDA-USD", "act": "tpsl", "sl": 1, "exp": now + 60}])
rep = SB.cmd_check(now=now + 120, fetch=lambda t: state)
b = inbox()["batches"][0]
assert rep[0]["closed"] and rep[0]["done"] == 0 and b["proposals"][0]["status"] == "expired"

# txflow name mapping helpers
assert SB.tx_key("btc") == "BTC-USDC" and SB.venue({"pf": "txflow", "m": "BTC"}) == "txflow"
print(json.dumps({"ok": True}))
