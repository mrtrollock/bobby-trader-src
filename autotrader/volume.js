// QFEX volume mode (DISABLED unless QFEX_VOLUME_MODE=1, and like every send it also needs AUTOTRADER_ENABLED=1 +
// AUTOTRADER_LIVE=1 and no STOP file). Runs inside the loop after the protection guard.
//
// Styles (QFEX_VOL_STYLE=maker|taker, or QFEX_VOL_TAKER=1 for taker). Default: maker (Season 0).
//
// Maker (Season 0) — per market (at most QFEX_VOL_MAX_MARKETS, one position per market, never entry+exit together):
//   idle --cooldown(jitter)--> ALO entry at the touch (+ attached protective stop_loss and a farther backup take_profit)
//        --fill--> maker exit: ALO reduce-only limit at +QFEX_VOL_TP_PCT  --fill--> idle (round trip) ...
//   stale entry (touch moved > QFEX_VOL_STALE_PCT) -> cancelled and re-quoted (rate-limited per market);
//   held > QFEX_VOL_MAX_HOLD_S -> the exit is re-quoted at the touch (still maker); the exchange stop-loss stays.
//
// Taker (Loss Refunds, $100k/week TAKER notional Mon–Mon UTC) — one market at a time by default (CL preferred):
//   idle --cooldown--> LIMIT IOC entry through the touch (+ hard SL + backup TP) --fill--> immediate close_position
//   (engine LIMIT IOC flatten). No resting maker book from this mode → no self-match; exchange STP still applies.
//   Live taker sends are HARD-BLOCKED until QFEX_VOL_TAKER_ARM_UTC (default 2026-11-02T00:00:00Z).
//
// Hard limits checked before EVERY entry: worst loss at the stop incl. fees + slippage <= QFEX_MAX_TRADE_LOSS_USD;
// realised week loss incl. fees + open worst-case + new <= weekly cap (maker: QFEX_WEEKLY_LOSS_CAP_USD; taker:
// QFEX_VOL_TAKER_WEEKLY_LOSS_CAP_USD or shared); same for the day; margin <= free collateral; liquidation distance
// >= QFEX_VOL_LIQ_MULT x stop distance; leverage set per market and read back; guard state healthy; market in its
// regular session for the next 15 min. Protective stops are never cancelled; only ORPHANED stops of this mode
// (their market is flat, no resting entry) are removed so they cannot hit a later position.
import * as Q from '../src/qfex.js';
import { weekStartUtc } from '../src/risk.js';
import { POLICY } from '../src/risk.js';

export const VOL_ENTRY = 'vol', VOL_EXIT = 'vx'; // client_order_id prefixes: b-vol-…, b-vx-…
// Loss Refunds taker mode must not go live before this (Mon 2 Nov 2026 00:00 UTC). Override with QFEX_VOL_TAKER_ARM_UTC.
export const TAKER_ARM_UTC_DEFAULT = '2026-11-02T00:00:00.000Z';
export const TAKER_TARGET_WEEK_USD = 100_000;
const up = (x) => String(x || '').toUpperCase();
const cidOf = (o) => String((o.raw && o.raw.client_order_id) || '');
export const isVolEntry = (o) => cidOf(o).startsWith('b-' + VOL_ENTRY + '-') && !o.stop && o.kind === 'LIMIT';
export const isVolExit = (o) => cidOf(o).startsWith('b-' + VOL_EXIT + '-') && !o.stop;
export const isVolStop = (o) => !!o.stop && cidOf(o).startsWith('b-' + VOL_ENTRY + '-');

