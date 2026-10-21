# Bobby Trader

A small **web app (PWA, add to home screen)** that turns AI-written trade proposals into **PIN-approved orders, signed on
the user's own device**, on [Arcus](https://docs.arcus.xyz) and on Hyperliquid, including HIP-3 dexes such as
**Entropy** (`io:` markets), plus a **TxFlow manual mode** (no signing: the order is placed in app.txflow.com and
checked from public data). Works the same on a computer and a phone. The app UI is in English.

The AI assistant never holds trading keys and never places orders. It can only *propose*. The human reviews each
proposal in the app, the app re-checks it against live market data and the risk policy, and only a PIN unlock on the
device can sign and send it.

Built with **Grok Bot**.

## How it works

```
 AI assistant ──► send_batch.py send trades.json ──► public/proposals.json  (inbox, served next to index.html)
                                                               │
                                     user opens 📥 Proposals in the web app, taps "Open"
                                                               ▼
                Web app (single static index.html, strict hash-based CSP, no Telegram)
                  1. decode + validate proposal (corruption check)
                  2. live check: mark, size rounding, margin, LIVE fees, liquidation, loss at SL incl. fees,
                     max leverage, expiry, drift + RISK POLICY (hard blocks, see below)
                  3. user approves → PIN → keys decrypted in memory → sign → send
                     straight from the device to Arcus / Hyperliquid          (TxFlow: manual card + public check)
                                                               │
                 send_batch.py check ──► reads public account state, marks each trade done / expired in proposals.json
```

### Briefing (📰 first tab)

`briefing.py` writes `public/briefing.json`, which the Briefing tab renders per platform (🏹 ARCUS, 🤖 ENTROPY, 🌊 TxFLOW):
equity with % change since last night, positions kept / nothing triggered, US market hours for stock/ETF underlyings,
one bullet per position (uPnL + comment) and an optional "One detail:" note (duplicate SL, stray SL/TP, missing SL).

```bash
cp .env.example .env              # fill in PUBLIC addresses only
python3 briefing.py --snapshot-only   # cron at ~22:00 Europe/Berlin: the "last night" baseline
python3 briefing.py [--comments my_comments.json]   # morning: write public/briefing.json (+ a new snapshot)
git add public/briefing.json && git commit -m briefing && git push fork web-app   # publishes in ~1 min
```

Only public read endpoints are used, nothing is signed. Snapshots stay local in `snapshots.json` (git-ignored).
The JSON never contains an address (the script refuses to write if it would), **but equity, positions, PnL and SL/TP
levels become public at the site URL**. Comments file: `{"arcus": {"detail": "...", "positions": {"TSLA": "I'm holding, ..."}}}`
(keys arcus | entropy | txflow); a human comment replaces the generated one. Offline demo:
`python3 briefing.py --mock tests/fixtures/briefing_mock.json --snapshots /tmp/s.json --out /tmp/b.json`.

### Autotrader (Arcus + Entropy, headless)

`autotrader/` runs fully automatic, policy-gated maker trades on Arcus and Entropy (Hyperliquid dex `io`) from
`autotrader/queue.json`, with the same signing and risk code as the app. Dry run and kill switch by default;
see [autotrader/README.md](autotrader/README.md). TxFlow stays manual.

### Risk policy (`src/risk.js` `POLICY`, editable in Settings) — hard blocks, the approve button stays disabled
- **Maker only**: new positions must be **post-only limit** entries (Arcus `ALO`, Hyperliquid / TxFlow `Alo`); a limit
  that would cross the book is blocked. Market entries are refused (closing a position stays possible).
- **Max leverage 1×** (isolated).
- **Stop-loss mandatory** on every new position.
- **Max loss at stop per trade = 1 % of platform capital** (default capital $300 per platform → **$3**), fees included
  (maker fee on the entry leg, taker fee on the stop).
- **Weekly loss cap $50 per platform** (week = Monday 00:00 UTC). Used = realized PnL net of fees this week, read from
  public fills (Arcus `/v1/fills`, Hyperliquid `userFillsByTime`, TxFlow `userFills`); if fills cannot be read, the
  local journal's SL risk is used and a warning is shown. A trade that could cross the cap is blocked.
- **Margin above free collateral** is blocked.
- **No deposit / withdraw churn, no vault**: fund-moving and vault actions (`withdraw*`, `usdSend`, `tokenSend`,
  `vaultTransfer`, …, Arcus `/v1/withdraw`) are refused by every signer path, and `vaultAddress` is never used.
- `send_batch.py` refuses non-compliant proposals at publish time too.

### Live fees (`src/fees.js`)
Arcus: per-market maker/taker ppm from `/v1/markets`, less the referral discount from `/v1/account/stats?include=feeTier`
(`/v1/feetiers` as second source). Hyperliquid main dex: `userFees` (`userAddRate` / `userCrossRate`). TxFlow: `userFees`.
HIP-3 dexes (Entropy) set their own fees: the configured fallback is used. Hardcoded values are the last fallback.

### Key handling
- Keys are typed once in the app and stored **only on the device**, encrypted with the PIN
  (PBKDF2-SHA256, 600k iterations → AES-256-GCM, WebCrypto) in this origin's IndexedDB. Auto-lock after inactivity.
