#!/usr/bin/env node
// Bobby autotrader CLI. Keys come ONLY from the environment; nothing secret is written to disk or logs.
//   node autotrader/cli.js verify                     # key-permission checks only
//   node autotrader/cli.js status [--since UNIX_MS] [--pf qfex]  # JSON: equity, positions, open orders, SL/TP, fills
//   node autotrader/cli.js once                       # process autotrader/queue.json once
//   node autotrader/cli.js loop                       # process every AUTOTRADER_INTERVAL_S (60) seconds (+ protection guard, + volume mode if QFEX_VOLUME_MODE=1)
//   node autotrader/cli.js picks [--pf arcus]         # READ-ONLY, no keys: lowest-OI markets that pass the liquidity gate (JSON)
//   node autotrader/cli.js guard                      # READ-ONLY: is every open position protected (SL + TP)? never sends
//   node autotrader/cli.js cancel <arcus|entropy|qfex> <market> <orderId>
//   node autotrader/cli.js close  <arcus|entropy|qfex> <market>
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as C from './core.js';
import * as V from './volume.js';
import * as L from '../src/lowoi.js';

const DIR = dirname(fileURLToPath(import.meta.url));
const P = { queue: process.env.AUTOTRADER_QUEUE || join(DIR, 'queue.json'), stop: join(DIR, 'STOP'), stopVolume: join(DIR, 'STOP_VOLUME'), logs: join(DIR, 'logs'), state: join(DIR, 'state.json'), alert: join(DIR, 'ALERT') };

