// QFEX volume mode: pure decisions + the executor over the mocked QFEX WebSocket/REST. Nothing real is ever sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Q from '../src/qfex.js';
import * as C from '../autotrader/core.js';
import * as V from '../autotrader/volume.js';
import { randHex } from './helpers.mjs';
import { fakeWsClass, fakeFetch, FXQ, ACCT } from './qfex_mock.mjs';

const T0 = Date.UTC(2026, 9, 21, 14, 0, 0); // Wednesday 09:00 Chicago: US100 regular session
const REF = FXQ('qfex_refdata_us100.json').data[0];
const REFS = { 'US100-USD': REF, 'CL-USD': { ...REF, symbol: 'CL-USD', product_category: 'COMMODITY', tick_size: '0.01', lot_size: '0.001', min_quantity: '0.1', default_max_leverage: 10 } };
const FEES = { 'US100-USD': { maker_fee: 0.0002, taker_fee: 0.0005 }, 'CL-USD': { maker_fee: 0, taker_fee: 0.00006 } };
const QUOTES = { 'US100-USD': { mark: 25000, bid: 24999, ask: 25001 }, 'CL-USD': { mark: 98, bid: 97.99, ask: 98.01 } };
const VC = (o = {}) => ({ ...V.loadVolumeConfig({ QFEX_VOLUME_MODE: '1', QFEX_LEVERAGE: '5', QFEX_VOL_MARKETS: 'US100,CL', ...o }) });
const LIM = { perTrade: 3, weeklyCap: 30 };
const ST = (o = {}) => ({ equity: 100, free: 100, positions: [], orders: [], weeklyLoss: 0, dailyLoss: 0, ...o });
const rng0 = () => 0.5;
const decide = (o = {}) => V.decideVolume({ vc: VC(), st: ST(), refs: REFS, fees: FEES, quotes: QUOTES, vstate: {}, now: T0, rng: rng0, limits: LIM, ...o });
const entryRow = (o = {}) => ({ id: 'e1', market: 'US100-USD', side: 'BUY', kind: 'LIMIT', px: 24999, size: 0.004, reduceOnly: false, raw: { client_order_id: 'b-vol-abc' }, ...o });

test('config: OFF by default; leverage and limits validated', () => {
  assert.equal(V.loadVolumeConfig({}).enabled, false);
  const cfg = C.loadConfig({ AUTOTRADER_NETWORK: 'testnet', QFEX_API_PUBLIC_KEY: 'pk_' + randHex(8), QFEX_API_SECRET_KEY: randHex(24), QFEX_ACCOUNT_ID: ACCT, QFEX_KEY_SINGLE_ACCOUNT_ACK: '1' });
  assert.equal(cfg.qfexVol.enabled, false);
  for (const lev of ['11', '0', '2.5']) assert.throws(() => V.loadVolumeConfig({ QFEX_LEVERAGE: lev }), /QFEX_LEVERAGE/);
  assert.throws(() => V.loadVolumeConfig({ QFEX_VOL_SL_PCT: '0.1' }), /SL_PCT/);
  assert.equal(V.loadVolumeConfig({ QFEX_LEVERAGE: '10' }).leverage, 10);
  assert.deepEqual(V.loadVolumeConfig({}).prefer, ['US100-USD', 'US500-USD']);
});

test('session: regular session only, and still open 15 min later', () => {
  assert.equal(V.inSession(REF, T0), true);
  assert.equal(V.inSession(REF, Date.UTC(2026, 9, 21, 20, 50)), false); // 15:50 Chicago: closes 15:59:59
  assert.equal(V.inSession(REF, Date.UTC(2026, 9, 24, 14)), false);      // Saturday
});

