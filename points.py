#!/usr/bin/env python3
"""Bobby Trader: points weeks per platform (schedules, countdown targets, volume / fees / PnL per points week).

Used by balances.py (its output goes into the ENCRYPTED public/balances.enc.json under "points"); nothing here is ever
published in plaintext. Read-only public data only: TxFlow /info (userFills, userFundings, clearinghouseState,
frontendOpenOrders), Hyperliquid /info (userFillsByTime, Entropy dexes), Variational's public next-drop timestamp,
QFEX fills from the autotrader status (HMAC key stays in the autotrader). No private key is ever read.

Schedules (primary sources, checked 2026-10-21):
  arcus        Season 1: 250K points/week, distributed Wednesdays 19:00 UTC (Arcus Points page; the blog says 3 PM ET).
               arcus.xyz/blog/introducing-arcus-points; x.com/arcus_xyz/status/2106278949915681229 (+ weekly posts)
  txflow       Season 1: 1.25M trader points/epoch, epochs Monday -> Monday 00:00 UTC, credited the Tuesday after.
               docs.txflow.com/points/how-points-work; x.com/TxFlow_L1/status/2112605558079635890
  variational  Omni: 150K points/week, distributed Fridays 00:00 UTC for activity through Thursday 00:00 UTC.
               docs.variational.io/omni/rewards/points; GET omni.variational.io/api/points/next_drop_ts (public)
  entropy      no points; USDC fee rebates, "distributions occur bi-weekly" (no day/time published).
               docs.entropy.io/about-entropy/referrals
  qfex         Season 0 announced (CEO post 2026-10-07), no schedule/rules published.
  extended     TRACKING ONLY (not farmed). Weekly epochs Tuesday -> Monday (page dates; Tue 00:00 UTC assumed); weekly distributions have ENDED (docs:
               "as of 06.10.2026, 69,235,805 of 70 million points distributed"; last weekly = Epoch 75, Sep 29 - Oct 5);
               a final distribution follows the ongoing competition (date not published).
               docs.extended.exchange/extended-resources/points-program. Account data (volume/PnL/points) is only
               available with an API key (api.docs.extended.exchange), which we do not have or request -> manual.
  risex        TRACKING ONLY (not farmed). Season 1 "Ignite": 200K points/week, weeks Monday 00:00 -> Sunday 23:59 UTC,
               distributed Tuesdays 14:00 UTC (first drop Tue 28 Jul 2026 for Week 1 = 20-26 Jul); ends no later than Q2 2027.
               docs.risechain.com/docs/risex/rewards/points; blog.risechain.com (Season 1 guide); GET api.rise.trade/v1/points/epoch/current
               (public: "Week 14 (19-25 Oct UTC)", distribution_at Tue 27 Oct 14:00 UTC). Volume/fees/PnL per week from the public
               trade history; wallet points need a wallet-signed JWT -> manual.
  metric       TRACKING ONLY (not farmed). Spot propAMM DEX (metric.xyz) for tokenized stocks/crypto on Ethereum, BNB Chain
               and Robinhood Chain. Points UI exists but no official formula, season schedule or token/TGE announced (as of Oct 2026).
               Referrals are live; wash trading / self-deals banned (terms). No public per-address points/balances API -> manual
               (screenshots). Genuine swap volume on Metric's own quotes is what scores; farming plan is a separate build.

Ledger (git-ignored, chmod 600) points_ledger.json: {"v": 1, "weeks": {pf: {"<window start unix>": row}}, "cov": {pf: unix}}.
Manual entries (git-ignored) points_manual.json, see points_manual.example.json: per platform "equity" (balance for
platforms without a public per-address API, e.g. Variational), "netDeposits", and "weeks": {"<week number>": {"volume",
"pnl", "fees", "points"}} - manual values override/extend the computed ones (points are not readable by API anywhere).
"""
import json, os, time, urllib.request
from datetime import date, datetime, time as dtime, timedelta, timezone
from zoneinfo import ZoneInfo

UTC, ET = timezone.utc, ZoneInfo("America/New_York")
DAY = 86400
ORDER = ("arcus", "entropy", "txflow", "qfex", "variational", "extended", "risex", "metric", "tradexyz")
NAMES = {"arcus": "🏹 Arcus", "entropy": "🤖 Entropy", "txflow": "🌊 TxFlow", "qfex": "📈 QFEX", "variational": "🌀 Variational", "extended": "♟️ Extended", "risex": "⚡ RiseX", "metric": "🔷 Metric", "tradexyz": "📊 trade.xyz"}
VARIATIONAL_NEXT_DROP = "https://omni.variational.io/api/points/next_drop_ts"
HISTORY_KEEP = 60
# Where the points numbers come from. Checked 2026-10-21: no documented API exposes a user's points on any platform, so
# points are entered by hand (points_manual.json) and kept in the private points ledger. activity[pf]["points"] =
# {window_start: points} is the hook for an official source if one appears (shown as "auto").
POINTS_SRC = {
    "arcus": "manual: the documented Arcus API (docs.arcus.xyz, REST + WebSocket) has no points or rewards endpoint; points are only shown on the Arcus Points Dashboard",
    "txflow": "manual: the TxFlow API (docs.txflow.com) has no points query (only referral rewards); points are shown on the TxFlow Points dashboard",
    "variational": "manual: Variational documents no points API; the Omni points page needs a signed-in session",
    "qfex": "manual: the QFEX API (api.qfex.com/openapi.yaml) has no points or season endpoint (only referral rewards); Season 0 points are not published yet",
    "extended": "manual: Extended's points (GET /api/v1/user/rewards/earned) and account volume/PnL are only readable with an Extended API key, which Bobby does not have and does not request (tracking only)",
    "risex": "manual: RiseX documents wallet points endpoints (GET /v1/points/..., developer.rise.trade) but they need a JWT from a wallet-signed login; Bobby has no RiseX signer and does not request one (tracking only). Points are shown on rise.trade/points",
    "tradexyz": "none announced: trade[XYZ] has no points program or token (docs.trade.xyz, Oct 2026); volume / fees / PnL from the public Hyperliquid fills on the xyz dex (tracking only)",
    "metric": "manual: Metric (metric.xyz) shows points in the app UI only; no documented public points/balances API and Bobby does not hold a Metric trading key (tracking only). Enter points from screenshots / the app",
    "entropy": "rebates, not points: Entropy pays USDC/HYPE fee rebates every 2 weeks (claimable on the Entropy profile, no API); enter them as \"rebates\" by week",
}
KEEP = ("points", "pointsSrc", "rebates", "rebatesSrc")  # survive a recompute of the week from fills
PENDING_GRACE = {}  # TxFlow: drop = Tuesday 00:00 UTC after the epoch (credit time on Tuesday not stated)


