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
  const entryFee = notional * feeRate;
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
  if (!(size > 0)) blocks.push('Taille invalide');
  if (maxLev && leverage > maxLev) blocks.push(`Levier ${leverage}× > max du marché (${maxLev}×)`);
  if (isTpsl) {
    const m = Number(mark);
    if (sl && (isLong ? sl >= m : sl <= m)) blocks.push('SL du mauvais côté du prix actuel (déjà franchi)');
    if (tp && (isLong ? tp <= m : tp >= m)) blocks.push('TP du mauvais côté du prix actuel (déjà franchi)');
  } else {
    if (sl && (isLong ? sl >= entry : sl <= entry)) blocks.push('SL du mauvais côté du prix d’entrée');
    if (tp && (isLong ? tp <= entry : tp >= entry)) blocks.push('TP du mauvais côté du prix d’entrée');
  }
  if (!sl) warns.push('Aucun stop-loss');
  if (slLoss != null && slLoss >= maxLoss) warns.push(`Perte au SL ${slLoss.toFixed(2)} $ ≥ ${maxLoss} $`);
  if (sl && liq && (isLong ? sl <= liq : sl >= liq)) warns.push('SL au-delà du prix de liquidation estimé');
  if (expiry && now > expiry) warns.push('Proposition expirée');
  if (moved != null && moved > maxMove) warns.push(`Le prix a bougé de ${(moved * 100).toFixed(2)} % depuis la proposition`);
  if (freeCollateral != null && margin > freeCollateral * 1.001) warns.push(`Marge ${margin.toFixed(2)} $ > collatéral libre ${freeCollateral.toFixed(2)} $`);
  return { entry, notional, margin, entryFee, slLoss, slLocked, slPnl, tpGain, liq, moved, blocks, warns, needsSecondConfirm: warns.length > 0 };
}
