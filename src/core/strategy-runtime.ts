// the strategy execution engine: order handling, the bar-level fill model,
// position accounting and the result statistics.
//
// no DOM, no chart, no imports outside this file - the browser worker and the
// server runner both execute this exact module, so a strategy scores the same
// wherever it runs

/** Which way a position or fill points. */
export type Side = 'long' | 'short' | 'flat';

export type OrderKind = 'market' | 'limit' | 'stop';

/** Why a position closed, for the trade log and the markers on the chart. */
export type ExitReason = 'signal' | 'stop' | 'target' | 'reverse' | 'end-of-data';

export interface StrategyOrder {
    id: number;
    side: 'buy' | 'sell';
    qty: number;
    kind: OrderKind;
    /** Trigger price for limit/stop. Ignored for market. */
    price?: number;
    /** Protective stop attached to the position this order opens. */
    sl?: number;
    /** Profit target attached to the position this order opens. */
    tp?: number;
    tag?: string;
    /** Bar index the order was placed on. It becomes eligible on the next one. */
    placedIndex: number;
}

export interface StrategyPosition {
    side: Side;
    qty: number;
    avgPrice: number;
    entryTs: bigint;
    entryIndex: number;
    sl?: number;
    tp?: number;
    tag?: string;
    /**
     * Best/worst price while open, from the entry bar's full range. Exact for
     * a market fill; an upper bound for a limit/stop filling mid-bar - don't
     * read MAE as gospel on a one-bar trade.
     */
    highWatermark: number;
    lowWatermark: number;
    /** Bar index and timestamp of the best excursion, for efficiency analysis. */
    mfeIndex: number;
    mfeTs: bigint;
    maeIndex: number;
    maeTs: bigint;
    /**
     * |entry - stop| per unit, locked at entry. Undefined when the position
     * opened without a stop, which makes every R-multiple on it meaningless
     * rather than zero - the difference matters, so it stays undefined.
     */
    initialRiskPerUnit?: number;
    /** Fills that have gone into this position. Checked against `pyramiding`. */
    entries: number;
    /**
     * Commission already paid to open the quantity still held. Carried so the
     * exit's trade record can report the round-trip fee - otherwise pnl
     * wouldn't sum to the equity curve.
     */
    entryFees: number;
}

export interface StrategyTrade {
    id: number;
    side: Exclude<Side, 'flat'>;
    qty: number;
    entryTs: bigint;
    entryPrice: number;
    exitTs: bigint;
    exitPrice: number;
    /** Net of fees, in account currency. */
    pnl: number;
    /** Before fees. */
    pnlGross: number;
    /** Net return on the notional put at risk, as a fraction. */
    pnlPct: number;
    fees: number;
    /** The fee split, because a strategy killed by commission and one killed by
     *  slippage need different fixes. */
    commission: number;
    slippage: number;
    /** How many bars the position was held. */
    bars: number;
    /** Wall-clock time held, in nanoseconds. */
    durationNs: bigint;
    tag?: string;
    reason: ExitReason;
    /**
     * Stop and target both sat inside the resolving bar, so which came first
     * was assumed (stop wins) rather than observed. Intrabar data shrinks how
     * often this happens but never zeroes it.
     */
    ambiguousExit?: boolean;

    // Excursion. Price units, always >= 0.
    /** Worst the price went against this position before it closed. */
    maeAbs: number;
    /** Best the price went in favour of it. */
    mfeAbs: number;
    /** The same two, in account currency. */
    maePnl: number;
    mfePnl: number;
    /** When the best and worst excursions happened. */
    mfeTs: bigint;
    maeTs: bigint;
    /** Bars from entry to the best excursion. Tells you if you exit too late. */
    barsToMfe: number;

    // Risk multiples. Undefined together when the position had no stop.
    /** |entry - stop| per unit at entry. */
    initialRiskPerUnit?: number;
    /** Total risk taken: initialRiskPerUnit x qty x contractSize. */
    initialRiskTotal?: number;
    /** Result in R. */
    realizedR?: number;
    /** Best and worst R reached while open. */
    maxFavorableR?: number;
    maxAdverseR?: number;
    /**
     * How much of the favourable excursion the exit actually captured, 0..1.
     * A strategy averaging 0.2 here is right about direction and wrong about
     * exits, which is a different problem from one that is simply wrong.
     */
    efficiency?: number;

    /** Peak-to-exit give-back within this position, in account currency. */
    maxDrawdownAbs: number;
    maxDrawdownPct: number;

    /** The protective levels this position opened with, if any. */
    sl?: number;
    tp?: number;
}

export interface StrategyEquityPoint {
    ts: bigint;
    /** Mark-to-market account value at this bar's close. */
    equity: number;
    /** Fraction below the running peak, 0 at a new high. */
    drawdown: number;
}

