import * as A from './arcus.js';
import * as H from './hl.js';
import * as API from './api.js';
import { computeRisk, FEES, MAX_LOSS } from './risk.js';
import { extractToken, decodeProposal } from './proposal.js';
import * as KS from './keystore.js';
import { runTpslReplace, legLabel } from './replace.js';

const LAUNCH_URL = window.__LAUNCH_URL || location.href; // captured before telegram-web-app.js loads
const tg = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData ? window.Telegram.WebApp : null;
const DEFAULTS = { dryRun: true, testnet: false, maxLoss: MAX_LOSS, slippage: 0.02, feeArcus: FEES.arcus, feeIo: FEES.hl_io,
  feeMain: FEES.hl_main, arcusAddress: '', arcusSub: 0, hlMaster: '', hlDexes: 'io' };
const S = { settings: { ...DEFAULTS }, secrets: null, lockTimer: null, log: [], view: 'home', proposal: null };
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
const fmt = (x, d = 2) => (x == null || !Number.isFinite(Number(x)) ? '—' : Number(x).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmtPx = (x) => (x == null ? '—' : Number(x).toLocaleString('fr-FR', { maximumSignificantDigits: 7 }));
const haptic = (t) => { try { tg && tg.HapticFeedback.notificationOccurred(t); } catch { /* */ } };
function toast(msg, kind = 'info') {
  const t = h('div', { class: 'toast ' + kind }, msg); document.body.append(t); setTimeout(() => t.remove(), 3500);
}
function confirmDialog(msg) {
  return new Promise((res) => { if (tg && tg.showConfirm) tg.showConfirm(msg, (ok) => res(!!ok)); else res(window.confirm(msg)); });
}

// ---------------------------------------------------------------- persistence (non-secret)
async function loadSettings() {
  try { const b = await KS.deviceBackend(); const s = await b.get('tgtrade_settings'); if (s) S.settings = { ...DEFAULTS, ...JSON.parse(s) }; } catch { /* */ }
  try { const b = await KS.deviceBackend(); const l = await b.get('tgtrade_log'); if (l) S.log = JSON.parse(l); } catch { /* */ }
}
async function saveSettings() { const b = await KS.deviceBackend(); await b.set('tgtrade_settings', JSON.stringify(S.settings)); }
async function addLog(entry) {
  S.log.unshift(entry); S.log = S.log.slice(0, 200);
  try { const b = await KS.deviceBackend(); await b.set('tgtrade_log', JSON.stringify(S.log)); } catch (e) { toast('Journal non sauvegardé: ' + e.message, 'err'); }
}
const base = () => API.bases(S.settings.testnet);

// ---------------------------------------------------------------- keys / PIN
function lockNow() { S.secrets = null; clearTimeout(S.lockTimer); }
function touchLock() { clearTimeout(S.lockTimer); S.lockTimer = setTimeout(() => { lockNow(); render(); }, LOCK_MS); }
function askPin(title = 'Code PIN') {
  return new Promise((res) => {
    const inp = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', class: 'pin', placeholder: '••••••' });
    const close = (v) => { ov.remove(); res(v); };
    const ov = h('div', { class: 'overlay' }, h('div', { class: 'modal' }, h('h2', {}, title), inp,
      h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: () => close(null) }, 'Annuler'),
        h('button', { class: 'btn primary', onclick: () => close(inp.value) }, 'Valider'))));
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') close(inp.value); });
    document.body.append(ov); setTimeout(() => inp.focus(), 50);
  });
}
async function ensureUnlocked() {
  if (S.secrets) { touchLock(); return S.secrets; }
  if (!(await KS.hasKeystore())) throw new Error('Aucune clé enregistrée. Va dans Réglages.');
  const pin = await askPin('Déverrouiller les clés');
  if (!pin) throw new Error('Annulé');
  const busy = showBusy('Déchiffrement…');
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
    return { pf: 'arcus', m, mark: Number(m.markPrice), maxLev: A.maxLeverage(m), fee: A.takerFee(m) || st.feeArcus,
      mmf: Number(m.maintenanceMarginFraction), size: Number(p.act === 'open' ? A.qtyFloor(m, p.sz) : 0), sizeStr: p.act === 'open' ? A.qtyFloor(m, p.sz) : '0',
      minNotional: Number(m.minOrderNotional || 0), minSize: Number(m.minOrderSize || 0), free, pos, status: m.status, plan, planErr,
      order: p.act === 'cancel' ? (await API.arcusOpenOrders(base().arcus, st.arcusAddress, st.arcusSub)).find((o) => String(o.orderId) === String(p.oid)) || null : undefined };
  }
  const mk = await API.hlMarket(base().hl, p.m);
  let free = null, pos = null;
  if (st.hlMaster) {
    try { const s = await API.hlState(base().hl, st.hlMaster, mk.dex); free = Number(s.withdrawable);
      try { const ad = await API.hlInfo(base().hl, { type: 'activeAssetData', user: st.hlMaster, coin: p.m }); const at = (ad.availableToTrade || []).map(Number); if (at.length === 2) free = p.sd === 'short' ? at[1] : at[0]; } catch { /* */ }
      const ap = (s.assetPositions || []).map((x) => x.position).find((x) => x.coin === p.m); pos = ap || null; } catch { /* */ }
  }
  let order;
  if (p.act === 'cancel') order = (await API.hlOpenOrders(base().hl, st.hlMaster, mk.dex)).find((o) => String(o.oid) === String(p.oid)) || null;
  return { pf: 'hl', mk, order, mark: mk.markPx, maxLev: mk.maxLeverage, fee: mk.dex ? st.feeIo : st.feeMain, mmf: 1 / (2 * mk.maxLeverage),
    size: p.act === 'open' ? H.roundSz(p.sz, mk.szDecimals) : 0, free, pos };
}