const numEnv = (env, k, d) => (env[k] != null && env[k] !== '' ? Number(env[k]) : d);
export function loadVolumeConfig(env = process.env) {
  const range = (k, d) => { const v = String(env[k] || d).split('-').map(Number); return [v[0], v[1] ?? v[0]]; };
  const styleRaw = String(env.QFEX_VOL_STYLE || (env.QFEX_VOL_TAKER === '1' ? 'taker' : 'maker')).toLowerCase().trim();
  const style = styleRaw === 'taker' ? 'taker' : 'maker';
  const takerDefaults = style === 'taker';
  // Taker ignores maker QFEX_VOL_MARKETS (often US100-heavy); use QFEX_VOL_TAKER_MARKETS or CL-USD.
  const marketsEnv = takerDefaults
    ? (env.QFEX_VOL_TAKER_MARKETS != null && env.QFEX_VOL_TAKER_MARKETS !== '' ? env.QFEX_VOL_TAKER_MARKETS : 'CL-USD')
    : env.QFEX_VOL_MARKETS;
  const markets = (!marketsEnv || String(marketsEnv).toUpperCase() === 'AUTO')
    ? (takerDefaults ? ['CL-USD'] : 'auto')
    : String(marketsEnv).split(',').map((s) => s.trim()).filter(Boolean).map((s) => Q.normSymbol(s));
  const notionalRange = range('QFEX_VOL_TAKER_NOTIONAL_USD', '800-2000');
  const vc = {
    enabled: env.QFEX_VOLUME_MODE === '1',
    style,
    // Hard arm gate for live taker sends (ISO UTC). Before this instant, style=taker still decides/logs but never sends.
    takerArmUtc: String(env.QFEX_VOL_TAKER_ARM_UTC || TAKER_ARM_UTC_DEFAULT),
    takerTargetWeekUsd: numEnv(env, 'QFEX_VOL_TAKER_TARGET_USD', TAKER_TARGET_WEEK_USD),
    leverage: numEnv(env, 'QFEX_LEVERAGE', 5),
    // Taker defaults to 1 market (CL); don't inherit maker's QFEX_VOL_MAX_MARKETS=3.
    maxMarkets: numEnv(env, takerDefaults ? 'QFEX_VOL_TAKER_MAX_MARKETS' : 'QFEX_VOL_MAX_MARKETS', takerDefaults ? 1 : 3),
    markets,
    tpPct: numEnv(env, 'QFEX_VOL_TP_PCT', 0.001),
    // fee floor for the take-profit: per market TP = max(QFEX_VOL_TP_PCT, 2 x maker fee + this). With 0.02 % maker a
    // 0.04 % TP would net zero, so those markets keep 0.08 %; 0-maker markets (CL) can use the tighter TP.
    tpNetMinPct: numEnv(env, 'QFEX_VOL_TP_NET_MIN_PCT', 0.0004),
    slPct: numEnv(env, 'QFEX_VOL_SL_PCT', 0.004),
    tpBackupMult: numEnv(env, 'QFEX_VOL_TP_BACKUP_MULT', takerDefaults ? 5 : 3),
    notionalUsd: env.QFEX_VOL_NOTIONAL_USD ? Number(env.QFEX_VOL_NOTIONAL_USD) : null,
    // Taker sprint size band (used when style=taker and QFEX_VOL_NOTIONAL_USD unset)
    notionalMinUsd: notionalRange[0],
    notionalMaxUsd: notionalRange[1],
    utilisation: numEnv(env, 'QFEX_VOL_UTILISATION', 0.8),
    sizeJitter: numEnv(env, 'QFEX_VOL_SIZE_JITTER', 0.15),
    cooldownS: range('QFEX_VOL_COOLDOWN_S', takerDefaults ? '5-25' : '20-90'),
    dailyLossFrac: numEnv(env, 'QFEX_VOL_DAILY_LOSS_FRAC', 0.4),
    // Mode-specific caps (taker Loss Refunds). Maker keeps using cfg.qfex.weeklyLossCap from env.
    takerWeeklyCap: env.QFEX_VOL_TAKER_WEEKLY_LOSS_CAP_USD != null && env.QFEX_VOL_TAKER_WEEKLY_LOSS_CAP_USD !== ''
      ? Number(env.QFEX_VOL_TAKER_WEEKLY_LOSS_CAP_USD) : 85,
    takerDailyCap: env.QFEX_VOL_TAKER_DAILY_LOSS_CAP_USD != null && env.QFEX_VOL_TAKER_DAILY_LOSS_CAP_USD !== ''
      ? Number(env.QFEX_VOL_TAKER_DAILY_LOSS_CAP_USD) : null, // null -> dailyLossFrac * takerWeeklyCap
    stalePct: numEnv(env, 'QFEX_VOL_STALE_PCT', 0.0005),
    maxSpreadPct: numEnv(env, 'QFEX_VOL_MAX_SPREAD_PCT', takerDefaults ? 0.001 : 0.0005),
    requotesPerMin: numEnv(env, 'QFEX_VOL_REQUOTES_PER_MIN', 3),
    maxHoldS: numEnv(env, 'QFEX_VOL_MAX_HOLD_S', takerDefaults ? 30 : 1800),
    liqMult: numEnv(env, 'QFEX_VOL_LIQ_MULT', 3),
    tickS: Math.max(5, numEnv(env, 'QFEX_VOL_TICK_S', takerDefaults ? 8 : 15)),
    newPerTick: numEnv(env, 'QFEX_VOL_NEW_PER_TICK', 1),
    cancelOrphanStops: env.QFEX_VOL_CANCEL_ORPHAN_STOPS !== '0',
    // maker: tie-break among equally cheap markets. taker: prefer CL (0.6bps); avoid US100/US500 (5bps).
    prefer: String(env.QFEX_VOL_PREFER || (takerDefaults ? 'CL-USD' : 'US100-USD,US500-USD')).split(',').map((x) => x.trim()).filter(Boolean).map((x) => Q.normSymbol(x)),
    avoid: String(env.QFEX_VOL_AVOID != null ? env.QFEX_VOL_AVOID : (takerDefaults ? 'US100-USD,US500-USD' : '')).split(',').map((x) => x.trim()).filter(Boolean).map((x) => Q.normSymbol(x)),
  };
  const bad = [];
  if (!(Number.isInteger(vc.leverage) && vc.leverage >= 1 && vc.leverage <= Q.MAX_VOLUME_LEVERAGE)) bad.push(`QFEX_LEVERAGE must be an integer 1..${Q.MAX_VOLUME_LEVERAGE}`);
  if (!(vc.maxMarkets >= 1 && vc.maxMarkets <= 5)) bad.push('QFEX_VOL_MAX_MARKETS must be 1..5');
  if (!(vc.tpPct >= 0.0003 && vc.tpPct <= 0.01)) bad.push('QFEX_VOL_TP_PCT must be 0.0003..0.01 (fraction)');
  if (!(vc.slPct >= 0.001 && vc.slPct <= 0.03)) bad.push('QFEX_VOL_SL_PCT must be 0.001..0.03 (fraction)');
  if (!(vc.tpBackupMult >= 1.5)) bad.push('QFEX_VOL_TP_BACKUP_MULT must be >= 1.5');
  if (!(vc.dailyLossFrac > 0 && vc.dailyLossFrac <= 1)) bad.push('QFEX_VOL_DAILY_LOSS_FRAC must be in (0, 1]');
  if (!(vc.utilisation > 0 && vc.utilisation <= 0.9)) bad.push('QFEX_VOL_UTILISATION must be in (0, 0.9]');
  if (!(vc.sizeJitter >= 0 && vc.sizeJitter <= 0.3)) bad.push('QFEX_VOL_SIZE_JITTER must be 0..0.3');
  if (!(vc.liqMult >= 2)) bad.push('QFEX_VOL_LIQ_MULT must be >= 2');
  if (!(vc.cooldownS[0] >= 5 && vc.cooldownS[1] >= vc.cooldownS[0])) bad.push('QFEX_VOL_COOLDOWN_S must be MIN-MAX seconds, MIN >= 5');
  if (style === 'taker') {
    if (!(vc.notionalMinUsd >= 100 && vc.notionalMaxUsd >= vc.notionalMinUsd && vc.notionalMaxUsd <= 20000)) bad.push('QFEX_VOL_TAKER_NOTIONAL_USD must be MIN-MAX in 100..20000');
    if (!(vc.takerWeeklyCap > 0 && vc.takerWeeklyCap <= 100)) bad.push('QFEX_VOL_TAKER_WEEKLY_LOSS_CAP_USD must be > 0 and <= 100');
    const td = vc.takerDailyCap != null ? vc.takerDailyCap : +(vc.dailyLossFrac * vc.takerWeeklyCap).toFixed(2);
    if (!(td > 0 && td <= vc.takerWeeklyCap)) bad.push('taker daily loss cap must be > 0 and <= taker weekly cap');
    vc.takerDailyCap = td;
    const armMs = Date.parse(vc.takerArmUtc);
    if (!Number.isFinite(armMs)) bad.push('QFEX_VOL_TAKER_ARM_UTC must be a parseable ISO UTC timestamp');
  }
  if (bad.length) throw new Error('volume mode config: ' + bad.join('; '));
  return vc;
}

