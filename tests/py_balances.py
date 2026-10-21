"""Offline tests for balances.py: ledger math, overrides, deposits, encryption, no plaintext, refusal without passphrase."""
import json, os, sys, tempfile
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
for k in [k for k in os.environ if k.startswith(("QFEX_", "BOBBY_"))]:
    os.environ.pop(k)
import balances as BL  # noqa: E402
import vaultpy  # noqa: E402

T0 = 1792500000
led = {}
d = BL.update(led, {"qfex": {"equity": 100.0, "deposit": 100.0}, "arcus": {"equity": 300.0}}, {}, T0)
P = {r["id"]: r for r in d["platforms"]}
assert P["qfex"]["start"] == 100 and P["qfex"]["pnl"] == 0 and P["entropy"]["status"] == "not connected yet" and P["txflow"]["status"] == "not connected yet"
assert d["total"] == {"start": 400.0, "current": 400.0, "netDeposits": 0.0, "pnl": 0.0, "pnlPct": 0.0}
# QFEX: +50 deposited, equity 152 -> pnl +2 ; Arcus manual start 290 + 5 net deposits, equity 297 -> pnl +2
d = BL.update(led, {"qfex": {"equity": 152.0, "deposit": 150.0}, "arcus": {"equity": 297.0}}, {"arcus": {"start": 290, "netDeposits": 5}}, T0 + 3600)
P = {r["id"]: r for r in d["platforms"]}
assert P["qfex"]["netDeposits"] == 50 and P["qfex"]["pnl"] == 2 and abs(P["qfex"]["pnlPct"] - 2 / 150) < 1e-6
assert P["arcus"]["start"] == 290 and P["arcus"]["netDeposits"] == 5 and P["arcus"]["pnl"] == 2 and P["arcus"]["startOverride"]
assert d["total"]["pnl"] == 4 and len(d["history"]) == 2 and d["history"][-1]["total"] == {"eq": 449.0, "pnl": 4.0}
# Hyperliquid ledger flows into dex io (send) and main (deposit)
A = "0x" + "ab" * 20
ups = [{"delta": {"type": "deposit", "usdc": "100"}}, {"delta": {"type": "send", "usdcValue": "40", "destinationDex": "io", "destination": A, "sourceDex": "", "user": A}},
       {"delta": {"type": "withdraw", "usdc": "10", "fee": "1"}}]
assert BL.hl_flows(ups, A, ["io"]) == 40 and BL.hl_flows(ups, A, ["", "io"]) == 100 - 11  # main->io send nets out when both counted
d = BL.update(led, {"entropy": {"equity": 41.0, "flowsSince": 0.0}}, {}, T0 + 7200)
d = BL.update(led, {"entropy": {"equity": 85.0, "flowsSince": 40.0}}, {}, T0 + 10800)
assert {r["id"]: r for r in d["platforms"]}["entropy"]["pnl"] == 4
# CLI: refuses without passphrase; writes ciphertext only
tmp = Path(tempfile.mkdtemp()); mock = tmp / "m.json"; mock.write_text(json.dumps({"qfex": {"equity": 100, "deposit": 100, "positions": [{"market": "GOLD-USD", "side": "long", "size": 0.001, "entry": 4141.2,
    "mark": 4139.6, "upnl": -0.0016, "sl": [4124.7], "tp": [4174.3], "protected": True}],
    "volume": {"day": {"volume": 1000, "fees": 0.2, "pnl": -0.1, "trades": 4}, "week": {"volume": 70000, "fees": 14, "pnl": -5, "trades": 300}, "month": {"volume": 150000, "fees": 30, "pnl": -12, "trades": 700}, "goal": 300000}}}))
(tmp / "ALERT").write_text(json.dumps({"t": "2026-10-21T12:00:00Z", "pf": "qfex", "market": "GOLD-USD", "kind": "close", "missing": ["sl"], "ok": True, "reason": "no planned SL/TP"}) + "\nbad\n")
args = ["--mock", str(mock), "--ledger", str(tmp / "l.json"), "--starts", str(tmp / "s.json"), "--out", str(tmp / "b.enc.json"), "--now", str(T0), "--alerts", str(tmp / "ALERT")]
try:
    BL.main(args); raise AssertionError("published without passphrase")
except SystemExit as e:
    assert "BOBBY_VIEW_PASSPHRASE" in str(e)
assert not (tmp / "b.enc.json").exists()
os.environ["BOBBY_VIEW_PASSPHRASE"] = "test-pass-balances"
assert BL.main(args) == 0
raw = (tmp / "b.enc.json").read_text()
assert "qfex" not in raw and "100" not in json.loads(raw)["ct"][:0] and json.loads(raw)["alg"] == "AES-256-GCM" and json.loads(raw)["it"] == 600000
doc = vaultpy.read_sealed(tmp / "b.enc.json")
assert doc["positions"] == [{"pf": "qfex", "market": "GOLD-USD", "side": "long", "size": 0.001, "entry": 4141.2, "mark": 4139.6, "upnl": -0.0016, "sl": [4124.7], "tp": [4174.3], "protected": True}]
assert BL.positions_of({"positions": [{"market": "X", "side": "short", "size": 1, "sl": [], "tp": [2]}]})[0]["protected"] is False
assert doc["volume"]["month"]["volume"] == 150000 and doc["volume"]["monthPct"] == 50.0 and doc["volume"]["week"]["fees"] == 14
assert BL.volume_line(None) is None and BL.volume_line({"x": 1}) is None
assert doc["alerts"]["count"] == 1 and doc["alerts"]["latest"][0]["kind"] == "close"
assert {r["id"]: r for r in doc["platforms"]}["qfex"]["current"] == 100 and oct(os.stat(tmp / "l.json").st_mode)[-3:] == "600"
try:
    vaultpy.read_sealed(tmp / "b.enc.json", "wrong-passphrase"); raise AssertionError("wrong passphrase accepted")
