import test from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../src/arcus.js';
import * as D from '../src/dec.js';
import { runPy, randHex } from './helpers.mjs';

const ADDRESS = '0x' + randHex(20); // throwaway address
const KEY = randHex(32); // throwaway Ed25519 key, never the env key
const markets = [
  { marketId: 1, marketDisplayName: 'BTC-USD', tickSize: '0.1', stepSize: '0.00000001', markPrice: '82013.7' },
  { marketId: 41, marketDisplayName: 'TSLA-USD', tickSize: '0.01', stepSize: '0.001', markPrice: '378.83' },
  { marketId: 7, marketDisplayName: 'GLD-USD', tickSize: '0.01', stepSize: '0.01', markPrice: '382.96' },
  { marketId: 9, marketDisplayName: 'PEPE-USD', tickSize: '0.0000001', stepSize: '1', markPrice: '0.0000123' },
  { marketId: 12, marketDisplayName: 'USO-USD', tickSize: '0.001', stepSize: '0.1', markPrice: '158.5' },
];
const R = (a) => a[Math.floor(Math.random() * a.length)];

function jsReq(c) {
  const ctx = A.makeCtx({ priv: A.keyFromHex(KEY), address: ADDRESS, accountIndex: 0, nowNs: () => BigInt(c.ts), nowUs: () => BigInt(c.now_us) });
  const m = c.market;
  switch (c.kind) {
    case 'market': return A.marketOrder(ctx, m, c.side, c.qty, { slippage: c.slippage, reduceOnly: c.reduce });
    case 'close': return A.closePosition(ctx, m, c.positions[0], { slippage: c.slippage });
    case 'ptpsl': return A.positionTpsl(ctx, m, c.pside, { takeProfit: c.tp, stopLoss: c.sl });
    case 'cancel': return A.cancelOrder(ctx, m, c.oid);
    case 'lev': return A.setLeverage(ctx, m, c.lev, true);
    case 'sget': return A.signedGet(ctx, '/v1/affiliate/code');
    case 'entry': return A.entryTpsl(ctx, m, c.side, c.qty, { type: c.type, limitPrice: c.limit, takeProfit: c.tp, stopLoss: c.sl, slippage: c.slippage });
  }
}

test('Arcus requests are byte-identical to arcus.py (throwaway Ed25519 key)', () => {
  const cases = [];
  for (let i = 0; i < 60; i++) {
    const m = R(markets);
    const ts = 1792136420518974644n + BigInt(i) * 1234567n;
    const base = { ts: Number.MAX_SAFE_INTEGER, market: m };
    const mark = Number(m.markPrice);
    let qty = D.normalize(D.snap(String(Math.random() * 10 + 0.01), m.stepSize, 'floor'));
    if (D.cmp(qty, '0') === 0) qty = m.stepSize;
    const px = (f) => D.toStr(D.parse(D.snap(String(mark * f), m.tickSize, 'round')));
    const side = R(['BUY', 'SELL']);
    const kinds = ['market', 'close', 'ptpsl', 'cancel', 'lev', 'sget', 'entry'];
    const kind = kinds[i % kinds.length];
    const c = { ...base, kind, ts: ts.toString(), now_us: (ts / 1000n).toString(), side, qty, slippage: R([0.01, 0.02, 0.05, 0.08]), reduce: i % 2 === 0 };
    if (kind === 'close') c.positions = [{ size: (side === 'BUY' ? '-' : '') + qty, side: side === 'BUY' ? 'SHORT' : 'LONG' }];
    if (kind === 'ptpsl') { c.pside = side === 'BUY' ? 'LONG' : 'SHORT'; c.tp = px(side === 'BUY' ? 1.07 : 0.93); if (i % 3) c.sl = px(side === 'BUY' ? 0.96 : 1.04); }
    if (kind === 'cancel') c.oid = randHex(8);
    if (kind === 'lev') c.lev = 1 + (i % 10);
    if (kind === 'entry') { c.type = i % 2 ? 'market' : 'limit'; c.limit = String(mark * 0.99); c.tick = m.tickSize; c.tp = px(side === 'BUY' ? 1.05 : 0.95); c.sl = px(side === 'BUY' ? 0.97 : 1.03); }
    cases.push(c);
  }
  // python needs ints for ts/now_us
  const pyIn = JSON.stringify(cases).replace(/"(ts|now_us)":"(\d+)"/g, '"$1":$2');
  const py = runPy('py_arcus.py', pyIn, { ARCUS_API_SIGNING_KEY: KEY, ARCUS_ADDRESS: ADDRESS, ARCUS_ACCOUNT_INDEX: '0', ARCUS_ALLOW_WRITE: '1', ARCUS_BASE_URL: 'http://127.0.0.1:9' });
  assert.equal(py.length, cases.length);
  cases.forEach((c, i) => {
    const js = jsReq({ ...c, ts: BigInt(c.ts), now_us: BigInt(c.now_us) });
    const p = py[i];
    assert.equal(js.path, p.path, c.kind);
    assert.equal(js.method, p.method, c.kind);
    assert.deepEqual(js.query, p.query, c.kind);
    assert.deepEqual(js.headers, p.headers, c.kind + ' headers/signature');
    assert.equal(js.body, p.body, c.kind + ' body bytes');
  });
});