test('entry: maker at the touch, attached SL + backup TP, worst loss incl. fees <= $3, cheapest fee first, one per tick', () => {
  const { actions } = decide();
  assert.equal(actions.length, 1);
  const a = actions[0];
  assert.equal(a.market, 'CL-USD'); // 0 maker beats 2 bp
  assert.ok(a.side === 'long' ? a.px === 97.99 : a.px === 98.01);
  assert.ok(a.risk.worstLoss <= 3 && a.risk.notional > 100 && a.risk.notional < 160, JSON.stringify(a.risk));
  assert.ok(a.side === 'long' ? a.sl < a.px && a.tp > a.px : a.sl > a.px && a.tp < a.px);
  assert.ok(a.risk.liqDist >= 3 * a.risk.slDist);
  // preference tie-break among equal fees: US100 before US500
  const refs = { 'US500-USD': { ...REF, symbol: 'US500-USD' }, 'US100-USD': REF };
  const q = { 'US500-USD': QUOTES['US100-USD'], 'US100-USD': QUOTES['US100-USD'] };
  const r2 = V.decideVolume({ vc: VC({ QFEX_VOL_MARKETS: 'US500,US100' }), st: ST(), refs, fees: { 'US500-USD': FEES['US100-USD'], 'US100-USD': FEES['US100-USD'] }, quotes: q, vstate: {}, now: T0, rng: () => 0.99, limits: LIM });
  assert.equal(r2.actions[0].market, 'US100-USD');
  // a live 0 bp maker fee (depositor promo) on US500 puts it first
  const r3 = V.decideVolume({ vc: VC({ QFEX_VOL_MARKETS: 'US500,US100' }), st: ST(), refs, fees: { 'US500-USD': { maker_fee: 0, taker_fee: 0.00006 }, 'US100-USD': FEES['US100-USD'] }, quotes: q, vstate: {}, now: T0, rng: rng0, limits: LIM });
  assert.equal(r3.actions[0].market, 'US500-USD');
});

test('limits: per-trade cap shrinks or blocks; weekly cap halts for the week; daily stop; margin; liquidation; guard pause', () => {
  // 10x and a 1.5 % stop: $240 notional would lose > $3 -> shrunk to fit
  const big = V.decideVolume({ vc: VC({ QFEX_LEVERAGE: '10', QFEX_VOL_SL_PCT: '0.015', QFEX_VOL_MARKETS: 'US100' }), st: ST(), refs: REFS, fees: FEES, quotes: QUOTES, vstate: {}, now: T0, rng: rng0, limits: LIM });
  assert.ok(big.actions[0].risk.worstLoss <= 3, JSON.stringify(big.actions[0].risk));
  // weekly cap reached -> halt (alerted once) + resting entry cancelled + nothing new, until next Monday
  const vs = { markets: { 'US100-USD': { phase: 'entry', requotes: [] } } };
  const h = decide({ st: ST({ weeklyLoss: 30.5, orders: [entryRow()] }), vstate: vs });
  assert.equal(h.actions[0].kind, 'halt'); assert.match(h.actions[0].reason, /weekly/);
  assert.ok(h.actions.some((x) => x.kind === 'cancel' && x.id === 'e1'));
  assert.ok(!h.actions.some((x) => x.kind === 'enter'));
  assert.equal(new Date(vs.halted.until).getUTCDay(), 1);
  const later = decide({ st: ST({ weeklyLoss: 0 }), vstate: vs, now: T0 + 3600e3 });
  assert.ok(!later.actions.some((x) => x.kind === 'enter' || x.kind === 'halt'));
  // daily stop at 40 % of the weekly cap
  const d = decide({ st: ST({ dailyLoss: 12.1 }) }); assert.match(d.actions[0].reason, /daily/);
  // budget left smaller than one trade -> no entry
  const nb = decide({ st: ST({ weeklyLoss: 29.99 }) }); assert.ok(!nb.actions.some((x) => x.kind === 'enter'));
  // free collateral too small for the margin
  const nm = decide({ st: ST({ free: 5 }), vc: VC({ QFEX_VOL_NOTIONAL_USD: '150', QFEX_VOL_MARKETS: 'US100' }) });
  assert.ok(nm.notes.some((n) => /free collateral/.test(n)));
  // liquidation distance too close (huge foreign exposure on cross margin)
  const liq = decide({ st: ST({ positions: [{ market: 'GOLD-USD', side: 'long', size: 2, entry: 4100, mark: 4100 }] }), vc: VC({ QFEX_VOL_MARKETS: 'US100' }) });
  assert.ok(liq.notes.some((n) => /liquidation distance/.test(n)), liq.notes.join('|'));
  // guard not healthy / kill -> no new exposure, resting entries cancelled
  const p = decide({ canEnter: false, st: ST({ orders: [entryRow()] }), vstate: { markets: { 'US100-USD': { phase: 'entry' } } } });
  assert.deepEqual(p.actions.map((x) => x.kind), ['cancel']);
});

