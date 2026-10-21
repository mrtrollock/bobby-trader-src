import * as A from './arcus.js';
import * as H from './hl.js';
import * as API from './api.js';
import { computeRisk, FEES, MAX_LOSS, POLICY, checkPolicy, weekStartUtc, weekEndUtc, realizedLoss, policyFor } from './risk.js';
import * as F from './fees.js';
import * as T from './txflow.js';
import * as Q from './qfex.js';
import { extractToken, decodeProposal } from './proposal.js';
import * as KS from './keystore.js';
import { runTpslReplace, legLabel } from './replace.js';
import { openJson } from './vault.js';

const LAUNCH_URL = window.__LAUNCH_URL || location.href;
const DEFAULTS = { dryRun: true, testnet: false, maxLoss: MAX_LOSS, slippage: 0.02, feeArcus: FEES.arcus, feeIo: FEES.hl_io,
  feeMain: FEES.hl_main, arcusAddress: '', arcusSub: 0, hlMaster: '', hlDexes: 'io', txflowAddress: '',
  // conservative farming policy (hard blocks), see src/risk.js POLICY
  polMakerOnly: POLICY.makerOnly, polMaxLev: POLICY.maxLeverage, polRequireSl: POLICY.requireStopLoss, polMaxLossPct: POLICY.maxLossPct,
  polWeeklyCap: POLICY.weeklyLossCap, capArcus: POLICY.capital.arcus, capHl: POLICY.capital.hl, capTxflow: POLICY.capital.txflow, capQfex: POLICY.capital.qfex };
const policy = () => { const st = S.settings; return { ...POLICY, makerOnly: !!st.polMakerOnly, maxLeverage: Number(st.polMaxLev), requireStopLoss: !!st.polRequireSl,
  maxLossPct: Number(st.polMaxLossPct), weeklyLossCap: Number(st.polWeeklyCap), capital: { arcus: Number(st.capArcus), hl: Number(st.capHl), txflow: Number(st.capTxflow), qfex: Number(st.capQfex) } }; };
const PF_NAME = { arcus: '🏹 Arcus', hl: '🤖 Entropy / Hyperliquid', txflow: '🌊 TxFlow', qfex: '📈 QFEX' };
const S = { settings: { ...DEFAULTS }, secrets: null, lockTimer: null, log: [], view: 'briefing', proposal: null, viewPass: null, data: null, pendingTok: null };
const LOCK_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------- tiny DOM helper
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const $app = () => document.getElementById('app');
const fmt = (x, d = 2) => (x == null || !Number.isFinite(Number(x)) ? '—' : Number(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmtPx = (x) => (x == null ? '—' : Number(x).toLocaleString('en-US', { maximumSignificantDigits: 7 }));
const haptic = (t) => { try { navigator.vibrate && navigator.vibrate(t === 'success' ? 40 : [60, 40, 60]); } catch { /* */ } };
function toast(msg, kind = 'info') {
  const t = h('div', { class: 'toast ' + kind }, msg); document.body.append(t); setTimeout(() => t.remove(), 3500);
}
function confirmDialog(msg) {
  return Promise.resolve(window.confirm(msg));
}

// ---------------------------------------------------------------- persistence (non-secret)
async function loadSettings() {
  try { const b = await KS.deviceBackend(); const s = await b.get('tgtrade_settings'); if (s) S.settings = { ...DEFAULTS, ...JSON.parse(s) }; } catch { /* */ }
  try { const b = await KS.deviceBackend(); const l = await b.get('tgtrade_log'); if (l) S.log = JSON.parse(l); } catch { /* */ }
}
async function saveSettings() { const b = await KS.deviceBackend(); await b.set('tgtrade_settings', JSON.stringify(S.settings)); }
async function addLog(entry) {
  S.log.unshift(entry); S.log = S.log.slice(0, 200);
  try { const b = await KS.deviceBackend(); await b.set('tgtrade_log', JSON.stringify(S.log)); } catch (e) { toast('Journal not saved: ' + e.message, 'err'); }
}
const base = () => ({ ...API.bases(S.settings.testnet), txflow: S.settings.testnet ? T.TESTNET : T.MAINNET, qfex: Q.bases(S.settings.testnet) });

// ---------------------------------------------------------------- weekly realized loss per platform (Mon 00:00 UTC)
const lossCache = {};
async function weeklyLoss(pf) {
  const st = S.settings, from = weekStartUtc(), key = pf + from + st.testnet;
  if (lossCache[key] && Date.now() - lossCache[key].t < 60e3) return lossCache[key].v;
  let v;
  if (pf === 'arcus') {
    if (!st.arcusAddress) return null;
    const r = await API.arcusGet(base().arcus, '/v1/fills', { address: st.arcusAddress, accountIndex: st.arcusSub, from: from * 1000, limit: 1000 });
    v = realizedLoss((r.fills || []).map((f) => ({ time: Number(f.createdAt) / 1000, closedPnl: f.closedPnl, fee: f.fee })), from, Infinity, { feeIncluded: true });
  } else if (pf === 'hl') {
    if (!st.hlMaster) return null;
    const rows = await API.hlInfo(base().hl, { type: 'userFillsByTime', user: st.hlMaster, startTime: from });
    v = realizedLoss(rows, from);
  } else if (pf === 'qfex') {
    return null; // private data: QFEX's weekly cap is enforced by the autotrader (it holds the key); here: local journal only
  } else {
    if (!st.txflowAddress) return null;
    v = realizedLoss(await T.fills(base().txflow, st.txflowAddress, from, Date.now() + 60e3), from);
  }
  lossCache[key] = { t: Date.now(), v }; return v;
}
// Fallback when fills cannot be read: SL risk of trades sent (not dry) this week, from the local journal.
const journalRisk = (pf) => S.log.filter((e) => e.pf === pf && e.act === 'open' && !e.dry && e.ok && Date.parse(e.t) >= weekStartUtc())
  .reduce((a, e) => a + (Number(e.slLoss) || 0), 0);

// ---------------------------------------------------------------- keys / PIN
function lockNow() { S.secrets = null; clearTimeout(S.lockTimer); }
function touchLock() { clearTimeout(S.lockTimer); S.lockTimer = setTimeout(() => { lockNow(); render(); }, LOCK_MS); }
function askPin(title = 'PIN code') {
  return new Promise((res) => {
    const inp = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', class: 'pin', placeholder: '••••••' });
    const close = (v) => { ov.remove(); res(v); };
    const ov = h('div', { class: 'overlay' }, h('div', { class: 'modal' }, h('h2', {}, title), inp,
      h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: () => close(null) }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => close(inp.value) }, 'Confirm'))));
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') close(inp.value); });
    document.body.append(ov); setTimeout(() => inp.focus(), 50);
  });
}
async function ensureUnlocked() {
  if (S.secrets) { touchLock(); return S.secrets; }
  if (!(await KS.hasKeystore())) throw new Error('No keys saved. Go to Settings.');
  const pin = await askPin('Unlock keys');
  if (!pin) throw new Error('Cancelled');
  const busy = showBusy('Decrypting…');
  try { S.secrets = await KS.loadKeystore(pin); } finally { busy(); }
  touchLock(); return S.secrets;
}
function showBusy(msg) { const o = h('div', { class: 'overlay' }, h('div', { class: 'modal center' }, h('div', { class: 'spin' }), msg)); document.body.append(o); return () => o.remove(); }

function arcusCtx(sec, offsetMs = 0) {
  const priv = A.keyFromHex(sec.arcus.key);
  return A.makeCtx({ priv, address: sec.arcus.address, accountIndex: sec.arcus.sub,
    nowNs: () => BigInt(Math.round(Date.now() + offsetMs)) * 1000000n + BigInt(Math.floor(Math.random() * 1000)) });
}

// ---------------------------------------------------------------- market context for a proposal
async function loadContext(p) {
  const st = S.settings;
  if (p.pf === 'arcus') {
    const m = await API.arcusMarket(base().arcus, p.m);
    let free = null, pos = null;
    try { free = Number((await API.arcusAccount(base().arcus, st.arcusAddress, st.arcusSub)).freeCollateral); } catch { /* */ }
    try { pos = (await API.arcusPositions(base().arcus, st.arcusAddress, st.arcusSub)).find((x) => x.marketId === m.marketId) || null; } catch { /* */ }
    let plan, planErr;
    if (p.act === 'tpsl') {
      try { plan = A.planTpslReplace(await API.arcusOpenOrders(base().arcus, st.arcusAddress, st.arcusSub), m.marketId, { takeProfit: p.tp, stopLoss: p.sl }); }
      catch (e) { planErr = e.message; }
    }
    let stats = null; try { if (st.arcusAddress) stats = await API.arcusGet(base().arcus, '/v1/account/stats', { address: st.arcusAddress, include: 'feeTier' }); } catch { /* */ }
    const fr = F.arcusRates(m, stats, null);
    return { pf: 'arcus', m, mark: Number(m.markPrice), maxLev: A.maxLeverage(m), fee: fr.taker || st.feeArcus, makerFee: fr.maker, feeSrc: fr.source,
      mmf: Number(m.maintenanceMarginFraction), size: Number(p.act === 'open' ? A.qtyFloor(m, p.sz) : 0), sizeStr: p.act === 'open' ? A.qtyFloor(m, p.sz) : '0',
      minNotional: Number(m.minOrderNotional || 0), minSize: Number(m.minOrderSize || 0), free, pos, status: m.status, plan, planErr,
      order: p.act === 'cancel' ? (await API.arcusOpenOrders(base().arcus, st.arcusAddress, st.arcusSub)).find((o) => String(o.orderId) === String(p.oid)) || null : undefined };
  }
  if (p.pf === 'txflow') return loadTxflow(p);
  if (p.pf === 'qfex') return loadQfex(p);
  const mk = await API.hlMarket(base().hl, p.m);
  let free = null, pos = null;
  if (st.hlMaster) {
    try { const s = await API.hlState(base().hl, st.hlMaster, mk.dex); free = Number(s.withdrawable);
      try { const ad = await API.hlInfo(base().hl, { type: 'activeAssetData', user: st.hlMaster, coin: p.m }); const at = (ad.availableToTrade || []).map(Number); if (at.length === 2) free = p.sd === 'short' ? at[1] : at[0]; } catch { /* */ }
      const ap = (s.assetPositions || []).map((x) => x.position).find((x) => x.coin === p.m); pos = ap || null; } catch { /* */ }
  }
  let order;
  if (p.act === 'cancel') order = (await API.hlOpenOrders(base().hl, st.hlMaster, mk.dex)).find((o) => String(o.oid) === String(p.oid)) || null;
  let fr = mk.dex ? { maker: st.feeIo, taker: st.feeIo, source: 'setting (HIP-3)' } : { maker: F.FALLBACK.hl_main.maker, taker: st.feeMain, source: 'default' };
  if (!mk.dex && st.hlMaster) { try { fr = F.userFeesRates(await API.hlInfo(base().hl, { type: 'userFees', user: st.hlMaster }), fr); } catch { /* */ } }
  return { pf: 'hl', mk, order, mark: mk.markPx, maxLev: mk.maxLeverage, fee: fr.taker, makerFee: fr.maker, feeSrc: fr.source, mmf: 1 / (2 * mk.maxLeverage),
    size: p.act === 'open' ? H.roundSz(p.sz, mk.szDecimals) : 0, free, pos };
}

