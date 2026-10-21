// Loop resilience: transient QFEX 401/403/5xx/network failures are retried with backoff instead of aborting the loop
// (incident 2026-10-21: an empty-body 403 during a QFEX outage killed the loop), plus the stall watchdog and the
// bounded REST timeout. Pure helpers + mocked network only.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Q from '../src/qfex.js';
import * as C from '../autotrader/core.js';

test('transient vs definitive errors', () => {
  for (const m of ['QFEX: key cannot read positions of its account (HTTP 403); tick "View positions"', 'QFEX GET /user/trade: HTTP 403 {}',
    'QFEX GET /user/positions: HTTP 401 {"error":"invalid HMAC signature"}', 'QFEX GET /refdata: HTTP 503 {}', 'fetch failed',
    'The operation was aborted due to timeout', 'QFEX: WebSocket connect timeout', 'QFEX: timeout waiting for authentication', 'HTTP 429 {}'])
    assert.equal(C.isTransientError(new Error(m)), true, m);
  for (const m of ['QFEX: this API key can list all your accounts ("All accounts" scope...)', 'QFEX: the key accepted a foreign account id; refusing',
    'QFEX: could not verify the key scope (foreign account answered HTTP 404); aborting on doubt', 'QFEX: set QFEX_ACCOUNT_ID to the UUID',
    'Arcus: this API key is not registered for ARCUS_ACCOUNT_ADDRESS', 'QFEX GET /user/positions: HTTP 400 {}'])
    assert.equal(C.isTransientError(new Error(m)), false, m);
});

test('a 403 on the positions probe during verify is classified transient; a definitive scope finding is not', async () => {
  const cfg = { qfex: { ack: true, accountId: 'acc' } };
  const net403 = { qfex: { getRaw: async () => ({ ok: false, status: 403, body: {} }) } };
  const e1 = await C.verifyQfex(cfg, net403).catch((e) => e);
  assert.match(e1.message, /HTTP 403/); assert.equal(C.isTransientError(e1), true);
  const netAll = { qfex: { getRaw: async () => ({ ok: true, status: 200, body: {} }) } };
  const e2 = await C.verifyQfex(cfg, netAll).catch((e) => e);
  assert.match(e2.message, /All accounts/); assert.equal(C.isTransientError(e2), false);
});

test('read health: exponential backoff capped below the stall watchdog, abort only after > 10 min of continuous failures', () => {
  const h = C.readHealth(); const t0 = 1e12;
  assert.equal(h.degraded, false);
  const waits = []; let r;
  for (let i = 0, t = t0; i < 6; i++) { r = h.fail(t); waits.push(r.waitMs); assert.equal(r.abort, false); t += r.waitMs; }
  assert.deepEqual(waits, [15e3, 30e3, 60e3, 120e3, 240e3, 240e3]);
  assert.ok(waits.every((w) => w < 5 * 60e3));
  assert.equal(h.degraded, true);
  assert.equal(h.fail(t0 + 10 * 60e3).abort, false);         // exactly 10 min: still retrying
  assert.equal(h.fail(t0 + 10 * 60e3 + 1).abort, true);      // > 10 min in a row: real problem
  const rec = h.ok(t0 + 11 * 60e3); assert.equal(rec.n, 8); assert.equal(h.degraded, false);
  // a recovery resets the window: a new blip starts from scratch
  assert.deepEqual([h.fail(t0 + 20 * 60e3).waitMs, h.fail(t0 + 20 * 60e3).abort], [15e3, false]);
});

test('intermittent blips never abort as long as reads recover in between', () => {
  const h = C.readHealth(); let t = 1e12;
  for (let i = 0; i < 50; i++) { assert.equal(h.fail(t).abort, false); t += 15e3; h.ok(t); t += 60e3; }
});

test('stall watchdog: one ERROR after 5 min without a finished tick, repeated every 15 min, then recovery', () => {
  const m = {}; const t0 = 1e12;
  assert.equal(C.stallCheck(m, t0, t0 + 4 * 60e3), null);
  assert.equal(C.stallCheck(m, t0, t0 + 5 * 60e3), null);
  const a = C.stallCheck(m, t0, t0 + 5 * 60e3 + 1000); assert.equal(a.stalled, true);
  assert.equal(C.stallCheck(m, t0, t0 + 10 * 60e3), null);
  assert.equal(C.stallCheck(m, t0, t0 + 21 * 60e3).stalled, true);
  const t1 = t0 + 22 * 60e3; assert.equal(C.stallCheck(m, t1, t1 + 1000).recovered, true);
  assert.equal(C.stallCheck(m, t1, t1 + 2000), null);
});

test('QFEX REST calls are bounded by a timeout (a hanging request cannot freeze the loop)', async () => {
  const realFetch = globalThis.fetch; const prev = process.env.QFEX_HTTP_TIMEOUT_MS;
  process.env.QFEX_HTTP_TIMEOUT_MS = '50';
  let sawSignal = false;
  globalThis.fetch = (url, opts) => new Promise((_, rej) => { sawSignal = !!opts.signal; opts.signal.addEventListener('abort', () => rej(opts.signal.reason)); });
  try {
    const net = Q.makeNet(Q.MAINNET, null, {});
    const keep = setTimeout(() => {}, 3000); // AbortSignal.timeout timers are unref'd: keep the test process alive
    const t = Date.now(); const e = await net.publicGet('/refdata').catch((x) => x); clearTimeout(keep);
    assert.ok(sawSignal); assert.ok(Date.now() - t < 2000); assert.ok(e instanceof Error);
    assert.equal(C.isTransientError(e), true, e.message);
  } finally { globalThis.fetch = realFetch; if (prev == null) delete process.env.QFEX_HTTP_TIMEOUT_MS; else process.env.QFEX_HTTP_TIMEOUT_MS = prev; }
});

test('a tick where the guard read worked but a later read failed backs off without moving toward the abort', () => {
  const h = C.readHealth(); const t0 = 1e12; let t = t0, r;
  for (let i = 0; i < 12; i++) { r = h.fail(t, { partial: true }); assert.equal(r.abort, false); t += r.waitMs; }
  assert.ok(t - t0 > 10 * 60e3); assert.equal(r.waitMs, 240e3); assert.equal(h.degraded, true);
  assert.equal(h.fail(t + 1000).abort, false); // a full failure starts the 10-min window from the last partial success
});
