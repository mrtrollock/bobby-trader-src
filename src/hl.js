// Hyperliquid (main dex + HIP-3 builder dexes such as "io") action builders and phantom-agent EIP-712 signing,
// ported from hyperliquid-python-sdk (utils/signing.py, exchange.py).
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils.js';
import { encode as mpEncode } from '@msgpack/msgpack';
import * as D from './dec.js';
import { assertTradeOnly } from './risk.js';

export const MAINNET = 'https://api.hyperliquid.xyz';
export const TESTNET = 'https://api.hyperliquid-testnet.xyz';
const te = new TextEncoder();
const strip0x = (h) => (h.startsWith('0x') ? h.slice(2) : h);

export function keyFromHex(hex) {
  const raw = strip0x(String(hex || '').trim()).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(raw)) throw new Error('Invalid Hyperliquid key (64 hex characters expected)');
  return hexToBytes(raw);
}
export function addressOf(priv) {
  const pub = secp256k1.getPublicKey(priv, false).slice(1);
  return '0x' + bytesToHex(keccak_256(pub).slice(-20));
}

// ---------------------------------------------------------------- wire formatting
// Python float -> exact decimal string (repr digits are not enough: we need the exact binary value for rounding)
function exactDec(x) { return x.toFixed(100).replace(/0+$/, '').replace(/\.$/, ''); }
// Python round(x, n) on a float: correctly rounded, ties-to-even on the exact binary value
export function pyRound(x, n) {
  const s = D.snap(exactDec(x), n > 0 ? '0.' + '0'.repeat(n - 1) + '1' : '1', 'half');
  return Number(s);
}
// Python f"{x:.5g}" then float()
export const sig5 = (x) => Number(x.toPrecision(5));

export function floatToWire(x) {
  const rounded = x.toFixed(8);
  if (Math.abs(Number(rounded) - x) >= 1e-12) throw new Error('float_to_wire causes rounding ' + x);
  return D.normalize(rounded);
}
// SDK rule for perps: 5 significant figures and at most (6 - szDecimals) decimals; integers always allowed
export function roundPx(px, szDecimals, isSpot = false) {
  if (Number.isInteger(px) && px >= 1e5) return px;
  return pyRound(sig5(px), (isSpot ? 8 : 6) - szDecimals);
}
export function roundSz(sz, szDecimals) {
  return Number(D.snap(String(sz), szDecimals > 0 ? '0.' + '0'.repeat(szDecimals - 1) + '1' : '1', 'floor'));
}
export function slippagePx(px, isBuy, slippage, szDecimals) {
  return roundPx(px * (isBuy ? 1 + slippage : 1 - slippage), szDecimals);
}

// ---------------------------------------------------------------- actions (key order matters for msgpack)
export function orderTypeWire(t) {
  if (t.limit) return { limit: { tif: t.limit.tif } };
  if (t.trigger) return { trigger: { isMarket: t.trigger.isMarket, triggerPx: floatToWire(t.trigger.triggerPx), tpsl: t.trigger.tpsl } };
  throw new Error('Invalid order type');
}
export function orderWire(asset, o) {
  const w = { a: asset, b: o.isBuy, p: floatToWire(o.limitPx), s: floatToWire(o.sz), r: o.reduceOnly, t: orderTypeWire(o.orderType) };
  if (o.cloid) w.c = o.cloid;
  return w;
}
export const orderAction = (wires, grouping = 'na') => ({ type: 'order', orders: wires, grouping });
export const updateLeverageAction = (asset, isCross, leverage) => ({ type: 'updateLeverage', asset, isCross, leverage });
export const cancelAction = (cancels) => ({ type: 'cancel', cancels: cancels.map((c) => ({ a: c.a, o: c.o })) });

