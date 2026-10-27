- 2026-10-26 (t89u): User: QFEX needs >= $100k TAKER volume/week (resets Mon 00:00 UTC). Bot is maker-first (ALO); only STOP_MARKET fills are taker. Week Oct 26: $6.6k total / ~$1.07k taker. Since Oct 21: $30.0k / ~$4.0k taker.

- 2026-10-27 (t89s491 confirm): Official sources — $100k/week is Loss Refunds (TAKER ONLY), not published Season 0 points rules.
  Exact Loss Refunds wording (qfex.com/lossback): "$100K minimum reward-period taker notional"; "Trade at least $100,000 in notional taker volume during the reward period to qualify."
  Rewards Hub (qfex.com/rewards-hub): "A minimum of $100,000 in taker volume during the reward period is required to qualify." Current period shown: 26 Oct 00:00 – 2 Nov 00:00 UTC; register each week.
  @QFEX X (2026-10-06): "Trade at least $100K in taker notional during the campaign" + register Rewards Hub + link X; finish with realized loss; 20% of eligible losers refunded up to $2k; "Eligibility and a loss do not entitle any user to a refund."
  Other eligibility: link X, verification, deposit ≥$100, first trade before period closes, realized PnL loss (unrealized doesn't count; realized profits offset losses). Re-register each week.
  Season 0 (@annanay 2026-10-07): "will recognize early trading activity, product feedback, and community engagement" only — no $100k, no maker/taker, no points dashboard in docs.qfex.com.
  Fee tiers (docs.qfex.com/qfex/fees): trailing 30d Effective Volume = total traded (not taker-only; weighted 2× commodities/indices, 5× single stocks).
  Invitation initial grant (changelog 14 Oct 2026): $100k all-time personal trading volume (incl. subaccounts) — lifetime, not weekly, not stated as taker-only.
  Conclusion: confirmed TAKER-ONLY for Loss Refunds $100k/week. Season 0 volume mechanics still unpublished. No trading settings changed.
  Links: https://www.qfex.com/lossback | https://www.qfex.com/rewards-hub | https://x.com/QFEX/status/2107488551466049701 | https://x.com/annanay/status/2107780122258366667 | https://docs.qfex.com/qfex/fees

- 2026-10-27 (t90u): User asked "can we go for 100k taker vol/week". Plan drafted for approval; NO trading settings changed.
  Live account fees (GET /user/fees): CL taker 0.6bps / maker 0; US100/US500/SILVER/NATGAS/COPPER taker 5bps / maker 2bps.
  This week (26 Oct–): ~$10.6k total / ~$1.54k taker (fee-rate heuristic); ~5.4d left to 2 Nov 00:00 UTC → ~$18k taker/day needed.
  $30 weekly / ~$12 daily caps cannot survive a US100-path taker sprint (~$50 fees alone on $100k); CL-only might fit ~$6 fees + spread if cap raised.
  No QFEX taker/IOC volume mode in Bobby yet (maker ALO only). Recommend start next Mon period after code + cap approval; keep Season 0 maker in parallel.

- 2026-10-27 (t90s507 approved): Build QFEX taker volume mode NOW; START live taker only Mon 2 Nov 2026 00:00 UTC (next Loss Refunds period). Keep Season 0 maker until then.
  Caps for taker: weekly $75–$100 (default env QFEX_VOL_TAKER_WEEKLY_LOSS_CAP_USD=85), daily ~$30–$40 (default 40% of weekly → $34). Auto-halt at cap.
  Style: QFEX_VOL_STYLE=maker|taker (or QFEX_VOL_TAKER=1). Default remains maker. Hard arm: QFEX_VOL_TAKER_ARM_UTC (default 2026-11-02T00:00:00.000Z) — live taker sends blocked before that even if style=taker.
  Sprint: LIMIT IOC entry through touch → immediate close_position (IOC flatten). Prefer CL (0.6bps); avoid US100/US500. Notional $800–$2k (QFEX_VOL_TAKER_NOTIONAL_USD). One market at a time. Hard SL still attached. STP via exchange + no resting maker book from this mode.
  Target: ≥$100k TAKER notional per Mon–Mon UTC Loss Refunds period (QFEX_VOL_TAKER_TARGET_USD=100000). volumeStats now splits makerVolume/takerVolume from fill order_type.
  Enable on Nov 2 (after 00:00 UTC) in ~/.bobby-autotrader.env, then restart the loop:
    QFEX_VOL_STYLE=taker
    # optional aliases / overrides (defaults already match the plan):
    # QFEX_VOL_TAKER_ARM_UTC=2026-11-02T00:00:00.000Z
    # QFEX_VOL_TAKER_WEEKLY_LOSS_CAP_USD=85
    # QFEX_VOL_TAKER_DAILY_LOSS_CAP_USD=34
    # QFEX_VOL_TAKER_NOTIONAL_USD=800-2000
    # QFEX_VOL_TAKER_MAX_MARKETS=1
    # QFEX_VOL_TAKER_MARKETS=CL-USD
    # QFEX_VOL_PREFER=CL-USD
    # QFEX_VOL_AVOID=US100-USD,US500-USD
  Taker uses QFEX_VOL_TAKER_* caps (default weekly 85 / daily 34); maker still uses QFEX_WEEKLY_LOSS_CAP_USD. Live sends also hard-blocked until arm UTC even if style is flipped early. Do NOT flip style before Mon 2 Nov 00:00 UTC.

