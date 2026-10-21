// Entropy volume mode (Hyperliquid HIP-3 dex "io", the Bobby SUBACCOUNT only). OFF unless AUTOTRADER_ENTROPY_VOLUME=1,
// and like every send it also needs AUTOTRADER_ENABLED=1 + AUTOTRADER_LIVE=1, no STOP file, a verified subaccount
// (every request is signed by core.hlSign with vaultAddress = that subaccount) and margin on EntropyIO (margin gate).
// Modeled on the QFEX volume mode (volume.js):
//   idle --cooldown(jitter)--> post-only (Alo) entry at the touch on one of the low-OI picks that pass the liquidity
//        gate, 1x..3x ISOLATED, with SL + backup TP attached on the same order (normalTpsl: active from the fill)
//        --fill--> maker exit: reduce-only Alo limit at +ENTROPY_VOL_TP_PCT --fill--> idle (round trip) ...
//   stale entry -> cancelled + re-quoted (rate-limited); held > ENTROPY_VOL_MAX_HOLD_S -> exit re-quoted at the touch;
//   an exit placed < 45 s ago that is gone while the position still shows -> wait (duplicate-exit guard);
//   flat market with leftover reduce-only triggers of this mode -> cancelled (they could hit a later position).
// Hard limits before EVERY entry: worst loss at the stop incl. fees + stop slippage <= min($3, 1% of capped equity);
// week/day realised loss + open worst case + new <= $50 / $20 (reached -> halted until next week / day); margin <=
// free; isolated liquidation distance >= ENTROPY_VOL_LIQ_MULT x stop distance; notional <= a share of the book depth.
import * as H from '../src/hl.js';
import * as L from '../src/lowoi.js';
import { randomBytes } from 'node:crypto';
import { weekStartUtc } from '../src/risk.js';
import * as C from './core.js';

export const CID_ENTRY = '0xb0bb0e01', CID_EXIT = '0xb0bb0e02';
export const cloid = (prefix, rnd = randomBytes) => prefix + rnd(12).toString('hex'); // 16 bytes = 0x + 32 hex
const up = (x) => String(x || '').toUpperCase();
const cidOf = (o) => String((o.raw && o.raw.cloid) || o.cloid || '').toLowerCase();
export const isHvEntry = (o) => o.kind === 'LIMIT' && !o.reduceOnly && cidOf(o).startsWith(CID_ENTRY);
export const isHvExit = (o) => o.kind === 'LIMIT' && !!o.reduceOnly && cidOf(o).startsWith(CID_EXIT);
export const isTrigger = (o) => ['SL', 'TP', 'TRIGGER'].includes(o.kind);

