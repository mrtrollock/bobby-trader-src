import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cleanEnv } from './helpers.mjs';

test('briefing.py: equity change vs last night, SL in profit / distance, triggers, duplicate+stray SL, US hours, no address (offline)', () => {
  const r = spawnSync('python3', [new URL('./py_briefing.py', import.meta.url).pathname], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), { ok: true });
});
