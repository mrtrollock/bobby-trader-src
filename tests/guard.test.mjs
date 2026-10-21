// Protection guard: every open position must carry a live SL AND TP; unprotected -> attach at the planned level, else close.
// Offline: QFEX over the mocked WebSocket/REST, Arcus/Entropy over a mocked net. Nothing real is ever sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Q from '../src/qfex.js';
import * as C from '../autotrader/core.js';
import { randHex } from './helpers.mjs';
import { fakeWsClass, fakeFetch, ACCT } from './qfex_mock.mjs';

const T0 = Date.UTC(2026, 9, 21, 12, 0, 0);
const ENV = { AUTOTRADER_NETWORK: 'testnet', QFEX_API_PUBLIC_KEY: 'pk_' + randHex(8), QFEX_API_SECRET_KEY: randHex(24), QFEX_ACCOUNT_ID: ACCT, QFEX_KEY_SINGLE_ACCOUNT_ACK: '1' };
const POS = (over = {}) => ({ symbol: 'US100-USD', position: 0.003, average_price: 29600, unrealised_pnl: 0, leverage: 1, ...over });
const SL = { stop_order_id: 's-sl', account_id: ACCT, symbol: 'US100-USD', price: 29300, quantity: 0.003, direction: 'SELL', stop_order_type: 'STOPLOSS' };
const TP = { stop_order_id: 's-tp', account_id: ACCT, symbol: 'US100-USD', price: 30100, quantity: 0.003, direction: 'SELL', stop_order_type: 'TAKEPROFIT' };
const PLAN = { 'qfex:US100-USD': { pf: 'qfex', market: 'US100-USD', side: 'long', sl: 29300, tp: 30100 } };

function setup(stateOver = {}) {
  const cfg = C.loadConfig(ENV);
  const state = { mark: 29650, bid: 29649, ask: 29651, positions: [POS()], stops: [], orders: [], ...stateOver };
  const log = [], rest = [];
  const realFetch = globalThis.fetch; globalThis.fetch = fakeFetch(state, rest);
  let now = T0;
  const net = { now: () => now, retryMs: 1, qfex: Q.makeNet(cfg.bases.qfex, cfg.qfex, { WS: fakeWsClass(state, log), stopsMs: 20 }) };
  const io = { live: true, kill: null, logs: [], alerts: [], journals: [], plans: PLAN };
  io.log = (lvl, m) => io.logs.push(lvl + ' ' + m); io.alert = (a) => io.alerts.push(a); io.journal = (j) => io.journals.push(j);
  return { cfg, net, state, log, io, memo: {}, tick: (ms) => { now += ms; }, restore: () => { globalThis.fetch = realFetch; } };
}
const orderMsgs = (log) => log.filter((x) => x.m && ['add_order', 'close_position', 'cancel_order'].includes(x.m.type)).map((x) => x.m);

test('decideProtection: grace (2 ticks AND grace period), attach at planned level, close when past / no plan / did not stick', () => {
  const st = (orders = []) => ({ positions: [{ market: 'US100-USD', side: 'long', size: 0.003, entry: 29600, mark: 29650 }], orders });
  const memo = {};
  assert.equal(C.decideProtection('qfex', st(), PLAN, memo, T0)[0].kind, 'grace');
  assert.equal(C.decideProtection('qfex', st(), PLAN, memo, T0 + 60e3)[0].kind, 'grace'); // 2nd tick but < 120 s for QFEX
  const a = C.decideProtection('qfex', st(), PLAN, memo, T0 + 130e3)[0];
  assert.deepEqual([a.kind, a.missing, a.sl, a.tp], ['attach', ['sl', 'tp'], 29300, 30100]);
  assert.equal(C.decideProtection('qfex', st(), PLAN, memo, T0 + 190e3)[0].kind, 'close'); // attach did not stick
  // protected -> ok + memo cleared
  const ok = C.decideProtection('qfex', st([{ market: 'US100-USD', kind: 'SL' }, { market: 'US100-USD', kind: 'TP' }]), PLAN, memo, T0 + 250e3);
  assert.deepEqual(ok.map((x) => x.kind), ['recovered', 'ok']); assert.deepEqual(memo, {});
  // only the TP is missing -> only the TP is attached
  const m2 = {}; C.decideProtection('qfex', st([{ market: 'US100-USD', kind: 'SL' }]), PLAN, m2, T0);
  const tpOnly = C.decideProtection('qfex', st([{ market: 'US100-USD', kind: 'SL' }]), PLAN, m2, T0 + 121e3)[0];
  assert.deepEqual([tpOnly.kind, tpOnly.missing, tpOnly.sl, tpOnly.tp], ['attach', ['tp'], null, 30100]);
  // price already past the planned SL -> close
  const past = { positions: [{ market: 'US100-USD', side: 'long', size: 0.003, entry: 29600, mark: 29250 }], orders: [] }, m3 = {};
  C.decideProtection('qfex', past, PLAN, m3, T0); const c = C.decideProtection('qfex', past, PLAN, m3, T0 + 121e3)[0];
  assert.equal(c.kind, 'close'); assert.match(c.reason, /past the planned stop-loss/);
  // no plan (or a plan for the other side) -> close
  const m4 = {}; C.decideProtection('qfex', st(), {}, m4, T0); assert.match(C.decideProtection('qfex', st(), {}, m4, T0 + 121e3)[0].reason, /no planned/);
  const m5 = {}, wrong = { 'qfex:US100-USD': { ...PLAN['qfex:US100-USD'], side: 'short' } };
  C.decideProtection('qfex', st(), wrong, m5, T0); assert.equal(C.decideProtection('qfex', st(), wrong, m5, T0 + 121e3)[0].kind, 'close');
  // Arcus/Entropy grace is 60 s
  const m6 = {}; C.decideProtection('arcus', st(), {}, m6, T0); assert.equal(C.decideProtection('arcus', st(), {}, m6, T0 + 61e3)[0].kind, 'close');
  // a closed position drops out of the memo
  const m7 = {}; C.decideProtection('qfex', st(), PLAN, m7, T0); C.decideProtection('qfex', { positions: [], orders: [] }, PLAN, m7, T0 + 10e3); assert.deepEqual(m7, {});
});

