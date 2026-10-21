# Bobby autotrader (Arcus + Entropy, headless)

Fully automatic, policy-gated **maker** trading on **Arcus** and **Entropy** (Hyperliquid HIP-3 dex `io`).
TxFlow stays manual (web app). Runs on this box with Node 20; reuses the web app's signing (`src/arcus.js`,
`src/hl.js`), policy (`src/risk.js`) and fee (`src/fees.js`) code.

## Safety model
* **Dry run by default.** Orders are only sent with `AUTOTRADER_LIVE=1`.
* **Kill switch.** Nothing is sent while `autotrader/STOP` exists or `AUTOTRADER_ENABLED` is not `1`
  (`touch autotrader/STOP` stops new orders at the next iteration; cancels/closes are gated too).
* **Explicit network.** `AUTOTRADER_NETWORK=testnet|mainnet` is required; there is no default.
* **Startup key checks, abort on any doubt** (`verify`, also on `once`/`loop`/`cancel`/`close`, and every 30 min in `loop`):
  * Arcus: `GET /v1/apiKeys?address=…` must list this key as `ACTIVE`, not expired, scoped to
    `ARCUS_ACCOUNT_INDEX` (or all subaccounts), with **no extra `permissions`** (e.g. `withdraw` ⇒ abort).
  * Hyperliquid: `POST /info {type:"userRole", user:<agent>}` must be `agent` of `HL_ACCOUNT_ADDRESS`;
    the main account key itself is refused.
* **Never moves funds.** withdraw / transfer / vault actions are refused by `assertTradeOnly` in the shared signers
  and network layer (`src/risk.js`), and no code path builds them.
* Keys are read **only from the environment**, never written to disk, and redacted from logs and the journal.

## Hard policy (every rule rejects; rejections are logged with reasons)
post-only entry (Arcus `ALO`, Hyperliquid `Alo`) at a limit that does not cross the mark · 1× isolated ·
SL **and** TP attached to the entry (Arcus `entryTpsl`, HL `normalTpsl`) · loss at SL incl. fees ≤ **1 % of live
platform equity** · weekly realized loss < **$50 per platform** (Mon 00:00 UTC, from public fills; also blocks a trade
whose SL could cross the cap) · margin ≤ free collateral · max **3** concurrent positions/resting entries per platform,
one per market · drift between `ref` and live mark ≤ 1 % · not expired · Entropy markets must be on dex `io` · TxFlow refused.
All `computeRisk` warnings (SL past liquidation, etc.) are hard blocks here too.

## Queue (`autotrader/queue.json`, written by the AI, git-ignored)
JSON array (or `{"proposals": [...]}`), see `queue.example.json`. Fields (short or long names):
`id`, `platform|pf` (`arcus` | `entropy`), `market|m` (`TSLA-USD`, `io:ANTH`), `side|sd` (`long|short`),
`type|et` (`limit`), `price|px`, `size|sz`, `leverage|lev` (1), `stopLoss|sl`, `takeProfit|tp`,
`expiry|exp` (unix s), `refPrice|ref`, `rationale|n`. Each id is processed once per mode (dry/live);
held trades (kill switch) are re-evaluated next run. State: `autotrader/state.json`. Logs: `autotrader/logs/autotrader.log`
and the decision journal `autotrader/logs/journal.jsonl` (both git-ignored).

## Commands
```bash
node autotrader/cli.js verify                    # key checks only
node autotrader/cli.js status [--since UNIX_MS]  # JSON: equity, free, weekly loss, positions + SL/TP, open orders, fills
node autotrader/cli.js once                      # process the queue once
node autotrader/cli.js loop                      # every AUTOTRADER_INTERVAL_S (default 60 s)
node autotrader/cli.js cancel <arcus|entropy> <market> <orderId>   # refuses to cancel the only SL of a position
node autotrader/cli.js close  <arcus|entropy> <market>             # reduce-only IOC close
```
Start in the background (after testing in dry run):
```bash
set -a; . ~/.bobby-autotrader.env; set +a          # chmod 600 file OUTSIDE the repo
nohup node autotrader/cli.js loop >> autotrader/logs/nohup.out 2>&1 &
```

## Environment
| var | meaning |
| --- | --- |
| `AUTOTRADER_NETWORK` | `testnet` or `mainnet` (required) |
| `AUTOTRADER_ENABLED` | `1` to allow sending (otherwise kill switch) |
| `AUTOTRADER_LIVE` | `1` to really send (otherwise dry run) |
| `ARCUS_API_PRIVATE_KEY` | Ed25519 private key, 64 hex, of a **trade-only** Arcus API key |
| `ARCUS_ACCOUNT_ADDRESS` | Arcus owner (master) address |
| `ARCUS_ACCOUNT_INDEX` | subaccount, default 0 |
| `HL_AGENT_PRIVATE_KEY` | Hyperliquid **agent (API) wallet** private key, 0x + 64 hex |
| `HL_ACCOUNT_ADDRESS` | Hyperliquid master account address (the one that holds funds on `io`) |
| optional | `AUTOTRADER_HL_DEXES` (default `io`), `AUTOTRADER_INTERVAL_S` (60), `AUTOTRADER_MAX_POSITIONS` (3), `AUTOTRADER_QUEUE` |

## Creating the keys
* **Arcus trade-only API key** — in the Arcus web app (API keys section) generate and register a key, or generate an
  Ed25519 pair yourself and register it with `POST /v1/createApiKey` signed (EIP-712) by your wallet.
  Keys created this way are always trade-only; the `withdraw` scope only exists via Arcus' operator provisioning.
  Docs: https://docs.arcus.xyz/api-reference/authentication ,
  https://docs.arcus.xyz/api-reference/onboarding/create-api-key , https://docs.arcus.xyz/api-reference/onboarding/get-api-keys
* **Hyperliquid agent wallet (Entropy)** — on https://app.hyperliquid.xyz/API create an API wallet (give it a name,
  e.g. `bobby`), copy its private key, and approve it with your main wallet. Agents can sign orders/cancels for the
  master account on every perp dex (including `io`) but cannot withdraw or transfer. Use a fresh agent per process.
  Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets
