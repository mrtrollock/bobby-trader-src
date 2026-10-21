// Autotrader DRY-RUN end-to-end with throwaway keys (network, not part of `npm test`):
//  1. the real CLI `verify` against TESTNET aborts for unregistered/unapproved throwaway keys (exit 2, no key in logs);
//  2. the queue is processed on REAL public market data (Arcus TESTNET markets; Entropy = Hyperliquid dex "io" read-only
//     on mainnet /info because the testnet has no io dex) against synthetic fresh $300 accounts. Sending is impossible:
//     sendArcus/sendHl are replaced by functions that throw, and AUTOTRADER_LIVE is unset (dry run).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as C from '../autotrader/core.js';
import { processQueue } from '../autotrader/cli.js';
import * as API from '../src/api.js';
import { randHex, cleanEnv } from './helpers.mjs';

const ARCUS_KEY = randHex(32), HL_KEY = '0x' + randHex(32);
const post = (u, b) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());

// 1. real key checks abort
const lb = (await fetch('https://api.testnet.arcus.xyz/v1/leaderboard?limit=30').then((r) => r.json())).entries;
const env = cleanEnv({ AUTOTRADER_NETWORK: 'testnet', ARCUS_API_PRIVATE_KEY: ARCUS_KEY, ARCUS_ACCOUNT_ADDRESS: lb[0].address, ARCUS_ACCOUNT_INDEX: '0' });
const v = spawnSync('node', ['autotrader/cli.js', 'verify'], { env, encoding: 'utf8' });
assert.equal(v.status, 2, v.stdout + v.stderr); assert.match(v.stderr, /ABORT: Arcus: this API key is not registered/);
const v2 = spawnSync('node', ['autotrader/cli.js', 'verify'], { env: cleanEnv({ AUTOTRADER_NETWORK: 'testnet', HL_AGENT_PRIVATE_KEY: HL_KEY, HL_ACCOUNT_ADDRESS: '0x' + '33'.repeat(20) }), encoding: 'utf8' });
assert.equal(v2.status, 2); assert.match(v2.stderr, /ABORT: Hyperliquid: agent wallet is not approved/);
const logText = readFileSync('autotrader/logs/autotrader.log', 'utf8');
assert.ok(!logText.includes(ARCUS_KEY) && !logText.includes(HL_KEY.slice(2)), 'key material in log');

// 2. accounts. Arcus testnet accounts are not publicly discoverable, so the Arcus ACCOUNT reads (account, positions,
//    open orders, fills) are a synthetic fresh $300 account; markets, marks, ticks and fees are REAL testnet data.
const arcusAddr = '0x' + '55'.repeat(20);
const SYNTH = { '/v1/account': { equity: '300', freeCollateral: '300' }, '/v1/positions': { positions: [] }, '/v1/openOrders': { orders: [] }, '/v1/fills': { fills: [] } };
const HLM = 'https://api.hyperliquid.xyz/info';
// Entropy: same approach, synthetic fresh $300 account on dex io; io market metadata/marks are REAL (read-only /info).
const hlAddr = '0x' + '66'.repeat(20);
const SYNTH_HL = { clearinghouseState: { marginSummary: { accountValue: '300' }, withdrawable: '300', assetPositions: [] }, frontendOpenOrders: [], userFillsByTime: [],
  userRole: { role: 'agent', data: { user: hlAddr } } };
console.error('accounts found:', !!arcusAddr, !!hlAddr);

