import test from 'node:test';
import assert from 'node:assert/strict';
import * as H from '../src/hl.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { runPy, randHex } from './helpers.mjs';

const KEY = '0x' + randHex(32); // throwaway secp256k1 key
const R = (a) => a[Math.floor(Math.random() * a.length)];
const rnd = (lo, hi) => lo + Math.random() * (hi - lo);

test('Hyperliquid signatures, action hashes and wires are byte-identical to hyperliquid-python-sdk', () => {
  const priv = H.keyFromHex(KEY);
  const actions = [], orders = [];
  const roundIn = [], slipIn = [], wireIn = [];
  for (let i = 0; i < 80; i++) {
    const szDecimals = R([0, 1, 2, 3, 4, 5]);
    const asset = R([0, 1, 5, 159, 200000, 200001, 200005, 110003]);
    const mark = R([rnd(0.00001, 0.01), rnd(0.5, 5), rnd(10, 300), rnd(900, 5000), rnd(50000, 120000)]);
    roundIn.push([mark, szDecimals]);
    const isBuy = Math.random() < 0.5, slip = R([0.01, 0.02, 0.05, 0.08]);
    slipIn.push([mark, isBuy, slip, szDecimals]);
    const kind = i % 5;
    let action;
    const sz = Math.max(H.roundSz(rnd(0.001, 50), szDecimals), 10 ** -szDecimals);
    if (kind === 0) action = H.updateLeverageAction(asset, Math.random() < 0.5, 1 + (i % 20));
    else if (kind === 1) action = H.buildCancel(asset, Math.floor(rnd(1, 2 ** 45)));
    else if (kind === 2) action = H.buildClose({ asset, szDecimals, szi: (isBuy ? -1 : 1) * sz, markPx: mark, slippage: slip });
    else if (kind === 3) action = H.buildPositionTpsl({ asset, szDecimals, positionIsLong: isBuy, tp: H.roundPx(mark * (isBuy ? 1.1 : 0.9), szDecimals), sl: H.roundPx(mark * (isBuy ? 0.95 : 1.05), szDecimals) });
    else {
      const [lev, ord] = H.buildOpen({ asset, szDecimals, isBuy, sz, leverage: 5, type: R(['market', 'limit']), limitPx: mark * 0.99, markPx: mark,
        tp: mark * (isBuy ? 1.08 : 0.92), sl: mark * (isBuy ? 0.97 : 1.03), slippage: slip });
      actions.push({ action: lev, nonce: 1792136420000 + i, mainnet: true });
      action = ord;
    }
    const c = { action, nonce: 1792136420518 + i * 7, mainnet: i % 4 !== 0 };
    if (i % 9 === 0) c.vault = '0x' + randHex(20);
    if (i % 11 === 0) c.expires = 1792136500000 + i;
    actions.push(c);
    if (action.type === 'order') {
      // python rebuilds the same orders from floats via order_request_to_order_wire
      orders.push({ grouping: action.grouping, legs: action.orders.map((w) => ({ asset: w.a, req: { coin: 'X', is_buy: w.b, sz: Number(w.s), limit_px: Number(w.p),
        reduce_only: w.r, order_type: w.t.limit ? { limit: w.t.limit } : { trigger: { isMarket: w.t.trigger.isMarket, triggerPx: Number(w.t.trigger.triggerPx), tpsl: w.t.trigger.tpsl } } } })),
        js: action });
    }
    wireIn.push(R([sz, mark.toFixed(4) * 1, 0.1 + 0.2, 1e-8, 123456, 0.00012]));
  }
  const py = runPy('py_hl.py', { key: KEY, actions, round: roundIn, slip: slipIn, wire: wireIn, orders: orders.map(({ js, ...o }) => o) });
  assert.equal(H.addressOf(priv).toLowerCase(), py.address.toLowerCase());
  actions.forEach((c, i) => {
    assert.equal(bytesToHex(H.actionHash(c.action, c.vault ?? null, c.nonce, c.expires ?? null)), py.sigs[i].hash, 'hash #' + i);
    assert.deepEqual(H.signL1Action(priv, c.action, c.vault ?? null, c.nonce, c.expires ?? null, c.mainnet), py.sigs[i].sig, 'sig #' + i);
  });
  roundIn.forEach(([px, sd], i) => assert.equal(H.pyRound(H.sig5(px), 6 - sd), py.round[i], `round ${px} ${sd}`));
  slipIn.forEach(([px, b, s, sd], i) => assert.equal(H.slippagePx(px, b, s, sd), py.slip[i], `slip ${px}`));
  wireIn.forEach((x, i) => assert.equal(H.floatToWire(x), py.wire[i]));
  orders.forEach((o, i) => assert.deepEqual(o.js, py.orders[i], 'order action #' + i));
});

test('exchange request body has the SDK shape and recovers to the agent address', async () => {
  const { secp256k1 } = await import('@noble/curves/secp256k1.js');
  const priv = H.keyFromHex(KEY);
  const action = H.updateLeverageAction(200001, false, 5);
  const r = H.exchangeRequest(priv, action, 1792136420518, { isMainnet: true });
  const b = JSON.parse(r.body);
  assert.deepEqual(Object.keys(b), ['action', 'nonce', 'signature', 'vaultAddress', 'expiresAfter']);
  const digest = H.l1Digest(H.actionHash(action, null, 1792136420518, null), true);
  const sig = secp256k1.Signature.fromBytes(new Uint8Array([b.signature.v - 27, ...H_hex(b.signature.r), ...H_hex(b.signature.s)]), 'recovered');
  const pub = sig.recoverPublicKey(digest).toBytes(false);
  const { keccak_256 } = await import('@noble/hashes/sha3.js');
  assert.equal('0x' + bytesToHex(keccak_256(pub.slice(1)).slice(-20)), H.addressOf(priv));
});
function H_hex(h) { const s = h.slice(2).padStart(64, '0'); return Uint8Array.from(s.match(/../g).map((x) => parseInt(x, 16))); }

test('asset id for HIP-3 dex = 100000 + dexIndex*10000 + index (dexIndex from perpDexs)', () => {
  const perpDexs = [null, { name: 'xyz' }, { name: 'flx' }, { name: 'vntl' }, { name: 'hyna' }, { name: 'km' }, { name: 'abcd' }, { name: 'cash' }, { name: 'para' }, { name: 'mkts' }, { name: 'io' }];
  const uni = [{ name: 'io:OAI' }, { name: 'io:ANTH' }, { name: 'io:SNDK' }];
  assert.equal(H.assetId('io:ANTH', uni, perpDexs), 200001);
  assert.equal(H.assetId('BTC', [{ name: 'BTC' }, { name: 'ETH' }], [null]), 0);
  assert.equal(H.assetId('ETH', [{ name: 'BTC' }, { name: 'ETH' }], [null]), 1);
  assert.throws(() => H.assetId('io:NOPE', uni, perpDexs));
});

test('price/size wire formatting rules', () => {
  assert.equal(H.roundPx(1943.876, 3), 1943.9);   // 5 sig figs
  assert.equal(H.roundPx(0.0123456, 0), 0.012346);
  assert.equal(H.roundPx(57.6349, 2), 57.635);
  assert.equal(H.roundPx(4.123456, 5), 4.1);      // max 6-szDecimals decimals
  assert.equal(H.roundPx(123456, 0), 123456);     // integers always allowed
  assert.equal(H.roundSz(1.23999, 2), 1.23);
  assert.equal(H.floatToWire(0.1 + 0.2), '0.3');
  assert.equal(H.floatToWire(100), '100');
  assert.throws(() => H.floatToWire(1.123456789));
});