const numEnv = (env, k, d) => (env[k] != null && env[k] !== '' ? Number(env[k]) : d);
export function loadHlVolumeConfig(env = process.env) {
  const range = (k, d) => { const v = String(env[k] || d).split('-').map(Number); return [v[0], v[1] ?? v[0]]; };
  const vc = {
    enabled: env.AUTOTRADER_ENTROPY_VOLUME === '1',
    leverage: numEnv(env, 'ENTROPY_VOL_LEVERAGE', 3),
    maxMarkets: numEnv(env, 'ENTROPY_VOL_MAX_MARKETS', 2),
    markets: env.ENTROPY_VOL_MARKETS ? String(env.ENTROPY_VOL_MARKETS).split(',').map((s) => s.trim()).filter(Boolean).map((s) => (s.includes(':') ? s : 'io:' + s)) : 'picks',
    tpPct: numEnv(env, 'ENTROPY_VOL_TP_PCT', 0.001),
    tpNetMinPct: numEnv(env, 'ENTROPY_VOL_TP_NET_MIN_PCT', 0.0004),
    slPct: numEnv(env, 'ENTROPY_VOL_SL_PCT', 0.004),
    tpBackupMult: numEnv(env, 'ENTROPY_VOL_TP_BACKUP_MULT', 3),
    // io fees measured on the master's io fills (2026-10-21): maker ~0.0246 %, taker ~0.0298 % (rounded up here)
    maker: numEnv(env, 'ENTROPY_VOL_MAKER_FEE', 0.00025),
    taker: numEnv(env, 'ENTROPY_VOL_TAKER_FEE', 0.0003),
    stopSlippage: numEnv(env, 'ENTROPY_VOL_STOP_SLIPPAGE', 0.002),
    notionalUsd: env.ENTROPY_VOL_NOTIONAL_USD ? Number(env.ENTROPY_VOL_NOTIONAL_USD) : null,
    utilisation: numEnv(env, 'ENTROPY_VOL_UTILISATION', 0.8),
    sizeJitter: numEnv(env, 'ENTROPY_VOL_SIZE_JITTER', 0.15),
    cooldownS: range('ENTROPY_VOL_COOLDOWN_S', '30-120'),
    stalePct: numEnv(env, 'ENTROPY_VOL_STALE_PCT', 0.001),
    maxSpreadPct: numEnv(env, 'ENTROPY_VOL_MAX_SPREAD_PCT', 0.001),
    maxDepthFrac: numEnv(env, 'ENTROPY_VOL_MAX_DEPTH_FRAC', 0.25),
    requotesPerMin: numEnv(env, 'ENTROPY_VOL_REQUOTES_PER_MIN', 3),
    maxHoldS: numEnv(env, 'ENTROPY_VOL_MAX_HOLD_S', 1800),
    liqMult: numEnv(env, 'ENTROPY_VOL_LIQ_MULT', 3),
    newPerTick: numEnv(env, 'ENTROPY_VOL_NEW_PER_TICK', 1),
    minNotional: numEnv(env, 'ENTROPY_VOL_MIN_NOTIONAL_USD', 11),
    picksRefreshS: numEnv(env, 'ENTROPY_VOL_PICKS_REFRESH_S', 600),
    capital: numEnv(env, 'HL_CAPITAL_USD', 300),
    // Hyperliquid unified/portfolio-margin accounts are capped at 50k actions/day: stay far below (entries stop at 80 %)
    maxActionsPerDay: numEnv(env, 'ENTROPY_VOL_MAX_ACTIONS_PER_DAY', 5000),
  };
  const bad = [];
  if (!(Number.isInteger(vc.leverage) && vc.leverage >= 1 && vc.leverage <= 3)) bad.push('ENTROPY_VOL_LEVERAGE must be an integer 1..3');
  if (!(Number.isInteger(vc.maxMarkets) && vc.maxMarkets >= 1 && vc.maxMarkets <= 2)) bad.push('ENTROPY_VOL_MAX_MARKETS must be 1..2');
  if (!(vc.tpPct >= 0.0005 && vc.tpPct <= 0.01)) bad.push('ENTROPY_VOL_TP_PCT must be 0.0005..0.01 (fraction)');
  if (!(vc.slPct >= 0.002 && vc.slPct <= 0.03)) bad.push('ENTROPY_VOL_SL_PCT must be 0.002..0.03 (fraction)');
  if (!(vc.tpBackupMult >= 1.5)) bad.push('ENTROPY_VOL_TP_BACKUP_MULT must be >= 1.5');
  if (!(vc.utilisation > 0 && vc.utilisation <= 0.9)) bad.push('ENTROPY_VOL_UTILISATION must be in (0, 0.9]');
  if (!(vc.sizeJitter >= 0 && vc.sizeJitter <= 0.3)) bad.push('ENTROPY_VOL_SIZE_JITTER must be 0..0.3');
  if (!(vc.liqMult >= 2)) bad.push('ENTROPY_VOL_LIQ_MULT must be >= 2');
  if (!(vc.maxDepthFrac > 0 && vc.maxDepthFrac <= 0.5)) bad.push('ENTROPY_VOL_MAX_DEPTH_FRAC must be in (0, 0.5]');
  if (!(vc.maxHoldS >= 300)) bad.push('ENTROPY_VOL_MAX_HOLD_S must be >= 300 (a short hold was worse on QFEX)');
  if (!(vc.cooldownS[0] >= 10 && vc.cooldownS[1] >= vc.cooldownS[0])) bad.push('ENTROPY_VOL_COOLDOWN_S must be MIN-MAX seconds, MIN >= 10');
  if (!(vc.capital > 0 && vc.capital <= 300)) bad.push('HL_CAPITAL_USD must be > 0 and <= 300');
  if (!(vc.maxActionsPerDay >= 100 && vc.maxActionsPerDay <= 20000)) bad.push('ENTROPY_VOL_MAX_ACTIONS_PER_DAY must be 100..20000 (unified accounts: 50k/day)');
  if (bad.length) throw new Error('Entropy volume mode config: ' + bad.join('; '));
  return vc;
}
// take-profit at least 2 maker fees + a net minimum (0.1 % default vs ~0.05 % round-trip maker fees on io)
export const tpPctFor = (vc) => Math.max(vc.tpPct, 2 * Math.abs(vc.maker) + vc.tpNetMinPct);

