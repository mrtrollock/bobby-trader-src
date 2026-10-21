#!/usr/bin/env python3
"""Bobby Trader: morning briefing generator -> public/briefing.enc.json (ENCRYPTED with BOBBY_VIEW_PASSPHRASE,
decrypted and rendered by the app's Briefing tab; nothing is published in plaintext).

    python3 briefing.py                      # read live public data, write public/briefing.enc.json, store a snapshot
    python3 briefing.py --testnet            # same against the testnets
    python3 briefing.py --snapshot-only      # just store a snapshot (cron it at ~22:00 Europe/Berlin = "last night")
    python3 briefing.py --mock FILE          # offline: raw API bundles from FILE (tests / demos), no network
    python3 briefing.py --comments FILE      # human comments merged in (see below)
    options: --out PATH (default public/briefing.enc.json, must end in .enc.json), --snapshots PATH (default snapshots.json), --now UNIX

Reads PUBLIC account data only (no keys, nothing is signed or sent):
  Arcus    GET /v1/account, /v1/positions, /v1/openOrders, /v1/fills, /v1/markets  (address + accountIndex)
  Entropy  Hyperliquid POST /info clearinghouseState / frontendOpenOrders with dex "io", userFillsByTime
  TxFlow   POST /info perpMeta, clearinghouseState, frontendOpenOrders, userFills
  Low-OI   `node autotrader/cli.js picks` (public market data, no keys): per platform the lowest-OI markets passing the
           liquidity gate (src/lowoi.js) -> doc["lowOi"]; BOBBY_LOW_OI=0 turns it off
  QFEX     needs the API key (QFEX account data is private): read via `node autotrader/cli.js status --pf qfex`
           when QFEX_API_PUBLIC_KEY + QFEX_API_SECRET_KEY are in the environment; with BOBBY_QFEX=1 and no key the
           briefing shows a "needs a QFEX API key" card. The key never reaches this script's output.
Env (.env, git-ignored, all public values): BOBBY_ACCOUNT_ADDRESS + ARCUS_ACCOUNT_INDEX (Arcus owner),
BOBBY_HL_ADDRESS (Hyperliquid master for Entropy, default BOBBY_ACCOUNT_ADDRESS), BOBBY_HL_DEXES (default "io"; "main" = the main Hyperliquid dex),
BOBBY_TXFLOW_ADDRESS (default BOBBY_ACCOUNT_ADDRESS). A platform with no address is skipped.

The output carries NO address or key, but equity, positions, SL/TP levels and PnL ARE public once pushed.
Snapshots (equity, positions, trigger orders) stay local in snapshots.json (git-ignored). "Since last night" = the
latest snapshot taken 21:00-23:59 Europe/Berlin on an earlier day; otherwise the previous run.

Comments file (optional, JSON): {"arcus": {"detail": "One-line note", "positions": {"TSLA": "I'm holding, ..."}}, ...}
Keys: arcus | entropy | txflow | qfex. Symbols are short names (TSLA, ANTH, BTC). A human comment replaces the auto one.
"""
import argparse, json, os, re, subprocess, sys, time, urllib.parse, urllib.request
from datetime import datetime, timedelta, date
from pathlib import Path
from zoneinfo import ZoneInfo

import vaultpy

HERE = Path(__file__).parent
BERLIN, NY = ZoneInfo("Europe/Berlin"), ZoneInfo("America/New_York")
ENDPOINTS = {
    False: {"arcus": "https://api.arcus.xyz", "hl": "https://api.hyperliquid.xyz/info", "txflow": "https://rpc.txflow.com/info"},
    True: {"arcus": "https://api.testnet.arcus.xyz", "hl": "https://api.hyperliquid-testnet.xyz/info", "txflow": "https://rpc.txflow-testnet.xyz/info"},
}
TX_HEADERS = {"x-api-version": "2026-08-16"}
PLATFORMS = {"arcus": ("🏹", "ARCUS"), "entropy": ("🤖", "ENTROPY"), "txflow": ("🌊", "TxFLOW"), "qfex": ("📈", "QFEX")}
QFEX_NEEDS_KEY = "needs a QFEX API key: QFEX account data is private (set QFEX_API_PUBLIC_KEY / QFEX_API_SECRET_KEY on the box)"
# QFEX index/commodity perps (everything else listed on QFEX is a US single stock / ETF)
QFEX_NON_EQUITY = set("US100 US500 KOSPI NIKKEI HSI TAIEX CL NATGAS GOLD SILVER URANIUM COPPER".split())
# US-listed stocks/ETFs that may appear on Hyperliquid/TxFlow without a category field (Arcus gives one per market).
US_TICKERS = set("""AAPL MSFT NVDA TSLA AMZN GOOGL GOOG META NFLX AMD INTC COIN MSTR HOOD PLTR CRCL ORCL AVGO MU SMCI ARM UBER
SPY QQQ IWM DIA GLD SLV USO TLT XLE XLF XLK SMH ARKK IBIT ETHA SPX NDX US500 US100 USTECH""".split())
# NYSE full-day holidays (early closes ignored).
NYSE_HOLIDAYS = {date.fromisoformat(d) for d in """2026-01-01 2026-01-19 2026-02-16 2026-04-03 2026-05-25 2026-06-19 2026-07-03
2026-09-07 2026-11-26 2026-12-25 2027-01-01 2027-01-18 2027-02-15 2027-03-26 2027-05-31 2027-06-18 2027-07-05 2027-09-06
2027-11-25 2027-12-24 2028-01-17 2028-02-21 2028-04-14 2028-05-29 2028-06-19 2028-07-04 2028-09-04 2028-11-23 2028-12-25""".split()}
RTH = (9 * 3600 + 30 * 60, 16 * 3600)  # 09:30-16:00 New York


