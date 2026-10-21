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
const OWNER = '0x' + '11'.repeat(20), MASTER = '0x' + '22'.repeat(20);
const ARCUS_KEY = randHex(32), HL_KEY = '0x' + randHex(32);
const ENV = { AUTOTRADER_NETWORK: 'testnet', ARCUS_API_PRIVATE_KEY: ARCUS_KEY, ARCUS_ACCOUNT_ADDRESS: OWNER, ARCUS_ACCOUNT_INDEX: '0',
  HL_AGENT_PRIVATE_KEY: HL_KEY, HL_ACCOUNT_ADDRESS: MASTER };
const cfgOf = (extra = {}) => C.loadConfig({ ...ENV, ...extra });

function mockNet(cfg, o = {}) {
  const s = { equity: 300, free: 300, positions: [], orders: [], fills: [], hlEquity: 300, hlFree: 300, hlPositions: [], hlOrders: [], hlFills: [],
    keys: [{ apiKey: cfg.arcus ? cfg.arcus.apiKey : 'x', status: 'ACTIVE', validUntil: NOW + 30 * 86400e3, accountIndex: 0 }],
    role: { role: 'agent', data: { user: MASTER } }, ...o };
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
      throw new Error('unmocked ' + path);
    },
    hlInfo: async (b) => {
      if (b.type === 'userRole') return s.role;
      if (b.type === 'clearinghouseState') return { marginSummary: { accountValue: String(s.hlEquity) }, withdrawable: String(s.hlFree), assetPositions: s.hlPositions };
      if (b.type === 'frontendOpenOrders') return s.hlOrders;
      if (b.type === 'userFillsByTime') return s.hlFills;
      if (b.type === 'metaAndAssetCtxs') return FX('hl_io_meta.json');
      if (b.type === 'perpDexs') return FX('hl_perpdexs.json');
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

test('startup aborts: Arcus key with withdraw permission / unknown / wrong subaccount; HL agent not approved or main key', async () => {
  const cfg = cfgOf();
  assert.ok(await C.verifyKeys(cfg, mockNet(cfg)));
  const bad = (k) => mockNet(cfg, { keys: [{ apiKey: cfg.arcus.apiKey, status: 'ACTIVE', accountIndex: 0, ...k }] });
  await assert.rejects(C.verifyKeys(cfg, bad({ permissions: ['withdraw'] })), /extra permissions \(withdraw\)/);
  await assert.rejects(C.verifyKeys(cfg, bad({ status: 'REVOKED' })), /REVOKED/);
  await assert.rejects(C.verifyKeys(cfg, bad({ accountIndex: 3 })), /subaccount 3/);
  await assert.rejects(C.verifyKeys(cfg, mockNet(cfg, { keys: [] })), /not registered/);
  await assert.rejects(C.verifyKeys(cfg, mockNet(cfg, { role: { role: 'user' } })), /not approved/);
  await assert.rejects(C.verifyKeys(cfg, mockNet(cfg, { role: { role: 'agent', data: { user: OWNER } } })), /not approved/);
  const self = C.loadConfig({ ...ENV, HL_ACCOUNT_ADDRESS: H.addressOf(H.keyFromHex(HL_KEY)) });
  await assert.rejects(C.verifyKeys(self, mockNet(self)), /MAIN account key/);
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
  await rej(AR, /weekly loss cap reached/, { fills: [{ createdAt: NOW - 3600e3, closedPnl: '-50', fee: '0' }] });
  await rej(AR, /could exceed the weekly cap/, { fills: [{ createdAt: NOW - 3600e3, closedPnl: '-48', fee: '0' }] });
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
  assert.equal(r[1].requests[0].body.action.leverage, 1); assert.equal(hl.vaultAddress, null);
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
  const sl = { orderId: '77', marketDisplayName: 'TSLA-USD', side: 'SELL', tpslType: 'STOP_LOSS', triggerPrice: '371', price: '0' };
  const tp = { orderId: '78', marketDisplayName: 'TSLA-USD', side: 'SELL', tpslType: 'TAKE_PROFIT', triggerPrice: '420', price: '0' };
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
