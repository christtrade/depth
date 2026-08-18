// the data contracts for the trading layer. nothing here depends on React, the
// chart or any particular broker - these flow through the whole system, from a
// broker or engine as Order/Position/Fill, through useTradingState, out as the
// TradeLines the chart draws.
export type OrderSide = 'long' | 'short';
export type PositionSide = 'long' | 'short' | 'flat';

export type OrderType = 'market' | 'limit' | 'stop' | 'stop_limit';

export type OrderStatus =
    | 'pending' // submitted, not yet acknowledged
    | 'working' // resting in the book / active
    | 'partial' // partially filled, still working
    | 'filled' // completely filled
    | 'cancelled' // cancelled before fully filled
    | 'rejected'; // rejected by the exchange/broker

export type PositionStatus = 'open' | 'closed' | 'partially_closed';

export type TimeInForce = 'gtc' | 'day' | 'ioc' | 'fok' | 'gtd';

export type CloseReason = 'manual' | 'tp' | 'sl' | 'order' | 'market' | 'limit' | 'stop';

// Cost configs
export type CommissionConfig = {
    type: 'fixed' | 'percent';
    /** fixed: $ per fill - percent: % of notional */
    value: number;
};

export type SlippageConfig = {
    type: 'ticks' | 'percent';
    /** ticks: number of ticks - percent: % of price */
    value: number;
};

// Bracket level
//
// A single TP or SL target on a position.
// qty lets you partially take profit or scale out:
//   e.g. TP1: 2 contracts at 19 950, TP2: 3 contracts at 20 000
//
// Invariants enforced by the engine (not this type):
//   - Sum of tp qty should not exceed position remainingQuantity.
//   - Sum of sl qty should not exceed position remainingQuantity.

export type BracketLevel = {
    /** Stable id - use nanoid(). Lets the engine match broker updates without
     *  relying on array position. Required when round-tripping through a broker. */
    id: string;
    /** Price to trigger the TP or SL order. */
    price: number;
    /** Contracts / shares to close at this level. Must be > 0. */
    qty: number;
    /** Set by the engine when the bracket order is triggered. */
    triggered: boolean;
    /** Unix ns when triggered. 0 = not yet triggered. */
    triggeredAt: number;
};

// Order
export type BracketSpec = {
    takeProfits?: BracketLevel[];
    stopLosses?: BracketLevel[];
};

export type Order = {
    // Identity
    id: string;
    symbol: string;

    // Order params
    side: OrderSide;
    type: OrderType;
    /** Total order quantity (contracts / shares). Always positive. */
    quantity: number;
    /** Limit price - required for 'limit' and 'stop_limit'. */
    price: number;
    /** Stop trigger price - required for 'stop' and 'stop_limit'. */
    stopPrice: number;
    tif: TimeInForce;

    // Execution modifiers
    /** If true, will only reduce an existing position; will never open or flip. */
    reduceOnly: boolean;
    /** Apply reduce logic to this specific position first (multi-position setups). */
    targetPositionId?: string;
    /** Bracket to attach to the position this order opens. */
    bracket: BracketSpec;

    // State
    status: OrderStatus;
    filledQuantity: number;
    /** Volume-weighted average fill price. */
    avgPrice: number;
    /** Internal flag for STOP_LIMIT - set by engine when stop is triggered. */
    triggered: boolean;

    // Timestamps
    createdAt: number; // unix ns
    updatedAt: number; // unix ns

    // Cost tracking
    fees: number;
    commission: number;
    slippage: number;

    metadata: Record<string, any>;
};

// Fill
export type Fill = {
    id: string;
    orderId: string;
    symbol: string;
    side: OrderSide;
    price: number;
    quantity: number;
    ts: number; // unix ns
    fee: number;
    feeCurrency: string;
    /** Id of the position opened by this fill. */
    openedPositionId?: string;
    /** Ids of positions reduced by this fill. */
    reducedPositionIds?: string[];
};

// Position close record
//
// One entry per partial or full close. Aggregating closes[] gives the full
// trade history for a position without needing to replay fills.

