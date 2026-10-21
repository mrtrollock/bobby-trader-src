// Headless Chrome check of the Briefing tab's "Low-OI picks" card in dist/: an encrypted briefing.enc.json with a lowOi
// section (throwaway passphrase, or the real one + real files with LOWOI_REAL=1) must decrypt and render per platform
// (Arcus, Entropy, TxFlow) OI, spread, depth and a Berlin timestamp, with no request outside the static site.
// Usage: npm run build && node tests/e2e_lowoi.mjs
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { sealJson } from '../src/vault.js';

const REAL = process.env.LOWOI_REAL === '1';
const PORT = 8768, ORIGIN = `http://127.0.0.1:${PORT}`;
const PASS = REAL ? process.env.BOBBY_VIEW_PASSPHRASE : 'e2e-' + randomBytes(9).toString('hex');
const FILES = ['proposals.enc.json', 'briefing.enc.json', 'balances.enc.json'];
const backups = Object.fromEntries(FILES.map((f) => [f, existsSync('dist/' + f) ? readFileSync('dist/' + f, 'utf8') : null]));
const restore = () => { for (const [f, v] of Object.entries(backups)) { if (v == null) rmSync('dist/' + f, { force: true }); else writeFileSync('dist/' + f, v); } };
const seal = async (f, obj) => writeFileSync('dist/' + f, JSON.stringify(await sealJson(obj, PASS)));
const now = Date.now();
if (REAL) for (const f of FILES) copyFileSync('public/' + f, 'dist/' + f);
else {
  const pk = (market, oiUsd, spread, depthUsd) => ({ market, oiUsd, spread, depthUsd, worstLossUsd: 2.6, refNotionalUsd: 226 });
  await seal('briefing.enc.json', { v: 1, generated: Math.floor(now / 1000), platforms: [], lowOi: { t: now, platforms: {
    arcus: { eligible: 60, scanned: 70, picks: [pk('W-USD', 21800, 0.0014, 180000), pk('PENGU-USD', 40300, 0.0012, 156000)] },
    entropy: { eligible: 8, scanned: 14, picks: [pk('io:XIAOMI', 100500, 0.001, 13800)] },
    txflow: { manual: true, eligible: 30, scanned: 236, picks: [pk('GMX-USDC', 20400, 0.0012, 2500)] } } } });
  await seal('proposals.enc.json', { v: 1, updated: 0, batches: [] });
  await seal('balances.enc.json', { v: 1, platforms: [] });
}
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
  const raw = await page.evaluate(async () => (await fetch('./briefing.enc.json')).text());
  if (/picks|W-USD|lowOi/.test(raw) || Object.keys(JSON.parse(raw)).sort().join() !== 'aad,alg,ct,it,iv,kdf,salt,v') fail.push('served briefing not an opaque envelope');
  await page.type('#viewpass', PASS); await page.click('#unlock');
  await page.waitForSelector('#lowoi', { timeout: 20000 });
  const r = await page.evaluate(() => { const c = document.querySelector('#lowoi');
    return { text: c.innerText.replace(/\s+/g, ' '), h3: [...c.querySelectorAll('h3')].map((x) => x.textContent), rows: [...c.querySelectorAll('tbody tr')].map((x) => x.innerText.replace(/\s+/g, ' ').trim()), wide: document.documentElement.scrollWidth <= window.innerWidth + 1 }; });
  await page.evaluate(() => document.querySelector('#lowoi').scrollIntoView());
  await page.screenshot({ path: REAL ? '/tmp/e2e_lowoi_real.png' : 'tests/e2e_lowoi.png', fullPage: true });
  console.log(JSON.stringify({ h3: r.h3, rows: r.rows, outside, logs }, null, 1));
  if (!/Low-OI picks/.test(r.text) || !/\(Berlin time\)/.test(r.text)) fail.push('title/timestamp');
  if (!r.h3.some((x) => /Arcus/.test(x)) || !r.h3.some((x) => /Entropy/.test(x)) || !r.h3.some((x) => /TxFlow/.test(x))) fail.push('platform sections');
  if (!REAL && (!/W-USD \$21,800 0\.140% \$180,000/.test(r.rows.join(' | ')) || !/TxFlow \(manual\)/.test(r.h3.join()))) fail.push('rows');
  if (!r.rows.length || !r.wide) fail.push('rows/layout');
  if (outside.length || logs.length) fail.push('outside requests / page errors');
} finally { await browser.close(); srv.kill(); restore(); }
if (fail.length) { console.error('E2E LOWOI FAIL: ' + fail.join(', ')); process.exit(1); }
console.error('E2E LOWOI OK');
