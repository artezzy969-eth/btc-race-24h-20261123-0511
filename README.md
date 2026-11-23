[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/artezzy969-eth/btc-race-24h-20261123-0511/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/artezzy969-eth/btc-race-24h-20261123-0511/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

# Dip-and-Ride — a cbBTC mean-reversion bot

A bot for the make.fun competition `btc-race-24h-20261123-0511`: it trades
Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute on-chain bars, starting
from 1,000 USDC of paper money, long only, no leverage.

## Strategy

1-minute mean reversion on BTC is a losing game if you scalp it: a full-size
round trip costs ~26 bps (4 bps fee + 2 bps slippage + price impact each way),
while a typical 1-minute dip is only ~10-20 bps deep. So this bot buys one
dip early and rides the trend instead of trading every wiggle:

- **Mean and bands.** Fast EMA (15 bars) of closes; band width is the
  population standard deviation of the last 15 closes. `z = (close - EMA15) / std`.
- **Entry.** `z < +0.5` while the close is above the slow EMA (30 bars): price
  has pulled back to or below its fast mean inside an uptrend. The first
  tranche spends 80% of cash. If the dip deepens to `z < -2.0`, a second
  tranche spends 90% of the remaining cash.
- **Exit (whole position).** Take-profit +5% over cost, stop-loss -3% under
  cost, or 1,440 bars held. A 10-bar cooldown follows every exit.
- **Downtrend guard.** The uptrend filter is relaxed after bar 720 only if the
  bot has made no trade yet, so a flat or falling window still produces its
  one trade instead of sitting in cash all day.

Deterministic: no clock, no randomness, no network, no files outside the repo.
All money math is bigint micro-USDC through the vendored SDK; indicators run
in float64 on closes only.

## Parameters

| Parameter | Value |
|---|---|
| Fast (mid) EMA | 15 bars |
| Slow EMA (trend filter) | 30 bars |
| Std-dev lookback | 15 bars |
| Entry z | < +0.5 |
| Scale-in z | < -2.0 |
| First tranche | 80% of cash |
| Scale-in tranche | 90% of remaining cash |
| Take-profit | +5% over cost |
| Stop-loss | -3% under cost |
| Max hold | 1,440 bars |
| Exit cooldown | 10 bars |
| Trend-filter relax | bar 720, only if no trade yet |
| Max slippage | 100 bps |

## Local dev grade (kit replay, `grade-local --driver process`)

- **Net PnL: +34.151 USDC** (return +3.42%)
- Trades: 2 (one entry + one scale-in; the position is flattened at the end)
- Win rate: 1.0, max drawdown: 1.94%, Sharpe (per bar): 0.03
- Fees: 0.798 USDC; net PnL at 2x fees: +33.341 USDC
- Guardrails: met (≥1 trade, drawdown ≤25%)
- Two executions reproduced byte for byte (L1 regrade).

The dev window itself rises +3.64%, so the best baseline (buy-and-hold,
+34.9 USDC) is the number to beat; this bot lands just under it by buying the
first dip (bar 45) instead of the first bar. The sweep behind the parameters:
tight take-profits (0.2-0.9%) lost money — 200 round trips bled fees — and a
give-back exit (sell after giving back 2 points of a 3%+ gain) was tried and
removed after local grading showed it cost ~$8.60 by selling into a normal
late-window pullback and re-buying higher. The chosen set sits on a plateau:
mid EMA 10-15, slow EMA 30, lookback 10-20 and entry z 0.5 all give the same
single early trade and the same PnL, and the 5% take-profit / 3% stop-loss
never fire on the dev window — they are race-window exits, not dev tuning.

## Layout

- `main.ts` — the bot (Node 22, erasable TypeScript, stdlib only).
- `vendor/makefun-bars.ts` — byte copy of the kit SDK shim.
- `LICENSE` — MIT.

## Run

Grade locally with the competition kit:

```
node cli/makefun.mjs grade-local --kit <kit-dir> --bot <this-repo> --driver process
```