export interface StrategyStats {
    netPnl: number;
    grossProfit: number;
    grossLoss: number;
    /** grossProfit / |grossLoss|. Infinity with no losers, 0 with no winners. */
    profitFactor: number;
    totalTrades: number;
    wins: number;
    losses: number;
    /** Fraction, not percent. */
    winRate: number;
    avgWin: number;
    avgLoss: number;
    /** Expected P&L per trade. */
    expectancy: number;
    maxDrawdown: number;
    maxDrawdownPct: number;
    /** Annualised, from per-bar returns and the bar period. 0 without one. */
    sharpe: number;
    returnPct: number;
    /** Fraction of bars holding a position. */
    exposure: number;
    finalEquity: number;

    // Distribution
    largestWin: number;
    largestLoss: number;
    /** Median trade P&L. The mean is what one outlier moves; this is not. */
    medianPnl: number;
    /** avgWin / |avgLoss|. How much bigger a winner is than a loser. */
    payoffRatio: number;
    /** Trades that closed exactly flat, counted separately from wins and losses. */
    breakEvens: number;

    // Streaks
    maxWinStreak: number;
    maxLossStreak: number;
    /** Signed: positive means the run ended on N wins, negative on N losses. */
    currentStreak: number;

    // Duration
    avgBarsHeld: number;
    avgWinBarsHeld: number;
    avgLossBarsHeld: number;
    /** Total bars in the run, for anything wanting to re-derive a rate. */
    totalBars: number;

    // Risk-adjusted. Each falls back to 0 rather than NaN or Infinity when the
    // run does not support it - a panel showing "-" is honest, "NaN" is a bug.
    /** Like Sharpe but only downside deviation is punished. */
    sortino: number;
    /** Annualised return over max drawdown. */
    calmar: number;
    /** Net profit over max drawdown - how much the strategy makes per unit of pain. */
    recoveryFactor: number;
    /** RMS of the drawdown series. Punishes long shallow drawdowns Sharpe ignores. */
    ulcerIndex: number;
    /** System Quality Number: sqrt(n) x mean / stdev of trade P&L. */
    sqn: number;
    /** Kelly fraction from win rate and payoff. Negative means no edge. */
    kelly: number;
    /** Compound annual growth rate, from the run's wall-clock span. */
    cagr: number;

    // R multiples, over the trades that had a stop
    /** How many trades carried a stop, and so have an R at all. */
    tradesWithRisk: number;
    avgR: number;
    /** Sum of R. The expectancy curve most people actually track. */
    totalR: number;
    /** Mean of realizedR / maxFavorableR - how much of the move exits capture. */
    avgEfficiency: number;

    // Excursion
    avgMae: number;
    avgMfe: number;

    // Side split, because most broken strategies are broken on one side only
    longTrades: number;
    shortTrades: number;
    longWinRate: number;
    shortWinRate: number;
    longPnl: number;
    shortPnl: number;

    // Costs
    totalFees: number;
    totalCommission: number;
    /**
     * What slippage cost, in account currency - already inside netPnl via the
     * fill prices, reported here rather than deducted again.
     */
    totalSlippage: number;
    /** What the run would have made with no commission at all. */
    grossPnlBeforeCosts: number;

    // Fill resolution. How much of this run was observed rather than assumed.
    /** Chart bars whose fills were resolved against finer intrabar data. */
    intrabarBars: number;
    /**
     * Bars given intrabar data that didn't reconcile with the aggregate and
     * fell back to it. Non-zero means the finer feed has holes - the run is
     * still valid, just not the run the intrabar toggle implies.
     */
    intrabarFallbacks: number;
    /**
     * Exits where stop and target shared a resolving bar and the stop was
     * assumed first. Compare against `totalTrades` for how much of the result
     * rests on that assumption.
     */
    ambiguousExits: number;
}

export interface StrategyConfig {
    initialCapital: number;
    /** Charged per contract per side. */
    commission: number;
    /** Applied against the trader, in ticks, on market and stop fills. */
    slippageTicks: number;
    tickSize: number;
    /** Account-currency value of one point of price movement, per contract. */
    contractSize: number;
    /** How many entries may stack in the same direction. */
    pyramiding: number;
    /**
     * Whether an opposite-side order flips a position or just closes it. True
     * matches how most scripts read: sell() while long means "get out and go
     * short".
     */
    allowReverse: boolean;
    /**
     * Smallest tradable quantity increment; order sizes floor to it. 1 for a
     * listed future, fractional for spot - comes from the instrument, not
     * assumed.
     */
    qtyStep: number;
}

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
    initialCapital: 100_000,
    commission: 0,
    slippageTicks: 0,
    tickSize: 0.01,
    contractSize: 1,
    pyramiding: 1,
    allowReverse: true,
    qtyStep: 1,
};

export interface StrategyResult {
    trades: StrategyTrade[];
    equity: StrategyEquityPoint[];
    stats: StrategyStats;
    position: StrategyPosition | null;
    openOrders: StrategyOrder[];
}

