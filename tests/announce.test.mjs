import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanEnv } from './helpers.mjs';
import { openJson } from '../src/vault.js';
import * as AN from '../src/announce.js';

const ROOT = new URL('..', import.meta.url).pathname;
const NOW = Date.parse('2026-10-22T10:00:00Z');
const cli = (file, args, extra = {}) => spawnSync('python3', [join(ROOT, 'tools/announce.py'), '--file', file, ...args],
  { encoding: 'utf8', env: cleanEnv({ ANNOUNCE_NOW: String(NOW / 1000), ...extra }) });

test('announce.py: add (Berlin deadline -> UTC), dedupe by project+title and id, list, remove, expire', () => {
  const d = mkdtempSync(join(tmpdir(), 'ann-')), f = join(d, 'announcements.json');
  writeFileSync(f, '[]\n');
  let r = cli(f, ['add', '--project', 'extended', '--title', 'Airdrop registration open', '--text', 'Sign the eligibility message', '--severity', 'action',
    '--url', 'https://docs.extended.exchange/x', '--deadline', '2026-10-30T18:00', '--claim-url', 'https://app.extended.exchange/claim']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^added: extended-airdrop-registration-open-/);
  let items = JSON.parse(readFileSync(f, 'utf8'));
  assert.equal(items.length, 1);
  assert.equal(items[0].deadline, '2026-10-30T17:00:00Z'); // 18:00 Berlin (CET after the DST switch on 25 Oct)
  assert.equal(items[0].createdAt, '2026-10-22T10:00:00Z');
  assert.equal(items[0].claimUrl, 'https://app.extended.exchange/claim');
  // same project + title (other case): updated, not duplicated; createdAt kept
  r = cli(f, ['add', '--project', 'extended', '--title', 'AIRDROP registration open', '--text', 'new text', '--severity', 'action', '--url', 'https://docs.extended.exchange/y'],
    { ANNOUNCE_NOW: String(NOW / 1000 + 60) });
  assert.match(r.stdout, /^updated:/);
  items = JSON.parse(readFileSync(f, 'utf8'));
  assert.equal(items.length, 1); assert.equal(items[0].text, 'new text'); assert.equal(items[0].createdAt, '2026-10-22T10:00:00Z');
  r = cli(f, ['add', '--project', 'variational', '--title', 'TGE date announced', '--severity', 'info', '--url', 'https://variational.io/blog', '--id', 'var-tge', '--expires', '2026-10-25']);
  assert.equal(r.status, 0, r.stderr);
  r = cli(f, ['add', '--project', 'variational', '--title', 'Different title', '--severity', 'info', '--url', 'https://variational.io/blog2', '--id', 'var-tge']);
  assert.match(r.stdout, /^updated: var-tge/);
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).length, 2);
  r = cli(f, ['list']); assert.equal(r.status, 0); assert.match(r.stdout, /2 item\(s\) active/);
  // validation: https only, known projects, no wallet addresses
  assert.notEqual(cli(f, ['add', '--project', 'extended', '--title', 't', '--severity', 'info', '--url', 'http://x.com']).status, 0);
  assert.notEqual(cli(f, ['add', '--project', 'extended', '--title', 't', '--severity', 'info', '--url', 'javascript:alert(1)']).status, 0);
  assert.notEqual(cli(f, ['add', '--project', 'nope', '--title', 't', '--severity', 'info', '--url', 'https://x.com']).status, 0);
  assert.notEqual(cli(f, ['add', '--project', 'extended', '--title', 'send to 0x' + 'ab'.repeat(20), '--severity', 'info', '--url', 'https://x.com']).status, 0);
  // expire: past deadline / expiry for more than keep-days only
  const later = String(Date.parse('2026-11-10T00:00:00Z') / 1000);
  r = cli(f, ['list', '--all'], { ANNOUNCE_NOW: later }); assert.match(r.stdout, /deadline passed/); assert.match(r.stdout, /expired/);
  r = cli(f, ['expire', '--keep-days', '30'], { ANNOUNCE_NOW: later }); assert.match(r.stdout, /expired 0/);
  r = cli(f, ['expire'], { ANNOUNCE_NOW: later }); assert.match(r.stdout, /expired 2/);
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), []);
  cli(f, ['add', '--project', 'risex', '--title', 'x', '--severity', 'info', '--url', 'https://rise.trade']);
  assert.equal(cli(f, ['remove', '--id', 'nope']).status === 0, false);
  const id = JSON.parse(readFileSync(f, 'utf8'))[0].id;
  assert.equal(cli(f, ['remove', '--id', id]).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), []);
});

