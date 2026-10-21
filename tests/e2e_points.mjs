// Headless Chrome check of the Points tab in dist/: balances.py --mock writes the encrypted balances.enc.json (with the
// "points" section) using a throwaway passphrase; the page must decrypt it, render the per-platform points weeks with
// live countdowns, and make no request outside the static site. Real data files are backed up and restored.
// Usage: npm run build && node tests/e2e_points.mjs
import puppeteer from 'puppeteer-core';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealJson } from '../src/vault.js';

const PORT = 8767, ORIGIN = `http://127.0.0.1:${PORT}`;
const PASS = 'e2e-' + randomBytes(9).toString('hex');
const FILES = ['proposals.enc.json', 'briefing.enc.json', 'balances.enc.json', 'positions.enc.json'];
const backups = Object.fromEntries(FILES.map((f) => [f, existsSync('dist/' + f) ? readFileSync('dist/' + f, 'utf8') : null]));
const restore = () => { for (const [f, v] of Object.entries(backups)) { if (v == null) rmSync('dist/' + f, { force: true }); else writeFileSync('dist/' + f, v); } };
const seal = async (f, obj) => writeFileSync('dist/' + f, JSON.stringify(await sealJson(obj, PASS)));
await seal('briefing.enc.json', { v: 1, platforms: [] });
await seal('proposals.enc.json', { v: 1, updated: 0, batches: [] });
await seal('positions.enc.json', { v: 1, generated: 0, positions: [], orders: [], platforms: {}, bobby: null }); // the real one uses the real passphrase (restored afterwards)
const now = Math.floor(Date.now() / 1000), H = 3600e3, nowMs = now * 1000;
const bt = mkdtempSync(join(tmpdir(), 'pts-'));
const fills = [{ time: nowMs - 2 * H, px: '100', sz: '2', fee: '0.04', closedPnl: '0', tradeSide: 'Maker' }, { time: nowMs - H, px: '110', sz: '2', fee: '0.1', closedPnl: '20', tradeSide: 'Taker' },
  { time: nowMs - 9 * 24 * H, px: '50', sz: '1', fee: '0.5', closedPnl: '-3', tradeSide: 'Taker' }];
const dayEnd = (Math.floor(now / 86400) + 1) * 86400 * 1000;
writeFileSync(join(bt, 'm.json'), JSON.stringify({ switches: { enabled: true, qfex: true },
  qfex: { equity: 100, deposit: 100, limits: { weeklyCap: 30, weeklyUsed: 12.5, weeklyRemaining: 17.5, dailyCap: 12, dailyUsed: 12.2, dailyRemaining: 0, maxTradeLoss: 0, halted: { scope: 'daily', until: dayEnd, reason: 'daily loss cap reached' } }, volume: { day: {}, week: { volume: 71500, fees: 1.5, pnl: -2.25, trades: 300 }, month: { volume: 71500 }, goal: 300000 } },
  txflow: { equity: 518.7, activity: { fills, fundings: [], from: now - 30 * 86400 } },
  risex: { equity: 36.84, deposit: 113.78, allTime: { deposits: 156.01, withdrawals: 42.23, net: 113.78, src: 'RiseX transfer history (public API)' }, note: 'tracking only · not farmed: Bobby does not trade RiseX (you trade it yourself)',
    activity: { fills: [{ time: nowMs - H, px: '4000', sz: '0.5', fee: '0.2', closedPnl: '1.2', maker: true }], fundings: [], from: now - 30 * 86400 } } }));
const mon = (t) => { const d = Math.floor(t / 86400); return (d - ((d + 3) % 7)) * 86400; }; // Monday 00:00 UTC
writeFileSync(join(bt, 'points_manual.json'), JSON.stringify({ variational: { equity: 250, weeks: {} }, txflow: { weeks: { [String(mon(now - 9 * 86400))]: { points: 250 } }, retro: { label: 'Retroactive (pre-Season 1)', points: null } },
  extended: { weeks: { 66: { points: 6.3 } }, pointsTotal: 4064.9, profile: { asOf: 'test', items: [['Total rank', '#1,890']] } }, risex: { pointsTotal: 98 } }));
