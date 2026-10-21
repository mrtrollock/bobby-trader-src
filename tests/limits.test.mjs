// Loss caps: weekly (Mon 00:00 UTC) + daily (00:00 UTC, default 40% of weekly) per platform, enforced for new entries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from '../autotrader/core.js';
import { randHex } from './helpers.mjs';

const FX = (f) => JSON.parse(readFileSync(new URL('./fixtures/' + f, import.meta.url)));
const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const OWNER = '0x' + '11'.repeat(20), MASTER = '0x' + '22'.repeat(20), SUB = '0x' + '55'.repeat(20);
const ARCUS_KEY = randHex(32), HL_KEY = '0x' + randHex(32);
const ENV = { AUTOTRADER_NETWORK: 'testnet', AUTOTRADER_ARCUS: '1', ARCUS_API_PRIVATE_KEY: ARCUS_KEY, ARCUS_ACCOUNT_ADDRESS: OWNER, ARCUS_ACCOUNT_INDEX: '0',
  HL_AGENT_PRIVATE_KEY: HL_KEY, HL_ACCOUNT_ADDRESS: MASTER, HL_SUBACCOUNT_ADDRESS: SUB };
// legacy fixtures: TSLA-USD and A/B/C-USD are Bobby-owned Arcus markets (the ownership tests below use their own cfg)
const OWN = () => Object.fromEntries(['TSLA-USD', 'A-USD', 'B-USD', 'C-USD'].map((m) => [m, { t: NOW }]));
const verified = (c) => { if (c.hl) c.hl.subVerified = true; return c; };
const cfgOf = (extra = {}) => verified(Object.assign(C.loadConfig({ ...ENV, ...extra }), { arcusOwn: OWN() }));

// deep two-sided book around mid (5 levels/side, 1 bp apart, $100k each)
const BOOK = (mid, sz = 100000 / mid, step = 0.0001) => ({ bids: [1, 2, 3, 4, 5].map((i) => [String(+(mid * (1 - i * step)).toFixed(4)), String(sz)]), asks: [1, 2, 3, 4, 5].map((i) => [String(+(mid * (1 + i * step)).toFixed(4)), String(sz)]) });
function mockNet(cfg, o = {}) {
  const s = { equity: 300, free: 300, positions: [], orders: [], fills: [], hlEquity: 300, hlFree: 300, hlPositions: [], hlOrders: [], hlFills: [],
    keys: [{ apiKey: cfg.arcus ? cfg.arcus.apiKey : 'x', status: 'ACTIVE', validUntil: NOW + 30 * 86400e3, accountIndex: 0 }],
    role: { role: 'agent', data: { user: MASTER } }, subRole: { role: 'subAccount', data: { master: MASTER } }, subs: [{ name: 'Bobby', subAccountUser: SUB }], ...o };
  const sent = [];
  const net = {
    sent, s, now: () => NOW, arcusClockOffsetMs: async () => 0,
    arcusGet: async (path) => {
      if (path === '/v1/apiKeys') return { apiKeys: s.keys };
      if (path === '/v1/account') return { equity: String(s.equity), freeCollateral: String(s.free) };
      if (path === '/v1/positions') return { positions: s.positions };
      if (path === '/v1/openOrders') return { orders: s.orders };
      if (path === '/v1/fills') return { fills: s.fills };
      if (path === '/v1/markets') return { markets: [FX('arcus_market_tsla.json')] };
      if (path === '/v1/account/stats') return {};
      if (path.startsWith('/v1/l2OrderBook/')) return s.arcusBook || BOOK(400);
      throw new Error('unmocked ' + path);
    },
    hlInfo: async (b) => {
      if (b.type === 'userRole') return String(b.user).toLowerCase() === SUB ? s.subRole : s.role;
      if (b.type === 'subAccounts') { assert.equal(b.user, MASTER); return s.subs; }
      if (b.type === 'clearinghouseState') return { marginSummary: { accountValue: String(s.hlEquity) }, withdrawable: String(s.hlFree), assetPositions: s.hlPositions };
      if (b.type === 'frontendOpenOrders') return s.hlOrders;
      if (b.type === 'userFillsByTime') return s.hlFills;
      if (b.type === 'metaAndAssetCtxs') return FX('hl_io_meta.json');
      if (b.type === 'perpDexs') return FX('hl_perpdexs.json');
      if (b.type === 'l2Book') { const k = s.hlBook || BOOK(380); return { levels: [k.bids.map(([px, sz]) => ({ px, sz, n: 1 })), k.asks.map(([px, sz]) => ({ px, sz, n: 1 }))] }; }
      throw new Error('unmocked ' + b.type);
    },
    sendArcus: async (d) => { sent.push({ pf: 'arcus', d }); return { ok: true, status: 200, body: { responses: [{ status: 'OK' }] } }; },
    sendHl: async (d) => { sent.push({ pf: 'hl', d }); return { ok: true, status: 200, body: { status: 'ok', response: { data: { statuses: [{ resting: { oid: 1 } }] } } } }; },
  };
  return net;
}
const exp = NOW / 1000 + 3600;
const AR = { id: 'a1', platform: 'arcus', market: 'TSLA-USD', side: 'long', type: 'limit', price: 398, size: 0.1, leverage: 1, stopLoss: 371, takeProfit: 420, expiry: exp, refPrice: 400, rationale: 'test' };
const EN = { id: 'e1', pf: 'entropy', m: 'io:ANTH', sd: 'short', et: 'limit', px: 382, sz: 0.1, lev: 1, sl: 405, tp: 360, exp, ref: 380 };


