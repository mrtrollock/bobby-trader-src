// Arcus TP/SL replacement runner (DOM-free so it can be tested against a simulated engine).
// Sequence: cancel position-level legs -> wait until gone -> place new positionTpsl (re-signed each try, retried on
// POSITION_TPSL_ALREADY_EXISTS) -> verify it is live -> only then cancel entry-linked legs of the replaced types.
import * as A from './arcus.js';

export async function waitFor(fn, { timeoutMs = 8000, everyMs = 500, sleep, now = () => Date.now() } = {}) {
  const t0 = now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (now() - t0 > timeoutMs) return null;
    await sleep(everyMs);
  }
}

export const legLabel = (o) => `Cancel ${o.isPositionTPSL ? 'position' : 'entry-linked'} ${o.tpslType === 'STOP_LOSS' ? 'SL' : 'TP'} @ ${o.triggerPrice}`;

// deps: { plan, m, marketName, mkPlace() -> req, mkCancel(orderId) -> req, send(req) -> {ok,status,error,body},
//         openOrders() -> rows, sleep(ms), now() }
export async function runTpslReplace(deps) {
  const { plan, m, marketName, mkPlace, mkCancel, send, openOrders, sleep, now = () => Date.now() } = deps;
  const out = [];
  const step = async (label, req, isCancel) => {
    const r = await send(req); let err = r.error;
    if (isCancel && err && /NOT_FOUND|ALREADY_CANCEL|ALREADY_FILLED/i.test(err)) err = null; // already gone = fine
    const row = { label, status: r.status, ok: !err, error: err || null, body: r.body }; out.push(row); return row;
  };
  const W = (fn, timeoutMs, everyMs) => waitFor(fn, { timeoutMs, everyMs, sleep, now });
  for (const o of plan.cancelFirst) await step(legLabel(o), mkCancel(String(o.orderId)), true);
  if (plan.cancelFirst.length) {
    const ids = new Set(plan.cancelFirst.map((o) => String(o.orderId)));
    const gone = await W(async () => !(await openOrders()).some((o) => ids.has(String(o.orderId))), 8000, 400);
    out.push({ label: 'Old position TP/SL removed', ok: !!gone, error: gone ? null : 'Still visible after 8 s' });
  }
  const placeLbl = `Nouveau TP/SL position (SL ${plan.place.sl ?? '—'} · TP ${plan.place.tp ?? '—'})`;
  let placed = false;
  for (let i = 0; i < 3 && !placed; i++) {
    if (i) await sleep(1200);
    const row = await step(placeLbl + (i ? ` (essai ${i + 1})` : ''), mkPlace(), false);
    if (!row.ok && !/POSITION_TPSL_ALREADY_EXISTS/.test(row.error || '')) break;
    if (!row.ok) row.retried = true;
    if (row.ok) placed = !!(await W(async () => A.tpslPlaced(await openOrders(), m, plan.place), 6000, 500));
    if (row.ok && !placed) { row.ok = false; row.error = 'Sent but not visible in open orders after 6 s'; }
  }
  if (!placed) {
    let rows = null; try { rows = await openOrders(); } catch { /* unknown */ }
    const noSl = rows ? !A.hasStopLoss(rows, m.marketId) : true;
    return { ok: false, results: out, restore: plan.restore,
      critical: noSl ? `Position ${marketName} has NO stop-loss right now. Restore the old SL immediately (button below) or place it in the Arcus app.` : null };
  }
  out.push({ label: 'Nouveaux TP/SL visibles ✅', ok: true });
  for (const o of plan.cancelAfter) await step(legLabel(o), mkCancel(String(o.orderId)), true);
  return { ok: out.every((x) => x.ok || x.retried), results: out };
}
