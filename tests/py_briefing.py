"""Offline tests for briefing.py (mock raw API bundles, no network)."""
import json, os, shutil, sys, tempfile
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
FX = ROOT / "tests" / "fixtures"
FAKE = "0x" + "ab" * 20
for _k in [k for k in os.environ if k.startswith("QFEX_") or k == "BOBBY_QFEX"]:
    os.environ.pop(_k)  # never touch a real QFEX key from the caller's environment
os.environ.update(BOBBY_ACCOUNT_ADDRESS=FAKE, BOBBY_TXFLOW_ADDRESS="", BOBBY_HL_ADDRESS="")
os.environ["BOBBY_VIEW_PASSPHRASE"] = "test-pass-briefing"
import briefing as B  # noqa: E402
import vaultpy  # noqa: E402
PT = lambda path: json.dumps(vaultpy.read_sealed(path), ensure_ascii=False)  # decrypted text

BER = ZoneInfo("Europe/Berlin")
ts = lambda *a: int(datetime(*a, tzinfo=BER).timestamp())
NOW = ts(2026, 10, 24, 8, 30)  # Saturday morning

# --- market hours
assert B.us_market(NOW)["text"] == "The US market is closed until Monday, so there's very little movement.", B.us_market(NOW)
w = B.us_market(ts(2026, 10, 21, 2, 49))
assert not w["open"] and "until 15:30 Berlin time" in w["text"], w
assert B.us_market(ts(2026, 10, 21, 16, 0))["open"]
assert "until Friday" in B.us_market(ts(2026, 11, 25, 23, 0))["text"]     # Thanksgiving Thu skipped
assert "until tomorrow 15:30" in B.us_market(ts(2026, 10, 21, 23, 0))["text"]

# --- baseline choice
snaps = [{"t": ts(2026, 10, 22, 22, 0)}, {"t": ts(2026, 10, 23, 22, 5)}, {"t": ts(2026, 10, 24, 7, 0)}]
b, nightly = B.pick_baseline(snaps, NOW)
assert nightly and b["t"] == ts(2026, 10, 23, 22, 5) and B.since_label(b, nightly, NOW) == "since last night"
b, nightly = B.pick_baseline([{"t": ts(2026, 10, 24, 7, 0)}], NOW)
assert not nightly and B.since_label(b, nightly, NOW) == "since Sat 07:00"

# --- full run on the mock bundle
tmp = Path(tempfile.mkdtemp())
snap = tmp / "snapshots.json"; shutil.copy(FX / "briefing_snapshots.json", snap)
out = tmp / "briefing.enc.json"
assert B.main(["--mock", str(FX / "briefing_mock.json"), "--snapshots", str(snap), "--out", str(out),
               "--comments", str(FX / "briefing_comments.json"), "--now", str(NOW)]) == 0
assert "ARCUS" not in out.read_text() and "\"ct\"" in out.read_text()  # ciphertext on disk
text = PT(out); d = json.loads(text)
assert FAKE not in text.lower() and "0xab" not in text.lower()
P = {p["id"]: p for p in d["platforms"]}
a = P["arcus"]
assert a["name"] == "ARCUS" and a["emoji"] == "🏹" and a["equity"] == 2381.4 and a["changeLabel"] == "since last night"
assert abs(a["change"] - (2381.4 - 2376.6) / 2376.6) < 1e-6
assert a["summary"] == "Positions: 3/3, nothing triggered overnight. The US market is closed until Monday, so there's very little movement.", a["summary"]
it = {i["sym"]: i for i in a["items"]}
assert it["TSLA"]["slInProfit"] is True and it["TSLA"]["auto"].startswith("I'm holding, the SL is in profit at 157")
assert it["NVDA"]["slActive"] == 200 and "is far away" in it["NVDA"]["auto"] and it["NVDA"]["tp"] == [170]
assert it["QQQ"]["comment"].startswith("I'm holding, the bounce") and it["QQQ"]["auto"]
assert a["detail"].startswith("One detail: NVDA has 2 SL orders") and "205" in a["detail"]
e = P["entropy"]
assert e["triggered"] == ["ANTH TP at 375"] and "triggered overnight: ANTH TP at 375." in e["summary"], e["summary"]
t = P["txflow"]
assert t["change"] < 0 and "Stray SL" in t["detail"] and t["items"][0]["sl"] == [98000] and "leaves some room" in t["items"][0]["auto"]
assert "US market" not in t["summary"]          # crypto only: no market-hours line
s = json.loads(snap.read_text()); assert len(s) == 2 and s[-1]["t"] == NOW and "orders" in s[-1]["platforms"]["arcus"]

