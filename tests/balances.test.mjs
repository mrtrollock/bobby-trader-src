import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanEnv } from './helpers.mjs';
import { sealJson, openJson } from '../src/vault.js';

const ROOT = new URL('..', import.meta.url).pathname;
test('balances.py: start = first reading, deposits, overrides, PnL, encrypted output, refuses without passphrase (offline)', () => {
  const r = spawnSync('python3', [join(ROOT, 'tests/py_balances.py')], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout.trim().split('\n').pop()).ok, true);
});
test('vault: Python seals -> browser code opens, browser seals -> Python opens; wrong passphrase fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vault-')), pass = 'compat-pass-123';
  const py = (code) => spawnSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(ROOT)}); import vaultpy, json\n${code}`],
    { encoding: 'utf8', env: { ...cleanEnv(), BOBBY_VIEW_PASSPHRASE: pass } });
  let r = py(`vaultpy.write_sealed(${JSON.stringify(join(dir, 'a.enc.json'))}, {"x": 1.5, "s": "é"})`);
  assert.equal(r.status, 0, r.stderr);
  const env = JSON.parse(readFileSync(join(dir, 'a.enc.json'), 'utf8'));
  assert.deepEqual(Object.keys(env).sort(), ['aad', 'alg', 'ct', 'it', 'iv', 'kdf', 'salt', 'v']);
  assert.equal(env.it, 600000);
  assert.deepEqual(await openJson(env, pass), { x: 1.5, s: 'é' });
  await assert.rejects(openJson(env, 'not-the-pass'), /Wrong passphrase/);
  await assert.rejects(openJson({ ...env, it: 1000 }, pass), /iterations too low/);
  writeFileSync(join(dir, 'b.enc.json'), JSON.stringify(await sealJson({ y: [1, 2] }, pass)));
  r = py(`print(json.dumps(vaultpy.read_sealed(${JSON.stringify(join(dir, 'b.enc.json'))})))`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { y: [1, 2] });
  r = py(`vaultpy.write_sealed(${JSON.stringify(join(dir, 'plain.json'))}, {})`);
  assert.notEqual(r.status, 0);
});
test('flows.py + positions.py + Arcus deposits: all-time deposits, attribution, Bobby status, re-base (offline)', () => {
  const r = spawnSync('python3', [join(ROOT, 'tests/py_positions.py')], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout.trim().split('\n').pop()).ok, true);
});
