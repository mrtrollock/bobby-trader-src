// One-shot build: bundles src/app.js (+ noble/msgpack) and inlines JS/CSS into dist/index.html with a hash-based CSP.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const out = await build({ entryPoints: ['src/app.js'], bundle: true, format: 'iife', target: ['es2020'], minify: true, write: false, legalComments: 'none' });
let js = out.outputFiles[0].text;
if (/<\/script/i.test(js)) js = js.replace(/<\/script/gi, '<\\/script');
const css = readFileSync('src/style.css', 'utf8');
const pre = 'window.__LAUNCH_URL=location.href;';
const sha = (s) => "'sha256-" + createHash('sha256').update(s, 'utf8').digest('base64') + "'";
const CONNECT = ['https://api.arcus.xyz', 'https://api.hyperliquid.xyz', 'https://api.testnet.arcus.xyz', 'https://api.hyperliquid-testnet.xyz'];
const csp = [
  "default-src 'none'",
  `script-src ${sha(pre)} ${sha(js)} https://telegram.org`,
  `style-src ${sha(css)}`,
  `connect-src ${CONNECT.join(' ')}`,
  "img-src 'self' data:", "font-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-src 'none'", "worker-src 'none'", "manifest-src 'self'",
].join('; ');
const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0f1115">
<title>Bobby Trade</title>
<style>${css}</style>
<script>${pre}</script>
<script src="https://telegram.org/js/telegram-web-app.js?59"></script>
</head><body><div id="app"></div>
<script>${js}</script>
</body></html>
`;
mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', html);
console.log('dist/index.html', html.length, 'bytes');
