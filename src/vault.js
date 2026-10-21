// Passphrase vault for published private data (balances): PBKDF2-SHA256 (600k, random 16-byte salt) -> AES-256-GCM
// (random 12-byte IV, AAD = purpose string). Isomorphic WebCrypto: the browser app and Node use this same code;
// balances.py writes the identical format with the `cryptography` package (tests check both directions).
const te = new TextEncoder(), td = new TextDecoder();
export const VAULT_ITER = 600000, VAULT_AAD = 'bobby-balances-v1';
const b64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function key(pass, salt, it) {
  const base = await crypto.subtle.importKey('raw', te.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: it }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function sealJson(obj, pass, { aad = VAULT_AAD, it = VAULT_ITER } = {}) {
  if (!pass || pass.length < 8) throw new Error('passphrase too short');
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, await key(pass, salt, it), te.encode(JSON.stringify(obj))));
  return { v: 1, alg: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', it, aad, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}
export async function openJson(env, pass) {
  if (!env || env.v !== 1 || env.alg !== 'AES-256-GCM' || env.kdf !== 'PBKDF2-SHA256') throw new Error('Unknown file format');
  if (!(env.it >= 300000)) throw new Error('KDF iterations too low');
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.iv), additionalData: te.encode(env.aad || VAULT_AAD) }, await key(pass, unb64(env.salt), env.it), unb64(env.ct));
    return JSON.parse(td.decode(pt));
  } catch { throw new Error('Wrong passphrase'); }
}
