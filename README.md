# Bobby Trader

A Telegram Mini App that turns AI-written trade proposals into **PIN-approved orders, signed on the user's phone**, on
[Arcus](https://docs.arcus.xyz) and on Hyperliquid, including HIP-3 dexes such as **Entropy** (`io:` markets).

The AI assistant never holds trading keys and never places orders. It can only *propose*. The human reviews each
proposal in the Mini App, the app re-checks it against live market data, and only a PIN unlock on the phone can sign and
send it.

Built with **Grok Bot**. The app UI is in French.

## How it works

```
 AI assistant ──► make_proposal.py ──► unsigned link     #p=v1.<base64url json>.<sha256[:16]>
                         │
                 send_batch.py ──► Telegram: one message per platform, numbered buttons
                                          │
                                    user taps a button
                                          ▼
                Telegram Mini App (single static file, strict CSP)
                  1. decode + validate proposal (corruption check)
                  2. live check: mark, size rounding, margin, fees, liquidation,
                     loss at SL / gain at TP incl. fees, max leverage, expiry, drift
                  3. user approves → PIN → keys decrypted in memory → sign → send
                     straight from the phone to Arcus / Hyperliquid
                                          │
                 send_batch.py check ──► reads public account state, ticks ✅ per trade,
                                         edits the message to "✅ all executed"
```

### Key handling
- Keys are typed once into the Mini App and stored **only on the device**, encrypted with the user's PIN
  (PBKDF2-SHA256, 600k iterations → AES-256-GCM, WebCrypto). Auto-lock after inactivity.
- Arcus: Ed25519 API signing key. Hyperliquid: an *API/agent wallet* key (trade-only, cannot withdraw).
- The page is one static `index.html` with JS/CSS inlined and a hash-based Content-Security-Policy:
  `connect-src` is limited to the Arcus and Hyperliquid APIs, so the code cannot talk to anything else.
- Default mode is **DRY RUN**: it signs and shows the payload but sends nothing. A testnet toggle is available.

### Risk checks (`src/risk.js`)
Before approval the app shows notional, margin, fees, an isolated-margin liquidation estimate, and the **loss at
stop-loss including fees on both sides**. Hard blocks: leverage above the market max, SL/TP on the wrong side.
Red warnings (need a second confirmation): SL loss over the configured limit, liquidation before the SL, expired
proposal, price moved more than 1% since the proposal, margin above free collateral. For TP/SL updates on an
open position, the side check is against the *mark*, so a stop moved past entry to lock in profit is accepted, and
the locked gain is shown.

### Arcus TP/SL replacement (`src/replace.js`)
Arcus allows one position-level TP and one SL per market (`POSITION_TPSL_ALREADY_EXISTS`) and cannot modify TP/SL
legs. A `tpsl` proposal therefore replaces them in a single approval:
cancel the position-level legs → wait until they are gone → place the new position TP/SL (re-signed, retried on
`ALREADY_EXISTS`) → verify it is live → only then cancel entry-linked legs of the replaced type. The leg you did not
change is carried over. If placement fails, the result screen raises a 🚨 alert when the position is left without a
stop and offers a one-tap "restore previous TP/SL".

### Batched Telegram proposals (`send_batch.py`)
One message per platform (🏹 Arcus / 🤖 Entropy / 🤖 Hyperliquid), numbered trades, one Mini App button per trade.
Execution is detected **without a server**: `check` compares each proposal with the live public account state
against a baseline taken at send time (position moved, resting order at the price, TP/SL triggers present, order
gone). Each line gets a ✅ when executed and ⌛ when expired; when a whole message is done it is edited to a green
✅ header and its buttons are removed.

```
python3 send_batch.py send trades.json [--dry]
python3 send_batch.py check [--watch 3600 --every 60]
python3 send_batch.py status | done <id> | test [--dry]
```
Configuration comes from environment variables only (see `.env.example`). Local state goes in `batches.json`
(git-ignored, chmod 600).

### Proposal format (v1)
`id, pf (arcus|hl), m, act (open|tpsl|cancel), sd (long|short), sz, lev, et (market|limit), px, ref, sl, tp, exp, n`.
HL markets: `BTC` (main dex) or `io:ANTH` (HIP-3 dex). Arcus markets: `TSLA-USD`. The hash only detects
corruption. It is not a security boundary; the security boundary is the human approval plus the PIN.

## Layout
| Path | What |
|---|---|
| `src/app.js` | Mini App UI (views, approval flow, settings, journal) |
| `src/arcus.js`, `src/hl.js` | Request builders + signers (Ed25519 for Arcus, EIP-712 L1 actions for Hyperliquid) |
| `src/risk.js` | Pre-trade risk math |
| `src/replace.js` | Arcus TP/SL replace state machine |
| `src/proposal.js`, `src/keystore.js` | Proposal codec, PIN-encrypted keystore |
| `src/dec.js`, `src/canon.js`, `src/api.js` | Decimal snapping, canonical JSON, read endpoints |
| `build.mjs` | esbuild bundle → single `dist/index.html` with hash-based CSP |
| `make_proposal.py`, `send_batch.py` | Proposal links and batched Telegram messages |
| `reference/arcus.py` | Minimal Python Arcus client, used as the reference signer in parity tests |
| `tests/` | Node test suite + Python reference scripts + headless e2e |

## Tests
```bash
npm ci
python3 -m venv venv && venv/bin/pip install -r requirements-dev.txt
npm test          # 31 tests
npm run e2e       # optional: headless Chrome, testnet + dry run (needs /usr/bin/google-chrome)
```
- **Parity**: Arcus requests are byte-identical to `reference/arcus.py`, and Hyperliquid signatures, action hashes
  and order wires are byte-identical to the official `hyperliquid-python-sdk` (randomised cases, throwaway keys).
- **Risk math**, **proposal codec + keystore**, **TP/SL replace** (simulated matching engine with async cancels,
  transient errors, hard failures), and **batch messaging** (Telegram mocked, offline).
- **e2e**: drives the built app in headless Chrome with throwaway keys on testnet in dry-run mode; every
  mutating endpoint is also blocked at the network layer.

Test child processes run with every `*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASS*` env var stripped, so a real key can
never leak into a test.

## Disclaimer
MIT licensed (see `LICENSE`). Personal project, not financial advice. Trading perpetuals with leverage can lose more than you expect. Use dry run
and testnet first.
