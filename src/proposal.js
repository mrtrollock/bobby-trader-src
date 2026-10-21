// Proposal format v1: fragment  #p=v1.<base64url(utf8 JSON)>.<h>   with h = hex(sha256(utf8 JSON))[0:16]
// h only detects corruption/truncation; it is NOT authentication (the user's tap is the security boundary).
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const te = new TextEncoder(), td = new TextDecoder();
export function b64urlEncode(bytes) {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(s); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export const shortHash = (bytes) => bytesToHex(sha256(bytes)).slice(0, 16);

export function encodeProposal(obj) {
  const bytes = te.encode(JSON.stringify({ v: 1, ...obj }));
  return `v1.${b64urlEncode(bytes)}.${shortHash(bytes)}`;
}

// Accepts a full URL, a "#p=..." fragment, "p=..." or the bare "v1.xxx.hash" token
export function extractToken(input) {
  if (!input) return null;
  const s = String(input).trim();
  const m = s.match(/(?:^|[#?&])p=(v1\.[A-Za-z0-9_-]+\.[0-9a-f]{16})/) || s.match(/^(v1\.[A-Za-z0-9_-]+\.[0-9a-f]{16})$/);
  return m ? m[1] : null;
}

const NUM = ['sz', 'lev', 'px', 'ref', 'sl', 'tp', 'exp'];
export function decodeProposal(token) {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('Unknown proposal format');
  const bytes = b64urlDecode(parts[1]);
  if (shortHash(bytes) !== parts[2]) throw new Error('Corrupted proposal (invalid checksum)');
  const p = JSON.parse(td.decode(bytes));
  return validateProposal(p);
}

export function validateProposal(p) {
  const err = (m) => { throw new Error('Invalid proposal: ' + m); };
  if (p.v !== 1) err('version');
  if (!p.id || typeof p.id !== 'string') err('id');
  if (!['arcus', 'hl', 'txflow', 'qfex'].includes(p.pf)) err('platform');
  if (!p.m || typeof p.m !== 'string') err('market');
  const act = p.act || 'open';
  if (!['open', 'tpsl', 'cancel'].includes(act)) err('action');
  if (act === 'cancel' && (p.oid == null || String(p.oid) === '')) err('oid required');
  for (const k of NUM) if (p[k] != null && !Number.isFinite(Number(p[k]))) err(k);
  if (act === 'open') {
    if (!['long', 'short'].includes(p.sd)) err('side (long|short)');
    if (!(Number(p.sz) > 0)) err('size');
    if (!(Number(p.lev) >= 1) || !Number.isInteger(Number(p.lev))) err('leverage');
    if (!['market', 'limit'].includes(p.et)) err('entry type');
    if (p.et === 'limit' && !(Number(p.px) > 0)) err('limit price');
  }
  if (act === 'tpsl' && p.sl == null && p.tp == null) err('TP or SL required');
  if (p.pf === 'txflow' && act === 'tpsl') err('TxFlow TP/SL: set it in the TxFlow app');
  // QFEX: entries only (stops are attached to the entry); cancels/closes are done by the autotrader CLI.
  if (p.pf === 'qfex' && act !== 'open') err('QFEX: only new entries (with SL + TP) are supported in the app');
  if (p.pf === 'qfex' && act === 'open' && (p.et !== 'limit' || p.sl == null || p.tp == null)) err('QFEX entries need a limit price, a stop-loss and a take-profit');
  if (p.exp != null && !(Number(p.exp) > 1e9)) err('expiry');
  return { ...p, act };
}
