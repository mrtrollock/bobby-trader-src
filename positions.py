#!/usr/bin/env python3
"""Bobby Trader: open positions on every platform + Bobby's live status -> public/positions.enc.json (ENCRYPTED).

    python3 positions.py                # read, encrypt, write public/positions.enc.json (+ dist/ copy)
    python3 positions.py --mock FILE    # offline (tests): {"qfex": {"positions": [...]}, "bobby": {...}, ...}

Read-only. QFEX / Arcus / Entropy (Bobby subaccount) come from `node autotrader/cli.js status` with every private
signing key removed from its environment (only the QFEX read key stays, as in balances.py); TxFlow and the Hyperliquid
main wallet and RiseX (tracking only) from public APIs; Variational / Extended / Metric from points_manual.json ("variational": {"positions": [...]}) or "manual".
The same document is embedded in balances.enc.json (tools/publish.sh) and published alone by tools/positions_publish.sh.
No addresses, account ids, order ids or keys are ever written.
"""
import argparse, json, os, subprocess, sys, time
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).parent
PFS = ("qfex", "entropy", "arcus", "txflow", "variational", "extended", "risex", "metric", "tradexyz")
LABEL = {"qfex": "QFEX", "entropy": "Entropy", "arcus": "Arcus", "txflow": "TxFlow", "variational": "Variational", "extended": "Extended", "risex": "RiseX", "metric": "Metric", "tradexyz": "trade.xyz"}
TRACKING = ("extended", "risex", "metric", "tradexyz")  # shown, never traded by Bobby
STRIP = ("ARCUS_API_PRIVATE_KEY", "ARCUS_API_KEY", "HL_AGENT_PRIVATE_KEY")
num = lambda x: None if x in (None, "") else float(x)


def norm(pf, p, by, account=None):
    sl = [float(x) for x in p.get("sl") or [] if x is not None]
    tp = [float(x) for x in p.get("tp") or [] if x is not None]
    return {"pf": pf, "market": str(p.get("market") or p.get("coin") or "?"), "side": str(p.get("side") or "").lower(), "size": num(p.get("size")),
            "entry": num(p.get("entry")), "mark": num(p.get("mark")), "upnl": num(p.get("upnl")), "sl": sl, "tp": tp,
            "protected": bool(p.get("protected", bool(sl) and bool(tp))), "leverage": p.get("leverage"), "by": by,
            **({"account": account} if account else {})}


def bobby_markets(state):
    """Markets Bobby himself holds or is entering (autotrader state, no ids): QFEX volume mode, Entropy volume mode, Arcus own."""
    out = {"qfex": set(), "entropy": set(), "arcus": set()}
    for k, v in ((state.get("volume") or {}).get("markets") or {}).items():
        if (v or {}).get("phase") in ("entry", "pos", "exit"):
            out["qfex"].add(k)
    for k, v in ((state.get("hlVolume") or {}).get("markets") or {}).items():
        if (v or {}).get("phase") in ("entry", "pos", "exit"):
            out["entropy"].add(k)
    out["arcus"] |= set(((state.get("guard") or {}).get("__arcusOwn") or {}).keys())
    return out


def from_status(st, state):
    """Pure (tested). st = `cli.js status` JSON, state = autotrader/state.json. -> positions, working orders, per-platform meta."""
    bm = bobby_markets(state or {})
    pos, orders, meta = [], [], {}
    for pf in ("qfex", "entropy", "arcus"):
        p = (st.get("platforms") or {}).get(pf)
        if p is None:
            meta[pf] = {"status": "not connected"}
            continue
        if p.get("error"):
            meta[pf] = {"status": "error", "error": str(p["error"])[:160]}
            continue
        own = set(bm[pf]) | set(p.get("bobbyMarkets") or [])
        def who(m):
            if pf == "entropy":
                return "Bobby"  # the Bobby subaccount is traded only by Bobby
            if m in own:
                return "Bobby"
            return "your tools" if pf == "arcus" else "manual / not Bobby"
        rows = [norm(pf, x, who(x.get("market")), "Bobby subaccount" if pf == "entropy" else ("account 0" if pf == "arcus" else None)) for x in p.get("positions") or []]
        pos += rows
        for o in p.get("openOrders") or []:
            if o.get("kind") in ("SL", "TP"):
                continue  # already shown on the position
            orders.append({"pf": pf, "market": str(o.get("market")), "side": str(o.get("side") or "").lower(), "kind": o.get("kind"), "px": num(o.get("px")),
                           "trig": num(o.get("trig")), "size": num(o.get("size")), "reduceOnly": bool(o.get("reduceOnly")), "by": who(o.get("market"))})
        meta[pf] = {"status": "ok", "count": len(rows), "src": "autotrader status (read-only)"}
    return pos, orders, meta