// ---------------------------------------------------------------- daily action budget (persisted in vstate)
export const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
export function actionsToday(vstate, now) { const a = vstate.actions; return a && a.day === dayKey(now) ? a.n : 0; }
export function countActions(vstate, now, n) { const d = dayKey(now); if (!vstate.actions || vstate.actions.day !== d) vstate.actions = { day: d, n: 0 }; vstate.actions.n += n; return vstate.actions.n; }

// ---------------------------------------------------------------- sizing / risk for one entry (pure, isolated margin)
export function entryRisk({ isLong, px, qty, vc, szDecimals, maxLev, lev, free, pendingMargin, limits }) {
  const sl = H.roundPx(px * (1 + (isLong ? -vc.slPct : vc.slPct)), szDecimals);
  const notional = qty * px, slDist = Math.abs(px - sl) / px, stopRate = vc.taker + vc.stopSlippage;
  const worstLoss = qty * Math.abs(px - sl) + notional * Math.max(0, vc.maker) + qty * sl * stopRate;
  const margin = notional / lev, mmf = 1 / (2 * (Number(maxLev) || 1));
  const liqDist = 1 / lev - mmf; // isolated: only this position's margin is at stake
  const blocks = [];
  if (worstLoss > limits.perTrade) blocks.push(`worst loss $${worstLoss.toFixed(2)} > per-trade cap $${limits.perTrade.toFixed(2)}`);
  if (worstLoss > limits.weekLeft) blocks.push(`worst loss $${worstLoss.toFixed(2)} > weekly budget left $${limits.weekLeft.toFixed(2)}`);
  if (worstLoss > limits.dayLeft) blocks.push(`worst loss $${worstLoss.toFixed(2)} > daily budget left $${limits.dayLeft.toFixed(2)}`);
  if (margin + pendingMargin > free) blocks.push(`margin $${margin.toFixed(2)} (+ $${pendingMargin.toFixed(2)} resting) > free $${free.toFixed(2)}`);
  if (!(liqDist >= limits.liqMult * slDist)) blocks.push(`liquidation distance ${(liqDist * 100).toFixed(2)}% < ${limits.liqMult}x stop distance`);
  if (lev > maxLev) blocks.push(`leverage ${lev}x > market max ${maxLev}x`);
  if (notional < vc.minNotional) blocks.push(`notional $${notional.toFixed(2)} < minimum $${vc.minNotional}`);
  return { sl, notional, margin, slDist, worstLoss, liqDist, stopRate, blocks };
}

