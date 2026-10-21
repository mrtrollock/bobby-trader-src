// QFEX end-to-end DRY RUN over real WebSocket framing: a local mock trade/MDS server (ws.WebSocketServer on 127.0.0.1)
// + mocked REST. Runs verify -> status -> queue (dry run) -> cancel/close builders exactly as the CLI does.
// Nothing touches QFEX; no order exists anywhere. Usage: npm run e2e:qfex
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import * as Q from '../src/qfex.js';
import * as C from '../autotrader/core.js';
import { processQueue } from '../autotrader/cli.js';
import { fakeFetch, ACCT, USER } from './qfex_mock.mjs';
import { randHex } from './helpers.mjs';

const state = { mark: 29600, bid: 29599, ask: 29601, orders: [], stops: [], positions: [] };
const seen = [];
const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((r) => wss.once('listening', r));
const port = wss.address().port;
wss.on('connection', (sock, req) => {
  const mds = req.url.startsWith('/mds'); let authed = false;
  const reply = (m) => sock.send(JSON.stringify(m));
  sock.on('message', (raw) => {
    const m = JSON.parse(String(raw)); seen.push({ mds, m });
    if (mds) { for (const s of m.symbols) { reply({ type: 'mark_price', symbol: s, price: String(state.mark) }); reply({ type: 'bbo', symbol: s, bid: [[String(state.bid), '1']], ask: [[String(state.ask), '1']] }); } return; }
    if (m.type === 'auth') { authed = m.params.hmac.signature === Q.signature(SEC, m.params.hmac.nonce, m.params.hmac.unix_ts); return reply(authed ? { authenticated: true } : { err: { error_code: 'PermissionDenied' } }); }
    if (!authed) return reply({ err: { error_code: 'PermissionDenied', incoming_message: m } });
    if (m.type === 'subscribe') return m.params.channels.forEach((c) => { reply({ subscribed: c });
      if (c === 'balances') reply({ balance_response: { id: ACCT, user_id: ACCT, deposit: 300, realised_pnl: 0, order_margin: 0, position_margin: 0, unrealised_pnl: 0, net_funding: 0, available_balance: 300, fees: 0 } }); });
    if (m.type === 'get_user_orders') return reply({ all_orders_response: { orders: state.orders, twaps: [] } });
    reply({ err: { error_code: 'PermissionDenied', message: 'e2e server refuses all trading messages', incoming_message: m } });
  });
});
const PUB = 'pk_' + randHex(8), SEC = randHex(24);
const cfg = C.loadConfig({ AUTOTRADER_NETWORK: 'testnet', AUTOTRADER_ENABLED: '1', QFEX_API_PUBLIC_KEY: PUB, QFEX_API_SECRET_KEY: SEC, QFEX_ACCOUNT_ID: ACCT, QFEX_KEY_SINGLE_ACCOUNT_ACK: '1' });
assert.equal(cfg.live, false, 'dry run must be the default');
const bases = { ...cfg.bases.qfex, trade: `ws://127.0.0.1:${port}/trade`, mds: `ws://127.0.0.1:${port}/mds` };
const restLog = []; globalThis.fetch = fakeFetch(state, restLog);
const net = { now: () => Date.now(), qfex: Q.makeNet(bases, cfg.qfex, { stopsMs: 200 }) };

const v = await C.verifyKeys(cfg, net); console.log('verify:', v.qfex);
const st = await C.accountState('qfex', cfg, net); console.log('status: equity', st.equity, 'free', st.free, 'positions', st.positions.length, 'weeklyLoss', st.weeklyLoss);
const now = Date.now() / 1000;
const queue = [
  { id: 'e2e-us100-long', pf: 'qfex', m: 'US100-USD', sd: 'long', et: 'limit', px: 29580, sz: 0.003, lev: 1, sl: 29300, tp: 30100, exp: now + 3600, ref: 29600 },
  { id: 'e2e-us100-too-big', pf: 'qfex', m: 'US100-USD', sd: 'short', et: 'limit', px: 29620, sz: 0.02, lev: 1, sl: 29900, tp: 29100, exp: now + 3600, ref: 29600 },
];
const logs = [], journal = [];
const res = await processQueue(cfg, net, { queue, state: { dry: {}, live: {} }, stopExists: () => false, logFn: (l, m) => logs.push(l + ' ' + m), journalFn: (j) => journal.push(j) });
console.log(logs.join('\n'));
assert.deepEqual(res.map((r) => r.status), ['dry-run', 'rejected']);
const entry = res[0].requests.find((r) => r.ws === 'add_order').body.params;
assert.equal(entry.order_type, 'ALO'); assert.equal(entry.order_time_in_force, 'GTC'); assert.ok(entry.stop_loss > 0 && entry.take_profit > 0);
assert.equal(res[0].requests[0].path, '/user/leverage');
const trading = seen.filter((x) => !x.mds && !['auth', 'subscribe', 'get_user_orders'].includes(x.m.type));
assert.deepEqual(trading, [], 'no trading message may reach the socket in a dry run');
assert.ok(restLog.every((r) => r.method === 'GET' && !/withdraw|transfer|address|banker/.test(r.path)), 'only signed GET reads');
assert.ok(restLog.every((r) => !JSON.stringify(r).includes(SEC)), 'secret never sent');
wss.close();
console.log('\nQFEX e2e dry run OK: ' + seen.length + ' WS messages (auth/subscribe/read/MDS only), ' + restLog.length + ' REST GETs, 0 orders.');
process.exit(0);
