// Read-only: QFEX volume-mode fills per time window (round trips, volume, fees, PnL). Never prints keys or the account id.
// usage: node tools/qfex_vol_report.mjs <fromISO> <toISO> [<fromISO> <toISO> ...]   (env loaded)
import * as C from '../autotrader/core.js';
import * as Q from '../src/qfex.js';
const env = { ...process.env }; delete env.HL_AGENT_PRIVATE_KEY; delete env.ARCUS_API_PRIVATE_KEY;
const cfg = C.loadConfig(env), net = C.realNet(cfg);
const args = process.argv.slice(2), from = Math.min(...args.filter((_, i) => i % 2 === 0).map((x) => Date.parse(x)));
const rows = [];
for (let off = 0; off <= 20000; off += 1000) {
  const r = await net.qfex.get('/user/trade', { start_time: new Date(from).toISOString(), limit: 1000, offset: off }, { accountId: cfg.qfex.accountId });
  const d = (r && r.data) || []; rows.push(...d); if (d.length < 1000) break;
}
const t = Q.tradeRows(rows).filter((x) => x.m !== 'GOLD-USD');
for (let i = 0; i < args.length; i += 2) {
  const a = Date.parse(args[i]), b = Date.parse(args[i + 1]), w = t.filter((x) => x.time >= a && x.time < b), h = (b - a) / 3600e3;
  const closes = w.filter((x) => x.closedPnl !== 0), vol = w.reduce((s, x) => s + Math.abs(x.px * x.sz), 0), fees = w.reduce((s, x) => s + x.fee, 0);
  const gross = closes.reduce((s, x) => s + x.closedPnl, 0), losers = closes.filter((x) => x.closedPnl < 0);
  const byM = {}; for (const x of closes) byM[x.m] = (byM[x.m] || 0) + 1;
  console.log(JSON.stringify({ window: [args[i], args[i + 1]], hours: +h.toFixed(2), fills: w.length, roundTrips: closes.length, rtPerHour: +(closes.length / h).toFixed(1),
    volume: +vol.toFixed(2), volPerHour: +(vol / h).toFixed(0), fees: +fees.toFixed(4), grossPnl: +gross.toFixed(4), netPnl: +(gross - fees).toFixed(4),
    losers: losers.length, worstLoss: losers.length ? +Math.min(...losers.map((x) => x.closedPnl)).toFixed(4) : 0, avgLoss: losers.length ? +(losers.reduce((s, x) => s + x.closedPnl, 0) / losers.length).toFixed(4) : 0,
    avgPerRt: closes.length ? +((gross - fees) / closes.length).toFixed(4) : 0, byMarket: byM, projMonth: Math.round(vol / h * 6.5 * 21) }));
}
