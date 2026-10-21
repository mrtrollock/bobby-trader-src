// QFEX adapter (https://docs.qfex.com): HMAC-SHA256 auth, WebSocket order entry (trade.qfex.com), REST reads (api.qfex.com),
// public market data over the MDS WebSocket (mds.qfex.com). UAT/testnet = the same hosts on qfex.io.
//
// Trade-only by construction:
//  * every REST request goes through assertQfexRest(): only a short allowlist of GET reads plus POST /user/leverage;
//    the funding service (banker.qfex.*), /withdraw, /address, /user/transfer, builder/web3 and API-key endpoints are refused;
//  * every WebSocket message goes through assertQfexMessage(): add_order must be a post-only ALO GTC entry with BOTH
//    stop_loss and take_profit; stop orders can never be cancelled/modified; no TWAP, no cancel_all, no modify;
//  * no builder code and no wallet-signed (SIWE / builder) key flow exists in this code.
// The browser app only imports the pure helpers (fees, categories, policy, builders); the network part is Node-only and
// loads `ws` lazily, so the secret key never has to enter the browser.
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import * as D from './dec.js';

export const MAINNET = { rest: 'https://api.qfex.com', trade: 'wss://trade.qfex.com', mds: 'wss://mds.qfex.com', network: 'mainnet' };
export const UAT = { rest: 'https://api.qfex.io', trade: 'wss://trade.qfex.io', mds: 'wss://mds.qfex.io', network: 'uat' };
export const bases = (testnet) => (testnet ? UAT : MAINNET);

// ---------------------------------------------------------------- fees (docs.qfex.com/qfex/fees, entry tier "Tier 5", < $2m 30-day volume)
export const FEE_SCHEDULE = {
  INDEX: { maker: 0.0002, taker: 0.0005 },
  COMMODITY: { maker: 0.0002, taker: 0.0005 },
  EQUITY: { maker: 0.0005, taker: 0.001 },
};
// What a triggered stop is assumed to cost on top of the price move: stops convert to MARKET orders on the mark price,
// so a TAKER fee (never below these floors) plus slippage.
export const STOP_TAKER_FLOOR = { INDEX: 0.0005, COMMODITY: 0.0005, EQUITY: 0.001 };
export const STOP_SLIPPAGE = { INDEX: 0.0005, COMMODITY: 0.0005, EQUITY: 0.001 };
export const ALLOWED_CATEGORIES = ['INDEX', 'COMMODITY', 'EQUITY']; // FX: no published fee row -> refused
// Cheaper categories are preferred (fees are half of single stocks); used to rank / warn, not to block.
export const PREFERRED_CATEGORIES = ['INDEX', 'COMMODITY'];
// Browser fallback when refdata cannot be read (QFEX REST has no CORS): known index/commodity symbols, everything else
// is treated as EQUITY (the most expensive category, i.e. conservative).
export const KNOWN_CATEGORY = {
  'US100-USD': 'INDEX', 'US500-USD': 'INDEX', 'KOSPI-USD': 'INDEX', 'NIKKEI-USD': 'INDEX', 'HSI-USD': 'INDEX', 'TAIEX-USD': 'INDEX',
  'ASHR-USD': 'INDEX', 'XLF-USD': 'INDEX', 'XLE-USD': 'INDEX', 'DRAM-USD': 'INDEX', 'IGV-USD': 'INDEX', 'SOXL-USD': 'INDEX',
  'CL-USD': 'COMMODITY', 'NATGAS-USD': 'COMMODITY', 'GOLD-USD': 'COMMODITY', 'SILVER-USD': 'COMMODITY', 'URANIUM-USD': 'COMMODITY', 'COPPER-USD': 'COMMODITY',
};
export const normSymbol = (m) => { const s = String(m || '').trim().toUpperCase().replace(/^QFEX:/, ''); return s.includes('-') ? s : s + '-USD'; };
export const categoryOf = (sym, ref) => String((ref && ref.product_category) || KNOWN_CATEGORY[normSymbol(sym)] || 'EQUITY').toUpperCase();