test('plansFromJournal: plan field, and the real QFEX entry echo (live GOLD test shape); dry/failed entries ignored', () => {
  const lines = [
    JSON.stringify({ id: 'd', decision: 'dry-run', mode: 'dry', plan: { pf: 'qfex', market: 'US100-USD', side: 'long', sl: 1, tp: 2 } }),
    JSON.stringify({ id: 'g', decision: 'placed', mode: 'live', results: [{ label: 'set leverage', echo: { leverage: 1 } }, { label: 'entry', status: 'ACK',
      echo: { order_id: 'o', symbol: 'GOLD-USD', status: 'ACK', quantity: 0.001, price: 4141.2, take_profit: 4174.3, stop_loss: 4124.7, side: 'BUY', type: 'ALO' } }] }),
    JSON.stringify({ id: 'a', decision: 'placed', mode: 'live', plan: { pf: 'arcus', market: 'TSLA-USD', side: 'short', sl: 410, tp: 380 } }),
    JSON.stringify({ id: 'f', decision: 'failed', mode: 'live', plan: { pf: 'arcus', market: 'TSLA-USD', side: 'long', sl: 1, tp: 2 } }), 'not json'];
  const p = C.plansFromJournal(lines);
  assert.deepEqual(Object.keys(p).sort(), ['arcus:TSLA-USD', 'qfex:GOLD-USD']);
  assert.deepEqual([p['qfex:GOLD-USD'].side, p['qfex:GOLD-USD'].sl, p['qfex:GOLD-USD'].tp], ['long', 4124.7, 4174.3]);
  assert.equal(p['arcus:TSLA-USD'].side, 'short');
});

test('QFEX stop order: reduce-only side, no nested stops, allowed by policy; entries still must be ALO GTC with SL+TP', () => {
  const s = Q.buildStopOrder({ symbol: 'us100', positionIsLong: true, kind: 'SL', qty: 0.003, trig: 29300 });
  assert.deepEqual(s, { type: 'add_order', params: { symbol: 'US100-USD', side: 'SELL', order_type: 'STOP_LOSS', order_time_in_force: 'GTC', quantity: 0.003, price: 29300 } });
  assert.equal(Q.buildStopOrder({ symbol: 'US100-USD', positionIsLong: false, kind: 'TP', qty: 1, trig: 5 }).params.side, 'BUY');
  assert.throws(() => Q.assertQfexMessage({ type: 'add_order', params: { ...s.params, stop_loss: 1 } }), /no further stops/);
  assert.throws(() => Q.assertQfexMessage({ type: 'add_order', params: { symbol: 'US100-USD', side: 'BUY', order_type: 'LIMIT', order_time_in_force: 'GTC', quantity: 1, price: 1, stop_loss: 0.5, take_profit: 2 } }), /post-only/);
  assert.throws(() => Q.assertQfexMessage({ type: 'add_order', params: { symbol: 'US100-USD', side: 'BUY', order_type: 'MARKET', order_time_in_force: 'IOC', quantity: 1 } }), /post-only/);
});

test('QFEX guard live: unprotected position -> grace -> attach SL+TP at the planned levels -> protected next tick; alert written', async () => {
  const t = setup();
  try {
    let r = await C.guardTick(t.cfg, t.net, t.memo, t.io);
    assert.equal(r[0].kind, 'grace'); assert.equal(orderMsgs(t.log).length, 0);
    assert.equal(r[0].mark, 29650); // mark price from the public MDS
    t.tick(130e3); r = await C.guardTick(t.cfg, t.net, t.memo, t.io);
    const sent = orderMsgs(t.log);
    assert.deepEqual(sent.map((m) => [m.params.order_type, m.params.side, m.params.quantity, m.params.price]), [['STOP_LOSS', 'SELL', 0.003, 29300], ['TAKE_PROFIT', 'SELL', 0.003, 30100]]);
    assert.equal(r[0].did, 'attach'); assert.equal(r[0].ok, true);
    assert.equal(t.io.alerts.length, 1); assert.equal(t.io.alerts[0].kind, 'attach');
    assert.equal(t.io.journals[0].decision, 'guard');
    t.tick(60e3); r = await C.guardTick(t.cfg, t.net, t.memo, t.io);
    assert.deepEqual(r.map((x) => x.kind), ['recovered', 'ok']); assert.equal(orderMsgs(t.log).length, 2);
  } finally { t.restore(); }
});

