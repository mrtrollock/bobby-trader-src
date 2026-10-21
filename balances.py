#!/usr/bin/env python3
"""Bobby Trader: balances / PnL ledger -> public/balances.enc.json (ENCRYPTED with BOBBY_VIEW_PASSPHRASE).

    python3 balances.py                 # read current equity per platform, update the ledger, publish (encrypted)
    python3 balances.py --testnet       # same against the testnets
    python3 balances.py --mock FILE     # offline readings (tests): {"arcus": {"equity": 300}, "qfex": {"equity": 100, "deposit": 100}, ...}
    options: --out PATH (*.enc.json), --ledger PATH (default balances_ledger.json), --starts PATH (default balances_start.json), --now UNIX

Readers (read-only): Arcus GET /v1/account (BOBBY_ACCOUNT_ADDRESS + ARCUS_ACCOUNT_INDEX), Entropy Hyperliquid
clearinghouseState on BOBBY_HL_DEXES (BOBBY_HL_ADDRESS) + userNonFundingLedgerUpdates for deposits/withdrawals/transfers
(best effort), TxFlow clearinghouseState (BOBBY_TXFLOW_ADDRESS), QFEX through `node autotrader/cli.js status --pf qfex`
(QFEX key in the env; `deposit` tracks net transfers in/out of the account). A platform without data shows
"not connected yet".
Variational (no public per-address API) comes from points_manual.json; points weeks (volume / fees / PnL per points week,
countdown schedule) are built by points.py and published inside the same encrypted file under "points".

Ledger (git-ignored, chmod 600): the first reading of a platform becomes its starting balance; every run appends a
snapshot. PnL = current - start - net deposits since start. Manual overrides (git-ignored) in balances_start.json:
{"arcus": {"start": 300, "netDeposits": 0}, ...}  (start replaces the recorded one; netDeposits is ADDED to the
auto-tracked flows, e.g. for Arcus/TxFlow deposits, which these public APIs do not expose).
"""
import argparse, json, os, sys, time
from pathlib import Path

import briefing as B
import points as PT
import vaultpy

HERE = Path(__file__).parent
NAMES = {"arcus": "🏹 Arcus", "entropy": "🤖 Entropy", "txflow": "🌊 TxFlow", "qfex": "📈 QFEX", "variational": "🌀 Variational"}
ORDER = ("arcus", "entropy", "txflow", "qfex", "variational")  # variational: manual (points_manual.json), no public per-address API
f = lambda x: None if x in (None, "") else float(x)


def hl_flows(updates, addr, dexes):
    """Net USDC flowing INTO the measured Hyperliquid dexes (best effort over the ledger delta types)."""
    addr, main, net = addr.lower(), "" in dexes, 0.0
    for u in updates or []:
        d = u.get("delta") or {}
        t, usdc = d.get("type"), f(d.get("usdc")) or 0.0
        if t == "deposit" and main:
            net += usdc
        elif t == "withdraw" and main:
            net -= usdc + (f(d.get("fee")) or 0.0)
        elif t == "accountClassTransfer" and main:
            net += usdc if d.get("toPerp") else -usdc
        elif t in ("internalTransfer", "subAccountTransfer") and main:
            net += usdc if str(d.get("destination", "")).lower() == addr else -usdc
        elif t == "send":
            v = f(d.get("usdcValue")) or f(d.get("amount")) or 0.0
            if d.get("destinationDex", "") in dexes and str(d.get("destination", "")).lower() == addr:
                net += v
            if d.get("sourceDex", "") in dexes and str(d.get("user", "")).lower() == addr:
                net -= v
    return net


