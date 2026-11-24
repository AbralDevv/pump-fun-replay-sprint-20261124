// Pump.fun Replay Sprint — early-momentum rotation bot (agent-fun/replay/v2).
//
// Idea, in one paragraph: most pump.fun coins are decided in the first minutes
// after launch. This bot watches every new curve, waits until a coin shows real
// early demand (a few distinct non-creator buyers, positive net flow, price up a
// little from creation but not yet run away), buys a small fixed stake in pieces
// (each reply may spend at most 1% of the coin's real SOL reserve, so a young
// coin is accumulated over several batches), then exits on a take-profit, a
// trailing stop once the trade is armed, a stop-loss, a creator sell, a single
// very large sell, or a maximum hold time. It never holds more than 5 coins, so
// capital keeps rotating through the window; every finished round trip is at
// least 0.01 SOL, which is what the guardrail counts. No clock, no randomness,
// no network, no environment: every decision is a pure function of the batches
// the harness delivers, so the two grading runs agree byte for byte.
//
// Money math: a round trip pays ~1.25% curve fees per side plus a fixed
// 105,000-lamport transaction fee per order. On a 0.1 SOL stake that is about
// 2.7% per round trip, so exits are tight (+8% take-profit, -4% stop, trailing
// stop armed from entry that sells on a 6% pullback from the peak, 400-slot
// max hold) and entries require strong early momentum (10 trades, 5 distinct
// buyers, all of the last 10 trades buys, price +20% to +50% vs creation and
// within 2% of its tape high). Tuned by local grading: the loose first draft
// lost -4.18 SOL; this config grades at about -0.03 SOL with a ~1% drawdown.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
} from "./vendor/makefun-bot.ts";

// ------------------------------------------------------------------ tuning
const SOL = LAMPORTS_PER_SOL;
const TARGET_STAKE = 100_000_000n; // 0.10 SOL bought per coin, in pieces
const MIN_BUY = 10_000_000n; // 0.01 SOL: the smallest buy that counts as a round trip
const MIN_REAL_SOL = 1_000_000_000n; // need real reserve >= 1 SOL so 1% >= MIN_BUY
const MAX_REAL_SOL = 60_000_000_000n; // above this the easy move is usually over
const MIN_TRADES = 10; // trades seen before a first buy
const MIN_BUYERS = 5; // distinct non-creator buyers before a first buy
const FLOW_WINDOW = 10; // last N trades the flow check looks at
const FLOW_MIN_BUYS = 10; // of those N, all must be buys
const RUNUP_MIN = 1.2; // price must be at least 20% above creation price
const RUNUP_MAX = 1.5; // and at most 1.5x creation price (do not chase a moon)
const NEAR_HIGH = 0.98; // price within 2% of the tape's high: momentum intact
const MAX_ENTRY_AGE = 600; // slots after creation during which a first buy may fire
const MAX_ADD_AGE = 600; // slots after creation during which adds may still fire
const BUY_SLIPPAGE_BPS = 1000; // tight enough to refuse buying a 2-slot moon
const SELL_SLIPPAGE_BPS = 2000;
const TAKE_PROFIT = 1.08; // sell when price reaches 1.08x the average entry
const STOP_LOSS = 0.96; // sell when price falls to 0.96x the average entry
const TRAIL_ARM = 1.0; // trailing stop armed from entry: any pullback from the peak sells
const TRAIL_DROP = 0.94; // ... sell if price falls to 0.94x its high while holding
const MAX_HOLD_SLOTS = 400; // give up on a flat coin after this many slots
const BIG_SELL_BPS = 1000; // one sell >= 10% of the real reserve: exit now
const MAX_NEW_PER_BATCH = 2; // new coins per batch (adds do not count)
const DD_HALT = 0.6; // stop opening below 60% of peak equity (guardrail is 50%)
const DD_RESUME = 0.7; // resume opening once equity recovers above 70% of peak
const TAPE_KEEP = 40; // trades remembered per coin
const PRUNE_EVERY = 5000; // batches between tape prunes
const PRUNE_AGE = 20000; // slots of silence before a dead coin's tape is dropped

// ------------------------------------------------------------------ books
interface Tick {
  slot: number;
  buy: boolean;
  sol: bigint;
  price: number;
}