def hl_main_positions(B, url, user):
    """User's own Hyperliquid main wallet (manual trading), main dex + EntropyIO; public reads."""
    out = []
    for dex in ("", "io"):
        s = B._post(url, {"type": "clearinghouseState", "user": user, **({"dex": dex} if dex else {})}) or {}
        for ap in s.get("assetPositions") or []:
            p = ap.get("position") or {}
            sz = float(p.get("szi") or 0)
            if not sz:
                continue
            pv = num(p.get("positionValue"))
            out.append(norm("entropy", {"market": p.get("coin"), "side": "long" if sz > 0 else "short", "size": abs(sz), "entry": p.get("entryPx"),
                                        "mark": (pv / abs(sz)) if pv else None, "upnl": p.get("unrealizedPnl"), "leverage": (p.get("leverage") or {}).get("value")},
                            "manual", "main wallet"))
    return out


def _fresh(path, now_ts, max_s):
    try:
        h = json.loads(Path(path).read_text())
        t = datetime.fromisoformat(str(h.get("t")).replace("Z", "+00:00")).timestamp()
        return h if now_ts - t <= max_s else None
    except (OSError, ValueError, TypeError):
        return None


def bobby_status(env, st, entropy, qhealth, loop_running, stops, now_ts):
    """Pure (tested). Bobby's real per-platform state for the top bar. env: switches (strings), st: cli status (or {}),
    entropy: entropy_status.json (fresh or None), qhealth: qfex_health.json (fresh or None), stops: {"all","volume","entropy"}."""
    live = env.get("AUTOTRADER_ENABLED") == "1" and env.get("AUTOTRADER_LIVE") == "1"
    plat = st.get("platforms") or {}
    rows = []
    def add(pf, state, detail=""):
        rows.append({"id": pf, "label": LABEL[pf], "state": state, "detail": detail})
    stopped = None
    if not loop_running:
        stopped = "loop not running"
    elif stops.get("all"):
        stopped = "STOP file set"
    elif not live:
        stopped = "dry run (AUTOTRADER_LIVE off)"
    # QFEX
    vm = (plat.get("qfex") or {}).get("volumeMode") or {}
    if env.get("QFEX_VOLUME_MODE") != "1" and not env.get("QFEX_API_PUBLIC_KEY"):
        add("qfex", "off", "no key")
    elif stopped:
        add("qfex", "stopped", stopped)
    elif stops.get("volume"):
        add("qfex", "paused", "STOP_VOLUME set")
    elif vm.get("halted"):
        add("qfex", "halted", "loss cap reached")
    elif qhealth and qhealth.get("down"):
        add("qfex", "paused", f"QFEX outage ({qhealth.get('downMin')} min), retrying")
    else:
        add("qfex", "live", f"volume mode {vm.get('leverage') or env.get('QFEX_LEVERAGE') or ''}x".strip())
    # Entropy (Bobby subaccount)
    hv = (plat.get("entropy") or {}).get("volumeMode") or {}
    if not env.get("HL_AGENT_PRIVATE_KEY_SET"):
        add("entropy", "off", "no API wallet")
    elif stopped:
        add("entropy", "stopped", stopped)
    elif stops.get("entropy"):
        add("entropy", "paused", "STOP_ENTROPY set")
    elif hv.get("halted"):
        add("entropy", "halted", "loss cap reached")
    elif entropy and entropy.get("state") == "active":
        add("entropy", "live", "Bobby subaccount" + (" · auto mode" if env.get("AUTOTRADER_ENTROPY_VOLUME") == "1" else " · queued ideas only"))
    elif entropy and entropy.get("state") == "waiting":
        add("entropy", "waiting", "waiting for margin on EntropyIO")
    elif entropy and entropy.get("state") == "disabled":
        add("entropy", "off", str(entropy.get("reason") or "disabled")[:120])
    else:
        add("entropy", "unknown", "no fresh status from the loop")
    # Arcus
    if env.get("AUTOTRADER_ARCUS") != "1":
        add("arcus", "paused", "your own tools trade Arcus")
    elif stopped:
        add("arcus", "stopped", stopped)
    else:
        add("arcus", "live", "own $50 cap")
    add("txflow", "manual", "you trade TxFlow by hand")
    add("variational", "manual", "you trade Variational by hand")
    add("extended", "tracking", "points tracking only")
    add("risex", "tracking", "tracking only · not farmed (you trade RiseX yourself)")
    add("metric", "tracking", "tracking only · not farmed (spot swaps; no Metric key)")
    add("tradexyz", "tracking", "tracking only · not farmed (you trade trade.xyz yourself)")
    return {"loopRunning": bool(loop_running), "live": live and not stopped, "platforms": rows,
            "summary": " · ".join(f"{r['label']} {r['state']}" for r in rows if r["id"] not in TRACKING)}


