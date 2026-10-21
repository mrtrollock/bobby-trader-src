// Bobby autotrader core: headless, policy-gated maker trading on Arcus, Entropy (Hyperliquid dex "io") and QFEX.
// Reuses the app's signing (src/arcus.js, src/hl.js, src/qfex.js), policy (src/risk.js) and fee (src/fees.js) code.
// Every network call goes through `net` (real or mocked), so the whole decision path is testable offline.
import * as A from '../src/arcus.js';
import * as H from '../src/hl.js';
import * as Q from '../src/qfex.js';
import * as API from '../src/api.js';
import * as F from '../src/fees.js';
import { computeRisk, checkPolicy, POLICY, weekStartUtc, realizedLoss, assertTradeOnly } from '../src/risk.js';

export const MAX_POSITIONS = 3;
export const MAX_DRIFT = 0.01;
const PF_ALIASES = { arcus: 'arcus', entropy: 'entropy', hl: 'entropy', hyperliquid: 'entropy', qfex: 'qfex' };
export const PLATFORMS = ['arcus', 'entropy', 'qfex'];
const KEY_OF = { arcus: 'arcus', entropy: 'hl', qfex: 'qfex' };
const POL_PF = { arcus: 'arcus', entropy: 'hl', qfex: 'qfex' };