test('announce.py seal: encrypted envelope only (refuses without a passphrase), opens in the app, unchanged items keep the ciphertext', async () => {
  const d = mkdtempSync(join(tmpdir(), 'ann-')), f = join(d, 'a.json'), out = join(d, 'announcements.enc.json'), PASS = 'test-pass-123456';
  writeFileSync(f, '[]\n');
  cli(f, ['add', '--project', 'txflow', '--title', 'Season 0 retro points', '--severity', 'info', '--url', 'https://docs.txflow.com/x']);
  assert.notEqual(cli(f, ['seal', '--out', out]).status, 0);
  assert.equal(existsSync(out), false);
  assert.notEqual(cli(f, ['seal', '--out', join(d, 'plain.json')], { BOBBY_VIEW_PASSPHRASE: PASS }).status, 0);
  const r = cli(f, ['seal', '--out', out], { BOBBY_VIEW_PASSPHRASE: PASS });
  assert.equal(r.status, 0, r.stderr);
  const raw = readFileSync(out, 'utf8'), env = JSON.parse(raw);
  assert.deepEqual(Object.keys(env).sort(), ['aad', 'alg', 'ct', 'it', 'iv', 'kdf', 'salt', 'v']);
  assert.doesNotMatch(raw, /txflow|Season/i);
  const doc = await openJson(env, PASS);
  assert.equal(doc.items[0].project, 'txflow');
  cli(f, ['seal', '--out', out], { BOBBY_VIEW_PASSPHRASE: PASS });
  assert.equal(readFileSync(out, 'utf8'), raw);
});

// minimal DOM stand-in for the pure builders
function h(tag, attrs = {}, ...kids) {
  const el = { tag, attrs: attrs || {}, kids: [], classList: { add: (c) => { el.attrs.class = (el.attrs.class || '') + ' ' + c; } }, append: (...k) => el.kids.push(...k) };
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.kids.push(c);
  return el;
}
const text = (el) => (el == null ? '' : typeof el === 'string' ? el : el.kids.map(text).join(' '));
const find = (el, pred, out = []) => { if (el && typeof el === 'object') { if (pred(el)) out.push(el); el.kids.forEach((k) => find(k, pred, out)); } return out; };
const iso = (ms) => new Date(ms).toISOString();
const H = 3600e3;
const items = [
  { id: 'i-old', project: 'variational', title: 'Old info', severity: 'info', url: 'https://variational.io', createdAt: iso(NOW - 48 * H) },
  { id: 'i-new', project: 'extended', title: 'TGE date', severity: 'info', url: 'https://extended.exchange', createdAt: iso(NOW - H) },
  { id: 'a-late', project: 'txflow', title: 'Register later', severity: 'action', deadline: iso(NOW + 10 * 24 * H), url: 'https://docs.txflow.com', createdAt: iso(NOW) },
  { id: 'a-soon', project: 'extended', title: 'Sign eligibility', severity: 'action', deadline: iso(NOW + 26 * H + 5 * 60e3), url: 'https://extended.exchange/a', claimUrl: 'javascript:alert(1)', createdAt: iso(NOW - 5 * H) },
  { id: 'a-past', project: 'arcus', title: 'Missed', severity: 'action', deadline: iso(NOW - H), url: 'https://arcus.xyz', createdAt: iso(NOW - 9 * H) },
  { id: 'i-exp', project: 'risex', title: 'Expired', severity: 'info', expiresAt: iso(NOW - 1), url: 'https://rise.trade', createdAt: iso(NOW) },
];