def load_env():
    f = HERE / ".env"
    if f.exists():
        for line in f.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


# ------------------------------------------------------------------ http (public reads only)
def _get(url, params=None):
    if params:
        url += "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "bobby-briefing"}), timeout=20) as r:
        return json.load(r)

def _post(url, body, headers=None):
    req = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json", "User-Agent": "bobby-briefing", **(headers or {})})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)

def _tx(url, body):
    r = _post(url, body, TX_HEADERS)
    if isinstance(r, dict) and r.get("success") is False:
        raise RuntimeError(f"TxFlow {body.get('type')}: {r.get('message')}")
    return r.get("data") if isinstance(r, dict) and "data" in r else r


# ------------------------------------------------------------------ raw bundles (same shape as the --mock file)
def fetch_arcus(ep, addr, sub, since_ms):
    q = {"address": addr, "accountIndex": sub}
    return {"account": _get(ep + "/v1/account", q), "positions": _get(ep + "/v1/positions", q),
            "openOrders": _get(ep + "/v1/openOrders", q), "fills": _get(ep + "/v1/fills", {**q, "from": int(since_ms) * 1000, "limit": 500}),  # from/createdAt: epoch MICROseconds
            "markets": _get(ep + "/v1/markets")}

def fetch_hl(ep, addr, dexes, since_ms):
    out = {"dexes": {}}
    for dex in dexes:
        body = {"type": "clearinghouseState", "user": addr, **({"dex": dex} if dex else {})}
        out["dexes"][dex] = {"state": _post(ep, body), "openOrders": _post(ep, {**body, "type": "frontendOpenOrders"})}
    out["fills"] = _post(ep, {"type": "userFillsByTime", "user": addr, "startTime": since_ms})
    try:  # unified / portfolio-margin accounts hold the perp collateral as spot USDC
        out["mode"] = _post(ep, {"type": "userAbstraction", "user": addr})
        out["spotUsdc"] = next((b for b in (_post(ep, {"type": "spotClearinghouseState", "user": addr}) or {}).get("balances") or [] if b.get("coin") == "USDC"), None)
    except Exception:  # noqa: BLE001
        pass
    return out

def fetch_txflow(ep, addr, since_ms):
    fills, offset = [], 0
    while offset <= 20000:
        d = _tx(ep, {"type": "userFills", "user": addr, "accountType": ["perp"], "startTimeMs": since_ms,
                     "endTimeMs": int(time.time() * 1000) + 60000, "limit": 2000, "offset": offset}) or {}
        fills += d.get("data", []) if isinstance(d, dict) else d
        if not (isinstance(d, dict) and d.get("hasMore")):
            break
        offset += 2000
    return {"meta": _tx(ep, {"type": "perpMeta", "includeDelisted": False}),
            "state": _tx(ep, {"type": "clearinghouseState", "user": addr, "accountType": "perp"}),
            "openOrders": _tx(ep, {"type": "frontendOpenOrders", "user": addr, "limit": 200, "offset": 0}), "fills": fills}


# ------------------------------------------------------------------ normalization -> {equity, positions, orders, fills, equityMarkets}
f = lambda x: None if x in (None, "") else float(x)
def _kind(s):
    s = str(s or "").lower().replace("_", " ")
    return "SL" if "stop" in s else "TP" if "take" in s else "LIMIT"