export type PositionClose = {
    timestamp: number; // unix ns
    price: number;
    quantity: number;
    /** Gross PnL for this close (price diff x qty x tickValue). */
    pnl: number;
    /** Net PnL after per-close costs and allocated open-leg costs. */
    pnlNet: number;
    reason: CloseReason;
    // Linkage back to the source order / bracket level
    orderId: string;
    orderType: OrderType;
    tpId?: string; // BracketLevel.id of the TP that triggered this close
    slId?: string; // BracketLevel.id of the SL that triggered this close
    /** Realized risk-reward ratio after this close. */
    realizedRRAfter: number;
    // Per-close costs
    fees: number;
    commission: number;
    slippage: number;
    spread: number;
    /** Portion of open-leg costs allocated to this close (for auditing). */
    openCostAllocated?: number;
    notes?: object[];
    tags?: object[];
};

// Position
export type Position = {
    // Identity
    id: string;
    symbol: string;
    side: PositionSide;
    type: OrderType;
    status: PositionStatus;

    // Size
    /** Quantity at open. Immutable after creation. */
    startingQuantity: number;
    /** Current open quantity (startingQuantity minus qty from closes[]). */
    remainingQuantity: number;

    // Prices
    /** Volume-weighted average entry price. */
    entryPrice: number;
    /** Mark price for live PnL - updated by tick(). */
    currentPrice?: number;

    // PnL
    unrealizedPnl: number;
    unrealizedPnlPct: number;
    /** Cumulative gross realized PnL across all closes[]. */
    realizedPnl: number;

    // Risk / reward
    /** Initial risk per unit (|entry - initialSL|). Set once at open. */
    initialRiskPerUnit: number;
    /** Total initial risk (initialRiskPerUnit x startingQuantity). */
    initialRiskTotal: number;
    /** Unix ns when initialRisk was locked in. 0 = not yet locked. */
    initialRiskLockedAt: number;
    /** Intended RR at open (set by the user pre-trade). */
    initialRR: number;
    /** Running realized RR (realizedPnl / initialRiskTotal). */
    realizedRR: number;
    /** Best realized RR reached while the position was open. */
    maxFavorableR: number;
    /** Worst realized RR reached while the position was open. */
    maxAdverseR: number;

    // Excursion / drawdown tracking
    /** Highest mark price seen (long) / lowest mark price seen (short). */
    highWatermark: number;
    /** Lowest mark price seen (long) / highest mark price seen (short). */
    lowWatermark: number;
    /** Maximum adverse excursion - worst price against the position. */
    maeAbs: number;
    /** Maximum favorable excursion - best price in favour. */
    mfeAbs: number;
    /** Largest drawdown from the high-watermark in price units. */
    maxDrawdownAbs: number;
    maxDrawdownPct: number;

    // Bracket levels
    takeProfits: BracketLevel[];
    stopLosses: BracketLevel[];
    /** Break-even level - single price, does not close quantity. */
    bePrice?: number;

    // Close history
    /** One entry per partial or full close. */
    closes: PositionClose[];

    // Cost tracking
    spread: number;
    feesTotal: number;
    commissionTotal: number;
    slippageTotal: number;
    /** (commission_open + fees_open) / startingQuantity - for proportional allocation on partial closes. */
    openCostPerUnit: number;
    openCostTotal: number;

    // Timestamps
    openedAt: number; // unix ns of first fill
    closedAt?: number; // unix ns - set when status transitions to 'closed'
    updatedAt: number; // unix ns

    // Annotations
    notes?: object[];
    tags?: object[];
    checklist?: object[];
    rating?: number;
    emotion?: object[];
    images?: object[];
    tradeType?: string;
    confidence?: number;
    playbookAdherence?: number;
    metadata?: Record<string, any>;
};

// Create / close params
export type CreatePositionParams = {
    symbol: string;
    side: PositionSide;
    type: OrderType;
    entryPrice: number;
    quantity: number;
    timestamp: number;
    takeProfits?: Array<{ price: number; qty: number }>;
    stopLosses?: Array<{ price: number; qty: number }>;
    metadata: Record<string, any>;
    notes?: object[];
    tags?: object[];
    checklist?: object[];
    rating?: number;
    emotion?: object[];
    images?: object[];
    confidence?: number;
    playbookAdherence?: number;
    tradeType?: string;
};

export type ClosePositionParams = {
    positionId: string;
    price: number;
    /** Defaults to full remainingQuantity if omitted. */
    quantity: number;
    timestamp: number;
    reason: CloseReason;
    orderId?: string;
    orderType?: OrderType;
    tpId?: string;
    slId?: string;
    fees: number;
    commission: number;
    slippage: number;
};

