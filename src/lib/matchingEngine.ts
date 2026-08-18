import { nanoid } from 'nanoid';
import type { UseTradingStateReturn } from '../hooks/useTradingState';
import type {
    Order,
    Fill,
    Position,
    PositionClose,
    BracketLevel,
    BracketAmendment,
    PriceTick,
    CloseReason,
    OrderType,
    OrderSide,
} from './types/trading-types';
import { getTickValue, calcUnrealizedPnl, calcUnrealizedPnlPct } from './types/trading-types';
import type { MboEvent, PriceHistory } from './types';
import type { OhlcvBar, SymbolInfo } from '../interfaces/IDataAdapter';
import type { SerialTrade } from './types';
import { CompactBuffer, createCompactBuffer, getEvent, getTsNs } from './compact-buffer';
import { TypedEventBus } from '../core';
import { notifyPositionClosed } from './notifications/tradeToast';
// add an entry here to teach sanitizeMetadata about a new symbol
interface SymbolConfig {
    enginePerDisplayUnit: number;
    uom: string;
    contractType: string | number;
    priceScale: number;
    symbolType: 'future' | 'equity' | 'forex' | 'crypto';
    tickSize: number;
    tickValue: number;
}

const SYMBOL_CONFIGS: Record<string, SymbolConfig> = {
    NQ: {
        enginePerDisplayUnit: 20,
        uom: 'Contracts',
        contractType: 'Full',
        priceScale: 100,
        symbolType: 'future',
        tickSize: 0.25,
        tickValue: 5,
    },
    MNQ: {
        // $2 a point - one tenth of NQ, which is what a micro is.
        enginePerDisplayUnit: 2,
        uom: 'Contracts',
        contractType: 'Micro',
        priceScale: 100,
        symbolType: 'future',
        tickSize: 0.25,
        tickValue: 0.5,
    },
    ES: {
        enginePerDisplayUnit: 50,
        uom: 'Contracts',
        contractType: 'Full',
        priceScale: 100,
        symbolType: 'future',
        tickSize: 0.25,
        tickValue: 12.5,
    },
    MES: {
        enginePerDisplayUnit: 5,
        uom: 'Contracts',
        contractType: 'Micro',
        priceScale: 100,
        symbolType: 'future',
        tickSize: 0.25,
        tickValue: 1.25,
    },
    DEFAULT: {
        enginePerDisplayUnit: 1,
        uom: 'Units',
        contractType: 'Standard',
        priceScale: 100,
        symbolType: 'equity',
        tickSize: 0.01,
        tickValue: 1,
    },
};

// matches by case-insensitive substring, so "NQH6" resolves to the NQ entry.
// longest key first, because every micro's ticker contains its mini's - in
// declaration order "MNQH6" hits NQ and gets priced as a full contract.
const SYMBOL_CONFIG_KEYS = Object.keys(SYMBOL_CONFIGS)
    .filter((key) => key !== 'DEFAULT')
    .sort((a, b) => b.length - a.length);

function resolveSymbolConfig(symbol: string): SymbolConfig {
    const upper = symbol.toUpperCase();
    for (const key of SYMBOL_CONFIG_KEYS) {
        if (upper.includes(key)) return SYMBOL_CONFIGS[key];
    }
    return SYMBOL_CONFIGS.DEFAULT;
}

// full metadata for a position or order. never guesses - it all comes from the
// registry above, and a caller's own meta is spread last so overrides win.
export function sanitizeMetadata(
    meta: Record<string, unknown> | undefined,
    symbol: string,
    quantity: number,
    symbolInfo?: SymbolInfo | null,
): Record<string, unknown> {
    if (symbolInfo) {
        const minTick = symbolInfo.priceFormat?.minTick ?? 0.01;
        const multiplier = symbolInfo.contract?.multiplier ?? 1;
        const uom = symbolInfo.type === 'future' ? 'Contracts' : 'Shares';
        return {
            enginePerDisplayUnit: 1,
            uom,
            contractType: symbolInfo.type,
            displayQty: quantity,
            priceScale: 100,
            symbolType: symbolInfo.type,
            tickSize: minTick,
            tickValue: minTick * multiplier,
            // session is optional, and an absent one means 24/7 not a crash
            timezone: symbolInfo.session?.timezone ?? symbolInfo.timezone ?? 'UTC',
            ...(meta ?? {}),
        };
    }
    const cfg = resolveSymbolConfig(symbol);
    return {
        enginePerDisplayUnit: cfg.enginePerDisplayUnit,
        uom: cfg.uom,
        contractType: cfg.contractType,
        displayQty: quantity / cfg.enginePerDisplayUnit,
        priceScale: cfg.priceScale,
        symbolType: cfg.symbolType,
        tickSize: cfg.tickSize,
        tickValue: cfg.tickValue,
        ...(meta ?? {}),
    };
}
//  Fee schedule
export interface FeeSchedule {
    /** CME exchange fee per contract per side (e.g. NQ: $0.85). */
    exchangeFeePerContract: number;
    /** Broker commission per contract per side. */
    commissionPerContract: number;
    /** NFA regulatory fee per contract (one-way). */
    nfaFeePerContract: number;
    /** Clearing fee per contract. */
    clearingFeePerContract: number;
}

export const NQ_FEE_SCHEDULE: FeeSchedule = {
    exchangeFeePerContract: 0.85,
    commissionPerContract: 2.25,
    nfaFeePerContract: 0.02,
    clearingFeePerContract: 0.35,
};

// a micro costs about a quarter of its mini, not a tenth. fees are per
// contract, so a micro on the mini's schedule pays $3.47 a side to control $2 a
// point - ten of them would cost ten times the one NQ they add up to, and
// sizing down would become the most expensive way to take the same trade.
export const MICRO_FEE_SCHEDULE: FeeSchedule = {
    exchangeFeePerContract: 0.25,
    commissionPerContract: 0.5,
    nfaFeePerContract: 0.02,
    clearingFeePerContract: 0.1,
};

export const ZERO_FEE_SCHEDULE: FeeSchedule = {
    exchangeFeePerContract: 0,
    commissionPerContract: 0,
    nfaFeePerContract: 0,
    clearingFeePerContract: 0,
};

// read off the contract's size rather than its name: anything worth a tenth of
// an e-mini or less is a micro whatever it's called, and a symbol that says
// nothing about its multiplier gets the full schedule - the safe way to be wrong
/** Largest point value still charged as a micro: MES is $5, MNQ $2, MYM $0.50. */
const MICRO_MULTIPLIER_CEILING = 5;

export function feeScheduleFor(symbolInfo?: SymbolInfo | null): FeeSchedule {
    if (symbolInfo?.type !== 'future') return NQ_FEE_SCHEDULE;
    const multiplier = symbolInfo.contract?.multiplier;
    return multiplier !== undefined && multiplier <= MICRO_MULTIPLIER_CEILING
        ? MICRO_FEE_SCHEDULE
        : NQ_FEE_SCHEDULE;
}

function calcCommission(qty: number, schedule: FeeSchedule): number {
    return schedule.commissionPerContract * qty;
}

function calcExchangeFees(qty: number, schedule: FeeSchedule): number {
    return (
        (schedule.exchangeFeePerContract +
            schedule.nfaFeePerContract +
            schedule.clearingFeePerContract) *
        qty
    );
}
//  L3 book shadow
interface Level {
    totalSize: number;
    orders: Map<string, number>; // order_id -> size
}

// sorted price array plus a level map. getBest is O(1), add/remove O(log n).
class SortedBook {
    private readonly prices: number[] = [];
    private readonly levels = new Map<number, Level>();

    getBest(side: 'bid' | 'ask'): number | null {
        if (this.prices.length === 0) return null;
        return side === 'bid' ? this.prices[this.prices.length - 1] : this.prices[0];
    }

    getLevel(price: number): Level | undefined {
        return this.levels.get(price);
    }

    has(price: number): boolean {
        return this.levels.has(price);
    }

    getSortedPrices(): readonly number[] {
        return this.prices;
    }

    getOrCreate(price: number): Level {
        let level = this.levels.get(price);
        if (!level) {
            level = { totalSize: 0, orders: new Map() };
            this.levels.set(price, level);
            this._insertPrice(price);
        }
        return level;
    }

    removeLevel(price: number): void {
        this.levels.delete(price);
        this._removePrice(price);
    }

    clear(): void {
        this.prices.length = 0;
        this.levels.clear();
    }

    private _insertPrice(price: number): void {
        let lo = 0;
        let hi = this.prices.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (this.prices[mid] < price) lo = mid + 1;
            else hi = mid;
        }
        this.prices.splice(lo, 0, price);
    }

    private _removePrice(price: number): void {
        let lo = 0;
        let hi = this.prices.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            if (this.prices[mid] === price) {
                this.prices.splice(mid, 1);
                return;
            }
            if (this.prices[mid] < price) lo = mid + 1;
            else hi = mid - 1;
        }
    }
}
//  Queue position tracker
interface QueuedOrder {
    order: Order;
    queueAhead: number;
    tradedThrough: number;
    bracketTp?: BracketLevel[];
    bracketSl?: BracketLevel[];
}
//  FIFO lot queue
interface Lot {
    side: OrderSide;
    qty: number;
    price: number;
    /** Entry fee allocated to this lot (per-unit). */
    feePerUnit: number;
    commissionPerUnit: number;
}
//  Engine options & public interfaces
export interface L3EngineOptions {
    symbolInfo?: SymbolInfo;
    tickSize?: number;
    fees?: FeeSchedule;
    fillLatencyMs?: number;
    /** 'net' = CME-style futures netting. 'hedge' = independent positions. */
    nettingMode?: 'net' | 'hedge';
    marketSlippageTicks?: number;
    eventBus?: TypedEventBus;
}

export type FillAmbiguity = 'pessimistic' | 'optimistic';

export interface FillSearchOptions {
    /** When false, jumps skip fill evaluation entirely (fast navigation). */
    enabled: boolean;
    /**
     * Cap on how fine the skipped span is evaluated, as a function of the jumped
     * span (ns). Bounds the work for huge jumps (e.g. a month -> hourly bars).
     * Returns a barNs. This is what keeps gap settlement from fetching the
     * highest granularity over a long span.
     */
    maxResolution: (spanNs: bigint) => bigint;
    /**
     * Tie-break when a single (finest-allowed) bar's range contains conflicting
     * triggers - e.g. both a stop-loss and a take-profit. 'pessimistic' assumes
     * the worse (stop) side filled first. OHLC alone can't disambiguate intrabar
     * order, so this is a policy, not ground truth.
     */
    ambiguity: FillAmbiguity;
}

export const DEFAULT_FILL_SEARCH: FillSearchOptions = {
    enabled: true,
    // keeps the evaluated bar count bounded - finer for short jumps, coarser for
    // long ones, on roughly a thousand-bar budget
    maxResolution: (spanNs) => {
        const DAY = 86_400_000_000_000n;
        if (spanNs <= DAY) return 60_000_000_000n; // 1m
        if (spanNs <= 7n * DAY) return 300_000_000_000n; // 5m
        if (spanNs <= 31n * DAY) return 3_600_000_000_000n; // 1h
        return 86_400_000_000_000n; // 1d
    },
    ambiguity: 'pessimistic',
};

