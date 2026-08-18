/**
 * The single source of truth for how data enters DepthChart.
 */

export type { MboEvent } from '../lib/types';
import { ReactNode } from 'react';
import type { Timeframe } from '../lib/timeframes';

export type DataLevel = 'l3' | 'l2' | 'ohlcv' | 'tick';
// Trading session
export type DayOfWeek = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';

export interface SessionCorrection {
    /** ISO date: '2024-11-29' */
    date: string;
    /** Time range in HHMM-HHMM format: '0930-1300' */
    hours: string;
}

export interface TradingSubsession {
    id: string;
    label: string;
    /** HHMM-HHMM, e.g. '0400-0930'. Overnight: '1800-0000' */
    hours: string;
    days?: DayOfWeek[];
}

export interface TradingSession {
    /**
     * Trading hours in HHMM-HHMM format.
     * '24/7' or 'always' -> never closed.
     * Overnight sessions work naturally: '1800-1700' means open 6pm, close 5pm next day.
     */
    hours: '24/7' | 'always' | string;
    /** IANA timezone, e.g. 'America/New_York'. Required unless hours is '24/7'/'always'. */
    timezone: string;
    /** Trading days. Defaults to Mon-Fri when omitted. */
    days?: DayOfWeek[];
    /** Named subsessions (pre/post market, etc.) - purely for display. */
    subsessions?: TradingSubsession[];
    /** Non-trading holidays. ISO dates: ['2024-11-28', '2024-12-25'] */
    holidays?: string[];
    /** Partial-session corrections, e.g. early close days. */
    corrections?: SessionCorrection[];
}

// Price format
export interface FractionalFormat {
    /** Denominator of the fraction. E.g. 32 for 1/32nds (T-Bonds). */
    denominator: number;
    /** Sub-denominator for 1/4 of 1/32 etc. (ZF, ZB). */
    subDenominator?: number;
}

export interface PriceFormat {
    /** Decimal places for display, e.g. 2 for 19234.25 */
    precision: number;
    /** Minimum price increment, e.g. 0.25 for NQ */
    minTick: number;
    /** Set for fractional instruments (T-Bonds, Corn futures). */
    fractional?: FractionalFormat;
}

// Instrument type
export type SymbolType =
    | 'future'
    | 'stock'
    | 'forex'
    | 'crypto'
    | 'index'
    | 'option'
    | 'spread'
    | 'bond'
    | 'etf'
    | 'custom';

/**
 * How an instrument trades. Reached through `SymbolInfo.contract`, which is the
 * only thing that owns it - the account holds a balance, not a tick size, so
 * nothing about sizing or pricing should be read off it. Resolve one with
 * `specForSymbol(info)`.
 */
export interface ContractSpec {
    /** Point value / multiplier. E.g. 20 for NQ ($20/pt). */
    multiplier?: number;
    /** Minimum price increment (alias for priceFormat.minTick). */
    tickSize?: number;
    /** Cash value of one tick. */
    tickValue?: number;
    /** Settlement currency. */
    currency?: string;
    /**
     * Smallest tradable increment of quantity.
     *
     * 1 for a listed future, where a third of a contract does not exist. Spot
     * and perpetual venues are the other case entirely - Binance will sell you
     * 0.001 BTC - so this is what separates "size" from "contract count", and
     * order sizing floors to it rather than to whole numbers.
     *
     * Defaults to 1, which is the safe reading for anything that forgot to say.
     */
    qtyStep?: number;
    /** Smallest order the venue will accept. Defaults to `qtyStep`. */
    minQty?: number;
    /** ISO date of expiry. */
    expiresAt?: string;
    /** True for continuous/front-month contracts (/NQ1 etc.) */
    continuous?: boolean;
}

// SymbolInfo
export type SymbolIcon =
    /** Shorthand for { src }. */
    | string
    /** Image URL, data: URI, or imported SVG path. */
    | { src: string; alt?: string }
    /** Monogram fallback - depth draws the chip. */
    | { text: string; color?: string }
    /** Escape hatch: any component, sized by the renderer. */
    | { render: (props: { size: number }) => ReactNode };

