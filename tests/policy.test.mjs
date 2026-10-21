import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRisk, checkPolicy, POLICY, weekStartUtc, weekEndUtc, realizedLoss, assertTradeOnly } from '../src/risk.js';
import { validateProposal } from '../src/proposal.js';
import * as H from '../src/hl.js';
import * as A from '../src/arcus.js';
import { randHex } from './helpers.mjs';

const ok = { v: 1, id: 'x', pf: 'arcus', m: 'TSLA-USD', act: 'open', sd: 'long', sz: 0.5, lev: 1, et: 'limit', px: 398, sl: 393 };
const risk = (p, extra = {}) => computeRisk({ isLong: p.sd === 'long', size: p.sz, leverage: p.lev, mark: 400, type: p.et, limitPx: p.px,
  feeRate: 0.000225, entryFeeRate: 0, mmf: 0.05, maxLev: 10, sl: p.sl, ...extra });

test('defaults: maker-only, 1x, mandatory SL, 1 % of $300 per trade, $50 weekly cap', () => {
  assert.equal(POLICY.makerOnly, true); assert.equal(POLICY.maxLeverage, 1); assert.equal(POLICY.requireStopLoss, true);
  assert.equal(POLICY.maxLossPct, 0.01); assert.equal(POLICY.weeklyLossCap, 50);
  assert.deepEqual(POLICY.capital, { arcus: 300, hl: 300, txflow: 300, qfex: 100 });
});
test('a compliant post-only 1x trade with ~$2.5 at risk passes', () => {
  const r = risk(ok); const c = checkPolicy(ok, r, { weeklyLossUsed: 0 });
  assert.ok(r.slLoss > 2.4 && r.slLoss < 3, String(r.slLoss));
  assert.deepEqual(c.blocks, []); assert.equal(c.maxLoss, 3);
});
test('market entry, leverage > 1x and missing SL are hard blocks', () => {
  for (const [p, re] of [[{ ...ok, et: 'market', ref: 400 }, /maker/], [{ ...ok, lev: 2 }, /leverage 2×/], [{ ...ok, sl: undefined }, /stop-loss required/]]) {
    const c = checkPolicy(p, risk(p), {}); assert.ok(c.blocks.some((b) => re.test(b)), JSON.stringify(c.blocks));
  }
});
test('loss at SL above 1 % of platform capital is blocked; capital and % are configurable', () => {
  const p = { ...ok, sz: 1, sl: 394 }; // ~$4 + fees
  assert.ok(checkPolicy(p, risk(p), {}).blocks.some((b) => /loss at SL/.test(b)));
  const pol = { ...POLICY, capital: { ...POLICY.capital, arcus: 1000 } }; // 1 % of 1000 = $10
  assert.deepEqual(checkPolicy(p, risk(p), { policy: pol }).blocks, []);
  assert.ok(checkPolicy(p, risk(p), { policy: { ...pol, maxLossPct: 0.002 } }).blocks.length === 1);
});
test('weekly cap: blocked once used >= cap, and when this trade could cross it; cap is configurable', () => {
  const r = risk(ok);
  assert.ok(checkPolicy(ok, r, { weeklyLossUsed: 50 }).blocks.some((b) => /weekly loss cap reached/.test(b)));
  assert.ok(checkPolicy(ok, r, { weeklyLossUsed: 48.5 }).blocks.some((b) => /exceed the weekly cap/.test(b)));
  assert.deepEqual(checkPolicy(ok, r, { weeklyLossUsed: 40 }).blocks, []);
  assert.deepEqual(checkPolicy(ok, r, { weeklyLossUsed: 50, policy: { ...POLICY, weeklyLossCap: 100 } }).blocks, []);
});
test('margin above free collateral is a block; cancels are never blocked by policy', () => {
  assert.ok(checkPolicy(ok, risk(ok), { freeCollateral: 100 }).blocks.some((b) => /free collateral/.test(b)));
  assert.deepEqual(checkPolicy({ ...ok, act: 'cancel', oid: '1' }, null, { weeklyLossUsed: 999 }).blocks, []);
});
test('maker entry fee is used for the entry leg, taker for the stop', () => {
  const a = risk(ok), b = risk(ok, { entryFeeRate: undefined });
  assert.ok(b.slLoss - a.slLoss > 0.04 && b.slLoss - a.slLoss < 0.05);
});
test('week = Monday 00:00 UTC → next Monday', () => {
  const wed = Date.UTC(2026, 9, 21, 0, 30); // Wed 21 Oct 2026
  assert.equal(new Date(weekStartUtc(wed)).toISOString(), '2026-10-19T00:00:00.000Z');
  assert.equal(new Date(weekEndUtc(wed)).toISOString(), '2026-10-26T00:00:00.000Z');
  const sun = Date.UTC(2026, 9, 25, 23, 59); assert.equal(new Date(weekStartUtc(sun)).toISOString(), '2026-10-19T00:00:00.000Z');
  assert.equal(new Date(weekStartUtc(Date.UTC(2026, 9, 26))).toISOString(), '2026-10-26T00:00:00.000Z');
});
test('realized loss: fees subtracted unless already included; gains count as 0; outside window ignored', () => {
  const f = [{ time: 10, closedPnl: '-5', fee: '0.5' }, { time: 20, closedPnl: '2', fee: '0.1' }, { time: 1, closedPnl: '-100', fee: '0' }];
  assert.ok(Math.abs(realizedLoss(f, 5) - 3.6) < 1e-9);
  assert.ok(Math.abs(realizedLoss(f, 5, Infinity, { feeIncluded: true }) - 3) < 1e-9);
  assert.equal(realizedLoss([{ time: 10, closedPnl: '9', fee: '1' }], 0), 0);
});
test('funds/vault actions are refused by every signer path', () => {
  for (const type of ['withdraw3', 'usdSend', 'vaultTransfer', 'tokenSend', 'spotSend', 'usdClassTransfer'])
    assert.throws(() => assertTradeOnly('action', { type }), /forbidden/);
  const priv = H.keyFromHex(randHex());
  assert.throws(() => H.exchangeRequest(priv, { type: 'withdraw3', amount: '1' }, 1), /forbidden/);
  assert.throws(() => H.exchangeRequest(priv, H.buildCancel(1, 1), 1, { vaultAddress: '0x' + '11'.repeat(20) }), /vault/);
  assert.throws(() => assertTradeOnly('arcus', { path: '/v1/withdraw' }), /forbidden/);
  assert.doesNotThrow(() => assertTradeOnly('arcus', { path: '/v1/placeOrder' }));
});
test('post-only: Hyperliquid Alo and Arcus ALO when requested; defaults unchanged', () => {
  const [, o] = H.buildOpen({ asset: 1, szDecimals: 2, isBuy: true, sz: 1, leverage: 1, type: 'limit', limitPx: 100, markPx: 101, sl: 95, postOnly: true });
  assert.equal(o.orders[0].t.limit.tif, 'Alo');
  const [, d] = H.buildOpen({ asset: 1, szDecimals: 2, isBuy: true, sz: 1, leverage: 1, type: 'limit', limitPx: 100, markPx: 101 });
  assert.equal(d.orders[0].t.limit.tif, 'Gtc');
  const ctx = A.makeCtx({ priv: A.keyFromHex(randHex()), address: '0x' + '22'.repeat(20) });
  const m = { marketId: 7, tickSize: '0.01', stepSize: '0.001', markPrice: '400' };
  const req = A.entryTpsl(ctx, m, 'BUY', '0.5', { type: 'limit', limitPrice: '398', stopLoss: '393', postOnly: true });
  assert.equal(JSON.parse(req.body).orders[0].timeInForce, 'ALO');
});
test('proposal format accepts TxFlow (open/cancel), refuses TxFlow tpsl', () => {
  assert.equal(validateProposal({ ...ok, pf: 'txflow', m: 'BTC-USDC' }).pf, 'txflow');
  assert.throws(() => validateProposal({ v: 1, id: 'y', pf: 'txflow', m: 'BTC-USDC', act: 'tpsl', sl: 1 }), /TxFlow/);
});
