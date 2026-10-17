import test from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../src/arcus.js';
import { runTpslReplace } from '../src/replace.js';

// Shapes mirror Arcus /v1/openOrders; all ids and prices are synthetic
const NVDA = { marketId: 28, marketDisplayName: 'NVDA-USD', tickSize: '0.01', stepSize: '0.0000001', markPrice: '100' };
const rows = () => [
  { orderId: 'n-sl', marketId: 28, side: 'BUY', type: 'MARKET', tpslType: 'STOP_LOSS', triggerPrice: '102', isPositionTPSL: true, status: 'UNTRIGGERED' },
  { orderId: 'n-tp', marketId: 28, side: 'BUY', type: 'MARKET', tpslType: 'TAKE_PROFIT', triggerPrice: '95.5', isPositionTPSL: true, status: 'UNTRIGGERED' },
  { orderId: 'g-sl', marketId: 20, side: 'SELL', type: 'MARKET', tpslType: 'STOP_LOSS', triggerPrice: '48.2', isPositionTPSL: null, parentOrderId: 'e7', status: 'UNTRIGGERED' },
  { orderId: 'g-tp', marketId: 20, side: 'SELL', type: 'MARKET', tpslType: 'TAKE_PROFIT', triggerPrice: '55', isPositionTPSL: null, parentOrderId: 'e7', status: 'UNTRIGGERED' },
];

test('plan: SL-only change on a position-level pair cancels both, keeps the TP', () => {
  const p = A.planTpslReplace(rows(), 28, { stopLoss: '101' });
  assert.deepEqual(p.cancelFirst.map((o) => o.orderId).sort(), ['n-sl', 'n-tp']);
  assert.deepEqual(p.cancelAfter, []);
  assert.deepEqual(p.place, { tp: '95.5', sl: '101' });
  assert.deepEqual(p.carried, { tp: true, sl: false });
  assert.deepEqual(p.restore, { tp: '95.5', sl: '102' });
  assert.equal(p.replaces, true);
});
test('plan: entry-linked legs are cancelled only after, and only for the replaced type', () => {
  const p = A.planTpslReplace(rows(), 20, { stopLoss: '50.5' });
  assert.deepEqual(p.cancelFirst, []);
  assert.deepEqual(p.cancelAfter.map((o) => o.orderId), ['g-sl']);
  assert.deepEqual(p.place, { tp: null, sl: '50.5' });
  assert.deepEqual(p.current, { tp: ['55'], sl: ['48.2'] });
});
test('plan: no existing legs = plain placement; needs tp or sl', () => {
  const p = A.planTpslReplace(rows(), 99, { stopLoss: '1', takeProfit: '2' });
  assert.equal(p.replaces, false); assert.deepEqual(p.place, { tp: '2', sl: '1' });
  assert.throws(() => A.planTpslReplace(rows(), 28, {}));
});
test('tpslPlaced compares snapped triggers', () => {
  const o = [{ orderId: 'x', marketId: 28, tpslType: 'STOP_LOSS', triggerPrice: '101', isPositionTPSL: true, status: 'UNTRIGGERED' }];
  assert.equal(A.tpslPlaced(o, NVDA, { sl: '101.004', tp: null }), true);
  assert.equal(A.tpslPlaced(o, NVDA, { sl: '101', tp: '95' }), false);
});

// Simulated engine: async cancels (visible after `lag` polls), position-level uniqueness enforced at placement.
function engine({ lag = 2, rejectPlace = 0, dropCancel = false } = {}) {
  let book = rows(); const pending = []; let polls = 0, n = 0; const log = [];
  const tick = () => { polls++; for (const p of [...pending]) if (polls >= p.at) { book = book.filter((o) => o.orderId !== p.id); pending.splice(pending.indexOf(p), 1); } };
  return { log, book: () => book,
    mkCancel: (id) => ({ kind: 'cancel', id }), mkPlace: () => ({ kind: 'place', ts: ++n }),
    send: async (r) => {
      log.push(r.kind + (r.id ? ':' + r.id : ''));
      if (r.kind === 'cancel') { if (!dropCancel) pending.push({ id: r.id, at: polls + lag }); return { ok: true, status: 202 }; }
      tick();
      if (rejectPlace > 0) { rejectPlace--; return { ok: true, status: 200, error: 'POSITION_TPSL_ALREADY_EXISTS' }; }
      if (book.some((o) => o.marketId === 28 && o.isPositionTPSL)) return { ok: true, status: 200, error: 'POSITION_TPSL_ALREADY_EXISTS' };
      book.push({ orderId: 'new-sl', marketId: 28, tpslType: 'STOP_LOSS', triggerPrice: '101', isPositionTPSL: true, status: 'UNTRIGGERED' },
        { orderId: 'new-tp', marketId: 28, tpslType: 'TAKE_PROFIT', triggerPrice: '95.5', isPositionTPSL: true, status: 'UNTRIGGERED' });
      return { ok: true, status: 202 };
    },
    openOrders: async () => { tick(); return book; } };
}
const fast = { sleep: async () => {}, now: (() => { let t = 0; return () => (t += 100); })() };

