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
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('Format de proposition inconnu');
  const bytes = b64urlDecode(parts[1]);
  if (shortHash(bytes) !== parts[2]) throw new Error('Proposition corrompue (empreinte invalide)');
  const p = JSON.parse(td.decode(bytes));
  return validateProposal(p);
}

export function validateProposal(p) {
  const err = (m) => { throw new Error('Proposition invalide: ' + m); };
  if (p.v !== 1) err('version');
  if (!p.id || typeof p.id !== 'string') err('id');
  if (!['arcus', 'hl'].includes(p.pf)) err('plateforme');
  if (!p.m || typeof p.m !== 'string') err('marché');
  const act = p.act || 'open';
  if (!['open', 'tpsl', 'cancel'].includes(act)) err('action');
  if (act === 'cancel' && (p.oid == null || String(p.oid) === '')) err('oid requis');
  for (const k of NUM) if (p[k] != null && !Number.isFinite(Number(p[k]))) err(k);
  if (act === 'open') {
    if (!['long', 'short'].includes(p.sd)) err('sens (long|short)');
    if (!(Number(p.sz) > 0)) err('taille');
    if (!(Number(p.lev) >= 1) || !Number.isInteger(Number(p.lev))) err('levier');
    if (!['market', 'limit'].includes(p.et)) err('type d’entrée');
    if (p.et === 'limit' && !(Number(p.px) > 0)) err('prix limite');
  }
  if (act === 'tpsl' && p.sl == null && p.tp == null) err('TP ou SL requis');
  if (p.exp != null && !(Number(p.exp) > 1e9)) err('expiration');
  return { ...p, act };
}