test('announce.js: ordering (action by deadline, then newest info), hidden reasons, Berlin countdown', () => {
  assert.deepEqual(AN.activeItems(items, [], NOW).map((x) => x.id), ['a-soon', 'a-late', 'i-new', 'i-old']);
  assert.deepEqual(AN.activeItems(items, ['a-soon'], NOW).map((x) => x.id), ['a-late', 'i-new', 'i-old']);
  assert.equal(AN.hiddenReason(items[4], [], NOW), 'deadline passed');
  assert.equal(AN.hiddenReason(items[5], [], NOW), 'expired');
  assert.equal(AN.hiddenReason(items[0], new Set(['i-old']), NOW), 'dismissed');
  assert.equal(AN.fmtLeft(26 * 3600 + 300), 'in 1d 2h');
  assert.equal(AN.fmtLeft(2 * 3600 + 300), 'in 2h 5m');
  assert.equal(AN.fmtLeft(20), 'in 1m');
  assert.equal(AN.deadlineText(items[3], NOW), 'Deadline Fri 23 Oct, 14:05 Berlin · in 1d 2h'); // 12:05Z = 14:05 CEST
  assert.equal(AN.safeUrl('javascript:alert(1)'), null);
  assert.equal(AN.safeUrl('http://x.com'), null);
  assert.equal(AN.safeUrl('https://x.com/a'), 'https://x.com/a');
  assert.deepEqual(AN.itemsOf({ v: 1, items: [1] }), [1]); assert.deepEqual(AN.itemsOf(null), []);
});

test('announce.js: banner shows the top item + "N more" (expands), dismiss callback, safe links only; empty -> null', () => {
  assert.equal(AN.bannerEl(h, null, { now: NOW }), null);
  assert.equal(AN.bannerEl(h, { items: [] }, { now: NOW }), null);
  assert.equal(AN.bannerEl(h, { items: [items[4], items[5]] }, { now: NOW }), null);
  const dismissed = [];
  const b = AN.bannerEl(h, { items }, { now: NOW, onDismiss: (id) => dismissed.push(id), onToggle: () => {} });
  assert.match(b.attrs.class, /annbanner action/);
  const rows = find(b, (e) => /annitem/.test(e.attrs.class || ''));
  assert.equal(rows.length, 1); assert.equal(rows[0].attrs['data-id'], 'a-soon');
  assert.match(text(b), /Sign eligibility/); assert.match(text(b), /Deadline Fri 23 Oct, 14:05 Berlin · in 1d 2h/);
  assert.match(text(b), /\+3 more announcements/);
  const hrefs = find(b, (e) => e.tag === 'a').map((a) => a.attrs.href);
  assert.deepEqual(hrefs, ['https://extended.exchange/a']); // the javascript: claim link is dropped
  find(b, (e) => e.tag === 'button' && e.attrs.class === 'anndismiss')[0].attrs.onclick({ stopPropagation() {} });
  assert.deepEqual(dismissed, ['a-soon']);
  const ex = AN.bannerEl(h, { items }, { now: NOW, expanded: true });
  assert.equal(find(ex, (e) => /annitem/.test(e.attrs.class || '')).length, 4);
  assert.match(text(ex), /Show less/);
  const info = AN.bannerEl(h, { items: [items[0]] }, { now: NOW });
  assert.match(info.attrs.class, /annbanner info/); assert.doesNotMatch(text(info), /more/);
});

test('announce.js: Points-tab card lists every item incl. dismissed/expired with its state; dismissed ids persist', () => {
  const restored = [];
  const c = AN.announcementsCard(h, { items }, { now: NOW, dismissed: ['i-old'], onRestore: (id) => restored.push(id) });
  assert.equal(find(c, (e) => /annitem/.test(e.attrs.class || '')).length, 6);
  const t = text(c);
  assert.match(t, /dismissed/); assert.match(t, /deadline passed/); assert.match(t, /expired/); assert.match(t, /showing in the banner/);
  find(c, (e) => e.tag === 'button' && /annrestore/.test(e.attrs.class))[0].attrs.onclick();
  assert.deepEqual(restored, ['i-old']);
  assert.match(text(AN.announcementsCard(h, null, { now: NOW })), /No airdrop or TGE news yet/);
  const mem = new Map(), store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.deepEqual(AN.loadDismissed(store), []);
  AN.saveDismissed(['a', 'b', 'a'], store);
  assert.deepEqual(AN.loadDismissed(store), ['a', 'b']);
  mem.set(AN.DISMISS_KEY, 'garbage'); assert.deepEqual(AN.loadDismissed(store), []);
});