async function loadTxflow(p) {
  const st = S.settings, B = base().txflow;
  const mk = await T.market(B, p.m);
  const ctx = await T.assetCtx(B, mk.index);
  let fr = { ...F.FALLBACK.txflow, source: 'default' }, free = null, chs = null, oo = [];
  if (st.txflowAddress) {
    try { fr = F.userFeesRates(await T.userFees(B, st.txflowAddress, mk.index), fr); } catch { /* */ }
    try { chs = await T.state(B, st.txflowAddress); free = Number(chs.withdrawable); } catch { /* */ }
    try { oo = await T.openOrders(B, st.txflowAddress); } catch { /* */ }
  }
  const size = Number(p.sz);
  return { pf: 'txflow', mk, mark: Number(ctx.markPx || (ctx.nodeCtx && ctx.nodeCtx.markPx)), maxLev: Number(mk.maxLeverage), fee: fr.taker, makerFee: fr.maker,
    feeSrc: fr.source, mmf: 1 / (2 * Number(mk.maxLeverage || 1)), size, free, chs, oo, halted: !!mk.haltTrading };
}
// QFEX in the browser: public mark + best bid/ask from the MDS WebSocket only (QFEX REST sends no CORS headers, and the
// HMAC secret never enters the browser). Fees come from the published schedule; the stop leg is charged taker + slippage.
async function loadQfex(p) {
  const sym = Q.normSymbol(p.m), cat = Q.categoryOf(sym);
  const q = await Q.mdsQuote(base().qfex, sym);
  const fr = Q.rates(cat, null);
  const maxLev = 10; // conservative (QFEX defaults: 10x stocks, up to 30x indices/commodities); only used for the liq. estimate at 1x
  return { pf: 'qfex', sym, category: cat, mark: q.mark, bid: q.bid, ask: q.ask, maxLev, mmf: 1 / (2 * maxLev), fee: fr.stopRate, makerFee: fr.maker,
    taker: fr.taker, slippage: fr.slippage, feeSrc: fr.source + ', ' + cat, size: Number(p.sz), free: null };
}
async function withPolicy(p, c, r) {
  let used = null, src = 'fills';
  try { used = await weeklyLoss(p.pf); } catch { used = null; }
  if (used == null) { used = journalRisk(p.pf); src = 'journal'; }
  const pol = checkPolicy(p, r, { policy: policyFor(p.pf, policy()), weeklyLossUsed: used, freeCollateral: c.free });
  r.blocks.push(...pol.blocks);
  if (src === 'journal' && p.act === 'open') r.warns.push(p.pf === 'qfex' ? 'QFEX weekly losses are private: the autotrader checks the $' + policyFor('qfex', policy()).weeklyLossCap + ' cap from fills before sending (local journal estimate shown)'
    : 'Weekly losses could not be read: estimated from the local journal');
  r.policy = { ...pol, src };
  return r;
}

function riskFor(p, c) {
  if (p.act === 'cancel') return { blocks: c.order ? [] : ['Order not found (already cancelled or filled?)'], warns: [] };
  if (p.act === 'tpsl') {
    if (!c.pos) return { blocks: ['No open position on this market'], warns: [] };
    const isLong = c.pf === 'arcus' ? ['LONG', 'BUY'].includes(String(c.pos.side).toUpperCase()) : Number(c.pos.szi) > 0;
    const size = Math.abs(Number(c.pf === 'arcus' ? c.pos.size : c.pos.szi));
    const entry = Number(c.pf === 'arcus' ? c.pos.averageEntryPrice : c.pos.entryPx);
    const lev = Number(c.pf === 'arcus' ? c.pos.leverage : (c.pos.leverage && c.pos.leverage.value)) || 1;
    const tgt = c.pf === 'arcus' && c.plan ? c.plan.place : { sl: p.sl, tp: p.tp };
    const r = computeRisk({ mode: 'tpsl', isLong, size, leverage: lev, mark: c.mark, type: 'limit', limitPx: entry, feeRate: c.fee, mmf: c.mmf,
      sl: tgt.sl != null ? Number(tgt.sl) : null, tp: tgt.tp != null ? Number(tgt.tp) : null, expiry: p.exp, maxLoss: S.settings.maxLoss });
    r.blocks = r.blocks.filter((b) => !b.startsWith('Leverage'));
    if (c.pf === 'arcus' && !c.plan) r.blocks.push('Could not read open orders (' + (c.planErr || '?') + '): TP/SL replacement is not safe');
    r.keepsStop = c.pf === 'arcus' ? !!(c.plan && c.plan.place.sl != null) : (p.sl != null ? true : null);
    if (c.pf !== 'arcus' && p.sl == null) r.warns.push('No SL in this proposal: make sure a stop already exists');
    return { ...r, isLong, size, entryLabel: 'Position entry' };
  }
  const isLong = p.sd === 'long';
  const r = computeRisk({ isLong, size: c.size, leverage: Number(p.lev), mark: c.mark, type: p.et, limitPx: p.px, feeRate: c.fee,
    entryFeeRate: p.et === 'limit' && S.settings.polMakerOnly && c.makerFee != null ? Math.max(0, c.makerFee) : undefined,
    mmf: c.mmf, maxLev: c.maxLev, sl: p.sl != null ? Number(p.sl) : null, tp: p.tp != null ? Number(p.tp) : null,
    ref: p.ref != null ? Number(p.ref) : (p.et === 'market' ? null : null), expiry: p.exp, freeCollateral: c.free, maxLoss: S.settings.maxLoss });
  if (p.et === 'market' && p.ref == null) r.warns.push('No reference price in the proposal (1% drift check not possible)');
  if (c.pf === 'arcus') {
    if (c.status && c.status !== 'ONLINE') r.blocks.push('Arcus market ' + c.status);
    if (c.minSize && c.size < c.minSize) r.blocks.push(`Size < minimum (${c.minSize})`);
    if (c.minNotional && r.notional < c.minNotional) r.blocks.push(`Notional < minimum ($${c.minNotional})`);
  } else if (c.pf === 'txflow') {
    if (c.halted) r.blocks.push('TxFlow market halted');
  } else if (c.pf === 'qfex') {
    if (!(c.mark > 0)) r.blocks.push('No QFEX mark price');
    if (p.et !== 'limit') r.blocks.push('QFEX: post-only limit (ALO) entries only');
    if (p.sl == null || p.tp == null) r.blocks.push('QFEX: stop-loss and take-profit are both required');
    if (Number(p.lev) !== 1) r.blocks.push('QFEX: 1× leverage only');
    if (isLong ? c.ask != null && Number(p.px) >= c.ask : c.bid != null && Number(p.px) <= c.bid)
      r.blocks.push('Maker policy: the limit price would cross the best ' + (isLong ? 'ask' : 'bid') + ' (ALO would be rejected)');
    if (!Q.PREFERRED_CATEGORIES.includes(c.category)) r.warns.push(`QFEX single stock: fees are 2.5× higher than indices/commodities (maker ${fmt(c.makerFee * 100, 3)}%, stop leg ${fmt(c.fee * 100, 3)}%)`);
    r.warns.push('Tick/lot rounding, price band, free collateral and the weekly loss from fills are re-checked by the autotrader before sending');
  } else if (c.mk.isDelisted) r.blocks.push('Market delisted');
  if (p.et === 'limit' && S.settings.polMakerOnly && c.mark) {
    const crosses = isLong ? Number(p.px) >= c.mark : Number(p.px) <= c.mark;
    if (crosses) r.blocks.push('Maker policy: the limit price would cross the book (taker), post-only would be rejected');
  }
  if (c.pos && Number(c.pf === 'arcus' ? c.pos.size : c.pos.szi) !== 0) r.warns.push('A position already exists on this market: TP/SL are sized for this new order only');
  return { ...r, isLong, size: c.size, entryLabel: p.et === 'limit' ? 'Limit price' : 'Entry (mark)' };
}