- Arcus: Ed25519 API signing key (trade-only when created through the public `createApiKey`). Hyperliquid: an
  *API/agent wallet* key (trade-only, cannot withdraw). TxFlow: **no key at all** (manual mode).
- `connect-src` is limited to `'self'` (proposals.json) and the Arcus / Hyperliquid / TxFlow APIs.
- Default mode is **DRY RUN**: it signs and shows the payload but sends nothing. A testnet toggle is available.

### TxFlow (`src/txflow.js`)
- **Manual mode (default)**: the proposal card lists market, side, post-only limit, size, leverage, SL/TP, expiry and
  opens app.txflow.com; "Check execution" reads `clearinghouseState` + `frontendOpenOrders` (public `POST /info`)
  and flags a position without a stop. The dashboard shows the points-epoch activity (Mon→Mon UTC): fills, volume, fees,
  active days, maker share (`userFills`, `tradeSide`).
- **Agent signing stub, feature-flagged OFF** (`TXFLOW_AGENT_ENABLED = false`): post-only order builder, agent EIP-712
  signing and the one-time `approveAgent` typed data (agent name `bobby`, to be signed by the user's own wallet).
  Reproduces the test vectors published on docs.txflow.com/api/signing. Needs the mainnet `/exchange` whitelist.

### Proposals inbox (`send_batch.py`)
```
python3 send_batch.py send trades.json [--dry]     # writes public/proposals.json (+ dist/ if built)
python3 send_batch.py check [--watch 3600 --every 60]
python3 send_batch.py status | done <id> | test [--dry]
```
No token or secret: only public addresses (`.env.example`). Baselines stay in `batches.json` (git-ignored, chmod 600).
On GitHub Pages, publishing new proposals = commit + push `public/proposals.json` (and rebuild/deploy `dist/`).

### Proposal format (v1)
`id, pf (arcus|hl|txflow), m, act (open|tpsl|cancel), sd (long|short), sz, lev, et (market|limit), px, ref, sl, tp, exp, n`.
HL markets: `BTC` (main dex) or `io:ANTH` (HIP-3 dex). Arcus markets: `TSLA-USD`. TxFlow: `BTC-USDC`. The hash only
detects corruption. It is not a security boundary; the security boundary is the human approval plus the PIN.

## Layout
| Path | What |
|---|---|
| `src/app.js` | Web app UI (inbox, dashboard, approval flow, TxFlow manual card, settings, journal) |
| `src/arcus.js`, `src/hl.js` | Request builders + signers (Ed25519 for Arcus, EIP-712 L1 actions for Hyperliquid) |
| `src/risk.js` | Pre-trade risk math + risk POLICY + trade-only guard |
| `src/fees.js` | Live fee readers with fallbacks |
| `src/txflow.js` | TxFlow public reads, manual execution check, agent-signing stub (flag off) |
| `src/replace.js` | Arcus TP/SL replace state machine |
| `src/proposal.js`, `src/keystore.js` | Proposal codec, PIN-encrypted keystore |
| `src/dec.js`, `src/canon.js`, `src/api.js` | Decimal snapping, canonical JSON, read endpoints |
| `build.mjs` | esbuild bundle → `dist/index.html` with hash-based CSP, + `public/` (manifest, icons, proposals.json) |
| `make_proposal.py`, `send_batch.py` | Proposal links and the proposals inbox (`public/proposals.json`) |
| `reference/arcus.py` | Minimal Python Arcus client, used as the reference signer in parity tests |
| `tests/` | Node test suite + Python reference scripts + headless e2e |

## Tests
```bash
npm ci
python3 -m venv venv && venv/bin/pip install -r requirements-dev.txt
npm test          # 50 tests
npm run e2e       # optional: headless Chrome, TESTNET + dry run (needs /usr/bin/google-chrome)
```
- **Parity**: Arcus requests are byte-identical to `reference/arcus.py`, Hyperliquid signatures/hashes/wires to the
  official `hyperliquid-python-sdk`, TxFlow signing to the vectors published in the TxFlow docs.
- **Risk policy** (maker-only, 1×, mandatory SL, 1 % per trade, weekly cap, Monday-UTC week, realized loss, trade-only
  guard, post-only builders), **risk math**, **proposal codec + keystore**, **TP/SL replace**, **fees parsing**,
  **TxFlow reads / epoch activity / execution check**, **inbox publisher** (offline).
- **e2e**: drives the built app in headless Chrome on testnet in dry-run mode; every mutating endpoint and every
  mainnet host is blocked at the network layer.

Test child processes run with every `*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASS*` env var stripped, so a real key can
never leak into a test.

## Preview locally / publish
```bash
npm run serve      # builds, then serves dist/ on http://127.0.0.1:8080
```
GitHub Pages: publish the `dist/` folder (e.g. a Pages workflow uploading `dist/`, or a `gh-pages` branch with its
contents). `.nojekyll` is included. Serve over HTTPS only (WebCrypto + PWA install need a secure context).

## Disclaimer
MIT licensed (see `LICENSE`). Personal project, not financial advice. Trading perpetuals with leverage can lose more than you expect. Use dry run
and testnet first.
