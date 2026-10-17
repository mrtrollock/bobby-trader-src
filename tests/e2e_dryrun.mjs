// Headless Chrome end-to-end check of dist/index.html in TESTNET + DRY RUN with throwaway keys.
// Safety net: every signed/mutating endpoint is aborted at the network layer, so nothing can ever be sent.
import puppeteer from 'puppeteer-core';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const srv = spawn('python3', ['-m', 'http.server', '8765', '--bind', '127.0.0.1', '-d', 'dist'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, isMobile: true });
const logs = [], reqs = [];
page.on('console', (m) => logs.push(m.type() + ': ' + m.text()));
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
await page.setRequestInterception(true);
const MUT = /\/exchange$|\/v1\/(placeOrder|batchPlaceOrders|cancelOrder|setLeverage|cancelAllOrders|modifyOrder)/;
page.on('request', (r) => { reqs.push(r.method() + ' ' + r.url()); if (MUT.test(new URL(r.url()).pathname)) { logs.push('BLOCKED ' + r.url()); r.abort(); } else r.continue(); });
const click = async (text) => { const ok = await page.evaluate((t) => { const b = [...document.querySelectorAll('button,label')].find((x) => x.textContent.includes(t)); if (b) { b.click(); return true; } return false; }, text); if (!ok) throw new Error('no button ' + text); await new Promise((r) => setTimeout(r, 300)); };
const typeIn = async (sel, v) => { await page.$eval(sel, (e) => { e.value = ''; }); await page.type(sel, v); };
const PIN = '483920';
const confirmAll = () => page.evaluate(() => { window.confirm = () => true; });

await page.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'networkidle0' });
await confirmAll();
await click('Réglages');
await page.evaluate(() => { const l = [...document.querySelectorAll('label.toggle')].find((x) => x.textContent.includes('Testnet')); l.querySelector('input').click(); });
await new Promise((r) => setTimeout(r, 500));
const inputs = 'section:nth-of-type(2) input';
const arcusKey = randomBytes(32).toString('hex'), hlKey = '0x' + randomBytes(32).toString('hex');
await typeIn('input[placeholder^="Clé privée Ed25519"]', arcusKey);
await typeIn('input[placeholder^="Clé privée API wallet"]', hlKey);
await typeIn('input[placeholder^="Adresse principale"]', '0x' + randomBytes(20).toString('hex'));
await typeIn('input[placeholder^="PIN"]', PIN);
await typeIn('input[placeholder^="Confirme"]', PIN);
await click('Enregistrer (chiffré)');
await new Promise((r) => setTimeout(r, 2500));
const stored = await page.evaluate(() => new Promise((res) => { const q = indexedDB.open('tgtrade'); q.onsuccess = () => { const g = q.result.transaction('kv').objectStore('kv').get('tgtrade_ks_v1'); g.onsuccess = () => res(g.result); }; }));
const ksOk = stored && !stored.includes(arcusKey) && !stored.includes(hlKey.slice(2)) && JSON.parse(stored).it === 600000;
await page.click('.brand'); await new Promise((r) => setTimeout(r, 300)); await click('Verrouiller'); // lock -> PIN prompt must appear on approve

async function runProposal(trade) {
  const url = execFileSync('python3', ['make_proposal.py', 'http://127.0.0.1:8765/index.html', JSON.stringify(trade)], { encoding: 'utf8' }).trim();
  await page.goto('about:blank'); await page.goto(url, { waitUntil: 'networkidle0' }); await confirmAll();
  await page.waitForFunction(() => document.body.innerText.includes('Contrôle en direct') || document.querySelector('.alert.block'), { timeout: 20000 });
  const screen = await page.evaluate(() => document.body.innerText);
  const hasAck = await page.$('#ack');
  if (hasAck) await page.click('#ack');
  const disabled = await page.$eval('.btn.approve', (b) => b.disabled).catch(() => null);
  if (disabled === false) {
    await click('Approuver');
    if (await page.$('.pin')) { await page.type('.pin', PIN); await click('Valider'); }
    await page.waitForFunction(() => document.body.innerText.includes('DRY RUN') && document.querySelector('pre'), { timeout: 20000 });
  }
  return { screen, after: await page.evaluate(() => document.body.innerText) };
}
const now = Math.floor(Date.now() / 1000);
const hlRes = await runProposal({ id: 'e2e-hl', pf: 'hl', m: 'SOL', sd: 'long', sz: 0.5, lev: 3, et: 'market', ref: 105.87, sl: 100, tp: 115, exp: now + 3600, n: 'test e2e' });
const arRes = await runProposal({ id: 'e2e-ar', pf: 'arcus', m: 'ETH-USD', sd: 'short', sz: 0.05, lev: 5, et: 'limit', px: 2500, ref: 2462, sl: 2600, tp: 2300, exp: now + 3600 });
const bigRes = await runProposal({ id: 'e2e-big', pf: 'hl', m: 'SOL', sd: 'short', sz: 50, lev: 3, et: 'limit', px: 106, sl: 110, tp: 95, exp: now - 10 });
await page.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'networkidle0' });
await click('Journal');
const journal = await page.evaluate(() => document.querySelector('pre.log').innerText);
await page.screenshot({ path: 'tests/e2e_journal.png' });
console.log(JSON.stringify({ ksOk, hl: hlRes.after.slice(0, 1800), arcus: arRes.after.slice(0, 2600), big: bigRes.screen.slice(0, 1400), journal,
  csp: logs.filter((l) => /Content Security|Refused|pageerror|BLOCKED/.test(l)), hosts: [...new Set(reqs.map((r) => r.split(' ')[0] + ' ' + new URL(r.split(' ')[1]).origin + new URL(r.split(' ')[1]).pathname))] }, null, 1));
await browser.close(); srv.kill();