export function inSession(ref, ms) {
  const mh = ref && ref.market_hours; if (!mh || !mh.tz) return false;
  const at = (t) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: mh.tz, weekday: 'long', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(t)).map((p) => [p.type, p.value]));
    const hms = `${parts.hour}:${parts.minute}:${parts.second}`;
    return (mh[parts.weekday.toLowerCase()] || []).some((s) => s.session === 'open' && hms >= s.open && hms <= s.close);
  };
  return at(ms) && at(ms + 15 * 60e3);
}
// Cheapest INDEX/COMMODITY markets first (maker, then taker fee), ALO supported, active.
export function rankMarkets(refs, fees) {
  return refs.filter((r) => ['INDEX', 'COMMODITY'].includes(up(r.product_category)) && up(r.status) === 'ACTIVE' && (r.order_types || []).includes('ALO'))
    .map((r) => { const f = Q.rates(up(r.product_category), (fees || {})[r.symbol]); return { symbol: r.symbol, maker: f.maker, taker: f.taker, ref: r }; })
    .sort((a, b) => a.maker - b.maker || a.taker - b.taker || a.symbol.localeCompare(b.symbol));
}
// QFEX-only by design: no hedge legs anywhere (Arcus points terms disqualify delta-neutral / hedged farming).
export const HEDGING = false;

// ---------------------------------------------------------------- sizing / risk for one entry (pure)
export function entryRisk({ isLong, px, qty, slPct, ref, fee, lev, equity, free, totalNotional, pendingMargin, limits, style = 'maker' }) {
  const tick = ref.tick_size, cat = up(ref.product_category);
  const sl = Q.snap(px * (1 + (isLong ? -slPct : slPct)), tick, isLong ? 'ceil' : 'floor');
  const notional = qty * px, slDist = Math.abs(px - sl) / px;
  const stopRate = Math.max(fee.taker, Q.STOP_TAKER_FLOOR[cat] ?? 0.0005) + (Q.STOP_SLIPPAGE[cat] ?? 0.0005);
  // maker: entry maker fee + stop taker; taker sprint: entry taker + exit taker (flatten) + stop path if flatten fails
  const entryFee = style === 'taker' ? Math.max(0, fee.taker) : Math.max(0, fee.maker);
  const exitFee = style === 'taker' ? Math.max(0, fee.taker) : 0; // maker exit is maker-fee'd separately / ignored in worst-case SL path
  const worstLoss = qty * Math.abs(px - sl) + notional * entryFee + qty * sl * stopRate + notional * exitFee;
  const margin = notional / lev, maxLev = Number(ref.default_max_leverage) || 1, mmf = 1 / (2 * maxLev);
  const liqDist = equity / (totalNotional + notional) - mmf; // cross margin, every position moving against us at once
  const blocks = [];
  if (worstLoss > limits.perTrade) blocks.push(`worst loss $${worstLoss.toFixed(2)} > per-trade cap $${limits.perTrade.toFixed(2)}`);
  if (worstLoss > limits.weekLeft) blocks.push(`worst loss $${worstLoss.toFixed(2)} > weekly budget left $${limits.weekLeft.toFixed(2)}`);
  if (worstLoss > limits.dayLeft) blocks.push(`worst loss $${worstLoss.toFixed(2)} > daily budget left $${limits.dayLeft.toFixed(2)}`);
  if (margin + pendingMargin > free) blocks.push(`margin $${margin.toFixed(2)} (+ $${pendingMargin.toFixed(2)} resting) > free collateral $${free.toFixed(2)}`);
  if (!(liqDist >= limits.liqMult * slDist)) blocks.push(`liquidation distance ${(liqDist * 100).toFixed(2)}% < ${limits.liqMult}x stop distance ${(slDist * 100).toFixed(2)}%`);
  if (lev > maxLev) blocks.push(`leverage ${lev}x > market max ${maxLev}x`);
  return { sl, notional, margin, slDist, worstLoss, liqDist, stopRate, blocks, entryFee, exitFee };
}