except Exception as e:  # noqa: BLE001
    assert "AssertionError" not in type(e).__name__
# Entropy (Bobby subaccount): mode read every run; standard -> main + io + spot USDC; unified/portfolio -> spot USDC + io uPnL
class FakeHL:
    def __init__(self, mode, main="0.0", io="0.0", spot="0.0", upnl="0"):
        self.mode, self.main, self.io, self.spot, self.upnl = mode, main, io, spot, upnl
    def _post(self, url, body):
        t = body["type"]
        if t == "clearinghouseState":
            io = body.get("dex") == "io"
            return {"marginSummary": {"accountValue": self.io if io else self.main},
                    "assetPositions": [{"position": {"coin": "io:X", "szi": "1", "unrealizedPnl": self.upnl}}] if io and self.upnl != "0" else []}
        if t == "userAbstraction":
            return self.mode
        if t == "spotClearinghouseState":
            return {"balances": [{"coin": "USDC", "total": self.spot, "hold": "0.0"}, {"coin": "HYPE", "total": "221.0", "hold": "0"}]}
        raise AssertionError(t)
    def _get(self, url, q): raise AssertionError("no GET expected")
    def _tx(self, url, body): raise AssertionError("no TxFlow expected")
    ENDPOINTS = BL.B.ENDPOINTS
    scrub = staticmethod(BL.B.scrub)
_realB = BL.B
os.environ["BOBBY_HL_ADDRESS"] = "0x" + "cd" * 20
cases = (  # mode, main, io, spot, io uPnL, want equity, want split, funds-not-on-io note
    ("disabled", "300.185872", "0.0", "0.00717387", "0", 300.19304587, {"main": 300.19, "io": 0.0, "spot": 0.01}, True),  # today's real case
    ("disabled", "0.0", "150.0", "0.0", "0", 150.0, {"main": 0.0, "io": 150.0, "spot": 0.0}, False),
    ("unifiedAccount", "0.0", "0.0", "300.18717387", "0", 300.18717387, {"main": 0.0, "io": 0.0, "spot": 300.19}, False),
    ("portfolioMargin", "0.0", "0.0", "300.18717387", "-2.5", 297.68717387, {"main": 0.0, "io": -2.5, "spot": 300.19}, False),
    ("unifiedAccount", "0.0", "55.0", "300.0", "0", 300.0, {"main": 0.0, "io": 0.0, "spot": 300.0}, False),  # per-dex value ignored
)
for mode, main, io, spot, upnl, want, split, noted in cases:
    BL.B = FakeHL(mode, main, io, spot, upnl)
    live, _ = BL.read_live(False, {})
    e = live["entropy"]
    assert abs(e["equity"] - want) < 1e-6 and e["split"] == split and e["mode"] == mode, (mode, e)
    assert ("funds not on EntropyIO yet" in (e.get("note") or "")) == noted, e
BL.B = _realB; os.environ.pop("BOBBY_HL_ADDRESS")
# flows: master -> sub spot sends count, internal spot <-> main moves of the sub net to 0, other tokens ignored
SUBA, MAS = "0x" + "e2" * 20, "0x" + "34" * 20
ups = [{"delta": {"type": "send", "user": MAS, "destination": SUBA, "sourceDex": "spot", "destinationDex": "spot", "token": "USDC", "usdcValue": "300.18"}},
       {"delta": {"type": "send", "user": SUBA, "destination": SUBA, "sourceDex": "spot", "destinationDex": "", "token": "USDC", "usdcValue": "300.18"}},
       {"delta": {"type": "send", "user": MAS, "destination": SUBA, "sourceDex": "spot", "destinationDex": "cash", "token": "USDT0", "usdcValue": "100"}},
       {"delta": {"type": "accountClassTransfer", "usdc": "50", "toPerp": True}}]
assert abs(BL.hl_flows(ups, SUBA, ["", "io", "spot"]) - 300.18) < 1e-9
# the published row carries the split and mode
d = BL.update({}, {"entropy": {"equity": 300.19, "split": {"main": 300.19, "io": 0, "spot": 0}, "splitBasis": "main dex + io + spot", "mode": "disabled"}}, {}, T0)
r = {x["id"]: x for x in d["platforms"]}["entropy"]; assert r["split"]["main"] == 300.19 and r["mode"] == "disabled"
print(json.dumps({"ok": True, "envelope": json.loads(raw) | {"ct": "…"}}))