def loop_running():
    try:
        return subprocess.run(["pgrep", "-f", "autotrader/cli.js loop"], capture_output=True).returncode == 0
    except OSError:
        return False


def env_switches():
    e = os.environ
    keep = ("AUTOTRADER_ENABLED", "AUTOTRADER_LIVE", "AUTOTRADER_ARCUS", "AUTOTRADER_ENTROPY_VOLUME", "QFEX_VOLUME_MODE", "QFEX_LEVERAGE")
    out = {k: e.get(k, "") for k in keep}
    out["QFEX_API_PUBLIC_KEY"] = "1" if e.get("QFEX_API_PUBLIC_KEY") else ""  # presence only, never the value
    out["HL_AGENT_PRIVATE_KEY_SET"] = "1" if e.get("HL_AGENT_PRIVATE_KEY") else ""
    return out


def cli_status():
    env = {k: v for k, v in os.environ.items() if k not in STRIP}
    env.setdefault("AUTOTRADER_NETWORK", "mainnet")
    r = subprocess.run(["node", str(HERE / "autotrader" / "cli.js"), "status"], capture_output=True, text=True, env=env, timeout=150)
    if r.returncode != 0:
        raise RuntimeError("autotrader status failed")
    return json.loads(r.stdout)


def manual_positions(manual):
    out = []
    for pf in ("variational", "extended", "metric"):
        for p in ((manual or {}).get(pf) or {}).get("positions") or []:
            out.append(norm(pf, p, "manual"))
    return out


def finish(pos, orders, meta, bobby, now_ts, manual):
    mp = manual_positions(manual)
    pos = pos + mp
    for pf in ("variational", "extended", "metric"):
        n = sum(1 for p in mp if p["pf"] == pf)
        note = ("no public API: open positions are not readable" if pf == "variational"
                else "tracking only · not farmed (spot DEX; no public positions API)" if pf == "metric"
                else "tracking only (not traded)")
        meta[pf] = ({"status": "ok", "count": n, "src": "manual entry (points_manual.json)"} if n else
                    {"status": "manual", "note": note})
    return {"v": 1, "generated": now_ts, "tz": "Europe/Berlin", "positions": pos, "orders": orders,
            "platforms": {pf: {**meta.get(pf, {"status": "no data"}), "t": now_ts} for pf in PFS}, "bobby": bobby}


