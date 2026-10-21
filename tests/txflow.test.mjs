import test from 'node:test';
import assert from 'node:assert/strict';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import * as T from '../src/txflow.js';
import * as F from '../src/fees.js';
const hx = (b) => '0x' + bytesToHex(b);

// Vectors published at https://docs.txflow.com/api/signing (throwaway key 0xabab…ab, testnet domain)
test('TxFlow domain separators match the docs (mainnet 869, testnet 2511)', () => {
  assert.equal(hx(T.domainSeparator(T.NETWORKS.mainnet)), '0x878a21f7c464d592bad925771b5ab6f52897c4321b30eb6cfdf4ea55c749ad8d');
  assert.equal(hx(T.domainSeparator(T.NETWORKS.testnet)), '0x839dd579adc05b1545a37213db5dd3dc6928532ddf73dfa1b53f647421060a8f');
});
test('agent order signing reproduces the documented connectionId, signingHash and r/s/v', () => {
  const act = { type: 'order', grouping: 'na', orders: [{ a: 1, b: true, p: '50000.0', s: '0.01', r: false, t: { limit: { tif: 'Gtc' } } }] };
  assert.equal(hx(T.connectionId(act, 1700000000000)), '0x6546d1c3acf430a28a0b2552c66e985f6543646660874734732ae9e9daf4d806');
  assert.equal(hx(T.agentSigningHash(act, 1700000000000, T.NETWORKS.testnet)), '0xeae1ae63709636fb9567accd33bc5dd2717bfac4d97e9a853f91c7fb391e1cc6');
  const env = T.signAgentAction(act, 1700000000000, hexToBytes('ab'.repeat(32)), T.NETWORKS.testnet);
  assert.deepEqual(env.signature, { r: '0x4064848dd881985c52dacdc00f7046f1010f7f370e34620d36fcf3b2d1ecb3e0', s: '0x25c45ad67b9506ac653fc3658f47aa8b6002bfa86a31ae619b334d71aa8b4f6f', v: 27 });
  assert.equal(env.vaultAddress, null);
});
test('approveAgent struct/signing hash match the docs; typed data uses agent name "bobby"', () => {
  const msg = { txflowNetwork: 'TxFlow-Testnet', chainId: 2511, apiVersion: 1, agentAddress: '0x0202020202020202020202020202020202020202', agentName: 'my-trading-bot', nonce: 2000 };
  assert.equal(hx(T.approveAgentStructHash(msg)), '0xbb5293971660f3252f455b6debbda781841fb23bd45cbbf0199c4de5250573b9');
  assert.equal(hx(T.approveAgentSigningHash(msg, T.NETWORKS.testnet)), '0x1df22801b48ae1402ad36b244aa245fd6e842fa5fef2c40819b1e6c661cd2212');
  const td = T.approveAgentTypedData('0x' + '03'.repeat(20), 5, T.NETWORKS.mainnet);
  assert.equal(td.message.agentName, 'bobby'); assert.equal(td.message.chainId, 869); assert.equal(td.domain.chainId, 42161);
});
test('agent stub: feature flag OFF, post-only orders, no funds/vault/approve via agent', async () => {
  assert.equal(T.TXFLOW_AGENT_ENABLED, false);
  await assert.rejects(T.sendAgentAction(T.TESTNET, {}, { dryRun: true }), /désactivée/);
  assert.equal(T.orderAction({ asset: 1, isBuy: true, px: '60000.0', sz: '0.001' }).orders[0].t.limit.tif, 'Alo');
  const k = hexToBytes('ab'.repeat(32));
  assert.throws(() => T.signAgentAction({ type: 'withdraw3', amount: '1' }, 1, k, T.NETWORKS.testnet), /interdite/);
  assert.throws(() => T.signAgentAction({ type: 'tokenSend' }, 1, k, T.NETWORKS.testnet), /interdite/);
  assert.throws(() => T.signAgentAction({ type: 'approveAgent' }, 1, k, T.NETWORKS.testnet), /wallet principal/);
});
test('info reads: POST /info with the version header; errors surface; fills follow hasMore', async () => {
  const calls = [];
  const fake = async (url, init) => { const b = JSON.parse(init.body); calls.push([url, init.headers['x-api-version'], b]);
    if (b.type === 'userFills') return { ok: true, json: async () => ({ success: true, data: { data: [{ time: 1 }], hasMore: b.offset === 0 } }) };
    return { ok: true, json: async () => ({ success: false, message: 'nope' }) }; };
  const rows = await T.fills(T.TESTNET, '0x' + '01'.repeat(20), 0, 10, fake);
  assert.equal(rows.length, 2); assert.equal(calls[0][0], T.TESTNET + '/info'); assert.equal(calls[0][1], '2026-08-16');
  assert.deepEqual(calls[0][2].accountType, ['perp']);
  await assert.rejects(T.state(T.TESTNET, '0x' + '01'.repeat(20), fake), /nope/);
});
test('weekly activity (epoch) and manual execution check', () => {
  const from = Date.UTC(2026, 9, 19), to = from + 7 * 864e5;
  const a = T.weeklyActivity([{ time: from + 1, px: '60000', sz: '0.001', fee: '0.009', tradeSide: 'Maker' },
    { time: from + 864e5 + 5, px: '60000', sz: '0.001', fee: '0.027', tradeSide: 'Taker' }, { time: from - 1, px: '1', sz: '1', fee: '1' }], from, to);
  assert.equal(a.fills, 2); assert.equal(a.activeDays, 2); assert.ok(Math.abs(a.volume - 120) < 1e-9); assert.equal(a.makerShare, 0.5);
  const mk = { index: 1, name: 'BTC-USDC' }, p = { sd: 'long', px: 60000 };
  assert.equal(T.executedNow(p, { assetPositions: [] }, [], mk).executed, false);
  assert.ok(T.executedNow(p, { assetPositions: [] }, [{ asset: 1, coin: 'BTC-USDC', side: 'B', limitPx: '60010', isTrigger: false }], mk).resting);
  const x = T.executedNow(p, { assetPositions: [{ position: { asset: '1', coin: '1', szi: '0.001' }, tpsl: [] }] }, [], mk);
  assert.ok(x.position && x.hasStopLoss === false);
});
test('live fee parsing with fallbacks (Arcus market/tier table, HL & TxFlow userFees)', () => {
  assert.deepEqual(F.arcusRates({ effectiveMakerFeePpm: 0, effectiveTakerFeePpm: 225 }, { tradingFeeTier: { level: 0, feeDiscountPpm: 50000 } }),
    { maker: 0, taker: 225 * 0.95 / 1e6, source: 'marché' });
  assert.equal(F.arcusRates({}, { tradingFeeTier: { level: 1 } }, { tiers: [{ level: 0, maker_fee_ppm: 200, taker_fee_ppm: 500 }, { level: 1, maker_fee_ppm: 150, taker_fee_ppm: 450 }] }).taker, 450 / 1e6);
  assert.equal(F.arcusRates({}, null, null).source, 'défaut');
  assert.deepEqual(F.userFeesRates({ userAddRate: '0.00015', userCrossRate: '0.00045' }, F.FALLBACK.hl_main), { maker: 0.00015, taker: 0.00045, source: 'userFees' });
  assert.equal(F.userFeesRates({ success: true, data: { userAddRate: '0.0001', userCrossRate: '0.0004' } }, F.FALLBACK.txflow).taker, 0.0004);
  assert.equal(F.userFeesRates({}, F.FALLBACK.txflow).source, 'défaut');
});