function riskFor(p, c) {
  if (p.act === 'cancel') return { blocks: c.order ? [] : ['Ordre introuvable (déjà annulé ou exécuté ?)'], warns: [] };
  if (p.act === 'tpsl') {
    if (!c.pos) return { blocks: ['Aucune position ouverte sur ce marché'], warns: [] };
    const isLong = c.pf === 'arcus' ? ['LONG', 'BUY'].includes(String(c.pos.side).toUpperCase()) : Number(c.pos.szi) > 0;
    const size = Math.abs(Number(c.pf === 'arcus' ? c.pos.size : c.pos.szi));
    const entry = Number(c.pf === 'arcus' ? c.pos.averageEntryPrice : c.pos.entryPx);
    const lev = Number(c.pf === 'arcus' ? c.pos.leverage : (c.pos.leverage && c.pos.leverage.value)) || 1;
    const tgt = c.pf === 'arcus' && c.plan ? c.plan.place : { sl: p.sl, tp: p.tp };
    const r = computeRisk({ mode: 'tpsl', isLong, size, leverage: lev, mark: c.mark, type: 'limit', limitPx: entry, feeRate: c.fee, mmf: c.mmf,
      sl: tgt.sl != null ? Number(tgt.sl) : null, tp: tgt.tp != null ? Number(tgt.tp) : null, expiry: p.exp, maxLoss: S.settings.maxLoss });
    r.blocks = r.blocks.filter((b) => !b.includes('Levier'));
    if (c.pf === 'arcus' && !c.plan) r.blocks.push('Lecture des ordres ouverts impossible (' + (c.planErr || '?') + ') : remplacement TP/SL non sûr');
    return { ...r, isLong, size, entryLabel: 'Entrée position' };
  }
  const isLong = p.sd === 'long';
  const r = computeRisk({ isLong, size: c.size, leverage: Number(p.lev), mark: c.mark, type: p.et, limitPx: p.px, feeRate: c.fee,
    mmf: c.mmf, maxLev: c.maxLev, sl: p.sl != null ? Number(p.sl) : null, tp: p.tp != null ? Number(p.tp) : null,
    ref: p.ref != null ? Number(p.ref) : (p.et === 'market' ? null : null), expiry: p.exp, freeCollateral: c.free, maxLoss: S.settings.maxLoss });
  if (p.et === 'market' && p.ref == null) r.warns.push('Pas de prix de référence dans la proposition (contrôle 1 % impossible)');
  if (c.pf === 'arcus') {
    if (c.status && c.status !== 'ONLINE') r.blocks.push('Marché Arcus ' + c.status);
    if (c.minSize && c.size < c.minSize) r.blocks.push(`Taille < minimum (${c.minSize})`);
    if (c.minNotional && r.notional < c.minNotional) r.blocks.push(`Notionnel < minimum (${c.minNotional} $)`);
  } else if (c.mk.isDelisted) r.blocks.push('Marché délisté');
  if (c.pos && Number(c.pf === 'arcus' ? c.pos.size : c.pos.szi) !== 0) r.warns.push('Une position existe déjà sur ce marché : TP/SL dimensionnés sur ce nouvel ordre uniquement');
  return { ...r, isLong, size: c.size, entryLabel: p.et === 'limit' ? 'Prix limite' : 'Entrée (mark)' };
}

