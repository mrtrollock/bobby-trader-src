import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
export const PY = new URL('../venv/bin/python', import.meta.url).pathname;
// Child env WITHOUT any real secret; a throwaway key is injected explicitly.
export function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/KEY|TOKEN|SECRET|PASS/i.test(k)) delete env[k];
  return { ...env, ...extra };
}
export function runPy(script, input, extraEnv = {}) {
  const r = spawnSync(PY, [new URL(script, import.meta.url).pathname], { input: typeof input === "string" ? input : JSON.stringify(input), env: cleanEnv(extraEnv), encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}
export const randHex = (n = 32) => randomBytes(n).toString('hex');
