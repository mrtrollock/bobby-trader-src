// TxFlow (L1 perps): public reads for MANUAL mode + a feature-flagged agent-signing stub for later (whitelisted) use.
// Docs: https://docs.txflow.com/api , /api/signing , /api/exchange/approveAgent , /api/info/*
// Manual mode (default): the app never signs anything for TxFlow. It shows the proposal, opens app.txflow.com
// (where the user's own per-device agent key places the order), then checks execution from public /info data.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils.js';
import { encode as mpEncode } from '@msgpack/msgpack';
import { assertTradeOnly } from './risk.js';

export const MAINNET = 'https://rpc.txflow.com';
export const TESTNET = 'https://rpc.txflow-testnet.xyz';
export const APP_URL = 'https://app.txflow.com/';
export const API_VERSION_HEADER = '2026-08-16';
export const NETWORKS = {
  mainnet: { name: 'TxFlow-Mainnet', chainId: 869, apiVersion: 1, signingChainId: 42161 },
  testnet: { name: 'TxFlow-Testnet', chainId: 2511, apiVersion: 1, signingChainId: 421614 },
};
// Agent-key trading needs the mainnet /exchange whitelist (txflow.com/apply). OFF until the user is whitelisted
// and explicitly turns it on in code; the UI never exposes it while false.
export const TXFLOW_AGENT_ENABLED = false;
export const AGENT_NAME = 'bobby';

// ---------------------------------------------------------------- public reads (unsigned POST /info)
export async function info(base, body, fetchFn = fetch) {
  const r = await fetchFn(base + '/info', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-version': API_VERSION_HEADER }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw new Error(`TxFlow ${body.type}: ${j.message || 'HTTP ' + r.status}`);
  return j.data;
}
export const perpMeta = (base, f) => info(base, { type: 'perpMeta', includeDelisted: false }, f);
export async function market(base, name, f) {
  const meta = await perpMeta(base, f);
  const u = (meta.universe || []).find((x) => String(x.name).toUpperCase() === String(name).toUpperCase()
    || String(x.name).toUpperCase() === String(name).toUpperCase() + '-USDC' || String(x.index) === String(name));
  if (!u) throw new Error('Marché TxFlow inconnu: ' + name);
  return u;
}
export const assetCtx = (base, index, f) => info(base, { type: 'activeAssetCtx', coin: String(index) }, f);
export const state = (base, user, f) => info(base, { type: 'clearinghouseState', user, accountType: 'perp' }, f);
export const openOrders = (base, user, f) => info(base, { type: 'frontendOpenOrders', user, limit: 200, offset: 0 }, f);
export const userFees = (base, user, index, f) => info(base, { type: 'userFees', user, asset: String(index) }, f);
// All perp fills in [startMs, endMs), following hasMore pagination (newest first, 2000 per page max).
export async function fills(base, user, startMs, endMs, f) {
  const out = [];
  for (let offset = 0; offset <= 200000; offset += 2000) {
    const d = await info(base, { type: 'userFills', user, accountType: ['perp'], startTimeMs: startMs, endTimeMs: endMs, limit: 2000, offset }, f);
    out.push(...(d.data || []));
    if (!d.hasMore) break;
  }
  return out;
}

// Weekly activity for the points epoch (Mon-Mon UTC): fills, volume, fees, active days, maker share.
export function weeklyActivity(rows, startMs, endMs) {
  const days = new Set(); let volume = 0, fees = 0, maker = 0, n = 0;
  for (const f of rows || []) {
    const t = Number(f.time); if (!(t >= startMs && t < endMs)) continue;
    n++; const ntl = Math.abs(Number(f.px) * Number(f.sz)); volume += ntl; fees += Number(f.fee || 0);
    if (f.tradeSide === 'Maker') maker += ntl; // read tradeSide, never `crossed` (docs: always null)
    days.add(new Date(t).toISOString().slice(0, 10));
  }
  return { fills: n, volume, fees, activeDays: days.size, makerShare: volume ? maker / volume : null };
}

// Execution check without a baseline (manual mode): a resting non-trigger order on that market/side at the limit
// price (±0.5 %), or an open position on that market in the proposal's direction.
export function executedNow(p, st, oo, mk) {
  const sameMk = (x) => String(x.asset ?? x.instrumentId ?? x.coin) === String(mk.index) || String(x.coin).toUpperCase() === String(mk.name).toUpperCase();
  const isBuy = p.sd === 'long';
  const near = (a, b) => Math.abs(Number(a) - Number(b)) <= 0.005 * Math.abs(Number(b));
  const order = (oo || []).find((o) => sameMk(o) && !o.isTrigger && (o.side === 'B') === isBuy && near(o.limitPx, p.px));
  const pos = ((st && st.assetPositions) || []).map((x) => x.position).find((x) => x && sameMk(x) && Number(x.szi) * (isBuy ? 1 : -1) > 0);
  const hasSl = pos ? ((st.assetPositions.find((x) => x.position === pos) || {}).tpsl || []).some((t) => Number(t.slTriggerPrice) > 0)
    || (oo || []).some((o) => sameMk(o) && o.isTrigger && /stop/i.test(String(o.orderType))) : null;
  return { resting: order || null, position: pos || null, hasStopLoss: hasSl, executed: !!(order || pos) };
}

// Deep link: the app's market URL format is not documented, so this opens the trade page and the card shows the
// exact parameters to enter.
export const appLink = () => APP_URL;

// ---------------------------------------------------------------- agent-signing stub (feature-flagged OFF)
const te = new TextEncoder();
const kstr = (s) => keccak_256(te.encode(s));
const u256 = (n) => { const b = new Uint8Array(32); let v = BigInt(n); for (let i = 31; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };
const addr32 = (a) => { const b = new Uint8Array(32); b.set(hexToBytes(String(a).replace(/^0x/, '').toLowerCase()), 12); return b; };
const DOMAIN_TYPEHASH = kstr('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)');
const AGENT_TYPEHASH = kstr('Agent(string txflowNetwork,uint32 chainId,uint32 apiVersion,bytes32 connectionId)');
const APPROVE_TYPEHASH = kstr('ApproveAgent(string txflowNetwork,uint32 chainId,uint32 apiVersion,address agentAddress,string agentName,uint64 nonce)');
export const domainSeparator = (net, chainIdOverride) => keccak_256(concatBytes(DOMAIN_TYPEHASH, kstr(net.name), kstr(String(net.apiVersion)),
  u256(chainIdOverride ?? net.chainId), new Uint8Array(32)));
const digest = (domSep, structHash) => keccak_256(concatBytes(new Uint8Array([0x19, 0x01]), domSep, structHash));
function u64be(n) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n)); return b; }

