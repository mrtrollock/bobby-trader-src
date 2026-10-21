// Entropy volume mode: pure decisions + one executor tick with a mocked Hyperliquid (subaccount vaultAddress, isolated
// Alo + SL + TP, STOP / dry run / unverified subaccount send nothing). Offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from '../autotrader/core.js';
import * as HV from '../autotrader/hlvolume.js';
import * as H from '../src/hl.js';
import { randHex } from './helpers.mjs';

const FX = (f) => JSON.parse(readFileSync(new URL('./fixtures/' + f, import.meta.url)));
const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const MASTER = '0x' + '22'.repeat(20), SUB = '0x' + '55'.repeat(20), HL_KEY = '0x' + randHex(32);
const ENV = { AUTOTRADER_NETWORK: 'mainnet', AUTOTRADER_ENABLED: '1', AUTOTRADER_LIVE: '1', HL_AGENT_PRIVATE_KEY: HL_KEY, HL_ACCOUNT_ADDRESS: MASTER, HL_SUBACCOUNT_ADDRESS: SUB, AUTOTRADER_ENTROPY_VOLUME: '1' };
const VC = HV.loadHlVolumeConfig(ENV);
const MK = { 'io:OAI': { asset: 110000, szDecimals: 3, maxLev: 6 }, 'io:ANTH': { asset: 110001, szDecimals: 3, maxLev: 6 }, 'io:TCNT': { asset: 110002, szDecimals: 2, maxLev: 5 } };
const Qt = (mid, spr = 0.0004, depthUsd = 50000, trades = 100) => ({ bid: +(mid * (1 - spr / 2)).toFixed(3), ask: +(mid * (1 + spr / 2)).toFixed(3), mark: mid, depthUsd, trades });
const QUOTES = { 'io:OAI': Qt(380), 'io:ANTH': Qt(380), 'io:TCNT': Qt(50) };
const LIM = { perTrade: 3, weeklyCap: 50, dailyCap: 20 };
const ST = (o = {}) => ({ equity: 300, free: 300, positions: [], orders: [], weeklyLoss: 0, dailyLoss: 0, ...o });
const seq = (...xs) => { let i = 0; return () => xs[i++ % xs.length]; };
const ent = (market, side, px, size, id = '1') => ({ id, market, side, kind: 'LIMIT', px, size, reduceOnly: false, raw: { cloid: HV.CID_ENTRY + 'a'.repeat(24) } });
const exitO = (market, side, px, size, id = '2') => ({ id, market, side, kind: 'LIMIT', px, size, reduceOnly: true, raw: { cloid: HV.CID_EXIT + 'b'.repeat(24) } });
const trig = (market, kind, trigPx, id) => ({ id, market, side: 'SELL', kind, px: null, trig: trigPx, size: 1, reduceOnly: true, raw: {} });

test('config: switch, defaults (TP 0.1 % / SL 0.4 % / hold 30 min / 3x / 2 markets) and hard bounds', () => {
  assert.equal(HV.loadHlVolumeConfig({}).enabled, false);
  assert.deepEqual([VC.enabled, VC.tpPct, VC.slPct, VC.maxHoldS, VC.leverage, VC.maxMarkets, VC.markets], [true, 0.001, 0.004, 1800, 3, 2, 'picks']);
  for (const [k, v, re] of [['ENTROPY_VOL_LEVERAGE', '4', /1\.\.3/], ['ENTROPY_VOL_MAX_MARKETS', '3', /1\.\.2/], ['ENTROPY_VOL_MAX_HOLD_S', '120', /short hold/], ['HL_CAPITAL_USD', '500', /<= 300/]])
    assert.throws(() => HV.loadHlVolumeConfig({ ...ENV, [k]: v }), re);
  assert.ok(HV.tpPctFor(VC) >= 2 * VC.maker + VC.tpNetMinPct - 1e-12); // TP covers two maker fees + 0.04 %
  assert.equal(HV.tpPctFor({ ...VC, tpPct: 0.0005 }), 2 * VC.maker + VC.tpNetMinPct);
});

