"""Offline tests for points.py: schedules (Berlin/UTC/ET incl. DST), aggregation, ledger, manual entries, TxFlow
positions/flows, and the balances.py integration (encrypted, no address in the output)."""
import json, os, sys, tempfile
from datetime import datetime, timezone
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
for k in [k for k in os.environ if k.startswith(("QFEX_", "BOBBY_"))]:
    os.environ.pop(k)
import points as PT  # noqa: E402
import balances as BL  # noqa: E402
import vaultpy  # noqa: E402

U = lambda *a: int(datetime(*a, tzinfo=timezone.utc).timestamp())
NOW = U(2026, 10, 21, 12, 30)  # Wed 14:30 Berlin
# Arcus: Wednesday 19:00 UTC per the Arcus Points page
w = PT.window("arcus", PT.window_index("arcus", NOW))
assert (w["n"], w["start"], w["end"], w["drop"]) == (3, U(2026, 10, 14, 19), U(2026, 10, 21, 19), U(2026, 10, 21, 19)), w
assert PT.window("arcus", PT.window_index("arcus", U(2026, 11, 2)))["drop"] == U(2026, 11, 4, 19)  # Points page: 19:00 UTC all year (blog: 3 PM ET)
assert PT.window("arcus", PT.window_index("arcus", U(2026, 10, 7, 18, 59)))["n"] == 1  # Week 1 dropped Oct 7
# TxFlow: Epoch 2 = Mon 19 Oct -> Mon 26 Oct 00:00 UTC, no exact drop time
w = PT.window("txflow", PT.window_index("txflow", NOW))
assert (w["n"], w["start"], w["end"], w["drop"]) == (2, U(2026, 10, 19), U(2026, 10, 26), None), w
assert PT.window("txflow", PT.window_index("txflow", U(2026, 10, 12)))["n"] == 1
# Variational: Week 45 = Thu 15 Oct -> Thu 22 Oct 00:00 UTC, drop Fri 23 Oct 00:00 UTC (= API next_drop_ts on 2026-10-21)
w = PT.window("variational", PT.window_index("variational", NOW))
assert (w["n"], w["start"], w["end"], w["drop"]) == (45, U(2026, 10, 15), U(2026, 10, 22), U(2026, 10, 23)), w
assert PT.window("variational", PT.window_index("variational", U(2026, 10, 15, 0, 0, 1) - 2))["n"] == 44
# QFEX / Entropy: tracking week Monday 00:00 UTC, no drop
for pf in ("qfex", "entropy"):
    w = PT.window(pf, PT.window_index(pf, NOW))
    assert (w["n"], w["start"], w["drop"]) == (None, U(2026, 10, 19), None) and w["label"] == "Week of 19 Oct"
# aggregate: volume, fees, realized pnl - fees + funding, maker share only when known
F = [{"time": U(2026, 10, 19, 1) * 1000, "px": "100", "sz": "2", "fee": "0.04", "closedPnl": "0", "tradeSide": "Maker"},
     {"time": U(2026, 10, 20, 1) * 1000, "px": "110", "sz": "-2", "fee": "0.1", "closedPnl": "20", "tradeSide": "Taker"},
     {"time": U(2026, 10, 13, 1) * 1000, "px": "50", "sz": "1", "fee": "0.5", "closedPnl": "-3", "tradeSide": "Taker"}]