// ---------------------------------------------------------------- pure decision step (unit-tested)
// input: { vc, st (entropy accountState: subaccount, io dex), mk {COIN: {asset, szDecimals, maxLev}}, quotes {COIN: {bid, ask,
//          mark, depthUsd}}, pool [COIN] (low-OI picks in rank order), vstate, now, rng, canEnter, limits {perTrade, weeklyCap, dailyCap} }
// vstate.actions = {day, n}: HL actions sent today; >= 80 % of ENTROPY_VOL_MAX_ACTIONS_PER_DAY -> no new entries, >= 100 % -> nothing
export function decideHlVolume({ vc, st, mk, quotes, pool, vstate, now, rng = Math.random, canEnter = true, limits }) {
  const actions = [], notes = []; vstate.markets ||= {}; vstate.stats ||= { roundTrips: 0, stopsOrOther: 0 };
  const used = actionsToday(vstate, now), cap = vc.maxActionsPerDay || 5000;
  if (used >= cap) return { actions, notes: [`daily action budget used (${used}/${cap}): nothing sent until 00:00 UTC (exchange SL/TP stay)`] };
  if (used >= 0.8 * cap) { canEnter = false; notes.push(`daily action budget at ${used}/${cap}: no new entries until 00:00 UTC`); }
  const ms = vstate.markets, mkt = (s) => ms[s] || (ms[s] = { phase: 'idle', cooldownUntil: 0, requotes: [] });
  const { weeklyCap, dailyCap } = limits;
  if (vstate.halted && now >= vstate.halted.until) { notes.push('halt expired: ' + vstate.halted.reason); delete vstate.halted; }
  if (!vstate.halted && st.weeklyLoss >= weeklyCap) vstate.halted = { reason: `weekly loss $${st.weeklyLoss.toFixed(2)} >= cap $${weeklyCap}`, until: weekStartUtc(now) + 7 * 86400e3, at: now, scope: 'weekly' };
  else if (!vstate.halted && st.dailyLoss >= dailyCap) vstate.halted = { reason: `daily loss $${st.dailyLoss.toFixed(2)} >= daily cap $${dailyCap}`, until: Math.floor(now / 86400e3) * 86400e3 + 86400e3, at: now, scope: 'daily' };
  if (vstate.halted && vstate.halted.at === now) actions.push({ kind: 'halt', ...vstate.halted });
  const byMarket = (s) => ({ pos: st.positions.find((p) => p.market === s), orders: st.orders.filter((o) => o.market === s) });
  const requoteOk = (m) => { m.requotes = (m.requotes || []).filter((t) => now - t < 60e3); return m.requotes.length < vc.requotesPerMin; };
  const cool = () => now + 1000 * (vc.cooldownS[0] + rng() * (vc.cooldownS[1] - vc.cooldownS[0]));
  let openRisk = 0, pendingMargin = 0, active = 0;
  const tracked = new Set([...Object.keys(ms), ...st.orders.filter((o) => isHvEntry(o) || isHvExit(o)).map((o) => o.market)]);
  for (const s of tracked) {
    const m = mkt(s), { pos, orders } = byMarket(s), q = quotes[s] || {}, k = mk[s];
    const entries = orders.filter(isHvEntry), exits = orders.filter(isHvExit), trig = orders.filter(isTrigger);
    const foreign = orders.filter((o) => !isHvEntry(o) && !isHvExit(o) && !isTrigger(o));
    if (pos) {
      if (!['entry', 'pos'].includes(m.phase)) { notes.push(`${s}: position not opened by volume mode, left alone`); continue; }
      active += 1; openRisk += m.risk || 0;
      if (m.phase === 'entry') { m.phase = 'pos'; m.filledAt = now; }
      if (entries.length) { for (const o of entries) actions.push({ kind: 'cancel', market: s, id: o.id, why: 'rest of a partially filled entry (never entry + exit together)' }); continue; }
      if (!k) { notes.push(`${s}: no market metadata, exit not placed`); continue; }
      const isLong = pos.side === 'long', ref = pos.mark || pos.entry;
      if (pos.size * ref < vc.minNotional) { if (!exits.length) actions.push({ kind: 'close', market: s, side: pos.side, qty: pos.size, why: `position $${(pos.size * ref).toFixed(2)} below the minimum order value: close (reduce-only IOC)` }); continue; }
      const held = now - (m.filledAt || now) > vc.maxHoldS * 1000;
      let px = pos.entry * (1 + (isLong ? tpPctFor(vc) : -tpPctFor(vc)));
      if (held && q.bid != null && q.ask != null) px = isLong ? q.ask : q.bid; // re-quote at the touch (still maker)
      else if (isLong && q.ask != null) px = Math.max(px, q.ask); else if (!isLong && q.bid != null) px = Math.min(px, q.bid);
      px = H.roundPx(px, k.szDecimals);
      // duplicate-exit guard: an exit placed moments ago may have filled while the position feed still shows the position
      if (!exits.length && m.exitAt && now - m.exitAt < 45e3) { notes.push(`${s}: exit placed ${Math.round((now - m.exitAt) / 1000)}s ago is gone; waiting for the position feed`); continue; }
      if (!exits.length) { actions.push({ kind: 'exit', market: s, side: pos.side, qty: pos.size, px, why: held ? 'held too long: exit at the touch' : 'take-profit exit (maker)' }); m.exitAt = now; continue; }
      const ex = exits[0];
      if (held && ex.px != null && Math.abs(ex.px - px) / px > vc.stalePct && requoteOk(m)) { m.requotes.push(now); actions.push({ kind: 'cancel', market: s, id: ex.id, why: 'held too long: exit re-quoted at the touch' }); }
      continue;
    }
    // flat market
    for (const o of exits) actions.push({ kind: 'cancel', market: s, id: o.id, why: 'exit left on a flat market' });
    if (m.phase === 'pos') { vstate.stats.roundTrips += 1; m.rt = (m.rt || 0) + 1; m.phase = 'idle'; m.risk = 0; m.margin = 0; m.exitAt = 0; m.cooldownUntil = cool(); }
    if (entries.length) {
      const o = entries[0]; active += 1; m.phase = 'entry'; openRisk += m.risk || 0; pendingMargin += m.margin || 0;
      const isLong = up(o.side) === 'BUY', touch = isLong ? q.bid : q.ask;
      if (!canEnter || vstate.halted) { actions.push({ kind: 'cancel', market: s, id: o.id, why: vstate.halted ? 'halted: ' + vstate.halted.reason : 'new exposure paused' }); m.cancelled = true; continue; }
      if (touch != null && o.px != null && Math.abs(touch - o.px) / o.px > vc.stalePct) {
        if (requoteOk(m)) { m.requotes.push(now); m.cancelled = true; actions.push({ kind: 'cancel', market: s, id: o.id, why: `stale: touch ${touch} vs ${o.px}` }); }
        else notes.push(`${s}: stale entry, re-quote budget used (${vc.requotesPerMin}/min)`);
      }
      continue;
    }
    // leftover reduce-only SL/TP triggers of a finished round trip on a flat market (no entry resting, no other orders)
    if (trig.length && !foreign.length && trig.every((o) => o.reduceOnly)) for (const o of trig) actions.push({ kind: 'cancel', market: s, id: o.id, why: 'orphan SL/TP trigger (market is flat): would otherwise hit a later position' });
    if (m.phase === 'entry') { // entry gone, no position: cancelled by us (re-quote now) or filled + closed between ticks
      m.phase = 'idle'; m.risk = 0; m.margin = 0;
      m.cooldownUntil = m.cancelled ? now : cool();
      if (!m.cancelled) { vstate.stats.stopsOrOther += 1; notes.push(`${s}: entry vanished without a position (filled and closed between ticks?)`); }
    }
    m.cancelled = false;
  }
  if (!canEnter || vstate.halted) return { actions, notes: notes.concat(vstate.halted ? ['halted: ' + vstate.halted.reason] : ['new exposure paused']) };
  const slots = Math.min(vc.maxMarkets - active, vc.newPerTick);
  if (slots <= 0) return { actions, notes };
  const busy = new Set([...st.positions.map((p) => p.market), ...st.orders.map((o) => o.market)]);
  const cands = [];
  for (const s of pool) {
    const q = quotes[s] || {}, m = ms[s] || {}, k = mk[s];
    if (!k || k.isDelisted || busy.has(s) || now < (m.cooldownUntil || 0) || now < (m.blockedUntil || 0)) continue;
    if (!(q.bid > 0 && q.ask > q.bid && q.mark > 0)) continue;
    if ((q.ask - q.bid) / q.mark > vc.maxSpreadPct) { notes.push(`${s}: spread ${((q.ask - q.bid) / q.mark * 100).toFixed(3)}% too wide`); continue; }
    cands.push(s);
  }
  // low-OI picks keep their rank; a little randomness among the top ones (timing/market vary)
  const keyed = cands.map((x, i) => ({ x, r: i + rng() * 1.5 })).sort((a, b) => a.r - b.r).map((k) => k.x);
  let placed = 0;
  const equityCap = Math.min(Math.max(st.equity, 0), vc.capital);
  for (const s of keyed) {
    if (placed >= slots) break;
    const q = quotes[s], m = mkt(s), k = mk[s];
    const lev = Math.min(vc.leverage, Number(k.maxLev) || 1);
    const isLong = m.lastSide ? (rng() < 0.75 ? m.lastSide !== 'long' : m.lastSide === 'long') : rng() < 0.5;
    const px = isLong ? q.bid : q.ask;
    let base = vc.notionalUsd ?? (equityCap * lev * vc.utilisation / vc.maxMarkets);
    if (q.depthUsd > 0) base = Math.min(base, q.depthUsd * vc.maxDepthFrac);
    let qty = H.roundSz(base * (1 + (rng() * 2 - 1) * vc.sizeJitter) / px, k.szDecimals);
    const lim = { perTrade: limits.perTrade, weekLeft: weeklyCap - st.weeklyLoss - openRisk, dayLeft: dailyCap - st.dailyLoss - openRisk, liqMult: vc.liqMult };
    const risk = (qq) => entryRisk({ isLong, px, qty: qq, vc, szDecimals: k.szDecimals, maxLev: k.maxLev, lev, free: st.free, pendingMargin, limits: lim });
    let r = risk(qty);
    if (r.blocks.length && r.worstLoss > 0) { // shrink once to fit the loss budgets
      const room = Math.min(lim.perTrade, lim.weekLeft, lim.dayLeft) / r.worstLoss;
      const q2 = H.roundSz(qty * Math.min(1, room) * 0.98, k.szDecimals);
      if (q2 > 0 && q2 < qty) { qty = q2; r = risk(qty); }
    }
    if (r.blocks.length) { notes.push(`${s}: no entry (${r.blocks.join('; ')})`); continue; }
    const tp = H.roundPx(px * (1 + (isLong ? 1 : -1) * tpPctFor(vc) * vc.tpBackupMult), k.szDecimals);
    actions.push({ kind: 'enter', market: s, side: isLong ? 'long' : 'short', qty, px, sl: r.sl, tp, lev, risk: { worstLoss: +r.worstLoss.toFixed(4), notional: +r.notional.toFixed(2),
      margin: +r.margin.toFixed(2), slDist: +r.slDist.toFixed(5), liqDist: +r.liqDist.toFixed(4), maker: vc.maker, stopRate: r.stopRate } });
    openRisk += r.worstLoss; pendingMargin += r.margin; placed += 1;
  }
  return { actions, notes };
}