def read_live(testnet, start):
    """{pf: {"equity", "deposit"?, "flowsSince"?} | {"status": "..."}}; start = ledger starts (for flow windows)."""
    ep = B.ENDPOINTS[testnet]
    addr = os.environ.get("BOBBY_ACCOUNT_ADDRESS", "")
    hl_addr = os.environ.get("BOBBY_HL_ADDRESS", "") or addr
    tx_addr = os.environ.get("BOBBY_TXFLOW_ADDRESS", "") or addr
    dexes = ["" if d.strip() == "main" else d.strip() for d in (os.environ.get("BOBBY_HL_DEXES") or "io").split(",") if d.strip()]
    qkey = bool(os.environ.get("QFEX_API_PUBLIC_KEY") and os.environ.get("QFEX_API_SECRET_KEY"))
    secrets = [addr, hl_addr, tx_addr] + [os.environ.get(k, "") for k in ("QFEX_ACCOUNT_ID", "QFEX_API_PUBLIC_KEY", "QFEX_API_SECRET_KEY")]

    def arcus():
        a = B._get(ep["arcus"] + "/v1/account", {"address": addr, "accountIndex": int(os.environ.get("ARCUS_ACCOUNT_INDEX", "0") or 0)})
        return {"equity": f(a.get("equity"))}

    def entropy():
        eq = 0.0
        for dex in dexes:
            st = B._post(ep["hl"], {"type": "clearinghouseState", "user": hl_addr, **({"dex": dex} if dex else {})})
            eq += float(((st or {}).get("marginSummary") or {}).get("accountValue") or 0)
        out = {"equity": eq}
        s0 = (start.get("entropy") or {}).get("t")
        if s0:
            ups = B._post(ep["hl"], {"type": "userNonFundingLedgerUpdates", "user": hl_addr, "startTime": int(s0 * 1000)})
            out["flowsSince"] = hl_flows(ups, hl_addr, dexes)
        return out

    def txflow():
        st = B._tx(ep["txflow"], {"type": "clearinghouseState", "user": tx_addr, "accountType": "perp"}) or {}
        out = {"equity": f((st.get("marginSummary") or {}).get("accountValue"))}
        try:  # positions (+ SL/TP) and deposits/withdrawals since the start, all public by address
            oo = B._tx(ep["txflow"], {"type": "frontendOpenOrders", "user": tx_addr, "limit": 200, "offset": 0}) or []
            out["positions"] = PT.txflow_positions(st, oo.get("data", oo) if isinstance(oo, dict) else oo)
            s0 = (start.get("txflow") or {}).get("t")
            if s0:
                ups = PT._paged_tx(B, ep["txflow"], {"type": "userNonFundingLedgerUpdates", "user": tx_addr, "startTimeMs": int(s0 * 1000)})
                out["flowsSince"], out["flowsSrc"] = PT.txflow_flows(ups, tx_addr), "TxFlow ledger (public API)"
        except Exception:  # noqa: BLE001 - equity alone is still useful
            pass
        return out

    def qfex():
        since = PT.qfex_since(int(time.time()))
        q = B.fetch_qfex(testnet, since * 1000)
        return {"equity": f(q.get("equity")), "deposit": f(q.get("deposit")), "positions": positions_of(q), "volume": q.get("volume"),
                "fills": q.get("fills"), "fillsFrom": since}

    out = {}
    for pf, ok, fn in (("arcus", addr, arcus), ("entropy", hl_addr, entropy), ("txflow", tx_addr, txflow), ("qfex", qkey, qfex)):
        if not ok:
            out[pf] = {"status": "not connected yet"}
            continue
        try:
            out[pf] = fn()
        except Exception as e:  # noqa: BLE001
            out[pf] = {"status": "error", "error": B.scrub(f"{type(e).__name__}: {e}", secrets)[:160]}
    return out, secrets


def update(ledger, readings, starts, now_ts):
    """Pure ledger math (tested). Mutates ledger, returns the published document."""
    ledger.setdefault("v", 1); ledger.setdefault("start", {}); ledger.setdefault("snapshots", [])
    rows, snap = [], {"t": now_ts, "p": {}}
    for pf in ORDER:
        r = readings.get(pf) or {"status": "not connected yet"}
        row = {"id": pf, "name": NAMES[pf]}
        if r.get("equity") is None:
            row.update(status=r.get("status") or "no data", error=r.get("error"))
            rows.append(row); continue
        eq = float(r["equity"])
        st = ledger["start"].get(pf)
        if st is None:
            st = ledger["start"][pf] = {"t": now_ts, "equity": eq, **({"deposit": r["deposit"]} if r.get("deposit") is not None else {})}
        ov = starts.get(pf) or {}
        start = float(ov["start"]) if ov.get("start") is not None else float(st["equity"])
        if r.get("deposit") is not None and st.get("deposit") is not None:
            auto, src = float(r["deposit"]) - float(st["deposit"]), "QFEX deposit field"
        elif r.get("flowsSince") is not None:
            auto, src = float(r["flowsSince"]), r.get("flowsSrc") or "Hyperliquid ledger (best effort)"
        elif r.get("manual"):
            auto, src = 0.0, "manual entry (points_manual.json; deposits in balances_start.json)"
        else:
            auto, src = 0.0, "not exposed by the API (use balances_start.json)"
        nd = auto + float(ov.get("netDeposits") or 0)
        pnl = eq - start - nd
        base = start + nd
        row.update(status="ok", start=round(start, 2), startT=st["t"], current=round(eq, 2), netDeposits=round(nd, 2), ndSource=src,
                   pnl=round(pnl, 2), pnlPct=round(pnl / base, 6) if base > 0 else None, startOverride=ov.get("start") is not None)
        snap["p"][pf] = {"eq": round(eq, 2), "pnl": round(pnl, 2)}
        rows.append(row)
    ok = [r for r in rows if r["status"] == "ok"]
    tot = None
    if ok:
        s, c, n = sum(r["start"] for r in ok), sum(r["current"] for r in ok), sum(r["netDeposits"] for r in ok)
        p = c - s - n
        tot = {"start": round(s, 2), "current": round(c, 2), "netDeposits": round(n, 2), "pnl": round(p, 2), "pnlPct": round(p / (s + n), 6) if s + n > 0 else None}
        snap["total"] = {"eq": tot["current"], "pnl": tot["pnl"]}
        ledger["snapshots"] = (ledger["snapshots"] + [snap])[-2000:]
    return {"v": 1, "generated": now_ts, "tz": "Europe/Berlin", "platforms": rows, "total": tot, "history": ledger["snapshots"][-200:]}