export interface PlaceOrderRequest {
    side: OrderSide;
    type: OrderType;
    qty: number;
    limitPrice?: number;
    stopPrice?: number;
    tif?: Order['tif'];
    bracketTp?: BracketLevel[];
    bracketSl?: BracketLevel[];
    symbol?: string;
    reduceOnly?: boolean;
    targetPositionId?: string;
    metadata?: Record<string, unknown>;
}

export interface L3MatchingEngine {
    onMboEvent: (event: MboEvent, tsNs: bigint) => void;
    onTick: (tick: PriceTick) => void;
    /** L3 path: ingest a compact buffer and then use seekTo to replay. */
    ingestCompactBuf: (buf: ArrayBuffer) => void;
    /** OHLCV path: ingest bars; seekTo advances bar by bar. Resets the replay cursor. */
    ingestOhlcvBars: (bars: OhlcvBar[], barNs?: bigint) => void;
    /**
     * OHLCV path: extend the buffer forward without rewinding the replay.
     * What a stream-append must use - see appendOhlcvBars for why.
     */
    appendOhlcvBars: (bars: OhlcvBar[], barNs?: bigint) => void;
    /** OHLCV path: ingest finer-resolution bars so seekTo uses accurate mark prices within the open bar. */
    ingestSupplementalBars?: (
        bars: Array<{
            time: number;
            open: number;
            high: number;
            low: number;
            close: number;
            volume: number;
        }>,
    ) => void;
    /** Cursor-preserving counterpart of ingestSupplementalBars. */
    appendSupplementalBars?: (
        bars: Array<{
            time: number;
            open: number;
            high: number;
            low: number;
            close: number;
            volume: number;
        }>,
    ) => void;
    /** Tick path: ingest SerialTrades (trade-by-trade); seekTo replays each trade. */
    ingestTicks: (trades: SerialTrade[]) => void;
    /** L2 path: ingest pre-sampled BBO history; seekTo advances snapshot by snapshot. */
    ingestPriceHistory: (history: PriceHistory[]) => void;
    /** Cursor-preserving forms of the three above, for streamed extensions. */
    appendTicks: (trades: SerialTrade[]) => void;
    appendPriceHistory: (history: PriceHistory[]) => void;
    appendCompactBuf: (buf: ArrayBuffer) => void;
    seekTo: (tNs: bigint) => void;
    getPrice: () => number;
    placeOrder: (req: PlaceOrderRequest) => string;
    cancelOrder: (orderId: string) => void;
    amendOrder: (orderId: string, newPrice: number) => void;
    syncPosition: (position: Position) => void;
    syncOrder: (order: Order) => void;
    /**
     * Amend a bracket level on an open position.
     * Accepts a full BracketAmendment (typed) keyed by stable BracketLevel.id.
     */
    amendBracket: (amendment: BracketAmendment) => void;
    closePosition: (positionId: string) => void;
    reversePosition: (positionId: string) => void;
    totalFeesPaid: () => number;
    totalRealizedPnl: () => number;
    /** All orders ever placed - includes working, filled, cancelled, rejected. */
    getOrders: () => Order[];
    /** All fills produced by this engine. */
    getFills: () => Fill[];
    /** All positions that have been fully closed. */
    getPositionHistory: () => Position[];
    /** Configure gap-fill search (jump settlement). Merges into current config. */
    setFillSearch: (patch: Partial<FillSearchOptions>) => void;
    getFillSearch: () => FillSearchOptions;
    /** Cheap gate: is there any resting order / untriggered bracket that could fill? */
    hasPendingTriggers: () => boolean;
    /**
     * Replay a skipped span's bars (fetched at fillSearch.maxResolution) to apply
     * fills the jump would otherwise have skipped. Bars must be time-ascending.
     */
    settleGapBars: (
        bars: Array<{ tsNs: bigint; open: number; high: number; low: number; close: number }>,
        ambiguity?: FillAmbiguity,
    ) => void;
    destroy: () => void;
}
// every required Position field is zero-initialised here. dont build a Position
// literal anywhere else, always come through this.
function buildPosition(params: {
    symbol: string;
    side: 'long' | 'short';
    type: OrderType;
    entryPrice: number;
    quantity: number;
    takeProfits: BracketLevel[];
    stopLosses: BracketLevel[];
    openedAt: number;
    openFee: number;
    openCommission: number;
    metadata?: Record<string, unknown>;
    symbolInfo?: SymbolInfo | null;
}): Position {
    const openCostTotal = params.openFee + params.openCommission;
    const openCostPerUnit = params.quantity > 0 ? openCostTotal / params.quantity : 0;

    // lock initial risk at open when both a tp and sl are already there.
    // lockRiskIfEligible does it later for brackets added after the fact.
    const { initialRR, initialRiskPerUnit, initialRiskLockedAt } = computeInitialRR(
        params.side,
        params.entryPrice,
        params.takeProfits,
        params.stopLosses,
        params.openedAt,
    );

    return {
        id: nanoid(),
        symbol: params.symbol,
        side: params.side,
        type: params.type,
        status: 'open',

        startingQuantity: params.quantity,
        remainingQuantity: params.quantity,

        entryPrice: params.entryPrice,
        currentPrice: params.entryPrice,

        unrealizedPnl: 0,
        unrealizedPnlPct: 0,
        realizedPnl: 0,

        initialRiskPerUnit,
        initialRiskTotal: initialRiskPerUnit * params.quantity,
        initialRiskLockedAt,
        initialRR,
        realizedRR: 0,
        maxFavorableR: 0,
        maxAdverseR: 0,

        highWatermark: params.entryPrice,
        lowWatermark: params.entryPrice,
        maeAbs: 0,
        mfeAbs: 0,
        maxDrawdownAbs: 0,
        maxDrawdownPct: 0,

        takeProfits: params.takeProfits,
        stopLosses: params.stopLosses,
        bePrice: undefined,

        closes: [],

        spread: 0,
        feesTotal: params.openFee,
        commissionTotal: params.openCommission,
        slippageTotal: 0,
        openCostPerUnit,
        openCostTotal,

        openedAt: params.openedAt,
        updatedAt: params.openedAt,

        metadata: sanitizeMetadata(
            params.metadata,
            params.symbol,
            params.quantity,
            params.symbolInfo,
        ),
    };
}
//  RR locking helpers
// locks RR the moment both a tp and sl exist, whether thats at open or the
// first amendBracket that supplies both sides, so initialRR is right for
// intra-bar analysis rather than only settling once a bar closes.
//
// uses the first untriggered tp (the conservative reward proxy) and the first
// untriggered sl (the closest risk proxy).
function computeInitialRR(
    side: 'long' | 'short',
    entryPrice: number,
    takeProfits: BracketLevel[],
    stopLosses: BracketLevel[],
    nowTs: number,
): { initialRR: number; initialRiskPerUnit: number; initialRiskLockedAt: number } {
    const tp = takeProfits.find((t) => !t.triggered);
    const sl = stopLosses.find((s) => !s.triggered);

    if (!tp || !sl) {
        return { initialRR: 0, initialRiskPerUnit: 0, initialRiskLockedAt: 0 };
    }

    if (side === 'long') {
        if (tp.price <= entryPrice || sl.price >= entryPrice) {
            return { initialRR: 0, initialRiskPerUnit: 0, initialRiskLockedAt: 0 };
        }
        const reward = tp.price - entryPrice;
        const risk = entryPrice - sl.price;
        return {
            initialRR: reward / risk,
            initialRiskPerUnit: risk,
            initialRiskLockedAt: nowTs,
        };
    } else {
        if (tp.price >= entryPrice || sl.price <= entryPrice) {
            return { initialRR: 0, initialRiskPerUnit: 0, initialRiskLockedAt: 0 };
        }
        const reward = entryPrice - tp.price;
        const risk = sl.price - entryPrice;
        return {
            initialRR: reward / risk,
            initialRiskPerUnit: risk,
            initialRiskLockedAt: nowTs,
        };
    }
}

// for a position whose brackets were just amended. only re-locks if risk wasnt
// locked already.
function lockRiskIfEligible(pos: Position, nowTs: number): Position {
    if (pos.initialRiskLockedAt > 0) return pos; // already locked - immutable
    if (pos.side === 'flat') return pos;
    const { initialRR, initialRiskPerUnit, initialRiskLockedAt } = computeInitialRR(
        pos.side,
        pos.entryPrice,
        pos.takeProfits,
        pos.stopLosses,
        nowTs,
    );
    if (initialRiskLockedAt === 0) return pos; // still not eligible
    return {
        ...pos,
        initialRR,
        initialRiskPerUnit,
        initialRiskTotal: initialRiskPerUnit * pos.remainingQuantity,
        initialRiskLockedAt,
    };
}