test('foreign positions (e.g. the GOLD test trade) are never touched and their market is never entered', () => {
  const gold = { market: 'GOLD-USD', side: 'long', size: 0.001, entry: 4141.2, mark: 4150 };
  const refs = { ...REFS, 'GOLD-USD': { ...REF, symbol: 'GOLD-USD', product_category: 'COMMODITY', tick_size: '0.1', min_quantity: '0.001', lot_size: '0.0001', default_max_leverage: 20 } };
  const orders = [{ id: 's1', market: 'GOLD-USD', kind: 'SL', stop: true, raw: { client_order_id: 'b-live-test-qfex-gold-2-x-stop-loss' } }];
  const r = V.decideVolume({ vc: VC({ QFEX_VOL_MARKETS: 'GOLD' }), st: ST({ positions: [gold], orders }), refs, fees: { 'GOLD-USD': FEES['US100-USD'] }, quotes: { 'GOLD-USD': { mark: 4150, bid: 4149.9, ask: 4150.1 } }, vstate: {}, now: T0, rng: rng0, limits: LIM });
  assert.deepEqual(r.actions, []);
});

test('stale entry re-quoted (rate-limited); fill -> maker reduce-only exit; partial fill -> cancel rest first; flat -> round trip, cooldown, orphan stops/exits removed', () => {
  const vs = { markets: { 'US100-USD': { phase: 'entry', requotes: [] } } };
  const q = { ...QUOTES, 'US100-USD': { mark: 25030, bid: 25029, ask: 25031 } }; // moved 0.12 % away
  const vc = VC({ QFEX_VOL_MARKETS: 'US100', QFEX_VOL_REQUOTES_PER_MIN: '2' });
  for (let i = 0; i < 2; i++) assert.equal(V.decideVolume({ vc, st: ST({ orders: [entryRow()] }), refs: REFS, fees: FEES, quotes: q, vstate: vs, now: T0 + i, rng: rng0, limits: LIM }).actions[0].kind, 'cancel');
  const third = V.decideVolume({ vc, st: ST({ orders: [entryRow()] }), refs: REFS, fees: FEES, quotes: q, vstate: vs, now: T0 + 2, rng: rng0, limits: LIM });
  assert.equal(third.actions.length, 0); assert.ok(third.notes.some((n) => /budget/.test(n)));
  // cancelled entry gone -> immediately eligible again (re-quote)
  const rq = V.decideVolume({ vc, st: ST(), refs: REFS, fees: FEES, quotes: q, vstate: vs, now: T0 + 3, rng: rng0, limits: LIM });
  assert.equal(rq.actions[0].kind, 'enter');
  // filled: position long 0.004 @ 24999 with SL+TP -> exit SELL reduce-only at +0.10 %
  const v2 = { markets: { 'US100-USD': { phase: 'entry', requotes: [] } } };
  const pos = { market: 'US100-USD', side: 'long', size: 0.004, entry: 24999, mark: 25000 };
  const stops = [{ id: 'sl', market: 'US100-USD', kind: 'SL', stop: true, raw: { client_order_id: 'b-vol-abc-stop-loss' } }, { id: 'tp', market: 'US100-USD', kind: 'TP', stop: true, raw: { client_order_id: 'b-vol-abc-take-profit' } }];
  const ex = V.decideVolume({ vc, st: ST({ positions: [pos], orders: stops }), refs: REFS, fees: FEES, quotes: QUOTES, vstate: v2, now: T0, rng: rng0, limits: LIM });
  assert.deepEqual(ex.actions.map((x) => [x.kind, x.side, x.qty, x.px]), [['exit', 'long', 0.004, 25024]]);
  assert.ok(!ex.actions.some((x) => x.kind === 'cancelStop')); // protective stops are never cancelled
  // partial fill: entry still resting -> cancel it, no exit in the same tick
  const pf = V.decideVolume({ vc, st: ST({ positions: [pos], orders: [...stops, entryRow({ size: 0.001 })] }), refs: REFS, fees: FEES, quotes: QUOTES, vstate: v2, now: T0 + 1, rng: rng0, limits: LIM });
  assert.deepEqual(pf.actions.map((x) => x.kind), ['cancel']);
  // exit filled -> flat; leftover orphan stops + nothing else -> cancelStop, round trip counted, cooldown set
  const fl = V.decideVolume({ vc, st: ST({ orders: stops }), refs: REFS, fees: FEES, quotes: QUOTES, vstate: v2, now: T0 + 60e3, rng: rng0, limits: LIM });
  assert.deepEqual(fl.actions.map((x) => x.kind), ['cancelStop', 'cancelStop']);
  assert.equal(v2.stats.roundTrips, 1); assert.ok(v2.markets['US100-USD'].cooldownUntil > T0 + 60e3);
  // after the cooldown: new entry on the other side
  const nx = V.decideVolume({ vc, st: ST(), refs: REFS, fees: FEES, quotes: QUOTES, vstate: { markets: { 'US100-USD': { ...v2.markets['US100-USD'], lastSide: 'long' } } }, now: T0 + 200e3, rng: () => 0.1, limits: LIM });
  assert.equal(nx.actions[0].side, 'short'); assert.equal(nx.actions[0].px, 25001);
  // a stale exit on a flat market is cancelled
  const se = V.decideVolume({ vc, st: ST({ orders: [{ id: 'x1', market: 'US100-USD', kind: 'LIMIT', side: 'SELL', px: 25024, reduceOnly: true, raw: { client_order_id: 'b-vx-1' } }] }), refs: REFS, fees: FEES, quotes: QUOTES, vstate: {}, now: T0, rng: rng0, limits: LIM });
  assert.equal(se.actions[0].kind, 'cancel');
  // held too long -> exit re-quoted at the touch
  const v3 = { markets: { 'US100-USD': { phase: 'pos', filledAt: T0 - 2 * 3600e3, requotes: [] } } };
  const ho = V.decideVolume({ vc, st: ST({ positions: [pos], orders: [...stops, { id: 'x1', market: 'US100-USD', kind: 'LIMIT', side: 'SELL', px: 25024, reduceOnly: true, raw: { client_order_id: 'b-vx-1' } }] }), refs: REFS, fees: FEES, quotes: QUOTES, vstate: v3, now: T0, rng: rng0, limits: LIM });
  assert.match(ho.actions[0].why, /held too long/);
});