FU = [{"time": U(2026, 10, 19, 8) * 1000, "amount": "-0.06"}]
a = PT.aggregate(F, FU, U(2026, 10, 19) * 1000, U(2026, 10, 26) * 1000)
assert a == {"volume": 420.0, "fees": 0.14, "funding": -0.06, "pnl": 19.8, "trades": 2, "makerShare": round(200 / 420, 4)}, a
assert PT.aggregate([{"time": 1, "px": 1, "sz": 1, "fee": 0}], [], 0, 10)["makerShare"] is None
# update: fills cover from Oct 12 -> epoch 1 + 2 computed; manual points merged by epoch number; qfex week fallback
led = {}
act = {"txflow": {"fills": F, "fundings": FU, "from": U(2026, 10, 12)}, "qfex": {"week": {"volume": 70000, "fees": 1.5, "pnl": -2.25, "trades": 300}}}
man = {"txflow": {"weeks": {"1": {"points": 210.4}}}, "variational": {"equity": 250, "weeks": {"45": {"volume": 12000, "pnl": -3.2, "points": 12.5}, "44": {"points": 9}}}}
d = PT.update(led, act, man, NOW)
P = {p["id"]: p for p in d["platforms"]}
tx = P["txflow"]
assert tx["status"] == "ok" and tx["connected"] and tx["window"]["label"] == "Epoch 2" and tx["current"]["volume"] == 420.0 and tx["current"]["pnl"] == 19.8
assert [h["label"] for h in tx["history"]] == ["Epoch 2", "Epoch 1"] and tx["history"][1]["points"] == 210.4 and tx["history"][1]["pnl"] == -3.5
assert P["qfex"]["current"]["volume"] == 70000 and P["qfex"]["current"]["pnl"] == -2.25 and P["qfex"]["kind"] == "not announced"
v = P["variational"]
assert v["status"] == "manual" and v["connected"] and v["current"]["volume"] == 12000 and v["current"]["points"] == 12.5 and v["history"][1]["label"] == "Week 44"
assert P["arcus"]["connected"] is False and P["arcus"]["status"] == "not connected" and P["arcus"]["window"]["drop"] == U(2026, 10, 21, 19)
assert P["entropy"]["kind"] == "rebates" and P["entropy"]["current"] is None and len(P["arcus"]["upcoming"]) == 6
assert d["total"] == {"volume": round(420 + 70000 + 12000, 4), "fees": round(0.14 + 1.5, 4), "pnl": round(19.8 - 2.25 - 3.2, 4)}, d["total"]
assert all(s["url"].startswith("https://") for p in d["platforms"] for s in p["sources"])
# a later run that only covers the previous window keeps epoch 1 (+ its manual points) untouched
d2 = PT.update(led, {"txflow": {"fills": F[:2], "fundings": [], "from": U(2026, 10, 19)}}, man, NOW + 3600)
tx2 = {p["id"]: p for p in d2["platforms"]}["txflow"]
assert tx2["history"][1]["pnl"] == -3.5 and tx2["history"][1]["points"] == 210.4 and tx2["current"]["funding"] == 0
assert PT.since_for("txflow", led, NOW, U(2026, 10, 12)) == U(2026, 10, 12)  # cov = Oct 12 <= previous window start
assert PT.since_for("txflow", {}, NOW, U(2026, 10, 12)) == U(2026, 10, 12) and PT.since_for("txflow", {"cov": {"txflow": U(2026, 10, 19)}}, NOW, U(2026, 10, 12)) == U(2026, 10, 12)
assert PT.qfex_since(NOW) == U(2026, 10, 12)
# TxFlow positions (SL/TP from position tpsl) and flows
st = {"assetPositions": [{"position": {"coin": "HYPE-USDC", "asset": "44", "szi": "10.0", "entryPx": "77.8", "markPx": "81.1", "unrealizedPnl": "33", "leverage": {"value": 10}},
                          "tpsl": [{"slTriggerPrice": "75.95", "tpTriggerPrice": "90.000"}]},
                         {"position": {"coin": "BTC-USDC", "asset": "1", "szi": "-0.02", "entryPx": "83060", "markPx": "83000", "unrealizedPnl": "1.2", "leverage": {"value": 60}}}]}
pos = PT.txflow_positions(st, [{"coin": "BTC-USDC", "isTrigger": True, "orderType": "Stop Market", "triggerPx": "85000"}])
assert pos[0] == {"market": "HYPE", "side": "long", "size": 10.0, "entry": 77.8, "mark": 81.1, "upnl": 33.0, "sl": [75.95], "tp": [90.0], "protected": True, "leverage": 10}, pos[0]
assert pos[1]["side"] == "short" and pos[1]["sl"] == [85000.0] and pos[1]["protected"] is False
A = "0x" + "cd" * 20
rows = [{"delta": {"type": "deposit", "amount": "100", "status": "completed"}}, {"delta": {"type": "withdraw", "amount": "10", "fee": "1"}},
        {"delta": {"type": "tokenSend", "user": "0x" + "11" * 20, "destination": A, "usdcValue": "5"}}, {"delta": {"type": "deposit", "amount": "7", "status": "failed"}}]