const num = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
// liveRow: GET /user/fees -> fees[symbol] = { maker_fee, taker_fee } (fractions; anything above 0.5 % is treated as bogus)
export function rates(category, liveRow, { slippage } = {}) {
  const cat = FEE_SCHEDULE[category] ? category : 'EQUITY';
  let maker = num(liveRow && liveRow.maker_fee), taker = num(liveRow && liveRow.taker_fee), source = 'GET /user/fees';
  if (maker == null || taker == null || taker < 0 || taker > 0.005 || maker > 0.005) { ({ maker, taker } = FEE_SCHEDULE[cat]); source = 'schedule (Tier 5)'; }
  const slip = slippage != null && Number.isFinite(Number(slippage)) ? Number(slippage) : STOP_SLIPPAGE[cat];
  const stopTaker = Math.max(taker, STOP_TAKER_FLOOR[cat]);
  return { maker: Math.max(0, maker), taker, stopTaker, slippage: slip, stopRate: stopTaker + slip, source, category: cat };
}

// ---------------------------------------------------------------- HMAC auth (signature = hex(HMAC-SHA256(secret, `${nonce}:${unix_ts}`)))
const te = new TextEncoder();
export function signature(secret, nonce, unixTs) {
  return bytesToHex(hmac(sha256, te.encode(String(secret)), te.encode(`${nonce}:${unixTs}`)));
}
export const newNonce = () => bytesToHex(randomBytes(16));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s) => UUID.test(String(s || ''));
export function checkCreds(c) {
  if (!c || !c.pub || !c.secret) throw new Error('QFEX: QFEX_API_PUBLIC_KEY and QFEX_API_SECRET_KEY are both required');
  if (/\s/.test(c.pub) || /\s/.test(c.secret) || c.secret.length < 16) throw new Error('QFEX: malformed API key (check for spaces / truncation)');
  if (c.pub === c.secret) throw new Error('QFEX: public and secret key are identical');
  if (c.accountId && !isUuid(c.accountId)) throw new Error('QFEX_ACCOUNT_ID must be the account UUID');
  return c;
}
export function authHeaders(c, { nonce = newNonce(), unixTs = Math.floor(Date.now() / 1000), accountId = c.accountId } = {}) {
  const h = { 'x-qfex-public-key': c.pub, 'x-qfex-hmac-signature': signature(c.secret, nonce, unixTs), 'x-qfex-nonce': nonce, 'x-qfex-timestamp': String(unixTs) };
  if (accountId) h['x-qfex-requested-account-id'] = accountId;
  return h;
}
export function authMessage(c, { nonce = newNonce(), unixTs = Math.floor(Date.now() / 1000) } = {}) {
  const params = { hmac: { public_key: c.pub, nonce, unix_ts: unixTs, signature: signature(c.secret, nonce, unixTs) } };
  if (c.accountId) params.account_id = c.accountId; // never a builder_code
  return { type: 'auth', params };
}

// ---------------------------------------------------------------- trade-only guards
// /user/subaccounts/balance is only called as a scope probe: a single-account key gets 403 there (verified on mainnet).
const REST_GET = [/^\/user\/positions$/, /^\/user\/trade$/, /^\/user\/subaccounts\/balance$/, /^\/user\/account-equity$/, /^\/user\/fees$/, /^\/refdata$/,
  /^\/md\/contracts$/, /^\/md\/orderbook\/[A-Z0-9-]+$/];
const REST_POST = [/^\/user\/leverage$/];
export function assertQfexRest(base, method, path) {
  const host = (() => { try { return new URL(base).host; } catch { return ''; } })();
  if (!/^api\.qfex\.(com|io)$/.test(host)) throw new Error('QFEX request forbidden: host ' + (host || base) + ' (only api.qfex.com / api.qfex.io; never the funding service)');
  const p = String(path).split('?')[0];
  const ok = (String(method).toUpperCase() === 'GET' ? REST_GET : String(method).toUpperCase() === 'POST' ? REST_POST : []).some((re) => re.test(p));
  if (!ok) throw new Error(`QFEX request forbidden by policy: ${method} ${p}`);
}
const WS_TYPES = new Set(['auth', 'subscribe', 'unsubscribe', 'add_order', 'cancel_order', 'close_position', 'cancel_on_disconnect',
  'get_user_orders', 'get_user_trades', 'get_user_leverage']);
