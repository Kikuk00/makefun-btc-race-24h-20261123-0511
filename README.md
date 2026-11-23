[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/Kikuk00/makefun-btc-race-24h-20261123-0511/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/Kikuk00/makefun-btc-race-24h-20261123-0511/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

# Staged Trend Rider — cbBTC 24h race bot

A long-only cbBTC (CBBTC/USDC) trading bot for the `agent-fun/bars-replay/v1`
harness: it reads one 1-minute bar per batch and answers with buy/sell orders.
Paper money only — nothing is traded for real. Node 22, standard library only,
deterministic: the same bars always give the same orders.

## Strategy

Costs are the whole shape of this bot. A full-size round trip pays ~26–34 bps
(4 bps fee + 2 bps slippage each way, plus constant-product impact against a
~$0.6–0.9M pool), while one-minute noise is ~8 bps. So the bot only trades
moves big enough to clear that bar, sizes into them in stages, and otherwise
sits in cash.

- **Stage 1 (half size):** buy 50% of cash when the 15-bar return tops +30 bps
  and EMA(8) is above EMA(21) — short-term momentum with a trend filter.
- **Mean-reversion guards:** a stage-1 entry also needs RSI(14) at or below 70
  and the close no more than 200 bps above EMA(21). It never chases an
  overbought spike or a vertical extension.
- **Stage 2 (top-up to full size):** while holding stage 1, if the 60-bar
  return tops +75 bps with EMA(8) still above EMA(21), spend the remaining
  cash. A real move gets full size; a false start stays half size.
- **Exit:** a 300 bps trailing stop from the highest close since entry sells
  the whole position. Winners run, losers are cut ~3% from the peak.
- **Drawdown brake:** if equity falls 8% below its peak, sell everything and
  stop new entries for 240 bars. The 25% guardrail is never approached.
- **Discipline:** no new entries in the last 60 bars (nothing bought that late
  has time to outrun its round-trip cost), and a 30-bar cooldown after any
  stop-out so a falling knife is never re-bought on the next bar.
- Every order caps slippage at 100 bps from the latest close.

Indicators are float64 only (EMAs seeded as the mean of their first span of
closes; RSI(14) as the simple mean of the last 14 up/down changes). No clock,
no environment, no randomness, no network. A bar the harness skips (a gap)
adds nothing to any indicator.

## Backtest (dev window, 1,440 bars, official `grade-local`)

| Bot | Net PnL | Trades | Max drawdown | Sharpe |
| --- | --- | --- | --- | --- |
| **Staged Trend Rider (this bot)** | **+$27.90** | **2** | **1.98%** | 0.025 |
| buy-and-hold (house) | +$32.17 | 1 | 1.98% | 0.027 |
| momentum (house) | +$34.94 | 1 | 1.98% | 0.030 |
| ema-cross (house) | −$114.83 | 76 | 11.65% | −0.109 |
| rsi-bollinger (house) | −$9.32 | 10 | 2.06% | −0.016 |
| adx-momentum (house) | −$11.20 | 24 | 4.16% | −0.010 |

Dev gate: **+$27.90 > $0, passes.** Fees paid on dev: $0.81. Two graded runs
produce byte-identical action logs (`action_log_sha256`
`bdc2dd8b666127bca7dfd9e7ad16206ce5e90526ea5b45df56e5f96ff9ba9770`).

Why not plain buy-and-hold, which scores a little higher on this one up day
(+3.64%)? The dev window is a single day. On 300 synthetic 24 h days built by
resampling its hourly blocks (returns mirrored half the time, so expected drift
is ~0), this bot's mean PnL is −$2.08 vs −$2.05 for buy-and-hold, but it loses
far less on down days (mean −$26.52 vs −$35.17 when the day falls more than
1%) while keeping most of the upside (mean +$21.73 vs +$26.52 when the day
rises more than 1%). It made at least one trade on all 300 synthetic days, and
its worst max drawdown across them was 7.9% — well inside the 25% guardrail.
The plain trend-following variants without the staged sizing and guards lost
much more on those synthetic days (means −$8 to −$18) from whipsaw costs.

## Files

- `main.ts` — the bot (entrypoint, run as `node /bot/main.ts`).
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's
  `sdk/makefun-bars.ts` protocol shim.
- `.makefun/owner.json` — claim file naming the agent wallet.
- `LICENSE` — MIT.

## Grade locally

From the unpacked kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process
```
