// Headless Chrome end-to-end check of dist/ (plain browser build) in TESTNET + DRY RUN with throwaway keys.
// Safety nets: every signed/mutating endpoint AND every mainnet host is aborted at the network layer, so nothing can
// ever be sent and mainnet is never contacted. The empty throwaway HL account is given fake collateral (mocked read).
import puppeteer from 'puppeteer-core';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';

const PORT = 8765, ORIGIN = `http://127.0.0.1:${PORT}`;
const inboxBackup = readFileSync('dist/proposals.json', 'utf8');
const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '-d', 'dist'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (u, b, h = {}) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(b) }).then((r) => r.json());

// live TESTNET marks so the proposals are valid post-only (maker) limits
const [hlMeta, hlCtx] = await post('https://api.hyperliquid-testnet.xyz/info', { type: 'metaAndAssetCtxs' });
const solI = hlMeta.universe.findIndex((u) => u.name === 'SOL'); const solMark = Number(hlCtx[solI].markPx);
const arM = (await fetch('https://api.testnet.arcus.xyz/v1/markets').then((r) => r.json())).markets.find((m) => m.marketDisplayName === 'ETH-USD');
const ethMark = Number(arM.markPrice);
const txMeta = (await post('https://rpc.txflow-testnet.xyz/info', { type: 'perpMeta', includeDelisted: false }, { 'x-api-version': '2026-08-16' })).data;
const btc = txMeta.universe.find((u) => /^BTC/.test(u.name));
const btcMark = Number((await post('https://rpc.txflow-testnet.xyz/info', { type: 'activeAssetCtx', coin: String(btc.index) }, { 'x-api-version': '2026-08-16' })).data.markPx);
const r2 = (x, d) => Number(x.toFixed(d));

const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
const logs = [], reqs = [];
page.on('console', (m) => logs.push(m.type() + ': ' + m.text()));
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
await page.setRequestInterception(true);
const MUT = /\/exchange$|\/v1\/(placeOrder|batchPlaceOrders|cancelOrder|setLeverage|cancelAllOrders|modifyOrder|withdraw)/;
const MAINNET = /^https:\/\/(api\.arcus\.xyz|api\.hyperliquid\.xyz|rpc\.txflow\.com)\//;
page.on('request', (r) => {
  const u = r.url(); reqs.push(r.method() + ' ' + u);
  if (MAINNET.test(u)) { logs.push('BLOCKED-MAINNET ' + u); return r.abort(); }
  if (MUT.test(new URL(u).pathname)) { logs.push('BLOCKED ' + u); return r.abort(); }
  if (u.startsWith('https://api.hyperliquid-testnet.xyz/info') && r.method() === 'POST') {
    const b = JSON.parse(r.postData() || '{}');
    if (b.type === 'clearinghouseState') return r.respond({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ assetPositions: [], withdrawable: '1000', marginSummary: { accountValue: '1000' } }) });
    if (b.type === 'activeAssetData') return r.respond({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ availableToTrade: ['1000', '1000'] }) });
  }
  r.continue();
});
const click = async (text, sel = 'button,label,a') => { const ok = await page.evaluate((t, s) => { const b = [...document.querySelectorAll(s)].find((x) => x.textContent.includes(t)); if (b) { b.click(); return true; } return false; }, text, sel); if (!ok) throw new Error('no button ' + text); await sleep(300); };
const typeIn = async (sel, v) => { await page.$eval(sel, (e) => { e.value = ''; }); await page.type(sel, v); };
const PIN = '483920';
const confirmAll = () => page.evaluate(() => { window.confirm = () => true; });

