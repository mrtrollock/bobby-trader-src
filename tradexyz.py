"""trade.xyz (trade[XYZ], Hyperliquid HIP-3 perp dex "xyz"): TRACKING ONLY, not farmed, never traded by Bobby.

Read-only, public Hyperliquid info API (https://api.hyperliquid.xyz/info, no key, no signer):
  perpDexs                                     dex "xyz" exists (deployer 0x8880...0888, docs.trade.xyz)
  subAccounts(user)                            the wallet's subaccounts (the Bobby/Entropy subaccount is excluded)
  clearinghouseState(user, dex="xyz")          xyz equity (accountValue) + open positions
  frontendOpenOrders(user, dex="xyz")          resting TP/SL triggers on xyz positions
  userFillsByTime(user, startTime, ...)        fills; only coins "xyz:*" count (paged forward, 2000 / page)
  userFunding(user, startTime)                 funding on "xyz:*" coins (paged, 500 / page)
  userNonFundingLedgerUpdates(user)            explicit USDC sends into / out of the xyz dex (deposits / withdrawals)
  portfolio(user)                              all-dex perp volume, only used to flag a truncated fill history
Hyperliquid serves at most the 10,000 most recent fills per address through the time-range endpoints, so very old
history can be missing; tradexyz_cache.json (git-ignored, chmod 600) keeps every fill already seen so the 08:00/20:00
refresh only fetches new ones. Unified accounts (Hyperliquid account abstraction) trade xyz from the shared USDC
balance: those trades have no xyz deposit, so xyz equity is margin + uPnL of open xyz positions, and "PnL" is the
realized fills PnL (closedPnl - fees + funding). No token / points program is announced (Oct 2026): not valued.
No address, subaccount or order id is ever written to a published field (cache keys are hashes).
"""
import hashlib, json, os, time
from pathlib import Path

DEX = "xyz"
HERE = Path(__file__).parent
CACHE = HERE / "tradexyz_cache.json"
NOTE = "tracking only · not farmed: Bobby does not trade trade.xyz (your own trades, public Hyperliquid API)"
START_MS = 1735689600000  # 2025-01-01 UTC (HIP-3 went live Oct 2025)
_f = lambda x: None if x in (None, "") else float(x)
_h = lambda a: hashlib.sha256(a.lower().encode()).hexdigest()[:12]
is_xyz = lambda coin: str(coin or "").startswith(DEX + ":")
is_perp = lambda coin: not str(coin or "").startswith("@") and "/" not in str(coin or "") and str(coin or "") != "PURR/USDC"


# ------------------------------------------------------------------ pure (tested)
def compact(f):
    return {"t": int(f["time"]), "c": f["coin"], "px": float(f["px"]), "sz": float(f["sz"]), "fee": _f(f.get("fee")) or 0.0,
            "pnl": _f(f.get("closedPnl")) or 0.0, "tk": bool(f.get("crossed")), "id": f"{f.get('tid')}:{f.get('oid')}"}


def to_points_fills(rows):
    """compact rows -> points.aggregate() fills."""
    return [{"time": r["t"], "px": r["px"], "sz": r["sz"], "fee": r["fee"], "closedPnl": r["pnl"], "maker": not r["tk"]} for r in rows]


def summarize(rows, fundings=(), now_ms=None, week_start_ms=None):
    now_ms = now_ms or int(time.time() * 1000)
    def agg(xs, fu=()):
        v = sum(r["px"] * r["sz"] for r in xs)
        tk = sum(r["px"] * r["sz"] for r in xs if r["tk"])
        fee, pnl, fund = sum(r["fee"] for r in xs), sum(r["pnl"] for r in xs), sum(x["usdc"] for x in fu)
        return {"volume": round(v, 2), "taker": round(tk, 2), "maker": round(v - tk, 2), "fills": len(xs), "fees": round(fee, 2),
                "closedPnl": round(pnl, 2), "funding": round(fund, 2), "pnl": round(pnl - fee + fund, 2)}
    out = agg(rows, fundings)
    out["first"] = min((r["t"] for r in rows), default=None)
    out["last"] = max((r["t"] for r in rows), default=None)
    by = {}
    for r in rows:
        m = by.setdefault(r["c"].split(":", 1)[1], {"volume": 0.0, "fills": 0, "closedPnl": 0.0})
        m["volume"] += r["px"] * r["sz"]; m["fills"] += 1; m["closedPnl"] += r["pnl"]
    out["byMarket"] = [{"market": k, "volume": round(m["volume"], 2), "fills": m["fills"], "closedPnl": round(m["closedPnl"], 2)}
                       for k, m in sorted(by.items(), key=lambda kv: -kv[1]["volume"])]
    if week_start_ms is not None:
        out["week"] = agg([r for r in rows if r["t"] >= week_start_ms], [x for x in fundings if x["t"] >= week_start_ms])
    d30 = now_ms - 30 * 86400000
    out["last30d"] = agg([r for r in rows if r["t"] >= d30], [x for x in fundings if x["t"] >= d30])
    return out