function setupNet(stateOver = {}) {
  const cfg = C.loadConfig({ AUTOTRADER_NETWORK: 'testnet', QFEX_API_PUBLIC_KEY: 'pk_' + randHex(8), QFEX_API_SECRET_KEY: randHex(24), QFEX_ACCOUNT_ID: ACCT, QFEX_KEY_SINGLE_ACCOUNT_ACK: '1',
    QFEX_VOLUME_MODE: '1', QFEX_LEVERAGE: '5', QFEX_VOL_MARKETS: 'US100' });
  const state = { mark: 25000, bid: 24999, ask: 25001, positions: [], stops: [], orders: [], balance: { available_balance: '100', deposit: '100', realised_pnl: '0', unrealised_pnl: '0', net_funding: '0' }, equitySeries: [100], ...stateOver };
  const log = [], rest = [], realFetch = globalThis.fetch; globalThis.fetch = fakeFetch(state, rest);
  const net = { now: () => T0, retryMs: 1, qfex: Q.makeNet(cfg.bases.qfex, cfg.qfex, { WS: fakeWsClass(state, log), stopsMs: 20 }) };
  const io = { live: true, kill: null, guardOk: true, logs: [], alerts: [], journals: [], accountState: C.accountState, rng: rng0 };
  io.log = (l, m) => io.logs.push(l + ' ' + m); io.alert = (a) => io.alerts.push(a); io.journal = (j) => io.journals.push(j);
  V._resetCache();
  return { cfg, net, state, log, rest, io, restore: () => { globalThis.fetch = realFetch; } };
}
const sentOrders = (log) => log.filter((x) => x.m && ['add_order', 'cancel_order', 'cancel_stop_order', 'close_position'].includes(x.m.type)).map((x) => x.m);