test('Arcus Ed25519 signature verifies and API key = public key', async () => {
  const { ed25519 } = await import('@noble/curves/ed25519.js');
  const priv = A.keyFromHex(KEY);
  const ctx = A.makeCtx({ priv, address: ADDRESS });
  const r = A.setLeverage(ctx, markets[1], 5, true);
  const msg = new TextEncoder().encode(`${r.headers['X-Timestamp']}setLeverage${r.body}`);
  const { hexToBytes } = await import('@noble/hashes/utils.js');
  assert.ok(ed25519.verify(hexToBytes(r.headers['X-Signature']), msg, hexToBytes(ctx.apiKey)));
  assert.match(r.headers['X-Signature'], /^[0-9a-f]{128}$/);
});

test('decimal snapping mirrors Python Decimal rules', () => {
  assert.equal(D.snap('378.8349', '0.01', 'floor'), '378.83');
  assert.equal(D.snap('378.8301', '0.01', 'ceil'), '378.84');
  assert.equal(D.snap('379', '0.1', 'floor'), '379.0');
  assert.equal(D.units('1.25', '0.05'), 25n);
  assert.throws(() => D.units('1.26', '0.05'));
  assert.equal(A.protectivePrice(markets[1], 'BUY', '378.83', 0.02), '386.40');
  assert.equal(A.protectivePrice(markets[1], 'SELL', '378.83', 0.02), '371.26');
  assert.equal(A.maxLeverage({ initialMarginFraction: '0.025' }), 40);
  assert.equal(A.maxLeverage({ initialMarginFraction: '0.1', offHoursInitialMarginFraction: '0.2', isOutsideRth: true }), 5);
});

test('tickTiers: entry, protective and stop prices snap to the tier tick; the signed integer still uses tickSize', () => {
  const m = { marketId: 1, marketDisplayName: 'BTC-USD', tickSize: '0.1', stepSize: '0.00000001', markPrice: '600000',
    tickTiers: [{ upToPrice: '500000', tick: '0.1' }, { upToPrice: '1000000', tick: '0.2' }, { tick: '5' }] };
  const ctx = A.makeCtx({ priv: A.keyFromHex(KEY), address: ADDRESS, accountIndex: 0, nowNs: () => 1792136420518974644n, nowUs: () => 1792136420518974n });
  const d = A.entryTpsl(ctx, m, 'BUY', '0.001', { type: 'limit', limitPrice: '600000.3', stopLoss: '590000.3', takeProfit: '610000.1', postOnly: true });
  const b = JSON.parse(d.body);
  assert.equal(b.orders[0].timeInForce, 'ALO');
  const isMul = (x, t) => D.cmp(D.snap(x, t, 'floor'), x) === 0;
  for (const o of b.orders) { assert.ok(isMul(o.price, '0.2'), o.price); if (o.stopPrice) assert.ok(isMul(o.stopPrice, '0.2'), o.stopPrice); }
  assert.ok(BigInt(b.orders[0].goodTilTime) >= 1792136420518974n + 30n * 86400n * 1000000n); // >= 1 month ahead (µs)
  assert.equal(A.tpslStop(m, '590000.3'), '590000.2');
});
