#!/usr/bin/env python3
"""Minimal Arcus perps client (https://docs.arcus.xyz).

Auth follows https://docs.arcus.xyz/api-reference/authentication :
  - API key = hex Ed25519 public key derived from ARCUS_API_SIGNING_KEY (private, 64 hex)
  - X-Timestamp = Unix ns; X-Signature = Ed25519 sig (128 hex)
  - Scheme 1 (place/cancel/modify): sign the typed canonical payload
  - Scheme 2 (cancelAllOrders, setLeverage, signed GETs): sign timestamp + action + canonical_json(body)
The signing key is never printed, logged or written.

Mutating functions refuse to run unless ARCUS_ALLOW_WRITE=1 is set AND confirm=True is passed.
"""
import json, math, os, sys, time
from decimal import Decimal, ROUND_FLOOR, ROUND_CEILING

import requests
from cryptography.hazmat.primitives.asymmetric import ed25519

BASE = os.environ.get("ARCUS_BASE_URL", "https://api.arcus.xyz")
ADDRESS = os.environ.get("ARCUS_ADDRESS", "")  # your Arcus owner address (public)
ACCOUNT_INDEX = int(os.environ.get("ARCUS_ACCOUNT_INDEX", "0"))
TIMEOUT = 15

OP_PLACE, OP_CANCEL, OP_MODIFY, OP_PLACE_UNTRIGGERED = 1, 2, 3, 4
SIDE = {"BUY": 0, "SELL": 1}
TIF = {"GTT": 0, "FOK": 1, "IOC": 2, "ALO": 3}


class ArcusError(Exception):
    def __init__(self, status, body, path):
        super().__init__(f"HTTP {status} on {path}: {body}")
        self.status, self.body, self.path = status, body, path


# ---------------------------------------------------------------- keys / signing
def _load_key():
    raw = os.environ.get("ARCUS_API_SIGNING_KEY", "").strip()
    if raw.startswith("0x"):
        raw = raw[2:]
    if len(raw) != 64:
        raise SystemExit("ARCUS_API_SIGNING_KEY missing or not 64 hex chars")
    return ed25519.Ed25519PrivateKey.from_private_bytes(bytes.fromhex(raw))


_PRIV = None
def _priv():
    global _PRIV
    if _PRIV is None:
        _PRIV = _load_key()
    return _PRIV


def api_key():
    return _priv().public_key().public_bytes_raw().hex()


def _sign(msg: bytes) -> str:
    return _priv().sign(msg).hex()


def canonical(obj) -> str:
    return json.dumps(obj, separators=(",", ":"), sort_keys=True)


def _now_ns() -> int:
    return time.time_ns()


# ---------------------------------------------------------------- HTTP
def _request(method, path, params=None, body=None, headers=None):
    h = {"Content-Type": "application/json", "X-API-Key": api_key()}
    h.update(headers or {})
    data = canonical(body).encode() if body is not None else None
    r = requests.request(method, BASE + path, params=params, data=data, headers=h, timeout=TIMEOUT)
    try:
        payload = r.json() if r.content else {}
    except ValueError:
        payload = {"raw": r.text[:500]}
    if r.status_code >= 400:
        raise ArcusError(r.status_code, payload, path)
    return payload


def _get(path, **params):
    params = {k: v for k, v in params.items() if v is not None}
    return _request("GET", path, params=params)


def _signed_get(path):
    """Scheme 2 signed read: signature over timestamp + action (no body)."""
    ts = _now_ns()
    action = path.rstrip("/").split("/")[-1]
    sig = _sign(f"{ts}{action}".encode())
    return _request("GET", path, params={"address": ADDRESS},
                    headers={"X-Timestamp": str(ts), "X-Signature": sig})


def _require_write(confirm):
    if not confirm or os.environ.get("ARCUS_ALLOW_WRITE") != "1":
        raise PermissionError("Write blocked: pass confirm=True and set ARCUS_ALLOW_WRITE=1")


# ---------------------------------------------------------------- public / read
def server_time():
    return _get("/v1/time")


def api_keys(address=ADDRESS):
    return _get("/v1/apiKeys", address=address)


def markets(market=None):
    """All markets incl. tickSize/stepSize/oracle/mark/openInterest/IMF/MMF."""
    return _get("/v1/markets", market=market)["markets"]


def market_by_name(name):
    for m in markets():
        if m["marketDisplayName"].upper() == name.upper() or str(m["marketId"]) == str(name):
            return m
    raise KeyError(f"unknown market {name}")


