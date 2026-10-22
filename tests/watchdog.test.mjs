// Loop stalls (2026-10-21/22): every network call is bounded by a timeout, a timed-out SEND is reported as "state
// unknown" and never retried blindly, the tick watchdog abandons a tick (its later sends are refused), suspension of the
// whole machine is told apart from a hung request, and tools/supervise.sh restarts a stalled loop. Offline only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import * as API from '../src/api.js';
import * as C from '../autotrader/core.js';
import * as V from '../autotrader/volume.js';
import * as HV from '../autotrader/hlvolume.js';
import * as L from '../src/lowoi.js';

// a fetch that never answers; it only rejects when its AbortSignal fires
const hangingFetch = (seen) => (url, opts = {}) => new Promise((_, rej) => { seen.signal = !!opts.signal; if (opts.signal) opts.signal.addEventListener('abort', () => rej(opts.signal.reason)); });
async function withEnv(env, fn) {
  const prev = {}; for (const k of Object.keys(env)) { prev[k] = process.env[k]; process.env[k] = env[k]; }
  const realFetch = globalThis.fetch; const keep = setInterval(() => {}, 1000); // AbortSignal.timeout timers are unref'd
  try { return await fn(); } finally { clearInterval(keep); globalThis.fetch = realFetch; for (const k of Object.keys(env)) { if (prev[k] == null) delete process.env[k]; else process.env[k] = prev[k]; } }
}

test('Hyperliquid + Arcus reads are bounded by HTTP_READ_TIMEOUT_MS and fail as transient errors', () => withEnv({ HTTP_READ_TIMEOUT_MS: '50' }, async () => {
  const seen = {}; globalThis.fetch = hangingFetch(seen);
  for (const call of [() => API.hlInfo('https://hl.invalid', { type: 'clearinghouseState' }), () => API.arcusGet('https://arcus.invalid', '/v1/account')]) {
    const t = Date.now(); const e = await call().catch((x) => x);
    assert.ok(seen.signal); assert.ok(Date.now() - t < 2000); assert.ok(e instanceof Error); assert.match(e.message, /timed out/);
    assert.equal(e.timeout, true); assert.equal(e.uncertain, undefined); assert.equal(C.isTransientError(e), true);
  }
}));

test('a timed-out order send is "state unknown": C.send reports it (no throw, no retry, nothing after it is sent)', () => withEnv({ HTTP_SEND_TIMEOUT_MS: '50' }, async () => {
  let calls = 0; globalThis.fetch = (u, o) => { calls += 1; return hangingFetch({})(u, o); };
  const net = { sendHl: (d) => API.sendHl('https://hl.invalid', d) };
  const res = await C.send('entropy', [{ label: 'updateLeverage', d: { path: '/exchange', headers: {}, body: '{}' } }, { label: 'entry', d: { path: '/exchange', headers: {}, body: '{}' } }], net);
  assert.equal(calls, 1); assert.equal(res.length, 1);
  assert.equal(res[0].ok, false); assert.equal(res[0].uncertain, true); assert.match(res[0].error, /state unknown/);
  // a non-network error (policy) still throws
  await assert.rejects(C.send('entropy', [{ label: 'x', d: {} }], { sendHl: async () => { throw new Error('refusing: withdraw'); } }), /refusing/);
}));

test('public market-data fetchers (low-OI picks) always pass an AbortSignal', async () => {
  let sig = null; const f = async (u, init) => { sig = init && init.signal; return { ok: true, json: async () => ({ markets: [] }) }; };
  await L.arcusRows('https://arcus.invalid', f).catch(() => {});
  assert.ok(sig && typeof sig.aborted === 'boolean');
});

