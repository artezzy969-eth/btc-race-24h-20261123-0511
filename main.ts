// Dip-and-ride: a volatility-aware mean-reversion bot for cbBTC/USDC, long only.
//
// Idea
// ----
// On a 1-minute chart BTC's dips are noisy, but its trend is real: the dev window
// rises +3.6% while 1-minute returns scatter ~8 bps. Chasing every dip with a
// tight take-profit loses to the ~26 bps round-trip cost (4 bps fee + 2 bps
// slippage + price impact each way), so this bot does the opposite of scalping:
// it buys ONE dip early, sizes in if the dip deepens, and then rides the trend,
// exiting only on a real gain, a real loss, or the window ending.
//
//   - Mean: a fast EMA (15 bars) of closes. Band width: the population
//     standard deviation of the last 15 closes. z = (close - fast EMA) / std.
//   - Entry: z below +0.5 while the close sits above the slow EMA (30 bars),
//     i.e. price has pulled back to or below its fast mean inside an uptrend.
//     First tranche spends 80% of cash; if the dip deepens to z below -2.0 a
//     second tranche spends 90% of what cash is left.
//   - Exit (whole position): +5% over cost (take-profit), -3% under cost
//     (stop-loss), or 1,440 bars held (the whole window). A 10-bar cooldown after an exit stops an instant re-buy at the same price.
//   - Downtrend guard: the uptrend filter is only relaxed after bar 720 when
//     the bot has still made no trade, so a flat or falling window still gets
//     its one trade instead of sitting in cash all day.
//
// Everything is deterministic: no clock, no randomness, no network, no files.
// All money math is bigint quote units (micro-USDC) through the SDK; the
// indicators run in float64 on closes only, which is exactly reproducible.
//
// Parameters were swept on the dev window with the kit replay. The short
// lookbacks (15/30) matter: they let the first entry fire around bar 44,
// before the trend runs away. The result is a plateau, not a peak: the same
// single early trade and the same net PnL show up for mid EMA 10-15, slow EMA
// 30, lookback 10-20 and entry z 0.5, and a 5% take-profit / 3% stop-loss
// never fire on the dev window -- they are race-window exits, not dev tuning.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- tuned parameters (dev-window sweep; see README) ---
const MID_EMA_BARS = 15; // fast mean for the z-score
const SLOW_EMA_BARS = 30; // trend filter
const STD_BARS = 15; // band-width lookback
const ENTRY_Z = 0.5; // enter when z < +0.5 (close at/below the fast mean)
const SCALE_Z = -2.0; // scale in when the dip deepens past -2 sigma
const FIRST_TRANCHE_BPS = 8000; // 80% of cash on the first buy
const SCALE_TRANCHE_BPS = 9000; // 90% of remaining cash on the scale-in
const TAKE_PROFIT_BPS = 500; // +5% over cost
const STOP_LOSS_BPS = 300; // -3% under cost
const MAX_HOLD_BARS = 1440; // give up after a full window (never on dev)
const COOLDOWN_BARS = 10; // bars to wait after an exit before re-entering
const TREND_RELAX_BAR = 720; // drop the uptrend filter after this bar if no trade yet
const MAX_SLIPPAGE_BPS = 100; // 1% past the close the order was decided on

interface Track {
  closes: number[];
  emaMid: number | null;
  emaSlow: number | null;
}

const track: Track = { closes: [], emaMid: null, emaSlow: null };
let holdSince = -1;
let tranches = 0;
let lastExitBar = -1_000_000;
let tradesMade = 0;

function push(bar: Bar): void {
  const c = Number(bar.c);
  track.closes.push(c);
  if (track.closes.length > STD_BARS) track.closes.shift();
  const kMid = 2 / (MID_EMA_BARS + 1);
  const kSlow = 2 / (SLOW_EMA_BARS + 1);
  track.emaMid = track.emaMid === null ? c : track.emaMid + kMid * (c - track.emaMid);
  track.emaSlow = track.emaSlow === null ? c : track.emaSlow + kSlow * (c - track.emaSlow);
}

/** z-score of the latest close against the fast EMA, scaled by the band width. */
function zScore(): number | null {
  if (track.closes.length < STD_BARS || track.emaMid === null) return null;
  const mean = track.closes.reduce((a, x) => a + x, 0) / STD_BARS;
  const variance = track.closes.reduce((a, x) => a + (x - mean) * (x - mean), 0) / STD_BARS;
  const sd = Math.sqrt(variance);
  const last = track.closes[track.closes.length - 1]!;
  if (sd === 0) return 0;
  return (last - track.emaMid) / sd;
}

/** Whether the held position exits on this close: TP, SL, or max hold. */
function shouldExit(state: BarsState, held: { qty: bigint; cost: bigint }): boolean {
  const value = state.value(SYMBOL, held.qty);
  if (value === 0n || held.cost === 0n) return false;
  // value >= cost * (1 + TP)  <=>  value * 10000 >= cost * (10000 + TP)
  if (value * BPS >= held.cost * (BPS + BigInt(TAKE_PROFIT_BPS))) return true;
  // value <= cost * (1 - SL)
  if (value * BPS <= held.cost * (BPS - BigInt(STOP_LOSS_BPS))) return true;
  if (holdSince >= 0 && state.seq - holdSince >= MAX_HOLD_BARS) return true;
  return false;
}

await runBars({
  onBatch(state, batch) {
    for (const bar of batch.bars) push(bar);
    if (state.warmingUp) return [];
    const fresh = batch.bars.some((b) => b.symbol === SYMBOL);
    if (!fresh) return [];

    const { caps, fees } = state.hello;
    const minNotional = BigInt(fees.min_notional_quote_units);
    const close = state.close(SYMBOL);
    const z = zScore();
    if (close === null || z === null || track.emaSlow === null) return [];

    const orders: (SellInput | BuyInput)[] = [];
    const held = state.positions.get(SYMBOL);

    // --- exits first: sells never fund a buy in the same reply ---
    if (held !== undefined && held.qty > 0n) {
      if (shouldExit(state, held)) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        lastExitBar = state.seq;
        holdSince = -1;
        tranches = 0;
        tradesMade += 1;
        return orders;
      }
      // Scale in while the dip deepens and we still hold cash.
      if (tranches === 1 && z < SCALE_Z && state.cash > minNotional) {
        const spend = (state.cash * BigInt(SCALE_TRANCHE_BPS)) / BPS;
        if (spend >= minNotional) {
          orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS });
          tranches = 2;
          tradesMade += 1;
        }
      }
      return orders;
    }

    // --- entries: flat, past cooldown, pullback inside an uptrend ---
    if (state.seq - lastExitBar < COOLDOWN_BARS) return [];
    const trendOk = close > BigInt(Math.floor(track.emaSlow));
    const trendRelaxed = tradesMade === 0 && state.seq >= TREND_RELAX_BAR;
    if (z < ENTRY_Z && (trendOk || trendRelaxed)) {
      let spend = (state.cash * BigInt(FIRST_TRANCHE_BPS)) / BPS;
      const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
      if (spend > byWeight) spend = byWeight;
      if (spend > state.cash) spend = state.cash;
      if (spend >= minNotional && spend > 0n) {
        orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS });
        holdSince = state.seq;
        tranches = 1;
        tradesMade += 1;
      }
    }
    return orders.slice(0, caps.max_orders_per_bar);
  },
});
