// Headless Chrome check of the QFEX proposal card in dist/ (plain browser build): MAINNET public market data over the
// MDS WebSocket only. Nothing is signed (the QFEX secret never exists in the browser); every request except the
// static page and wss://mds.qfex.* is aborted. Usage: npm run build && node tests/e2e_qfex_app.mjs
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import * as Q from '../src/qfex.js';
import { encodeProposal } from '../src/proposal.js';

const PORT = 8766, ORIGIN = `http://127.0.0.1:${PORT}`;
const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '-d', 'dist'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(800);
const q = await Q.mdsQuote(Q.MAINNET, 'US100-USD');
const now = Math.floor(Date.now() / 1000), mark = q.mark;
const mk = (o) => encodeProposal({ v: 1, pf: 'qfex', m: 'US100-USD', sd: 'long', et: 'limit', lev: 1, exp: now + 3600, ref: mark, ...o });
const cases = [
  ['ok', mk({ id: 'qx-ok', px: Math.floor(mark * 0.999), sz: 0.003, sl: Math.floor(mark * 0.99), tp: Math.floor(mark * 1.02), n: 'e2e' }), /Policy compliant/],
  ['too big', mk({ id: 'qx-big', px: Math.floor(mark * 0.999), sz: 0.02, sl: Math.floor(mark * 0.98), tp: Math.floor(mark * 1.02) }), /Loss at SL|loss at SL/],
  ['crossing', mk({ id: 'qx-cross', px: Math.ceil(mark * 1.002), sz: 0.003, sl: Math.floor(mark * 0.99), tp: Math.floor(mark * 1.02) }), /cross/],
];
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
let fail = 0;
for (const [name, tok, want] of cases) {
  const page = await browser.newPage();
  const blocked = [];
  await page.setRequestInterception(true);
  page.on('request', (r) => { const u = r.url(); if (u.startsWith(ORIGIN) || u.startsWith('wss://mds.qfex.')) return r.continue(); blocked.push(u); r.abort(); });
  await page.goto(`${ORIGIN}/index.html?p=${tok}`, { waitUntil: 'domcontentloaded' });
  let text = '';
  for (let i = 0; i < 40; i++) { await sleep(250); text = await page.evaluate(() => document.body.innerText); if (/Live check/.test(text) && !/Loading live price/.test(text)) break; }
  const ok = want.test(text) && /QFEX/.test(text) && !/Approve and send/.test(text);
  if (!ok) fail++;
  const lines = text.split('\n').filter((l) => /Mark|Maker fee|bid \/ ask|Loss at SL|⛔|✅|⚠️|queue/i.test(l)).slice(0, 12);
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}\n  ` + lines.join('\n  ') + (blocked.length ? `\n  aborted: ${blocked.length} other request(s)` : ''));
  await page.close();
}
await browser.close(); srv.kill();
process.exit(fail ? 1 : 0);
