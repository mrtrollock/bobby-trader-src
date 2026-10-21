// Arcus request builders: a line-by-line port of reference/arcus.py (signing + order construction).
// Pure functions: they return request descriptors {method, path, query, headers, body}; sending is separate.
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { pyJson } from './canon.js';
import * as D from './dec.js';

export const MAINNET = 'https://api.arcus.xyz';
export const TESTNET = 'https://api.testnet.arcus.xyz';
export const OP_PLACE = 1, OP_CANCEL = 2, OP_MODIFY = 3, OP_PLACE_UNTRIGGERED = 4;
export const SIDE = { BUY: 0, SELL: 1 };
export const TIF = { GTT: 0, FOK: 1, IOC: 2, ALO: 3 };
export const canonical = (o) => pyJson(o, true);

export function keyFromHex(hex) {
  let raw = String(hex || '').trim();
  if (raw.startsWith('0x')) raw = raw.slice(2);
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new Error('Invalid Arcus key (64 hex characters expected)');
  return hexToBytes(raw.toLowerCase());
}
export const apiKeyOf = (priv) => bytesToHex(ed25519.getPublicKey(priv));
export const signHex = (priv, msg) => bytesToHex(ed25519.sign(new TextEncoder().encode(msg), priv));

// ctx = { priv (Uint8Array), address, accountIndex, nowNs: () => BigInt, nowUs: () => BigInt }
export function makeCtx({ priv, address, accountIndex = 0, nowNs, nowUs }) {
  const ns = nowNs || (() => BigInt(Date.now()) * 1000000n);
  return { priv, address, accountIndex: Number(accountIndex), nowNs: ns, nowUs: nowUs || (() => ns() / 1000n), apiKey: apiKeyOf(priv) };
}
const goodTilUs = (ctx, days = 40) => ctx.nowUs() + BigInt(days) * 86400n * 1000000n; // >= 1 month (required)

function req(ctx, path, body, headers) {
  return { method: 'POST', path, query: { address: ctx.address }, body: body == null ? null : canonical(body),
    headers: { 'Content-Type': 'application/json', 'X-API-Key': ctx.apiKey, ...headers } };
}

export function tickFor(m, price) {
  // tickTiers (if present) give a coarser tick at high prices; tickSize stays the integer unit (as in arcus.py)
  if (Array.isArray(m.tickTiers) && m.tickTiers.length && price != null) {
    for (const t of m.tickTiers) if (t.upToPrice == null || D.cmp(price, t.upToPrice) <= 0) return t.tick;
  }
  return m.tickSize;
}

export function orderPayload(ctx, op, m, ts, side, price, qty, tif, reduceOnly, gUs, clientId) {
  const d = { ad: ctx.address.toLowerCase(), ai: ctx.accountIndex, ct: ts, g: gUs * 1000n, m: m.marketId, op,
    p: D.units(price, m.tickSize), q: D.units(qty, m.stepSize), r: reduceOnly ? 1 : 0, s: SIDE[side], t: TIF[tif], v: 1 };
  if (clientId) d.c = clientId;
  return canonical(d);
}

export function orderBody(ctx, m, ts, side, orderType, qty, price, tif, reduceOnly, gUs, clientId, extra = {}) {
  const b = { address: ctx.address, accountIndex: ctx.accountIndex, marketId: m.marketId, orderSide: side, orderType,
    quantity: String(qty), price: String(price), timeInForce: tif, goodTilTime: gUs.toString(), timestamp: ts, reduceOnly };
  if (clientId) b.clientId = clientId;
  return Object.assign(b, extra);
}

export function protectivePrice(m, side, refPrice, slippage) {
  if (!(slippage > 0 && slippage < 0.10)) throw new Error('slippage must be in (0, 0.10)');
  // tier tick of the target price (a price in a coarser tickTiers band must be a multiple of that band's tick; the
  // signed integer still uses the top-level tickSize, see orderPayload)
  const raw = side === 'BUY' ? D.mul(refPrice, D.add('1', String(slippage))) : D.mul(refPrice, D.sub('1', String(slippage)));
  return D.snap(raw, tickFor(m, raw), side === 'BUY' ? 'floor' : 'ceil');
}

// ---- builders mirroring arcus.py mutating functions
export function marketOrder(ctx, m, side, qty, { slippage = 0.02, reduceOnly = false, clientId = null } = {}) {
  const price = protectivePrice(m, side, m.markPrice, slippage);
  const ts = ctx.nowNs(), g = goodTilUs(ctx);
  const payload = orderPayload(ctx, OP_PLACE, m, ts, side, price, qty, 'IOC', reduceOnly, g, clientId);
  const body = orderBody(ctx, m, ts, side, 'MARKET', qty, price, 'IOC', reduceOnly, g, clientId);
  return req(ctx, '/v1/placeOrder', body, { 'X-Timestamp': ts.toString(), 'X-Signature': signHex(ctx.priv, payload) });
}

