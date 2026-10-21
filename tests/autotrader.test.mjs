// Autotrader: hard policy, key-permission aborts, kill switch, dry run — all offline with a mocked network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from '../autotrader/core.js';
import { processQueue } from '../autotrader/cli.js';
import * as A from '../src/arcus.js';
import * as H from '../src/hl.js';
import { randHex } from './helpers.mjs';

const FX = (f) => JSON.parse(readFileSync(new URL('./fixtures/' + f, import.meta.url)));
const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const OWNER = '0x' + '11'.repeat(20), MASTER = '0x' + '22'.repeat(20), SUB = '0x' + '55'.repeat(20);
const ARCUS_KEY = randHex(32), HL_KEY = '0x' + randHex(32);
const ENV = { AUTOTRADER_NETWORK: 'testnet', AUTOTRADER_ARCUS: '1', ARCUS_API_PRIVATE_KEY: ARCUS_KEY, ARCUS_ACCOUNT_ADDRESS: OWNER, ARCUS_ACCOUNT_INDEX: '0',
  HL_AGENT_PRIVATE_KEY: HL_KEY, HL_ACCOUNT_ADDRESS: MASTER, HL_SUBACCOUNT_ADDRESS: SUB };
// legacy fixtures: TSLA-USD and A/B/C-USD are Bobby-owned Arcus markets (the ownership tests below use their own cfg)
const OWN = () => Object.fromEntries(['TSLA-USD', 'A-USD', 'B-USD', 'C-USD'].map((m) => [m, { t: NOW }]));
const verified = (c) => { if (c.hl) c.hl.subVerified = true; return c; };
const cfgOf = (extra = {}) => verified(Object.assign(C.loadConfig({ ...ENV, ...extra }), { arcusOwn: OWN() }));

// deep two-sided book around mid (5 levels/side, 1 bp apart, $100k each)
const BOOK = (mid, sz = 100000 / mid, step = 0.0001) => ({ bids: [1, 2, 3, 4, 5].map((i) => [String(+(mid * (1 - i * step)).toFixed(4)), String(sz)]), asks: [1, 2, 3, 4, 5].map((i) => [String(+(mid * (1 + i * step)).toFixed(4)), String(sz)]) });
function mockNet(cfg, o = {}) {
  const s = { equity: 300, free: 300, positions: [], orders: [], fills: [], hlEquity: 300, hlFree: 300, hlPositions: [], hlOrders: [], hlFills: [],
    keys: [{ apiKey: cfg.arcus ? cfg.arcus.apiKey : 'x', status: 'ACTIVE', validUntil: NOW + 30 * 86400e3, accountIndex: 0 }],
    role: { role: 'agent', data: { user: MASTER } }, subRole: { role: 'subAccount', data: { master: MASTER } }, subs: [{ name: 'Bobby', subAccountUser: SUB }], ...o };
  const sent = [];
  const net = {
    sent, s, now: () => NOW, arcusClockOffsetMs: async () => 0,
    arcusGet: async (path) => {
      if (path === '/v1/apiKeys') return { apiKeys: s.keys };
      if (path === '/v1/account') return { equity: String(s.equity), freeCollateral: String(s.free) };
      if (path === '/v1/positions') return { positions: s.positions };
      if (path === '/v1/openOrders') return { orders: s.orders };
      if (path === '/v1/fills') return { fills: s.fills };
      if (path === '/v1/markets') return { markets: [FX('arcus_market_tsla.json')] };
      if (path === '/v1/account/stats') return {};
      if (path.startsWith('/v1/l2OrderBook/')) return s.arcusBook || BOOK(400);
      throw new Error('unmocked ' + path);
    },
    hlInfo: async (b) => {
      if (b.type === 'userRole') return String(b.user).toLowerCase() === SUB ? s.subRole : s.role;
      if (b.type === 'subAccounts') { assert.equal(b.user, MASTER); return s.subs; }
      if (b.type === 'clearinghouseState') return { marginSummary: { accountValue: String(s.hlEquity) }, withdrawable: String(s.hlFree), assetPositions: s.hlPositions };
      if (b.type === 'frontendOpenOrders') return s.hlOrders;
      if (b.type === 'userFillsByTime') return s.hlFills;
      if (b.type === 'metaAndAssetCtxs') return FX('hl_io_meta.json');
      if (b.type === 'perpDexs') return FX('hl_perpdexs.json');
      if (b.type === 'l2Book') { const k = s.hlBook || BOOK(380); return { levels: [k.bids.map(([px, sz]) => ({ px, sz, n: 1 })), k.asks.map(([px, sz]) => ({ px, sz, n: 1 }))] }; }
      throw new Error('unmocked ' + b.type);
    },
    sendArcus: async (d) => { sent.push({ pf: 'arcus', d }); return { ok: true, status: 200, body: { responses: [{ status: 'OK' }] } }; },
    sendHl: async (d) => { sent.push({ pf: 'hl', d }); return { ok: true, status: 200, body: { status: 'ok', response: { data: { statuses: [{ resting: { oid: 1 } }] } } } }; },
  };
  return net;
}
const exp = NOW / 1000 + 3600;
const AR = { id: 'a1', platform: 'arcus', market: 'TSLA-USD', side: 'long', type: 'limit', price: 398, size: 0.1, leverage: 1, stopLoss: 371, takeProfit: 420, expiry: exp, refPrice: 400, rationale: 'test' };
const EN = { id: 'e1', pf: 'entropy', m: 'io:ANTH', sd: 'short', et: 'limit', px: 382, sz: 0.1, lev: 1, sl: 405, tp: 360, exp, ref: 380 };

