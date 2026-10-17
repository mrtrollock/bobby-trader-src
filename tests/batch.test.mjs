import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cleanEnv } from './helpers.mjs';

test('send_batch.py: one message per platform, live-state detection, ✅ edit (offline, Telegram mocked)', () => {
  const r = spawnSync('python3', [new URL('./py_batch.py', import.meta.url).pathname], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim()), { ok: true });
});