// ---------------------------------------------------------------- build (sign) requests
function buildRequests(p, c, sec, offsetMs) {
  const st = S.settings;
  if (p.pf === 'arcus') {
    if (!sec.arcus || !sec.arcus.key) throw new Error('Arcus key missing');
    const ctx = arcusCtx(sec, offsetMs), m = c.m;
    if (p.act === 'cancel') return [{ label: 'Cancel', d: A.cancelOrder(ctx, m, String(p.oid)) }];
    if (p.act === 'tpsl') return [{ label: 'TP/SL position', d: A.positionTpsl(ctx, m, c.pos.side, { takeProfit: p.tp, stopLoss: p.sl }) }];
    const side = p.sd === 'long' ? 'BUY' : 'SELL';
    return [
      { label: `Leverage ${p.lev}× isolated`, d: A.setLeverage(ctx, m, p.lev, true) },
      { label: 'Order + TP/SL (entryTpsl)', d: A.entryTpsl(ctx, m, side, c.sizeStr, { type: p.et, limitPrice: p.px, takeProfit: p.tp, stopLoss: p.sl, slippage: st.slippage, postOnly: !!st.polMakerOnly }) },
    ];
  }
  if (p.pf === 'qfex') throw new Error('QFEX: nothing is signed in the browser, use the autotrader queue');
  if (p.pf === 'txflow') throw new Error('TxFlow: manual mode, nothing is signed here');
  if (!sec.hl || !sec.hl.key) throw new Error('Hyperliquid key missing');
  const priv = H.keyFromHex(sec.hl.key), mk = c.mk, isMainnet = !st.testnet;
  let nonce = Date.now();
  const sign = (action) => H.exchangeRequest(priv, action, nonce++, { isMainnet });
  if (p.act === 'cancel') return [{ label: 'Cancel', d: sign(H.buildCancel(mk.asset, p.oid)) }];
  if (p.act === 'tpsl') return [{ label: 'TP/SL position', d: sign(H.buildPositionTpsl({ asset: mk.asset, szDecimals: mk.szDecimals, positionIsLong: Number(c.pos.szi) > 0, tp: p.tp, sl: p.sl })) }];
  const [lev, order] = H.buildOpen({ asset: mk.asset, szDecimals: mk.szDecimals, isBuy: p.sd === 'long', sz: p.sz, leverage: Number(p.lev),
    isCross: false, type: p.et, limitPx: p.px, markPx: mk.midPx || mk.markPx, tp: p.tp, sl: p.sl, slippage: st.slippage, postOnly: !!st.polMakerOnly });
  return [{ label: `Leverage ${p.lev}× isolated`, d: sign(lev) }, { label: 'Order + TP/SL (normalTpsl)', d: sign(order) }];
}

function hlError(body) {
  if (!body || body.status !== 'ok') return typeof body?.response === 'string' ? body.response : 'Response not ok';
  const st = body.response?.data?.statuses || [];
  const errs = st.filter((x) => x && x.error).map((x) => x.error);
  return errs.length ? errs.join(' | ') : null;
}
function arcusError(r) {
  if (!r.ok) return `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;
  if (r.body && !Array.isArray(r.body.responses) && ['ERROR', 'REJECTED'].includes(r.body.status)) return r.body.rejectionReason || r.body.error || r.body.status;
  const rows = r.body?.responses || [];
  const errs = rows.filter((x) => x && (x.status === 'ERROR' || x.status === 'REJECTED')).map((x) => x.error || x.rejectionReason || x.status);
  return errs.length ? errs.join(' | ') : null;
}
async function execute(pf, reqs) {
  const out = [];
  for (const r of reqs) {
    const res = pf === 'arcus' ? await API.sendArcus(base().arcus, r.d) : await API.sendHl(base().hl, r.d);
    const err = pf === 'arcus' ? arcusError(res) : (!res.ok ? `HTTP ${res.status}` : hlError(res.body));
    out.push({ label: r.label, status: res.status, ok: !err, error: err, body: res.body });
    if (err) break; // never send the order if leverage failed
  }
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function arcusTpslReplace(p, c, sec, dry) {
  const st = S.settings, m = c.m, plan = c.plan, B = base().arcus;
  const off = await API.arcusClockOffsetMs(B).catch(() => 0);
  const ctx = () => arcusCtx(sec, off);
  const mkPlace = () => A.positionTpsl(ctx(), m, c.pos.side, { takeProfit: plan.place.tp, stopLoss: plan.place.sl });
  const mkCancel = (id) => A.cancelOrder(ctx(), m, id);
  if (dry) {
    const reqs = [...plan.cancelFirst.map((o) => ({ label: '1. ' + legLabel(o), d: mkCancel(String(o.orderId)) })),
      { label: `2. New position TP/SL (SL ${plan.place.sl ?? '—'} · TP ${plan.place.tp ?? '—'})`, d: mkPlace() },
      ...plan.cancelAfter.map((o) => ({ label: '3. ' + legLabel(o), d: mkCancel(String(o.orderId)) }))];
    return { ok: true, results: [{ label: 'DRY RUN — not sent', ok: true, dry: true, payload: showPayload(reqs) }] };
  }
  return runTpslReplace({ plan, m, marketName: p.m, mkPlace, mkCancel, sleep,
    send: async (d) => { const res = await API.sendArcus(B, d); return { ok: res.ok, status: res.status, body: res.body, error: arcusError(res) }; },
    openOrders: () => API.arcusOpenOrders(B, st.arcusAddress, st.arcusSub) });
}
const showPayload = (reqs) => reqs.map((r) => ({ label: r.label, method: r.d.method, path: r.d.path, query: r.d.query,
  headers: r.d.headers, body: r.d.body ? JSON.parse(r.d.body.replace(/:(\d{16,})([,}])/g, ':"$1"$2')) : null }));

// ---------------------------------------------------------------- views
function header() {
  const st = S.settings;
  return h('header', {}, h('div', { class: 'brand', onclick: () => go('home') }, '⚡ Bobby Trade'),
    h('div', { class: 'badges' }, st.dryRun ? h('span', { class: 'badge warn' }, 'DRY RUN') : h('span', { class: 'badge live' }, 'LIVE'),
      st.testnet ? h('span', { class: 'badge' }, 'TESTNET') : null, h('span', { class: 'badge' }, S.secrets ? '🔓' : '🔒'),
      h('button', { class: 'badge lockbtn', id: 'lockapp', title: 'Lock the app', onclick: lockApp }, 'Lock')));
}
function go(v, extra) { if (v !== 'home' && v !== 'briefing' && (S.view === 'home' || S.view === 'briefing')) { try { history.pushState({ v }, ''); } catch { /* */ } } S.view = v; Object.assign(S, extra || {}); render(); window.scrollTo(0, 0); }
function render() {
  const app = $app();
  if (!S.viewPass) { app.replaceChildren(); viewLock(app); return; } // nothing else renders until the passphrase decrypted the data
  app.replaceChildren(header());
  const views = { briefing: viewBriefing, home: viewHome, inbox: viewInbox, balances: viewBalances, dash: viewDash, confirm: viewConfirm, settings: viewSettings, positions: viewPositions, log: viewLog };
  (views[S.view] || viewHome)(app);
  app.append(nav());
}

function nav() {
  const b = (v, ico, label) => h('button', { class: 'navbtn' + (S.view === v ? ' on' : ''), onclick: () => go(v, { result: null }) }, h('span', {}, ico), label);
  return h('nav', { class: 'bottom' }, b('briefing', '📰', 'Briefing'), b('inbox', '📥', 'Proposals'), b('balances', '💰', 'Balances'), b('dash', '📈', 'Dashboard'), b('positions', '📊', 'Positions'), b('settings', '⚙️', 'Settings'));
}
window.addEventListener('popstate', () => { if (S.view !== 'briefing') go('briefing', { result: null }); });

// ---------------------------------------------------------------- private data: every published file is *.enc.json (passphrase vault)
const DATA_FILES = { briefing: 'briefing.enc.json', proposals: 'proposals.enc.json', balances: 'balances.enc.json' };
const VP_KEY = 'bobby_viewpass_v1'; // optional "remember on this device": the passphrase encrypted with a PIN (same PBKDF2/AES-GCM as the keystore)
async function fetchSealed(name) {
  const r = await fetch('./' + name + '?t=' + Date.now(), { cache: 'no-store' });
  if (r.status === 404) return undefined;
  if (!r.ok) throw new Error(name + ': HTTP ' + r.status);
  return r.json();
}
// Fetch + decrypt everything. Throws 'Wrong passphrase' if any published file does not open with it.
async function loadVault(pass) {
  const out = {}; let found = 0;
  for (const [k, f] of Object.entries(DATA_FILES)) {
    const env = await fetchSealed(f);
    if (env === undefined) { out[k] = null; continue; }
    found++; out[k] = await openJson(env, pass);
  }
  if (!found) throw new Error('Nothing published yet (no encrypted data files on the site).');
  return out;
}
async function refreshData() { S.data = await loadVault(S.viewPass); return S.data; }
async function unlockWith(pass) {
  const busy = showBusy('Decrypting…');
  try { S.data = await loadVault(pass); S.viewPass = pass; } finally { busy(); }
  render();
  if (S.pendingTok) { const t = S.pendingTok; S.pendingTok = null; openProposal(t); }
}
function lockApp() { S.viewPass = null; S.data = null; lockNow(); S.view = 'briefing'; render(); }
function viewLock(app) {
  const pass = h('input', { type: 'password', id: 'viewpass', autocomplete: 'current-password', placeholder: 'Passphrase' });
  const remember = h('input', { type: 'checkbox', id: 'remember' });
  const err = h('div', { class: 'alert block hidden', id: 'lockerr' });
  const fail = (e) => { err.textContent = e.message === 'Wrong passphrase' ? 'Wrong passphrase.' : e.message; err.classList.remove('hidden'); haptic('error'); };
  const go1 = async () => {
    const v = pass.value; if (!v) return;
    try {
      await unlockWith(v);
      if (remember.checked) {
        const pin = await askPin('Choose a PIN to remember the passphrase on this device');
        if (pin) { await (await KS.secureBackend()).set(VP_KEY, await KS.encryptSecrets({ p: v }, pin)); toast('Passphrase remembered (PIN-encrypted)'); }
      }
    } catch (e) { fail(e); }
  };
  pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') go1(); });
  const pinBtn = h('button', { class: 'btn ghost hidden', id: 'pinunlock', onclick: async () => {
    const pin = await askPin('PIN'); if (!pin) return;
    try { const blob = await (await KS.secureBackend()).get(VP_KEY); await unlockWith((await KS.decryptSecrets(blob, pin)).p); } catch (e) { fail(e); }
  } }, 'Unlock with PIN');
  KS.secureBackend().then((b) => b.get(VP_KEY)).then((x) => { if (x) pinBtn.classList.remove('hidden'); }).catch(() => {});
  app.append(h('section', { class: 'card lock' }, h('h2', {}, '🔒 Bobby Trade'),
    h('p', { class: 'muted' }, 'This app is private. Enter the passphrase to decrypt it.'), pass,
    h('label', { class: 'toggle small' }, remember, ' Remember on this device (encrypted with a PIN)'),
    h('button', { class: 'btn primary big', id: 'unlock', onclick: go1 }, 'Unlock'), pinBtn, err));
  setTimeout(() => pass.focus(), 50);
}

// ---------------------------------------------------------------- balances (balances.enc.json, written by balances.py)
const pct = (x) => (x == null ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%');
const sgn2 = (x) => (x == null ? '—' : Number(x) === 0 ? '$0.00' : (x < 0 ? '-$' : '+$') + Math.abs(Number(x)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
function sparkline(points, w = 300, hgt = 48) {
  const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`); svg.setAttribute('class', 'spark'); svg.setAttribute('preserveAspectRatio', 'none');
  const v = points.filter((x) => Number.isFinite(x));
  if (v.length < 2) return svg;
  const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
  const d = v.map((y, i) => `${i ? 'L' : 'M'}${((i / (v.length - 1)) * w).toFixed(1)},${(hgt - 3 - ((y - lo) / span) * (hgt - 6)).toFixed(1)}`).join(' ');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d); path.setAttribute('fill', 'none'); path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke', v[v.length - 1] >= v[0] ? '#3ecf8e' : '#ff6b6b'); svg.append(path);
  return svg;
}
function viewBalances(app) {
  const j = S.data && S.data.balances;
  const card = h('section', { class: 'card' }, h('h2', {}, '💰 Balances'),
    h('div', { class: 'muted small' }, j && j.generated ? `${berlinTime(j.generated)} (Berlin time)${j.network && j.network !== 'mainnet' ? ' · ' + j.network : ''}` : 'Not published yet'));
  app.append(card);
  if (!j) { card.append(h('p', { class: 'muted' }, 'No balances yet. Run tools/publish_balances.sh on the box.')); return; }
  const cls = (x) => (x == null ? '' : x >= 0 ? 'green' : 'redtxt');
  const row = (name, r, tot) => (r.status === 'ok' || tot
    ? h('tr', { class: tot ? 'total' : '' }, h('th', {}, name), h('td', {}, usd0(r.start)), h('td', {}, usd0(r.current)), h('td', {}, sgn2(r.netDeposits)),
      h('td', { class: cls(r.pnl) }, sgn2(r.pnl)), h('td', { class: cls(r.pnl) }, pct(r.pnlPct)))
    : h('tr', { class: 'muted' }, h('th', {}, name), h('td', { colspan: '5' }, r.status === 'error' ? 'error: ' + (r.error || '') : r.status)));
  const rows = (j.platforms || []).map((r) => row(String(r.name || r.id).replace(/^[^A-Za-z]+/, ''), r));
  if (j.total) rows.push(row('Total', j.total, true));
  card.append(h('div', { class: 'scroll' }, h('table', { class: 'bal', id: 'baltable' },
    h('thead', {}, h('tr', {}, ...['', 'Start', 'Now', 'Net dep.', 'PnL', '%'].map((t) => h('th', {}, t)))), h('tbody', {}, ...rows))));
  const notes = (j.platforms || []).filter((r) => r.status === 'ok').map((r) => `${r.name}: since ${berlinTime(r.startT)}${r.startOverride ? ' (manual start)' : ''}; deposits: ${r.ndSource}`);
  if (notes.length) card.append(h('ul', { class: 'muted small' }, ...notes.map((n) => h('li', {}, n))));
  const hist = j.history || [];
  const hc = h('section', { class: 'card' }, h('h2', {}, 'History'));
  app.append(hc);
  if (hist.length >= 2) hc.append(h('div', { class: 'muted small' }, 'Total PnL'), sparkline(hist.map((x) => x.total && x.total.pnl)));
  hc.append(h('div', { class: 'scroll' }, h('table', { class: 'bal', id: 'histtable' }, h('thead', {}, h('tr', {}, h('th', {}, 'Berlin time'), h('th', {}, 'Balance'), h('th', {}, 'PnL'))),
    h('tbody', {}, ...hist.slice(-30).reverse().map((x) => h('tr', {}, h('td', {}, berlinTime(x.t)), h('td', {}, usd0(x.total && x.total.eq)),
      h('td', { class: cls(x.total && x.total.pnl) }, sgn2(x.total && x.total.pnl))))))));
  app.append(h('button', { class: 'btn ghost', onclick: async () => { try { await refreshData(); render(); } catch (e) { toast(e.message, 'err'); } } }, 'Refresh'));
}