let SECRETS = [];
const redact = (s) => { let t = String(s); for (const k of SECRETS) if (k) t = t.split(k).join('<redacted>').split(k.replace(/^0x/, '')).join('<redacted>'); return t; };
function log(level, msg, extra) {
  mkdirSync(P.logs, { recursive: true });
  const line = redact(`${new Date().toISOString()} ${level} ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`);
  appendFileSync(join(P.logs, 'autotrader.log'), line + '\n');
  (level === 'ERROR' ? console.error : console.log)(line);
}
function journal(entry) {
  mkdirSync(P.logs, { recursive: true });
  appendFileSync(join(P.logs, 'journal.jsonl'), redact(JSON.stringify({ t: new Date().toISOString(), ...entry })) + '\n');
}
// autotrader/ALERT: JSON lines, newest last; surfaced by balances.py (count + latest) in the encrypted Balances tab.
function alert(entry) { appendFileSync(P.alert, redact(JSON.stringify({ t: new Date().toISOString(), ...entry })) + '\n'); }
const readJournal = () => { try { return readFileSync(join(P.logs, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const loadState = () => { try { return JSON.parse(readFileSync(P.state, 'utf8')); } catch { return { dry: {}, live: {} }; } };
const saveState = (s) => { writeFileSync(P.state + '.tmp', JSON.stringify(s, null, 1)); renameSync(P.state + '.tmp', P.state); };
function readQueue() {
  if (!existsSync(P.queue)) return [];
  const j = JSON.parse(readFileSync(P.queue, 'utf8'));
  return Array.isArray(j) ? j : j.proposals || [];
}

async function boot({ needKeys = true } = {}) {
  const cfg = C.loadConfig(process.env);
  SECRETS = C.secretsOf(cfg).concat([process.env.ARCUS_API_PRIVATE_KEY, process.env.ARCUS_API_KEY].filter(Boolean).map((x) => String(x).trim()));
  for (const [pf, why] of Object.entries(cfg.disabled || {})) log('WARN', `${pf}: ${why}`);
  const net = C.realNet(cfg);
  if (needKeys) {
    if (!cfg.arcus && !cfg.hl && !cfg.qfex) throw new Error('no keys in env (ARCUS_API_PRIVATE_KEY, HL_AGENT_PRIVATE_KEY and/or QFEX_API_PUBLIC_KEY + QFEX_API_SECRET_KEY)');
    const v = await C.verifyKeys(cfg, net);
    log('INFO', `keys verified on ${cfg.network}`, v);
  }
  return { cfg, net };
}

export async function processQueue(cfg, net, { queue, state, stopExists, logFn = log, journalFn = journal }) {
  const mode = cfg.live ? 'live' : 'dry';
  state[mode] ||= {};
  const stCache = {}, results = [];
  for (const q of queue) {
    if (!q || !q.id) { logFn('WARN', 'queue entry without id skipped'); continue; }
    if (state[mode][q.id]) continue;
    let ev;
    try { ev = await C.evaluate(q, cfg, net, stCache); } catch (e) { ev = { ok: false, p: q, reasons: ['evaluation error: ' + e.message] }; }
    if (!ev.ok) {
      logFn('REJECT', `${q.id}: ${ev.reasons.join(' | ')}`);
      journalFn({ id: q.id, decision: 'rejected', reasons: ev.reasons, risk: ev.risk, mode });
      state[mode][q.id] = { status: 'rejected', t: Date.now(), reasons: ev.reasons };
      results.push({ id: q.id, status: 'rejected', reasons: ev.reasons }); continue;
    }
    const kill = C.killReason(cfg, stopExists());
    if (kill) {
      logFn('HOLD', `${q.id}: passes policy but NOT placed (kill switch: ${kill})`);
      journalFn({ id: q.id, decision: 'held', reason: kill, risk: ev.risk, mode });
      results.push({ id: q.id, status: 'held', reason: kill }); continue; // not marked processed: re-evaluated next run
    }
    const reqs = await C.buildOpen(ev, cfg, net);
    const pfKey = ev.p.pf;
    if (!cfg.live) {
      logFn('DRY', `${q.id}: would place ${ev.p.sd} ${ev.ctx.size} ${ev.ctx.market} @ ${ev.p.px} SL ${ev.p.sl} TP ${ev.p.tp} (risk at SL $${ev.risk.slLoss.toFixed(2)})`);
      journalFn({ id: q.id, decision: 'dry-run', risk: ev.risk, requests: C.summarize(reqs), mode });
      state[mode][q.id] = { status: 'dry-run', t: Date.now() };
      // count it as a resting entry so the per-platform position limit also holds within a dry run
      if (stCache[pfKey]) stCache[pfKey].orders.push({ id: 'dry-' + q.id, market: ev.ctx.market, kind: 'LIMIT' });
      results.push({ id: q.id, status: 'dry-run', requests: C.summarize(reqs) }); continue;
    }
    const res = await C.send(pfKey, reqs, net);
    const ok = res.every((x) => x.ok);
    logFn(ok ? 'PLACED' : 'ERROR', `${q.id}: ${res.map((x) => `${x.label}: ${x.ok ? 'ok' : x.error}`).join(' | ')}`);
    journalFn({ id: q.id, decision: ok ? 'placed' : 'failed', plan: { pf: pfKey, market: ev.ctx.market, side: ev.p.sd, size: ev.ctx.size, px: ev.p.px, sl: ev.p.sl, tp: ev.p.tp }, risk: ev.risk, results: res.map(({ label, status, ok: o, error, body }) => ({ label, status, ok: o, error, ...(body ? { echo: C.echoOf(body) } : {}) })), mode });
    state[mode][q.id] = { status: ok ? 'placed' : 'failed', t: Date.now() };
    // Arcus: the market is Bobby's from the moment an entry is sent (even if the reply was an error: fail closed, the
    // guard releases it after 5 min when Bobby has neither a position nor an order there)
    if (pfKey === 'arcus' && cfg.arcusOwn) cfg.arcusOwn[ev.ctx.market] = { t: Date.now(), id: q.id };
    delete stCache[pfKey];
    results.push({ id: q.id, status: ok ? 'placed' : 'failed' });
  }
  return results;
}

async function runGuard(cfg, net, state, { readOnly = false } = {}) {
  state.guard ||= {};
  const quiet = () => {};
  return C.guardTick(cfg, net, state.guard, { live: cfg.live, kill: C.killReason(cfg, existsSync(P.stop)), log, journal: readOnly ? quiet : journal, alert: readOnly ? quiet : alert,
    plans: C.plansFromJournal(readJournal()) }, { readOnly });
}
// Bobby-owned Arcus markets live in state.json (state.guard.__arcusOwn); cfg.arcusOwn points at that object.
const bindOwn = (cfg, state) => { state.guard ||= {}; state.guard.__arcusOwn ||= {}; cfg.arcusOwn = state.guard.__arcusOwn; };
async function once(ctx) {
  const { cfg, net } = ctx || await boot();
  const state = loadState(); bindOwn(cfg, state);
  // guard BEFORE new entries (repairs come first) and again after them (a fill during this tick is seen next tick)
  const guard = await runGuard(cfg, net, state);
  saveState(state);
  const out = await processQueue(cfg, net, { queue: readQueue(), state, stopExists: () => existsSync(P.stop) });
  saveState(state);
  // volume mode (QFEX_VOLUME_MODE=1 only): after the guard; new exposure only while the guard sees QFEX healthy
  let volume = null;
  if (cfg.qfexVol && cfg.qfexVol.enabled) {
    state.volume ||= {};
    const guardOk = !guard.some((g) => g.pf === 'qfex' && ['unknown', 'close', 'attach'].includes(g.kind));
    try { volume = await V.volumeTick(cfg, net, state.volume, { live: cfg.live, kill: C.killReason(cfg, existsSync(P.stop)), log, journal, alert, guardOk, pauseEntries: existsSync(P.stopVolume), accountState: C.accountState }); }
    catch (e) { log('ERROR', 'volume tick failed: ' + e.message); volume = { enabled: true, error: e.message }; }
    saveState(state);
  }
  // hot = re-check soon: an entry is resting (it may fill at any moment) or a position is inside its grace period
  out.hot = guard.some((g) => g.kind === 'grace' || g.resting > 0) || out.some((r) => r.status === 'placed');
  return Object.assign(out, { guard, volume, tickMs: volume ? cfg.qfexVol.tickS * 1000 : null });
}

function volumeStatus(cfg) {
  const vc = cfg.qfexVol; if (!vc) return null;
  const vs = loadState().volume || {};
  return { enabled: vc.enabled, sending: vc.enabled && cfg.enabled && cfg.live, leverage: vc.leverage, maxMarkets: vc.maxMarkets, markets: vc.markets, tpPct: vc.tpPct, slPct: vc.slPct,
    dailyLossStop: +(vc.dailyLossFrac * cfg.qfex.weeklyLossCap).toFixed(2), halted: vs.halted || null, stats: vs.stats || null,
    active: Object.entries(vs.markets || {}).filter(([, m]) => m.phase !== 'idle').map(([k, m]) => ({ market: k, phase: m.phase })) };
}
async function status(sinceMs, only) {
  const cfg = C.loadConfig(process.env); SECRETS = C.secretsOf(cfg); bindOwn(cfg, JSON.parse(JSON.stringify(loadState())));
  const net = C.realNet(cfg);
  const out = { network: cfg.network, t: Date.now(), since: sinceMs ?? null, dryRun: !cfg.live, enabled: cfg.enabled, stop: existsSync(P.stop), platforms: {} };
  for (const [pf, has] of [['arcus', cfg.arcusAddress], ['entropy', cfg.hlAddress], ['qfex', cfg.qfex]]) {
    if (!has || (only && only !== pf)) continue;
    try {
      const st = await C.accountState(pf, cfg, net, { sinceMs: sinceMs ?? Date.now() - 86400e3 });
      const strip = (x) => { const { raw, ...rest } = x; return rest; };
      out.platforms[pf] = { equity: st.equity, free: st.free, weeklyLoss: st.weeklyLoss, ...(st.deposit != null ? { deposit: st.deposit } : {}),
        positions: st.positions.map((p) => { const sl = st.orders.filter((o) => o.market === p.market && o.kind === 'SL').map((o) => o.trig),
          tp = st.orders.filter((o) => o.market === p.market && o.kind === 'TP').map((o) => o.trig);
          return { ...strip(p), sl, tp, protected: sl.length > 0 && tp.length > 0 }; }),
        ...(pf === 'arcus' ? { weeklyLossAccount: st.weeklyLossAccount, bobbyMarkets: st.bobbyMarkets, bobbyWeekFills: st.bobbyWeekFills,
          limits: { weeklyLossCap: 50, weeklyRemaining: Math.max(0, 50 - st.weeklyLoss) } } : {}),
        ...(pf === 'qfex' ? { volume: st.volume, dailyLoss: st.dailyLoss, volumeMode: volumeStatus(cfg) } : {}),
        ...(pf === 'qfex' ? { limits: { weeklyLossCap: cfg.qfex.weeklyLossCap, weeklyRemaining: Math.max(0, cfg.qfex.weeklyLossCap - st.weeklyLoss),
          maxTradeLoss: Math.min(cfg.qfex.maxTradeLossUsd, 0.05 * st.equity, Math.max(0, cfg.qfex.weeklyLossCap - st.weeklyLoss)) } } : {}),
        openOrders: st.orders.map(strip), fills: st.fills, ...(st.stopsKnown !== undefined ? { stopsKnown: st.stopsKnown } : {}) };
    } catch (e) { out.platforms[pf] = { error: redact(e.message) }; }
  }
  console.log(JSON.stringify(out, null, 1));
}

async function reduceCmd(kind, pf, market, oid) {
  if (!C.PLATFORMS.includes(pf)) throw new Error('platform must be arcus, entropy or qfex');
  const { cfg, net } = await boot(); bindOwn(cfg, loadState());
  const reqs = kind === 'cancel' ? await C.buildCancel(pf, market, oid, cfg, net) : await C.buildClose(pf, market, cfg, net);
  const kill = C.killReason(cfg, existsSync(P.stop));
  if (kill) { log('HOLD', `${kind} ${pf} ${market}: not sent (kill switch: ${kill})`); return; }
  if (!cfg.live) { log('DRY', `${kind} ${pf} ${market}: dry run, not sent`, C.summarize(reqs)); journal({ decision: 'dry-run', cmd: kind, pf, market, requests: C.summarize(reqs) }); return; }
  const res = await C.send(pf, reqs, net);
  log(res.every((x) => x.ok) ? 'SENT' : 'ERROR', `${kind} ${pf} ${market}: ${res.map((x) => x.ok ? 'ok' : x.error).join(' | ')}`);
  journal({ decision: 'sent', cmd: kind, pf, market, results: res.map(({ label, status, ok, error }) => ({ label, status, ok, error })) });
}

async function loop() {
  const every = Math.max(15, Number(process.env.AUTOTRADER_INTERVAL_S || 60)) * 1000;
  let ctx = await boot(), verifiedAt = Date.now(), stopping = false, hot = false, volTick = null;
  log('INFO', `loop started (${ctx.cfg.network}, ${ctx.cfg.live ? 'LIVE' : 'DRY RUN'}, every ${every / 1000}s, QFEX volume mode ${ctx.cfg.qfexVol && ctx.cfg.qfexVol.enabled ? 'ON (' + ctx.cfg.qfexVol.leverage + 'x)' : 'off'})`);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopping = true; log('INFO', 'stopping on ' + sig); });
  while (!stopping) {
    try {
      if (Date.now() - verifiedAt > 30 * 60e3) { ctx = await boot(); verifiedAt = Date.now(); }
      const r = await once(ctx); hot = !!(r && r.hot); volTick = r && r.tickMs;
    } catch (e) {
      log('ERROR', 'iteration failed: ' + e.message);
      if (/key|agent|permission|approved|registered|expired|QFEX: (authentication|this API key|could not verify|set QFEX_KEY)/i.test(e.message)) { log('ERROR', 'key check failed, aborting loop'); process.exit(2); }
    }
    // while an entry rests / a fill is staging its stops: re-check every 20 s; volume mode ticks every QFEX_VOL_TICK_S
    const wait = Math.min(hot ? Math.min(every, 20000) : every, volTick || Infinity);
    for (let t = 0; t < wait && !stopping; t += 1000) await new Promise((r) => setTimeout(r, 1000));
  }
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const flag = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  switch (cmd) {
    case 'verify': await boot(); return;
    case 'status': return status(flag('--since') != null ? Number(flag('--since')) : undefined, flag('--pf'));
    case 'once': { const r = await once(); console.log(JSON.stringify({ results: r.map(({ requests, ...x }) => x), guard: r.guard })); return; }
    case 'guard': { // read-only: decisions are computed and printed, nothing is sent, the persisted guard memo is not changed
      const cfg = C.loadConfig(process.env); SECRETS = C.secretsOf(cfg);
      const gs = { guard: JSON.parse(JSON.stringify(loadState().guard || {})) }; bindOwn(cfg, gs);
      const rep = await runGuard(cfg, C.realNet(cfg), gs, { readOnly: true });
      console.log(JSON.stringify(rep, null, 1)); return; }
    case 'picks': { // public market data only; never loads or uses a key
      const pfs = flag('--pf') ? [flag('--pf')] : ['arcus', 'entropy', 'txflow'];
      console.log(JSON.stringify(await L.picks({ env: process.env, platforms: pfs, testnet: process.env.AUTOTRADER_NETWORK === 'testnet' }), null, 1)); return; }
    case 'loop': return loop();
    case 'cancel': return reduceCmd('cancel', rest[0], rest[1], rest[2]);
    case 'close': return reduceCmd('close', rest[0], rest[1]);
    default: console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 10).join('\n')); process.exitCode = cmd ? 1 : 0;
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e) => { log('ERROR', 'ABORT: ' + e.message); process.exit(2); });
}