// ---------------------------------------------------------------- executor (one tick)
const cache = { picks: null, picksAt: 0, perpDexs: null, perpDexsAt: 0 };
export const _resetCache = () => { cache.picks = null; cache.perpDexs = null; };
async function marketData(cfg, net, vc, coins, env) {
  const now = net.now();
  if (!cache.perpDexs || now - cache.perpDexsAt > 3600e3) { cache.perpDexs = await net.hlInfo({ type: 'perpDexs' }); cache.perpDexsAt = now; }
  if (vc.markets === 'picks' && (!cache.picks || now - cache.picksAt > vc.picksRefreshS * 1000)) {
    try { const p = await (net.picks || L.picks)({ env: { ...env, ENTROPY_PREFER_LOW_OI: env.ENTROPY_PREFER_LOW_OI ?? '1' }, platforms: ['entropy'], testnet: cfg.testnet });
      cache.picks = (((p.platforms || {}).entropy || {}).picks || []).map((x) => ({ market: x.market, depthUsd: Number(x.depthUsd) || null })); cache.picksAt = now; }
    catch (e) { if (!cache.picks) throw e; }
  }
  const pool = vc.markets === 'picks' ? cache.picks.map((x) => x.market) : vc.markets;
  const depth = Object.fromEntries((cache.picks || []).map((x) => [x.market, x.depthUsd]));
  const [meta, ctxs] = await net.hlInfo({ type: 'metaAndAssetCtxs', dex: 'io' });
  const mk = {}, marks = {};
  meta.universe.forEach((u, i) => { mk[u.name] = { asset: H.assetId(u.name, meta.universe, cache.perpDexs), szDecimals: u.szDecimals, maxLev: u.maxLeverage, isDelisted: !!u.isDelisted }; marks[u.name] = Number(ctxs[i].markPx); });
  const quotes = {};
  for (const c of new Set([...pool, ...coins])) {
    if (!mk[c]) continue;
    try { const b = await net.hlInfo({ type: 'l2Book', coin: c }); const bid = b.levels[0][0], ask = b.levels[1][0];
      quotes[c] = { bid: bid ? Number(bid.px) : null, ask: ask ? Number(ask.px) : null, mark: marks[c], depthUsd: depth[c] ?? null }; } catch { /* no quote -> no new entry there */ }
  }
  return { pool, mk, quotes };
}

