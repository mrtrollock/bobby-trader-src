#!/usr/bin/env python3
"""Bobby Trader: balances / PnL ledger -> public/balances.enc.json (ENCRYPTED with BOBBY_VIEW_PASSPHRASE).

    python3 balances.py                 # read current equity per platform, update the ledger, publish (encrypted)
    python3 balances.py --testnet       # same against the testnets
    python3 balances.py --mock FILE     # offline readings (tests): {"arcus": {"equity": 300}, "qfex": {"equity": 100, "deposit": 100}, ...}
    options: --out PATH (*.enc.json), --ledger PATH (default balances_ledger.json), --starts PATH (default balances_start.json), --now UNIX

Readers (read-only): Arcus GET /v1/account (BOBBY_ACCOUNT_ADDRESS + ARCUS_ACCOUNT_INDEX), Entropy Hyperliquid
subaccount (BOBBY_HL_ADDRESS): userAbstraction + main dex + io (+ BOBBY_HL_DEXES) + spot USDC + userNonFundingLedgerUpdates for deposits/withdrawals/transfers
(best effort), TxFlow clearinghouseState (BOBBY_TXFLOW_ADDRESS), QFEX through `node autotrader/cli.js status --pf qfex`
(QFEX key in the env; `deposit` tracks net transfers in/out of the account). A platform without data shows
"not connected yet".
RiseX (tracking only, not traded) from the public RiseX API (risex.py, BOBBY_RISEX_ADDRESS or BOBBY_ACCOUNT_ADDRESS).
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
from briefing import entropy_note
import points as PT
import limits as LM
import flows as FL
import positions as POS
import vaultpy
import risex as RX

HERE = Path(__file__).parent
NAMES = {"arcus": "🏹 Arcus", "entropy": "🤖 Entropy", "txflow": "🌊 TxFlow", "qfex": "📈 QFEX", "variational": "🌀 Variational", "risex": "⚡ RiseX"}
# variational: manual (points_manual.json), no public per-address API; risex: tracking only (public API, not traded by Bobby)
ORDER = ("arcus", "entropy", "txflow", "qfex", "variational", "risex")
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
        elif t == "accountClassTransfer" and main and "spot" not in dexes:  # perp <-> spot inside the measured account
            net += usdc if d.get("toPerp") else -usdc
        elif t in ("internalTransfer", "subAccountTransfer") and main:
            net += usdc if str(d.get("destination", "")).lower() == addr else -usdc
        elif t == "send":
            v = f(d.get("usdcValue")) or f(d.get("amount")) or 0.0
            if d.get("token", "USDC") != "USDC":
                continue  # only USDC is measured (spot USDC + perp dexes)
            if d.get("destinationDex", "") in dexes and str(d.get("destination", "")).lower() == addr:
                net += v
            if d.get("sourceDex", "") in dexes and str(d.get("user", "")).lower() == addr:
                net -= v
    return net


UNIFIED = ("unifiedAccount", "portfolioMargin")


def entropy_equity(mode, states, usdc, min_io=10.0):
    """Pure (tested). states = {dex: clearinghouseState} ("" = main perp dex), usdc = spot USDC balance row or None.
    unifiedAccount / portfolioMargin: every balance and hold lives in spot, per-dex perp states are not meaningful ->
    equity = spot USDC total + unrealized PnL of the perp positions. Standard (disabled / dexAbstraction / unknown):
    the balances are separate -> main dex + io + spot USDC. Returns equity, mode, split and a note when the io dex
    has no usable margin yet."""
    av = {d: float(((st or {}).get("marginSummary") or {}).get("accountValue") or 0) for d, st in states.items()}
    upnl = {d: sum(float((ap.get("position") or {}).get("unrealizedPnl") or 0) for ap in (st or {}).get("assetPositions") or []) for d, st in states.items()}
    npos = sum(len((st or {}).get("assetPositions") or []) for st in states.values())
    spot = float((usdc or {}).get("total") or 0)
    hold = float((usdc or {}).get("hold") or 0)
    split = {"main": round(av.get("", 0.0), 2), "io": round(av.get("io", 0.0), 2), "spot": round(spot, 2)}
    if mode in UNIFIED:
        eq = spot + sum(upnl.values())
        split["io"] = round(upnl.get("io", 0.0), 2)
        out = {"equity": round(eq, 6), "mode": mode, "collateral": "spot USDC (unified)", "split": split, "splitBasis": "spot USDC + io uPnL"}
        usable = spot - hold
    else:
        eq = sum(av.values()) + spot
        out = {"equity": round(eq, 6), "mode": mode or "unknown", "split": split, "splitBasis": "main dex + io + spot"}
        usable = av.get("io", 0.0) + (av.get("", 0.0) if mode == "dexAbstraction" else 0.0)
    if usable < min_io and not npos and eq >= min_io:
        out["_fundsNote"] = (f"funds not on EntropyIO yet: ${split['main']:.2f} main perp dex, ${split['io']:.2f} io, ${split['spot']:.2f} spot "
                             f"(account mode {out['mode']}); switch the Bobby subaccount to unified account so its USDC backs the io dex")
    return out


ARCUS_NOTE = "PnL covers the whole Arcus account (incl. your own tools; Bobby is paused on Arcus)"


def arcus_reading(a):
    """Pure (tested). Arcus GET /v1/account -> equity + netDeposits as `deposit` (deposits are not PnL) + all-time PnL."""
    eq, nd = f(a.get("equity")), f(a.get("netDeposits"))
    out = {"equity": eq, "note": ARCUS_NOTE}
    if nd is not None:
        out["deposit"], out["depositSrc"] = nd, "Arcus netDeposits (public account API)"
        if eq is not None:
            out["allTimePnl"] = round(eq - nd, 2)
    return out


def hl_spot_usdc(B, url, user):
    """Spot USDC of a Hyperliquid user + account mode (unifiedAccount / portfolioMargin hold perp collateral in spot)."""
    try:
        mode = B._post(url, {"type": "userAbstraction", "user": user})
    except Exception:  # noqa: BLE001
        mode = None
    try:
        sp = B._post(url, {"type": "spotClearinghouseState", "user": user}) or {}
    except Exception:  # noqa: BLE001
        return None
    u = next((b for b in sp.get("balances") or [] if b.get("coin") == "USDC"), None)
    if not u:
        return None
    return {"total": float(u.get("total") or 0), "hold": float(u.get("hold") or 0),
            "unified": str(mode) in ("unifiedAccount", "portfolioMargin"), "mode": mode if isinstance(mode, str) else None}


def read_live(testnet, start):
    """{pf: {"equity", "deposit"?, "flowsSince"?} | {"status": "..."}}; start = ledger starts (for flow windows)."""
    ep = B.ENDPOINTS[testnet]
    addr = os.environ.get("BOBBY_ACCOUNT_ADDRESS", "")
    hl_addr = os.environ.get("BOBBY_HL_ADDRESS", "") or addr
    tx_addr = os.environ.get("BOBBY_TXFLOW_ADDRESS", "") or addr
    dexes = ["" if d.strip() == "main" else d.strip() for d in (os.environ.get("BOBBY_HL_DEXES") or "io").split(",") if d.strip()]
    qkey = bool(os.environ.get("QFEX_API_PUBLIC_KEY") and os.environ.get("QFEX_API_SECRET_KEY"))
    rx_addr = os.environ.get("BOBBY_RISEX_ADDRESS", "") or addr
    secrets = [addr, hl_addr, tx_addr, rx_addr] + [os.environ.get(k, "") for k in ("QFEX_ACCOUNT_ID", "QFEX_API_PUBLIC_KEY", "QFEX_API_SECRET_KEY")]

    def arcus():
        a = B._get(ep["arcus"] + "/v1/account", {"address": addr, "accountIndex": int(os.environ.get("ARCUS_ACCOUNT_INDEX", "0") or 0)})
        return arcus_reading(a)

    def entropy():
        # the Bobby subaccount: account mode read every run (same rules as the autotrader loop, autotrader/core.js)
        try:
            mode = B._post(ep["hl"], {"type": "userAbstraction", "user": hl_addr})
        except Exception:  # noqa: BLE001
            mode = None
        states = {}
        for dex in dict.fromkeys(["", "io"] + dexes):  # main perp dex + EntropyIO (+ any extra BOBBY_HL_DEXES)
            states[dex] = B._post(ep["hl"], {"type": "clearinghouseState", "user": hl_addr, **({"dex": dex} if dex else {})}) or {}
        sp = B._post(ep["hl"], {"type": "spotClearinghouseState", "user": hl_addr}) or {}
        usdc = next((b for b in sp.get("balances") or [] if b.get("coin") == "USDC"), None)
        out = entropy_equity(mode if isinstance(mode, str) else None, states, usdc)
        note = out.pop("_fundsNote", None) or entropy_note(HERE / "autotrader" / "entropy_status.json", time.time())
        if note:
            out["note"] = note
        s0 = (start.get("entropy") or {}).get("t")
        try:  # all-time deposits / withdrawals from the beginning (the subaccount's own view)
            all_ups = B._post(ep["hl"], {"type": "userNonFundingLedgerUpdates", "user": hl_addr, "startTime": 0}) or []
            out["allTime"] = FL.hl_totals(all_ups, hl_addr)
        except Exception as e:  # noqa: BLE001
            all_ups, out["allTimeError"] = None, "ledger not read (" + type(e).__name__ + ")"
        if s0:
            ups = [u for u in all_ups if int(u.get("time") or 0) >= int(s0 * 1000)] if all_ups is not None else \
                B._post(ep["hl"], {"type": "userNonFundingLedgerUpdates", "user": hl_addr, "startTime": int(s0 * 1000)})
            out["flowsSince"] = hl_flows(ups, hl_addr, list(states) + ["spot"])
        return out

    def txflow():
        st = B._tx(ep["txflow"], {"type": "clearinghouseState", "user": tx_addr, "accountType": "perp"}) or {}
        out = {"equity": f((st.get("marginSummary") or {}).get("accountValue"))}
        try:  # positions (+ SL/TP) and deposits/withdrawals since the start, all public by address
            oo = B._tx(ep["txflow"], {"type": "frontendOpenOrders", "user": tx_addr, "limit": 200, "offset": 0}) or []
            out["positions"] = PT.txflow_positions(st, oo.get("data", oo) if isinstance(oo, dict) else oo)
            try:
                out["allTime"] = FL.txflow_totals(PT._paged_tx(B, ep["txflow"], {"type": "userNonFundingLedgerUpdates", "user": tx_addr, "startTimeMs": 0}), tx_addr)
            except Exception as e:  # noqa: BLE001
                out["allTimeError"] = "ledger not read (" + type(e).__name__ + ")"
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
                "fills": q.get("fills"), "fillsFrom": since, "limits": q.get("limits")}

    def risex():  # tracking only: public RiseX API by address (no key)
        return RX.read(B, testnet, rx_addr)

    out = {}
    for pf, ok, fn in (("arcus", addr, arcus), ("entropy", hl_addr, entropy), ("txflow", tx_addr, txflow), ("qfex", qkey, qfex), ("risex", rx_addr, risex)):
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
        row = {"id": pf, "name": NAMES[pf], **({"note": r["note"]} if r.get("note") else {}), **{k: r[k] for k in ("split", "splitBasis", "mode") if r.get(k)}}
        if r.get("equity") is None:
            row.update(status=r.get("status") or "no data", error=r.get("error"))
            rows.append(row); continue
        eq = float(r["equity"])
        st = ledger["start"].get(pf)
        if st is None:
            st = ledger["start"][pf] = {"t": now_ts, "equity": eq, **({"deposit": r["deposit"]} if r.get("deposit") is not None else {})}
        elif r.get("deposit") is not None and st.get("deposit") is None:  # deposit tracking added later: re-base so old flows are not PnL
            st = ledger["start"][pf] = {"t": now_ts, "equity": eq, "deposit": r["deposit"], "rebased": "deposit tracking started"}
        ov = starts.get(pf) or {}
        start = float(ov["start"]) if ov.get("start") is not None else float(st["equity"])
        if r.get("deposit") is not None and st.get("deposit") is not None:
            auto, src = float(r["deposit"]) - float(st["deposit"]), r.get("depositSrc") or "QFEX deposit field"
        elif r.get("flowsSince") is not None:
            auto, src = float(r["flowsSince"]), r.get("flowsSrc") or "Hyperliquid ledger (best effort)"
        elif r.get("manual"):
            auto, src = 0.0, "manual entry (points_manual.json; deposits in balances_start.json)"
        else:
            auto, src = 0.0, "not exposed by the API (use balances_start.json)"
        nd = auto + float(ov.get("netDeposits") or 0)
        pnl = eq - start - nd
        base = start + nd
        if r.get("allTimePnl") is not None:
            row["allTimePnl"] = r["allTimePnl"]
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
    ap.add_argument("--valuation", help="airdrop valuation research inputs (default: valuation_inputs.json next to --ledger)")
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
    doc["valuation"] = PT.valuation_inputs(PT.load_json(a.valuation or lp.with_name("valuation_inputs.json")))  # encrypted with the rest
    # weekly + daily loss caps per platform (limits.py; usage from the autotrader's own accounting)
    caps, statuses = LM.collect_mock(readings) if a.mock else LM.collect_live(readings, lambda t: B.scrub(t, secrets))
    doc["limits"] = LM.build(caps, statuses, activity, manual, now_ts)
    doc["network"] = "mock" if a.mock else ("testnet" if a.testnet else "mainnet")
    doc["alerts"] = read_alerts(Path(a.alerts))
    doc["flows"] = FL.build(readings, manual)
    if a.mock:
        doc["positions"] = [{"pf": pf, **p} for pf in ORDER for p in ((readings.get(pf) or {}).get("positions") or [])]
        pdoc = POS.from_mock(readings, now_ts)
    else:
        pdoc = POS.collect(B, a.testnet, now_ts, secrets, txflow_positions=(readings.get("txflow") or {}).get("positions"),
                           risex_positions=(readings.get("risex") or {}).get("positions"))
        doc["positions"] = pdoc["positions"]
    doc["positionsMeta"], doc["bobby"], doc["orders"] = pdoc["platforms"], pdoc["bobby"], pdoc["orders"]
    doc["volume"] = volume_line((readings.get("qfex") or {}).get("volume"))
    text = json.dumps(doc)
    if any(s and s.lower() in text.lower() for s in secrets + POS.secrets_env()):
        raise SystemExit("refusing to write: an address or key would be included")
    lp.write_text(json.dumps(ledger, indent=0)); os.chmod(lp, 0o600)
    PT.save_ledger(pl_path, pledger)
    out = vaultpy.write_sealed(a.out, doc)
    dist = HERE / "dist"
    if dist.is_dir() and out.resolve() == (HERE / "public" / "balances.enc.json").resolve():
        (dist / out.name).write_text(out.read_text())
    if not a.mock and out.resolve() == (HERE / "public" / "balances.enc.json").resolve():  # same positions doc, also published alone
        po = vaultpy.write_sealed(HERE / "public" / "positions.enc.json", pdoc)
        if dist.is_dir():
            (dist / po.name).write_text(po.read_text())
    print("balances: " + ", ".join(f"{r['id']} {r['status']}" for r in doc["platforms"]) + f" -> {out} (encrypted)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