assert PT.txflow_flows(rows, A) == 94
assert PT.manual_balance({}, "variational")["status"].startswith("not connected") and PT.manual_balance(man, "variational") == {"equity": 250.0, "manual": True}
# balances.py integration: points + Variational row inside the encrypted doc; points ledger next to --ledger (chmod 600)
tmp = Path(tempfile.mkdtemp())
(tmp / "points_manual.json").write_text(json.dumps(man))
(tmp / "m.json").write_text(json.dumps({"qfex": {"equity": 100, "deposit": 100, "volume": {"day": {}, "week": {"volume": 70000, "fees": 1.5, "pnl": -2.25, "trades": 300}, "month": {"volume": 70000}, "goal": 300000}},
                                        "txflow": {"equity": 518.7, "activity": {"fills": F, "fundings": FU, "from": U(2026, 10, 12)}}}))
os.environ["BOBBY_VIEW_PASSPHRASE"] = "test-pass-points"
assert BL.main(["--mock", str(tmp / "m.json"), "--ledger", str(tmp / "l.json"), "--starts", str(tmp / "s.json"), "--out", str(tmp / "b.enc.json"),
                "--alerts", str(tmp / "ALERT"), "--now", str(NOW)]) == 0
raw = (tmp / "b.enc.json").read_text()
assert "Variational" not in raw and "Epoch" not in raw and json.loads(raw)["alg"] == "AES-256-GCM"
doc = vaultpy.read_sealed(tmp / "b.enc.json")
B = {r["id"]: r for r in doc["platforms"]}
assert B["variational"]["status"] == "ok" and B["variational"]["current"] == 250 and "manual" in B["variational"]["ndSource"]
pp = {p["id"]: p for p in doc["points"]["platforms"]}
assert pp["txflow"]["current"]["volume"] == 420.0 and pp["qfex"]["current"]["volume"] == 70000 and pp["variational"]["current"]["points"] == 12.5
assert oct(os.stat(tmp / "points_ledger.json").st_mode)[-3:] == "600" and json.loads((tmp / "points_ledger.json").read_text())["weeks"]["txflow"]
# Arcus /v1/fills reader (from/to/createdAt in MICROseconds, newest first, paged backwards with `to`) and Hyperliquid io-dex filter, with a fake HTTP layer
class FakeB:
    def __init__(self): self.calls = []
    def _get(self, url, q):
        self.calls.append((url, dict(q)))
        assert q["from"] == U(2026, 10, 14, 19) * 1_000_000
        if "to" not in q:
            return {"fills": [{"id": i, "createdAt": U(2026, 10, 16) * 1_000_000 - i, "price": "10", "size": "1", "fee": "0.01", "closedPnl": "0.5", "liquidity": "maker"} for i in range(1000)]}
        assert q["to"] == U(2026, 10, 16) * 1_000_000 - 999 - 1
        return {"fills": [{"id": 999, "createdAt": U(2026, 10, 16) * 1_000_000 - 999, "price": "10", "size": "1", "fee": "0.01", "closedPnl": "0.5"},
                          {"id": 1000, "createdAt": U(2026, 10, 15) * 1_000_000, "price": "20", "size": "-1", "fee": "0.02", "closedPnl": "-1"}]}
    def _post(self, url, body):
        return [{"coin": "io:NVDA", "time": U(2026, 10, 20) * 1000, "px": "180", "sz": "1", "fee": "0.05", "closedPnl": "2", "crossed": False},
                {"coin": "BTC", "time": U(2026, 10, 20) * 1000, "px": "80000", "sz": "1", "fee": "9", "closedPnl": "0", "crossed": True}]
