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

test('read health: exponential backoff capped at 2 min, never aborts: alert after > 10 min, repeated every 30 min', () => {
  const h = C.readHealth(); const t0 = 1e12;
  assert.equal(h.degraded, false);
  const waits = []; let r;
  for (let i = 0, t = t0; i < 6; i++) { r = h.fail(t); waits.push(r.waitMs); assert.equal(r.alert, false); assert.equal('abort' in r, false); t += r.waitMs; }
  assert.deepEqual(waits, [15e3, 30e3, 60e3, 120e3, 120e3, 120e3]);
  assert.equal(h.degraded, true);
  assert.equal(h.fail(t0 + 10 * 60e3).alert, false);          // exactly 10 min: still quiet
  r = h.fail(t0 + 10 * 60e3 + 1); assert.equal(r.alert, true); assert.equal(r.long, true); assert.equal(r.waitMs, 120e3); // > 10 min: alert, keep retrying
  assert.equal(h.fail(t0 + 12 * 60e3).alert, false);          // no alert spam
  assert.equal(h.fail(t0 + 40 * 60e3).alert, false);
  assert.equal(h.fail(t0 + 40 * 60e3 + 2).alert, true);       // repeated after 30 min
  for (let k = 0; k < 100; k++) assert.ok(h.fail(t0 + 41 * 60e3 + k * 120e3).waitMs <= 120e3); // hours later: still retrying
  const rec = h.ok(t0 + 300 * 60e3); assert.equal(rec.alerted, true); assert.equal(h.degraded, false);
  // a recovery resets the window: a new blip starts from scratch, no alert
  r = h.fail(t0 + 400 * 60e3); assert.deepEqual([r.waitMs, r.alert, r.long], [15e3, false, false]);
  assert.equal(h.ok(t0 + 401 * 60e3).alerted, false);
});

test('intermittent blips never alert as long as reads recover in between', () => {
  const h = C.readHealth(); let t = 1e12;
  for (let i = 0; i < 50; i++) { assert.equal(h.fail(t).alert, false); t += 15e3; h.ok(t); t += 60e3; }
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

test('a tick where the guard read worked but a later read failed backs off without moving toward the alert', () => {
  const h = C.readHealth(); const t0 = 1e12; let t = t0, r;
  for (let i = 0; i < 12; i++) { r = h.fail(t, { partial: true }); assert.equal(r.alert, false); t += r.waitMs; }
  assert.ok(t - t0 > 10 * 60e3); assert.equal(r.waitMs, 120e3); assert.equal(h.degraded, true);
  assert.equal(h.fail(t + 1000).alert, false); // a full failure starts the 10-min window from the last partial success
});

test('readHealth.pace: slower ticks for 15 min after any read failure, normal speed when quiet', () => {
  const h = C.readHealth(); const t0 = 1e12;
  assert.equal(h.pace(t0), 0);
  h.fail(t0); h.ok(t0 + 30e3);
  assert.equal(h.pace(t0 + 31e3), 45e3);
  assert.equal(h.pace(t0 + 14 * 60e3), 45e3);
  assert.equal(h.pace(t0 + 15 * 60e3 + 1), 0);
  const g = C.readHealth({ slowMs: 60e3, coolMs: 60e3 }); g.fail(t0, { partial: true });
  assert.equal(g.pace(t0 + 59e3), 60e3); assert.equal(g.pace(t0 + 61e3), 0);
});

test('isTransientError: a WebSocket handshake rejected with HTTP 403/5xx is transient (14:32Z key re-check abort)', () => {
  assert.equal(C.isTransientError(new Error('QFEX: authentication failed (trade WebSocket refused the API key: Unexpected server response: 403)')), true);
  assert.equal(C.isTransientError(new Error('QFEX: trade WebSocket read failed after retries (QFEX: authentication failed (trade WebSocket refused the API key: Unexpected server response: 503))')), true);
  assert.equal(C.isTransientError(new Error('QFEX: this API key has all-accounts scope')), false);
});

test('loop source: the long-outage path alerts and never exits (no process.exit after health.fail)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../autotrader/cli.js', import.meta.url), 'utf8');
  const blk = src.slice(src.indexOf('const h = health.fail('), src.indexOf('for (let t = 0; t < wait'));
  assert.ok(blk.length > 100); assert.equal(/process\.exit/.test(blk), false);
  assert.match(blk, /kind: 'reads-down'/); assert.match(blk, /kind: 'reads-recovered'/);
});