// ---------------------------------------------------------------- pure decision step (unit-tested)
// input: { vc, st (qfex accountState), refs {SYM: ref}, fees {SYM: row}, quotes {SYM: {mark,bid,ask}}, vstate, now, rng,
//          canEnter (guard healthy + not killed), limits {perTrade, weeklyCap} }
export const tpPctFor = (vc, maker) => Math.max(vc.tpPct, 2 * Math.abs(maker || 0) + (vc.tpNetMinPct ?? 0));
// returns { actions[], notes[] } and mutates vstate (phases, cooldowns, requote budget, halts, round trips).
export function decideVolume({ vc, st, refs, fees, quotes, vstate, now, rng = Math.random, canEnter = true, limits }) {
  const actions = [], notes = []; vstate.markets ||= {}; vstate.stats ||= { roundTrips: 0, stopsOrOther: 0 };
  const ms = vstate.markets, mkt = (s) => ms[s] || (ms[s] = { phase: 'idle', cooldownUntil: 0, requotes: [] });
  const weeklyCap = (vc.style === 'taker' && limits.takerWeeklyCap != null) ? limits.takerWeeklyCap : limits.weeklyCap;
  const dailyCap = (vc.style === 'taker' && limits.takerDailyCap != null) ? limits.takerDailyCap : vc.dailyLossFrac * weeklyCap;
  // halts (persisted): weekly cap -> until next Monday 00:00 UTC; daily stop -> until next 00:00 UTC
  if (vstate.halted && now >= vstate.halted.until) { notes.push('halt expired: ' + vstate.halted.reason); delete vstate.halted; }
  if (!vstate.halted && st.weeklyLoss >= weeklyCap) vstate.halted = { reason: `weekly loss $${st.weeklyLoss.toFixed(2)} >= cap $${weeklyCap}`, until: weekStartUtc(now) + 7 * 86400e3, at: now, scope: 'weekly' };
  else if (!vstate.halted && st.dailyLoss >= dailyCap) vstate.halted = { reason: `daily loss $${st.dailyLoss.toFixed(2)} >= daily stop $${dailyCap.toFixed(2)}`, until: Math.floor(now / 86400e3) * 86400e3 + 86400e3, at: now, scope: 'daily' };
  if (vstate.halted && vstate.halted.at === now) actions.push({ kind: 'halt', ...vstate.halted });
  const byMarket = (s) => ({ pos: st.positions.find((p) => up(p.market) === s), orders: st.orders.filter((o) => up(o.market) === s) });
  const makerOf = (s) => (refs[s] ? Q.rates(up(refs[s].product_category), fees[s]).maker : 0) || 0;
  const tpFor = (s) => tpPctFor(vc, makerOf(s));
  const requoteOk = (m) => { m.requotes = (m.requotes || []).filter((t) => now - t < 60e3); return m.requotes.length < vc.requotesPerMin; };
  let openRisk = 0, pendingMargin = 0, active = 0;
  const markets = new Set([...Object.keys(ms), ...st.orders.filter((o) => isVolEntry(o) || isVolExit(o) || isVolStop(o)).map((o) => up(o.market))]);
  for (const s of markets) {
    const m = mkt(s), { pos, orders } = byMarket(s), ref = refs[s], q = quotes[s] || {};
    const entries = orders.filter(isVolEntry), exits = orders.filter(isVolExit), vstops = orders.filter(isVolStop);
    if (pos) {
      // restart reconciliation: the phase update of a send can be lost (process killed between send and state save);
      // a position that carries this mode's own tagged stops/exit IS ours: adopt it (managed, never re-entered)
      if (!['entry', 'pos'].includes(m.phase) && (vstops.length || exits.length)) { m.phase = 'pos'; m.filledAt ||= now; m.risk ||= limits.perTrade; notes.push(`${s}: volume-mode position adopted from the exchange state`); }
      if (!['entry', 'pos'].includes(m.phase)) { notes.push(`${s}: position not opened by volume mode, left alone`); continue; }
      active += 1; openRisk += m.risk || 0;
      if (m.phase === 'entry') { m.phase = 'pos'; m.filledAt = now; }
      if (entries.length) { for (const o of entries) actions.push({ kind: 'cancel', market: s, id: o.id, why: 'rest of a partially filled entry (never entry + exit together)' }); continue; }
      const isLong = pos.side === 'long', tick = ref ? ref.tick_size : null;
      if (ref && pos.size < Number(ref.min_quantity)) { if (!exits.length) actions.push({ kind: 'close', market: s, why: `position ${pos.size} below the minimum order size: close (taker)` }); continue; }
      if (!tick) { notes.push(`${s}: no refdata, exit not placed`); continue; }
      // Taker sprint: flatten ASAP via close_position (engine LIMIT IOC). Cancel any accidental maker exits.
      if (vc.style === 'taker') {
        for (const o of exits) actions.push({ kind: 'cancel', market: s, id: o.id, why: 'taker style: cancel resting exit before IOC flatten' });
        if (m.exitAt && now - m.exitAt < 8e3) { notes.push(`${s}: taker flatten sent ${Math.round((now - m.exitAt) / 1000)}s ago; waiting for position feed`); continue; }
        actions.push({ kind: 'close', market: s, why: 'taker sprint: immediate IOC flatten' }); m.exitAt = now; continue;
      }
      const held = now - (m.filledAt || now) > vc.maxHoldS * 1000;
      let target = Q.snap(pos.entry * (1 + (isLong ? tpFor(s) : -tpFor(s))), tick, isLong ? 'ceil' : 'floor');
      if (held && q.bid != null && q.ask != null) target = isLong ? q.ask : q.bid; // re-quote at the touch (still maker)
      const step = Number(tick);
      let px = target;
      if (isLong && q.bid != null) px = Math.max(target, Number((q.bid + step).toFixed(10)));
      if (!isLong && q.ask != null) px = Math.min(target, Number((q.ask - step).toFixed(10)));
      px = Q.snap(px, tick, isLong ? 'ceil' : 'floor');
      // an exit placed moments ago may have just filled while the position feed still shows the position: wait a tick
      // (seen live: a duplicate reduce-only exit was refused with INVALID_QUANTITY)
      if (!exits.length && m.exitAt && now - m.exitAt < 45e3) { notes.push(`${s}: exit placed ${Math.round((now - m.exitAt) / 1000)}s ago is gone; waiting for the position feed`); continue; }
      if (!exits.length) { actions.push({ kind: 'exit', market: s, side: pos.side, qty: pos.size, px, why: held ? 'held too long: exit at the touch' : 'take-profit exit (maker)' }); m.exitAt = now; continue; }
      const ex = exits[0];
      if (held && ex.px != null && Math.abs(ex.px - px) / px > vc.stalePct && requoteOk(m)) { m.requotes.push(now); actions.push({ kind: 'cancel', market: s, id: ex.id, why: 'held too long: exit re-quoted at the touch' }); }
      continue;
    }
    // flat market
    for (const o of exits) actions.push({ kind: 'cancel', market: s, id: o.id, why: 'exit left on a flat market' });
    if (m.phase === 'pos') { // round trip finished (maker exit, stop or backup TP)
      vstate.stats.roundTrips += 1; m.rt = (m.rt || 0) + 1; m.phase = 'idle'; m.risk = 0; m.exitAt = 0;
      m.cooldownUntil = now + 1000 * (vc.cooldownS[0] + rng() * (vc.cooldownS[1] - vc.cooldownS[0]));
    }
    if (vstops.length) {
      if (entries.length || !vc.cancelOrphanStops) notes.push(`${s}: ${vstops.length} orphan stop(s) of this mode on a flat market; no new entry here`);
      else for (const o of vstops) actions.push({ kind: 'cancelStop', market: s, id: o.id, why: 'orphan stop (market is flat): would otherwise hit a later position' });
      if (entries.length) { active += 1; } continue;
    }
    if (entries.length) {
      const o = entries[0]; active += 1; m.phase = 'entry'; m.seenResting = true; openRisk += m.risk || 0; pendingMargin += m.margin || 0;
      const isLong = up(o.side) === 'BUY', touch = isLong ? q.bid : q.ask;
      if (!canEnter || vstate.halted || !(ref && inSession(ref, now))) { actions.push({ kind: 'cancel', market: s, id: o.id, why: vstate.halted ? 'halted: ' + vstate.halted.reason : !canEnter ? 'new exposure paused' : 'market session ending' }); m.cancelled = true; continue; }
      if (touch != null && o.px != null && Math.abs(touch - o.px) / o.px > vc.stalePct) {
        if (requoteOk(m)) { m.requotes.push(now); m.cancelled = true; actions.push({ kind: 'cancel', market: s, id: o.id, why: `stale: touch ${touch} vs ${o.px}` }); }
        else notes.push(`${s}: stale entry, re-quote budget used (${vc.requotesPerMin}/min)`);
      }
      continue;
    }
    if (m.phase === 'entry') { // entry gone, no position: cancelled by us (re-quote now) or filled + closed between ticks
      m.phase = 'idle'; m.risk = 0; m.margin = 0;
      // never seen resting = QFEX cancelled the post-only (ALO) entry on placement because it would have crossed:
      // re-quote right away (counts against the per-market re-quote budget) instead of a full cooldown
      const aloCross = !m.cancelled && m.seenResting === false;
      if (aloCross && requoteOk(m)) { m.requotes.push(now); m.cooldownUntil = now; vstate.stats.aloRequotes = (vstate.stats.aloRequotes || 0) + 1; notes.push(`${s}: post-only entry cancelled on placement (would cross): re-quoting now`); }
      else m.cooldownUntil = m.cancelled ? now : now + 1000 * (vc.cooldownS[0] + rng() * (vc.cooldownS[1] - vc.cooldownS[0]));
      if (!m.cancelled && !aloCross) { vstate.stats.stopsOrOther += 1; notes.push(`${s}: entry vanished without a position (filled and closed between ticks?)`); }
      if (aloCross) vstate.stats.aloCancels = (vstate.stats.aloCancels || 0) + 1;
      m.seenResting = undefined;
    }
    m.cancelled = false;
  }
  if (!canEnter || vstate.halted) return { actions, notes: notes.concat(vstate.halted ? ['halted: ' + vstate.halted.reason] : ['new exposure paused']) };
  // ---- new entries
  const slots = Math.min(vc.maxMarkets - active, vc.newPerTick);
  if (slots <= 0) return { actions, notes };
  const totalNotional = st.positions.reduce((a, p) => a + p.size * (p.mark || p.entry || 0), 0)
    + st.orders.filter((o) => o.kind === 'LIMIT' && !o.reduceOnly && !o.stop).reduce((a, o) => a + (o.size || 0) * (o.px || 0), 0);
  const busy = new Set([...st.positions.map((p) => up(p.market)), ...st.orders.map((o) => up(o.market))]);
  const pool = (vc.markets === 'auto' ? Object.keys(refs) : vc.markets).filter((s) => refs[s]);
  const cands = [];
  for (const s of pool) {
    const ref = refs[s], q = quotes[s] || {}, m = mkt(s);
    if (!['INDEX', 'COMMODITY'].includes(up(ref.product_category)) || up(ref.status) !== 'ACTIVE') continue;
    if (vc.style === 'taker') {
      if (!(ref.order_types || []).includes('LIMIT') || !(ref.order_time_in_force || []).includes('IOC')) continue;
    } else if (!(ref.order_types || []).includes('ALO')) continue;
    if ((vc.avoid || []).includes(s)) continue;
    if (busy.has(s) || now < (m.cooldownUntil || 0) || now < (m.blockedUntil || 0) || !inSession(ref, now)) continue;
    if (!(q.bid > 0 && q.ask > q.bid && q.mark > 0)) continue;
    if ((q.ask - q.bid) / q.mark > vc.maxSpreadPct) { notes.push(`${s}: spread ${((q.ask - q.bid) / q.mark * 100).toFixed(3)}% too wide`); continue; }
    cands.push(s);
  }
  // randomised order (timing/market vary), cheaper fee first on ties
  const pref = (x) => { const i = (vc.prefer || []).indexOf(x); return i < 0 ? 99 : i; };
  const keyed = cands.map((x) => {
    const fr = Q.rates(up(refs[x].product_category), fees[x]);
    return { x, fee: vc.style === 'taker' ? fr.taker : fr.maker, p: pref(x), r: rng() };
  });
  keyed.sort((a, b) => a.fee - b.fee || a.p - b.p || a.r - b.r);
  cands.splice(0, cands.length, ...keyed.map((k) => k.x));
  let placed = 0, extraNotional = 0;
  for (const s of cands) {
    if (placed >= slots) break;
    const ref = refs[s], q = quotes[s], m = mkt(s), fee = Q.rates(up(ref.product_category), fees[s]);
    const lev = Math.min(vc.leverage, Number(ref.default_max_leverage) || 1);
    const isLong = m.lastSide ? (rng() < 0.75 ? m.lastSide !== 'long' : m.lastSide === 'long') : rng() < 0.5;
    // maker: passive at touch; taker: aggressive through touch (ask for BUY / bid for SELL) so LIMIT IOC takes liquidity
    const px = vc.style === 'taker' ? (isLong ? q.ask : q.bid) : (isLong ? q.bid : q.ask);
    const base = vc.notionalUsd != null ? vc.notionalUsd
      : (vc.style === 'taker' ? (vc.notionalMinUsd + rng() * (vc.notionalMaxUsd - vc.notionalMinUsd))
        : (st.equity * lev * vc.utilisation / vc.maxMarkets));
    const target = base * (1 + (rng() * 2 - 1) * vc.sizeJitter);
    let qty = Q.snap(target / px, ref.lot_size, 'floor');
    const minQ = Number(ref.min_quantity);
    if (qty < minQ) { if (minQ * px <= base * 1.2) qty = minQ; else { notes.push(`${s}: minimum size ${minQ} ($${(minQ * px).toFixed(0)}) above the target notional $${base.toFixed(0)}`); continue; } }
    const lim = { perTrade: limits.perTrade, weekLeft: weeklyCap - st.weeklyLoss - openRisk, dayLeft: dailyCap - st.dailyLoss - openRisk, liqMult: vc.liqMult };
    let r = entryRisk({ isLong, px, qty, slPct: vc.slPct, ref, fee, lev, equity: st.equity, free: st.free, totalNotional: totalNotional + extraNotional, pendingMargin, limits: lim, style: vc.style });
    // shrink once to fit the budgets (never below the minimum size)
    if (r.blocks.length && r.worstLoss > 0) {
      const room = Math.min(lim.perTrade, lim.weekLeft, lim.dayLeft) / r.worstLoss;
      const q2 = Q.snap(qty * Math.min(1, room) * 0.98, ref.lot_size, 'floor');
      if (q2 >= minQ && q2 < qty) { qty = q2; r = entryRisk({ isLong, px, qty, slPct: vc.slPct, ref, fee, lev, equity: st.equity, free: st.free, totalNotional: totalNotional + extraNotional, pendingMargin, limits: lim, style: vc.style }); }
    }
    if (r.blocks.length) { notes.push(`${s}: no entry (${r.blocks.join('; ')})`); continue; }
    const tp = Q.snap(px * (1 + (isLong ? 1 : -1) * tpPctFor(vc, fee.maker || 0) * vc.tpBackupMult), ref.tick_size, isLong ? 'floor' : 'ceil');
    actions.push({ kind: 'enter', market: s, side: isLong ? 'long' : 'short', qty, px, sl: r.sl, tp, lev, style: vc.style, risk: { worstLoss: +r.worstLoss.toFixed(4), notional: +r.notional.toFixed(2),
      margin: +r.margin.toFixed(2), slDist: +r.slDist.toFixed(5), liqDist: +r.liqDist.toFixed(4), maker: fee.maker, taker: fee.taker, stopRate: r.stopRate } });
    m.pending = { risk: r.worstLoss, margin: r.margin, side: isLong ? 'long' : 'short' };
    openRisk += r.worstLoss; pendingMargin += r.margin; extraNotional += r.notional; placed += 1;
  }
  return { actions, notes };
}

