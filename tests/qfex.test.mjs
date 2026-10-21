// QFEX adapter + autotrader policy: offline (mocked REST + mocked WebSocket). No real order is ever sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import * as Q from '../src/qfex.js';
import * as C from '../autotrader/core.js';
import { processQueue } from '../autotrader/cli.js';
import { validateProposal } from '../src/proposal.js';
import { randHex } from './helpers.mjs';
import { fakeWsClass, fakeFetch, ACCT, USER } from './qfex_mock.mjs';

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const PUB = 'pk_' + randHex(8), SEC = randHex(24);
const ENV = { AUTOTRADER_NETWORK: 'testnet', QFEX_API_PUBLIC_KEY: PUB, QFEX_API_SECRET_KEY: SEC, QFEX_ACCOUNT_ID: ACCT, QFEX_KEY_SINGLE_ACCOUNT_ACK: '1' };
const cfgOf = (x = {}) => C.loadConfig({ ...ENV, ...x });
const exp = NOW / 1000 + 3600;
// US100 ~ 29,600: 0.003 lots ~ $88.8 notional, SL 300 pts away -> $0.90 + fees
const QX = { id: 'q1', pf: 'qfex', m: 'US100-USD', sd: 'long', et: 'limit', px: 29590.4, sz: 0.00309, lev: 1, sl: 29290.2, tp: 30100.9, exp, ref: 29600 };

function setup(stateOver = {}, cfgExtra = {}) {
  const cfg = cfgOf(cfgExtra);
  const state = { mark: 29600, bid: 29599, ask: 29601, ...stateOver };
  const log = [], restLog = [];
  const realFetch = globalThis.fetch; globalThis.fetch = fakeFetch(state, restLog);
  const net = { now: () => NOW, qfex: Q.makeNet(cfg.bases.qfex, cfg.qfex, { WS: fakeWsClass(state, log), stopsMs: 30 }) };
  return { cfg, net, state, log, restLog, restore: () => { globalThis.fetch = realFetch; } };
}
const sentWs = (log) => log.filter((x) => x.m && !/mds/.test(x.url)).map((x) => x.m);

test('HMAC signature matches HMAC-SHA256(secret, "nonce:ts") hex; REST + WS auth shapes', () => {
  const s = Q.signature('topsecret', 'abc123', 1700000000);
  assert.equal(s, createHmac('sha256', 'topsecret').update('abc123:1700000000').digest('hex'));
  const h = Q.authHeaders({ pub: 'P', secret: 'topsecret0123456789', accountId: ACCT }, { nonce: 'n1', unixTs: 5 });
  assert.deepEqual(Object.keys(h).sort(), ['x-qfex-hmac-signature', 'x-qfex-nonce', 'x-qfex-public-key', 'x-qfex-requested-account-id', 'x-qfex-timestamp']);
  const a = Q.authMessage({ pub: 'P', secret: 'topsecret0123456789', accountId: ACCT }, { nonce: 'n1', unixTs: 5 });
  assert.deepEqual(a, { type: 'auth', params: { hmac: { public_key: 'P', nonce: 'n1', unix_ts: 5, signature: Q.signature('topsecret0123456789', 'n1', 5) }, account_id: ACCT } });
  assert.ok(Q.newNonce() !== Q.newNonce() && Q.newNonce().length <= 100);
});

test('network switch: AUTOTRADER_NETWORK=testnet -> qfex.io (UAT), mainnet -> qfex.com', () => {
  assert.equal(cfgOf().bases.qfex.rest, 'https://api.qfex.io');
  assert.equal(cfgOf().bases.qfex.trade, 'wss://trade.qfex.io');
  const m = cfgOf({ AUTOTRADER_NETWORK: 'mainnet' }).bases.qfex;
  assert.deepEqual([m.rest, m.trade, m.mds], ['https://api.qfex.com', 'wss://trade.qfex.com', 'wss://mds.qfex.com']);
  assert.throws(() => cfgOf({ QFEX_ACCOUNT_ID: 'not-a-uuid' }), /UUID/);
  assert.throws(() => cfgOf({ QFEX_API_SECRET_KEY: '' }), /both required/);
  assert.ok(C.secretsOf(cfgOf()).includes(SEC));
});