const cfgA = C.loadConfig({ AUTOTRADER_NETWORK: 'testnet', AUTOTRADER_ENABLED: '1', ARCUS_API_PRIVATE_KEY: ARCUS_KEY, ARCUS_ACCOUNT_ADDRESS: arcusAddr || '0x' + '44'.repeat(20) });
const cfgH = C.loadConfig({ AUTOTRADER_NETWORK: 'mainnet', AUTOTRADER_ENABLED: '1', HL_AGENT_PRIVATE_KEY: HL_KEY, HL_ACCOUNT_ADDRESS: hlAddr || '0x' + '44'.repeat(20) });
const noSend = (net) => ({ ...net, sendArcus: () => { throw new Error('SEND BLOCKED'); }, sendHl: () => { throw new Error('SEND BLOCKED'); } });
const realA = C.realNet(cfgA);
const realH = C.realNet(cfgH);
const netA = { ...noSend(realA), arcusGet: (path, q) => (SYNTH[path] ? Promise.resolve(SYNTH[path]) : realA.arcusGet(path, q)) }, netH = { ...noSend(realH), hlInfo: (body) => (SYNTH_HL[body.type] ? Promise.resolve(SYNTH_HL[body.type]) : realH.hlInfo(body)) };
assert.equal(cfgA.live, false); assert.equal(cfgH.live, false);

const now = Date.now() / 1000, out = {};
if (arcusAddr) {
  const m = await API.arcusMarket(API.bases(true).arcus, 'ETH-USD'), mark = Number(m.markPrice);
  const acct = SYNTH['/v1/account'];
  const risk = Math.min(0.01 * Number(acct.equity), 0.5 * Number(acct.freeCollateral)) * 0.5;        // half the 1% budget
  const px = +(mark * 0.995).toFixed(1), sl = +(px * 0.98).toFixed(1), tp = +(px * 1.03).toFixed(1);
  const sz = +Math.max(Number(m.minOrderSize), Math.min(risk / (px - sl + px * 0.001), 0.5 * Number(acct.freeCollateral) / px)).toFixed(4);
  const q = [{ id: 'e2e-ar', platform: 'arcus', market: 'ETH-USD', side: 'long', type: 'limit', price: px, size: sz, stopLoss: sl, takeProfit: tp, expiry: now + 600, refPrice: mark },
    { id: 'e2e-ar-bad', platform: 'arcus', market: 'ETH-USD', side: 'long', type: 'market', price: px, size: sz, leverage: 5, stopLoss: sl, expiry: now + 600, refPrice: mark * 1.05 }];
  out.arcus = await processQueue(cfgA, netA, { queue: q, state: {}, stopExists: () => false, journalFn: () => {} });
}
if (hlAddr) {
  const [meta, ctxs] = await post(HLM, { type: 'metaAndAssetCtxs', dex: 'io' });
  const i = meta.universe.findIndex((u) => u.name === 'io:OAI'), mark = Number(ctxs[i].markPx);
  const st = SYNTH_HL.clearinghouseState;
  const eq = Number(st.marginSummary.accountValue), free = Number(st.withdrawable);
  const px = Number((mark * 1.005).toPrecision(5)), sl = Number((px * 1.02).toPrecision(5)), tp = Number((px * 0.97).toPrecision(5));
  const sz = Math.max(0.001, +Math.min((Math.min(0.01 * eq, 0.5 * free) * 0.5) / (sl - px + px * 0.001), 0.5 * free / px).toFixed(3));
  const q = [{ id: 'e2e-io', pf: 'entropy', m: 'io:OAI', sd: 'short', et: 'limit', px, sz, sl, tp, exp: now + 600, ref: mark }];
  out.entropy = await processQueue(cfgH, netH, { queue: q, state: {}, stopExists: () => false, journalFn: () => {} });
}
const show = (r) => r && r.map((x) => ({ id: x.id, status: x.status, reasons: x.reasons, entry: x.requests && x.requests[1].body.orders ? x.requests[1].body.orders[0].timeInForce : x.requests && x.requests[1].body.action.orders[0].t }));
console.log(JSON.stringify({ arcus: show(out.arcus), entropy: show(out.entropy) }, null, 1));
if (out.arcus) { assert.equal(out.arcus[0].status, 'dry-run', JSON.stringify(out.arcus[0])); assert.equal(out.arcus[1].status, 'rejected'); }
if (out.entropy) assert.equal(out.entropy[0].status, 'dry-run', JSON.stringify(out.entropy[0]));
assert.ok(out.arcus || out.entropy, 'no account with equity found');
console.error('AUTOTRADER E2E OK (dry run, nothing sent)');