await page.goto(ORIGIN + '/index.html', { waitUntil: 'networkidle0' });
await confirmAll();
const noTelegram = await page.evaluate(() => !window.Telegram && ![...document.scripts].some((s) => /telegram/.test(s.src)));
const manifest = await page.evaluate(async () => (await fetch(document.querySelector('link[rel=manifest]').href)).json());
await click('Réglages');
await page.evaluate(() => { const l = [...document.querySelectorAll('label.toggle')].find((x) => x.textContent.includes('Testnet')); l.querySelector('input').click(); });
await sleep(500);
const arcusKey = randomBytes(32).toString('hex'), hlKey = '0x' + randomBytes(32).toString('hex');
await typeIn('input[placeholder^="Clé privée Ed25519"]', arcusKey);
await typeIn('input[placeholder^="Clé privée API wallet"]', hlKey);
await typeIn('input[placeholder^="Adresse principale"]', '0x' + randomBytes(20).toString('hex'));
await typeIn('input[placeholder^="PIN"]', PIN);
await typeIn('input[placeholder^="Confirme"]', PIN);
await click('Enregistrer (chiffré)');
await sleep(2500);
const stored = await page.evaluate(() => new Promise((res) => { const q = indexedDB.open('tgtrade'); q.onsuccess = () => { const g = q.result.transaction('kv').objectStore('kv').get('tgtrade_ks_v1'); g.onsuccess = () => res(g.result); }; }));
const ksOk = !!stored && !stored.includes(arcusKey) && !stored.includes(hlKey.slice(2)) && JSON.parse(stored).it === 600000;
const dryDefault = await page.evaluate(() => document.body.innerText.includes('DRY RUN'));
await page.click('.brand'); await sleep(300); await click('Verrouiller');

const now = Math.floor(Date.now() / 1000);
const solPx = r2(solMark * 0.99, 2), solSl = r2(solPx * 0.99, 2), solSz = r2(2 / (solPx - solSl), 2);
const ethPx = r2(ethMark * 1.01, 1), ethSl = r2(ethPx * 1.01, 1), ethSz = r2(2 / (ethSl - ethPx), 3);
const btcPx = r2(btcMark * 0.99, 0), btcSl = r2(btcPx * 0.99, 0), btcSz = r2(2 / (btcPx - btcSl), 4);
const trades = {
  hl: { id: 'e2e-hl', pf: 'hl', m: 'SOL', sd: 'long', sz: solSz, lev: 1, et: 'limit', px: solPx, ref: solMark, sl: solSl, exp: now + 3600, n: 'test e2e' },
  ar: { id: 'e2e-ar', pf: 'arcus', m: 'ETH-USD', sd: 'short', sz: ethSz, lev: 1, et: 'limit', px: ethPx, ref: ethMark, sl: ethSl, exp: now + 3600 },
  bad: { id: 'e2e-bad', pf: 'hl', m: 'SOL', sd: 'long', sz: 5, lev: 3, et: 'market', ref: solMark, sl: r2(solMark * 0.9, 2), exp: now + 3600 },
  tx: { id: 'e2e-tx', pf: 'txflow', m: btc.name, sd: 'long', sz: btcSz, lev: 1, et: 'limit', px: btcPx, sl: btcSl, exp: now + 3600 },
};
const tok = (t) => execFileSync('python3', ['make_proposal.py', './', JSON.stringify(t)], { encoding: 'utf8' }).trim().split('#p=')[1];
const toks = Object.fromEntries(Object.entries(trades).map(([k, t]) => [k, tok(t)]));
// inbox as send_batch.py would publish it (written directly: send_batch's baselines read mainnet, which e2e never touches)
writeFileSync('dist/proposals.json', JSON.stringify({ v: 1, updated: now, batches: [
  { id: 'b1', group: 'entropy', title: '🤖 Hyperliquid (testnet)', created: now, closed: false, proposals: [
    { id: 'e2e-hl', pf: 'hl', line: `🟢 LONG SOL ${solSz} · 1× · limite ${solPx}`, token: toks.hl, exp: now + 3600, status: 'pending' },
    { id: 'old', pf: 'hl', line: 'ancienne', token: toks.hl, exp: now - 10, status: 'pending' }] },
  { id: 'b2', group: 'txflow', title: '🌊 TxFlow (manuel)', created: now, closed: false, proposals: [
    { id: 'e2e-tx', pf: 'txflow', line: `🟢 LONG ${btc.name} ${btcSz}`, token: toks.tx, exp: now + 3600, status: 'pending' }] }] }));

