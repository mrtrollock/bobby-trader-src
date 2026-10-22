// Low open-interest (OI) market picks for points farming (Arcus, Entropy = Hyperliquid "io" dex, TxFlow), with a
// liquidity safety gate. Public market data only: no keys, nothing is signed or sent.
//
// Safety gate (a market is "eligible" only if ALL hold):
//   * market online, OI >= minOiUsd and 24h volume >= minVol24hUsd (skip dead / illiquid books)
//   * spread <= maxSpread
//   * reference trade: the largest notional the per-trade cap allows, N = cap / (slPct + taker + slippageBudget),
//     bounded by capital x 1x leverage. Walking the CURRENT book for N on EACH side (a long's stop sells into the bids,
//     a short's stop buys the asks): half-spread + impact, times stressMult (books are thinner when a stop fires),
//     must stay <= slippageBudget, and both sides must hold >= N within depthBand of the mid.
//   * => worst-case stop loss N x (slPct + taker + stressed slippage) <= cap (~$3)
// Ranking: eligible markets by OI ascending when preferLowOi (the points tilt), otherwise OI descending.
// Caveat: the current book is only a proxy for the book at stop time; gaps can still exceed the estimate.

export const DEFAULTS = { maxTradeLossUsd: 3, capitalUsd: 300, slPct: 0.01, slippageBudget: 0.003, stressMult: 2, maxSpread: 0.002,
  depthBand: 0.005, minOiUsd: 20000, minVol24hUsd: 50000, limit: 5 };

export function optsFromEnv(env = process.env, pf = 'arcus') {
  const P = pf.toUpperCase(), n = (k) => (env[k] != null && env[k] !== '' ? Number(env[k]) : undefined);
  const o = { ...DEFAULTS };
  for (const [k, e] of [['minOiUsd', 'LOWOI_MIN_OI_USD'], ['minVol24hUsd', 'LOWOI_MIN_VOL24H_USD'], ['maxSpread', 'LOWOI_MAX_SPREAD'],
    ['slippageBudget', 'LOWOI_SLIPPAGE_BUDGET'], ['stressMult', 'LOWOI_STRESS_MULT'], ['slPct', 'LOWOI_SL_PCT'], ['limit', 'LOWOI_LIMIT']]) {
    const v = n(`${P}_${e}`) ?? n(e); if (v != null && Number.isFinite(v)) o[k] = v;
  }
  o.preferLowOi = (env[`${P}_PREFER_LOW_OI`] ?? env.BOBBY_PREFER_LOW_OI ?? '1') === '1';
  return o;
}

// levels: [[px, sz], ...] best first (numbers or strings)
export function walk(levels, notionalUsd) {
  let left = notionalUsd, qty = 0, cost = 0;
  for (const [px, sz] of levels) {
    const p = Number(px), s = Number(sz); if (!(p > 0 && s > 0)) continue;
    const take = Math.min(left, p * s); cost += take; qty += take / p; left -= take;
    if (left <= 1e-9) break;
  }
  return { filled: left <= 1e-9, avgPx: qty > 0 ? cost / qty : null, worstNotional: notionalUsd - Math.max(0, left) };
}
const depthWithin = (levels, lim, isBid) => levels.reduce((a, [px, sz]) => a + ((isBid ? Number(px) >= lim : Number(px) <= lim) ? Number(px) * Number(sz) : 0), 0);

export function bookStats(bids, asks, band = DEFAULTS.depthBand) {
  const bid = bids.length ? Number(bids[0][0]) : null, ask = asks.length ? Number(asks[0][0]) : null;
  if (!(bid > 0 && ask > 0 && ask > bid)) return null;
  const mid = (bid + ask) / 2;
  return { bid, ask, mid, spread: (ask - bid) / mid, bidDepthUsd: depthWithin(bids, mid * (1 - band), true), askDepthUsd: depthWithin(asks, mid * (1 + band), false) };
}