# --- second run: baseline is now this morning's run, not last night
out2 = tmp / "b2.enc.json"
B.main(["--mock", str(FX / "briefing_mock.json"), "--snapshots", str(snap), "--out", str(out2), "--now", str(NOW + 3600)])
d2 = vaultpy.read_sealed(out2)
assert d2["platforms"][0]["changeLabel"] == "since last night"  # nightly snapshot still preferred

# --- low-OI picks (non-mock runs): fetched via the autotrader's key-less `picks`, published only inside the envelope
LOWOI = {"t": 1, "platforms": {"arcus": {"preferLowOi": True, "scanned": 3, "eligible": 2, "picks": [{"market": "W-USD", "oiUsd": 21000, "spread": 0.0014, "depthUsd": 170000}]},
         "txflow": {"manual": True, "picks": []}, "entropy": {"error": "HTTP 500"}}}
lo_calls = []
B.fetch_low_oi = lambda testnet: lo_calls.append(testnet) or LOWOI
assert "lowOi" not in d  # mock bundle without lowOi: nothing invented, nothing fetched

# --- no address configured -> nothing fetched, empty briefing
for k in ("BOBBY_ACCOUNT_ADDRESS",):
    os.environ[k] = ""
out3 = tmp / "b3.enc.json"
B.main(["--snapshots", str(tmp / "none.json"), "--out", str(out3), "--now", str(NOW)])
d3 = vaultpy.read_sealed(out3)
assert d3["platforms"] == [] and d3["lowOi"]["platforms"]["arcus"]["picks"][0]["market"] == "W-USD" and lo_calls == [False]
assert "W-USD" not in out3.read_text()  # ciphertext only
os.environ["BOBBY_LOW_OI"] = "0"; B.main(["--snapshots", str(tmp / "none.json"), "--out", str(out3), "--now", str(NOW)])
assert "lowOi" not in vaultpy.read_sealed(out3) and lo_calls == [False]; os.environ.pop("BOBBY_LOW_OI")
# --- QFEX (private data via the autotrader's status; key never in the output)
QK = {"QFEX_API_PUBLIC_KEY": "pk_test_public_abc", "QFEX_API_SECRET_KEY": "s3cr3t_" + "9" * 30, "QFEX_ACCOUNT_ID": "0b7c6a7e-1d2f-4c3b-9a8e-5f6d7c8b9a01"}
qst = json.loads((FX / "briefing_qfex_status.json").read_text())
os.environ.update(QK)
calls = []
B.fetch_qfex = lambda testnet, since_ms: calls.append((testnet, since_ms)) or qst
out4 = tmp / "b4.enc.json"
B.main(["--snapshots", str(tmp / "q.json"), "--out", str(out4), "--now", str(NOW)])
t4 = PT(out4); q = {p["id"]: p for p in json.loads(t4)["platforms"]}["qfex"]
assert calls and q["name"] == "QFEX" and q["equity"] == 301.2 and q["positions"]["open"] == 2
qi = {i["sym"]: i for i in q["items"]}
assert qi["US100"]["sl"] == [29300] and qi["US100"]["tp"] == [30100] and abs(qi["US100"]["mark"] - 29880) < 1e-6 and not qi["US100"]["equityUnderlying"]
assert qi["AAPL"]["equityUnderlying"] and "no SL" in qi["AAPL"]["auto"] and "AAPL has no stop-loss" in q["detail"]
assert all(v not in t4 for v in QK.values())
qst["stopsKnown"] = False
B.main(["--snapshots", str(tmp / "q2.json"), "--out", str(out4), "--now", str(NOW)])
q = {p["id"]: p for p in vaultpy.read_sealed(out4)["platforms"]}["qfex"]
assert "SL status unknown" in q["detail"] and {i["sym"]: i for i in q["items"]}["AAPL"]["auto"].startswith("SL status unknown")
# PnL since the snapshot: second run compares with the stored snapshot
qst["equity"] = 305.0
B.main(["--snapshots", str(tmp / "q2.json"), "--out", str(out4), "--now", str(NOW + 3600)])
q = {p["id"]: p for p in vaultpy.read_sealed(out4)["platforms"]}["qfex"]
assert abs(q["change"] - (305.0 - 301.2) / 301.2) < 1e-6, q
# a fetch error is scrubbed of the account id / keys
B.fetch_qfex = lambda testnet, since_ms: (_ for _ in ()).throw(RuntimeError("bad account " + QK["QFEX_ACCOUNT_ID"] + " key " + QK["QFEX_API_PUBLIC_KEY"]))
B.main(["--snapshots", str(tmp / "q3.json"), "--out", str(out4), "--now", str(NOW)])
t4 = PT(out4); assert "qfex" in t4 and all(v not in t4 for v in QK.values()), t4
# no key + BOBBY_QFEX=1 -> "needs a QFEX API key" card, nothing fetched
for k in QK:
    os.environ.pop(k)
