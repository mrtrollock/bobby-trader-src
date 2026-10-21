"""RiseX (RISEx perp DEX on RISE Chain): TRACKING ONLY, not farmed, not traded by Bobby. Read-only public REST API.

Official: app https://www.rise.trade · API docs https://developer.rise.trade (llms.txt index) · program docs
https://docs.risechain.com/docs/risex · X @risextrade / @risechain. Mainnet REST https://api.rise.trade.
Every endpoint used here is documented as public (no auth, address as a query parameter):
  GET /v1/portfolio/details?account=        equity (total_account_value), positions (size signed: + long / - short)
  GET /v1/account/transfer-history?account= deposits / withdrawals (paged; the total_* fields read 0, so items are summed)
  GET /v1/trade-history?account=            fills (time in NANOseconds; realized_pnl is net of fees/funding)
  GET /v1/orders/tpsl?account=&statuses=TPSL_ORDER_STATUS_ACCEPTED   resting TP/SL triggers
  GET /v1/markets                           market id -> name
  GET /v1/points/epoch/current              next scheduled points drop (public)
Points per wallet (GET /v1/points/...) need a JWT (wallet-signed login) -> manual entries only.
Pure functions are tested (tests/py_risex.py). Addresses never leave this module in a published field.
"""
BASE = {False: "https://api.rise.trade", True: "https://api.testnet.rise.trade"}
NS = 1_000_000_000
_f = lambda x: None if x in (None, "") else float(x)
NOTE = "tracking only · not farmed: Bobby does not trade RiseX (you trade it yourself)"


def _data(r):
    return (r or {}).get("data") if isinstance(r, dict) else None


def flows(items):
    """transfer-history items -> all-time deposits / withdrawals / net (USDC)."""
    dep = wd = 0.0
    n = 0
    for it in items or []:
        t, amt = str(it.get("type") or "").upper(), _f(it.get("amount")) or 0.0
        if t == "DEPOSIT":
            dep += amt; n += 1
        elif t in ("WITHDRAW", "WITHDRAWAL"):
            wd += amt; n += 1
    return {"deposits": round(dep, 2), "withdrawals": round(wd, 2), "net": round(dep - wd, 2), "events": n,
            "src": "RiseX transfer history (public API)"}


def positions(details, tpsl=None, names=None):
    """portfolio/details positions (non-zero size) + accepted TP/SL triggers -> dashboard position rows."""
    names = names or {}
    trig = {}
    for o in tpsl or []:
        if str(o.get("status")) != "TPSL_ORDER_STATUS_ACCEPTED":
            continue
        kind = "sl" if "STOP" in str(o.get("stop_type")) else "tp" if "TAKE" in str(o.get("stop_type")) else None
        if kind and _f(o.get("stop_price")) is not None:
            trig.setdefault(str(o.get("market_id")), {"sl": [], "tp": []})[kind].append(_f(o["stop_price"]))
    out = []
    for p in (details or {}).get("positions") or []:
        sz = _f(p.get("size")) or 0.0
        if not sz:
            continue
        mid = str(p.get("market_id"))
        t = trig.get(mid) or {"sl": [], "tp": []}
        mkt = str(p.get("market_name") or names.get(mid) or mid).replace("/USDC", "")
        out.append({"market": mkt, "side": "long" if sz > 0 else "short", "size": abs(sz), "entry": _f(p.get("avg_entry_price")),
                    "mark": _f(p.get("mark_price")), "upnl": _f(p.get("unrealized_pnl")), "sl": sorted(t["sl"]), "tp": sorted(t["tp"]),
                    "protected": bool(t["sl"]) and bool(t["tp"]), "leverage": _f(p.get("leverage")) or None})
    return out


def reading(details, transfers, tpsl=None, names=None):
    """Pure (tested). -> balances.py reading: equity, net deposits as `deposit`, all-time flows + PnL, positions."""
    s = (details or {}).get("summary") or {}
    eq = _f(s.get("total_account_value"))
    if eq is None:
        eq = _f(s.get("cross_margin_balance"))
    fl = flows(transfers)
    out = {"equity": eq, "deposit": fl["net"], "depositSrc": fl["src"], "allTime": fl, "note": NOTE,
           "positions": positions(details, tpsl, names)}
    if eq is not None:
        out["allTimePnl"] = round(eq - fl["net"], 2)
    if _f(s.get("realized_pnl")) is not None:
        out["realizedPnl"] = round(_f(s["realized_pnl"]), 2)
    return out


def fills(trades):
    """trade-history rows -> points.aggregate() fills (ms). realized_pnl is already net of fees, so closedPnl = realized + fee
    (aggregate() subtracts the fee again)."""
    out = []
    for t in trades or []:
        fee = _f(t.get("fee")) or 0.0
        out.append({"time": int(int(t.get("time") or 0) // 1_000_000), "px": t.get("price"), "sz": t.get("size"), "fee": fee,
                    "closedPnl": (_f(t.get("realized_pnl")) or 0.0) + fee, "maker": str(t.get("liquidity_indicator") or "").upper() == "MAKER"})
    return out


# ------------------------------------------------------------------ live (network, public, read-only)
def _paged(B, url, params, key, cap=50):
    rows = []
    for page in range(1, cap + 1):
        d = _data(B._get(url, {**params, "page": page})) or {}
        got = d.get(key) or []
        rows += got
        if not d.get("has_next_page") or not got:
            break
    return rows


def market_names(B, testnet):
    d = _data(B._get(BASE[testnet] + "/v1/markets")) or []
    d = d.get("markets", []) if isinstance(d, dict) else d
    return {str(m.get("market_id")): str(m.get("display_name") or (m.get("config") or {}).get("name") or m.get("market_id")) for m in d}


def read(B, testnet, addr):
    base = BASE[testnet]
    det = _data(B._get(base + "/v1/portfolio/details", {"account": addr})) or {}
    tr = _paged(B, base + "/v1/account/transfer-history", {"account": addr, "limit": 100}, "items")
    try:
        tp = (_data(B._get(base + "/v1/orders/tpsl", {"account": addr, "statuses": "TPSL_ORDER_STATUS_ACCEPTED", "limit": 100})) or {}).get("orders") or []
    except Exception:  # noqa: BLE001 - positions without SL/TP info are still useful
        tp = None
    return reading(det, tr, tp)


def read_positions(B, testnet, addr):
    return read(B, testnet, addr)["positions"]


def activity(B, testnet, addr, since_s, now_s):
    rows = _paged(B, BASE[testnet] + "/v1/trade-history", {"account": addr, "start_time": int(since_s) * NS, "end_time": (int(now_s) + 60) * NS,
                                                           "limit": 1000, "sorted_by": "time"}, "trades")
    seen, uniq = set(), []
    for r in rows:
        if r.get("id") in seen:
            continue
        seen.add(r.get("id")); uniq.append(r)
    return {"fills": fills(uniq), "fundings": [], "from": int(since_s), "src": "RiseX public API (realized PnL net of fees and funding)"}


def next_drop(B, testnet):
    """Official next scheduled drop (public): (distribution unix, epoch label) or (None, None)."""
    e = (_data(B._get(BASE[testnet] + "/v1/points/epoch/current")) or {}).get("epoch") or {}
    return (int(e["distribution_at"]) if e.get("distribution_at") else None), e.get("epoch_id")