test('gatedNet: once the tick is abandoned no order/cancel of that tick is sent (HL, Arcus, QFEX); reads still work', async () => {
  const sent = []; const base = { hlInfo: async () => ({ ok: 1 }), sendHl: async (d) => { sent.push('hl'); return { ok: true, status: 200, body: { status: 'ok' } }; },
    sendArcus: async () => { sent.push('arcus'); return { ok: true }; }, qfex: { get: async () => 1, send: async () => { sent.push('qfex'); return [{ ok: true }]; } } };
  const token = {}; const g = C.gatedNet(base, token);
  await g.sendHl({}); await g.qfex.send([]); assert.deepEqual(sent, ['hl', 'qfex']);
  token.abandoned = true;
  await assert.rejects(g.sendHl({}), (e) => e.notSent === true);
  await assert.rejects(g.sendArcus({}), /abandoned/);
  const q = await g.qfex.send([{}]); assert.equal(q[0].ok, false); assert.equal(q[0].notSent, true);
  assert.deepEqual(sent, ['hl', 'qfex']); assert.equal(await g.qfex.get(), 1); assert.deepEqual(await g.hlInfo(), { ok: 1 });
  // through C.send: refused locally, reported as NOT uncertain (nothing left the box)
  const r = await C.send('entropy', [{ label: 'entry', d: {} }], g); assert.equal(r[0].ok, false); assert.equal(r[0].uncertain, false);
});

test('withDeadline: finished, failed and timed-out ticks', async () => {
  assert.deepEqual(await C.withDeadline(Promise.resolve(5), 1000), { done: true, value: 5 });
  const f = await C.withDeadline(Promise.reject(new Error('x')), 1000); assert.equal(f.done, false); assert.equal(f.error.message, 'x');
  let release; const slow = new Promise((r) => { release = r; });
  const t = await C.withDeadline(slow, 20); assert.equal(t.timedOut, true);
  release(7); assert.deepEqual(await t.pending, { done: true, value: 7 });
});

test('watchdogStep: a frozen-timer gap is a suspension (no STALL); a real stall while timers run still alerts', () => {
  const t0 = 1e12, m = {};
  assert.equal(C.watchdogStep(m, t0, t0 + 30e3), null);
  // box frozen for 69 min while a tick was in flight: the next beat is 69 min late
  const s = C.watchdogStep(m, t0, t0 + 30e3 + 69 * 60e3); assert.equal(s.suspended, true); assert.ok(s.gapMs > 60 * 60e3);
  let t = t0 + 30e3 + 69 * 60e3;
  for (let i = 0; i < 9; i++) { t += 30e3; assert.equal(C.watchdogStep(m, t0, t), null); } // idle counted from the resume
  t += 30e3 * 2; const st = C.watchdogStep(m, t0, t); assert.equal(st.stalled, true); // > 5 min after resume, timers running
  t += 30e3; const rec = C.watchdogStep(m, t, t + 1000); assert.equal(rec.recovered, true);
  // normal timers, hung request: STALL after 5 min, never "suspended"
  const m2 = {}; let u = t0; let stalled = false;
  for (let i = 0; i < 12; i++) { u += 30e3; const w = C.watchdogStep(m2, t0, u); assert.ok(!w || !w.suspended); if (w && w.stalled) stalled = true; }
  assert.equal(stalled, true);
});

