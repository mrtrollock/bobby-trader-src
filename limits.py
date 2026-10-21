#!/usr/bin/env python3
"""Bobby Trader: weekly + daily loss caps per platform for the Balances tab (inside the ENCRYPTED balances.enc.json).

Configured caps come from the autotrader itself (`node autotrader/cli.js limits`, key-less), usage from the autotrader's
own accounting (`cli.js status --pf <pf>`: realized loss incl. fees since Monday 00:00 UTC / 00:00 UTC; Arcus counts only
Bobby's own fills). Status subprocesses never get a private key (only public addresses + the QFEX read key for QFEX,
which balances.py already reads). TxFlow / Variational are traded by hand: their $50/week is a reference, measured against
this week's real PnL (TxFlow public fills; Variational from points_manual.json "weekPnl"/"dayPnl").
"""
import json, os, subprocess
from pathlib import Path

HERE = Path(__file__).parent
ORDER = ("arcus", "entropy", "txflow", "qfex", "variational")
NAMES = {"arcus": "🏹 Arcus", "entropy": "🤖 Entropy", "txflow": "🌊 TxFlow", "qfex": "📈 QFEX", "variational": "🌀 Variational"}
DAY, WEEK = 86400, 7 * 86400
KEYS = ("ARCUS_API_PRIVATE_KEY", "ARCUS_API_KEY", "HL_AGENT_PRIVATE_KEY", "QFEX_API_PUBLIC_KEY", "QFEX_API_SECRET_KEY")