test('QFEX guard live: attach rejected -> close_position (reduce-only); price past SL -> close directly', async () => {
  const t = setup({ stopReject: true });
  try {
    await C.guardTick(t.cfg, t.net, t.memo, t.io); t.tick(130e3);
    const r = await C.guardTick(t.cfg, t.net, t.memo, t.io);
    assert.deepEqual(orderMsgs(t.log).map((m) => m.type + ':' + (m.params.order_type || '')), ['add_order:STOP_LOSS', 'close_position:']);
    assert.equal(r[0].did, 'close'); assert.equal(r[0].ok, true); assert.deepEqual(t.state.closed, ['US100-USD']);
    assert.ok(t.io.logs.some((l) => /attaching sl\+tp failed/.test(l)));
    assert.deepEqual(t.io.alerts.map((a) => a.kind), ['close']);
  } finally { t.restore(); }
  const u = setup({ mark: 29200, bid: 29199, ask: 29201 });
  try {
    await C.guardTick(u.cfg, u.net, u.memo, u.io); u.tick(130e3);
    const r = await C.guardTick(u.cfg, u.net, u.memo, u.io);
    assert.deepEqual(orderMsgs(u.log).map((m) => m.type), ['close_position']); assert.match(r[0].reason || '', /past the planned stop-loss/);
  } finally { u.restore(); }
});

test('QFEX guard: protected position untouched; dry run / kill switch only alert; read-only never sends or alerts', async () => {
  const p = setup({ stops: [SL, TP] });
  try {
    for (let i = 0; i < 3; i++) { const r = await C.guardTick(p.cfg, p.net, p.memo, p.io); assert.deepEqual(r.map((x) => x.kind), ['ok']); p.tick(200e3); }
    assert.equal(orderMsgs(p.log).length, 0); assert.equal(p.io.alerts.length, 0);
  } finally { p.restore(); }
  // stops listed only through get_user_orders (exact mainnet shape) also count
  const o = setup({ orders: [{ order_id: 'x1', symbol: 'US100-USD', status: 'ACK', price: 29300, type: 'STOP_LOSS', reduce_only: true, order_origin: 'STOP_ORDER', quantity: 0.003 },
    { order_id: 'x2', symbol: 'US100-USD', status: 'ACK', price: 30100, type: 'TAKE_PROFIT', reduce_only: true, order_origin: 'STOP_ORDER', quantity: 0.003 }] });
  try { assert.equal((await C.guardTick(o.cfg, o.net, o.memo, o.io))[0].kind, 'ok'); } finally { o.restore(); }
  for (const [name, io] of [['dry', { live: false }], ['kill', { kill: 'STOP file present' }]]) {
    const d = setup();
    try {
      Object.assign(d.io, io);
      await C.guardTick(d.cfg, d.net, d.memo, d.io); d.tick(130e3);
      const r = await C.guardTick(d.cfg, d.net, d.memo, d.io); d.tick(60e3); await C.guardTick(d.cfg, d.net, d.memo, d.io);
      assert.equal(orderMsgs(d.log).length, 0, name); assert.ok(r[0].held, name);
      assert.equal(d.io.alerts.length, 1, name); assert.equal(d.io.alerts[0].kind, 'unprotected');
    } finally { d.restore(); }
  }
  const ro = setup();
  try {
    await C.guardTick(ro.cfg, ro.net, ro.memo, ro.io, { readOnly: true }); ro.tick(130e3);
    const r = await C.guardTick(ro.cfg, ro.net, ro.memo, ro.io, { readOnly: true });
    assert.match(r[0].would, /attach sl\+tp/); assert.equal(orderMsgs(ro.log).length, 0); assert.equal(ro.io.alerts.length, 0);
  } finally { ro.restore(); }
});

test('QFEX guard: a dropped trade WebSocket is re-opened and re-read; persistent failure -> "unknown", never a close', async () => {
  const t = setup({ stops: [SL, TP], dropTrade: 2 });
  try {
    const r = await C.guardTick(t.cfg, t.net, t.memo, t.io);
    assert.deepEqual(r.map((x) => x.kind), ['ok']);
    assert.ok(t.log.filter((x) => x.open && /trade/.test(x.open)).length >= 3);
  } finally { t.restore(); }
  const u = setup({ dropTrade: 1000 });
  try {
    for (let i = 0; i < 4; i++) { const r = await C.guardTick(u.cfg, u.net, u.memo, u.io); assert.equal(r[0].kind, 'unknown'); u.tick(120e3); }
    assert.equal(orderMsgs(u.log).length, 0);
    assert.equal(u.io.alerts.length, 1); assert.equal(u.io.alerts[0].kind, 'unknown');
  } finally { u.restore(); }
});
