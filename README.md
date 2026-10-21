# Bobby Trader

A small **web app (PWA, add to home screen)** that turns AI-written trade proposals into **PIN-approved orders, signed on
the user's own device**, on [Arcus](https://docs.arcus.xyz) and on Hyperliquid, including HIP-3 dexes such as
**Entropy** (`io:` markets), plus a **TxFlow manual mode** (no signing: the order is placed in app.txflow.com and
checked from public data), plus **QFEX** (equity/index/commodity perps) through the headless autotrader: the app checks a
QFEX proposal against the policy with live public prices and hands it to the autotrader queue (no QFEX key in the browser).
Works the same on a computer and a phone. The app UI is in English.

The AI assistant never holds trading keys and never places orders. It can only *propose*. The human reviews each
proposal in the app, the app re-checks it against live market data and the risk policy, and only a PIN unlock on the
device can sign and send it.

Built with **Grok Bot**.

## Privacy: what is public and what is not

- **The code is public** (this repo is a fork of a public repo, and GitHub Pages serves the built app). It contains no
  key, no secret, no account id, no wallet address and no balance: keys live only on the user's device (PIN-encrypted)
  or in `~/.bobby-autotrader.env` on the box (chmod 600, outside the repo); addresses go in the git-ignored `.env`.
- **The whole app is behind a passphrase.** On load it shows only a lock screen; nothing else renders until the
  passphrase decrypts the data. Every published data file is an encrypted envelope `*.enc.json`
  (`briefing.enc.json`, `proposals.enc.json`, `balances.enc.json`): AES-256-GCM, key = PBKDF2-SHA256(passphrase,
  random 16-byte salt, 600,000 iterations), random 12-byte IV. Without `BOBBY_VIEW_PASSPHRASE`, `briefing.py`,
  `send_batch.py`, `balances.py` and `tools/publish.sh` **refuse to write/publish**; `build.mjs` refuses to build if any
  plaintext `.json` data file would land in `dist/`. "Remember on this device" stores the passphrase encrypted with a
  PIN (same PBKDF2/AES-GCM scheme as the key store); the 🔒 Lock button clears it from memory.
- Not indexed: `<meta name="robots" content="noindex">` and `robots.txt` (`Disallow: /`). The page itself (code, no
  data) is still reachable by anyone with the URL; it just shows the lock screen.
- Git history: the plaintext `public/briefing.json` / `public/proposals.json` were only ever committed empty
  (`{"platforms": []}` / no batches) and are no longer tracked.

## How it works

```
 AI assistant ──► send_batch.py send trades.json ──► public/proposals.enc.json  (encrypted inbox, next to index.html)
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
                 send_batch.py check ──► reads public account state, marks each trade done / expired in the inbox
```

### Briefing (📰 first tab)

`briefing.py` writes `public/briefing.enc.json` (encrypted), which the Briefing tab renders per platform (🏹 ARCUS, 🤖 ENTROPY, 🌊 TxFLOW):
equity with % change since last night, positions kept / nothing triggered, US market hours for stock/ETF underlyings,
one bullet per position (uPnL + comment) and an optional "One detail:" note (duplicate SL, stray SL/TP, missing SL).

```bash
cp .env.example .env              # fill in PUBLIC addresses only
python3 briefing.py --snapshot-only   # cron at ~22:00 Europe/Berlin: the "last night" baseline
python3 briefing.py [--comments my_comments.json]   # morning: write public/briefing.enc.json (+ a new snapshot)
tools/publish.sh briefing      # = refresh + encrypt + commit only that file + push fork web-app (~1 min)
```

Only public read endpoints are used, nothing is signed. Snapshots stay local in `snapshots.json` (git-ignored).
The JSON never contains an address (the script refuses to write if it would), and it is encrypted with
`BOBBY_VIEW_PASSPHRASE` before it is written (equity, positions, PnL and SL/TP levels are only readable after unlocking). Comments file: `{"arcus": {"detail": "...", "positions": {"TSLA": "I'm holding, ..."}}}`
(keys arcus | entropy | txflow); a human comment replaces the generated one. Offline demo:
`python3 briefing.py --mock tests/fixtures/briefing_mock.json --snapshots /tmp/s.json --out /tmp/b.enc.json`.

