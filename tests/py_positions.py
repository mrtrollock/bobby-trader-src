"""Offline tests: flows.py (all-time deposits), positions.py (attribution, Bobby status), balances.arcus_reading + deposit re-base."""
import json, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import flows as FL, positions as POS, balances as BL

SUB, MAIN, OTHER = "0xsub", "0xmain", "0xother"
# --- Hyperliquid subaccount's own view
ups = [{"delta": {"type": "subAccountTransfer", "usdc": "300", "user": MAIN, "destination": SUB}},
       {"delta": {"type": "subAccountTransfer", "usdc": "264.11", "user": SUB, "destination": MAIN}},
       {"delta": {"type": "send", "user": SUB, "destination": SUB, "sourceDex": "spot", "destinationDex": "", "token": "USDC", "usdcValue": "300"}},
       {"delta": {"type": "send", "user": MAIN, "destination": SUB, "token": "USDC", "usdcValue": "300.19"}},
       {"delta": {"type": "send", "user": MAIN, "destination": SUB, "token": "HYPE", "usdcValue": "50"}},
       {"delta": {"type": "accountClassTransfer", "usdc": "10", "toPerp": True}}]
t = FL.hl_totals(ups, SUB)
assert (t["deposits"], t["withdrawals"], t["net"], t["skippedNonStable"]) == (600.19, 264.11, 336.08, 1), t
# --- TxFlow: deposits, incoming send, vault deposit counts as money out, failed ignored
rows = [{"delta": {"type": "deposit", "amount": "106", "status": "Completed"}}, {"delta": {"type": "deposit", "amount": "9", "status": "Failed"}},
        {"delta": {"type": "tokenSend", "user": OTHER, "destination": MAIN, "usdcValue": "2"}},
        {"delta": {"type": "vaultEvent", "user": MAIN, "isDeposit": True, "amount": "20"}},
        {"delta": {"type": "withdraw", "amount": "10", "fee": "1"}}]
t = FL.txflow_totals(rows, MAIN)
assert (t["deposits"], t["withdrawals"], t["net"], t["vaultNet"]) == (108, 31, 77, 20), t
# --- cards + totals; unknowns stay None with a reason
doc = FL.build({"arcus": {"equity": 242.81, "deposit": 395.59}, "entropy": {"equity": 300.19, "allTime": FL.hl_totals(ups, SUB)},
                "txflow": {"equity": 100}, "qfex": {"equity": 98, "deposit": 100}}, {})
r = {x["id"]: x for x in doc["rows"]}
assert r["arcus"]["pnl"] == -152.78 and r["arcus"]["deposits"] is None and "net only" in r["arcus"]["note"]
assert r["entropy"]["pnl"] == round(300.19 - 336.08, 2)
assert r["txflow"]["net"] is None and r["txflow"]["pnl"] is None and r["txflow"]["reason"]
assert "CSV" in r["variational"]["reason"] and "API key" in r["extended"]["reason"]
assert doc["total"]["platforms"] == ["arcus", "entropy", "qfex"] and doc["total"]["deposits"] is None
assert doc["total"]["pnl"] == round(-152.78 + (300.19 - 336.08) - 2, 2), doc["total"]
# --- Arcus: netDeposits are deposits, not PnL; an old start without a deposit is re-based once
a = BL.arcus_reading({"equity": "242.813518983", "netDeposits": "395.5908"})
assert a["deposit"] == 395.5908 and a["allTimePnl"] == -152.78
ledger = {"start": {"arcus": {"t": 1, "equity": 123.12}}, "snapshots": []}
out = BL.update(ledger, {"arcus": a}, {}, 100)
row = next(x for x in out["platforms"] if x["id"] == "arcus")
assert row["pnl"] == 0 and row["allTimePnl"] == -152.78 and ledger["start"]["arcus"]["deposit"] == 395.5908, row
out = BL.update(ledger, {"arcus": {**a, "equity": 342.81, "deposit": 495.5908}}, {}, 200)  # +$100 deposit later: still 0 PnL
assert next(x for x in out["platforms"] if x["id"] == "arcus")["pnl"] == 0
# --- positions: attribution from autotrader state + status
st = {"platforms": {"qfex": {"positions": [{"market": "SILVER-USD", "side": "long", "size": 2, "entry": 58, "mark": 57.9, "upnl": -0.1, "sl": [57.7], "tp": [58.2]},
                                           {"market": "GOLD-USD", "side": "short", "size": 1, "entry": 1, "mark": 1, "upnl": 0, "sl": [], "tp": []}],
                                "openOrders": [{"id": "x", "market": "SILVER-USD", "kind": "SL", "trig": 57.7}, {"id": "secret-id", "market": "SILVER-USD", "kind": "LIMIT", "px": 58.07, "side": "SELL", "reduceOnly": True}]},
                    "entropy": {"positions": [{"market": "io:XIAOMI", "side": "short", "size": 99, "sl": [3.4], "tp": [3.3]}], "openOrders": []},
                    "arcus": {"positions": [{"market": "ETH-USD", "side": "long", "size": 1}], "openOrders": [], "bobbyMarkets": []}}}
state = {"volume": {"markets": {"SILVER-USD": {"phase": "pos"}, "GOLD-USD": {"phase": "idle"}}}, "hlVolume": {"markets": {}}, "guard": {"__arcusOwn": {}}}
pos, orders, meta = POS.from_status(st, state)
by = {(p["pf"], p["market"]): p["by"] for p in pos}
assert by[("qfex", "SILVER-USD")] == "Bobby" and by[("qfex", "GOLD-USD")] != "Bobby" and by[("entropy", "io:XIAOMI")] == "Bobby" and by[("arcus", "ETH-USD")] == "your tools"
assert len(orders) == 1 and "id" not in orders[0] and "secret-id" not in json.dumps(orders) and meta["qfex"]["count"] == 2
assert next(p for p in pos if p["market"] == "SILVER-USD")["protected"] and not next(p for p in pos if p["market"] == "GOLD-USD")["protected"]
# --- Bobby status (top bar)
env = {"AUTOTRADER_ENABLED": "1", "AUTOTRADER_LIVE": "1", "AUTOTRADER_ARCUS": "0", "QFEX_VOLUME_MODE": "1", "QFEX_API_PUBLIC_KEY": "1", "HL_AGENT_PRIVATE_KEY_SET": "1", "AUTOTRADER_ENTROPY_VOLUME": "1"}
b = POS.bobby_status(env, {}, {"state": "active"}, None, True, {}, 0)
assert b["summary"] == "QFEX live · Entropy live · Arcus paused · TxFlow manual · Variational manual", b["summary"]
b = POS.bobby_status(env, {}, {"state": "waiting"}, {"down": True, "downMin": 12}, True, {}, 0)
assert b["platforms"][0]["state"] == "paused" and b["platforms"][1]["state"] == "waiting"
b = POS.bobby_status(env, {}, {"state": "active"}, None, False, {}, 0)
assert b["platforms"][0]["state"] == "stopped" and not b["live"]
b = POS.bobby_status({**env, "AUTOTRADER_LIVE": "0"}, {}, {"state": "active"}, None, True, {}, 0)
assert "dry run" in b["platforms"][0]["detail"]
fin = POS.finish(pos, orders, meta, b, 5, {"variational": {"positions": [{"market": "BTC", "side": "long", "size": 0.1}]}})
assert fin["platforms"]["variational"]["count"] == 1 and fin["platforms"]["extended"]["status"] == "manual"
print(json.dumps({"ok": True}))