export function assertQfexMessage(m) {
  if (!m || !WS_TYPES.has(m.type)) throw new Error('QFEX message forbidden by policy: ' + (m && m.type));
  const p = m.params || {};
  if (m.type === 'auth' && (p.builder_code || p.jwt)) throw new Error('QFEX: builder codes and JWT/wallet sessions are not used');
  if (m.type === 'add_order') {
    if (p.order_type !== 'ALO' || p.order_time_in_force !== 'GTC') throw new Error('QFEX policy: entries must be post-only (ALO, GTC)');
    if (!(Number(p.stop_loss) > 0) || !(Number(p.take_profit) > 0)) throw new Error('QFEX policy: stop_loss and take_profit are mandatory on every entry');
    if (p.reduce_only) throw new Error('QFEX policy: entries are never reduce-only');
  }
  if (m.type === 'cancel_order' && p.cancel_order_id_type !== 'order_id') throw new Error('QFEX policy: cancel by exchange order_id only');
  if (m.type === 'cancel_on_disconnect' && p.cancel_on_disconnect !== false) throw new Error('QFEX policy: cancel-on-disconnect stays off (resting entries and stops must survive the bot)');
  if (m.type === 'subscribe' || m.type === 'unsubscribe') {
    for (const ch of p.channels || []) if (!['order_responses', 'stop_orders', 'fills', 'positions', 'balances'].includes(ch)) throw new Error('QFEX: unknown channel ' + ch);
  }
}

// ---------------------------------------------------------------- order construction
const dp = (step) => { const s = D.normalize(String(step)); return s.includes('.') ? s.split('.')[1].length : 0; };
export function snap(x, step, mode) { return Number(D.snap(String(x), D.normalize(String(step)), mode)); }
// Round prices to the tick in the SAFE direction: the entry more passive, the SL closer to the entry (less loss), the TP closer.
export function roundProposal({ isLong, px, sl, tp, qty }, ref) {
  const tick = ref.tick_size, lot = ref.lot_size;
  return {
    px: snap(px, tick, isLong ? 'floor' : 'ceil'),
    sl: snap(sl, tick, isLong ? 'ceil' : 'floor'),
    tp: snap(tp, tick, isLong ? 'floor' : 'ceil'),
    qty: snap(qty, lot, 'floor'),
    tickDp: dp(tick), lotDp: dp(lot),
  };
}
let cidSeq = 0;
export const clientOrderId = (id) => `bobby-${String(id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)}-${Date.now().toString(36)}${(cidSeq++).toString(36)}`;
export function buildEntry({ symbol, isLong, qty, px, sl, tp, clientOrderId: cid }) {
  if (!(px > 0) || !(qty > 0)) throw new Error('QFEX entry: price and quantity required');
  if (!(sl > 0) || !(tp > 0)) throw new Error('QFEX entry: stop-loss and take-profit required');
  if (isLong ? !(sl < px && tp > px) : !(sl > px && tp < px)) throw new Error('QFEX entry: SL/TP on the wrong side of the entry');
  const m = { type: 'add_order', params: { symbol: normSymbol(symbol), side: isLong ? 'BUY' : 'SELL', order_type: 'ALO', order_time_in_force: 'GTC',
    quantity: qty, price: px, take_profit: tp, stop_loss: sl, client_order_id: cid } };
  assertQfexMessage(m); return m;
}
export const buildCancel = (symbol, orderId) => { const m = { type: 'cancel_order', params: { symbol: normSymbol(symbol), order_id: String(orderId), cancel_order_id_type: 'order_id' } }; assertQfexMessage(m); return m; };
// The engine sizes a LIMIT IOC on the opposite side to the open position: it can only reduce (close in full).
export const buildClosePosition = (symbol, cid) => { const m = { type: 'close_position', params: { symbol: normSymbol(symbol), ...(cid ? { client_order_id: cid } : {}) } }; assertQfexMessage(m); return m; };
export const cancelOnDisconnectOff = () => ({ type: 'cancel_on_disconnect', params: { cancel_on_disconnect: false } });
export const leverageRequest = (symbol, leverage = 1) => {
  if (Number(leverage) !== 1) throw new Error('QFEX policy: leverage is always 1x');
  return { method: 'POST', path: '/user/leverage', body: JSON.stringify({ symbol: normSymbol(symbol), leverage: 1 }) };
};

