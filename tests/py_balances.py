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
print(json.dumps({"ok": True, "envelope": json.loads(raw) | {"ct": "…"}}))