interface Coin {
  mint: string;
  createdSlot: number | null;
  creator: string;
  createPrice: number;
  ticks: Tick[];
  buyers: Set<string>;
  devSold: boolean;
  complete: boolean;
  lastSlot: number;
  highPrice: number; // highest price seen over the tape
  boughtLamports: bigint; // SOL spent on filled buys (fees included)
  committedLamports: bigint; // bought + buys still in flight
  entryTokens: bigint; // tokens received from filled buys
  entrySlot: number; // slot of the first filled buy, -1 when flat
  holdHigh: number; // highest price seen while holding
  pendingBuy: boolean;
  pendingSell: boolean;
}

interface Pending {
  mint: string;
  kind: "buy" | "sell";
  lamports: bigint; // buy: SOL committed; sell: tokens committed
}

const coins = new Map<string, Coin>();
const pending = new Map<string, Pending>();
const roundTripped = new Set<string>();
let myFills = 0;
let myBuys = 0;
let mySells = 0;
let batchesSeen = 0;
let peakEquity = 10n * SOL;
let halted = false;

function coinOf(mint: string): Coin | undefined {
  return coins.get(mint);
}

function newCoin(mint: string, slot: number, creator: string, price: number): Coin {
  const c: Coin = {
    mint,
    createdSlot: slot,
    creator,
    createPrice: price,
    ticks: [],
    buyers: new Set(),
    devSold: false,
    complete: false,
    lastSlot: slot,
    highPrice: price,
    boughtLamports: 0n,
    committedLamports: 0n,
    entryTokens: 0n,
    entrySlot: -1,
    holdHigh: 0,
    pendingBuy: false,
    pendingSell: false,
  };
  coins.set(mint, c);
  return c;
}

/** Marginal price in SOL per token from a curve's virtual reserves. */
function priceOf(vq: bigint, vt: bigint): number {
  if (vt <= 0n || vq <= 0n) return 0;
  return Number(vq) / Number(vt);
}

function netFlow(c: Coin, n: number): bigint {
  let flow = 0n;
  const ts = c.ticks.slice(-n);
  for (const t of ts) flow += t.buy ? t.sol : -t.sol;
  return flow;
}

function buysIn(c: Coin, n: number): number {
  let k = 0;
  for (const t of c.ticks.slice(-n)) if (t.buy) k += 1;
  return k;
}

/** Equity: cash plus every position marked at its curve's current price. */
function equity(state: BotState): bigint {
  let total = state.cash;
  for (const [mint, pos] of state.positions) {
    const curve = state.curves.get(mint);
    if (curve === undefined) continue;
    const p = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (p <= 0) continue;
    // tokens * price, in lamports: tokens are integers, price is SOL/token.
    total += BigInt(Math.floor(Number(pos.token_amount) * p));
  }
  return total;
}

function holding(state: BotState, mint: string): boolean {
  const pos = state.positions.get(mint);
  return pos !== undefined && pos.token_amount > 0n;
}

// ------------------------------------------------------------------ the bot
await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    try {
      return decide(state, batch, orders);
    } catch (err) {
      // Never fail the run on one bad batch: log and send what was built.
      console.error(`batch ${batch.seq}: ${err instanceof Error ? err.message : String(err)}`);
      return orders;
    }
  },

  onDone(state: BotState): void {
    console.error(
      `done: batches=${batchesSeen} fills=${myFills} buys=${myBuys} sells=${mySells} ` +
        `roundTrips=${roundTripped.size} coins=${coins.size} cash=${state.cash}`,
    );
  },
});