// ---------------------------------------------------------------- response parsing
// Messages may arrive bare ({order_response: {...}}) or in an envelope ({type, channel, contents}).
export function classify(msg) {
  if (!msg || typeof msg !== 'object') return { kind: 'other', msg };
  if (msg.err) return { kind: 'err', err: msg.err };
  if (msg.error_code) return { kind: 'err', err: msg };
  // shapes confirmed on mainnet (2026-10-21): {"authenticated":true}, {"subscribed":"<channel>"},
  // {"all_orders_response":{"orders":[],"twaps":[]}}, {"balance_response":{id, user_id, deposit, ..., available_balance, fees}},
  // {"user_leverage_response":[{id, symbol, initial_margin, maintenance_margin, leverage:"10"}]}
  if (msg.authenticated !== undefined) return { kind: 'auth', ok: msg.authenticated === true };
  if (msg.balance_response) return { kind: 'balance', balance: msg.balance_response };
  if (msg.user_leverage_response) return { kind: 'leverage', rows: [].concat(msg.user_leverage_response) };
  if (msg.type === 'authenticated') return { kind: 'auth', ok: true };
  if (msg.order_response) return { kind: 'order', order: msg.order_response };
  if (msg.all_orders_response) return { kind: 'orders', orders: msg.all_orders_response.orders || [] };
  if (msg.stop_order_response) return { kind: 'stop', stop: msg.stop_order_response };
  if (msg.subscribed) return { kind: 'subscribed', channel: msg.subscribed };
  if (msg.ack) return { kind: 'ack', ack: msg.ack };
  if (msg.user_trades_response) return { kind: 'trades', trades: msg.user_trades_response };
  if (msg.channel && /stop/.test(msg.channel) && Array.isArray(msg.contents)) return { kind: 'stops', stops: msg.contents };
  return { kind: 'other', msg };
}
export const OK_ENTRY = new Set(['ACK']);
export function entryError(order, want) {
  if (!order) return 'no order response (state unknown: check status before retrying)';
  if (!OK_ENTRY.has(order.status)) return 'order ' + order.status;
  if (want && (!(Number(order.stop_loss) > 0) || !(Number(order.take_profit) > 0))) return 'order ACKed but the exchange echoed no stop_loss/take_profit';
  return null;
}
export function stopRows(stops) {
  return (stops || []).map((s) => ({ id: String(s.stop_order_id), market: s.symbol, side: s.direction, kind: s.stop_order_type === 'STOP_LOSS' ? 'SL' : s.stop_order_type === 'TAKE_PROFIT' ? 'TP' : 'TRIGGER',
    px: null, trig: num(s.price), size: num(s.quantity), reduceOnly: true, stop: true, raw: s }));
}
export function orderRows(orders) {
  return (orders || []).filter((o) => !['CANCELLED', 'FILLED', 'EXPIRED', 'REJECTED'].includes(o.status)).map((o) => ({ id: String(o.order_id), market: o.symbol, side: o.side,
    kind: o.type === 'STOP_LOSS' ? 'SL' : o.type === 'TAKE_PROFIT' ? 'TP' : 'LIMIT', px: num(o.price), trig: null, size: num(o.quantity_remaining ?? o.quantity),
    sl: num(o.stop_loss) || null, tp: num(o.take_profit) || null, reduceOnly: false, raw: o }));
}
// GET /user/trade rows -> {time ms, closedPnl, fee}. realised_pnl_change is not documented as net of fees: the fee is
// subtracted as well, which can only overstate a loss (conservative, like Hyperliquid/TxFlow in risk.realizedLoss).
export function tradeRows(rows) {
  return (rows || []).map((t) => { const ts = Number(t.order_timestamp); return { time: ts > 1e12 ? ts : ts * 1000, closedPnl: Number(t.realised_pnl_change || 0), fee: Number(t.fee || 0),
    m: t.symbol, px: num(t.price), sz: num(t.quantity), side: t.side, type: t.order_type, liquidation: t.liquidation }; });
}