test('entries: low-OI pick order, post-only at the touch, isolated <= 3x, worst loss <= $3, max 2 markets, SL/TP attached', () => {
  const vs = {};
  const { actions } = HV.decideHlVolume({ vc: { ...VC, newPerTick: 2 }, st: ST(), mk: MK, quotes: QUOTES, pool: ['io:TCNT', 'io:OAI', 'io:ANTH'], vstate: vs, now: NOW, rng: seq(0.1, 0.2, 0.3, 0.4), limits: LIM });
  const en = actions.filter((a) => a.kind === 'enter'); assert.equal(en.length, 2);
  for (const a of en) {
    assert.ok(a.lev >= 1 && a.lev <= 3); assert.ok(a.risk.worstLoss <= 3, JSON.stringify(a.risk)); assert.ok(a.risk.notional >= 11);
    const q = QUOTES[a.market]; assert.equal(a.px, a.side === 'long' ? q.bid : q.ask);
    if (a.side === 'long') { assert.ok(a.sl < a.px && a.tp > a.px); } else { assert.ok(a.sl > a.px && a.tp < a.px); }
    assert.ok(Math.abs(Math.abs(a.sl - a.px) / a.px - 0.004) < 0.0005);
  }
  assert.equal(en[0].market, 'io:TCNT'); // lowest OI first
  // two markets busy -> no third entry even with slots per tick
  const st2 = ST({ orders: [ent('io:TCNT', 'BUY', QUOTES['io:TCNT'].bid, 1, '7'), ent('io:OAI', 'BUY', QUOTES['io:OAI'].bid, 1, '8')] });
  const r2 = HV.decideHlVolume({ vc: { ...VC, newPerTick: 2 }, st: st2, mk: MK, quotes: QUOTES, pool: ['io:TCNT', 'io:OAI', 'io:ANTH'], vstate: {}, now: NOW, rng: seq(0.5), limits: LIM });
  assert.equal(r2.actions.filter((a) => a.kind === 'enter').length, 0);
});

test('entries: spread / depth / budgets / free margin / no margin -> no entry; per-trade cap shrinks the size', () => {
  const run = (o) => HV.decideHlVolume({ vc: VC, st: ST(o.st), mk: MK, quotes: o.quotes || QUOTES, pool: o.pool || ['io:OAI'], vstate: {}, now: NOW, rng: seq(0.5), limits: { ...LIM, ...o.lim } });
  assert.equal(run({ quotes: { 'io:OAI': Qt(380, 0.003) } }).actions.length, 0);
  assert.equal(run({ st: { weeklyLoss: 49.95 } }).actions.filter((a) => a.kind === 'enter').length, 0);
  assert.equal(run({ st: { free: 1, equity: 1 } }).actions.length, 0);
  const small = run({ lim: { perTrade: 1 } }).actions[0]; assert.ok(small.risk.worstLoss <= 1);
  const thin = run({ quotes: { 'io:OAI': Qt(380, 0.0004, 400) } }).actions[0]; assert.ok(thin.risk.notional <= 400 * 0.25 * 1.16);
});

test('round trip: fill -> maker exit at +TP; duplicate-exit guard; held 30 min -> touch; flat -> cooldown + orphan SL/TP cancelled', () => {
  const vs = { markets: { 'io:OAI': { phase: 'entry', risk: 2, margin: 100, requotes: [] } } };
  const pos = { market: 'io:OAI', side: 'long', size: 0.9, entry: 380, mark: 380 };
  let r = HV.decideHlVolume({ vc: VC, st: ST({ positions: [pos], orders: [trig('io:OAI', 'SL', 378.48, '3'), trig('io:OAI', 'TP', 381.14, '4')] }), mk: MK, quotes: QUOTES, pool: [], vstate: vs, now: NOW, limits: LIM });
  const ex = r.actions.find((a) => a.kind === 'exit'); assert.ok(ex); assert.equal(ex.px, H.roundPx(380 * 1.001, 3)); assert.match(ex.why, /take-profit/);
  // exit vanished 10 s later while the position still shows: wait (no duplicate exit)
  r = HV.decideHlVolume({ vc: VC, st: ST({ positions: [pos] }), mk: MK, quotes: QUOTES, pool: [], vstate: vs, now: NOW + 10e3, limits: LIM });
  assert.equal(r.actions.length, 0); assert.ok(r.notes.some((n) => /waiting for the position feed/.test(n)));
  // held > 30 min with the exit resting far away -> cancelled for a re-quote at the touch
  r = HV.decideHlVolume({ vc: VC, st: ST({ positions: [pos], orders: [exitO('io:OAI', 'SELL', 380.38, 0.9)] }), mk: MK, quotes: { 'io:OAI': Qt(379) }, pool: [], vstate: vs, now: NOW + 1801e3, limits: LIM });
  assert.ok(r.actions.some((a) => a.kind === 'cancel' && /held too long/.test(a.why)));
  // flat: round trip counted, cooldown, leftover reduce-only triggers + exit cancelled, no immediate re-entry there
  r = HV.decideHlVolume({ vc: VC, st: ST({ orders: [trig('io:OAI', 'SL', 378.48, '3'), exitO('io:OAI', 'SELL', 380.38, 0.9, '5')] }), mk: MK, quotes: QUOTES, pool: ['io:OAI'], vstate: vs, now: NOW + 1900e3, rng: seq(0.5), limits: LIM });
  assert.equal(vs.stats.roundTrips, 1);
  assert.deepEqual(r.actions.filter((a) => a.kind === 'cancel').map((a) => a.id).sort(), ['3', '5']);
  assert.equal(r.actions.filter((a) => a.kind === 'enter').length, 0);
});

