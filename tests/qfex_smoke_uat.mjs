// Public QFEX UAT (qfex.io) market-data smoke test: refdata over REST + mark/BBO over the MDS WebSocket. No key, no orders.
import assert from 'node:assert/strict';
import * as Q from '../src/qfex.js';
const b = Q.bases(process.argv[2] !== 'mainnet');
for (const sym of ['US100-USD', 'GOLD-USD']) {
  const r = await (await fetch(b.rest + '/refdata?ticker=' + sym)).json();
  const ref = r.data.find((x) => x.symbol === sym);
  assert.ok(ref && ref.order_types.includes('ALO'), sym + ' refdata / ALO');
  const q = await Q.mdsQuote(b, sym, { timeoutMs: 15000 });
  assert.ok(q.mark > 0, sym + ' mark');
  const fr = Q.rates(Q.categoryOf(sym, ref), null);
  console.log(`${b.network} ${sym} [${ref.product_category} ${ref.status}] tick ${ref.tick_size} lot ${ref.lot_size} min ${ref.min_quantity} band ${ref.min_price}–${ref.max_price} | mark ${q.mark} bid ${q.bid} ask ${q.ask} | maker ${fr.maker} stop leg ${fr.stopRate}`);
}
process.exit(0);