// io = { live, kill, log, journal, alert, canEnter, accountState, rng, env }
export async function hlVolumeTick(cfg, net, vstate, io) {
  const vc = cfg.hlVol;
  if (!vc || !vc.enabled) return { enabled: false };
  if (!cfg.hl || cfg.hl.subVerified !== true) return { enabled: true, idle: 'Entropy disabled (no verified subaccount)' };
  const st = await io.accountState('entropy', cfg, net);
  const coins = [...new Set([...Object.keys(vstate.markets || {}), ...st.positions.map((p) => p.market), ...st.orders.map((o) => o.market)])];
  const { pool, mk, quotes } = await marketData(cfg, net, vc, coins, io.env || process.env);
  const now = net.now(), caps = C.lossCaps(io.env || process.env).entropy;
  const limits = { perTrade: Math.min(3, caps.maxTradePct * Math.min(Math.max(st.equity, 0), caps.capital)), weeklyCap: caps.weekly, dailyCap: caps.daily };
  const send = io.live && !io.kill;
  const { actions, notes } = decideHlVolume({ vc, st, mk, quotes, pool, vstate, now, rng: io.rng || Math.random, canEnter: io.canEnter !== false && !io.kill, limits });
  const report = { enabled: true, live: send, actions: [], notes, halted: vstate.halted || null, stats: vstate.stats, weeklyLoss: st.weeklyLoss, dailyLoss: st.dailyLoss, pool, marginMode: st.marginMode || null };
  for (const a of actions) {
    if (a.kind === 'halt') { io.log('ALERT', `Entropy volume mode halted: ${a.reason}`); io.alert({ pf: 'entropy', kind: 'volume-halt', reason: a.reason }); report.actions.push(a); continue; }
    if (!send) { report.actions.push({ ...a, sent: false, held: io.kill || 'dry run' }); continue; }
    const m = vstate.markets[a.market], k = mk[a.market];
    let reqs = [];
    try {
      if (!k) throw new Error('no market metadata for ' + a.market);
      const sign = (act) => C.hlSign(cfg, act, net); // vaultAddress = the verified subaccount, always
      if (a.kind === 'enter') {
        const [lev, order] = H.buildOpen({ asset: k.asset, szDecimals: k.szDecimals, isBuy: a.side === 'long', sz: a.qty, leverage: a.lev, isCross: false, type: 'limit', limitPx: a.px,
          markPx: quotes[a.market].mark, tp: a.tp, sl: a.sl, postOnly: true, cloid: cloid(CID_ENTRY) });
        if (lev.isCross !== false || order.grouping !== 'normalTpsl' || order.orders.length !== 3 || order.orders[0].t.limit.tif !== 'Alo' || !order.orders.slice(1).every((w) => w.r === true && w.t.trigger))
          throw new Error('internal: Entropy volume entry is not isolated Alo + SL + TP');
        reqs = [{ label: `updateLeverage ${a.lev}x isolated`, d: sign(lev) }, { label: `volume entry ${a.side} ${a.qty} @ ${a.px} (Alo) SL ${a.sl} TP(backup) ${a.tp}`, d: sign(order) }];
      } else if (a.kind === 'exit') {
        const act = H.buildMakerExit({ asset: k.asset, szDecimals: k.szDecimals, positionIsLong: a.side === 'long', sz: a.qty, px: a.px, cloid: cloid(CID_EXIT) });
        if (act.orders[0].r !== true || act.orders[0].t.limit.tif !== 'Alo') throw new Error('internal: exit is not reduce-only Alo');
        reqs = [{ label: `volume exit ${a.qty} @ ${a.px} (Alo reduce-only)`, d: sign(act) }];
      } else if (a.kind === 'cancel') reqs = [{ label: 'cancel ' + a.id, d: sign(H.buildCancel(k.asset, a.id)) }];
      else if (a.kind === 'close') {
        const act = H.buildClose({ asset: k.asset, szDecimals: k.szDecimals, szi: a.side === 'long' ? a.qty : -a.qty, markPx: quotes[a.market] ? quotes[a.market].mark : null });
        if (!act.orders.every((w) => w.r === true)) throw new Error('internal: close is not reduce-only');
        reqs = [{ label: 'close (reduce-only IOC)', d: sign(act) }];
      }
    } catch (e) { report.actions.push({ ...a, ok: false, error: e.message }); io.log('ERROR', `entropy volume ${a.kind} ${a.market}: ${e.message}`); continue; }
    if (actionsToday(vstate, now) + reqs.length > (vc.maxActionsPerDay || 5000)) { report.actions.push({ ...a, sent: false, held: 'daily action budget' }); continue; }
    const res = await C.send('entropy', reqs, net); countActions(vstate, now, res.length); const ok = res.length === reqs.length && res.every((x) => x.ok);
    const err = res.map((x) => x.error).filter(Boolean).join(' | ');
    if (a.kind === 'enter') {
      if (ok) Object.assign(m, { phase: 'entry', since: now, lastSide: a.side, risk: a.risk.worstLoss, margin: a.risk.margin, cancelled: false });
      else if (/post only|immediately match/i.test(err)) m.cooldownUntil = now + 5e3; // Alo would have crossed: re-quote soon, no alert
      else { m.blockedUntil = now + 10 * 60e3; io.alert({ pf: 'entropy', market: a.market, kind: 'volume-entry-failed', ok: false, reason: err }); }
      io.journal({ id: 'hvol-' + a.market + '-' + now, decision: ok ? 'placed' : 'failed', volume: true, plan: { pf: 'entropy', market: a.market, side: a.side, size: a.qty, px: a.px, sl: a.sl, tp: a.tp },
        risk: a.risk, lev: a.lev, results: res.map(({ label, status, ok: o, error }) => ({ label, status, ok: o, error })), mode: 'live' });
    } else {
      if (a.kind === 'exit' && !ok) { m.exitAt = 0; m.exitFails = (m.exitFails || 0) + 1; if (m.exitFails === 3) io.alert({ pf: 'entropy', market: a.market, kind: 'volume-exit-failed', ok: false, reason: err + ' (the exchange SL/TP still protect the position)' }); }
      if (a.kind === 'exit' && ok) m.exitFails = 0;
      io.journal({ decision: 'volume-' + a.kind, volume: true, pf: 'entropy', market: a.market, why: a.why, ok, error: err || undefined, mode: 'live' });
    }
    io.log(ok ? 'VOLUME' : 'ERROR', `entropy volume ${a.kind} ${a.market}: ${ok ? 'ok' : err} (${a.why || ''})`);
    report.actions.push({ ...a, ok, error: err || undefined });
  }
  return report;
}
