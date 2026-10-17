import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { encodeProposal, decodeProposal, extractToken } from '../src/proposal.js';
import { encryptSecrets, decryptSecrets } from '../src/keystore.js';

const trade = { id: 'demo-1', pf: 'hl', m: 'io:ANTH', sd: 'short', sz: 1.5, lev: 5, et: 'limit', px: 1000, ref: 980, sl: 1050, tp: 900, exp: 1792150000, n: 'Example short — retest zone 995–1 005 €' };

test('round trip JS encode/decode', () => {
  const tok = encodeProposal(trade);
  assert.deepEqual(decodeProposal(tok), { v: 1, ...trade, act: 'open' });
});
test('make_proposal.py URL decodes in JS (incl. Telegram appended params) and corruption is detected', () => {
  const r = spawnSync('python3', [new URL('../make_proposal.py', import.meta.url).pathname, 'https://u.github.io/app/', JSON.stringify(trade)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const url = r.stdout.trim();
  assert.match(url, /^https:\/\/u\.github\.io\/app\/#p=v1\./);
  const withTg = url + '&tgWebAppData=query_id%3DAAA&tgWebAppVersion=9.1&tgWebAppPlatform=android';
  const p = decodeProposal(extractToken(withTg));
  assert.equal(p.n, trade.n); assert.equal(p.sz, 1.5); assert.equal(p.m, 'io:ANTH');
  const tok = extractToken(url);
  const parts = tok.split('.');
  const flipped = parts[1].slice(0, 10) + (parts[1][10] === 'A' ? 'B' : 'A') + parts[1].slice(11);
  assert.throws(() => decodeProposal(`v1.${flipped}.${parts[2]}`), /corrompue/);
  assert.throws(() => decodeProposal(`v1.${parts[1].slice(0, -4)}.${parts[2]}`), /corrompue/);
});
test('validation rejects bad proposals', () => {
  assert.throws(() => decodeProposal(encodeProposal({ ...trade, pf: 'txflow' })));
  assert.throws(() => decodeProposal(encodeProposal({ ...trade, et: 'limit', px: undefined })));
  assert.throws(() => decodeProposal(encodeProposal({ ...trade, lev: 2.5 })));
  assert.equal(extractToken('nothing here'), null);
});
test('keystore: PBKDF2(600k)+AES-GCM round trip, wrong PIN fails, no plaintext in blob', async () => {
  const secret = { arcus: { key: 'aa'.repeat(32) }, hl: { key: '0x' + 'bb'.repeat(32) } };
  const blob = await encryptSecrets(secret, '123456');
  assert.ok(!blob.includes('aaaa') && !blob.includes('bbbb'));
  assert.equal(JSON.parse(blob).it, 600000);
  assert.deepEqual(await decryptSecrets(blob, '123456'), secret);
  await assert.rejects(decryptSecrets(blob, '654321'), /PIN incorrect/);
  await assert.rejects(encryptSecrets(secret, '1', 1000));
});