// ---------------------------------------------------------------- signing
function u64be(n) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n)); return b; }
export function actionHash(action, vaultAddress, nonce, expiresAfter) {
  let data = concatBytes(mpEncode(action), u64be(nonce));
  data = vaultAddress == null ? concatBytes(data, new Uint8Array([0])) : concatBytes(data, new Uint8Array([1]), hexToBytes(strip0x(vaultAddress)));
  if (expiresAfter != null) data = concatBytes(data, new Uint8Array([0]), u64be(expiresAfter));
  return keccak_256(data);
}
const kstr = (s) => keccak_256(te.encode(s));
const u256 = (n) => { const b = new Uint8Array(32); let v = BigInt(n); for (let i = 31; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };
const DOMAIN_TYPEHASH = kstr('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)');
const AGENT_TYPEHASH = kstr('Agent(string source,bytes32 connectionId)');
const DOMAIN_SEP = keccak_256(concatBytes(DOMAIN_TYPEHASH, kstr('Exchange'), kstr('1'), u256(1337), new Uint8Array(32)));

export function l1Digest(hash, isMainnet) {
  const structHash = keccak_256(concatBytes(AGENT_TYPEHASH, kstr(isMainnet ? 'a' : 'b'), hash));
  return keccak_256(concatBytes(new Uint8Array([0x19, 0x01]), DOMAIN_SEP, structHash));
}
export function signL1Action(priv, action, vaultAddress, nonce, expiresAfter, isMainnet) {
  const digest = l1Digest(actionHash(action, vaultAddress, nonce, expiresAfter), isMainnet);
  const sig = secp256k1.sign(digest, priv, { prehash: false, format: 'recovered' }); // [recovery, r(32), s(32)]
  const rec = sig[0], r = bytesToHex(sig.slice(1, 33)), s = bytesToHex(sig.slice(33, 65));
  return { r: '0x' + BigInt('0x' + r).toString(16), s: '0x' + BigInt('0x' + s).toString(16), v: 27 + rec };
}
// Body exactly as exchange.py _post_action builds it
// vaultAddress: only the ONE subaccount the caller explicitly allows (allowedVault, the autotrader's HL_SUBACCOUNT_ADDRESS,
// verified at startup to be a subaccount of the agent's master); any other vault/subaccount is refused. The web app
// never passes allowedVault, so for it trading via a vault stays forbidden.
export function exchangeRequest(priv, action, nonce, { isMainnet = true, vaultAddress = null, allowedVault = null, expiresAfter = null } = {}) {
  assertTradeOnly('action', action);
  if (vaultAddress != null) {
    const ok = /^0x[0-9a-fA-F]{40}$/.test(String(vaultAddress)) && allowedVault != null && String(vaultAddress).toLowerCase() === String(allowedVault).toLowerCase();
    if (!ok) throw new Error('Trading via a vault is forbidden by policy (only the configured Bobby subaccount is allowed)');
    vaultAddress = String(vaultAddress).toLowerCase();
  }
  const signature = signL1Action(priv, action, vaultAddress, nonce, expiresAfter, isMainnet);
  return { method: 'POST', path: '/exchange', body: JSON.stringify({ action, nonce, signature, vaultAddress, expiresAfter }),
    headers: { 'Content-Type': 'application/json' } };
}

// ---------------------------------------------------------------- asset ids
export function dexOf(coin) { const i = coin.indexOf(':'); return i > 0 ? coin.slice(0, i) : ''; }
// perpDexs: array from {"type":"perpDexs"} (index 0 = null main dex). asset = 100000 + dexIndex*10000 + index
export function assetId(coin, universe, perpDexs) {
  const dex = dexOf(coin);
  const idx = universe.findIndex((u) => u.name === coin);
  if (idx < 0) throw new Error('Unknown market: ' + coin);
  if (!dex) return idx;
  const di = perpDexs.findIndex((d) => d && d.name === dex);
  if (di < 1) throw new Error('Dex inconnu: ' + dex);
  return 100000 + di * 10000 + idx;
}

// ---------------------------------------------------------------- trade builders (pure)
// meta: {asset, szDecimals}; returns list of actions to sign & send in order
export function buildOpen({ asset, szDecimals, isBuy, sz, leverage, isCross = false, type, limitPx, markPx, tp, sl,
  slippage = 0.02, tpslSlippage = 0.08, postOnly = false }) {
  const size = roundSz(sz, szDecimals);
  const entryPx = type === 'market' ? slippagePx(markPx, isBuy, slippage, szDecimals) : roundPx(Number(limitPx), szDecimals);
  const wires = [orderWire(asset, { isBuy, limitPx: entryPx, sz: size, reduceOnly: false,
    orderType: { limit: { tif: type === 'market' ? 'Ioc' : (postOnly ? 'Alo' : 'Gtc') } } })];
  for (const [kind, trig] of [['tp', tp], ['sl', sl]]) {
    if (trig == null || trig === '') continue;
    const t = roundPx(Number(trig), szDecimals);
    wires.push(orderWire(asset, { isBuy: !isBuy, limitPx: slippagePx(t, !isBuy, tpslSlippage, szDecimals), sz: size,
      reduceOnly: true, orderType: { trigger: { triggerPx: t, isMarket: true, tpsl: kind } } }));
  }
  return [updateLeverageAction(asset, isCross, Math.trunc(leverage)), orderAction(wires, wires.length > 1 ? 'normalTpsl' : 'na')];
}
export function buildPositionTpsl({ asset, szDecimals, positionIsLong, tp, sl, tpslSlippage = 0.08 }) {
  const wires = [];
  for (const [kind, trig] of [['tp', tp], ['sl', sl]]) {
    if (trig == null || trig === '') continue;
    const t = roundPx(Number(trig), szDecimals);
    wires.push(orderWire(asset, { isBuy: !positionIsLong, limitPx: slippagePx(t, !positionIsLong, tpslSlippage, szDecimals), sz: 0,
      reduceOnly: true, orderType: { trigger: { triggerPx: t, isMarket: true, tpsl: kind } } }));
  }
  if (!wires.length) throw new Error('TP or SL required');
  return orderAction(wires, 'positionTpsl');
}
export function buildClose({ asset, szDecimals, szi, markPx, slippage = 0.02 }) {
  const isBuy = Number(szi) < 0;
  return orderAction([orderWire(asset, { isBuy, limitPx: slippagePx(markPx, isBuy, slippage, szDecimals), sz: roundSz(Math.abs(Number(szi)), szDecimals),
    reduceOnly: true, orderType: { limit: { tif: 'Ioc' } } })]);
}
export const buildCancel = (asset, oid) => cancelAction([{ a: asset, o: Number(oid) }]);
