# Offline checks for send_batch.py: grouping, rendering, execution detection, ✅ edit. No network, no Telegram.
import json, sys, tempfile, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import send_batch as SB

SB.STATE = Path(tempfile.mkdtemp()) / "batches.json"
SB.chat_id = lambda: "42"
calls = []
def fake_tg(method, payload):
    calls.append((method, payload)); return {"message_id": 100 + len(calls)}
SB.tg = fake_tg

now = time.time()
ar0 = {"sizes": {"NVDA-USD": -10.0}, "orders": [{"id": "old1", "m": "NVDA-USD", "side": "buy", "px": 107.1, "trig": 102.0, "kind": "STOP_LOSS"}]}
io0 = {"sizes": {"io:ANTH": -1.0}, "orders": [{"id": "77", "m": "io:ANTH", "side": "buy", "px": 1100, "trig": None, "kind": "LIMIT"}]}
state = {"arcus": ar0, "hl:io": io0}
SB.state_for = lambda trades: state
trades = [
    {"id": "a1", "pf": "arcus", "m": "TSLA-USD", "sd": "long", "sz": 5, "lev": 10, "et": "market", "ref": 400, "sl": 390, "tp": 430, "exp": now + 3600},
    {"id": "a2", "pf": "arcus", "m": "NVDA-USD", "act": "tpsl", "sl": 101, "exp": now + 3600},
    {"id": "e1", "pf": "hl", "m": "io:ANTH", "act": "cancel", "oid": 77, "exp": now + 3600},
    {"id": "e2", "pf": "hl", "m": "io:OAI", "sd": "short", "sz": 1.2, "lev": 7, "et": "limit", "px": 900, "sl": 950, "exp": now + 3600},
]
sent = SB.cmd_send(trades)
assert [s["group"] for s in sent] == ["arcus", "entropy"], sent
assert len(calls) == 2 and all(c[0] == "sendMessage" for c in calls)
kb = calls[0][1]["reply_markup"]["inline_keyboard"]
assert [b["text"] for r in kb for b in r] == ["1️⃣ LONG TSLA", "2️⃣ TP/SL NVDA"], kb
assert kb[0][0]["web_app"]["url"].startswith(SB.BASE_URL + "#p=v1.")
assert "🏹 ARCUS" in calls[0][1]["text"] and "🤖 ENTROPY" in calls[1][1]["text"]

# nothing happened yet -> no edits
calls.clear(); rep = SB.cmd_check(fetch=lambda t: state)
assert calls == [] and all(r["done"] == 0 for r in rep), rep

# TSLA filled + ANTH order cancelled; NVDA SL still old; OAI limit not placed
state = {"arcus": {"sizes": {"NVDA-USD": -10.0, "TSLA-USD": 5.0}, "orders": ar0["orders"]},
         "hl:io": {"sizes": {"io:ANTH": -1.0}, "orders": []}}
rep = SB.cmd_check(fetch=lambda t: state)
assert [c[0] for c in calls] == ["editMessageText", "editMessageText"]
assert {r["group"]: r["done"] for r in rep} == {"arcus": 1, "entropy": 1}, rep
assert not calls[0][1]["text"].startswith("✅")

# NVDA SL replaced at 101 and OAI limit resting -> both messages fully ✅, buttons removed
calls.clear()
state["arcus"]["orders"] = [{"id": "n2", "m": "NVDA-USD", "side": "buy", "px": 106.0, "trig": 101.0, "kind": "STOP_LOSS"}]
state["hl:io"]["orders"] = [{"id": "88", "m": "io:OAI", "side": "sell", "px": 900.0, "trig": None, "kind": "LIMIT"}]
rep = SB.cmd_check(fetch=lambda t: state)
assert all(r["closed"] and r["done"] == r["total"] for r in rep), rep
for _, p in calls:
    assert p["text"].startswith("✅ <b>"), p["text"]
    assert p["reply_markup"]["inline_keyboard"] == []
    assert p["message_id"] in (101, 102)

# closed batches are not checked again
calls.clear(); assert SB.cmd_check(fetch=lambda t: state) == [] and calls == []

# expiry: an unexecuted, expired trade gets ⌛ and closes the batch without ✅ header
SB.STATE.unlink(); calls.clear()
SB.cmd_send([{"id": "x1", "pf": "arcus", "m": "NVDA-USD", "act": "tpsl", "sl": 1, "exp": now + 60}])
calls.clear(); rep = SB.cmd_check(now=now + 120, fetch=lambda t: state)
assert rep[0]["closed"] and "⌛" in calls[0][1]["text"] and not calls[0][1]["text"].startswith("✅")
print(json.dumps({"ok": True}))