test('replace: cancel -> wait gone -> place -> verified, TP carried over, SL never doubled at placement', async () => {
  const e = engine();
  const plan = A.planTpslReplace(e.book(), 28, { stopLoss: '101' });
  const r = await runTpslReplace({ plan, m: NVDA, marketName: 'NVDA-USD', ...e, ...fast });
  assert.equal(r.ok, true, JSON.stringify(r.results));
  assert.deepEqual(e.log, ['cancel:n-sl', 'cancel:n-tp', 'place']);
  const sl = e.book().filter((o) => o.marketId === 28 && o.tpslType === 'STOP_LOSS');
  assert.deepEqual(sl.map((o) => o.triggerPrice), ['101']);
  assert.ok(e.book().some((o) => o.orderId === 'new-tp' && o.triggerPrice === '95.5'));
});
test('replace: transient POSITION_TPSL_ALREADY_EXISTS is retried', async () => {
  const e = engine({ rejectPlace: 1 });
  const plan = A.planTpslReplace(e.book(), 28, { stopLoss: '101' });
  const r = await runTpslReplace({ plan, m: NVDA, marketName: 'NVDA-USD', ...e, ...fast });
  assert.equal(r.ok, true); assert.deepEqual(e.log.filter((x) => x === 'place').length, 2);
});
test('replace: if the old legs never go away, the old SL is still there -> failure without critical alarm, restore offered', async () => {
  const e = engine({ dropCancel: true });
  const plan = A.planTpslReplace(e.book(), 28, { stopLoss: '101' });
  const r = await runTpslReplace({ plan, m: NVDA, marketName: 'NVDA-USD', ...e, ...fast });
  assert.equal(r.ok, false); assert.equal(r.critical, null); assert.deepEqual(r.restore, { tp: '95.5', sl: '102' });
  assert.ok(e.book().some((o) => o.orderId === 'n-sl'));
});
test('replace: placement hard-fails after cancel -> critical "SANS stop-loss" + restore values', async () => {
  const e = engine();
  const send0 = e.send;
  e.send = async (r) => (r.kind === 'place' ? { ok: false, status: 400, error: 'HTTP 400 bad trigger' } : send0(r));
  const plan = A.planTpslReplace(e.book(), 28, { stopLoss: '101' });
  const r = await runTpslReplace({ plan, m: NVDA, marketName: 'NVDA-USD', ...e, ...fast });
  assert.equal(r.ok, false); assert.match(r.critical, /SANS stop-loss/); assert.deepEqual(r.restore, { tp: '95.5', sl: '102' });
});
test('replace: entry-linked SL cancelled only after the new SL is live', async () => {
  const e = engine();
  const book0 = e.book();
  const plan = A.planTpslReplace(book0, 20, { stopLoss: '50.5' });
  const GLD = { marketId: 20, tickSize: '0.01' };
  const log = []; let live = false;
  const r = await runTpslReplace({ plan, m: GLD, marketName: 'GLD-USD', ...fast, mkCancel: (id) => ({ kind: 'cancel', id }), mkPlace: () => ({ kind: 'place' }),
    send: async (q) => { log.push(q.kind + ':' + (q.id || '') + ':' + live); if (q.kind === 'place') live = true; return { ok: true, status: 202 }; },
    openOrders: async () => (live ? [{ orderId: 'z', marketId: 20, tpslType: 'STOP_LOSS', triggerPrice: '50.5', isPositionTPSL: true }] : []) });
  assert.equal(r.ok, true); assert.deepEqual(log, ['place::false', 'cancel:g-sl:true']);
});
