#!/usr/bin/env python3
"""Turn a trade dict into a Mini App proposal URL:  <base>#p=v1.<base64url(json)>.<sha256[:16]>

Fields (v1): id, pf ("arcus"|"hl"), m (Arcus "TSLA-USD" | HL "BTC" or "io:ANTH"), act ("open" default | "tpsl"),
sd ("long"|"short"), sz, lev (int), et ("market"|"limit"), px (limit price), ref (mark at proposal time),
sl, tp, exp (unix seconds), n (note).  The hash only detects corruption; it is not a security boundary.

    python3 make_proposal.py https://<user>.github.io/<repo>/ '{"pf":"hl","m":"io:ANTH","sd":"short",...}'
"""
import base64, hashlib, json, sys, time, uuid

REQUIRED_OPEN = ("pf", "m", "sd", "sz", "lev", "et")

def make_token(trade: dict) -> str:
    t = {k: v for k, v in trade.items() if v is not None}
    t.setdefault("id", uuid.uuid4().hex[:10])
    t.setdefault("exp", int(time.time()) + 2 * 3600)
    act = t.get("act", "open")
    if act == "open":
        missing = [k for k in REQUIRED_OPEN if k not in t]
        if missing:
            raise ValueError(f"missing fields: {missing}")
        if t["et"] == "limit" and "px" not in t:
            raise ValueError("limit order needs px")
        if t["et"] == "market" and "ref" not in t:
            raise ValueError("market order needs ref (reference mark) for the 1% drift check")
    body = {"v": 1, **t}
    raw = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    b64 = base64.urlsafe_b64encode(raw).rstrip(b"=").decode()
    return f"v1.{b64}.{hashlib.sha256(raw).hexdigest()[:16]}"

def make_url(base_url: str, trade: dict) -> str:
    return base_url.split("#")[0] + "#p=" + make_token(trade)

if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    print(make_url(sys.argv[1], json.loads(sys.argv[2])))
