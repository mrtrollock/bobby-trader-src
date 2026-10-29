"""All-time deposits / withdrawals / net deposited / all-time PnL per platform (inside the ENCRYPTED balances.enc.json).

Pure functions (tested) + small public readers. Unknown values stay None and carry a reason; nothing is guessed.
  Arcus:      /v1/account netDeposits (net only: the public API has no separate deposit / withdrawal totals)
  Entropy:    Hyperliquid userNonFundingLedgerUpdates of the Bobby subaccount from the beginning (its own view)
  TxFlow:     TxFlow userNonFundingLedgerUpdates from the beginning (bridge deposits/withdrawals, transfers, vault moves)
  QFEX:       balance `deposit` (net deposited; separate totals are not exposed to a single-account key)
  RiseX:      public transfer history (deposits / withdrawals summed from the beginning; tracking only, not traded)
  trade.xyz:  Hyperliquid ledger sends into / out of the xyz dex (unified-account trades use the shared balance; tracking only)
  Variational / Extended / Metric: manual (points_manual.json "<pf>": {"flows": {"deposits", "withdrawals"}}) or not tracked
"""
STABLES = ("USDC", "USDT0", "USDT", "USDH", "USDE")
NAMES = {"arcus": "🏹 Arcus", "entropy": "🤖 Entropy", "txflow": "🌊 TxFlow", "qfex": "📈 QFEX", "variational": "🌀 Variational", "extended": "🟣 Extended", "risex": "⚡ RiseX", "metric": "🔷 Metric", "tradexyz": "📊 trade.xyz"}
ORDER = ("arcus", "entropy", "txflow", "qfex", "variational", "extended", "risex", "metric", "tradexyz")
_f = lambda x: float(x or 0)


def _tok(t):
    return str(t or "USDC").split(":")[0].upper()


def hl_totals(updates, addr):
    """Hyperliquid account's own view: money arriving from another account / the bridge = deposit, leaving = withdrawal.
    Moves inside the same account (spot <-> perp, dex <-> dex) are ignored. Non-stable tokens are skipped and counted."""
    a, dep, wd, skipped, n = (addr or "").lower(), 0.0, 0.0, 0, 0
    for u in updates or []:
        d = u.get("delta") or {}
        t = d.get("type")
        src, dst = str(d.get("user", "")).lower(), str(d.get("destination", "")).lower()
        if t == "deposit":
            dep += _f(d.get("usdc")); n += 1
        elif t == "withdraw":
            wd += _f(d.get("usdc")) + _f(d.get("fee")); n += 1
        elif t in ("subAccountTransfer", "internalTransfer"):
            v = _f(d.get("usdc"))
            if dst == a and src != a:
                dep += v; n += 1
            elif src == a and dst != a:
                wd += v + _f(d.get("fee")); n += 1
        elif t in ("send", "spotTransfer"):
            if src == dst:
                continue  # inside this account
            if _tok(d.get("token")) not in STABLES:
                skipped += 1; continue
            v = _f(d.get("usdcValue")) or _f(d.get("amount"))
            if dst == a:
                dep += v; n += 1
            elif src == a:
                wd += v + _f(d.get("fee")); n += 1
    return {"deposits": round(dep, 2), "withdrawals": round(wd, 2), "net": round(dep - wd, 2), "events": n, "skippedNonStable": skipped,
            "src": "Hyperliquid ledger from the beginning (Bobby subaccount's own view)"}


def txflow_totals(rows, addr):
    """TxFlow perp account: bridge deposits / withdrawals + transfers from / to other accounts; vault deposits count as money
    leaving the perp account (they are not in its balance) and are reported separately."""
    a, dep, wd, vin, vout, n = (addr or "").lower(), 0.0, 0.0, 0.0, 0.0, 0
    for r in rows or []:
        d = r.get("delta") or {}
        t, st = d.get("type"), str(d.get("status", "completed")).lower()
        amt = _f(d.get("amount") or d.get("usdcValue"))
        if t in ("deposit", "multiChainDeposit"):
            if st in ("failed", "pending"):
                continue
            dep += amt; n += 1
        elif t in ("withdraw", "multiChainWithdraw"):
            if st == "failed":
                continue
            wd += amt + _f(d.get("fee")); n += 1
        elif t == "tokenSend":
            src, dst = str(d.get("user", "")).lower(), str(d.get("destination", "")).lower()
            v = _f(d.get("usdcValue") or d.get("amount"))
            if dst == a and src != a:
                dep += v; n += 1
            elif src == a and dst != a:
                wd += v + _f(d.get("fee")); n += 1
        elif t == "vaultEvent" and str(d.get("user", "")).lower() == a:
            if d.get("isDeposit"):
                vin += amt
            else:
                vout += amt
            n += 1
    return {"deposits": round(dep, 2), "withdrawals": round(wd + vin - vout, 2), "net": round(dep - wd - vin + vout, 2), "events": n,
            "vaultNet": round(vin - vout, 2), "src": "TxFlow ledger from the beginning (incl. incoming transfers; vault deposits count as withdrawals)"}


