// Headless Chrome check of the announcements banner in dist/: every data file is sealed with a throwaway passphrase
// (announcements.enc.json via tools/announce.py seal); the banner must sit sticky at the top of every tab on phone and
// desktop widths, show the most urgent item + "N more", dismiss (persisted), list everything on the Points tab, and an
// unreadable announcements file must never block the unlock. Real data files are backed up and restored.
// Usage: npm run build && node tests/e2e_announce.mjs
import puppeteer from 'puppeteer-core';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealJson } from '../src/vault.js';

const PORT = 8768, ORIGIN = `http://127.0.0.1:${PORT}`;
const PASS = 'e2e-' + randomBytes(9).toString('hex');
const FILES = ['proposals.enc.json', 'briefing.enc.json', 'balances.enc.json', 'positions.enc.json', 'announcements.enc.json'];
const backups = Object.fromEntries(FILES.map((f) => [f, existsSync('dist/' + f) ? readFileSync('dist/' + f, 'utf8') : null]));
const restore = () => { for (const [f, v] of Object.entries(backups)) { if (v == null) rmSync('dist/' + f, { force: true }); else writeFileSync('dist/' + f, v); } };
const seal = async (f, obj, p = PASS) => writeFileSync('dist/' + f, JSON.stringify(await sealJson(obj, p)));
const now = Date.now(), H = 3600e3, iso = (t) => new Date(t).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = [];
const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '-d', 'dist'], { stdio: 'ignore' });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
try {
  await seal('briefing.enc.json', { v: 1, platforms: [] });
  await seal('proposals.enc.json', { v: 1, updated: 0, batches: [] });
  await seal('positions.enc.json', { v: 1, generated: 0, positions: [], orders: [], platforms: {}, bobby: null });
  await seal('balances.enc.json', { v: 1, generated: Math.floor(now / 1000), platforms: [] });
  const d = mkdtempSync(join(tmpdir(), 'ann-e2e-')), f = join(d, 'a.json');
  writeFileSync(f, '[]');
  const env = { ...process.env, BOBBY_VIEW_PASSPHRASE: PASS };
  const add = (...a) => execFileSync('python3', ['tools/announce.py', '--file', f, 'add', ...a], { env });
  add('--project', 'extended', '--title', 'Airdrop eligibility: sign the message', '--text', 'Extended asks every trader to sign an eligibility message in the app before the snapshot.', '--severity', 'action',
    '--url', 'https://docs.extended.exchange/', '--deadline', iso(now + 30 * H), '--claim-url', 'https://app.extended.exchange/');
  add('--project', 'variational', '--title', 'TGE date announced', '--text', 'Token generation on 12 Nov.', '--severity', 'info', '--url', 'https://variational.io/');
  add('--project', 'txflow', '--title', 'Season 0 retro points live', '--severity', 'info', '--url', 'https://docs.txflow.com/points/how-points-work');
  execFileSync('python3', ['tools/announce.py', '--file', f, 'seal', '--out', 'dist/announcements.enc.json'], { env });
  const raw = readFileSync('dist/announcements.enc.json', 'utf8');
  if (/extended|variational|airdrop/i.test(raw)) fail.push('announcements file not opaque');
  await sleep(500);
  for (const [name, vp] of [['mobile', { width: 375, height: 812, isMobile: true, hasTouch: true }], ['desktop', { width: 1280, height: 800 }]]) {
    const page = await browser.newPage();
    await page.setViewport(vp);
    const outside = [], logs = [];
    page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
    await page.setRequestInterception(true);
    page.on('request', (r) => { if (r.url().startsWith(ORIGIN)) return r.continue(); outside.push(r.url()); r.abort(); });
    await page.goto(ORIGIN + '/index.html', { waitUntil: 'networkidle0' });
    await page.evaluate(() => localStorage.clear());
    await page.type('#viewpass', PASS); await page.click('#unlock');
    await page.waitForSelector('nav.bottom', { timeout: 20000 });
    for (const tab of ['Briefing', 'Balances', 'Positions', 'Dashboard', 'Settings', 'Points']) {
      await page.evaluate((t) => [...document.querySelectorAll('nav button')].find((x) => x.textContent.includes(t)).click(), tab);
      await sleep(150);
      const b = await page.evaluate(() => { const e = document.getElementById('annbanner'); if (!e) return null; const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, first: e === document.getElementById('app').firstElementChild, t: e.innerText.replace(/\s+/g, ' ') }; });
      if (!b || !b.first || b.top > 20 || b.bottom > vp.height) fail.push(`${name}/${tab}: banner not at the top / not visible`);
      if (b && !/Action needed.*Extended.*Airdrop eligibility.*Deadline \w{3} \d+ \w{3}, \d\d:\d\d Berlin · in 1d [56]h.*\+2 more announcements/i.test(b.t)) fail.push(`${name}/${tab}: banner text ${b && b.t}`);
    }
    const card = await page.evaluate(() => (document.getElementById('anncard') || {}).innerText || '');
    if ((card.match(/showing in the banner/g) || []).length !== 3) fail.push(name + ': points card');
    // sticky while scrolling (Points tab is long)
    await page.evaluate(() => window.scrollTo(0, 2000)); await sleep(100);
    const st = await page.evaluate(() => document.getElementById('annbanner').getBoundingClientRect().top);
    if (st < -1 || st > 20) fail.push(name + ': not sticky (' + st + ')');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.click('#annmore'); await sleep(100);
    const n = await page.evaluate(() => document.querySelectorAll('#annbanner .annitem').length);
    if (n !== 3) fail.push(name + ': expand');
    await page.screenshot({ path: `tests/e2e_announce_${name}.png` });
    await page.click('#annbanner .annitem.action .anndismiss'); await sleep(100);
    const after = await page.evaluate(() => ({ t: document.getElementById('annbanner').innerText, ls: localStorage.getItem('bobby_ann_dismissed_v1'), card: document.getElementById('anncard').innerText }));
    if (/Airdrop eligibility/.test(after.t) || !/TGE date announced/.test(after.t) || !/extended-/.test(after.ls || '') || !/dismissed/.test(after.card)) fail.push(name + ': dismiss');
    await page.evaluate(() => [...document.querySelectorAll('#anncard .annrestore')][0].click()); await sleep(100);
    if (!/Airdrop eligibility/.test(await page.evaluate(() => document.getElementById('annbanner').innerText))) fail.push(name + ': restore');
    console.log(JSON.stringify({ name, outside, logs }));
    if (outside.length || logs.length) fail.push(name + ': outside requests / page errors');
    await page.close();
  }
  // an announcements file sealed with another passphrase (or missing) never blocks the unlock: no banner, app works
  await seal('announcements.enc.json', { v: 1, items: [] }, 'other-passphrase-xyz');
  const page = await browser.newPage();
  await page.goto(ORIGIN + '/index.html', { waitUntil: 'networkidle0' });
  await page.type('#viewpass', PASS); await page.click('#unlock');
  await page.waitForSelector('nav.bottom', { timeout: 20000 });
  if (await page.evaluate(() => !!document.getElementById('annbanner'))) fail.push('banner from unreadable file');
  rmSync('dist/announcements.enc.json');
  await page.reload({ waitUntil: 'networkidle0' });
  await page.type('#viewpass', PASS); await page.click('#unlock');
  await page.waitForSelector('nav.bottom', { timeout: 20000 });
} finally { await browser.close(); srv.kill(); restore(); }
if (fail.length) { console.error('E2E ANNOUNCE FAIL: ' + fail.join(', ')); process.exit(1); }
console.error('E2E ANNOUNCE OK');