def short(m):
    m = str(m).split(":")[-1].upper()
    for suf in ("-USDC", "-USD", "-PERP"):
        m = m[: -len(suf)] if m.endswith(suf) else m
    return m

def _arcus_s(t):
    """Arcus createdAt -> unix seconds (mainnet sends microseconds; ms accepted too)."""
    t = float(t or 0)
    return t / 1e6 if t > 1e14 else t / 1000 if t > 1e11 else t

def norm_arcus(raw):
    mk = raw.get("markets") or {}
    mk = mk.get("markets", mk) if isinstance(mk, dict) else mk
    mk = {m["marketDisplayName"].upper(): m for m in (mk if isinstance(mk, list) else list(mk.values()))}
    pos = (raw.get("positions") or {}).get("positions", raw.get("positions")) or []
    pos = pos if isinstance(pos, list) else list(pos.values())
    positions = []
    for p in pos:
        sz = abs(float(p.get("size") or 0))
        if not sz:
            continue
        m = p["marketDisplayName"].upper(); row = mk.get(m, {})
        positions.append({"m": m, "sym": short(m), "side": "long" if str(p.get("side", "")).upper() in ("LONG", "BUY") else "short", "size": sz,
                          "entry": f(p.get("averageEntryPrice") or p.get("entryPrice")), "mark": f(p.get("markPrice") or row.get("markPrice")),
                          "upnl": f(p.get("unrealizedPnl"))})
    oo = (raw.get("openOrders") or {}).get("orders", raw.get("openOrders")) or []
    orders = [{"id": str(o.get("orderId")), "m": o["marketDisplayName"].upper(), "kind": _kind(o.get("tpslType") or o.get("type")),
               "trig": f(o.get("triggerPrice")), "px": f(o.get("price")), "side": "buy" if str(o.get("side")).upper() == "BUY" else "sell",
               "position": bool(o.get("isPositionTPSL"))} for o in oo]
    fl = (raw.get("fills") or {}).get("fills", raw.get("fills")) or []
    fills = [{"t": int(_arcus_s(x.get("createdAt"))), "m": str(x.get("marketDisplayName", "")).upper(), "side": str(x.get("side", "")).lower(),
              "px": f(x.get("price")), "sz": f(x.get("size")), "pnl": f(x.get("closedPnl")), "kind": _kind(x.get("tpslType") or x.get("orderType"))} for x in fl]
    eq = {m for m, r in mk.items() if str(r.get("category", "")).upper() in ("EQUITIES", "ETF", "ETFS", "INDICES", "INDEX")}
    rth = {m: r.get("regularTradingHours") for m, r in mk.items() if r.get("regularTradingHours")}
    acct = raw.get("account") or {}
    return {"equity": f(acct.get("equity")), "positions": positions, "orders": orders, "fills": fills, "equityMarkets": eq, "rth": rth}

def _hl_orders(oo, names=None):
    out = []
    for o in oo or []:
        m = names.get(str(o.get("asset", o.get("coin"))), str(o.get("coin", "")).upper()) if names else str(o.get("coin"))
        out.append({"id": str(o.get("oid")), "m": m, "kind": _kind(o.get("orderType")) if o.get("isTrigger") or _kind(o.get("orderType")) != "LIMIT" else "LIMIT",
                    "trig": f(o.get("triggerPx")) if o.get("isTrigger") else None, "px": f(o.get("limitPx")),
                    "side": "buy" if o.get("side") == "B" else "sell", "position": bool(o.get("isPositionTpsl"))})
    return out

def _hl_positions(st, names=None):
    out = []
    for ap in (st or {}).get("assetPositions", []):
        p = ap.get("position") or {}
        szi = float(p.get("szi") or 0)
        if not szi:
            continue
        m = names.get(str(p.get("asset", p.get("coin"))), str(p.get("coin", "")).upper()) if names else str(p.get("coin"))
        pv = f(p.get("positionValue"))
        out.append({"m": m, "sym": short(m), "side": "long" if szi > 0 else "short", "size": abs(szi), "entry": f(p.get("entryPx")),
                    "mark": (pv / abs(szi)) if pv else f(p.get("markPx")), "upnl": f(p.get("unrealizedPnl")),
                    "tpsl": ap.get("tpsl") or []})
    return out

