import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRisk, liqPrice } from '../src/risk.js';
const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('SL loss / TP gain include fees on both sides', () => {
  // synthetic short 1.2 @1000, SL 1050, TP 920, fee 0.01%/side
  const r = computeRisk({ isLong: false, size: 1.2, leverage: 5, mark: 1000, type: 'market', feeRate: 0.0001, mmf: 1 / 12, maxLev: 6, sl: 1050, tp: 920 });
  near(r.notional, 1.2 * 1000);
  near(r.margin, (1.2 * 1000) / 5);
  near(r.slLoss, 1.2 * (1050 - 1000) + 0.0001 * 1.2 * (1000 + 1050));
  near(r.tpGain, 1.2 * (1000 - 920) - 0.0001 * 1.2 * (1000 + 920));
  assert.equal(r.blocks.length, 0); assert.equal(r.warns.length, 0);
});
test('oversized SL is caught: 80 @50 SL 52 = ~-164$ incl. fees (>=100 -> red, 2nd confirm)', () => {
  const r = computeRisk({ isLong: false, size: 80, leverage: 10, mark: 50, type: 'market', feeRate: 0.00045, mmf: 0.05, maxLev: 20, sl: 52 });
  assert.ok(r.slLoss > 150 && r.slLoss < 165, String(r.slLoss));
  assert.ok(r.warns.some((w) => w.includes('Perte au SL')));
  assert.ok(r.needsSecondConfirm);
});
test('exactly $100 counts as over the limit', () => {
  const r = computeRisk({ isLong: true, size: 10, leverage: 2, mark: 100, type: 'market', feeRate: 0, mmf: 0.01, sl: 90 });
  near(r.slLoss, 100); assert.ok(r.warns.some((w) => w.includes('Perte au SL')));
});
test('leverage above market max and SL on the wrong side are hard blocks', () => {
  const r = computeRisk({ isLong: true, size: 1, leverage: 10, mark: 100, type: 'market', feeRate: 0, mmf: 0.05, maxLev: 6, sl: 101 });
  assert.equal(r.blocks.length, 2);
});
test('expired proposal and >1% move are red warnings', () => {
  const r = computeRisk({ isLong: true, size: 1, leverage: 2, mark: 102, ref: 100, type: 'market', feeRate: 0, mmf: 0.05, sl: 95, expiry: 1000, now: 2000 });
  assert.ok(r.warns.some((w) => w.includes('expirée')));
  assert.ok(r.warns.some((w) => w.includes('bougé')));
  const ok = computeRisk({ isLong: true, size: 1, leverage: 2, mark: 100.9, ref: 100, type: 'market', feeRate: 0, mmf: 0.05, sl: 95, expiry: 3000, now: 2000 });
  assert.equal(ok.warns.length, 0);
});
test('limit entry uses the limit price, not mark', () => {
  const r = computeRisk({ isLong: false, size: 2, leverage: 7, mark: 980, type: 'limit', limitPx: 1000, feeRate: 0.0001, mmf: 1 / 30, sl: 1030 });
  near(r.slLoss, 2 * 30 + 0.0001 * 2 * (1000 + 1030));
});
test('isolated liquidation estimate', () => {
  near(liqPrice({ isLong: true, entry: 100, leverage: 10, mmf: 0.05 }), 90 / 0.95);
  near(liqPrice({ isLong: false, entry: 100, leverage: 10, mmf: 0.05 }), 110 / 1.05);
  const r = computeRisk({ isLong: true, size: 1, leverage: 10, mark: 100, type: 'market', feeRate: 0, mmf: 0.05, sl: 90 });
  assert.ok(r.warns.some((w) => w.includes('liquidation')));
});
test('margin above free collateral warns', () => {
  const r = computeRisk({ isLong: true, size: 10, leverage: 2, mark: 100, type: 'market', feeRate: 0, mmf: 0.05, sl: 99, freeCollateral: 300 });
  assert.ok(r.warns.some((w) => w.includes('collatéral')));
});
test('tpsl on existing position: SL moved past entry to lock profit is valid (checked vs mark)', () => {
  // synthetic long 20 @100, mark 103, new SL 100.1 (just past entry)
  const r = computeRisk({ mode: 'tpsl', isLong: true, size: 20, leverage: 13, mark: 103, type: 'limit', limitPx: 100, feeRate: 0.000225, mmf: 0.033, sl: 100.1 });
  assert.equal(r.blocks.length, 0, r.blocks.join());
  assert.ok(r.slLocked > 0); assert.equal(r.slLoss, 0);
  near(r.slLocked, 20 * 0.1 - 0.000225 * 20 * (100 + 100.1));
  // SL above the current mark (long) is blocked; TP below mark blocked
  const bad = computeRisk({ mode: 'tpsl', isLong: true, size: 20, leverage: 13, mark: 103, type: 'limit', limitPx: 100, feeRate: 0, mmf: 0.033, sl: 104, tp: 102 });
  assert.equal(bad.blocks.length, 2);
  // short: SL must be above mark, TP below mark; SL below entry (locked profit) is fine
  const sh = computeRisk({ mode: 'tpsl', isLong: false, size: 25, leverage: 10, mark: 196, type: 'limit', limitPx: 200, feeRate: 0, mmf: 0.05, sl: 199, tp: 190 });
  assert.equal(sh.blocks.length, 0); near(sh.slLocked, 25 * 1);
  const shBad = computeRisk({ mode: 'tpsl', isLong: false, size: 25, leverage: 10, mark: 196, type: 'limit', limitPx: 200, feeRate: 0, mmf: 0.05, sl: 195, tp: 197 });
  assert.equal(shBad.blocks.length, 2);
  // a normal (losing) tpsl SL still reports the loss
  const loss = computeRisk({ mode: 'tpsl', isLong: true, size: 10, leverage: 5, mark: 100, type: 'limit', limitPx: 100, feeRate: 0, mmf: 0.05, sl: 95 });
  near(loss.slLoss, 50); assert.equal(loss.slLocked, null);
});
test('open orders keep the entry-side check', () => {
  const r = computeRisk({ isLong: true, size: 1, leverage: 5, mark: 100, type: 'limit', limitPx: 90, feeRate: 0, mmf: 0.05, sl: 95 });
  assert.ok(r.blocks.some((b) => b.includes('prix d’entrée')));
});
