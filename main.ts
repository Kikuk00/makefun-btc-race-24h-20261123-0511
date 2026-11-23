// Staged Trend Rider — a cbBTC (CBBTC/USDC) trading bot for agent-fun/bars-replay/v1.
//
// Strategy (long only, $1,000 paper, one position, no leverage, no shorts):
//   - Stage 1 (half size): buy 50% of cash when the 15-bar return tops +30 bps
//     AND EMA(8) is above EMA(21) — short-term momentum with a trend filter.
//   - Mean-reversion guards on every stage-1 entry: RSI(14) must be at or below
//     70 (never chase an overbought spike) and the close must sit no more than
//     200 bps above EMA(21) (never buy a vertical extension).
//   - Stage 2 (top-up to full size): when holding stage 1 and the 60-bar return
//     tops +75 bps with EMA(8) still above EMA(21), spend the remaining cash.
//     A real move gets full size; a false start stays half size.
//   - Exit: a 300 bps trailing stop from the highest close since entry sells the
//     whole position. Winners run, losers are cut at roughly 3% from the peak.
//   - Drawdown brake: if equity falls 8% below its peak, sell everything and
//     stop new entries for 240 bars. The 25% guardrail is never approached.
//   - Discipline: no new entries in the last 60 bars (nothing bought that late
//     has time to outrun its round-trip cost), and a 30-bar cooldown after any
//     stop-out so a falling knife is never re-bought on the next bar.
//   - Every order caps slippage at 100 bps from the latest close.
//
// Costs are the reason for the shape: a full-size round trip pays ~26-34 bps
// (4 bps fee + 2 bps slippage each way, plus constant-product impact against a
// ~$0.6-0.9M pool). One-minute noise is ~8 bps, so the bot only trades moves
// big enough to clear that bar, holds them while they run, and otherwise sits
// in cash. On the 24 h dev window it makes 2 trades (buy, top-up) and holds.
//
// Deterministic: float64 indicators only (EMA seeded as the mean of its first
// span of closes, RSI(14) as the simple mean of the last 14 up/down changes),
// no clock, no environment, no randomness, no network. The same bars always
// give the same orders. A bar the harness skips (a gap) adds nothing to any
// indicator, exactly like the kit baselines.
//
// The closes window is kept at 61 bars: the longest lookback (60, the top-up
// confirmation) plus the current bar, so every indicator read stays in range.
//
// Node 22, standard library only (node:readline via the vendored shim).

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// --- tuned parameters (see README for the backtest behind each) ---
const STAGE1_FRACTION_NUM = 1n; // stage 1 buys 1/2 of cash
const STAGE1_FRACTION_DEN = 2n;
const ENTRY_LOOKBACK = 15; // bars for the entry momentum read
const ENTRY_MIN_BPS = 30; // 15-bar return must top +30 bps
const CONFIRM_LOOKBACK = 60; // bars for the top-up confirmation read
const CONFIRM_MIN_BPS = 75; // 60-bar return must top +75 bps
const FAST_SPAN = 8; // EMA spans
const SLOW_SPAN = 21;
const RSI_SPAN = 14; // RSI lookback (simple mean of up/down changes)
const RSI_CAP = 70; // mean-reversion guard: never enter overbought
const EXTENSION_CAP_BPS = 200; // mean-reversion guard: never buy >2% above EMA(21)
const TRAIL_STOP_BPS = 300; // trailing stop from the peak close since entry
const DD_BRAKE = 0.08; // 8% equity drawdown: flatten + halt entries
const DD_HALT_BARS = 240; // bars the drawdown brake halts new entries for
const COOLDOWN_BARS = 30; // bars after a stop-out before a new entry
const LATE_CUTOFF_BARS = 1380; // no new entries once this many bars are seen
const MAX_SLIPPAGE_BPS = 100; // 1% past the close the order was decided on
const CLOSES_KEPT = 61; // closes window: longest lookback (60) + current bar

interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

interface Series {
  closes: number[]; // every close seen, oldest first (trimmed to 61)
  fast: Ema;
  slow: Ema;
  /** Bars of this symbol seen so far. */
  seen: number;
  /** Highest close since the current entry (stage 1 or 2). */
  peak: number | null;
  /** 0 = flat, 1 = holding stage 1, 2 = holding stage 1 + top-up. */
  stage: number;
  /** Bars left of the post-stop-out cooldown. */
  cool: number;
  /** Bars-seen count until which new entries are halted (drawdown brake). */
  haltUntil: number;
}

const series = new Map<string, Series>();