def _utc_midnight(d):
    return int(datetime.combine(d, dtime(0), tzinfo=UTC).timestamp())


# Each schedule: boundary(k) -> unix of the k-th window boundary (k may be negative); window k = [b(k), b(k+1)).
# number(k) -> week/epoch number of window k; drop(k) -> unix of the points drop for window k (None = not published).
SCHED = {
    "arcus": {
        "kind": "points", "program": "Season 1 · 250K points / week", "unit": "Week",
        "boundary": lambda k: _utc_midnight(date(2026, 10, 7) + timedelta(days=7 * k)) + 19 * 3600,
        "number": lambda k: k + 2, "drop": lambda s, e: e, "dropExact": True,
        "rule": "Points drop every Wednesday 19:00 UTC, as stated on the Arcus Points page (\"Points distributed at 19:00:00 UTC every Wednesday\"; 21:00 Berlin now, 20:00 from 25 Oct). Note: the Arcus blog says 3 PM ET, which is 20:00 UTC from 1 Nov",
        "window": "Drop to drop, Wednesday 19:00 UTC → Wednesday 19:00 UTC (Arcus does not publish the exact activity cut-off: assumed)",
        "endsBy": int(datetime(2027, 7, 1, tzinfo=ET).timestamp()), "endsNote": "Program ends no later than end of H1 2027",
        "sources": [["Arcus blog: Introducing Arcus Points", "https://arcus.xyz/blog/introducing-arcus-points"],
                    ["@arcus_xyz: definitive points update (Wed 3PM)", "https://x.com/arcus_xyz/status/2106278949915681229"],
                    ["@arcus_xyz: Season 1 Week 2 complete", "https://x.com/arcus_xyz/status/2110449661031129363"]],
        "unverified": ["activity window (assumed drop-to-drop)", "blog says 3 PM ET (20:00 UTC after 1 Nov); the Points page's 19:00 UTC is used"],
    },
    "txflow": {
        "kind": "points", "program": "Season 1 · 1.25M trader points / epoch", "unit": "Epoch",
        "boundary": lambda k: _utc_midnight(date(2026, 10, 12) + timedelta(days=7 * k)),
        "number": lambda k: k + 1, "drop": lambda s, e: e + DAY, "dropExact": False,  # credited "on Tuesday": countdown to Tue 00:00 UTC (earliest)
        "rule": "Epochs run Monday 00:00 → Monday 00:00 UTC; points are credited the Tuesday after (countdown targets Tuesday 00:00 UTC, the earliest possible time) (time not stated; Epoch 1 was announced Tue 20 Oct 20:03 Berlin)",
        "window": "Monday 00:00 UTC → Monday 00:00 UTC (02:00/01:00 Berlin)",
        "endsBy": int(datetime(2027, 4, 1, tzinfo=UTC).timestamp()), "endsNote": "Weekly distribution ends no later than Q1 2027",
        "sources": [["TxFlow docs: How Points Work", "https://docs.txflow.com/points/how-points-work"],
                    ["@TxFlow_L1: Season 1 Epoch 1 distributed", "https://x.com/TxFlow_L1/status/2112605558079635890"]],
        "unverified": ["exact credit time on Tuesday"],
    },
    "variational": {
        "kind": "points", "program": "Omni points · 150K points / week", "unit": "Week",
        "boundary": lambda k: _utc_midnight(date(2026, 10, 15) + timedelta(days=7 * k)),
        "number": lambda k: k + 45, "drop": lambda s, e: e + DAY, "dropExact": True,
        "rule": "Points drop every Friday 00:00 UTC (02:00/01:00 Berlin) for activity through Thursday 00:00 UTC",
        "window": "Thursday 00:00 UTC → Thursday 00:00 UTC",
        "endsBy": int(datetime(2027, 1, 1, tzinfo=UTC).timestamp()), "endsNote": "Weekly distributions end no later than end of Q4 2026",
        "sources": [["Variational docs: Points", "https://docs.variational.io/omni/rewards/points"],
                    ["Variational help: When are points distributed?", "https://help.variational.io/en/articles/15029270-when-are-points-distributed"],
                    ["@variational_io: week 44 distributed", "https://x.com/variational_io/status/2110886003036844486"],
                    ["Public API: next_drop_ts", VARIATIONAL_NEXT_DROP]],
        "unverified": [],
    },
    "entropy": {
        "kind": "rebates", "program": "No points · USDC fee rebates (bi-weekly) · Hyperliquid io dex", "unit": "Week",
        "boundary": lambda k: _utc_midnight(date(2026, 10, 12) + timedelta(days=7 * k)),
        "number": lambda k: None, "drop": lambda s, e: None, "dropExact": False,
        "rule": "No points program. Fee rebates are claimable on the Entropy profile (min $5); \"distributions occur bi-weekly\", day and time not published",
        "window": "No official points week: tracking week Monday 00:00 → Monday 00:00 UTC",
        "endsBy": None, "endsNote": None,
        "sources": [["Entropy docs: Referrals / rebates", "https://docs.entropy.io/about-entropy/referrals"]],
        "unverified": ["rebate distribution day/time"],
    },
    "extended": {
        "kind": "ended", "tracking": True, "program": "Points program · weekly distributions ended (70M points total)", "unit": "Epoch",
        "boundary": lambda k: _utc_midnight(date(2026, 9, 29) + timedelta(days=7 * k)),
        "number": lambda k: k + 75, "drop": lambda s, e: None, "dropExact": False,
        "rule": "Weekly distributions have ended (69,235,805 of 70M points distributed as of 6 Oct 2026; last weekly epoch: Epoch 75, Sep 29 - Oct 5). The final distribution takes place after the ongoing competition: date not published",
        "window": "Epochs Tuesday → Monday (dates as shown on the Extended points page, e.g. Epoch 75 = Tue Sep 29 - Mon Oct 5, 2026); assumed Tuesday 00:00 UTC boundaries",
        "endsBy": _utc_midnight(date(2026, 10, 6)), "endsNote": "Weekly distributions ended; one final distribution after the ongoing competition (date not published)",
        "sources": [["Extended docs: Points Program", "https://docs.extended.exchange/extended-resources/points-program"],
                    ["Extended API docs: Points (authenticated)", "https://api.docs.extended.exchange/#points"]],
        "unverified": ["exact epoch boundary time (dates only on the points page)", "final distribution date"],
    },
    "risex": {
        "kind": "points", "tracking": True, "program": "Season 1 \u201cIgnite\u201d · 200K points / week", "unit": "Week",
        "boundary": lambda k: _utc_midnight(date(2026, 10, 19) + timedelta(days=7 * k)),
        "number": lambda k: k + 14, "drop": lambda s, e: e + DAY + 14 * 3600, "dropExact": True,
        "rule": "Points are distributed every Tuesday 14:00 UTC (16:00 Berlin now, 15:00 from 25 Oct) for the week Monday 00:00 \u2192 Sunday 23:59 UTC. The weekly model and weightings change and are not published; counted: volume (maker and taker), total costs (fees, slippage, negative markouts), open interest and hold time, trading sophistication (wash-style flow scores lower), referrals (+10% of referees' points)",
        "window": "Monday 00:00 UTC \u2192 Monday 00:00 UTC (02:00/01:00 Berlin); official: Week 14 = 19\u201325 Oct UTC",
        "endsBy": int(datetime(2027, 7, 1, tzinfo=UTC).timestamp()), "endsNote": "Season 1 ends no later than Q2 2027 (tied to product milestones)",
        "sources": [["RISE docs: RISEx Points", "https://docs.risechain.com/docs/risex/rewards/points"],
                    ["RISE blog: Season 1 Ignite guide", "https://blog.risechain.com/rise-points-season-1-ignite-everything-you-need-to-know/"],
                    ["RiseX API: current points epoch (public)", "https://api.rise.trade/v1/points/epoch/current"],
                    ["RiseX API docs", "https://developer.rise.trade/reference/general-information"],
                    ["@risextrade on X (weekly drop posts)", "https://x.com/risextrade"]],
        "unverified": [],
    },
    "tradexyz": {
        "kind": "not announced", "tracking": True, "program": "No points program · no token announced", "unit": "Week",
        "boundary": lambda k: _utc_midnight(date(2026, 10, 12) + timedelta(days=7 * k)),
        "number": lambda k: None, "drop": lambda s, e: None, "dropExact": False,
        "rule": "trade[XYZ] (Hyperliquid HIP-3 dex \u201cxyz\u201d) has no official points, season or token. Its trades are Hyperliquid trades too (same wallet, same matching engine). Not valued until something official is published",
        "window": "No official points week: tracking week Monday 00:00 \u2192 Monday 00:00 UTC",
        "endsBy": None, "endsNote": None,
        "sources": [["trade[XYZ] docs", "https://docs.trade.xyz/"],
                    ["trade[XYZ] docs: relationship to Hyperliquid (HIP-3 \u201cxyz\u201d)", "https://docs.trade.xyz/overview/relationship-to-hyperliquid"],
                    ["@tradexyz on X", "https://x.com/tradexyz"]],
        "unverified": ["any points / token / airdrop"],
    },
    "metric": {
        "kind": "not announced", "tracking": True, "program": "Points UI live · schedule / formula not announced", "unit": "Week",
        "boundary": lambda k: _utc_midnight(date(2026, 10, 12) + timedelta(days=7 * k)),
        "number": lambda k: None, "drop": lambda s, e: None, "dropExact": False,
        "rule": "Metric shows a points balance in the app, but no official season, drop day or scoring formula is published. Referrals are live. Counted activity (per public posts / terms): genuine swaps that take Metric's own propAMM quote (not 0x/Kyber routes). Wash trading and self-deals are banned",
        "window": "No official points week yet: tracking week Monday 00:00 → Monday 00:00 UTC",
        "endsBy": None, "endsNote": None,
        "sources": [["Metric", "https://metric.xyz/"],
                    ["Metric app", "https://app.metric.xyz/"],
                    ["@metricxyz on X", "https://x.com/metricxyz"],
                    ["@metricxyz: referrals live", "https://x.com/metricxyz/status/2112922190349844551"]],
        "unverified": ["points formula / season schedule / drop time", "token / TGE / airdrop share"],
    },
    "qfex": {
        "kind": "not announced", "program": "Season 0 announced · schedule not announced", "unit": "Week",
        "boundary": lambda k: _utc_midnight(date(2026, 10, 12) + timedelta(days=7 * k)),
        "number": lambda k: None, "drop": lambda s, e: None, "dropExact": False,
        "rule": "Season 0 was announced (it \"will recognize early trading activity\") but no points schedule or rules are published",
        "window": "No official points week yet: tracking week Monday 00:00 → Monday 00:00 UTC (same as the autotrader's weekly limits)",
        "endsBy": None, "endsNote": None,
        "sources": [["QFEX CEO @annanay: Season 0", "https://x.com/annanay/status/2107780122258366667"],
                    ["@QFEX: loss refund rounds (Mon-Mon)", "https://x.com/QFEX/status/2109687768653918714"]],
        "unverified": ["everything about Season 0"],
    },
}