def norm_hl(raw):
    positions, orders, equity = [], [], 0.0
    for dex, d in (raw.get("dexes") or {}).items():
        equity += float(((d.get("state") or {}).get("marginSummary") or {}).get("accountValue") or 0)
        positions += _hl_positions(d.get("state")); orders += _hl_orders(d.get("openOrders"))
    dexes = tuple(x + ":" for x in (raw.get("dexes") or {}) if x)
    fills = [{"t": int(x["time"]) // 1000, "m": x.get("coin"), "side": "buy" if x.get("side") == "B" else "sell", "px": f(x.get("px")),
              "sz": f(x.get("sz")), "pnl": f(x.get("closedPnl")), "kind": "LIMIT", "dir": x.get("dir")}
             for x in raw.get("fills") or [] if not dexes or str(x.get("coin", "")).startswith(dexes)]
    eq = {p["m"] for p in positions + orders if short(p["m"]) in US_TICKERS}
    usdc = raw.get("spotUsdc")
    if usdc and (str(raw.get("mode")) in ("unifiedAccount", "portfolioMargin") or equity <= 0):
        equity = float(usdc.get("total") or 0) + sum(float(p.get("upnl") or p.get("pnl") or 0) for p in positions)
    return {"equity": equity, "positions": positions, "orders": orders, "fills": fills, "equityMarkets": eq, "rth": {}}

def norm_txflow(raw):
    uni = (raw.get("meta") or {}).get("universe", [])
    names = {str(u["index"]): str(u["name"]).upper() for u in uni}
    st = raw.get("state") or {}
    positions, orders = _hl_positions(st, names), _hl_orders(raw.get("openOrders"), names)
    for p in positions:  # position-level TP/SL lives on the position for TxFlow
        for i, t in enumerate(p.pop("tpsl", [])):
            for k, kind in (("slTriggerPrice", "SL"), ("tpTriggerPrice", "TP")):
                if f(t.get(k)):
                    orders.append({"id": f"pos-{p['m']}-{kind}-{i}", "m": p["m"], "kind": kind, "trig": f(t.get(k)), "px": None,
                                   "side": "sell" if p["side"] == "long" else "buy", "position": True})
    fills = [{"t": int(float(x.get("time") or 0)) // 1000, "m": names.get(str(x.get("asset", x.get("coin"))), str(x.get("coin", "")).upper()),
              "side": "buy" if x.get("side") == "B" else "sell", "px": f(x.get("px")), "sz": f(x.get("sz")), "pnl": f(x.get("closedPnl")),
              "kind": _kind(x.get("orderType"))} for x in raw.get("fills") or []]
    eq = {p["m"] for p in positions + orders if short(p["m"]) in US_TICKERS}
    return {"equity": f((st.get("marginSummary") or {}).get("accountValue")), "positions": positions, "orders": orders,
            "fills": fills, "equityMarkets": eq, "rth": {}}

def fetch_qfex(testnet, since_ms):
    """Account data via the autotrader (it holds the HMAC key logic); returns its status JSON for QFEX."""
    env = {**os.environ, "AUTOTRADER_NETWORK": "testnet" if testnet else "mainnet"}
    for k in ("ARCUS_API_PRIVATE_KEY", "HL_AGENT_PRIVATE_KEY"):
        env.pop(k, None)
    r = subprocess.run(["node", str(HERE / "autotrader" / "cli.js"), "status", "--since", str(since_ms), "--pf", "qfex"],
                       capture_output=True, text=True, env=env, timeout=90)
    if r.returncode != 0:
        raise RuntimeError("autotrader status failed")
    q = (json.loads(r.stdout).get("platforms") or {}).get("qfex")
    if not q:
        raise RuntimeError("no QFEX data")
    if q.get("error"):
        raise RuntimeError(q["error"])
    return q

def fetch_low_oi(testnet):
    """Lowest-OI markets that pass the liquidity gate (Arcus, Entropy io, TxFlow), from `node autotrader/cli.js picks`.
    Public market data only: every key is removed from the child environment."""
    env = {k: v for k, v in os.environ.items() if not re.search(r"KEY|SECRET|PRIVATE|PASSPHRASE|ACCOUNT_ID", k)}
    env["AUTOTRADER_NETWORK"] = "testnet" if testnet else "mainnet"
    r = subprocess.run(["node", str(HERE / "autotrader" / "cli.js"), "picks"], capture_output=True, text=True, env=env, timeout=180)
    if r.returncode != 0:
        raise RuntimeError("picks failed")
    return json.loads(r.stdout)