// ---------------------------------------------------------------- executor (one tick)
const cache = { refs: null, refsAt: 0, fees: null, feesAt: 0 };
async function refsAndFees(cfg, net) {
  const now = net.now();
  if (!cache.refs || now - cache.refsAt > 3600e3) { const r = await net.qfex.publicGet('/refdata'); cache.refs = Object.fromEntries(((r && r.data) || []).map((x) => [up(x.symbol), x])); cache.refsAt = now; }
  if (!cache.fees || now - cache.feesAt > 3600e3) { try { cache.fees = ((await net.qfex.get('/user/fees', null, { accountId: cfg.qfex.accountId })) || {}).fees || {}; cache.feesAt = now; } catch { cache.fees = cache.fees || {}; } }
  return { refs: cache.refs, fees: cache.fees };
}
export const _resetCache = () => { cache.refs = null; cache.fees = null; };

// io = { live, kill, log, journal, alert, guardOk, accountState, rng }
// an entry whose LAST request (the order itself) was sent but got no answer in time: state unknown on the exchange
export const uncertainEntry = (reqs, res) => res.length === reqs.length && res.length > 0 && !res[res.length - 1].ok
  && (res[res.length - 1].uncertain === true || /state unknown/i.test(String(res[res.length - 1].error || '')));
