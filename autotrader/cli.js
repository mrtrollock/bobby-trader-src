#!/usr/bin/env node
// Bobby autotrader CLI. Keys come ONLY from the environment; nothing secret is written to disk or logs.
//   node autotrader/cli.js verify                     # key-permission checks only
//   node autotrader/cli.js status [--since UNIX_MS] [--pf qfex]  # JSON: equity, positions, open orders, SL/TP, fills
//   node autotrader/cli.js once                       # process autotrader/queue.json once
//   node autotrader/cli.js loop                       # process every AUTOTRADER_INTERVAL_S (60) seconds
//   node autotrader/cli.js cancel <arcus|entropy|qfex> <market> <orderId>
//   node autotrader/cli.js close  <arcus|entropy|qfex> <market>
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as C from './core.js';

const DIR = dirname(fileURLToPath(import.meta.url));
const P = { queue: process.env.AUTOTRADER_QUEUE || join(DIR, 'queue.json'), stop: join(DIR, 'STOP'), logs: join(DIR, 'logs'), state: join(DIR, 'state.json') };

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
const loadState = () => { try { return JSON.parse(readFileSync(P.state, 'utf8')); } catch { return { dry: {}, live: {} }; } };
const saveState = (s) => { writeFileSync(P.state + '.tmp', JSON.stringify(s, null, 1)); renameSync(P.state + '.tmp', P.state); };
function readQueue() {
  if (!existsSync(P.queue)) return [];
  const j = JSON.parse(readFileSync(P.queue, 'utf8'));
  return Array.isArray(j) ? j : j.proposals || [];
}

async function boot({ needKeys = true } = {}) {
  const cfg = C.loadConfig(process.env);
  SECRETS = C.secretsOf(cfg);
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
    journalFn({ id: q.id, decision: ok ? 'placed' : 'failed', risk: ev.risk, results: res.map(({ label, status, ok: o, error }) => ({ label, status, ok: o, error })), mode });
    state[mode][q.id] = { status: ok ? 'placed' : 'failed', t: Date.now() };
    delete stCache[pfKey];
    results.push({ id: q.id, status: ok ? 'placed' : 'failed' });
  }
  return results;
}

async function once(ctx) {
  const { cfg, net } = ctx || await boot();
  const state = loadState();
  const out = await processQueue(cfg, net, { queue: readQueue(), state, stopExists: () => existsSync(P.stop) });
  saveState(state);
  return out;
}

async function status(sinceMs, only) {
  const cfg = C.loadConfig(process.env); SECRETS = C.secretsOf(cfg);
  const net = C.realNet(cfg);
  const out = { network: cfg.network, t: Date.now(), since: sinceMs ?? null, dryRun: !cfg.live, enabled: cfg.enabled, stop: existsSync(P.stop), platforms: {} };
  for (const [pf, has] of [['arcus', cfg.arcusAddress], ['entropy', cfg.hlAddress], ['qfex', cfg.qfex]]) {
    if (!has || (only && only !== pf)) continue;
    try {
      const st = await C.accountState(pf, cfg, net, { sinceMs: sinceMs ?? Date.now() - 86400e3 });
      const strip = (x) => { const { raw, ...rest } = x; return rest; };
      out.platforms[pf] = { equity: st.equity, free: st.free, weeklyLoss: st.weeklyLoss, ...(st.deposit != null ? { deposit: st.deposit } : {}),
        positions: st.positions.map((p) => ({ ...strip(p), sl: st.orders.filter((o) => o.market === p.market && o.kind === 'SL').map((o) => o.trig),
          tp: st.orders.filter((o) => o.market === p.market && o.kind === 'TP').map((o) => o.trig) })),
        ...(pf === 'qfex' ? { limits: { weeklyLossCap: cfg.qfex.weeklyLossCap, weeklyRemaining: Math.max(0, cfg.qfex.weeklyLossCap - st.weeklyLoss),
          maxTradeLoss: Math.min(cfg.qfex.maxTradeLossUsd, 0.05 * st.equity, Math.max(0, cfg.qfex.weeklyLossCap - st.weeklyLoss)) } } : {}),
        openOrders: st.orders.map(strip), fills: st.fills, ...(st.stopsKnown !== undefined ? { stopsKnown: st.stopsKnown } : {}) };
    } catch (e) { out.platforms[pf] = { error: redact(e.message) }; }
  }
  console.log(JSON.stringify(out, null, 1));
}

async function reduceCmd(kind, pf, market, oid) {
  if (!C.PLATFORMS.includes(pf)) throw new Error('platform must be arcus, entropy or qfex');
  const { cfg, net } = await boot();
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
  let ctx = await boot(), verifiedAt = Date.now(), stopping = false;
  log('INFO', `loop started (${ctx.cfg.network}, ${ctx.cfg.live ? 'LIVE' : 'DRY RUN'}, every ${every / 1000}s)`);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopping = true; log('INFO', 'stopping on ' + sig); });
  while (!stopping) {
    try {
      if (Date.now() - verifiedAt > 30 * 60e3) { ctx = await boot(); verifiedAt = Date.now(); }
      await once(ctx);
    } catch (e) {
      log('ERROR', 'iteration failed: ' + e.message);
      if (/key|agent|permission|approved|registered|expired|QFEX: (authentication|this API key|could not verify|set QFEX_KEY)/i.test(e.message)) { log('ERROR', 'key check failed, aborting loop'); process.exit(2); }
    }
    for (let t = 0; t < every && !stopping; t += 1000) await new Promise((r) => setTimeout(r, 1000));
  }
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const flag = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  switch (cmd) {
    case 'verify': await boot(); return;
    case 'status': return status(flag('--since') != null ? Number(flag('--since')) : undefined, flag('--pf'));
    case 'once': { const r = await once(); console.log(JSON.stringify(r.map(({ requests, ...x }) => x))); return; }
    case 'loop': return loop();
    case 'cancel': return reduceCmd('cancel', rest[0], rest[1], rest[2]);
    case 'close': return reduceCmd('close', rest[0], rest[1]);
    default: console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 9).join('\n')); process.exitCode = cmd ? 1 : 0;
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e) => { log('ERROR', 'ABORT: ' + e.message); process.exit(2); });
}
