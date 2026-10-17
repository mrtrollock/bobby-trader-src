"""Reference: hyperliquid-python-sdk signing + wire helpers, fed identical inputs by the Node tests."""
import json, sys
from eth_account import Account
from hyperliquid.utils.signing import (sign_l1_action, action_hash, float_to_wire, order_request_to_order_wire,
                                       order_wires_to_order_action)
req = json.load(sys.stdin)
res = {}
w = Account.from_key(req["key"])
res["address"] = w.address
res["sigs"] = []
for c in req["actions"]:
    a = c["action"]
    res["sigs"].append({"hash": action_hash(a, c.get("vault"), c["nonce"], c.get("expires")).hex(),
                        "sig": sign_l1_action(w, a, c.get("vault"), c["nonce"], c.get("expires"), c["mainnet"])})
res["round"] = [round(float(f"{px:.5g}"), 6 - sd) for px, sd in req["round"]]
res["slip"] = [round(float(f"{(px * ((1 + s) if b else (1 - s))):.5g}"), 6 - sd) for px, b, s, sd in req["slip"]]
res["wire"] = [float_to_wire(x) for x in req["wire"]]
res["orders"] = []
for o in req["orders"]:
    wires = [order_request_to_order_wire(x["req"], x["asset"]) for x in o["legs"]]
    res["orders"].append(order_wires_to_order_action(wires, None, o["grouping"]))
print(json.dumps(res))