def candles(market, timeframe="1h", countback=200, to_us=None, from_us=None):
    """OHLCV (oracle-derived prices). Timestamps in epoch microseconds."""
    to_us = to_us or int(time.time() * 1_000_000)
    return _get("/v1/candles", market=market, timeframe=timeframe, to=to_us,
                countback=countback, **({"from": from_us} if from_us else {}))


def account(address=ADDRESS, account_index=ACCOUNT_INDEX):
    return _get("/v1/account", address=address, accountIndex=account_index)


def positions(address=ADDRESS, account_index=ACCOUNT_INDEX, market=None):
    ps = _get("/v1/positions", address=address, accountIndex=account_index, market=market).get("positions", [])
    return list(ps.values()) if isinstance(ps, dict) else ps  # API returns a dict keyed by marketId


def open_orders(address=ADDRESS, account_index=ACCOUNT_INDEX, market=None, limit=None):
    return _get("/v1/openOrders", address=address, accountIndex=account_index, market=market, limit=limit).get("orders", [])


def fills(address=ADDRESS, account_index=ACCOUNT_INDEX, market=None, limit=50):
    return _get("/v1/fills", address=address, accountIndex=account_index, market=market, limit=limit)


def leverages(address=ADDRESS, account_index=ACCOUNT_INDEX):
    return _get("/v1/leverages", address=address, accountIndex=account_index)


def referral_code():
    """Signed (Scheme 2) read-only call; useful to verify the signature server-side."""
    return _signed_get("/v1/affiliate/code")


# ---------------------------------------------------------------- order helpers
def _to_int(value, unit) -> int:
    n = Decimal(str(value)) / Decimal(str(unit))
    if n != n.to_integral_value():
        raise ValueError(f"{value} is not a multiple of {unit}")
    return int(n)


def _snap(price, tick, rounding):
    t = Decimal(str(tick))
    return (Decimal(str(price)) / t).to_integral_value(rounding=rounding) * t


def _good_til_us(days=40):
    return int(time.time() * 1_000_000) + days * 86_400 * 1_000_000  # >= 1 month ahead (required)


def _order_payload(op, m, ts, side, price, qty, tif, reduce_only, good_til_us, client_id=None):
    """Typed canonical payload (keys alphabetical, no whitespace)."""
    d = {"ad": ADDRESS.lower(), "ai": ACCOUNT_INDEX, "ct": ts, "g": good_til_us * 1000,
         "m": m["marketId"], "op": op, "p": _to_int(price, m["tickSize"]),
         "q": _to_int(qty, m["stepSize"]), "r": 1 if reduce_only else 0,
         "s": SIDE[side], "t": TIF[tif], "v": 1}
    if client_id:
        d["c"] = client_id
    return canonical(d)


def _order_body(m, ts, side, order_type, qty, price, tif, reduce_only, good_til_us, client_id=None, **extra):
    b = {"address": ADDRESS, "accountIndex": ACCOUNT_INDEX, "marketId": m["marketId"],
         "orderSide": side, "orderType": order_type, "quantity": str(qty), "price": str(price),
         "timeInForce": tif, "goodTilTime": str(good_til_us), "timestamp": ts, "reduceOnly": reduce_only}
    if client_id:
        b["clientId"] = client_id
    b.update(extra)
    return b


def _protective_price(m, side, ref_price, slippage):
    if not 0 < slippage < 0.10:
        raise ValueError("slippage must be in (0, 0.10): docs require price within 10% of mark/trigger")
    ref = Decimal(str(ref_price))
    if side == "BUY":
        return _snap(ref * (1 + Decimal(str(slippage))), m["tickSize"], ROUND_FLOOR)
    return _snap(ref * (1 - Decimal(str(slippage))), m["tickSize"], ROUND_CEILING)


# ---------------------------------------------------------------- mutating (NOT called in read-only runs)
def place_market_order(market, side, qty, slippage=0.02, reduce_only=False, client_id=None, confirm=False):
    """MARKET + IOC with a protective price (mark +/- slippage, must be within 10% of mark)."""
    _require_write(confirm)
    m = market_by_name(market)
    price = _protective_price(m, side, m["markPrice"], slippage)
    ts, g = _now_ns(), _good_til_us()
    payload = _order_payload(OP_PLACE, m, ts, side, price, qty, "IOC", reduce_only, g, client_id)
    body = _order_body(m, ts, side, "MARKET", qty, price, "IOC", reduce_only, g, client_id)
    return _request("POST", "/v1/placeOrder", params={"address": ADDRESS}, body=body,
                    headers={"X-Timestamp": str(ts), "X-Signature": _sign(payload.encode())})