def positions_of(q):
    """Open QFEX positions from the autotrader status (market, side, size, entry, mark, uPnL, SL/TP triggers, protected)."""
    out = []
    for p in q.get("positions") or []:
        num = lambda x: None if x is None else float(x)
        sl, tp = [float(x) for x in p.get("sl") or [] if x is not None], [float(x) for x in p.get("tp") or [] if x is not None]
        out.append({"market": str(p.get("market")), "side": p.get("side"), "size": num(p.get("size")), "entry": num(p.get("entry")), "mark": num(p.get("mark")),
                    "upnl": num(p.get("upnl")), "sl": sl, "tp": tp, "protected": bool(p.get("protected", bool(sl) and bool(tp)))})
    return out


def read_alerts(path, keep=5):
    """autotrader/ALERT (written by the protection guard): count + latest entries, shown at the top of the Balances tab."""
    rows = []
    if path.exists():
        for line in path.read_text().splitlines():
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue
    keys = ("t", "pf", "market", "kind", "missing", "ok", "reason", "would", "held")
    return {"count": len(rows), "latest": [{k: r.get(k) for k in keys if r.get(k) is not None} for r in rows[-keep:]]}


def volume_line(v):
    """QFEX traded volume / fees / PnL (from the autotrader status, UTC periods) for the Balances tab; None when unknown."""
    if not isinstance(v, dict) or not isinstance(v.get("month"), dict):
        return None
    keep = lambda p: {k: round(float((v.get(p) or {}).get(k) or 0), 2) for k in ("volume", "fees", "pnl", "trades")}
    goal = float(v.get("goal") or 300000)
    month = keep("month")
    return {"pf": "qfex", "day": keep("day"), "week": keep("week"), "month": month, "goal": goal, "monthPct": round(100 * month["volume"] / goal, 2) if goal else None}


def main(argv=None):
    B.load_env()
    ap = argparse.ArgumentParser(description="Bobby balances / PnL -> public/balances.enc.json (encrypted)")
    ap.add_argument("--out", default=str(HERE / "public" / "balances.enc.json"))
    ap.add_argument("--ledger", default=str(HERE / "balances_ledger.json"))
    ap.add_argument("--starts", default=str(HERE / "balances_start.json"))
    ap.add_argument("--alerts", default=str(HERE / "autotrader" / "ALERT"), help="autotrader protection-guard alerts (JSON lines)")
    ap.add_argument("--points-ledger", help="points weeks ledger (default: points_ledger.json next to --ledger)")
    ap.add_argument("--points-manual", help="manual points/volume/balances (default: points_manual.json next to --ledger)")
    ap.add_argument("--mock"); ap.add_argument("--testnet", action="store_true"); ap.add_argument("--now", type=float)
    a = ap.parse_args(argv)
    vaultpy.passphrase()  # refuse before reading anything: the output is published
    now_ts = int(a.now or time.time())
    lp, sp = Path(a.ledger), Path(a.starts)
    ledger = json.loads(lp.read_text()) if lp.exists() else {}
    starts = json.loads(sp.read_text()) if sp.exists() else {}
    if a.mock:
        readings, secrets = json.loads(Path(a.mock).read_text()), []
    else:
        readings, secrets = read_live(a.testnet, ledger.get("start", {}))
    # points weeks (points.py): Variational balance is manual; volume/PnL per points week go into the encrypted doc
    pl_path = Path(a.points_ledger) if a.points_ledger else lp.with_name("points_ledger.json")
    manual = PT.load_json(a.points_manual or lp.with_name("points_manual.json"))
    readings.setdefault("variational", PT.manual_balance(manual, "variational"))
    pledger = PT.load_json(pl_path)
    activity = PT.mock_activity(readings) if a.mock else PT.collect_live(B, a.testnet, pledger, readings, now_ts, secrets)
    doc = update(ledger, readings, starts, now_ts)
    doc["points"] = PT.update(pledger, activity, manual, now_ts)
    doc["network"] = "mock" if a.mock else ("testnet" if a.testnet else "mainnet")
    doc["alerts"] = read_alerts(Path(a.alerts))
    doc["positions"] = [{"pf": pf, **p} for pf in ORDER for p in ((readings.get(pf) or {}).get("positions") or [])]
    doc["volume"] = volume_line((readings.get("qfex") or {}).get("volume"))
    text = json.dumps(doc)
    if any(s and s.lower() in text.lower() for s in secrets):
        raise SystemExit("refusing to write: an address or key would be included")
    lp.write_text(json.dumps(ledger, indent=0)); os.chmod(lp, 0o600)
    PT.save_ledger(pl_path, pledger)
    out = vaultpy.write_sealed(a.out, doc)
    dist = HERE / "dist"
    if dist.is_dir() and out.resolve() == (HERE / "public" / "balances.enc.json").resolve():
        (dist / out.name).write_text(out.read_text())
    print("balances: " + ", ".join(f"{r['id']} {r['status']}" for r in doc["platforms"]) + f" -> {out} (encrypted)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