export function closePosition(ctx, m, position, { slippage = 0.02 } = {}) {
  const size = String(position.size).trim().replace(/^[-+]/, '');
  const side = ['LONG', 'BUY'].includes(String(position.side).toUpperCase()) ? 'SELL' : 'BUY';
  return marketOrder(ctx, m, side, size, { slippage, reduceOnly: true });
}

function tpslLegs(ctx, m, ts, g, closeSide, qty, tp, sl, slippage) {
  const legs = [];
  for (const [kind, trig] of [['TAKE_PROFIT', tp], ['STOP_LOSS', sl]]) {
    if (trig == null || trig === '') continue;
    const stop = D.snap(String(trig), tickFor(m, String(trig)), 'floor');
    const price = protectivePrice(m, closeSide, stop, slippage);
    const payload = orderPayload(ctx, OP_PLACE_UNTRIGGERED, m, ts, closeSide, price, qty, 'IOC', true, g);
    const body = orderBody(ctx, m, ts, closeSide, 'MARKET', String(qty), price, 'IOC', true, g, null, { tpslType: kind, stopPrice: String(stop) });
    body.signature = signHex(ctx.priv, payload);
    legs.push(body);
  }
  return legs;
}

export function positionTpsl(ctx, m, positionSide, { takeProfit = null, stopLoss = null, slippage = 0.05 } = {}) {
  const closeSide = ['LONG', 'BUY'].includes(String(positionSide).toUpperCase()) ? 'SELL' : 'BUY';
  const ts = ctx.nowNs(), g = goodTilUs(ctx);
  const orders = tpslLegs(ctx, m, ts, g, closeSide, 0, takeProfit, stopLoss, slippage);
  if (!orders.length) throw new Error('need take_profit and/or stop_loss');
  return req(ctx, '/v1/batchPlaceOrders', { grouping: 'positionTpsl', orders },
    { 'X-Timestamp': ts.toString(), 'X-Signature': orders[0].signature });
}

// Entry + bound TP/SL children (grouping entryTpsl). Same per-leg signing as positionTpsl in arcus.py:
// entry leg op=1, TPSL children op=4, every leg's ct == shared X-Timestamp; children sized to the entry quantity.
export function entryTpsl(ctx, m, side, qty, { type = 'market', limitPrice = null, takeProfit = null, stopLoss = null,
  slippage = 0.02, tpslSlippage = 0.05, clientId = null, postOnly = false } = {}) {
  const ts = ctx.nowNs(), g = goodTilUs(ctx);
  let price, orderType, tif;
  if (type === 'market') { price = protectivePrice(m, side, m.markPrice, slippage); orderType = 'MARKET'; tif = 'IOC'; }
  else { price = D.snap(String(limitPrice), tickFor(m, limitPrice), side === 'BUY' ? 'floor' : 'ceil'); orderType = 'LIMIT'; tif = postOnly ? 'ALO' : 'GTT'; }
  const payload = orderPayload(ctx, OP_PLACE, m, ts, side, price, qty, tif, false, g, clientId);
  const entry = orderBody(ctx, m, ts, side, orderType, qty, price, tif, false, g, clientId);
  entry.signature = signHex(ctx.priv, payload);
  const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
  const legs = tpslLegs(ctx, m, ts, g, closeSide, qty, takeProfit, stopLoss, tpslSlippage);
  const orders = [entry, ...legs];
  if (!legs.length) { delete entry.signature; return req(ctx, '/v1/placeOrder', entry, { 'X-Timestamp': ts.toString(), 'X-Signature': signHex(ctx.priv, payload) }); }
  return req(ctx, '/v1/batchPlaceOrders', { grouping: 'entryTpsl', orders }, { 'X-Timestamp': ts.toString(), 'X-Signature': entry.signature });
}

export function limitOrder(ctx, m, side, qty, price, { reduceOnly = false, clientId = null } = {}) {
  const ts = ctx.nowNs(), g = goodTilUs(ctx);
  const payload = orderPayload(ctx, OP_PLACE, m, ts, side, price, qty, 'GTT', reduceOnly, g, clientId);
  const body = orderBody(ctx, m, ts, side, 'LIMIT', qty, price, 'GTT', reduceOnly, g, clientId);
  return req(ctx, '/v1/placeOrder', body, { 'X-Timestamp': ts.toString(), 'X-Signature': signHex(ctx.priv, payload) });
}

export function cancelOrder(ctx, m, orderId) {
  const ts = ctx.nowNs();
  const payload = canonical({ ad: ctx.address.toLowerCase(), ai: ctx.accountIndex, ct: ts, id: orderId, m: m.marketId, op: OP_CANCEL, v: 1 });
  const body = { address: ctx.address, accountIndex: ctx.accountIndex, marketId: m.marketId, kind: 'orderId', orderId, timestamp: ts };
  return req(ctx, '/v1/cancelOrder', body, { 'X-Timestamp': ts.toString(), 'X-Signature': signHex(ctx.priv, payload) });
}