async function openToken(t, approve = true) {
  await page.goto('about:blank'); await page.goto(`${ORIGIN}/index.html#p=${t}`, { waitUntil: 'networkidle0' }); await confirmAll();
  await page.waitForFunction(() => document.body.innerText.includes('Contrôle en direct') || document.querySelector('.alert.block'), { timeout: 25000 });
  await sleep(300);
  const screen = await page.evaluate(() => document.body.innerText);
  const blocks = await page.$$eval('.alert.block', (xs) => xs.map((x) => x.textContent));
  if (await page.$('#ack')) await page.click('#ack');
  const disabled = await page.$eval('.btn.approve', (b) => b.disabled).catch(() => null);
  let after = screen;
  if (approve && disabled === false) {
    await click('Approuver');
    if (await page.$('.pin')) { await page.type('.pin', PIN); await click('Valider'); }
    await page.waitForFunction(() => document.body.innerText.includes('DRY RUN') && document.querySelector('pre'), { timeout: 25000 });
    after = await page.evaluate(() => document.body.innerText);
  }
  return { screen, blocks, approveDisabled: disabled, after };
}
const hl = await openToken(toks.hl);
const ar = await openToken(toks.ar);
const bad = await openToken(toks.bad, false);
const tx = await openToken(toks.tx, false);
const txCard = { conforme: tx.screen.includes('Conforme à la politique'), link: await page.$eval('a.btn', (a) => a.href).catch(() => null) };

await page.goto(ORIGIN + '/index.html', { waitUntil: 'networkidle0' });
await click('Propositions', 'nav button');
await page.waitForFunction(() => document.body.innerText.includes('LONG SOL'), { timeout: 10000 });
const inbox = await page.evaluate(() => document.body.innerText);
await page.screenshot({ path: 'tests/e2e_inbox.png' });
await click('Ouvrir', 'button');
await page.waitForFunction(() => document.body.innerText.includes('Contrôle en direct') || document.querySelector('.alert.block'), { timeout: 25000 });
const fromInbox = await page.evaluate(() => document.body.innerText.includes('e2e-hl'));
await click('Tableau', 'nav button');
await page.waitForFunction(() => document.body.innerText.includes('Perte réalisée cette semaine'), { timeout: 25000 });
const dash = await page.evaluate(() => document.body.innerText);
await page.screenshot({ path: 'tests/e2e_dash.png' });
await page.click('.brand'); await sleep(300); await click('Journal');
const journal = await page.evaluate(() => document.querySelector('pre.log').innerText);
await page.screenshot({ path: 'tests/e2e_journal.png' });
writeFileSync('dist/proposals.json', inboxBackup);

const payloadTif = (txt, re) => re.test(txt);
const res = {
  noTelegram, manifestName: manifest.name, ksOk, dryDefault,
  hl_postOnly_Alo: payloadTif(hl.after, /"tif":\s*"Alo"/), hl_blocks: hl.blocks, hl_dry: hl.after.includes('DRY RUN — non envoyé'),
  ar_postOnly_ALO: payloadTif(ar.after, /"timeInForce":\s*"ALO"/), ar_blocks: ar.blocks, ar_dry: ar.after.includes('DRY RUN — non envoyé'),
  bad_blocks: bad.blocks, bad_approveDisabled: bad.approveDisabled,
  tx_blocks: tx.blocks, txCard,
  inbox_hasLines: inbox.includes('LONG SOL') && inbox.includes('TxFlow') && inbox.includes('expiré'), fromInbox,
  dash: dash.slice(0, 900), journal,
  csp: logs.filter((l) => /Content Security|Refused|pageerror|BLOCKED/.test(l)),
  hosts: [...new Set(reqs.map((r) => { const [m, u] = r.split(' '); const x = new URL(u); return m + ' ' + x.origin + x.pathname; }))],
};
console.log(JSON.stringify(res, null, 1));
await browser.close(); srv.kill();
const fail = [];
if (!res.noTelegram) fail.push('telegram'); if (!res.ksOk) fail.push('keystore'); if (!res.dryDefault) fail.push('dry default');
if (!res.hl_dry || !res.hl_postOnly_Alo) fail.push('hl dry-run post-only'); if (!res.ar_dry || !res.ar_postOnly_ALO) fail.push('arcus dry-run post-only');
if (res.bad_approveDisabled !== true || !res.bad_blocks.some((b) => /maker/.test(b)) || !res.bad_blocks.some((b) => /levier 3×/.test(b))) fail.push('policy blocks');
if (!res.txCard.conforme || !String(res.txCard.link).startsWith('https://app.txflow.com')) fail.push('txflow card');
if (!res.inbox_hasLines || !res.fromInbox) fail.push('inbox');
if (res.csp.some((l) => /MAINNET|Refused|Content Security|pageerror/.test(l))) fail.push('csp/mainnet');
if (fail.length) { console.error('E2E FAIL: ' + fail.join(', ')); process.exit(1); }
console.error('E2E OK');
