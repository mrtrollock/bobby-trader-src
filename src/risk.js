// Risk math for the confirm screen. All inputs are numbers.
export const FEES = { arcus: 0.000213, hl_io: 0.0001, hl_main: 0.00045 };
export const MAX_LOSS = 100;

// Isolated liquidation estimate: margin M = notional/lev; liq when M + pnl = mmf * size * P
export function liqPrice({ isLong, entry, leverage, mmf }) {
  const im = 1 / leverage;
  const p = isLong ? (entry * (1 - im)) / (1 - mmf) : (entry * (1 + im)) / (1 + mmf);
  return p > 0 ? p : 0;
}

export function computeRisk(p) {
  const { isLong, size, leverage, mark, feeRate, mmf, maxLev, sl, tp, ref, expiry, now = Date.now() / 1000,
    freeCollateral = null, maxLoss = MAX_LOSS, maxMove = 0.01, mode = 'open' } = p;
  // mode 'tpsl': TP/SL on an existing position. Sides are checked against the CURRENT MARK
  // (a SL moved past the entry in the profit direction is valid: it locks a gain).
  const entry = p.type === 'limit' ? Number(p.limitPx) : Number(mark);
  const notional = size * entry;
  const margin = notional / leverage;
  const entryFee = notional * (p.entryFeeRate ?? feeRate);
  const s = isLong ? 1 : -1;
  const isTpsl = mode === 'tpsl';
  const slPnl = sl ? s * (sl - entry) * size - entryFee - size * sl * feeRate : null;
  let slLoss = sl ? Math.max(0, -s * (sl - entry) * size) + entryFee + size * sl * feeRate : null;
  let slLocked = null;
  if (isTpsl && sl) { if (slPnl >= 0) { slLocked = slPnl; slLoss = 0; } else slLoss = -slPnl; }
  const tpGain = tp ? s * (tp - entry) * size - entryFee - size * tp * feeRate : null;
  const liq = liqPrice({ isLong, entry, leverage, mmf });
  const moved = ref ? Math.abs(mark - ref) / ref : null;
  const blocks = [], warns = [];
  if (!(size > 0)) blocks.push('Invalid size');
  if (maxLev && leverage > maxLev) blocks.push(`Leverage ${leverage}× > market max (${maxLev}×)`);
  if (isTpsl) {
    const m = Number(mark);
    if (sl && (isLong ? sl >= m : sl <= m)) blocks.push('SL on the wrong side of the current price (already crossed)');
    if (tp && (isLong ? tp <= m : tp >= m)) blocks.push('TP on the wrong side of the current price (already crossed)');
  } else {
    if (sl && (isLong ? sl >= entry : sl <= entry)) blocks.push('SL on the wrong side of the entry price');
    if (tp && (isLong ? tp <= entry : tp >= entry)) blocks.push('TP on the wrong side of the entry price');
  }
  if (!sl) warns.push('No stop-loss');
  if (slLoss != null && slLoss >= maxLoss) warns.push(`Loss at SL $${slLoss.toFixed(2)} ≥ $${maxLoss}`);
  if (sl && liq && (isLong ? sl <= liq : sl >= liq)) warns.push('SL beyond the estimated liquidation price');
  if (expiry && now > expiry) warns.push('Proposal expired');
  if (moved != null && moved > maxMove) warns.push(`Price moved ${(moved * 100).toFixed(2)}% since the proposal`);
  if (freeCollateral != null && margin > freeCollateral * 1.001) warns.push(`Margin $${margin.toFixed(2)} > free collateral $${freeCollateral.toFixed(2)}`);
  return { entry, notional, margin, entryFee, slLoss, slLocked, slPnl, tpGain, liq, moved, blocks, warns, needsSecondConfirm: warns.length > 0 };
}

// ---------------------------------------------------------------- conservative farming policy (points + capital preservation)
// Every rule here is a HARD block (the approve button stays disabled), not a red warning.
// Configurable from Settings; these are the defaults.
export const POLICY = {
  makerOnly: true,          // entries must be post-only limit orders (Arcus ALO / Hyperliquid & TxFlow Alo / QFEX ALO)
  maxLeverage: 1,           // 1x isolated: notional <= margin
  requireStopLoss: true,    // every new position carries a stop-loss
  maxLossPct: 0.01,         // max loss at SL (fees incl.) per trade, as a fraction of platform capital (1 % of $300 = $3)
  weeklyLossCap: 50,        // $ per platform per week (Mon 00:00 UTC); once used up, new proposals are blocked
  capital: { arcus: 300, hl: 300, txflow: 300, qfex: 100 }, // QFEX: user's starting size; the autotrader uses live equity // $ per platform (used for the % rule)
  marginAboveFreeBlocks: true,
  // per-platform overrides (absolute $ instead of % of capital). QFEX: user's choice 2026-10-21; per-trade loss is also
  // capped at maxLossEquityPct of live equity and, via the weekly rule below, at the remaining weekly budget.
  perPlatform: { qfex: { weeklyLossCap: 30, maxTradeLossUsd: 3, maxLossEquityPct: 0.05 } },
};
// Effective policy for one platform: applies the perPlatform override (cfg: { weeklyLossCap, maxTradeLossUsd }) on top.
export function policyFor(pf, base = POLICY, override = {}) {
  const o = { ...((base.perPlatform || {})[pf] || {}), ...Object.fromEntries(Object.entries(override).filter(([, v]) => v != null)) };
  if (!Object.keys(o).length) return base;
  return { ...base, weeklyLossCap: o.weeklyLossCap ?? base.weeklyLossCap, maxTradeLossUsd: o.maxTradeLossUsd, maxLossEquityPct: o.maxLossEquityPct };
}
export const PLATFORMS = ['arcus', 'hl', 'txflow', 'qfex'];