def row(pf, current, fl, reason=None, note=None):
    """One card row; fl = {"deposits"?, "withdrawals"?, "net"?} or None. All-time PnL = current - net deposited."""
    fl = fl or {}
    net = fl.get("net")
    if net is None and fl.get("deposits") is not None and fl.get("withdrawals") is not None:
        net = round(fl["deposits"] - fl["withdrawals"], 2)
    cur = None if current is None else round(float(current), 2)
    out = {"id": pf, "name": NAMES[pf], "deposits": fl.get("deposits"), "withdrawals": fl.get("withdrawals"), "net": net, "current": cur,
           "pnl": round(cur - net, 2) if cur is not None and net is not None else None, "src": fl.get("src"), "reason": reason}
    notes = [x for x in (note, fl.get("note")) if x]
    if fl.get("vaultNet"):
        notes.append(f"${fl['vaultNet']:,.2f} sits in TxFlow vaults (not in the balance)")
    if fl.get("skippedNonStable"):
        notes.append(f"{fl['skippedNonStable']} non-stablecoin transfer(s) not counted")
    if notes:
        out["note"] = "; ".join(notes)
    return out


def build(readings, manual):
    """readings: balances.py readings ({pf: {"equity", "allTime"?, "deposit"?}}); manual: points_manual.json."""
    rows = []
    for pf in ORDER:
        r = readings.get(pf) or {}
        eq = r.get("equity")
        m = ((manual or {}).get(pf) or {}).get("flows")
        if pf == "arcus":
            rows.append(row(pf, eq, {"net": r.get("deposit"), "src": "Arcus netDeposits (public account API)"} if r.get("deposit") is not None else None,
                            reason=None if r.get("deposit") is not None else "not read", note="net only: Arcus does not publish separate deposit / withdrawal totals"))
        elif pf in ("entropy", "txflow", "risex"):
            at = r.get("allTime")
            rows.append(row(pf, eq, at, reason=None if at else (r.get("allTimeError") or ("not read: " + str(r.get("status") or "no data") if pf == "risex" else "ledger not read"))))
        elif pf == "tradexyz":
            at = r.get("allTime")
            rows.append(row(pf, eq, at, reason=None if at else "not read: " + str(r.get("status") or "no data"),
                            note="xyz-dex sends only: in a unified account trade.xyz trades use the shared Hyperliquid USDC balance, so realized PnL is on the Balances card"))
        elif pf == "qfex":
            d = r.get("deposit")
            rows.append(row(pf, eq, {"net": round(float(d), 2), "src": "QFEX balance deposit field"} if d is not None else None,
                            reason=None if d is not None else "not read", note="net only: QFEX does not expose separate deposit / withdrawal totals to this key"))
        elif m:
            rows.append(row(pf, eq, {**{k: (None if m.get(k) is None else round(float(m[k]), 2)) for k in ("deposits", "withdrawals")}, "src": "manual entry"}))
        elif pf == "variational":
            rows.append(row(pf, eq, None, reason="manual / not available yet (send the Variational Transfers CSV export)"))
        elif pf == "extended":
            rows.append(row(pf, eq, None, reason="not tracked (needs an Extended API key)"))
        elif pf == "metric":
            rows.append(row(pf, eq, None, reason="not tracked (no public balances API; enter flows/points by hand from the Metric app)"))
        else:
            rows.append(row(pf, eq, None, reason="not tracked"))
    known = [x for x in rows if x["net"] is not None and x["current"] is not None]
    tot = None
    if known:
        s = lambda k: round(sum(x[k] for x in known), 2)
        dep = [x["deposits"] for x in known]
        tot = {"net": s("net"), "current": s("current"), "pnl": s("pnl"), "platforms": [x["id"] for x in known],
               "deposits": round(sum(dep), 2) if all(v is not None for v in dep) else None,
               "withdrawals": round(sum(x["withdrawals"] for x in known), 2) if all(x["withdrawals"] is not None for x in known) else None}
    return {"rows": rows, "total": tot}
