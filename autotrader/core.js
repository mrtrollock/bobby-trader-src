// Bobby autotrader core: headless, policy-gated maker trading on Arcus, Entropy (Hyperliquid dex "io") and QFEX.
// Reuses the app's signing (src/arcus.js, src/hl.js, src/qfex.js), policy (src/risk.js) and fee (src/fees.js) code.
// Every network call goes through `net` (real or mocked), so the whole decision path is testable offline.
import * as A from '../src/arcus.js';
import * as H from '../src/hl.js';
import * as Q from '../src/qfex.js';
import * as API from '../src/api.js';
import * as F from '../src/fees.js';
import { loadVolumeConfig } from './volume.js';
import * as L from '../src/lowoi.js';
import { createHash } from 'node:crypto';
import { computeRisk, checkPolicy, POLICY, weekStartUtc, realizedLoss, assertTradeOnly, policyFor } from '../src/risk.js';

export const MAX_POSITIONS = 3;
export const MAX_DRIFT = 0.01;
const PF_ALIASES = { arcus: 'arcus', entropy: 'entropy', hl: 'entropy', hyperliquid: 'entropy', qfex: 'qfex' };
export const PLATFORMS = ['arcus', 'entropy', 'qfex'];
const KEY_OF = { arcus: 'arcus', entropy: 'hl', qfex: 'qfex' };
const POL_PF = { arcus: 'arcus', entropy: 'hl', qfex: 'qfex' };