def norm_qfex(raw):
    positions = []
    for p in raw.get("positions") or []:
        sz, entry, upnl = abs(float(p.get("size") or 0)), f(p.get("entry")), f(p.get("upnl"))
        if not sz:
            continue
        mark = f(p.get("mark"))
        if mark is None and entry is not None and upnl is not None:
            mark = entry + (upnl / sz if p.get("side") == "long" else -upnl / sz)
        m = str(p["market"]).upper()
        positions.append({"m": m, "sym": short(m), "side": p.get("side"), "size": sz, "entry": entry, "mark": mark, "upnl": upnl})
    orders = [{"id": str(o.get("id")), "m": str(o.get("market")).upper(), "kind": o.get("kind") or "LIMIT", "trig": f(o.get("trig")), "px": f(o.get("px")),
               "side": str(o.get("side") or "").lower(), "position": bool(o.get("stop"))} for o in raw.get("openOrders") or []]
    fills = [{"t": int(float(x.get("time") or 0)) // 1000, "m": str(x.get("m") or "").upper(), "side": str(x.get("side") or "").lower(),
              "px": f(x.get("px")), "sz": f(x.get("sz")), "pnl": f(x.get("closedPnl")), "kind": _kind(x.get("type"))} for x in raw.get("fills") or []]
    eq = {p["m"] for p in positions + orders if short(p["m"]) not in QFEX_NON_EQUITY}
    return {"equity": f(raw.get("equity")), "positions": positions, "orders": orders, "fills": fills, "equityMarkets": eq, "rth": {},
            "stopsKnown": raw.get("stopsKnown", True)}

NORM = {"arcus": norm_arcus, "entropy": norm_hl, "txflow": norm_txflow, "qfex": norm_qfex}


# ------------------------------------------------------------------ US market hours
def _trading_day(d):
    return d.weekday() < 5 and d not in NYSE_HOLIDAYS

def us_market(now_ts, rth=None):
    """-> {open, reopens (unix), text}. rth: Arcus regularTradingHours {startSecondsOfDay, endSecondsOfDay, timezone}."""
    tz = ZoneInfo((rth or {}).get("timezone") or "America/New_York")
    start, end = ((rth or {}).get("startSecondsOfDay"), (rth or {}).get("endSecondsOfDay")) if rth else RTH
    start, end = (start if start is not None else RTH[0]), (end if end is not None else RTH[1])
    now = datetime.fromtimestamp(now_ts, tz)
    sec = now.hour * 3600 + now.minute * 60 + now.second
    if _trading_day(now.date()) and start <= sec < end:
        return {"open": True, "reopens": None, "text": "The US market is open."}
    d = now.date() if (_trading_day(now.date()) and sec < start) else now.date() + timedelta(days=1)
    while not _trading_day(d):
        d += timedelta(days=1)
    nxt = datetime(d.year, d.month, d.day, tzinfo=tz) + timedelta(seconds=start)
    b_now, b_nxt = now.astimezone(BERLIN), nxt.astimezone(BERLIN)
    days = (b_nxt.date() - b_now.date()).days
    when = (f"until {b_nxt:%H:%M} Berlin time" if days == 0 else f"until tomorrow {b_nxt:%H:%M} Berlin time" if days == 1
            else f"until {b_nxt:%A}")
    return {"open": False, "reopens": int(nxt.timestamp()), "text": f"The US market is closed {when}, so there's very little movement."}


# ------------------------------------------------------------------ snapshots
def snap_of(n):
    return {"equity": n["equity"], "positions": {p["m"]: (p["size"] if p["side"] == "long" else -p["size"]) for p in n["positions"]},
            "orders": [{"id": o["id"], "m": o["m"], "kind": o["kind"], "trig": o["trig"]} for o in n["orders"] if o["kind"] in ("SL", "TP")]}

def pick_baseline(snaps, now_ts):
    """Latest snapshot from 21:00-23:59 Berlin on an earlier Berlin day ("last night"), else the latest earlier one."""
    today = datetime.fromtimestamp(now_ts, BERLIN).date()
    older = [s for s in snaps if s["t"] < now_ts - 60]
    night = [s for s in older if datetime.fromtimestamp(s["t"], BERLIN).hour >= 21 and datetime.fromtimestamp(s["t"], BERLIN).date() < today]
    if night:
        return max(night, key=lambda s: s["t"]), True
    return (max(older, key=lambda s: s["t"]), False) if older else (None, False)

def since_label(base, nightly, now_ts):
    if not base:
        return None
    if nightly and (datetime.fromtimestamp(now_ts, BERLIN).date() - datetime.fromtimestamp(base["t"], BERLIN).date()).days == 1:
        return "since last night"
    return "since " + datetime.fromtimestamp(base["t"], BERLIN).strftime("%a %H:%M")


# ------------------------------------------------------------------ per-platform briefing
def fmt_px(x):
    return "—" if x is None else f"{x:,.6g}" if abs(x) < 1e6 else f"{x:,.0f}"