test('fees: Tier 5 schedule, stop leg = max(taker, floor) + slippage; live fees used when sane', () => {
  const idx = Q.rates('INDEX', null), eq = Q.rates('EQUITY', null), com = Q.rates('COMMODITY', null);
  assert.deepEqual([idx.maker, idx.taker, idx.stopRate], [0.0002, 0.0005, 0.001]);
  assert.deepEqual([com.maker, com.taker], [0.0002, 0.0005]);
  assert.deepEqual([eq.maker, eq.taker, eq.stopRate], [0.0005, 0.001, 0.002]);
  const live = Q.rates('INDEX', { maker_fee: '0.0001', taker_fee: '0.0003' });
  assert.equal(live.source, 'GET /user/fees'); assert.equal(live.stopTaker, 0.0005); // floor applies
  assert.equal(Q.rates('INDEX', { maker_fee: '2', taker_fee: '5' }).source, 'schedule (Tier 5)'); // bps / bogus -> schedule
  assert.equal(Q.rates('INDEX', null, { slippage: 0.002 }).stopRate, 0.0025);
  assert.equal(Q.categoryOf('US100'), 'INDEX'); assert.equal(Q.categoryOf('NVDA-USD'), 'EQUITY'); assert.equal(Q.categoryOf('X', { product_category: 'commodity' }), 'COMMODITY');
});

test('order construction: ALO GTC entry with SL+TP, safe tick/lot rounding, guard refuses everything else', () => {
  const r = Q.roundProposal({ isLong: true, px: 29590.4, sl: 29290.2, tp: 30100.9, qty: 0.00309 }, { tick_size: '1', lot_size: '0.0001' });
  assert.deepEqual([r.px, r.sl, r.tp, r.qty], [29590, 29291, 30100, 0.003]);
  const s = Q.roundProposal({ isLong: false, px: 29610.2, sl: 29900.7, tp: 29100.3, qty: 0.0031 }, { tick_size: '1', lot_size: '0.0001' });
  assert.deepEqual([s.px, s.sl, s.tp], [29611, 29900, 29101]);
  const e = Q.buildEntry({ symbol: 'us100', isLong: true, qty: 0.003, px: 29590, sl: 29291, tp: 30100, clientOrderId: 'c1' });
  assert.deepEqual(e, { type: 'add_order', params: { symbol: 'US100-USD', side: 'BUY', order_type: 'ALO', order_time_in_force: 'GTC', quantity: 0.003, price: 29590, take_profit: 30100, stop_loss: 29291, client_order_id: 'c1' } });
  assert.throws(() => Q.buildEntry({ symbol: 'US100-USD', isLong: true, qty: 0.003, px: 29590, sl: 0, tp: 30100 }), /stop-loss and take-profit/);
  assert.throws(() => Q.buildEntry({ symbol: 'US100-USD', isLong: true, qty: 0.003, px: 29590, sl: 29700, tp: 30100 }), /wrong side/);
  for (const bad of [{ ...e, params: { ...e.params, order_type: 'LIMIT' } }, { ...e, params: { ...e.params, order_type: 'MARKET', order_time_in_force: 'IOC' } },
    { ...e, params: { ...e.params, stop_loss: 0 } }, { ...e, params: { ...e.params, take_profit: undefined } }])
    assert.throws(() => Q.assertQfexMessage(bad), /post-only|mandatory/);
  for (const t of ['modify_order', 'cancel_all_orders', 'cancel_stop_order', 'modify_stop_order', 'add_twap', 'transfer', 'withdraw'])
    assert.throws(() => Q.assertQfexMessage({ type: t, params: {} }), /forbidden/);
  assert.throws(() => Q.assertQfexMessage({ type: 'cancel_on_disconnect', params: { cancel_on_disconnect: true } }), /stays off/);
  assert.throws(() => Q.assertQfexMessage({ type: 'auth', params: { builder_code: 'x' } }), /builder/);
  assert.throws(() => Q.leverageRequest('US100-USD', 2), /1x/);
  assert.deepEqual(Q.leverageRequest('US100'), { method: 'POST', path: '/user/leverage', body: '{"symbol":"US100-USD","leverage":1}' });
  assert.deepEqual(Q.buildClosePosition('US100', 'c').type, 'close_position');
  // REST allowlist: never the funding service or any money-moving path
  for (const [b, m, p] of [['https://banker.qfex.com', 'GET', '/address'], ['https://banker.qfex.io', 'POST', '/withdraw'], ['https://api.qfex.com', 'POST', '/user/transfer'],
    ['https://api.qfex.com', 'GET', '/withdrawal-addresses'], ['https://api.qfex.com', 'POST', '/user/api-keys'], ['https://api.qfex.com', 'DELETE', '/user/positions'], ['https://evil.com', 'GET', '/user/positions']])
    assert.throws(() => Q.assertQfexRest(b, m, p), /forbidden/);
  Q.assertQfexRest('https://api.qfex.com', 'GET', '/user/trade?limit=1'); Q.assertQfexRest('https://api.qfex.io', 'POST', '/user/leverage');
});