test('uncertainEntry: only an entry whose order request itself went unanswered', () => {
  const reqs = [{}, {}];
  assert.equal(V.uncertainEntry(reqs, [{ ok: true }, { ok: false, error: 'QFEX: timeout waiting for add_order response (state unknown: run status before retrying)' }]), true);
  assert.equal(HV.uncertainEntry(reqs, [{ ok: true }, { ok: false, uncertain: true, error: 'HL /exchange timed out' }]), true);
  assert.equal(HV.uncertainEntry(reqs, [{ ok: false, uncertain: true, error: 'leverage step' }]), false); // order never sent
  assert.equal(HV.uncertainEntry(reqs, [{ ok: true }, { ok: false, error: 'Post only order would have immediately matched' }]), false);
  assert.equal(HV.uncertainEntry(reqs, [{ ok: true }, { ok: false, uncertain: false, error: 'tick abandoned by the watchdog: not sent' }]), false);
});

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
test('restart reconciliation (Entropy): a position carrying Bobby\'s tagged exit is adopted, never re-entered or duplicated', () => {
  const ENV = { AUTOTRADER_NETWORK: 'mainnet', AUTOTRADER_ENABLED: '1', AUTOTRADER_LIVE: '1', HL_AGENT_PRIVATE_KEY: '0x' + '11'.repeat(32), HL_ACCOUNT_ADDRESS: '0x' + '22'.repeat(20), HL_SUBACCOUNT_ADDRESS: '0x' + '55'.repeat(20), AUTOTRADER_ENTROPY_VOLUME: '1' };
  const VC = HV.loadHlVolumeConfig(ENV);
  const MK = { 'io:OAI': { asset: 110000, szDecimals: 3, maxLev: 6 } };
  const Q = { 'io:OAI': { bid: 379.9, ask: 380.1, mark: 380, depthUsd: 50000, trades: 100 } };
  const pos = { market: 'io:OAI', side: 'long', size: 0.9, entry: 380, mark: 380 };
  const exitO = { id: '2', market: 'io:OAI', side: 'SELL', kind: 'LIMIT', px: 380.4, size: 0.9, reduceOnly: true, raw: { cloid: HV.CID_EXIT + 'b'.repeat(24) } };
  const vs = {}; // state.json lost the phase (fresh state after a kill)
  const r = HV.decideHlVolume({ vc: VC, st: { equity: 300, free: 300, positions: [pos], orders: [exitO], weeklyLoss: 0, dailyLoss: 0 }, mk: MK, quotes: Q, pool: ['io:OAI'], vstate: vs, now: NOW, rng: () => 0.5, limits: { perTrade: 3, weeklyCap: 50, dailyCap: 20 } });
  assert.equal(vs.markets['io:OAI'].phase, 'pos'); assert.ok(r.notes.some((n) => /adopted/.test(n)));
  assert.equal(r.actions.filter((a) => a.kind === 'enter' || a.kind === 'exit').length, 0); // exit already rests, no new entry on a busy market
});

test('restart reconciliation (QFEX): a position with this mode\'s tagged stops is adopted; an untagged one is left alone', () => {
  const cid = (p) => 'b-' + p + '-x1';
  const st = (orders) => ({ equity: 100, free: 100, weeklyLoss: 0, dailyLoss: 0, positions: [{ market: 'NATGAS-USD', side: 'short', size: 10, entry: 3.0, mark: 3.0 }], orders });
  const vstop = { id: 's1', market: 'NATGAS-USD', side: 'BUY', kind: 'SL', stop: true, trig: 3.05, size: 10, reduceOnly: true, clientOrderId: cid(V.VOL_ENTRY), raw: { client_order_id: cid(V.VOL_ENTRY) } };
  const vc = { tpPct: 0.001, slPct: 0.004, maxHoldS: 1800, stalePct: 0.001, requotesPerMin: 3, dailyLossFrac: 0.4, cooldownS: [5, 10], maxMarkets: 1, newPerTick: 1, markets: ['NATGAS-USD'], cancelOrphanStops: true };
  const vs = {};
  const r = V.decideVolume({ vc, st: st([vstop]), refs: {}, fees: {}, quotes: {}, vstate: vs, now: NOW, limits: { perTrade: 3, weeklyCap: 30 } });
  assert.ok(V.isVolStop(vstop), 'fixture must look like a volume-mode stop');
  assert.equal(vs.markets['NATGAS-USD'].phase, 'pos'); assert.ok(r.notes.some((n) => /adopted/.test(n)));
  assert.equal(r.actions.filter((a) => a.kind === 'enter').length, 0);
  const vs2 = {}; const r2 = V.decideVolume({ vc, st: st([]), refs: {}, fees: {}, quotes: {}, vstate: vs2, now: NOW, limits: { perTrade: 3, weeklyCap: 30 } });
  assert.equal(r2.actions.filter((a) => a.kind === 'enter').length, 0);
});

