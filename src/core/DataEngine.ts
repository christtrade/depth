// pure orchestrator: owns the adapter lifecycle, drives fetchBars for initial /
// forward / backward loads, keeps the master buffer per data level, routes
// responses through the right processor, and emits on the bus so panes react.

import { TypedEventBus } from './TypedEventBus';
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
import { DataAdapterError, makeTimeRange } from '../interfaces/IDataAdapter';
import {
    normalizeSymbolSearchResponse,
    searchSymbolsLocally,
    symbolSearchCacheKey,
} from '../lib/symbol-search';
import type { FootprintOptions } from '../lib/types/footprint';
import type { SerialTrade } from '../lib/types';
import type { PriceHistory } from '../lib/types';
import type { FootprintBar } from '../lib/types/footprint';
import { processL3Chunk } from './processing/l3-processor';
import type { L3DataChunk } from './processing/l3-processor';
import {
    processOhlcvChunk,
    processOhlcvWithSupplemental,
    type OhlcvDataChunk,
} from './processing/ohlcv-processor';
import { processTickChunk, type TickDataChunk } from './processing/tick-processor';
import { processL2Chunk, type L2DataChunk } from './processing/l2-processor';
import { type DataChunk, isEmptyChunk } from './processing/data-chunk';
import { isoToNs } from '../lib/sampler';
import type { DataSourceRegistry } from './DataSourceRegistry';
import {
    loadIngestAsync,
    serializeTrades,
    serializePriceHistory,
} from '../lib/slice-worker-client';
import { ExecutionEngine } from './ExecutionEngine';
import { ChartState } from './ChartState';
import { Timeframe, timeframeFromBarNs } from '../lib/timeframes';
import { clipToSession, isMarketOpen, walkBackMarketNs } from './SessionUtils';
import type { SessionWindow } from './SessionUtils';
import { nextOpenNs } from './SessionUtils';

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
    ohlcvBars: OhlcvBar[];
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
    /** Populated for ohlcv; derived from footprintBars for l3/tick; empty for l2. */
    readonly ohlcvBars: OhlcvBar[];
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

function _nsToIso(ns: bigint): string {
    const ms = Number(ns / 1_000_000n);
    const subMs = Number(ns % 1_000_000n);
    return new Date(ms).toISOString().slice(0, -1) + String(subMs).padStart(6, '0') + 'Z';
}

// l3 / tick path
function _deriveOhlcvFromFootprint(footprintBars: FootprintBar[]): OhlcvBar[] {
    return footprintBars.map((fb) => ({
        time: Number(fb.ts / 1_000_000n),
        open: fb.open,
        high: fb.high,
        low: fb.low,
        close: fb.close,
        volume: fb.totalVol,
    }));
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
                ohlcvBars: chunk.ohlcvBars,
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
                ohlcvBars: [],
                dataStart: chunk.dataStart,
                dataEnd: chunk.dataEnd,
            };
    }
}

interface LoadedSegment {
    from: bigint;
    to: bigint;
    /** The barNs actually requested from the adapter for this segment. */
    fetchBarNs: bigint;
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
    segments: LoadedSegment[];
    refiningSegments: Set<string>;
    /**
     * Finest supplemental resolution the adapter serving this symbol declares,
     * null for none. Per symbol because a plugin source and the host adapter
     * answer getCapabilities() differently.
     */
    supplementalResolution: bigint | null;
}