// updates a position's excursion tracking for the [min, max] range visited
// during a tick or candle, and recomputes the R-multiples with it
function updateExcursions(pos: Position, minVisited: number, maxVisited: number): Position {
    if (pos.status === 'closed') return pos;

    let maeAbs = pos.maeAbs;
    let mfeAbs = pos.mfeAbs;
    let highWatermark = pos.highWatermark;
    let lowWatermark = pos.lowWatermark;

    if (pos.side === 'long') {
        maeAbs = Math.max(maeAbs, Math.max(0, pos.entryPrice - minVisited));
        mfeAbs = Math.max(mfeAbs, Math.max(0, maxVisited - pos.entryPrice));
        highWatermark = Math.max(highWatermark, maxVisited);
        lowWatermark = Math.min(lowWatermark, minVisited);
    } else {
        maeAbs = Math.max(maeAbs, Math.max(0, maxVisited - pos.entryPrice));
        mfeAbs = Math.max(mfeAbs, Math.max(0, pos.entryPrice - minVisited));
        highWatermark = Math.max(highWatermark, maxVisited);
        lowWatermark = Math.min(lowWatermark, minVisited);
    }

    const ddPts =
        pos.side === 'long'
            ? Math.max(0, highWatermark - minVisited)
            : Math.max(0, maxVisited - lowWatermark);
    const maxDrawdownAbs = Math.max(pos.maxDrawdownAbs, ddPts * pos.remainingQuantity);
    const entryNotional = pos.entryPrice * pos.startingQuantity;
    const maxDrawdownPct = entryNotional > 0 ? maxDrawdownAbs / entryNotional : 0;

    const rpu = pos.initialRiskPerUnit;
    const maxFavorableR = rpu > 0 ? mfeAbs / rpu : 0;
    const maxAdverseR = rpu > 0 ? maeAbs / rpu : 0;

    return {
        ...pos,
        maeAbs,
        mfeAbs,
        highWatermark,
        lowWatermark,
        maxDrawdownAbs,
        maxDrawdownPct,
        maxFavorableR,
        maxAdverseR,
    };
}
//  Factory
export function createL3MatchingEngine(
    tradingState: UseTradingStateReturn,
    options: L3EngineOptions = {},
): L3MatchingEngine {
    const {
        symbolInfo = null,
        tickSize = 0.25,
        fees = NQ_FEE_SCHEDULE,
        fillLatencyMs = 0,
        nettingMode = 'net',
        marketSlippageTicks = 0,
        eventBus = null,
    } = options;

    const symbol = symbolInfo?.symbol ?? '';
    const resolvedTickSize = symbolInfo?.priceFormat?.minTick ?? tickSize;
    const resolvedTickValue = symbolInfo?.contract?.multiplier ?? getTickValue(symbol);

    // L3 book shadow
    const bidBook = new SortedBook();
    const askBook = new SortedBook();
    const bidOrderIndex = new Map<string, number>();
    const askOrderIndex = new Map<string, number>();
    let bestBid: number | null = null;
    let bestAsk: number | null = null;

    const workingOrders = new Map<string, QueuedOrder>();
    const openPositions = new Map<string, Position>();
    const lotQueues = new Map<string, Lot[]>();

    // Account history
    const allOrders = new Map<string, Order>();
    const positionHistory: Position[] = [];
    const allFills: Fill[] = [];

    let _totalFees = 0;
    let _totalRealizedPnl = 0;

    let lastTick: PriceTick | null = null;
    let destroyed = false;

    // during a seekTo replay the per-tick playback:tick emit is suppressed and a
    // single coalesced one fires at the end of the
    // seek. At high playback speeds a frame replays thousands of ticks; emitting
    // (and allocating a payload) per tick was the dominant source of GC pressure,
    // and the only consumer (AccountSummary) samples on a 250ms timer anyway.
    let _suppressTickEmit = false;

    // Non-L3 data stores
    type SuppBar = {
        tsNs: bigint;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
    };

    type NonL3Mode =
        | {
              kind: 'ohlcv';
              bars: Array<{ tsNs: bigint; bar: OhlcvBar }>;
              suppBars: SuppBar[];
              /** Bar period in ns. Tells a completed bar from the forming one. */
              barNs: bigint;
          }
        | { kind: 'tick'; trades: SerialTrade[] }
        | { kind: 'l2'; history: PriceHistory[] };

    let _nonL3: NonL3Mode | null = null;
    let _nonL3Cursor = 0;
    let _nonL3SuppCursor = 0;
    let _nonL3LastTs = 0n;
    /** Last horizon passed to seekToOhlcv - drives rewind detection there. */
    let _nonL3LastSeekTs = 0n;

    /**
     * Bar period, inferred from the most common gap between consecutive bar
     * opens. Used when the host doesn't pass one to ingestOhlcvBars. Returns 0n
     * when there's too little data to tell, which the caller treats as "assume a
     * bar is complete the moment it opens" - the pre-open-bar behaviour.
     */
    function inferBarNs(bars: Array<{ tsNs: bigint }>): bigint {
        const counts = new Map<bigint, number>();
        for (let i = 1; i < bars.length; i++) {
            const gap = bars[i].tsNs - bars[i - 1].tsNs;
            if (gap <= 0n) continue;
            counts.set(gap, (counts.get(gap) ?? 0) + 1);
        }
        let best = 0n;
        let bestCount = 0;
        for (const [gap, n] of counts) {
            if (n > bestCount) {
                best = gap;
                bestCount = n;
            }
        }
        return best;
    }

    function syncPosition(position: Position): void {
        // A finished trade is history. Putting it back in openPositions arms its
        // brackets again, so the next replay re-closes a position the user
        // already closed - a second "closed in profit" toast, a second realised
        // P&L, on a trade that happened in a previous session.
        if (position.status === 'closed' || position.remainingQuantity <= 0) {
            openPositions.delete(position.id);
            return;
        }
        openPositions.set(position.id, position);
        seededIds.add(position.id);
        pendingSeed = true;
    }
    function syncOrder(order: Order): void {
        // Whether this order arrives from outside the engine's own history.
        // Read before the write below, which would make everything look known.
        const restored = !allOrders.has(order.id);
        allOrders.set(order.id, order);

        // Same rule for orders: filled/cancelled/rejected ones are the account's
        // order history, not resting work. Seeding them into workingOrders left
        // a filled limit sitting on the book, so the first replay past its price
        // filled it a second time - opening a position out of nowhere, which its
        // (still untriggered) brackets then closed. That is the "long opened /
        // closed in profit" pair that greets a restored session on play.
        const terminal =
            order.status === 'filled' ||
            order.status === 'cancelled' ||
            order.status === 'rejected';
        if (terminal) {
            workingOrders.delete(order.id);
            return;
        }

        // only orders the engine didnt place itself need the watermark. this is
        // also the amend path for a resting order, and one the engine has watched
        // since it was placed needs no protection from its own past - re-seeding
        // it would blind it to the bars of the step it was amended in, so a limit
        // could sit through the print that should have filled it
        if (restored) {
            seededIds.add(order.id);
            pendingSeed = true;
        }
        const patch: QueuedOrder = {
            ...workingOrders.get(order.id),
            order,
            // `bracket` is required on a live Order but can be absent on one
            // rebuilt from an older save or handed over by a custom adapter, and
            // this runs on every restore.
            bracketSl: order.bracket?.stopLosses ?? [],
            bracketTp: order.bracket?.takeProfits ?? [],
        };
        workingOrders.set(order.id, patch);
    }
    //  L3 Book maintenance
    function removeFromLevel(book: SortedBook, price: number, orderId: string): number {
        const level = book.getLevel(price);
        if (!level) return 0;
        const size = level.orders.get(orderId) ?? 0;
        level.orders.delete(orderId);
        level.totalSize = Math.max(0, level.totalSize - size);
        if (level.totalSize === 0) book.removeLevel(price);
        return size;
    }
    // Seeded state watermark.
    //
    // positions and orders handed to a fresh engine by syncPosition/syncOrder -
    // restoring a session, or rebuilding when the symbol resolves - already
    // existed in the past. the engine's bar cursor starts at zero though, so the
    // first seek replays the whole loaded window through the fill checks, and a
    // position restored at today's price gets stopped out on a bar from days ago
    // the instant playback starts.
    //
    // neither timestamp on the entities settles it: a position's openedAt is
    // playhead time but an order's placedAt is wall clock, so theyre not
    // comparable to each other or to bar timestamps in a replay. what is known
    // is that everything seeded existed as of the first horizon the engine hears
    // about - thats the watermark, and nothing before it may settle against
    // seeded state.
    /** Ids handed over by syncPosition / syncOrder, still awaiting a watermark. */
    const seededIds = new Set<string>();
    /** Horizon at which the seeded state was known to exist. */
    let seedWatermarkNs: bigint | null = null;
    let pendingSeed = false;

    /** Stamp anything seeded since the last seek with the horizon we just heard. */
    function markSeedWatermark(tNs: bigint): void {
        if (!pendingSeed) return;
        pendingSeed = false;
        // Only ever moves forward: a later re-seed can't un-settle earlier bars.
        if (seedWatermarkNs === null || tNs > seedWatermarkNs) seedWatermarkNs = tNs;
    }

    /** True when this bar/sub-bar predates the point at which `id` was seeded. */
    function predatesSeed(id: string, tsNs: bigint): boolean {
        if (seedWatermarkNs === null) return false;
        if (!seededIds.has(id)) return false;
        return tsNs < seedWatermarkNs;
    }
    //  Range-based fill helpers (used by non-L3 seekTo paths)
    function checkLimitFillsFromRange(low: number, high: number, tsNs: bigint): void {
        for (const [id, qo] of workingOrders) {
            const { order } = qo;
            if (predatesSeed(id, tsNs)) continue;
            // A triggered stop_limit rests as a limit at order.price - fill it too.
            const isLimit =
                order.type === 'limit' || (order.type === 'stop_limit' && order.triggered);
            if (!isLimit) continue;
            const p = order.price;
            const hit = order.side === 'long' ? low <= p : high >= p;
            if (!hit) continue;
            scheduleFill(qo, p, tsNs);
            workingOrders.delete(id);
        }
    }

    function checkStopFillsFromRange(low: number, high: number, tsNs: bigint): void {
        const nowNs = Number(tsNs);
        for (const [id, qo] of workingOrders) {
            const { order } = qo;
            if (predatesSeed(id, tsNs)) continue;
            if (order.type !== 'stop' && order.type !== 'stop_limit') continue;
            // an already-triggered stop_limit is a resting limit now, so skip it -
            // the promote below is a delete+set on the same key and would
            // otherwise re-visit and re-promote it forever
            if (order.type === 'stop_limit' && order.triggered) continue;
            const stopPrice = order.stopPrice;
            const reached = order.side === 'long' ? high >= stopPrice : low <= stopPrice;
            if (!reached) continue;

            const slip = marketSlippageTicks * tickSize;
            if (order.type === 'stop') {
                const fillPrice = snap(order.side === 'long' ? stopPrice + slip : stopPrice - slip);
                scheduleFill(qo, fillPrice, tsNs);
                workingOrders.delete(id);
            } else {
                // stop_limit: promote to a resting limit order
                const limitPrice = order.price ?? stopPrice;
                const promotedOrder: Order = {
                    ...order,
                    triggered: true,
                    status: 'working',
                    updatedAt: nowNs,
                };
                workingOrders.delete(id);
                workingOrders.set(id, {
                    order: promotedOrder,
                    queueAhead: 0,
                    tradedThrough: 0,
                    bracketTp: qo.bracketTp,
                    bracketSl: qo.bracketSl,
                });
                allOrders.set(promotedOrder.id, promotedOrder);
                tradingState.upsertOrder(promotedOrder);
                // Immediately check if the newly promoted limit is already marketable
                checkLimitFillsFromRange(low, limitPrice, tsNs);
            }
        }
    }

    function checkBracketTriggersFromRange(
        low: number,
        high: number,
        tsNs: bigint,
        // when one bar's range straddles both a tp and an sl, ohlc cant say which
        // traded first. pessimistic settles the sl first, the same way in live
        // playback and gap settlement.
        ambiguity: FillAmbiguity = 'pessimistic',
    ): void {
        const nowNs = Number(tsNs);
        for (const pos of openPositions.values()) {
            if (pos.remainingQuantity <= 0) continue;
            // keeps MAE/MFE honest too - excursions over bars from before the
            // position existed arent excursions of that trade
            if (predatesSeed(pos.id, tsNs)) continue;

            const updated = updateExcursions(pos, low, high);
            openPositions.set(pos.id, updated);

            const checkTps = () => {
                for (const tp of updated.takeProfits) {
                    if (tp.triggered) continue;
                    const hit = updated.side === 'long' ? high >= tp.price : low <= tp.price;
                    if (!hit) continue;
                    const cur = openPositions.get(pos.id);
                    if (!cur || cur.remainingQuantity <= 0) break;
                    closePositionInternal(
                        cur,
                        Math.min(tp.qty, cur.remainingQuantity),
                        tp.price,
                        nowNs,
                        'tp',
                        tp.id,
                        undefined,
                    );
                }
            };

            const checkSls = () => checkSlLoop(updated, low, high, nowNs);

            if (ambiguity === 'pessimistic') {
                checkSls();
                checkTps();
            } else {
                checkTps();
                checkSls();
            }
        }
    }

    function checkSlLoop(updated: Position, low: number, high: number, nowNs: number): void {
        for (const sl of updated.stopLosses) {
            if (sl.triggered) continue;
            const hit = updated.side === 'long' ? low <= sl.price : high >= sl.price;
            if (!hit) continue;
            const cur = openPositions.get(updated.id);
            if (!cur || cur.remainingQuantity <= 0) break;
            closePositionInternal(
                cur,
                cur.remainingQuantity,
                sl.price,
                nowNs,
                'sl',
                undefined,
                sl.id,
            );
            break;
        }
    }
    // Gap settlement on jumps. when the horizon skips a span that was never
    // replayed, its bars get evaluated here so resting orders and brackets still
    // fill. the caller fetches the span once at fillSearch.maxResolution - which
    // is bounded for huge jumps - and hands the bars to settleGapBars, which runs
    // the same per-bar logic as live ohlcv playback.
    let _fillSearch: FillSearchOptions = DEFAULT_FILL_SEARCH;

    function setFillSearch(patch: Partial<FillSearchOptions>): void {
        _fillSearch = { ..._fillSearch, ...patch };
    }
    function getFillSearch(): FillSearchOptions {
        return _fillSearch;
    }

    /** True if anything could fill - cheap gate so jumps with no orders do no work. */
    function hasPendingTriggers(): boolean {
        if (workingOrders.size > 0) return true;
        for (const pos of openPositions.values()) {
            if (pos.remainingQuantity <= 0) continue;
            if (pos.takeProfits.some((t) => !t.triggered)) return true;
            if (pos.stopLosses.some((s) => !s.triggered)) return true;
        }
        return false;
    }

    /**
     * Replay a time-ascending set of bars covering a skipped span, applying fills
     * exactly as live playback would - open tick, intrabar range checks, close
     * tick - with bracket ties broken per `ambiguity`. Leaves the replay cursor
     * alone; this is a side pass over the gap only.
     */
    function settleGapBars(
        bars: Array<{ tsNs: bigint; open: number; high: number; low: number; close: number }>,
        ambiguity: FillAmbiguity = _fillSearch.ambiguity,
    ): void {
        if (destroyed) return;
        // a gap settle can be the first thing a freshly seeded engine sees, on a
        // jump straight after a restore, so it pins the watermark too - the span
        // starts at the horizon we were on, which is exactly where the seeded
        // state is known to have existed
        if (bars.length) markSeedWatermark(bars[0].tsNs);
        const hs = tickSize / 2;
        const wasSuppressed = _suppressTickEmit;
        _suppressTickEmit = true;
        try {
            for (const bar of bars) {
                const tsN = Number(bar.tsNs);
                onTick({ symbol, bid: bar.open - hs, ask: bar.open + hs, last: bar.open, ts: tsN });
                checkLimitFillsFromRange(bar.low, bar.high, bar.tsNs);
                checkStopFillsFromRange(bar.low, bar.high, bar.tsNs);
                checkBracketTriggersFromRange(bar.low, bar.high, bar.tsNs, ambiguity);
                if (bar.close !== bar.open) {
                    onTick({
                        symbol,
                        bid: bar.close - hs,
                        ask: bar.close + hs,
                        last: bar.close,
                        ts: tsN,
                    });
                }
            }
        } finally {
            _suppressTickEmit = wasSuppressed;
        }
    }
    //  MBO event processor
    function onMboEvent(event: MboEvent, tsNs: bigint): void {
        if (destroyed) return;

        const { action, side, price, size, order_id } = event;

        if (action === 'R') {
            bidBook.clear();
            askBook.clear();
            bidOrderIndex.clear();
            askOrderIndex.clear();
            bestBid = null;
            bestAsk = null;
            return;
        }

        let restingSide = side;
        if (action === 'T' || action === 'F') {
            restingSide = side === 'B' ? 'A' : 'B';
        }

        const isBid = restingSide === 'B';
        const book = isBid ? bidBook : askBook;

        if (action === 'A') {
            if (price === null) return;
            const level = book.getOrCreate(price);
            const oldSize = level.orders.get(order_id) ?? 0;
            level.totalSize = Math.max(0, level.totalSize - oldSize) + size;
            level.orders.set(order_id, size);
            if (isBid) {
                if (bestBid === null || price > bestBid) bestBid = price;
                bidOrderIndex.set(order_id, price);
            } else {
                if (bestAsk === null || price < bestAsk) bestAsk = price;
                askOrderIndex.set(order_id, price);
            }
        } else if (action === 'C') {
            const actualPrice = isBid ? bidOrderIndex.get(order_id) : askOrderIndex.get(order_id);
            if (actualPrice === undefined) return;
            const removed = removeFromLevel(book, actualPrice, order_id);
            if (removed > 0) {
                isBid ? bidOrderIndex.delete(order_id) : askOrderIndex.delete(order_id);
                if (isBid) bestBid = bidBook.getBest('bid');
                else bestAsk = askBook.getBest('ask');
            }
        } else if (action === 'M') {
            const oldBidPrice = bidOrderIndex.get(order_id);
            const oldAskPrice = askOrderIndex.get(order_id);
            const oldPrice = oldBidPrice ?? oldAskPrice;
            if (oldPrice === undefined) return;

            const isOrderBid = oldBidPrice !== undefined;
            const orderBook = isOrderBid ? bidBook : askBook;
            const orderIndex = isOrderBid ? bidOrderIndex : askOrderIndex;
            const newPrice = price !== null && price !== 0 ? price : oldPrice;

            removeFromLevel(orderBook, oldPrice, order_id);
            const newLevel = orderBook.getOrCreate(newPrice);
            newLevel.orders.set(order_id, size);
            newLevel.totalSize += size;
            orderIndex.set(order_id, newPrice);

            if (isOrderBid) bestBid = bidBook.getBest('bid');
            else bestAsk = askBook.getBest('ask');
        } else if (action === 'T' || action === 'F') {
            const bidPrice = bidOrderIndex.get(order_id);
            const askPrice = askOrderIndex.get(order_id);

            if (bidPrice !== undefined) {
                removeFromLevel(bidBook, bidPrice, order_id);
                bidOrderIndex.delete(order_id);
                bestBid = bidBook.getBest('bid');
            }
            if (askPrice !== undefined) {
                removeFromLevel(askBook, askPrice, order_id);
                askOrderIndex.delete(order_id);
                bestAsk = askBook.getBest('ask');
            }

            if (price !== null) {
                checkQueueFills(price, size, side, tsNs);
                checkBracketTriggers(price, side, tsNs);
            }
        }
    }
    //  Queue fill simulation
    function checkQueueFills(
        tradePrice: number,
        tradeSize: number,
        aggressorSide: string,
        tsNs: bigint,
    ): void {
        for (const [id, qo] of workingOrders) {
            const { order } = qo;
            if (predatesSeed(id, tsNs)) continue;
            // A triggered stop_limit rests as a limit at order.price - fill it too.
            const isLimit =
                order.type === 'limit' || (order.type === 'stop_limit' && order.triggered);
            if (!isLimit) continue;

            const limitPrice = order.price;

            if (order.side === 'long' && aggressorSide === 'A') {
                if (tradePrice < limitPrice) {
                    qo.tradedThrough = Infinity;
                } else if (tradePrice === limitPrice) {
                    qo.tradedThrough += tradeSize;
                } else {
                    continue;
                }
            } else if (order.side === 'short' && aggressorSide === 'B') {
                if (tradePrice > limitPrice) {
                    qo.tradedThrough = Infinity;
                } else if (tradePrice === limitPrice) {
                    qo.tradedThrough += tradeSize;
                } else {
                    continue;
                }
            } else {
                continue;
            }

            if (qo.tradedThrough >= qo.queueAhead) {
                scheduleFill(qo, limitPrice, tsNs);
                workingOrders.delete(id);
            }
        }
    }

    // bracket triggers snap to the tick grid and update excursions/drawdown on
    // the same tick they trigger. partial tp falls out of closePositionInternal.
    function checkBracketTriggers(tradePrice: number, aggressorSide: string, tsNs: bigint): void {
        const nowNs = Number(tsNs);

        for (const pos of openPositions.values()) {
            if (pos.remainingQuantity <= 0) continue;
            // same rule as the range path - a seeded position cant settle against
            // trades from before it was handed to this engine
            if (predatesSeed(pos.id, tsNs)) continue;

            // per trade tick, for accuracy
            const updated = updateExcursions(pos, tradePrice, tradePrice);
            openPositions.set(pos.id, updated);

            // Take profits
            for (const tp of pos.takeProfits) {
                if (tp.triggered) continue;

                const tpHit =
                    pos.side === 'long'
                        ? aggressorSide === 'B' && tradePrice >= tp.price
                        : aggressorSide === 'A' && tradePrice <= tp.price;

                if (!tpHit) continue;

                const current = openPositions.get(pos.id);
                if (!current || current.remainingQuantity <= 0) break;

                const closeQty = Math.min(tp.qty, current.remainingQuantity);
                closePositionInternal(current, closeQty, tp.price, nowNs, 'tp', tp.id, undefined);
            }

            // Stop losses - always flatten full remaining qty
            for (const sl of pos.stopLosses) {
                if (sl.triggered) continue;

                const slHit =
                    pos.side === 'long'
                        ? aggressorSide === 'A' && tradePrice <= sl.price
                        : aggressorSide === 'B' && tradePrice >= sl.price;

                if (!slHit) continue;

                const current = openPositions.get(pos.id);
                if (!current || current.remainingQuantity <= 0) break;

                closePositionInternal(
                    current,
                    current.remainingQuantity,
                    sl.price,
                    nowNs,
                    'sl',
                    undefined,
                    sl.id,
                );
                break; // position is now flat
            }
        }
    }
    //  Stop order trigger
    function checkStopTriggers(tick: PriceTick): void {
        for (const [id, qo] of workingOrders) {
            const { order } = qo;
            if (order.type !== 'stop' && order.type !== 'stop_limit') continue;
            // an already-triggered stop_limit is a resting limit now, so
            // checkQueueFills fills it, not this. skipping it also stops the
            // promote below re-visiting and re-promoting it forever.
            if (order.type === 'stop_limit' && order.triggered) continue;

            const stopPrice = order.stopPrice;
            const triggered = order.side === 'long' ? tick.ask >= stopPrice : tick.bid <= stopPrice;

            if (!triggered) continue;

            if (order.type === 'stop') {
                const slip = marketSlippageTicks * tickSize;
                const fillPrice = order.side === 'long' ? tick.ask + slip : tick.bid - slip;
                scheduleFill(qo, snap(fillPrice), BigInt(tick.ts));
                workingOrders.delete(id);
            } else {
                // stop_limit: promote to a limit order
                const limitPrice = order.price ?? stopPrice;
                const triggeredOrder: Order = {
                    ...order,
                    triggered: true,
                    status: 'working',
                    updatedAt: tick.ts,
                };
                const ourBook = order.side === 'long' ? bidBook : askBook;
                const queueAhead = ourBook.getLevel(limitPrice)?.totalSize ?? 0;

                workingOrders.delete(id);
                workingOrders.set(id, {
                    order: triggeredOrder,
                    queueAhead,
                    tradedThrough: 0,
                    bracketTp: qo.bracketTp,
                    bracketSl: qo.bracketSl,
                });
                allOrders.set(triggeredOrder.id, triggeredOrder);
                tradingState.upsertOrder(triggeredOrder);
            }
        }
    }
    //  Fill execution
    function scheduleFill(qo: QueuedOrder, fillPrice: number, tsNs: bigint): void {
        if (fillLatencyMs <= 0) {
            executeFill(qo, fillPrice, tsNs);
        } else {
            setTimeout(() => executeFill(qo, fillPrice, tsNs), fillLatencyMs);
        }
    }

    function executeFill(qo: QueuedOrder, fillPrice: number, tsNs: bigint): void {
        if (destroyed) return;
        const { order, bracketTp, bracketSl } = qo;

        const remainingQty = order.quantity - order.filledQuantity;
        const fee = calcExchangeFees(remainingQty, fees);
        const commission = calcCommission(remainingQty, fees);
        const totalFee = fee + commission;
        _totalFees += totalFee;

        const fillNs = Number(tsNs);

        // VWAP of fills - prior fills weighted by filledQuantity
        const prevVwapContrib = order.avgPrice * order.filledQuantity;
        const newVwapContrib = fillPrice * remainingQty;
        const newAvgPrice = (prevVwapContrib + newVwapContrib) / order.quantity;

        const fill: Fill = {
            id: nanoid(),
            orderId: order.id,
            symbol: order.symbol,
            side: order.side,
            price: fillPrice,
            quantity: remainingQty,
            ts: fillNs,
            fee: totalFee,
            feeCurrency: 'USD',
        };

        const filledOrder: Order = {
            ...order,
            filledQuantity: order.quantity,
            avgPrice: newAvgPrice,
            status: 'filled',
            fees: fee,
            commission,
            updatedAt: fillNs,
        };

        allOrders.set(filledOrder.id, filledOrder);
        allFills.push(fill);
        tradingState.upsertOrder(filledOrder);
        tradingState.applyFill(fill);

        updatePosition(filledOrder, fillPrice, fee, commission, bracketTp, bracketSl, fillNs);
    }
    //  Position management
    function getLots(sym: string): Lot[] {
        if (!lotQueues.has(sym)) lotQueues.set(sym, []);
        return lotQueues.get(sym)!;
    }

    function updatePosition(
        order: Order,
        fillPrice: number,
        fillFee: number,
        fillCommission: number,
        bracketTp?: BracketLevel[],
        bracketSl?: BracketLevel[],
        nowNs?: number,
    ): void {
        if (nettingMode === 'net') {
            updateNetPosition(
                order,
                fillPrice,
                fillFee,
                fillCommission,
                bracketTp,
                bracketSl,
                nowNs,
            );
        } else {
            openHedgePosition(
                order,
                fillPrice,
                fillFee,
                fillCommission,
                bracketTp,
                bracketSl,
                nowNs,
            );
        }
    }

    // net-mode position update: new position, scale-in, partial close, flip.
    // every close goes through closePositionInternal so the PositionClose record
    // and the cost fields stay consistent across all four.
    function updateNetPosition(
        order: Order,
        fillPrice: number,
        fillFee: number,
        fillCommission: number,
        bracketTp: BracketLevel[] | undefined,
        bracketSl: BracketLevel[] | undefined,
        nowNs: number,
    ): void {
        let existing: Position | undefined;
        for (const pos of openPositions.values()) {
            if (pos.symbol === order.symbol) {
                existing = pos;
                break;
            }
        }

        const lots = getLots(order.symbol);
        const feePerUnit = fillFee / order.quantity;
        const commissionPerUnit = fillCommission / order.quantity;

        // Case 1: No existing position - open new
        if (!existing) {
            for (let i = 0; i < order.quantity; i++) {
                lots.push({
                    side: order.side,
                    qty: 1,
                    price: fillPrice,
                    feePerUnit,
                    commissionPerUnit,
                });
            }

            const pos = buildPosition({
                symbol: order.symbol,
                side: order.side,
                type: order.type,
                entryPrice: fillPrice,
                quantity: order.quantity,
                takeProfits: bracketTp ?? [],
                stopLosses: bracketSl ?? [],
                openedAt: nowNs,
                openFee: fillFee,
                openCommission: fillCommission,
                metadata: order.metadata,
                symbolInfo,
            });

            openPositions.set(pos.id, pos);
            tradingState.upsertPosition(pos);
            return;
        }

        const sameDir = existing.side === order.side;

        // Case 2: Same direction - scale in
        if (sameDir) {
            for (let i = 0; i < order.quantity; i++) {
                lots.push({
                    side: order.side,
                    qty: 1,
                    price: fillPrice,
                    feePerUnit,
                    commissionPerUnit,
                });
            }

            const newQty = existing.remainingQuantity + order.quantity;
            // VWAP entry re-calculation
            const newEntry =
                (existing.entryPrice * existing.remainingQuantity + fillPrice * order.quantity) /
                newQty;

            const newOpenCostTotal = existing.openCostTotal + fillFee + fillCommission;
            const newStartingQty = existing.startingQuantity + order.quantity;

            // Merge brackets (append; don't replace)
            const mergedTp = [
                ...existing.takeProfits,
                ...(bracketTp?.filter((t) => !existing!.takeProfits.some((e) => e.id === t.id)) ??
                    []),
            ];
            const mergedSl = [
                ...existing.stopLosses,
                ...(bracketSl?.filter((s) => !existing!.stopLosses.some((e) => e.id === s.id)) ??
                    []),
            ];

            // Re-lock RR with updated entry and brackets
            const updatedForRR = {
                ...existing,
                entryPrice: newEntry,
                remainingQuantity: newQty,
                startingQuantity: newStartingQty,
                takeProfits: mergedTp,
                stopLosses: mergedSl,
                openCostTotal: newOpenCostTotal,
                openCostPerUnit: newStartingQty > 0 ? newOpenCostTotal / newStartingQty : 0,
                feesTotal: existing.feesTotal + fillFee,
                commissionTotal: existing.commissionTotal + fillCommission,
                updatedAt: nowNs,
            };

            const lockedPos = lockRiskIfEligible(updatedForRR, nowNs);
            openPositions.set(existing.id, lockedPos);
            tradingState.upsertPosition(lockedPos);
            return;
        }

        // Case 3/4: Opposite direction - close (partial) or flip
        let toClose = order.quantity;

        while (toClose > 0 && toClose <= existing.remainingQuantity) {
            // Partial or full close - use closePositionInternal for the qty we have
            break;
        }

        if (order.quantity <= existing.remainingQuantity) {
            // Case 3: Partial or full close
            const closeQty = order.quantity;
            closePositionInternal(
                existing,
                closeQty,
                fillPrice,
                nowNs,
                'order',
                undefined,
                undefined,
                order.id,
                order.type,
            );
        } else {
            // Case 4: Flip - close all, open opposite
            const closeQty = existing.remainingQuantity;
            closePositionInternal(
                existing,
                closeQty,
                fillPrice,
                nowNs,
                'order',
                undefined,
                undefined,
                order.id,
                order.type,
            );

            const flipQty = order.quantity - closeQty;
            if (flipQty > 0) {
                const flipLots = getLots(order.symbol);
                for (let i = 0; i < flipQty; i++) {
                    flipLots.push({
                        side: order.side,
                        qty: 1,
                        price: fillPrice,
                        feePerUnit,
                        commissionPerUnit,
                    });
                }
                const flippedFee = fillFee * (flipQty / order.quantity);
                const flippedComm = fillCommission * (flipQty / order.quantity);
                const newPos = buildPosition({
                    symbol: order.symbol,
                    side: order.side,
                    type: order.type,
                    entryPrice: fillPrice,
                    quantity: flipQty,
                    takeProfits: bracketTp ?? [],
                    stopLosses: bracketSl ?? [],
                    openedAt: nowNs,
                    openFee: flippedFee,
                    openCommission: flippedComm,
                    metadata: order.metadata,
                    symbolInfo,
                });
                openPositions.set(newPos.id, newPos);
                tradingState.upsertPosition(newPos);
            }
        }
    }

    /**
     * Hedge mode: always open a new independent position regardless of existing
     * positions. Uses a unique lot-queue key per position to prevent cross-pos FIFO.
     */
    function openHedgePosition(
        order: Order,
        fillPrice: number,
        fillFee: number,
        fillCommission: number,
        bracketTp: BracketLevel[] | undefined,
        bracketSl: BracketLevel[] | undefined,
        nowNs: number,
    ): void {
        const hedgeKey = `${order.symbol}:${nanoid(6)}`;
        const lots = getLots(hedgeKey);
        const feePerUnit = fillFee / order.quantity;
        const commissionPerUnit = fillCommission / order.quantity;

        for (let i = 0; i < order.quantity; i++) {
            lots.push({
                side: order.side,
                qty: 1,
                price: fillPrice,
                feePerUnit,
                commissionPerUnit,
            });
        }

        const pos = buildPosition({
            symbol: order.symbol,
            side: order.side,
            type: order.type,
            entryPrice: fillPrice,
            quantity: order.quantity,
            takeProfits: bracketTp ?? [],
            stopLosses: bracketSl ?? [],
            openedAt: nowNs,
            openFee: fillFee,
            openCommission: fillCommission,
            metadata: order.metadata,
            symbolInfo,
        });

        openPositions.set(pos.id, pos);
        tradingState.upsertPosition(pos);
    }
    // the one close path, partial and full. always writes a PositionClose with
    // every cost field, owns the FIFO lot drain so flat/reduce dont duplicate it,
    // updates realizedRR and the R-multiples together, and derives risk back out
    // of MAE on a final close when no sl was ever set.
    function closePositionInternal(
        pos: Position,
        closeQty: number,
        exitPrice: number,
        nowNs: number,
        reason: CloseReason,
        tpId?: string,
        slId?: string,
        orderId?: string,
        orderType?: OrderType,
    ): void {
        if (!openPositions.has(pos.id)) return;
        if (closeQty <= 0 || closeQty > pos.remainingQuantity) return;

        const lots = getLots(nettingMode === 'hedge' ? pos.id : pos.symbol);

        const exitFee = calcExchangeFees(closeQty, fees);
        const exitCommission = calcCommission(closeQty, fees);
        const exitFeeTotal = exitFee + exitCommission;
        _totalFees += exitFeeTotal;

        // FIFO lot drain
        let toClose = closeQty;
        let grossPnl = 0;
        let allocatedOpenFee = 0;
        let allocatedOpenCommission = 0;

        while (toClose > 0 && lots.length > 0) {
            const lot = lots[0];
            const qty = Math.min(toClose, lot.qty);
            const dir = lot.side === 'long' ? 1 : -1;
            grossPnl += dir * (exitPrice - lot.price) * qty * resolvedTickValue;
            allocatedOpenFee += lot.feePerUnit * qty;
            allocatedOpenCommission += lot.commissionPerUnit * qty;
            lot.qty -= qty;
            if (lot.qty === 0) lots.shift();
            toClose -= qty;
        }

        const openCostAllocated = allocatedOpenFee + allocatedOpenCommission;
        const pnlNet = grossPnl - exitFeeTotal - openCostAllocated;

        _totalRealizedPnl += pnlNet;

        // Mark the bracket level as triggered
        let updatedTp = pos.takeProfits;
        let updatedSl = pos.stopLosses;

        if (tpId) {
            updatedTp = pos.takeProfits.map((t) =>
                t.id === tpId ? { ...t, triggered: true, triggeredAt: nowNs } : t,
            );
        }
        if (slId) {
            updatedSl = pos.stopLosses.map((s) =>
                s.id === slId ? { ...s, triggered: true, triggeredAt: nowNs } : s,
            );
        }

        const newRemainingQty = pos.remainingQuantity - closeQty;
        const newRealizedPnl = pos.realizedPnl + pnlNet;

        // Retroactive risk derivation on final close (legacy parity + tickValue correction)
        let initialRiskPerUnit = pos.initialRiskPerUnit;
        let initialRiskTotal = pos.initialRiskTotal;
        if (pos.initialRiskLockedAt === 0 && initialRiskPerUnit === 0 && newRemainingQty === 0) {
            const sl = updatedSl.find((s) => s.triggered) ?? updatedSl.find((s) => !s.triggered);
            let derivedRisk = 0;
            if (sl) {
                derivedRisk =
                    pos.side === 'long'
                        ? Math.max(0, pos.entryPrice - sl.price)
                        : Math.max(0, sl.price - pos.entryPrice);
            }
            if (derivedRisk <= 0 && pos.maeAbs > 0) {
                derivedRisk = pos.maeAbs;
            }
            if (derivedRisk > 0) {
                initialRiskPerUnit = derivedRisk;
                initialRiskTotal = derivedRisk * pos.startingQuantity;
            }
        }

        const realizedRR =
            initialRiskTotal > 0 ? newRealizedPnl / (initialRiskTotal * resolvedTickValue) : 0;

        const positionClose: PositionClose = {
            timestamp: nowNs,
            price: exitPrice,
            quantity: closeQty,
            pnl: grossPnl,
            pnlNet,
            reason,
            orderId: orderId ?? '',
            orderType: orderType ?? 'market',
            tpId,
            slId,
            realizedRRAfter: realizedRR,
            fees: exitFee,
            commission: exitCommission,
            slippage: 0,
            spread: 0,
            openCostAllocated,
        };

        const newStatus = newRemainingQty === 0 ? 'closed' : 'partially_closed';

        const closed: Position = {
            ...pos,
            side: pos.side,
            status: newStatus,
            remainingQuantity: newRemainingQty,
            realizedPnl: newRealizedPnl,
            realizedRR,
            takeProfits: updatedTp,
            stopLosses: updatedSl,
            feesTotal: pos.feesTotal + exitFeeTotal,
            commissionTotal: pos.commissionTotal + exitCommission,
            closes: [...pos.closes, positionClose],
            initialRiskPerUnit,
            initialRiskTotal,
            closedAt: newRemainingQty === 0 ? nowNs : pos.closedAt,
            updatedAt: nowNs,
        };

        const newUnrealizedPnl = calcUnrealizedPnl(closed, exitPrice, resolvedTickValue);
        const newUnrealizedPnlPct = calcUnrealizedPnlPct(closed, exitPrice, resolvedTickValue);

        closed.unrealizedPnl = newUnrealizedPnl;
        closed.unrealizedPnlPct = newUnrealizedPnlPct;

        if (newRemainingQty === 0) {
            openPositions.delete(pos.id);
            positionHistory.push(closed);
        } else {
            openPositions.set(pos.id, closed);
        }

        tradingState.upsertPosition(closed);

        const isFullClose = newStatus === 'closed';
        notifyPositionClosed({
            side: closed.side,
            symbol: closed.symbol,
            pnl: isFullClose ? newRealizedPnl : pnlNet,
            rMultiple: realizedRR,
            reason,
            partial: !isFullClose,
        });
    }

    /**
     * Close a full position at a given price.
     * (Used by closePosition() public API and reversePosition().)
     */
    function flattenPositionInternal(
        pos: Position,
        exitPrice: number,
        reason: CloseReason,
        nowNs: number,
    ): void {
        closePositionInternal(pos, pos.remainingQuantity, exitPrice, nowNs, reason);
    }
    //  Market order execution (book sweep)
    function executeMarketOrder(qo: QueuedOrder, tick: PriceTick, tsNs: bigint): void {
        const { order } = qo;
        const slip = marketSlippageTicks * tickSize;
        const isLong = order.side === 'long';

        const book = isLong ? askBook : bidBook;
        const raw = book.getSortedPrices();

        let remaining = order.quantity;
        let totalCost = 0;
        let swept = false;

        if (isLong) {
            for (let i = 0; i < raw.length && remaining > 0; i++) {
                const level = book.getLevel(raw[i])!;
                const fillQty = Math.min(remaining, level.totalSize);
                totalCost += (raw[i] + slip) * fillQty;
                remaining -= fillQty;
                swept = true;
            }
        } else {
            for (let i = raw.length - 1; i >= 0 && remaining > 0; i--) {
                const level = book.getLevel(raw[i])!;
                const fillQty = Math.min(remaining, level.totalSize);
                totalCost += (raw[i] - slip) * fillQty;
                remaining -= fillQty;
                swept = true;
            }
        }

        if (!swept || remaining > 0) {
            const bboPrice = isLong
                ? (tick.ask ?? bestAsk ?? tick.ask) + slip * 2
                : (tick.bid ?? bestBid ?? tick.bid) - slip * 2;
            totalCost += bboPrice * remaining;
        }

        const avgFillPrice = snap(totalCost / order.quantity);
        scheduleFill(qo, avgFillPrice, tsNs);
    }

    function snap(price: number): number {
        return Math.round(price / resolvedTickSize) * resolvedTickSize;
    }
    //  Tick handler
    function emitPlaybackTick(tick: PriceTick): void {
        if (!eventBus) return;
        eventBus.emit('playback:tick', {
            bid: tick.bid,
            ask: tick.ask,
            last: tick.last,
            spread: Math.abs(tick.ask - tick.bid),
        });
    }

    function onTick(tick: PriceTick): void {
        if (destroyed) return;

        lastTick = tick;
        tradingState.tick(tick);
        checkStopTriggers(tick);

        if (tick.bid != null) bestBid = tick.bid;
        if (tick.ask != null) bestAsk = tick.ask;

        // Update live unrealized PnL on all open positions
        const markPrice = tick.last ?? (tick.bid + tick.ask) / 2;

        // During a replay this is suppressed and emitted once in seekTo(); live
        // ticks (onTick called directly) still emit immediately.
        if (!_suppressTickEmit) emitPlaybackTick(tick);

        for (const pos of openPositions.values()) {
            if (pos.symbol !== tick.symbol) continue;

            const unrealizedPnl = calcUnrealizedPnl(pos, markPrice, resolvedTickValue);
            const unrealizedPnlPct = calcUnrealizedPnlPct(pos, markPrice, resolvedTickValue);

            const exc = updateExcursions(
                pos,
                Math.min(tick.bid, tick.ask),
                Math.max(tick.bid, tick.ask),
            );

            const updated: Position = {
                ...exc,
                currentPrice: markPrice,
                unrealizedPnl,
                unrealizedPnlPct,
                updatedAt: tick.ts,
            };

            openPositions.set(pos.id, updated);
            tradingState.upsertPosition(updated);
        }
    }
    //  Public: placeOrder
    /** The order record a request becomes, before any matching happens. */
    function buildOrder(
        req: PlaceOrderRequest,
        id: string,
        sym: string,
        nowNs: number,
        status: Order['status'],
    ): Order {
        return {
            id,
            symbol: sym,
            side: req.side,
            type: req.type,
            quantity: req.qty,
            filledQuantity: 0,
            price: req.limitPrice ?? 0,
            stopPrice: req.stopPrice ?? 0,
            tif: req.tif ?? 'gtc',
            status,
            reduceOnly: req.reduceOnly ?? false,
            targetPositionId: req.targetPositionId,
            avgPrice: 0, // set on fill, not on placement
            triggered: false,
            fees: 0, // populated on fill
            commission: 0, // populated on fill
            slippage: 0,
            createdAt: nowNs,
            updatedAt: nowNs,
            metadata: sanitizeMetadata(req.metadata, sym, req.qty, symbolInfo),
            bracket: { takeProfits: req.bracketTp, stopLosses: req.bracketSl },
        };
    }

    function placeOrder(req: PlaceOrderRequest): string {
        const id = nanoid();
        const sym = req.symbol ?? symbol;

        // no tick yet - the book has never been walked to the playhead, so theres
        // no time to stamp the order with and no price to fill it at. reject
        // rather than invent one. the chart seeds every book the moment its
        // dataset lands, so this is the "traded before any data" case.
        if (!lastTick) {
            const rejected = buildOrder(req, id, sym, 0, 'rejected');
            allOrders.set(id, rejected);
            tradingState.upsertOrder(rejected);
            return id;
        }

        const nowNs = lastTick.ts;

        if (req.type === 'market') {
            if (!req?.limitPrice && !req?.stopPrice) {
                if (req.side === 'long') {
                    req.limitPrice = lastTick.ask;
                } else {
                    req.limitPrice = lastTick.bid;
                }
            }
        }

        const order = buildOrder(req, id, sym, nowNs, 'working');

        allOrders.set(id, order);
        tradingState.upsertOrder(order);

        if (req.type === 'market') {
            executeMarketOrder(
                {
                    order,
                    queueAhead: 0,
                    tradedThrough: 0,
                    bracketTp: req.bracketTp,
                    bracketSl: req.bracketSl,
                },
                lastTick,
                BigInt(lastTick.ts),
            );
        } else if (req.type === 'limit') {
            const ourBook = req.side === 'long' ? bidBook : askBook;
            const queueAhead = ourBook.getLevel(req.limitPrice!)?.totalSize ?? 0;

            workingOrders.set(id, {
                order,
                queueAhead,
                tradedThrough: 0,
                bracketTp: req.bracketTp,
                bracketSl: req.bracketSl,
            });

            if (lastTick) {
                const fillable =
                    req.side === 'long'
                        ? lastTick.ask <= req.limitPrice!
                        : lastTick.bid >= req.limitPrice!;

                if (fillable) {
                    const qo = workingOrders.get(id)!;
                    qo.queueAhead = 0;
                    qo.tradedThrough = Infinity;
                    workingOrders.delete(id);
                    const fillPrice = req.side === 'long' ? lastTick.ask : lastTick.bid;
                    scheduleFill(qo, fillPrice, BigInt(lastTick.ts));
                }
            }
        } else {
            // stop / stop_limit
            workingOrders.set(id, {
                order,
                queueAhead: 0,
                tradedThrough: 0,
                bracketTp: req.bracketTp,
                bracketSl: req.bracketSl,
            });
        }

        return id;
    }
    //  Public: cancelOrder
    function cancelOrder(orderId: string): void {
        const qo = workingOrders.get(orderId);
        if (!qo) return;
        workingOrders.delete(orderId);
        const cancelled: Order = {
            ...qo.order,
            status: 'cancelled',
            updatedAt: lastTick.ts,
        };
        allOrders.set(orderId, cancelled);
        tradingState.upsertOrder(cancelled);
    }
    // deliberately not amending against avgPrice: on a resting unfilled order
    // its 0, and on a partially filled one it reflects the portion already done,
    // so using it as the new working price would cross the market and trigger a
    // spurious marketable-limit fill. only the relevant price field moves:
    //   limit / triggered stop_limit    -> order.price
    //   stop / untriggered stop_limit   -> order.stopPrice
    //
    //  Queue position is reset to the current depth at the new level -
    //  amending loses time priority, which is the correct exchange semantics.
    function amendOrder(orderId: string, newPrice: number): void {
        const qo = workingOrders.get(orderId);
        if (!qo) return;

        const { order } = qo;
        const snappedPrice = snap(newPrice);

        const isLimitSide =
            order.type === 'limit' || (order.type === 'stop_limit' && order.triggered);
        const isStopSide =
            order.type === 'stop' || (order.type === 'stop_limit' && !order.triggered);

        const updated: Order = {
            ...order,
            price: isLimitSide ? snappedPrice : order.price,
            stopPrice: isStopSide ? snappedPrice : order.stopPrice,
            updatedAt: lastTick.ts,
        };

        // Re-queue: lose old time priority at the new price level
        const ourBook = updated.side === 'long' ? bidBook : askBook;
        const levelPrice = isLimitSide ? snappedPrice : (updated.price ?? snappedPrice);
        const queueAhead = ourBook.getLevel(levelPrice)?.totalSize ?? 0;

        workingOrders.set(orderId, {
            ...qo,
            order: updated,
            queueAhead,
            tradedThrough: 0,
        });

        allOrders.set(orderId, updated);
        tradingState.upsertOrder(updated);
    }
    //  Public: amendBracket
    //
    // keyed by BracketLevel.id rather than array index:
    //
    //  Array indices are unstable when partial fills trigger and a level is
    //  marked triggered (shifting the effective ordering). The BracketLevel.id
    //  is a stable nanoid assigned at creation - safe for broker round-trips
    //  and chart drag handles.
    //
    //  The full BracketAmendment type is accepted so call sites have access to
    //  both price and qty in one shot, avoiding a second round-trip.
    //
    //  After any bracket update we re-attempt RR locking in case the position
    //  now has both a TP and an SL for the first time.
    function amendBracket(amendment: BracketAmendment): void {
        const { positionId, which, levelId, index, price, qty, remove } = amendment;
        const pos = openPositions.get(positionId);
        if (!pos) return;

        const snappedPrice = snap(price);
        const nowNs = lastTick.ts;

        // levels carry a stable id, but positions from an older save or a custom
        // adapter might not - fall back to the array index the caller was looking
        // at, which is what the id came from anyway
        const isTarget = (level: BracketLevel, i: number) =>
            level.id ? level.id === levelId : i === index;

        let updated: Position = { ...pos };

        if (which === 'tp') {
            updated = {
                ...updated,
                takeProfits: remove
                    ? pos.takeProfits.filter((t, i) => !isTarget(t, i))
                    : pos.takeProfits.map((t, i) =>
                          isTarget(t, i)
                              ? { ...t, price: snappedPrice, qty: qty > 0 ? qty : t.qty }
                              : t,
                      ),
            };
        } else if (which === 'sl') {
            updated = {
                ...updated,
                stopLosses: remove
                    ? pos.stopLosses.filter((s, i) => !isTarget(s, i))
                    : pos.stopLosses.map((s, i) =>
                          isTarget(s, i)
                              ? { ...s, price: snappedPrice, qty: qty > 0 ? qty : s.qty }
                              : s,
                      ),
            };
        } else if (which === 'be') {
            updated = { ...updated, bePrice: remove ? undefined : snappedPrice };
        }

        const locked = lockRiskIfEligible(updated, nowNs);
        const final: Position = { ...locked, updatedAt: nowNs };

        openPositions.set(positionId, final);
        tradingState.upsertPosition(final);
    }
    //  Public: closePosition / reversePosition
    function closePosition(positionId: string): void {
        const pos = openPositions.get(positionId);
        if (!pos || !lastTick) return;
        const slip = marketSlippageTicks * tickSize;
        const exitPrice = snap(pos.side === 'long' ? lastTick.bid - slip : lastTick.ask + slip);
        flattenPositionInternal(pos, exitPrice, 'market', lastTick.ts);
    }

    function reversePosition(positionId: string): void {
        const pos = openPositions.get(positionId);
        if (!pos || !lastTick) return;
        const slip = marketSlippageTicks * tickSize;
        const exitPrice = snap(pos.side === 'long' ? lastTick.bid - slip : lastTick.ask + slip);
        const oppSide: OrderSide = pos.side === 'long' ? 'short' : 'long';
        const qty = pos.remainingQuantity;

        flattenPositionInternal(pos, exitPrice, 'market', lastTick.ts);

        placeOrder({
            side: oppSide,
            type: 'market',
            qty,
            symbol: pos.symbol,
        });
    }
    //  Non-L3 data ingestion
    function ingestOhlcvBars(bars: OhlcvBar[], barNs?: bigint): void {
        const sorted = bars
            .map((b) => ({ tsNs: BigInt(b.time) * 1_000_000n, bar: b }))
            .sort((a, b) => (a.tsNs < b.tsNs ? -1 : a.tsNs > b.tsNs ? 1 : 0));
        _nonL3 = {
            kind: 'ohlcv',
            bars: sorted,
            suppBars: [],
            barNs: barNs && barNs > 0n ? barNs : inferBarNs(sorted),
        };
        _nonL3Cursor = 0;
        _nonL3SuppCursor = 0;
        _nonL3LastTs = 0n;
        _cb = createCompactBuffer(0);
        _processedUpToIdx = 0;
    }

    /**
     * Extend the bar buffer forward, leaving the replay cursor where it is.
     *
     * `ingestOhlcvBars` is a reset - it swaps in a whole new dataset and rewinds
     * to the start of time, which is right for a load or a jump but wrong for a
     * stream. Data arriving as the playhead nears the loaded edge comes in here
     * instead, or every forward extension replays the whole history on the next
     * seek.
     *
     * Bars at or after the first incoming timestamp are replaced rather than
     * appended: the tail of the buffer is normally a bar that was still forming
     * when it was last handed over, and comes back complete.
     */
    function appendOhlcvBars(bars: OhlcvBar[], barNs?: bigint): void {
        if (_nonL3?.kind !== 'ohlcv' || bars.length === 0) {
            if (bars.length) ingestOhlcvBars(bars, barNs);
            return;
        }
        const data = _nonL3;
        const incoming = bars
            .map((b) => ({ tsNs: BigInt(b.time) * 1_000_000n, bar: b }))
            .sort((a, b) => (a.tsNs < b.tsNs ? -1 : a.tsNs > b.tsNs ? 1 : 0));

        // reaching further back than what we hold means a different window, not
        // an extension - the cursor indexes into the old one, so rebuild
        if (data.bars.length > 0 && incoming[0].tsNs < data.bars[0].tsNs) {
            ingestOhlcvBars(bars, barNs);
            return;
        }

        const firstNewTs = incoming[0].tsNs;
        let keep = data.bars.length;
        while (keep > 0 && data.bars[keep - 1].tsNs >= firstNewTs) keep--;
        data.bars.length = keep;
        for (const b of incoming) data.bars.push(b);

        // only reachable if the overlap swallowed bars the replay had already
        // consumed, i.e. the feed rewrote history behind the horizon
        if (_nonL3Cursor > data.bars.length) _nonL3Cursor = data.bars.length;
        if (barNs && barNs > 0n) data.barNs = barNs;
    }

    /** Sub-bar counterpart of appendOhlcvBars - same cursor-preserving splice. */
    function appendSupplementalBars(
        bars: Array<{
            time: number;
            open: number;
            high: number;
            low: number;
            close: number;
            volume: number;
        }>,
    ): void {
        if (_nonL3?.kind !== 'ohlcv' || bars.length === 0) return;
        const data = _nonL3;
        const incoming = bars
            .map((b) => ({
                tsNs: BigInt(Math.round(b.time)) * 1_000_000n,
                open: b.open,
                high: b.high,
                low: b.low,
                close: b.close,
                volume: b.volume,
            }))
            .sort((a, b) => (a.tsNs < b.tsNs ? -1 : a.tsNs > b.tsNs ? 1 : 0));

        if (data.suppBars.length > 0 && incoming[0].tsNs < data.suppBars[0].tsNs) {
            ingestSupplementalBars(bars);
            return;
        }

        const firstNewTs = incoming[0].tsNs;
        let keep = data.suppBars.length;
        while (keep > 0 && data.suppBars[keep - 1].tsNs >= firstNewTs) keep--;
        data.suppBars.length = keep;
        for (const b of incoming) data.suppBars.push(b);

        if (_nonL3SuppCursor > data.suppBars.length) _nonL3SuppCursor = data.suppBars.length;
    }

    function ingestSupplementalBars(
        bars: Array<{
            time: number;
            open: number;
            high: number;
            low: number;
            close: number;
            volume: number;
        }>,
    ): void {
        if (_nonL3?.kind !== 'ohlcv') return;
        // keep the full ohlc - the forming bar is replayed from these, and a level
        // touched by a sub-bar's wick has to trigger like it would intrabar
        _nonL3.suppBars = bars
            .map((b) => ({
                tsNs: BigInt(Math.round(b.time)) * 1_000_000n,
                open: b.open,
                high: b.high,
                low: b.low,
                close: b.close,
                volume: b.volume,
            }))
            .sort((a, b) => (a.tsNs < b.tsNs ? -1 : a.tsNs > b.tsNs ? 1 : 0));
        _nonL3SuppCursor = 0;
    }

    function ingestTicks(trades: SerialTrade[]): void {
        _nonL3 = {
            kind: 'tick',
            trades: [...trades].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)),
        };
        _nonL3Cursor = 0;
        _nonL3LastTs = 0n;
        _cb = createCompactBuffer(0);
        _processedUpToIdx = 0;
    }

    function ingestPriceHistory(history: PriceHistory[]): void {
        _nonL3 = {
            kind: 'l2',
            history: [...history].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)),
        };
        _nonL3Cursor = 0;
        _nonL3LastTs = 0n;
        _cb = createCompactBuffer(0);
        _processedUpToIdx = 0;
    }

    // Streaming counterparts.
    //
    // the tick and l2 streams re-send the whole series, just longer at the end.
    // the prefix already replayed is unchanged so the cursor still points at the
    // same event and the swap is safe. the ingest* forms above rewind to zero,
    // which re-settles the entire history on the next seek - and that can fill a
    // live working order back in the past, since the watermark only guards state
    // that was handed over, not orders this engine placed itself.
    //
    // a series starting earlier than what we hold is a different window rather
    // than an extension, so those fall back to the reset.

    function appendTicks(trades: SerialTrade[]): void {
        if (_nonL3?.kind !== 'tick' || trades.length === 0) {
            if (trades.length) ingestTicks(trades);
            return;
        }
        const sorted = [...trades].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
        if (_nonL3.trades.length > 0 && sorted[0].ts < _nonL3.trades[0].ts) {
            ingestTicks(trades);
            return;
        }
        const cursor = Math.min(_nonL3Cursor, sorted.length);
        _nonL3.trades = sorted;
        _nonL3Cursor = cursor;
    }

    function appendPriceHistory(history: PriceHistory[]): void {
        if (_nonL3?.kind !== 'l2' || history.length === 0) {
            if (history.length) ingestPriceHistory(history);
            return;
        }
        const sorted = [...history].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
        if (_nonL3.history.length > 0 && sorted[0].ts < _nonL3.history[0].ts) {
            ingestPriceHistory(history);
            return;
        }
        const cursor = Math.min(_nonL3Cursor, sorted.length);
        _nonL3.history = sorted;
        _nonL3Cursor = cursor;
    }

    /** L3 counterpart: the master buffer only ever grows at the end. */
    function appendCompactBuf(buf: ArrayBuffer): void {
        const processed = _processedUpToIdx;
        ingestCompactBuf(buf);
        _processedUpToIdx = Math.min(processed, _cb.length);
    }
    //  Non-L3 seekTo paths
    function seekToOhlcv(tNs: bigint): void {
        const data = _nonL3 as {
            kind: 'ohlcv';
            bars: Array<{ tsNs: bigint; bar: OhlcvBar }>;
            suppBars: SuppBar[];
            barNs: bigint;
        };
        const hs = 0; // half spread fallback
        const barPeriodNs = data.barNs;

        // rewind detection keys off the horizon, not the last completed bar -
        // most of a seek's work happens inside the forming bar, so a scrub back
        // that doesnt cross a bar boundary still has to rewind the sub-bar cursor
        // or those sub-bars stay silently consumed
        if (tNs < _nonL3LastSeekTs) {
            _nonL3Cursor = 0;
            _nonL3SuppCursor = 0;
        }
        _nonL3LastSeekTs = tNs;

        while (_nonL3Cursor < data.bars.length) {
            const { tsNs: barTsNs, bar } = data.bars[_nonL3Cursor];
            // a bar's ohlc only describes the past once it has closed. replaying
            // the bar containing tNs would settle orders against price action
            // that from the horizon's point of view hasnt happened yet - tps and
            // sls firing early, stamped at the bar open. the forming bar gets
            // handled below off finer sub-bars.
            if (barTsNs + barPeriodNs > tNs) break;
            _nonL3Cursor++;
            _nonL3LastTs = barTsNs;

            const barTsMsNum = Number(barTsNs);
            const openBid = bar.bid ?? bar.open - hs;
            const openAsk = bar.ask ?? bar.open + hs;
            const closeBid = bar.bid ?? bar.close - hs;
            const closeAsk = bar.ask ?? bar.close + hs;

            // the open tick sets lastTick so market orders can fill, and triggers
            // any stop the bar opens at or through
            onTick({ symbol, bid: openBid, ask: openAsk, last: bar.open, ts: barTsMsNum });

            // intrabar fills over the bar's full range. checkStopFillsFromRange
            // catches stops the open tick missed, like one between open and high.
            checkLimitFillsFromRange(bar.low, bar.high, barTsNs);
            checkStopFillsFromRange(bar.low, bar.high, barTsNs);
            checkBracketTriggersFromRange(bar.low, bar.high, barTsNs);

            // close tick, marks open positions to market
            if (bar.close !== bar.open) {
                onTick({ symbol, bid: closeBid, ask: closeAsk, last: bar.close, ts: barTsMsNum });
            }
        }

        // the forming bar. the bar containing tNs is deliberately not replayed
        // above, so its price action comes from finer sub-bars instead - only the
        // part that has actually happened, meaning sub-bars at or before the
        // horizon. thats what makes a level fill the second it is touched rather
        // than at the containing bar's open, and what gives fills a sub-bar
        // timestamp instead of snapping to the bar boundary.
        //
        // the window starts at the bar-aligned floor of the horizon, matching how
        // the chart builds its open bar, so the engine settles against exactly
        // the candle on screen. sub-bars before that belong to completed bars
        // whose full range was handled above.
        if (data.suppBars.length > 0 && barPeriodNs > 0n) {
            const openBarStart = (tNs / barPeriodNs) * barPeriodNs;
            let lastOpenSupp: SuppBar | null = null;

            while (
                _nonL3SuppCursor < data.suppBars.length &&
                data.suppBars[_nonL3SuppCursor].tsNs <= tNs
            ) {
                const supp = data.suppBars[_nonL3SuppCursor];
                _nonL3SuppCursor++;
                if (supp.tsNs < openBarStart) continue;
                // binance-style archives pad no-trade seconds with zero-volume
                // bars at the prior close. the chart skips them when building the
                // open bar, so settle against real trades only or the engine and
                // the candle disagree.
                if ((supp.volume ?? 0) === 0) continue;

                // the same three checks a completed bar gets, over the sub-bar's
                // own range - entries fill inside the forming bar too, not just exits
                checkLimitFillsFromRange(supp.low, supp.high, supp.tsNs);
                checkStopFillsFromRange(supp.low, supp.high, supp.tsNs);
                checkBracketTriggersFromRange(supp.low, supp.high, supp.tsNs);
                lastOpenSupp = supp;
            }

            if (lastOpenSupp) {
                const suppNs = Number(lastOpenSupp.tsNs);
                onTick({
                    symbol,
                    bid: lastOpenSupp.close - hs,
                    ask: lastOpenSupp.close + hs,
                    last: lastOpenSupp.close,
                    ts: suppNs,
                });
            }
        }
    }

    function seekToTick(tNs: bigint): void {
        const data = _nonL3 as { kind: 'tick'; trades: SerialTrade[] };
        const hs = tickSize / 2;

        if (tNs < _nonL3LastTs) _nonL3Cursor = 0;

        while (_nonL3Cursor < data.trades.length) {
            const trade = data.trades[_nonL3Cursor];
            if (trade.ts > tNs) break;
            _nonL3Cursor++;
            _nonL3LastTs = trade.ts;

            const tradeNs = Number(trade.ts);
            // 'B' aggressor -> buyer lifted the ask -> trade happened at ask
            // 'A' aggressor -> seller hit the bid -> trade happened at bid
            const bid = trade.side === 'B' ? trade.price - hs : trade.price;
            const ask = trade.side === 'A' ? trade.price + hs : trade.price;

            onTick({ symbol, bid, ask, last: trade.price, ts: tradeNs });

            // A point-price range: fills limits at or through the trade price.
            checkLimitFillsFromRange(trade.price, trade.price, trade.ts);
            checkBracketTriggersFromRange(trade.price, trade.price, trade.ts);
        }
    }

    function seekToL2(tNs: bigint): void {
        const data = _nonL3 as { kind: 'l2'; history: PriceHistory[] };

        if (tNs < _nonL3LastTs) _nonL3Cursor = 0;

        while (_nonL3Cursor < data.history.length) {
            const snap = data.history[_nonL3Cursor];
            if (snap.ts > tNs) break;
            _nonL3Cursor++;
            _nonL3LastTs = snap.ts;

            const snapNs = Number(snap.ts);
            const { bestBid, bestAsk } = snap;
            const mid = (bestBid + bestAsk) / 2;

            onTick({ symbol, bid: bestBid, ask: bestAsk, last: mid, ts: snapNs });

            // Marketable-limit check: fill if limit price is at or inside the BBO.
            for (const [id, qo] of workingOrders) {
                const { order } = qo;
                if (order.type !== 'limit') continue;
                const p = order.price;
                const marketable = order.side === 'long' ? bestAsk <= p : bestBid >= p;
                if (!marketable) continue;
                const fillPrice = order.side === 'long' ? bestAsk : bestBid;
                scheduleFill(qo, fillPrice, snap.ts);
                workingOrders.delete(id);
            }

            // Bracket check using the full BBO spread as the effective price range.
            checkBracketTriggersFromRange(bestBid, bestAsk, snap.ts);
        }
    }
    //  Compact buffer ingestion + horizon-driven seek
    const CBUF_BYTES = 20;

    let _cb: CompactBuffer = createCompactBuffer(0);
    let _processedUpToIdx = 0;

    function ingestCompactBuf(buf: ArrayBuffer): void {
        const count = buf.byteLength / CBUF_BYTES;
        _cb._buf = buf;
        _cb._view = new DataView(buf);
        _cb.length = count;
        _cb.capacity = count;
        _processedUpToIdx = 0;
    }

    /** Last traded price, or NaN until this book has been seeked into its data. */
    function getPrice(): number {
        return lastTick ? lastTick.last : NaN;
    }

    function seekTo(tNs: bigint): void {
        if (destroyed) return;

        // Before any replay: this is the horizon the seeded state belongs to.
        markSeedWatermark(tNs);

        // coalesce the per-tick playback:tick emit across the replay - a single
        // seek can run thousands of ticks at speed, so one emit fires below off
        // the final tick
        const wasSuppressed = _suppressTickEmit;
        _suppressTickEmit = true;
        try {
            // Route to the appropriate non-L3 path when non-L3 data is loaded.
            if (_nonL3) {
                switch (_nonL3.kind) {
                    case 'ohlcv':
                        seekToOhlcv(tNs);
                        break;
                    case 'tick':
                        seekToTick(tNs);
                        break;
                    case 'l2':
                        seekToL2(tNs);
                        break;
                }
            } else if (_cb.length > 0) {
                // L3 compact-buffer path (original).
                const lastProcessedTs =
                    _processedUpToIdx > 0 ? getTsNs(_cb, _processedUpToIdx - 1) : 0n;

                if (tNs < lastProcessedTs) {
                    bidBook.clear();
                    askBook.clear();
                    bidOrderIndex.clear();
                    askOrderIndex.clear();
                    bestBid = null;
                    bestAsk = null;
                    _processedUpToIdx = 0;
                }

                while (_processedUpToIdx < _cb.length) {
                    const ts = getTsNs(_cb, _processedUpToIdx);
                    if (ts > tNs) break;
                    onMboEvent(getEvent(_cb, _processedUpToIdx), ts);
                    _processedUpToIdx++;
                }

                if (bestBid !== null && bestAsk !== null) {
                    onTick({ symbol, bid: bestBid, ask: bestAsk, ts: Number(tNs) });
                }
            }
        } finally {
            _suppressTickEmit = wasSuppressed;
        }

        // One coalesced emit for the whole seek (skipped if a caller is already
        // batching emits around us).
        if (!wasSuppressed && lastTick) emitPlaybackTick(lastTick);
    }
    //  Metrics + lifecycle
    function totalFeesPaid(): number {
        return _totalFees;
    }

    function totalRealizedPnl(): number {
        return _totalRealizedPnl;
    }

    function getOrders(): Order[] {
        return [...allOrders.values()];
    }

    function getFills(): Fill[] {
        return [...allFills];
    }

    function getPositionHistory(): Position[] {
        return [...positionHistory];
    }

    function destroy(): void {
        destroyed = true;
        workingOrders.clear();
        openPositions.clear();
        bidBook.clear();
        askBook.clear();
        lotQueues.clear();
        allOrders.clear();
        positionHistory.length = 0;
        allFills.length = 0;
        _cb = createCompactBuffer(0);
        _nonL3 = null;
        _nonL3Cursor = 0;
        _nonL3SuppCursor = 0;
        _nonL3LastTs = 0n;
    }

    return {
        syncPosition,
        syncOrder,
        onMboEvent,
        onTick,
        ingestCompactBuf,
        ingestOhlcvBars,
        appendOhlcvBars,
        ingestSupplementalBars,
        appendSupplementalBars,
        appendTicks,
        appendPriceHistory,
        appendCompactBuf,
        ingestTicks,
        ingestPriceHistory,
        seekTo,
        getPrice,
        placeOrder,
        cancelOrder,
        amendOrder,
        amendBracket,
        closePosition,
        reversePosition,
        totalFeesPaid,
        totalRealizedPnl,
        getOrders,
        getFills,
        getPositionHistory,
        setFillSearch,
        getFillSearch,
        hasPendingTriggers,
        settleGapBars,
        destroy,
    };
}
