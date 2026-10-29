"""Offline tests: tradexyz.py (tracking only): fills summary, xyz flows, positions + TP/SL, live read with a fake API (Bobby excluded,
incremental cache, truncation note), balances / flows / positions / points wiring."""
import json, sys, os, tempfile
from pathlib import Path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import tradexyz as TX, flows as FL, positions as POS, points as PT, balances as BL, limits as LM

MAIN, SUB, BOBBY = "0x" + "a1" * 20, "0x" + "b2" * 20, "0x" + "c3" * 20
NOW = 1793260800  # Thu 29 Oct 2026 08:00 UTC
WEEK = NOW - (NOW - 345600) % 604800
assert WEEK == 1792972800  # Mon 26 Oct 2026 00:00 UTC
F = lambda t, coin, px, sz, fee, pnl, crossed, tid: {"time": t, "coin": coin, "px": str(px), "sz": str(sz), "fee": str(fee), "closedPnl": str(pnl), "crossed": crossed, "tid": tid, "oid": tid}
fills = {MAIN: [F(1763171400000, "xyz:NVDA", 200, 10, 0.5, 0, True, 1), F(1793000000000, "xyz:NVDA", 210, 10, 0.5, 100, True, 2),
                F(1793000001000, "BTC", 100000, 0.01, 0.4, 0, True, 3), F(1793000002000, "@107", 40, 1, 0, 0, True, 4)],
         SUB: [F(1792000000000, "xyz:XYZ100", 25000, 0.1, -0.1, -5, False, 5)], BOBBY: [F(1793000000000, "xyz:GOLD", 4000, 1, 1, 0, True, 6)]}
ups = {SUB: [{"hash": "0x1", "delta": {"type": "send", "usdcValue": "200", "sourceDex": "", "destinationDex": "xyz", "nonce": 1}},
             {"hash": "0x2", "delta": {"type": "send", "usdcValue": "74.72", "sourceDex": "xyz", "destinationDex": "spot", "nonce": 2}}]}
state = {MAIN: {"marginSummary": {"accountValue": "120.5"}, "assetPositions": [{"position": {"coin": "xyz:TSLA", "szi": "-2", "entryPx": "450", "positionValue": "880", "unrealizedPnl": "20", "leverage": {"value": 5}}}]}}
calls = []


class FakeB:
    ENDPOINTS = {False: {"hl": "https://api.hyperliquid.xyz/info"}}

    @staticmethod
    def _post(url, body):
        calls.append(body); u = body.get("user")
        t = body["type"]
        if t == "subAccounts":
            return [{"subAccountUser": SUB, "name": "x"}, {"subAccountUser": BOBBY, "name": "Bobby"}]
        if t == "userFillsByTime":
            return [f for f in fills.get(u, []) if f["time"] >= body["startTime"]]
        if t == "userFunding":
            return [{"time": 1793000000000, "delta": {"coin": "xyz:NVDA", "usdc": "-1.5"}}] if u == MAIN else []
        if t == "clearinghouseState":
            assert body["dex"] == "xyz"
            return state.get(u, {"marginSummary": {"accountValue": "0"}, "assetPositions": []})
        if t == "frontendOpenOrders":
            return [{"coin": "xyz:TSLA", "isTrigger": True, "reduceOnly": True, "orderType": "Stop Market", "triggerPx": "480"},
                    {"coin": "xyz:TSLA", "isTrigger": True, "reduceOnly": True, "orderType": "Take Profit Market", "triggerPx": "400"}]
        if t == "userNonFundingLedgerUpdates":
            return ups.get(u, [])
        if t == "portfolio":
            return [["perpAllTime", {"vlm": "50000" if u == MAIN else "2500"}]]
        raise AssertionError(t)