// ---------------------------------------------------------------- config from env (keys never leave this object)
export function loadConfig(env = process.env) {
  const net = env.AUTOTRADER_NETWORK;
  if (!['mainnet', 'testnet'].includes(net)) throw new Error('AUTOTRADER_NETWORK must be set to "testnet" or "mainnet"');
  const testnet = net === 'testnet';
  const cfg = {
    network: net, testnet, bases: API.bases(testnet),
    enabled: env.AUTOTRADER_ENABLED === '1',
    live: env.AUTOTRADER_LIVE === '1',            // DRY RUN unless explicitly 1
    dexes: String(env.AUTOTRADER_HL_DEXES || 'io').split(',').map((s) => s.trim()).filter(Boolean),
    maxPositions: Number(env.AUTOTRADER_MAX_POSITIONS || MAX_POSITIONS),
    arcus: env.ARCUS_API_PRIVATE_KEY ? { key: env.ARCUS_API_PRIVATE_KEY.trim(), address: String(env.ARCUS_ACCOUNT_ADDRESS || '').trim(),
      accountIndex: Number(env.ARCUS_ACCOUNT_INDEX || 0) } : null,
    hl: env.HL_AGENT_PRIVATE_KEY ? { key: env.HL_AGENT_PRIVATE_KEY.trim(), address: String(env.HL_ACCOUNT_ADDRESS || '').trim() } : null,
    // QFEX: HMAC API key pair. Must be scoped to ONE account with only execute + view permissions (see README).
    qfex: env.QFEX_API_PUBLIC_KEY || env.QFEX_API_SECRET_KEY ? { pub: String(env.QFEX_API_PUBLIC_KEY || '').trim(), secret: String(env.QFEX_API_SECRET_KEY || '').trim(),
      accountId: String(env.QFEX_ACCOUNT_ID || '').trim() || null, ack: env.QFEX_KEY_SINGLE_ACCOUNT_ACK === '1', allowMain: env.QFEX_ALLOW_MAIN_ACCOUNT === '1',
      slippage: env.QFEX_SL_SLIPPAGE != null && env.QFEX_SL_SLIPPAGE !== '' ? Number(env.QFEX_SL_SLIPPAGE) : null,
      categories: String(env.QFEX_CATEGORIES || Q.ALLOWED_CATEGORIES.join(',')).toUpperCase().split(',').map((x) => x.trim()).filter((x) => Q.ALLOWED_CATEGORIES.includes(x)) } : null,
    // public addresses for status without keys
    arcusAddress: String(env.ARCUS_ACCOUNT_ADDRESS || '').trim(), arcusIndex: Number(env.ARCUS_ACCOUNT_INDEX || 0),
    hlAddress: String(env.HL_ACCOUNT_ADDRESS || '').trim(),
  };
  for (const [k, v] of [['ARCUS_ACCOUNT_ADDRESS', cfg.arcusAddress], ['HL_ACCOUNT_ADDRESS', cfg.hlAddress]])
    if (v && !/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(k + ' is not a 0x address');
  if (cfg.arcus && !cfg.arcus.address) throw new Error('ARCUS_ACCOUNT_ADDRESS is required with ARCUS_API_PRIVATE_KEY');
  if (cfg.hl && !cfg.hl.address) throw new Error('HL_ACCOUNT_ADDRESS is required with HL_AGENT_PRIVATE_KEY');
  // parse now so a malformed key fails early (the error message never contains the key)
  if (cfg.arcus) { cfg.arcus.priv = A.keyFromHex(cfg.arcus.key); cfg.arcus.apiKey = A.apiKeyOf(cfg.arcus.priv); }
  if (cfg.hl) { cfg.hl.priv = H.keyFromHex(cfg.hl.key); cfg.hl.agent = H.addressOf(cfg.hl.priv); }
  if (cfg.qfex) {
    Q.checkCreds(cfg.qfex);
    if (cfg.qfex.slippage != null && !(cfg.qfex.slippage >= 0 && cfg.qfex.slippage < 0.02)) throw new Error('QFEX_SL_SLIPPAGE must be a fraction between 0 and 0.02');
  }
  cfg.bases.qfex = Q.bases(testnet);
  return cfg;
}
export const secretsOf = (cfg) => [cfg.arcus && cfg.arcus.key, cfg.hl && cfg.hl.key, cfg.qfex && cfg.qfex.secret, cfg.qfex && cfg.qfex.pub].filter(Boolean);

export function realNet(cfg) {
  return {
    arcusGet: (path, params) => API.arcusGet(cfg.bases.arcus, path, params),
    hlInfo: (body) => API.hlInfo(cfg.bases.hl, body),
    sendArcus: (d) => API.sendArcus(cfg.bases.arcus, d),
    sendHl: (d) => { const a = JSON.parse(d.body).action; assertTradeOnly('action', a); return API.sendHl(cfg.bases.hl, d); },
    arcusClockOffsetMs: () => API.arcusClockOffsetMs(cfg.bases.arcus),
    qfex: Q.makeNet(cfg.bases.qfex, cfg.qfex),
    now: () => Date.now(),
  };
}

// ---------------------------------------------------------------- startup key checks (abort on any doubt)
export async function verifyKeys(cfg, net) {
  const out = {};
  if (cfg.arcus) {
    const keys = (await net.arcusGet('/v1/apiKeys', { address: cfg.arcus.address })).apiKeys || [];
    const mine = keys.find((k) => String(k.apiKey).toLowerCase() === cfg.arcus.apiKey.toLowerCase());
    if (!mine) throw new Error('Arcus: this API key is not registered for ARCUS_ACCOUNT_ADDRESS');
    if (mine.status !== 'ACTIVE') throw new Error('Arcus: API key status is ' + mine.status);
    if (mine.validUntil && Number(mine.validUntil) < net.now()) throw new Error('Arcus: API key expired');
    const perms = Array.isArray(mine.permissions) ? mine.permissions : mine.permissions ? [mine.permissions] : [];
    if (perms.length) throw new Error('Arcus: API key has extra permissions (' + perms.join(',') + '); a trade-only key is required');
    if (!mine.allSubaccounts && Number(mine.accountIndex ?? 0) !== cfg.arcus.accountIndex)
      throw new Error(`Arcus: key is scoped to subaccount ${mine.accountIndex}, not ARCUS_ACCOUNT_INDEX=${cfg.arcus.accountIndex}`);
    out.arcus = { apiKey: cfg.arcus.apiKey.slice(0, 10) + '…', status: mine.status, permissions: 'trade-only' };
  }
  if (cfg.hl) {
    if (cfg.hl.agent.toLowerCase() === cfg.hl.address.toLowerCase()) throw new Error('Hyperliquid: HL_AGENT_PRIVATE_KEY is the MAIN account key; use an agent (API) wallet');
    const role = await net.hlInfo({ type: 'userRole', user: cfg.hl.agent });
    const master = role && role.data && (role.data.user || role.data.master);
    if (!role || role.role !== 'agent' || String(master || '').toLowerCase() !== cfg.hl.address.toLowerCase())
      throw new Error('Hyperliquid: agent wallet is not approved for HL_ACCOUNT_ADDRESS (userRole=' + JSON.stringify(role && role.role) + ')');
    out.hl = { agent: cfg.hl.agent.slice(0, 8) + '…', role: 'agent' };
  }
  if (cfg.qfex) out.qfex = await verifyQfex(cfg, net);
  return out;
}

// QFEX has no endpoint that lists a key's permissions, and the only withdraw-capable paths live on the funding service,
// which this code never calls. What CAN be detected without side effects: whether the key reaches more than one account.
// Withdraw permission ("deposit_withdraw") only exists on keys with "All accounts" access, so a key that can read a
// second account is refused. A key on an account with no sibling cannot be distinguished: then the user's explicit
// QFEX_KEY_SINGLE_ACCOUNT_ACK=1 (single account, execute + view only, withdraw unticked) is required. It is required always.
export async function verifyQfex(cfg, net) {
  const q = cfg.qfex;
  if (!q.ack) throw new Error('QFEX: set QFEX_KEY_SINGLE_ACCOUNT_ACK=1 only after confirming the API key is scoped to ONE specific account with ' +
    'only "Execute orders" + view permissions and "Deposit and withdraw" unticked (QFEX cannot report key permissions)');
  const lst = await net.qfex.get('/user/subaccounts/balance', null, { accountId: null }).catch((e) => { throw new Error('QFEX: API key rejected or no read permission (' + e.message + ')'); });
  const accounts = (lst && lst.accounts) || [];
  if (!q.accountId && accounts.length > 1) throw new Error('QFEX: the key sees ' + accounts.length + ' accounts; set QFEX_ACCOUNT_ID to the UUID of the trading (sub)account');
  const target = q.accountId || (accounts[0] || {}).account_id || null;
  if (q.accountId && accounts.length && !accounts.some((a) => a.account_id === q.accountId)) throw new Error('QFEX: QFEX_ACCOUNT_ID is not one of this key\'s accounts');
  // Builder/wallet-registered keys (the only kind that can withdraw without "All accounts") are restricted to the MAIN
  // account, so a key that trades a SUBACCOUNT cannot be one of them. Refuse the main account when the API says it is.
  const tRow = accounts.find((a) => a.account_id === target);
  if (tRow && tRow.is_master === true && !q.allowMain) throw new Error('QFEX: the configured account is the MAIN account; trade from a dedicated subaccount ' +
    '(create one, move ~$300 to it in the QFEX UI, scope the key to it and set QFEX_ACCOUNT_ID). Override: QFEX_ALLOW_MAIN_ACCOUNT=1');
  const own = await net.qfex.getRaw('/user/positions', null, { accountId: q.accountId });
  if (!own.ok) throw new Error(`QFEX: key cannot read the configured account (HTTP ${own.status}); check QFEX_ACCOUNT_ID and the view permissions`);
  const others = accounts.map((a) => a.account_id).filter((id) => id && id !== target);
  for (const id of others) {
    const r = await net.qfex.getRaw('/user/positions', null, { accountId: id });
    if (r.ok) throw new Error('QFEX: this API key can read more than one account ("All accounts" scope, which is the only scope that can carry ' +
      'withdraw permission). Create a key scoped to ONE specific account with execute + view only.');
    if (![401, 403, 404].includes(r.status)) throw new Error(`QFEX: could not verify the key scope (HTTP ${r.status} on another account); aborting on doubt`);
  }
  return { key: q.pub.slice(0, 12) + '…', account: (target ? target.slice(0, 8) + '…' : 'primary') + (tRow && tRow.is_master === false ? ' (subaccount)' : ''), scope: others.length ? 'single account (verified: ' + others.length + ' other account(s) refused)' : 'single account (acknowledged, not detectable)',
    permissions: 'withdraw/funding never called; ack=1' };
}

// ---------------------------------------------------------------- proposals
export function normalizeProposal(q) {
  const p = {
    id: q.id, pf: PF_ALIASES[String(q.pf ?? q.platform ?? '').toLowerCase()] || String(q.pf ?? q.platform ?? '').toLowerCase(),
    m: q.m ?? q.market, sd: String(q.sd ?? q.side ?? '').toLowerCase(), et: q.et ?? q.type ?? 'limit',
    px: Number(q.px ?? q.limit ?? q.price), sz: Number(q.sz ?? q.size), lev: Number(q.lev ?? q.leverage ?? 1),
    sl: q.sl ?? q.stopLoss, tp: q.tp ?? q.takeProfit, exp: Number(q.exp ?? q.expiry), ref: Number(q.ref ?? q.refPrice), n: q.n ?? q.rationale ?? '',
    act: 'open', postOnly: q.postOnly !== false,
  };
  if (p.sd === 'buy') p.sd = 'long'; if (p.sd === 'sell') p.sd = 'short';
  p.sl = p.sl == null || p.sl === '' ? null : Number(p.sl); p.tp = p.tp == null || p.tp === '' ? null : Number(p.tp);
  return p;
}
function basicChecks(p, cfg, nowS) {
  const b = [];
  if (!p.id) b.push('missing id');
  if (p.pf === 'txflow') b.push('TxFlow is manual only: use the app');
  else if (!PLATFORMS.includes(p.pf)) b.push('unknown platform ' + p.pf);
  else if (!cfg[KEY_OF[p.pf]]) b.push(`${p.pf}: no key configured`);
  if (p.pf === 'entropy' && !cfg.dexes.includes(H.dexOf(String(p.m || '')))) b.push(`Entropy market must be on dex ${cfg.dexes.join('/')} (e.g. io:ANTH)`);
  if (!p.m) b.push('missing market');
  if (!['long', 'short'].includes(p.sd)) b.push('side must be long or short');
  if (p.et !== 'limit') b.push('Policy: post-only limit entries only');
  if (p.postOnly === false) b.push('Policy: postOnly cannot be disabled');
  if (!(p.px > 0)) b.push('missing limit price');
  if (!(p.sz > 0)) b.push('missing size');
  if (!(p.lev >= 1) || p.lev > POLICY.maxLeverage) b.push(`Policy: leverage ${p.lev}× > ${POLICY.maxLeverage}× max`);
  if (p.sl == null) b.push('Policy: stop-loss required');
  if (p.tp == null) b.push('Policy: take-profit required');
  if (!(p.ref > 0)) b.push('missing ref price (needed for the 1% drift check)');
  if (!(p.exp > 1e9)) b.push('missing expiry');
  else if (nowS > p.exp) b.push('expired');
  return b;
}

// ---------------------------------------------------------------- live context per platform (public reads)
async function arcusFillsSince(net, addr, ai, fromMs) {
  const r = await net.arcusGet('/v1/fills', { address: addr, accountIndex: ai, from: fromMs, limit: 1000 });
  return (r.fills || []).map((f) => ({ time: Number(f.createdAt), closedPnl: f.closedPnl, fee: f.fee, m: f.marketDisplayName, px: f.price, sz: f.size, side: f.side }));
}
async function hlFillsSince(net, user, fromMs, dexes) {
  const rows = await net.hlInfo({ type: 'userFillsByTime', user, startTime: fromMs });
  const pre = dexes.map((d) => d + ':');
  return (rows || []).filter((f) => pre.some((x) => String(f.coin).startsWith(x)))
    .map((f) => ({ time: Number(f.time), closedPnl: f.closedPnl, fee: f.fee, m: f.coin, px: f.px, sz: f.sz, side: f.side === 'B' ? 'BUY' : 'SELL', dir: f.dir }));
}

async function qfexTrades(net, cfg, fromMs) {
  const rows = []; const q = cfg.qfex;
  for (let off = 0; off <= 20000; off += 1000) {
    const r = await net.qfex.get('/user/trade', { start_time: new Date(fromMs).toISOString(), limit: 1000, offset: off }, { accountId: q.accountId });
    const d = (r && r.data) || []; rows.push(...d); if (d.length < 1000) break;
  }
  return Q.tradeRows(rows).filter((t) => t.time >= fromMs);
}
async function qfexState(cfg, net, { sinceMs } = {}) {
  const q = cfg.qfex;
  const lst = await net.qfex.get('/user/subaccounts/balance', null, { accountId: q.accountId });
  const accts = (lst && lst.accounts) || [];
  const a = (q.accountId ? accts.find((x) => x.account_id === q.accountId) : accts.find((x) => x.is_master)) || (accts.length === 1 ? accts[0] : null);
  const pb = await net.qfex.get('/user/positions', null, { accountId: q.accountId });
  const bal = (pb && pb.balance) || {};
  const equity = a && a.equity != null ? Number(a.equity) : Number(bal.deposit || 0) + Number(bal.realised_pnl || 0) + Number(bal.unrealised_pnl || 0) + Number(bal.net_funding || 0);
  const free = a && a.available_balance != null ? Number(a.available_balance) : Number(bal.available_balance || 0);
  const positions = ((pb && pb.positions) || []).filter((p) => Number(p.position) !== 0).map((p) => ({ market: p.symbol, side: Number(p.position) > 0 ? 'long' : 'short',
    size: Math.abs(Number(p.position)), entry: Number(p.average_price), mark: null, upnl: Number(p.unrealised_pnl || 0), leverage: Number(p.leverage), raw: p }));
  const ws = await net.qfex.wsRead();
  const orders = [...Q.orderRows(ws.orders), ...Q.stopRows(ws.stops)];
  const weekFrom = weekStartUtc(net.now());
  const week = await qfexTrades(net, cfg, weekFrom);
  const fills = sinceMs != null ? (sinceMs >= weekFrom ? week.filter((t) => t.time >= sinceMs) : await qfexTrades(net, cfg, sinceMs)) : undefined;
  return { pf: 'qfex', equity, free, positions, orders, stopsKnown: ws.stops.length > 0 || !positions.length, stopsSubscribed: ws.stopsSubscribed,
    weeklyLoss: realizedLoss(week, weekFrom), fills };
}

export async function accountState(pf, cfg, net, { sinceMs } = {}) {
  if (pf === 'qfex') return qfexState(cfg, net, { sinceMs });
  if (pf === 'arcus') {
    const addr = cfg.arcus ? cfg.arcus.address : cfg.arcusAddress, ai = cfg.arcus ? cfg.arcus.accountIndex : cfg.arcusIndex;
    const acct = await net.arcusGet('/v1/account', { address: addr, accountIndex: ai });
    let pos = (await net.arcusGet('/v1/positions', { address: addr, accountIndex: ai })).positions || [];
    pos = (Array.isArray(pos) ? pos : Object.values(pos)).filter((p) => Number(p.size) !== 0);
    const oo = (await net.arcusGet('/v1/openOrders', { address: addr, accountIndex: ai })).orders || [];
    const week = await arcusFillsSince(net, addr, ai, weekStartUtc(net.now()));
    const fills = sinceMs != null ? await arcusFillsSince(net, addr, ai, sinceMs) : undefined;
    return {
      pf, equity: Number(acct.equity), free: Number(acct.freeCollateral),
      positions: pos.map((p) => ({ market: p.marketDisplayName, side: A.isLongSide(p.side) ? 'long' : 'short', size: Number(p.size),
        entry: Number(p.averageEntryPrice), mark: p.markPrice != null ? Number(p.markPrice) : null, upnl: Number(p.unrealizedPnl), raw: p })),
      orders: oo.map((o) => ({ id: String(o.orderId), market: o.marketDisplayName, side: o.side, kind: o.tpslType === 'STOP_LOSS' ? 'SL' : o.tpslType === 'TAKE_PROFIT' ? 'TP' : 'LIMIT',
        px: o.price != null ? Number(o.price) : null, trig: o.triggerPrice != null ? Number(o.triggerPrice) : null, size: Number(o.remainingSize ?? o.originalSize ?? 0), raw: o })),
      weeklyLoss: realizedLoss(week, weekStartUtc(net.now()), Infinity, { feeIncluded: true }), fills,
    };
  }
  const user = cfg.hl ? cfg.hl.address : cfg.hlAddress;
  let equity = 0, free = 0; const positions = [], orders = [];
  for (const dex of cfg.dexes) {
    const st = await net.hlInfo({ type: 'clearinghouseState', user, dex });
    equity += Number((st.marginSummary || {}).accountValue || 0); free += Number(st.withdrawable || 0);
    for (const ap of st.assetPositions || []) {
      const p = ap.position || {}; const szi = Number(p.szi || 0); if (!szi) continue;
      positions.push({ market: p.coin, side: szi > 0 ? 'long' : 'short', size: Math.abs(szi), entry: Number(p.entryPx),
        mark: p.positionValue ? Number(p.positionValue) / Math.abs(szi) : null, upnl: Number(p.unrealizedPnl), raw: p });
    }
    for (const o of (await net.hlInfo({ type: 'frontendOpenOrders', user, dex })) || []) {
      const ot = String(o.orderType || '');
      orders.push({ id: String(o.oid), market: o.coin, side: o.side === 'B' ? 'BUY' : 'SELL', kind: o.isTrigger ? (/stop/i.test(ot) ? 'SL' : /take/i.test(ot) ? 'TP' : 'TRIGGER') : 'LIMIT',
        px: Number(o.limitPx), trig: o.isTrigger ? Number(o.triggerPx) : null, size: Number(o.sz), reduceOnly: !!o.reduceOnly, raw: o });
    }
  }
  const week = await hlFillsSince(net, user, weekStartUtc(net.now()), cfg.dexes);
  const fills = sinceMs != null ? await hlFillsSince(net, user, sinceMs, cfg.dexes) : undefined;
  return { pf, equity, free, positions, orders, weeklyLoss: realizedLoss(week, weekStartUtc(net.now())), fills };
}

async function qfexRef(net, sym) {
  const r = await net.qfex.publicGet('/refdata', { ticker: sym });
  const row = ((r && r.data) || []).find((x) => String(x.symbol).toUpperCase() === sym);
  if (!row) throw new Error('Unknown QFEX market: ' + sym);
  return row;
}
async function qfexMarketCtx(p, cfg, net) {
  const sym = Q.normSymbol(p.m), ref = await qfexRef(net, sym), isLong = p.sd === 'long';
  const quote = await net.qfex.quote(sym);
  let live = null; try { live = ((await net.qfex.get('/user/fees', null, { accountId: cfg.qfex.accountId })).fees || {})[sym] || null; } catch { /* schedule fallback */ }
  const fr = Q.rates(Q.categoryOf(sym, ref), live, { slippage: cfg.qfex.slippage });
  const r = p.px > 0 && p.sl != null && p.tp != null ? Q.roundProposal({ isLong, px: p.px, sl: p.sl, tp: p.tp, qty: p.sz }, ref) : { px: p.px, sl: p.sl, tp: p.tp, qty: Q.snap(p.sz || 0, ref.lot_size, 'floor') };
  const maxLev = Number(ref.default_max_leverage) || 1;
  return { market: sym, ref, quote, mark: quote.mark, bid: quote.bid, ask: quote.ask, maxLev, mmf: 1 / (2 * maxLev), maker: fr.maker, taker: fr.taker, stopRate: fr.stopRate,
    stopTaker: fr.stopTaker, slippage: fr.slippage, feeSrc: fr.source, category: fr.category, size: r.qty, px: r.px, sl: r.sl, tp: r.tp,
    minSize: Number(ref.min_quantity || 0), maxSize: Number(ref.max_quantity || Infinity), band: [Number(ref.min_price), Number(ref.max_price)],
    status: String(ref.status || '').toUpperCase() === 'ACTIVE' ? 'ONLINE' : String(ref.status || 'UNKNOWN').toUpperCase(), orderTypes: ref.order_types || [] };
}

async function marketCtx(pf, p, cfg, net, st) {
  if (pf === 'qfex') return qfexMarketCtx(p, cfg, net);
  if (pf === 'arcus') {
    const ms = (await net.arcusGet('/v1/markets')).markets || [];
    const name = String(p.m).toUpperCase();
    const m = ms.find((x) => x.marketDisplayName.toUpperCase() === name || x.marketDisplayName.toUpperCase() === name + '-USD');
    if (!m) throw new Error('Unknown Arcus market: ' + p.m);
    let stats = null; try { stats = await net.arcusGet('/v1/account/stats', { address: cfg.arcus.address, include: 'feeTier' }); } catch { /* */ }
    const fr = F.arcusRates(m, stats, null);
    return { m, market: m.marketDisplayName, mark: Number(m.markPrice), maxLev: A.maxLeverage(m), mmf: Number(m.maintenanceMarginFraction), maker: fr.maker, taker: fr.taker,
      feeSrc: fr.source, size: Number(A.qtyFloor(m, p.sz)), sizeStr: A.qtyFloor(m, p.sz), minSize: Number(m.minOrderSize || 0), minNotional: Number(m.minOrderNotional || 0),
      status: m.status };
  }
  const dex = H.dexOf(p.m);
  const [meta, ctxs] = await net.hlInfo({ type: 'metaAndAssetCtxs', dex });
  const perpDexs = await net.hlInfo({ type: 'perpDexs' });
  const idx = meta.universe.findIndex((u) => u.name === p.m);
  if (idx < 0) throw new Error('Unknown HL market: ' + p.m);
  const u = meta.universe[idx], c = ctxs[idx];
  const fr = { ...F.FALLBACK.hl_io, source: 'default (HIP-3)' };
  return { mk: { coin: p.m, dex, asset: H.assetId(p.m, meta.universe, perpDexs), szDecimals: u.szDecimals, maxLeverage: u.maxLeverage, isDelisted: !!u.isDelisted },
    market: p.m, mark: Number(c.markPx), maxLev: u.maxLeverage, mmf: 1 / (2 * u.maxLeverage), maker: fr.maker, taker: fr.taker, feeSrc: fr.source,
    size: Number(H.roundSz(p.sz, u.szDecimals)), status: u.isDelisted ? 'DELISTED' : 'ONLINE' };
}

// Full hard-policy evaluation. Returns { ok, reasons[], risk, ctx }. Every computeRisk warning is a hard block here
// (there is no human to acknowledge it).
export async function evaluate(q, cfg, net, stCache = {}) {
  const nowS = net.now() / 1000;
  const p = normalizeProposal(q);
  const reasons = basicChecks(p, cfg, nowS);
  if (reasons.length) return { ok: false, p, reasons };
  const st = stCache[p.pf] || (stCache[p.pf] = await accountState(p.pf, cfg, net));
  const c = await marketCtx(p.pf, p, cfg, net, st);
  const isLong = p.sd === 'long';
  if (p.pf === 'qfex') { p.px = c.px; p.sl = c.sl; p.tp = c.tp; } // tick-rounded in the safe direction; risk is computed on these
  // QFEX stops fire as MARKET orders on the mark: the exit leg is charged a taker fee (floored per category) + slippage.
  const exitRate = p.pf === 'qfex' ? c.stopRate : c.taker;
  const r = computeRisk({ isLong, size: c.size, leverage: p.lev, mark: c.mark, type: 'limit', limitPx: p.px, feeRate: exitRate,
    entryFeeRate: Math.max(0, c.maker ?? 0), mmf: c.mmf, maxLev: c.maxLev, sl: p.sl, tp: p.tp, ref: p.ref, expiry: p.exp, now: nowS,
    freeCollateral: st.free, maxLoss: Infinity, maxMove: MAX_DRIFT });
  reasons.push(...r.blocks, ...r.warns);
  const pol = { ...POLICY, capital: { ...POLICY.capital, [POL_PF[p.pf]]: st.equity } };
  const cp = checkPolicy({ ...p, pf: POL_PF[p.pf] }, r, { policy: pol, weeklyLossUsed: st.weeklyLoss, freeCollateral: st.free });
  reasons.push(...cp.blocks);
  if (!(st.equity > 0)) reasons.push('no equity on this platform');
  if (r.moved != null && r.moved > MAX_DRIFT && !reasons.some((x) => /moved/.test(x))) reasons.push(`Price moved ${(r.moved * 100).toFixed(2)}% since the proposal`);
  if (!(c.mark > 0)) reasons.push('no live mark price');
  else if (isLong ? p.px >= c.mark : p.px <= c.mark) reasons.push('Maker policy: the limit price would cross the book (post-only would be rejected)');
  if (p.pf === 'qfex') {
    if (isLong ? c.ask != null && p.px >= c.ask : c.bid != null && p.px <= c.bid) reasons.push('Maker policy: the limit price would cross the best ' + (isLong ? 'ask' : 'bid') + ' (ALO would be rejected)');
    if (!c.orderTypes.includes('ALO')) reasons.push('QFEX market does not accept ALO (post-only) orders');
    if (!cfg.qfex.categories.includes(c.category)) reasons.push(`QFEX category ${c.category} not allowed (QFEX_CATEGORIES=${cfg.qfex.categories.join(',')})`);
    if (c.band[0] > 0 && (p.px < c.band[0] || p.px > c.band[1])) reasons.push(`limit price outside the QFEX price band ${c.band[0]}–${c.band[1]}`);
    if (c.size > c.maxSize) reasons.push(`size > maximum (${c.maxSize})`);
    if (st.positions.length && st.stopsKnown === false) reasons.push('QFEX stop orders could not be read: refusing to add exposure until the existing positions\' stops are confirmed');
  }
  if (c.status && c.status !== 'ONLINE') reasons.push('market ' + c.status);
  if (c.minSize && c.size < c.minSize) reasons.push(`size < minimum (${c.minSize})`);
  if (c.minNotional && r.notional < c.minNotional) reasons.push(`notional < minimum ($${c.minNotional})`);
  const sameMarket = (x) => String(x.market).toUpperCase() === String(c.market).toUpperCase();
  const entries = st.orders.filter((o) => o.kind === 'LIMIT' && !o.reduceOnly && !(o.raw && o.raw.reduceOnly));
  const busy = new Set([...st.positions.map((x) => x.market), ...entries.map((o) => o.market)]);
  if (busy.size >= cfg.maxPositions && !busy.has(c.market)) reasons.push(`max ${cfg.maxPositions} concurrent positions/entries on ${p.pf} reached`);
  if (st.positions.some(sameMarket) || entries.some(sameMarket)) reasons.push('a position or resting entry already exists on ' + c.market);
  return { ok: reasons.length === 0, p, reasons: [...new Set(reasons)], risk: { slLoss: r.slLoss, tpGain: r.tpGain, notional: r.notional, margin: r.margin,
    maxLoss: cp.maxLoss, weeklyLossUsed: st.weeklyLoss, equity: st.equity, free: st.free, mark: c.mark, drift: r.moved,
    fees: { maker: c.maker, taker: c.taker, ...(p.pf === 'qfex' ? { stopRate: c.stopRate, slippage: c.slippage, category: c.category, preferred: Q.PREFERRED_CATEGORIES.includes(c.category) } : {}), src: c.feeSrc } }, ctx: c };
}

// ---------------------------------------------------------------- request builders (signed, not sent)
async function arcusCtx(cfg, net) {
  const off = await net.arcusClockOffsetMs().catch(() => 0);
  return A.makeCtx({ priv: cfg.arcus.priv, address: cfg.arcus.address, accountIndex: cfg.arcus.accountIndex,
    nowNs: () => BigInt(Math.round(net.now() + off)) * 1000000n + BigInt(Math.floor(Math.random() * 1000)) });
}
let hlNonce = 0;
const nextNonce = (net) => { hlNonce = Math.max(hlNonce + 1, net.now()); return hlNonce; };
export async function buildOpen(ev, cfg, net) {
  const { p, ctx: c } = ev;
  if (p.pf === 'qfex') {
    const entry = Q.buildEntry({ symbol: c.market, isLong: p.sd === 'long', qty: c.size, px: p.px, sl: p.sl, tp: p.tp, clientOrderId: Q.clientOrderId(p.id) });
    if (entry.params.order_type !== 'ALO' || !(entry.params.stop_loss > 0) || !(entry.params.take_profit > 0)) throw new Error('internal: QFEX entry is not ALO with SL+TP');
    return [{ label: 'set leverage 1x (POST /user/leverage)', kind: 'rest', d: Q.leverageRequest(c.market, 1) },
      { label: 'cancel-on-disconnect off (resting entry + stops survive)', kind: 'ws', d: Q.cancelOnDisconnectOff() },
      { label: 'entry ALO GTC + stop_loss + take_profit', kind: 'ws', d: entry }];
  }
  if (p.pf === 'arcus') {
    const ctx = await arcusCtx(cfg, net);
    return [{ label: 'setLeverage 1x isolated', d: A.setLeverage(ctx, c.m, 1, true) },
      { label: 'entry ALO + TP/SL', d: (() => { const d = A.entryTpsl(ctx, c.m, p.sd === 'long' ? 'BUY' : 'SELL', c.sizeStr, { type: 'limit', limitPrice: p.px, takeProfit: p.tp, stopLoss: p.sl, postOnly: true });
        const b = JSON.parse(d.body); if (!b.orders || b.orders[0].timeInForce !== 'ALO' || b.orders.length !== 3) throw new Error('internal: Arcus entry is not ALO with SL+TP'); return d; })() }];
  }
  const [lev, order] = H.buildOpen({ asset: c.mk.asset, szDecimals: c.mk.szDecimals, isBuy: p.sd === 'long', sz: p.sz, leverage: 1, isCross: false,
    type: 'limit', limitPx: p.px, markPx: c.mark, tp: p.tp, sl: p.sl, postOnly: true });
  if (order.orders[0].t.limit.tif !== 'Alo') throw new Error('internal: entry is not Alo');
  const sign = (a) => H.exchangeRequest(cfg.hl.priv, a, nextNonce(net), { isMainnet: !cfg.testnet });
  return [{ label: 'updateLeverage 1x isolated', d: sign(lev) }, { label: 'entry Alo + TP/SL (normalTpsl)', d: sign(order) }];
}

// ---------------------------------------------------------------- send + result parsing
export function arcusError(r) {
  if (!r.ok) return `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;
  if (r.body && !Array.isArray(r.body.responses) && ['ERROR', 'REJECTED'].includes(r.body.status)) return r.body.rejectionReason || r.body.error || r.body.status;
  const errs = (r.body?.responses || []).filter((x) => x && (x.status === 'ERROR' || x.status === 'REJECTED')).map((x) => x.error || x.rejectionReason || x.status);
  return errs.length ? errs.join(' | ') : null;
}
export function hlError(r) {
  if (!r.ok) return `HTTP ${r.status}`;
  const body = r.body;
  if (!body || body.status !== 'ok') return typeof body?.response === 'string' ? body.response : 'response not ok';
  const errs = (body.response?.data?.statuses || []).filter((x) => x && x.error).map((x) => x.error);
  return errs.length ? errs.join(' | ') : null;
}
export const summarize = (reqs) => reqs.map((r) => {
  if (r.kind === 'ws') return { label: r.label, ws: r.d.type, body: r.d };
  if (r.kind === 'rest') return { label: r.label, method: r.d.method, path: r.d.path, body: r.d.body ? JSON.parse(r.d.body) : null };
  const b = r.d.body ? JSON.parse(r.d.body.replace(/:(\d{16,})([,}])/g, ':"$1"$2')) : null;
  if (b && b.signature) b.signature = '<sig>';
  if (b && Array.isArray(b.orders)) b.orders = b.orders.map((o) => ({ ...o, signature: o.signature ? '<sig>' : undefined }));
  return { label: r.label, path: r.d.path, body: b };
});
export async function send(pf, reqs, net) {
  if (pf === 'qfex') return net.qfex.send(reqs);
  const out = [];
  for (const r of reqs) {
    const res = pf === 'arcus' ? await net.sendArcus(r.d) : await net.sendHl(r.d);
    const err = pf === 'arcus' ? arcusError(res) : hlError(res);
    out.push({ label: r.label, status: res.status, ok: !err, error: err, body: res.body });
    if (err) break; // never place the order if the leverage step failed
  }
  return out;
}

// Kill switch: STOP file present, or AUTOTRADER_ENABLED != 1 -> nothing is sent.
export function killReason(cfg, stopExists) {
  if (stopExists) return 'STOP file present';
  if (!cfg.enabled) return 'AUTOTRADER_ENABLED is not 1';
  return null;
}

// ---------------------------------------------------------------- reduce-only commands
export async function buildCancel(pf, market, orderId, cfg, net) {
  if (pf === 'qfex') market = Q.normSymbol(market);
  const st = await accountState(pf, cfg, net);
  const o = st.orders.find((x) => x.id === String(orderId) && String(x.market).toUpperCase() === String(market).toUpperCase());
  if (!o) throw new Error(`order ${orderId} not found on ${market}`);
  const pos = st.positions.find((x) => String(x.market).toUpperCase() === String(market).toUpperCase());
  if (pos && o.kind === 'SL' && st.orders.filter((x) => x.kind === 'SL' && x.market === o.market).length <= 1)
    throw new Error('Policy: refusing to cancel the only stop-loss of an open position (close the position instead)');
  if (pf === 'qfex') {
    if (o.stop || o.kind !== 'LIMIT') throw new Error('Policy: QFEX stop orders (SL/TP) are never cancelled by the bot; close the position instead');
    return [{ label: 'cancel ' + o.id, kind: 'ws', d: Q.buildCancel(o.market, o.id) }];
  }
  if (pf === 'arcus') {
    const ms = (await net.arcusGet('/v1/markets')).markets; const m = ms.find((x) => x.marketDisplayName === o.market);
    return [{ label: 'cancel ' + o.id, d: A.cancelOrder(await arcusCtx(cfg, net), m, o.id) }];
  }
  const c = await marketCtx('entropy', { m: o.market, sz: 0 }, cfg, net);
  return [{ label: 'cancel ' + o.id, d: H.exchangeRequest(cfg.hl.priv, H.buildCancel(c.mk.asset, o.id), nextNonce(net), { isMainnet: !cfg.testnet }) }];
}
export async function buildClose(pf, market, cfg, net) {
  if (pf === 'qfex') market = Q.normSymbol(market);
  const st = await accountState(pf, cfg, net);
  const pos = st.positions.find((x) => String(x.market).toUpperCase() === String(market).toUpperCase());
  if (!pos) throw new Error('no open position on ' + market);
  if (pf === 'qfex') {
    const d = Q.buildClosePosition(pos.market, Q.clientOrderId('close'));
    if (d.type !== 'close_position') throw new Error('internal: close is not close_position');
    return [{ label: 'close_position (engine LIMIT IOC, opposite side, sized to the position)', kind: 'ws', d }];
  }
  if (pf === 'arcus') {
    const ms = (await net.arcusGet('/v1/markets')).markets; const m = ms.find((x) => x.marketDisplayName === pos.market);
    const d = A.closePosition(await arcusCtx(cfg, net), m, pos.raw, { slippage: 0.02 });
    if (!/"reduceOnly":\s*true/.test(d.body)) throw new Error('internal: close is not reduce-only');
    return [{ label: 'close (reduce-only IOC)', d }];
  }
  const c = await marketCtx('entropy', { m: pos.market, sz: 0 }, cfg, net);
  const a = H.buildClose({ asset: c.mk.asset, szDecimals: c.mk.szDecimals, szi: pos.side === 'long' ? pos.size : -pos.size, markPx: c.mark });
  if (!a.orders.every((o) => o.r === true)) throw new Error('internal: close is not reduce-only');
  return [{ label: 'close (reduce-only IOC)', d: H.exchangeRequest(cfg.hl.priv, a, nextNonce(net), { isMainnet: !cfg.testnet }) }];
}