def collect(B, testnet, now_ts, secrets, txflow_positions=None, risex_positions=None, tradexyz_positions=None):
    import points as PT
    ep = B.ENDPOINTS[testnet]
    scrub = lambda t: B.scrub(str(t), secrets)[:160]
    state = {}
    try:
        state = json.loads((HERE / "autotrader" / "state.json").read_text())
    except (OSError, ValueError):
        pass
    try:
        st = cli_status()
        pos, orders, meta = from_status(st, state)
    except Exception as e:  # noqa: BLE001
        st, pos, orders = {}, [], []
        meta = {pf: {"status": "error", "error": scrub(f"{type(e).__name__}: {e}")} for pf in ("qfex", "entropy", "arcus")}
    main = os.environ.get("BOBBY_ACCOUNT_ADDRESS", "")
    sub = (os.environ.get("BOBBY_HL_ADDRESS") or "").lower()
    if main and main.lower() != sub:
        try:
            mp = hl_main_positions(B, ep["hl"], main)
            pos += mp
            if mp and meta.get("entropy", {}).get("status") == "ok":
                meta["entropy"]["count"] += len(mp)
        except Exception:  # noqa: BLE001 - optional extra
            pass
    tx_addr = os.environ.get("BOBBY_TXFLOW_ADDRESS") or main
    if txflow_positions is None and tx_addr:
        try:
            stx = B._tx(ep["txflow"], {"type": "clearinghouseState", "user": tx_addr, "accountType": "perp"}) or {}
            oo = B._tx(ep["txflow"], {"type": "frontendOpenOrders", "user": tx_addr, "limit": 200, "offset": 0}) or []
            txflow_positions = PT.txflow_positions(stx, oo.get("data", oo) if isinstance(oo, dict) else oo)
        except Exception as e:  # noqa: BLE001
            meta["txflow"] = {"status": "error", "error": scrub(f"{type(e).__name__}: {e}")}
    if txflow_positions is not None:
        pos += [norm("txflow", p, "manual") for p in txflow_positions]
        meta["txflow"] = {"status": "ok", "count": len(txflow_positions), "src": "TxFlow public API"}
    elif "txflow" not in meta:
        meta["txflow"] = {"status": "not connected"}
    rx_addr = os.environ.get("BOBBY_RISEX_ADDRESS") or main
    if risex_positions is None and rx_addr:
        try:
            import risex as RX
            risex_positions = RX.read_positions(B, testnet, rx_addr)
        except Exception as e:  # noqa: BLE001
            meta["risex"] = {"status": "error", "error": scrub(f"{type(e).__name__}: {e}")}
    if risex_positions is not None:
        pos += [norm("risex", p, "manual") for p in risex_positions]
        meta["risex"] = {"status": "ok", "count": len(risex_positions), "src": "RiseX public API (tracking only)"}
    elif "risex" not in meta:
        meta["risex"] = {"status": "not connected"}
    xyz_addr = os.environ.get("BOBBY_TRADEXYZ_ADDRESS") or main
    if tradexyz_positions is None and xyz_addr:
        try:
            import tradexyz as TX
            url = ep["hl"]
            accts = TX.accounts(B, url, xyz_addr, (os.environ.get("BOBBY_HL_ADDRESS", ""), os.environ.get("HL_SUBACCOUNT_ADDRESS", "")))
            secrets = list(secrets) + accts
            states = [B._post(url, {"type": "clearinghouseState", "user": a, "dex": TX.DEX}) or {} for a in accts]
            orders = [o for a, s in zip(accts, states) if s.get("assetPositions") for o in (B._post(url, {"type": "frontendOpenOrders", "user": a, "dex": TX.DEX}) or [])]
            tradexyz_positions = TX.positions(states, orders)
        except Exception as e:  # noqa: BLE001
            meta["tradexyz"] = {"status": "error", "error": scrub(f"{type(e).__name__}: {e}")}
    if tradexyz_positions is not None:
        pos += [norm("tradexyz", p, "manual") for p in tradexyz_positions]
        meta["tradexyz"] = {"status": "ok", "count": len(tradexyz_positions), "src": "Hyperliquid public API, xyz dex (tracking only)"}
    elif "tradexyz" not in meta:
        meta["tradexyz"] = {"status": "not connected"}
    stops = {"all": (HERE / "autotrader" / "STOP").exists(), "volume": (HERE / "autotrader" / "STOP_VOLUME").exists(),
             "entropy": (HERE / "autotrader" / "STOP_ENTROPY").exists()}
    bobby = bobby_status(env_switches(), st, _fresh(HERE / "autotrader" / "entropy_status.json", now_ts, 30 * 60),
                         _fresh(HERE / "autotrader" / "qfex_health.json", now_ts, 20 * 60), loop_running(), stops, now_ts)
    import points as PT2
    return finish(pos, orders, meta, bobby, now_ts, PT2.load_json(HERE / "points_manual.json"))