// ---------------------------------------------------------------- build (sign) requests
function buildRequests(p, c, sec, offsetMs) {
  const st = S.settings;
  if (p.pf === 'arcus') {
    if (!sec.arcus || !sec.arcus.key) throw new Error('Clé Arcus manquante');
    const ctx = arcusCtx(sec, offsetMs), m = c.m;
    if (p.act === 'cancel') return [{ label: 'Annulation', d: A.cancelOrder(ctx, m, String(p.oid)) }];
    if (p.act === 'tpsl') return [{ label: 'TP/SL position', d: A.positionTpsl(ctx, m, c.pos.side, { takeProfit: p.tp, stopLoss: p.sl }) }];
    const side = p.sd === 'long' ? 'BUY' : 'SELL';
    return [
      { label: `Levier ${p.lev}× isolé`, d: A.setLeverage(ctx, m, p.lev, true) },
      { label: 'Ordre + TP/SL (entryTpsl)', d: A.entryTpsl(ctx, m, side, c.sizeStr, { type: p.et, limitPrice: p.px, takeProfit: p.tp, stopLoss: p.sl, slippage: st.slippage }) },
    ];
  }
  if (!sec.hl || !sec.hl.key) throw new Error('Clé Hyperliquid manquante');
  const priv = H.keyFromHex(sec.hl.key), mk = c.mk, isMainnet = !st.testnet;
  let nonce = Date.now();
  const sign = (action) => H.exchangeRequest(priv, action, nonce++, { isMainnet });
  if (p.act === 'cancel') return [{ label: 'Annulation', d: sign(H.buildCancel(mk.asset, p.oid)) }];
  if (p.act === 'tpsl') return [{ label: 'TP/SL position', d: sign(H.buildPositionTpsl({ asset: mk.asset, szDecimals: mk.szDecimals, positionIsLong: Number(c.pos.szi) > 0, tp: p.tp, sl: p.sl })) }];
  const [lev, order] = H.buildOpen({ asset: mk.asset, szDecimals: mk.szDecimals, isBuy: p.sd === 'long', sz: p.sz, leverage: Number(p.lev),
    isCross: false, type: p.et, limitPx: p.px, markPx: mk.midPx || mk.markPx, tp: p.tp, sl: p.sl, slippage: st.slippage });
  return [{ label: `Levier ${p.lev}× isolé`, d: sign(lev) }, { label: 'Ordre + TP/SL (normalTpsl)', d: sign(order) }];
}

function hlError(body) {
  if (!body || body.status !== 'ok') return typeof body?.response === 'string' ? body.response : 'Réponse non ok';
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
      { label: `2. Nouveau TP/SL position (SL ${plan.place.sl ?? '—'} · TP ${plan.place.tp ?? '—'})`, d: mkPlace() },
      ...plan.cancelAfter.map((o) => ({ label: '3. ' + legLabel(o), d: mkCancel(String(o.orderId)) }))];
    return { ok: true, results: [{ label: 'DRY RUN — non envoyé', ok: true, dry: true, payload: showPayload(reqs) }] };
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
      st.testnet ? h('span', { class: 'badge' }, 'TESTNET') : null, h('span', { class: 'badge' }, S.secrets ? '🔓' : '🔒')));
}
function go(v, extra) { S.view = v; Object.assign(S, extra || {}); render(); window.scrollTo(0, 0); }
function render() {
  const app = $app(); app.replaceChildren(header());
  const views = { home: viewHome, confirm: viewConfirm, settings: viewSettings, positions: viewPositions, log: viewLog };
  (views[S.view] || viewHome)(app);
  if (tg) { if (S.view !== 'home') tg.BackButton.show(); else tg.BackButton.hide(); }
}

function viewHome(app) {
  const ta = h('textarea', { rows: 3, placeholder: 'Colle ici un lien ou un code de proposition (v1.…)' });
  app.append(
    h('section', { class: 'card' }, h('h2', {}, 'Proposition'), ta,
      h('button', { class: 'btn primary big', onclick: () => openProposal(ta.value) }, 'Ouvrir la proposition')),
    h('div', { class: 'grid' },
      h('button', { class: 'btn tile', onclick: () => go('positions') }, '📊', h('span', {}, 'Positions & ordres')),
      h('button', { class: 'btn tile', onclick: () => go('log') }, '🧾', h('span', {}, 'Journal')),
      h('button', { class: 'btn tile', onclick: () => go('settings') }, '⚙️', h('span', {}, 'Réglages')),
      h('button', { class: 'btn tile', onclick: () => { lockNow(); render(); toast('Clés verrouillées'); } }, '🔒', h('span', {}, 'Verrouiller'))),
    h('p', { class: 'muted small' }, 'Les ordres sont signés sur ce téléphone et partent de ta connexion. Rien n’est envoyé sans ton appui sur « Approuver ».'));
}

function openProposal(input) {
  const tok = extractToken(input);
  if (!tok) { toast('Aucune proposition reconnue', 'err'); return; }
  try { go('confirm', { proposal: decodeProposal(tok), ctx: null, risk: null, result: null, ack: false }); }
  catch (e) { toast(e.message, 'err'); }
}