export interface SymbolInfo {
    symbol: string;
    description?: string;
    /** Full name shown in the symbol picker. Falls back to description. */
    longName?: string;
    exchange?: string;
    /** Listed (primary) exchange, if different from routing exchange. */
    listedExchange?: string;

    /** Instrument type. */
    type: SymbolType;

    /** Data level this adapter produces. */
    dataLevel: DataLevel;

    /** Icon for this symbol. */
    icon?: SymbolIcon;
    legendIcon?: SymbolIcon;

    /**
     * Price formatting. When omitted, tickSize is used as a fallback for
     * minTick and precision is inferred from it.
     */
    priceFormat: PriceFormat;

    /** @deprecated Minimum price increment. Fallback for `priceFormat.minTick`. */
    tickSize?: number;

    /**
     * Symbol timezone. Used as the default for session.timezone when not
     * specified there. Falls back to 'UTC'.
     */
    timezone?: string;

    /** Trading session. When absent, the symbol is treated as 24/7. */
    session?: TradingSession;

    /**
     * How the instrument trades: what a tick is worth, what a point is worth,
     * and the smallest size the venue accepts. The single source for all of it.
     *
     * Every instrument type, not only futures and options - spot crypto has a
     * tick size and a (fractional) size step just as much as a listed contract
     * does, and anything that sizes an order needs both.
     */
    contract?: ContractSpec;

    /** Locale for number formatting. E.g. 'en-US'. */
    locale?: string;

    /** Volume decimal places. 0 = always integer. Default 0. */
    volumePrecision?: number;

    /** Subsymbols shown in the symbol picker (e.g. individual contracts under /NQ1). */
    subsymbols?: SymbolInfo[];

    /**
     * Extra search terms. The built-in matcher searches these alongside symbol,
     * name and exchange, so `keywords: ['gold', 'bullion']` makes XAUUSD
     * reachable by typing "gold". Adapters that search server-side
     * (`symbolSearch: 'server'`) own their own matching and can ignore this.
     */
    keywords?: string[];

    /**
     * Ascending-sorted list of barNs values this adapter can natively serve.
     *
     * DataEngine picks the coarsest supported resolution <= the active timeframe
     * for all fetches. When the active timeframe drops below a loaded segment's
     * resolution, DataEngine re-fetches that segment at the finer resolution
     * and emits `data:refine` so ChartInner can replace the stale bars.
     *
     * Example: `[60_000_000_000n, 300_000_000_000n, 3_600_000_000_000n]`
     * declares native support for 1m, 5m, and 1h bars.
     *
     * If omitted or empty, the adapter is assumed to handle any barNs (legacy behavior).
     */
    supportedResolutions?: bigint[];

    /** Arbitrary extra metadata. Not processed by the engine. */
    meta?: Record<string, unknown>;
}
// New per-level bar types
export interface OhlcvBar {
    /** Unix timestamp in milliseconds (ms since epoch). */
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    /** Best bid at bar close. When absent the engine falls back to close minus half a tick. */
    bid?: number;
    /** Best ask at bar close. When absent the engine falls back to close plus half a tick. */
    ask?: number;
}

export interface TickEvent {
    /** Unix timestamp in milliseconds (ms since epoch). */
    time: number;
    price: number;
    size: number;
    side: 'B' | 'A' | 'N';
}

export interface L2Snapshot {
    /** Unix timestamp in milliseconds (ms since epoch). */
    time: number;
    bids: Array<{ price: number; size: number }>;
    asks: Array<{ price: number; size: number }>;
}

// Request / Response
/**
 * A half-open time range `[from, to)` since the Unix epoch, with `from` always
 * <= `to` (see {@link FetchRequest.direction} for which edge a fetch extends).
 *
 * The same instant is offered in three units so adapters can use whichever maps
 * cleanest onto their backend: nanoseconds are canonical (full precision); the
 * `Ms` / `Iso` forms are derived conveniences. The ISO strings carry
 * nanosecond precision, e.g. `'2024-05-29T00:00:00.000000000Z'`.
 *
 * Build one with {@link makeTimeRange} so the derived forms stay consistent.
 */
