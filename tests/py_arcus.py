"""Reference signer: runs the REAL reference/arcus.py functions with a throwaway key (passed via env by the
test runner), patched clock and a captured (never sent) _request. Reads cases JSON on stdin, prints results JSON."""
import importlib.util, json, sys
from pathlib import Path
from decimal import Decimal
spec = importlib.util.spec_from_file_location("arcus", Path(__file__).resolve().parent.parent / "reference" / "arcus.py")
arcus = importlib.util.module_from_spec(spec); spec.loader.exec_module(arcus)

def capture(method, path, params=None, body=None, headers=None):
    h = {"Content-Type": "application/json", "X-API-Key": arcus.api_key()}
    h.update(headers or {})
    return {"method": method, "path": path, "query": params, "headers": h,
            "body": arcus.canonical(body) if body is not None else None}
arcus._request = capture

out = []
for c in json.load(sys.stdin):
    ts, now_us = c["ts"], c["now_us"]
    arcus._now_ns = lambda ts=ts: ts
    arcus._good_til_us = lambda days=40, now_us=now_us: now_us + days * 86_400 * 1_000_000
    m = c["market"]
    arcus.market_by_name = lambda name, m=m: m
    arcus.positions = lambda **kw: c.get("positions", [])
    k = c["kind"]
    if k == "market":
        r = arcus.place_market_order(m["marketDisplayName"], c["side"], c["qty"], slippage=c["slippage"], reduce_only=c.get("reduce", False), confirm=True)
    elif k == "close":
        r = arcus.close_position(m["marketDisplayName"], slippage=c["slippage"], confirm=True)
    elif k == "ptpsl":
        r = arcus.place_position_tpsl(m["marketDisplayName"], c["pside"], take_profit=c.get("tp"), stop_loss=c.get("sl"), confirm=True)
    elif k == "cancel":
        r = arcus.cancel_order(m["marketDisplayName"], c["oid"], confirm=True)
    elif k == "lev":
        r = arcus.set_leverage(m["marketDisplayName"], c["lev"], isolated=True, confirm=True)
    elif k == "sget":
        r = arcus.referral_code()
    elif k == "entry":
        # entryTpsl composed from arcus.py's own primitives (arcus.py has no wrapper for this grouping)
        g = arcus._good_til_us(); side = c["side"]; close = "SELL" if side == "BUY" else "BUY"
        if c["type"] == "market":
            price, ot, tif = arcus._protective_price(m, side, m["markPrice"], c["slippage"]), "MARKET", "IOC"
        else:
            price = arcus._snap(c["limit"], c["tick"], arcus.ROUND_FLOOR if side == "BUY" else arcus.ROUND_CEILING); ot, tif = "LIMIT", "GTT"
        e = arcus._order_body(m, ts, side, ot, c["qty"], price, tif, False, g)
        e["signature"] = arcus._sign(arcus._order_payload(arcus.OP_PLACE, m, ts, side, price, c["qty"], tif, False, g).encode())
        orders = [e]
        for kind, trig in (("TAKE_PROFIT", c.get("tp")), ("STOP_LOSS", c.get("sl"))):
            if trig is None: continue
            stop = arcus._snap(trig, m["tickSize"], arcus.ROUND_FLOOR)
            p2 = arcus._protective_price(m, close, stop, 0.05)
            b = arcus._order_body(m, ts, close, "MARKET", str(c["qty"]), p2, "IOC", True, g, tpslType=kind, stopPrice=str(stop))
            b["signature"] = arcus._sign(arcus._order_payload(arcus.OP_PLACE_UNTRIGGERED, m, ts, close, p2, c["qty"], "IOC", True, g).encode())
            orders.append(b)
        r = capture("POST", "/v1/batchPlaceOrders", {"address": arcus.ADDRESS}, {"grouping": "entryTpsl", "orders": orders},
                    {"X-Timestamp": str(ts), "X-Signature": orders[0]["signature"]})
    out.append(r)
print(json.dumps(out))