test('halts at $20/day and $50/week; paused (STOP_VOLUME/STOP_ENTROPY/guard) cancels resting entries, never new ones', () => {
  const vs = {};
  let r = HV.decideHlVolume({ vc: VC, st: ST({ dailyLoss: 20 }), mk: MK, quotes: QUOTES, pool: ['io:OAI'], vstate: vs, now: NOW, limits: LIM });
  assert.equal(r.actions[0].kind, 'halt'); assert.equal(vs.halted.scope, 'daily'); assert.equal(r.actions.filter((a) => a.kind === 'enter').length, 0);
  const vw = {}; r = HV.decideHlVolume({ vc: VC, st: ST({ weeklyLoss: 50 }), mk: MK, quotes: QUOTES, pool: ['io:OAI'], vstate: vw, now: NOW, limits: LIM }); assert.equal(vw.halted.scope, 'weekly');
  const vp = { markets: { 'io:OAI': { phase: 'entry', requotes: [] } } };
  r = HV.decideHlVolume({ vc: VC, st: ST({ orders: [ent('io:OAI', 'BUY', QUOTES['io:OAI'].bid, 0.9, '9')] }), mk: MK, quotes: QUOTES, pool: ['io:OAI', 'io:ANTH'], vstate: vp, now: NOW, canEnter: false, limits: LIM });
  assert.deepEqual(r.actions.map((a) => [a.kind, a.id]), [['cancel', '9']]);
});

test('a position not opened by volume mode is left alone and its market is skipped', () => {
  const st = ST({ positions: [{ market: 'io:OAI', side: 'short', size: 1, entry: 380, mark: 380 }] });
  const r = HV.decideHlVolume({ vc: VC, st, mk: MK, quotes: QUOTES, pool: ['io:OAI'], vstate: { markets: { 'io:OAI': { phase: 'idle', requotes: [] } } }, now: NOW, rng: seq(0.5), limits: LIM });
  assert.equal(r.actions.length, 0); assert.ok(r.notes.some((n) => /left alone/.test(n)));
});

function mockNet() {
  const sent = [];
  return { sent, now: () => NOW,
    hlInfo: async (b) => {
      if (b.type === 'perpDexs') return FX('hl_perpdexs.json');
      if (b.type === 'metaAndAssetCtxs') { assert.equal(b.dex, 'io'); return FX('hl_io_meta.json'); }
      if (b.type === 'l2Book') return { levels: [[{ px: '379.9', sz: '50', n: 1 }], [{ px: '380.1', sz: '50', n: 1 }]] };
      if (b.type === 'candleSnapshot') { const t0 = b.req.startTime; return Array.from({ length: 15 }, (_, i) => ({ t: t0 + i * 60e3, n: b.req.coin === 'io:ANTH' ? 0 : 3 })); }
      throw new Error('unmocked ' + b.type);
    },
    picks: async () => ({ platforms: { entropy: { picks: [{ market: 'io:ANTH', depthUsd: 40000 }, { market: 'io:OAI', depthUsd: 40000 }] } } }),
    sendHl: async (d) => { sent.push(d); return { ok: true, status: 200, body: { status: 'ok', response: { data: { statuses: [{ resting: { oid: 11 } }] } } } }; } };
}
const cfgOf = () => { const c = C.loadConfig(ENV); c.hl.subVerified = true; c.hlVol = HV.loadHlVolumeConfig(ENV); return c; };
const IO = (o = {}) => ({ live: true, kill: null, log: () => {}, journal: () => {}, alert: () => {}, env: ENV, rng: seq(0.3), accountState: async () => ST(), ...o });