writeFileSync(join(bt, 'v.json'), JSON.stringify({ generatedAt: '2026-10-21', disclaimer: 'Illustrative only: points carry no guaranteed token rights.', platforms: [
  { id: 'extended', tgeStatus: 'announced, no date', airdropPct: 0.3, airdropBadge: 'official', airdropUrl: 'https://docs.extended.exchange/', totalPoints: 70e6, totalPointsBadge: 'official', valuable: true, marketReference: 'Polymarket >$150M 67%', userPoints: 1, scenarios: {} },
  { id: 'txflow', tgeStatus: 'unknown', docNotes: { url: 'https://docs.txflow.com/points/how-points-work', items: ['Cancelled orders and spot trading earn nothing.'] }, airdropPct: 0.1, airdropBadge: 'user assumption', totalPoints: 36380800, totalPointsBadge: 'projected', valuable: true, warning: 'txflowtoken.com is NOT an official TxFlow site' },
  { id: 'risex', tgeStatus: 'not announced', airdropPct: 0.1, airdropBadge: 'assumed', totalPoints: 9.8e6, totalPointsBadge: 'projected', valuable: true, warning: 'any site offering a RISE claim is a scam' },
  { id: 'qfex', tgeStatus: 'unknown', valuable: false, cannotValue: "no token/points announced: can't value" },
  { id: 'entropy', tgeStatus: 'none', valuable: false, cannotValue: "no token/points announced: can't value (Entropy pays cashback: USDC fee rebates)" }] }));