function kv(rows) { return h('table', { class: 'kv' }, rows.filter(Boolean).map(([k, v, cls]) => h('tr', {}, h('th', {}, k), h('td', { class: cls || '' }, v)))); }

function viewConfirm(app) {
  const p = S.proposal;
  if (!p) return go('home');
  if (S.result) { app.append(h('section', { class: 'card' }, h('h1', {}, `${p.act} ${p.m}`))); return renderResult(app); }
  const pfName = p.pf === 'arcus' ? '🏹 Arcus' : (p.m.includes(':') ? '🤖 Hyperliquid ' + p.m.split(':')[0] : '🤖 Hyperliquid');
  const title = p.act === 'cancel' ? `❌ Annuler un ordre ${p.m}` : p.act === 'tpsl' ? `TP/SL sur ${p.m}` : `${p.sd === 'long' ? '🟢 LONG' : '🔴 SHORT'} ${p.m}`;
  const card = h('section', { class: 'card' }, h('div', { class: 'muted small' }, pfName + ' · id ' + p.id), h('h1', {}, title));
  if (p.n) card.append(h('p', { class: 'note' }, p.n));
  card.append(kv([
    p.act === 'open' && ['Taille', String(p.sz)], p.act === 'open' && ['Levier', p.lev + '× isolé'],
    p.act === 'open' && ['Entrée', p.et === 'market' ? 'Market (IOC)' : 'Limite ' + fmtPx(p.px)],
    p.act === 'cancel' && ['Ordre (oid)', String(p.oid)],
    p.act !== 'cancel' && ['Stop-loss', p.sl != null ? fmtPx(p.sl) : '—'], p.act !== 'cancel' && ['Take-profit', p.tp != null ? fmtPx(p.tp) : '—'],
    p.ref != null && ['Prix de réf.', fmtPx(p.ref)], p.exp && ['Expire', new Date(p.exp * 1000).toLocaleString('fr-FR')]]));
  app.append(card);
  const live = h('section', { class: 'card' }, h('div', { class: 'spin' }), ' Chargement du prix en direct…');
  app.append(live);
  (async () => {
    try {
      const c = await loadContext(p); const r = riskFor(p, c); S.ctx = c; S.risk = r;
      live.replaceChildren(h('h2', {}, 'Contrôle en direct'), kv([
        p.act === 'cancel' && c.order && ['Ordre trouvé', c.pf === 'hl' ? `${c.order.orderType} ${c.order.side === 'B' ? 'achat' : 'vente'} ${c.order.sz}${Number(c.order.triggerPx) ? ' · déclencheur ' + c.order.triggerPx : ' @ ' + c.order.limitPx}` : `${c.order.type || ''} ${c.order.side || ''} ${c.order.triggerPrice || c.order.price || ''}`],
        c.plan && ['SL actuel', c.plan.current.sl.length ? c.plan.current.sl.map(fmtPx).join(' + ') : 'aucun', c.plan.current.sl.length ? '' : 'red'],
        c.plan && ['TP actuel', c.plan.current.tp.length ? c.plan.current.tp.map(fmtPx).join(' + ') : 'aucun'],
        c.plan && ['Après', `SL ${c.plan.place.sl != null ? fmtPx(c.plan.place.sl) : '—'}${c.plan.carried.sl ? ' (gardé)' : ''} · TP ${c.plan.place.tp != null ? fmtPx(c.plan.place.tp) : '—'}${c.plan.carried.tp ? ' (gardé)' : ''}`, 'green'],
        c.plan && c.plan.replaces && ['Remplacement', `annule ${c.plan.cancelFirst.length} ordre(s) TP/SL position → place le nouveau → vérifie${c.plan.cancelAfter.length ? ` → annule ${c.plan.cancelAfter.length} ordre(s) lié(s) à l’entrée` : ''}`],
        ['Mark', fmtPx(c.mark)], r.moved != null && ['Écart vs réf.', fmt(r.moved * 100) + ' %', r.moved > 0.01 ? 'red' : ''],
        p.act === 'open' && ['Taille arrondie', String(c.size)], r.entry != null && [r.entryLabel, fmtPx(r.entry)],
        r.notional != null && ['Notionnel', fmt(r.notional) + ' $'], p.act === 'open' && ['Marge', fmt(r.margin) + ' $'],
        c.free != null && p.act === 'open' && ['Collatéral libre', fmt(c.free) + ' $'],
        ['Frais taker', fmt(c.fee * 100, 4) + ' %/côté'], ['Levier max', c.maxLev + '×'],
        r.slLocked != null ? ['Gain verrouillé au SL (frais incl.)', '+' + fmt(r.slLocked) + ' $', 'green']
          : r.slLoss != null && ['Perte au SL (frais incl.)', '−' + fmt(r.slLoss) + ' $', r.slLoss >= S.settings.maxLoss ? 'red' : 'green'],
        r.tpGain != null && ['Gain au TP (frais incl.)', (r.tpGain < 0 ? '−' : '+') + fmt(Math.abs(r.tpGain)) + ' $', r.tpGain < 0 ? 'red' : 'green'],
        r.liq != null && p.act === 'open' && ['Liquidation estimée', fmtPx(r.liq)]]));
      const box = h('div');
      for (const b of r.blocks) box.append(h('div', { class: 'alert block' }, '⛔ ' + b));
      for (const w of r.warns) box.append(h('div', { class: 'alert warn' }, '⚠️ ' + w));
      live.append(box);
      const approve = h('button', { class: 'btn approve', disabled: r.blocks.length > 0 || r.warns.length > 0 ? true : null, onclick: () => approveFlow(approve) },
        S.settings.dryRun ? 'Approuver (dry run, rien n’est envoyé)' : 'Approuver et envoyer');
      if (r.blocks.length) approve.textContent = 'Bloqué';
      else if (r.warns.length) {
        const cb = h('input', { type: 'checkbox', id: 'ack' });
        cb.addEventListener('change', () => { approve.disabled = !cb.checked; approve.classList.toggle('danger', cb.checked); });
        live.append(h('label', { class: 'ack', for: 'ack' }, cb, ' Je confirme malgré les alertes en rouge'));
      }
      live.append(approve, h('button', { class: 'btn ghost', onclick: () => go('home') }, 'Refuser'));
    } catch (e) { live.replaceChildren(h('div', { class: 'alert block' }, '⛔ ' + e.message)); }
  })();
}