export interface TimeRange {
    /** Start, ns since epoch (inclusive). Canonical. */
    fromNs: bigint;
    /** End, ns since epoch (exclusive). Canonical. */
    toNs: bigint;
    /** Start, ms since epoch (inclusive). Truncated from `fromNs`. */
    fromMs: number;
    /** End, ms since epoch (exclusive). Truncated from `toNs`. */
    toMs: number;
    /** Start as a nanosecond-precision ISO 8601 string. */
    fromIso: string;
    /** End as a nanosecond-precision ISO 8601 string. */
    toIso: string;
}

/**
 * Nanosecond-precision ISO 8601 string for a ns-since-epoch instant, e.g.
 * `'2024-05-29T00:00:00.000000000Z'`. Use {@link Date} on the `Ms` forms if you
 * only need millisecond precision.
 */
export function nsToIso(ns: bigint): string {
    const ms = Number(ns / 1_000_000n);
    const subMs = Number(ns % 1_000_000n);
    return new Date(ms).toISOString().slice(0, -1) + String(subMs).padStart(6, '0') + 'Z';
}

/** Build a {@link TimeRange} from ns bounds, filling in the ms/ISO conveniences. */
export function makeTimeRange(fromNs: bigint, toNs: bigint): TimeRange {
    return {
        fromNs,
        toNs,
        fromMs: Number(fromNs / 1_000_000n),
        toMs: Number(toNs / 1_000_000n),
        fromIso: nsToIso(fromNs),
        toIso: nsToIso(toNs),
    };
}

export interface FetchRequest {
    /**
     * The instrument being requested, with its price format, session, data
     * level and any other metadata. Multi-symbol adapters key off
     * `symbolInfo.symbol`; single-symbol adapters can ignore it.
     */
    symbolInfo: SymbolInfo;

    /**
     * Chronological span to cover. `range.fromNs` is always <= `range.toNs`
     * regardless of `direction` - the bounds are never reversed.
     */
    range: TimeRange;

    /**
     * Target bar resolution, with its human label and default bar count.
     * Read `timeframe.barNs` for the bar duration in nanoseconds.
     */
    timeframe: Timeframe;

    /**
     * Which edge of the loaded data this fetch is extending:
     *  - `initial`  - the first load for a window.
     *  - `forward`  - newer bars, appended to the right.
     *  - `backward` - older bars, prepended to the left.
     */
    direction: 'initial' | 'forward' | 'backward';

    /**
     * When set, also return bars at this finer resolution (ns) as
     * `supplementalBars`, for smoother playback. The engine sets this
     * automatically from the adapter's getCapabilities().
     */
    supplementalBarNs?: bigint;
}

export interface SupplementalBarSet {
    /** barNs of the finer-resolution data */
    resolution: bigint;
    bars: OhlcvBar[];
}

export interface BarResponse {
    /** Raw MBO events (L3). Leave empty for other data levels or _preProcessed. */
    events: import('../lib/types').MboEvent[];
    /** OHLCV bars - populate for dataLevel === 'ohlcv' */
    ohlcvBars?: OhlcvBar[];
    /**
     * Optional finer-resolution bars for the same time range.
     * The engine uses these to produce smoother playback via real prices instead
     * of the synthetic interpolation fallback.
     */
    supplementalBars?: SupplementalBarSet[];
    /** Tick events - populate for dataLevel === 'tick' */
    ticks?: TickEvent[];
    /** L2 depth snapshots - populate for dataLevel === 'l2' */
    l2Snapshots?: L2Snapshot[];
    hasMore: boolean;
    coveredFrom?: bigint;
    coveredTo?: bigint;
    _preProcessed?: PreProcessedPayload;
}

export interface AdapterCapabilities {
    /**
     * Finer-resolution bar granularities this adapter can supply as
     * supplementalBars alongside OHLCV responses (sorted finest-first).
     * E.g. [1_000_000_000n] means S1 data is available.
     */
    supplementalResolutions?: bigint[];