// ---------------------------------------------------------------- briefing (briefing.enc.json, written by briefing.py)
const berlinTime = (t) => new Date(t * 1000).toLocaleString('en-GB', { timeZone: 'Europe/Berlin', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const usd0 = (x) => (x == null ? '—' : '$' + Number(x).toLocaleString('en-US', { maximumFractionDigits: Math.abs(x) >= 1000 ? 0 : 2, minimumFractionDigits: Math.abs(x) >= 1000 ? 0 : 2 }));
const signedUsd = (x) => (x == null ? '' : (x < 0 ? '-$' : '+$') + Math.abs(Number(x)).toLocaleString('en-US', { maximumFractionDigits: Math.abs(x) >= 100 ? 0 : 2 }));
function briefingCard(p) {
  const card = h('section', { class: 'card brief' }, h('h2', {}, `${p.emoji || ''} ${p.name || p.id}`));
  if (p.needsKey) { card.append(h('div', { class: 'alert warn' }, 'QFEX needs an API key: account data is private, so the briefing reads it through the autotrader on the box (QFEX_API_PUBLIC_KEY / QFEX_API_SECRET_KEY).')); return card; }
  if (p.error) { card.append(h('div', { class: 'alert warn' }, 'Could not read this account: ' + p.error)); return card; }
  const ch = p.change;
  card.append(h('div', { class: 'equity' }, 'Equity ', h('b', {}, usd0(p.equity)),
    ch != null ? h('span', { class: 'dot ' + (ch >= 0 ? 'up' : 'down') }, ' ● ') : null,
    ch != null ? h('span', { class: ch >= 0 ? 'green' : 'redtxt' }, (ch >= 0 ? '+' : '') + (ch * 100).toFixed(1) + '% ' + (p.changeLabel || '')) : null));
  if (p.summary) card.append(h('p', { class: 'summary' }, p.summary));
  if ((p.items || []).length) card.append(h('ul', { class: 'bullets' }, ...p.items.map((i) => h('li', {},
    h('b', {}, `${i.sym} ${i.side} `), h('b', { class: Number(i.upnl) < 0 ? 'redtxt' : 'green' }, signedUsd(i.upnl)), ': ' + (i.comment || i.auto || '')))));
  if (p.detail) card.append(h('p', { class: 'detail' }, /^one detail/i.test(p.detail) ? p.detail : 'One detail: ' + p.detail));
  return card;
}
function viewBriefing(app) {
  const box = h('section', { class: 'card' }, h('div', { class: 'spin' }), ' Loading briefing…');
  app.append(box);
  (async () => {
    let j = S.data && S.data.briefing;
    if (S.refreshBriefing) { S.refreshBriefing = false; try { j = (await refreshData()).briefing; } catch (e) { toast(e.message, 'err'); } }
    const plats = (j && j.platforms) || [];
    const head = h('div', { class: 'card' }, h('h2', {}, '📰 Briefing'), h('div', { class: 'muted small' },
      j && j.generated ? `${berlinTime(j.generated)} (Berlin time)${j.network && j.network !== 'mainnet' ? ' · ' + j.network : ''}` : 'Not published yet'));
    if (!plats.length) {
      head.append(h('p', { class: 'muted' }, 'No briefing yet. Run briefing.py, then commit and push public/briefing.enc.json.'));
      head.append(h('button', { class: 'btn ghost', onclick: () => { S.refreshBriefing = true; render(); } }, 'Refresh'));
      box.replaceWith(head); return;
    }
    const frag = [head, ...plats.map(briefingCard), h('button', { class: 'btn ghost', onclick: () => { S.refreshBriefing = true; render(); } }, 'Refresh')];
    box.replaceWith(...frag);
  })();
}

// ---------------------------------------------------------------- proposals inbox (proposals.enc.json next to the page)
const STATUS = { done: ['✅', 'executed'], expired: ['⌛', 'expired'], pending: ['•', 'to review'] };
async function fetchInbox() {
  const j = (await refreshData()).proposals;
  if (!j) throw new Error('No proposals published yet.');
  return j;
}
function viewInbox(app) {
  const box = h('section', { class: 'card' }, h('div', { class: 'spin' }), ' Loading proposals…');
  app.append(box);
  (async () => {
    try {
      const j = await fetchInbox(), now = Date.now() / 1000;
      const parts = [h('div', { class: 'muted small' }, 'Updated: ' + (j.updated ? new Date(j.updated * 1000).toLocaleString('en-US') : '—'))];
      const groups = (j.batches || []).filter((b) => !b.closed || S.showClosed);
      if (!groups.length) parts.push(h('p', { class: 'muted' }, 'No open proposals.'));
      for (const b of groups) {
        parts.push(h('h2', {}, (b.title || b.group) + (b.closed ? ' · done' : '')));
        for (const p of b.proposals || []) {
          const st = p.status === 'pending' && p.exp && now > p.exp ? 'expired' : p.status || 'pending';
          const [ico, lbl] = STATUS[st] || STATUS.pending;
          parts.push(h('div', { class: 'pos' }, h('div', {}, h('b', {}, ico + ' ' + p.line), p.n ? h('div', { class: 'muted small' }, p.n) : null,
            h('div', { class: 'muted small' }, lbl + (p.exp ? ' · expires ' + new Date(p.exp * 1000).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' }) : ''))),
            st === 'pending' ? h('button', { class: 'btn primary', onclick: () => openProposal(p.token) }, 'Open') : null));
        }
      }
      const tog = h('label', { class: 'toggle small' }, h('input', { type: 'checkbox', checked: !!S.showClosed, onchange: (e) => { S.showClosed = e.target.checked; render(); } }), ' Show finished batches');
      box.replaceChildren(h('h2', {}, '📥 Proposals'), ...parts, tog, h('button', { class: 'btn ghost', onclick: () => render() }, 'Refresh'));
    } catch (e) { box.replaceChildren(h('div', { class: 'alert block' }, e.message)); }
  })();
}

// ---------------------------------------------------------------- dashboard
function viewDash(app) {
  const st = S.settings, pol = policy(), from = weekStartUtc(), to = weekEndUtc();
  const box = h('section', { class: 'card' }, h('div', { class: 'spin' }), ' Loading…');
  app.append(box);
  (async () => {
    const parts = [h('h2', {}, '📈 Dashboard'), h('div', { class: 'muted small' },
      `Week (UTC): ${new Date(from).toISOString().slice(0, 10)} → ${new Date(to).toISOString().slice(0, 10)} · ends in ${fmt((to - Date.now()) / 36e5, 0)} h`)];
    const bar = (used, cap) => { const pct = cap > 0 ? Math.min(100, (100 * used) / cap) : 0;
      const fill = h('div', { class: 'fill' + (pct >= 100 ? ' red' : pct >= 60 ? ' warn' : '') }); fill.style.width = pct.toFixed(0) + '%'; // CSSOM: allowed by the CSP
      return h('div', { class: 'bar' }, fill); };
    const row = async (pf, label, balFn) => {
      const card = h('div', { class: 'dash' }, h('h3', {}, label));
      try { const bal = await balFn(); card.append(kv([['Account value', bal != null ? '$' + fmt(bal) : '—'], ['Reference capital', '$' + fmt(pol.capital[pf], 0)]])); }
      catch (e) { card.append(h('div', { class: 'alert warn' }, 'Balance: ' + e.message)); }
      let used = null; try { used = await weeklyLoss(pf); } catch (e) { card.append(h('div', { class: 'muted small' }, 'Losses: ' + e.message)); }
      if (used == null) used = journalRisk(pf);
      card.append(kv([['Realized loss this week', `$${fmt(used)} / $${fmt(pol.weeklyLossCap, 0)}`, used >= pol.weeklyLossCap ? 'red' : ''],
        ['Max loss per trade (SL)', '$' + fmt(pol.capital[pf] * pol.maxLossPct)]]), bar(used, pol.weeklyLossCap));
      return card;
    };
    if (st.arcusAddress) parts.push(await row('arcus', PF_NAME.arcus, async () => Number((await API.arcusAccount(base().arcus, st.arcusAddress, st.arcusSub)).equity)));
    if (st.hlMaster) parts.push(await row('hl', PF_NAME.hl, async () => {
      let tot = 0; for (const dex of ['', ...String(st.hlDexes || '').split(',').map((x) => x.trim()).filter(Boolean)]) tot += Number((await API.hlState(base().hl, st.hlMaster, dex)).marginSummary.accountValue || 0);
      return tot; }));
    if (st.txflowAddress) {
      const card = await row('txflow', PF_NAME.txflow, async () => Number((await T.state(base().txflow, st.txflowAddress)).marginSummary.accountValue || 0));
      try {
        const a = T.weeklyActivity(await T.fills(base().txflow, st.txflowAddress, from, to), from, to);
        const dayN = Math.min(7, Math.floor((Date.now() - from) / 864e5) + 1);
        card.append(h('h3', {}, 'Points epoch activity (Mon→Mon UTC)'), kv([['Fills', String(a.fills)], ['Volume', '$' + fmt(a.volume)], ['Fees paid', '$' + fmt(a.fees, 4)],
          ['Active days', `${a.activeDays} / ${dayN}`], ['Maker share', a.makerShare == null ? '—' : fmt(a.makerShare * 100, 0) + ' %']]),
        h('p', { class: 'muted small' }, 'TxFlow points require a minimum (unpublished) amount of real trading per epoch. Credited on Tuesdays.'));
      } catch (e) { card.append(h('div', { class: 'alert warn' }, 'TxFlow activity: ' + e.message)); }
      parts.push(card);
    }
    if (parts.length === 2) parts.push(h('p', {}, 'Enter your public addresses in Settings.'));
    box.replaceChildren(...parts);
  })();
}

function viewHome(app) {
  const ta = h('textarea', { rows: 3, placeholder: 'Paste a proposal link or code here (v1.…)' });
  app.append(
    h('section', { class: 'card' }, h('h2', {}, 'Proposal'), ta,
      h('button', { class: 'btn primary big', onclick: () => openProposal(ta.value) }, 'Open proposal')),
    h('div', { class: 'grid' },
      h('button', { class: 'btn tile', onclick: () => go('inbox') }, '📥', h('span', {}, 'Proposals')),
      h('button', { class: 'btn tile', onclick: () => go('dash') }, '📈', h('span', {}, 'Dashboard')),
      h('button', { class: 'btn tile', onclick: () => go('positions') }, '📊', h('span', {}, 'Positions & orders')),
      h('button', { class: 'btn tile', onclick: () => go('log') }, '🧾', h('span', {}, 'Journal')),
      h('button', { class: 'btn tile', onclick: () => go('settings') }, '⚙️', h('span', {}, 'Settings')),
      h('button', { class: 'btn tile', onclick: () => { lockNow(); render(); toast('Keys locked'); } }, '🔒', h('span', {}, 'Lock keys')),
      h('button', { class: 'btn tile', onclick: async () => { try { await (await KS.secureBackend()).del(VP_KEY); } catch { /* */ } toast('Remembered passphrase forgotten'); } }, '🧹', h('span', {}, 'Forget passphrase'))),
    h('p', { class: 'muted small' }, 'Orders are signed on this device and sent from your connection. Nothing is sent until you tap “Approve”.'));
}

function openProposal(input) {
  const tok = extractToken(input);
  if (!tok) { toast('No proposal recognized', 'err'); return; }
  try { go('confirm', { proposal: decodeProposal(tok), ctx: null, risk: null, result: null, ack: false }); }
  catch (e) { toast(e.message, 'err'); }
}

function kv(rows) { return h('table', { class: 'kv' }, rows.filter(Boolean).map(([k, v, cls]) => h('tr', {}, h('th', {}, k), h('td', { class: cls || '' }, v)))); }

function viewConfirm(app) {
  const p = S.proposal;
  if (!p) return go('home');
  if (S.result) { app.append(h('section', { class: 'card' }, h('h1', {}, `${p.act} ${p.m}`))); return renderResult(app); }
  const pfName = p.pf === 'arcus' ? '🏹 Arcus' : p.pf === 'txflow' ? '🌊 TxFlow (manual mode)' : p.pf === 'qfex' ? '📈 QFEX (autotrader)' : (p.m.includes(':') ? '🤖 Hyperliquid ' + p.m.split(':')[0] : '🤖 Hyperliquid');
  const title = p.act === 'cancel' ? `❌ Cancel an order on ${p.m}` : p.act === 'tpsl' ? `TP/SL on ${p.m}` : `${p.sd === 'long' ? '🟢 LONG' : '🔴 SHORT'} ${p.m}`;
  const card = h('section', { class: 'card' }, h('div', { class: 'muted small' }, pfName + ' · id ' + p.id), h('h1', {}, title));
  if (p.n) card.append(h('p', { class: 'note' }, p.n));
  card.append(kv([
    p.act === 'open' && ['Size', String(p.sz)], p.act === 'open' && ['Leverage', p.lev + '× isolated'],
    p.act === 'open' && ['Entry', p.et === 'market' ? 'Market (IOC)' : 'Limit ' + fmtPx(p.px)],
    p.act === 'cancel' && ['Order (oid)', String(p.oid)],
    p.act !== 'cancel' && ['Stop-loss', p.sl != null ? fmtPx(p.sl) : '—'], p.act !== 'cancel' && ['Take-profit', p.tp != null ? fmtPx(p.tp) : '—'],
    p.ref != null && ['Reference price', fmtPx(p.ref)], p.exp && ['Expires', new Date(p.exp * 1000).toLocaleString('en-US')]]));
  app.append(card);
  const live = h('section', { class: 'card' }, h('div', { class: 'spin' }), ' Loading live price…');
  app.append(live);
  (async () => {
    try {
      const c = await loadContext(p); const r = await withPolicy(p, c, riskFor(p, c)); S.ctx = c; S.risk = r;
      live.replaceChildren(h('h2', {}, 'Live check'), kv([
        p.act === 'cancel' && c.order && ['Order found', c.pf === 'hl' ? `${c.order.orderType} ${c.order.side === 'B' ? 'buy' : 'sell'} ${c.order.sz}${Number(c.order.triggerPx) ? ' · trigger ' + c.order.triggerPx : ' @ ' + c.order.limitPx}` : `${c.order.type || ''} ${c.order.side || ''} ${c.order.triggerPrice || c.order.price || ''}`],
        c.plan && ['Current SL', c.plan.current.sl.length ? c.plan.current.sl.map(fmtPx).join(' + ') : 'none', c.plan.current.sl.length ? '' : 'red'],
        c.plan && ['Current TP', c.plan.current.tp.length ? c.plan.current.tp.map(fmtPx).join(' + ') : 'none'],
        c.plan && ['After', `SL ${c.plan.place.sl != null ? fmtPx(c.plan.place.sl) : '—'}${c.plan.carried.sl ? ' (kept)' : ''} · TP ${c.plan.place.tp != null ? fmtPx(c.plan.place.tp) : '—'}${c.plan.carried.tp ? ' (kept)' : ''}`, 'green'],
        c.plan && c.plan.replaces && ['Replacement', `cancel ${c.plan.cancelFirst.length} position TP/SL order(s) → place the new one → verify${c.plan.cancelAfter.length ? ` → cancel ${c.plan.cancelAfter.length} entry-linked order(s)` : ''}`],
        ['Mark', fmtPx(c.mark)], r.moved != null && ['Drift vs ref.', fmt(r.moved * 100) + '%', r.moved > 0.01 ? 'red' : ''],
        p.act === 'open' && ['Rounded size', String(c.size)], r.entry != null && [r.entryLabel, fmtPx(r.entry)],
        r.notional != null && ['Notional', '$' + fmt(r.notional)], p.act === 'open' && ['Margin', '$' + fmt(r.margin)],
        c.free != null && p.act === 'open' && ['Free collateral', '$' + fmt(c.free)],
        c.pf === 'qfex' ? ['Maker fee / stop leg', fmt(c.makerFee * 100, 4) + '% / ' + fmt(c.fee * 100, 4) + '% (taker ' + fmt(c.taker * 100, 3) + '% + slippage ' + fmt(c.slippage * 100, 3) + '%; ' + c.feeSrc + ')']
          : ['Maker / taker fees', (c.makerFee != null ? fmt(c.makerFee * 100, 4) : '—') + ' / ' + fmt(c.fee * 100, 4) + '% (' + (c.feeSrc || '?') + ')'],
        c.pf === 'qfex' && ['Best bid / ask', (c.bid != null ? fmtPx(c.bid) : '—') + ' / ' + (c.ask != null ? fmtPx(c.ask) : '—')],
        c.pf !== 'qfex' && ['Max leverage', c.maxLev + '×'],
        r.policy && r.policy.maxLoss != null && p.act === 'open' && ['Loss cap per trade', '$' + fmt(r.policy.maxLoss)],
        r.policy && ['Weekly losses (' + r.policy.src + ')', '$' + fmt(r.policy.used) + ' / $' + fmt(policyFor(p.pf, policy()).weeklyLossCap, 0)],
        r.slLocked != null ? ['Locked gain at SL (incl. fees)', '+$' + '' + fmt(r.slLocked), 'green']
          : r.slLoss != null && ['Loss at SL (incl. fees)', '−$' + '' + fmt(r.slLoss), r.slLoss >= S.settings.maxLoss ? 'red' : 'green'],
        r.tpGain != null && ['Gain at TP (incl. fees)', (r.tpGain < 0 ? '−$' : '+$') + '' + fmt(Math.abs(r.tpGain)), r.tpGain < 0 ? 'red' : 'green'],
        r.liq != null && p.act === 'open' && ['Estimated liquidation', fmtPx(r.liq)]]));
      const box = h('div');
      for (const b of r.blocks) box.append(h('div', { class: 'alert block' }, '⛔ ' + b));
      for (const w of r.warns) box.append(h('div', { class: 'alert warn' }, '⚠️ ' + w));
      live.append(box);
      if (p.pf === 'txflow') { live.append(txflowManual(p, c, r)); return; }
      if (p.pf === 'qfex') { live.append(qfexAutotrader(p, c, r)); return; }
      const approve = h('button', { class: 'btn approve', disabled: r.blocks.length > 0 || r.warns.length > 0 ? true : null, onclick: () => approveFlow(approve) },
        S.settings.dryRun ? 'Approve (dry run, nothing is sent)' : 'Approve and send');
      if (r.blocks.length) approve.textContent = 'Blocked';
      else if (r.warns.length) {
        const cb = h('input', { type: 'checkbox', id: 'ack' });
        cb.addEventListener('change', () => { approve.disabled = !cb.checked; approve.classList.toggle('danger', cb.checked); });
        live.append(h('label', { class: 'ack', for: 'ack' }, cb, ' I confirm despite the red alerts'));
      }
      live.append(approve, h('button', { class: 'btn ghost', onclick: () => go('home') }, 'Reject'));
    } catch (e) { live.replaceChildren(h('div', { class: 'alert block' }, '⛔ ' + e.message)); }
  })();
}

// TxFlow manual mode: nothing is signed here. The user places the order in the TxFlow app (its own agent key),
// then this card checks public account data for the resting order / position.
function txflowManual(p, c, r) {
  const wrap = h('div');
  const ok = r.blocks.length === 0;
  wrap.append(h('div', { class: ok ? 'alert ok' : 'alert block' }, ok ? '✅ Policy compliant: place it manually in TxFlow' : '⛔ Do not place this trade'));
  if (ok) {
    wrap.append(h('h3', {}, 'Enter in TxFlow'), kv([['Market', c.mk.name], ['Side', p.sd === 'long' ? 'Buy / Long' : 'Sell / Short'],
      ['Type', 'Limit · Post-only (Alo)'], ['Limit price', String(p.px)], ['Size', String(p.sz)], ['Leverage', p.lev + '× isolated'],
      ['Stop-loss', p.sl != null ? String(p.sl) : '—'], ['Take-profit', p.tp != null ? String(p.tp) : '—'],
      p.exp && ['Valid until', new Date(p.exp * 1000).toLocaleString('en-US')]]),
    h('a', { class: 'btn primary big', href: T.appLink(), target: '_blank', rel: 'noopener noreferrer' }, 'Open app.txflow.com'));
  }
  const out = h('div', { class: 'small' });
  const check = async () => {
    if (!S.settings.txflowAddress) { out.textContent = 'Enter your (public) TxFlow address in Settings.'; return; }
    out.textContent = 'Checking…';
    try {
      const B = base().txflow;
      const [st, oo] = await Promise.all([T.state(B, S.settings.txflowAddress), T.openOrders(B, S.settings.txflowAddress)]);
      const x = T.executedNow(p, st, oo, c.mk);
      out.replaceChildren(x.executed ? h('div', { class: 'alert ok' }, x.position ? `✅ Position open (${x.position.szi})` : `✅ Order resting @ ${x.resting.limitPx}`) : h('div', { class: 'alert warn' }, 'Not placed yet'),
        x.position && x.hasStopLoss === false ? h('div', { class: 'alert block' }, '🚨 Position without a stop-loss detected: add one in TxFlow') : null);
      if (x.executed) await addLog({ t: new Date().toISOString(), id: p.id, pf: 'txflow', m: p.m, act: p.act, sd: p.sd, sz: String(p.sz), lev: p.lev, et: p.et,
        px: p.px, sl: p.sl, tp: p.tp, mark: c.mark, slLoss: r.slLoss, dry: false, manual: true, testnet: S.settings.testnet, ok: true, res: [] });
    } catch (e) { out.textContent = 'Error: ' + e.message; }
  };
  wrap.append(h('button', { class: 'btn ghost', onclick: check }, 'Check execution (public read)'), out,
    h('button', { class: 'btn ghost', onclick: () => go('inbox') }, 'Back to proposals'));
  return wrap;
}

// QFEX: nothing is signed in the browser (the HMAC secret stays on the box). A compliant proposal is handed to the
// headless autotrader as a queue.json entry; it re-runs every check with live private data before sending.
function qfexAutotrader(p, c, r) {
  const wrap = h('div');
  const ok = r.blocks.length === 0;
  wrap.append(h('div', { class: ok ? 'alert ok' : 'alert block' }, ok ? '✅ Policy compliant: queue it for the QFEX autotrader' : '⛔ Do not queue this trade'));
  if (ok) {
    const entry = { id: p.id, pf: 'qfex', m: c.sym, sd: p.sd, et: 'limit', px: Number(p.px), sz: Number(p.sz), lev: 1, sl: Number(p.sl), tp: Number(p.tp),
      exp: p.exp, ref: p.ref != null ? Number(p.ref) : c.mark, n: p.n || '' };
    const txt = JSON.stringify(entry);
    wrap.append(h('h3', {}, 'Autotrader queue entry (autotrader/queue.json)'), h('pre', { class: 'small' }, txt),
      h('button', { class: 'btn primary', onclick: async () => { try { await navigator.clipboard.writeText(txt); toast('Copied'); } catch { toast('Copy failed: select the text', 'err'); } } }, 'Copy queue entry'),
      h('p', { class: 'muted small' }, 'Order sent by the autotrader: leverage set to 1×, then a post-only ALO GTC limit with the stop-loss and take-profit attached. Dry run until AUTOTRADER_LIVE=1.'));
  }
  wrap.append(h('button', { class: 'btn ghost', onclick: () => go('inbox') }, 'Back to proposals'));
  return wrap;
}

async function approveFlow(btn) {
  const p = S.proposal, st = S.settings;
  btn.disabled = true;
  let busy = null;
  try {
    const sec = await ensureUnlocked();
    busy = showBusy(st.dryRun ? 'Signing (dry run)…' : 'Signing and sending…');
    // re-check live mark right before signing
    const c = await loadContext(p);
    if (p.act !== 'cancel' && Math.abs(c.mark - S.ctx.mark) / S.ctx.mark > 0.01) throw new Error('Price moved more than 1% during confirmation. Reload.');
    const r = await withPolicy(p, c, riskFor(p, c));
    if (r.blocks.length) throw new Error(r.blocks.join(' / '));
    let results, extra = {};
    if (p.pf === 'arcus' && p.act === 'tpsl') {
      const rr = await arcusTpslReplace(p, c, sec, st.dryRun); results = rr.results; extra = { critical: rr.critical, restore: rr.restore, okAll: rr.ok };
    } else {
      const offset = p.pf === 'arcus' ? await API.arcusClockOffsetMs(base().arcus).catch(() => 0) : 0;
      const reqs = buildRequests(p, c, sec, offset);
      if (st.dryRun) results = [{ label: 'DRY RUN — not sent', ok: true, dry: true, payload: showPayload(reqs) }];
      else results = await execute(p.pf, reqs);
    }
    const ok = (extra.okAll ?? results.every((x) => x.ok)) && !extra.restore && !extra.critical;
    delete extra.okAll; S.result = { ok, results, ...extra };
    await addLog({ t: new Date().toISOString(), id: p.id, pf: p.pf, m: p.m, act: p.act, sd: p.sd, sz: String(c.size || ''), lev: p.lev,
      et: p.et, px: p.px, sl: p.sl, tp: p.tp, mark: c.mark, slLoss: r.slLoss, dry: st.dryRun, testnet: st.testnet, ok,
      res: results.map((x) => ({ label: x.label, status: x.status, error: x.error, body: x.dry ? undefined : x.body })) });
    haptic(ok ? 'success' : 'error');
  } catch (e) { haptic('error'); toast(e.message, 'err'); btn.disabled = false; return; }
  finally { if (busy) busy(); }
  render();
}

function renderResult(app) {
  const r = S.result;
  const sec = h('section', { class: 'card' }, h('h2', { class: r.ok ? 'green' : 'red' }, r.ok ? '✅ Done' : '❌ Error'));
  if (r.critical) sec.append(h('div', { class: 'alert block' }, '🚨 ' + r.critical));
  const p0 = S.proposal;
  if (r.restore && (r.restore.sl != null || r.restore.tp != null) && p0) {
    const rp = { v: 1, id: p0.id + '-r', pf: 'arcus', m: p0.m, act: 'tpsl', sl: r.restore.sl ?? undefined, tp: r.restore.tp ?? undefined,
      exp: Math.floor(Date.now() / 1000) + 900, n: 'Restore the previous TP/SL after a failed replacement' };
    sec.append(h('button', { class: 'btn danger big', onclick: () => go('confirm', { proposal: rp, ctx: null, risk: null, result: null }) },
      `Restore previous TP/SL (SL ${r.restore.sl ?? '—'} · TP ${r.restore.tp ?? '—'})`));
  }
  for (const x of r.results) {
    sec.append(h('div', { class: 'muted' }, x.label + (x.status ? ' · HTTP ' + x.status : '')));
    if (x.error) sec.append(h('div', { class: x.retried ? 'alert warn' : 'alert block' }, (x.retried ? 'Retried: ' : '') + x.error));
    sec.append(h('pre', {}, JSON.stringify(x.payload || x.body, null, 1)));
  }
  sec.append(h('button', { class: 'btn primary big', onclick: () => go('home', { proposal: null, result: null }) }, 'Back'));
  app.append(sec);
}

// ---------------------------------------------------------------- positions / close / cancel
function viewPositions(app) {
  const st = S.settings;
  const box = h('section', { class: 'card' }, h('div', { class: 'spin' }), ' Loading…');
  app.append(box);
  (async () => {
    const parts = [];
    if (st.arcusAddress) {
      try {
        const [pos, oo] = await Promise.all([API.arcusPositions(base().arcus, st.arcusAddress, st.arcusSub), API.arcusOpenOrders(base().arcus, st.arcusAddress, st.arcusSub)]);
        parts.push(h('h2', {}, '🏹 Arcus'));
        for (const p of pos) parts.push(h('div', { class: 'pos' }, h('div', {}, h('b', {}, `${p.marketDisplayName} ${p.side} ${p.size}`),
          h('div', { class: 'muted small' }, `entry ${fmtPx(p.averageEntryPrice)} · uPnL $${fmt(p.unrealizedPnl)}`)),
          h('button', { class: 'btn danger', onclick: () => manage('arcus', 'close', p) }, 'Close')));
        for (const o of oo) parts.push(h('div', { class: 'pos' }, h('div', {}, h('b', {}, `${o.marketDisplayName} ${o.side} ${o.tpslType || o.type}`),
          h('div', { class: 'muted small' }, `${o.remainingSize}/${o.originalSize} @ ${o.price}${o.triggerPrice ? ' trig ' + o.triggerPrice : ''}`)),
          h('button', { class: 'btn ghost', onclick: () => manage('arcus', 'cancel', o) }, 'Cancel')));
        if (!pos.length && !oo.length) parts.push(h('p', { class: 'muted' }, 'Nothing open.'));
      } catch (e) { parts.push(h('div', { class: 'alert block' }, 'Arcus: ' + e.message)); }
    }
    if (st.hlMaster) {
      for (const dex of ['', ...String(st.hlDexes || '').split(',').map((x) => x.trim()).filter(Boolean)]) {
        try {
          const [s, oo] = await Promise.all([API.hlState(base().hl, st.hlMaster, dex), API.hlOpenOrders(base().hl, st.hlMaster, dex)]);
          parts.push(h('h2', {}, '🤖 Hyperliquid ' + (dex || 'main') + ` · free $${fmt(s.withdrawable)}`));
          const ps = (s.assetPositions || []).map((x) => x.position);
          for (const p of ps) parts.push(h('div', { class: 'pos' }, h('div', {}, h('b', {}, `${p.coin} ${Number(p.szi) > 0 ? 'LONG' : 'SHORT'} ${Math.abs(p.szi)}`),
            h('div', { class: 'muted small' }, `entry ${fmtPx(p.entryPx)} · uPnL $${fmt(p.unrealizedPnl)} · liq ${fmtPx(p.liquidationPx)}`)),
            h('button', { class: 'btn danger', onclick: () => manage('hl', 'close', p) }, 'Close')));
          for (const o of oo) parts.push(h('div', { class: 'pos' }, h('div', {}, h('b', {}, `${o.coin} ${o.side === 'B' ? 'buy' : 'sell'} ${o.orderType || ''}`),
            h('div', { class: 'muted small' }, `${o.sz} @ ${o.limitPx}${o.isTrigger ? ' trig ' + o.triggerPx : ''}`)),
            h('button', { class: 'btn ghost', onclick: () => manage('hl', 'cancel', o) }, 'Cancel')));
          if (!ps.length && !oo.length) parts.push(h('p', { class: 'muted' }, 'Nothing open.'));
        } catch (e) { parts.push(h('div', { class: 'alert block' }, `HL ${dex || 'main'}: ` + e.message)); }
      }
    }
    if (!parts.length) parts.push(h('p', {}, 'Enter your addresses in Settings.'));
    box.replaceChildren(...parts);
  })();
}

async function manage(pf, what, item) {
  const st = S.settings;
  const name = pf === 'arcus' ? (item.marketDisplayName) : item.coin;
  const msg = what === 'close' ? `Close the whole ${name} position at market?` : `Cancel the ${name} order?`;
  if (!(await confirmDialog(msg + (st.dryRun ? ' (dry run)' : '')))) return;
  let busy = null;
  try {
    const sec = await ensureUnlocked();
    busy = showBusy('Signing…');
    let reqs;
    if (pf === 'arcus') {
      const m = await API.arcusMarket(base().arcus, name);
      const ctx = arcusCtx(sec, await API.arcusClockOffsetMs(base().arcus).catch(() => 0));
      reqs = [{ label: what === 'close' ? 'Close' : 'Cancel', d: what === 'close' ? A.closePosition(ctx, m, item, { slippage: st.slippage }) : A.cancelOrder(ctx, m, item.orderId) }];
    } else {
      const mk = await API.hlMarket(base().hl, name);
      const priv = H.keyFromHex(sec.hl.key);
      const action = what === 'close' ? H.buildClose({ asset: mk.asset, szDecimals: mk.szDecimals, szi: item.szi, markPx: mk.midPx || mk.markPx, slippage: st.slippage })
        : H.buildCancel(mk.asset, item.oid);
      reqs = [{ label: what === 'close' ? 'Close' : 'Cancel', d: H.exchangeRequest(priv, action, Date.now(), { isMainnet: !st.testnet }) }];
    }
    const results = st.dryRun ? [{ label: 'DRY RUN — not sent', ok: true, dry: true, payload: showPayload(reqs) }] : await execute(pf, reqs);
    const ok = results.every((x) => x.ok);
    await addLog({ t: new Date().toISOString(), id: what + '-' + Date.now(), pf, m: name, act: what, dry: st.dryRun, testnet: st.testnet, ok,
      res: results.map((x) => ({ label: x.label, status: x.status, error: x.error, body: x.dry ? undefined : x.body })) });
    busy(); busy = null;
    S.proposal = { id: what, pf, m: name, act: what }; S.result = { ok, results };
    haptic(ok ? 'success' : 'error');
    go('confirm');
  } catch (e) { toast(e.message, 'err'); } finally { if (busy) busy(); }
}

// ---------------------------------------------------------------- log
function logText() {
  return S.log.map((e) => {
    const what = e.act === 'open' ? `${e.sd} ${e.sz} ${e.m} ${e.lev}× ${e.et}${e.px ? ' @' + e.px : ''} SL ${e.sl ?? '—'} TP ${e.tp ?? '—'}` : `${e.act} ${e.m}`;
    const err = (e.res || []).map((r) => r.error).filter(Boolean).join('; ');
    return `${new Date(e.t).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })} [${e.pf}${e.testnet ? ' testnet' : ''}${e.dry ? ' DRY' : ''}] ${e.ok ? 'OK' : 'ERROR'} ${what}${e.slLoss != null ? ` (SL −$${Number(e.slLoss).toFixed(0)})` : ''}${err ? ' — ' + err : ''} #${e.id}`;
  }).join('\n');
}
function viewLog(app) {
  const txt = logText() || 'Journal is empty.';
  app.append(h('section', { class: 'card' }, h('h2', {}, 'Trade journal'), h('pre', { class: 'log' }, txt),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: async () => { try { await navigator.clipboard.writeText(txt); toast('Copied ✅'); } catch { toast('Copy failed', 'err'); } } }, 'Copy'),
      h('button', { class: 'btn primary', onclick: () => {
        if (navigator.share) navigator.share({ title: 'Bobby Trade journal', text: txt.slice(0, 3500) }).catch(() => {});
        else toast('Sharing not available: use Copy', 'err');
      } }, 'Share'))));
}

// ---------------------------------------------------------------- settings
function viewSettings(app) {
  const st = S.settings;
  const f = {
    aKey: h('input', { type: 'password', autocomplete: 'off', placeholder: 'Arcus Ed25519 private key (64 hex)' }),
    aAddr: h('input', { value: st.arcusAddress, autocomplete: 'off' }), aSub: h('input', { type: 'number', value: st.arcusSub, inputmode: 'numeric' }),
    hKey: h('input', { type: 'password', autocomplete: 'off', placeholder: 'HL API wallet private key (0x + 64 hex)' }),
    hAddr: h('input', { value: st.hlMaster, autocomplete: 'off', placeholder: 'Main address 0x…' }),
    tAddr: h('input', { value: st.txflowAddress, autocomplete: 'off', placeholder: 'TxFlow public address 0x… (read-only)' }),
    pin: h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'new-password', placeholder: 'PIN (6 digits min.)' }),
    pin2: h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'new-password', placeholder: 'Confirm PIN' }),
  };
  const info = h('div', { class: 'muted small' }, '…');
  KS.secureBackend().then((b) => KS.hasKeystore().then((has) => { info.textContent = `Storage: ${b.name} · ${has ? 'keys saved (PIN-encrypted)' : 'no keys'}`; }));
  const save = async () => {
    try {
      if (f.pin.value.length < 6 || f.pin.value !== f.pin2.value) throw new Error('PIN: at least 6 characters, both entries identical');
      const prev = S.secrets || ((await KS.hasKeystore()) ? await ensureUnlocked() : {});
      const sec = { arcus: { ...(prev.arcus || {}) }, hl: { ...(prev.hl || {}) } };
      if (f.aKey.value) { A.keyFromHex(f.aKey.value); sec.arcus.key = f.aKey.value.trim(); }
      if (f.hKey.value) { H.keyFromHex(f.hKey.value); sec.hl.key = f.hKey.value.trim(); }
      sec.arcus.address = f.aAddr.value.trim(); sec.arcus.sub = Number(f.aSub.value || 0); sec.hl.master = f.hAddr.value.trim();
      const tAddr = f.tAddr.value.trim(); if (tAddr && !/^0x[0-9a-fA-F]{40}$/.test(tAddr)) throw new Error('Invalid TxFlow address'); st.txflowAddress = tAddr;
      if (sec.hl.master && !/^0x[0-9a-fA-F]{40}$/.test(sec.hl.master)) throw new Error('Invalid HL address');
      if (sec.arcus.address && !/^0x[0-9a-fA-F]{40}$/.test(sec.arcus.address)) throw new Error('Invalid Arcus address');
      const busy = showBusy('Encrypting…');
      try { const where = await KS.saveKeystore(sec, f.pin.value); toast('Keys saved in ' + where); } finally { busy(); }
      Object.assign(st, { arcusAddress: sec.arcus.address, arcusSub: sec.arcus.sub, hlMaster: sec.hl.master }); await saveSettings();
      S.secrets = sec; touchLock(); f.aKey.value = f.hKey.value = f.pin.value = f.pin2.value = ''; render();
    } catch (e) { toast(e.message, 'err'); }
  };
  const check = h('pre', { class: 'small' });
  const test = async () => {
    check.textContent = 'Checking (read-only)…';
    const lines = [];
    try {
      const sec = await ensureUnlocked();
      if (sec.arcus?.key) {
        const ctx = arcusCtx(sec, await API.arcusClockOffsetMs(base().arcus).catch(() => 0));
        lines.push('Arcus public key: ' + ctx.apiKey.slice(0, 10) + '…');
        const keys = await API.arcusApiKeys(base().arcus, sec.arcus.address);
        const mine = keys.find((k) => k.apiKey.toLowerCase() === ctx.apiKey.toLowerCase());
        lines.push(mine ? `  registered: ${mine.status}, valid until ${mine.validUntil ? new Date(mine.validUntil).toLocaleString('en-US') : '—'}` : '  ⚠️ key not found for this address');
        const r = await API.sendArcus(base().arcus, A.signedGet(ctx, '/v1/affiliate/code'));
        lines.push('  signed request: ' + (r.ok ? 'OK ✅' : 'HTTP ' + r.status));
      }
      if (sec.hl?.key) {
        const agent = H.addressOf(H.keyFromHex(sec.hl.key));
        lines.push('HL API wallet: ' + agent);
        const role = await API.hlUserRole(base().hl, agent);
        const okm = role?.role === 'agent' && role?.data?.user?.toLowerCase() === (sec.hl.master || '').toLowerCase();
        lines.push('  role: ' + JSON.stringify(role) + (okm ? ' ✅' : ' ⚠️ not approved for the main address'));
      }
    } catch (e) { lines.push('Error: ' + e.message); }
    check.textContent = lines.join('\n');
  };
  const wipe = async () => {
    if (!(await confirmDialog('Permanently erase the keys from this device?'))) return;
    await KS.wipeKeystore(); lockNow(); toast('Keys erased'); render();
  };
  const tog = (key, label) => { const c = h('input', { type: 'checkbox', checked: st[key] });
    c.addEventListener('change', async () => {
      if (key === 'dryRun' && !c.checked && !(await confirmDialog('Turn off dry run? Orders will really be sent.'))) { c.checked = true; return; }
      st[key] = c.checked; await saveSettings(); render(); });
    return h('label', { class: 'toggle' }, c, ' ' + label); };
  const num = (key, label, step) => { const i = h('input', { type: 'number', step, value: st[key] });
    i.addEventListener('change', async () => { const v = Number(i.value); if (Number.isFinite(v) && v > 0) { st[key] = v; await saveSettings(); } });
    return h('label', { class: 'field' }, label, i); };
  app.append(
    h('section', { class: 'card' }, h('h2', {}, 'Mode'), tog('dryRun', 'Dry run (sign without sending)'), tog('testnet', 'Testnet (Arcus + Hyperliquid)'),
      num('maxLoss', 'Loss at SL warning threshold ($)', '1'), num('slippage', 'Market slippage (0.02 = 2%)', '0.005'),
      num('feeIo', 'HL io fee per side (fallback)', '0.00001'), num('feeMain', 'HL main fee per side (fallback)', '0.00001')),
    h('section', { class: 'card' }, h('h2', {}, 'Risk policy (hard blocks)'),
      tog('polMakerOnly', 'Maker-only entries (post-only limit)'), tog('polRequireSl', 'Stop-loss required'),
      num('polMaxLev', 'Max leverage (×)', '1'), num('polMaxLossPct', 'Max loss at SL per trade (0.01 = 1% of capital)', '0.001'),
      num('polWeeklyCap', 'Weekly loss cap per platform ($)', '1'),
      num('capArcus', 'Arcus capital ($)', '1'), num('capHl', 'Entropy / Hyperliquid capital ($)', '1'), num('capTxflow', 'TxFlow capital ($)', '1'), num('capQfex', 'QFEX capital ($)', '1'),
      h('p', { class: 'muted small' }, 'Week = Monday 00:00 UTC. This app never builds deposits, withdrawals, transfers or vault actions.')),
    h('section', { class: 'card' }, h('h2', {}, '🌊 TxFlow (manual mode)'), h('label', { class: 'field' }, 'Account address (public)', f.tAddr),
      h('button', { class: 'btn ghost', onclick: async () => { const v = f.tAddr.value.trim(); if (v && !/^0x[0-9a-fA-F]{40}$/.test(v)) return toast('Invalid TxFlow address', 'err'); st.txflowAddress = v; await saveSettings(); toast('TxFlow address saved'); } }, 'Save address'),
      h('p', { class: 'muted small' }, 'No TxFlow key here. Orders are placed in app.txflow.com; this app only reads public data. Agent signing (“bobby”) stays disabled until the mainnet whitelist is granted.')),
    h('section', { class: 'card' }, h('h2', {}, 'Keys'), info,
      h('h3', {}, '🏹 Arcus'), f.aKey, h('label', { class: 'field' }, 'Owner address', f.aAddr), h('label', { class: 'field' }, 'Subaccount', f.aSub),
      h('h3', {}, '🤖 Hyperliquid / Entropy'), f.hKey, h('label', { class: 'field' }, 'Main address (master)', f.hAddr),
      h('h3', {}, 'PIN'), f.pin, f.pin2,
      h('p', { class: 'muted small' }, 'Leave a key field empty to keep the key already saved. Keys are encrypted with your PIN (PBKDF2 600,000 iterations + AES-GCM) and never leave this device.'),
      h('button', { class: 'btn primary big', onclick: save }, 'Save (encrypted)'),
      h('button', { class: 'btn ghost', onclick: test }, 'Check keys (read-only)'), check,
      h('button', { class: 'btn danger', onclick: wipe }, 'Erase keys')));
}

// ---------------------------------------------------------------- boot
async function boot() {
  await loadSettings(); // device-local settings only; nothing is shown before the passphrase unlocks
  render();
  const tok = extractToken(LAUNCH_URL);
  if (tok) { try { history.replaceState(null, '', location.pathname); } catch { /* */ } S.pendingTok = tok; } // opened after unlock
}
document.addEventListener('visibilitychange', () => { if (document.hidden) { /* keep timer */ } });
boot();