async function approveFlow(btn) {
  const p = S.proposal, st = S.settings;
  btn.disabled = true;
  let busy = null;
  try {
    const sec = await ensureUnlocked();
    busy = showBusy(st.dryRun ? 'Signature (dry run)…' : 'Signature et envoi…');
    // re-check live mark right before signing
    const c = await loadContext(p);
    if (p.act !== 'cancel' && Math.abs(c.mark - S.ctx.mark) / S.ctx.mark > 0.01) throw new Error('Le prix a bougé de plus de 1 % pendant la confirmation. Recharge.');
    const r = riskFor(p, c);
    if (r.blocks.length) throw new Error(r.blocks.join(' / '));
    let results, extra = {};
    if (p.pf === 'arcus' && p.act === 'tpsl') {
      const rr = await arcusTpslReplace(p, c, sec, st.dryRun); results = rr.results; extra = { critical: rr.critical, restore: rr.restore, okAll: rr.ok };
    } else {
      const offset = p.pf === 'arcus' ? await API.arcusClockOffsetMs(base().arcus).catch(() => 0) : 0;
      const reqs = buildRequests(p, c, sec, offset);
      if (st.dryRun) results = [{ label: 'DRY RUN — non envoyé', ok: true, dry: true, payload: showPayload(reqs) }];
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
  const sec = h('section', { class: 'card' }, h('h2', { class: r.ok ? 'green' : 'red' }, r.ok ? '✅ Terminé' : '❌ Erreur'));
  if (r.critical) sec.append(h('div', { class: 'alert block' }, '🚨 ' + r.critical));
  const p0 = S.proposal;
  if (r.restore && (r.restore.sl != null || r.restore.tp != null) && p0) {
    const rp = { v: 1, id: p0.id + '-r', pf: 'arcus', m: p0.m, act: 'tpsl', sl: r.restore.sl ?? undefined, tp: r.restore.tp ?? undefined,
      exp: Math.floor(Date.now() / 1000) + 900, n: 'Remise de l’ancien TP/SL après échec du remplacement' };
    sec.append(h('button', { class: 'btn danger big', onclick: () => go('confirm', { proposal: rp, ctx: null, risk: null, result: null }) },
      `Remettre l’ancien TP/SL (SL ${r.restore.sl ?? '—'} · TP ${r.restore.tp ?? '—'})`));
  }
  for (const x of r.results) {
    sec.append(h('div', { class: 'muted' }, x.label + (x.status ? ' · HTTP ' + x.status : '')));
    if (x.error) sec.append(h('div', { class: x.retried ? 'alert warn' : 'alert block' }, (x.retried ? 'Réessayé : ' : '') + x.error));
    sec.append(h('pre', {}, JSON.stringify(x.payload || x.body, null, 1)));
  }
  sec.append(h('button', { class: 'btn primary big', onclick: () => go('home', { proposal: null, result: null }) }, 'Retour'));
  app.append(sec);
}

// ---------------------------------------------------------------- positions / close / cancel
function viewPositions(app) {
  const st = S.settings;
  const box = h('section', { class: 'card' }, h('div', { class: 'spin' }), ' Chargement…');
  app.append(box);
  (async () => {
    const parts = [];
    if (st.arcusAddress) {
      try {
        const [pos, oo] = await Promise.all([API.arcusPositions(base().arcus, st.arcusAddress, st.arcusSub), API.arcusOpenOrders(base().arcus, st.arcusAddress, st.arcusSub)]);
        parts.push(h('h2', {}, '🏹 Arcus'));
        for (const p of pos) parts.push(h('div', { class: 'pos' }, h('div', {}, h('b', {}, `${p.marketDisplayName} ${p.side} ${p.size}`),
          h('div', { class: 'muted small' }, `entrée ${fmtPx(p.averageEntryPrice)} · uPnL ${fmt(p.unrealizedPnl)} $`)),
          h('button', { class: 'btn danger', onclick: () => manage('arcus', 'close', p) }, 'Fermer')));
        for (const o of oo) parts.push(h('div', { class: 'pos' }, h('div', {}, h('b', {}, `${o.marketDisplayName} ${o.side} ${o.tpslType || o.type}`),
          h('div', { class: 'muted small' }, `${o.remainingSize}/${o.originalSize} @ ${o.price}${o.triggerPrice ? ' trig ' + o.triggerPrice : ''}`)),
          h('button', { class: 'btn ghost', onclick: () => manage('arcus', 'cancel', o) }, 'Annuler')));
        if (!pos.length && !oo.length) parts.push(h('p', { class: 'muted' }, 'Rien d’ouvert.'));
      } catch (e) { parts.push(h('div', { class: 'alert block' }, 'Arcus: ' + e.message)); }
    }
    if (st.hlMaster) {
      for (const dex of ['', ...String(st.hlDexes || '').split(',').map((x) => x.trim()).filter(Boolean)]) {
        try {
          const [s, oo] = await Promise.all([API.hlState(base().hl, st.hlMaster, dex), API.hlOpenOrders(base().hl, st.hlMaster, dex)]);
          parts.push(h('h2', {}, '🤖 Hyperliquid ' + (dex || 'main') + ` · libre ${fmt(s.withdrawable)} $`));
          const ps = (s.assetPositions || []).map((x) => x.position);
          for (const p of ps) parts.push(h('div', { class: 'pos' }, h('div', {}, h('b', {}, `${p.coin} ${Number(p.szi) > 0 ? 'LONG' : 'SHORT'} ${Math.abs(p.szi)}`),
            h('div', { class: 'muted small' }, `entrée ${fmtPx(p.entryPx)} · uPnL ${fmt(p.unrealizedPnl)} $ · liq ${fmtPx(p.liquidationPx)}`)),
            h('button', { class: 'btn danger', onclick: () => manage('hl', 'close', p) }, 'Fermer')));
          for (const o of oo) parts.push(h('div', { class: 'pos' }, h('div', {}, h('b', {}, `${o.coin} ${o.side === 'B' ? 'achat' : 'vente'} ${o.orderType || ''}`),
            h('div', { class: 'muted small' }, `${o.sz} @ ${o.limitPx}${o.isTrigger ? ' trig ' + o.triggerPx : ''}`)),
            h('button', { class: 'btn ghost', onclick: () => manage('hl', 'cancel', o) }, 'Annuler')));
          if (!ps.length && !oo.length) parts.push(h('p', { class: 'muted' }, 'Rien d’ouvert.'));
        } catch (e) { parts.push(h('div', { class: 'alert block' }, `HL ${dex || 'main'}: ` + e.message)); }
      }
    }
    if (!parts.length) parts.push(h('p', {}, 'Renseigne tes adresses dans Réglages.'));
    box.replaceChildren(...parts);
  })();
}

async function manage(pf, what, item) {
  const st = S.settings;
  const name = pf === 'arcus' ? (item.marketDisplayName) : item.coin;
  const msg = what === 'close' ? `Fermer toute la position ${name} au market ?` : `Annuler l’ordre ${name} ?`;
  if (!(await confirmDialog(msg + (st.dryRun ? ' (dry run)' : '')))) return;
  let busy = null;
  try {
    const sec = await ensureUnlocked();
    busy = showBusy('Signature…');
    let reqs;
    if (pf === 'arcus') {
      const m = await API.arcusMarket(base().arcus, name);
      const ctx = arcusCtx(sec, await API.arcusClockOffsetMs(base().arcus).catch(() => 0));
      reqs = [{ label: what === 'close' ? 'Fermeture' : 'Annulation', d: what === 'close' ? A.closePosition(ctx, m, item, { slippage: st.slippage }) : A.cancelOrder(ctx, m, item.orderId) }];
    } else {
      const mk = await API.hlMarket(base().hl, name);
      const priv = H.keyFromHex(sec.hl.key);
      const action = what === 'close' ? H.buildClose({ asset: mk.asset, szDecimals: mk.szDecimals, szi: item.szi, markPx: mk.midPx || mk.markPx, slippage: st.slippage })
        : H.buildCancel(mk.asset, item.oid);
      reqs = [{ label: what === 'close' ? 'Fermeture' : 'Annulation', d: H.exchangeRequest(priv, action, Date.now(), { isMainnet: !st.testnet }) }];
    }
    const results = st.dryRun ? [{ label: 'DRY RUN — non envoyé', ok: true, dry: true, payload: showPayload(reqs) }] : await execute(pf, reqs);
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
    return `${new Date(e.t).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })} [${e.pf}${e.testnet ? ' testnet' : ''}${e.dry ? ' DRY' : ''}] ${e.ok ? 'OK' : 'ERREUR'} ${what}${e.slLoss != null ? ` (SL −${Number(e.slLoss).toFixed(0)}$)` : ''}${err ? ' — ' + err : ''} #${e.id}`;
  }).join('\n');
}
function viewLog(app) {
  const txt = logText() || 'Journal vide.';
  app.append(h('section', { class: 'card' }, h('h2', {}, 'Journal des trades'), h('pre', { class: 'log' }, txt),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: async () => { try { await navigator.clipboard.writeText(txt); toast('Copié ✅'); } catch { toast('Copie impossible', 'err'); } } }, 'Copier'),
      h('button', { class: 'btn primary', onclick: () => {
        const u = 'https://t.me/share/url?url=' + encodeURIComponent('Journal Bobby Trade') + '&text=' + encodeURIComponent(txt.slice(0, 3500));
        if (tg) tg.openTelegramLink(u); else window.open(u, '_blank');
      } }, 'Partager'))));
}

