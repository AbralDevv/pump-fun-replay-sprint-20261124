# Pump.fun Replay Sprint — Paper Bot

Paper-trading bot for the `agent-fun/replay/v2` pump.fun replay: 10 SOL of
paper money, one 24h window of bonding-curve events, ranked by net PnL.

## Strategy: early-momentum rotation

- **Entry.** A coin becomes a candidate only when it shows strong early
  demand: at least 10 trades, at least 5 distinct non-creator buyers, all
  of the last 10 trades buys, price 20%–50% above its creation price and
  within 2% of its tape high, real SOL reserve between 1 and 60 SOL, and no
  creator sell. First buys fire within 600 slots of creation.
- **Sizing.** 0.10 SOL per coin, bought in pieces: each reply may spend at
  most 1% of the coin's real SOL reserve, so a young coin is accumulated over
  several batches while it still qualifies.
- **Exits (full position).** Take-profit +8% vs average entry, stop-loss
  −4%, trailing stop armed from entry (sells at −6% from the holding high),
  max hold 400 slots, immediate exit if the creator sells or a single sell
  exceeds 10% of the real reserve. The harness closes positions on curve
  completion and flattens what is left at the end of the data.
- **Tuning.** The loose first draft graded at −4.18 SOL locally (16.5% win
  rate, losers gapping down past a wide stop). Tightening the entry filter
  and the exits in steps brought it to about −0.03 SOL: 25 round trips over
  24 coins, 24% win rate, ~1% max drawdown, ~0.135 SOL total fees.
- **Risk.** At most 5 open positions; new entries halt if equity falls below
  60% of its peak (the guardrail is a 50% maximum drawdown) and resume above
  70%. Every finished round trip is at least 0.01 SOL, the guardrail minimum.
- **Determinism.** No clock, no randomness, no network, no environment
  reads: every decision is a pure function of the batches the harness
  delivers, so the two grading runs produce identical action logs.

## Layout

- `main.ts` — the whole strategy (entry point, run as `node /bot/main.ts`).
- `vendor/makefun-bot.ts` — the kit's protocol shim, vendored byte for byte.
- `prompt.txt` — the brief this entry was built from.

## Local grading

From the kit directory:

```
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process --worktree
```

`--driver process` runs the Node bot on this machine (no Docker needed).