def from_mock(readings, now_ts):
    pos = [norm(pf, p, p.get("by") or ("Bobby" if pf in ("qfex", "entropy") else "manual")) for pf in PFS for p in ((readings.get(pf) or {}).get("positions") or [])]
    meta = {pf: {"status": "ok", "count": sum(1 for p in pos if p["pf"] == pf)} for pf in ("qfex", "entropy", "arcus", "txflow", "risex", "tradexyz")}
    bobby = readings.get("bobby") or bobby_status({"AUTOTRADER_ENABLED": "1", "AUTOTRADER_LIVE": "1", "QFEX_VOLUME_MODE": "1", "QFEX_API_PUBLIC_KEY": "1",
                                                   "HL_AGENT_PRIVATE_KEY_SET": "1", "AUTOTRADER_ENTROPY_VOLUME": "1"}, {}, {"state": "active"}, None, True, {}, now_ts)
    return finish(pos, [], meta, bobby, now_ts, {})


def secrets_env():
    """Values that must never appear in a published document (addresses, account ids, keys)."""
    return [v for v in (os.environ.get(k, "") for k in ("BOBBY_ACCOUNT_ADDRESS", "BOBBY_HL_ADDRESS", "BOBBY_TXFLOW_ADDRESS", "ARCUS_ACCOUNT_ADDRESS", "HL_ACCOUNT_ADDRESS",
            "HL_SUBACCOUNT_ADDRESS", "QFEX_ACCOUNT_ID", "QFEX_API_PUBLIC_KEY", "QFEX_API_SECRET_KEY", "BOBBY_VARIATIONAL_ADDRESS", "BOBBY_RISEX_ADDRESS", "BOBBY_TRADEXYZ_ADDRESS", "ARCUS_API_KEY")) if len(v) > 6]


def main(argv=None):
    import briefing as B
    import vaultpy
    B.load_env()
    ap = argparse.ArgumentParser(description="open positions + Bobby status -> public/positions.enc.json (encrypted)")
    ap.add_argument("--out", default=str(HERE / "public" / "positions.enc.json"))
    ap.add_argument("--mock"); ap.add_argument("--testnet", action="store_true"); ap.add_argument("--now", type=float)
    a = ap.parse_args(argv)
    vaultpy.passphrase()
    now_ts = int(a.now or time.time())
    secrets = secrets_env()
    doc = from_mock(json.loads(Path(a.mock).read_text()), now_ts) if a.mock else collect(B, a.testnet, now_ts, secrets)
    text = json.dumps(doc).lower()
    if any(s and len(s) > 6 and s.lower() in text for s in secrets):
        raise SystemExit("refusing to write: an address or key would be included")
    out = vaultpy.write_sealed(a.out, doc)
    dist = HERE / "dist"
    if dist.is_dir() and out.resolve() == (HERE / "public" / "positions.enc.json").resolve():
        (dist / out.name).write_text(out.read_text())
    print(f"positions: {len(doc['positions'])} open, {len(doc['orders'])} working orders; Bobby: {doc['bobby']['summary']} -> {out} (encrypted)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