// ---------------------------------------------------------------- settings
function viewSettings(app) {
  const st = S.settings;
  const f = {
    aKey: h('input', { type: 'password', autocomplete: 'off', placeholder: 'Clé privée Ed25519 Arcus (64 hex)' }),
    aAddr: h('input', { value: st.arcusAddress, autocomplete: 'off' }), aSub: h('input', { type: 'number', value: st.arcusSub, inputmode: 'numeric' }),
    hKey: h('input', { type: 'password', autocomplete: 'off', placeholder: 'Clé privée API wallet HL (0x + 64 hex)' }),
    hAddr: h('input', { value: st.hlMaster, autocomplete: 'off', placeholder: 'Adresse principale 0x…' }),
    pin: h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'new-password', placeholder: 'PIN (6 chiffres min.)' }),
    pin2: h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'new-password', placeholder: 'Confirme le PIN' }),
  };
  const info = h('div', { class: 'muted small' }, '…');
  KS.secureBackend().then((b) => KS.hasKeystore().then((has) => { info.textContent = `Stockage : ${b.name} · ${has ? 'clés enregistrées (chiffrées par PIN)' : 'aucune clé'}`; }));
  const save = async () => {
    try {
      if (f.pin.value.length < 6 || f.pin.value !== f.pin2.value) throw new Error('PIN : 6 caractères min. et identiques');
      const prev = S.secrets || ((await KS.hasKeystore()) ? await ensureUnlocked() : {});
      const sec = { arcus: { ...(prev.arcus || {}) }, hl: { ...(prev.hl || {}) } };
      if (f.aKey.value) { A.keyFromHex(f.aKey.value); sec.arcus.key = f.aKey.value.trim(); }
      if (f.hKey.value) { H.keyFromHex(f.hKey.value); sec.hl.key = f.hKey.value.trim(); }
      sec.arcus.address = f.aAddr.value.trim(); sec.arcus.sub = Number(f.aSub.value || 0); sec.hl.master = f.hAddr.value.trim();
      if (sec.hl.master && !/^0x[0-9a-fA-F]{40}$/.test(sec.hl.master)) throw new Error('Adresse HL invalide');
      if (sec.arcus.address && !/^0x[0-9a-fA-F]{40}$/.test(sec.arcus.address)) throw new Error('Adresse Arcus invalide');
      const busy = showBusy('Chiffrement…');
      try { const where = await KS.saveKeystore(sec, f.pin.value); toast('Clés enregistrées dans ' + where); } finally { busy(); }
      Object.assign(st, { arcusAddress: sec.arcus.address, arcusSub: sec.arcus.sub, hlMaster: sec.hl.master }); await saveSettings();
      S.secrets = sec; touchLock(); f.aKey.value = f.hKey.value = f.pin.value = f.pin2.value = ''; render();
    } catch (e) { toast(e.message, 'err'); }
  };
  const check = h('pre', { class: 'small' });
  const test = async () => {
    check.textContent = 'Vérification (lecture seule)…';
    const lines = [];
    try {
      const sec = await ensureUnlocked();
      if (sec.arcus?.key) {
        const ctx = arcusCtx(sec, await API.arcusClockOffsetMs(base().arcus).catch(() => 0));
        lines.push('Arcus clé publique : ' + ctx.apiKey.slice(0, 10) + '…');
        const keys = await API.arcusApiKeys(base().arcus, sec.arcus.address);
        const mine = keys.find((k) => k.apiKey.toLowerCase() === ctx.apiKey.toLowerCase());
        lines.push(mine ? `  enregistrée : ${mine.status}, valide jusqu’au ${mine.validUntil ? new Date(mine.validUntil).toLocaleString('fr-FR') : '—'}` : '  ⚠️ clé non trouvée pour cette adresse');
        const r = await API.sendArcus(base().arcus, A.signedGet(ctx, '/v1/affiliate/code'));
        lines.push('  requête signée : ' + (r.ok ? 'OK ✅' : 'HTTP ' + r.status));
      }
      if (sec.hl?.key) {
        const agent = H.addressOf(H.keyFromHex(sec.hl.key));
        lines.push('HL API wallet : ' + agent);
        const role = await API.hlUserRole(base().hl, agent);
        const okm = role?.role === 'agent' && role?.data?.user?.toLowerCase() === (sec.hl.master || '').toLowerCase();
        lines.push('  rôle : ' + JSON.stringify(role) + (okm ? ' ✅' : ' ⚠️ non approuvé pour l’adresse principale'));
      }
    } catch (e) { lines.push('Erreur : ' + e.message); }
    check.textContent = lines.join('\n');
  };
  const wipe = async () => {
    if (!(await confirmDialog('Effacer définitivement les clés de ce téléphone ?'))) return;
    await KS.wipeKeystore(); lockNow(); toast('Clés effacées'); render();
  };
  const tog = (key, label) => { const c = h('input', { type: 'checkbox', checked: st[key] });
    c.addEventListener('change', async () => {
      if (key === 'dryRun' && !c.checked && !(await confirmDialog('Désactiver le dry run ? Les ordres seront réellement envoyés.'))) { c.checked = true; return; }
      st[key] = c.checked; await saveSettings(); render(); });
    return h('label', { class: 'toggle' }, c, ' ' + label); };
  const num = (key, label, step) => { const i = h('input', { type: 'number', step, value: st[key] });
    i.addEventListener('change', async () => { const v = Number(i.value); if (Number.isFinite(v) && v > 0) { st[key] = v; await saveSettings(); } });
    return h('label', { class: 'field' }, label, i); };
  app.append(
    h('section', { class: 'card' }, h('h2', {}, 'Mode'), tog('dryRun', 'Dry run (signe sans envoyer)'), tog('testnet', 'Testnet (Arcus + Hyperliquid)'),
      num('maxLoss', 'Perte max par SL ($)', '1'), num('slippage', 'Slippage market (0,02 = 2 %)', '0.005'),
      num('feeIo', 'Frais HL io / côté', '0.00001'), num('feeMain', 'Frais HL main / côté', '0.00001')),
    h('section', { class: 'card' }, h('h2', {}, 'Clés'), info,
      h('h3', {}, '🏹 Arcus'), f.aKey, h('label', { class: 'field' }, 'Adresse propriétaire', f.aAddr), h('label', { class: 'field' }, 'Sous-compte', f.aSub),
      h('h3', {}, '🤖 Hyperliquid / Entropy'), f.hKey, h('label', { class: 'field' }, 'Adresse principale (master)', f.hAddr),
      h('h3', {}, 'PIN'), f.pin, f.pin2,
      h('p', { class: 'muted small' }, 'Laisse un champ de clé vide pour garder la clé déjà enregistrée. Les clés sont chiffrées par ton PIN (PBKDF2 600 000 itérations + AES-GCM) et ne quittent jamais ce téléphone.'),
      h('button', { class: 'btn primary big', onclick: save }, 'Enregistrer (chiffré)'),
      h('button', { class: 'btn ghost', onclick: test }, 'Vérifier les clés (lecture seule)'), check,
      h('button', { class: 'btn danger', onclick: wipe }, 'Effacer les clés')));
}

// ---------------------------------------------------------------- boot
async function boot() {
  if (tg) {
    tg.ready(); tg.expand();
    try { tg.setHeaderColor('bg_color'); } catch { /* */ }
    tg.BackButton.onClick(() => go('home', { result: null }));
  }
  await loadSettings();
  render();
  const tok = extractToken(LAUNCH_URL) || (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param ? extractToken('p=' + tg.initDataUnsafe.start_param) : null);
  if (tok) openProposal(tok);
}
document.addEventListener('visibilitychange', () => { if (document.hidden) { /* keep timer */ } });
boot();