### Balances (💰 tab, `balances.py`)

Per platform (Arcus, Entropy, TxFlow, QFEX) + total: starting balance, current balance, net deposits/withdrawals since
the start, PnL $ and % (PnL = current − start − net deposits), plus a snapshot history (Berlin time) with a sparkline.

```bash
tools/publish.sh               # one command: refresh balances, encrypt, commit ONLY public/balances.enc.json, push fork web-app
tools/publish.sh all           # balances + briefing (+ the inbox)
```
- Readers (read-only): Arcus `/v1/account` (`BOBBY_ACCOUNT_ADDRESS`), Entropy/Hyperliquid `clearinghouseState` on
  `BOBBY_HL_DEXES` (`BOBBY_HL_ADDRESS`), TxFlow `clearinghouseState` (`BOBBY_TXFLOW_ADDRESS`), QFEX through the
  autotrader key. A platform without an address/key shows "not connected yet".
- Ledger `balances_ledger.json` (git-ignored, chmod 600): the first reading becomes the start, every run adds a snapshot.
- Deposits: QFEX from the account `deposit` field; Hyperliquid from `userNonFundingLedgerUpdates` (best effort);
  Arcus/TxFlow do not expose them publicly → add them in `balances_start.json` (git-ignored):
  `{"arcus": {"start": 300, "netDeposits": 50}}` (`start` replaces the recorded one, `netDeposits` is added).


### Autotrader (Arcus + Entropy + QFEX, headless)

`autotrader/` runs fully automatic, policy-gated maker trades on Arcus, Entropy (Hyperliquid dex `io`) and QFEX from
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
- `connect-src` is limited to `'self'` (the encrypted `*.enc.json` data) and the Arcus / Hyperliquid / TxFlow APIs, plus the public QFEX
  market-data WebSocket (`wss://mds.qfex.com`, `wss://mds.qfex.io`).

### QFEX (`src/qfex.js`, see [autotrader/README.md](autotrader/README.md#qfex))
- The app card (pf `qfex`, entries only) reads mark + best bid/ask from the public MDS WebSocket, prices fees from the
  published Tier-5 schedule (stop leg = taker + slippage) and runs the hard policy. A compliant proposal shows a
  `queue.json` entry for the autotrader, which re-checks everything with the private account data and sends it.
- `briefing.py` shows a QFEX card when the autotrader key is in the environment (`node autotrader/cli.js status --pf qfex`),
  or a "needs a QFEX API key" card with `BOBBY_QFEX=1`.
- Tests: `node --test tests/qfex.test.mjs`, `npm run e2e:qfex` (mock WebSocket), `npm run smoke:qfex` (public UAT data),
  `npm run e2e:qfex-app` (headless Chrome, public data only).
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
python3 send_batch.py send trades.json [--dry]     # writes public/proposals.enc.json, encrypted (+ dist/ if built)
python3 send_batch.py check [--watch 3600 --every 60]
python3 send_batch.py status | done <id> | test [--dry]
```
No token or secret: only public addresses (`.env.example`). Baselines stay in `batches.json` (git-ignored, chmod 600).
On GitHub Pages, publishing new proposals = `tools/publish.sh inbox` (commits only `public/proposals.enc.json`).

### Proposal format (v1)
`id, pf (arcus|hl|txflow|qfex), m, act (open|tpsl|cancel; qfex: open only), sd (long|short), sz, lev, et (market|limit), px, ref, sl, tp, exp, n`.
HL markets: `BTC` (main dex) or `io:ANTH` (HIP-3 dex). Arcus markets: `TSLA-USD`. TxFlow: `BTC-USDC`. QFEX: `US100-USD`, `GOLD-USD`. The hash only
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
| `build.mjs` | esbuild bundle → `dist/index.html` with hash-based CSP, + `public/` (manifest, icons, robots.txt, `*.enc.json`); refuses plaintext data |
| `make_proposal.py`, `send_batch.py` | Proposal links and the encrypted proposals inbox (`public/proposals.enc.json`) |
| `balances.py`, `tools/publish.sh` | Balances/PnL ledger and the one-command encrypted publish |
| `src/vault.js`, `vaultpy.py` | Passphrase vault (same envelope in the browser and in Python) |
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