// ---------------------------------------------------------------- Node network layer (lazy; not used by the browser bundle)
async function wsCtor() {
  if (typeof globalThis.WebSocket === 'function' && typeof process === 'undefined') return globalThis.WebSocket;
  const name = 'ws'; const m = await import(name); return m.default || m.WebSocket;
}
async function rest(b, method, path, { params, body, creds, accountId } = {}) {
  assertQfexRest(b.rest, method, path);
  const q = params ? Object.entries(params).filter(([, v]) => v != null) : [];
  const url = b.rest + path + (q.length ? '?' + new URLSearchParams(q).toString() : '');
  const headers = { 'Content-Type': 'application/json', ...(creds ? authHeaders(creds, { accountId: accountId === undefined ? creds.accountId : accountId }) : {}) };
  const r = await fetch(url, { method, headers, body });
  const text = await r.text(); let j; try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text.slice(0, 300) }; }
  return { ok: r.ok, status: r.status, body: j };
}
const must = (r, what) => { if (!r.ok) throw new Error(`QFEX ${what}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`); return r.body; };

// One authenticated trade-WebSocket session. Every outgoing message is policy-checked.
export class Session {
  constructor(ws) { this.ws = ws; this.queue = []; this.waiters = []; ws.on ? ws.on('message', (d) => this._in(d)) : ws.addEventListener('message', (e) => this._in(e.data)); }
  _in(d) { let m; try { m = JSON.parse(String(d)); } catch { return; } const c = classify(m); this.queue.push(c);
    for (const w of [...this.waiters]) if (w.match(c)) { this.waiters.splice(this.waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve(c); } }
  send(m) { assertQfexMessage(m); this.ws.send(JSON.stringify(m)); }
  wait(match, ms = 10000, what = 'response') {
    const hit = this.queue.find(match); if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => { const w = { match, resolve }; this.waiters.push(w);
      w.timer = setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) { this.waiters.splice(i, 1); reject(new Error('QFEX: timeout waiting for ' + what)); } }, ms); });
  }
  collect(ms) { return new Promise((r) => setTimeout(() => r(this.queue.slice()), ms)); }
  close() { try { this.ws.close(); } catch { /* */ } }
}
export async function openSession(b, creds, { WS, timeoutMs = 10000 } = {}) {
  checkCreds(creds);
  const Ctor = WS || await wsCtor();
  const ws = new Ctor(b.trade + '?api_key=' + encodeURIComponent(creds.pub));
  await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('QFEX: WebSocket connect timeout')), timeoutMs);
    const ok = () => { clearTimeout(t); res(); }, ko = (e) => { clearTimeout(t); const m = (e && e.message) || '';
      rej(new Error(/\b40[13]\b/.test(m) ? 'QFEX: authentication failed (trade WebSocket refused the API key: ' + m + ')' : 'QFEX: WebSocket error ' + m)); };
    if (ws.once) { ws.once('open', ok); ws.once('error', ko); } else { ws.addEventListener('open', ok); ws.addEventListener('error', ko); } });
  const s = new Session(ws);
  s.send(authMessage(creds));
  const a = await s.wait((c) => c.kind === 'auth' || c.kind === 'err', timeoutMs, 'authentication').catch((e) => { s.close(); throw e; });
  if (a.kind === 'err' || !a.ok) { s.close(); throw new Error('QFEX: authentication failed (' + (a.err ? a.err.error_code + ' ' + (a.err.message || '') : 'not authenticated') + ')'); }
  return s;
}
// Public market data (no auth): mark price + best bid/ask for one symbol from the MDS WebSocket.
export async function mdsQuote(b, symbol, { WS, timeoutMs = 8000 } = {}) {
  const Ctor = WS || await wsCtor(); const sym = normSymbol(symbol);
  const ws = new Ctor(b.mds);
  return new Promise((resolve, reject) => {
    const out = { symbol: sym, mark: null, bid: null, ask: null };
    const done = (e) => { clearTimeout(t); try { ws.close(); } catch { /* */ } e ? reject(e) : resolve(out); };
    const t = setTimeout(() => (out.mark != null ? done() : done(new Error('QFEX: no mark price from MDS for ' + sym))), timeoutMs);
    const onMsg = (d) => { let m; try { m = JSON.parse(String(d && d.data !== undefined ? d.data : d)); } catch { return; }
      if (m.error_code) return done(new Error('QFEX MDS: ' + m.error_code + ' ' + (m.message || '')));
      if (m.symbol !== sym) return;
      if (m.type === 'mark_price') out.mark = num(m.price);
      if (m.type === 'bbo') { const best = (side) => { const r = (m[side] || []).find((x) => Number(x[1]) > 0); return r ? Number(r[0]) : null; }; out.bid = best('bid'); out.ask = best('ask'); out.bboSeen = true; }
      if (out.mark != null && out.bboSeen) done(); };
    const onOpen = () => ws.send(JSON.stringify({ type: 'subscribe', channels: ['mark_price', 'bbo'], symbols: [sym] }));
    if (ws.on) { ws.on('open', onOpen); ws.on('message', onMsg); ws.on('error', (e) => done(new Error('QFEX MDS: ' + e.message))); }
    else { ws.addEventListener('open', onOpen); ws.addEventListener('message', onMsg); ws.addEventListener('error', () => done(new Error('QFEX MDS: WebSocket error'))); }
  });
}