    /**
     * Who filters symbol searches. See {@link SymbolSearchMode}.
     * Defaults to 'none'.
     */
    symbolSearch?: SymbolSearchMode;

    /**
     * How long the picker waits after a keystroke before searching, in ms.
     *
     * Defaults to 200 for `symbolSearch: 'server'` - enough to stop a request
     * per character going out over the network - and 0 for 'none', which matches
     * in memory. Override it when the default misreads your adapter: set 0 if you
     * declare 'server' but search a list you already hold in memory, or raise it
     * if each search is expensive or rate-limited.
     */
    symbolSearchDebounceMs?: number;
}

export interface BarPreviewResponse {
    symbol: string;
    bars: {
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
        time: number;
    }[];
}

export interface PreProcessedPayload {
    compactBuf: ArrayBuffer;
    trades: import('../lib/types').SerialTrade[];
    priceHistory: import('../lib/types').PriceHistory[];
    footprintBars: import('../lib/types/footprint').FootprintBar[];
    dataStart: number;
    dataEnd: number;
}

// Symbol search
/**
 * Who filters a {@link SymbolSearchRequest}.
 *
 * 'none' (default) - the adapter ignores `query` and the facets and returns its
 * whole universe. The engine calls `searchSymbols` once, caches the result, and
 * matches + ranks locally on every keystroke. Right for any universe small
 * enough to ship to the client.
 *
 * 'server' - the adapter honors `query`, the facets, `limit` and `cursor`. The
 * engine forwards every (debounced) keystroke and does no matching of its own.
 * Right for a broker or exchange with tens of thousands of instruments.
 */
export type SymbolSearchMode = 'server' | 'none';

export interface SymbolSearchRequest {
    /** Free text. `''` means browse: the picker just opened, nothing typed. */
    query: string;

    /** Facet filters. Undefined means "any". */
    type?: SymbolType;
    exchange?: string;
    dataLevel?: DataLevel;

    /** How many results the caller wants. Adapters may return fewer. */
    limit?: number;

    /** Opaque cursor from a previous response. Set when paging in more results. */
    cursor?: string;

    /**
     * Aborted when this search is superseded (the user typed again) or
     * abandoned (the picker closed). Honor it if your transport can - the
     * engine drops late responses either way.
     */
    signal?: AbortSignal;
}

export interface SymbolSearchResponse {
    symbols: SymbolInfo[];
    /** True when more results exist past this page. */
    hasMore?: boolean;
    /** Pass back as `request.cursor` to fetch the next page. */
    cursor?: string;
}

// The interface
export interface IDataAdapter {
    resolveSymbol(symbol: string): SymbolInfo | Promise<SymbolInfo>;
    /**
     * Supply symbols for the picker. Return a bare array to hand over the whole
     * universe and let the engine match locally; return a
     * {@link SymbolSearchResponse} to page results yourself. Which of the two
     * the engine expects is decided by `getCapabilities().symbolSearch`.
     */
    searchSymbols(request: SymbolSearchRequest): Promise<SymbolSearchResponse | SymbolInfo[]>;
    fetchBars(request: FetchRequest): Promise<BarResponse>;
    fetchPreview?(request: FetchRequest): Promise<BarPreviewResponse>;
    subscribeRealtime?(onBar: (bar: BarResponse) => void): () => void;
    connect?(): Promise<void>;
    destroy?(): void;
    /**
     * Declare what supplemental resolutions this adapter can provide.
     * Called once after resolveSymbol(). The engine attaches the finest
     * declared resolution as supplementalResolution in every FetchRequest.
     */
    getCapabilities?(): AdapterCapabilities;
}

// Typed error
export type DataAdapterErrorCode =
    | 'unauthenticated'
    | 'forbidden'
    | 'not_found'
    | 'no_data'
    | 'rate_limited'
    | 'server_error'
    | 'network_error'
    | 'decode_error'
    | 'unknown';

export class DataAdapterError extends Error {
    constructor(
        public readonly code: DataAdapterErrorCode,
        message: string,
        public readonly httpStatus?: number,
    ) {
        super(message);
        this.name = 'DataAdapterError';
    }
}