fb = FakeB()
aa = PT.arcus_activity(fb, "https://api.arcus.xyz", "0xabc", 0, U(2026, 10, 14, 19), NOW)
assert len(aa["fills"]) == 1001 and aa["fills"][-1]["time"] == U(2026, 10, 15) * 1000 and fb.calls[0][1]["accountIndex"] == 0 and len(fb.calls) == 2
ag = PT.aggregate(aa["fills"], [], U(2026, 10, 14, 19) * 1000, U(2026, 10, 21, 19) * 1000)
assert ag["volume"] == 10020.0 and ag["trades"] == 1001 and ag["pnl"] == round(1000 * 0.5 - 1 - 10 - 0.02, 4) and ag["makerShare"] == round(10000 / 10020, 4), ag
ha = PT.hl_activity(fb, "https://api.hyperliquid.xyz/info", "0xabc", ["io"], U(2026, 10, 19), NOW)
assert len(ha["fills"]) == 1 and ha["fills"][0]["maker"] is True
d3 = PT.update({}, {"arcus": aa, "entropy": ha}, {}, NOW)
P3 = {p["id"]: p for p in d3["platforms"]}
assert P3["arcus"]["status"] == "ok" and P3["arcus"]["window"]["label"] == "Week 3" and P3["arcus"]["current"]["volume"] == 10020.0
assert P3["entropy"]["current"]["volume"] == 180.0 and P3["entropy"]["current"]["pnl"] == 1.95
# not connected (address not configured yet): countdown data still published, with a configuration hint
d4 = PT.update({}, {"arcus": {"connected": False, "note": "not connected: set BOBBY_ACCOUNT_ADDRESS"}}, {}, NOW)
a4 = d4["platforms"][0]
assert a4["id"] == "arcus" and a4["connected"] is False and a4["window"]["drop"] and "BOBBY_ACCOUNT_ADDRESS" in a4["dataNote"]
# points earned: manual points persist in the ledger after the manual entry is removed and survive a recompute from fills;
# states (entered / pending / missing / rebates), pts per $1K, season totals, date keys, auto hook never overrides manual
L5 = {}
FX = [{"time": U(2026, 10, 13, 1) * 1000, "px": "100", "sz": "20", "fee": "0.1", "closedPnl": "1"}, {"time": U(2026, 10, 20, 1) * 1000, "px": "100", "sz": "5", "fee": "0", "closedPnl": "0"}]
ACT5 = {"txflow": {"fills": FX, "fundings": [], "from": U(2026, 10, 12)}, "qfex": {"week": {"volume": 5000, "fees": 1, "pnl": 2, "trades": 10}}}
M5 = {"txflow": {"weeks": {"1": {"points": 300}}}, "entropy": {"weeks": {"2026-10-12": {"rebates": 1.25}}}, "qfex": {"weeks": {"2026-10-19": {"points": 40}}}}
d5 = PT.update(L5, ACT5, M5, NOW)
P5 = {p["id"]: p for p in d5["platforms"]}
t5 = P5["txflow"]
assert [(x["label"], x["points"], x["pointsSrc"], x["pointsState"], x["ptsPer1k"]) for x in t5["history"]] == [("Epoch 2", None, None, "pending", None), ("Epoch 1", 300.0, "manual", "entered", 150.0)], t5["history"]
assert {k: t5["earned"][k] for k in ("points", "weeks", "volume", "ptsPer1k", "src", "rebates", "totalSrc")} == {"points": 300.0, "weeks": 1, "volume": 2000.0, "ptsPer1k": 150.0, "src": ["manual"], "rebates": None, "totalSrc": "sum"} and t5["pointsSource"].startswith("manual")
assert P5["qfex"]["current"]["points"] == 40.0 and P5["qfex"]["current"]["ptsPer1k"] == 8.0
assert P5["entropy"]["history"][0]["rebates"] == 1.25 and P5["entropy"]["history"][0]["pointsState"] == "rebates" and P5["entropy"]["earned"]["rebates"] == 1.25
assert P5["arcus"]["earned"]["points"] is None and "no points or rewards endpoint" in P5["arcus"]["pointsSource"]
# next day: manual file emptied, fills recomputed, an "auto" source must not override the manual number
d6 = PT.update(L5, {**ACT5, "txflow": {**ACT5["txflow"], "points": {str(U(2026, 10, 12)): 999, str(U(2026, 10, 19)): 55}}}, {}, NOW + 86400)
t6 = {p["id"]: p for p in d6["platforms"]}["txflow"]
assert [(x["points"], x["pointsSrc"]) for x in t6["history"]] == [(55.0, "auto"), (300.0, "manual")], t6["history"]
assert {p["id"]: p for p in d6["platforms"]}["qfex"]["current"]["points"] == 40.0  # QFEX week totals path keeps points too
# Epoch 1 without points after its credit day -> missing ("not entered yet"), never 0
d7 = PT.update({}, {"txflow": ACT5["txflow"]}, {}, NOW)
assert {p["id"]: p for p in d7["platforms"]}["txflow"]["history"][1]["pointsState"] == "missing"
assert PT.update({}, {}, {"arcus": {"pointsTotal": 1234}}, NOW)["platforms"][0]["earned"]["points"] == 1234.0
# bonus / retro / profile (persist in the ledger); Extended: tracking only, weekly distributions ended, Tue-Mon epochs
L8 = {}
M8 = {"variational": {"weeks": {"2026-10-08": {"points": 2.907816}}, "bonus": [{"label": "Swap Market Competition", "points": 0.358827, "date": "2026-09-24"}, {"label": "Retro", "points": 497.4, "date": "2025-01-29"}],
                      "profile": {"rank": "3014", "total": 538.77}},
      "txflow": {"retro": {"label": "Retroactive (pre-Season 1)", "points": None}},
      "extended": {"weeks": {"75": {"points": 0}, "66": {"points": 6.3}}, "pointsTotal": 4064.9}}