def sl_phrase(p, sl):
    if sl is None:
        return "⚠️ there is no SL on this position", None, None
    long = p["side"] == "long"
    in_profit = p["entry"] is not None and (sl > p["entry"] if long else sl < p["entry"])
    dist = abs(p["mark"] - sl) / p["mark"] if p.get("mark") else None
    if in_profit:
        locked = abs(sl - p["entry"]) * p["size"]
        return f"I'm holding, the SL is in profit at {fmt_px(sl)} (locks about +${locked:,.2f})", True, dist
    if dist is None:
        return f"I'm holding, the SL is at {fmt_px(sl)}", False, dist
    room = "is far away" if dist >= 0.05 else "leaves some room" if dist >= 0.015 else "is close"
    return f"I'm holding, the SL at {fmt_px(sl)} {room} ({dist * 100:.1f}% from the mark)", False, dist

def build_platform(pid, n, base, nightly, now_ts, comments):
    emoji, name = PLATFORMS[pid]
    com = (comments or {}).get(pid) or {}
    pcom = {str(k).upper(): v for k, v in (com.get("positions") or {}).items()}
    label = since_label(base, nightly, now_ts)
    bsnap = (base or {}).get("platforms", {}).get(pid) if base else None
    change = None
    if bsnap and bsnap.get("equity") and n["equity"] is not None:
        change = (n["equity"] - bsnap["equity"]) / bsnap["equity"]
    items, notes = [], []
    by_m = {}
    for o in n["orders"]:
        by_m.setdefault(o["m"], []).append(o)
    pos_m = {p["m"] for p in n["positions"]}
    for p in sorted(n["positions"], key=lambda x: -(abs(x["upnl"] or 0))):
        mine = by_m.get(p["m"], [])
        exit_side = "sell" if p["side"] == "long" else "buy"
        sls = sorted({o["trig"] for o in mine if o["kind"] == "SL" and o["trig"] is not None and o["side"] == exit_side})
        tps = sorted({o["trig"] for o in mine if o["kind"] == "TP" and o["trig"] is not None and o["side"] == exit_side})
        n_sl = sum(1 for o in mine if o["kind"] == "SL" and o["side"] == exit_side)
        # the binding SL is the one closest to the mark
        sl = (max(sls) if p["side"] == "long" else min(sls)) if sls else None
        auto, in_profit, dist = sl_phrase(p, sl)
        if sl is None and n.get("stopsKnown") is False:
            auto = "SL status unknown (QFEX stop orders could not be read)"
        if n_sl > 1:
            extra = [x for x in sls if x != sl]
            notes.append(f"{p['sym']} has {n_sl} SL orders ({', '.join(fmt_px(x) for x in sls)})." + (
                f" The one at {', '.join(fmt_px(x) for x in extra)} is a redundant second SL." if extra else " They are duplicates at the same level."))
        if sl is None and n.get("stopsKnown") is False:
            notes.append(f"{p['sym']}: SL status unknown (stop orders could not be read).")
        elif sl is None:
            notes.append(f"{p['sym']} has no stop-loss.")
        items.append({"sym": p["sym"], "market": p["m"], "side": p["side"], "size": p["size"], "entry": p["entry"], "mark": p["mark"],
                      "upnl": p["upnl"], "sl": sls, "tp": tps, "protected": bool(sls) and bool(tps), "slActive": sl, "slInProfit": in_profit,
                      "slDistPct": None if dist is None else round(dist * 100, 2), "equityUnderlying": p["m"] in n["equityMarkets"],
                      "auto": auto, "comment": pcom.get(p["sym"]) or pcom.get(p["m"].upper())})
    for m, os_ in by_m.items():
        trig = [o for o in os_ if o["kind"] in ("SL", "TP")]
        if m not in pos_m and trig:
            notes.append(f"Stray {'/'.join(sorted({o['kind'] for o in trig}))} order(s) on {short(m)} with no open position.")
    # what happened since the baseline
    since_ts = base["t"] if base else None
    fills = [x for x in n["fills"] if since_ts is None or x["t"] > since_ts]
    triggered = []
    if bsnap:
        live_ids = {o["id"] for o in n["orders"]}
        for o in bsnap.get("orders", []):
            if o["id"] not in live_ids and (o["m"] in bsnap.get("positions", {})) and abs(n_size(n, o["m"])) < abs(bsnap["positions"].get(o["m"], 0)):
                triggered.append(f"{short(o['m'])} {o['kind']} at {fmt_px(o['trig'])}")
    for x in fills:
        if x["kind"] in ("SL", "TP"):
            t = f"{short(x['m'])} {x['kind']} at {fmt_px(x['px'])}"
            if t not in triggered:
                triggered.append(t)
    prev_n = len((bsnap or {}).get("positions", {})) if bsnap else None
    kept = sum(1 for m in (bsnap or {}).get("positions", {}) if m in pos_m) if bsnap else None
    when = "overnight" if label == "since last night" else (label if label else "in the last 24h")
    if not base:
        fills = [x for x in n["fills"] if x["t"] > now_ts - 86400]
    if triggered:
        trig_txt = f"triggered {when}: " + ", ".join(triggered) + "."
    elif fills:
        trig_txt = f"no SL/TP triggered {when}, {len(fills)} fill(s)."
    else:
        trig_txt = f"nothing triggered {when}."
    count = f"{kept}/{prev_n}" if prev_n else str(len(n["positions"]))
    market = None
    if any(i["equityUnderlying"] for i in items) or n["equityMarkets"] & pos_m:
        rth = next((n["rth"][m] for m in pos_m if m in n["rth"]), None)
        market = us_market(now_ts, rth if rth else None)
        if rth:  # Arcus window is extended hours; also report regular-session status
            market = {**us_market(now_ts, None), "extended": us_market(now_ts, rth)["open"]}
    summary = f"Positions: {count}, {trig_txt}" + (f" {market['text']}" if market else "")
    if not n["positions"]:
        summary = "No open positions. " + trig_txt[0].upper() + trig_txt[1:] if base else "No open positions."
    detail = com.get("detail") or ("One detail: " + " ".join(notes) if notes else None)
    return {"id": pid, "emoji": emoji, "name": name, "equity": n["equity"], "change": None if change is None else round(change, 6),
            "changeLabel": label, "positions": {"open": len(n["positions"]), "prev": prev_n, "kept": kept},
            "triggered": triggered, "fillsSince": len(fills), "market": market, "summary": summary, "items": items,
            "notes": notes, "detail": detail}