test('executor: isolated leverage + Alo entry with SL/TP, signed with vaultAddress = the subaccount, Bobby cloid', async () => {
  HV._resetCache(); const net = mockNet(); const jr = [];
  const rep = await HV.hlVolumeTick(cfgOf(), net, {}, IO({ journal: (e) => jr.push(e) }));
  assert.equal(rep.actions.filter((a) => a.kind === 'enter' && a.ok).length, 1);
  assert.equal(net.sent.length, 2);
  const [lev, ord] = net.sent.map((d) => JSON.parse(d.body));
  for (const b of [lev, ord]) assert.equal(b.vaultAddress, SUB);
  assert.deepEqual([lev.action.type, lev.action.isCross, lev.action.leverage <= 3], ['updateLeverage', false, true]);
  assert.equal(ord.action.grouping, 'normalTpsl'); assert.equal(ord.action.orders.length, 3);
  assert.equal(ord.action.orders[0].t.limit.tif, 'Alo'); assert.ok(ord.action.orders[0].c.startsWith(HV.CID_ENTRY));
  assert.deepEqual(ord.action.orders.slice(1).map((w) => [w.r, w.t.trigger.tpsl]).sort(), [[true, 'sl'], [true, 'tp']]);
  assert.equal(jr[0].plan.pf, 'entropy'); assert.ok(jr[0].plan.sl && jr[0].plan.tp); // the guard knows the planned SL/TP
});

test('executor: STOP file (kill), dry run, unverified subaccount or switch off -> nothing is sent', async () => {
  for (const [cfgMod, io] of [[(c) => c, { kill: 'STOP file' }], [(c) => c, { live: false }], [(c) => { c.hl.subVerified = false; return c; }, {}], [(c) => { c.hlVol.enabled = false; return c; }, {}]]) {
    HV._resetCache(); const net = mockNet();
    await HV.hlVolumeTick(cfgMod(cfgOf()), net, {}, IO(io));
    assert.equal(net.sent.length, 0);
  }
});

test('daily action budget (unified accounts: 50k/day): >= 80 % no new entries, >= 100 % nothing; executor counts sent actions', async () => {
  const day = HV.dayKey(NOW);
  let r = HV.decideHlVolume({ vc: VC, st: ST(), mk: MK, quotes: QUOTES, pool: ['io:OAI'], vstate: { actions: { day, n: 4000 } }, now: NOW, rng: seq(0.5), limits: LIM });
  assert.equal(r.actions.filter((a) => a.kind === 'enter').length, 0); assert.ok(r.notes.some((n) => /4000\/5000/.test(n)));
  const pos = { market: 'io:OAI', side: 'long', size: 0.9, entry: 380, mark: 380 };
  r = HV.decideHlVolume({ vc: VC, st: ST({ positions: [pos] }), mk: MK, quotes: QUOTES, pool: [], vstate: { actions: { day, n: 4500 }, markets: { 'io:OAI': { phase: 'pos', filledAt: NOW, requotes: [] } } }, now: NOW, limits: LIM });
  assert.ok(r.actions.some((a) => a.kind === 'exit')); // exits still managed between 80 % and 100 %
  r = HV.decideHlVolume({ vc: VC, st: ST({ positions: [pos] }), mk: MK, quotes: QUOTES, pool: [], vstate: { actions: { day, n: 5000 }, markets: { 'io:OAI': { phase: 'pos', filledAt: NOW, requotes: [] } } }, now: NOW, limits: LIM });
  assert.equal(r.actions.length, 0);
  assert.equal(HV.actionsToday({ actions: { day: '2026-10-20', n: 4999 } }, NOW), 0); // new UTC day resets
  HV._resetCache(); const net = mockNet(); const vs = {};
  await HV.hlVolumeTick(cfgOf(), net, vs, IO()); assert.equal(HV.actionsToday(vs, NOW), net.sent.length); assert.ok(net.sent.length > 0);
  assert.throws(() => HV.loadHlVolumeConfig({ ...ENV, ENTROPY_VOL_MAX_ACTIONS_PER_DAY: '60000' }), /50k/);
});