export class DataEngine {
    private adapter: IDataAdapter | null = null;
    private realtimeUnsub: (() => void) | null = null;
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
    // themselves here so the fetch resolution is the finest anyone needs.
    private readonly paneResolutions = new Map<number, { symbol: string; barNs: bigint }>();
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
        ohlcvBars: OhlcvBar[];
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
        ohlcvBars: [],
        barNs: 60_000_000_000n,
        dataStart: 0,
        dataEnd: 0,
        supplemental: null,
    };

    private maxLookbackBars: number;

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
                segments: [],
                refiningSegments: new Set(),
                supplementalResolution: null,
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

    setAdapter(adapter: IDataAdapter): void {
        this.realtimeUnsub?.();
        this.realtimeUnsub = null;
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
    // reset of master/segments
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
        st.master = null;
        st.segments = [];
        st.refiningSegments.clear();

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

        // 5. subscribe to realtime. this tracks the focused symbol, so tear the
        // previous subscription down or loading several panes leaks/double-feeds
        if (adapter.subscribeRealtime) {
            this.realtimeUnsub?.();
            this.realtimeUnsub = adapter.subscribeRealtime((bar) => {
                this._handleRealtimeBar(bar);
            });
        }
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

        // fresh window, so drop the loaded range and segments - pagination and
        // refinement restart relative to this one
        st.loadedFrom = null;
        st.loadedTo = null;
        st.hasMoreHistory = true;
        st.hasMoreForward = true;
        st.master = null;
        st.segments = [];
        st.refiningSegments.clear();
        this.horizonIso = _nsToIso(horizonNs);

        // jump-loads pass announceLoading=false since theyre quick re-centers -
        // no full loading overlay, interactions stay live. the ingest still emits
        // a ready at the end, and errors surface either way
        if (announceLoading)
            this.eventBus.emit('data:status', {
                status: 'loading',
                symbol: st.symbolInfo.symbol,
            });

        const timeframe = this._fetchTimeframe(st, this._activeBarNs(st.symbolInfo.symbol));
        const fetchBarNs = timeframe.barNs;

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
            });
        } catch (err) {
            this._emitAdapterError('fetch_failed', err, st.symbolInfo.symbol);
            return;
        }

        const processed = this._process(response, st);
        if (!processed) {
            this.eventBus.emit('data:status', {
                status: 'ready',
                symbol: st.symbolInfo.symbol,
            });
            return;
        }

        st.loadedFrom = BigInt(processed.dataStart) * 1_000_000n;
        st.loadedTo = BigInt(processed.dataEnd) * 1_000_000n;
        st.hasMoreHistory = response.hasMore;
        st.segments = [{ from: st.loadedFrom!, to: st.loadedTo!, fetchBarNs }];

        st.master = {
            ..._chunkToMasterFields(processed),
            // the bars' own period, not the view timeframe. consumers tell a
            // completed bar from the forming one with it, and with panes at mixed
            // timeframes the two arent the same number anymore
            barNs: processed.kind === 'ohlcv' ? fetchBarNs : this.state.get('timeframe').barNs,
            playFromNs: st.loadedFrom,
            symbolInfo: st.symbolInfo,
        };

        this._syncShared();
        await this._emitLoad(st);

        // a pane can announce a finer timeframe while this fetch is in flight,
        // since panes mount around the first load. settle it here rather than
        // leaving that pane looking at bars it cant draw
        this._refineStaleSegments(st);
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
    // while a chart is loaded - nothing else re-asks, since a timeframe change
    // only refines bars out of segments already in hand and refinement carries no
    // supplementalBarNs.
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
                timeframe: this._fetchTimeframe(st, cfg.maxResolution(span)),
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
     * fetch path here joins the loaded-range bookkeeping (segments,
     * `loadedFrom`/`loadedTo`, prefetch, playback horizon) - this one doesn't. A
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
                ohlcvBars: [],
                ticks: [],
                barNs: 1_000_000_000n,
                dataStart: 0,
                dataEnd: 0,
                symbolInfo: null,
            };
        }

        const { dataLevel, trades, footprintBars, priceHistory, ohlcvBars } = master;

        const ticks: TickEvent[] =
            dataLevel === 'l3' || dataLevel === 'tick' ? _deriveTicksFromTrades(trades) : [];

        return {
            dataLevel,
            trades,
            footprintBars,
            priceHistory,
            ohlcvBars,
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

        this.realtimeUnsub?.();
        this.realtimeUnsub = null;
        this._cancelSymbolSearch();
        this.symbolSearchCache.clear();
        this.symbolUniverse = null;
        this.adapter?.destroy?.();
        this.adapter = null;
        this._states.clear();
    }

    // Scroll pagination

    private _fetchForward(symbol: string, spanNs?: bigint): void {
        if (this.destroyed) return;
        const adapter = this._adapterFor(symbol);
        if (!adapter) return;
        const st = this._st(symbol);
        if (st.forwardInFlight) return;
        if (!st.hasMoreForward) {
            // asked for more but the stream is exhausted, so re-assert it and
            // playback pauses at the end instead of holding forever. the final
            // chunk's data:bounds clears the engine's end flag.
            this.eventBus.emit('data:no-more-forward', { symbol });
            return;
        }
        if (st.loadedTo === null || !st.symbolInfo) return;

        // sized to playback consumption, but never less than the scroll window
        const win = spanNs && spanNs > this.scrollWindowNs ? spanNs : this.scrollWindowNs;

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

        const _fwdTimeframe = this._fetchTimeframe(st, this._activeBarNs(symbol));
        const _fwdFetchBarNs = _fwdTimeframe.barNs;
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
                const processed = this._process(response, st);

                // nothing past this window, so stop future forward fetches and let
                // playback know it hit the real end so it pauses instead of stalling
                if (response.hasMore === false) {
                    st.hasMoreForward = false;
                    this.eventBus.emit('data:no-more-forward', { symbol });
                }

                if (!processed || isEmptyChunk(processed)) {
                    return;
                }

                st.loadedTo = BigInt(processed.dataEnd) * 1_000_000n;
                st.segments.push({ from, to: st.loadedTo!, fetchBarNs: _fwdFetchBarNs });
                this._growMaster(st, processed);
                this._emitAppend(st, processed).catch((err) =>
                    console.error('[DataEngine] forward _emitAppend failed', err),
                );
            })
            .catch((err) => {
                console.error('[DataEngine] forward fetch failed', err);
                this._emitAdapterError('prefetch_failed', err, symbol);
            })
            .finally(() => {
                st.forwardInFlight = false;
                this.eventBus.emit('data:prefetch-done', undefined);
            });
    }

    private _fetchBackward(symbol: string, viewMin: bigint): void {
        if (this.destroyed) return;
        const adapter = this._adapterFor(symbol);
        if (!adapter) return;
        const st = this._st(symbol);
        if (!st.hasMoreHistory) return;
        if (st.loadedFrom === null || !st.symbolInfo) return;

        if (st.backwardInFlight) {
            if (st.pendingBackwardViewMin === null || viewMin < st.pendingBackwardViewMin) {
                st.pendingBackwardViewMin = viewMin;
            }
            return;
        }

        const barNs = this._activeBarNs(symbol);
        const _bwdTimeframe = this._fetchTimeframe(st, barNs);
        const _bwdFetchBarNs = _bwdTimeframe.barNs;
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


                const processed = this._process(response, st);

                if (!processed || isEmptyChunk(processed)) {
                    st.loadedFrom = from;
                    st.hasMoreHistory = response.hasMore;
                    if (!response.hasMore) {
                        this.eventBus.emit('data:no-more-history', { symbol });
                    }
                    return;
                }

                st.loadedFrom = BigInt(processed.dataStart) * 1_000_000n;
                st.segments.unshift({ from: st.loadedFrom!, to, fetchBarNs: _bwdFetchBarNs });
                st.hasMoreHistory = response.hasMore;
                this._prependMaster(st, processed);
                this._emitPrepend(st, processed, viewMin).catch((err) =>
                    console.error('[DataEngine] backward _emitPrepend failed', err),
                );

                if (!response.hasMore) {
                    this.eventBus.emit('data:no-more-history', { symbol });
                }
            })
            .catch((err) => {
                console.error('[DataEngine] backward fetch failed', err);
                // still advance loadedFrom on error or we hammer the same range
                st.loadedFrom = from;
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

    // the finest bar period anything on screen needs for this symbol: the focused
    // timeframe, or finer if another pane shows the instrument at one. everything
    // a pane draws is aggregated up from what gets fetched, so the finest
    // requirement is the one that has to be met
    private _activeBarNs(symbol: string): bigint {
        let finest = this.state.get('timeframe').barNs;
        for (const pane of this.paneResolutions.values()) {
            if (pane.symbol !== symbol) continue;
            if (pane.barNs > 0n && pane.barNs < finest) finest = pane.barNs;
        }
        return finest;
    }

    // the other end of _activeBarNs: the coarsest period on screen. warmup is
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

    // a pane announced the instrument + timeframe it shows, on mount and on every
    // change to either. re-fetches whatever it holds at too coarse a resolution,
    // which on a fresh load is what closes the gap between the focused pane's
    // timeframe and what this pane actually needs
    private _onPaneResolution(id: number, symbol: string, barNs: bigint): void {
        if (this.destroyed) return;

        // barNs 0 is a withdrawal - the pane unmounted or moved off this symbol
        if (barNs <= 0n || !symbol) {
            if (this.paneResolutions.get(id)?.symbol === symbol || !symbol) {
                this.paneResolutions.delete(id);
            }
            return;
        }

        const prev = this.paneResolutions.get(id);
        if (prev?.symbol === symbol && prev.barNs === barNs) return;
        this.paneResolutions.set(id, { symbol, barNs });

        const st = this._states.get(symbol);
        if (!st?.symbolInfo) return; // not loaded yet, the load will size itself
        this._refineStaleSegments(st);
    }

    // re-fetch anything this symbol holds coarser than some pane now needs. runs
    // after every load as well as on an announcement, since a pane announcing
    // while the first fetch is in flight would otherwise be stuck with the bars
    // that fetch was sized for
    private _refineStaleSegments(st: SymbolState): void {
        if (!st.symbolInfo) return;
        const fetchBarNs = this._effectiveFetchBarNs(
            st,
            this._activeBarNs(st.symbolInfo.symbol),
        );
        for (const seg of st.segments.filter((s) => s.fetchBarNs > fetchBarNs)) {
            this._refineSegment(st, seg, fetchBarNs);
        }
    }

    // coarsest supported resolution <= activeBarNs, or activeBarNs itself when
    // the adapter declares no supportedResolutions
    private _effectiveFetchBarNs(st: SymbolState, activeBarNs: bigint): bigint {
        const supported = st.symbolInfo?.supportedResolutions;
        if (!supported?.length) return activeBarNs;
        let best: bigint | null = null;
        for (const r of supported) {
            if (r <= activeBarNs) best = r;
            else break;
        }
        return best ?? supported[0];
    }

    // the Timeframe to hand the adapter for a fetch. applies the supported-
    // resolution downgrade, then keeps the active view timeframe when its barNs
    // matches (so its label/defaultBars survive) or resolves a coarser one
    private _fetchTimeframe(st: SymbolState, baseBarNs: bigint): Timeframe {
        const fetchBarNs = this._effectiveFetchBarNs(st, baseBarNs);
        const viewTf = this.state.get('timeframe');
        return fetchBarNs === viewTf.barNs ? viewTf : timeframeFromBarNs(fetchBarNs);
    }

    // Response processing

    private _process(response: BarResponse, st: SymbolState): DataChunk | null {
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
                return processTickChunk(response.ticks ?? [], barNs);
            case 'l2':
                return processL2Chunk(response.l2Snapshots ?? [], barNs);
            default: {
                if (!response.events?.length) return null;
                return processL3Chunk(response.events, barNs, this.fpOptions);
            }
        }
    }

    // Realtime

    private _handleRealtimeBar(bar: BarResponse): void {
        if (this.destroyed) return;
        // realtime feeds the focused symbol's stream
        const st = this._st(this.activeSymbol);
        if (!st.master) return;
        const processed = this._process(bar, st);
        if (!processed || isEmptyChunk(processed)) return;

        st.loadedTo = BigInt(processed.dataEnd) * 1_000_000n;
        st.hasMoreForward = true;
        this._growMaster(st, processed);
        this._emitAppend(st, processed).catch((err) =>
            console.error('[DataEngine] realtime _emitAppend failed', err),
        );
    }

    // Master mutations

    private _growMaster(st: SymbolState, chunk: DataChunk): void {
        const master = st.master;
        if (!master) return;
        const dl = master.dataLevel;

        switch (dl) {
            case 'l3': {
                const c = chunk as L3DataChunk;
                const total = master.compactBuf.byteLength + c.compactBuf.byteLength;
                const merged = new Uint8Array(total);
                merged.set(new Uint8Array(master.compactBuf), 0);
                merged.set(new Uint8Array(c.compactBuf), master.compactBuf.byteLength);
                master.compactBuf = merged.buffer;
                master.trades = master.trades.concat(c.trades);
                master.priceHistory = master.priceHistory.concat(c.priceHistory);
                master.footprintBars = master.footprintBars.concat(c.footprintBars);
                master.ohlcvBars = _deriveOhlcvFromFootprint(master.footprintBars);
                master.dataEnd = c.dataEnd > 0 ? c.dataEnd : master.dataEnd;
                break;
            }
            case 'tick': {
                const c = chunk as TickDataChunk;
                master.trades = master.trades.concat(c.trades);
                master.priceHistory = master.priceHistory.concat(c.priceHistory);
                master.footprintBars = master.footprintBars.concat(c.footprintBars);
                master.ohlcvBars = _deriveOhlcvFromFootprint(master.footprintBars);
                master.dataEnd = c.dataEnd > 0 ? c.dataEnd : master.dataEnd;
                break;
            }
            case 'ohlcv': {
                const c = chunk as OhlcvDataChunk;
                // in place, instead of allocating a fresh array of the whole
                // (growing) master on every forward chunk
                for (const b of c.ohlcvBars) master.ohlcvBars.push(b);
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
    }

    private _prependMaster(st: SymbolState, chunk: DataChunk): void {
        const master = st.master;
        if (!master) return;
        const dl = master.dataLevel;

        switch (dl) {
            case 'l3': {
                const c = chunk as L3DataChunk;
                const total = c.compactBuf.byteLength + master.compactBuf.byteLength;
                const merged = new Uint8Array(total);
                merged.set(new Uint8Array(c.compactBuf), 0);
                merged.set(new Uint8Array(master.compactBuf), c.compactBuf.byteLength);
                master.compactBuf = merged.buffer;
                master.trades = c.trades.concat(master.trades);
                master.priceHistory = c.priceHistory.concat(master.priceHistory);
                master.footprintBars = c.footprintBars.concat(master.footprintBars);
                master.ohlcvBars = _deriveOhlcvFromFootprint(master.footprintBars);
                master.dataStart = c.dataStart > 0 ? c.dataStart : master.dataStart;
                break;
            }
            case 'tick': {
                const c = chunk as TickDataChunk;
                master.trades = c.trades.concat(master.trades);
                master.priceHistory = c.priceHistory.concat(master.priceHistory);
                master.footprintBars = c.footprintBars.concat(master.footprintBars);
                master.ohlcvBars = _deriveOhlcvFromFootprint(master.footprintBars);
                master.dataStart = c.dataStart > 0 ? c.dataStart : master.dataStart;
                break;
            }
            case 'ohlcv': {
                const c = chunk as OhlcvDataChunk;
                master.ohlcvBars = c.ohlcvBars.concat(master.ohlcvBars);
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
    }

    // the period to declare for a symbol's master: for ohlcv the resolution its
    // bars were actually fetched at, for everything else the view timeframe the
    // events are bucketed into
    private _masterBarNs(st: SymbolState): bigint {
        const viewBarNs = this.state.get('timeframe').barNs;
        if (st.master?.dataLevel !== 'ohlcv' || !st.symbolInfo) return viewBarNs;
        return this._effectiveFetchBarNs(st, this._activeBarNs(st.symbolInfo.symbol));
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
            this.eventBus.on('data:request-forward', (p) => {
                // route to the requesting pane's symbol so each paginates its own
                // stream, falling back to the focused one when unspecified
                this._fetchForward(this._targetSymbol(p?.symbol));
            }),
            this.eventBus.on('data:request-backward', ({ viewMin, symbol }) => {
                this._fetchBackward(this._targetSymbol(symbol), viewMin);
            }),
            this.eventBus.on('data:rehydrate', () => this.rehydrate()),
            this.eventBus.on('data:pane-resolution', ({ id, symbol, barNs }) =>
                this._onPaneResolution(id, symbol, barNs),
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
                    if (st.symbolInfo) this._fetchForward(sym, spanNs);
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
            ohlcvBars: master.ohlcvBars,
            barNs: master.barNs,
            dataStart: master.dataStart,
            dataEnd: master.dataEnd,
            supplemental: master.supplemental ?? null,
        };
    }

    private async _emitLoad(st: SymbolState, rehydrate = false): Promise<void> {
        const master = st.master;
        if (!master) return;
        const ingestBufs = await this._runLoadIngest(master);
        this.eventBus.emit('data:load', {
            symbol: master.symbolInfo.symbol,
            ...this._buildPayload(master),
            session: st.session,
            playFromIso: this.horizonIso,
            rehydrate,
            ...ingestBufs,
        });
    }

    private async _emitAppend(st: SymbolState, chunk: DataChunk): Promise<void> {
        const master = st.master;
        if (!master) return;
        const ingestBufs = await this._runLoadIngest(master);
        // for ohlcv send only the chunk's new bars so the consumer extends its
        // arrays incrementally - it froze re-aggregating the full master each
        // time. other levels read the full master from _buildPayload.
        this.eventBus.emit('data:append', {
            symbol: master.symbolInfo.symbol,
            ...this._buildPayload(master),
            ohlcvBars: 'ohlcvBars' in chunk ? chunk.ohlcvBars : master.ohlcvBars,
            session: st.session,
            ...ingestBufs,
        });
    }

    private async _emitPrepend(
        st: SymbolState,
        chunk: DataChunk,
        viewMin: bigint,
    ): Promise<void> {
        const master = st.master;
        if (!master) return;
        const ingestBufs = await this._runLoadIngest(master);
        // the ohlcv prepend consumer wants only the newly fetched bars, since it
        // prepends them to its display. every other field is the full master.
        this.eventBus.emit('data:prepend', {
            symbol: master.symbolInfo.symbol,
            dataLevel: master.dataLevel,
            compactBuf: master.compactBuf,
            trades: master.trades,
            priceHistory: master.priceHistory,
            footprintBars: master.footprintBars,
            ohlcvBars: 'ohlcvBars' in chunk ? chunk.ohlcvBars : [],
            barNs: master.barNs,
            dataStart: master.dataStart,
            viewMin,
            session: st.session,
            ...ingestBufs,
        });
    }

    private _emitAdapterError(code: string, err: unknown, symbol?: string): void {
        const message =
            err instanceof DataAdapterError
                ? err.message
                : err instanceof Error
                  ? err.message
                  : String(err);
        this.eventBus.emit('data:status', {
            status: 'error',
            error: { code, message },
            symbol,
        });
    }

    private _onTimeframeChange(newActiveBarNs: bigint): void {
        // every loaded symbol, not just the focused one. a pane can only
        // re-aggregate what it holds, so one still on coarser segments draws a bar
        // every fourth slot with gaps between once the timeframe drops below its
        // fetch resolution - which is what interval sync does to every pane at
        // once. stale makes it self-limiting, symbols already fine enough refetch
        // nothing.
        for (const st of this._states.values()) {
            if (!st.symbolInfo?.supportedResolutions?.length) continue;

            // against the finest requirement, not just the timeframe that
            // changed - another pane may already need this symbol finer still
            const newFetchBarNs = this._effectiveFetchBarNs(
                st,
                bigMin(newActiveBarNs, this._activeBarNs(st.symbolInfo.symbol)),
            );
            const stale = st.segments.filter((s) => s.fetchBarNs > newFetchBarNs);
            for (const seg of stale) {
                this._refineSegment(st, seg, newFetchBarNs);
            }
        }
    }

    private _refineSegment(st: SymbolState, seg: LoadedSegment, newFetchBarNs: bigint): void {
        if (this.destroyed || !st.symbolInfo) return;
        const adapter = this._adapterFor(st.symbolInfo.symbol);
        if (!adapter) return;
        const key = `${seg.from}:${seg.to}`;
        if (st.refiningSegments.has(key)) return;
        st.refiningSegments.add(key);

        adapter
            .fetchBars({
                symbolInfo: st.symbolInfo,
                range: makeTimeRange(seg.from, seg.to),
                timeframe: timeframeFromBarNs(newFetchBarNs),
                direction: 'initial',
            })
            .then((response) => {
                if (this.destroyed) return;

                const idx = st.segments.findIndex((s) => s.from === seg.from && s.to === seg.to);
                if (idx !== -1) st.segments[idx].fetchBarNs = newFetchBarNs;

                const ohlcvBars = response.ohlcvBars ?? [];
                if (ohlcvBars.length === 0) return;

                if (st.master?.dataLevel === 'ohlcv') {
                    const fromMs = Number(seg.from / 1_000_000n);
                    const toMs = Number(seg.to / 1_000_000n);
                    const kept = st.master.ohlcvBars.filter((b) => {
                        const t = new Date(b.time).getTime();
                        return t < fromMs || t > toMs;
                    });
                    st.master.ohlcvBars = [...kept, ...ohlcvBars].sort(
                        (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime(),
                    );
                    this._syncShared();
                }

                this.eventBus.emit('data:refine', {
                    symbol: st.symbolInfo!.symbol,
                    dataLevel: st.master?.dataLevel ?? this.sharedData.dataLevel,
                    ohlcvBars,
                    barNs: newFetchBarNs,
                    from: _nsToIso(seg.from),
                    to: _nsToIso(seg.to),
                });
            })
            .catch((err) => {
                console.error('[DataEngine] segment refinement failed', err);
            })
            .finally(() => {
                st.refiningSegments.delete(key);
            });
    }

    // Helpers

    private _openWindows(st: SymbolState, from: bigint, to: bigint): SessionWindow[] {
        if (!st.session) return [{ from, to }];
        return clipToSession(st.session, from, to);
    }

}