def n_size(n, m):
    for p in n["positions"]:
        if p["m"] == m:
            return p["size"] if p["side"] == "long" else -p["size"]
    return 0.0


# ------------------------------------------------------------------ main
def scrub(text, secrets):
    for s in secrets:
        if s:
            text = text.replace(s, "<address>").replace(s.lower(), "<address>")
    return text

def qfex_outage_note(path, now_ts, fresh_s=20 * 60):
    """autotrader/qfex_health.json (written by the loop): a note while QFEX reads have failed for > 10 min, else None.
    Stale files (loop stopped, > fresh_s old) are ignored. Contains no keys or account ids."""
    try:
        h = json.loads(Path(path).read_text())
        t = datetime.fromisoformat(str(h.get("t")).replace("Z", "+00:00")).timestamp()
    except (OSError, ValueError, TypeError):
        return None
    if not h.get("down") or now_ts - t > fresh_s:
        return None
    return (f"Autotrader: QFEX reads failing for {h.get('downMin')} min ({h.get('failedTicks')} failed checks); "
            "new entries paused, exchange stops untouched, still retrying.")


def main(argv=None):
    load_env()
    ap = argparse.ArgumentParser(description="Bobby morning briefing -> public/briefing.enc.json (encrypted)")
    ap.add_argument("--out", default=str(HERE / "public" / "briefing.enc.json"))
    ap.add_argument("--snapshots", default=str(HERE / "snapshots.json"))
    ap.add_argument("--mock"); ap.add_argument("--comments"); ap.add_argument("--testnet", action="store_true")
    ap.add_argument("--snapshot-only", action="store_true"); ap.add_argument("--now", type=float)
    a = ap.parse_args(argv)
    if not a.snapshot_only:
        vaultpy.passphrase()  # refuse early: nothing is published without encryption
    now_ts = int(a.now or time.time())
    snap_path = Path(a.snapshots)
    snaps = json.loads(snap_path.read_text()) if snap_path.exists() else []
    base, nightly = pick_baseline(snaps, now_ts)
    since_ms = int(((base or {}).get("t") or now_ts - 86400) * 1000)
    comments = json.loads(Path(a.comments).read_text()) if a.comments else {}

    ep = ENDPOINTS[a.testnet]
    addr = os.environ.get("BOBBY_ACCOUNT_ADDRESS", "")
    hl_addr = os.environ.get("BOBBY_HL_ADDRESS", "") or addr
    tx_addr = os.environ.get("BOBBY_TXFLOW_ADDRESS", "") or addr
    dexes = ["" if d.strip() == "main" else d.strip() for d in (os.environ.get("BOBBY_HL_DEXES") or "io").split(",") if d.strip()]
    secrets = [addr, hl_addr, tx_addr] + [os.environ.get(k, "") for k in ("QFEX_ACCOUNT_ID", "QFEX_API_PUBLIC_KEY", "QFEX_API_SECRET_KEY")]
    qfex_key = bool(os.environ.get("QFEX_API_PUBLIC_KEY") and os.environ.get("QFEX_API_SECRET_KEY"))
    if a.mock:
        raw = json.loads(Path(a.mock).read_text())
    else:
        raw = {}
        for pid, ok, fn in (("arcus", addr, lambda: fetch_arcus(ep["arcus"], addr, int(os.environ.get("ARCUS_ACCOUNT_INDEX", "0") or 0), since_ms)),
                            ("entropy", hl_addr, lambda: fetch_hl(ep["hl"], hl_addr, dexes, since_ms)),
                            ("txflow", tx_addr, lambda: fetch_txflow(ep["txflow"], tx_addr, since_ms)),
                            ("qfex", qfex_key, lambda: fetch_qfex(a.testnet, since_ms))):
            if not ok:
                continue
            try:
                raw[pid] = fn()
            except Exception as e:  # noqa: BLE001
                raw[pid] = {"error": scrub(f"{type(e).__name__}: {e}", secrets)[:200]}

        if not qfex_key and os.environ.get("BOBBY_QFEX") == "1":
            raw["qfex"] = {"needsKey": True}

    out, snap = [], {"t": now_ts, "platforms": {}}
    for pid in PLATFORMS:
        if pid not in raw:
            continue
        if raw[pid].get("needsKey"):
            out.append({"id": pid, "emoji": PLATFORMS[pid][0], "name": PLATFORMS[pid][1], "error": QFEX_NEEDS_KEY, "needsKey": True, "items": []})
            continue
        if raw[pid].get("error"):
            out.append({"id": pid, "emoji": PLATFORMS[pid][0], "name": PLATFORMS[pid][1], "error": raw[pid]["error"], "items": []})
            continue
        n = NORM[pid](raw[pid])
        snap["platforms"][pid] = snap_of(n)
        out.append(build_platform(pid, n, base, nightly, now_ts, comments))

    if snap["platforms"]:
        snaps = [s for s in snaps if s["t"] > now_ts - 14 * 86400] + [snap]
        snap_path.write_text(json.dumps(snaps[-200:], indent=0))
        try:
            os.chmod(snap_path, 0o600)
        except OSError:
            pass
    if a.snapshot_only:
        print(f"snapshot stored ({len(snap['platforms'])} platform(s))")
        return 0
    note = None if a.mock else qfex_outage_note(HERE / "autotrader" / "qfex_health.json", now_ts)
    if note:
        q = next((p for p in out if p["id"] == "qfex"), None)
        if q is None:
            out.append({"id": "qfex", "emoji": PLATFORMS["qfex"][0], "name": PLATFORMS["qfex"][1], "error": note, "items": []})
        elif q.get("error"):
            q["error"] = note + " " + q["error"]
        else:
            q.setdefault("notes", []).insert(0, note)
    doc = {"v": 1, "generated": now_ts, "tz": "Europe/Berlin", "network": "testnet" if a.testnet else ("mock" if a.mock else "mainnet"),
           "baseline": (base or {}).get("t"), "platforms": out}
    # Low-OI picks (points tilt): lowest open-interest markets that still pass the spread/depth/stop-slippage gate
    if a.mock:
        if raw.get("lowOi"):
            doc["lowOi"] = raw["lowOi"]
    elif os.environ.get("BOBBY_LOW_OI", "1") == "1":
        try:
            doc["lowOi"] = fetch_low_oi(a.testnet)
        except Exception as e:  # noqa: BLE001
            doc["lowOi"] = {"error": scrub(f"{type(e).__name__}: {e}", secrets)[:200]}
    text = json.dumps(doc, indent=1, ensure_ascii=False)
    leaked = [s for s in secrets if s and s.lower() in text.lower()]
    if leaked:
        raise SystemExit("refusing to write: an address would be published")
    out_path = vaultpy.write_sealed(a.out, doc)  # refuses without BOBBY_VIEW_PASSPHRASE or a non-.enc.json name
    dist = HERE / "dist"
    if dist.is_dir() and out_path.resolve() == (HERE / "public" / "briefing.enc.json").resolve():
        (dist / "briefing.enc.json").write_text(out_path.read_text())
    print(f"wrote {a.out}: " + ", ".join(f"{p['name']} {'error' if p.get('error') else str(len(p['items'])) + ' pos'}" for p in out) or "no platform configured")
    return 0


if __name__ == "__main__":
    sys.exit(main())
