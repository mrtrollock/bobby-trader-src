// Keystore: secrets are always encrypted with a PIN (PBKDF2-SHA256, 600k iterations -> AES-256-GCM, WebCrypto),
// then stored in Telegram SecureStorage (Bot API >= 9.0, iOS/Android keychain/keystore) or IndexedDB as fallback.
// Telegram CloudStorage is never used.
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
  } catch { throw new Error('PIN incorrect'); }
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
function tgBackend(api, name) {
  const p = (fn) => new Promise((res, rej) => { try { fn((err, v) => (err ? rej(new Error(String(err))) : res(v))); } catch (e) { rej(e); } });
  return {
    name,
    get: (k) => p((cb) => api.getItem(k, (e, v) => cb(e, v || null))),
    set: (k, v) => p((cb) => api.setItem(k, v, cb)),
    del: (k) => p((cb) => api.removeItem(k, cb)),
  };
}
const tg = () => (typeof window !== 'undefined' && window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData ? window.Telegram.WebApp : null);

let _secure = null;
export async function secureBackend() {
  if (_secure) return _secure;
  const w = tg();
  if (w && w.isVersionAtLeast && w.isVersionAtLeast('9.0') && w.SecureStorage) {
    const b = tgBackend(w.SecureStorage, 'Telegram SecureStorage');
    try { await b.get(KS_KEY); return (_secure = b); } catch { /* UNSUPPORTED on this client -> fallback */ }
  }
  return (_secure = IDB);
}
let _dev = null;
export async function deviceBackend() { // trade log (non-secret)
  if (_dev) return _dev;
  const w = tg();
  if (w && w.isVersionAtLeast && w.isVersionAtLeast('9.0') && w.DeviceStorage) {
    const b = tgBackend(w.DeviceStorage, 'Telegram DeviceStorage');
    try { await b.get('tgtrade_probe'); return (_dev = b); } catch { /* fallback */ }
  }
  return (_dev = IDB);
}

export async function hasKeystore() { return !!(await (await secureBackend()).get(KS_KEY)); }
export async function saveKeystore(obj, pin) { const b = await secureBackend(); await b.set(KS_KEY, await encryptSecrets(obj, pin)); return b.name; }
export async function loadKeystore(pin) { const blob = await (await secureBackend()).get(KS_KEY); if (!blob) throw new Error('Aucune clé enregistrée'); return decryptSecrets(blob, pin); }
export async function wipeKeystore() {
  const b = await secureBackend(); await b.del(KS_KEY);
  try { await IDB.del(KS_KEY); } catch { /* ignore */ }
}