test('executor: dry run and kill switch send nothing; disabled mode does nothing', async () => {
  const s = setupNet();
  try {
    const off = await V.volumeTick({ ...s.cfg, qfexVol: { ...s.cfg.qfexVol, enabled: false } }, s.net, {}, s.io);
    assert.deepEqual(off, { enabled: false });
    const dry = await V.volumeTick(s.cfg, s.net, {}, { ...s.io, live: false });
    assert.equal(dry.actions[0].kind, 'enter'); assert.equal(dry.actions[0].sent, false);
    const kill = await V.volumeTick(s.cfg, s.net, {}, { ...s.io, kill: 'STOP file present' });
    assert.ok(!kill.actions.some((x) => x.kind === 'enter'));
    assert.deepEqual(sentOrders(s.log), []); assert.ok(!s.rest.some((r) => r.method === 'POST'));
  } finally { s.restore(); }
});

test('executor live (mock): leverage set to 5x and read back, then the ALO entry with SL + TP; exit is ALO reduce-only', async () => {
  const s = setupNet({ levNow: 1 });
  try {
    const vs = {};
    const r = await V.volumeTick(s.cfg, s.net, vs, s.io);
    assert.equal(r.actions[0].ok, true, JSON.stringify(r.actions));
    const lev = s.rest.find((x) => x.method === 'POST' && x.path === '/user/leverage'); assert.deepEqual(JSON.parse(lev.body), { symbol: 'US100-USD', leverage: 5 });
    const [e] = sentOrders(s.log);
    assert.equal(e.params.order_type, 'ALO'); assert.ok(e.params.stop_loss > 0 && e.params.take_profit > 0); assert.match(e.params.client_order_id, /^b-vol-/);
    assert.equal(vs.markets['US100-USD'].phase, 'entry');
    assert.equal(s.io.journals[0].decision, 'placed'); assert.equal(s.io.journals[0].plan.sl, e.params.stop_loss); // the guard can re-attach from the plan
    // fill
    s.state.positions = [{ symbol: 'US100-USD', position: e.params.quantity, average_price: e.params.price, unrealised_pnl: 0, leverage: 5 }];
    s.state.stops = [{ stop_order_id: 'st1', symbol: 'US100-USD', price: e.params.stop_loss, quantity: e.params.quantity, direction: 'SELL', stop_order_type: 'STOPLOSS', client_order_id: e.params.client_order_id + '-stop-loss' }];
    const r2 = await V.volumeTick(s.cfg, s.net, vs, s.io);
    const x = sentOrders(s.log).pop();
    assert.equal(r2.actions[0].kind, 'exit'); assert.equal(r2.actions[0].ok, true, JSON.stringify(r2.actions));
    assert.deepEqual([x.params.order_type, x.params.reduce_only, x.params.side, x.params.stop_loss], ['ALO', true, 'SELL', 0]);
    assert.ok(!sentOrders(s.log).some((m) => m.type === 'cancel_stop_order'));
  } finally { s.restore(); }
});

