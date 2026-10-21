# Bobby autotrader (Arcus + Entropy + QFEX, headless)

Fully automatic, policy-gated **maker** trading on **Arcus**, **Entropy** (Hyperliquid HIP-3 dex `io`) and **QFEX**
(equity/index/commodity perps, `src/qfex.js`).
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
  * QFEX: see [QFEX](#qfex) — `QFEX_KEY_SINGLE_ACCOUNT_ACK=1` is mandatory; the cross-account listing
    `GET /user/subaccounts/balance` must answer **403** (single-account key; a 200 means "All accounts", the only scope
    that can hold `deposit_withdraw`, and is refused); a random foreign account id must be refused; the trade socket must
    authenticate and its balance snapshot `id` must be `QFEX_ACCOUNT_ID`; the account must not be the primary account
    (referrals `self.user_id`, see QFEX below).
* **Never moves funds.** withdraw / transfer / vault actions are refused by `assertTradeOnly` in the shared signers
  and network layer (`src/risk.js`), and no code path builds them. QFEX: `assertQfexRest` only allows a handful of GET
  reads + `POST /user/leverage` on `api.qfex.*` (the funding host `banker.qfex.*` is never contacted), and
  `assertQfexMessage` only allows auth/subscribe/reads, ALO+GTC entries carrying SL **and** TP, cancel by order id,
  `close_position`, and `cancel_on_disconnect:false`.
* Keys are read **only from the environment**, never written to disk, and redacted from logs and the journal.

## Hard policy (every rule rejects; rejections are logged with reasons)
post-only entry (Arcus `ALO`, Hyperliquid `Alo`, QFEX `ALO`) at a limit that does not cross the mark (QFEX: nor the best bid/ask) · 1× isolated ·
SL **and** TP attached to the entry (Arcus `entryTpsl`, HL `normalTpsl`) · loss at SL incl. fees ≤ **1 % of live
platform equity** · weekly realized loss < **$50 per platform** (Mon 00:00 UTC, from public fills; also blocks a trade
whose SL could cross the cap) · margin ≤ free collateral · max **3** concurrent positions/resting entries per platform,
one per market · drift between `ref` and live mark ≤ 1 % · not expired · Entropy markets must be on dex `io` · TxFlow refused.
QFEX: leverage is set to 1× with `POST /user/leverage` before every entry (the entry is not sent unless the API answers
`leverage: 1`); the SL loss assumes the stop fills as a **taker** plus slippage (see [QFEX](#qfex)).
All `computeRisk` warnings (SL past liquidation, etc.) are hard blocks here too.

## Queue (`autotrader/queue.json`, written by the AI, git-ignored)
JSON array (or `{"proposals": [...]}`), see `queue.example.json`. Fields (short or long names):
`id`, `platform|pf` (`arcus` | `entropy` | `qfex`), `market|m` (`TSLA-USD`, `io:ANTH`, `US100-USD`), `side|sd` (`long|short`),
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
node autotrader/cli.js cancel <arcus|entropy|qfex> <market> <orderId>   # refuses to cancel the only SL (QFEX: any SL/TP)
node autotrader/cli.js close  <arcus|entropy|qfex> <market>             # reduce-only IOC close (QFEX: close_position)
npm run e2e:qfex      # offline QFEX dry run over a local mock WebSocket (no network, no order)
npm run smoke:qfex    # public UAT market data (refdata + mark/BBO), no key
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
| `QFEX_API_PUBLIC_KEY` | QFEX API public key (key scoped to ONE subaccount, Execute orders + View only) |
| `QFEX_API_SECRET_KEY` | QFEX API secret key (HMAC-SHA256; never leaves the box, never in the browser) |
| `QFEX_ACCOUNT_ID` | UUID of the subaccount the key is scoped to (required if the key sees more than one account) |
| `QFEX_KEY_SINGLE_ACCOUNT_ACK` | must be `1`: you confirm the key is single-account, withdraw unticked, created in Developer Settings |
| optional | `AUTOTRADER_HL_DEXES` (default `io`), `AUTOTRADER_INTERVAL_S` (60), `AUTOTRADER_MAX_POSITIONS` (3), `AUTOTRADER_QUEUE` |
| `QFEX_WEEKLY_LOSS_CAP_USD` | QFEX weekly realized-loss cap in $ (default **30**, max 50) |
| `QFEX_MAX_TRADE_LOSS_USD` | QFEX max loss at SL per trade in $, fees + stop slippage included (default **3**, ≤ weekly cap) |
| optional QFEX | `QFEX_CATEGORIES` (default `INDEX,COMMODITY,EQUITY`; FX is always refused), `QFEX_SL_SLIPPAGE` (fraction, overrides the per-category default), `QFEX_ALLOW_MAIN_ACCOUNT` (`1` to allow the main account; not recommended) |

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

## Protection guard (every tick, Arcus / Entropy / QFEX)
`once` (and therefore every `loop` tick) first checks **every open position** for a live stop-loss **and** take-profit:
* Unprotected on two consecutive ticks **and** longer than the grace period (QFEX 120 s: it stages the stops right after
  the fill; Arcus/Entropy 60 s) → attach the missing leg(s) **reduce-only at the original planned level** from the decision
  journal (`plan`, or the QFEX entry echo). QFEX: `add_order` `STOP_LOSS`/`TAKE_PROFIT` sized to the position; Arcus:
  `positionTpsl`; Entropy: `positionTpsl` trigger orders.
* No planned level, price already past it, attaching rejected, or the attached stop did not show up next tick →
  **close the position** reduce-only (QFEX `close_position`, Arcus/Entropy reduce-only IOC).
* Every action is logged, journaled (`decision: guard`) and appended to **`autotrader/ALERT`** (JSON lines, git-ignored);
  `balances.py` publishes the count + latest alerts (encrypted) and the Balances tab shows them in red.
* Dry run / kill switch: nothing is sent, the guard logs `ALERT ... would ...` and writes one alert per position.
* While an entry rests (or a position is in its grace period) the loop re-checks every 20 s instead of every interval.
* QFEX trade socket dropped: the stops live on the exchange; each read re-opens the socket (3 attempts). If positions/stops
  cannot be read the guard reports `unknown` (never closes on missing data) and alerts after 5 minutes.
* `node autotrader/cli.js guard` = read-only check (prints the decision per position, sends nothing, writes no alert).

## QFEX
QFEX (https://qfex.com, docs https://docs.qfex.com) is an off-chain CLOB for perps on US stocks, indices, commodities.
Collateral is USDC (deposits on Arbitrum One). `AUTOTRADER_NETWORK=testnet` uses UAT (`api.qfex.io`, `wss://trade.qfex.io`,
`wss://mds.qfex.io`); `mainnet` uses `api.qfex.com`, `wss://trade.qfex.com`, `wss://mds.qfex.com`.

* **Auth**: HMAC-SHA256 of `"<nonce>:<unix_ts>"` with the secret key; REST headers `x-qfex-public-key`,
  `x-qfex-hmac-signature`, `x-qfex-nonce`, `x-qfex-timestamp` (+ `x-qfex-requested-account-id`); WebSocket `auth`
  message with the same HMAC (+ `account_id`). No builder code, no wallet (SIWE) sign-in, no JWT is ever used.
* **Main vs subaccount**: the trade socket's balance `user_id` equals the account id even on a subaccount, so it is not
  a main-account signal. `GET /user/referrals/notional-volume` (user-level) has a `relationship:"self"` row whose
  `user_id` is the login user = primary account id and whose `account_ids` lists all your accounts: `QFEX_ACCOUNT_ID` must
  be in that list and differ from that `user_id`. Without that row the ack decides.
* **Reads** (all work with a single-account key): `/user/positions` (balance: equity = deposit + realised + unrealised +
  funding, capped by the latest `/user/account-equity` point; free = `available_balance`), `/user/trade` (weekly realized loss =
  `realised_pnl_change − fee`, conservative), `/user/fees`, public `/refdata`; mark price + best bid/ask from the MDS
  WebSocket; open orders (`get_user_orders`) and stop orders (`stop_orders` subscription) from the trade WebSocket.
* **Entry** (in this order, stops at the first failure): `POST /user/leverage {symbol, leverage:1}` → must answer `1`;
  `cancel_on_disconnect:false` (the resting entry and its stops must survive the bot disconnecting); `add_order` with
  `order_type:"ALO"`, `order_time_in_force:"GTC"`, `stop_loss` **and** `take_profit`. The `order_response` must be `ACK`
  and echo non-zero `stop_loss`/`take_profit`, otherwise the entry is cancelled immediately. A timeout is reported as
  "state unknown" and never retried automatically (run `status`).
* **Rounding**: size down to `lot_size`; prices to `tick_size` in the safe direction (entry more passive, SL and TP
  closer to the entry); the entry must lie inside the refdata price band; `min_quantity` enforced; market must be `ACTIVE`
  and accept `ALO`.
* **Fees / risk**: live `GET /user/fees` when sane, else the Tier-5 schedule (maker 0.02 % index/commodity, 0.05 % stocks;
  taker 0.05 % / 0.10 %). QFEX TP/SL fire as **market** orders on the mark, so the loss at SL = price move + maker entry fee
  + stop leg at `max(taker, floor) + slippage` with floor 0.10 % stocks / 0.05 % index+commodity and default slippage
  0.10 % stocks / 0.05 % index+commodity (`QFEX_SL_SLIPPAGE`). **QFEX limits differ from Arcus/Entropy**: the total must
  be ≤ `QFEX_MAX_TRADE_LOSS_USD` ($3), never more than 5 % of live equity and never more than what is left of the weekly
  budget; weekly cap `QFEX_WEEKLY_LOSS_CAP_USD` ($30, Mon 00:00 UTC). Arcus/Entropy keep 1 % of equity and $50/week.
  **Prefer INDEX and COMMODITY markets** (half the fees): e.g. `US100-USD`, `US500-USD`, `GOLD-USD`, `SILVER-USD`,
  `CL-USD`, `NATGAS-USD`, `COPPER-USD`, `NIKKEI-USD`, `KOSPI-USD`, `HSI-USD`. FX is refused (no published fee row).
  `QFEX_CATEGORIES=INDEX,COMMODITY` blocks single stocks entirely. Note `min_quantity` (US100: 0.001 ≈ $30).
* **Cancel/close**: only resting entries can be cancelled by the bot; QFEX stop orders (SL/TP) are **never** cancelled or
  modified (there is no stop-order cancel path in the code); `close` uses `close_position` (the engine sends an IOC on the
  opposite side sized to the position, so it can only reduce).
* **Stops unknown**: QFEX has no "list stop orders" request; they are read from the `stop_orders` subscription. If a
  position exists and no stop can be read, new entries are refused and `status` reports `stopsKnown:false`.
* **Confirmed with one live mainnet trade (2026-10-21, GOLD-USD long 0.001, ALO GTC, 1×)**: `POST /user/leverage` answers
  `{leverage: 1}` and `get_user_leverage` reads 1×; the `add_order` reply is `order_response` status `ACK` and **echoes
  `stop_loss` / `take_profit`**; the entry rests (`all_orders_response`), then `order_response` `FILLED` + `fill_response`.
  The SL/TP stop orders are created **only when the entry fills** (none while it rests): `stop_order_response` with
  `stop_order_type` `STOPLOSS` / `TAKEPROFIT` (re-sent about every second), and they also appear in `get_user_orders` as
  `type` `STOP_LOSS` / `TAKE_PROFIT`, `reduce_only: true`, `order_origin: STOP_ORDER` (merged into one row per id).
  `client_order_id` must be 1–36 characters (the bot's ids are ≤ 36). `GET /user/trade` `fee` is the **rate**
  (dollar fee = rate × price × qty). The bot therefore checks the echo at placement; `status` shows `protected` per position.

### QFEX key: one subaccount, Execute + View only
1. Create a QFEX account with a **separate email / fresh wallet** — never the TxFlow/main wallet. Complete KYC/T&Cs if asked
   and enable 2FA.
2. Deposit USDC on **Arbitrum One** to the address shown in the QFEX UI (deposits land in the main account).
3. Create a **subaccount** (e.g. `bobby`) and transfer ~$300 to it in the UI. Copy its account UUID.
4. Developer Settings → *Generate public and secret API keys* → name `bobby-autotrader`, **Account access: that specific
   subaccount** (not "All accounts"), permissions **Execute orders, View orders, View positions, View balance** only —
   *Deposit and withdraw* unticked (QFEX forces it off for single-account keys anyway). Copy both keys (shown once).
5. Put `QFEX_API_PUBLIC_KEY`, `QFEX_API_SECRET_KEY`, `QFEX_ACCOUNT_ID` and `QFEX_KEY_SINGLE_ACCOUNT_ACK=1` in the
   chmod 600 env file outside the repo, then `node autotrader/cli.js verify` and a dry-run `once`.

Never create keys through "builder wallet registration" / wallet sign-in: those keys are main-account keys that can withdraw
to registered addresses. The bot refuses the main (primary) account for that reason. QFEX cannot report a key's
permissions, so withdraw capability is not directly detectable; what is enforced: the ack, single-account scope (a key that
can read another of your accounts is refused), subaccount only, and a code path that cannot reach any funding endpoint.
