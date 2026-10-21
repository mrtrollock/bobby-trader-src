// Live fee rates, read from documented public endpoints, with the hardcoded FEES as fallback.
//  Arcus      : per-market schedule on GET /v1/markets (effective/base maker+taker ppm), tier level + referral discount
//               from GET /v1/account/stats?include=feeTier, exchange table GET /v1/feetiers as second source.
//  Hyperliquid: POST /info {type:"userFees", user} -> userAddRate (maker) / userCrossRate (taker). Main dex only:
//               HIP-3 dexes (Entropy "io") set their own fees, so the configured io fallback is kept for them.
//  TxFlow     : POST /info {type:"userFees", asset, user} -> userAddRate / userCrossRate.
import { FEES } from './risk.js';

export const FALLBACK = { arcus: { maker: 0, taker: FEES.arcus }, hl_main: { maker: 0.00015, taker: FEES.hl_main },
  hl_io: { maker: FEES.hl_io, taker: FEES.hl_io }, txflow: { maker: 0.00015, taker: 0.00045 } };

const num = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));

// m: an Arcus market row; stats: /v1/account/stats body (optional); table: /v1/feetiers body (optional)
export function arcusRates(m, stats, table) {
  const tier = stats && stats.tradingFeeTier ? stats.tradingFeeTier : null;
  const disc = tier && num(tier.feeDiscountPpm) ? num(tier.feeDiscountPpm) / 1e6 : 0;
  let maker = num(m && (m.effectiveMakerFeePpm ?? m.baseMakerFeePpm));
  let taker = num(m && (m.effectiveTakerFeePpm ?? m.baseTakerFeePpm));
  let source = 'marché';
  if ((maker == null || taker == null) && table && Array.isArray(table.tiers)) {
    const lvl = tier ? Number(tier.level) : 0;
    const row = table.tiers.find((t) => Number(t.level) === lvl) || table.tiers[0];
    if (row) { maker ??= num(row.maker_fee_ppm); taker ??= num(row.taker_fee_ppm); source = '/v1/feetiers'; }
  }
  if (maker == null || taker == null) return { ...FALLBACK.arcus, source: 'défaut' };
  const apply = (ppm) => (ppm > 0 ? ppm * (1 - disc) : ppm) / 1e6; // discount only on positive fees (rebates untouched)
  return { maker: apply(maker), taker: apply(taker), source };
}

// body: Hyperliquid or TxFlow userFees payload (TxFlow wraps it in {success, data})
export function userFeesRates(body, fallback) {
  const d = body && body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : body;
  const maker = num(d && d.userAddRate), taker = num(d && d.userCrossRate);
  if (maker == null || taker == null || taker <= 0) return { ...fallback, source: 'défaut' };
  return { maker, taker, source: 'userFees' };
}