export function setLeverage(ctx, m, leverage, isolated = null) {
  const body = { address: ctx.address, accountIndex: ctx.accountIndex, marketId: m.marketId, leverage: Math.trunc(Number(leverage)) };
  if (isolated !== null && isolated !== undefined) body.isolated = !!isolated;
  const ts = ctx.nowNs();
  const sig = signHex(ctx.priv, `${ts}setLeverage${canonical(body)}`);
  return req(ctx, '/v1/setLeverage', body, { 'X-Timestamp': ts.toString(), 'X-Signature': sig });
}

// Scheme-2 signed GET (read-only) used to verify the key: /v1/affiliate/code
export function signedGet(ctx, path) {
  const ts = ctx.nowNs();
  const action = path.replace(/\/+$/, '').split('/').pop();
  return { method: 'GET', path, query: { address: ctx.address }, body: null,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': ctx.apiKey, 'X-Timestamp': ts.toString(), 'X-Signature': signHex(ctx.priv, `${ts}${action}`) } };
}

export function maxLeverage(m) {
  const imf = Number(m.isOutsideRth ? (m.offHoursInitialMarginFraction || m.initialMarginFraction) : m.initialMarginFraction);
  return imf > 0 ? Math.floor(1 / imf + 1e-9) : 1;
}
export function makerFee(m) {
  const ppm = Number(m.effectiveMakerFeePpm ?? m.baseMakerFeePpm);
  return Number.isFinite(ppm) ? ppm / 1e6 : null; // may be 0 (beta) or negative (rebate)
}
export function takerFee(m) {
  const ppm = Number(m.effectiveTakerFeePpm ?? m.baseTakerFeePpm);
  return Number.isFinite(ppm) && ppm > 0 ? ppm / 1e6 : 0.000213;
}
export function qtyFloor(m, qty) { return D.normalize(D.snap(String(qty), m.stepSize, 'floor')); }

// ---- TP/SL replacement (Arcus rejects a 2nd position-level TPSL with POSITION_TPSL_ALREADY_EXISTS; modify is not
// supported on TPSL legs, so "replace" = cancel the old legs, then place the new positionTpsl).
export const isLongSide = (s) => ['LONG', 'BUY'].includes(String(s).toUpperCase());
export const tpslStop = (m, trig) => D.normalize(D.snap(String(trig), tickFor(m, String(trig)), 'floor'));
const has = (x) => x != null && x !== '';
const live = (o) => o && o.tpslType && (o.status == null || o.status === 'UNTRIGGERED');

// orders = /v1/openOrders rows. Plan:
//  - cancelFirst: every position-level leg on the market (they block the new placement). The untouched leg type is
//    carried over (same trigger) so replacing only the SL keeps the existing TP, and vice versa.
//  - place: the positionTpsl to send once cancelFirst is gone.
//  - cancelAfter: entry-linked legs (parentOrderId) of the replaced types; they don't block placement, so they are
//    cancelled only AFTER the new legs are live (the position is never left without a SL by them).
//  - restore: the previous position-level triggers (used to put the old SL/TP back if the placement fails).
export function planTpslReplace(orders, marketId, { takeProfit = null, stopLoss = null } = {}) {
  const types = [];
  if (has(takeProfit)) types.push('TAKE_PROFIT');
  if (has(stopLoss)) types.push('STOP_LOSS');
  if (!types.length) throw new Error('need take_profit and/or stop_loss');
  const legs = (orders || []).filter((o) => live(o) && String(o.marketId) === String(marketId));
  const pos = legs.filter((o) => o.isPositionTPSL === true);
  const linked = legs.filter((o) => o.isPositionTPSL !== true);
  const trig = (xs, t) => { const o = xs.find((x) => x.tpslType === t); return o ? String(o.triggerPrice) : null; };
  const restore = { tp: trig(pos, 'TAKE_PROFIT'), sl: trig(pos, 'STOP_LOSS') };
  const place = { tp: has(takeProfit) ? String(takeProfit) : restore.tp, sl: has(stopLoss) ? String(stopLoss) : restore.sl };
  const carried = { tp: !has(takeProfit) && restore.tp != null, sl: !has(stopLoss) && restore.sl != null };
  const current = { tp: legs.filter((o) => o.tpslType === 'TAKE_PROFIT').map((o) => String(o.triggerPrice)),
    sl: legs.filter((o) => o.tpslType === 'STOP_LOSS').map((o) => String(o.triggerPrice)) };
  return { types, cancelFirst: pos, cancelAfter: linked.filter((o) => types.includes(o.tpslType)), place, carried, restore, current,
    replaces: pos.length > 0 || linked.some((o) => types.includes(o.tpslType)) };
}

// True when the open orders show live position-level legs at the planned triggers.
export function tpslPlaced(orders, m, place) {
  const pos = (orders || []).filter((o) => live(o) && o.isPositionTPSL === true && String(o.marketId) === String(m.marketId));
  const ok = (t, v) => !has(v) || pos.some((o) => o.tpslType === t && D.cmp(String(o.triggerPrice), tpslStop(m, v)) === 0);
  return ok('TAKE_PROFIT', place.tp) && ok('STOP_LOSS', place.sl);
}
export const hasStopLoss = (orders, marketId) => (orders || []).some((o) => live(o) && o.tpslType === 'STOP_LOSS' && String(o.marketId) === String(marketId));
