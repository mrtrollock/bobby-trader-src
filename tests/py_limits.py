"""Offline tests for limits.py: week/day boundaries, per-platform rows (auto/manual, halted, not connected), TxFlow usage
from public fills, Variational manual entry, and the balances.py integration (encrypted, caps from `cli.js limits`)."""
import json, os, sys, tempfile
from datetime import datetime, timezone
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
for k in [k for k in os.environ if k.startswith(("QFEX_", "BOBBY_", "ARCUS_", "HL_", "AUTOTRADER_"))]:
    os.environ.pop(k)
import limits as LM  # noqa: E402
import balances as BL  # noqa: E402
import vaultpy  # noqa: E402

U = lambda *a: int(datetime(*a, tzinfo=timezone.utc).timestamp())
NOW = U(2026, 10, 21, 12, 30)  # Wed
assert LM.week_start(NOW) == U(2026, 10, 19) and LM.day_start(NOW) == U(2026, 10, 21)
assert LM.week_start(U(2026, 10, 19)) == U(2026, 10, 19) and LM.week_start(U(2026, 10, 18, 23, 59)) == U(2026, 10, 12)
CAPS = LM.read_caps()  # key-less, defaults
c = CAPS["caps"]
assert (c["arcus"]["weekly"], c["arcus"]["daily"], c["entropy"]["daily"], c["qfex"]["weekly"], c["qfex"]["daily"], c["qfex"]["maxTradeUsd"]) == (50, 20, 20, 30, 12, 3), c
assert c["txflow"]["mode"] == "manual" and c["txflow"]["daily"] is None and c["variational"]["weekly"] == 50
SW = {"enabled": True, "arcus": True, "entropy": False, "qfex": True}
st = {"arcus": {"limits": {"weeklyCap": 50, "weeklyUsed": 12.345, "weeklyRemaining": 37.655, "dailyCap": 20, "dailyUsed": 20, "dailyRemaining": 0, "maxTradeLoss": 0,
                           "halted": {"scope": "daily", "until": U(2026, 10, 22) * 1000, "reason": "daily cap reached"}}},
      "entropy": {"note": "address not set (BOBBY_HL_ADDRESS)"},
      "qfex": {"limits": {"weeklyCap": 30, "weeklyUsed": 4, "weeklyRemaining": 26, "dailyCap": 12, "dailyUsed": 1, "dailyRemaining": 11, "maxTradeLoss": 3, "halted": None}}}
act = {"txflow": {"from": U(2026, 10, 19), "fills": [{"time": U(2026, 10, 20) * 1000, "closedPnl": "-10", "fee": "0.5"}, {"time": U(2026, 10, 21, 9) * 1000, "closedPnl": "-2", "fee": "0.1"},
                                                     {"time": U(2026, 10, 18) * 1000, "closedPnl": "-99", "fee": "0"}], "fundings": [{"time": U(2026, 10, 20) * 1000, "amount": "-0.4"}]}}
d = LM.build(CAPS, st, act, {"variational": {"weekPnl": 7.5}}, NOW, SW)
P = {r["id"]: r for r in d["platforms"]}
assert [r["id"] for r in d["platforms"]] == ["arcus", "entropy", "txflow", "qfex", "variational"]
assert d["weekResets"] == U(2026, 10, 26) and d["dayResets"] == U(2026, 10, 22) and "Monday 00:00 UTC" in d["rules"]
a = P["arcus"]
assert a["status"] == "halted" and a["haltedUntil"] == U(2026, 10, 22) and a["haltScope"] == "daily" and a["weeklyUsed"] == 12.35 and a["dailyPct"] == 1.0 and a["weeklyPct"] == 0.247, a
e = P["entropy"]
assert e["status"] == "not connected" and e["weeklyCap"] == 50 and e["dailyCap"] == 20 and "BOBBY_HL_ADDRESS" in e["note"] and e["weeklyUsed"] is None, e
q = P["qfex"]
assert q["status"] == "ok" and q["dailyCap"] == 12 and q["maxTradeLoss"] == 3 and q["maxTradeRule"].startswith("$3 max") and q["note"] is None, q
t = P["txflow"]
assert t["mode"] == "manual" and t["status"] == "manual" and t["weeklyUsed"] == 13.0 and t["weeklyRemaining"] == 37.0 and t["dailyUsed"] == 2.1 and t["dailyCap"] is None
assert t["dailyRule"] == "not set (manual trading)" and t["weekPnl"] == -13.0
v = P["variational"]
assert v["weeklyUsed"] == 0.0 and v["weekPnl"] == 7.5 and v["dailyUsed"] is None and "manual entry" in v["note"]
# expired halt is ignored; trading switch off is noted; manual over cap; no data
st["arcus"]["limits"]["halted"]["until"] = (NOW - 1) * 1000
d2 = LM.build(CAPS, st, {"txflow": {"from": U(2026, 10, 19), "fills": [{"time": U(2026, 10, 20) * 1000, "closedPnl": "-60", "fee": "0"}]}}, {}, NOW, {"enabled": False})
P2 = {r["id"]: r for r in d2["platforms"]}
assert P2["arcus"]["status"] == "ok" and "not trading" in P2["arcus"]["note"]
assert P2["txflow"]["status"] == "over cap" and P2["txflow"]["weeklyRemaining"] == 0 and P2["txflow"]["weeklyPct"] == 1.0
assert P2["variational"]["weeklyUsed"] is None and "points_manual.json" in P2["variational"]["note"]
# txflow fills that start after Monday cannot measure the week
assert LM.manual_usage("txflow", {"txflow": {"from": U(2026, 10, 20), "fills": []}}, {}, NOW) is None
# balances.py --mock: limits inside the encrypted doc
tmp = Path(tempfile.mkdtemp())
(tmp / "m.json").write_text(json.dumps({"arcus": {"equity": 300, "limits": st["arcus"]["limits"]}, "qfex": {"equity": 100, "deposit": 100, "limits": st["qfex"]["limits"]},
                                        "txflow": {"equity": 400, "activity": act["txflow"]}, "switches": SW}))
os.environ["BOBBY_VIEW_PASSPHRASE"] = "test-pass-limits"
assert BL.main(["--mock", str(tmp / "m.json"), "--ledger", str(tmp / "l.json"), "--starts", str(tmp / "s.json"), "--out", str(tmp / "b.enc.json"),
                "--alerts", str(tmp / "none"), "--now", str(NOW)]) == 0
raw = (tmp / "b.enc.json").read_text()
assert "weeklyCap" not in raw and "ct" in json.loads(raw)
doc = vaultpy.read_sealed(tmp / "b.enc.json")
L = {r["id"]: r for r in doc["limits"]["platforms"]}
assert L["arcus"]["status"] == "ok" and L["qfex"]["dailyCap"] == 12 and L["txflow"]["weeklyUsed"] == 13.0 and L["entropy"]["status"] == "not connected"
print(json.dumps({"ok": True}))