test('proposal validation: qfex accepts open entries with SL+TP only', () => {
  const base = { v: 1, id: 'x', pf: 'qfex', m: 'US100-USD', sd: 'long', sz: 0.003, lev: 1, et: 'limit', px: 29590, sl: 29291, tp: 30100 };
  assert.equal(validateProposal(base).pf, 'qfex');
  assert.throws(() => validateProposal({ ...base, tp: undefined }), /take-profit/);
  assert.throws(() => validateProposal({ ...base, act: 'tpsl' }), /only new entries/);
  assert.throws(() => validateProposal({ ...base, act: 'cancel', oid: '1' }), /only new entries/);
});

test('key safety: ack required; 403 on the cross-account listing = single-account evidence; All-accounts, foreign-account and main-account keys refused', async () => {
  let t = setup({}, { QFEX_KEY_SINGLE_ACCOUNT_ACK: '0' });
  try { await assert.rejects(C.verifyKeys(t.cfg, t.net), /QFEX_KEY_SINGLE_ACCOUNT_ACK=1/); } finally { t.restore(); }
  t = setup();
  try { const v = await C.verifyKeys(t.cfg, t.net); assert.match(v.qfex.scope, /cross-account listing 403/); assert.match(v.qfex.account, /^subaccount \(verified/); assert.match(v.qfex.websocket, /authenticated/);
    assert.ok(t.restLog.every((r) => r.method === 'GET' && !/withdraw|transfer|address/.test(r.path)));
    assert.ok(!JSON.stringify(v).includes(PUB) && !JSON.stringify(v).includes(ACCT)); } finally { t.restore(); }
  t = setup({ allAccountsKey: true });
  try { await assert.rejects(C.verifyKeys(t.cfg, t.net), /All accounts/); } finally { t.restore(); }
  t = setup({ foreignReadable: true });
  try { await assert.rejects(C.verifyKeys(t.cfg, t.net), /foreign account/); } finally { t.restore(); }
  t = setup({ wsAccount: USER, ownAccount: USER }, { QFEX_ACCOUNT_ID: USER });
  try { await assert.rejects(C.verifyKeys(t.cfg, t.net), /MAIN \(primary\) account/); } finally { t.restore(); }
  t = setup({ wsAccount: USER, ownAccount: USER }, { QFEX_ACCOUNT_ID: USER, QFEX_ALLOW_MAIN_ACCOUNT: '1' });
  try { assert.match((await C.verifyKeys(t.cfg, t.net)).qfex.account, /main account/); } finally { t.restore(); }
  t = setup({ wsAccount: USER });
  try { await assert.rejects(C.verifyKeys(t.cfg, t.net), /different account/); } finally { t.restore(); }
  t = setup({ noReferral: true }); // no main/sub signal -> the ack decides, nothing refused
  try { assert.match((await C.verifyKeys(t.cfg, t.net)).qfex.account, /undetermined/); } finally { t.restore(); }
  t = setup({}, { QFEX_ACCOUNT_ID: '' });
  try { await assert.rejects(C.verifyKeys(t.cfg, t.net), /set QFEX_ACCOUNT_ID/); } finally { t.restore(); }
  t = setup({ noBalance: true });
  try { await assert.rejects(C.verifyKeys(t.cfg, t.net), /account identity/); } finally { t.restore(); }
  t = setup({ authOk: false });
  try { await assert.rejects(C.accountState('qfex', t.cfg, t.net), /authentication failed/); } finally { t.restore(); }
});

test('state: equity = deposit + pnl + funding, capped by the latest account-equity point; free = available_balance', async () => {
  const t = setup({ balance: { deposit: 300, realised_pnl: -2, unrealised_pnl: 1, net_funding: 0, available_balance: 250 }, equitySeries: [300, 297.5] });
  try { const s = await C.accountState('qfex', t.cfg, t.net); assert.equal(s.equity, 297.5); assert.equal(s.free, 250); } finally { t.restore(); }
});

test('evaluate: passing US100 long; risk uses maker entry + taker/slippage stop leg', async () => {
  const t = setup();
  try {
    const ev = await C.evaluate(QX, t.cfg, t.net);
    assert.deepEqual(ev.reasons, []); assert.equal(ev.ok, true);
    assert.deepEqual([ev.p.px, ev.p.sl, ev.p.tp, ev.ctx.size], [29590, 29291, 30100, 0.003]);
    const expect = 0.003 * (29590 - 29291) + 0.003 * 29590 * 0.0002 + 0.003 * 29291 * 0.001;
    assert.ok(Math.abs(ev.risk.slLoss - expect) < 1e-6, ev.risk.slLoss + ' vs ' + expect);
    assert.equal(ev.risk.fees.category, 'INDEX'); assert.equal(ev.risk.fees.stopRate, 0.001);
    const reqs = await C.buildOpen(ev, t.cfg, t.net);
    assert.deepEqual(reqs.map((r) => r.kind), ['rest', 'ws', 'ws']);
    assert.equal(reqs[0].d.path, '/user/leverage'); assert.equal(JSON.parse(reqs[0].d.body).leverage, 1);
    assert.equal(reqs[2].d.params.order_type, 'ALO');
  } finally { t.restore(); }
});

test('evaluate: hard blocks (loss > $3 incl. stop fee+slippage, weekly cap, free collateral, crossing, drift, equity category, max 3, stops unknown)', async () => {
  const check = async (q, st, re, cx = {}) => { const t = setup(st, cx); try { const ev = await C.evaluate(q, t.cfg, t.net); assert.equal(ev.ok, false); assert.ok(ev.reasons.some((x) => re.test(x)), ev.reasons.join(' | ')); } finally { t.restore(); } };
  await check({ ...QX, sz: 0.0095 }, {}, /loss at SL/); // 0.0095*299 = 2.84 + fees ~0.34 -> > $3
  await check(QX, { trades: [{ order_timestamp: NOW / 1000 - 3600, realised_pnl_change: '-49', fee: '0.5', symbol: 'US100-USD' }] }, /weekly/);
  await check(QX, { balance: { deposit: 300, realised_pnl: 0, unrealised_pnl: 0, net_funding: 0, available_balance: 20 } }, /free collateral/);
  await check({ ...QX, px: 29601.5 }, {}, /cross/);
  await check({ ...QX, sd: 'short', px: 29598.2, sl: 29900, tp: 29100 }, {}, /cross/);
  await check({ ...QX, ref: 29000 }, {}, /moved/);
  await check({ ...QX, sz: 0.0004 }, {}, /minimum/);
  await check({ ...QX, lev: 2 }, {}, /leverage/);
  await check({ ...QX, tp: null }, {}, /take-profit/);
  await check({ ...QX, et: 'market' }, {}, /post-only/);
  await check({ ...QX, m: 'AAPL-USD', px: 330, sl: 325, tp: 340, ref: 331, sz: 0.1 }, { mark: 331, bid: 330.9, ask: 331.1 }, /category EQUITY not allowed/, { QFEX_CATEGORIES: 'INDEX,COMMODITY' });
  const pos = (s) => ({ symbol: s, position: '0.003', average_price: '100', unrealised_pnl: '0', leverage: 1 });
  await check(QX, { positions: [pos('GOLD-USD'), pos('CL-USD'), pos('US500-USD')], stops: [{ stop_order_id: 's', symbol: 'GOLD-USD', price: '90', quantity: '0.003', direction: 'SELL', stop_order_type: 'STOP_LOSS' }] }, /max 3/);
  await check(QX, { positions: [pos('GOLD-USD')], noStopsSnapshot: true }, /stop orders could not be read/);
  await check(QX, { positions: [pos('US100-USD')], stops: [{ stop_order_id: 's', symbol: 'US100-USD', price: '90', quantity: '0.003', direction: 'SELL', stop_order_type: 'STOP_LOSS' }] }, /already exists/);
});

test('equity stop leg costs 0.10% taker + 0.10% slippage', async () => {
  const t = setup({ mark: 331, bid: 330.9, ask: 331.1 });
  try {
    const ev = await C.evaluate({ ...QX, m: 'AAPL-USD', px: 330, sl: 325, tp: 340, ref: 331, sz: 0.1 }, t.cfg, t.net);
    assert.equal(ev.risk.fees.category, 'EQUITY'); assert.equal(ev.risk.fees.preferred, false);
    const expect = 0.1 * 5 + 0.1 * 330 * 0.0005 + 0.1 * 325 * 0.002;
    assert.ok(Math.abs(ev.risk.slLoss - expect) < 1e-9);
  } finally { t.restore(); }
});

test('dry run (default): nothing is sent on the trade socket, journal records the ALO+SL+TP entry', async () => {
  const t = setup({}, { AUTOTRADER_ENABLED: '1' });
  assert.equal(t.cfg.live, false);
  try {
    const state = { dry: {}, live: {} }, j = [];
    const r = await processQueue(t.cfg, t.net, { queue: [QX], state, stopExists: () => false, logFn: () => {}, journalFn: (x) => j.push(x) });
    assert.equal(r[0].status, 'dry-run');
    assert.ok(!sentWs(t.log).some((m) => ['add_order', 'cancel_order', 'close_position', 'cancel_on_disconnect'].includes(m.type)));
    assert.ok(!t.restLog.some((x) => x.method !== 'GET'));
    const entry = r[0].requests.find((x) => x.ws === 'add_order').body.params;
    assert.equal(entry.order_type, 'ALO'); assert.ok(entry.stop_loss > 0 && entry.take_profit > 0);
  } finally { t.restore(); }
});

test('live send path against the MOCK socket: leverage 1x first, entry ACK must echo SL/TP else the entry is cancelled', async () => {
  let t = setup({}, { AUTOTRADER_LIVE: '1', AUTOTRADER_ENABLED: '1' });
  try {
    const r = await processQueue(t.cfg, t.net, { queue: [QX], state: { dry: {}, live: {} }, stopExists: () => false, logFn: () => {}, journalFn: () => {} });
    assert.equal(r[0].status, 'placed');
    const lev = t.restLog.find((x) => x.method === 'POST'); assert.equal(lev.path, '/user/leverage');
    const ws = sentWs(t.log).map((m) => m.type);
    assert.deepEqual(ws.filter((x) => x !== 'subscribe' && x !== 'get_user_orders'), ['auth', 'auth', 'get_user_leverage', 'cancel_on_disconnect', 'add_order']);
  } finally { t.restore(); }
  t = setup({ ackStops: false }, { AUTOTRADER_LIVE: '1', AUTOTRADER_ENABLED: '1' });
  try {
    const r = await processQueue(t.cfg, t.net, { queue: [QX], state: { dry: {}, live: {} }, stopExists: () => false, logFn: () => {}, journalFn: () => {} });
    assert.equal(r[0].status, 'failed');
    assert.ok(sentWs(t.log).some((m) => m.type === 'cancel_order' && m.params.order_id === 'oid-1'));
  } finally { t.restore(); }
  for (const st of [{ leverageEcho: null, levStuck: 10 }, { leverageEcho: null, levStuck: 1 }]) { // REST body without leverage: the trade socket decides
    t = setup(st, { AUTOTRADER_LIVE: '1', AUTOTRADER_ENABLED: '1' });
    try {
      const r = await processQueue(t.cfg, t.net, { queue: [QX], state: { dry: {}, live: {} }, stopExists: () => false, logFn: () => {}, journalFn: () => {} });
      assert.equal(r[0].status, st.levStuck === 1 ? 'placed' : 'failed'); assert.equal(sentWs(t.log).some((m) => m.type === 'add_order'), st.levStuck === 1);
    } finally { t.restore(); }
  }
  t = setup({ leverageEcho: 5 }, { AUTOTRADER_LIVE: '1', AUTOTRADER_ENABLED: '1' });
  try {
    const r = await processQueue(t.cfg, t.net, { queue: [QX], state: { dry: {}, live: {} }, stopExists: () => false, logFn: () => {}, journalFn: () => {} });
    assert.equal(r[0].status, 'failed'); assert.ok(!sentWs(t.log).some((m) => m.type === 'add_order'));
  } finally { t.restore(); }
});

test('cancel/close: only resting entries are cancellable, stops never; close uses close_position', async () => {
  const st = { positions: [{ symbol: 'US100-USD', position: '-0.003', average_price: '29600', unrealised_pnl: '-0.1', leverage: 1 }],
    stops: [{ stop_order_id: 'sl-1', symbol: 'US100-USD', price: '29900', quantity: '0.003', direction: 'BUY', stop_order_type: 'STOP_LOSS' },
      { stop_order_id: 'tp-1', symbol: 'US100-USD', price: '29100', quantity: '0.003', direction: 'BUY', stop_order_type: 'TAKE_PROFIT' }],
    orders: [{ order_id: 'o-9', symbol: 'GOLD-USD', status: 'ACK', side: 'BUY', type: 'ALO', price: '4000', quantity: '0.01', stop_loss: '3990', take_profit: '4020' }] };
  const t = setup(st);
  try {
    const s = await C.accountState('qfex', t.cfg, t.net);
    assert.equal(s.positions[0].side, 'short'); assert.equal(s.stopsKnown, true);
    assert.deepEqual(s.orders.map((o) => o.kind).sort(), ['LIMIT', 'SL', 'TP']);
    await assert.rejects(C.buildCancel('qfex', 'US100', 'sl-1', t.cfg, t.net), /stop-loss|never cancelled/);
    await assert.rejects(C.buildCancel('qfex', 'US100', 'tp-1', t.cfg, t.net), /never cancelled/);
    const c = await C.buildCancel('qfex', 'GOLD', 'o-9', t.cfg, t.net);
    assert.deepEqual(c[0].d, { type: 'cancel_order', params: { symbol: 'GOLD-USD', order_id: 'o-9', cancel_order_id_type: 'order_id' } });
    const cl = await C.buildClose('qfex', 'US100', t.cfg, t.net);
    assert.equal(cl[0].d.type, 'close_position'); assert.equal(cl[0].d.params.symbol, 'US100-USD');
  } finally { t.restore(); }
});

test('weekly loss: realised_pnl_change minus fee since Monday 00:00 UTC; second/ms timestamps', async () => {
  const mon = Date.UTC(2026, 9, 19);
  const t = setup({ trades: [
    { order_timestamp: (mon - 1000) / 1000, realised_pnl_change: '-100', fee: '1' },
    { order_timestamp: mon + 1000, realised_pnl_change: '-5', fee: '0.2' },
    { order_timestamp: (mon + 5000) / 1000, realised_pnl_change: '2', fee: '0.1' }] });
  try { const s = await C.accountState('qfex', t.cfg, t.net); assert.ok(Math.abs(s.weeklyLoss - 3.3) < 1e-9); } finally { t.restore(); }
});

test('QFEX loss limits: $3/trade (fees + stop slippage), ≤ 5% of live equity, ≤ remaining of the $30 week; env-configurable with ceilings', async () => {
  const c = cfgOf(); assert.equal(c.qfex.weeklyLossCap, 30); assert.equal(c.qfex.maxTradeLossUsd, 3);
  assert.throws(() => cfgOf({ QFEX_WEEKLY_LOSS_CAP_USD: '60' }), /<= 50/);
  assert.throws(() => cfgOf({ QFEX_MAX_TRADE_LOSS_USD: '40' }), /weekly cap/);
  assert.equal(cfgOf({ QFEX_WEEKLY_LOSS_CAP_USD: '20', QFEX_MAX_TRADE_LOSS_USD: '2' }).qfex.maxTradeLossUsd, 2);
  const ev = async (q, st, cx) => { const t = setup(st, cx); try { return await C.evaluate(q, t.cfg, t.net); } finally { t.restore(); } };
  const bal = (eq) => ({ balance: { deposit: eq, realised_pnl: 0, unrealised_pnl: 0, net_funding: 0, available_balance: eq }, equitySeries: [eq] });
  // $300 equity: 0.0095 lots risk ~$3.18 > $3 (would pass the old 1 %-of-$300 = $3 too); 0.0085 ~ $2.85 passes
  let e = await ev({ ...QX, sz: 0.0095 }, bal(300)); assert.ok(e.reasons.some((x) => /loss at SL \$3\.\d+ > \$3\.00 \(\$3\.00 max per trade/.test(x)), e.reasons.join('|'));
  e = await ev({ ...QX, sz: 0.0085 }, bal(300)); assert.deepEqual(e.reasons, []); assert.equal(e.risk.maxLoss, 3);
  // $40 equity: 5 % = $2 < $3 -> $2 cap
  e = await ev({ ...QX, sz: 0.0085, sl: 29400 }, bal(40)); assert.equal(e.risk.maxLoss, 2);
  // weekly: $28.50 used of $30 -> a $2.85 trade would exceed the remaining $1.50
  e = await ev({ ...QX, sz: 0.0085 }, { ...bal(300), trades: [{ order_timestamp: NOW / 1000 - 60, realised_pnl_change: '-28', fee: '0.5' }] });
  assert.ok(e.reasons.some((x) => /exceed the weekly cap .* > \$30/.test(x)), e.reasons.join('|'));
  e = await ev(QX, { ...bal(300), trades: [{ order_timestamp: NOW / 1000 - 60, realised_pnl_change: '-30', fee: '0' }] });
  assert.ok(e.reasons.some((x) => /weekly loss cap reached \(\$30\.00 \/ \$30\)/.test(x)));
  // Arcus / Entropy unchanged: 1 % of capital, $50/week
  const { POLICY, policyFor, checkPolicy } = await import('../src/risk.js');
  assert.equal(policyFor('arcus'), POLICY); assert.equal(policyFor('hl'), POLICY); assert.equal(POLICY.weeklyLossCap, 50);
  const r = { slLoss: 3.5, margin: 1 };
  assert.match(checkPolicy({ pf: 'arcus', act: 'open', et: 'limit', lev: 1, sl: 1 }, r).blocks.join(), /\(1\.0% of \$300\)/);
  assert.equal(checkPolicy({ pf: 'qfex', act: 'open', et: 'limit', lev: 1, sl: 1 }, r, { policy: policyFor('qfex') }).maxLoss, 3); // web app: 5 % of $100 = $5 -> $3
});
