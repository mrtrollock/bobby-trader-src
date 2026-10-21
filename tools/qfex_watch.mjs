// Read-only QFEX trade-socket watcher: subscribes to order_responses, stop_orders, fills, positions, balances and polls
// get_user_orders; writes every message (user/account ids removed, secrets redacted) as JSONL. Sends no order.
//   node tools/qfex_watch.mjs OUT.jsonl MINUTES
import { appendFileSync } from 'node:fs';
import * as Q from '../src/qfex.js';
import * as C from '../autotrader/core.js';
const [out = '/tmp/qfex_watch.jsonl', mins = '12'] = process.argv.slice(2);
const cfg = C.loadConfig(process.env), secrets = C.secretsOf(cfg);
const red = (s) => { let t = s; for (const k of secrets) if (k) t = t.split(k).join('<redacted>'); return t; };
const scrub = (o) => (Array.isArray(o) ? o.map(scrub) : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, /user_id|account_id|^user$|api_key/i.test(k) ? '<id>' : scrub(v)])) : o);
const s = await Q.openSession(cfg.bases.qfex, cfg.qfex);
const orig = s._in.bind(s);
s._in = (d) => { try { appendFileSync(out, red(JSON.stringify({ t: new Date().toISOString(), m: scrub(JSON.parse(String(d))) })) + '\n'); } catch { /* */ } orig(d); };
s.send({ type: 'subscribe', params: { channels: ['order_responses', 'stop_orders', 'fills', 'positions', 'balances'] } });
const poll = () => s.send({ type: 'get_user_orders', params: { limit: 200, offset: 0 } });
poll(); const iv = setInterval(poll, 60000);
setTimeout(() => { clearInterval(iv); s.close(); process.exit(0); }, Number(mins) * 60000);