def flows(updates_by_acct):
    """Explicit USDC sends into / out of the xyz dex (unified-account trades on the shared balance are not deposits)."""
    dep = wd = 0.0
    n = 0
    seen = set()
    for ups in updates_by_acct:
        for u in ups or []:
            d = u.get("delta") or {}
            if d.get("type") != "send" or (u.get("hash"), d.get("nonce")) in seen:
                continue
            amt = _f(d.get("usdcValue") or d.get("amount")) or 0.0
            if d.get("destinationDex") == DEX and d.get("sourceDex") != DEX:
                dep += amt; n += 1; seen.add((u.get("hash"), d.get("nonce")))
            elif d.get("sourceDex") == DEX and d.get("destinationDex") != DEX:
                wd += amt; n += 1; seen.add((u.get("hash"), d.get("nonce")))
    return {"deposits": round(dep, 2), "withdrawals": round(wd, 2), "net": round(dep - wd, 2), "events": n,
            "src": "Hyperliquid ledger: USDC sends into / out of the xyz dex (unified-account trades use the shared balance and are not counted)"}


def positions(states, orders=()):
    trig = {}
    for o in orders or []:
        if not o.get("isTrigger") or not o.get("reduceOnly", True):
            continue
        ot = str(o.get("orderType") or "")
        kind = "sl" if "Stop" in ot else "tp" if "Take" in ot else None
        if kind and _f(o.get("triggerPx")) is not None:
            trig.setdefault(o.get("coin"), {"sl": [], "tp": []})[kind].append(_f(o["triggerPx"]))
    out = []
    for st in states or []:
        for ap in (st or {}).get("assetPositions") or []:
            p = ap.get("position") or {}
            sz = _f(p.get("szi")) or 0.0
            if not sz:
                continue
            t = trig.get(p.get("coin")) or {"sl": [], "tp": []}
            ntl, upnl = _f(p.get("positionValue")), _f(p.get("unrealizedPnl"))
            out.append({"market": str(p.get("coin")).split(":", 1)[-1], "side": "long" if sz > 0 else "short", "size": abs(sz),
                        "entry": _f(p.get("entryPx")), "mark": (ntl / abs(sz)) if ntl else None, "upnl": upnl,
                        "sl": sorted(t["sl"]), "tp": sorted(t["tp"]), "protected": bool(t["sl"]) and bool(t["tp"]),
                        "leverage": _f((p.get("leverage") or {}).get("value"))})
    return out


def reading(states, orders, fl, summary, truncated=None):
    eq = round(sum(_f(((s or {}).get("marginSummary") or {}).get("accountValue")) or 0.0 for s in states), 2)
    out = {"equity": eq, "deposit": fl["net"], "depositSrc": fl["src"], "allTime": fl, "note": NOTE, "positions": positions(states, orders),
           "allTimePnl": summary["pnl"], "allTimePnlSrc": "realized: closedPnl - fees + funding over all xyz fills",
           "xyzVolume": {k: summary.get(k) for k in ("volume", "taker", "maker", "fills", "fees", "closedPnl", "funding", "pnl", "first", "last", "week", "last30d")}}
    out["xyzVolume"]["byMarket"] = summary["byMarket"][:12]
    if truncated:
        out["xyzVolume"]["historyNote"] = truncated
    return out


# ------------------------------------------------------------------ live (network, public, read-only)
def _load_cache():
    try:
        return json.loads(CACHE.read_text())
    except Exception:  # noqa: BLE001
        return {"v": 1, "acct": {}}


def _save_cache(c):
    CACHE.write_text(json.dumps(c, separators=(",", ":"))); os.chmod(CACHE, 0o600)


