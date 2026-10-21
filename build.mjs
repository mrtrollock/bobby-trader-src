// One-shot build: bundles src/app.js (+ noble/msgpack) and inlines JS/CSS into dist/index.html with a hash-based CSP.
// Plain browser / PWA build (no Telegram). Output dist/ is a static site (GitHub Pages ready).
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const out = await build({ entryPoints: ['src/app.js'], bundle: true, format: 'iife', target: ['es2020'], minify: true, write: false, legalComments: 'none' });
let js = out.outputFiles[0].text;
if (/<\/script/i.test(js)) js = js.replace(/<\/script/gi, '<\\/script');
const css = readFileSync('src/style.css', 'utf8');
const pre = 'window.__LAUNCH_URL=location.href;';
const sha = (s) => "'sha256-" + createHash('sha256').update(s, 'utf8').digest('base64') + "'";
// 'self' = the encrypted *.enc.json data next to the page. Every other host is a read/trade API; nothing else can be contacted.
const CONNECT = ["'self'", 'https://api.arcus.xyz', 'https://api.hyperliquid.xyz', 'https://rpc.txflow.com',
  'https://api.testnet.arcus.xyz', 'https://api.hyperliquid-testnet.xyz', 'https://rpc.txflow-testnet.xyz',
  'wss://mds.qfex.com', 'wss://mds.qfex.io']; // QFEX: public market data only (no REST: no CORS; no trade socket: no key in the browser)
const csp = [
  "default-src 'none'",
  `script-src ${sha(pre)} ${sha(js)}`,
  `style-src ${sha(css)}`,
  `connect-src ${CONNECT.join(' ')}`,
  "img-src 'self' data:", "font-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-src 'none'", "worker-src 'none'", "manifest-src 'self'",
].join('; ');
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0f1115">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icon-192.png">
<link rel="apple-touch-icon" href="icon-180.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Bobby">
<title>Bobby Trade</title>
<style>${css}</style>
<script>${pre}</script>
</head><body><div id="app"></div>
<script>${js}</script>
</body></html>
`;
rmSync('dist', { recursive: true, force: true }); // never ship stale files
mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', html);
// static assets (manifest, icons, robots.txt, *.enc.json, .nojekyll) are copied as-is next to index.html
if (existsSync('public')) cpSync('public', 'dist', { recursive: true });
// Privacy guard: the site is public, so every data file must be an encrypted envelope (*.enc.json). Refuse anything else.
const ENVELOPE = ['v', 'alg', 'kdf', 'it', 'aad', 'salt', 'iv', 'ct'];
for (const f of readdirSync('dist', { recursive: true }).map(String)) {
  if (!/\.json$/i.test(f) || f === 'manifest.webmanifest') continue;
  if (!/\.enc\.json$/.test(f)) throw new Error(`refusing to build: plaintext data file dist/${f} (publish only *.enc.json)`);
  const o = JSON.parse(readFileSync('dist/' + f, 'utf8'));
  if (Object.keys(o).sort().join() !== [...ENVELOPE].sort().join() || o.alg !== 'AES-256-GCM') throw new Error(`refusing to build: dist/${f} is not an encrypted envelope`);
}
console.log('dist/index.html', html.length, 'bytes');
