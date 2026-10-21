"""Offline tests: risex.py (tracking only): reading (equity, flows, all-time PnL), positions + TP/SL, fills, points schedule, wiring."""
import json, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import risex as RX, flows as FL, positions as POS, points as PT, balances as BL
from datetime import datetime, timezone

ADDR = "0xabcdefabcdefabcdefabcdefabcdefabcdef0001"
det = {"account": ADDR, "summary": {"total_account_value": "36.842200083872206016", "cross_margin_balance": "36.84", "realized_pnl": "-76.942139916127793915"},
       "positions": [{"size": "0", "market_id": "18", "market_name": "XAG/USDC"},
                     {"size": "-0.5", "market_id": "2", "market_name": "ETH/USDC", "avg_entry_price": "4100", "mark_price": "4000", "unrealized_pnl": "50", "leverage": "10"},
                     {"size": "2", "market_id": "5", "market_name": "SOL/USDC", "avg_entry_price": "180", "mark_price": "181", "unrealized_pnl": "2", "leverage": "5"}]}
tr = [{"address": ADDR, "type": "DEPOSIT", "amount": "56"}, {"address": ADDR, "type": "WITHDRAW", "amount": "42.23"}, {"address": ADDR, "type": "DEPOSIT", "amount": "100.01434"}]
tp = [{"market_id": "2", "stop_type": "STOP_LOSS", "stop_price": "4200", "status": "TPSL_ORDER_STATUS_ACCEPTED"},
      {"market_id": "2", "stop_type": "TAKE_PROFIT", "stop_price": "3900", "status": "TPSL_ORDER_STATUS_ACCEPTED"},
      {"market_id": "5", "stop_type": "STOP_LOSS", "stop_price": "170", "status": "TPSL_ORDER_STATUS_CANCELLED"}]
r = RX.reading(det, tr, tp)
assert r["equity"] == 36.842200083872206 and r["deposit"] == 113.78 and r["allTime"]["deposits"] == 156.01 and r["allTime"]["withdrawals"] == 42.23
assert r["allTimePnl"] == round(36.8422 - 113.78, 2) == -76.94 and r["realizedPnl"] == -76.94 and "tracking only" in r["note"]
ps = {p["market"]: p for p in r["positions"]}
assert set(ps) == {"ETH", "SOL"} and ps["ETH"]["side"] == "short" and ps["ETH"]["size"] == 0.5 and ps["ETH"]["sl"] == [4200] and ps["ETH"]["tp"] == [3900] and ps["ETH"]["protected"]
assert ps["SOL"]["side"] == "long" and ps["SOL"]["sl"] == [] and not ps["SOL"]["protected"]  # cancelled trigger ignored
assert ADDR not in json.dumps({k: v for k, v in r.items()}).lower()  # no address in the reading
# fills: ns -> ms; realized_pnl is net of fees, aggregate() must give realized back as PnL
f = RX.fills([{"time": "1792505325000000000", "price": "4000", "size": "0.01", "fee": "0.04", "realized_pnl": "-0.16", "liquidity_indicator": "TAKER"},
              {"time": "1792505326000000000", "price": "4000", "size": "0.01", "fee": "0.01", "realized_pnl": "0.20", "liquidity_indicator": "MAKER"}])
assert f[0]["time"] == 1792505325000 and f[1]["maker"] is True and f[0]["maker"] is False
ag = PT.aggregate(f, [], 0, 2**62)
assert ag["volume"] == 80 and ag["fees"] == 0.05 and ag["pnl"] == 0.04 and ag["makerShare"] == 0.5, ag
# flows card: deposits / withdrawals / net / all-time PnL
doc = FL.build({"risex": r}, {})
x = {y["id"]: y for y in doc["rows"]}["risex"]
assert (x["deposits"], x["withdrawals"], x["net"], x["current"], x["pnl"]) == (156.01, 42.23, 113.78, 36.84, -76.94) and x["reason"] is None
assert {y["id"]: y for y in FL.build({"risex": {"status": "error"}}, {})["rows"]}["risex"]["reason"].startswith("not read")
# balances ledger: deposits are not PnL; the row is in the table, tracking note kept
led = {}
d1 = BL.update(led, {"risex": r}, {}, 1792600000)
row = {y["id"]: y for y in d1["platforms"]}["risex"]
assert row["status"] == "ok" and row["pnl"] == 0 and row["allTimePnl"] == -76.94 and "tracking only" in row["note"]
r2 = dict(r, equity=r["equity"] + 50, deposit=r["deposit"] + 50)  # a new $50 deposit
row2 = {y["id"]: y for y in BL.update(led, {"risex": r2}, {}, 1792600600)["platforms"]}["risex"]
assert row2["pnl"] == 0 and row2["netDeposits"] == 50, row2
# points schedule: official Week 14 = 19-25 Oct UTC, drop Tue 27 Oct 14:00 UTC (= /v1/points/epoch/current distribution_at 1793109600)
w = PT.window("risex", PT.window_index("risex", 1792620000))
assert w["n"] == 14 and w["start"] == 1792368000 and w["drop"] == 1793109600
assert PT.window("risex", PT.window_index("risex", 1784505600))["n"] == 1  # Week 1 = Mon 20 Jul 2026
assert PT.SCHED["risex"]["tracking"] and PT.SCHED["risex"]["dropExact"] and "risex" in PT.POINTS_SRC
pdoc = PT.update({}, {"risex": {"fills": f, "fundings": [], "from": 1792368000, "src": "RiseX public API", "apiNextDrop": 1793109600}},
                 {"risex": {"weeks": {"13": {"points": 12.5}}}}, 1792620000)
pr = {p["id"]: p for p in pdoc["platforms"]}["risex"]
assert pr["tracking"] and pr["connected"] and pr["apiNextDrop"] == 1793109600 and pr["earned"]["points"] == 12.5 and pr["window"]["n"] == 14
# positions + Bobby status: tracking pill, never "live", left out of the summary
st = POS.bobby_status({}, {}, None, None, True, {}, 1792620000)
rx = {p["id"]: p for p in st["platforms"]}["risex"]
assert rx["state"] == "tracking" and "not farmed" in rx["detail"] and "RiseX" not in st["summary"]
fin = POS.finish([POS.norm("risex", p, "manual") for p in r["positions"]], [], {"risex": {"status": "ok", "count": 2}}, st, 1792620000, {})
assert fin["platforms"]["risex"]["count"] == 2 and sum(1 for p in fin["positions"] if p["pf"] == "risex") == 2
assert "BOBBY_RISEX_ADDRESS" in open(os.path.join(os.path.dirname(__file__), "..", "positions.py")).read()
# loss caps: RiseX is not traded, so it is not in the limits
import limits as LM
assert "risex" not in LM.ORDER
print(json.dumps({"ok": True}))