def week_start(t):  # Monday 00:00 UTC
    d = int(t // DAY) * DAY
    return d - ((int(t // DAY) + 3) % 7) * DAY  # 1970-01-01 was a Thursday


def day_start(t):
    return int(t // DAY) * DAY


def _node(args, env, timeout=90):
    r = subprocess.run(["node", str(HERE / "autotrader" / "cli.js"), *args], capture_output=True, text=True, env=env, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError("autotrader " + args[0] + " failed")
    return json.loads(r.stdout)


def keyless_env(extra=None):
    env = {k: v for k, v in os.environ.items() if k not in KEYS}
    env.setdefault("AUTOTRADER_NETWORK", "mainnet")
    return {**env, **(extra or {})}


def read_caps():
    return _node(["limits"], keyless_env({"AUTOTRADER_NETWORK": os.environ.get("AUTOTRADER_NETWORK") or "mainnet"}), timeout=30)


def read_switches():
    """On/off switches need to know whether keys exist: computed here as booleans, never values."""
    e = os.environ
    return {"enabled": e.get("AUTOTRADER_ENABLED") == "1", "live": e.get("AUTOTRADER_LIVE") == "1",
            "arcus": e.get("AUTOTRADER_ARCUS") == "1" and bool(e.get("ARCUS_API_PRIVATE_KEY")), "entropy": bool(e.get("HL_AGENT_PRIVATE_KEY")),
            "qfex": bool(e.get("QFEX_API_PUBLIC_KEY") and e.get("QFEX_API_SECRET_KEY")), "qfexVolume": e.get("QFEX_VOLUME_MODE") == "1"}


def read_status(pf, scrub):
    """Usage from the autotrader's own accounting (read-only, key-less) for Arcus / Entropy; None when not configured."""
    e = os.environ
    if pf == "arcus":
        if not e.get("ARCUS_ACCOUNT_ADDRESS"):
            return {"note": "address not set (ARCUS_ACCOUNT_ADDRESS)"}
        extra = {}
    else:
        addr = e.get("HL_ACCOUNT_ADDRESS") or e.get("BOBBY_HL_ADDRESS")
        if not addr:
            return {"note": "address not set (BOBBY_HL_ADDRESS)"}
        extra = {"HL_ACCOUNT_ADDRESS": addr}
    try:
        st = (_node(["status", "--pf", pf], keyless_env(extra)).get("platforms") or {}).get(pf) or {}
    except Exception as ex:  # noqa: BLE001
        return {"error": scrub(f"{type(ex).__name__}: {ex}")[:160]}
    if st.get("error"):
        return {"error": scrub(str(st["error"]))[:160]}
    return {"limits": st.get("limits"), "equity": st.get("equity")}


def manual_usage(pf, activity, manual, now):
    """TxFlow: realized PnL - fees + funding from public fills since Monday / today 00:00 UTC; Variational: manual."""
    if pf == "txflow":
        a = activity.get("txflow") or {}
        if a.get("fills") is None or a.get("from") is None or a["from"] > week_start(now):
            return None
        def pnl(frm):
            v = 0.0
            for f in a["fills"]:
                if float(f.get("time") or 0) >= frm * 1000:
                    v += float(f.get("closedPnl") or 0) - float(f.get("fee") or 0)
            for x in a.get("fundings") or []:
                if float(x.get("time") or 0) >= frm * 1000:
                    v += float(x.get("amount") or 0)
            return v
        return {"weekPnl": pnl(week_start(now)), "dayPnl": pnl(day_start(now)), "src": "TxFlow public fills (fees + funding incl.)"}
    m = (manual or {}).get(pf) or {}
    if m.get("weekPnl") is None:
        return None
    return {"weekPnl": float(m["weekPnl"]), "dayPnl": float(m["dayPnl"]) if m.get("dayPnl") is not None else None, "src": "manual entry (points_manual.json)"}


def build(caps_doc, statuses, activity, manual, now, switches=None):
    """Pure (tested). statuses: {pf: {"limits": limitsState()} | {"note"} | {"error"}}. Times in unix seconds."""
    caps, sw = (caps_doc or {}).get("caps") or {}, switches or (caps_doc or {}).get("switches") or {}
    r2 = lambda x: None if x is None else round(float(x), 2)
    rows = []
    for pf in ORDER:
        c = caps.get(pf) or {}
        row = {"id": pf, "name": NAMES[pf], "mode": c.get("mode", "manual"), "weeklyCap": c.get("weekly"), "dailyCap": c.get("daily"), "dailyRule": c.get("dailyRule"),
               "maxTradeRule": None, "maxTradeLoss": None, "weeklyUsed": None, "dailyUsed": None, "weeklyRemaining": None, "dailyRemaining": None,
               "status": "no data", "haltedUntil": None, "haltScope": None, "note": None}
        if pf == "qfex":
            row["maxTradeRule"] = f"${c.get('maxTradeUsd')} max, ≤ {round((c.get('maxLossEquityPct') or 0) * 100)}% of equity"
        elif c:
            row["maxTradeRule"] = f"{round((c.get('maxTradePct') or 0) * 100)}% of equity" + (f" (capital capped at ${c.get('capital')})" if row["mode"] == "auto" else " (reference)")
        if row["mode"] == "auto":
            row["trading"] = bool(sw.get(pf)) and bool(sw.get("enabled"))
            s = statuses.get(pf) or {}
            L = s.get("limits")
            if L:
                row.update(weeklyCap=L.get("weeklyCap"), weeklyUsed=r2(L.get("weeklyUsed")), weeklyRemaining=r2(L.get("weeklyRemaining")), dailyCap=L.get("dailyCap"),
                           dailyUsed=r2(L.get("dailyUsed")), dailyRemaining=r2(L.get("dailyRemaining")), maxTradeLoss=r2(L.get("maxTradeLoss")),
                           maxTradeRule=L.get("maxTradeRule") or row["maxTradeRule"], dailyRule=L.get("dailyRule") or row["dailyRule"])
                h = L.get("halted")
                if h and float(h.get("until") or 0) / 1000 > now:
                    row.update(status="halted", haltedUntil=int(float(h["until"]) / 1000), haltScope=h.get("scope"), note=h.get("reason"))
                else:
                    row["status"] = "ok"
                if s.get("equity") is not None and float(s["equity"] or 0) <= 0:
                    row["note"] = (row["note"] + " · " if row["note"] else "") + "unfunded (equity $0): no trade fits the per-trade cap"
                if not row["trading"]:
                    row["note"] = (row["note"] + " · " if row["note"] else "") + "Bobby is not trading here right now (switch off or no key)"
            else:
                row["status"] = "not connected" if s.get("note") else "error" if s.get("error") else "no data"
                row["note"] = s.get("note") or s.get("error")
        else:
            u = manual_usage(pf, activity, manual, now)
            row["status"] = "manual"
            if u:
                wl, dl = max(0.0, -u["weekPnl"]), (max(0.0, -u["dayPnl"]) if u.get("dayPnl") is not None else None)
                row.update(weeklyUsed=r2(wl), weeklyRemaining=r2(max(0.0, (row["weeklyCap"] or 0) - wl)), dailyUsed=r2(dl), weekPnl=r2(u["weekPnl"]),
                           dayPnl=r2(u.get("dayPnl")), note=u["src"])
                if row["weeklyCap"] and wl >= row["weeklyCap"]:
                    row["status"], row["note"] = "over cap", "weekly reference cap used up: stop trading by hand until Monday 00:00 UTC"
            else:
                row["note"] = "no data (enter weekPnl / dayPnl in points_manual.json)" if pf == "variational" else "no data"
        if row["weeklyCap"] and row["weeklyUsed"] is not None:
            row["weeklyPct"] = round(min(1.0, row["weeklyUsed"] / row["weeklyCap"]), 4)
        if row["dailyCap"] and row["dailyUsed"] is not None:
            row["dailyPct"] = round(min(1.0, row["dailyUsed"] / row["dailyCap"]), 4)
        rows.append(row)
    return {"v": 1, "generated": now, "weekFrom": week_start(now), "weekResets": week_start(now) + WEEK, "dayFrom": day_start(now), "dayResets": day_start(now) + DAY,
            "rules": "Loss = realized PnL incl. fees (Arcus: Bobby's own trades only). Weekly caps reset Monday 00:00 UTC, daily caps at 00:00 UTC.",
            "platforms": rows}


def collect_live(readings, scrub):
    statuses = {"qfex": {"limits": (readings.get("qfex") or {}).get("limits")} if (readings.get("qfex") or {}).get("limits") else
                {"error": (readings.get("qfex") or {}).get("error") or (readings.get("qfex") or {}).get("status")}}
    for pf in ("arcus", "entropy"):
        statuses[pf] = read_status(pf, scrub)
    try:
        caps = read_caps()
    except Exception:  # noqa: BLE001
        caps = {}
    caps["switches"] = read_switches()
    return caps, statuses


def collect_mock(readings):
    """Offline: caps from the key-less `cli.js limits` (env defaults), usage from readings[pf]["limits"]."""
    caps = _node(["limits"], {k: v for k, v in keyless_env().items() if not k.startswith(("ARCUS_", "HL_", "QFEX_", "AUTOTRADER_"))} | {"AUTOTRADER_NETWORK": "mainnet"}, timeout=30)
    caps["switches"] = readings.get("switches") or {}
    statuses = {pf: ({"limits": (readings.get(pf) or {}).get("limits")} if (readings.get(pf) or {}).get("limits") else {"note": "no data"}) for pf in ("arcus", "entropy", "qfex")}
    return caps, statuses
