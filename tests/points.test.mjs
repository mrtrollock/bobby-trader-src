import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { cleanEnv } from './helpers.mjs';
import { fmtCountdown, target, liveWindow, targetLabel, kusd } from '../src/points.js';

const ROOT = new URL('..', import.meta.url).pathname;
test('points.py: schedules (UTC/ET DST), per-week aggregation, ledger, manual entries, TxFlow positions/flows, encrypted output (offline)', () => {
  const r = spawnSync('python3', [join(ROOT, 'tests/py_points.py')], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout.trim().split('\n').pop()).ok, true);
});
test('points.js: countdown format, target = next drop else window end, rolls over when the data is stale', () => {
  assert.equal(fmtCountdown(0), 'now');
  assert.equal(fmtCountdown(59), '00:00:59');
  assert.equal(fmtCountdown(2 * 86400 + 3 * 3600 + 4 * 60 + 5), '2d 03:04:05');
  const W = 7 * 86400, s0 = 1792000000;
  const mk = (i, drop) => ({ n: i + 1, label: 'Week ' + (i + 1), start: s0 + i * W, end: s0 + (i + 1) * W, drop: drop ? s0 + (i + 1) * W + 86400 : null });
  const v = { kind: 'points', window: mk(0, true), upcoming: [0, 1, 2].map((i) => mk(i, true)), endsBy: s0 + 10 * W };
  assert.deepEqual(target(v, s0 + 10), { t: s0 + W + 86400, kind: 'drop' });
  // after the first window ended but before its drop: still counts down to that drop
  assert.deepEqual(target(v, s0 + W + 10), { t: s0 + W + 86400, kind: 'drop' });
  // after the drop: next one, and the live window moved on although the published one is old
  assert.deepEqual(target(v, s0 + W + 86400 + 1), { t: s0 + 2 * W + 86400, kind: 'drop' });
  assert.equal(liveWindow(v, s0 + W + 5).n, 2);
  // no drop published (TxFlow / QFEX / Entropy): end of the live window
  const t = { kind: 'points', window: mk(0, false), upcoming: [0, 1].map((i) => mk(i, false)) };
  assert.deepEqual(target(t, s0 + 5), { t: s0 + W, kind: 'end' });
  assert.equal(targetLabel(t, 'end'), 'Epoch ends');
  assert.equal(targetLabel({ kind: 'rebates' }, 'end'), 'Tracking week ends');
  // the public API's next drop wins when ahead
  assert.deepEqual(target({ ...v, apiNextDrop: s0 + 999 }, s0 + 10), { t: s0 + 999, kind: 'drop' });
  // no drops beyond the program end
  assert.deepEqual(target({ ...v, endsBy: s0 }, s0 + 10), { t: s0 + W, kind: 'end' });
  assert.equal(kusd(71500), '$71.5K'); assert.equal(kusd(1250000), '$1.25M'); assert.equal(kusd(null), '—');
});

import { pointsText, lastDropped } from '../src/points.js';
test('points.js: points earned cells (auto / manual tag, pending, not entered yet, rebates)', () => {
  const now = 1792600000, P = { kind: 'points' };
  assert.equal(pointsText({ points: 1234.56, pointsSrc: 'manual' }, P, now), '1,234.56 · ✍ manual');
  assert.equal(pointsText({ points: 7, pointsSrc: 'auto' }, P, now), '7 · auto');
  assert.equal(pointsText({ points: 0, pointsSrc: 'manual' }, P, now), '0 · ✍ manual'); // an entered 0 stays 0
  assert.equal(pointsText({ pointsState: 'missing' }, P, now), 'not entered yet');
  assert.match(pointsText({ current: true, pointsState: 'pending', drop: now + 3600 }, P, now), /^pending \(drop \w{3} \d+ \w{3}, \d\d:\d\d\)$/);
  assert.equal(pointsText({ current: true, pointsState: 'pending', drop: null }, P, now), 'pending');
  assert.equal(pointsText({ current: true, pointsState: 'pending' }, { kind: 'not announced' }, now), 'no drop announced');
  assert.equal(pointsText({ points: null }, { kind: 'rebates' }, now), 'rebates, not points');
  assert.equal(pointsText({ rebates: 2.5, rebatesSrc: 'manual' }, { kind: 'rebates' }, now), '$2.50 · ✍ manual rebates');
  assert.equal(lastDropped({ history: [{ current: true }, { current: false, label: 'Week 2' }] }).label, 'Week 2');
});
test('points.js: Extended (ended program) has no countdown; small Variational values keep their decimals', () => {
  assert.equal(target({ kind: 'ended', window: { start: 0, end: 1e10, drop: null }, upcoming: [] }, 100), null);
  assert.equal(pointsText({ current: true, pointsState: 'pending' }, { kind: 'ended' }, 100), 'no weekly drops (ended)');
  assert.equal(pointsText({ points: 0.146345, pointsSrc: 'manual' }, { kind: 'points' }, 100), '0.146345 · ✍ manual');
  assert.equal(pointsText({ points: 4064.9, pointsSrc: 'manual' }, { kind: 'points' }, 100), '4,064.9 · ✍ manual');
});