export type CreateOrderParams = {
    symbol: string;
    side: OrderSide;
    type: OrderType;
    quantity: number;
    price: number;
    stopPrice: number;
    tif: TimeInForce;
    reduceOnly: boolean;
    timestamp: number;
    targetPositionId?: string;
    bracket?: BracketSpec;
    metadata: Record<string, any>;
    fees: number;
    commission: number;
    slippage: number;
    notes?: object[];
    tags?: object[];
};

// Tick
export type PriceTick = {
    symbol: string;
    bid: number;
    ask: number;
    last?: number;
    ts: number; // unix ns
};

// Bracket amendment event
export type BracketAmendment = {
    positionId: string;
    which: 'tp' | 'sl' | 'be';
    /** 0-based array index in takeProfits / stopLosses. */
    index: number;
    /** BracketLevel.id */
    levelId: string;
    price: number;
    qty: number;
    /**
     * Drop this level instead of repricing it (the x on a TP/SL line).
     *
     * Removal goes through the same call as a move on purpose: whoever is
     * managing the position - the built-in engine or a broker adapter - has to
     * hear about it, or the level stays armed after the user has taken it off
     * the chart. `price` and `qty` are ignored when this is set.
     */
    remove?: boolean;
};

// Trading events
export type TradingEventKind =
    | 'order:placed'
    | 'order:updated'
    | 'order:cancelled'
    | 'order:filled'
    | 'order:rejected'
    | 'position:opened'
    | 'position:updated'
    | 'position:closed'
    | 'fill:received';

export type TradingEvent =
    | { kind: 'order:placed'; order: Order }
    | { kind: 'order:updated'; order: Order }
    | { kind: 'order:cancelled'; order: Order }
    | { kind: 'order:filled'; order: Order; fill: Fill }
    | { kind: 'order:rejected'; order: Order; reason?: string }
    | { kind: 'position:opened'; position: Position }
    | { kind: 'position:updated'; position: Position }
    | { kind: 'position:closed'; position: Position; realizedPnl: number }
    | { kind: 'fill:received'; fill: Fill };

// Persistence snapshot
export type PositionsSnapshot = {
    positions: Position[];
    orders: Order[];
    positionCounter: number;
    orderCounter: number;
    lastState: {
        lastPriceBySymbol: Record<string, number>;
        lastSpreadBySymbol: Record<string, number>;
        lastBarEndBySymbol: Record<string, number>;
        currentTimeBySymbol: Record<string, number>;
        tradeCosts: {
            commission: CommissionConfig;
            slippage: SlippageConfig;
            fees: number;
        };
        defaultNonFuturesTickSize?: number;
    };
};

// PnL computation
/**
 * What one point is worth on one contract, for a symbol with no spec attached.
 *
 * Micros are tested first: every micro's ticker contains its mini's, so "MNQ"
 * matched the NQ branch and a micro trade was valued at ten times its size.
 * A symbol that carries a `ContractSpec` never reaches here - this is only the
 * floor under adapters that supply nothing.
 */
export function getTickValue(symbol: string): number {
    const upper = symbol.toUpperCase();
    if (upper.includes('MNQ')) return 2;
    if (upper.includes('MES')) return 5;
    if (upper.includes('NQ')) return 20;
    if (upper.includes('ES')) return 50;
    return 1;
}

export function calcUnrealizedPnl(
    position: Position,
    markPrice: number,
    tickValue: number,
): number {
    const dir = position.side === 'long' ? 1 : -1;
    return dir * (markPrice - position.entryPrice) * position.remainingQuantity * tickValue;
}

export function calcUnrealizedPnlPct(
    position: Position,
    markPrice: number,
    tickValue: number,
): number {
    if (position.entryPrice === 0) return 0;
    return (
        calcUnrealizedPnl(position, markPrice, tickValue) /
        (position.entryPrice * position.remainingQuantity)
    );
}

// Formatting
export function formatPnl(pnl: number, decimals = 2): string {
    const sign = pnl >= 0 ? '+' : '';
    return `${sign}$${Math.abs(pnl).toFixed(decimals)}`;
}

export function formatPnlPct(pct: number): string {
    const sign = pct >= 0 ? '+' : '';
    return `${sign}${(pct * 100).toFixed(2)}%`;
}