def close_position(market, slippage=0.02, confirm=False):
    """Close the full position with a reduce-only MARKET IOC order on the opposite side."""
    _require_write(confirm)
    m = market_by_name(market)
    pos = [p for p in positions(market=m["marketDisplayName"]) if Decimal(str(p["size"])) != 0]
    if not pos:
        return {"status": "NO_POSITION"}
    p = pos[0]
    size = abs(Decimal(str(p["size"])))
    side = "SELL" if p["side"].upper() in ("LONG", "BUY") else "BUY"
    return place_market_order(market, side, size, slippage=slippage, reduce_only=True, confirm=True)


def place_position_tpsl(market, position_side, take_profit=None, stop_loss=None, slippage=0.05, confirm=False):
    """positionTpsl via batchPlaceOrders: reduce-only MARKET/IOC legs, quantity 0 (engine sizes to full position).
    Each leg signed with op=4 and the shared X-Timestamp as ct. Protective price is set within 10% of the
    trigger price (docs rule for TPSL market legs)."""
    _require_write(confirm)
    m = market_by_name(market)
    close_side = "SELL" if position_side.upper() in ("LONG", "BUY") else "BUY"
    ts, g = _now_ns(), _good_til_us()
    orders = []
    for kind, trig in (("TAKE_PROFIT", take_profit), ("STOP_LOSS", stop_loss)):
        if trig is None:
            continue
        stop = _snap(trig, m["tickSize"], ROUND_FLOOR)
        price = _protective_price(m, close_side, stop, slippage)
        payload = _order_payload(OP_PLACE_UNTRIGGERED, m, ts, close_side, price, 0, "IOC", True, g)
        body = _order_body(m, ts, close_side, "MARKET", "0", price, "IOC", True, g,
                           tpslType=kind, stopPrice=str(stop))
        body["signature"] = _sign(payload.encode())
        orders.append(body)
    if not orders:
        raise ValueError("need take_profit and/or stop_loss")
    return _request("POST", "/v1/batchPlaceOrders", params={"address": ADDRESS},
                    body={"grouping": "positionTpsl", "orders": orders},
                    headers={"X-Timestamp": str(ts), "X-Signature": orders[0]["signature"]})


def cancel_order(market, order_id, confirm=False):
    _require_write(confirm)
    m = market_by_name(market)
    ts = _now_ns()
    payload = canonical({"ad": ADDRESS.lower(), "ai": ACCOUNT_INDEX, "ct": ts, "id": order_id,
                         "m": m["marketId"], "op": OP_CANCEL, "v": 1})
    body = {"address": ADDRESS, "accountIndex": ACCOUNT_INDEX, "marketId": m["marketId"],
            "kind": "orderId", "orderId": order_id, "timestamp": ts}
    return _request("POST", "/v1/cancelOrder", params={"address": ADDRESS}, body=body,
                    headers={"X-Timestamp": str(ts), "X-Signature": _sign(payload.encode())})


def set_leverage(market, leverage, isolated=None, confirm=False):
    """Scheme 2: sign timestamp + 'setLeverage' + canonical_json(body)."""
    _require_write(confirm)
    m = market_by_name(market)
    body = {"address": ADDRESS, "accountIndex": ACCOUNT_INDEX, "marketId": m["marketId"], "leverage": int(leverage)}
    if isolated is not None:
        body["isolated"] = bool(isolated)
    ts = _now_ns()
    sig = _sign(f"{ts}setLeverage{canonical(body)}".encode())
    return _request("POST", "/v1/setLeverage", params={"address": ADDRESS}, body=body,
                    headers={"X-Timestamp": str(ts), "X-Signature": sig})


# ---------------------------------------------------------------- status CLI
def _f(x, nd=2):
    try:
        return f"{float(x):,.{nd}f}"
    except (TypeError, ValueError):
        return "-"