os.environ["BOBBY_QFEX"] = "1"; calls.clear()
B.main(["--snapshots", str(tmp / "q4.json"), "--out", str(out4), "--now", str(NOW)])
q = {p["id"]: p for p in vaultpy.read_sealed(out4)["platforms"]}["qfex"]
assert q.get("needsKey") and "needs a QFEX API key" in q["error"] and not calls
# no passphrase -> refuses to publish
_pp = os.environ.pop("BOBBY_VIEW_PASSPHRASE")
try:
    B.main(["--mock", str(FX / "briefing_mock.json"), "--snapshots", str(tmp / "q5.json"), "--out", str(tmp / "x.enc.json"), "--now", str(NOW)]); raise AssertionError("published without passphrase")
except SystemExit as e:
    assert "BOBBY_VIEW_PASSPHRASE" in str(e)
assert not (tmp / "x.enc.json").exists()
os.environ["BOBBY_VIEW_PASSPHRASE"] = _pp
try:
    B.main(["--mock", str(FX / "briefing_mock.json"), "--snapshots", str(tmp / "q6.json"), "--out", str(tmp / "plain.json"), "--now", str(NOW)]); raise AssertionError("plaintext name accepted")
except SystemExit as e:
    assert ".enc.json" in str(e)
# long QFEX read outage (autotrader/qfex_health.json) -> note on the QFEX card; stale/recovered/missing -> nothing
from datetime import timezone as _tz
_iso = lambda ts: datetime.fromtimestamp(ts, _tz.utc).isoformat().replace("+00:00", "Z")
_hp = tmp / "qfex_health.json"
assert B.qfex_outage_note(_hp, NOW) is None
_hp.write_text(json.dumps({"t": _iso(NOW - 60), "down": True, "downMin": 14, "failedTicks": 9}))
_n = B.qfex_outage_note(_hp, NOW); assert _n and "14 min" in _n and "paused" in _n, _n
_hp.write_text(json.dumps({"t": _iso(NOW - 3600), "down": True, "downMin": 14, "failedTicks": 9}))
assert B.qfex_outage_note(_hp, NOW) is None
_hp.write_text(json.dumps({"t": _iso(NOW - 60), "down": False, "recoveredAt": _iso(NOW - 60)}))
assert B.qfex_outage_note(_hp, NOW) is None
print(json.dumps({"ok": True}))