test('loop source: every tick runs through the watchdog with a gated net; exit(3) only when an abandoned tick never settles', () => {
  const src = readFileSync(new URL('../autotrader/cli.js', import.meta.url), 'utf8');
  const loop = src.slice(src.indexOf('async function loop()'), src.indexOf('async function main('));
  assert.match(loop, /C\.gatedNet\(ctx\.net, token\)/); assert.match(loop, /C\.withDeadline\(fn\(tctx\), tickMax\)/);
  assert.match(loop, /runTick\(\(t\) => once\(t,/); assert.match(loop, /C\.watchdogStep\(/);
  assert.equal((loop.match(/process\.exit\(3\)/g) || []).length, 1);
  assert.ok(loop.indexOf('token.abandoned = true') < loop.indexOf('process.exit(3)'));
  assert.match(loop, /lastDone = Date\.now\(\); beat\(\);/);
});

// ---------------------------------------------------------------- supervisor (real bash, fake loop command)
function runSupervisor(dir, loopScript, env = {}) {
  writeFileSync(join(dir, 'fake.env'), 'FAKE_LOOP_ENV=1\n'); chmodSync(join(dir, 'fake.env'), 0o600);
  writeFileSync(join(dir, 'loop.sh'), loopScript);
  const p = spawn('bash', [new URL('../tools/supervise.sh', import.meta.url).pathname], { env: { ...process.env, BOBBY_ENV_FILE: join(dir, 'fake.env'), BOBBY_LOG_DIR: dir, BOBBY_ALERT_FILE: join(dir, 'ALERT'),
    BOBBY_LOOP_CMD: 'bash ' + join(dir, 'loop.sh'), BOBBY_CHECK_S: '1', BOBBY_STALL_RESTART_S: '3', BOBBY_TERM_WAIT_S: '2', BOBBY_RESTART_BACKOFF_S: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  return { p, out: () => out };
}
const until = async (fn, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

test('supervisor: restarts a loop whose heartbeat stopped (graceful TERM first) and passes the env file to it', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bobby-sup-'));
  // fake loop: proves it got the env file, beats twice, then hangs (ignores nothing: TERM ends it)
  const { p, out } = runSupervisor(dir, `echo "run env=$FAKE_LOOP_ENV" >> "${dir}/runs"; date > "$AUTOTRADER_HEARTBEAT_FILE"; sleep 1; date > "$AUTOTRADER_HEARTBEAT_FILE"; exec sleep 600\n`);
  try {
    assert.ok(await until(() => existsSync(join(dir, 'runs')) && readFileSync(join(dir, 'runs'), 'utf8').split('\n').filter(Boolean).length >= 2, 25000), out());
    assert.match(readFileSync(join(dir, 'runs'), 'utf8'), /run env=1/);
    assert.match(out(), /STALL: no tick completed/); assert.match(readFileSync(join(dir, 'ALERT'), 'utf8'), /supervisor-restart/);
  } finally { p.kill('SIGTERM'); await until(() => p.exitCode != null || p.signalCode != null, 5000); }
  assert.ok(!existsSync(join(dir, 'supervisor.pid')));
});

test('supervisor: exit code 2 (key check failed) is NOT restarted; any other exit is', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bobby-sup-'));
  const { p, out } = runSupervisor(dir, `echo x >> "${dir}/runs"; exit 2\n`);
  assert.ok(await until(() => p.exitCode != null, 10000), out()); assert.equal(p.exitCode, 2);
  assert.equal(readFileSync(join(dir, 'runs'), 'utf8').trim().split('\n').length, 1); assert.match(out(), /NOT restarting/);
  const dir2 = mkdtempSync(join(tmpdir(), 'bobby-sup-'));
  const s2 = runSupervisor(dir2, `echo x >> "${dir2}/runs"; exit 1\n`);
  try { assert.ok(await until(() => existsSync(join(dir2, 'runs')) && readFileSync(join(dir2, 'runs'), 'utf8').trim().split('\n').length >= 2, 20000), s2.out()); }
  finally { s2.p.kill('SIGTERM'); await until(() => s2.p.exitCode != null || s2.p.signalCode != null, 5000); }
});