tmp = Path(tempfile.mkdtemp()); TX.CACHE = tmp / "tradexyz_cache.json"
r = TX.read(FakeB, False, MAIN, exclude=(BOBBY,), now_s=NOW, week_start_s=WEEK)
v = r["xyzVolume"]
assert v["volume"] == 2000 + 2100 + 2500 and v["fills"] == 3 and v["taker"] == 4100 and v["maker"] == 2500, v  # BTC, spot and Bobby fills ignored
assert v["fees"] == 0.9 and v["closedPnl"] == 95 and v["funding"] == -1.5 and v["pnl"] == round(95 - 0.9 - 1.5, 2) == r["allTimePnl"]
assert v["week"]["volume"] == 2100 and v["last30d"]["volume"] == 4600 and v["first"] == 1763171400000 and v["last"] == 1793000000000
assert [m["market"] for m in v["byMarket"]] == ["NVDA", "XYZ100"] and v["byMarket"][0]["volume"] == 4100
assert "10,000" in v["historyNote"]  # main: portfolio 50k vs 5.1k of perp fills -> flagged; sub: 2.5k vs 2.5k -> fine
assert r["equity"] == 120.5 and r["allTime"]["deposits"] == 200 and r["allTime"]["withdrawals"] == 74.72 and r["deposit"] == 125.28 and r["accounts"] == 2
p = r["positions"][0]
assert p["market"] == "TSLA" and p["side"] == "short" and p["size"] == 2 and p["mark"] == 440 and p["sl"] == [480] and p["tp"] == [400] and p["protected"]
assert all(c.get("user") != BOBBY for c in calls)  # the Bobby subaccount is never read
assert r["activity"]["from"] == WEEK - 5 * 604800 and len(r["activity"]["fills"]) == 2  # points tab: last 6 weeks only
pub = json.dumps({k: r[k] for k in ("allTime", "note", "positions", "xyzVolume")}).lower()
assert MAIN[2:] not in pub and SUB[2:] not in pub
cache = TX.CACHE.read_text()
assert MAIN[2:] not in cache.lower() and oct(TX.CACHE.stat().st_mode & 0o777) == "0o600"
# incremental: a second read only asks for fills after the last one seen, totals unchanged
calls.clear()
r2 = TX.read(FakeB, False, MAIN, exclude=(BOBBY,), now_s=NOW + 3600, week_start_s=WEEK)
assert r2["xyzVolume"]["volume"] == v["volume"] and r2["xyzVolume"]["fills"] == 3
assert min(c["startTime"] for c in calls if c["type"] == "userFillsByTime") >= 1792000000000
# balances row + flows card + positions + points + valuation wiring
assert "tradexyz" in BL.ORDER and "tradexyz" in FL.ORDER and "tradexyz" in POS.TRACKING and "tradexyz" not in LM.ORDER
d = BL.update({}, {"tradexyz": r}, {}, NOW)
row = {x["id"]: x for x in d["platforms"]}["tradexyz"]
assert row["current"] == 120.5 and row["xyzVolume"]["volume"] == 6600 and "tracking only" in row["note"], row
fr = {x["id"]: x for x in FL.build({"tradexyz": r}, {})["rows"]}["tradexyz"]
assert fr["deposits"] == 200 and fr["withdrawals"] == 74.72 and fr["net"] == 125.28 and fr["current"] == 120.5 and "unified" in (fr.get("note") or "")
assert {x["id"]: x for x in FL.build({"tradexyz": {"status": "error"}}, {})["rows"]}["tradexyz"]["reason"].startswith("not read")
st = POS.bobby_status({}, {}, None, None, True, {}, NOW)
xs = {q["id"]: q for q in st["platforms"]}["tradexyz"]
assert xs["state"] == "tracking" and "not farmed" in xs["detail"] and "trade.xyz" not in st["summary"]
fin = POS.finish([POS.norm("tradexyz", q, "manual") for q in r["positions"]], [], {"tradexyz": {"status": "ok", "count": 1}}, st, NOW, {})
assert fin["platforms"]["tradexyz"]["count"] == 1 and [q["pf"] for q in fin["positions"]] == ["tradexyz"]
assert PT.SCHED["tradexyz"]["tracking"] and PT.SCHED["tradexyz"]["kind"] == "not announced" and "tradexyz" in PT.POINTS_SRC
assert PT.window("tradexyz", PT.window_index("tradexyz", NOW))["start"] == WEEK
pdoc = PT.update({}, PT.mock_activity({"tradexyz": r}), {}, NOW)
pr = {x["id"]: x for x in pdoc["platforms"]}["tradexyz"]
assert json.dumps(pr).count("2100") >= 1, pr
print(json.dumps({"ok": True}))