// Network object used by the autotrader (mockable): reads + the guarded send path.
export function makeNet(b, creds, { WS, stopsMs: defStopsMs = 1500 } = {}) {
  return {
    publicGet: async (path, params) => must(await rest(b, 'GET', path, { params }), 'GET ' + path),
    get: async (path, params, opts = {}) => must(await rest(b, 'GET', path, { params, creds, accountId: opts.accountId }), 'GET ' + path),
    getRaw: (path, params, opts = {}) => rest(b, 'GET', path, { params, creds, accountId: opts.accountId }),
    quote: (symbol) => mdsQuote(b, symbol, { WS }),
    // WS reads: open (non-stop) orders + stop orders (TP/SL) via a short-lived authenticated session.
    wsRead: async ({ stopsMs = defStopsMs } = {}) => {
      const s = await openSession(b, creds, { WS });
      try {
        s.send({ type: 'subscribe', params: { channels: ['stop_orders', 'balances'] } });
        s.send({ type: 'get_user_orders', params: { limit: 200, offset: 0 } });
        const o = await s.wait((c) => c.kind === 'orders' || (c.kind === 'err' && c.err.incoming_message && c.err.incoming_message.type === 'get_user_orders'), 10000, 'open orders');
        if (o.kind === 'err') throw new Error('QFEX get_user_orders: ' + o.err.error_code);
        const all = await s.collect(stopsMs);
        const subscribed = all.some((c) => c.kind === 'subscribed' && /stop/.test(String(c.channel)));
        const stops = [...all.filter((c) => c.kind === 'stop').map((c) => c.stop), ...all.filter((c) => c.kind === 'stops').flatMap((c) => c.stops)];
        const latest = new Map(); for (const st of stops) latest.set(String(st.stop_order_id), st);
        const bal = all.filter((c) => c.kind === 'balance').pop();
        return { orders: o.orders, stops: [...latest.values()], stopsSubscribed: subscribed, balance: bal ? bal.balance : null };
      } finally { s.close(); }
    },
    // reqs: [{label, kind:'rest'|'ws', d}] -> results; stops at the first failure (never place an entry after a failed step).
    send: async (reqs) => {
      const out = []; let s = null;
      try {
        for (const r of reqs) {
          if (r.kind === 'rest') {
            const res = await rest(b, r.d.method, r.d.path, { body: r.d.body, creds });
            let err = res.ok ? null : `HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`;
            if (!err && r.d.path === '/user/leverage' && res.body && res.body.leverage != null && Number(res.body.leverage) !== 1) err = 'leverage is ' + res.body.leverage + ', not 1x';
            if (!err && r.d.path === '/user/leverage') { // confirm on the trade socket (authoritative, shape verified): the symbol must read 1x
              const sym = JSON.parse(r.d.body).symbol;
              if (!s) { s = await openSession(b, creds, { WS }); s.send({ type: 'subscribe', params: { channels: ['order_responses'] } }); }
              s.send({ type: 'get_user_leverage', params: { symbol: sym } });
              let lv; try { lv = await s.wait((c) => c.kind === 'leverage' || (c.kind === 'err' && c.err.incoming_message && c.err.incoming_message.type === 'get_user_leverage'), 10000, 'leverage'); }
              catch (e) { lv = null; }
              const row = lv && lv.kind === 'leverage' ? lv.rows.find((x) => x.symbol === sym) : null;
              if (!row) err = 'could not confirm 1x leverage on ' + sym;
              else if (Number(row.leverage) !== 1) err = `leverage on ${sym} is ${row.leverage}x, not 1x`;
            }
            out.push({ label: r.label, status: res.status, ok: !err, error: err, body: res.body }); if (err) break; continue;
          }
          if (!s) { s = await openSession(b, creds, { WS }); s.send({ type: 'subscribe', params: { channels: ['order_responses'] } }); }
          const m = r.d; s.send(m);
          if (m.type === 'cancel_on_disconnect') { out.push({ label: r.label, ok: true, status: 'sent' }); continue; }
          const cid = m.params.client_order_id;
          const match = (c) => (c.kind === 'order' && ((cid && c.order.client_order_id === cid) || (!cid && c.order.symbol === m.params.symbol)))
            || (c.kind === 'err' && c.err.incoming_message && c.err.incoming_message.type === m.type);
          let c; try { c = await s.wait(match, 10000, m.type + ' response'); } catch (e) { out.push({ label: r.label, ok: false, error: e.message + ' (state unknown: run status before retrying)' }); break; }
          if (c.kind === 'err') { out.push({ label: r.label, ok: false, error: c.err.error_code + (c.err.message ? ': ' + c.err.message : '') }); break; }
          let err = m.type === 'add_order' ? entryError(c.order, true) : m.type === 'cancel_order' ? (c.order.status === 'CANCELLED' ? null : 'cancel ' + c.order.status)
            : (['ACK', 'FILLED', 'IOC_PARTIALLY_FILLED', 'IOC_CANCELLED'].includes(c.order.status) ? null : 'close ' + c.order.status);
          if (m.type === 'add_order' && c.order.status === 'ACK' && err) { // safety: never leave an entry without its stops
            try { s.send(buildCancel(m.params.symbol, c.order.order_id)); err += ' -> entry cancelled'; } catch (e) { err += ' -> CANCEL FAILED: ' + e.message; }
          }
          out.push({ label: r.label, ok: !err, error: err, status: c.order.status, body: c.order }); if (err) break;
        }
      } catch (e) { out.push({ label: 'session', ok: false, error: e.message }); }
      finally { if (s) s.close(); }
      return out;
    },
  };
}