// ---------------------------------------------------------------- config from env (keys never leave this object)
export function loadConfig(env = process.env) {
  const net = env.AUTOTRADER_NETWORK;
  if (!['mainnet', 'testnet'].includes(net)) throw new Error('AUTOTRADER_NETWORK must be set to "testnet" or "mainnet"');
  const testnet = net === 'testnet';
  const cfg = {
    network: net, testnet, bases: API.bases(testnet),
    enabled: env.AUTOTRADER_ENABLED === '1',
    live: env.AUTOTRADER_LIVE === '1',            // DRY RUN unless explicitly 1
    dexes: String(env.AUTOTRADER_HL_DEXES || 'io').split(',').map((s) => s.trim()).filter(Boolean),
    maxPositions: Number(env.AUTOTRADER_MAX_POSITIONS || MAX_POSITIONS),
    arcus: env.ARCUS_API_PRIVATE_KEY ? { key: env.ARCUS_API_PRIVATE_KEY.trim(), address: String(env.ARCUS_ACCOUNT_ADDRESS || '').trim(),
      accountIndex: Number(env.ARCUS_ACCOUNT_INDEX || 0) } : null,
    hl: env.HL_AGENT_PRIVATE_KEY ? { key: env.HL_AGENT_PRIVATE_KEY.trim(), address: String(env.HL_ACCOUNT_ADDRESS || '').trim() } : null,
    // QFEX: HMAC API key pair. Must be scoped to ONE account with only execute + view permissions (see README).
    qfex: env.QFEX_API_PUBLIC_KEY || env.QFEX_API_SECRET_KEY ? { pub: String(env.QFEX_API_PUBLIC_KEY || '').trim(), secret: String(env.QFEX_API_SECRET_KEY || '').trim(),
      accountId: String(env.QFEX_ACCOUNT_ID || '').trim() || null, ack: env.QFEX_KEY_SINGLE_ACCOUNT_ACK === '1', allowMain: env.QFEX_ALLOW_MAIN_ACCOUNT === '1',
      slippage: env.QFEX_SL_SLIPPAGE != null && env.QFEX_SL_SLIPPAGE !== '' ? Number(env.QFEX_SL_SLIPPAGE) : null,
      weeklyLossCap: env.QFEX_WEEKLY_LOSS_CAP_USD ? Number(env.QFEX_WEEKLY_LOSS_CAP_USD) : POLICY.perPlatform.qfex.weeklyLossCap,
      maxTradeLossUsd: env.QFEX_MAX_TRADE_LOSS_USD ? Number(env.QFEX_MAX_TRADE_LOSS_USD) : POLICY.perPlatform.qfex.maxTradeLossUsd,
      categories: String(env.QFEX_CATEGORIES || Q.ALLOWED_CATEGORIES.join(',')).toUpperCase().split(',').map((x) => x.trim()).filter((x) => Q.ALLOWED_CATEGORIES.includes(x)) } : null,
    // public addresses for status without keys
    arcusAddress: String(env.ARCUS_ACCOUNT_ADDRESS || '').trim(), arcusIndex: Number(env.ARCUS_ACCOUNT_INDEX || 0),
    hlAddress: String(env.HL_ACCOUNT_ADDRESS || '').trim(),
  };
  for (const [k, v] of [['ARCUS_ACCOUNT_ADDRESS', cfg.arcusAddress], ['HL_ACCOUNT_ADDRESS', cfg.hlAddress]])
    if (v && !/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(k + ' is not a 0x address');
  // Arcus key without its account address: Arcus stays OFF (fail closed, no orders, no reads); the other platforms run.
  cfg.disabled = {};
  if (cfg.arcus && !cfg.arcus.address) { cfg.arcus = null; cfg.disabled.arcus = 'ARCUS_ACCOUNT_ADDRESS is not set: Arcus is disabled (no orders, no reads)'; }
  // same for Entropy/Hyperliquid: an agent key without HL_ACCOUNT_ADDRESS keeps Entropy OFF instead of aborting the loop
  if (cfg.hl && !cfg.hl.address) { cfg.hl = null; cfg.disabled.entropy = 'HL_ACCOUNT_ADDRESS is not set: Entropy is disabled (no orders)'; }
  // parse now so a malformed key fails early (the error message never contains the key)
  if (cfg.arcus) { cfg.arcus.priv = A.keyFromHex(cfg.arcus.key); cfg.arcus.apiKey = A.apiKeyOf(cfg.arcus.priv); }
  // master switch: Arcus trades only with AUTOTRADER_ARCUS=1 (key parsed + address present but switch off -> no orders, read-only status still works)
  if (cfg.arcus && env.AUTOTRADER_ARCUS !== '1') { cfg.arcus = null; cfg.disabled.arcus = 'AUTOTRADER_ARCUS is not 1: Arcus trading is disabled (no orders)'; }
  if (cfg.hl) { cfg.hl.priv = H.keyFromHex(cfg.hl.key); cfg.hl.agent = H.addressOf(cfg.hl.priv); }
  if (cfg.qfex) {
    Q.checkCreds(cfg.qfex);
    if (cfg.qfex.slippage != null && !(cfg.qfex.slippage >= 0 && cfg.qfex.slippage < 0.02)) throw new Error('QFEX_SL_SLIPPAGE must be a fraction between 0 and 0.02');
    // hard ceilings: the weekly cap can never exceed the standing $50/platform policy; one trade can never exceed the week
    if (!(cfg.qfex.weeklyLossCap > 0 && cfg.qfex.weeklyLossCap <= POLICY.weeklyLossCap)) throw new Error(`QFEX_WEEKLY_LOSS_CAP_USD must be > 0 and <= ${POLICY.weeklyLossCap}`);
    if (!(cfg.qfex.maxTradeLossUsd > 0 && cfg.qfex.maxTradeLossUsd <= cfg.qfex.weeklyLossCap)) throw new Error('QFEX_MAX_TRADE_LOSS_USD must be > 0 and <= the weekly cap');
  }
  cfg.capital = { arcus: env.ARCUS_CAPITAL_USD ? Number(env.ARCUS_CAPITAL_USD) : POLICY.capital.arcus, hl: env.HL_CAPITAL_USD ? Number(env.HL_CAPITAL_USD) : POLICY.capital.hl };
  for (const [k, v] of Object.entries(cfg.capital)) if (!(v > 0 && v <= POLICY.capital[k])) throw new Error(`${k === 'hl' ? 'HL' : 'ARCUS'}_CAPITAL_USD must be > 0 and <= ${POLICY.capital[k]}`);
  // low-OI ranking + liquidity gate settings (ARCUS_PREFER_LOW_OI / ENTROPY_PREFER_LOW_OI, LOWOI_* thresholds; see src/lowoi.js)
  cfg.lowOi = { arcus: L.optsFromEnv(env, 'arcus'), entropy: L.optsFromEnv(env, 'entropy') };
  cfg.bases.qfex = Q.bases(testnet);
  // volume mode: OFF unless QFEX_VOLUME_MODE=1 (and still needs AUTOTRADER_ENABLED=1 + AUTOTRADER_LIVE=1 to send anything)
  cfg.qfexVol = cfg.qfex ? loadVolumeConfig(env) : null;
  cfg.caps = lossCaps(env);
  return cfg;
}

// ---------------------------------------------------------------- loss caps per platform (key-less: env + policy only)
// Weekly cap from Monday 00:00 UTC, daily cap from 00:00 UTC, both on realized losses incl. fees (Arcus: Bobby's own fills only).
// Daily cap default = DAILY_LOSS_FRAC x weekly (same rule as the QFEX volume mode): AUTOTRADER_DAILY_LOSS_FRAC, or absolute
// ARCUS_DAILY_LOSS_CAP_USD / HL_DAILY_LOSS_CAP_USD. QFEX: QFEX_VOL_DAILY_LOSS_FRAC (default 0.4) x QFEX weekly cap.
export const DAILY_LOSS_FRAC = 0.4;
export function lossCaps(env = process.env) {
  const num = (k, d) => (env[k] != null && String(env[k]).trim() !== '' ? Number(env[k]) : d);
  const frac = num('AUTOTRADER_DAILY_LOSS_FRAC', DAILY_LOSS_FRAC);
  if (!(frac > 0 && frac <= 1)) throw new Error('AUTOTRADER_DAILY_LOSS_FRAC must be in (0, 1]');
  const auto = (dailyKey, capKey, capDefault) => {
    const weekly = POLICY.weeklyLossCap, daily = num(dailyKey, +(frac * weekly).toFixed(2));
    if (!(daily > 0 && daily <= weekly)) throw new Error(`${dailyKey} must be > 0 and <= the weekly cap ($${weekly})`);
    return { weekly, daily, dailyRule: env[dailyKey] ? `${dailyKey}` : `${Math.round(frac * 100)}% of the weekly cap`,
      maxTradePct: POLICY.maxLossPct, capital: num(capKey, capDefault), mode: 'auto' };
  };
  const qWeekly = num('QFEX_WEEKLY_LOSS_CAP_USD', POLICY.perPlatform.qfex.weeklyLossCap), qFrac = num('QFEX_VOL_DAILY_LOSS_FRAC', DAILY_LOSS_FRAC);
  return {
    arcus: auto('ARCUS_DAILY_LOSS_CAP_USD', 'ARCUS_CAPITAL_USD', POLICY.capital.arcus),
    entropy: auto('HL_DAILY_LOSS_CAP_USD', 'HL_CAPITAL_USD', POLICY.capital.hl),
    qfex: { weekly: qWeekly, daily: +(qFrac * qWeekly).toFixed(2), dailyRule: `${Math.round(qFrac * 100)}% of the weekly cap`,
      maxTradeUsd: num('QFEX_MAX_TRADE_LOSS_USD', POLICY.perPlatform.qfex.maxTradeLossUsd), maxLossEquityPct: POLICY.perPlatform.qfex.maxLossEquityPct, mode: 'auto' },
    // traded by hand: the standing $50/platform policy, shown as a reference only (Bobby never trades these)
    txflow: { weekly: POLICY.weeklyLossCap, daily: null, dailyRule: 'not set (manual trading)', maxTradePct: POLICY.maxLossPct, capital: POLICY.capital.txflow, mode: 'manual' },
    variational: { weekly: POLICY.weeklyLossCap, daily: null, dailyRule: 'not set (manual trading)', maxTradePct: POLICY.maxLossPct, capital: POLICY.capital.txflow, mode: 'manual' },
  };
}
// Usage vs caps for one platform from an accountState() result (st.weeklyLoss / st.dailyLoss). halted: optional persisted
// halt (QFEX volume mode). Times are unix ms; the week resets Monday 00:00 UTC, the day at 00:00 UTC.
export function limitsState(pf, caps, st, now, { halted = null } = {}) {
  const c = caps && caps[pf]; if (!c) return null;
  const wu = Math.max(0, Number(st.weeklyLoss) || 0), du = Math.max(0, Number(st.dailyLoss) || 0);
  const ws = weekStartUtc(now), ds = dayStartUtc(now);
  const wr = Math.max(0, c.weekly - wu), dr = c.daily != null ? Math.max(0, c.daily - du) : null;
  const eq = Math.max(0, Number(st.equity) || 0);
  const perTrade = pf === 'qfex' ? Math.min(c.maxTradeUsd, c.maxLossEquityPct * eq) : c.maxTradePct * Math.min(eq, c.capital || Infinity);
  const r2 = (x) => (x == null ? null : +Number(x).toFixed(2));
  let h = null;
  if (wu >= c.weekly) h = { scope: 'weekly', until: ws + 7 * 86400e3, reason: 'weekly loss cap reached' };
  else if (c.daily != null && du >= c.daily) h = { scope: 'daily', until: ds + 86400e3, reason: 'daily loss cap reached' };
  if (!h && halted && halted.until > now) h = { scope: halted.scope || 'halt', until: halted.until, reason: halted.reason || 'halted' };
  return { mode: c.mode, weeklyCap: c.weekly, weeklyUsed: r2(wu), weeklyRemaining: r2(wr), dailyCap: c.daily, dailyUsed: r2(du), dailyRemaining: r2(dr), dailyRule: c.dailyRule,
    maxTradeLoss: r2(Math.min(perTrade, wr, dr ?? Infinity)), maxTradeRule: pf === 'qfex' ? `$${c.maxTradeUsd} max, ≤ ${c.maxLossEquityPct * 100}% of equity` : `${c.maxTradePct * 100}% of equity (capital capped at $${c.capital})`,
    halted: h, weekFrom: ws, dayFrom: ds };
}
// Daily cap check for a new entry (all automated platforms): blocks once the day's realized loss reached the cap, or when
// this trade's loss at SL could push it over. Returns block reasons.
export function dailyCapBlocks(pf, caps, st, slLoss, now) {
  const L = limitsState(pf, caps, st, now);
  if (!L || L.dailyCap == null) return [];
  if (L.dailyUsed >= L.dailyCap) return [`Policy: daily loss cap reached ($${L.dailyUsed.toFixed(2)} / $${L.dailyCap}), new entries resume 00:00 UTC`];
  if (slLoss != null && L.dailyUsed + slLoss > L.dailyCap + 1e-9) return [`Policy: this trade could exceed the daily cap ($${L.dailyUsed.toFixed(2)} + $${Number(slLoss).toFixed(2)} > $${L.dailyCap})`];
  return [];
}
// Exchange reply kept in the journal (non-identifying fields only; ids of users/accounts are dropped, the log is redacted too).
export const echoOf = (body) => (body && typeof body === 'object' ? Object.fromEntries(Object.entries(body).filter(([k]) => !/user|account|address|api_key|signature/i.test(k))
  .map(([k, v]) => [k, v && typeof v === 'object' ? JSON.stringify(v).slice(0, 300) : v])) : body);
export const secretsOf = (cfg) => [cfg.arcus && cfg.arcus.key, cfg.hl && cfg.hl.key, cfg.qfex && cfg.qfex.secret, cfg.qfex && cfg.qfex.pub, cfg.qfex && cfg.qfex.accountId].filter(Boolean);

export function realNet(cfg) {
  return {
    arcusGet: (path, params) => API.arcusGet(cfg.bases.arcus, path, params),
    hlInfo: (body) => API.hlInfo(cfg.bases.hl, body),
    sendArcus: (d) => API.sendArcus(cfg.bases.arcus, d),
    sendHl: (d) => { const a = JSON.parse(d.body).action; assertTradeOnly('action', a); return API.sendHl(cfg.bases.hl, d); },
    arcusClockOffsetMs: () => API.arcusClockOffsetMs(cfg.bases.arcus),
    qfex: Q.makeNet(cfg.bases.qfex, cfg.qfex),
    now: () => Date.now(),
  };
}

// ---------------------------------------------------------------- transient read failures (outage / edge blips)
// QFEX answers intermittent 401/403 with an EMPTY body (and 5xx / dropped connections) during outages: seen live
// 2026-10-21 next to mds.qfex.com 503s while `verify` passed a minute later. Such errors must not abort the loop.
// Definitive key findings (all-accounts scope, foreign account accepted, missing ack, malformed key...) carry no
// such status and still abort at once.
export function isTransientError(e) {
  const m = String((e && e.message) || e || '');
  if (/HTTP (401|403|408|425|429|5\d\d)\b/.test(m)) return true;
  return /fetch failed|timed? ?out|timeout|aborted|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|network|WebSocket (connect timeout|closed|error)|UND_ERR/i.test(m);
}
// Consecutive-failure tracker for the loop: exponential backoff (base, 2x, ... capped below the 5-min stall watchdog);
// abort only once reads have failed continuously for longer than maxDownMs.
// pace(t): after any failure, the healthy loop waits at least slowMs between ticks for coolMs (fewer REST calls and
// WebSocket handshakes while the QFEX edge is throwing intermittent 403s; normal speed returns once it has been quiet)
export function readHealth({ baseMs = 15e3, capMs = 240e3, maxDownMs = 10 * 60e3, slowMs = 45e3, coolMs = 15 * 60e3 } = {}) {
  const h = { since: null, n: 0, lastFail: null, get degraded() { return h.since != null; },
    pace(t) { return h.lastFail != null && t - h.lastFail < coolMs ? slowMs : 0; },
    // partial: another QFEX read of the same tick succeeded (the key demonstrably works): backoff continues, but the
    // "continuous failure" window that leads to the abort restarts
    fail(t, { partial = false } = {}) { if (h.since == null || partial) h.since = t; h.n += 1; h.lastFail = t; const downMs = t - h.since;
      return { downMs, n: h.n, waitMs: Math.min(capMs, baseMs * 2 ** (h.n - 1)), abort: downMs > maxDownMs }; },
    ok(t) { const r = h.since == null ? null : { downMs: t - h.since, n: h.n }; h.since = null; h.n = 0; return r; } };
  return h;
}
// Stall watchdog: no tick finished for > limitMs -> one message, repeated every repeatMs while it lasts.
export function stallCheck(memo, lastDone, now, { limitMs = 5 * 60e3, repeatMs = 15 * 60e3 } = {}) {
  const idle = now - lastDone;
  if (idle <= limitMs) { const was = memo.stalledSince; memo.stalledSince = null; memo.alertedAt = 0; return was ? { recovered: true, idleMs: idle } : null; }
  memo.stalledSince ||= lastDone;
  if (memo.alertedAt && now - memo.alertedAt < repeatMs) return null;
  memo.alertedAt = now;
  return { stalled: true, idleMs: idle };
}

// ---------------------------------------------------------------- startup key checks (abort on any doubt)
export async function verifyKeys(cfg, net) {
  const out = {};
  if (cfg.arcus) {
    const keys = (await net.arcusGet('/v1/apiKeys', { address: cfg.arcus.address })).apiKeys || [];
    const mine = keys.find((k) => String(k.apiKey).toLowerCase() === cfg.arcus.apiKey.toLowerCase());
    if (!mine) throw new Error('Arcus: this API key is not registered for ARCUS_ACCOUNT_ADDRESS');
    if (mine.status !== 'ACTIVE') throw new Error('Arcus: API key status is ' + mine.status);
    if (mine.validUntil && Number(mine.validUntil) < net.now()) throw new Error('Arcus: API key expired');
    const perms = Array.isArray(mine.permissions) ? mine.permissions : mine.permissions ? [mine.permissions] : [];
    if (perms.length) throw new Error('Arcus: API key has extra permissions (' + perms.join(',') + '); a trade-only key is required');
    if (!mine.allSubaccounts && Number(mine.accountIndex ?? 0) !== cfg.arcus.accountIndex)
      throw new Error(`Arcus: key is scoped to subaccount ${mine.accountIndex}, not ARCUS_ACCOUNT_INDEX=${cfg.arcus.accountIndex}`);
    out.arcus = { apiKey: cfg.arcus.apiKey.slice(0, 10) + '…', status: mine.status, permissions: 'trade-only' };
  }
  if (cfg.hl) {
    if (cfg.hl.agent.toLowerCase() === cfg.hl.address.toLowerCase()) throw new Error('Hyperliquid: HL_AGENT_PRIVATE_KEY is the MAIN account key; use an agent (API) wallet');
    const role = await net.hlInfo({ type: 'userRole', user: cfg.hl.agent });
    const master = role && role.data && (role.data.user || role.data.master);
    if (!role || role.role !== 'agent' || String(master || '').toLowerCase() !== cfg.hl.address.toLowerCase())
      throw new Error('Hyperliquid: agent wallet is not approved for HL_ACCOUNT_ADDRESS (userRole=' + JSON.stringify(role && role.role) + ')');
    out.hl = { agent: cfg.hl.agent.slice(0, 8) + '…', role: 'agent' };
  }
  if (cfg.qfex) out.qfex = await verifyQfex(cfg, net);
  return out;
}

// QFEX has no endpoint that lists a key's permissions, and the only withdraw-capable paths live on the funding service,
// which this code never calls. Detected without side effects (behaviour confirmed on mainnet 2026-10-21):
//  * the cross-account listing GET /user/subaccounts/balance answers 403 for a single-account key: POSITIVE evidence of
//    single-account scope. "deposit_withdraw" only exists on "All accounts" keys, so a 200 there is refused.
//  * a request for a random foreign account id must be refused (401/403/404).
//  * the trade socket must authenticate and its balance snapshot `id` must be QFEX_ACCOUNT_ID. NOTE: that snapshot's
//    `user_id` is the ACCOUNT id, not the login user (it equals `id` on a subaccount too), so it says nothing about main vs sub.
//  * main vs subaccount: GET /user/referrals/notional-volume (user-level, readable by a single-account key) has a
//    `relationship:"self"` row whose `user_id` is the login user = the PRIMARY account id (docs: primary row has
//    account_id == user_id) and whose `account_ids` lists the user's accounts. QFEX_ACCOUNT_ID == that user_id -> main
//    account -> refused (builder/wallet keys, which can withdraw to registered addresses, are main-account keys).
//    If that row is missing, main vs sub is reported as undeterminable and the ack below is relied on.
// QFEX_KEY_SINGLE_ACCOUNT_ACK=1 (single account, execute + view only, withdraw unticked) is required on top.
export async function verifyQfex(cfg, net) {
  const q = cfg.qfex;
  if (!q.ack) throw new Error('QFEX: set QFEX_KEY_SINGLE_ACCOUNT_ACK=1 only after confirming the API key is scoped to ONE specific account with ' +
    'only "Execute orders" + view permissions and "Deposit and withdraw" unticked (QFEX cannot report key permissions)');
  if (!q.accountId) throw new Error('QFEX: set QFEX_ACCOUNT_ID to the UUID of the subaccount the key is scoped to');
  const own = await net.qfex.getRaw('/user/positions', null, { accountId: q.accountId });
  if (own.status === 401) throw new Error('QFEX: API key rejected (HTTP 401: wrong key pair, or QFEX_ACCOUNT_ID is not the key\'s account)');
  if (!own.ok) throw new Error(`QFEX: key cannot read positions of its account (HTTP ${own.status}); tick "View positions"`);
  const cross = await net.qfex.getRaw('/user/subaccounts/balance', null, { accountId: null });
  if (cross.ok) throw new Error('QFEX: this API key can list all your accounts ("All accounts" scope, the only scope that can carry withdraw ' +
    'permission). Create a key scoped to ONE specific account with execute + view only.');
  if (cross.status !== 403) throw new Error(`QFEX: could not verify the key scope (cross-account listing answered HTTP ${cross.status}); aborting on doubt`);
  const foreign = await net.qfex.getRaw('/user/positions', null, { accountId: globalThis.crypto.randomUUID() });
  if (foreign.ok) throw new Error('QFEX: the key accepted a foreign account id; refusing');
  if (![401, 403, 404].includes(foreign.status)) throw new Error(`QFEX: could not verify the key scope (foreign account answered HTTP ${foreign.status}); aborting on doubt`);
  const ws = await net.qfex.wsRead(); // also proves the trade-socket authentication
  if (!ws.balance || !ws.balance.id) throw new Error('QFEX: could not read the account identity from the trade socket; aborting on doubt');
  if (ws.balance.id !== q.accountId) throw new Error('QFEX: the key trades a different account than QFEX_ACCOUNT_ID');
  let kind = 'undetermined (no main/sub signal; relying on QFEX_KEY_SINGLE_ACCOUNT_ACK)';
  const ref = await net.qfex.getRaw('/user/referrals/notional-volume', null, { accountId: q.accountId });
  const self = ref.ok && ref.body && Array.isArray(ref.body.users) ? ref.body.users.find((u) => u && u.relationship === 'self') : null;
  if (self && self.user_id && Array.isArray(self.account_ids) && self.account_ids.includes(self.user_id) && self.account_ids.includes(q.accountId)) {
    if (self.user_id === q.accountId) {
      if (!q.allowMain) throw new Error('QFEX: QFEX_ACCOUNT_ID is your MAIN (primary) account; trade from a dedicated subaccount ' +
        '(scope the key to it and set QFEX_ACCOUNT_ID). Override: QFEX_ALLOW_MAIN_ACCOUNT=1');
      kind = 'main account (override)';
    } else kind = 'subaccount (verified: not the primary account id)';
  }
  return { key: 'configured', account: kind, websocket: 'authenticated, account id matches',
    scope: 'single account (verified: cross-account listing 403, foreign account ' + foreign.status + ')', permissions: 'view ok; withdraw/funding never called; ack=1' };
}

// ---------------------------------------------------------------- proposals
export function normalizeProposal(q) {
  const p = {
    id: q.id, pf: PF_ALIASES[String(q.pf ?? q.platform ?? '').toLowerCase()] || String(q.pf ?? q.platform ?? '').toLowerCase(),
    m: q.m ?? q.market, sd: String(q.sd ?? q.side ?? '').toLowerCase(), et: q.et ?? q.type ?? 'limit',
    px: Number(q.px ?? q.limit ?? q.price), sz: Number(q.sz ?? q.size), lev: Number(q.lev ?? q.leverage ?? 1),
    sl: q.sl ?? q.stopLoss, tp: q.tp ?? q.takeProfit, exp: Number(q.exp ?? q.expiry), ref: Number(q.ref ?? q.refPrice), n: q.n ?? q.rationale ?? '',
    act: 'open', postOnly: q.postOnly !== false,
  };
  if (p.sd === 'buy') p.sd = 'long'; if (p.sd === 'sell') p.sd = 'short';
  p.sl = p.sl == null || p.sl === '' ? null : Number(p.sl); p.tp = p.tp == null || p.tp === '' ? null : Number(p.tp);
  return p;
}
function basicChecks(p, cfg, nowS) {
  const b = [];
  if (!p.id) b.push('missing id');
  if (p.pf === 'txflow') b.push('TxFlow is manual only: use the app');
  else if (!PLATFORMS.includes(p.pf)) b.push('unknown platform ' + p.pf);
  else if (!cfg[KEY_OF[p.pf]]) b.push(`${p.pf}: no key configured`);
  if (p.pf === 'entropy' && !cfg.dexes.includes(H.dexOf(String(p.m || '')))) b.push(`Entropy market must be on dex ${cfg.dexes.join('/')} (e.g. io:ANTH)`);
  if (!p.m) b.push('missing market');
  if (!['long', 'short'].includes(p.sd)) b.push('side must be long or short');
  if (p.et !== 'limit') b.push('Policy: post-only limit entries only');
  if (p.postOnly === false) b.push('Policy: postOnly cannot be disabled');
  if (!(p.px > 0)) b.push('missing limit price');
  if (!(p.sz > 0)) b.push('missing size');
  if (!(p.lev >= 1) || p.lev > POLICY.maxLeverage) b.push(`Policy: leverage ${p.lev}× > ${POLICY.maxLeverage}× max`);
  if (p.sl == null) b.push('Policy: stop-loss required');
  if (p.tp == null) b.push('Policy: take-profit required');
  if (!(p.ref > 0)) b.push('missing ref price (needed for the 1% drift check)');
  if (!(p.exp > 1e9)) b.push('missing expiry');
  else if (nowS > p.exp) b.push('expired');
  return b;
}

// ---------------------------------------------------------------- live context per platform (public reads)
// Arcus /v1/fills: from/to and createdAt are epoch MICROseconds (mainnet answers 400 "from must be a microsecond
// timestamp" to ms); newest first, paged backwards with `to`. Times are returned in ms.
// ---- Arcus attribution: account 0 is shared with the user's other tools. Every order Bobby places carries a clientId
// starting with BOBBY_CID ("bby-"); fills/orders expose clientId (not the API key), so ownership is decided by it.
export const BOBBY_CID = 'bby-';
export const isBobbyCid = (c) => typeof c === 'string' && c.startsWith(BOBBY_CID);
// <= 36 chars, [A-Za-z0-9_-] (Arcus clientId rules); unique per order (DUPLICATE_CLIENT_ID on live reuse)
export const arcusCid = (seed, kind) => BOBBY_CID + createHash('sha256').update(String(seed)).digest('hex').slice(0, 16) + '-' + kind;
// Fill attribution (fail closed): clientId "bby-" -> Bobby; no clientId in a market Bobby trades (Bobby fills this week,
// Bobby orders open, or a Bobby-owned market) -> counted as Bobby's; any other clientId -> the user's other tools.
export function attributeArcusFills(week, orders, owned = {}) {
  const mk = new Set([...week.filter((f) => isBobbyCid(f.clientId)).map((f) => up(f.m)), ...orders.filter((o) => isBobbyCid(o.clientId)).map((o) => up(o.market)),
    ...Object.keys(owned || {}).map(up)]);
  const bobby = week.filter((f) => isBobbyCid(f.clientId) || (!f.clientId && mk.has(up(f.m))));
  return { bobby, markets: mk };
}
export const arcusMs = (t) => { const n = Number(t); return n > 1e14 ? n / 1000 : n; };
async function arcusFillsSince(net, addr, ai, fromMs) {
  const out = []; let to;
  for (let page = 0; page < 20; page++) {
    const r = await net.arcusGet('/v1/fills', { address: addr, accountIndex: ai, from: Math.floor(fromMs) * 1000, ...(to != null ? { to } : {}), limit: 1000 });
    const rows = r.fills || []; out.push(...rows);
    if (rows.length < 1000) break;
    const oldest = Math.min(...rows.map((f) => Number(f.createdAt))); if (!(oldest > 1e14)) break; to = oldest - 1;
  }
  return out.map((f) => ({ time: arcusMs(f.createdAt), closedPnl: f.closedPnl, fee: f.fee, m: f.marketDisplayName, px: f.price, sz: f.size, side: f.side, clientId: f.clientId || null, orderId: f.orderId != null ? String(f.orderId) : null }))
    .filter((f) => f.time >= fromMs);
}
export async function hlSpotUsdc(net, user) {
  let mode = null, spot = null;
  try { mode = await net.hlInfo({ type: 'userAbstraction', user }); } catch { /* older API */ }
  try { spot = await net.hlInfo({ type: 'spotClearinghouseState', user }); } catch { return null; }
  const u = ((spot && spot.balances) || []).find((b) => b.coin === 'USDC');
  if (!u) return null;
  return { total: Number(u.total || 0), hold: Number(u.hold || 0), unified: ['unifiedAccount', 'portfolioMargin'].includes(String(mode)), mode };
}
async function hlFillsSince(net, user, fromMs, dexes) {
  const rows = await net.hlInfo({ type: 'userFillsByTime', user, startTime: fromMs });
  const pre = dexes.map((d) => d + ':');
  return (rows || []).filter((f) => pre.some((x) => String(f.coin).startsWith(x)))
    .map((f) => ({ time: Number(f.time), closedPnl: f.closedPnl, fee: f.fee, m: f.coin, px: f.px, sz: f.sz, side: f.side === 'B' ? 'BUY' : 'SELL', dir: f.dir }));
}

async function qfexTrades(net, cfg, fromMs) {
  const rows = []; const q = cfg.qfex;
  for (let off = 0; off <= 20000; off += 1000) {
    const r = await net.qfex.get('/user/trade', { start_time: new Date(fromMs).toISOString(), limit: 1000, offset: off }, { accountId: q.accountId });
    const d = (r && r.data) || []; rows.push(...d); if (d.length < 1000) break;
  }
  return Q.tradeRows(rows).filter((t) => t.time >= fromMs);
}
// ---------------------------------------------------------------- volume / fee / PnL tracking (QFEX fills, UTC periods)
export const VOLUME_GOAL_MONTH = 300000;
export const dayStartUtc = (ms) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
export const monthStartUtc = (ms) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
// fills: Q.tradeRows -> { day, week, month: {volume $, fees $, pnl $ (realised - fees), trades}, goal, monthPct }
export function volumeStats(fills, nowMs, { goal = VOLUME_GOAL_MONTH } = {}) {
  const per = (from) => { const r = { volume: 0, fees: 0, pnl: 0, trades: 0 };
    for (const f of fills || []) { if (!(f.time >= from)) continue; r.volume += Math.abs(Number(f.px || 0) * Number(f.sz || 0)); r.fees += Number(f.fee || 0); r.pnl += Number(f.closedPnl || 0) - Number(f.fee || 0); r.trades += 1; }
    return { volume: +r.volume.toFixed(2), fees: +r.fees.toFixed(4), pnl: +r.pnl.toFixed(4), trades: r.trades }; };
  const month = per(monthStartUtc(nowMs));
  return { day: per(dayStartUtc(nowMs)), week: per(weekStartUtc(nowMs)), month, goal, monthPct: +(100 * month.volume / goal).toFixed(2), periods: 'UTC (week from Monday 00:00 UTC)' };
}
async function qfexState(cfg, net, { sinceMs } = {}) {
  const q = cfg.qfex;
  const pb = await net.qfex.get('/user/positions', null, { accountId: q.accountId });
  const bal = (pb && pb.balance) || {};
  // equity = deposit + realised + unrealised + funding (the balance has no equity field); cross-checked against the latest
  // point of GET /user/account-equity and the lower of the two is used (conservative for the 1 % rule)
  let equity = Number(bal.deposit || 0) + Number(bal.realised_pnl || 0) + Number(bal.unrealised_pnl || 0) + Number(bal.net_funding || 0);
  try { const ae = await net.qfex.get('/user/account-equity', { duration: '1d' }, { accountId: q.accountId });
    const last = ((ae && ae.data) || []).filter((x) => Number.isFinite(Number(x.value))).pop();
    if (last && Number(last.value) < equity) equity = Number(last.value); } catch { /* optional */ }
  const free = Number(bal.available_balance || 0);
  const positions = ((pb && pb.positions) || []).filter((p) => Number(p.position) !== 0).map((p) => ({ market: p.symbol, side: Number(p.position) > 0 ? 'long' : 'short',
    size: Math.abs(Number(p.position)), entry: Number(p.average_price), mark: null, upnl: Number(p.unrealised_pnl || 0), leverage: Number(p.leverage), raw: p }));
  // The trade socket is short-lived per read: a dropped connection is simply re-opened and re-read (the stops live on the
  // exchange regardless). Three attempts, then the read fails loudly (the guard reports "stops unknown", never assumes).
  let ws, lastErr;
  for (let i = 0; i < 3 && !ws; i++) {
    try { ws = await net.qfex.wsRead(); } catch (e) { lastErr = e; if (/authentication/i.test(e.message)) break; await new Promise((r) => setTimeout(r, (net.retryMs ?? 1000) * (i + 1))); }
  }
  if (!ws) throw new Error('QFEX: trade WebSocket read failed after retries (' + (lastErr && lastErr.message) + ')');
  // mark price per position (public MDS); fallback entry + uPnL / size
  // all marks over ONE public MDS connection (was one connection per position: fewer handshakes, see the 403 incident)
  let marks = null;
  if (positions.length > 1 && net.qfex.quotes) { try { marks = await net.qfex.quotes(positions.map((p) => p.market)); } catch { marks = null; } }
  for (const p of positions) {
    const mq = marks && marks[String(p.market).toUpperCase()];
    if (mq && mq.mark != null) p.mark = mq.mark;
    else { try { p.mark = (await net.qfex.quote(p.market)).mark; } catch { /* fallback below */ } }
    if (p.mark == null && p.size > 0 && Number.isFinite(p.entry)) p.mark = p.entry + (p.side === 'long' ? p.upnl / p.size : -p.upnl / p.size);
  }
  const orders = Q.mergeOrders(ws.orders, ws.stops);
  const now = net.now(), weekFrom = weekStartUtc(now), dayFrom = dayStartUtc(now), monthFrom = monthStartUtc(now);
  const from = Math.min(weekFrom, monthFrom);
  const all = await qfexTrades(net, cfg, from), week = all.filter((t) => t.time >= weekFrom);
  const fills = sinceMs != null ? (sinceMs >= from ? all.filter((t) => t.time >= sinceMs) : await qfexTrades(net, cfg, sinceMs)) : undefined;
  return { pf: 'qfex', equity, free, deposit: Number(bal.deposit || 0), positions, orders, stopsKnown: ws.stops.length > 0 || !positions.length, stopsSubscribed: ws.stopsSubscribed,
    weeklyLoss: realizedLoss(week, weekFrom), dailyLoss: realizedLoss(all, dayFrom), volume: volumeStats(all, now), fills };
}

export async function accountState(pf, cfg, net, { sinceMs } = {}) {
  if (pf === 'qfex') return qfexState(cfg, net, { sinceMs });
  if (pf === 'arcus') {
    const addr = cfg.arcus ? cfg.arcus.address : cfg.arcusAddress, ai = cfg.arcus ? cfg.arcus.accountIndex : cfg.arcusIndex;
    const acct = await net.arcusGet('/v1/account', { address: addr, accountIndex: ai });
    let pos = (await net.arcusGet('/v1/positions', { address: addr, accountIndex: ai })).positions || [];
    pos = (Array.isArray(pos) ? pos : Object.values(pos)).filter((p) => Number(p.size) !== 0);
    const oo = (await net.arcusGet('/v1/openOrders', { address: addr, accountIndex: ai })).orders || [];
    const week = await arcusFillsSince(net, addr, ai, weekStartUtc(net.now()));
    const fills = sinceMs != null ? await arcusFillsSince(net, addr, ai, sinceMs) : undefined;
    const ws0 = weekStartUtc(net.now());
    const st = {
      pf, equity: Number(acct.equity), free: Number(acct.freeCollateral),
      positions: pos.map((p) => ({ market: p.marketDisplayName, side: A.isLongSide(p.side) ? 'long' : 'short', size: Number(p.size),
        entry: Number(p.averageEntryPrice), mark: p.markPrice != null ? Number(p.markPrice) : null, upnl: Number(p.unrealizedPnl), raw: p })),
      orders: oo.map((o) => ({ id: String(o.orderId), market: o.marketDisplayName, side: o.side, kind: o.tpslType === 'STOP_LOSS' ? 'SL' : o.tpslType === 'TAKE_PROFIT' ? 'TP' : 'LIMIT',
        px: o.price != null ? Number(o.price) : null, trig: o.triggerPrice != null ? Number(o.triggerPrice) : null, size: Number(o.remainingSize ?? o.originalSize ?? 0), clientId: o.clientId || null, raw: o })),
      fills,
    };
    // Bobby-only accounting + ownership (the other tools' positions/orders/fills are never Bobby's)
    const att = attributeArcusFills(week, st.orders, cfg.arcusOwn);
    st.bobbyMarkets = [...att.markets];
    st.weeklyLoss = realizedLoss(att.bobby, ws0, Infinity, { feeIncluded: true });
    st.dailyLoss = realizedLoss(att.bobby, dayStartUtc(net.now()), Infinity, { feeIncluded: true });
    st.weeklyLossAccount = realizedLoss(week, ws0, Infinity, { feeIncluded: true });
    st.bobbyWeekFills = att.bobby.length;
    const ownedNow = new Set([...Object.keys(cfg.arcusOwn || {}).map(up), ...st.orders.filter((o) => isBobbyCid(o.clientId)).map((o) => up(o.market))]);
    for (const p of st.positions) p.bobby = ownedNow.has(up(p.market));
    for (const o of st.orders) o.bobby = isBobbyCid(o.clientId);
    return st;
  }
  const user = cfg.hl ? cfg.hl.address : cfg.hlAddress;
  let equity = 0, free = 0; const positions = [], orders = [];
  for (const dex of cfg.dexes) {
    const st = await net.hlInfo({ type: 'clearinghouseState', user, dex });
    equity += Number((st.marginSummary || {}).accountValue || 0); free += Number(st.withdrawable || 0);
    for (const ap of st.assetPositions || []) {
      const p = ap.position || {}; const szi = Number(p.szi || 0); if (!szi) continue;
      positions.push({ market: p.coin, side: szi > 0 ? 'long' : 'short', size: Math.abs(szi), entry: Number(p.entryPx),
        mark: p.positionValue ? Number(p.positionValue) / Math.abs(szi) : null, upnl: Number(p.unrealizedPnl), raw: p });
    }
    for (const o of (await net.hlInfo({ type: 'frontendOpenOrders', user, dex })) || []) {
      const ot = String(o.orderType || '');
      orders.push({ id: String(o.oid), market: o.coin, side: o.side === 'B' ? 'BUY' : 'SELL', kind: o.isTrigger ? (/stop/i.test(ot) ? 'SL' : /take/i.test(ot) ? 'TP' : 'TRIGGER') : 'LIMIT',
        px: Number(o.limitPx), trig: o.isTrigger ? Number(o.triggerPx) : null, size: Number(o.sz), reduceOnly: !!o.reduceOnly, raw: o });
    }
  }
  // Unified / portfolio-margin accounts keep the collateral as SPOT USDC (the dex clearinghouse then reports ~0):
  // equity = spot USDC + unrealized PnL of the dex positions, free = USDC not on hold. Other spot tokens never count.
  const sp = await hlSpotUsdc(net, user);
  if (sp && (sp.unified || equity <= 0)) {
    equity = sp.total + positions.reduce((a, x) => a + (Number(x.upnl) || 0), 0); free = Math.max(0, sp.total - sp.hold); }
  const week = await hlFillsSince(net, user, weekStartUtc(net.now()), cfg.dexes);
  const fills = sinceMs != null ? await hlFillsSince(net, user, sinceMs, cfg.dexes) : undefined;
  return { pf, equity, free, positions, orders, weeklyLoss: realizedLoss(week, weekStartUtc(net.now())), dailyLoss: realizedLoss(week, dayStartUtc(net.now())), fills };
}

async function qfexRef(net, sym) {
  const r = await net.qfex.publicGet('/refdata', { ticker: sym });
  const row = ((r && r.data) || []).find((x) => String(x.symbol).toUpperCase() === sym);
  if (!row) throw new Error('Unknown QFEX market: ' + sym);
  return row;
}
async function qfexMarketCtx(p, cfg, net) {
  const sym = Q.normSymbol(p.m), ref = await qfexRef(net, sym), isLong = p.sd === 'long';
  const quote = await net.qfex.quote(sym);
  let live = null; try { live = ((await net.qfex.get('/user/fees', null, { accountId: cfg.qfex.accountId })).fees || {})[sym] || null; } catch { /* schedule fallback */ }
  const fr = Q.rates(Q.categoryOf(sym, ref), live, { slippage: cfg.qfex.slippage });
  const r = p.px > 0 && p.sl != null && p.tp != null ? Q.roundProposal({ isLong, px: p.px, sl: p.sl, tp: p.tp, qty: p.sz }, ref) : { px: p.px, sl: p.sl, tp: p.tp, qty: Q.snap(p.sz || 0, ref.lot_size, 'floor') };
  const maxLev = Number(ref.default_max_leverage) || 1;
  return { market: sym, ref, quote, mark: quote.mark, bid: quote.bid, ask: quote.ask, maxLev, mmf: 1 / (2 * maxLev), maker: fr.maker, taker: fr.taker, stopRate: fr.stopRate,
    stopTaker: fr.stopTaker, slippage: fr.slippage, feeSrc: fr.source, category: fr.category, size: r.qty, px: r.px, sl: r.sl, tp: r.tp,
    minSize: Number(ref.min_quantity || 0), maxSize: Number(ref.max_quantity || Infinity), band: [Number(ref.min_price), Number(ref.max_price)],
    status: String(ref.status || '').toUpperCase() === 'ACTIVE' ? 'ONLINE' : String(ref.status || 'UNKNOWN').toUpperCase(), orderTypes: ref.order_types || [] };
}

async function marketCtx(pf, p, cfg, net, st) {
  if (pf === 'qfex') return qfexMarketCtx(p, cfg, net);
  if (pf === 'arcus') {
    const ms = (await net.arcusGet('/v1/markets')).markets || [];
    const name = String(p.m).toUpperCase();
    const m = ms.find((x) => x.marketDisplayName.toUpperCase() === name || x.marketDisplayName.toUpperCase() === name + '-USD');
    if (!m) throw new Error('Unknown Arcus market: ' + p.m);
    let stats = null; try { stats = await net.arcusGet('/v1/account/stats', { address: cfg.arcus.address, include: 'feeTier' }); } catch { /* */ }
    const fr = F.arcusRates(m, stats, null);
    return { m, market: m.marketDisplayName, mark: Number(m.markPrice), maxLev: A.maxLeverage(m), mmf: Number(m.maintenanceMarginFraction), maker: fr.maker, taker: fr.taker,
      feeSrc: fr.source, size: Number(A.qtyFloor(m, p.sz)), sizeStr: A.qtyFloor(m, p.sz), minSize: Number(m.minOrderSize || 0), minNotional: Number(m.minOrderNotional || 0),
      status: m.status, oiUsd: Number(m.openInterest || 0) * Number(m.markPrice || 0), vol24hUsd: Number(m.volume24hNotional || 0) };
  }
  const dex = H.dexOf(p.m);
  const [meta, ctxs] = await net.hlInfo({ type: 'metaAndAssetCtxs', dex });
  const perpDexs = await net.hlInfo({ type: 'perpDexs' });
  const idx = meta.universe.findIndex((u) => u.name === p.m);
  if (idx < 0) throw new Error('Unknown HL market: ' + p.m);
  const u = meta.universe[idx], c = ctxs[idx];
  const fr = { ...F.FALLBACK.hl_io, source: 'default (HIP-3)' };
  return { mk: { coin: p.m, dex, asset: H.assetId(p.m, meta.universe, perpDexs), szDecimals: u.szDecimals, maxLeverage: u.maxLeverage, isDelisted: !!u.isDelisted },
    market: p.m, mark: Number(c.markPx), maxLev: u.maxLeverage, mmf: 1 / (2 * u.maxLeverage), maker: fr.maker, taker: fr.taker, feeSrc: fr.source,
    size: Number(H.roundSz(p.sz, u.szDecimals)), status: u.isDelisted ? 'DELISTED' : 'ONLINE', oiUsd: Number(c.openInterest || 0) * Number(c.markPx || 0), vol24hUsd: Number(c.dayNtlVlm || 0) };
}

// Full hard-policy evaluation. Returns { ok, reasons[], risk, ctx }. Every computeRisk warning is a hard block here
// (there is no human to acknowledge it).
export async function evaluate(q, cfg, net, stCache = {}) {
  const nowS = net.now() / 1000;
  const p = normalizeProposal(q);
  const reasons = basicChecks(p, cfg, nowS);
  if (reasons.length) return { ok: false, p, reasons };
  const st = stCache[p.pf] || (stCache[p.pf] = await accountState(p.pf, cfg, net));
  const c = await marketCtx(p.pf, p, cfg, net, st);
  const isLong = p.sd === 'long';
  if (p.pf === 'qfex') { p.px = c.px; p.sl = c.sl; p.tp = c.tp; } // tick-rounded in the safe direction; risk is computed on these
  // QFEX stops fire as MARKET orders on the mark: the exit leg is charged a taker fee (floored per category) + slippage.
  const exitRate = p.pf === 'qfex' ? c.stopRate : c.taker;
  const r = computeRisk({ isLong, size: c.size, leverage: p.lev, mark: c.mark, type: 'limit', limitPx: p.px, feeRate: exitRate,
    entryFeeRate: Math.max(0, c.maker ?? 0), mmf: c.mmf, maxLev: c.maxLev, sl: p.sl, tp: p.tp, ref: p.ref, expiry: p.exp, now: nowS,
    freeCollateral: st.free, maxLoss: Infinity, maxMove: MAX_DRIFT });
  reasons.push(...r.blocks, ...r.warns);
  const basePol = p.pf === 'qfex' ? policyFor('qfex', POLICY, { weeklyLossCap: cfg.qfex.weeklyLossCap, maxTradeLossUsd: cfg.qfex.maxTradeLossUsd }) : POLICY;
  // usable capital = live equity, capped at the platform's starting capital (Arcus/Entropy $300; ARCUS_CAPITAL_USD / HL_CAPITAL_USD override)
  const capOf = { arcus: cfg.capital && cfg.capital.arcus, entropy: cfg.capital && cfg.capital.hl }[p.pf];
  const usable = capOf > 0 ? Math.min(st.equity, capOf) : st.equity;
  const pol = { ...basePol, capital: { ...POLICY.capital, [POL_PF[p.pf]]: usable } };
  const cp = checkPolicy({ ...p, pf: POL_PF[p.pf] }, r, { policy: pol, weeklyLossUsed: st.weeklyLoss, freeCollateral: st.free });
  reasons.push(...cp.blocks);
  reasons.push(...dailyCapBlocks(p.pf, cfg.caps || lossCaps({}), st, r.slLoss, nowS * 1000));
  if (!(st.equity > 0)) reasons.push('no equity on this platform');
  if (r.moved != null && r.moved > MAX_DRIFT && !reasons.some((x) => /moved/.test(x))) reasons.push(`Price moved ${(r.moved * 100).toFixed(2)}% since the proposal`);
  if (!(c.mark > 0)) reasons.push('no live mark price');
  else if (isLong ? p.px >= c.mark : p.px <= c.mark) reasons.push('Maker policy: the limit price would cross the book (post-only would be rejected)');
  if (p.pf === 'qfex') {
    if (isLong ? c.ask != null && p.px >= c.ask : c.bid != null && p.px <= c.bid) reasons.push('Maker policy: the limit price would cross the best ' + (isLong ? 'ask' : 'bid') + ' (ALO would be rejected)');
    if (!c.orderTypes.includes('ALO')) reasons.push('QFEX market does not accept ALO (post-only) orders');
    if (!cfg.qfex.categories.includes(c.category)) reasons.push(`QFEX category ${c.category} not allowed (QFEX_CATEGORIES=${cfg.qfex.categories.join(',')})`);
    if (c.band[0] > 0 && (p.px < c.band[0] || p.px > c.band[1])) reasons.push(`limit price outside the QFEX price band ${c.band[0]}–${c.band[1]}`);
    if (c.size > c.maxSize) reasons.push(`size > maximum (${c.maxSize})`);
    if (st.positions.length && st.stopsKnown === false) reasons.push('QFEX stop orders could not be read: refusing to add exposure until the existing positions\' stops are confirmed');
  }
  if (c.status && c.status !== 'ONLINE') reasons.push('market ' + c.status);
  if (c.minSize && c.size < c.minSize) reasons.push(`size < minimum (${c.minSize})`);
  if (c.minNotional && r.notional < c.minNotional) reasons.push(`notional < minimum ($${c.minNotional})`);
  const sameMarket = (x) => String(x.market).toUpperCase() === String(c.market).toUpperCase();
  const entries = st.orders.filter((o) => o.kind === 'LIMIT' && !o.reduceOnly && !(o.raw && o.raw.reduceOnly));
  // Arcus account 0 is shared with the user's other tools: only Bobby's own positions/orders use Bobby's slots, and a
  // market where anything that is not Bobby's is open (position or order of any kind) is skipped.
  const mine = (x) => p.pf !== 'arcus' || x.bobby === true;
  const busy = new Set([...st.positions.filter(mine).map((x) => x.market), ...entries.filter(mine).map((o) => o.market)]);
  if (p.pf === 'arcus') {
    if (st.positions.some((x) => sameMarket(x) && !x.bobby)) reasons.push(`Arcus: another tool of yours holds a position on ${c.market} (skipped)`);
    if (st.orders.some((o) => sameMarket(o) && !o.bobby)) reasons.push(`Arcus: another tool of yours has open orders on ${c.market} (skipped)`);
  }
  if (busy.size >= cfg.maxPositions && !busy.has(c.market)) reasons.push(`max ${cfg.maxPositions} concurrent positions/entries on ${p.pf} reached`);
  if (st.positions.some(sameMarket) || entries.some(sameMarket)) reasons.push('a position or resting entry already exists on ' + c.market);
  if (p.pf === 'arcus' || p.pf === 'entropy') reasons.push(...await liquidityGate(p, c, r, cp, cfg, net));
  return { ok: reasons.length === 0, p, reasons: [...new Set(reasons)], risk: { slLoss: r.slLoss, tpGain: r.tpGain, notional: r.notional, margin: r.margin,
    maxLoss: cp.maxLoss, weeklyLossUsed: st.weeklyLoss, equity: st.equity, free: st.free, mark: c.mark, drift: r.moved,
    fees: { maker: c.maker, taker: c.taker, ...(p.pf === 'qfex' ? { stopRate: c.stopRate, slippage: c.slippage, category: c.category, preferred: Q.PREFERRED_CATEGORIES.includes(c.category) } : {}), src: c.feeSrc } }, ctx: c };
}

// Liquidity gate (Arcus + Entropy): fail closed. Skips thin markets (OI / 24h volume below the minimum, wide spread) and
// requires loss at SL + the stressed stop slippage of THIS trade's size (walked on the live book) to fit the per-trade cap.
export async function liquidityGate(p, c, r, cp, cfg, net) {
  const o = cfg.lowOi ? cfg.lowOi[p.pf] : L.DEFAULTS, out = [];
  let book = null;
  try {
    if (p.pf === 'arcus') { const b = await net.arcusGet('/v1/l2OrderBook/' + encodeURIComponent(c.market), { nLevels: 50 }); book = { bids: b.bids || [], asks: b.asks || [] }; }
    else { const b = await net.hlInfo({ type: 'l2Book', coin: c.market }); book = { bids: (b.levels[0] || []).map((x) => [x.px, x.sz]), asks: (b.levels[1] || []).map((x) => [x.px, x.sz]) }; }
  } catch { /* fail closed below */ }
  const bs = book && L.bookStats(book.bids, book.asks, o.depthBand);
  if (!bs) return ['Liquidity: order book unavailable or one-sided (fail closed)'];
  if (bs.spread > o.maxSpread) out.push(`Liquidity: spread ${(bs.spread * 100).toFixed(3)}% > ${(o.maxSpread * 100).toFixed(2)}% max`);
  if (c.oiUsd != null && c.oiUsd < o.minOiUsd) out.push(`Liquidity: open interest $${Math.round(c.oiUsd)} < $${o.minOiUsd} minimum`);
  if (c.vol24hUsd != null && c.vol24hUsd < o.minVol24hUsd) out.push(`Liquidity: 24h volume $${Math.round(c.vol24hUsd)} < $${o.minVol24hUsd} minimum`);
  const slip = L.stopSlippageFor(book.bids, book.asks, p.sd === 'long', r.notional || 0, o.stressMult);
  if (!Number.isFinite(slip)) out.push('Liquidity: the book cannot absorb this stop-loss size (fail closed)');
  else if (cp.maxLoss != null && r.slLoss != null && r.slLoss + (r.notional || 0) * slip > cp.maxLoss + 1e-9)
    out.push(`Liquidity: loss at SL incl. stressed stop slippage $${(r.slLoss + r.notional * slip).toFixed(2)} > $${cp.maxLoss.toFixed(2)}`);
  return out;
}

// ---------------------------------------------------------------- request builders (signed, not sent)
async function arcusCtx(cfg, net) {
  const off = await net.arcusClockOffsetMs().catch(() => 0);
  return A.makeCtx({ priv: cfg.arcus.priv, address: cfg.arcus.address, accountIndex: cfg.arcus.accountIndex,
    nowNs: () => BigInt(Math.round(net.now() + off)) * 1000000n + BigInt(Math.floor(Math.random() * 1000)) });
}
let hlNonce = 0;
const nextNonce = (net) => { hlNonce = Math.max(hlNonce + 1, net.now()); return hlNonce; };
export async function buildOpen(ev, cfg, net) {
  const { p, ctx: c } = ev;
  if (p.pf === 'qfex') {
    const entry = Q.buildEntry({ symbol: c.market, isLong: p.sd === 'long', qty: c.size, px: p.px, sl: p.sl, tp: p.tp, clientOrderId: Q.clientOrderId(p.id) });
    if (entry.params.order_type !== 'ALO' || !(entry.params.stop_loss > 0) || !(entry.params.take_profit > 0)) throw new Error('internal: QFEX entry is not ALO with SL+TP');
    return [{ label: 'set leverage 1x (POST /user/leverage)', kind: 'rest', d: Q.leverageRequest(c.market, 1) },
      { label: 'cancel-on-disconnect off (resting entry + stops survive)', kind: 'ws', d: Q.cancelOnDisconnectOff() },
      { label: 'entry ALO GTC + stop_loss + take_profit', kind: 'ws', d: entry }];
  }
  if (p.pf === 'arcus') {
    const ctx = await arcusCtx(cfg, net);
    return [{ label: 'setLeverage 1x isolated', d: A.setLeverage(ctx, c.m, 1, true) },
      { label: 'entry ALO + TP/SL', d: (() => { const d = A.entryTpsl(ctx, c.m, p.sd === 'long' ? 'BUY' : 'SELL', c.sizeStr, { type: 'limit', limitPrice: p.px, takeProfit: p.tp, stopLoss: p.sl, postOnly: true,
          clientId: arcusCid(p.id, 'e'), legClientIds: { sl: arcusCid(p.id, 's'), tp: arcusCid(p.id, 't') } });
        const b = JSON.parse(d.body); if (!b.orders || b.orders[0].timeInForce !== 'ALO' || b.orders.length !== 3 || !b.orders.every((o) => isBobbyCid(o.clientId))) throw new Error('internal: Arcus entry is not ALO with SL+TP and Bobby clientIds'); return d; })() }];
  }
  const [lev, order] = H.buildOpen({ asset: c.mk.asset, szDecimals: c.mk.szDecimals, isBuy: p.sd === 'long', sz: p.sz, leverage: 1, isCross: false,
    type: 'limit', limitPx: p.px, markPx: c.mark, tp: p.tp, sl: p.sl, postOnly: true });
  if (order.orders[0].t.limit.tif !== 'Alo') throw new Error('internal: entry is not Alo');
  const sign = (a) => H.exchangeRequest(cfg.hl.priv, a, nextNonce(net), { isMainnet: !cfg.testnet });
  return [{ label: 'updateLeverage 1x isolated', d: sign(lev) }, { label: 'entry Alo + TP/SL (normalTpsl)', d: sign(order) }];
}

// ---------------------------------------------------------------- send + result parsing
export function arcusError(r) {
  if (!r.ok) return `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;
  if (r.body && !Array.isArray(r.body.responses) && ['ERROR', 'REJECTED'].includes(r.body.status)) return r.body.rejectionReason || r.body.error || r.body.status;
  const errs = (r.body?.responses || []).filter((x) => x && (x.status === 'ERROR' || x.status === 'REJECTED')).map((x) => x.error || x.rejectionReason || x.status);
  return errs.length ? errs.join(' | ') : null;
}
export function hlError(r) {
  if (!r.ok) return `HTTP ${r.status}`;
  const body = r.body;
  if (!body || body.status !== 'ok') return typeof body?.response === 'string' ? body.response : 'response not ok';
  const errs = (body.response?.data?.statuses || []).filter((x) => x && x.error).map((x) => x.error);
  return errs.length ? errs.join(' | ') : null;
}
export const summarize = (reqs) => reqs.map((r) => {
  if (r.kind === 'ws') return { label: r.label, ws: r.d.type, body: r.d };
  if (r.kind === 'rest') return { label: r.label, method: r.d.method, path: r.d.path, body: r.d.body ? JSON.parse(r.d.body) : null };
  const b = r.d.body ? JSON.parse(r.d.body.replace(/:(\d{16,})([,}])/g, ':"$1"$2')) : null;
  if (b && b.signature) b.signature = '<sig>';
  if (b && Array.isArray(b.orders)) b.orders = b.orders.map((o) => ({ ...o, signature: o.signature ? '<sig>' : undefined }));
  return { label: r.label, path: r.d.path, body: b };
});
export async function send(pf, reqs, net) {
  if (pf === 'qfex') return net.qfex.send(reqs);
  const out = [];
  for (const r of reqs) {
    const res = pf === 'arcus' ? await net.sendArcus(r.d) : await net.sendHl(r.d);
    const err = pf === 'arcus' ? arcusError(res) : hlError(res);
    out.push({ label: r.label, status: res.status, ok: !err, error: err, body: res.body });
    if (err) break; // never place the order if the leverage step failed
  }
  return out;
}

// Kill switch: STOP file present, or AUTOTRADER_ENABLED != 1 -> nothing is sent.
export function killReason(cfg, stopExists) {
  if (stopExists) return 'STOP file present';
  if (!cfg.enabled) return 'AUTOTRADER_ENABLED is not 1';
  return null;
}

// ---------------------------------------------------------------- reduce-only commands
export async function buildCancel(pf, market, orderId, cfg, net) {
  if (pf === 'qfex') market = Q.normSymbol(market);
  const st = await accountState(pf, cfg, net);
  const o = st.orders.find((x) => x.id === String(orderId) && String(x.market).toUpperCase() === String(market).toUpperCase());
  if (!o) throw new Error(`order ${orderId} not found on ${market}`);
  if (pf === 'arcus' && !o.bobby) throw new Error(`refusing: Arcus order ${orderId} on ${market} is not Bobby's (another tool of yours)`);
  const pos = st.positions.find((x) => String(x.market).toUpperCase() === String(market).toUpperCase());
  if (pos && o.kind === 'SL' && st.orders.filter((x) => x.kind === 'SL' && x.market === o.market).length <= 1)
    throw new Error('Policy: refusing to cancel the only stop-loss of an open position (close the position instead)');
  if (pf === 'qfex') {
    if (o.stop || o.kind !== 'LIMIT') throw new Error('Policy: QFEX stop orders (SL/TP) are never cancelled by the bot; close the position instead');
    return [{ label: 'cancel ' + o.id, kind: 'ws', d: Q.buildCancel(o.market, o.id) }];
  }
  if (pf === 'arcus') {
    const ms = (await net.arcusGet('/v1/markets')).markets; const m = ms.find((x) => x.marketDisplayName === o.market);
    return [{ label: 'cancel ' + o.id, d: A.cancelOrder(await arcusCtx(cfg, net), m, o.id) }];
  }
  const c = await marketCtx('entropy', { m: o.market, sz: 0 }, cfg, net);
  return [{ label: 'cancel ' + o.id, d: H.exchangeRequest(cfg.hl.priv, H.buildCancel(c.mk.asset, o.id), nextNonce(net), { isMainnet: !cfg.testnet }) }];
}
export async function buildClose(pf, market, cfg, net) {
  if (pf === 'qfex') market = Q.normSymbol(market);
  const st = await accountState(pf, cfg, net);
  const pos = st.positions.find((x) => String(x.market).toUpperCase() === String(market).toUpperCase());
  if (!pos) throw new Error('no open position on ' + market);
  if (pf === 'qfex') {
    const d = Q.buildClosePosition(pos.market, Q.clientOrderId('close'));
    if (d.type !== 'close_position') throw new Error('internal: close is not close_position');
    return [{ label: 'close_position (engine LIMIT IOC, opposite side, sized to the position)', kind: 'ws', d }];
  }
  if (pf === 'arcus') {
    const ms = (await net.arcusGet('/v1/markets')).markets; const m = ms.find((x) => x.marketDisplayName === pos.market);
    if (!pos.bobby) throw new Error(`refusing: the Arcus position on ${pos.market} is not Bobby's (another tool of yours)`);
    const d = A.closePosition(await arcusCtx(cfg, net), m, pos.raw, { slippage: 0.02, clientId: arcusCid('close:' + pos.market + ':' + net.now(), 'c') });
    if (!/"reduceOnly":\s*true/.test(d.body)) throw new Error('internal: close is not reduce-only');
    return [{ label: 'close (reduce-only IOC)', d }];
  }
  const c = await marketCtx('entropy', { m: pos.market, sz: 0 }, cfg, net);
  const a = H.buildClose({ asset: c.mk.asset, szDecimals: c.mk.szDecimals, szi: pos.side === 'long' ? pos.size : -pos.size, markPx: c.mark });
  if (!a.orders.every((o) => o.r === true)) throw new Error('internal: close is not reduce-only');
  return [{ label: 'close (reduce-only IOC)', d: H.exchangeRequest(cfg.hl.priv, a, nextNonce(net), { isMainnet: !cfg.testnet }) }];
}


// ---------------------------------------------------------------- protection guard (every tick, every platform with keys)
// A position is protected when a live stop-loss AND a take-profit exist on its market. A position seen unprotected on two
// consecutive ticks AND for longer than the grace period (QFEX stages the stops right after a fill) is repaired:
//   1. attach the missing leg(s) reduce-only at the ORIGINAL planned level (decision journal), unless the price is already
//      past that level or there is no planned level;
//   2. otherwise, or if attaching failed / did not stick on the next tick: close the position (reduce-only).
// Every action is logged, journaled and written to autotrader/ALERT (JSON lines) for the balances routine to surface.
export const GRACE_MS = { qfex: 120e3, arcus: 60e3, entropy: 60e3 };
const up = (x) => String(x).toUpperCase();
export const guardKey = (pf, market) => `${pf}:${up(market)}`;
export function legsOf(st, market) {
  const same = (o) => up(o.market) === up(market);
  return { sl: st.orders.some((o) => same(o) && o.kind === 'SL'), tp: st.orders.some((o) => same(o) && o.kind === 'TP') };
}
// Planned SL/TP per platform:market from the decision journal (latest live placement wins). Entries carry `plan`; older
// QFEX entries are read from the exchange echo of the entry (symbol, side, stop_loss, take_profit).
export function plansFromJournal(lines) {
  const out = {};
  for (const raw of lines) {
    let e; try { e = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { continue; }
    if (!e || e.mode !== 'live' || e.decision !== 'placed') continue;
    let plan = e.plan;
    if (!plan) {
      const echo = (e.results || []).map((r) => r.echo).find((x) => x && Number(x.stop_loss) > 0 && Number(x.take_profit) > 0 && x.symbol);
      if (echo) plan = { pf: 'qfex', market: echo.symbol, side: up(echo.side) === 'BUY' ? 'long' : 'short', sl: Number(echo.stop_loss), tp: Number(echo.take_profit) };
    }
    if (plan && plan.pf && plan.market) out[guardKey(plan.pf, plan.market)] = { ...plan, id: e.id, t: e.t };
  }
  return out;
}
const pastSl = (side, mark, sl) => mark != null && (side === 'long' ? mark <= sl : mark >= sl);
const pastTp = (side, mark, tp) => mark != null && (side === 'long' ? mark >= tp : mark <= tp);
// Pure decision step (unit-tested). memo = state.guard (persisted between ticks). Returns actions; mutates memo.
export function decideProtection(pf, st, plans, memo, nowMs, { graceMs = GRACE_MS[pf] ?? 60e3 } = {}) {
  const actions = [], seen = new Set();
  for (const pos of st.positions) {
    const key = guardKey(pf, pos.market); seen.add(key);
    const legs = legsOf(st, pos.market);
    if (legs.sl && legs.tp) { if (memo[key]) actions.push({ pf, key, market: pos.market, kind: 'recovered' }); delete memo[key]; actions.push({ pf, key, market: pos.market, kind: 'ok', pos }); continue; }
    const m = memo[key] || (memo[key] = { first: nowMs, ticks: 0, attempts: 0 });
    m.ticks += 1; m.last = nowMs;
    const missing = [!legs.sl && 'sl', !legs.tp && 'tp'].filter(Boolean);
    if (m.ticks < 2 || nowMs - m.first < graceMs) { actions.push({ pf, key, market: pos.market, kind: 'grace', missing, ageMs: nowMs - m.first, pos }); continue; }
    const plan = plans[key] && plans[key].side === pos.side ? plans[key] : null;
    let why = null;
    if (m.attempts >= 1) why = 'attached stop(s) did not stick';
    else if (!plan) why = 'no planned SL/TP in the decision journal';
    else if (missing.includes('sl') && pastSl(pos.side, pos.mark, plan.sl)) why = `price ${pos.mark} already past the planned stop-loss ${plan.sl}`;
    else if (missing.includes('tp') && pastTp(pos.side, pos.mark, plan.tp)) why = `price ${pos.mark} already past the planned take-profit ${plan.tp}`;
    if (why) { actions.push({ pf, key, market: pos.market, kind: 'close', missing, reason: why, pos }); continue; }
    m.attempts += 1;
    actions.push({ pf, key, market: pos.market, kind: 'attach', missing, sl: missing.includes('sl') ? plan.sl : null, tp: missing.includes('tp') ? plan.tp : null, pos });
  }
  for (const k of Object.keys(memo)) if (k.startsWith(pf + ':') && !seen.has(k)) delete memo[k];
  return actions;
}
// Reduce-only requests that attach the missing legs to an OPEN position (signed, not sent).
export async function buildProtect(pf, pos, { sl, tp }, cfg, net) {
  const isLong = pos.side === 'long';
  if (pf === 'qfex') {
    const ref = await qfexRef(net, Q.normSymbol(pos.market));
    const r = Q.roundProposal({ isLong, px: pos.entry || pos.mark || 1, sl: sl ?? 1, tp: tp ?? 1, qty: pos.size }, ref);
    return [sl != null && { label: `attach stop-loss ${r.sl}`, kind: 'ws', d: Q.buildStopOrder({ symbol: pos.market, positionIsLong: isLong, kind: 'SL', qty: pos.size, trig: r.sl }) },
      tp != null && { label: `attach take-profit ${r.tp}`, kind: 'ws', d: Q.buildStopOrder({ symbol: pos.market, positionIsLong: isLong, kind: 'TP', qty: pos.size, trig: r.tp }) }].filter(Boolean);
  }
  if (pf === 'arcus') {
    if (!pos.bobby) throw new Error(`refusing: the Arcus position on ${pos.market} is not Bobby's (another tool of yours)`);
    const ms = (await net.arcusGet('/v1/markets')).markets; const m = ms.find((x) => x.marketDisplayName === pos.market);
    if (!m) throw new Error('Arcus market not found: ' + pos.market);
    const seed = 'guard:' + pos.market + ':' + net.now();
    return [{ label: `attach position TP/SL (sl ${sl ?? '-'} tp ${tp ?? '-'})`, d: A.positionTpsl(await arcusCtx(cfg, net), m, isLong ? 'LONG' : 'SHORT', { stopLoss: sl, takeProfit: tp,
      clientIds: { sl: arcusCid(seed, 's'), tp: arcusCid(seed, 't') } }) }];
  }
  const c = await marketCtx('entropy', { m: pos.market, sz: 0 }, cfg, net);
  const a = H.buildPositionTpsl({ asset: c.mk.asset, szDecimals: c.mk.szDecimals, positionIsLong: isLong, sl, tp });
  if (!a.orders.every((o) => o.r === true)) throw new Error('internal: TP/SL is not reduce-only');
  return [{ label: `attach position TP/SL (sl ${sl ?? '-'} tp ${tp ?? '-'})`, d: H.exchangeRequest(cfg.hl.priv, a, nextNonce(net), { isMainnet: !cfg.testnet }) }];
}
// Bobby-owned Arcus markets (state.guard.__arcusOwn, set when an entry is placed). Released once Bobby has neither a
// position nor an order there (after a 5-min settle window, so a just-sent entry is not dropped before it shows up).
export function releaseArcusOwnership(own, st, nowMs, settleMs = 5 * 60e3) {
  if (!own) return;
  for (const [mk, o] of Object.entries(own)) {
    const pos = st.positions.some((x) => up(x.market) === up(mk));
    const ord = st.orders.some((x) => up(x.market) === up(mk) && isBobbyCid(x.clientId));
    if (pos) { o.open = true; o.seen = nowMs; continue; }
    if (!ord && nowMs - Number(o.t || 0) > settleMs) delete own[mk];
  }
}
export const GUARD_PFS = (cfg) => [cfg.arcus && 'arcus', cfg.hl && 'entropy', cfg.qfex && 'qfex'].filter(Boolean);
// One guard tick. io = { live, kill, log, journal, alert, plans }. readOnly: decide and report, never send.
// last successful guard read per platform (in memory only): the volume tick of the SAME loop iteration reuses it when the
// guard changed nothing, halving the QFEX requests per tick (3 REST + 3 WebSocket connects per read)
export const lastGuardRead = {};
export async function guardTick(cfg, net, memo, io, { readOnly = false } = {}) {
  const report = [];
  for (const pf of GUARD_PFS(cfg)) {
    let st;
    try { st = await accountState(pf, cfg, net); lastGuardRead[pf] = { st, at: net.now() }; }
    catch (e) {
      const k = pf + ':__read'; memo[k] = memo[k] || { first: net.now(), ticks: 0 }; memo[k].ticks += 1;
      io.log('WARN', `guard ${pf}: account read failed (${e.message}); the exchange-side stops are unaffected, re-checking next tick`);
      if (net.now() - memo[k].first > 5 * 60e3 && !memo[k].alerted) { memo[k].alerted = true; io.alert({ pf, kind: 'unknown', reason: 'positions/stops could not be read for > 5 min: ' + e.message }); }
      report.push({ pf, kind: 'unknown', error: e.message }); continue;
    }
    delete memo[pf + ':__read'];
    let view = st;
    if (pf === 'arcus') { // never look at (let alone touch) the user's other tools' positions/orders
      if (!readOnly) releaseArcusOwnership(cfg.arcusOwn, st, net.now());
      for (const p of st.positions.filter((x) => !x.bobby)) report.push({ pf, key: guardKey(pf, p.market), market: p.market, kind: 'foreign', size: p.size, side: p.side });
      view = { ...st, positions: st.positions.filter((x) => x.bobby), orders: st.orders.filter((o) => o.bobby || st.positions.some((x) => x.bobby && up(x.market) === up(o.market))) };
    }
    const resting = view.orders.filter((o) => o.kind === 'LIMIT' && !o.reduceOnly && !o.stop).length;
    for (const a of decideProtection(pf, view, io.plans || {}, memo, net.now())) {
      const { pos, ...pub } = a; const row = { ...pub, size: pos && pos.size, side: pos && pos.side, mark: pos && pos.mark, resting };
      if (a.kind === 'ok' || a.kind === 'grace') { report.push(row); continue; }
      if (a.kind === 'recovered') { io.log('INFO', `guard ${a.key}: protected again`); report.push(row); continue; }
      const what = a.kind === 'attach' ? `attach ${a.missing.join('+')} (sl ${a.sl ?? '-'}, tp ${a.tp ?? '-'})` : `close (${a.reason})`;
      if (readOnly) { report.push({ ...row, would: what }); continue; }
      const held = io.kill ? 'kill switch: ' + io.kill : !io.live ? 'dry run' : null;
      if (held) {
        io.log('ALERT', `guard ${a.key}: UNPROTECTED (missing ${a.missing.join('+')}), would ${what} — not sent (${held})`);
        if (!memo[a.key].alerted) { memo[a.key].alerted = true; io.alert({ pf, market: a.market, kind: 'unprotected', missing: a.missing, would: what, held }); }
        report.push({ ...row, held }); continue;
      }
      let res = [], ok = false, did = a.kind;
      try {
        const reqs = a.kind === 'attach' ? await buildProtect(pf, pos, a, cfg, net) : await buildClose(pf, a.market, cfg, net);
        res = await send(pf, reqs, net); ok = res.length > 0 && res.every((x) => x.ok);
      } catch (e) { res = [{ ok: false, error: e.message }]; }
      if (a.kind === 'attach' && !ok) { // fall back to closing the position
        io.log('ERROR', `guard ${a.key}: attaching ${a.missing.join('+')} failed (${res.map((x) => x.error).filter(Boolean).join(' | ')}); closing the position`);
        try { const r2 = await send(pf, await buildClose(pf, a.market, cfg, net), net); ok = r2.length > 0 && r2.every((x) => x.ok); res = res.concat(r2); did = 'close'; }
        catch (e) { res.push({ ok: false, error: 'close: ' + e.message }); did = 'close'; ok = false; }
      }
      const msg = `guard ${a.key}: ${did === 'attach' ? 'attached ' + a.missing.join('+') : 'closed the position'} ${ok ? 'OK' : 'FAILED'}`;
      io.log(ok ? 'ALERT' : 'ERROR', msg + (ok ? '' : ': ' + res.map((x) => x.error).filter(Boolean).join(' | ')));
      io.journal({ decision: 'guard', pf, market: a.market, action: did, missing: a.missing, reason: a.reason, ok, results: res.map(({ label, status, ok: o, error }) => ({ label, status, ok: o, error })), mode: 'live' });
      io.alert({ pf, market: a.market, kind: did, missing: a.missing, ok, reason: a.reason || null });
      report.push({ ...row, did, ok });
    }
  }
  return report;
}