// row: { pf, market, status ('ONLINE'), oiUsd, vol24hUsd, takerFee, bids, asks }
export function assess(row, o = DEFAULTS) {
  const reasons = [];
  const taker = Number(row.takerFee) || 0;
  const N = Math.min(o.maxTradeLossUsd / (o.slPct + taker + o.slippageBudget), o.capitalUsd || Infinity);
  const out = { pf: row.pf, market: row.market, oiUsd: row.oiUsd, vol24hUsd: row.vol24hUsd, refNotionalUsd: +N.toFixed(2) };
  if (row.status && row.status !== 'ONLINE') reasons.push('market ' + row.status);
  if (!(row.oiUsd >= o.minOiUsd)) reasons.push(`OI $${Math.round(row.oiUsd || 0)} < min $${o.minOiUsd}`);
  if (row.vol24hUsd != null && !(row.vol24hUsd >= o.minVol24hUsd)) reasons.push(`24h volume $${Math.round(row.vol24hUsd)} < min $${o.minVol24hUsd}`);
  const b = row.bids && row.asks ? bookStats(row.bids, row.asks, o.depthBand) : null;
  if (!b) { reasons.push('no two-sided order book'); return { ...out, eligible: false, reasons }; }
  Object.assign(out, { spread: b.spread, bidDepthUsd: Math.round(b.bidDepthUsd), askDepthUsd: Math.round(b.askDepthUsd), depthUsd: Math.round(Math.min(b.bidDepthUsd, b.askDepthUsd)) });
  if (b.spread > o.maxSpread) reasons.push(`spread ${(b.spread * 100).toFixed(3)}% > ${(o.maxSpread * 100).toFixed(2)}%`);
  if (Math.min(b.bidDepthUsd, b.askDepthUsd) < N) reasons.push(`depth within ${(o.depthBand * 100).toFixed(1)}% $${Math.round(Math.min(b.bidDepthUsd, b.askDepthUsd))} < reference trade $${Math.round(N)}`);
  const sb = walk(row.bids, N), sa = walk(row.asks, N);
  const imp = (w, isBid) => (w.filled && w.avgPx ? (isBid ? (b.mid - w.avgPx) / b.mid : (w.avgPx - b.mid) / b.mid) : Infinity);
  const slip = Math.max(imp(sb, true), imp(sa, false)) * o.stressMult;
  out.stopSlippage = Number.isFinite(slip) ? +slip.toFixed(6) : null;
  if (!(slip <= o.slippageBudget)) reasons.push(`stressed stop slippage ${Number.isFinite(slip) ? (slip * 100).toFixed(3) + '%' : 'unfillable'} > budget ${(o.slippageBudget * 100).toFixed(2)}%`);
  out.worstLossUsd = Number.isFinite(slip) ? +(N * (o.slPct + taker + slip)).toFixed(2) : null;
  if (out.worstLossUsd != null && out.worstLossUsd > o.maxTradeLossUsd + 1e-9) reasons.push(`worst-case stop loss $${out.worstLossUsd} > $${o.maxTradeLossUsd}`);
  return { ...out, eligible: reasons.length === 0, reasons };
}

export function rank(assessed, o = DEFAULTS) {
  const el = assessed.filter((x) => x.eligible);
  el.sort((a, b) => (o.preferLowOi === false ? b.oiUsd - a.oiUsd : a.oiUsd - b.oiUsd));
  return el;
}

// Stop-slippage estimate for ONE proposed trade (the autotrader's pre-trade gate). Returns the stressed fraction or Infinity.
export function stopSlippageFor(bids, asks, isLong, notionalUsd, stressMult = DEFAULTS.stressMult) {
  const b = bookStats(bids, asks, 1); if (!b) return Infinity;
  const w = walk(isLong ? bids : asks, notionalUsd);
  if (!w.filled || !w.avgPx) return Infinity;
  return (isLong ? (b.mid - w.avgPx) / b.mid : (w.avgPx - b.mid) / b.mid) * stressMult;
}