const BOBBY = 'bby-0000000000000000-e';
test('lossCaps: defaults (Arcus/Entropy $50/week, $20/day = 40%; QFEX $30/week, $12/day, $3/trade; TxFlow/Variational manual reference)', () => {
  const c = C.lossCaps({});
  assert.deepEqual([c.arcus.weekly, c.arcus.daily, c.arcus.maxTradePct, c.arcus.mode], [50, 20, 0.01, 'auto']);
  assert.deepEqual([c.entropy.weekly, c.entropy.daily, c.entropy.capital], [50, 20, 300]);
  assert.deepEqual([c.qfex.weekly, c.qfex.daily, c.qfex.maxTradeUsd, c.qfex.maxLossEquityPct], [30, 12, 3, 0.05]);
  assert.deepEqual([c.txflow.weekly, c.txflow.daily, c.txflow.mode, c.variational.weekly, c.variational.mode], [50, null, 'manual', 50, 'manual']);
  const o = C.lossCaps({ AUTOTRADER_DAILY_LOSS_FRAC: '0.3', HL_DAILY_LOSS_CAP_USD: '10', QFEX_WEEKLY_LOSS_CAP_USD: '30', QFEX_VOL_DAILY_LOSS_FRAC: '0.5' });
  assert.deepEqual([o.arcus.daily, o.entropy.daily, o.qfex.daily], [15, 10, 15]);
  assert.match(o.entropy.dailyRule, /HL_DAILY_LOSS_CAP_USD/); assert.match(o.arcus.dailyRule, /30% of the weekly cap/);
  assert.throws(() => C.lossCaps({ ARCUS_DAILY_LOSS_CAP_USD: '60' }), /ARCUS_DAILY_LOSS_CAP_USD must be > 0 and <= the weekly cap/);
  assert.throws(() => C.lossCaps({ AUTOTRADER_DAILY_LOSS_FRAC: '0' }), /AUTOTRADER_DAILY_LOSS_FRAC/);
  assert.throws(() => cfgOf({ ARCUS_DAILY_LOSS_CAP_USD: '-1' }), /ARCUS_DAILY_LOSS_CAP_USD/); // validated at startup
  assert.equal(cfgOf().caps.arcus.daily, 20);
});
test('limitsState: used / remaining / per-trade max / halted until (daily -> next 00:00 UTC, weekly -> Monday 00:00 UTC)', () => {
  const caps = C.lossCaps({});
  const ok = C.limitsState('arcus', caps, { weeklyLoss: 12.345, dailyLoss: 4, equity: 250 }, NOW);
  assert.deepEqual([ok.weeklyCap, ok.weeklyUsed, ok.weeklyRemaining, ok.dailyCap, ok.dailyUsed, ok.dailyRemaining, ok.maxTradeLoss, ok.halted], [50, 12.35, 37.66, 20, 4, 16, 2.5, null]);
  assert.equal(ok.weekFrom, Date.UTC(2026, 9, 19)); assert.equal(ok.dayFrom, Date.UTC(2026, 9, 21));
  const d = C.limitsState('entropy', caps, { weeklyLoss: 21, dailyLoss: 20.5, equity: 300 }, NOW);
  assert.deepEqual([d.halted.scope, d.halted.until, d.dailyRemaining, d.maxTradeLoss], ['daily', Date.UTC(2026, 9, 22), 0, 0]);
  const w = C.limitsState('entropy', caps, { weeklyLoss: 50, dailyLoss: 0, equity: 300 }, NOW);
  assert.deepEqual([w.halted.scope, w.halted.until], ['weekly', Date.UTC(2026, 9, 26)]);
  const q = C.limitsState('qfex', caps, { weeklyLoss: 0, dailyLoss: 0, equity: 40 }, NOW, { halted: { scope: 'daily', until: NOW + 60e3, reason: 'daily stop' } });
  assert.deepEqual([q.maxTradeLoss, q.halted.reason], [2, 'daily stop']); // min($3, 5% of $40)
  assert.equal(C.limitsState('entropy', caps, { equity: 0 }, NOW).maxTradeLoss, 0); // unfunded
  const m = C.limitsState('txflow', caps, { weeklyLoss: 7 }, NOW);
  assert.deepEqual([m.mode, m.dailyCap, m.dailyRemaining, m.weeklyRemaining], ['manual', null, null, 43]);
});
test('daily cap is enforced for new entries on Arcus (Bobby fills only) and Entropy', async () => {
  const cfg = cfgOf();
  const run = (q, o) => C.evaluate(q, cfg, mockNet(cfg, o));
  // Arcus: $19 lost today by Bobby -> a trade risking > $1 more is blocked; $20 -> blocked outright
  let r = await run(AR, { fills: [{ createdAt: NOW - 3600e3, closedPnl: '-19', fee: '0', clientId: BOBBY }] });
  assert.ok(r.reasons.some((x) => /could exceed the daily cap \(\$19\.00 \+ \$\d/.test(x)), JSON.stringify(r.reasons));
  r = await run(AR, { fills: [{ createdAt: NOW - 3600e3, closedPnl: '-20', fee: '0', clientId: BOBBY }] });
  assert.ok(r.reasons.some((x) => /daily loss cap reached \(\$20\.00 \/ \$20\), new entries resume 00:00 UTC/.test(x)), JSON.stringify(r.reasons));
  // yesterday's loss counts for the week, not for today
  r = await run(AR, { fills: [{ createdAt: Date.UTC(2026, 9, 20, 15), closedPnl: '-20', fee: '0', clientId: BOBBY }] });
  assert.ok(!r.reasons.some((x) => /daily/.test(x)), JSON.stringify(r.reasons));
  // another tool's losses on a non-Bobby market never count (Bobby-only attribution)
  r = await run(AR, { fills: [{ createdAt: NOW - 3600e3, closedPnl: '-30', fee: '0', clientId: 'other-tool-1', marketDisplayName: 'NVDA-USD' }] });
  assert.ok(!r.reasons.some((x) => /daily|weekly/.test(x)), JSON.stringify(r.reasons));
  // Entropy
  r = await run(EN, { hlFills: [{ coin: 'io:ANTH', time: NOW - 600e3, closedPnl: '-20', fee: '0.1', px: '380', sz: '0.1' }] });
  assert.ok(r.reasons.some((x) => /daily loss cap reached/.test(x)), JSON.stringify(r.reasons));
  r = await run(EN);
  assert.deepEqual(r.reasons, []);
});

import { spawnSync } from 'node:child_process';
import { cleanEnv } from './helpers.mjs';
import { statusText } from '../src/limits.js';
test('limits.py: caps from the autotrader, usage per platform, manual references, encrypted output (offline)', () => {
  const r = spawnSync('python3', [new URL('./py_limits.py', import.meta.url).pathname], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout.trim().split('\n').pop()).ok, true);
});
test('limits.js: status text in Berlin time', () => {
  assert.equal(statusText({ status: 'ok' }), '✅ OK');
  assert.match(statusText({ status: 'halted', haltScope: 'daily', haltedUntil: Date.UTC(2026, 9, 22) / 1000 }), /^⛔ Halted until Thu 22 Oct, 02:00 \(daily cap\)$/);
  assert.match(statusText({ status: 'halted', haltScope: 'weekly', haltedUntil: Date.UTC(2026, 9, 26) / 1000 }), /Mon 26 Oct, 01:00 \(weekly cap\)/); // CET after Oct 25
  assert.equal(statusText({ status: 'manual' }), '✋ Manual (reference cap)');
});
