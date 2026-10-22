// Network layer (fetch). Only the 4 hosts allowed by the CSP are ever contacted.
import * as A from './arcus.js';
import * as H from './hl.js';
import { assertTradeOnly } from './risk.js';

export const bases = (testnet) => ({ arcus: testnet ? A.TESTNET : A.MAINNET, hl: testnet ? H.TESTNET : H.MAINNET });

// Every request is bounded (an unanswered request must never freeze the autotrader loop): reads HTTP_READ_TIMEOUT_MS
// (15 s), order/cancel sends HTTP_SEND_TIMEOUT_MS (20 s). A send that times out may still have reached the exchange:
// it is reported as "state unknown" (uncertain) and NEVER retried blindly; the next tick re-reads open orders and
// positions first, so nothing is ever submitted twice.
const envMs = (k, d) => { const v = typeof process !== 'undefined' && process.env ? Number(process.env[k]) : NaN; return v > 0 ? v : d; };
export const readTimeoutMs = () => envMs('HTTP_READ_TIMEOUT_MS', 15000);
export const sendTimeoutMs = () => envMs('HTTP_SEND_TIMEOUT_MS', 20000);
const isAbort = (e) => e && (e.name === 'TimeoutError' || e.name === 'AbortError' || /aborted due to timeout/i.test(String(e.message)));
export async function timedFetch(url, init = {}, ms = readTimeoutMs(), { send = false, what = 'request' } = {}) {
  try {
    const r = await fetch(url, { ...init, signal: init.signal || AbortSignal.timeout(ms) });
    return await j(r);
  } catch (e) {
    if (!isAbort(e)) throw e;
    const err = new Error(`${what} timed out after ${Math.round(ms / 1000)}s` + (send ? ' (state unknown: the next tick re-reads orders/positions before anything is re-sent)' : ''));
    err.timeout = true; if (send) err.uncertain = true;
    throw err;
  }
}
async function j(r) {
  const text = await r.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 500) }; }
  return { ok: r.ok, status: r.status, body };
}
export async function sendArcus(base, d) {
  assertTradeOnly('arcus', d);
  const qs = d.query ? '?' + new URLSearchParams(d.query).toString() : '';
  const send = d.method && d.method !== 'GET';
  return timedFetch(base + d.path + qs, { method: d.method, headers: d.headers, body: d.body ?? undefined }, send ? sendTimeoutMs() : readTimeoutMs(), { send, what: 'Arcus ' + (d.method || 'GET') + ' ' + d.path });
}
export async function sendHl(base, d) {
  return timedFetch(base + d.path, { method: 'POST', headers: d.headers, body: d.body }, sendTimeoutMs(), { send: true, what: 'HL ' + d.path });
}
// ---------------- Arcus reads (public)
export async function arcusGet(base, path, params = {}) {
  const q = Object.entries(params).filter(([, v]) => v != null);
  const r = await timedFetch(base + path + (q.length ? '?' + new URLSearchParams(q).toString() : ''), {}, readTimeoutMs(), { what: 'Arcus GET ' + path });
  if (!r.ok) throw new Error(`Arcus HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body;
}
export async function arcusMarket(base, name) {
  const ms = (await arcusGet(base, '/v1/markets')).markets;
  const m = ms.find((x) => x.marketDisplayName.toUpperCase() === name.toUpperCase() || String(x.marketId) === String(name)
    || x.marketDisplayName.toUpperCase() === (name.toUpperCase() + '-USD'));
  if (!m) throw new Error('Unknown Arcus market: ' + name);
  return m;
}
export async function arcusClockOffsetMs(base) {
  const t0 = Date.now(); const r = await arcusGet(base, '/v1/time'); const t1 = Date.now();
  return Number(BigInt(r.timeNs) / 1000000n) - (t0 + t1) / 2;
}
export async function arcusPositions(base, address, ai) {
  const ps = (await arcusGet(base, '/v1/positions', { address, accountIndex: ai })).positions || [];
  return (Array.isArray(ps) ? ps : Object.values(ps)).filter((p) => Number(p.size) !== 0);
}
export const arcusAccount = (base, address, ai) => arcusGet(base, '/v1/account', { address, accountIndex: ai });
export const arcusOpenOrders = async (base, address, ai) => (await arcusGet(base, '/v1/openOrders', { address, accountIndex: ai })).orders || [];
export const arcusApiKeys = async (base, address) => (await arcusGet(base, '/v1/apiKeys', { address })).apiKeys || [];
// ---------------- Hyperliquid reads
export async function hlInfo(base, body) {
  const r = await timedFetch(base + '/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, readTimeoutMs(), { what: 'HL info ' + (body && body.type) });
  if (!r.ok) throw new Error(`HL HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body;
}
export async function hlMarket(base, coin) {
  const dex = H.dexOf(coin);
  const [meta, ctxs] = await hlInfo(base, dex ? { type: 'metaAndAssetCtxs', dex } : { type: 'metaAndAssetCtxs' });
  const perpDexs = dex ? await hlInfo(base, { type: 'perpDexs' }) : [null];
  const idx = meta.universe.findIndex((u) => u.name === coin);
  if (idx < 0) throw new Error('Unknown HL market: ' + coin);
  const u = meta.universe[idx], c = ctxs[idx];
  return { coin, dex, asset: H.assetId(coin, meta.universe, perpDexs), szDecimals: u.szDecimals, maxLeverage: u.maxLeverage,
    onlyIsolated: !!u.onlyIsolated, markPx: Number(c.markPx), midPx: Number(c.midPx || c.markPx), isDelisted: !!u.isDelisted };
}
export const hlState = (base, user, dex) => hlInfo(base, dex ? { type: 'clearinghouseState', user, dex } : { type: 'clearinghouseState', user });
export const hlOpenOrders = (base, user, dex) => hlInfo(base, dex ? { type: 'frontendOpenOrders', user, dex } : { type: 'frontendOpenOrders', user });
export const hlUserRole = (base, user) => hlInfo(base, { type: 'userRole', user });
