// Dry-run simulation of the QFEX volume mode against LIVE PUBLIC prices (MDS mark + BBO; no key, no order).
// Per market and parameter set: flat -> cooldown -> ALO entry at the touch (sides alternate) -> re-quote when stale ->
// fill -> maker TP exit (ALO reduce-only limit) at +tp, protective stop at -sl (taker + slippage) -> round trip.
// Fill models: "conservative" = only when the opposite best price reaches our level; "optimistic" = also when our level vanishes.
//   node tools/qfex_volume_sim.mjs MINUTES OUT.json [SYMBOLS...]
import { writeFileSync, readFileSync } from 'node:fs';
const WS = (await import('ws')).default;
const [mins = '15', out = '/tmp/qfex_sim.json', ...symsArg] = process.argv.slice(2);
const ref = JSON.parse(readFileSync('/tmp/refall.json', 'utf8')).data;
const fees = JSON.parse(readFileSync('/tmp/fees.json', 'utf8')).fees;
const cands = symsArg.length ? symsArg : ref.filter((m) => ['INDEX', 'COMMODITY'].includes(String(m.product_category).toUpperCase()) && m.status === 'ACTIVE').map((m) => m.symbol);
const TPS = (process.env.SIM_TPS || '0.0008,0.001,0.0015').split(',').map(Number), SLS = (process.env.SIM_SLS || '0.003,0.005,0.0088').split(',').map(Number), STALE = 0.0005, SLIP = 0.0005, COOL = [20e3, 60e3];
const book = {}, sims = [];
for (const s of cands) for (const tp of TPS) for (const sl of SLS) for (const model of ['conservative', 'optimistic'])
  sims.push({ s, tp, sl, model, st: 'cool', until: Date.now() + 5e3, side: 1, px: 0, entry: 0, rt: 0, wins: 0, stops: 0, requotes: 0, pnlPct: 0, feePct: 0, holdMs: 0, t0: 0 });
const mk = (s) => fees[s] || { maker_fee: 0.0002, taker_fee: 0.0005 };
function step(sim, now) {
  const b = book[sim.s]; if (!b || b.bid == null || b.ask == null || b.mark == null) return;
  const f = mk(sim.s), long = sim.side > 0;
  if (sim.st === 'cool') { if (now >= sim.until) { sim.st = 'rest'; sim.px = long ? b.bid : b.ask; } return; }
  if (sim.st === 'rest') {
    const filled = long ? (b.ask <= sim.px || (sim.model === 'optimistic' && b.bid < sim.px)) : (b.bid >= sim.px || (sim.model === 'optimistic' && b.ask > sim.px));
    if (filled) { sim.st = 'pos'; sim.entry = sim.px; sim.t0 = now; return; }
    const touch = long ? b.bid : b.ask;
    if (Math.abs(touch - sim.px) / sim.px > STALE) { sim.px = touch; sim.requotes++; }
    return;
  }
  if (sim.st === 'pos') {
    const tpPx = sim.entry * (1 + sim.side * sim.tp), slPx = sim.entry * (1 - sim.side * sim.sl);
    const tpHit = long ? (b.bid >= tpPx || (sim.model === 'optimistic' && b.ask > tpPx)) : (b.ask <= tpPx || (sim.model === 'optimistic' && b.bid < tpPx));
    const slHit = long ? b.mark <= slPx : b.mark >= slPx;
    if (tpHit || slHit) {
      sim.rt++; sim.holdMs += now - sim.t0;
      if (tpHit) { sim.wins++; sim.pnlPct += sim.tp; sim.feePct += 2 * f.maker_fee; }
      else { sim.stops++; sim.pnlPct -= sim.sl + SLIP; sim.feePct += f.maker_fee + Math.max(f.taker_fee, 0.0005); }
      sim.st = 'cool'; sim.until = now + COOL[0] + Math.random() * (COOL[1] - COOL[0]); sim.side = -sim.side;
    }
  }
}
const ws = new WS('wss://mds.qfex.com');
ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', channels: ['mark_price', 'bbo'], symbols: cands })));
let msgs = 0;
ws.on('message', (d) => {
  let m; try { m = JSON.parse(String(d)); } catch { return; } msgs++;
  const b = book[m.symbol] || (book[m.symbol] = { n: 0 });
  if (m.type === 'mark_price') b.mark = Number(m.price);
  if (m.type === 'bbo') { const best = (x) => { const r = (x || []).find((y) => Number(y[1]) > 0); return r ? Number(r[0]) : null; }; b.bid = best(m.bid); b.ask = best(m.ask); b.n++; }
  if (b.bid && b.ask) { b.spreadSum = (b.spreadSum || 0) + (b.ask - b.bid) / ((b.ask + b.bid) / 2); b.spreadN = (b.spreadN || 0) + 1; b.lo = Math.min(b.lo ?? Infinity, b.mark ?? b.bid); b.hi = Math.max(b.hi ?? 0, b.mark ?? b.ask); }
  const now = Date.now(); for (const s of sims) if (s.s === m.symbol) step(s, now);
});
const T0 = Date.now();
setTimeout(() => {
  ws.close();
  const hours = (Date.now() - T0) / 3600e3;
  const mkts = Object.fromEntries(cands.map((s) => { const b = book[s] || {}; const r = ref.find((x) => x.symbol === s);
    return [s, { updates: b.n || 0, spreadBps: b.spreadN ? +(1e4 * b.spreadSum / b.spreadN).toFixed(2) : null, rangePct: b.hi ? +(100 * (b.hi - b.lo) / b.lo).toFixed(3) : null,
      mark: b.mark ?? null, minQty: Number(r.min_quantity), minNotional: b.mark ? +(Number(r.min_quantity) * b.mark).toFixed(2) : null, maxLev: r.default_max_leverage,
      maker: mk(s).maker_fee, taker: mk(s).taker_fee }]; }));
  const res = sims.map(({ s, tp, sl, model, rt, wins, stops, requotes, pnlPct, feePct, holdMs }) => ({ s, tp, sl, model, rt, rtPerHour: +(rt / hours).toFixed(2), wins, stops, requotesPerHour: +(requotes / hours).toFixed(1),
    netPctPerRt: rt ? +((pnlPct - feePct) / rt * 100).toFixed(4) : null, feePctPerRt: rt ? +(feePct / rt * 100).toFixed(4) : null, avgHoldS: rt ? Math.round(holdMs / rt / 1000) : null }));
  writeFileSync(out, JSON.stringify({ minutes: +(hours * 60).toFixed(1), msgs, markets: mkts, results: res }, null, 1));
  process.exit(0);
}, Number(mins) * 60e3);