const pyEnv = { ...process.env, BOBBY_VIEW_PASSPHRASE: PASS, BOBBY_ACCOUNT_ADDRESS: '', BOBBY_HL_ADDRESS: '', BOBBY_TXFLOW_ADDRESS: '', BOBBY_VARIATIONAL_ADDRESS: '', QFEX_API_PUBLIC_KEY: '', QFEX_API_SECRET_KEY: '', QFEX_ACCOUNT_ID: '' };
execFileSync('python3', ['balances.py', '--mock', join(bt, 'm.json'), '--ledger', join(bt, 'l.json'), '--starts', join(bt, 's.json'), '--alerts', join(bt, 'ALERT'), '--out', 'dist/balances.enc.json', '--valuation', join(bt, 'v.json'), '--now', String(now)], { env: pyEnv });
const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '-d', 'dist'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(800);
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const fail = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true });
  const outside = [], logs = [];
  page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
  await page.setRequestInterception(true);
  page.on('request', (r) => { if (r.url().startsWith(ORIGIN)) return r.continue(); outside.push(r.url()); r.abort(); });
  await page.goto(ORIGIN + '/index.html', { waitUntil: 'networkidle0' });
  const raw = await page.evaluate(async () => (await fetch('./balances.enc.json')).text());
  if (/Epoch|Variational|TxFlow|points|weeklyCap|halted|airdrop/i.test(raw) || Object.keys(JSON.parse(raw)).sort().join() !== 'aad,alg,ct,it,iv,kdf,salt,v') fail.push('served file not an opaque envelope');
  await page.type('#viewpass', PASS); await page.click('#unlock');
  await page.waitForSelector('nav.bottom', { timeout: 20000 });
  const navOk = await page.evaluate(() => { const b = [...document.querySelectorAll('nav button')]; const p = b.find((x) => x.textContent.includes('Points')); if (p) p.click(); return { n: b.length, fits: b.every((x) => x.getBoundingClientRect().right <= window.innerWidth + 1) }; });
  await page.waitForSelector('#ptstable', { timeout: 10000 });
  const read = () => page.evaluate(() => ({ rows: [...document.querySelectorAll('#ptstable tbody tr')].map((r) => r.innerText.replace(/\s+/g, ' ').trim()),
    cds: [...document.querySelectorAll('#ptstable [data-cd]')].map((e) => e.textContent), hist: [...document.querySelectorAll('#ptshist-txflow tbody tr')].map((r) => r.innerText.replace(/\s+/g, ' ').trim()),
    cards: [...document.querySelectorAll('.card.pts')].map((c) => c.innerText.replace(/\s+/g, ' ').slice(0, 1500)), wide: document.documentElement.scrollWidth <= window.innerWidth + 1 }));
  const a = await read(); await sleep(2100); const b = await read();
  await page.screenshot({ path: 'tests/e2e_points.png', fullPage: true });
  const rows = a.rows.join(' | ');
  console.log(JSON.stringify({ navOk, rows: a.rows, cds: [a.cds, b.cds], hist: a.hist, cards: a.cards.map((c) => c.slice(0, 220)), outside, logs }, null, 1));
  if (navOk.n !== 7 || !navOk.fits || !a.wide) fail.push('nav/mobile layout');
  if (a.rows.length !== 8) fail.push('summary rows');
  if (!/Arcus \d*d? ?\d\d:\d\d:\d\d not connected/.test(rows) || !/Entropy .* not connected/.test(rows)) fail.push('not connected rows with countdown');
  if (!/TxFlow [\dd :]+ \$420 \+\$19\.86 \$0\.14/.test(rows)) fail.push('txflow week');
  if (!/QFEX [\dd :]+ \$71\.5K -\$2\.25 \$1\.50/.test(rows)) fail.push('qfex week');
  if (!/Variational [\dd :]+ — — —/.test(rows)) fail.push('variational manual');
  if (!/RiseX [\dd :]+ \$2\.0K \+\$1\.00 \$0\.20/.test(rows)) fail.push('risex week');
  if (!/Total \$73\.9K \+\$18\.61 \$1\.84/.test(rows)) fail.push('total row');
  if (a.cds.length !== 6 || a.cds.join() === b.cds.join()) fail.push('countdowns not ticking');
  if (!a.hist.some((x) => /-\$3\.50 \$0\.50 250 · ✍ manual 5,000/.test(x))) fail.push('txflow history');
  const earned = await page.evaluate(() => [...document.querySelectorAll('#ptsearned tbody tr')].map((r) => r.innerText.replace(/\s+/g, ' ').trim()));
  console.log(JSON.stringify({ earned }, null, 1));
  const E = earned.join(' | ');
  if (earned.length !== 7 || !/TxFlow Epoch \d+: 250 · ✍ manual 250 · ✍ manual 5,000( \||$)/.test(E) || !/Entropy .*rebates, not points/.test(E) || !/Arcus — not entered yet —/.test(E) || /\b0 · /.test(E)) fail.push('points earned table');
  const txCard = a.cards.find((c) => c.startsWith('🌊')) || '';
  const exCard = a.cards.find((c) => c.startsWith('♟')) || '';
  if (!/tracking only · not farmed/.test(exCard) || !/weekly distributions ended/.test(exCard) || !/Total rank #1,890/.test(exCard) || !/Extended Epoch 66: 6\.3 · ✍ manual 4,064\.9 · ✍ dashboard —/.test(E)) fail.push('extended');
  if (!/Retroactive \(pre-Season 1\) pending/.test(txCard)) fail.push('txflow retro');
  const rxCard = a.cards.find((c) => c.startsWith('⚡')) || '';
  if (!/tracking only · not farmed/.test(rxCard) || !/Season 1 “Ignite” · 200K points \/ week/.test(rxCard) || !/Tuesday 14:00 UTC/.test(rxCard) || !/Next points drop/.test(rxCard) || !/RiseX .*98 · ✍ dashboard/.test(E)) fail.push('risex card');
  const val = await page.evaluate(() => ({ disc: (document.querySelector('#valdisclaimer') || {}).textContent || '',
    t: Object.fromEntries([...document.querySelectorAll('#valcard .val')].map((e) => [e.id, e.innerText.replace(/\s+/g, ' ')])),
    ext: [...document.querySelectorAll('#valtable-extended tbody tr')].map((r) => r.innerText.replace(/\s+/g, ' ').trim()),
    rx: [...document.querySelectorAll('#valtable-risex tbody tr')].map((r) => r.innerText.replace(/\s+/g, ' ').trim()),
    tx: [...document.querySelectorAll('#valtable-txflow tbody tr')].map((r) => r.innerText.replace(/\s+/g, ' ').trim()) }));
  console.log(JSON.stringify({ val }, null, 1));
  if (!/no guaranteed token rights/.test(val.disc)) fail.push('valuation disclaimer');
  if (val.ext.join(' | ') !== '$ / point $1.0714 $2.1429 $4.2857 $8.5714 $12.86 | Your $ $4,355 $8,711 $17,421 $34,842 $52,263') fail.push('extended valuation');
  if (val.tx.join(' | ') !== '$ / point $0.6872 $1.3744 $2.7487 $5.4974 $8.2461 | Your $ $172 $344 $687 $1,374 $2,062') fail.push('txflow valuation (250 pts)');
  if (!/30% official/.test(val.t['val-extended'] || '') || !/Market hint: Polymarket/.test(val.t['val-extended'] || '') || !/NOT an official TxFlow site/.test(val.t['val-txflow'] || '') || !/10% user assumption/.test(val.t['val-txflow'] || '') || !/From the official docs \(source\) Cancelled orders/.test(val.t['val-txflow'] || '')) fail.push('valuation badges/notes');
  if (val.rx.join(' | ') !== '$ / point $2.5510 $5.1020 $10.20 $20.41 $30.61 | Your $ $250 $500 $1,000 $2,000 $3,000' || !/10% assumed/.test(val.t['val-risex'] || '') || !/scam/.test(val.t['val-risex'] || '')) fail.push('risex valuation');
  if (!/can't value/.test(val.t['val-qfex'] || '') || !/cashback/.test(val.t['val-entropy'] || '')) fail.push('cannot value');
  if (!/Points this week pending/.test(txCard) || !/Points season total 250 over 1 week\(s\) · 5,000 pts \/ \$1K/.test(txCard)) fail.push('txflow card points');
  const cards = a.cards.join(' ');
  if (!/Season 1 · 250K points \/ week/.test(cards) || !/Next points drop/.test(cards) || !/Points credited \(Tuesday; time not stated\)/.test(cards) || !/every 2 weeks \(date not published\)/.test(cards) || !/Points drop not announced/.test(cards)) fail.push('cards');
  // Balances tab: loss caps card
  await page.evaluate(() => [...document.querySelectorAll('nav button')].find((x) => x.textContent.includes('Balances')).click());
  await page.waitForSelector('#limitscard', { timeout: 10000 });
  const lim = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#limitscard .lim')].map((e) => [e.id, { t: e.innerText.replace(/\s+/g, ' '), bars: [...e.querySelectorAll('.bar .fill')].map((f) => f.className + ' ' + f.style.width) }])));
  const head = await page.evaluate(() => document.querySelector('#limitscard').innerText.replace(/\s+/g, ' ').slice(0, 200));
  await page.evaluate(() => document.querySelector('#limitscard').scrollIntoView());
  await page.screenshot({ path: 'tests/e2e_limits.png', fullPage: true });
  console.log(JSON.stringify({ head, lim }, null, 1));
  if (Object.keys(lim).join() !== 'lim-arcus,lim-entropy,lim-txflow,lim-qfex,lim-variational') fail.push('limits rows');
  const q = lim['lim-qfex'] || { t: '', bars: [] };
  if (!/Halted until \w{3} \d+ \w{3}, 0[12]:00 \(daily cap\)/.test(q.t) || !/\$12\.50 used of \$30 · \$17\.50 left/.test(q.t) || !/\$12\.20 used of \$12 · \$0\.00 left/.test(q.t) || q.bars.join() !== 'fill 42%,fill red 100%') fail.push('qfex caps');
  if (!/Not connected/.test(lim['lim-arcus'].t) || !/Weekly: — used of \$50/.test(lim['lim-arcus'].t) || !/Daily: — used of \$20/.test(lim['lim-arcus'].t) || !/Not connected/.test(lim['lim-entropy'].t)) fail.push('arcus/entropy caps');
  if (!/manual/.test(lim['lim-txflow'].t) || !/\$0\.00 used of \$50 · \$50\.00 left/.test(lim['lim-txflow'].t) || !/not set \(manual trading\)/.test(lim['lim-txflow'].t)) fail.push('txflow caps');
  if (!/manual/.test(lim['lim-variational'].t) || !/no data/.test(lim['lim-variational'].t)) fail.push('variational caps');
  if (!/Week resets Monday 00:00 UTC/.test(head)) fail.push('reset note');
  if (outside.length || logs.length) fail.push('outside requests / page errors');
} finally { await browser.close(); srv.kill(); restore(); }
if (fail.length) { console.error('E2E POINTS FAIL: ' + fail.join(', ')); process.exit(1); }
console.error('E2E POINTS OK');