test('executor live (mock): leverage that does not read back blocks the entry (alert, market paused)', async () => {
  const s = setupNet({ levNow: 1, levStuck: 1 });
  try {
    const vs = {};
    const r = await V.volumeTick(s.cfg, s.net, vs, s.io);
    assert.equal(r.actions[0].ok, false); assert.match(r.actions[0].error, /leverage on US100-USD is 1x, not 5x/);
    assert.deepEqual(sentOrders(s.log), []);
    assert.equal(s.io.alerts[0].kind, 'volume-entry-failed'); assert.ok(vs.markets['US100-USD'].blockedUntil > T0);
  } finally { s.restore(); }
});

test('executor live (mock): orphan stops of this mode on a flat market are cancelled; foreign stops are not', async () => {
  const s = setupNet({ levNow: 5, stops: [
    { stop_order_id: 'orph', symbol: 'US100-USD', price: 24900, quantity: 0.004, direction: 'SELL', stop_order_type: 'STOPLOSS', client_order_id: 'b-vol-abc-stop-loss' },
    { stop_order_id: 'gold', symbol: 'GOLD-USD', price: 4124.7, quantity: 0.001, direction: 'SELL', stop_order_type: 'STOPLOSS', client_order_id: 'b-live-test-qfex-gold-2-x-stop-loss' }] });
  try {
    const vs = { markets: { 'US100-USD': { phase: 'pos', requotes: [] } } };
    const r = await V.volumeTick(s.cfg, s.net, vs, s.io);
    assert.deepEqual(r.actions.map((a) => [a.kind, a.id, a.ok]), [['cancelStop', 'orph', true]]);
    assert.deepEqual(s.state.stopCancels, ['orph']);
    assert.equal(vs.stats.roundTrips, 1);
  } finally { s.restore(); }
});

test('an exit that just vanished (filled while the position feed lags) is not re-placed for 45 s', () => {
  const vs = { markets: { 'US100-USD': { phase: 'pos', filledAt: T0 - 60e3, exitAt: T0 - 10e3, requotes: [] } } };
  const pos = { market: 'US100-USD', side: 'long', size: 0.004, entry: 24999, mark: 25000 };
  const r = V.decideVolume({ vc: VC({ QFEX_VOL_MARKETS: 'US100' }), st: ST({ positions: [pos] }), refs: REFS, fees: FEES, quotes: QUOTES, vstate: vs, now: T0, rng: rng0, limits: LIM });
  assert.deepEqual(r.actions, []); assert.ok(r.notes.some((n) => /waiting for the position feed/.test(n)));
  const r2 = V.decideVolume({ vc: VC({ QFEX_VOL_MARKETS: 'US100' }), st: ST({ positions: [pos] }), refs: REFS, fees: FEES, quotes: QUOTES, vstate: vs, now: T0 + 40e3, rng: rng0, limits: LIM });
  assert.equal(r2.actions[0].kind, 'exit');
});

test('volume stats: day / week / month volume, fees and PnL; goal progress', () => {
  const f = (t, px, sz, fee, pnl = 0) => ({ time: t, px, sz, fee, closedPnl: pnl });
  const v = C.volumeStats([f(T0 - 40 * 86400e3, 100, 1, 1), f(Date.UTC(2026, 9, 2), 100, 10, 0.2), f(Date.UTC(2026, 9, 19, 9), 25000, 0.004, 0.02, 0.1), f(T0 - 3600e3, 98, 1, 0)], T0);
  assert.deepEqual([v.day.volume, v.week.volume, v.month.volume], [98, 198, 1198]);
  assert.equal(v.week.fees, 0.02); assert.equal(v.week.pnl, 0.08);
  assert.equal(v.monthPct, +(100 * 1198 / 300000).toFixed(2));
});