def _est_liq_price(p, acct, mkts_by_id, all_pos):
    """Rough liquidation estimate (not provided by the API). Cross: whole-account equity vs total MM;
    isolated: position margin. Assumes other positions' prices unchanged."""
    try:
        m = mkts_by_id[p["marketId"]]
        mmf = float(m["maintenanceMarginFraction"])
        size = abs(float(p["size"]))
        s = 1 if p["side"].upper() in ("LONG", "BUY") else -1
        mark = float(p.get("markPx") or m["markPrice"])
        if str(p.get("marginMode", "")).upper() == "ISOLATED":
            eq, mm_other = float(p["marginUsed"]) + float(p["unrealizedPnl"]), 0.0
        else:
            eq = float(acct["equity"])
            mm_other = sum(abs(float(q["size"])) * float(q.get("markPx") or mkts_by_id[q["marketId"]]["markPrice"])
                           * float(mkts_by_id[q["marketId"]]["maintenanceMarginFraction"])
                           for q in all_pos if q["marketId"] != p["marketId"]
                           and str(q.get("marginMode", "")).upper() != "ISOLATED")
        liq = (mm_other - eq + s * size * mark) / (size * (s - mmf))
        return liq if liq > 0 else None
    except Exception:
        return None


def status():
    out = []
    out.append(f"API key (public): {api_key()[:8]}…  address {ADDRESS}  subaccount {ACCOUNT_INDEX}  host {BASE}")
    try:
        keys = api_keys()["apiKeys"]
        mine = [k for k in keys if k["apiKey"].lower() == api_key().lower()]
        if mine:
            k = mine[0]
            vu = k.get("validUntil")
            vu_s = time.strftime("%Y-%m-%d %H:%M", time.localtime(vu / 1000)) if vu else "-"
            scope = "all subaccounts" if k.get("allSubaccounts") else f"subaccount {k.get('accountIndex', 0)}"
            out.append(f"Key registration: {k.get('status')} | name={k.get('apiWalletName')} | {scope} | "
                       f"valid until {vu_s} | extra permissions={k.get('permissions') or 'none (trade-only)'}")
        else:
            out.append(f"Key registration: derived public key NOT found among {len(keys)} key(s) for this address")
    except ArcusError as e:
        out.append(f"Key registration check failed: {e}")
    try:
        referral_code()
        out.append("Signed request check (/v1/affiliate/code): OK, signature accepted")
    except ArcusError as e:
        out.append(f"Signed request check (/v1/affiliate/code): HTTP {e.status} {e.body}")

    mk = {m["marketId"]: m for m in markets()}
    try:
        acct = account()
    except ArcusError as e:
        out.append(f"Account: HTTP {e.status} {e.body}")
        print("\n".join(out)); return
    out.append(f"Account: equity ${_f(acct.get('equity'))} | free collateral ${_f(acct.get('freeCollateral'))} | "
               f"net deposits ${_f(acct.get('netDeposits'))} | pending dep/wd {acct.get('pendingDeposits')}/{acct.get('pendingWithdrawals')}")
    pos = [p for p in positions() if float(p.get("size") or 0) != 0]
    out.append(f"\nOpen positions ({len(pos)}):")
    if pos:
        out.append(f"  {'market':<12}{'side':<6}{'size':>12}{'entry':>12}{'mark':>12}{'uPnL':>10}{'lev':>6}{'mode':>9}{'liq~est':>12}")
        for p in pos:
            liq = _est_liq_price(p, acct, mk, pos)
            out.append(f"  {p.get('marketDisplayName',''):<12}{p.get('side',''):<6}{p.get('size',''):>12}"
                       f"{_f(p.get('averageEntryPrice'),4):>12}{_f(p.get('markPx'),4):>12}{_f(p.get('unrealizedPnl')):>10}"
                       f"{str(p.get('leverage','-')):>6}{str(p.get('marginMode','-')):>9}{(_f(liq,4) if liq else '-'):>12}")
    oo = open_orders()
    out.append(f"\nOpen orders ({len(oo)}):")
    for o in oo:
        kind = o.get("tpslType") or o.get("type")
        trig = f" trigger {o.get('triggerPrice')}" if o.get("triggerPrice") else ""
        flags = (" reduce-only" if o.get("reduceOnly") else "") + (" position-TPSL" if o.get("isPositionTPSL") else "")
        out.append(f"  {o.get('marketDisplayName','')} {o.get('side')} {kind} size {o.get('remainingSize')}/"
                   f"{o.get('originalSize')} @ {o.get('price')}{trig} {o.get('timeInForce')}{flags} "
                   f"[{o.get('status')}] id={o.get('orderId')}")
    print("\n".join(out))


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "status":
        status()
    elif cmd == "markets":
        for m in markets():
            print(f"{m['marketId']:>4} {m['marketDisplayName']:<12} mark {m.get('markPrice')} OI {m.get('openInterest')} "
                  f"IMF {m.get('initialMarginFraction')} status {m.get('status')}")
    else:
        sys.exit("usage: arcus.py [status|markets]")
