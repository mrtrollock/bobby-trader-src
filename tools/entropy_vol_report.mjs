// Read-only: Entropy (Hyperliquid io dex) fills of the Bobby SUBACCOUNT per time window: round trips, volume, fees, PnL.
// Public info API only (no key needed); never prints addresses. Bobby is the only trader on the subaccount.
// usage: node tools/entropy_vol_report.mjs <fromISO> <toISO> [<fromISO> <toISO> ...]   (env with HL_SUBACCOUNT_ADDRESS loaded)
import * as API from '../src/api.js';
const sub = String(process.env.HL_SUBACCOUNT_ADDRESS || '').trim();
if (!/^0x[0-9a-fA-F]{40}$/.test(sub)) { console.error('HL_SUBACCOUNT_ADDRESS is not set'); process.exit(64); }
const base = API.bases(process.env.AUTOTRADER_NETWORK === 'testnet').hl;
const args = process.argv.slice(2); if (!args.length || args.length % 2) { console.error('usage: <fromISO> <toISO> ...'); process.exit(64); }
const from = Math.min(...args.filter((_, i) => i % 2 === 0).map((x) => Date.parse(x)));
const rows = []; let start = from;
for (let i = 0; i < 20; i++) { // userFillsByTime returns at most 2000 rows per call: page by time
  const d = (await API.hlInfo(base, { type: 'userFillsByTime', user: sub, startTime: start })) || [];
  rows.push(...d); if (d.length < 2000) break; start = Math.max(...d.map((f) => Number(f.time))) + 1;
}
const t = rows.filter((f) => String(f.coin).startsWith('io:')).map((f) => ({ time: Number(f.time), m: f.coin, px: Number(f.px), sz: Number(f.sz), fee: Number(f.fee || 0),
  closedPnl: Number(f.closedPnl || 0), maker: f.crossed === false, dir: f.dir, bobby: String(f.cloid || '').toLowerCase().startsWith('0xb0bb0e') }));
for (let i = 0; i < args.length; i += 2) {
  const a = Date.parse(args[i]), b = Date.parse(args[i + 1]), w = t.filter((x) => x.time >= a && x.time < b), h = (b - a) / 3600e3;
  const closes = w.filter((x) => /^Close/.test(x.dir || '') || x.closedPnl !== 0), vol = w.reduce((s, x) => s + Math.abs(x.px * x.sz), 0), fees = w.reduce((s, x) => s + x.fee, 0);
  const gross = closes.reduce((s, x) => s + x.closedPnl, 0), losers = closes.filter((x) => x.closedPnl < 0), byM = {};
  for (const x of closes) byM[x.m] = (byM[x.m] || 0) + 1;
  console.log(JSON.stringify({ window: [args[i], args[i + 1]], hours: +h.toFixed(2), fills: w.length, makerFills: w.filter((x) => x.maker).length, roundTrips: closes.length,
    rtPerHour: +(closes.length / h).toFixed(1), volume: +vol.toFixed(2), volPerHour: +(vol / h).toFixed(0), fees: +fees.toFixed(4), grossPnl: +gross.toFixed(4), netPnl: +(gross - fees).toFixed(4),
    lossPerVolBp: vol ? +((gross - fees) / vol * 1e4).toFixed(2) : null, losers: losers.length, worstLoss: losers.length ? +Math.min(...losers.map((x) => x.closedPnl)).toFixed(4) : 0,
    byMarket: byM, projMonth: Math.round(vol / h * 24 * 30), note: 'Entropy cashback (paid in USDC to the primary wallet) is not included' }));
}