export function takerArmed(vc, nowMs) {
  const arm = Date.parse(vc.takerArmUtc || TAKER_ARM_UTC_DEFAULT);
  return Number.isFinite(arm) && nowMs >= arm;
}

export async function volumeTick(cfg, net, vstate, io) {
  const vc = cfg.qfexVol;
  if (!vc || !vc.enabled) return { enabled: false };
  if (!cfg.qfex) return { enabled: true, error: 'no QFEX key' };
  const st = await io.accountState('qfex', cfg, net);
  const { refs, fees } = await refsAndFees(cfg, net);
  const pool = vc.markets === 'auto' ? Object.keys(refs).filter((s) => ['INDEX', 'COMMODITY'].includes(up(refs[s].product_category))) : vc.markets;
  const quotes = await net.qfex.quotes([...new Set([...pool, ...Object.keys(vstate.markets || {}), ...st.positions.map((p) => up(p.market))])]);
  const now = net.now();
  const limits = {
    perTrade: Math.min(cfg.qfex.maxTradeLossUsd, (POLICY.perPlatform.qfex.maxLossEquityPct ?? 1) * st.equity),
    weeklyCap: cfg.qfex.weeklyLossCap,
    takerWeeklyCap: vc.style === 'taker' ? vc.takerWeeklyCap : null,
    takerDailyCap: vc.style === 'taker' ? vc.takerDailyCap : null,
  };
  const armed = vc.style !== 'taker' || takerArmed(vc, now);
  // Hard gate: never send live taker orders before the arm instant (default Mon 2 Nov 2026 00:00 UTC).
  const send = io.live && !io.kill && armed;
  const canEnter = io.guardOk !== false && !io.kill && !io.pauseEntries && armed; // pauseEntries: autotrader/STOP_VOLUME
  const { actions, notes } = decideVolume({ vc, st, refs, fees, quotes, vstate, now, rng: io.rng || Math.random, canEnter, limits });
  if (vc.style === 'taker' && !armed) notes.unshift(`taker style armed for ${vc.takerArmUtc} (now < arm: live sends blocked; set QFEX_VOL_STYLE=taker only at/after that instant)`);
  const report = {
    enabled: true, live: send, style: vc.style, armed, actions: [], notes,
    halted: vstate.halted || null, stats: vstate.stats, volume: st.volume,
    weeklyLoss: st.weeklyLoss, dailyLoss: st.dailyLoss,
    weeklyCap: vc.style === 'taker' ? vc.takerWeeklyCap : cfg.qfex.weeklyLossCap,
    dailyCap: vc.style === 'taker' ? vc.takerDailyCap : +(vc.dailyLossFrac * cfg.qfex.weeklyLossCap).toFixed(2),
  };
  for (const a of actions) {
    if (a.kind === 'halt') { io.log('ALERT', `volume mode halted: ${a.reason}`); io.alert({ pf: 'qfex', kind: 'volume-halt', reason: a.reason }); report.actions.push(a); continue; }
    if (!send) { report.actions.push({ ...a, sent: false, held: !armed ? 'taker not armed yet' : (io.kill || 'dry run') }); continue; }
    const m = vstate.markets[a.market];
    let reqs = [];
    try {
      if (a.kind === 'enter') {
        const levNow = (await net.qfex.leverage([a.market]))[a.market];
        if (levNow !== a.lev) reqs.push({ label: `set leverage ${a.lev}x + read back`, kind: 'rest', d: Q.leverageRequest(a.market, a.lev, { volume: true, maxLev: refs[a.market].default_max_leverage }) });
        const taker = (a.style || vc.style) === 'taker';
        const build = taker ? Q.buildTakerEntry : Q.buildEntry;
        const tag = taker ? 'LIMIT IOC taker' : 'ALO maker';
        reqs.push({ label: 'cancel-on-disconnect off', kind: 'ws', d: Q.cancelOnDisconnectOff() },
          { label: `volume entry ${a.side} ${a.qty} @ ${a.px} (${tag}) SL ${a.sl} TP(backup) ${a.tp}`, kind: 'ws', d: build({ symbol: a.market, isLong: a.side === 'long', qty: a.qty, px: a.px, sl: a.sl, tp: a.tp, clientOrderId: Q.clientOrderId(VOL_ENTRY) }) });
        a.levBefore = levNow;
      } else if (a.kind === 'exit') reqs = [{ label: `volume exit ${a.qty} @ ${a.px} (ALO reduce-only)`, kind: 'ws', d: Q.buildExit({ symbol: a.market, positionIsLong: a.side === 'long', qty: a.qty, px: a.px, clientOrderId: Q.clientOrderId(VOL_EXIT) }) }];
      else if (a.kind === 'cancel') reqs = [{ label: 'cancel ' + a.id, kind: 'ws', d: Q.buildCancel(a.market, a.id) }];
      else if (a.kind === 'cancelStop') reqs = [{ label: 'cancel orphan stop ' + a.id, kind: 'ws', d: Q.buildCancelStop(a.id) }];
      else if (a.kind === 'close') reqs = [{ label: 'close_position (IOC flatten)', kind: 'ws', d: Q.buildClosePosition(a.market, Q.clientOrderId(VOL_EXIT)) }];
    } catch (e) { report.actions.push({ ...a, ok: false, error: e.message }); io.log('ERROR', `volume ${a.kind} ${a.market}: ${e.message}`); continue; }
    const res = await net.qfex.send(reqs); const ok = res.length > 0 && res.every((x) => x.ok);
    const err = res.map((x) => x.error).filter(Boolean).join(' | ');
    if (a.kind === 'enter') {
      if (ok) Object.assign(m, { phase: 'entry', since: now, lastSide: a.side, risk: a.risk.worstLoss, margin: a.risk.margin, cancelled: false, seenResting: false });
      else if (uncertainEntry(reqs, res)) {
        // the entry request timed out after it was sent: it may be resting (or filled) on the exchange. Track it as an
        // entry so the next tick adopts whatever the exchange shows (resting order / position with its SL+TP) instead
        // of ignoring it; if nothing is there it is treated as cancelled. Never re-sent blindly (market blocked 2 min).
        Object.assign(m, { phase: 'entry', since: now, lastSide: a.side, risk: a.risk.worstLoss, margin: a.risk.margin, cancelled: true, seenResting: false, uncertain: now });
        m.blockedUntil = now + 2 * 60e3; io.log('WARN', `volume enter ${a.market}: result unknown (${err}); re-reading the exchange next tick before anything is re-sent`);
      }
      else { m.blockedUntil = now + 10 * 60e3; io.alert({ pf: 'qfex', market: a.market, kind: 'volume-entry-failed', ok: false, reason: err }); }
      io.journal({ id: 'vol-' + a.market + '-' + now, decision: ok ? 'placed' : 'failed', volume: true, style: a.style || vc.style,
        plan: { pf: 'qfex', market: a.market, side: a.side, size: a.qty, px: a.px, sl: a.sl, tp: a.tp, style: a.style || vc.style },
        risk: a.risk, lev: a.lev, results: res.map(({ label, status, ok: o, error }) => ({ label, status, ok: o, error })), mode: 'live' });
    } else {
      if (a.kind === 'exit' && !ok) { m.exitFails = (m.exitFails || 0) + 1; if (m.exitFails === 3) io.alert({ pf: 'qfex', market: a.market, kind: 'volume-exit-failed', ok: false, reason: err + ' (the exchange SL/TP still protect the position)' }); }
      if (a.kind === 'exit' && ok) m.exitFails = 0;
      io.journal({ decision: 'volume-' + a.kind, volume: true, style: vc.style, pf: 'qfex', market: a.market, why: a.why, ok, error: err || undefined, mode: 'live' });
    }
    io.log(ok ? 'VOLUME' : 'ERROR', `volume ${a.kind} ${a.market} [${vc.style}]: ${ok ? 'ok' : err} (${a.why || ''})`);
    report.actions.push({ ...a, ok, error: err || undefined });
  }
  return report;
}