export function connectionId(action, nonce, vaultAddress = null) {
  const { type, ...body } = action;
  let data = concatBytes(mpEncode(body), u64be(nonce));
  data = vaultAddress == null ? concatBytes(data, new Uint8Array([0])) : concatBytes(data, new Uint8Array([1]), hexToBytes(vaultAddress.replace(/^0x/, '')));
  return keccak_256(data);
}
export function agentSigningHash(action, nonce, net) {
  const cid = connectionId(action, nonce, null);
  const sh = keccak_256(concatBytes(AGENT_TYPEHASH, kstr(net.name), u256(net.chainId), u256(net.apiVersion), cid));
  return digest(domainSeparator(net), sh);
}
function sign(hash, priv) {
  const sig = secp256k1.sign(hash, priv, { prehash: false, format: 'recovered', lowS: true });
  return { r: '0x' + bytesToHex(sig.slice(1, 33)), s: '0x' + bytesToHex(sig.slice(33, 65)), v: 27 + sig[0] };
}
// Post-only limit order (Alo). px/sz must already be strings on the instrument's tick/size grid.
export function orderAction({ asset, isBuy, px, sz, postOnly = true, reduceOnly = false }) {
  return { type: 'order', grouping: 'na', orders: [{ a: Number(asset), b: !!isBuy, p: String(px), s: String(sz), r: !!reduceOnly, t: { limit: { tif: postOnly ? 'Alo' : 'Gtc' } } }] };
}
export function signAgentAction(action, nonce, agentPriv, net) {
  assertTradeOnly('action', action);
  if (action.type === 'approveAgent') throw new Error('approveAgent est signé par le wallet principal, jamais par l’agent');
  return { action, signature: sign(agentSigningHash(action, nonce, net), agentPriv), nonce, vaultAddress: null, signatureChainId: null };
}
// One-time approval of the bot's agent, to be signed by the user's OWN wallet (EIP-1193 eth_signTypedData_v4).
// The private key of the main wallet is never handled by this app.
export function approveAgentTypedData(agentAddress, nonce, net, { signingChainId = net.signingChainId } = {}) {
  return {
    domain: { name: net.name, version: String(net.apiVersion), chainId: signingChainId, verifyingContract: '0x0000000000000000000000000000000000000000' },
    types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
      ApproveAgent: [{ name: 'txflowNetwork', type: 'string' }, { name: 'chainId', type: 'uint32' }, { name: 'apiVersion', type: 'uint32' },
        { name: 'agentAddress', type: 'address' }, { name: 'agentName', type: 'string' }, { name: 'nonce', type: 'uint64' }] },
    primaryType: 'ApproveAgent',
    message: { txflowNetwork: net.name, chainId: net.chainId, apiVersion: net.apiVersion, agentAddress, agentName: AGENT_NAME, nonce },
  };
}
export function approveAgentStructHash(msg) {
  return keccak_256(concatBytes(APPROVE_TYPEHASH, kstr(msg.txflowNetwork), u256(msg.chainId), u256(msg.apiVersion), addr32(msg.agentAddress),
    kstr(msg.agentName ?? ''), u256(msg.nonce)));
}
export const approveAgentSigningHash = (msg, net, chainIdOverride) => digest(domainSeparator(net, chainIdOverride), approveAgentStructHash(msg));

export async function sendAgentAction(base, envelope, { dryRun = true, fetchFn = fetch } = {}) {
  if (!TXFLOW_AGENT_ENABLED) throw new Error('Signature agent TxFlow désactivée (whitelist mainnet requise)');
  if (dryRun) return { dry: true, envelope };
  assertTradeOnly('action', envelope.action);
  const r = await fetchFn(base + '/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-version': API_VERSION_HEADER }, body: JSON.stringify(envelope) });
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
}