// ---------------------------------------------------------------- public-data fetchers (fetchFn injectable for tests)
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch { out[k] = null; } } }));
  return out;
}
// bounded (15 s): a hanging public-data request must never freeze the autotrader loop
const jget = async (f, url, init = {}) => { const r = await f(url, { ...init, signal: init.signal || AbortSignal.timeout(15000) }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };
const hlLevels = (lv) => (lv || []).map((x) => [x.px, x.sz]);

export const arcusBook = async (base, market, f = fetch) => { const b = await jget(f, `${base}/v1/l2OrderBook/${encodeURIComponent(market)}?nLevels=50`); return { bids: b.bids || [], asks: b.asks || [] }; };
export async function arcusRows(base = 'https://api.arcus.xyz', f = fetch, o = DEFAULTS) {
  const ms = (await jget(f, base + '/v1/markets')).markets || [];
  const rows = ms.map((m) => ({ pf: 'arcus', market: m.marketDisplayName, category: m.category, status: m.status, mark: Number(m.markPrice),
    oiUsd: Number(m.openInterest || 0) * Number(m.markPrice || 0), vol24hUsd: Number(m.volume24hNotional || 0),
    takerFee: Number(m.effectiveTakerFeePpm ?? m.baseTakerFeePpm ?? 225) / 1e6, isOutsideRth: !!m.isOutsideRth }));
  const cand = rows.filter((r) => r.status === 'ONLINE' && r.oiUsd >= o.minOiUsd && r.vol24hUsd >= o.minVol24hUsd);
  const books = await pool(cand, 8, (r) => arcusBook(base, r.market, f));
  cand.forEach((r, i) => { if (books[i]) Object.assign(r, books[i]); });
  return rows;
}
const HL_IO_TAKER = 0.0009; // HIP-3 io dex fallback (src/fees.js FALLBACK.hl_io is used by the autotrader)
export async function entropyRows(url = 'https://api.hyperliquid.xyz/info', dex = 'io', f = fetch, o = DEFAULTS, taker = HL_IO_TAKER) {
  const post = (body) => jget(f, url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const [meta, ctxs] = await post({ type: 'metaAndAssetCtxs', dex });
  const rows = meta.universe.map((u, i) => { const c = ctxs[i] || {}; const px = Number(c.markPx || 0);
    return { pf: 'entropy', market: u.name, status: u.isDelisted ? 'DELISTED' : 'ONLINE', mark: px, oiUsd: Number(c.openInterest || 0) * px, vol24hUsd: Number(c.dayNtlVlm || 0), takerFee: taker }; });
  const cand = rows.filter((r) => r.status === 'ONLINE' && r.oiUsd >= o.minOiUsd && r.vol24hUsd >= o.minVol24hUsd);
  const books = await pool(cand, 4, async (r) => { const b = await post({ type: 'l2Book', coin: r.market }); return { bids: hlLevels(b.levels[0]), asks: hlLevels(b.levels[1]) }; });
  cand.forEach((r, i) => { if (books[i]) Object.assign(r, books[i]); });
  return rows;
}
export async function txflowRows(base = 'https://rpc.txflow.com', f = fetch, o = DEFAULTS, taker = 0.00045, { maxBooks = 30 } = {}) {
  const post = async (body) => { const j = await jget(f, base + '/info', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-version': '2026-08-16' }, body: JSON.stringify(body) });
    if (j.success === false) throw new Error(j.message); return j.data; };
  const uni = ((await post({ type: 'perpMeta', includeDelisted: false })).universe || []).filter((u) => !u.delisted);
  const ctxs = await pool(uni, 10, (u) => post({ type: 'activeAssetCtx', coin: String(u.index) }));
  const rows = uni.map((u, i) => { const c = ctxs[i] || {}; const px = Number(c.markPx || 0);
    return { pf: 'txflow', market: u.name, status: u.haltTrading ? 'HALTED' : ctxs[i] ? 'ONLINE' : 'UNKNOWN', mark: px, oiUsd: Number(c.openInterest || 0) * px, vol24hUsd: Number(c.dayNtlVlm || 0), takerFee: taker, index: u.index }; });
  const cand = rows.filter((r) => r.status === 'ONLINE' && r.oiUsd >= o.minOiUsd && r.vol24hUsd >= o.minVol24hUsd).sort((a, b) => a.oiUsd - b.oiUsd).slice(0, maxBooks);
  const books = await pool(cand, 8, async (r) => { const b = await post({ type: 'l2Book', coin: String(r.index) }); return { bids: hlLevels(b.levels[0]), asks: hlLevels(b.levels[1]) }; });
  cand.forEach((r, i) => { if (books[i]) Object.assign(r, books[i]); });
  return rows;
}

const slim = (x) => ({ market: x.market, oiUsd: Math.round(x.oiUsd), spread: x.spread != null ? +x.spread.toFixed(6) : null, depthUsd: x.depthUsd ?? null,
  vol24hUsd: Math.round(x.vol24hUsd || 0), worstLossUsd: x.worstLossUsd ?? null, refNotionalUsd: x.refNotionalUsd });
// { t, platforms: { arcus: { picks:[...], eligible, scanned, preferLowOi, opts } | { error } } }
export async function picks({ env = process.env, f = fetch, platforms = ['arcus', 'entropy', 'txflow'], testnet = false, now = Date.now() } = {}) {
  const out = { t: now, platforms: {} };
  const src = {
    arcus: (o) => arcusRows(testnet ? 'https://api.testnet.arcus.xyz' : 'https://api.arcus.xyz', f, o),
    entropy: (o) => entropyRows(testnet ? 'https://api.hyperliquid-testnet.xyz/info' : 'https://api.hyperliquid.xyz/info', 'io', f, o),
    txflow: (o) => txflowRows(testnet ? 'https://rpc.txflow-testnet.xyz' : 'https://rpc.txflow.com', f, o),
  };
  await Promise.all(platforms.map(async (pf) => {
    const o = optsFromEnv(env, pf);
    try {
      const rows = await src[pf](o); const as = rows.map((r) => assess(r, o)); const el = rank(as, o);
      out.platforms[pf] = { preferLowOi: o.preferLowOi, scanned: rows.length, eligible: el.length, picks: el.slice(0, o.limit).map(slim),
        rules: { maxTradeLossUsd: o.maxTradeLossUsd, slPct: o.slPct, maxSpread: o.maxSpread, minOiUsd: o.minOiUsd, minVol24hUsd: o.minVol24hUsd, slippageBudget: o.slippageBudget, stressMult: o.stressMult },
        ...(pf === 'txflow' ? { manual: true } : {}) };
    } catch (e) { out.platforms[pf] = { error: String(e.message || e).slice(0, 200) }; }
  }));
  return out;
}