test('max rest: an unfilled entry is cancelled after ENTROPY_VOL_ENTRY_MAX_REST_S, its SL/TP only on a later flat tick, then the market rests and another is picked', () => {
  assert.equal(VC.entryMaxRestS, 600); assert.equal(VC.minTrades, 20);
  const px = QUOTES['io:OAI'].ask, e = ent('io:OAI', 'SELL', px, 1, '9'), sl = trig('io:OAI', 'SL', px * 1.004, '10'), tp = trig('io:OAI', 'TP', px * 0.997, '11');
  const vs = { markets: { 'io:OAI': { phase: 'entry', since: NOW - 300e3, requotes: [] } } };
  const run = (st, now, pool = ['io:OAI', 'io:TCNT']) => HV.decideHlVolume({ vc: VC, st: ST(st), mk: MK, quotes: QUOTES, pool, vstate: vs, now, rng: seq(0.5), limits: LIM });
  assert.equal(run({ orders: [e, sl, tp] }, NOW).actions.filter((a) => a.market === 'io:OAI').length, 0); // 5 min: keep resting
  let r = run({ orders: [e, sl, tp] }, NOW + 301e3);
  assert.deepEqual(r.actions.filter((a) => a.market === 'io:OAI').map((a) => [a.kind, a.id]), [['cancel', '9']]); // the entry only
  // the cancel raced a fill: position present -> its SL/TP are kept, the volume mode manages the position
  const vsFill = JSON.parse(JSON.stringify(vs));
  const rf = HV.decideHlVolume({ vc: VC, st: ST({ positions: [{ market: 'io:OAI', side: 'short', size: 1, entry: px, mark: px }], orders: [sl, tp] }), mk: MK, quotes: QUOTES, pool: [], vstate: vsFill, now: NOW + 362e3, rng: seq(0.5), limits: LIM });
  assert.ok(!rf.actions.some((a) => a.kind === 'cancel' && ['10', '11'].includes(a.id))); assert.ok(rf.actions.some((a) => a.kind === 'exit'));
  // next tick, flat and the entry gone: orphan SL/TP cancelled, OAI rests 15 min, TCNT picked instead
  r = run({ orders: [sl, tp] }, NOW + 362e3);
  assert.deepEqual(r.actions.filter((a) => a.kind === 'cancel').map((a) => a.id).sort(), ['10', '11']);
  assert.ok(vs.markets['io:OAI'].blockedUntil >= NOW + 362e3 + 900e3 - 1);
  r = run({}, NOW + 600e3); const en = r.actions.filter((a) => a.kind === 'enter'); assert.equal(en.length, 1); assert.equal(en[0].market, 'io:TCNT');
});

test('activity gate: too few recent trades (or unknown) -> no entry there; the executor reads 1m candles and counts its actions', async () => {
  const run = (trades) => HV.decideHlVolume({ vc: VC, st: ST(), mk: MK, quotes: { 'io:OAI': { ...Qt(380), trades } }, pool: ['io:OAI'], vstate: {}, now: NOW, rng: seq(0.5), limits: LIM });
  assert.equal(run(5).actions.length, 0); assert.ok(run(5).notes.some((n) => /too quiet/.test(n)));
  assert.equal(run(undefined).actions.length, 0);
  assert.equal(run(25).actions.filter((a) => a.kind === 'enter').length, 1);
  HV._resetCache(); const net = mockNet(), vs = {};
  const rep = await HV.hlVolumeTick(cfgOf(), net, vs, IO()); // ANTH has 0 trades -> OAI
  const en = rep.actions.filter((a) => a.kind === 'enter'); assert.equal(en.length, 1); assert.equal(en[0].market, 'io:OAI');
  assert.equal(HV.actionsToday(vs, NOW), net.sent.length);
});
