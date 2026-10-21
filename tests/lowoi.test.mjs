import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../src/lowoi.js';

const book = (mid, usd, spread = 0.0002, n = 10, step = 0.0002) => ({
  bids: Array.from({ length: n }, (_, i) => [mid * (1 - spread / 2 - i * step), usd / n / mid]),
  asks: Array.from({ length: n }, (_, i) => [mid * (1 + spread / 2 + i * step), usd / n / mid]) });
const row = (market, oiUsd, b, extra = {}) => ({ pf: 'arcus', market, status: 'ONLINE', oiUsd, vol24hUsd: 1e6, takerFee: 0.000225, ...b, ...extra });

test('assess: eligible only with tight spread, enough depth, OI/volume above minimum, worst-case stop loss <= cap', () => {
  const ok = L.assess(row('A', 50000, book(10, 100000)));
  assert.equal(ok.eligible, true, JSON.stringify(ok.reasons)); assert.ok(ok.worstLossUsd <= 3);
  assert.match(L.assess(row('B', 50000, book(10, 100000, 0.005))).reasons.join(), /spread/);
  assert.match(L.assess(row('C', 50000, book(10, 150))).reasons.join(), /depth|unfillable/);
  assert.match(L.assess(row('D', 5000, book(10, 100000))).reasons.join(), /OI/);
  assert.match(L.assess(row('E', 50000, book(10, 100000), { vol24hUsd: 10 })).reasons.join(), /volume/);
  assert.match(L.assess(row('F', 50000, { bids: [], asks: [] })).reasons.join(), /order book/);
  assert.match(L.assess(row('G', 50000, book(10, 100000), { status: 'OFFLINE' })).reasons.join(), /OFFLINE/);
  // book that is deep only 1.5 % away: stressed slippage blows the budget -> not eligible
  const far = { bids: [[9.999, 1], [9.85, 1e5]], asks: [[10.001, 1], [10.15, 1e5]] };
  const x = L.assess(row('H', 50000, far)); assert.equal(x.eligible, false); assert.match(x.reasons.join(), /slippage/);
});

test('rank: lowest OI first when preferLowOi, ineligible markets never ranked; env options', () => {
  const as = [row('BIG', 5e6, book(10, 1e5)), row('SMALL', 3e4, book(10, 1e5)), row('MID', 4e5, book(10, 1e5)), row('THIN', 2.5e4, book(10, 100, 0.01))].map((r) => L.assess(r));
  assert.deepEqual(L.rank(as, { preferLowOi: true }).map((x) => x.market), ['SMALL', 'MID', 'BIG']);
  assert.deepEqual(L.rank(as, { preferLowOi: false }).map((x) => x.market), ['BIG', 'MID', 'SMALL']);
  const o = L.optsFromEnv({ ARCUS_PREFER_LOW_OI: '0', ARCUS_LOWOI_MIN_OI_USD: '1000', LOWOI_MAX_SPREAD: '0.001' }, 'arcus');
  assert.equal(o.preferLowOi, false); assert.equal(o.minOiUsd, 1000); assert.equal(o.maxSpread, 0.001);
  assert.equal(L.optsFromEnv({}, 'entropy').preferLowOi, true);
});

test('stopSlippageFor: walks the exit side (long -> bids), Infinity when the book cannot absorb the size', () => {
  const b = { bids: [[99.9, 1], [99, 10]], asks: [[100.1, 1], [101, 10]] };
  assert.ok(L.stopSlippageFor(b.bids, b.asks, true, 50, 1) < 0.002);
  assert.ok(L.stopSlippageFor(b.bids, b.asks, true, 500, 1) > 0.005);
  assert.equal(L.stopSlippageFor(b.bids, b.asks, false, 1e6, 1), Infinity);
});

test('picks(): mocked public endpoints for Arcus, Entropy (io) and TxFlow; no keys, POST /info only reads', async () => {
  const seen = [];
  const res = (j) => ({ ok: true, status: 200, json: async () => j });
  const f = async (url, init) => {
    seen.push(url + ' ' + (init && init.body || ''));
    if (url.endsWith('/v1/markets')) return res({ markets: [
      { marketDisplayName: 'LOW-USD', status: 'ONLINE', markPrice: '10', openInterest: '3000', volume24hNotional: '500000', effectiveTakerFeePpm: 225 },
      { marketDisplayName: 'HIGH-USD', status: 'ONLINE', markPrice: '10', openInterest: '900000', volume24hNotional: '500000', effectiveTakerFeePpm: 225 },
      { marketDisplayName: 'OFF-USD', status: 'OFFLINE', markPrice: '10', openInterest: '0', volume24hNotional: '0' }] });
    if (url.includes('/v1/l2OrderBook/')) return res(book(10, 1e5));
    const body = init && JSON.parse(init.body); const lv = (b) => [b.bids.map(([px, sz]) => ({ px: String(px), sz: String(sz) })), b.asks.map(([px, sz]) => ({ px: String(px), sz: String(sz) }))];
    if (body.type === 'metaAndAssetCtxs') return res([{ universe: [{ name: 'io:A' }, { name: 'io:B' }] }, [{ markPx: '10', openInterest: '50000', dayNtlVlm: '1e6' }, { markPx: '10', openInterest: '4000', dayNtlVlm: '1e6' }]]);
    if (body.type === 'l2Book' && url.includes('hyperliquid')) return res({ levels: lv(book(10, 1e5)) });
    if (body.type === 'perpMeta') return res({ success: true, data: { universe: [{ name: 'X-USDC', index: 1 }, { name: 'Y-USDC', index: 2 }] } });
    if (body.type === 'activeAssetCtx') return res({ success: true, data: { markPx: '10', openInterest: body.coin === '1' ? '2500' : '90000', dayNtlVlm: '1e6' } });
    if (body.type === 'l2Book') return res({ success: true, data: { levels: lv(book(10, 1e5)) } });
    throw new Error('unexpected ' + url);
  };
  const p = await L.picks({ env: {}, f, now: 1 });
  assert.deepEqual(p.platforms.arcus.picks.map((x) => x.market), ['LOW-USD', 'HIGH-USD']);
  assert.deepEqual(p.platforms.entropy.picks.map((x) => x.market), ['io:B', 'io:A']);
  assert.deepEqual(p.platforms.txflow.picks.map((x) => x.market), ['X-USDC', 'Y-USDC']); assert.equal(p.platforms.txflow.manual, true);
  assert.ok(p.platforms.arcus.picks.every((x) => x.spread > 0 && x.depthUsd > 0 && x.oiUsd > 0));
  assert.ok(!seen.some((s) => /placeOrder|batch|exchange|cancel|apiKeys|setLeverage/i.test(s.split(' ')[0])));
});