def accounts(B, url, main, exclude=()):
    ex = {a.lower() for a in exclude if a}
    subs = B._post(url, {"type": "subAccounts", "user": main}) or []
    return [main] + [s["subAccountUser"] for s in subs if s.get("subAccountUser") and s["subAccountUser"].lower() not in ex]


def _sync(B, url, addr, cache, now_ms):
    a = cache["acct"].setdefault(_h(addr), {"upto": START_MS, "fills": [], "perpAll": 0.0, "fupto": START_MS, "funding": []})
    ids = {r["id"] for r in a["fills"]}
    start = a["upto"]
    for _ in range(200):
        rows = B._post(url, {"type": "userFillsByTime", "user": addr, "startTime": start, "endTime": now_ms + 60000, "aggregateByTime": False}) or []
        for f in rows:
            k = f"{f.get('tid')}:{f.get('oid')}"
            if k in ids:
                continue
            ids.add(k)
            if is_perp(f.get("coin")):
                a["perpAll"] += float(f["px"]) * float(f["sz"])
            if is_xyz(f.get("coin")):
                a["fills"].append(compact(f))
        if rows:
            a["upto"] = max(int(r["time"]) for r in rows)
        if len(rows) < 2000:
            break
        start = a["upto"]
        time.sleep(0.2)
    fids = {(x["t"], x["c"]) for x in a["funding"]}
    start = a["fupto"]
    for _ in range(400):
        rows = B._post(url, {"type": "userFunding", "user": addr, "startTime": start, "endTime": now_ms + 60000}) or []
        for x in rows:
            d = x.get("delta") or {}
            if is_xyz(d.get("coin")) and (int(x["time"]), d["coin"]) not in fids:
                fids.add((int(x["time"]), d["coin"])); a["funding"].append({"t": int(x["time"]), "c": d["coin"], "usdc": float(d.get("usdc") or 0)})
        if rows:
            a["fupto"] = max(int(r["time"]) for r in rows)
        if len(rows) < 500:
            break
        start = a["fupto"] + 1
        time.sleep(0.2)
    return a


def read(B, testnet, main, exclude=(), now_s=None, week_start_s=None):
    url = B.ENDPOINTS[testnet]["hl"]
    now_ms = int((now_s or time.time()) * 1000)
    cache = _load_cache()
    accts = accounts(B, url, main, exclude)
    rows, fund, states, orders, ups, gaps = [], [], [], [], [], []
    for addr in accts:
        a = _sync(B, url, addr, cache, now_ms)
        rows += a["fills"]; fund += a["funding"]
        st = B._post(url, {"type": "clearinghouseState", "user": addr, "dex": DEX}) or {}
        states.append(st)
        if (st.get("assetPositions") or []):
            orders += B._post(url, {"type": "frontendOpenOrders", "user": addr, "dex": DEX}) or []
        ups.append(B._post(url, {"type": "userNonFundingLedgerUpdates", "user": addr, "startTime": START_MS}) or [])
        if a["fills"]:
            try:
                pf = dict(B._post(url, {"type": "portfolio", "user": addr}) or [])
                api = _f((pf.get("perpAllTime") or {}).get("vlm"))
                if api and api - a["perpAll"] > max(1000.0, 0.01 * api):
                    gaps.append(api - a["perpAll"])
            except Exception:  # noqa: BLE001 - only used for the truncation note
                pass
    _save_cache(cache)
    note = None
    if gaps:
        note = (f"Hyperliquid serves only the ~10,000 most recent fills per address: about ${sum(gaps):,.0f} of all-dex perp volume "
                f"on {len(gaps)} account(s) is not in the fill history, so older xyz volume may be undercounted")
    s = summarize(rows, fund, now_ms, week_start_s * 1000 if week_start_s else None)
    r = reading(states, orders, flows(ups), s, note)
    r["accounts"] = len(accts)
    frm = max(START_MS // 1000, (week_start_s or now_ms // 1000) - 5 * 604800)  # points tab: this week + the 5 before
    r["activity"] = {"fills": to_points_fills([x for x in rows if x["t"] >= frm * 1000]),
                     "fundings": [{"time": x["t"], "usdc": x["usdc"]} for x in fund if x["t"] >= frm * 1000], "from": frm,
                     "src": "Hyperliquid public API, xyz dex (main wallet + subaccounts, Bobby excluded)"}
    return r