/** One OHLCV bar, structurally what the stdlib and the data engine already use. */
export interface StrategyBar {
    ts: bigint;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

/**
 * Do these finer bars actually subdivide this one?
 *
 * A feed with a hole in it is worse than none at all - it'd resolve a stop
 * against a range missing the second price actually traded through. Rejected
 * whole rather than repaired, since fixing it would mean inventing the
 * ordering inside the gap.
 *
 * @param tolerance Half a tick - two aggregation paths over the same trades
 * agree to the tick, not the float.
 */
export function reconcileIntrabar(
    bar: StrategyBar,
    sub: readonly StrategyBar[] | undefined,
    tolerance: number,
): boolean {
    if (!sub || sub.length === 0) return false;

    const near = (a: number, b: number) => Math.abs(a - b) <= tolerance;

    // right open/close but wrong extremes is the signature of a feed missing
    // bars in the middle
    if (!near(sub[0].open, bar.open)) return false;
    if (!near(sub[sub.length - 1].close, bar.close)) return false;

    let high = -Infinity;
    let low = Infinity;
    let prevTs = -1n;

    for (const s of sub) {
        // out of order or duplicate timestamps mean this isn't the order the
        // market actually traded in
        if (s.ts <= prevTs) return false;
        prevTs = s.ts;

        if (s.high > high) high = s.high;
        if (s.low < low) low = s.low;
    }

    return near(high, bar.high) && near(low, bar.low);
}

export interface OrderOpts {
    /** Place a limit instead of a market order. */
    limit?: number;
    /** Place a stop instead of a market order. */
    stop?: number;
    /** Protective stop for the resulting position, as an absolute price. */
    sl?: number;
    /** Profit target for the resulting position, as an absolute price. */
    tp?: number;
    /** Free label, carried onto the trade and shown on the chart marker. */
    tag?: string;
}

/** What a strategy script sees as `broker`. */
export interface BrokerApi {
    buy(qty?: number, opts?: OrderOpts): number;
    sell(qty?: number, opts?: OrderOpts): number;
    /** Flatten at the next bar's open. No-op when already flat. */
    close(): void;
    cancelAll(): void;
    readonly position: Readonly<StrategyPosition> | null;
    readonly equity: number;
    readonly cash: number;
    readonly openOrders: readonly StrategyOrder[];
}

function median(values: number[]): number {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// the sqrt(n) term rewards enough trades to trust, not just a lucky streak
function sqn(pnls: number[]): number {
    if (pnls.length < 2) return 0;

    let mean = 0;
    for (const p of pnls) mean += p;
    mean /= pnls.length;

    let varSum = 0;
    for (const p of pnls) varSum += (p - mean) * (p - mean);
    const sd = Math.sqrt(varSum / (pnls.length - 1));

    return sd === 0 ? 0 : (Math.sqrt(pnls.length) * mean) / sd;
}

// the only part of a result that grows with the range - a five year minute
// run would otherwise retain hundreds of MB of it
const MAX_EQUITY_POINTS = 8192;

export class StrategyEngine {
    private cfg: StrategyConfig;
    private pending: StrategyOrder[] = [];
    private pos: StrategyPosition | null = null;
    private trades: StrategyTrade[] = [];
    private equityCurve: StrategyEquityPoint[] = [];
    private realized: number;
    private peak: number;
    private nextOrderId = 1;
    private index = -1;
    private barsInPosition = 0;
    private barCount = 0;
    private markPrice = 0;
    private closeRequested = false;
    private barNs = 0n;
    private slippagePaid = 0;
    private usedIntrabar = false;
    private intrabarBars = 0;
    private intrabarFallbacks = 0;
    private ambiguousExits = 0;

    // accumulated per bar, not derived from equityCurve, so memory doesn't
    // grow with the run
    private pendingEquity: StrategyEquityPoint | null = null;
    private equityCount = 0;
    private firstTs: bigint | null = null;
    private lastTs = 0n;
    private lastEquity: number | null = null;
    private prevEquity: number | null = null;
    private maxDdAbs = 0;
    private maxDdPct = 0;
    private ulcerSum = 0;
    // Welford, not sum-of-squares - the naive form loses precision over a
    // couple million bars
    private retN = 0;
    private retMean = 0;
    private retM2 = 0;
    private downSum = 0;
    private downCount = 0;
    private curvePhase = 0;
    private curveStride = 1;
    private lastFolded: StrategyEquityPoint | null = null;

    constructor(cfg: Partial<StrategyConfig> = {}) {
        this.cfg = { ...DEFAULT_STRATEGY_CONFIG, ...cfg };
        this.realized = this.cfg.initialCapital;
        this.peak = this.cfg.initialCapital;
    }

    // bar period, used only to annualize sharpe
    setBarNs(ns: bigint): void {
        this.barNs = ns;
    }

    // Fills pending orders and checks the open position's stop/target against
    // this bar's range, before the script sees it. `sub` is the same period at
    // finer resolution - when it reconciles, fills resolve against each
    // sub-bar in turn instead of the aggregate, so a bar with both a stop and a
    // target can say which came first. Still one call per chart bar either way.
    beginBar(bar: StrategyBar, index: number, sub?: readonly StrategyBar[]): void {
        this.index = index;
        this.markPrice = bar.close;

        // half a tick: two aggregation paths over the same trades agree to the
        // tick, not to the float
        const intrabar =
            sub && sub.length > 0
                ? reconcileIntrabar(bar, sub, Math.max(this.cfg.tickSize / 2, 1e-9))
                : false;

        if (sub && sub.length > 0) {
            if (intrabar) this.intrabarBars++;
            else this.intrabarFallbacks++;
        }
        this.usedIntrabar = intrabar;

        if (this.closeRequested) {
            this.closeRequested = false;
            // an explicit close is a market order like any other, so it pays the
            // same slippage - leaving it at the clean open made flat round trips
            // look free
            if (this.pos) {
                const slip = this.cfg.slippageTicks * this.cfg.tickSize;
                this.exit(bar, bar.open + (this.pos.side === 'long' ? -slip : slip), 'signal');
            }
        }

        if (!intrabar) {
            if (this.pending.length) this.processPending(bar);
            if (this.pos) this.checkBrackets(bar);
            return;
        }

        for (const s of sub!) {
            if (this.pending.length) this.processPending(s);
            if (this.pos) this.checkBrackets(s);
            // a position opened partway through the bar no longer inherits the
            // range it was never open for
            if (this.pos) this.trackExcursion(s);
        }
    }

    // marks to market and records the equity point, after the script's update
    endBar(bar: StrategyBar): void {
        this.barCount++;
        this.markPrice = bar.close;
        if (this.pos) {
            this.barsInPosition++;
            // re-running this against the aggregate would widen a sub-bar's
            // watermarks back out to the full bar
            if (!this.usedIntrabar) this.trackExcursion(bar);
        }

        const eq = this.equity;
        if (eq > this.peak) this.peak = eq;

        // held one bar back - finish() can still revise a position closed at
        // the last bar before it's counted
        this.foldPending();

        if (this.firstTs === null) this.firstTs = bar.ts;
        this.pendingEquity = {
            ts: bar.ts,
            equity: eq,
            drawdown: this.peak > 0 ? (this.peak - eq) / this.peak : 0,
        };
    }

    // returns computed here, from the true per-bar sequence, not the (decimated) stored curve
    private foldPending(): void {
        const p = this.pendingEquity;
        if (!p) return;
        this.pendingEquity = null;

        this.equityCount++;
        this.lastTs = p.ts;
        this.lastEquity = p.equity;

        // this.peak has moved on by now - recover this point's own peak from
        // the drawdown it carries
        const peak = p.drawdown >= 1 ? p.equity : p.equity / (1 - p.drawdown);
        const abs = peak - p.equity;
        if (abs > this.maxDdAbs) this.maxDdAbs = abs;
        if (p.drawdown > this.maxDdPct) this.maxDdPct = p.drawdown;
        this.ulcerSum += p.drawdown * p.drawdown;

        if (this.prevEquity !== null && this.prevEquity > 0) {
            const r = (p.equity - this.prevEquity) / this.prevEquity;
            this.retN++;
            const delta = r - this.retMean;
            this.retMean += delta / this.retN;
            this.retM2 += delta * (r - this.retMean);
            if (r < 0) {
                this.downSum += r * r;
                this.downCount++;
            }
        }
        this.prevEquity = p.equity;

        this.lastFolded = p;
        this.keepInCurve(p);
    }

    // halving + doubling the stride on overflow keeps the whole span covered
    // at a coarser resolution, instead of a detailed head and a missing tail
    private keepInCurve(p: StrategyEquityPoint): void {
        if (this.curvePhase === 0) {
            this.equityCurve.push(p);
            if (this.equityCurve.length > MAX_EQUITY_POINTS) {
                const kept: StrategyEquityPoint[] = [];
                for (let i = 0; i < this.equityCurve.length; i += 2) {
                    kept.push(this.equityCurve[i]);
                }
                this.equityCurve = kept;
                this.curveStride *= 2;
            }
        }
        this.curvePhase = (this.curvePhase + 1) % this.curveStride;
    }

    // closes anything still open at the last bar, so the trade log balances
    finish(lastBar: StrategyBar | undefined): void {
        if (!this.pos || !lastBar) {
            this.foldPending();
            return;
        }

        this.exit(lastBar, lastBar.close, 'end-of-data');

        const last = this.pendingEquity;
        if (last) {
            const eq = this.equity;
            if (eq > this.peak) this.peak = eq;
            last.equity = eq;
            last.drawdown = this.peak > 0 ? (this.peak - eq) / this.peak : 0;
        }

        this.foldPending();
    }

    get equity(): number {
        return this.realized + this.unrealized();
    }

    get result(): StrategyResult {
        // readable without finish() - a sweep scoring a combination has no
        // open-position cleanup to do
        this.foldPending();

        // the stride can land the final bar between kept points; append it if so
        if (this.lastFolded && this.equityCurve[this.equityCurve.length - 1] !== this.lastFolded) {
            this.equityCurve.push(this.lastFolded);
        }

        return {
            trades: this.trades,
            equity: this.equityCurve,
            stats: this.computeStats(),
            position: this.pos,
            openOrders: this.pending,
        };
    }

    // the object handed to the script. It closes over the engine rather than exposing it,
    // so a script cannot rewrite its own trade log
    api(): BrokerApi {
        const self = this;
        return {
            buy: (qty = 1, opts = {}) => self.place('buy', qty, opts),
            sell: (qty = 1, opts = {}) => self.place('sell', qty, opts),
            close: () => {
                if (self.pos) self.closeRequested = true;
            },
            cancelAll: () => {
                self.pending = [];
            },
            get position() {
                return self.pos;
            },
            get equity() {
                return self.equity;
            },
            get cash() {
                return self.realized;
            },
            get openOrders() {
                return self.pending;
            },
        };
    }

    // internals

    private place(side: 'buy' | 'sell', qty: number, opts: OrderOpts): number {
        const n = this.roundQty(qty);
        const order: StrategyOrder = {
            id: this.nextOrderId++,
            side,
            qty: n,
            kind: opts.limit != null ? 'limit' : opts.stop != null ? 'stop' : 'market',
            price: opts.limit ?? opts.stop,
            sl: opts.sl,
            tp: opts.tp,
            tag: opts.tag,
            placedIndex: this.index,
        };
        this.pending.push(order);
        return order.id;
    }

    private processPending(bar: StrategyBar): void {
        const stillPending: StrategyOrder[] = [];

        for (const order of this.pending) {
            if (order.placedIndex >= this.index) {
                stillPending.push(order);
                continue;
            }

            const fill = this.fillPrice(order, bar);
            if (fill == null) {
                stillPending.push(order);
                continue;
            }
            this.execute(order, fill, bar);
        }

        this.pending = stillPending;
    }

    // Null when the bar never traded through the  order's trigger
    private fillPrice(order: StrategyOrder, bar: StrategyBar): number | null {
        const slip = this.cfg.slippageTicks * this.cfg.tickSize;

        if (order.kind === 'market') {
            return order.side === 'buy' ? bar.open + slip : bar.open - slip;
        }

        const trigger = order.price!;

        if (order.kind === 'limit') {
            // filled at the limit, never better - an aggregate bar can't evidence
            // price improvement
            if (order.side === 'buy' && bar.low <= trigger) return trigger;
            if (order.side === 'sell' && bar.high >= trigger) return trigger;
            return null;
        }

        // stop: triggers on the way through, and a gap fills at the open
        if (order.side === 'buy' && bar.high >= trigger) {
            return Math.max(trigger, bar.open) + slip;
        }
        if (order.side === 'sell' && bar.low <= trigger) {
            return Math.min(trigger, bar.open) - slip;
        }
        return null;
    }

    private execute(order: StrategyOrder, price: number, bar: StrategyBar): void {
        const wanted: Side = order.side === 'buy' ? 'long' : 'short';

        // an order against an open position closes it first, and only then opens
        // the other way with whatever quantity is left
        if (this.pos && this.pos.side !== wanted) {
            const closing = Math.min(this.pos.qty, order.qty);
            const remainder = order.qty - closing;
            const reversing = remainder > 0 && this.cfg.allowReverse;

            this.exit(bar, price, reversing ? 'reverse' : 'signal', closing);

            // with allowReverse off, an opposite order can only ever flatten -
            // the leftover quantity is dropped rather than opening the other way
            if (reversing) {
                this.enter(wanted, remainder, price, bar, order);
            }
            return;
        }

        if (this.pos && this.pos.side === wanted) {
            if (this.pos.entries >= this.maxEntries()) return;

            const total = this.pos.qty + order.qty;
            this.pos.avgPrice = (this.pos.avgPrice * this.pos.qty + price * order.qty) / total;
            this.pos.qty = total;
            this.pos.entries++;
            if (order.sl != null) this.pos.sl = order.sl;
            if (order.tp != null) this.pos.tp = order.tp;
            const fee = this.commissionFor(order.qty);
            this.pos.entryFees += fee;
            this.realized -= fee;
            this.slippagePaid += this.slippageCost(order.qty);
            return;
        }

        this.enter(wanted, order.qty, price, bar, order);
    }

    // Pyramiding, normalized. 0 and negatives mean one entry not none
    private maxEntries(): number {
        return Math.max(1, Math.floor(this.cfg.pyramiding));
    }

    private roundQty(qty: number): number {
        const step = this.cfg.qtyStep > 0 ? this.cfg.qtyStep : 1;
        const wanted = Math.abs(qty);
        const floored = Math.floor(wanted / step) * step;
        // step can be fractional (0.001 BTC), so trim the float noise flooring
        // leaves behind rather than shipping 0.30000000000000004 into a fill
        const decimals = (String(step).split('.')[1] ?? '').length;
        return floored > 0 ? Number(floored.toFixed(decimals)) : step;
    }

    private enter(
        side: Side,
        qty: number,
        price: number,
        bar: StrategyBar,
        order: StrategyOrder,
    ): void {
        const fee = this.commissionFor(qty);
        this.pos = {
            side,
            qty,
            avgPrice: price,
            entryTs: bar.ts,
            entryIndex: this.index,
            sl: order.sl,
            tp: order.tp,
            tag: order.tag,
            entryFees: fee,
            // seeded at the fill rather than at the bar's extremes, so a position
            // that never moves reports zero excursion instead of the bar's range
            highWatermark: price,
            lowWatermark: price,
            mfeIndex: this.index,
            mfeTs: bar.ts,
            maeIndex: this.index,
            maeTs: bar.ts,
            initialRiskPerUnit: order.sl != null ? Math.abs(price - order.sl) : undefined,
            entries: 1,
        };
        this.barsInPosition = 0;
        this.realized -= fee;
        this.slippagePaid += this.slippageCost(qty);
    }

    private slippageCost(qty: number): number {
        return this.cfg.slippageTicks * this.cfg.tickSize * qty * this.cfg.contractSize;
    }

    private exit(
        bar: StrategyBar,
        price: number,
        reason: ExitReason,
        qty?: number,
        ambiguous = false,
    ): void {
        const pos = this.pos;
        if (!pos) return;

        const closing = qty ?? pos.qty;
        const dir = pos.side === 'long' ? 1 : -1;
        const gross = (price - pos.avgPrice) * dir * closing * this.cfg.contractSize;

        // entry side was already charged to equity at open, so only the exit
        // side moves it here - the trade record still reports the round trip
        const exitFee = this.commissionFor(closing);
        const entryFee = pos.qty > 0 ? (pos.entryFees * closing) / pos.qty : 0;
        const fees = entryFee + exitFee;
        pos.entryFees -= entryFee;

        this.realized += gross - exitFee;
        this.slippagePaid += this.slippageCost(closing);

        const notional = pos.avgPrice * closing * this.cfg.contractSize;
        const long = pos.side === 'long';
        const unit = closing * this.cfg.contractSize;

        // clamped at zero - a same-bar close can have a watermark equal to entry
        const mfeAbs = Math.max(0, long ? pos.highWatermark - pos.avgPrice : pos.avgPrice - pos.lowWatermark);
        const maeAbs = Math.max(0, long ? pos.avgPrice - pos.lowWatermark : pos.highWatermark - pos.avgPrice);

        const risk = pos.initialRiskPerUnit;
        const riskTotal = risk != null ? risk * unit : undefined;
        const net = gross - fees;
        const realizedR = riskTotal && riskTotal > 0 ? net / riskTotal : undefined;
        const maxFavorableR = riskTotal && riskTotal > 0 ? (mfeAbs * unit) / riskTotal : undefined;
        const maxAdverseR = riskTotal && riskTotal > 0 ? -(maeAbs * unit) / riskTotal : undefined;

        // undefined (not 0) when the trade never went in favour - nothing to capture
        const efficiency =
            mfeAbs > 0 ? Math.max(0, (long ? price - pos.avgPrice : pos.avgPrice - price)) / mfeAbs : undefined;

        const peakValue = mfeAbs * unit;
        const maxDrawdownAbs = Math.max(0, peakValue - (gross - fees));

        this.trades.push({
            id: this.trades.length + 1,
            side: pos.side as Exclude<Side, 'flat'>,
            qty: closing,
            entryTs: pos.entryTs,
            entryPrice: pos.avgPrice,
            exitTs: bar.ts,
            exitPrice: price,
            pnl: net,
            pnlGross: gross,
            pnlPct: notional > 0 ? net / notional : 0,
            fees,
            commission: fees,
            slippage: this.slippageCost(closing) * 2,
            bars: this.index - pos.entryIndex,
            durationNs: bar.ts - pos.entryTs,
            tag: pos.tag,
            reason,
            ...(ambiguous ? { ambiguousExit: true } : {}),

            maeAbs,
            mfeAbs,
            maePnl: maeAbs * unit,
            mfePnl: mfeAbs * unit,
            mfeTs: pos.mfeTs,
            maeTs: pos.maeTs,
            barsToMfe: pos.mfeIndex - pos.entryIndex,

            initialRiskPerUnit: risk,
            initialRiskTotal: riskTotal,
            realizedR,
            maxFavorableR,
            maxAdverseR,
            efficiency,

            maxDrawdownAbs,
            maxDrawdownPct: peakValue > 0 ? maxDrawdownAbs / peakValue : 0,

            sl: pos.sl,
            tp: pos.tp,
        });

        if (closing >= pos.qty) {
            this.pos = null;
            this.barsInPosition = 0;
        } else {
            pos.qty -= closing;
        }
    }

    private checkBrackets(bar: StrategyBar): void {
        const pos = this.pos!;
        if (pos.sl == null && pos.tp == null) return;

        const slip = this.cfg.slippageTicks * this.cfg.tickSize;
        const long = pos.side === 'long';

        const stopHit = pos.sl != null && (long ? bar.low <= pos.sl : bar.high >= pos.sl);
        const targetHit = pos.tp != null && (long ? bar.high >= pos.tp : bar.low <= pos.tp);

        // both in one bar: can't say which came first, so the stop wins - counted,
        // since that's how much of the result rests on the assumption
        const ambiguous = stopHit && targetHit;
        if (ambiguous) this.ambiguousExits++;

        if (stopHit) {
            const gapped = long ? Math.min(pos.sl!, bar.open) : Math.max(pos.sl!, bar.open);
            this.exit(bar, long ? gapped - slip : gapped + slip, 'stop', undefined, ambiguous);
            return;
        }
        if (targetHit) {
            this.exit(bar, pos.tp!, 'target');
        }
    }

    private trackExcursion(bar: StrategyBar): void {
        const pos = this.pos!;

        if (bar.high > pos.highWatermark) {
            pos.highWatermark = bar.high;
            if (pos.side === 'long') {
                pos.mfeIndex = this.index;
                pos.mfeTs = bar.ts;
            } else {
                pos.maeIndex = this.index;
                pos.maeTs = bar.ts;
            }
        }

        if (bar.low < pos.lowWatermark) {
            pos.lowWatermark = bar.low;
            if (pos.side === 'long') {
                pos.maeIndex = this.index;
                pos.maeTs = bar.ts;
            } else {
                pos.mfeIndex = this.index;
                pos.mfeTs = bar.ts;
            }
        }
    }

    private commissionFor(qty: number): number {
        return this.cfg.commission * qty;
    }

    private unrealized(): number {
        if (!this.pos) return 0;
        const dir = this.pos.side === 'long' ? 1 : -1;
        return (
            (this.markPrice - this.pos.avgPrice) * dir * this.pos.qty * this.cfg.contractSize
        );
    }

    private computeStats(): StrategyStats {
        const t = this.trades;
        const cap = this.cfg.initialCapital;

        let grossProfit = 0;
        let grossLoss = 0;
        let wins = 0;
        let losses = 0;
        let breakEvens = 0;
        let largestWin = 0;
        let largestLoss = 0;

        let winBars = 0;
        let lossBars = 0;
        let totalTradeBars = 0;

        let winStreak = 0;
        let lossStreak = 0;
        let maxWinStreak = 0;
        let maxLossStreak = 0;

        let rSum = 0;
        let rCount = 0;
        let effSum = 0;
        let effCount = 0;
        let maeSum = 0;
        let mfeSum = 0;

        let longTrades = 0;
        let shortTrades = 0;
        let longWins = 0;
        let shortWins = 0;
        let longPnl = 0;
        let shortPnl = 0;

        let totalCommission = 0;
        let grossBeforeCosts = 0;

        for (const trade of t) {
            if (trade.pnl > 0) {
                grossProfit += trade.pnl;
                wins++;
                winBars += trade.bars;
                winStreak++;
                lossStreak = 0;
                if (trade.pnl > largestWin) largestWin = trade.pnl;
            } else if (trade.pnl < 0) {
                grossLoss += trade.pnl;
                losses++;
                lossBars += trade.bars;
                lossStreak++;
                winStreak = 0;
                if (trade.pnl < largestLoss) largestLoss = trade.pnl;
            } else {
                breakEvens++;
                // a scratch breaks both streaks rather than extending either
                winStreak = 0;
                lossStreak = 0;
            }
            if (winStreak > maxWinStreak) maxWinStreak = winStreak;
            if (lossStreak > maxLossStreak) maxLossStreak = lossStreak;

            totalTradeBars += trade.bars;
            maeSum += trade.maeAbs;
            mfeSum += trade.mfeAbs;
            totalCommission += trade.commission;
            grossBeforeCosts += trade.pnlGross;

            if (trade.realizedR !== undefined) {
                rSum += trade.realizedR;
                rCount++;
            }
            if (trade.efficiency !== undefined) {
                effSum += trade.efficiency;
                effCount++;
            }

            if (trade.side === 'long') {
                longTrades++;
                longPnl += trade.pnl;
                if (trade.pnl > 0) longWins++;
            } else {
                shortTrades++;
                shortPnl += trade.pnl;
                if (trade.pnl > 0) shortWins++;
            }
        }

        const maxDd = this.maxDdAbs;
        const maxDdPct = this.maxDdPct;
        const ulcerSum = this.ulcerSum;

        const finalEquity = this.lastEquity ?? cap;
        const netPnl = finalEquity - cap;
        const returnPct = cap > 0 ? netPnl / cap : 0;

        const avgWin = wins ? grossProfit / wins : 0;
        const avgLoss = losses ? grossLoss / losses : 0;
        const winRate = t.length ? wins / t.length : 0;

        const pnls = t.map((x) => x.pnl);
        const years = this.runYears();

        return {
            netPnl,
            grossProfit,
            grossLoss,
            profitFactor:
                grossLoss === 0 ? (grossProfit > 0 ? Infinity : 0) : grossProfit / -grossLoss,
            totalTrades: t.length,
            wins,
            losses,
            winRate,
            avgWin,
            avgLoss,
            expectancy: t.length ? (grossProfit + grossLoss) / t.length : 0,
            maxDrawdown: maxDd,
            maxDrawdownPct: maxDdPct,
            sharpe: this.sharpe(),
            returnPct,
            exposure: this.barCount ? this.barsInPositionTotal() / this.barCount : 0,
            finalEquity,

            largestWin,
            largestLoss,
            medianPnl: median(pnls),
            payoffRatio: avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : avgWin > 0 ? Infinity : 0,
            breakEvens,

            maxWinStreak,
            maxLossStreak,
            currentStreak: winStreak > 0 ? winStreak : -lossStreak,

            avgBarsHeld: t.length ? totalTradeBars / t.length : 0,
            avgWinBarsHeld: wins ? winBars / wins : 0,
            avgLossBarsHeld: losses ? lossBars / losses : 0,
            totalBars: this.barCount,

            sortino: this.sortino(),
            calmar: maxDdPct > 0 && years > 0 ? this.cagr(years) / maxDdPct : 0,
            recoveryFactor: maxDd > 0 ? netPnl / maxDd : 0,
            ulcerIndex: this.equityCount ? Math.sqrt(ulcerSum / this.equityCount) : 0,
            sqn: sqn(pnls),
            kelly:
                avgLoss !== 0
                    ? winRate - (1 - winRate) / (avgWin / Math.abs(avgLoss))
                    : 0,
            cagr: this.cagr(years),

            tradesWithRisk: rCount,
            avgR: rCount ? rSum / rCount : 0,
            totalR: rSum,
            avgEfficiency: effCount ? effSum / effCount : 0,

            avgMae: t.length ? maeSum / t.length : 0,
            avgMfe: t.length ? mfeSum / t.length : 0,

            longTrades,
            shortTrades,
            longWinRate: longTrades ? longWins / longTrades : 0,
            shortWinRate: shortTrades ? shortWins / shortTrades : 0,
            longPnl,
            shortPnl,

            totalFees: totalCommission,
            totalCommission,
            totalSlippage: this.slippagePaid,
            grossPnlBeforeCosts: grossBeforeCosts,

            intrabarBars: this.intrabarBars,
            intrabarFallbacks: this.intrabarFallbacks,
            ambiguousExits: this.ambiguousExits,
        };
    }

    private runYears(): number {
        if (this.equityCount < 2 || this.firstTs === null) return 0;
        const ns = this.lastTs - this.firstTs;
        return ns > 0n ? Number(ns) / 31_536_000_000_000_000 : 0;
    }

    private cagr(years: number): number {
        const cap = this.cfg.initialCapital;
        if (years <= 0 || cap <= 0) return 0;
        const finalEquity = this.lastEquity ?? cap;
        if (finalEquity <= 0) return -1;
        return Math.pow(finalEquity / cap, 1 / years) - 1;
    }

    private sortino(): number {
        if (this.retN < 2 || this.barNs <= 0n) return 0;
        if (!this.downCount) return 0;

        const downDev = Math.sqrt(this.downSum / this.downCount);
        if (downDev === 0) return 0;

        const barsPerYear = Number(31_536_000_000_000_000n / this.barNs);
        return (this.retMean / downDev) * Math.sqrt(barsPerYear);
    }

    private barsInPositionTotal(): number {
        let n = 0;
        for (const trade of this.trades) n += trade.bars;
        if (this.pos) n += this.barsInPosition;
        return n;
    }

    private sharpe(): number {
        if (this.equityCount < 3 || this.barNs <= 0n) return 0;
        if (this.retN < 2) return 0;

        // sample deviation, n-1, which is what Welford's M2 divides to
        const sd = Math.sqrt(this.retM2 / (this.retN - 1));
        if (sd === 0) return 0;

        const barsPerYear = Number(31_536_000_000_000_000n / this.barNs);
        return (this.retMean / sd) * Math.sqrt(barsPerYear);
    }
}