test('config: network must be explicit, dry run unless AUTOTRADER_LIVE=1, kill switch unless AUTOTRADER_ENABLED=1', () => {
  assert.throws(() => C.loadConfig({ ...ENV, AUTOTRADER_NETWORK: undefined }), /AUTOTRADER_NETWORK/);
  const c = cfgOf(); assert.equal(c.live, false); assert.equal(c.enabled, false);
  assert.equal(C.killReason(c, false), 'AUTOTRADER_ENABLED is not 1');
  assert.equal(C.killReason(cfgOf({ AUTOTRADER_ENABLED: '1' }), true), 'STOP file present');
  assert.equal(C.killReason(cfgOf({ AUTOTRADER_ENABLED: '1' }), false), null);
  assert.equal(cfgOf({ AUTOTRADER_LIVE: 'true' }).live, false);
  assert.throws(() => C.loadConfig({ ...ENV, ARCUS_API_PRIVATE_KEY: 'nothex' }), (e) => !e.message.includes('nothex'));
});

test('startup: Arcus key problems abort; Entropy agent/subaccount problems disable Entropy only', async () => {
  const cfg = cfgOf();
  assert.ok(await C.verifyKeys(cfg, mockNet(cfg)));
  const bad = (k) => mockNet(cfg, { keys: [{ apiKey: cfg.arcus.apiKey, status: 'ACTIVE', accountIndex: 0, ...k }] });
  await assert.rejects(C.verifyKeys(cfg, bad({ permissions: ['withdraw'] })), /extra permissions \(withdraw\)/);
  await assert.rejects(C.verifyKeys(cfg, bad({ status: 'REVOKED' })), /REVOKED/);
  await assert.rejects(C.verifyKeys(cfg, bad({ accountIndex: 3 })), /subaccount 3/);
  await assert.rejects(C.verifyKeys(cfg, mockNet(cfg, { keys: [] })), /not registered/);
  // Entropy problems never abort: they disable Entropy only (QFEX/Arcus and the loop keep running)
  const hlOff = async (o, re, c = cfgOf()) => { const v = await C.verifyKeys(c, mockNet(c, o)); assert.match(v.hlDisabled, re); assert.equal(c.hl, null); assert.match(c.disabled.entropy, re); };
  await hlOff({ role: { role: 'user' } }, /not approved/);
  await hlOff({ role: { role: 'agent', data: { user: OWNER } } }, /not approved/);
  await hlOff({ subs: [{ name: 'Other', subAccountUser: '0x' + '66'.repeat(20) }] }, /not in the master wallet's subAccounts/);
  await hlOff({ subs: [] }, /not in the master wallet's subAccounts/);
  await hlOff({ subRole: { role: 'subAccount', data: { master: OWNER } } }, /userRole is not subAccount/);
  await hlOff({ subRole: { role: 'user' } }, /userRole is not subAccount/);
  await hlOff({}, /MAIN account key/, C.loadConfig({ ...ENV, HL_ACCOUNT_ADDRESS: H.addressOf(H.keyFromHex(HL_KEY)) }));
  const ok = C.loadConfig(ENV); const v = await C.verifyKeys(ok, mockNet(ok));
  assert.equal(v.hlDisabled, undefined); assert.equal(ok.hl.subVerified, true); assert.match(v.hl.subaccount, /Bobby/);
});

test('Entropy subaccount config: no subaccount or subaccount == master -> Entropy off; the master is never traded', () => {
  const none = C.loadConfig({ ...ENV, HL_SUBACCOUNT_ADDRESS: undefined }); assert.equal(none.hl, null); assert.match(none.disabled.entropy, /HL_SUBACCOUNT_ADDRESS is not set/);
  const same = C.loadConfig({ ...ENV, HL_SUBACCOUNT_ADDRESS: MASTER }); assert.equal(same.hl, null); assert.match(same.disabled.entropy, /equals the master/);
  assert.throws(() => C.loadConfig({ ...ENV, HL_SUBACCOUNT_ADDRESS: '0x123' }), /HL_SUBACCOUNT_ADDRESS is not a 0x address/);
});

test('hlSign: every Entropy request carries vaultAddress = the verified subaccount; otherwise it refuses to sign', () => {
  const cfg = cfgOf(); const net = { now: () => NOW };
  const d = C.hlSign(cfg, H.buildCancel(1, 1), net); assert.equal(JSON.parse(d.body).vaultAddress, SUB);
  const unverified = C.loadConfig(ENV); assert.throws(() => C.hlSign(unverified, H.buildCancel(1, 1), net), /not verified/);
  const c2 = cfgOf(); c2.hl.sub = MASTER; assert.throws(() => C.hlSign(c2, H.buildCancel(1, 1), net), /master wallet is never traded/);
  const c3 = cfgOf(); c3.hl.sub = ''; assert.throws(() => C.hlSign(c3, H.buildCancel(1, 1), net), /without the Bobby subaccount/);
  // hl.js: a vault is only accepted when it is exactly the explicitly allowed one
  assert.throws(() => H.exchangeRequest(cfg.hl.priv, H.buildCancel(1, 1), 1, { vaultAddress: SUB }), /vault/);
  assert.throws(() => H.exchangeRequest(cfg.hl.priv, H.buildCancel(1, 1), 1, { vaultAddress: MASTER, allowedVault: SUB }), /vault/);
  assert.equal(JSON.parse(H.exchangeRequest(cfg.hl.priv, H.buildCancel(1, 1), 1, { vaultAddress: SUB.toUpperCase().replace('0X', '0x'), allowedVault: SUB }).body).vaultAddress, SUB);
});

test('Entropy state is read from the subaccount only (never the master), margin gate waits for io-dex margin', async () => {
  const cfg = cfgOf(); const users = new Set(); const net = mockNet(cfg, { hlEquity: 0, hlFree: 0 });
  const inner = net.hlInfo; net.hlInfo = async (b) => { if (b.user && b.type !== 'userRole' && b.type !== 'subAccounts') users.add(String(b.user).toLowerCase()); return inner(b); };
  const st = await C.accountState('entropy', cfg, net);
  assert.deepEqual([...users], [SUB]);
  const w = C.entropyMarginStatus(st); assert.equal(w.state, 'waiting'); assert.match(w.reason, /waiting for margin on EntropyIO/);
  assert.equal(C.entropyMarginStatus({ equity: 300, free: 300, positions: [] }).state, 'active');
  assert.equal(C.entropyMarginStatus({ equity: 5, free: 1, positions: [{ market: 'io:ANTH' }] }).state, 'active');
  assert.equal(C.entropyMarginStatus(null).state, 'unknown');
});

test('policy: compliant Arcus + Entropy proposals pass with risk <= 1% of live equity', async () => {
  const cfg = cfgOf();
  const a = await C.evaluate(AR, cfg, mockNet(cfg));
  assert.deepEqual(a.reasons, []); assert.ok(a.risk.slLoss > 2 && a.risk.slLoss <= 3, String(a.risk.slLoss)); assert.equal(a.risk.maxLoss, 3);
  const e = await C.evaluate(EN, cfg, mockNet(cfg));
  assert.deepEqual(e.reasons, []); assert.ok(e.risk.slLoss <= 3);
});

test('policy: every hard rule rejects with a reason', async () => {
  const cfg = cfgOf();
  const rej = async (q, re, o) => { const r = await C.evaluate(q, cfg, mockNet(cfg, o)); assert.equal(r.ok, false); assert.ok(r.reasons.some((x) => re.test(x)), JSON.stringify(r.reasons)); };
  await rej({ ...AR, type: 'market' }, /post-only limit/);
  await rej({ ...AR, postOnly: false }, /postOnly/);
  await rej({ ...AR, leverage: 2 }, /leverage 2×/);
  await rej({ ...AR, stopLoss: undefined }, /stop-loss required/);
  await rej({ ...AR, takeProfit: undefined }, /take-profit required/);
  await rej({ ...AR, size: 0.3 }, /loss at SL .* \(1\.0% of \$300\)/);
  await rej(AR, /loss at SL .* of \$100/, { equity: 100 });                       // 1% of LIVE equity
  await rej(AR, /weekly loss cap reached/, { fills: [{ createdAt: NOW - 3600e3, closedPnl: '-50', fee: '0', clientId: 'bby-0000000000000000-e' }] });
  await rej(AR, /could exceed the weekly cap/, { fills: [{ createdAt: NOW - 3600e3, closedPnl: '-48', fee: '0', clientId: 'bby-0000000000000000-e' }] });
  await rej(AR, /margin above free collateral|Margin/, { free: 10 });
  await rej({ ...AR, refPrice: 380 }, /moved/);
  await rej({ ...AR, expiry: NOW / 1000 - 1 }, /expired/);
  await rej({ ...AR, refPrice: undefined }, /ref price/);
  await rej({ ...AR, price: 401, refPrice: 401 }, /cross the book/);
  await rej({ ...AR, platform: 'txflow' }, /TxFlow is manual/);
  await rej({ ...EN, m: 'ANTH' }, /dex io/);
  const three = ['A', 'B', 'C'].map((x) => ({ marketDisplayName: x + '-USD', side: 'LONG', size: '1', averageEntryPrice: '1', unrealizedPnl: '0' }));
  await rej(AR, /max 3 concurrent/, { positions: three });
  await rej(AR, /already exists on TSLA-USD/, { positions: [{ ...three[0], marketDisplayName: 'TSLA-USD' }] });
  await rej(EN, /max 3 concurrent/, { hlOrders: ['io:OAI', 'io:X', 'io:Y'].map((c, i) => ({ coin: c, side: 'B', oid: i, orderType: 'Limit', isTrigger: false, limitPx: '1', sz: '1' })) });
});

test('trade-only guards: withdraw/transfer/vault can never be built or sent', () => {
  const cfg = cfgOf();
  assert.throws(() => H.exchangeRequest(cfg.hl.priv, { type: 'withdraw3', amount: '1' }, 1), /forbidden/);
  assert.throws(() => H.exchangeRequest(cfg.hl.priv, { type: 'usdClassTransfer' }, 1), /forbidden/);
  assert.throws(() => H.exchangeRequest(cfg.hl.priv, H.buildCancel(1, 1), 1, { vaultAddress: MASTER }), /vault/);
  const real = C.realNet(cfg);
  return assert.rejects(real.sendArcus({ method: 'POST', path: '/v1/withdraw' }), /forbidden/);
});

const quiet = { logFn: () => {}, journalFn: () => {} };
test('kill switch: STOP file or AUTOTRADER_ENABLED!=1 -> compliant trades are held, nothing is sent', async () => {
  for (const [extra, stop, why] of [[{}, false, /ENABLED/], [{ AUTOTRADER_ENABLED: '1', AUTOTRADER_LIVE: '1' }, true, /STOP/]]) {
    const cfg = cfgOf(extra), net = mockNet(cfg), state = {};
    const r = await processQueue(cfg, net, { queue: [AR, EN], state, stopExists: () => stop, ...quiet });
    assert.deepEqual(r.map((x) => x.status), ['held', 'held']); assert.ok(why.test(r[0].reason));
    assert.equal(net.sent.length, 0); assert.deepEqual(state.live || state.dry, {}); // not consumed: retried next run
  }
});

test('dry run (default): signed post-only requests are built and logged, never sent; rejections are logged with reasons', async () => {
  const cfg = cfgOf({ AUTOTRADER_ENABLED: '1' }), net = mockNet(cfg), state = {}, logs = [], jr = [];
  const r = await processQueue(cfg, net, { queue: [AR, EN, { ...AR, id: 'bad', leverage: 3 }], state, stopExists: () => false,
    logFn: (l, m) => logs.push(l + ' ' + m), journalFn: (e) => jr.push(e) });
  assert.deepEqual(r.map((x) => x.status), ['dry-run', 'dry-run', 'rejected']);
  assert.equal(net.sent.length, 0);
  const ar = r[0].requests[1].body, hl = r[1].requests[1].body;
  assert.equal(ar.grouping, 'entryTpsl'); assert.equal(ar.orders[0].timeInForce, 'ALO'); assert.equal(ar.orders.length, 3);
  assert.deepEqual(ar.orders.slice(1).map((o) => o.tpslType).sort(), ['STOP_LOSS', 'TAKE_PROFIT']);
  assert.equal(r[0].requests[0].body.leverage, 1); assert.equal(r[0].requests[0].body.isolated, true);
  assert.equal(hl.action.orders[0].t.limit.tif, 'Alo'); assert.equal(hl.action.grouping, 'normalTpsl'); assert.equal(hl.action.orders.length, 3);
  assert.equal(r[1].requests[0].body.action.leverage, 1); assert.equal(hl.vaultAddress, SUB); // always the Bobby subaccount, never the master
  assert.ok(logs.some((l) => /^REJECT bad: .*leverage 3×/.test(l)));
  assert.ok(jr.find((e) => e.id === 'bad').reasons.length > 0);
  const blob = JSON.stringify([logs, jr, r]);
  assert.ok(!blob.includes(ARCUS_KEY) && !blob.includes(HL_KEY.slice(2)), 'no key material in logs/journal');
  // processed once per mode
  const again = await processQueue(cfg, net, { queue: [AR], state, stopExists: () => false, ...quiet });
  assert.deepEqual(again, []);
});

test('live mode (mocked exchange): sends exactly leverage + entry per trade; 4th concurrent entry is refused', async () => {
  const cfg = cfgOf({ AUTOTRADER_ENABLED: '1', AUTOTRADER_LIVE: '1' }), net = mockNet(cfg), state = {};
  const r = await processQueue(cfg, net, { queue: [AR], state, stopExists: () => false, ...quiet });
  assert.deepEqual(r.map((x) => x.status), ['placed']);
  assert.deepEqual(net.sent.map((x) => x.d.path), ['/v1/setLeverage', '/v1/batchPlaceOrders']);
  const dry = cfgOf({ AUTOTRADER_ENABLED: '1' }), n2 = mockNet(dry, { positions: ['A', 'B'].map((x) => ({ marketDisplayName: x + '-USD', side: 'LONG', size: '1', averageEntryPrice: '1', unrealizedPnl: '0' })) });
  const r2 = await processQueue(dry, n2, { queue: [AR, { ...AR, id: 'a2', market: 'TSLA' }], state: {}, stopExists: () => false, ...quiet });
  assert.deepEqual(r2.map((x) => x.status), ['dry-run', 'rejected']);
});

test('cancel/close are reduce-only and policy-checked (the only SL of a position cannot be cancelled)', async () => {
  const cfg = cfgOf();
  const pos = [{ marketDisplayName: 'TSLA-USD', side: 'LONG', size: '0.1', averageEntryPrice: '398', unrealizedPnl: '0' }];
  const sl = { orderId: '77', marketDisplayName: 'TSLA-USD', side: 'SELL', tpslType: 'STOP_LOSS', triggerPrice: '371', price: '0', clientId: 'bby-00000000000000aa-s' };
  const tp = { orderId: '78', marketDisplayName: 'TSLA-USD', side: 'SELL', tpslType: 'TAKE_PROFIT', triggerPrice: '420', price: '0', clientId: 'bby-00000000000000aa-t' };
  await assert.rejects(C.buildCancel('arcus', 'TSLA-USD', '77', cfg, mockNet(cfg, { positions: pos, orders: [sl, tp] })), /only stop-loss/);
  const c = await C.buildCancel('arcus', 'TSLA-USD', '78', cfg, mockNet(cfg, { positions: pos, orders: [sl, tp] }));
  assert.equal(c[0].d.path, '/v1/cancelOrder');
  const cl = await C.buildClose('arcus', 'TSLA-USD', cfg, mockNet(cfg, { positions: pos }));
  assert.equal(JSON.parse(cl[0].d.body).reduceOnly, true);
  const hp = [{ position: { coin: 'io:ANTH', szi: '-0.1', entryPx: '382', positionValue: '38', unrealizedPnl: '0.2' } }];
  const hc = await C.buildClose('entropy', 'io:ANTH', cfg, mockNet(cfg, { hlPositions: hp }));
  const a = JSON.parse(hc[0].d.body).action; assert.equal(a.orders[0].r, true); assert.equal(a.orders[0].b, true);
  await assert.rejects(C.buildClose('arcus', 'NVDA-USD', cfg, mockNet(cfg)), /no open position/);
});

test('status: equity, positions with SL/TP, open orders, weekly loss, fills since ts', async () => {
  const cfg = cfgOf();
  const net = mockNet(cfg, { positions: [{ marketDisplayName: 'TSLA-USD', side: 'LONG', size: '0.1', averageEntryPrice: '398', unrealizedPnl: '1.5' }],
    orders: [{ orderId: '77', marketDisplayName: 'TSLA-USD', side: 'SELL', tpslType: 'STOP_LOSS', triggerPrice: '371' }],
    fills: [{ createdAt: NOW - 1000, closedPnl: '-2', fee: '0.01', marketDisplayName: 'TSLA-USD', price: '398', size: '0.1', side: 'BUY' }] });
  const st = await C.accountState('arcus', cfg, net, { sinceMs: NOW - 86400e3 });
  assert.equal(st.equity, 300); assert.equal(st.positions[0].upnl, 1.5); assert.equal(st.orders[0].kind, 'SL'); assert.equal(st.weeklyLoss, 2); assert.equal(st.fills.length, 1);
});

// ---------------------------------------------------------------- protection guard (Arcus / Entropy)
test('guard Arcus/Entropy: unprotected -> attach position TP/SL at the planned level (reduce-only); no plan -> reduce-only close', async () => {
  const cfg = cfgOf();
  const net = mockNet(cfg, {
    positions: [{ marketDisplayName: 'TSLA-USD', side: 'LONG', size: '0.1', averageEntryPrice: '398', markPrice: '400', unrealizedPnl: '0.2' }],
    orders: [{ orderId: '77', marketDisplayName: 'TSLA-USD', side: 'SELL', tpslType: 'STOP_LOSS', triggerPrice: '371', price: '0' }], // SL only
    hlPositions: [{ position: { coin: 'io:ANTH', szi: '-0.1', entryPx: '382', positionValue: '38', unrealizedPnl: '0.2' } }],
  });
  let now = NOW; net.now = () => now;
  const io = { live: true, kill: null, logs: [], alerts: [], journals: [], plans: { 'arcus:TSLA-USD': { pf: 'arcus', market: 'TSLA-USD', side: 'long', sl: 371, tp: 420 } } };
  io.log = (l, m) => io.logs.push(l + ' ' + m); io.alert = (a) => io.alerts.push(a); io.journal = (j) => io.journals.push(j);
  const memo = {};
  let r = await C.guardTick(cfg, net, memo, io);
  assert.deepEqual(r.map((x) => [x.pf, x.kind]), [['arcus', 'grace'], ['entropy', 'grace']]); assert.equal(net.sent.length, 0);
  now += 61e3; r = await C.guardTick(cfg, net, memo, io);
  assert.deepEqual(r.map((x) => [x.pf, x.did, x.ok]), [['arcus', 'attach', true], ['entropy', 'close', true]]);
  const ar = JSON.parse(net.sent[0].d.body);
  assert.equal(ar.grouping, 'positionTpsl'); assert.equal(ar.orders.length, 1); // only the missing TP
  assert.equal(ar.orders[0].tpslType, 'TAKE_PROFIT'); assert.equal(ar.orders[0].reduceOnly, true); assert.equal(ar.orders[0].orderSide, 'SELL'); assert.equal(ar.orders[0].stopPrice, '420.00');
  const hl = JSON.parse(net.sent[1].d.body).action;
  assert.equal(hl.type, 'order'); assert.equal(hl.orders[0].r, true); assert.equal(hl.orders[0].b, true); // buy back the short, reduce-only
  assert.deepEqual(io.alerts.map((a) => [a.pf, a.kind]), [['arcus', 'attach'], ['entropy', 'close']]);
});

test('guard Arcus: attach rejected -> reduce-only close; protected positions are never touched', async () => {
  const cfg = cfgOf();
  const net = mockNet(cfg, { positions: [{ marketDisplayName: 'TSLA-USD', side: 'LONG', size: '0.1', averageEntryPrice: '398', markPrice: '400', unrealizedPnl: '0.2' }] });
  let n = 0; net.sendArcus = async (d) => { net.sent.push({ pf: 'arcus', d }); n++; return n === 1 ? { ok: false, status: 400, body: { error: 'rejected' } } : { ok: true, status: 200, body: { responses: [{ status: 'OK' }] } }; };
  let now = NOW; net.now = () => now;
  const io = { live: true, logs: [], alerts: [], journals: [], plans: { 'arcus:TSLA-USD': { pf: 'arcus', market: 'TSLA-USD', side: 'long', sl: 371, tp: 420 } } };
  io.log = (l, m) => io.logs.push(l + ' ' + m); io.alert = (a) => io.alerts.push(a); io.journal = (j) => io.journals.push(j);
  const memo = {};
  await C.guardTick({ ...cfg, hl: null }, net, memo, io); now += 61e3;
  const r = await C.guardTick({ ...cfg, hl: null }, net, memo, io);
  assert.equal(r[0].did, 'close'); assert.equal(net.sent.length, 2);
  assert.equal(JSON.parse(net.sent[1].d.body).reduceOnly ?? JSON.parse(net.sent[1].d.body).orders?.[0]?.reduceOnly, true);
  const ok = mockNet(cfg, { positions: [{ marketDisplayName: 'TSLA-USD', side: 'LONG', size: '0.1', averageEntryPrice: '398', markPrice: '400', unrealizedPnl: '0' }],
    orders: [{ orderId: '1', marketDisplayName: 'TSLA-USD', tpslType: 'STOP_LOSS', triggerPrice: '371' }, { orderId: '2', marketDisplayName: 'TSLA-USD', tpslType: 'TAKE_PROFIT', triggerPrice: '420' }] });
  for (let i = 0; i < 3; i++) assert.equal((await C.guardTick({ ...cfg, hl: null }, ok, {}, io))[0].kind, 'ok');
  assert.equal(ok.sent.length, 0);
});

test('Arcus key without ARCUS_ACCOUNT_ADDRESS: Arcus disabled (fail closed), config still loads, Arcus proposals rejected', async () => {
  const cfg = C.loadConfig({ AUTOTRADER_NETWORK: 'mainnet', ARCUS_API_PRIVATE_KEY: randHex(32), ARCUS_ACCOUNT_INDEX: '0' });
  assert.equal(cfg.arcus, null); assert.match(cfg.disabled.arcus, /ARCUS_ACCOUNT_ADDRESS/);
  assert.deepEqual(C.GUARD_PFS(cfg), []);
  const ev = await C.evaluate({ id: 'a1', pf: 'arcus', m: 'BTC', sd: 'long', px: 1, sz: 1, sl: 0.9, tp: 1.1, ref: 1, exp: NOW / 1000 + 600 }, cfg, { now: () => NOW });
  assert.equal(ev.ok, false); assert.ok(ev.reasons.some((r) => /no key configured/.test(r)));
});

test('AUTOTRADER_ARCUS master switch: Arcus off unless =1 (key still validated), Arcus proposals rejected', async () => {
  const cfg = C.loadConfig({ ...ENV, AUTOTRADER_ARCUS: '0' });
  assert.equal(cfg.arcus, null); assert.match(cfg.disabled.arcus, /AUTOTRADER_ARCUS/);
  assert.equal(cfg.arcusAddress, OWNER); // read-only status keeps working
  assert.throws(() => C.loadConfig({ ...ENV, AUTOTRADER_ARCUS: undefined, ARCUS_API_PRIVATE_KEY: 'nothex' }), (e) => !e.message.includes('nothex'));
  assert.ok(C.loadConfig({ ...ENV, AUTOTRADER_ARCUS: '1' }).arcus);
  const ev = await C.evaluate({ id: 'a2', pf: 'arcus', m: 'BTC', sd: 'long', px: 1, sz: 1, sl: 0.9, tp: 1.1, ref: 1, exp: NOW / 1000 + 600 }, cfg, { now: () => NOW });
  assert.equal(ev.ok, false);
});

test('liquidity gate (Arcus + Entropy): wide spread, thin book, low OI, missing book -> rejected; equity above $300 is capped', async () => {
  const cfg = cfgOf();
  const rej = async (q, re, o) => { const r = await C.evaluate(q, cfg, mockNet(cfg, o)); assert.equal(r.ok, false); assert.ok(r.reasons.some((x) => re.test(x)), JSON.stringify(r.reasons)); };
  await rej(AR, /spread .* > 0\.20% max/, { arcusBook: { bids: [['399', '100']], asks: [['401', '100']] } });
  await rej(AR, /cannot absorb this stop-loss size/, { arcusBook: { bids: [['399.9', '0.01']], asks: [['400.1', '0.01']] } });
  await rej(AR, /order book unavailable/, { arcusBook: { bids: [], asks: [] } });
  await rej(EN, /spread/, { hlBook: { bids: [['379', '100']], asks: [['381', '100']] } });
  // stressed slippage pushes the SL loss over the cap: thin book 1 % deep on the exit side
  await rej(AR, /incl\. stressed stop slippage/, { arcusBook: { bids: [['399.98', '0.001'], ['396', '10']], asks: [['400.02', '10']] } });
  const lowOi = C.loadConfig({ ...ENV, LOWOI_MIN_OI_USD: '1e9' });
  const r = await C.evaluate(AR, lowOi, mockNet(lowOi)); assert.ok(r.reasons.some((x) => /open interest .* minimum/.test(x)), JSON.stringify(r.reasons));
  const rich = await C.evaluate(AR, cfg, mockNet(cfg, { equity: 1000, free: 1000 }));
  assert.deepEqual(rich.reasons, []); assert.equal(rich.risk.maxLoss, 3); // 1 % of min(equity, $300)
  assert.throws(() => C.loadConfig({ ...ENV, ARCUS_CAPITAL_USD: '500' }), /ARCUS_CAPITAL_USD/);
});

test('Arcus fills: from is sent in microseconds and µs createdAt is converted to ms (weekly loss counted once)', async () => {
  const cfg = cfgOf(), net = mockNet(cfg, { fills: [{ createdAt: (NOW - 3600e3) * 1000, closedPnl: '-5', fee: '0.1', clientId: 'bby-0000000000000000-s' }] });
  const calls = []; const g = net.arcusGet; net.arcusGet = async (p, q) => { if (p === '/v1/fills') calls.push(q); return g(p, q); };
  const st = await C.accountState('arcus', cfg, net, {});
  assert.ok(calls.length && calls.every((q) => q.from > 1e15), JSON.stringify(calls));
  assert.ok(st.weeklyLoss >= 5 && st.weeklyLoss <= 5.1 + 1e-9, String(st.weeklyLoss));
});

test('Entropy on a unified Hyperliquid account: equity/free come from spot USDC (+ dex uPnL), other spot tokens ignored', async () => {
  const cfg = cfgOf(), net = mockNet(cfg, { hlEquity: 0, hlFree: 0 });
  const h = net.hlInfo; net.hlInfo = async (b) => b.type === 'userAbstraction' ? 'unifiedAccount'
    : b.type === 'spotClearinghouseState' ? { balances: [{ coin: 'USDC', total: '300.19', hold: '10' }, { coin: 'HYPE', total: '221', hold: '0' }] } : h(b);
  const st = await C.accountState('entropy', cfg, net, {});
  assert.equal(st.equity, 300.19); assert.equal(st.free, 290.19);
  const plain = await C.accountState('entropy', cfg, mockNet(cfg)); assert.equal(plain.equity, 300); // standard account unchanged
});


// ---------------------------------------------------------------- Arcus account shared with the user's other tools
const FOREIGN_POS = (m) => ({ marketDisplayName: m, side: 'LONG', size: '1', averageEntryPrice: '700', markPrice: '700', unrealizedPnl: '-1' });
const cfgNoOwn = (extra) => verified(Object.assign(C.loadConfig({ ...ENV, ...extra }), { arcusOwn: {} }));

test('Arcus clientIds: every Bobby order carries a valid "bby-" clientId (<= 36 chars, [A-Za-z0-9_-]); entry marks the market as Bobby-owned', async () => {
  for (const k of ['e', 's', 't', 'c']) { const c = C.arcusCid('some proposal id with spaces / and ü', k); assert.ok(C.isBobbyCid(c) && c.length <= 36 && /^[A-Za-z0-9_-]+$/.test(c), c); }
  assert.notEqual(C.arcusCid('a', 'e'), C.arcusCid('b', 'e')); assert.equal(C.isBobbyCid('my-order-42'), false); assert.equal(C.isBobbyCid(null), false);
  const cfg = cfgNoOwn({ AUTOTRADER_ENABLED: '1', AUTOTRADER_LIVE: '1' }), net = mockNet(cfg), state = {};
  const r = await processQueue(cfg, net, { queue: [AR], state, stopExists: () => false, ...quiet });
  assert.deepEqual(r.map((x) => x.status), ['placed']);
  const entry = JSON.parse(net.sent.find((x) => /batchPlaceOrders/.test(x.d.path)).d.body);
  assert.ok(entry.orders.every((o) => C.isBobbyCid(o.clientId)), JSON.stringify(entry.orders.map((o) => o.clientId)));
  assert.equal(new Set(entry.orders.map((o) => o.clientId)).size, 3); assert.equal(entry.orders[0].timeInForce, 'ALO');
  assert.ok(cfg.arcusOwn['TSLA-USD']);
});

test('Arcus weekly loss counts only Bobby: "bby-" fills + clientId-less fills in Bobby markets (fail closed); other tools excluded', async () => {
  const cfg = cfgNoOwn();
  const f = (m, pnl, cid) => ({ createdAt: (NOW - 3600e3) * 1000, marketDisplayName: m, closedPnl: String(pnl), fee: '0', ...(cid ? { clientId: cid } : {}) });
  const net = mockNet(cfg, { fills: [f('W-USD', -2, 'bby-00000000000000aa-s'), f('W-USD', -1), f('SPY-USD', -20, 'tread-123'), f('SPY-USD', -10), f('QQQ-USD', 5, 'my-order-42')] });
  const st = await C.accountState('arcus', cfg, net, {});
  assert.equal(st.weeklyLoss, 3); assert.equal(st.weeklyLossAccount, 28); assert.equal(st.bobbyWeekFills, 2);
  assert.deepEqual(st.bobbyMarkets, ['W-USD']);
  // a Bobby-owned market (entry sent, no fill yet): clientId-less fills there count against Bobby too
  const own = Object.assign(cfgNoOwn(), { arcusOwn: { 'SPY-USD': { t: NOW } } });
  assert.equal((await C.accountState('arcus', own, mockNet(own, { fills: [f('SPY-USD', -10), f('SPY-USD', -20, 'tread-1')] }), {})).weeklyLoss, 10);
  // the other tools' -$45 this week does not block Bobby
  const ev = await C.evaluate(AR, cfg, mockNet(cfg, { fills: [f('SPY-USD', -45, 'tread-9')] }));
  assert.deepEqual(ev.reasons, []);
});

test('Arcus entries skip markets with the other tools\' positions or orders; their positions do not use Bobby\'s slots', async () => {
  const cfg = cfgNoOwn();
  const rej = async (o, re) => { const r = await C.evaluate(AR, cfg, mockNet(cfg, o)); assert.equal(r.ok, false); assert.ok(r.reasons.some((x) => re.test(x)), JSON.stringify(r.reasons)); };
  await rej({ positions: [FOREIGN_POS('TSLA-USD')] }, /another tool of yours holds a position on TSLA-USD/);
  await rej({ orders: [{ orderId: '9', marketDisplayName: 'TSLA-USD', side: 'BUY', price: '350', clientId: 'tread-1' }] }, /another tool of yours has open orders on TSLA-USD/);
  await rej({ orders: [{ orderId: '9', marketDisplayName: 'TSLA-USD', side: 'SELL', tpslType: 'STOP_LOSS', triggerPrice: '300' }] }, /open orders on TSLA-USD/); // no clientId = not Bobby's
  const busy = await C.evaluate(AR, cfg, mockNet(cfg, { positions: ['SPY-USD', 'QQQ-USD', 'NVDA-USD', 'AAPL-USD'].map(FOREIGN_POS) }));
  assert.deepEqual(busy.reasons, []);
  const three = ['A', 'B', 'C'].map((x) => ({ orderId: x, marketDisplayName: x + '-USD', side: 'BUY', price: '1', clientId: C.arcusCid(x, 'e') }));
  await rej({ orders: three }, /max 3 concurrent/); // Bobby's own resting entries do count
});

test('guard never touches the other tools\' Arcus positions/orders (live mode): only Bobby\'s unprotected position is repaired', async () => {
  const cfg = Object.assign(cfgNoOwn({ AUTOTRADER_ENABLED: '1', AUTOTRADER_LIVE: '1' }), { arcusOwn: { 'TSLA-USD': { t: NOW - 3600e3 } } });
  const net = mockNet(cfg, {
    positions: [FOREIGN_POS('SPY-USD'), { marketDisplayName: 'TSLA-USD', side: 'LONG', size: '0.1', averageEntryPrice: '398', markPrice: '400', unrealizedPnl: '0.2' }, FOREIGN_POS('QQQ-USD')],
    orders: [{ orderId: '1', marketDisplayName: 'QQQ-USD', tpslType: 'STOP_LOSS', triggerPrice: '600', clientId: 'tread-5' }, { orderId: '2', marketDisplayName: 'SPY-USD', side: 'BUY', price: '650' }] });
  const memo = {}, plans = { 'arcus:TSLA-USD': { pf: 'arcus', market: 'TSLA-USD', side: 'long', sl: 371, tp: 420 } }, io = { live: true, kill: null, log: () => {}, journal: () => {}, alert: () => {}, plans };
  for (let i = 0; i < 3; i++) { net.s.now = NOW + i * 70e3; await C.guardTick(cfg, { ...net, now: () => NOW + i * 70e3 }, memo, io); }
  const rep = await C.guardTick(cfg, { ...net, now: () => NOW + 300e3 }, memo, io);
  assert.ok(rep.filter((r) => r.kind === 'foreign').map((r) => r.market).sort().join() === 'QQQ-USD,SPY-USD', JSON.stringify(rep));
  assert.ok(net.sent.length > 0);
  for (const x of net.sent) {
    const b = JSON.parse(x.d.body); const legs = b.orders || [b];
    assert.ok(legs.every((o) => o.marketId === FX('arcus_market_tsla.json').marketId), x.d.path); // TSLA only
    assert.ok(legs.every((o) => o.clientId == null || C.isBobbyCid(o.clientId)));
    assert.ok(!/cancel/i.test(x.d.path), 'nothing is cancelled');
  }
  assert.ok(!Object.keys(memo).some((k) => /SPY|QQQ/.test(k)));
  // direct builders refuse foreign targets
  await assert.rejects(C.buildClose('arcus', 'SPY-USD', cfg, net), /not Bobby's/);
  await assert.rejects(C.buildProtect('arcus', { market: 'SPY-USD', side: 'long', size: 1, bobby: false }, { sl: 600 }, cfg, net), /not Bobby's/);
  await assert.rejects(C.buildCancel('arcus', 'SPY-USD', '2', cfg, net), /not Bobby's/);
});

test('guard with only foreign Arcus positions (no plan, no legs) sends nothing even after the grace period', async () => {
  const cfg = cfgNoOwn({ AUTOTRADER_ENABLED: '1', AUTOTRADER_LIVE: '1' }), net = mockNet(cfg, { positions: [FOREIGN_POS('SPY-USD')] });
  const memo = {}, io = { live: true, kill: null, log: () => {}, journal: () => {}, alert: () => { throw new Error('no alert for foreign positions'); }, plans: {} };
  for (let i = 0; i < 5; i++) await C.guardTick(cfg, { ...net, now: () => NOW + i * 120e3 }, memo, io);
  assert.equal(net.sent.length, 0);
});

test('Arcus ownership is released only when Bobby has no position and no order there (after the settle window)', () => {
  const own = { 'A-USD': { t: NOW - 600e3 }, 'B-USD': { t: NOW - 60e3 }, 'C-USD': { t: NOW - 600e3 }, 'D-USD': { t: NOW - 600e3 } };
  const st = { positions: [{ market: 'C-USD' }], orders: [{ market: 'D-USD', clientId: C.arcusCid('d', 's') }, { market: 'A-USD', clientId: 'tread-1' }] };
  C.releaseArcusOwnership(own, st, NOW);
  assert.deepEqual(Object.keys(own).sort(), ['B-USD', 'C-USD', 'D-USD']); assert.equal(own['C-USD'].open, true);
});

test('Entropy dex abstraction: the io dex draws on the SUBACCOUNT main-dex balance (counted as margin), still only the subaccount', async () => {
  const cfg = cfgOf(); const users = new Set();
  const net = mockNet(cfg); const inner = net.hlInfo;
  net.hlInfo = async (b) => { if (b.user) users.add(String(b.user).toLowerCase());
    if (b.type === 'userAbstraction') return 'dexAbstraction';
    if (b.type === 'spotClearinghouseState') return { balances: [{ coin: 'USDC', total: '0.007', hold: '0' }] };
    if (b.type === 'clearinghouseState') return b.dex ? { marginSummary: { accountValue: '0' }, withdrawable: '0', assetPositions: [] } : { marginSummary: { accountValue: '300.19' }, withdrawable: '300.19', assetPositions: [] };
    return inner(b); };
  const st = await C.accountState('entropy', cfg, net);
  assert.ok(Math.abs(st.equity - 300.19) < 1e-9 && Math.abs(st.free - 300.19) < 1e-9, JSON.stringify(st));
  assert.equal(C.entropyMarginStatus(st).state, 'active'); assert.deepEqual([...users], [SUB]);
});

test('loop source: Entropy proposals stay queued while the margin gate is not active', () => {
  const src = readFileSync(new URL('../autotrader/cli.js', import.meta.url), 'utf8');
  assert.match(src, /em && em\.state !== 'active' && \/\^\(entropy\|hl\|hyperliquid\)\$\/i/);
});

test('Entropy margin modes (read every check): unified/portfolio -> spot USDC - holds; standard -> io dex only (spot USDC is not io margin)', async () => {
  const cfg = cfgOf();
  const run = async (mode, spot, io = '0') => { const net = mockNet(cfg); const inner = net.hlInfo; let modeReads = 0;
    net.hlInfo = async (b) => { if (b.type === 'userAbstraction') { modeReads += 1; assert.equal(String(b.user).toLowerCase(), SUB); return mode; }
      if (b.type === 'spotClearinghouseState') return { balances: [{ coin: 'USDC', total: spot, hold: '20' }] };
      if (b.type === 'clearinghouseState') return { marginSummary: { accountValue: io }, withdrawable: io, assetPositions: [] };
      return inner(b); };
    const st = await C.accountState('entropy', cfg, net); assert.equal(modeReads, 1); return { st, gate: C.entropyMarginStatus(st) }; };
  for (const mode of ['unifiedAccount', 'portfolioMargin']) {
    const { st, gate } = await run(mode, '300');
    assert.equal(st.equity, 300); assert.equal(st.free, 280); assert.deepEqual([gate.state, gate.mode], ['active', mode]);
  }
  const std = await run('disabled', '300'); assert.equal(std.st.free, 0); assert.equal(std.gate.state, 'waiting'); assert.match(std.gate.reason, /account mode disabled/);
  const stdIo = await run('disabled', '0', '150'); assert.equal(stdIo.gate.state, 'active');
});