def window_index(pf, t):
    """k with boundary(k) <= t < boundary(k+1)."""
    b = SCHED[pf]["boundary"]
    k = int((t - b(0)) // (7 * DAY))
    while b(k) > t:
        k -= 1
    while b(k + 1) <= t:
        k += 1
    return k


def window(pf, k):
    s = SCHED[pf]
    st, en = s["boundary"](k), s["boundary"](k + 1)
    n = s["number"](k)
    return {"k": k, "n": n, "label": f"{s['unit']} {n}" if n is not None else f"Week of {datetime.fromtimestamp(st, UTC).strftime('%d %b')}",
            "start": st, "end": en, "drop": s["drop"](st, en)}


# ------------------------------------------------------------------ aggregation (pure)
def aggregate(fills, fundings, start_ms, end_ms):
    v = fees = closed = fund = maker = 0.0
    n, known = 0, False
    for f in fills or []:
        t = float(f.get("time") or 0)
        if not (start_ms <= t < end_ms):
            continue
        n += 1
        ntl = abs(float(f.get("px") or 0) * float(f.get("sz") or 0))
        v += ntl
        fees += float(f.get("fee") or 0)
        closed += float(f.get("closedPnl") or 0)
        if f.get("tradeSide") is not None or f.get("maker") is not None:
            known = True
        if f.get("tradeSide") == "Maker" or f.get("maker") is True:
            maker += ntl
    for x in fundings or []:
        t = float(x.get("time") or 0)
        if start_ms <= t < end_ms:
            fund += float(x.get("amount") if x.get("amount") not in (None, "") else x.get("usdc") or 0)
    return {"volume": round(v, 2), "fees": round(fees, 4), "funding": round(fund, 4), "pnl": round(closed - fees + fund, 4),
            "trades": n, "makerShare": round(maker / v, 4) if v and known else None}


VAL_FIELDS = ("id", "platform", "tgeStatus", "tgeDate", "token", "airdropPct", "airdropBadge", "airdropPctSource", "airdropUrl", "totalPoints", "totalPointsBadge",
              "totalPointsSource", "raiseValuation", "marketReference", "notes", "warning", "valuable", "cannotValue", "sources", "docNotes")
VAL_FDVS = (250e6, 500e6, 1e9, 2e9, 3e9)


def valuation_inputs(raw):
    """Research inputs for the Valuation block (private file -> encrypted doc). Only research fields are kept: the user's
    points are NOT taken from here (the app uses the current points total), and precomputed scenarios are dropped."""
    if not isinstance(raw, dict) or not isinstance(raw.get("platforms"), list):
        return None
    out = []
    for p in raw["platforms"]:
        if isinstance(p, dict) and p.get("id") in SCHED:
            out.append({k: p.get(k) for k in VAL_FIELDS if k in p})
    return {"v": 1, "asOf": raw.get("generatedAt"), "formula": raw.get("formula"), "disclaimer": raw.get("disclaimer"),
            "fdvs": list(raw.get("fdvs") or VAL_FDVS), "platforms": out}


def per_1k(points, volume):
    """Efficiency: points per $1K of volume (None unless both are known and volume > 0)."""
    if points is None or not volume or float(volume) <= 0:
        return None
    return round(float(points) / (float(volume) / 1000), 3)


def points_state(pf, w, row, now_ts):
    """entered | pending (drop still ahead) | missing (dropped, not entered yet) | rebates (Entropy: no points)."""
    if SCHED[pf]["kind"] == "rebates":
        return "rebates"
    if row.get("points") is not None:
        return "entered"
    due = w["drop"] if w["drop"] is not None else w["end"] + PENDING_GRACE.get(pf, 0)
    return "pending" if now_ts < due else "missing"


def points_totals(pf, weeks, man, bonus=()):
    """Totals from the ledger (all stored weeks + bonus entries): points, the volume of the weeks that have points,
    pts/$1K (weekly points only, bonuses excluded); rebates. A "pointsTotal" read off the dashboard overrides the sum."""
    with_pts = [r for r in weeks.values() if r.get("points") is not None]
    wk = round(sum(float(r["points"]) for r in with_pts), 6) if with_pts else None
    vol = round(sum(float(r.get("volume") or 0) for r in with_pts), 2) if with_pts else None
    bon = [float(b["points"]) for b in bonus if b.get("points") is not None]
    pts = None if wk is None and not bon else round((wk or 0) + sum(bon), 6)
    reb = [float(r["rebates"]) for r in weeks.values() if r.get("rebates") is not None]
    out = {"points": pts, "weeks": len(with_pts), "weeklyPoints": wk, "bonusPoints": round(sum(bon), 6) if bon else None, "volume": vol,
           "ptsPer1k": per_1k(wk, vol) if vol else None, "src": sorted({r.get("pointsSrc") or "manual" for r in with_pts} | ({"manual"} if bon else set())) or None,
           "rebates": round(sum(reb), 4) if reb else None, "totalSrc": "sum" if pts is not None else None}
    if man.get("pointsTotal") is not None:  # e.g. a season total read off the dashboard (overrides the sum)
        out["sum"], out["points"], out["src"], out["totalSrc"] = pts, float(man["pointsTotal"]), ["manual"], "dashboard"
    if man.get("rebatesTotal") is not None:
        out["rebates"] = float(man["rebatesTotal"])
    return out


def update(ledger, activity, manual, now_ts):
    """Pure (tested). Mutates the ledger; returns the published "points" document."""
    ledger.setdefault("v", 1); ledger.setdefault("weeks", {}); ledger.setdefault("cov", {})
    for x in ("bonus", "retro", "profile"):
        ledger.setdefault(x, {})
    out = []
    for pf in ORDER:
        s, act, man = SCHED[pf], activity.get(pf) or {}, (manual or {}).get(pf) or {}
        weeks = ledger["weeks"].setdefault(pf, {})
        kc = window_index(pf, now_ts)
        if act.get("fills") is not None and act.get("from") is not None:
            frm = int(act["from"])
            k = window_index(pf, frm)
            if window(pf, k)["start"] < frm:
                k += 1  # only windows fully covered by the fetched fills are (re)computed
            for kk in range(k, kc + 1):
                w = window(pf, kk)
                row = aggregate(act["fills"], act.get("fundings"), w["start"] * 1000, w["end"] * 1000)
                old = weeks.get(str(w["start"])) or {}
                weeks[str(w["start"])] = {**{x: old[x] for x in KEEP if x in old}, **row, "src": act.get("src", "api"), "updated": now_ts}
            ledger["cov"][pf] = min(int(ledger["cov"].get(pf) or frm), frm)
        elif isinstance(act.get("week"), dict):  # e.g. QFEX autotrader week totals (UTC Monday week = this tracking week)
            w = window(pf, kc)
            wk = act["week"]
            old = weeks.get(str(w["start"])) or {}
            weeks[str(w["start"])] = {**{x: old[x] for x in KEEP if x in old}, "volume": round(float(wk.get("volume") or 0), 2), "fees": round(float(wk.get("fees") or 0), 4),
                                      "funding": None, "pnl": round(float(wk.get("pnl") or 0), 4), "trades": int(wk.get("trades") or 0),
                                      "makerShare": None, "src": act.get("src", "autotrader"), "updated": now_ts}
        # points from an official source, if one exists (none today): {window_start: points}
        for key, val in (act.get("points") or {}).items():
            row = weeks.setdefault(str(window(pf, window_index(pf, int(key)))["start"]), {"src": act.get("src", "api"), "updated": now_ts})
            if val is not None and row.get("pointsSrc") != "manual":
                row["points"], row["pointsSrc"] = float(val), "auto"
        # manual entries by week number, window start (unix) or start date (YYYY-MM-DD, UTC)
        for key, vals in (man.get("weeks") or {}).items():
            kk = None
            for cand in range(kc - 60, kc + 1):
                w = window(pf, cand)
                if str(key) in (str(w["n"]), str(w["start"]), datetime.fromtimestamp(w["start"], UTC).strftime("%Y-%m-%d"), w["label"]):
                    kk = cand; break
            if kk is None:
                continue
            w = window(pf, kk)
            row = dict(weeks.get(str(w["start"])) or {})
            for f in ("volume", "pnl", "fees", "points", "rebates", "trades"):
                if vals.get(f) is not None:
                    row[f] = float(vals[f]); row.setdefault("manual", []); row["manual"] = sorted(set(row["manual"]) | {f})
                    if f in ("points", "rebates"):
                        row[f + "Src"] = "manual"
            row.setdefault("src", "manual"); row["updated"] = row.get("updated") or now_ts
            weeks[str(w["start"])] = row
        # bonus entries (competitions, retroactive or off-schedule distributions), keyed by label; kept in the ledger
        bon = ledger["bonus"].setdefault(pf, {})
        for b in man.get("bonus") or []:
            if b.get("label"):
                bon[str(b["label"])] = {"label": str(b["label"]), "points": None if b.get("points") is None else float(b["points"]),
                                        "date": b.get("date"), "note": b.get("note"), "src": "manual"}
        # retroactive allocation still to come (e.g. TxFlow pre-Season 1): {"label", "points" (null = pending)}
        if isinstance(man.get("retro"), dict):
            r0 = man["retro"]
            ledger["retro"][pf] = {"label": r0.get("label") or "Retroactive", "points": None if r0.get("points") is None else float(r0["points"]), "note": r0.get("note")}
        # dashboard snapshot (rank, tier, totals as shown by the platform), latest one kept
        if isinstance(man.get("profile"), dict):
            ledger["profile"][pf] = man["profile"]
        # trim
        for key in sorted(weeks, key=int)[:-60]:
            weeks.pop(key)
        cur = window(pf, kc)
        upcoming = [window(pf, kk) for kk in range(kc, kc + 6)]
        hist = []
        for key in sorted(weeks, key=int, reverse=True):
            st = int(key)
            if st > cur["start"]:
                continue
            w = window(pf, window_index(pf, st))
            r = weeks[key]
            if st != cur["start"] and not r.get("trades") and not r.get("volume") and r.get("points") is None and r.get("rebates") is None and r.get("pnl") in (None, 0, 0.0):
                continue  # empty past week (nothing traded): keep the table short
            hist.append({"n": w["n"], "label": w["label"], "start": w["start"], "end": w["end"], "drop": w["drop"], "current": st == cur["start"],
                         **{f: weeks[key].get(f) for f in ("volume", "fees", "funding", "pnl", "trades", "points", "pointsSrc", "rebates", "rebatesSrc", "makerShare", "src", "manual")},
                         "pointsState": points_state(pf, w, r, now_ts), "ptsPer1k": per_1k(r.get("points"), r.get("volume"))})
        hist = hist[:HISTORY_KEEP]
        bonus = sorted(bon.values(), key=lambda b: str(b.get("date") or ""), reverse=True)
        earned = points_totals(pf, weeks, man, bonus)
        has_data = act.get("fills") is not None or isinstance(act.get("week"), dict)
        conn = bool(man) or act.get("connected", has_data)
        status = act.get("status") or ("ok" if has_data else "manual" if man else "not connected")
        out.append({"id": pf, "name": NAMES[pf], "kind": s["kind"], "program": s["program"], "rule": s["rule"], "windowRule": s["window"],
                    "dropExact": s["dropExact"], "endsBy": s["endsBy"], "endsNote": s["endsNote"], "sources": [{"label": a, "url": b} for a, b in s["sources"]],
                    "unverified": s["unverified"], "connected": bool(conn), "status": status,
                    "dataNote": act.get("note") or man.get("note"), "window": {k: cur[k] for k in ("n", "label", "start", "end", "drop")},
                    "upcoming": [{k: w[k] for k in ("n", "label", "start", "end", "drop")} for w in upcoming],
                    "current": next((h for h in hist if h["current"]), None), "history": hist, "earned": earned, "pointsSource": POINTS_SRC[pf], "tracking": bool(s.get("tracking")),
                    "bonus": bonus, "retro": ledger["retro"].get(pf), "profile": ledger["profile"].get(pf),
                    **({"apiNextDrop": act["apiNextDrop"]} if act.get("apiNextDrop") else {})})
    cur = [p["current"] for p in out if p["current"]]
    tot = {f: round(sum(float(c.get(f) or 0) for c in cur), 4) for f in ("volume", "fees", "pnl")} if cur else None
    return {"v": 1, "generated": now_ts, "platforms": out, "total": tot}


# ------------------------------------------------------------------ TxFlow helpers (positions for the Balances tab)
def txflow_positions(state, open_orders=None):
    out = []
    oo = open_orders or []
    for ap in (state or {}).get("assetPositions") or []:
        p = ap.get("position") or {}
        sz = float(p.get("szi") or 0)
        if not sz:
            continue
        coin = str(p.get("coin") or "")
        sl = [float(t["slTriggerPrice"]) for t in ap.get("tpsl") or [] if t.get("slTriggerPrice") not in (None, "", "0")]
        tp = [float(t["tpTriggerPrice"]) for t in ap.get("tpsl") or [] if t.get("tpTriggerPrice") not in (None, "", "0")]
        for o in oo:
            if str(o.get("coin")) == coin or str(o.get("asset", o.get("instrumentId"))) == str(p.get("asset")):
                if o.get("isTrigger") and o.get("triggerPx") not in (None, ""):
                    (sl if "stop" in str(o.get("orderType", "")).lower() else tp if "take" in str(o.get("orderType", "")).lower() else []).append(float(o["triggerPx"]))
        num = lambda x: None if x in (None, "") else float(x)
        out.append({"market": coin.replace("-USDC", ""), "side": "long" if sz > 0 else "short", "size": abs(sz), "entry": num(p.get("entryPx")),
                    "mark": num(p.get("markPx")), "upnl": num(p.get("unrealizedPnl")), "sl": sorted(set(sl)), "tp": sorted(set(tp)),
                    "protected": bool(sl) and bool(tp), "leverage": (p.get("leverage") or {}).get("value")})
    return out


def txflow_flows(rows, addr):
    """Net USDC into the TxFlow perp account from userNonFundingLedgerUpdates rows (deposit / withdraw / tokenSend)."""
    a, net = (addr or "").lower(), 0.0
    for r in rows or []:
        d = r.get("delta") or {}
        t = d.get("type")
        amt = float(d.get("amount") or d.get("usdcValue") or 0)
        if t in ("deposit", "multiChainDeposit") and str(d.get("status", "completed")).lower() not in ("failed", "pending"):
            net += amt
        elif t in ("withdraw", "multiChainWithdraw") and str(d.get("status", "completed")).lower() not in ("failed",):
            net -= amt + float(d.get("fee") or 0)
        elif t == "tokenSend":
            v = float(d.get("usdcValue") or d.get("amount") or 0)
            if str(d.get("destination", "")).lower() == a and str(d.get("user", "")).lower() != a:
                net += v
            elif str(d.get("user", "")).lower() == a and str(d.get("destination", "")).lower() != a:
                net -= v
    return net


# ------------------------------------------------------------------ live readers (network; read-only public endpoints)
def _paged_tx(B, ep, body, cap=200000):
    out = []
    for off in range(0, cap + 1, 2000):
        d = B._tx(ep, {**body, "limit": 2000, "offset": off}) or {}
        rows = d.get("data", []) if isinstance(d, dict) else d
        out += rows or []
        if not (isinstance(d, dict) and d.get("hasMore")):
            break
    return out


def txflow_activity(B, ep, addr, since_s, now_s):
    body = {"user": addr, "accountType": ["perp"], "startTimeMs": since_s * 1000, "endTimeMs": now_s * 1000 + 60000}
    fills = _paged_tx(B, ep, {"type": "userFills", **body})
    fund = _paged_tx(B, ep, {"type": "userFundings", **body})
    keep = lambda f: {"time": int(f.get("time") or 0), "px": f.get("px"), "sz": f.get("sz"), "fee": f.get("fee"), "closedPnl": f.get("closedPnl"), "tradeSide": f.get("tradeSide")}
    return {"fills": [keep(f) for f in fills], "fundings": [{"time": int(x.get("time") or 0), "amount": x.get("amount") or x.get("usdc")} for x in fund],
            "from": since_s, "src": "TxFlow public API"}


def hl_activity(B, url, addr, dexes, since_s, now_s):
    fills, start = [], since_s * 1000
    for _ in range(50):
        rows = B._post(url, {"type": "userFillsByTime", "user": addr, "startTime": start, "endTime": now_s * 1000 + 60000, "aggregateByTime": False}) or []
        fills += rows
        if len(rows) < 2000:
            break
        start = max(int(r["time"]) for r in rows) + 1
    want = lambda coin: any((d == "" and ":" not in coin) or (d and coin.startswith(d + ":")) for d in dexes)
    fills = [f for f in fills if want(str(f.get("coin", "")))]
    keep = lambda f: {"time": int(f.get("time") or 0), "px": f.get("px"), "sz": f.get("sz"), "fee": f.get("fee"), "closedPnl": f.get("closedPnl"), "maker": (not f["crossed"]) if isinstance(f.get("crossed"), bool) else None}
    return {"fills": [keep(f) for f in fills], "fundings": [], "from": since_s, "src": "Hyperliquid public API (funding not included)"}


def arcus_activity(B, base, addr, account_index, since_s, now_s):
    """Arcus GET /v1/fills (public by address + accountIndex), paged forward by createdAt."""
    # from/to/createdAt are epoch MICROseconds (mainnet rejects ms with 400); newest first -> page backwards with `to`
    fills, frm, to = [], int(since_s) * 1_000_000, None
    for _ in range(100):
        q = {"address": addr, "accountIndex": account_index, "from": frm, "limit": 1000, **({"to": to} if to is not None else {})}
        rows = (B._get(base + "/v1/fills", q) or {}).get("fills") or []
        fills += rows
        if len(rows) < 1000:
            break
        oldest = min(int(float(x.get("createdAt") or 0)) for x in rows)
        if to is not None and oldest - 1 >= to:
            break
        to = oldest - 1
    def ms(t):
        t = float(t or 0)
        return int(t / 1000 if t > 1e14 else t if t > 1e11 else t * 1000)
    maker = lambda f: (f.get("liquidity") or f.get("role") or "").lower() == "maker" if (f.get("liquidity") or f.get("role")) else (f.get("isMaker") if f.get("isMaker") is not None else None)
    keep = lambda f: {"time": ms(f.get("createdAt")), "px": f.get("price"), "sz": f.get("size"), "fee": f.get("fee"), "closedPnl": f.get("closedPnl"), "maker": maker(f)}
    seen, out = set(), []
    for f in fills:
        k = f.get("id") or f.get("tradeId") or f.get("fillId") or (f.get("createdAt"), f.get("price"), f.get("size"), f.get("side"))
        if k in seen:
            continue
        seen.add(k); out.append(keep(f))
    return {"fills": out, "fundings": [], "from": since_s, "src": "Arcus public API (funding not included)"}


def variational_next_drop(timeout=15):
    req = urllib.request.Request(VARIATIONAL_NEXT_DROP, headers={"User-Agent": "Mozilla/5.0 (bobby-points)"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        s = json.load(r).get("next_drop_ts")
    return int(datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()) if s else None


def since_for(pf, ledger, now_ts, backfill):
    """Fetch from the earliest unfinished window: previous window start if already covered, else the backfill start."""
    k = window_index(pf, now_ts)
    prev = window(pf, k - 1)["start"]
    cov = (ledger.get("cov") or {}).get(pf)
    return prev if cov and cov <= prev else min(prev, backfill)


def qfex_since(now_ts):
    return window("qfex", window_index("qfex", now_ts) - 1)["start"]


def collect_live(B, testnet, ledger, readings, now_ts, scrub_secrets):
    """{pf: activity}. Each reader fails soft (status "error" with a scrubbed message)."""
    ep = B.ENDPOINTS[testnet]
    tx_addr = os.environ.get("BOBBY_TXFLOW_ADDRESS", "") or os.environ.get("BOBBY_ACCOUNT_ADDRESS", "")
    hl_addr = os.environ.get("BOBBY_HL_ADDRESS", "") or os.environ.get("BOBBY_ACCOUNT_ADDRESS", "")
    dexes = ["" if d.strip() == "main" else d.strip() for d in (os.environ.get("BOBBY_HL_DEXES") or "io").split(",") if d.strip()]
    arcus_addr = os.environ.get("BOBBY_ACCOUNT_ADDRESS", "")
    arcus_idx = int(os.environ.get("ARCUS_ACCOUNT_INDEX", "0") or 0)
    act = {}

    def guard(pf, fn):
        try:
            act[pf] = fn()
        except Exception as e:  # noqa: BLE001
            act[pf] = {"connected": True, "status": "error", "note": B.scrub(f"{type(e).__name__}: {e}", scrub_secrets)[:160]}

    if arcus_addr:
        guard("arcus", lambda: arcus_activity(B, ep["arcus"], arcus_addr, arcus_idx, since_for("arcus", ledger, now_ts, window("arcus", -1)["start"]), now_ts))
    else:
        act["arcus"] = {"connected": False, "note": "not connected: set BOBBY_ACCOUNT_ADDRESS (+ ARCUS_ACCOUNT_INDEX, default 0) in ~/.bobby-autotrader.env"}
    if not hl_addr:
        act["entropy"] = {"connected": False, "note": "not connected: set BOBBY_HL_ADDRESS (Hyperliquid address; dex from BOBBY_HL_DEXES, default io)"}
    if tx_addr:
        guard("txflow", lambda: txflow_activity(B, ep["txflow"], tx_addr, since_for("txflow", ledger, now_ts, window("txflow", 0)["start"]), now_ts))
    if hl_addr:
        guard("entropy", lambda: hl_activity(B, ep["hl"], hl_addr, dexes, since_for("entropy", ledger, now_ts, window("entropy", 0)["start"]), now_ts))
    q = readings.get("qfex") or {}
    if q.get("fills") is not None and q.get("fillsFrom") is not None:
        act["qfex"] = {"fills": q["fills"], "fundings": [], "from": int(q["fillsFrom"]), "src": "QFEX fills (autotrader)"}
    elif isinstance(q.get("volume"), dict) and isinstance(q["volume"].get("week"), dict):
        act["qfex"] = {"week": q["volume"]["week"], "src": "QFEX autotrader week totals"}
    rx_addr = os.environ.get("BOBBY_RISEX_ADDRESS", "") or os.environ.get("BOBBY_ACCOUNT_ADDRESS", "")
    if rx_addr:
        import risex as RX
        def rx():
            a = RX.activity(B, testnet, rx_addr, since_for("risex", ledger, now_ts, window("risex", -6)["start"]), now_ts)
            a["note"] = "Tracking only · not farmed: volume / fees / PnL from the public RiseX trade history (your own trading); points entered by hand"
            try:
                nd, _ = RX.next_drop(B, testnet)
                if nd:
                    a["apiNextDrop"] = nd
            except Exception:  # noqa: BLE001 - the schedule fallback still gives the Tuesday 14:00 UTC drop
                pass
            return a
        guard("risex", rx)
    xa = (readings.get("tradexyz") or {}).get("activity")
    if xa:  # trade.xyz fills were already read (and cached) by balances.py
        act["tradexyz"] = {**xa, "note": "Tracking only · not farmed: volume / fees / PnL from the public Hyperliquid fills on the xyz dex (main wallet + subaccounts, Bobby excluded); no points program"}
    if os.environ.get("BOBBY_VARIATIONAL_ADDRESS"):
        try:
            act["variational"] = {"connected": False, "apiNextDrop": variational_next_drop(),
                                  "note": "No public per-address API (portfolio/points need a wallet-signed session); enter numbers in points_manual.json"}
        except Exception as e:  # noqa: BLE001
            act["variational"] = {"connected": False, "note": "next-drop check failed: " + type(e).__name__}
    return act


def mock_activity(readings):
    """Offline: readings[pf]["activity"] = {"fills": [...], "fundings": [...], "from": unix} or {"week": {...}}."""
    act = {pf: (readings.get(pf) or {}).get("activity") for pf in ORDER if (readings.get(pf) or {}).get("activity")}
    q = readings.get("qfex") or {}
    if "qfex" not in act and isinstance(q.get("volume"), dict) and isinstance(q["volume"].get("week"), dict):
        act["qfex"] = {"week": q["volume"]["week"], "src": "QFEX autotrader week totals"}
    return act


def manual_balance(manual, pf):
    m = (manual or {}).get(pf) or {}
    if m.get("equity") is None:
        return {"status": "not connected yet (no public API: add it to points_manual.json)"}
    return {"equity": float(m["equity"]), "manual": True}


def load_json(path):
    try:
        return json.loads(open(path).read())
    except (OSError, ValueError):
        return {}


def save_ledger(path, ledger):
    with open(path, "w") as fh:
        fh.write(json.dumps(ledger, indent=0))
    os.chmod(path, 0o600)