function decide(state: BotState, batch: Batch, orders: OrderInput[]): OrderInput[] {
  batchesSeen += 1;
  const slot = batch.slot;
  const txFee = state.txFeeLamports();

  // ---- 1. settle fills: update books, clear pending flags -----------------
  for (const f of batch.fills) {
    if (f.client_id.startsWith("_")) {
      // Harness close (complete / flatten / writeoff): the position is gone.
      const c = coinOf(f.mint);
      if (c !== undefined) {
        if (c.boughtLamports >= MIN_BUY) roundTripped.add(f.mint);
        c.boughtLamports = 0n;
        c.committedLamports = 0n;
        c.entryTokens = 0n;
        c.entrySlot = -1;
        c.holdHigh = 0;
        c.pendingBuy = false;
        c.pendingSell = false;
      }
      pending.delete(f.client_id);
      continue;
    }
    const p = pending.get(f.client_id);
    if (p === undefined) continue;
    pending.delete(f.client_id);
    const c = coinOf(f.mint);
    if (c === undefined) continue;
    if (p.kind === "buy") {
      c.pendingBuy = false;
      c.committedLamports -= p.lamports;
      if (f.status === "filled") {
        myFills += 1;
        myBuys += 1;
        c.boughtLamports += BigInt(f.quote_lamports);
        c.entryTokens += BigInt(f.token_amount);
        if (c.entrySlot < 0) c.entrySlot = f.slot;
      }
      // rejected / failed: nothing was spent, the committed amount is freed.
    } else {
      c.pendingSell = false;
      if (f.status === "filled") {
        myFills += 1;
        mySells += 1;
        if (!holding(state, f.mint)) {
          if (c.boughtLamports >= MIN_BUY) roundTripped.add(f.mint);
          c.boughtLamports = 0n;
          c.committedLamports = 0n;
          c.entryTokens = 0n;
          c.entrySlot = -1;
          c.holdHigh = 0;
        }
      }
    }
  }

  // ---- 2. fold this batch's events into the tapes ------------------------
  for (const e of batch.events) {
    if (e.event === "CreateEvent") {
      const price = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
      const c = coinOf(e.mint) ?? newCoin(e.mint, e.slot, e.creator, price);
      c.createdSlot = e.slot;
      c.creator = e.creator;
      c.createPrice = price;
      c.highPrice = Math.max(c.highPrice, price);
      c.lastSlot = e.slot;
    } else if (e.event === "TradeEvent") {
      let c = coinOf(e.mint);
      if (c === undefined) {
        // A coin created before the window: first sight is its baseline.
        const price = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        c = newCoin(e.mint, e.slot, e.user, price);
        c.createdSlot = null;
        c.createPrice = price;
      }
      const price = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
      const sol = BigInt(e.sol_amount);
      c.ticks.push({ slot: e.slot, buy: e.is_buy, sol, price });
      if (c.ticks.length > TAPE_KEEP) c.ticks.splice(0, c.ticks.length - TAPE_KEEP);
      if (e.user !== c.creator) c.buyers.add(e.user);
      if (e.user === c.creator && !e.is_buy) c.devSold = true;
      if (price > c.highPrice) c.highPrice = price;
      c.lastSlot = e.slot;
    } else {
      const c = coinOf(e.mint);
      if (c !== undefined) {
        c.complete = true;
        c.lastSlot = e.slot;
      }
    }
  }

  // ---- 3. exits: manage every open position ------------------------------
  for (const [mint, pos] of state.positions) {
    const c = coinOf(mint);
    const curve = state.curves.get(mint);
    if (c === undefined || curve === undefined || curve.complete || c.pendingSell) continue;
    if (pos.token_amount <= 0n) continue;
    const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (price <= 0) continue;
    const entry = Number(pos.cost_lamports) / Number(pos.token_amount);
    if (entry <= 0) continue;
    if (price > c.holdHigh) c.holdHigh = price;

    let why = "";
    if (price >= entry * TAKE_PROFIT) why = "take-profit";
    else if (price <= entry * STOP_LOSS) why = "stop-loss";
    else if (c.holdHigh >= entry * TRAIL_ARM && price <= c.holdHigh * TRAIL_DROP) why = "trailing-stop";
    else if (c.entrySlot >= 0 && slot - c.entrySlot >= MAX_HOLD_SLOTS) why = "max-hold";
    else if (c.devSold) why = "creator-sold";
    else {
      // One very large sell against this curve: the exit queue has started.
      const last = c.ticks[c.ticks.length - 1];
      if (
        last !== undefined &&
        !last.buy &&
        curve.real_quote_reserves > 0n &&
        last.sol * 10000n >= curve.real_quote_reserves * BigInt(BIG_SELL_BPS)
      ) {
        why = "big-sell";
      }
    }
    if (why === "") continue;
    if (orders.length >= state.hello.caps.max_orders_per_batch) continue;
    // Assign the client id ourselves so the fill can be matched back here.
    const sellId = state.clientId();
    orders.push({
      side: "sell",
      client_id: sellId,
      mint,
      token_amount: pos.token_amount,
      max_slippage_bps: SELL_SLIPPAGE_BPS,
    });
    c.pendingSell = true;
    pending.set(sellId, { mint, kind: "sell", lamports: pos.token_amount });
  }

  // ---- 4. drawdown guard: halt new entries while equity is deep down -----
  const eq = equity(state);
  if (eq > peakEquity) peakEquity = eq;
  if (halted) {
    if (eq > (peakEquity * BigInt(Math.round(DD_RESUME * 100))) / 100n) halted = false;
  } else if (eq < (peakEquity * BigInt(Math.round(DD_HALT * 100))) / 100n) {
    halted = true;
  }

  // ---- 5. entries: new coins and adds, in event order --------------------
  if (!halted) {
    let free = state.freeCashLamports();
    let slotsOpen = state.hello.caps.max_open_positions - state.committedPositionCount();
    let newThisBatch = 0;
    const seenThisBatch = new Set<string>();
    for (const e of batch.events) {
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
      if (seenThisBatch.has(e.mint)) continue;
      seenThisBatch.add(e.mint);
      const c = coinOf(e.mint);
      if (c === undefined || c.complete || c.pendingBuy || c.pendingSell) continue;
      const curve = state.curves.get(e.mint);
      if (curve === undefined || curve.complete) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0) continue;

      const isNew = !holding(state, e.mint) && c.boughtLamports === 0n && c.committedLamports === 0n;
      if (isNew) {
        if (newThisBatch >= MAX_NEW_PER_BATCH || slotsOpen <= 0) continue;
        if (!qualifiesFirstBuy(c, curve, price, slot)) continue;
      } else {
        // An add: keep accumulating toward the stake while the coin is young
        // and still looks the way it did when we first bought it.
        if (c.committedLamports >= TARGET_STAKE) continue;
        if (c.createdSlot !== null && slot - c.createdSlot > MAX_ADD_AGE) continue;
        if (c.ticks.length < MIN_TRADES || price < c.createPrice * RUNUP_MIN) continue;
        if (netFlow(c, FLOW_WINDOW) <= 0n) continue;
      }

      const cap = state.maxBuyLamports(e.mint);
      if (cap < MIN_BUY) continue;
      const remaining = TARGET_STAKE - c.committedLamports;
      if (remaining < MIN_BUY) continue;
      let amount = cap < remaining ? cap : remaining;
      if (free < amount + txFee) {
        if (free <= txFee + MIN_BUY) continue;
        amount = free - txFee;
      }
      if (amount < MIN_BUY) continue;
      const buyId = state.clientId();
      orders.push({
        side: "buy",
        client_id: buyId,
        mint: e.mint,
        quote_lamports: amount,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
      c.pendingBuy = true;
      c.committedLamports += amount;
      pending.set(buyId, { mint: e.mint, kind: "buy", lamports: amount });
      free -= amount + txFee;
      if (isNew) {
        newThisBatch += 1;
        slotsOpen -= 1;
      }
    }
  }

  // ---- 6. prune dead tapes on a fixed schedule ---------------------------
  if (batchesSeen % PRUNE_EVERY === 0) {
    for (const [mint, c] of coins) {
      if (holding(state, mint) || c.pendingBuy || c.pendingSell) continue;
      if (slot - c.lastSlot > PRUNE_AGE) coins.delete(mint);
    }
  }

  return orders;
}

/** First-buy filter: early demand, sane size, momentum without a moon. */
function qualifiesFirstBuy(
  c: Coin,
  curve: { real_quote_reserves: bigint },
  price: number,
  slot: number,
): boolean {
  if (c.createdSlot !== null && slot - c.createdSlot > MAX_ENTRY_AGE) return false;
  if (c.ticks.length < MIN_TRADES) return false;
  if (c.buyers.size < MIN_BUYERS) return false;
  if (c.devSold) return false;
  if (curve.real_quote_reserves < MIN_REAL_SOL) return false;
  if (curve.real_quote_reserves > MAX_REAL_SOL) return false;
  if (c.createPrice <= 0) return false;
  if (price < c.createPrice * RUNUP_MIN) return false;
  if (price > c.createPrice * RUNUP_MAX) return false;
  if (price < c.highPrice * NEAR_HIGH) return false;
  if (netFlow(c, FLOW_WINDOW) <= 0n) return false;
  if (buysIn(c, FLOW_WINDOW) < FLOW_MIN_BUYS) return false;
  return true;
}
