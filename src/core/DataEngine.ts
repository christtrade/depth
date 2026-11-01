// pure orchestrator: owns the adapter lifecycle, drives fetchBars for initial /
// forward / backward loads, keeps the master buffer per data level, routes
// responses through the right processor, and emits on the bus so panes react.

import { TypedEventBus } from './TypedEventBus';
import { BarStore } from './BarStore';
import type {
    IDataAdapter,
    BarResponse,
    SymbolInfo,
    DataLevel,
    OhlcvBar,
    TickEvent,
    SymbolSearchMode,
    SymbolSearchRequest,
    SymbolSearchResponse,
} from '../interfaces/IDataAdapter';
import { DataAdapterError, makeTimeRange, type TimeRange } from '../interfaces/IDataAdapter';
import {
    normalizeSymbolSearchResponse,
    searchSymbolsLocally,
    symbolSearchCacheKey,
} from '../lib/symbol-search';
import { footprintFromTrades, type FootprintOptions } from '../lib/types/footprint';
import type { SerialTrade } from '../lib/types';
import type { PriceHistory } from '../lib/types';
import type { FootprintBar } from '../lib/types/footprint';
import { bookAfter, carryBookInto, eventsBetween, processL3Chunk } from './processing/l3-processor';
import type { L3DataChunk } from './processing/l3-processor';
import {
    processOhlcvChunk,
    processOhlcvWithSupplemental,
    type OhlcvDataChunk,
} from './processing/ohlcv-processor';
import { processTickChunk, type TickDataChunk } from './processing/tick-processor';
import { processL2Chunk, type L2DataChunk } from './processing/l2-processor';
import { type DataChunk, isEmptyChunk } from './processing/data-chunk';
import { type Forming, formingOf, joinForming, narrowForming } from './processing/forming';
import { applyEvent, cloneBook } from '../lib/book';
import type { BookState, MboEvent } from '../lib/types';
import { isoToNs } from '../lib/sampler';
import { firstTsAtOrAfter } from '../lib/bucket-tail';
import type { DataSourceRegistry } from './DataSourceRegistry';
import {
    loadIngestAsync,
    serializeTrades,
    serializePriceHistory,
} from '../lib/slice-worker-client';
import { ExecutionEngine } from './ExecutionEngine';
import { ChartState } from './ChartState';
import { Timeframe, servableBarNs, timeframeFromBarNs } from '../lib/timeframes';
import { clipToSession, isMarketOpen, walkBackMarketNs } from './SessionUtils';
import type { SessionWindow } from './SessionUtils';
import { nextOpenNs } from './SessionUtils';
import { BYTES_PER_EVENT } from '../lib/compact-buffer';

// pages of server-side search results kept around for backspacing
const SYMBOL_SEARCH_CACHE_MAX = 32;

// keystroke debounce for server adapters that dont declare their own
const DEFAULT_SYMBOL_SEARCH_DEBOUNCE_MS = 200;

export interface DataEngineConfig {
    initialLoad: { start: string; end: string };
    horizon: string;
    fpOptions?: FootprintOptions;
    initialWindowNs?: bigint;
    scrollWindowNs?: bigint;
    dataBudget?: { maxBytes?: number };
    timeframe: Timeframe;
    /** Active symbol - passed in every FetchRequest so one adapter serves many symbols. */
    symbol?: string;
    /**
     * Symbols served by plugins. A symbol one of them claims is fetched through
     * that source instead of the adapter, and their symbols are folded into
     * every picker search alongside the adapter's own.
     */
    plugins?: DataSourceRegistry;
}

interface MasterBuffer {
    dataLevel: DataLevel;
    /** Populated for l3 only; empty ArrayBuffer for all other levels. */
    compactBuf: ArrayBuffer;
    /** Populated for l3 and tick; empty for ohlcv and l2. */
    trades: SerialTrade[];
    /** Populated for l3, tick, and l2; empty for ohlcv. */
    priceHistory: PriceHistory[];
    /** Populated for l3 and tick; empty for ohlcv and l2. */
    footprintBars: FootprintBar[];
    /** Populated for ohlcv; derived from footprintBars for l3/tick; empty for l2. */
    ohlcvBars: BarStore;
    barNs: bigint;
    /** Unix ms timestamps */
    dataStart: number;
    dataEnd: number;
    playFromNs: bigint;
    symbolInfo: SymbolInfo;
    supplemental?: Array<{ resolution: bigint; bars: OhlcvBar[] }> | null;
}

export interface ChartDataSnapshot {
    readonly dataLevel: DataLevel;
    readonly trades: SerialTrade[];
    readonly footprintBars: FootprintBar[];
    readonly priceHistory: PriceHistory[];
    /**
     * Every loaded bar, at the fetch resolution. Populated for ohlcv, derived
     * from footprintBars for l3/tick, empty for l2. Read the columns off it each
     * time - see `BarStore`. It's the store the chart draws from, so read it and
     * don't change it. `clone()` it for your own copy.
     */
    readonly bars: BarStore;
    /** Populated for tick and l3 (derived from trades). */
    readonly ticks: TickEvent[];
    readonly barNs: bigint;
    /** Unix ms timestamps */
    readonly dataStart: number;
    readonly dataEnd: number;
    readonly symbolInfo: SymbolInfo | null;
}

// Math.min for bigints
function bigMin(a: bigint, b: bigint): bigint {
    return a < b ? a : b;
}

function bigMax(a: bigint, b: bigint): bigint {
    return a > b ? a : b;
}

// an empty window holds nothing up to where it was asked to end
function loadedEdge(ms: number, emptyNs: bigint): bigint {
    return ms > 0 ? BigInt(ms) * 1_000_000n : emptyNs;
}

function _nsToIso(ns: bigint): string {
    const ms = Number(ns / 1_000_000n);
    const subMs = Number(ns % 1_000_000n);
    return new Date(ms).toISOString().slice(0, -1) + String(subMs).padStart(6, '0') + 'Z';
}

function _joined<T>(held: readonly T[], keep: number, add: readonly T[]): T[] {
    if (keep === held.length) return held.concat(add);
    const out = new Array<T>(keep + add.length);
    for (let i = 0; i < keep; i++) out[i] = held[i];
    for (let i = 0; i < add.length; i++) out[keep + i] = add[i];
    return out;
}

function _prependFootprints(
    page: FootprintBar[],
    held: FootprintBar[],
    trades: SerialTrade[],
    barNs: bigint,
    fp: FootprintOptions,
): FootprintBar[] {
    const seam = page.at(-1);
    if (!seam || held[0]?.ts !== seam.ts) return page.concat(held);
    const both = trades.slice(firstTsAtOrAfter(trades, seam.ts), firstTsAtOrAfter(trades, seam.ts + barNs));
    return page.slice(0, -1).concat(footprintFromTrades(both, barNs, fp), held.slice(1));
}

