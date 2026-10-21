"""Offline tests for briefing.py (mock raw API bundles, no network)."""
import json, os, shutil, sys, tempfile
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
FX = ROOT / "tests" / "fixtures"
FAKE = "0x" + "ab" * 20
os.environ.update(BOBBY_ACCOUNT_ADDRESS=FAKE, BOBBY_TXFLOW_ADDRESS="", BOBBY_HL_ADDRESS="")
import briefing as B  # noqa: E402

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
out = tmp / "briefing.json"
assert B.main(["--mock", str(FX / "briefing_mock.json"), "--snapshots", str(snap), "--out", str(out),
               "--comments", str(FX / "briefing_comments.json"), "--now", str(NOW)]) == 0
text = out.read_text(); d = json.loads(text)
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
out2 = tmp / "b2.json"
B.main(["--mock", str(FX / "briefing_mock.json"), "--snapshots", str(snap), "--out", str(out2), "--now", str(NOW + 3600)])
d2 = json.loads(out2.read_text())
assert d2["platforms"][0]["changeLabel"] == "since last night"  # nightly snapshot still preferred

# --- no address configured -> nothing fetched, empty briefing
for k in ("BOBBY_ACCOUNT_ADDRESS",):
    os.environ[k] = ""
out3 = tmp / "b3.json"
B.main(["--snapshots", str(tmp / "none.json"), "--out", str(out3), "--now", str(NOW)])
assert json.loads(out3.read_text())["platforms"] == []
print(json.dumps({"ok": True}))