function newSeries(): Series {
  return {
    closes: [],
    fast: { span: FAST_SPAN, warm: [], value: null },
    slow: { span: SLOW_SPAN, warm: [], value: null },
    seen: 0,
    peak: null,
    stage: 0,
    cool: 0,
    haltUntil: -1,
  };
}

function emaStep(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

function push(bar: Bar): Series {
  let s = series.get(bar.symbol);
  if (s === undefined) series.set(bar.symbol, (s = newSeries()));
  const c = Number(bar.c);
  s.closes.push(c);
  if (s.closes.length > CLOSES_KEPT) s.closes.shift();
  emaStep(s.fast, c);
  emaStep(s.slow, c);
  s.seen++;
  return s;
}

/** Return in bps of the close against the close `back` bars ago, or null. */
function retBps(s: Series, back: number): number | null {
  if (s.closes.length <= back) return null;
  const c = s.closes[s.closes.length - 1]!;
  const prev = s.closes[s.closes.length - 1 - back]!;
  return ((c - prev) * 10000) / prev;
}

/** RSI(14): simple mean of the last 14 up moves over the mean up + down. */
function rsi(s: Series): number | null {
  if (s.closes.length < RSI_SPAN + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let j = s.closes.length - RSI_SPAN; j < s.closes.length; j++) {
    const ch = s.closes[j]! - s.closes[j - 1]!;
    if (ch > 0) gain += ch;
    else loss += -ch;
  }
  gain /= RSI_SPAN;
  loss /= RSI_SPAN;
  const moved = gain + loss;
  return moved === 0 ? 50 : (100 * gain) / moved;
}

/** Peak equity the bot has seen (cash + positions at latest closes). */
let peakEquity: bigint | null = null;

await runBars({
  onBatch(state: BarsState, batch) {
    // Track the equity peak every batch (the drawdown brake's reference).
    if (peakEquity === null || state.equity > peakEquity) peakEquity = state.equity;

    const fresh = new Set<string>();
    for (const bar of batch.bars) {
      push(bar);
      fresh.add(bar.symbol);
    }
    if (state.warmingUp) return [];

    const { caps, fees } = state.hello;
    const orders: (SellInput | BuyInput)[] = [];

    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      const s = series.get(symbol)!;
      const c = s.closes[s.closes.length - 1]!;
      if (s.cool > 0) s.cool--;
      const held = state.positions.get(symbol);

      // --- drawdown brake: flatten and halt entries for a while ---
      if (
        held !== undefined &&
        peakEquity !== null &&
        Number(state.equity) < Number(peakEquity) * (1 - DD_BRAKE)
      ) {
        s.stage = 0;
        s.haltUntil = s.seen + DD_HALT_BARS;
        orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        continue;
      }

      if (held !== undefined) {
        // --- holding: top-up on confirmation, else trail the stop ---
        if (s.peak === null || c > s.peak) s.peak = c;
        if (s.stage === 1) {
          const confirm = retBps(s, CONFIRM_LOOKBACK);
          if (
            confirm !== null &&
            confirm > CONFIRM_MIN_BPS &&
            s.fast.value !== null &&
            s.slow.value !== null &&
            s.fast.value > s.slow.value
          ) {
            const topUp = state.cash;
            if (topUp >= BigInt(fees.min_notional_quote_units)) {
              s.stage = 2;
              orders.push({ side: 'buy', symbol, notional_quote_units: topUp, max_slippage_bps: MAX_SLIPPAGE_BPS });
              continue;
            }
          }
        }
        if (s.peak !== null && (s.peak - c) * 10000 > TRAIL_STOP_BPS * s.peak) {
          s.stage = 0;
          s.cool = COOLDOWN_BARS;
          orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
        continue;
      }

      // --- flat: stage-1 entry, behind every guard ---
      if (s.seen > LATE_CUTOFF_BARS) continue;
      if (s.cool > 0) continue;
      if (s.seen < s.haltUntil) continue;
      const entry = retBps(s, ENTRY_LOOKBACK);
      if (entry === null || entry <= ENTRY_MIN_BPS) continue;
      if (s.fast.value === null || s.slow.value === null || s.fast.value <= s.slow.value) continue;
      const r = rsi(s);
      if (r !== null && r > RSI_CAP) continue; // overbought: do not chase
      if (s.slow.value !== null && (c - s.slow.value) * 10000 > EXTENSION_CAP_BPS * s.slow.value) continue; // extended: do not chase
      const notional = (state.cash * STAGE1_FRACTION_NUM) / STAGE1_FRACTION_DEN;
      if (notional < BigInt(fees.min_notional_quote_units)) continue;
      s.peak = c;
      s.stage = 1;
      orders.push({ side: 'buy', symbol, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS });
    }

    return orders.slice(0, caps.max_orders_per_bar);
  },
});