// Start of the current week: Monday 00:00 UTC (also the TxFlow points epoch boundary).
export function weekStartUtc(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}
export const weekEndUtc = (nowMs = Date.now()) => weekStartUtc(nowMs) + 7 * 86400e3;

// Realized loss this week from fills: sum of closedPnl minus fees; a net gain counts as 0 used.
// fills: [{ time (ms), closedPnl, fee }]; rows outside [from, to) are ignored.
// feeIncluded: Arcus closedPnl is already net of the fill fee (docs); Hyperliquid's is not. TxFlow is not documented,
// so it is treated like Hyperliquid (fee subtracted), which can only overstate the loss (conservative).
export function realizedLoss(fills, from, to = Infinity, { feeIncluded = false } = {}) {
  let pnl = 0;
  for (const f of fills || []) {
    const t = Number(f.time);
    if (!(t >= from && t < to)) continue;
    pnl += Number(f.closedPnl || 0) - (feeIncluded ? 0 : Number(f.fee || 0));
  }
  return pnl < 0 ? -pnl : 0;
}

// p: proposal, r: computeRisk() result, opts: { policy, pf, weeklyLossUsed, isEntry }
export function checkPolicy(p, r, { policy = POLICY, weeklyLossUsed = 0, freeCollateral = null } = {}) {
  const blocks = [], warns = [];
  const pf = p.pf, act = p.act || 'open';
  const cap = Number((policy.capital || {})[pf] ?? 0);
  // absolute per-trade cap (e.g. QFEX $3) bounded by maxLossEquityPct of the capital (live equity in the autotrader)
  const abs = policy.maxTradeLossUsd != null ? Math.min(Number(policy.maxTradeLossUsd), cap > 0 && policy.maxLossEquityPct != null ? cap * Number(policy.maxLossEquityPct) : Infinity) : null;
  const maxLoss = abs != null ? abs : cap > 0 ? cap * Number(policy.maxLossPct) : null;
  const capTxt = abs != null ? `$${Number(policy.maxTradeLossUsd).toFixed(2)} max per trade, ≤ ${(Number(policy.maxLossEquityPct ?? 1) * 100).toFixed(0)}% of $${cap}` : `${(policy.maxLossPct * 100).toFixed(1)}% of $${cap}`;
  const used = Number(weeklyLossUsed) || 0;
  if (act === 'cancel') return { blocks, warns, maxLoss, used }; // cancelling only reduces risk
  if (act === 'open') {
    if (policy.makerOnly && p.et !== 'limit') blocks.push('Policy: maker-only entries (post-only limit order), no market orders');
    if (policy.maxLeverage && Number(p.lev) > Number(policy.maxLeverage)) blocks.push(`Policy: leverage ${p.lev}× > ${policy.maxLeverage}× max`);
    if (policy.requireStopLoss && (p.sl == null || p.sl === '')) blocks.push('Policy: stop-loss required');
    if (maxLoss != null && r && r.slLoss != null && r.slLoss > maxLoss + 1e-9)
      blocks.push(`Policy: loss at SL $${r.slLoss.toFixed(2)} > $${maxLoss.toFixed(2)} (${capTxt})`);
    if (policy.weeklyLossCap != null) {
      if (used >= policy.weeklyLossCap) blocks.push(`Policy: weekly loss cap reached ($${used.toFixed(2)} / $${policy.weeklyLossCap}), trading resumes Monday 00:00 UTC`);
      else if (r && r.slLoss != null && used + r.slLoss > policy.weeklyLossCap + 1e-9)
        blocks.push(`Policy: this trade could exceed the weekly cap ($${used.toFixed(2)} + $${r.slLoss.toFixed(2)} > $${policy.weeklyLossCap})`);
    }
    const free = freeCollateral ?? null;
    if (policy.marginAboveFreeBlocks && free != null && r && r.margin > free * 1.001) blocks.push('Policy: margin above free collateral');
  }
  if (act === 'tpsl' && policy.requireStopLoss && (p.sl == null || p.sl === '') && r && r.keepsStop === false)
    blocks.push('Policy: the position would be left without a stop-loss');
  return { blocks, warns, maxLoss, used };
}

// Actions that move funds or touch vaults are never built or sent by this app (no deposit/withdraw churn, no vault transfers).
export const FORBIDDEN_ACTIONS = new Set(['withdraw', 'withdraw3', 'usdSend', 'spotSend', 'tokenSend', 'usdClassTransfer', 'vaultTransfer',
  'subAccountTransfer', 'sendAsset', 'approveBuilderFee', 'createVault', 'cDeposit', 'cWithdraw', 'perpDexClassTransfer']);
export const FORBIDDEN_ARCUS_PATHS = [/\/v1\/withdraw/i, /\/v1\/transfer/i, /\/v1\/deposit/i, /vault/i];
export function assertTradeOnly(kind, x) {
  if (kind === 'action') { if (x && FORBIDDEN_ACTIONS.has(x.type)) throw new Error('Action forbidden by policy: ' + x.type); return; }
  if (kind === 'arcus') { if (FORBIDDEN_ARCUS_PATHS.some((re) => re.test(String(x && x.path)))) throw new Error('Arcus request forbidden: ' + x.path); }
}