P8 = {p["id"]: p for p in PT.update(L8, {}, M8, NOW)["platforms"]}
v8 = P8["variational"]
assert v8["history"][0]["label"] == "Week 44" and v8["history"][0]["points"] == 2.907816 and [b["label"] for b in v8["bonus"]] == ["Swap Market Competition", "Retro"]
assert v8["earned"]["points"] == round(2.907816 + 0.358827 + 497.4, 6) and v8["earned"]["weeklyPoints"] == 2.907816 and v8["earned"]["bonusPoints"] == 497.758827 and v8["profile"]["rank"] == "3014"
assert P8["txflow"]["retro"] == {"label": "Retroactive (pre-Season 1)", "points": None, "note": None}
x8 = P8["extended"]
assert x8["tracking"] and x8["kind"] == "ended" and [(h["label"], h["points"]) for h in x8["history"]] == [("Epoch 75", 0.0), ("Epoch 66", 6.3)]
assert x8["history"][0]["start"] == U(2026, 9, 29) and x8["earned"]["points"] == 4064.9 and x8["earned"]["totalSrc"] == "dashboard" and x8["earned"]["sum"] == 6.3
# removed from the manual file -> still in the ledger
P9 = {p["id"]: p for p in PT.update(L8, {}, {}, NOW + 86400)["platforms"]}
assert len(P9["variational"]["bonus"]) == 2 and P9["variational"]["history"][0]["points"] == 2.907816 and P9["txflow"]["retro"]["label"].startswith("Retro") and P9["variational"]["profile"]["rank"] == "3014"
# valuation inputs: research fields only (no user points / precomputed scenarios), unknown platforms dropped; encrypted in balances
VI = {"generatedAt": "2026-10-21", "disclaimer": "d", "platforms": [{"id": "extended", "airdropPct": 0.3, "totalPoints": 70000000, "userPoints": 4064.9, "scenarios": {"1B": 1}, "valuable": True},
      {"id": "nope", "airdropPct": 1}, {"id": "qfex", "valuable": False, "cannotValue": "x"}]}
vi = PT.valuation_inputs(VI)
assert [p["id"] for p in vi["platforms"]] == ["extended", "qfex"] and "userPoints" not in vi["platforms"][0] and "scenarios" not in vi["platforms"][0] and vi["fdvs"] == [250e6, 500e6, 1e9, 2e9, 3e9]
assert PT.valuation_inputs({}) is None and PT.valuation_inputs([]) is None
tmpv = Path(tempfile.mkdtemp()); (tmpv / "valuation_inputs.json").write_text(json.dumps(VI)); (tmpv / "m.json").write_text(json.dumps({"txflow": {"equity": 1}}))
assert BL.main(["--mock", str(tmpv / "m.json"), "--ledger", str(tmpv / "l.json"), "--starts", str(tmpv / "s.json"), "--out", str(tmpv / "b.enc.json"), "--alerts", str(tmpv / "none"), "--now", str(NOW)]) == 0
assert "airdropPct" not in (tmpv / "b.enc.json").read_text() and vaultpy.read_sealed(tmpv / "b.enc.json")["valuation"]["platforms"][0]["totalPoints"] == 70000000
print(json.dumps({"ok": True}))
