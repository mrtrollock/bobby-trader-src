// Keystore: secrets are always encrypted with a PIN (PBKDF2-SHA256, 600k iterations -> AES-256-GCM, WebCrypto),
// then stored in this origin's IndexedDB. Nothing is synced anywhere.
const ITER = 600000;
const KS_KEY = 'tgtrade_ks_v1';
const te = new TextEncoder(), td = new TextDecoder();
const b64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(pin, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', te.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function encryptSecrets(obj, pin, iterations = ITER) {
  if (iterations < 300000) throw new Error('iterations too low');
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pin, salt, iterations);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(KS_KEY) }, key, te.encode(JSON.stringify(obj))));
  return JSON.stringify({ v: 1, kdf: 'PBKDF2-SHA256', it: iterations, salt: b64(salt), iv: b64(iv), ct: b64(ct) });
}
export async function decryptSecrets(blob, pin) {
  const o = JSON.parse(blob);
  const key = await deriveKey(pin, unb64(o.salt), o.it);
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(o.iv), additionalData: te.encode(KS_KEY) }, key, unb64(o.ct));
    return JSON.parse(td.decode(pt));
  } catch { throw new Error('Wrong PIN'); }
}

// ---------------------------------------------------------------- backends
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('tgtrade', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
export const IDB = {
  name: 'IndexedDB',
  async get(k) { const db = await idb(); return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result ?? null); q.onerror = () => rej(q.error); }); },
  async set(k, v) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(true); t.onerror = () => rej(t.error); }); },
  async del(k) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').delete(k); t.oncomplete = () => res(true); t.onerror = () => rej(t.error); }); },
};
// Plain browser build: secrets and the trade log live in this origin's IndexedDB only (never a server, never cloud sync).
export async function secureBackend() { return IDB; }
export async function deviceBackend() { return IDB; } // trade log + settings (non-secret)

export async function hasKeystore() { return !!(await (await secureBackend()).get(KS_KEY)); }
export async function saveKeystore(obj, pin) { const b = await secureBackend(); await b.set(KS_KEY, await encryptSecrets(obj, pin)); return b.name; }
export async function loadKeystore(pin) { const blob = await (await secureBackend()).get(KS_KEY); if (!blob) throw new Error('No keys saved'); return decryptSecrets(blob, pin); }
export async function wipeKeystore() {
  const b = await secureBackend(); await b.del(KS_KEY);
  try { await IDB.del(KS_KEY); } catch { /* ignore */ }
}