// compactbuf event ts is in first 8 bytes
function firstEventAtOrAfter(buf: ArrayBuffer, ns: bigint): number {
    const view = new DataView(buf);
    let lo = 0;
    let hi = buf.byteLength / BYTES_PER_EVENT;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (view.getBigInt64(mid * BYTES_PER_EVENT, true) < ns) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

// l3 / tick path
function _deriveOhlcvFromFootprint(footprintBars: FootprintBar[]): BarStore {
    const out = new BarStore(footprintBars.length);
    for (const fb of footprintBars) {
        out.appendRow(Number(fb.ts / 1_000_000n), fb.open, fb.high, fb.low, fb.close, fb.totalVol);
    }
    return out;
}

function _deriveTicksFromTrades(trades: SerialTrade[]): TickEvent[] {
    return trades.map((t) => ({
        time: Number(t.ts / 1_000_000n),
        price: t.price,
        size: t.size,
        side: t.side,
    }));
}

// builds the level-specific fields of a MasterBuffer from a chunk
function _chunkToMasterFields(
    chunk: DataChunk,
): Pick<
    MasterBuffer,
    | 'dataLevel'
    | 'compactBuf'
    | 'trades'
    | 'priceHistory'
    | 'footprintBars'
    | 'ohlcvBars'
    | 'dataStart'
    | 'dataEnd'
    | 'supplemental'
> {
    switch (chunk.kind) {
        case 'l3':
            return {
                dataLevel: 'l3',
                compactBuf: chunk.compactBuf,
                trades: chunk.trades,
                priceHistory: chunk.priceHistory,
                footprintBars: chunk.footprintBars,
                ohlcvBars: _deriveOhlcvFromFootprint(chunk.footprintBars),
                dataStart: chunk.dataStart,
                dataEnd: chunk.dataEnd,
            };
        case 'tick':
            return {
                dataLevel: 'tick',
                compactBuf: new ArrayBuffer(0),
                trades: chunk.trades,
                priceHistory: chunk.priceHistory,
                footprintBars: chunk.footprintBars,
                ohlcvBars: _deriveOhlcvFromFootprint(chunk.footprintBars),
                dataStart: chunk.dataStart,
                dataEnd: chunk.dataEnd,
            };
        case 'ohlcv':
            return {
                dataLevel: 'ohlcv',
                compactBuf: new ArrayBuffer(0),
                trades: [],
                priceHistory: [],
                footprintBars: [],
                ohlcvBars: BarStore.from(chunk.ohlcvBars),
                dataStart: chunk.dataStart,
                dataEnd: chunk.dataEnd,
                supplemental: (chunk as any)?.supplemental ?? null,
            };
        case 'l2':
            return {
                dataLevel: 'l2',
                compactBuf: new ArrayBuffer(0),
                trades: [],
                priceHistory: chunk.priceHistory,
                footprintBars: [],
                ohlcvBars: new BarStore(),
                dataStart: chunk.dataStart,
                dataEnd: chunk.dataEnd,
            };
    }
}

/** Pan headroom either side of the pane window a switch loads, in bars. */
const SWITCH_PAD_BARS = 300n;
/** Window to load when no pane has said where it is looking, in bars either side. */
const SWITCH_FALLBACK_BARS = 1000n;
const DEFAULT_MAX_BYTES = 256 * 2 ** 20;
/** A BarStore row without bid/ask. */
const BAR_BYTES = 48;
// l2 has its own track
const BUDGETED = new Set<DataLevel>(['ohlcv', 'tick', 'l3']);

// measured in node: a trade object ~96 B, a bid/ask point ~88 B, a footprint level ~70 B
function heldBytes(m: MasterBuffer): number {
    let fp = 0;
    for (const b of m.footprintBars) fp += 160 + 72 * b.levels.length;
    return m.ohlcvBars.bytes + m.compactBuf.byteLength + 96 * m.trades.length + 88 * m.priceHistory.length + fp;
}

function _gcd(a: bigint, b: bigint): bigint {
    while (b > 0n) [a, b] = [b, a % b];
    return a;
}

// one engine drives a grid of panes that may each show a different symbol, so
// every symbol owns a state and paginates independently - a pan on one pane
// never reloads or clobbers another's data
interface SymbolState {
    master: MasterBuffer | null;
    session: import('../interfaces/IDataAdapter').TradingSession | null;
    /** Set after resolveSymbol(), read by _process() for level routing. */
    symbolInfo: SymbolInfo | null;
    loadedFrom: bigint | null;
    loadedTo: bigint | null;
    hasMoreHistory: boolean;
    hasMoreForward: boolean;
    forwardInFlight: boolean;
    backwardInFlight: boolean;
    pendingBackwardViewMin: bigint | null;
    /** Resolution the loaded window is at. 0n when nothing is loaded. */
    fetchBarNs: bigint;
    /** Bumped by anything that replaces the window, so a late fetch knows to drop its answer. */
    stageToken: number;
    /** Window a staged reload is out fetching; a switch announces twice, and both arrive before either returns. */
    staging: { barNs: bigint; from: bigint; to: bigint } | null;
    /**
     * Finest supplemental resolution the adapter serving this symbol declares,
     * null for none. Per symbol because a plugin source and the host adapter
     * answer getCapabilities() differently.
     */
    supplementalResolution: bigint | null;
    /** False while a hole separates the data from the live edge, so the feed waits until pans page across it. */
    reachesLive: boolean;
    pendingForwardViewMax: bigint | null;
    retry: { backward: Retry; forward: Retry };
    forming: Forming | null;
    /** The book just before `forming`s first event so the next chunk doesnt start empty (l3)*/
    formingBook: BookState | null;
}

// a direction whose last fetch failed: no new one b4 `at` and one `timer` to try again
interface Retry {
    at: number;
    ms: number;
    timer: ReturnType<typeof setTimeout> | null;
}

const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;

// twice as long after each failure in a row, so a source thats down isnt hammered
function backOff(r: Retry): void {
    r.ms = r.ms ? Math.min(RETRY_MAX_MS, r.ms * 2) : RETRY_MIN_MS;
    r.at = Date.now() + r.ms;
}

function recovered(r: Retry): void {
    r.ms = 0;
    r.at = 0;
}

const noRetry = (): Retry => ({ at: 0, ms: 0, timer: null });

export class DataEngine {
    private adapter: IDataAdapter | null = null;
    private realtimeUnsub: (() => void) | null = null;
    private realtimeKey = '';
    private executionEngine: ExecutionEngine | null = null;
    private readonly config: DataEngineConfig;

    private destroyed = false;

    // per-symbol load state: master cache, pagination edges, in-flight flags
    private readonly _states = new Map<string, SymbolState>();

    // so callers can read resolved info without waiting on the event
    private readonly resolvedSymbols = new Map<string, SymbolInfo>();

    // what each pane is actually looking at, keyed by pane id. shared state only
    // carries one timeframe (the focused pane's) but a layout can hold the same
    // instrument at four different ones, and sizing fetches off the focused pane
    // hands a 1m pane hourly bars it can only draw with gaps. panes announce
    // themselves here so the fetch resolution is the finest anyone needs, and
    // the window they report is what bounds refinement.
    private readonly paneResolutions = new Map<
        number,
        { symbol: string; barNs: bigint; viewFrom: bigint | null; viewTo: bigint | null }
    >();
    private fpOptions: FootprintOptions;
    private initialLoad: { start: string; end: string };
    private horizonIso: string;
    private scrollWindowNs: bigint;
    private activeSymbol: string;

    // serializes load() calls so concurrent symbol changes (restoring several
    // panes at once) dont clobber each other's in-flight state
    private _loadChain: Promise<void> = Promise.resolve();

    // Symbol search.
    // the whole universe from a 'none'-mode adapter, fetched once and matched
    // locally
    private symbolUniverse: SymbolInfo[] | null = null;
    private symbolUniverseInFlight: Promise<SymbolInfo[]> | null = null;
    private symbolSearchAbort: AbortController | null = null;
    // only the newest search may emit, late arrivals get dropped
    private latestSymbolSearchId: string | null = null;
    // small LRU so backspacing through a query doesnt refetch
    private readonly symbolSearchCache = new Map<string, SymbolSearchResponse>();

    private readonly unsubs: Array<() => void> = [];

    readonly sharedData: {
        dataLevel: DataLevel;
        compactBuf: ArrayBuffer;
        trades: SerialTrade[];
        priceHistory: PriceHistory[];
        footprintBars: FootprintBar[];
        ohlcvBars: BarStore;
        barNs: bigint;
        dataStart: number;
        dataEnd: number;
        supplemental: Array<{
            resolution: bigint;
            bars: Array<{
                time: number;
                open: number;
                high: number;
                low: number;
                close: number;
                volume: number;
            }>;
        }> | null;
    } = {
        dataLevel: 'l3',
        compactBuf: new ArrayBuffer(0),
        trades: [],
        priceHistory: [],
        footprintBars: [],
        ohlcvBars: new BarStore(),
        barNs: 60_000_000_000n,
        dataStart: 0,
        dataEnd: 0,
        supplemental: null,
    };

    private maxLookbackBars: number;
    private readonly maxBytes: number;
    private budgetTimer: ReturnType<typeof setTimeout> | null = null;
    private budgetWarned = false;
    private playheadNs: bigint | null = null;

    constructor(
        private readonly eventBus: TypedEventBus,
        private readonly state: ChartState,
        config: DataEngineConfig,
    ) {
        this.initialLoad = config.initialLoad;
        this.horizonIso = config.horizon;
        this.fpOptions = config.fpOptions ?? {};
        this.scrollWindowNs = config.scrollWindowNs ?? 3_600_000_000_000n;
        this.activeSymbol = config.symbol ?? '';
        this.maxLookbackBars = 0;
        this.maxBytes = config.dataBudget?.maxBytes ?? DEFAULT_MAX_BYTES;

        this.config = config;

        this._subscribeToEventBus();
    }

    // get-or-create the per-symbol load state
    private _st(symbol: string): SymbolState {
        let st = this._states.get(symbol);
        if (!st) {
            st = {
                master: null,
                session: null,
                symbolInfo: null,
                loadedFrom: null,
                loadedTo: null,
                hasMoreHistory: true,
                hasMoreForward: true,
                forwardInFlight: false,
                backwardInFlight: false,
                pendingBackwardViewMin: null,
                fetchBarNs: 0n,
                stageToken: 0,
                staging: null,
                supplementalResolution: null,
                reachesLive: true,
                pendingForwardViewMax: null,
                retry: { backward: noRetry(), forward: noRetry() },
                forming: null,
                formingBook: null,
            };
            this._states.set(symbol, st);
        }
        return st;
    }

    // the named symbol when it has a loaded state, so each pane paginates its own
    // instrument. falls back to the focused one for internal emits with no symbol
    private _targetSymbol(symbol?: string): string {
        return symbol && this._states.has(symbol) ? symbol : this.activeSymbol;
    }

    // live mode, including while the feed waits for the data to reach the live edge
    isRealtime(): boolean {
        return this.realtimeKey !== '';
    }

    setAdapter(adapter: IDataAdapter): void {
        for (const st of this._states.values()) this._dropMaster(st);
        this.realtimeUnsub?.();
        this.realtimeUnsub = null;
        this.realtimeKey = '';
        this.adapter?.destroy?.();
        this.adapter = adapter;
        // swapping the adapter invalidates every symbol's state
        this.resolvedSymbols.clear();
        this._states.clear();
    }

    // who serves this symbol: the plugin source that claimed it, or the host
    // adapter. a claimed symbol never reaches the host adapter at all, so it
    // gets the same windowing, prefetch, refinement and playback as any other
    private _adapterFor(symbol: string): IDataAdapter | null {
        return this.config.plugins?.adapterFor(symbol) ?? this.adapter;
    }

    // called via the chart:set-symbol subscription, not meant as a direct call
    // site - use chart.setSymbol() instead
    private _applySymbol(symbol: string): void {
        // already loaded, normally because another pane is showing it. the asking
        // pane still has nothing though: panes hold their own copy and only get
        // it from a data:load, so returning early here left it on the previous
        // symbol's bars while claiming the new one. re-emitting is what
        // rehydrate() does, and panes that already had it just re-ingest.
        const loaded = this._states.get(symbol);
        if (loaded?.master) {
            this.activeSymbol = symbol;
            this._syncShared();
            this._syncRealtime();
            void this._emitLoad(loaded, /* rehydrate */ true).catch((err) =>
                console.error('[DataEngine] re-emit on symbol switch failed', err),
            );
            return;
        }

        if (this.activeSymbol === symbol) return;
        this.activeSymbol = symbol;
        this.load(symbol);
    }

    getResolvedSymbolInfo(symbol: string): SymbolInfo | null {
        return this.resolvedSymbols.get(symbol) ?? null;
    }

    attachExecutionEngine(engine: ExecutionEngine): void {
        this.executionEngine = engine;
    }

    setLookback(lookback: number): void {
        this.maxLookbackBars = lookback;
    }

    // serializes against any in-flight load so rapid symbol changes (restoring
    // several panes) each finish cleanly instead of clobbering each other's
    // reset of master/loaded range
    load(symbol: string): Promise<void> {
        const next = this._loadChain.then(() => this._load(symbol));
        // keep the chain alive even if one load rejects, so later ones still run
        this._loadChain = next.catch(() => {});
        return next;
    }

    private async _load(symbol: string): Promise<void> {
        if (this.destroyed) return;

        // loads are queued, so claim the active symbol as this one actually
        // starts. realtime/getSnapshot then track the symbol loaded last, and the
        // data:load below is attributed by st.symbolInfo anyway
        this.activeSymbol = symbol;

        const adapter = this._adapterFor(symbol);
        if (!adapter) {
            const msg = '[DataEngine] No IDataAdapter set.';
            this.eventBus.emit('data:status', {
                status: 'error',
                error: { code: 'no_adapter', message: msg },
                symbol,
            });
            throw new Error(msg);
        }

        const st = this._st(symbol);
        st.loadedFrom = null;
        st.loadedTo = null;
        st.hasMoreHistory = true;
        st.hasMoreForward = true;
        this._dropMaster(st);
        st.fetchBarNs = 0n;
        st.stageToken++;
        st.staging = null;

        this.eventBus.emit('data:status', { status: 'loading', symbol });

        // 1. connect
        try {
            await adapter.connect?.();
        } catch (err) {
            this._emitAdapterError('adapter_connect_failed', err, symbol);
            return;
        }

        // 2. resolve the symbol
        let symbolInfo: SymbolInfo;
        try {
            symbolInfo = await adapter.resolveSymbol(symbol);
            st.session = symbolInfo.session ?? null;
            this.resolvedSymbols.set(symbolInfo.symbol, symbolInfo);
            this.eventBus.emit('data:symbol-resolved', { symbolInfo });
        } catch (err) {
            this._emitAdapterError('resolve_symbol_failed', err, symbol);
            return;
        }

        st.symbolInfo = symbolInfo;

        // 3. read the supplemental resolutions of whoever serves this symbol
        try {
            const caps = adapter.getCapabilities?.();
            const resolutions = caps?.supplementalResolutions;
            st.supplementalResolution =
                resolutions && resolutions.length > 0
                    ? resolutions.reduce((finest, r) => (r < finest ? r : finest))
                    : null;
        } catch {
            st.supplementalResolution = null;
        }

        // 4. fetch the initial window, centered on the configured horizon
        const lookbackNs = BigInt(this.maxLookbackBars) * this._lookbackBarNs(symbol);
        const fromNs = isoToNs(this.initialLoad.start) - lookbackNs;
        const toNs = isoToNs(this.initialLoad.end);
        await this._loadWindow(st, fromNs, toNs, isoToNs(this.horizonIso));
    }

    // one feed for the focused symbol at the res its data is held at
    // every master rebuild and focus change lands here. only a new key resubscribes,
    // and none opens while a hole would put live bars past it
    private _syncRealtime(): void {
        const st = this._states.get(this.activeSymbol);
        const info = st?.master ? st.symbolInfo : null;
        const adapter = info ? this._adapterFor(info.symbol) : null;
        const key = info && adapter?.subscribeRealtime ? `${info.symbol}|${st!.fetchBarNs}` : '';
        const open = key !== '' && st!.reachesLive;
        if (key === this.realtimeKey && open === (this.realtimeUnsub !== null)) return;
        this.realtimeUnsub?.();
        this.realtimeUnsub = null;
        this.realtimeKey = key;
        if (!open) return;

        const fetchBarNs = st!.fetchBarNs;
        const timeframe = this._fetchTimeframe(st!, fetchBarNs);
        this.realtimeUnsub = adapter!.subscribeRealtime!(
            {
                symbolInfo: info!,
                timeframe,
                since: st!.loadedTo ?? 0n,
                supplementalBarNs: this._supplementalFor(st!, fetchBarNs),
            },
            (bar) => {
                // in flight from before a switch
                if (st!.fetchBarNs === fetchBarNs) this._handleRealtimeBar(st!, bar);
            },
        );
    }

    // fetches a fresh window and reinitializes the chart around horizonNs, then
    // emits data:load. shared by load() and seekLoad() so both reset and rebuild
    // identically. assumes the symbol is already resolved.
    private async _loadWindow(
        st: SymbolState,
        fromNs: bigint,
        toNs: bigint,
        horizonNs: bigint,
        announceLoading = true,
    ): Promise<void> {
        if (this.destroyed || !st.symbolInfo) return;
        const adapter = this._adapterFor(st.symbolInfo.symbol);
        if (!adapter) return;

        // a jump back from the live edge leaves a hole
        // so wait for feed to page across
        const liveTo = !st.master ? null : st.reachesLive ? st.loadedTo : undefined;

        // fresh window, so drop the loaded range - pagination restarts relative
        // to this one, and a staged switch still in flight no longer applies
        st.loadedFrom = null;
        st.loadedTo = null;
        st.hasMoreHistory = true;
        st.hasMoreForward = true;
        st.reachesLive = true;
        st.pendingForwardViewMax = null;
        recovered(st.retry.backward);
        recovered(st.retry.forward);
        this._dropMaster(st);
        st.fetchBarNs = 0n;
        st.stageToken++;
        st.staging = null;
        this.horizonIso = _nsToIso(horizonNs);

        // jump-loads pass announceLoading=false since theyre quick re-centers -
        // no full loading overlay, interactions stay live. the ingest still emits
        // a ready at the end, and errors surface either way
        if (announceLoading)
            this.eventBus.emit('data:status', {
                status: 'loading',
                symbol: st.symbolInfo.symbol,
            });

        // a first load has no window to preserve, so an unservable timeframe
        // lands on the finest the adapter has rather than refusing - the pane
        // clamps itself to it once the symbol resolves
        const fetchBarNs =
            this._fetchBarNsFor(st, st.symbolInfo.symbol) ?? this._finestSupported(st);
        const timeframe = this._fetchTimeframe(st, fetchBarNs);

        if (adapter.fetchPreview) {
            adapter
                .fetchPreview({
                    symbolInfo: st.symbolInfo,
                    range: makeTimeRange(fromNs, toNs),
                    timeframe,
                    direction: 'backward',
                })
                .then((response) => {
                    if (this.destroyed) return;
                    this.eventBus.emit('data:preview', response);
                })
                .catch((err) => {
                    console.error('[DataEngine] preview fetch failed', err);
                });
        }

        let response: BarResponse;
        try {
            response = await adapter.fetchBars({
                symbolInfo: st.symbolInfo,
                range: makeTimeRange(fromNs, toNs),
                timeframe,
                direction: 'initial',
                supplementalBarNs: this._supplementalFor(st, timeframe.barNs),
                supplementalRange: this._supplementalRange(timeframe.barNs, fromNs, toNs),
            });
        } catch (err) {
            this._emitAdapterError('fetch_failed', err, st.symbolInfo.symbol);
            return;
        }

        const { processed, forming, book } = this._processWindow(response, st);
        if (!processed) {
            this.eventBus.emit('data:status', {
                status: 'ready',
                symbol: st.symbolInfo.symbol,
            });
            return;
        }

        st.loadedFrom = loadedEdge(processed.dataStart, toNs);
        st.loadedTo = loadedEdge(processed.dataEnd, toNs);
        st.hasMoreHistory = response.hasMore;
        st.reachesLive = liveTo === null || (liveTo !== undefined && toNs >= liveTo);
        st.fetchBarNs = fetchBarNs;
        st.master = this._buildMaster(st, processed, fetchBarNs);
        st.forming = forming;
        st.formingBook = book;

        this._syncShared();
        this._syncRealtime();
        this._scheduleBudget();
        await this._emitLoad(st);

        // a pane can announce a different timeframe while this fetch is in
        // flight, since panes mount around the first load. settle it here rather
        // than leaving that pane looking at bars it cant draw
        this._ensureResolution(st, null);
    }

    private _buildMaster(
        st: SymbolState,
        processed: DataChunk,
        fetchBarNs: bigint,
    ): MasterBuffer {
        return {
            ..._chunkToMasterFields(processed),
            // the bars' own period, not the view timeframe. consumers tell a
            // completed bar from the forming one with it, and with panes at mixed
            // timeframes the two arent the same number anymore
            barNs: processed.kind === 'ohlcv' ? fetchBarNs : this.state.get('timeframe').barNs,
            playFromNs: BigInt(processed.dataStart) * 1_000_000n,
            symbolInfo: st.symbolInfo!,
        };
    }

    // jump-load: re-fetch a window centered on targetNs and reinitialize there,
    // rather than streaming everything between the loaded edge and the target.
    // costs one window whatever the jump distance, and reuses the resolved symbol
    // and realtime subscription from the initial load
    async seekLoad(targetNs: bigint, fromNs?: bigint): Promise<void> {
        if (this.destroyed) return;

        const lookbackNs = BigInt(this.maxLookbackBars) * this._lookbackBarNs(this.activeSymbol);
        // half the configured initial-load span each side, plus the lookback pad
        const half = (isoToNs(this.initialLoad.end) - isoToNs(this.initialLoad.start)) / 2n;
        const windowFrom = targetNs - half - lookbackNs;

        // every loaded symbol re-centers, not just the focused one. theres one
        // playhead driving every pane, so a symbol left on its old window has
        // nothing where the jump lands - that pane clamps to its own stale edge,
        // freezes, then reports those edges as the playback engine's data bounds,
        // and the engine re-seeks every frame
        const targets = [...this._states.values()].filter((st) => st.symbolInfo);

        await Promise.all(
            targets.map(async (st) => {
                // settle fills over the skipped span before swapping in the new
                // window, so the engine sees fills in time order. the new window's
                // own replay covers [windowFrom, targetNs]. per symbol, since a
                // resting order on the pane you arent focused on still settles.
                if (fromNs !== undefined) await this._settleGapFills(st, fromNs, windowFrom);

                await this._loadWindow(
                    st,
                    windowFrom,
                    targetNs + half,
                    targetNs,
                    /* announceLoading */ false,
                );
            }),
        );
    }

    // re-fetch the focused symbol's window from scratch, leaving the horizon
    // where it is. exists because what an adapter is willing to return can change
    // while a chart is loaded - nothing else re-asks at the same resolution.
    // queued behind any in-flight load(), because the common case is that exact
    // race: the grant lands while the first fetch is still out, and that load
    // would reset master underneath the reload's own result
    reload(horizonNs?: bigint): Promise<void> {
        const next = this._loadChain.then(() => {
            if (this.destroyed) return;
            // nothing loaded for this symbol, so the load queued behind us will
            // pick the new state up on its own
            if (!this._states.get(this.activeSymbol)?.symbolInfo) return;
            return this.seekLoad(horizonNs ?? isoToNs(this.horizonIso));
        });
        this._loadChain = next.catch(() => {});
        return next;
    }

    // fetches the skipped span once and hands the bars to the execution engine,
    // which replays them through its fill logic so resting orders and brackets
    // the jump flew past still fill
    private async _settleGapFills(st: SymbolState, fromNs: bigint, toNs: bigint): Promise<void> {
        const exec = this.executionEngine;
        if (!exec || !st.symbolInfo) return;
        if (fromNs <= 0n || toNs <= fromNs) return; // nothing skipped, or backward

        const adapter = this._adapterFor(st.symbolInfo.symbol);
        if (!adapter) return;

        // one engine backs every symbol on the layout and its symbol-less default
        // is the focused pane's, so asking unqualified settles this symbol's bars
        // against the wrong book
        const symbol = st.symbolInfo.symbol;

        const cfg = exec.getFillSearch();
        if (!cfg.enabled || !exec.hasPendingTriggers(symbol)) return;

        const span = toNs - fromNs;

        let resp: BarResponse;
        try {
            resp = await adapter.fetchBars({
                symbolInfo: st.symbolInfo,
                range: makeTimeRange(fromNs, toNs),
                timeframe: this._fetchTimeframe(
                    st,
                    this._coarsestSupportedUpTo(st, cfg.maxResolution(span)),
                ),
                direction: 'forward',
            });
        } catch (err) {
            console.error('[DataEngine] gap-fill fetch failed', err);
            return;
        }

        const bars = (resp.ohlcvBars ?? [])
            .map((b) => ({
                tsNs: BigInt(Math.round(b.time)) * 1_000_000n,
                open: b.open,
                high: b.high,
                low: b.low,
                close: b.close,
            }))
            .filter((b) => b.tsNs >= fromNs && b.tsNs < toNs)
            .sort((a, b) => (a.tsNs < b.tsNs ? -1 : a.tsNs > b.tsNs ? 1 : 0));

        if (bars.length > 0) exec.settleGapBars(bars, cfg.ambiguity, symbol);
    }

    rehydrate(): void {
        if (this.destroyed) return;
        // re-emit every loaded symbol's master, not just the active one, so panes
        // showing different symbols get their data back on remount
        for (const st of this._states.values()) {
            if (!st.master) continue;
            this._emitLoad(st, /* rehydrate */ true).catch((err) =>
                console.error('[DataEngine] rehydrate _emitLoad failed', err),
            );
        }
    }

    rebuildFootprint(barNs: bigint, fpOptions?: FootprintOptions): void {
        if (this.destroyed) return;
        if (fpOptions !== undefined) this.fpOptions = fpOptions;
        this.eventBus.emit('data:rebuild-footprint', {
            barNs: this.state.get('timeframe').barNs,
            fpOptions: this.fpOptions,
        });
    }

    /**
     * Bars for a span, without touching what the chart has loaded. Every other
     * fetch path here joins the loaded-range bookkeeping (`loadedFrom`/
     * `loadedTo`, prefetch, playback horizon) - this one doesn't. A
     * five-year backtest shouldn't drag five years into the chart's working set
     * or make the next pan think it has history it doesn't.
     *
     * One request, one answer. Chunking a long span is the caller's job -
     * holding chunks here to return one array would cost exactly the memory
     * this exists to avoid.
     */
    async fetchRangeBars(opts: {
        /** Defaults to the focused symbol. */
        symbol?: string;
        fromNs: bigint;
        toNs: bigint;
        /** Defaults to the chart's current timeframe. */
        timeframe?: Timeframe;
    }): Promise<{ bars: OhlcvBar[]; hasMore: boolean; coveredTo: bigint | null }> {
        const symbol = this._targetSymbol(opts.symbol);
        const adapter = this._adapterFor(symbol);
        if (!adapter) throw new Error('no data adapter is attached');

        const symbolInfo =
            this.resolvedSymbols.get(symbol) ?? this._states.get(symbol)?.symbolInfo ?? null;
        if (!symbolInfo) throw new Error(`symbol "${symbol}" has not been resolved yet`);

        const timeframe = opts.timeframe ?? this.state.get('timeframe');

        const response = await adapter.fetchBars({
            symbolInfo,
            range: makeTimeRange(opts.fromNs, opts.toNs),
            timeframe,
            // 'initial', not 'backward' - this isn't extending an edge, and an
            // adapter that pages relative to what it last served would otherwise
            // answer about the chart's window instead of the span asked for
            direction: 'initial',
        });

        return {
            bars: response.ohlcvBars ?? [],
            hasMore: !!response.hasMore,
            coveredTo: response.coveredTo ?? null,
        };
    }

    getSnapshot(): ChartDataSnapshot {
        const master = this._states.get(this.activeSymbol)?.master ?? null;
        if (!master) {
            return {
                dataLevel: 'l3',
                trades: [],
                footprintBars: [],
                priceHistory: [],
                bars: new BarStore(),
                ticks: [],
                barNs: 1_000_000_000n,
                dataStart: 0,
                dataEnd: 0,
                symbolInfo: null,
            };
        }

        const { dataLevel, trades, footprintBars, priceHistory, ohlcvBars: bars } = master;

        const ticks: TickEvent[] =
            dataLevel === 'l3' || dataLevel === 'tick' ? _deriveTicksFromTrades(trades) : [];

        return {
            dataLevel,
            trades,
            footprintBars,
            priceHistory,
            bars,
            ticks,
            barNs: master.barNs,
            dataStart: master.dataStart,
            dataEnd: master.dataEnd,
            symbolInfo: master.symbolInfo,
        };
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;

        for (const unsub of this.unsubs) unsub();
        this.unsubs.length = 0;

        for (const st of this._states.values()) this._dropMaster(st);
        this.realtimeUnsub?.();
        this.realtimeUnsub = null;
        if (this.budgetTimer !== null) clearTimeout(this.budgetTimer);
        this.budgetTimer = null;
        this._cancelSymbolSearch();
        this.symbolSearchCache.clear();
        this.symbolUniverse = null;
        this.adapter?.destroy?.();
        this.adapter = null;
        this._states.clear();
    }

    // Scroll pagination

    // true while that direction waits out a failed fetch, with `again` set to run once the wait is over
    private _waiting(r: Retry, again: () => void): boolean {
        const wait = r.at - Date.now();
        if (wait <= 0) return false;
        r.timer ??= setTimeout(() => {
            r.timer = null;
            if (!this.destroyed) again();
        }, wait);
        return true;
    }

    // a pan into the hole a capped switch left. live feeds and playback page forward on their own
    private _requestForward(symbol: string, viewMax: bigint): void {
        const st = this._states.get(symbol);
        if (!st || st.reachesLive || st.loadedTo === null || viewMax <= st.loadedTo) return;
        this._fetchForward(symbol, undefined, viewMax);
    }

    private _fetchForward(symbol: string, spanNs?: bigint, viewMax?: bigint): void {
        if (this.destroyed) return;
        const adapter = this._adapterFor(symbol);
        if (!adapter) return;
        const st = this._st(symbol);
        if (st.forwardInFlight) {
            if (viewMax !== undefined && (st.pendingForwardViewMax ?? 0n) < viewMax) {
                st.pendingForwardViewMax = viewMax;
            }
            return;
        }
        if (!st.hasMoreForward) {
            // asked for more but the stream is exhausted, so re-assert it and
            // playback pauses at the end instead of holding forever. the final
            // chunk's data:bounds clears the engine's end flag.
            this.eventBus.emit('data:no-more-forward', { symbol });
            return;
        }
        if (st.loadedTo === null || !st.symbolInfo) return;
        // no prefetch-done until the retry does fetch, so playback waits for it instead of asking every frame
        const retry = () => this._fetchForward(symbol, spanNs, st.pendingForwardViewMax ?? viewMax);
        if (this._waiting(st.retry.forward, retry)) {
            if (viewMax !== undefined && (st.pendingForwardViewMax ?? 0n) < viewMax) {
                st.pendingForwardViewMax = viewMax;
            }
            return;
        }

        // sized to playback consumption, but never less than the scroll window
        let win = spanNs && spanNs > this.scrollWindowNs ? spanNs : this.scrollWindowNs;
        if (viewMax !== undefined) {
            // past the view in one go, but a zoomed-out pan can't fetch more than the budget holds
            // never under the scroll window though, or a small budget pages a few bars at a time
            let reach = viewMax - st.loadedTo + SWITCH_PAD_BARS * st.fetchBarNs;
            if (Number.isFinite(this.maxBytes)) {
                reach = bigMin(reach, BigInt(Math.floor(this.maxBytes / 2 / BAR_BYTES)) * st.fetchBarNs);
            }
            if (reach > win) win = reach;
        }

        st.forwardInFlight = true;
        const rawFrom = st.loadedTo;
        let rawTo = rawFrom + win;

        // no session at all means always open. every built-in adapter declares
        // one so this never used to fire, but a plugin source is allowed not to
        if (st.session && !isMarketOpen(st.session, rawTo)) {
            rawTo = nextOpenNs(st.session, rawTo) + win;
        }

        const windows = this._openWindows(st, rawFrom, rawTo);

        if (windows.length === 0) {
            // whole window is closed, so skip ahead to the next open and tell the
            // renderer about the gap
            this.eventBus.emit('data:session-gap', { from: rawFrom, to: rawTo, symbol });
            st.loadedTo = rawTo;
            st.forwardInFlight = false;
            return;
        }

        const from = windows[0].from;
        const to = windows[windows.length - 1].to;

        // the current resolution and not what's being requested
        const _fwdFetchBarNs = st.fetchBarNs;
        const _fwdTimeframe = this._fetchTimeframe(st, _fwdFetchBarNs);
        const master = st.master;
        adapter
            .fetchBars({
                symbolInfo: st.symbolInfo,
                range: makeTimeRange(from, to),
                timeframe: _fwdTimeframe,
                direction: 'forward',
                supplementalBarNs: this._supplementalFor(st, _fwdFetchBarNs),
            })
            .then((response) => {
                if (this.destroyed) return;
                recovered(st.retry.forward);
                // window got swapped while this was out, itd land at the wrong res or edge
                if (st.master !== master) return;

                // nothing past this window, so stop future forward fetches and let
                // playback know it hit the real end so it pauses instead of stalling
                if (response.hasMore === false) {
                    st.hasMoreForward = false;
                    this.eventBus.emit('data:no-more-forward', { symbol });
                }

                this._appendResponse(st, response, 'forward');

                // across the hole, so the feed picks up from here
                if (response.hasMore === false && !st.reachesLive) {
                    st.reachesLive = true;
                    this._syncRealtime();
                }
            })
            .catch((err) => {
                console.error('[DataEngine] forward fetch failed', err);
                backOff(st.retry.forward);
                this._emitAdapterError('prefetch_failed', err, symbol);
            })
            .finally(() => {
                st.forwardInFlight = false;
                this.eventBus.emit('data:prefetch-done', undefined);
                const queued = st.pendingForwardViewMax;
                st.pendingForwardViewMax = null;
                if (queued !== null && !this.destroyed) this._requestForward(symbol, queued);
            });
    }

    private _fetchBackward(symbol: string, viewMin: bigint): void {
        if (this.destroyed) return;
        const adapter = this._adapterFor(symbol);
        if (!adapter) return;
        const st = this._st(symbol);
        if (!st.hasMoreHistory) return;
        if (st.loadedFrom === null || !st.symbolInfo) return;

        const retry = () => {
            const queued = st.pendingBackwardViewMin;
            st.pendingBackwardViewMin = null;
            if (queued !== null) this._fetchBackward(symbol, queued);
        };
        if (st.backwardInFlight || this._waiting(st.retry.backward, retry)) {
            if (st.pendingBackwardViewMin === null || viewMin < st.pendingBackwardViewMin) {
                st.pendingBackwardViewMin = viewMin;
            }
            return;
        }

        const barNs = st.fetchBarNs;
        const _bwdTimeframe = this._fetchTimeframe(st, barNs);
        const lookbackNs = BigInt(this.maxLookbackBars) * this._lookbackBarNs(symbol);
        const session = st.symbolInfo.session ?? null;

        const rawTo = st.loadedFrom;
        // pass the duration, not an absolute time
        const targetTo = st.loadedFrom;
        const naiveFrom = viewMin - (viewMin % barNs) - lookbackNs;
        const rawFrom = session
            ? walkBackMarketNs(session, naiveFrom, targetTo - naiveFrom)
            : naiveFrom;

        // nothing older to fetch, this symbol's history already reaches past the
        // requested left edge. with per-symbol edges a pane can pan and emit a
        // viewMin well inside its own loaded data, so bail rather than issue an
        // inverted range that returns nothing
        if (rawFrom >= rawTo) return;

        st.backwardInFlight = true;
        const windows = this._openWindows(st, rawFrom, rawTo);

        // whole range is a session gap - weekend, holiday, overnight. advance
        // loadedFrom to the start of it so the next call doesnt re-request it
        if (windows.length === 0) {
            st.loadedFrom = rawFrom;
            this.eventBus.emit('data:session-gap', { from: rawFrom, to: rawTo, symbol });
            st.backwardInFlight = false;
            // keep draining queued requests, the view might scroll further back
            if (st.pendingBackwardViewMin !== null && st.hasMoreHistory && !this.destroyed) {
                const queued = st.pendingBackwardViewMin;
                st.pendingBackwardViewMin = null;
                this._fetchBackward(symbol, queued);
            }
            return;
        }

        const from = windows[0].from;
        const to = windows[windows.length - 1].to;

        if (adapter.fetchPreview) {
            adapter
                .fetchPreview({
                    symbolInfo: st.symbolInfo,
                    range: makeTimeRange(from, to),
                    timeframe: _bwdTimeframe,
                    direction: 'backward',
                })
                .then((response) => {
                    if (!this.destroyed) this.eventBus.emit('data:preview', response);
                })
                .catch((err) => console.error('[DataEngine] backward preview fetch failed', err));
        }

        adapter
            .fetchBars({
                symbolInfo: st.symbolInfo,
                range: makeTimeRange(from, to),
                timeframe: _bwdTimeframe,
                direction: 'backward',
                // no supplemental on backward fetches - _prependMaster throws it
                // away, so asking for it just makes the worker serialize and this
                // thread deserialize a huge 1s array for nothing. the bigger the
                // pan the worse the freeze.
            })
            .then((response) => {
                if (this.destroyed) return;
                recovered(st.retry.backward);
                const processed = this._process(response, st, { snapAt: rawTo });

                if (!processed || isEmptyChunk(processed)) {
                    st.loadedFrom = from;
                    st.hasMoreHistory = response.hasMore;
                    if (!response.hasMore) {
                        this.eventBus.emit('data:no-more-history', { symbol });
                    }
                    return;
                }

                st.loadedFrom = BigInt(processed.dataStart) * 1_000_000n;
                st.hasMoreHistory = response.hasMore;
                this._prependMaster(st, processed);
                // a throwing listener isn't a failed fetch
                try {
                    this._emitPrepend(st, processed, viewMin);
                } catch (err) {
                    console.error('[DataEngine] backward _emitPrepend failed', err);
                }

                if (!response.hasMore) {
                    this.eventBus.emit('data:no-more-history', { symbol });
                }
            })
            .catch((err) => {
                console.error('[DataEngine] backward fetch failed', err);
                // loadedFrom stays as is, or the pan clamp will never let the view reach far enough
                // to ask for this range again.
                // backOff() to back off first
                backOff(st.retry.backward);
                if (st.pendingBackwardViewMin === null || viewMin < st.pendingBackwardViewMin) {
                    st.pendingBackwardViewMin = viewMin;
                }
            })
            .finally(() => {
                st.backwardInFlight = false;
                if (st.pendingBackwardViewMin !== null && st.hasMoreHistory && !this.destroyed) {
                    const queued = st.pendingBackwardViewMin;
                    st.pendingBackwardViewMin = null;
                    this._fetchBackward(symbol, queued);
                }
            });
    }

    // supplemental bars for a fetch, or undefined when theyd be dead weight.
    // they exist to settle the forming candle out of sub-bars, so they only help
    // while strictly finer than what is being fetched - once the fetch resolution
    // catches up (a 1s chart on a 1s supplemental) the adapter ships a second
    // identical array that gets serialized and deserialized for nothing, doubling
    // the cost of every prefetch a pan triggers
    private _supplementalFor(st: SymbolState, fetchBarNs: bigint): bigint | undefined {
        const supplemental = st.supplementalResolution;
        if (supplemental === null || supplemental >= fetchBarNs) return undefined;
        return supplemental;
    }

    private _supplementalRange(
        fetchBarNs: bigint,
        from: bigint,
        to: bigint,
    ): TimeRange | undefined {
        const horizon = isoToNs(this.horizonIso);
        const start = bigMax(from, horizon - fetchBarNs);
        if (start <= from) return undefined; // nothing to trim
        if (start >= to) return undefined; // playhead is past this window
        return makeTimeRange(start, to);
    }

    private _symbolSearchMode(): SymbolSearchMode {
        return this.adapter?.getCapabilities?.().symbolSearch ?? 'none';
    }

    // keystroke debounce for the picker. the adapter's own value wins, otherwise
    // it follows the mode - a network search wants the wait, an in-memory one
    // only suffers from it. a plugin source searching a rate-limited API can ask
    // for longer even when the adapter matches in memory, so take the slowest
    private _symbolSearchDebounceMs(mode: SymbolSearchMode): number {
        const declared = this.adapter?.getCapabilities?.().symbolSearchDebounceMs;
        const own =
            typeof declared === 'number' && declared >= 0
                ? declared
                : mode === 'server'
                  ? DEFAULT_SYMBOL_SEARCH_DEBOUNCE_MS
                  : 0;
        return Math.max(own, this.config.plugins?.searchDebounceMs() ?? 0);
    }

    // serve one symbol search. server mode goes straight to the adapter, none
    // mode fetches the universe once and matches here. either way only the newest
    // requestId may emit, so a slow answer to an old query cant clobber a new one
    private async _searchSymbols(requestId: string, request: SymbolSearchRequest): Promise<void> {
        // no host adapter is not a dead end - a chart can be driven entirely by
        // plugin sources, and _withPluginSymbols still has answers
        if (this.destroyed) return;

        // a newer search wins. adapters that honor the signal stop now, the rest
        // just have their answer dropped below
        this.symbolSearchAbort?.abort();
        this.latestSymbolSearchId = requestId;

        const mode = this._symbolSearchMode();
        const key = symbolSearchCacheKey(request);

        if (mode === 'server') {
            const cached = this.symbolSearchCache.get(key);
            if (cached) {
                this._cacheSymbolSearch(key, cached); // refresh its LRU position
                this._emitSymbolSearch(
                    requestId,
                    await this._withPluginSymbols(cached, request),
                    mode,
                );
                return;
            }
        }

        const controller = new AbortController();
        this.symbolSearchAbort = controller;

        const stale = () =>
            this.destroyed || controller.signal.aborted || this.latestSymbolSearchId !== requestId;

        try {
            let response: SymbolSearchResponse;
            if (mode === 'server') {
                response = normalizeSymbolSearchResponse(
                    await this.adapter.searchSymbols({ ...request, signal: controller.signal }),
                );
            } else {
                response = searchSymbolsLocally(await this._loadSymbolUniverse(), request);
            }

            if (stale()) return;

            // cache the adapter's answer on its own - plugin symbols come and go
            // with the plugin, so they must not be baked into it
            if (mode === 'server') this._cacheSymbolSearch(key, response);
            this._emitSymbolSearch(requestId, await this._withPluginSymbols(response, request), mode);
        } catch (err) {
            if (stale()) return;
            console.error('[DataEngine] symbol search failed', err);
            this.eventBus.emit('data:search-symbols-error', {
                requestId,
                code: err instanceof DataAdapterError ? err.code : 'unknown',
                message: err instanceof Error ? err.message : String(err),
            });
        } finally {
            if (this.symbolSearchAbort === controller) this.symbolSearchAbort = null;
        }
    }

    // the universe behind local matching. fetched once per adapter and shared by
    // every concurrent search, so its deliberately not tied to any one search's
    // AbortSignal - it outlives them
    private _loadSymbolUniverse(): Promise<SymbolInfo[]> {
        if (this.symbolUniverse) return Promise.resolve(this.symbolUniverse);
        const adapter = this.adapter;
        if (!adapter) return Promise.resolve([]);

        if (!this.symbolUniverseInFlight) {
            this.symbolUniverseInFlight = Promise.resolve(adapter.searchSymbols({ query: '' }))
                .then((result) => {
                    const symbols = normalizeSymbolSearchResponse(result).symbols;
                    this.symbolUniverse = symbols;
                    return symbols;
                })
                .finally(() => {
                    this.symbolUniverseInFlight = null;
                });
        }

        return this.symbolUniverseInFlight;
    }

    // plugin-registered symbols go in front: someone who registered a source is
    // looking for its symbols, and an adapter with a big universe would bury them
    private async _withPluginSymbols(
        response: SymbolSearchResponse,
        request: SymbolSearchRequest,
    ): Promise<SymbolSearchResponse> {
        const plugins = this.config.plugins;
        if (!plugins) return response;
        let extra: SymbolInfo[];
        try {
            extra = await plugins.search(request);
        } catch (err) {
            console.error('[DataEngine] plugin symbol search failed', err);
            return response;
        }
        if (!extra.length) return response;

        const taken = new Set(extra.map((s) => s.symbol));
        return {
            ...response,
            symbols: [...extra, ...response.symbols.filter((s) => !taken.has(s.symbol))],
        };
    }

    private _emitSymbolSearch(
        requestId: string,
        response: SymbolSearchResponse,
        mode: SymbolSearchMode,
    ): void {
        this.eventBus.emit('data:search-symbols-response', {
            requestId,
            symbols: response.symbols,
            hasMore: response.hasMore ?? false,
            cursor: response.cursor,
            mode,
            debounceMs: this._symbolSearchDebounceMs(mode),
        });
    }

    private _cacheSymbolSearch(key: string, response: SymbolSearchResponse): void {
        this.symbolSearchCache.delete(key);
        this.symbolSearchCache.set(key, response);
        if (this.symbolSearchCache.size > SYMBOL_SEARCH_CACHE_MAX) {
            const oldest = this.symbolSearchCache.keys().next().value;
            if (oldest !== undefined) this.symbolSearchCache.delete(oldest);
        }
    }

    private _cancelSymbolSearch(): void {
        this.symbolSearchAbort?.abort();
        this.symbolSearchAbort = null;
        this.latestSymbolSearchId = null;
    }

    // the coarsest period on screen for this symbol. warmup is
    // counted in bars, so an indicator on the 1h pane needs maxLookbackBars x 1h
    // of history, and sizing that pad off the finest pane fetches a fraction of
    // what it takes to prime it
    private _lookbackBarNs(symbol: string): bigint {
        let coarsest = this.state.get('timeframe').barNs;
        for (const pane of this.paneResolutions.values()) {
            if (pane.symbol !== symbol) continue;
            if (pane.barNs > coarsest) coarsest = pane.barNs;
        }
        return coarsest;
    }

    // a pane announced the instrument, timeframe and window it shows - on mount,
    // on any change to them, and whenever a pan or zoom settles
    private _onPaneResolution(
        id: number,
        symbol: string,
        barNs: bigint,
        viewFrom?: bigint,
        viewTo?: bigint,
    ): void {
        if (this.destroyed) return;

        // barNs 0 is a withdrawal - the pane unmounted or moved off this symbol
        if (barNs <= 0n || !symbol) {
            if (this.paneResolutions.get(id)?.symbol === symbol || !symbol) {
                this.paneResolutions.delete(id);
            }
            return;
        }

        const nextFrom = viewFrom ?? null;
        const nextTo = viewTo ?? null;
        const prev = this.paneResolutions.get(id);
        const unchanged =
            prev?.symbol === symbol &&
            prev.barNs === barNs &&
            prev.viewFrom === nextFrom &&
            prev.viewTo === nextTo;
        if (unchanged) return;

        // decide between a pan and a change in resolution
        const switched = !prev || prev.symbol !== symbol || prev.barNs !== barNs;
        this.paneResolutions.set(id, { symbol, barNs, viewFrom: nextFrom, viewTo: nextTo });

        const st = this._states.get(symbol);
        if (!st?.symbolInfo) return; // not loaded yet, the load will size itself
        this._ensureResolution(
            st,
            switched && nextFrom !== null && nextTo !== null
                ? { from: nextFrom, to: nextTo }
                : null,
        );
    }

    /**
     * The resolution one window needs to serve every pane on this symbol: the
     * coarsest supported one that divides all their timeframes. The gcd, because
     * only a period that divides a timeframe lands on its bucket boundaries.
     * null when nothing supported can build it.
     */
    private _fetchBarNsFor(st: SymbolState, symbol: string): bigint | null {
        let need = 0n;
        for (const pane of this.paneResolutions.values()) {
            if (pane.symbol !== symbol || pane.barNs <= 0n) continue;
            need = need === 0n ? pane.barNs : _gcd(need, pane.barNs);
        }
        // no pane has announced - a headless host, or the first load before any
        // pane has mounted. shared state carries the focused timeframe.
        if (need === 0n) need = this.state.get('timeframe').barNs;
        return servableBarNs(st.symbolInfo?.supportedResolutions, need);
    }

    /** Finest resolution the adapter declares, or the view's own when it declares none. */
    private _finestSupported(st: SymbolState): bigint {
        const supported = st.symbolInfo?.supportedResolutions;
        if (!supported?.length) return this.state.get('timeframe').barNs;
        return supported.reduce((a, b) => (b < a ? b : a));
    }

    // coarsest supported resolution no finer than `capBarNs`. for fetches that
    // get replayed rather than drawn - no bucket grid to line up with, so this
    // one doesnt care about dividing anything
    private _coarsestSupportedUpTo(st: SymbolState, capBarNs: bigint): bigint {
        const supported = st.symbolInfo?.supportedResolutions;
        if (!supported?.length) return capBarNs;
        let best: bigint | null = null;
        for (const r of supported) {
            if (r <= capBarNs && (best === null || r > best)) best = r;
        }
        return best ?? this._finestSupported(st);
    }

    // the Timeframe to hand the adapter for a fetch. keeps the active view
    // timeframe when its barNs matches (so its label/defaultBars survive) or
    // resolves one for the fetch resolution
    private _fetchTimeframe(st: SymbolState, fetchBarNs: bigint): Timeframe {
        const viewTf = this.state.get('timeframe');
        return fetchBarNs === viewTf.barNs ? viewTf : timeframeFromBarNs(fetchBarNs);
    }

    // Response processing

    private _process(
        response: BarResponse,
        st: SymbolState,
        carry: { book?: BookState; snapAt?: bigint } = {},
    ): DataChunk | null {
        if (response._preProcessed) {
            const pre = response._preProcessed as any;
            // older pre-processed payloads dont carry a kind
            if (!pre.kind) return { kind: 'l3', ...pre } as L3DataChunk;
            return pre as DataChunk;
        }

        const barNs = this.state.get('timeframe').barNs;

        switch (st.symbolInfo?.dataLevel ?? 'l3') {
            case 'ohlcv':
                if (response.supplementalBars?.length) {
                    return processOhlcvWithSupplemental(
                        response.ohlcvBars ?? [],
                        response.supplementalBars,
                        barNs,
                    );
                }
                return processOhlcvChunk(response.ohlcvBars ?? [], barNs);
            case 'tick':
                return processTickChunk(response.ticks ?? [], barNs, this.fpOptions);
            case 'l2':
                return processL2Chunk(response.l2Snapshots ?? [], barNs);
            default:
                return processL3Chunk(response.events ?? [], barNs, this.fpOptions, carry);
        }
    }

    // process a whole new window with its forming buckete and the book where that starts
    private _processWindow(response: BarResponse, st: SymbolState) {
        const forming = formingOf(st.symbolInfo?.dataLevel ?? 'l3', response, this._chunkBarNs());
        const processed = this._process(response, st, { snapAt: forming?.bucket });
        const book = (processed as L3DataChunk | null)?.bookAt ?? null;
        return { processed, forming, book };
    }

    // the book just before the chunk joined the forming bucket
    private _bookBefore(st: SymbolState, trimFromNs: bigint | null): BookState | undefined {
        if (!st.formingBook) return undefined;
        const book = cloneBook(st.formingBook);
        // start the chunk after the forming bucket
        if (trimFromNs === null) {
            for (const e of st.forming?.items ?? []) applyEvent(book, e as MboEvent);
        }
        return book;
    }

    // Realtime

    private _handleRealtimeBar(st: SymbolState, bar: BarResponse): void {
        if (this.destroyed) return;
        if (!st.master) return;
        if (this._appendResponse(st, bar, 'realtime')) st.hasMoreForward = true;
    }

    // the bucket size _process builds footprints at
    private _chunkBarNs(): bigint {
        return this.state.get('timeframe').barNs;
    }

    // a forward page or live chunk onto the right edge. false when it brought nothing new
    private _appendResponse(st: SymbolState, response: BarResponse, from: string): boolean {
        if (!st.master) return false;
        const level = st.master.dataLevel;
        const barNs = this._chunkBarNs();
        // the seam comes back on every page and chunk, and the forming bucket gets rebuilt whole
        const joined = joinForming(level, st.forming, response, barNs);
        if (!joined) return false;
        const next = formingOf(level, joined.response, barNs);
        const processed = this._process(joined.response, st, {
            book: level === 'l3' ? this._bookBefore(st, joined.trimFromNs) : undefined,
            snapAt: next?.bucket,
        });
        if (!processed || isEmptyChunk(processed)) return false;

        const oldEnd = st.loadedTo;
        st.loadedTo = BigInt(processed.dataEnd) * 1_000_000n;
        const horizon = isoToNs(this.horizonIso);
        if (from === 'realtime' && oldEnd !== null && horizon >= oldEnd && st.loadedTo > horizon)
            this.horizonIso = _nsToIso(st.loadedTo);
        this._growMaster(st, processed, joined.trimFromNs);
        st.forming = next;
        st.formingBook = (processed as L3DataChunk).bookAt ?? null;
        try {
            this._emitAppend(st, processed);
        } catch (err) {
            console.error(`[DataEngine] ${from} _emitAppend failed`, err);
        }
        return true;
    }

    // Master mutations

    // `trimFromNs` means the chunk rebuilt everything from there on, so the held copy goes first
    private _growMaster(st: SymbolState, chunk: DataChunk, trimFromNs: bigint | null = null): void {
        const master = st.master;
        if (!master) return;
        const dl = master.dataLevel;

        switch (dl) {
            case 'l3':
            case 'tick': {
                // one copy each
                // consumers hold the old ones so nothing is changed in place
                const c = chunk as L3DataChunk | TickDataChunk;
                const cut = <T extends { ts: bigint }>(a: T[]) => trimFromNs === null ? a.length : firstTsAtOrAfter(a, trimFromNs);

                master.trades = _joined(master.trades, cut(master.trades), c.trades);
                master.priceHistory = _joined(master.priceHistory, cut(master.priceHistory), c.priceHistory);
                master.footprintBars = _joined(master.footprintBars, cut(master.footprintBars), c.footprintBars);

                if (dl === 'l3') {
                    const keep =
                        trimFromNs === null
                            ? master.compactBuf.byteLength
                            : firstEventAtOrAfter(master.compactBuf, trimFromNs) * BYTES_PER_EVENT;
                    const add = (c as L3DataChunk).compactBuf;
                    const merged = new Uint8Array(keep + add.byteLength);
                    merged.set(new Uint8Array(master.compactBuf, 0, keep), 0);
                    merged.set(new Uint8Array(add), keep);
                    master.compactBuf = merged.buffer;
                }
                master.ohlcvBars = _deriveOhlcvFromFootprint(master.footprintBars);
                master.dataEnd = c.dataEnd > 0 ? c.dataEnd : master.dataEnd;
                break;
            }
            case 'ohlcv': {
                const c = chunk as OhlcvDataChunk;
                if (c.ohlcvBars.length) {
                    master.ohlcvBars.replaceRange(c.ohlcvBars[0].time, Infinity, []);
                    master.ohlcvBars.append(c.ohlcvBars);
                }
                master.dataEnd = c.dataEnd > 0 ? c.dataEnd : master.dataEnd;
                if (c.supplemental?.length) {
                    if (!master.supplemental) {
                        master.supplemental = c.supplemental.map((s: any) => ({
                            ...s,
                            bars: [...s.bars],
                        }));
                    } else {
                        for (const sup of c.supplemental) {
                            const existing = master.supplemental.find(
                                (s: any) => s.resolution === sup.resolution,
                            );
                            // the supplemental 1s array is the biggest one here,
                            // and concat-copying it on each append was the main
                            // playback-forward freeze
                            if (existing) {
                                for (const b of sup.bars) existing.bars.push(b);
                            } else {
                                master.supplemental.push({ ...sup, bars: [...sup.bars] });
                            }
                        }
                    }
                }
                break;
            }
            case 'l2': {
                const c = chunk as L2DataChunk;
                master.priceHistory = master.priceHistory.concat(c.priceHistory);
                master.dataEnd = c.dataEnd > 0 ? c.dataEnd : master.dataEnd;
                break;
            }
        }

        master.barNs = this._masterBarNs(st);
        this._syncShared();
        this._scheduleBudget();
    }

    private _prependMaster(st: SymbolState, chunk: DataChunk): void {
        const master = st.master;
        if (!master) return;
        const dl = master.dataLevel;

        switch (dl) {
            case 'l3': {
                const c = chunk as L3DataChunk;
                // what was held started from an empty book
                const held = carryBookInto(
                    c.bookAt ?? bookAfter(c.compactBuf),
                    master.compactBuf,
                    master.priceHistory,
                    c.priceHistory.at(-1),
                );
                const total = c.compactBuf.byteLength + master.compactBuf.byteLength;
                const merged = new Uint8Array(total);
                merged.set(new Uint8Array(c.compactBuf), 0);
                merged.set(new Uint8Array(master.compactBuf), c.compactBuf.byteLength);
                master.compactBuf = merged.buffer;
                master.trades = c.trades.concat(master.trades);
                master.priceHistory = c.priceHistory.concat(held);
                master.footprintBars = _prependFootprints(
                    c.footprintBars,
                    master.footprintBars,
                    master.trades,
                    this._masterBarNs(st),
                    this.fpOptions,
                );
                master.ohlcvBars = _deriveOhlcvFromFootprint(master.footprintBars);
                master.dataStart = c.dataStart > 0 ? c.dataStart : master.dataStart;
                break;
            }
            case 'tick': {
                const c = chunk as TickDataChunk;
                master.trades = c.trades.concat(master.trades);
                master.priceHistory = c.priceHistory.concat(master.priceHistory);
                master.footprintBars = _prependFootprints(
                    c.footprintBars,
                    master.footprintBars,
                    master.trades,
                    this._masterBarNs(st),
                    this.fpOptions,
                );
                master.ohlcvBars = _deriveOhlcvFromFootprint(master.footprintBars);
                master.dataStart = c.dataStart > 0 ? c.dataStart : master.dataStart;
                break;
            }
            case 'ohlcv': {
                const c = chunk as OhlcvDataChunk;
                master.ohlcvBars.prepend(c.ohlcvBars);
                master.dataStart = c.dataStart > 0 ? c.dataStart : master.dataStart;
                break;
            }
            case 'l2': {
                const c = chunk as L2DataChunk;
                master.priceHistory = c.priceHistory.concat(master.priceHistory);
                master.dataStart = c.dataStart > 0 ? c.dataStart : master.dataStart;
                break;
            }
        }

        master.barNs = this._masterBarNs(st);
        this._syncShared();
        this._scheduleBudget();
    }

    // the period to declare for a symbol's master: for ohlcv the resolution its
    // bars were actually fetched at, for everything else the view timeframe the
    // events are bucketed into
    private _masterBarNs(st: SymbolState): bigint {
        const viewBarNs = this.state.get('timeframe').barNs;
        if (st.master?.dataLevel !== 'ohlcv') return viewBarNs;
        return st.fetchBarNs > 0n ? st.fetchBarNs : viewBarNs;
    }

    // mirror the focused symbol's master into the public sharedData snapshot
    private _syncShared(): void {
        const master = this._states.get(this.activeSymbol)?.master;
        if (!master) return;
        this.sharedData.dataLevel = master.dataLevel;
        this.sharedData.compactBuf = master.compactBuf;
        this.sharedData.trades = master.trades;
        this.sharedData.priceHistory = master.priceHistory;
        this.sharedData.footprintBars = master.footprintBars;
        this.sharedData.ohlcvBars = master.ohlcvBars;
        this.sharedData.barNs = master.barNs;
        this.sharedData.dataStart = master.dataStart;
        this.sharedData.dataEnd = master.dataEnd;
        this.sharedData.supplemental = master.supplemental ?? null;
    }

    // EventBus wiring

    private _subscribeToEventBus(): void {
        this.unsubs.push(
            this.eventBus.on('data:request-forward', ({ viewMax, symbol }) => {
                this._requestForward(this._targetSymbol(symbol), viewMax);
            }),
            this.eventBus.on('data:request-backward', ({ viewMin, symbol }) => {
                this._fetchBackward(this._targetSymbol(symbol), viewMin);
            }),
            this.eventBus.on('data:rehydrate', () => this.rehydrate()),
            this.eventBus.on('data:retry', ({ symbol }) => {
                this.load(symbol ?? this.activeSymbol).catch(() => {});
            }),
            this.eventBus.on('data:pane-resolution', ({ id, symbol, barNs, viewFrom, viewTo }) =>
                this._onPaneResolution(id, symbol, barNs, viewFrom, viewTo),
            ),
            this.eventBus.on('data:rebuild-footprint', ({ barNs, fpOptions }) =>
                this.rebuildFootprint(barNs, fpOptions),
            ),
            this.eventBus.on('data:prefetch', ({ spanNs, symbol }) => {
                // a named symbol paginates only itself. an unnamed one is the
                // playback clock asking for the whole layout, so every loaded
                // symbol gets extended - otherwise panes on anything but the
                // focused instrument run off their edge mid-replay and freeze
                if (symbol && this._states.has(symbol)) {
                    this._fetchForward(symbol, spanNs);
                    return;
                }
                for (const [sym, st] of this._states) {
                    if (st.symbolInfo && this._onScreen(sym)) this._fetchForward(sym, spanNs);
                }
            }),
            this.eventBus.on('data:seek-load', ({ tNs, fromNs }) => {
                void this.seekLoad(tNs, fromNs);
            }),
            this.eventBus.on('chart:set-symbol', ({ symbol }) => {
                if (symbol && symbol !== this.activeSymbol) {
                    this._applySymbol(symbol);
                }
            }),
            this.eventBus.on('data:search-symbols', ({ requestId, request }) => {
                void this._searchSymbols(requestId, request);
            }),
            this.eventBus.on('data:search-symbols-cancel', ({ requestId }) => {
                if (this.latestSymbolSearchId === requestId) this._cancelSymbolSearch();
            }),
            this.eventBus.on('data:request-symbol-resolved', ({ symbol }) => {
                const symbolInfo = this.resolvedSymbols.get(symbol);
                if (symbolInfo) {
                    this.eventBus.emit('data:symbol-resolved', { symbolInfo });
                    return;
                }
                // the toolbar and the order ticket ask about symbols that have
                // never been charted, and a plugin source can answer for its own
                // without loading anything
                void this.config.plugins?.resolve(symbol).then((info) => {
                    if (info && !this.destroyed) {
                        this.eventBus.emit('data:symbol-resolved', { symbolInfo: info });
                    }
                });
            }),
            this.eventBus.on('timeframe:change', ({ tf }) => this._onTimeframeChange(tf.barNs)),
            this.eventBus.on('playback:seek', ({ tNs }) => {
                this.playheadNs = tNs;
            }),
        );
    }

    // Emit helpers

    // off-thread bucketing for non-ohlcv levels, returns buffers to put on events
    private async _runLoadIngest(master: MasterBuffer): Promise<{
        ingestOhlcvBuf?: ArrayBuffer;
        ingestBucketedPhBuf?: ArrayBuffer;
        ingestTradesBuf?: ArrayBuffer;
        ingestPhBuf?: ArrayBuffer;
    }> {
        if (master.dataLevel === 'ohlcv') return {};
        const tradesBuf = serializeTrades(master.trades as any);
        const phBuf = serializePriceHistory(master.priceHistory);
        const result = await loadIngestAsync({ tradesBuf, phBuf, barNs: master.barNs });
        return {
            ingestOhlcvBuf: result.ohlcvBuf,
            ingestBucketedPhBuf: result.bucketedPhBuf,
            ingestTradesBuf: result.tradesBuf,
            ingestPhBuf: result.phBuf,
        };
    }

    // snapshot a symbol's master into the common data:load/append payload fields.
    // reads st.master directly rather than sharedData, so non-focused symbols
    // emit their own data to the right pane
    private _buildPayload(master: MasterBuffer) {
        return {
            dataLevel: master.dataLevel,
            compactBuf: master.compactBuf,
            trades: master.trades,
            priceHistory: master.priceHistory,
            footprintBars: master.footprintBars,
            bars: master.ohlcvBars,
            barNs: master.barNs,
            dataStart: master.dataStart,
            dataEnd: master.dataEnd,
            supplemental: master.supplemental ?? null,
        };
    }

    private async _emitLoad(
        st: SymbolState,
        rehydrate = false,
        replaced = false,
    ): Promise<void> {
        const master = st.master;
        if (!master) return;
        const ingestBufs = await this._runLoadIngest(master);
        this.eventBus.emit('data:load', {
            symbol: master.symbolInfo.symbol,
            ...this._buildPayload(master),
            session: st.session,
            playFromIso: this.horizonIso,
            rehydrate,
            replaced,
            ...ingestBufs,
        });
    }

    // the pane extends its own buckets, re-bucketing the whole master here was O(n) a chunk
    private _emitAppend(st: SymbolState, chunk: DataChunk): void {
        const master = st.master;
        if (!master) return;
        // ohlcvBars is only the chunk's new bars, so the consumer extends its own
        // incrementally. `bars` is the whole master.
        this.eventBus.emit('data:append', {
            symbol: master.symbolInfo.symbol,
            ...this._buildPayload(master),
            ohlcvBars: 'ohlcvBars' in chunk ? chunk.ohlcvBars : [],
            session: st.session,
        });
    }

    // ohlcvBars is just the page, every other field the full master
    private _emitPrepend(st: SymbolState, chunk: DataChunk, viewMin: bigint): void {
        const master = st.master;
        if (!master) return;
        this.eventBus.emit('data:prepend', {
            symbol: master.symbolInfo.symbol,
            dataLevel: master.dataLevel,
            compactBuf: master.compactBuf,
            trades: master.trades,
            priceHistory: master.priceHistory,
            footprintBars: master.footprintBars,
            ohlcvBars: 'ohlcvBars' in chunk ? chunk.ohlcvBars : [],
            bars: master.ohlcvBars,
            barNs: master.barNs,
            dataStart: master.dataStart,
            viewMin,
            session: st.session,
        });
    }

    // the adapters own code when it gave one
    // to like differentiate between rate limited vs offline etc
    private _emitAdapterError(fallbackCode: string, err: unknown, symbol?: string): void {
        const code = err instanceof DataAdapterError ? err.code : fallbackCode;
        const message = err instanceof Error ? err.message : String(err);
        this.eventBus.emit('data:status', {
            status: 'error',
            error: { code, message },
            symbol,
        });
    }

    private _onTimeframeChange(_newActiveBarNs: bigint): void {
        for (const [symbol, st] of this._states) {
            if (!this._onScreen(symbol)) continue;
            this._ensureResolution(st, null);
        }
    }

    // whether a pane is showing this sybol (loaded is another thing)
    private _onScreen(symbol: string): boolean {
        if (this.paneResolutions.size === 0) return true;
        for (const pane of this.paneResolutions.values()) {
            if (pane.symbol === symbol && pane.barNs > 0n) return true;
        }
        return false;
    }

    // Memory budget

    private _scheduleBudget(): void {
        if (this.budgetTimer !== null || !Number.isFinite(this.maxBytes)) return;
        this.budgetTimer = setTimeout(() => {
            this.budgetTimer = null;
            this._enforceBudget();
        }, 0);
    }

    // evicts down to half the budget so the next few pages dont set it off again
    private _enforceBudget(): void {
        if (this.destroyed) return;
        const held = [...this._states].filter(([, st]) => BUDGETED.has(st.master?.dataLevel as DataLevel));
        const bytes = new Map(held.map(([, st]) => [st, heldBytes(st.master!)]));
        let total = 0;
        for (const n of bytes.values()) total += n;
        if (total <= this.maxBytes) {
            this.budgetWarned = false;
            return;
        }
        let excess = total - this.maxBytes / 2;

        for (const [symbol, st] of held) {
            if (excess <= 0) return;
            if (symbol === this.activeSymbol || this._onScreen(symbol)) continue;
            excess -= bytes.get(st)!;
            this._dropMaster(st);
            this._states.delete(symbol);
        }

        type Seg = {
            symbol: string;
            st: SymbolState;
            front: boolean;
            bars: number;
            rowBytes: number;
            freed: number;
        };
        const segs: Seg[] = [];
        const bounds = new Map<SymbolState, { lo: number; hi: number }>();
        for (const [symbol, st] of held) {
            if (!this._states.has(symbol) || st.staging) continue;
            // keep protected data
            const keep = this._protectedRange(symbol, st);
            if (!keep) continue;

            const bars = st.master!.ohlcvBars;
            // a page in flight lands against the edge it was asked from
            const lo = st.backwardInFlight ? 0 : bars.lowerBound(keep.fromMs);
            const hi = st.forwardInFlight ? bars.length : bars.upperBound(keep.toMs);
            if (hi <= lo) continue;

            bounds.set(st, { lo, hi });
            const ohlcv = st.master!.dataLevel === 'ohlcv';
            const rowBytes = ohlcv ? (bars.bid ? 8 : 6) * 8 : bytes.get(st)! / bars.length;
            // ohlcv keeps a quarter of slack on every cut, so a dropped bar frees 1.25 rows
            const freed = ohlcv ? rowBytes * 1.25 : rowBytes;
            if (lo > 0) segs.push({ symbol, st, front: true, bars: lo, rowBytes, freed });
            if (hi < bars.length) segs.push({ symbol, st, front: false, bars: bars.length - hi, rowBytes, freed });
        }

        const drops = new Map<SymbolState, { front: number; back: number; symbol: string }>();
        segs.sort((a, b) => b.bars * b.rowBytes - a.bars * a.rowBytes);
        for (const seg of segs) {
            if (excess <= 0) break;
            const n = Math.min(seg.bars, Math.ceil(excess / seg.freed));
            excess -= n * seg.freed;

            const d = drops.get(seg.st) ?? { front: 0, back: 0, symbol: seg.symbol };
            if (seg.front) d.front = n;
            else d.back = n;
            drops.set(seg.st, d);
        }

        for (const [st, d] of drops) {
            const bars = st.master!.ohlcvBars;
            const { hi: keepHi } = bounds.get(st)!;
            // cut on bucket edges to avoid drawing a half candle on the coarsest pane
            const periodMs = Number(this._lookbackBarNs(d.symbol) / 1_000_000n) || 1;
            const bucket = (t: number) => Math.floor(t / periodMs) * periodMs;
            const lo = d.front > 0 ? bars.lowerBound(bucket(bars.time[d.front])) : 0;
            let hi = bars.length;
            if (d.back > 0) hi = Math.max(keepHi, bars.lowerBound(bucket(bars.time[bars.length - d.back])));
            if (lo > 0 || hi < bars.length) this._cut(st, lo, hi);
        }

        if (excess > this.maxBytes / 2 && !this.budgetWarned) {
            this.budgetWarned = true;
            console.warn('[DataEngine] what the panes show is over the data budget, keeping it');
        }
    }

    // the protected range is just what data we should never evict.
    // like every pane's view on this symbol (with pane room) and indicator lookback,
    // the playhead and the live edge while streaming. null when no pane says where its looking
    private _protectedRange(
        symbol: string,
        st: SymbolState,
    ): { fromMs: number; toMs: number } | null {
        let from: bigint | null = null;
        let to: bigint | null = null;
        //protect panes' views
        for (const pane of this.paneResolutions.values()) {
            if (pane.symbol !== symbol || pane.viewFrom === null || pane.viewTo === null) continue;
            const pad = bigMin(pane.viewTo - pane.viewFrom, SWITCH_PAD_BARS * st.fetchBarNs);
            //also take indicator lookback into account
            const f = pane.viewFrom - pad - BigInt(this.maxLookbackBars) * pane.barNs;
            const t = pane.viewTo + pad;
            if (from === null || f < from) from = f;
            if (to === null || t > to) to = t;
        }
        if (from === null || to === null) return null;

        // and playhead. not while live tho, thats the live edge, and a view a year back
        // would pin everything in between. cutting it pauses the feed instead
        if (this.playheadNs !== null && !this._streaming(symbol)) {
            const p = this._lookbackBarNs(symbol);
            if (this.playheadNs - p < from) from = this.playheadNs - p;
            if (this.playheadNs + p > to) to = this.playheadNs + p;
        }
        return { fromMs: Number(from / 1_000_000n), toMs: Number(to / 1_000_000n) };
    }

    // keep bars [lo, hi) and hand panes the smaller store
    private _cut(st: SymbolState, lo: number, hi: number): void {
        const master = st.master!;
        const old = master.ohlcvBars;
        this._evict(st, old, 0, lo);
        this._evict(st, old, hi, old.length);
        const ohlcv = master.dataLevel === 'ohlcv';
        const kept = old.slice(lo, hi, ohlcv ? Math.ceil((hi - lo) / 4) : 0);
        master.ohlcvBars = kept;
        const first = kept.time[0];
        const last = kept.time[kept.length - 1];
        if (!ohlcv) this._cutRaw(st, lo > 0 ? first : null, hi < old.length ? old.time[hi] : null);
        if (lo > 0) {
            if (ohlcv) master.dataStart = first;
            st.loadedFrom = BigInt(Math.round(first)) * 1_000_000n;
            st.hasMoreHistory = true;
        }
        if (hi < old.length) {
            if (ohlcv) master.dataEnd = last;
            // raw data ends before the first dropped bar, so the next page starts there
            st.loadedTo = BigInt(Math.round(ohlcv ? last : old.time[hi])) * 1_000_000n;
            st.hasMoreForward = true;
            st.reachesLive = false;
        }
        if (master.supplemental) {
            const end = last + Number(st.fetchBarNs / 1_000_000n);
            for (const s of master.supplemental) {
                s.bars = s.bars.filter((b) => b.time >= first && b.time < end);
            }
        }
        this._syncShared();
        this._syncRealtime();
        void this._emitLoad(st, /* rehydrate */ false, /* replaced */ true).catch((err) =>
            console.error('[DataEngine] eviction _emitLoad failed', err),
        );
    }

    // tick/l3 keep what's at or after fromMs and before toMs
    private _cutRaw(st: SymbolState, fromMs: number | null, toMs: number | null): void {
        const m = st.master!;
        const fromNs = fromMs === null ? null : BigInt(Math.round(fromMs)) * 1_000_000n;
        const toNs = toMs === null ? null : BigInt(Math.round(toMs)) * 1_000_000n;
        const cut = <T extends { ts: bigint }>(a: T[]) =>
            a.slice(
                fromNs === null ? 0 : firstTsAtOrAfter(a, fromNs),
                toNs === null ? a.length : firstTsAtOrAfter(a, toNs),
            );
        m.trades = cut(m.trades);
        m.priceHistory = cut(m.priceHistory);
        m.footprintBars = cut(m.footprintBars);
        if (m.dataLevel === 'l3') m.compactBuf = eventsBetween(m.compactBuf, fromNs, toNs);

        const ts = (i: number) =>
            m.dataLevel === 'l3' && m.compactBuf.byteLength > 0
                ? Number(new DataView(m.compactBuf).getBigInt64(i * BYTES_PER_EVENT, true) / 1_000_000n)
                : Number(m.trades.at(i)!.ts / 1_000_000n);
        if (toNs !== null) {
            // the next page starts a fresh bucket on the book thats left
            st.forming = null;
            st.formingBook = m.dataLevel === 'l3' ? bookAfter(m.compactBuf) : null;
        }
        const n = m.dataLevel === 'l3' ? m.compactBuf.byteLength / BYTES_PER_EVENT : m.trades.length;
        if (n === 0) return;
        if (fromNs !== null) m.dataStart = ts(0);
        if (toNs !== null) m.dataEnd = ts(n - 1);
    }

    private _streaming(symbol: string): boolean {
        return this.realtimeUnsub !== null && symbol === this.activeSymbol;
    }

    private _dropMaster(st: SymbolState): void {
        if (st.master) this._evict(st, st.master.ohlcvBars);
        st.master = null;
        st.forming = null;
        st.formingBook = null;
    }

    // hands bars lo, hi of a store about to be dropped to the adapters onevict
    private _evict(st: SymbolState, bars: BarStore, lo = 0, hi = bars.length): void {
        const info = st.symbolInfo;
        if (!info || st.master?.dataLevel !== 'ohlcv') return;
        const adapter = this._adapterFor(info.symbol);
        if (!adapter?.onEvict) return;

        // the forming bar isnt closed yet
        if (hi === bars.length && this._streaming(info.symbol)) hi--;
        if (hi <= lo) return;

        const view = bars.view(lo, hi);
        const from = BigInt(Math.round(view.time[0])) * 1_000_000n;
        const to = BigInt(Math.round(view.time[view.length - 1])) * 1_000_000n + st.fetchBarNs;
        try {
            const pending = adapter.onEvict({
                symbolInfo: info,
                timeframe: this._fetchTimeframe(st, st.fetchBarNs),
                range: makeTimeRange(from, to),
                bars: view,
            });
            if (pending) pending.catch((err) => console.error('[DataEngine] onEvict failed', err));
        } catch (err) {
            console.error('[DataEngine] onEvict failed', err);
        }
    }

    /**
     * Reload the window at the resolution the panes need, when it isnt already.
     * A reload and not a patch - two periods in one store is what draws an hourly
     * candle in the middle of a 1m chart, and nothing downstream can tell.
     *
     * `switchWindow` is the span a pane that just changed period needs in hand,
     * and reloads even at the right resolution when history falls short of it.
     * Pans are not this method's business; they extend an edge.
     */
    private _ensureResolution(
        st: SymbolState,
        switchWindow: { from: bigint; to: bigint } | null,
    ): void {
        if (this.destroyed || !st.symbolInfo || !st.master) return;
        const symbol = st.symbolInfo.symbol;

        const need = this._fetchBarNsFor(st, symbol);
        // nothing supported can build it. the pane gate rejects it before it gets this far
        // but not if the chart is being driven programmatically so guard here too
        if (need === null) return;

        // left edge only. right edge is the forward prefetch's job.
        // tick/l3 events start mid-bucket, so the first bucket's slack doesnt count
        const slack = st.master.dataLevel === 'ohlcv' ? 0n : st.fetchBarNs;
        const shortOfHistory =
            switchWindow !== null &&
            (st.loadedFrom === null || st.loadedFrom > switchWindow.from + slack);
        if (need === st.fetchBarNs && !shortOfHistory) return;
        if (!shortOfHistory && this._rebucket(st, need)) return;

        const win = this._switchWindow(st, symbol, need);

        const staging = st.staging;
        if (
            staging &&
            staging.barNs === need &&
            staging.from <= win.from &&
            staging.to >= win.to
        ) {
            return;
        }

        void this._stageLoad(st, need, win.from, win.to, win.capped);
    }

    // tick/l3 events have no period, so a switch whose forming bucket is still held raw
    // re-buckets whats loaded instead of fetching it all again
    private _rebucket(st: SymbolState, barNs: bigint): boolean {
        const master = st.master;
        if (!master) return false;
        const level = master.dataLevel;
        const narrowed = narrowForming(level, st.forming, barNs);
        if (!narrowed) return false;
        let book: BookState | null = null;
        if (level === 'l3') {
            if (!st.formingBook) return false;
            book = cloneBook(st.formingBook);
            for (const e of narrowed.before) applyEvent(book, e as MboEvent);
        }

        // a switch already on its way would land over this
        st.stageToken++;
        st.staging = null;
        st.fetchBarNs = barNs;
        st.forming = narrowed.forming;
        st.formingBook = book;
        // the pane announces before the shared timeframe moves, so not _chunkBarNs()
        master.footprintBars = footprintFromTrades(master.trades, barNs, this.fpOptions);
        master.ohlcvBars = _deriveOhlcvFromFootprint(master.footprintBars);
        master.barNs = barNs;
        this._syncShared();
        this._syncRealtime();
        this._emitLoad(st, /* rehydrate */ false, /* replaced */ true).catch((err) =>
            console.error('[DataEngine] _rebucket _emitLoad failed', err),
        );
        return true;
    }

    private _switchWindow(
        st: SymbolState,
        symbol: string,
        fetchBarNs: bigint,
    ): { from: bigint; to: bigint; capped: boolean } {
        const lookbackNs = BigInt(this.maxLookbackBars) * fetchBarNs;
        const padNs = SWITCH_PAD_BARS * fetchBarNs;

        let from: bigint | null = null;
        let to: bigint | null = null;
        for (const pane of this.paneResolutions.values()) {
            if (pane.symbol !== symbol) continue;
            if (pane.viewFrom === null || pane.viewTo === null) continue;
            if (pane.viewTo <= pane.viewFrom) continue;
            // a screen either side, capped - a pane zoomed out to years would
            // otherwise pad in years
            const pad = bigMin(pane.viewTo - pane.viewFrom, padNs);
            const paneFrom = pane.viewFrom - pad - lookbackNs;
            const paneTo = pane.viewTo + pad;
            if (from === null || paneFrom < from) from = paneFrom;
            if (to === null || paneTo > to) to = paneTo;
        }

        if (from === null || to === null) {
            const anchor = isoToNs(this.horizonIso);
            const budgetNs = SWITCH_FALLBACK_BARS * fetchBarNs;
            from = anchor - budgetNs - lookbackNs;
            to = anchor + budgetNs;
        }
        // keep the old right edge (keep this!), or there's a hole up to the live bar.
        // unless that's over the budget: then stop at the view, and pans page across
        const edge = st.loadedTo === null ? null : st.loadedTo + st.fetchBarNs;
        if (edge === null || edge <= to) return { from, to, capped: false };
        if (Number((edge - from) / fetchBarNs) * BAR_BYTES > this.maxBytes) {
            return { from, to, capped: true };
        }
        return { from, to: edge, capped: false };
    }

    // Fetch [from, to] at `fetchBarNs` and swap it in. Built first and swapped on
    // success, unlike _loadWindow which resets up front: a failed switch has to
    // leave the chart on the data it is drawing.
    private async _stageLoad(
        st: SymbolState,
        fetchBarNs: bigint,
        from: bigint,
        to: bigint,
        capped: boolean,
    ): Promise<void> {
        if (this.destroyed || !st.symbolInfo) return;
        const adapter = this._adapterFor(st.symbolInfo.symbol);
        if (!adapter) return;

        const token = ++st.stageToken;
        const timeframe = this._fetchTimeframe(st, fetchBarNs);
        st.staging = { barNs: fetchBarNs, from, to };

        let response: BarResponse;
        try {
            response = await adapter.fetchBars({
                symbolInfo: st.symbolInfo,
                range: makeTimeRange(from, to),
                timeframe,
                direction: 'initial',
                supplementalBarNs: this._supplementalFor(st, fetchBarNs),
                supplementalRange: this._supplementalRange(fetchBarNs, from, to),
            });
        } catch (err) {
            // only this load's own record: a newer one has already replaced it
            if (token === st.stageToken) st.staging = null;
            this._emitAdapterError('fetch_failed', err, st.symbolInfo.symbol);
            return;
        }

        // superseded while this was out - that window is the one that counts
        if (this.destroyed || token !== st.stageToken) return;
        st.staging = null;

        const { processed, forming, book } = this._processWindow(response, st);
        if (!processed || isEmptyChunk(processed)) {
            // keep what we have rather than swapping in an empty window, and say
            // so - a pane waiting on this resolution is dimmed until it hears
            this.eventBus.emit('data:resolution-unavailable', {
                symbol: st.symbolInfo.symbol,
                barNs: fetchBarNs,
            });
            this.eventBus.emit('data:status', {
                status: 'ready',
                symbol: st.symbolInfo.symbol,
            });
            return;
        }

        this._dropMaster(st);
        st.loadedFrom = BigInt(processed.dataStart) * 1_000_000n;
        st.loadedTo = BigInt(processed.dataEnd) * 1_000_000n;
        st.hasMoreHistory = response.hasMore;
        st.hasMoreForward = true;
        if (capped) st.reachesLive = false;
        st.pendingForwardViewMax = null;
        st.fetchBarNs = fetchBarNs;
        st.master = this._buildMaster(st, processed, fetchBarNs);
        st.forming = forming;
        st.formingBook = book;

        this._syncShared();
        this._syncRealtime();
        this._scheduleBudget();
        await this._emitLoad(st, /* rehydrate */ false, /* replaced */ true);
    }

    // Helpers

    private _openWindows(st: SymbolState, from: bigint, to: bigint): SessionWindow[] {
        if (!st.session) return [{ from, to }];
        return clipToSession(st.session, from, to);
    }

}
