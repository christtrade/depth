import { useCallback, useEffect, useRef, type MutableRefObject, type RefObject } from 'react';
import { isoToNs } from '../lib/sampler';
import { type PriceHistory, type TradePoint, type ViewBounds, type OhlcvBarMs } from '../lib/types';
import { footprintFromTrades, fpOptionsMatch, type FootprintBar, type FootprintOptions } from '../lib/types/footprint';
import { openBarFrom } from '../lib/open-bar';
import { extendBucketedPh, extendCandles, extendFootprints, foldTrades } from '../lib/bucket-tail';
import {
    BYTES_PER_EVENT,
    type CompactBuffer,
    createCompactBuffer,
    findFloorIndex,
    getTsNs,
    getEvent,
    sameEvent,
} from '../lib/compact-buffer';
import {
    deserializePriceHistoryFromBuf,
    deserializeOhlcvCacheFromBuf,
} from '../lib/slice-worker-client';
import { type SerialTrade } from '../lib/types';
import { SymbolInfo, type TickEvent } from '../interfaces/IDataAdapter';
import { type DataLevel, type TradingSession } from '../interfaces/IDataAdapter';
import { type LiveTransformer } from '../interfaces/ICoordinateTransformer';
import { type Indicator, type ChartPane, type Rect } from '../lib/types/indicator-types';
import { type Timeframe } from '../lib/timeframes';
import { type ChartSettings } from '../lib/types/chart-settings';
import { type TypedEventBus } from '../core/TypedEventBus';
import { type RenderEngine } from '../core/RenderEngine';
import { type SessionMapper } from '../core/SessionMapper';
import { BarStore } from '../core/BarStore';
import { hasBook } from '../lib/book';
import { ohlcvBucketRange } from '../lib/bar-grid';
import {
    aggregateOhlcvBars,
    displayFor,
    prependAggregatedOhlcvBars,
} from '../lib/bar-aggregate';
import { getSessionStatus, type SessionStatus } from '../core/SessionUtils';
import { type HeatmapReply, type WorkerInitMessage } from '../lib/types/heatmap-types';
import { HeatmapTiles } from '../lib/heatmap-tiles';
import { type LiveEdge } from '../lib/renderers/renderer';
import { followsEdge as followsDataEdge, loadedHorizon } from '../lib/view-edges';

// Local types
// Pure utility functions
export { ohlcvBucketRange };
export {
    aggregateOhlcvBars,
    isAggregated,
    displayFor,
    prependAggregatedOhlcvBars,
} from '../lib/bar-aggregate';

export function autoFitPriceAxis(
    view: ViewBounds,
    priceHistory: PriceHistory[],
    trades: TradePoint[],
    bars: BarStore,
    openBar: FootprintBar | null,
    settings: ChartSettings,
    horizon: bigint,
    dataLevel?: DataLevel,
) {
    if (!dataLevel) return;
    let lo = Infinity,
        hi = 0,
        found = false;

    // Convert view bounds to Number ms once - avoids BigInt allocation per bar in hot loops.
    const tMinMs = Number(view.tMin / 1_000_000n);
    const tMaxMs = Number(view.tMax / 1_000_000n);
    const horizonMs = Number(horizon / 1_000_000n);

    // The currently-forming bar in `bars` still carries its *eventual* high/low/
    // close, so scanning it during playback reveals future price action (where the
    // bar will close). Stop the completed-bar scan at the forming bar's start and
    // fold in `openBar` instead - it is aggregated only up to `horizon`, so it
    // reflects the bar's range as it actually is at the playhead.
    const openBarMs = openBar ? Number(openBar.ts / 1_000_000n) : Infinity;
    const scanEndMs = Math.min(horizonMs, openBarMs);
    const foldOpenBar = () => {
        if (!openBar || openBarMs >= tMaxMs || openBarMs >= horizonMs) return;
        if (openBar.high > hi) hi = openBar.high;
        if (openBar.low < lo) lo = openBar.low;
        if (!found) {
            view.pRef = openBar.high;
            found = true;
        }
    };

    const barsStartIdx = bars.lowerBound(tMinMs);
    const { time: bTime, high: bHigh, low: bLow } = bars;
    const scanBars = () => {
        for (let i = barsStartIdx; i < bTime.length; i++) {
            if (bTime[i] >= tMaxMs) break;
            if (bTime[i] >= scanEndMs) break;
            if (bHigh[i] > hi) hi = bHigh[i];
            if (bLow[i] < lo) lo = bLow[i];
            if (!found) {
                view.pRef = bHigh[i];
                found = true;
            }
        }
    };

    const scanTrades = () => {
        for (const t of trades) {
            if (t.ts > horizon || t.ts < view.tMin || t.ts >= view.tMax) continue;
            if (t.price > hi) hi = t.price;
            if (t.price < lo) lo = t.price;
            if (!found) {
                view.pRef = t.price;
                found = true;
            }
        }
    };

    if (
        settings.chartType === 'area' ||
        settings.chartType === 'line' ||
        settings.chartType === 'step' ||
        settings.chartType === 'baseline'
    ) {
        // tick bid/ask start at 0 until each side has traded, so its trades
        if (dataLevel === 'tick') scanTrades();
        else if (hasBook(dataLevel)) {
            for (const h of priceHistory) {
                if (h.ts > horizon || h.ts < view.tMin || h.ts >= view.tMax) continue;
                if (h.bestAsk > hi) hi = h.bestAsk;
                if (h.bestBid < lo) lo = h.bestBid;
                if (!found) {
                    view.pRef = h.bestBid;
                    found = true;
                }
            }
        } else if (dataLevel === 'ohlcv') {
            scanBars();
            foldOpenBar();
        }
    }
    if (
        settings.chartType === 'candles' ||
        settings.chartType === 'footprint' ||
        settings.chartType === 'hollow' ||
        settings.chartType === 'heikin-ashi' ||
        settings.chartType === 'bars' ||
        settings.chartType === 'renko' ||
        settings.chartType === 'kagi' ||
        settings.chartType === 'line-break'
    ) {
        if (hasBook(dataLevel) || dataLevel === 'tick') scanTrades();
        scanBars();
        foldOpenBar();
    }
    if (!found) return;
    if (settings.priceScaleMode === 'log' && lo > 0 && hi > 0) {
        // Apply the margins in log space so pMin stays strictly positive - a
        // linear `lo - span*margin` can go negative on a wide range and silently
        // drop the transformer back to linear scale.
        const logLo = Math.log(lo);
        const logHi = Math.log(hi);
        const logSpan = logHi - logLo;
        view.pMin = Math.exp(logLo - logSpan * settings.scaleMarginBottom);
        view.pMax = Math.exp(logHi + logSpan * settings.scaleMarginTop);
    } else {
        const span = hi - lo;
        view.pMin = lo - span * settings.scaleMarginBottom;
        view.pMax = hi + span * settings.scaleMarginTop;
    }
}

export function applyHorizonScrollEasing(t: number, type: string): number {
    switch (type) {
        case 'linear':
            return t;
        case 'easeOut':
            return 1 - Math.pow(1 - t, 3);
        case 'easeInOut':
            return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        default:
            return t;
    }
}

// Hook params & return types
export interface UseChartDataParams {
    eventBus: TypedEventBus;
    activeTimeframeRef: MutableRefObject<Timeframe>;
    horizonRef: MutableRefObject<bigint>;
    chartSettingsRef: MutableRefObject<ChartSettings>;
    sessionMapperRef: MutableRefObject<SessionMapper>;
    resolvedSessionRef: MutableRefObject<TradingSession | null>;
    resolvedSymbolInfoRef: MutableRefObject<SymbolInfo>;
    viewRef: MutableRefObject<ViewBounds | null>;
    /** Auto-computed right price-axis width (css px). */
    priceScaleWidthRef: MutableRefObject<number>;
    panesRef: MutableRefObject<ChartPane[]>;
    indicatorsRef: MutableRefObject<Indicator[]>;
    transformer: LiveTransformer;
    renderEngineRef: MutableRefObject<RenderEngine | null>;
    isYAxisAutoRef: MutableRefObject<boolean>;
    isDragging: MutableRefObject<boolean>;
    dragMode: MutableRefObject<string>;
    layoutsCacheRef: MutableRefObject<Record<string, Rect>>;
    baseCanvasRef: RefObject<HTMLCanvasElement>;
    selectedDrawingIdRef: MutableRefObject<string | null>;
    // Late-bound: filled in by ChartInner after hook call to break circular dep
    pushDrawParamsRef: MutableRefObject<() => void>;
    autofitIndicatorPanesRef: MutableRefObject<() => void>;
    updateSettingsBarPosRef: MutableRefObject<(id: string | null) => void>;
    resetViewRef: MutableRefObject<() => void>;
    syncPixelLayoutsRef: MutableRefObject<(panes?: ChartPane[]) => void>;
    // Direct callbacks
    setIndicators: (inds: Indicator[]) => void;
    setPanes: (updater: ((prev: ChartPane[]) => ChartPane[]) | ChartPane[]) => void;
    onDataBoundsChange?: (start: bigint, end: bigint) => void;
    onHorizonUpdate: (h: bigint) => void;
    isRealtime?: () => boolean;
    cellSymbol: string;
    /** Which cell this is, for events that are this pane's own business. */
    cellId: number;
    managed?: boolean;
    hidePriceScale: boolean;
    hideTimeScale: boolean;
    /** The loaded symbol serves a different data level than the last one did. */
    onDataLevelChangeRef: MutableRefObject<() => void>;
    onLoadAppliedRef: MutableRefObject<(sourceBarNs: bigint) => void>;
    onSymbolResolvedRef: MutableRefObject<(info: SymbolInfo) => void>;
}

export interface ChartDataResult {
    // Core data refs
    compactBufRef: MutableRefObject<CompactBuffer>;
    allTradesRef: MutableRefObject<TradePoint[]>;
    tradesRef: MutableRefObject<TradePoint[]>;
    priceHistoryRef: MutableRefObject<PriceHistory[]>;
    allPriceHistoryRef: MutableRefObject<PriceHistory[]>;
    footprintBarsRef: MutableRefObject<FootprintBar[]>;
    ohlcvBarsRef: MutableRefObject<{
        barNs: bigint;
        sourceBarNs: bigint;
        bars: BarStore;
        display: BarStore;
    }>;
    previewBarsRef: MutableRefObject<BarStore>;
    openBarRef: MutableRefObject<FootprintBar | null>;
    openBarTsRef: MutableRefObject<bigint>;
    openBarTradeCountRef: MutableRefObject<number>;
    phCursorRef: MutableRefObject<number>;
    playheadIdxRef: MutableRefObject<number>;
    isPlayingRef: MutableRefObject<boolean>;
    dataLevelRef: MutableRefObject<DataLevel | null>;
    datasetStartRef: MutableRefObject<bigint>;
    datasetEndRef: MutableRefObject<bigint>;
    prevSessionStatusRef: MutableRefObject<SessionStatus | null>;
    candleCacheRef: MutableRefObject<Map<
        bigint,
        { open: number; high: number; low: number; close: number; volume: number; delta: number }
    > | null>;
    supplementalBarsRef: MutableRefObject<any>;
    heatmapTilesRef: MutableRefObject<HeatmapTiles | null>;
    prevHorizonBarRef: MutableRefObject<bigint>;
    lastBarAdvanceTimeRef: MutableRefObject<number>;
    horizonScrollAnimRef: MutableRefObject<any>;
    // Worker refs (needed by ChartInner for worker-related logic)
    workerRef: MutableRefObject<Worker | null>;
    indicatorWorkerRef: MutableRefObject<Worker | null>;
    // Key functions needed by ChartInner
    seekHorizon: (
        horizon: bigint,
        triggerResample?: boolean,
        hotPath?: boolean,
        /** Explicit navigation: bring the view along instead of leaving it behind. */
        recenter?: boolean,
    ) => void;
    /** Frames a span of time. Does not move the playhead - see 'chart:goto-range'. */
    gotoRange: (fromNs: bigint, toNs?: bigint, padding?: number) => void;
    applyHorizon: (horizon: bigint, triggerResample?: boolean, hotPath?: boolean) => void;
    scheduleResample: () => void;
    runIndicatorWorker: (trades: SerialTrade[], barNs: bigint) => void;
    getTradesUpToHorizon: (horizon: bigint) => TradePoint[];
    rebuildFootprints: () => void;
    syncOhlcvOpenBar: (horizon: bigint) => void;
    rebuildCandleCache: (trades: TradePoint[], barNs: bigint) => void;
    foldEventsIntoOpenBar: (
        prevIdx: number,
        newIdx: number,
        barNs: bigint,
        horizon: bigint,
    ) => boolean;
    mergeOpenBar: () => void;
    resetPlayhead: (idx: number) => void;
    fpSettingsFromRef: () => {
        imbalanceRatio: number;
        stackMinCount: number;
        diagRatio: number;
        absorptionMult: number;
        absorptionDeltaFrac: number;
    };
    runHorizonAdvance: (horizon: bigint) => void;
    updatePriceHistoryToRawIdx: (rawIdx: number) => void;
    findPriceHistoryIdx: (horizon: bigint) => number;
}

// Hook
export function useChartData(p: UseChartDataParams): ChartDataResult {
    // Symbol this cell is showing, readable from the long-lived worker/ingest
    // closures below. Every cell shares one eventBus, so status emitted from
    // here must be attributed to this symbol or all cells react to it.
    const cellSymbolRef = useRef(p.cellSymbol);
    cellSymbolRef.current = p.cellSymbol;

    // Data refs
    const compactBufRef = useRef<CompactBuffer>(createCompactBuffer());
    const allTradesRef = useRef<TradePoint[]>([]);
    const midPrintsRef = useRef<TradePoint[]>([]);
    const tradesRef = useRef<TradePoint[]>([]);
    const priceHistoryRef = useRef<PriceHistory[]>([]);
    const allPriceHistoryRef = useRef<PriceHistory[]>([]);
    const footprintBarsRef = useRef<FootprintBar[]>([]);

    // barNs is what display is bucketed at. sourceBarNs is what bars was fetched at
    const ohlcvBarsRef = useRef<{
        barNs: bigint;
        sourceBarNs: bigint;
        bars: BarStore;
        display: BarStore;
    }>({
        barNs: 0n,
        sourceBarNs: 0n,
        bars: new BarStore(),
        display: new BarStore(),
    });
    const previewBarsRef = useRef<BarStore>(new BarStore());
    const openBarRef = useRef<FootprintBar | null>(null);
    const openBarTsRef = useRef<bigint>(0n);
    const openBarTradeCountRef = useRef<number>(0);
    const phCursorRef = useRef<number>(-1);
    const playheadIdxRef = useRef<number>(-1);
    const tickHorizonRef = useRef<bigint>(0n);
    const dataLevelRef = useRef<DataLevel | null>(null);
    const datasetStartRef = useRef<bigint>(0n);
    const datasetEndRef = useRef<bigint>(0n);
    const prevSessionStatusRef = useRef<SessionStatus | null>(null);
    const candleCacheRef = useRef<Map<
        bigint,
        { open: number; high: number; low: number; close: number; volume: number; delta: number }
    > | null>(null);
    const supplementalBarsRef = useRef<any>(null);
    const heatmapTilesRef = useRef<HeatmapTiles | null>(null);
    const prevHorizonBarRef = useRef(0n);
    const lastBarAdvanceTimeRef = useRef<number>(0);
    const horizonScrollAnimRef = useRef<any>(null);
    const horizonScrollRafRef = useRef<number | null>(null);
    const lastHorizonForIndicatorsRef = useRef<bigint>(0n);
    const resampleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Worker refs
    const workerRef = useRef<Worker | null>(null);
    // the engine never writes into a buffer it handed out, so holding it costs nothing
    const heatmapSentRef = useRef<{ buf: ArrayBuffer; length: number } | null>(null);
    const indicatorWorkerRef = useRef<Worker | null>(null);
    const indicatorRequestIdRef = useRef(0);
    const dataLoadedRef = useRef(false);
    // Tracks whether playback is actively running. During playback the playback
    // engine owns the horizon, so appended (future) data must NOT yank it.
    const isPlayingRef = useRef(false);

    // Stable accessors

    const getTradesUpToHorizon = useCallback((horizon: bigint): TradePoint[] => {
        const all = allTradesRef.current;
        if (all.length === 0) return all;
        let lo = 0,
            hi = all.length - 1,
            idx = all.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            if (all[mid].ts <= horizon) {
                idx = mid;
                lo = mid + 1;
            } else hi = mid - 1;
        }
        if (idx === all.length - 1) return all;
        return all.slice(0, idx + 1);
    }, []);

    const fpSettingsFromRef = useCallback(
        () => ({
            imbalanceRatio: p.chartSettingsRef.current.footprintImbalanceRatio,
            stackMinCount: p.chartSettingsRef.current.footprintStackMinCount,
            diagRatio: p.chartSettingsRef.current.footprintDiagRatio,
            absorptionMult: p.chartSettingsRef.current.footprintAbsorptionMult,
            absorptionDeltaFrac: p.chartSettingsRef.current.footprintAbsorptionDeltaFrac,
        }),
        [],
    );

    // Data helpers
    // book only l2 has no trades so its candles come off the mid prints
    const candleSrc = useCallback(
        (trades: TradePoint[]): TradePoint[] =>
            dataLevelRef.current === 'l2' && allTradesRef.current.length === 0 ? midPrintsRef.current : trades,
        [],
    );

    const rebuildCandleCache = useCallback((trades: TradePoint[], barNs: bigint) => {
        if (barNs === 0n) {
            candleCacheRef.current = null;
            return;
        }
        const map = new Map<
            bigint,
            {
                open: number;
                high: number;
                low: number;
                close: number;
                volume: number;
                delta: number;
            }
        >();
        for (const t of candleSrc(trades)) {
            if (t.ts > p.horizonRef.current) break;
            const k = (t.ts / barNs) * barNs;
            const b = map.get(k);
            if (!b) {
                map.set(k, {
                    open: t.price,
                    high: t.price,
                    low: t.price,
                    close: t.price,
                    volume: t.size,
                    delta: t.side === 'B' ? t.size : -t.size,
                });
            } else {
                if (t.price > b.high) b.high = t.price;
                if (t.price < b.low) b.low = t.price;
                b.close = t.price;
                b.volume += t.size;
                b.delta += t.side === 'B' ? t.size : -t.size;
            }
        }
        candleCacheRef.current = map;
    }, []);

    const updatePriceHistoryToRawIdx = useCallback((rawIdx: number) => {
        const full = allPriceHistoryRef.current;
        if (full.length === 0 || rawIdx < 0) return;
        const clampedIdx = Math.min(rawIdx, full.length - 1);
        if (clampedIdx === phCursorRef.current) return;
        const barNs = p.activeTimeframeRef.current.barNs;
        if (phCursorRef.current < 0) {
            if (barNs === 0n) {
                priceHistoryRef.current = full.slice(0, clampedIdx + 1);
            } else {
                const bucketed: PriceHistory[] = [];
                for (let i = 0; i <= clampedIdx; i++) {
                    const pt = full[i];
                    const bucket = (pt.ts / barNs) * barNs;
                    const last = bucketed.length > 0 ? bucketed[bucketed.length - 1] : null;
                    if (last && last.ts === bucket) {
                        last.bestBid = pt.bestBid;
                        last.bestAsk = pt.bestAsk;
                    } else bucketed.push({ ts: bucket, bestBid: pt.bestBid, bestAsk: pt.bestAsk });
                }
                priceHistoryRef.current = bucketed;
            }
            phCursorRef.current = clampedIdx;
            return;
        }
        if (barNs === 0n) {
            priceHistoryRef.current = full.slice(0, clampedIdx + 1);
            phCursorRef.current = clampedIdx;
            return;
        }
        const bucketed = priceHistoryRef.current;
        for (let i = phCursorRef.current + 1; i <= clampedIdx; i++) {
            const pt = full[i];
            const bucket = (pt.ts / barNs) * barNs;
            const last = bucketed.length > 0 ? bucketed[bucketed.length - 1] : null;
            if (last && last.ts === bucket) {
                last.bestBid = pt.bestBid;
                last.bestAsk = pt.bestAsk;
            } else bucketed.push({ ts: bucket, bestBid: pt.bestBid, bestAsk: pt.bestAsk });
        }
        phCursorRef.current = clampedIdx;
    }, []);

    const findPriceHistoryIdx = (horizon: bigint): number => {
        const full = allPriceHistoryRef.current;
        if (full.length === 0) return -1;
        let lo = 0,
            hi = full.length - 1,
            r = -1;
        while (lo <= hi) {
            const m = (lo + hi) >>> 1;
            if (full[m].ts <= horizon) {
                r = m;
                lo = m + 1;
            } else hi = m - 1;
        }
        return r;
    };

    // up to the playhead so the open bar merges onto the last one
    const rebuildFootprints = useCallback((horizon = p.horizonRef.current) => {
        footprintBarsRef.current = footprintFromTrades(
            getTradesUpToHorizon(horizon),
            p.activeTimeframeRef.current.barNs,
            fpSettingsFromRef(),
        );
    }, []);

    // the engines bars run to the data end, a replay needs them to stop at the playhead.
    // the engine has one set of options for every pane, the panes own settings win
    const takeFootprints = useCallback((bars: FootprintBar[], barNs: bigint, builtWith: FootprintOptions) => {
        if (
            barNs === p.activeTimeframeRef.current.barNs &&
            p.horizonRef.current >= datasetEndRef.current &&
            fpOptionsMatch(builtWith, fpSettingsFromRef())
        )
            footprintBarsRef.current = bars;
        else rebuildFootprints();
    }, []);

    const rebuildOpenBarLevels = useCallback((toEvIdx: number, barNs: bigint) => {
        const bar = openBarRef.current;
        if (!bar) return;
        const cb = compactBufRef.current;
        const currentBarTs = openBarTsRef.current;
        let startIdx = 0;
        for (let i = toEvIdx; i >= 0; i--) {
            if ((getTsNs(cb, i) / barNs) * barNs < currentBarTs) {
                startIdx = i + 1;
                break;
            }
        }
        const built = openBarFrom(cb, startIdx, toEvIdx, barNs, fpSettingsFromRef());
        if (built) Object.assign(bar, built);
    }, []);

    const foldEventsIntoOpenBar = useCallback(
        (prevIdx: number, newIdx: number, barNs: bigint, horizon: bigint): boolean => {
            if (barNs === 0n || newIdx <= prevIdx) return false;
            const cb = compactBufRef.current;
            let barClosed = false;
            for (let i = prevIdx + 1; i <= newIdx; i++) {
                const ev = getEvent(cb, i);
                if (ev.action !== 'T' || ev.price === null || ev.side === 'N') continue;
                const evBarTs = (getTsNs(cb, i) / barNs) * barNs;
                if (openBarRef.current && evBarTs > openBarTsRef.current) {
                    openBarRef.current = null;
                    openBarTsRef.current = evBarTs;
                    openBarTradeCountRef.current = 0;
                    barClosed = true;
                }
                if (!openBarRef.current) {
                    openBarRef.current = {
                        ts: evBarTs,
                        open: ev.price,
                        high: ev.price,
                        low: ev.price,
                        close: ev.price,
                        totalVol: 0,
                        totalDelta: 0,
                        maxLevelVol: 0,
                        maxAbsDelta: 0,
                        levels: [],
                        isBullish: true,
                        poc: ev.price,
                        stackedBuyZones: [],
                        stackedSellZones: [],
                        unfinishedTop: false,
                        unfinishedBottom: false,
                        absorptionCount: 0,
                        diagDominant: 'none',
                    };
                    openBarTsRef.current = evBarTs;
                    openBarTradeCountRef.current = 0;
                }
                const bar = openBarRef.current;
                if (ev.price > bar.high) bar.high = ev.price;
                if (ev.price < bar.low) bar.low = ev.price;
                bar.close = ev.price;
                bar.totalVol += ev.size;
                if (ev.side === 'B') bar.totalDelta += ev.size;
                else bar.totalDelta -= ev.size;
                openBarTradeCountRef.current++;
            }
            if (openBarRef.current) rebuildOpenBarLevels(newIdx, barNs);
            return barClosed;
        },
        [],
    );

    const mergeOpenBar = useCallback(() => {
        const bar = openBarRef.current;
        if (!bar) return;
        const bars = footprintBarsRef.current;
        if (bars.length > 0 && bars[bars.length - 1].ts === bar.ts) bars[bars.length - 1] = bar;
        else footprintBarsRef.current = [...bars, bar];
    }, []);

    const resetPlayhead = useCallback((idx: number) => {
        playheadIdxRef.current = idx;
        openBarRef.current = null;
        openBarTsRef.current = 0n;
        openBarTradeCountRef.current = 0;
        phCursorRef.current = -1;
    }, []);

    const followsEdge = (oldEnd: bigint, newEnd: bigint): boolean =>
        followsDataEdge({
            horizon: p.horizonRef.current,
            oldEnd,
            newEnd,
            barNs: p.activeTimeframeRef.current.barNs,
            playing: isPlayingRef.current,
        });

    const syncOhlcvOpenBar = useCallback((horizon: bigint) => {
        if (dataLevelRef.current !== 'ohlcv') return;
        // Having no supplemental bars is an ordinary state, not a reason to skip:
        // the source may not publish them, or this account may not be entitled to
        // them on this symbol. The fallback below still shapes the forming bar out
        // of the aggregate ones, whereas bailing here left openBarRef null - and
        // the chart reads it for last/bid/ask.
        const supp = supplementalBarsRef.current ?? [];
        const lowestRes = Math.min(...supp.map((b: any) => Number(b.resolution)));
        const bars = supp.find((b: any) => Number(b.resolution) === lowestRes)?.bars ?? [];
        const barNs = p.activeTimeframeRef.current.barNs;
        if (barNs <= 0n) return;
        // Bucketed the way the renderer buckets candles: anchored to the session
        // open. Flooring the horizon to a plain multiple of barNs put the forming
        // bar between two columns on every timeframe whose boundaries aren't
        // epoch multiples - 2h and up, on any symbol with a session.
        const { start: currentBarTs, end: barEndNs } = ohlcvBucketRange(
            horizon,
            barNs,
            p.sessionMapperRef.current,
        );
        const barTimeMs = Number(currentBarTs / 1_000_000n);
        const barEndMs = Number(barEndNs / 1_000_000n);
        const horizonMs = Number(horizon / 1_000_000n);
        // Binary search the first supplemental bar in this bucket - bars are time
        // sorted, so don't linear-scan the whole (large, 1s) array every append.
        let blo = 0,
            bhi = bars.length - 1,
            startIdx = bars.length;
        while (blo <= bhi) {
            const mid = (blo + bhi) >>> 1;
            if (bars[mid].time >= barTimeMs) {
                startIdx = mid;
                bhi = mid - 1;
            } else blo = mid + 1;
        }
        let h = 0,
            l = Infinity,
            o = 0,
            c = 0,
            v = 0,
            foundFirst = false;
        for (let i = startIdx; i < bars.length; i++) {
            const bar = bars[i];
            if (bar.time >= barEndMs || bar.time >= horizonMs) break;
            // Skip Binance zero-volume fill bars (no trade that second, priced at the
            // prior close). The native m/h/d bars are built from real trades only, so
            // including these fills gives the forming bar a phantom open (== prevClose)
            // and phantom wicks that make it snap the instant it commits to `display`.
            if ((bar.volume ?? 0) === 0) continue;
            if (!foundFirst) {
                foundFirst = true;
                o = bar.open;
            }
            if (bar.high > h) h = bar.high;
            if (bar.low < l) l = bar.low;
            c = bar.close;
            v += bar.volume;
        }

        if (foundFirst && v) {
            openBarRef.current = {
                ts: currentBarTs,
                open: o,
                high: h,
                low: l,
                close: c,
                totalVol: (v = Math.round(v * 1e8) / 1e8),
                totalDelta: 0,
                maxLevelVol: 0,
                maxAbsDelta: 0,
                levels: [],
                isBullish: c >= o,
                poc: 0,
                stackedBuyZones: [],
                stackedSellZones: [],
                unfinishedTop: false,
                unfinishedBottom: false,
                absorptionCount: 0,
                diagDominant: 'none',
            };
        } else {
            const disp = ohlcvBarsRef.current.display;
            const atEdge = horizon >= datasetEndRef.current;
            const prevIdx = disp.lowerBound(atEdge ? barEndMs : barTimeMs) - 1;
            const bar = prevIdx >= 0 ? disp.at(prevIdx) : undefined;
            if (!bar) return;
            openBarRef.current = {
                ts: BigInt(bar.time * 1_000_000),
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
                totalVol: bar.volume,
                totalDelta: 0,
                maxLevelVol: 0,
                maxAbsDelta: 0,
                levels: [],
                isBullish: bar.close >= bar.open,
                poc: 0,
                stackedBuyZones: [],
                stackedSellZones: [],
                unfinishedTop: false,
                unfinishedBottom: false,
                absorptionCount: 0,
                diagDominant: 'none',
            };
        }
    }, []);

    // Workers
    const onWorkerMessage = (e: MessageEvent<HeatmapReply>) => heatmapTilesRef.current?.onReply(e.data);

    // send a copy so the charts own buffer stays usable while the worker builds
    const sendHeatmapInit = useCallback(() => {
        const cb = compactBufRef.current;
        const worker = workerRef.current;
        if (!worker || !cb.length) return;
        const buf = cb._buf.slice(0, cb.length * BYTES_PER_EVENT);
        const msg: WorkerInitMessage = { type: 'init', buf, length: cb.length };
        worker.postMessage(msg, [buf]);
        heatmapSentRef.current = { buf: cb._buf, length: cb.length };
    }, []);

    // just the new events when what was sent is still there as it was, the whole buffer otherwise
    const sendHeatmapUpdate = useCallback(() => {
        const cb = compactBufRef.current;
        const worker = workerRef.current;
        const sent = heatmapSentRef.current;
        if (!worker || !sent || !cb.length || cb.length < sent.length) return sendHeatmapInit();
        if (!sameEvent(sent.buf, cb._buf, 0) || !sameEvent(sent.buf, cb._buf, sent.length - 1)) {
            return sendHeatmapInit();
        }
        if (cb.length > sent.length) {
            const buf = cb._buf.slice(sent.length * BYTES_PER_EVENT, cb.length * BYTES_PER_EVENT);
            const msg: WorkerInitMessage = { type: 'append', buf, length: cb.length - sent.length };
            worker.postMessage(msg, [buf]);
        }
        heatmapSentRef.current = { buf: cb._buf, length: cb.length };
    }, []);

    const runIndicatorWorker = useCallback((trades: SerialTrade[], barNs: bigint) => {
        const worker = indicatorWorkerRef.current;
        if (!worker) return;
        const SCRIPTED_SENTINEL = '__scripted__';

        const computable = p.indicatorsRef.current.filter(
            (ind) => ind.workerInit && ind.workerInit !== SCRIPTED_SENTINEL && ind.hydrate,
        );

        // Indicators dont run in the shared indicator worker but in their own
        // script.worker and recomputes via this event
        for (const ind of p.indicatorsRef.current) {
            if (ind.workerInit === SCRIPTED_SENTINEL) {
                p.eventBus.emit('plugin:scripted-recompute' as any, { id: ind.id });
            }
        }
        // building these walks every trade, on every live chunk
        if (computable.length === 0) return;

        function toNs(ts: number | bigint): bigint {
            const t = typeof ts === 'bigint' ? ts : BigInt(ts);
            if (t < 1_000_000_000_000n) return t * 1_000_000_000n;
            else if (t < 1_000_000_000_000_000n) return t * 1_000_000n;
            else if (t < 1_000_000_000_000_000_000n) return t * 1_000n;
            else return t;
        }

        const ohlcv: any[] = [];
        if (hasBook(dataLevelRef.current) || dataLevelRef.current === 'tick') {
            for (const [ts, bar] of candleCacheRef.current ?? new Map()) {
                ohlcv.push({
                    ts: toNs(ts),
                    open: bar.open,
                    high: bar.high,
                    low: bar.low,
                    close: bar.close,
                    volume: bar.volume,
                });
            }
            ohlcv.sort((a: any, b: any) => (a.ts < b.ts ? -1 : 1));
        } else if (dataLevelRef.current === 'ohlcv') {
            if (openBarRef.current) {
                ohlcv.push({
                    ts: openBarRef.current.ts,
                    open: openBarRef.current.open,
                    high: openBarRef.current.high,
                    low: openBarRef.current.low,
                    close: openBarRef.current.close,
                    volume: openBarRef.current.totalVol,
                });
            }
        }

        const ticks: TickEvent[] = trades.map((t) => ({
            time: Number(t.ts / 1_000_000n),
            price: t.price,
            size: t.size,
            side: t.side,
        }));

        const requestId = String(++indicatorRequestIdRef.current);
        worker.postMessage({
            type: 'compute',
            requestId,
            trades,
            ohlcv,
            ticks,
            snapshots: [],
            barNs,
            horizon: p.horizonRef.current,
            indicators: computable.map((ind) => ({
                id: ind.id,
                workerInit: ind.workerInit,
                params: (ind as any).workerParams,
            })),
        });
        worker.postMessage({
            type: 'register-update-fns',
            horizon: p.horizonRef.current,
            indicators: computable.map((ind) => ({
                id: ind.id,
                workerUpdate: ind.workerUpdate,
            })),
        });
    }, []);

    const runHorizonAdvance = useCallback((newHorizon: bigint) => {
        const worker = indicatorWorkerRef.current;
        if (!worker) return;
        const allTrades = allTradesRef.current;
        const lastHorizon = lastHorizonForIndicatorsRef.current;
        let lo = 0,
            hi = allTrades.length - 1,
            startI = allTrades.length;
        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            if (allTrades[mid].ts <= lastHorizon) {
                lo = mid + 1;
            } else {
                startI = mid;
                hi = mid - 1;
            }
        }
        let endI = startI - 1;
        lo = startI;
        hi = allTrades.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            if (allTrades[mid].ts <= newHorizon) {
                endI = mid;
                lo = mid + 1;
            } else hi = mid - 1;
        }
        lastHorizonForIndicatorsRef.current = newHorizon;
        const newTrades = endI >= startI ? allTrades.slice(startI, endI + 1) : [];
        const SCRIPTED_SENTINEL = '__scripted__';
        const computable = p.indicatorsRef.current.filter(
            (ind) =>
                ind.workerUpdate && ind.workerUpdate !== SCRIPTED_SENTINEL && ind.appendHydrate,
        );

        function toNs(ts: number | bigint): bigint {
            const t = typeof ts === 'bigint' ? ts : BigInt(ts);
            if (t < 1_000_000_000_000n) return t * 1_000_000_000n;
            else if (t < 1_000_000_000_000_000n) return t * 1_000_000n;
            else if (t < 1_000_000_000_000_000_000n) return t * 1_000n;
            else return t;
        }

        const ohlcv: any[] = [];
        if (hasBook(dataLevelRef.current) || dataLevelRef.current === 'tick') {
            for (const [ts, bar] of candleCacheRef.current ?? new Map()) {
                ohlcv.push({
                    ts: toNs(ts),
                    open: bar.open,
                    high: bar.high,
                    low: bar.low,
                    close: bar.close,
                    volume: bar.volume,
                });
            }
            ohlcv.sort((a: any, b: any) => (a.ts < b.ts ? -1 : 1));
        } else if (dataLevelRef.current === 'ohlcv') {
            if (openBarRef.current) {
                ohlcv.push({
                    ts: openBarRef.current.ts,
                    open: openBarRef.current.open,
                    high: openBarRef.current.high,
                    low: openBarRef.current.low,
                    close: openBarRef.current.close,
                    volume: openBarRef.current.totalVol,
                });
            }
        }

        const ticks: TickEvent[] = newTrades.map((t) => ({
            time: Number(t.ts / 1_000_000n),
            price: t.price,
            size: t.size,
            side: t.side,
        }));

        if (computable.length > 0) {
            const requestId = String(++indicatorRequestIdRef.current);
            worker.postMessage({
                type: 'compute',
                requestId,
                trades: newTrades,
                ohlcv,
                ticks,
                snapshots: [],
                barNs: p.activeTimeframeRef.current.barNs,
                horizon: newHorizon,
                indicators: computable.map((ind) => ({
                    id: ind.id,
                    workerInit: ind.workerInit,
                    params: (ind as any).workerParams,
                })),
            });
            worker.postMessage({
                type: 'register-update-fns',
                horizon: newHorizon,
                indicators: computable.map((ind) => ({
                    id: ind.id,
                    workerUpdate: ind.workerUpdate,
                })),
            });
        }

        // Keep scripted (plugin) indicators in sync as the horizon advances - they
        // recompute through their own worker (see runIndicatorWorker). Without this
        // they'd never update during playback.
        for (const ind of p.indicatorsRef.current) {
            if (ind.workerInit === SCRIPTED_SENTINEL) {
                p.eventBus.emit('plugin:scripted-recompute' as any, { id: ind.id });
            }
        }
    }, []);

    const scheduleResample = useCallback(() => {
        if (resampleTimerRef.current) clearTimeout(resampleTimerRef.current);
        resampleTimerRef.current = setTimeout(() => {
            const view = p.viewRef.current;
            const canvas = p.baseCanvasRef.current;
            if (!view || !canvas) return;

            if (p.indicatorsRef.current.some((i) => i.id === 'vp_visiblerange')) {
                runIndicatorWorker(
                    getTradesUpToHorizon(p.horizonRef.current),
                    p.activeTimeframeRef.current.barNs,
                );
            }
            // Scripted indicators compute over a window around the view (see
            // useChartSubscriptions). Recompute once the pan settles so the window
            // follows the viewport and off-screen bars stay uncomputed.
            const SCRIPTED = '__scripted__';
            for (const ind of p.indicatorsRef.current) {
                if (ind.workerInit === SCRIPTED) {
                    p.eventBus.emit('plugin:scripted-recompute' as any, { id: ind.id });
                }
            }
            if (p.chartSettingsRef.current.showHeatmap) heatmapTilesRef.current?.settled();
        }, p.chartSettingsRef.current.resamplingDebounce);
    }, [p.chartSettingsRef.current.resamplingDebounce]);

    const onIndicatorWorkerMessage = (e: MessageEvent) => {
        const msg = e.data;
        if (msg.type === 'compute') {
            const { requestId, results, errors } = msg;
            if (requestId !== String(indicatorRequestIdRef.current)) return;
            const barNs = p.activeTimeframeRef.current.barNs;
            for (const ind of p.indicatorsRef.current) {
                if (results[ind.id] !== undefined) ind.hydrate?.(results[ind.id], barNs);
                if (errors[ind.id]) console.error(`[indicator:${ind.id}]`, errors[ind.id]);
            }
            p.autofitIndicatorPanesRef.current();
            p.pushDrawParamsRef.current();
            p.renderEngineRef.current?.markDirty('base');
            p.renderEngineRef.current?.markDirty('ui');
            return;
        }
        if (msg.type === 'horizon:advance') {
            const { points, errors } = msg;
            const barNs = p.activeTimeframeRef.current.barNs;
            for (const ind of p.indicatorsRef.current) {
                if (points[ind.id] !== undefined) ind.appendHydrate?.(points[ind.id], barNs);
                if (errors[ind.id]) console.error(`[indicator:${ind.id}]`, errors[ind.id]);
            }
            p.renderEngineRef.current?.markDirty('base');
        }
    };

    // Ingest
    const ingestLoadedData = useCallback((payload: any) => {
        if (payload.error) {
            p.eventBus.emit('data:status', {
                status: 'error',
                error: {
                    code: payload.error,
                    message: payload.errorMessage ?? 'Failed to load data',
                },
                symbol: payload.symbol ?? cellSymbolRef.current,
            });
            return;
        }
        // Every load here is already filtered to this cell's symbol, so the level
        // follows the symbol. It used to be written once and kept forever, which
        // left the whole cell (renderers, the plugin gates) believing the first
        // symbol's level after a switch to one that serves less.
        const levelChanged = dataLevelRef.current !== payload.dataLevel;
        dataLevelRef.current = payload.dataLevel as DataLevel;
        if (levelChanged) p.onDataLevelChangeRef.current();
        // A load carries its own symbol's supplemental bars or none at all, so
        // write the miss too. Skipping it left the previous symbol's 1s bars in
        // place, and syncOhlcvOpenBar would build this symbol's forming candle
        // out of another instrument's prices - entitlement is per symbol now, so
        // "loaded a symbol with no supplemental" is an ordinary occurrence.
        supplementalBarsRef.current = payload.supplemental ?? null;

        if (payload.dataLevel === 'ohlcv') {
            const loaded: BarStore = payload.bars ?? new BarStore();
            if (payload.session !== undefined) {
                p.resolvedSessionRef.current = payload.session;
            }
            compactBufRef.current = createCompactBuffer(0);
            allTradesRef.current = [];
            midPrintsRef.current = [];
            tradesRef.current = [];
            allPriceHistoryRef.current = [];
            priceHistoryRef.current = [];
            footprintBarsRef.current = [];
            candleCacheRef.current = null;
            const _activeTfBarNs = p.activeTimeframeRef.current.barNs;

            // the engines store thats shared. the engine grows it and this pane only reads it
            // so every pane on a symbol holds one copy between them
            const raw = loaded;
            ohlcvBarsRef.current = {
                barNs: _activeTfBarNs,
                sourceBarNs: payload.barNs ?? _activeTfBarNs,
                bars: raw,
                display: new BarStore(),
            };
            const ds = BigInt(payload.dataStart) * 1_000_000n;
            const de = BigInt(payload.dataEnd) * 1_000_000n;
            const oldEnd = datasetEndRef.current;
            datasetStartRef.current = ds;
            datasetEndRef.current = de;
            p.onDataBoundsChange?.(ds, de);
            // protect the horizon from being dragged back a year after an eviction
            const playFrom = loadedHorizon({
                replaced: !!payload.replaced,
                follows: followsEdge(oldEnd, de),
                horizon: p.horizonRef.current,
                newEnd: de,
                playFrom: payload.playFromIso ? isoToNs(payload.playFromIso) : null,
            });
            p.horizonRef.current = playFrom;
            playheadIdxRef.current = 0;
            openBarRef.current = null;
            openBarTsRef.current = 0n;
            const PAD = 14n * 24n * 60n * 60n * 1_000_000_000n;
            p.sessionMapperRef.current.build(p.resolvedSessionRef.current, ds - PAD, de + PAD);

            prevHorizonBarRef.current = ohlcvBucketRange(
                playFrom,
                _activeTfBarNs,
                p.sessionMapperRef.current,
            ).start;
            ohlcvBarsRef.current.display = displayFor(
                raw,
                ohlcvBarsRef.current.sourceBarNs,
                _activeTfBarNs,
                p.sessionMapperRef.current,
            );
            syncOhlcvOpenBar(p.horizonRef.current);
            p.eventBus.emit('data:bounds', {
                start: ds,
                end: de,
                session: p.resolvedSessionRef.current,
                symbol: cellSymbolRef.current,
            });
            {
                const s = getSessionStatus(p.resolvedSessionRef.current, playFrom);
                const prev = prevSessionStatusRef.current;
                if (
                    !prev ||
                    prev.kind !== s.kind ||
                    (s.kind === 'sub' &&
                        prev.kind === 'sub' &&
                        (prev as any).label !== (s as any).label)
                ) {
                    prevSessionStatusRef.current = s;
                    p.eventBus.emit('session:status', { ...s, symbol: cellSymbolRef.current });
                }
            }

            if (!payload.replaced) {
                const timeSpan = 800_000_000_000n;
                const offset = 100_000_000_000n;
                p.viewRef.current = {
                    ...(p.viewRef.current ?? { tMin: 0n, tMax: 0n, pMin: 0, pMax: 0, pRef: 0 }),
                    tMin: de - timeSpan + offset,
                    tMax: de + offset,
                };
                p.resetViewRef.current();
            }
            p.transformer.update(p.viewRef.current);
            p.transformer.setSessionMapper(p.sessionMapperRef.current);
            p.transformer.setSession(p.resolvedSessionRef.current);
            p.renderEngineRef.current?.setView(p.viewRef.current);
            const _SCRIPTED = '__scripted__';
            const _keptInds = payload.replaced
                ? p.indicatorsRef.current
                : p.indicatorsRef.current.filter((i) => i.workerInit === _SCRIPTED);
            p.indicatorsRef.current = _keptInds;
            p.setIndicators(_keptInds);
            p.eventBus.emit('data:status', {
                status: 'ready',
                symbol: payload.symbol ?? cellSymbolRef.current,
            });
            p.onLoadAppliedRef.current(ohlcvBarsRef.current.sourceBarNs);
            p.pushDrawParamsRef.current();
            if (_keptInds.length > 0)
                runIndicatorWorker(
                    getTradesUpToHorizon(p.horizonRef.current),
                    p.activeTimeframeRef.current.barNs,
                );
            p.renderEngineRef.current?.markDirty('base');
            return;
        }

        try {
            const {
                compactBuf: inBuf,
                trades: newTrades,
                priceHistory: newHistory,
                footprintBars: newFpBars,
                fpOptions: fpBuiltWith,
                barNs: workerBarNs,
                dataStart,
                dataEnd,
                session: payloadSession,
            } = payload;
            if (payloadSession !== undefined) p.resolvedSessionRef.current = payloadSession;
            compactBufRef.current = createCompactBuffer(0);
            compactBufRef.current._buf = inBuf as ArrayBuffer;
            compactBufRef.current._view = new DataView(inBuf as ArrayBuffer);
            compactBufRef.current.length = (inBuf as ArrayBuffer).byteLength / BYTES_PER_EVENT;
            compactBufRef.current.capacity = compactBufRef.current.length;
            compactBufRef.current.firstTs = BigInt(dataStart) * 1_000_000n;
            compactBufRef.current.lastTs = BigInt(dataEnd) * 1_000_000n;
            allTradesRef.current = newTrades;
            midPrintsRef.current = payload.midPrints ?? [];
            allPriceHistoryRef.current = newHistory;
            tradesRef.current = newTrades;
            openBarRef.current = null;
            phCursorRef.current = newHistory.length - 1;
            candleCacheRef.current = null;
            const activeTfBarNs = p.activeTimeframeRef.current.barNs;
            const ds = BigInt(dataStart) * 1_000_000n;
            const de = BigInt(dataEnd) * 1_000_000n;
            const oldEnd = datasetEndRef.current;
            datasetStartRef.current = ds;
            datasetEndRef.current = de;
            p.onDataBoundsChange?.(ds, de);
            const playFrom = loadedHorizon({
                replaced: !!payload.replaced,
                follows: followsEdge(oldEnd, de),
                horizon: p.horizonRef.current,
                newEnd: de,
                playFrom: payload.playFromIso ? isoToNs(payload.playFromIso) : null,
            });
            const playFromIdx = findFloorIndex(compactBufRef.current, playFrom);
            playheadIdxRef.current = playFromIdx;
            openBarRef.current = null;
            openBarTsRef.current = 0n;
            openBarTradeCountRef.current = 0;
            p.horizonRef.current = playFrom;
            takeFootprints(newFpBars, workerBarNs, fpBuiltWith);
            const _SCRIPTED = '__scripted__';
            const _keptIndsL3 = payload.replaced
                ? p.indicatorsRef.current
                : p.indicatorsRef.current.filter((i) => i.workerInit === _SCRIPTED);
            p.indicatorsRef.current = _keptIndsL3;
            p.setIndicators(_keptIndsL3);
            const { ingestOhlcvBuf, ingestBucketedPhBuf } = payload;
            candleCacheRef.current = null;
            priceHistoryRef.current = [];
            const PAD = 14n * 24n * 60n * 60n * 1_000_000_000n;
            p.sessionMapperRef.current.build(p.resolvedSessionRef.current, ds - PAD, de + PAD);
            prevHorizonBarRef.current = ohlcvBucketRange(
                playFrom,
                activeTfBarNs,
                p.sessionMapperRef.current,
            ).start;
            p.eventBus.emit('data:bounds', {
                start: ds,
                end: de,
                session: p.resolvedSessionRef.current,
                symbol: cellSymbolRef.current,
            });
            {
                const s = getSessionStatus(p.resolvedSessionRef.current, playFrom);
                const prev = prevSessionStatusRef.current;
                if (
                    !prev ||
                    prev.kind !== s.kind ||
                    (s.kind === 'sub' &&
                        prev.kind === 'sub' &&
                        (prev as any).label !== (s as any).label)
                ) {
                    prevSessionStatusRef.current = s;
                    p.eventBus.emit('session:status', { ...s, symbol: cellSymbolRef.current });
                }
            }
            if (!payload.replaced) {
                const timeSpan = 800_000_000_000n;
                const offset = 100_000_000_000n;
                p.viewRef.current = {
                    ...(p.viewRef.current ?? { tMin: 0n, tMax: 0n, pMin: 0, pMax: 0, pRef: 0 }),
                    tMin: playFrom - timeSpan + offset,
                    tMax: playFrom + offset,
                };
            }
            p.transformer.update(p.viewRef.current);
            p.transformer.setSessionMapper(p.sessionMapperRef.current);
            p.transformer.setSession(p.resolvedSessionRef.current);
            p.renderEngineRef.current?.setView(p.viewRef.current);
            p.eventBus.emit('data:status', {
                status: 'ready',
                symbol: payload.symbol ?? cellSymbolRef.current,
            });
            // a switch waiting on this load can land now
            p.onLoadAppliedRef.current(workerBarNs);
            if (_keptIndsL3.length > 0)
                runIndicatorWorker(getTradesUpToHorizon(playFrom), activeTfBarNs);
            if (ingestBucketedPhBuf) {
                priceHistoryRef.current = deserializePriceHistoryFromBuf(ingestBucketedPhBuf);
                // a switch keeps the price zoom too
                if (!payload.replaced) autoFitPriceAxis(
                    p.viewRef.current!,
                    priceHistoryRef.current,
                    tradesRef.current,
                    dataLevelRef.current === 'ohlcv'
                        ? ohlcvBarsRef.current.display
                        : previewBarsRef.current,
                    openBarRef.current,
                    p.chartSettingsRef.current,
                    playFrom,
                    dataLevelRef.current,
                );
                p.transformer.update(p.viewRef.current!);
                p.transformer.setSessionMapper(p.sessionMapperRef.current);
                p.transformer.setSession(p.resolvedSessionRef.current);
                p.pushDrawParamsRef.current();
                p.renderEngineRef.current?.markDirty('base');
            }
            if (ingestOhlcvBuf) {
                candleCacheRef.current = deserializeOhlcvCacheFromBuf(
                    ingestOhlcvBuf,
                    p.horizonRef.current,
                );
            }
            // the ingest buckets trades and book only l2 has none
            if (candleSrc(newTrades) !== newTrades) rebuildCandleCache(newTrades, activeTfBarNs);
            // again, the cache changed after the push above
            p.pushDrawParamsRef.current();
            p.renderEngineRef.current?.markDirty('base');
            if (workerRef.current) {
                sendHeatmapInit();
                scheduleResample();
            }
        } catch (e) {
            console.error('[chart] ingestLoadedData failed', e);
        }
    }, []);

    const ingestAppendedData = useCallback((payload: any) => {
        if (payload.dataLevel === 'ohlcv') {
            const newBars: OhlcvBarMs[] = (payload.ohlcvBars ?? []).map((bar: any) => ({
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
                volume: bar.volume,
                time: bar.time,
            }));
            const _appendTargetBarNs = p.activeTimeframeRef.current.barNs;
            const de = BigInt(payload.dataEnd) * 1_000_000n;
            const oldEnd = datasetEndRef.current;
            datasetEndRef.current = de;
            // Extend raw + display in place - O(new bars). Rebuilding the whole
            // array and re-aggregating every forward chunk froze the UI as playback
            // accumulated data. Only the last display bucket can change.
            if (newBars.length > 0) {
                // the engine already trimmed the resetn edge ebar and appended these 2 the shared store
                const bars = ohlcvBarsRef.current.bars;
                const mapper = p.sessionMapperRef.current;
                ohlcvBarsRef.current.barNs = _appendTargetBarNs;
                const disp = ohlcvBarsRef.current.display;
                if (disp === bars) {
                    // display is the store and the engine already extended it
                } else if (disp.length === 0) {
                    ohlcvBarsRef.current.display = displayFor(
                        bars,
                        ohlcvBarsRef.current.sourceBarNs,
                        _appendTargetBarNs,
                        mapper,
                    );
                } else {
                    const lastBucketTime = disp.time[disp.length - 1];
                    const tail = aggregateOhlcvBars(
                        bars,
                        _appendTargetBarNs,
                        p.sessionMapperRef.current,
                        bars.lowerBound(lastBucketTime),
                    ).toArray();
                    // the last bucket gets replaced by the tail's first
                    if (tail.length) {
                        disp.set(disp.length - 1, tail[0]);
                        disp.append(tail.slice(1));
                    } else {
                        disp.replaceRange(lastBucketTime, lastBucketTime, []);
                    }
                }
            }
            // follow the new edge only when idle at the live edge. during playback
            // the engine owns the horizon, and yanking it snapped whole batches on.
            // a page into a hole isn't the live edge either, until it reaches it
            const followLive = followsEdge(oldEnd, de);
            const effHorizon = followLive ? de : p.horizonRef.current;
            p.horizonRef.current = effHorizon;
            followHorizonBar(effHorizon);
            syncOhlcvOpenBar(effHorizon);
            {
                const s = getSessionStatus(p.resolvedSessionRef.current, effHorizon);
                const prev = prevSessionStatusRef.current;
                if (
                    !prev ||
                    prev.kind !== s.kind ||
                    (s.kind === 'sub' &&
                        prev.kind === 'sub' &&
                        (prev as any).label !== (s as any).label)
                ) {
                    prevSessionStatusRef.current = s;
                    p.eventBus.emit('session:status', { ...s, symbol: cellSymbolRef.current });
                }
            }
            p.onDataBoundsChange?.(datasetStartRef.current, de);
            // Tell the playback engine the loaded edge moved so its data-gated
            // clock can advance past the old end (see usePlaybackEngine).
            p.eventBus.emit('data:bounds', {
                start: datasetStartRef.current,
                end: de,
                session: p.resolvedSessionRef.current,
                symbol: cellSymbolRef.current,
            });
            p.pushDrawParamsRef.current();
            runIndicatorWorker(getTradesUpToHorizon(effHorizon), _appendTargetBarNs);
            p.renderEngineRef.current?.markAllDirty();
            return;
        }
        try {
            const {
                compactBuf: inBuf,
                trades: newTrades,
                priceHistory: newHistory,
                footprintBars: newFpBars,
                fpOptions: fpBuiltWith,
                barNs: workerBarNs,
                dataEnd,
            } = payload;
            const ownBuf = inBuf as ArrayBuffer;
            const cb = createCompactBuffer(0);
            cb._buf = ownBuf;
            cb._view = new DataView(ownBuf);
            cb.length = ownBuf.byteLength / BYTES_PER_EVENT;
            cb.capacity = cb.length;
            cb.firstTs = datasetStartRef.current;
            cb.lastTs = BigInt(dataEnd) * 1_000_000n;
            compactBufRef.current = cb;
            allTradesRef.current = newTrades;
            midPrintsRef.current = payload.midPrints ?? [];
            allPriceHistoryRef.current = newHistory;
            tradesRef.current = newTrades;
            const activeTfBarNs = p.activeTimeframeRef.current.barNs;
            const de = BigInt(dataEnd) * 1_000_000n;
            const oldEnd = datasetEndRef.current;
            datasetEndRef.current = de;
            const followLive = followsEdge(oldEnd, de);
            const effHorizon = followLive ? de : p.horizonRef.current;
            const newPlayFromIdx = findFloorIndex(compactBufRef.current, effHorizon);
            playheadIdxRef.current = newPlayFromIdx;
            p.horizonRef.current = effHorizon;
            followHorizonBar(effHorizon);
            takeFootprints(newFpBars, workerBarNs, fpBuiltWith);
            if (activeTfBarNs > 0n) {
                phCursorRef.current = extendBucketedPh(
                    priceHistoryRef.current,
                    newHistory,
                    activeTfBarNs,
                    effHorizon,
                );
                if (candleCacheRef.current)
                    extendCandles(candleCacheRef.current, candleSrc(newTrades), activeTfBarNs, effHorizon);
                else rebuildCandleCache(newTrades, activeTfBarNs);
            }
            if (p.isYAxisAutoRef.current)
                autoFitPriceAxis(
                    p.viewRef.current!,
                    priceHistoryRef.current,
                    tradesRef.current,
                    dataLevelRef.current === 'ohlcv'
                        ? ohlcvBarsRef.current.display
                        : previewBarsRef.current,
                    openBarRef.current,
                    p.chartSettingsRef.current,
                    p.horizonRef.current,
                    dataLevelRef.current,
                );
            p.onDataBoundsChange?.(datasetStartRef.current, de);
            // Tell the playback engine the loaded edge moved so its data-gated
            // clock can advance past the old end (see usePlaybackEngine).
            p.eventBus.emit('data:bounds', {
                start: datasetStartRef.current,
                end: de,
                session: p.resolvedSessionRef.current,
                symbol: cellSymbolRef.current,
            });
            p.pushDrawParamsRef.current();
            p.renderEngineRef.current?.markAllDirty();
            runIndicatorWorker(getTradesUpToHorizon(p.horizonRef.current), activeTfBarNs);
            sendHeatmapUpdate();
            scheduleResample();
        } catch (e) {
            console.error('[chart] ingestAppendedData failed', e);
        }
    }, []);

    const ingestPrependedData = useCallback((payload: any) => {
        if (payload.dataLevel === 'ohlcv') {
            const newBars: OhlcvBarMs[] = (payload.ohlcvBars ?? []).map((bar: any) => ({
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
                volume: bar.volume,
                time: bar.time,
            }));
            const _prependTargetBarNs = p.activeTimeframeRef.current.barNs;
            const ds = BigInt(payload.dataStart) * 1_000_000n;
            const PAD = 14n * 24n * 60n * 60n * 1_000_000_000n;
            const newRangeFrom = ds - PAD;

            // Extend the session mapper backward only over the NEW range instead of
            // rebuilding from scratch - O(new_range_minutes) vs O(total_range_minutes).
            p.sessionMapperRef.current.extendBackward(p.resolvedSessionRef.current, newRangeFrom);

            const raw = ohlcvBarsRef.current.bars;
            const mapper = p.sessionMapperRef.current;
            const display = ohlcvBarsRef.current.display;
            ohlcvBarsRef.current.display =
                display === raw
                    ? raw // the store is the display, and the engine prepended into it
                    : prependAggregatedOhlcvBars(newBars, display, _prependTargetBarNs, mapper);
            ohlcvBarsRef.current.barNs = _prependTargetBarNs;
            datasetStartRef.current = ds;
            p.eventBus.emit('data:bounds', {
                start: ds,
                end: datasetEndRef.current,
                session: p.resolvedSessionRef.current,
                symbol: cellSymbolRef.current,
            });
            p.onDataBoundsChange?.(ds, datasetEndRef.current);
            if (p.isYAxisAutoRef.current)
                autoFitPriceAxis(
                    p.viewRef.current!,
                    priceHistoryRef.current,
                    tradesRef.current,
                    dataLevelRef.current === 'ohlcv'
                        ? ohlcvBarsRef.current.display
                        : previewBarsRef.current,
                    openBarRef.current,
                    p.chartSettingsRef.current,
                    p.horizonRef.current,
                    dataLevelRef.current,
                );
            p.pushDrawParamsRef.current();
            runIndicatorWorker(
                getTradesUpToHorizon(p.horizonRef.current),
                p.activeTimeframeRef.current.barNs,
            );
            p.renderEngineRef.current?.markAllDirty();
            return;
        }
        try {
            const {
                compactBuf: inBuf,
                trades: newTrades,
                priceHistory: newHistory,
                footprintBars: newFpBars,
                fpOptions: fpBuiltWith,
                dataStart,
            } = payload;
            const ds = BigInt(dataStart) * 1_000_000n;
            const ownBuf = inBuf as ArrayBuffer;
            const cb = createCompactBuffer(0);
            cb._buf = ownBuf;
            cb._view = new DataView(ownBuf);
            cb.length = ownBuf.byteLength / BYTES_PER_EVENT;
            cb.capacity = cb.length;
            cb.firstTs = ds;
            cb.lastTs = datasetEndRef.current;
            compactBufRef.current = cb;
            sendHeatmapInit();
            allTradesRef.current = newTrades;
            midPrintsRef.current = payload.midPrints ?? [];
            allPriceHistoryRef.current = newHistory;
            tradesRef.current = newTrades;
            if (newFpBars.length > 0) takeFootprints(newFpBars, payload.barNs, fpBuiltWith);
            playheadIdxRef.current = findFloorIndex(compactBufRef.current, p.horizonRef.current);
            datasetStartRef.current = ds;
            {
                const PAD = 14n * 24n * 60n * 60n * 1_000_000_000n;
                p.sessionMapperRef.current.build(
                    p.resolvedSessionRef.current,
                    ds - PAD,
                    datasetEndRef.current + PAD,
                );
            }
            p.eventBus.emit('data:bounds', {
                start: ds,
                end: datasetEndRef.current,
                session: p.resolvedSessionRef.current,
                symbol: cellSymbolRef.current,
            });
            p.onDataBoundsChange?.(ds, datasetEndRef.current);
            priceHistoryRef.current = [];
            phCursorRef.current = -1;
            updatePriceHistoryToRawIdx(findPriceHistoryIdx(p.horizonRef.current));
            rebuildCandleCache(newTrades, p.activeTimeframeRef.current.barNs);
            if (p.isYAxisAutoRef.current)
                autoFitPriceAxis(
                    p.viewRef.current!,
                    priceHistoryRef.current,
                    tradesRef.current,
                    dataLevelRef.current === 'ohlcv'
                        ? ohlcvBarsRef.current.display
                        : previewBarsRef.current,
                    openBarRef.current,
                    p.chartSettingsRef.current,
                    p.horizonRef.current,
                    dataLevelRef.current,
                );
            p.pushDrawParamsRef.current();
            p.renderEngineRef.current?.markAllDirty();
            runIndicatorWorker(
                getTradesUpToHorizon(p.horizonRef.current),
                p.activeTimeframeRef.current.barNs,
            );
        } catch (e) {
            console.error('[chart] ingestPrependedData failed', e);
        }
    }, []);

    // advances horizonScrollAnimRef on its own raf loop rather than only when
    // applyHorizon happens to be called again. auto playback calls applyHorizon every tick
    // so animation was fine there, but a single manual step only calls applyHorizon once
    // so only shifted the chart by a px instead of a whole bar
    const driveHorizonScrollAnim = useCallback(() => {
        const anim = horizonScrollAnimRef.current;
        const view = p.viewRef.current;
        if (!anim || !view) {
            horizonScrollRafRef.current = null;
            return;
        }
        const duration = anim.duration ?? p.chartSettingsRef.current.horizonScrollDuration;
        const raw = Math.min((performance.now() - anim.startTime) / duration, 1.0);
        const eased = applyHorizonScrollEasing(
            raw,
            anim.easing ?? p.chartSettingsRef.current.horizonScrollEasing,
        );
        const lerp = (a: bigint, b: bigint, f: number) => a + BigInt(Math.round(Number(b - a) * f));
        if (anim.startMMin !== undefined && anim.targetMMin !== undefined) {
            const sm = p.sessionMapperRef.current;
            view.tMin = sm.marketToTs(lerp(anim.startMMin, anim.targetMMin, eased));
            view.tMax = sm.marketToTs(lerp(anim.startMMax, anim.targetMMax, eased));
        } else {
            view.tMin = lerp(anim.startTMin, anim.targetTMin, eased);
            view.tMax = lerp(anim.startTMax, anim.targetTMax, eased);
        }
        p.transformer.update(view);
        p.renderEngineRef.current?.setView(view);
        p.renderEngineRef.current?.markDirty('base');
        p.renderEngineRef.current?.markDirty('drawings');
        if (raw >= 1.0) {
            horizonScrollAnimRef.current = null;
            horizonScrollRafRef.current = null;
            scheduleResample();
            return;
        }
        horizonScrollRafRef.current = requestAnimationFrame(driveHorizonScrollAnim);
    }, [scheduleResample]);

    useEffect(
        () => () => {
            if (horizonScrollRafRef.current !== null) {
                cancelAnimationFrame(horizonScrollRafRef.current);
            }
        },
        [],
    );

    const liveScrollRafRef = useRef<number | null>(null);
    const liveScrollLastRef = useRef(0);
    const liveEdgeRef = useRef<LiveEdge | null>(null);
    const liveClockRef = useRef(0n);
    const liveLagRef = useRef(0n);
    const liveSeenRef = useRef({ ph: { n: 0, last: 0n }, tr: { n: 0, last: 0n } });
    const liveLagTargetRef = useRef(0n);

    // move the view with the clock instead of per trade
    const liveFollowing = (): boolean => {
        const view = p.viewRef.current;
        if (!view || !p.isRealtime?.() || isPlayingRef.current) return false;
        if (p.activeTimeframeRef.current.barNs > 1_000_000n) return false;

        const h = p.horizonRef.current;
        if (h < datasetEndRef.current) return false;

        const mode = p.dragMode.current;
        if (p.isDragging.current && (mode === 'pan' || mode === 'scaleX')) return false;
        if (mode === 'pinch' || mode === 'glide') return false;

        const bar = ohlcvBucketRange(h, p.activeTimeframeRef.current.barNs, p.sessionMapperRef.current).start;
        return view.tMin < bar && bar < view.tMax;
    };

    const driveLiveScroll = (t: number) => {
        const view = p.viewRef.current;
        if (!view || !liveFollowing()) {
            liveScrollRafRef.current = null;
            // a stale edge would hide every trade after it
            liveEdgeRef.current = null;
            p.renderEngineRef.current?.setLiveEdge(null);
            p.renderEngineRef.current?.markDirty('base');
            return;
        }
        const nowNs = (ms: number) => BigInt(Math.round((performance.timeOrigin + ms) * 1e6));
        const from = nowNs(liveScrollLastRef.current);
        const to = nowNs(t);
        liveScrollLastRef.current = t;
        if (to > from) {
            const sm = p.sessionMapperRef.current;
            if (sm.hasSession) {
                const shift = sm.tsToMarket(to) - sm.tsToMarket(from);
                view.tMin = sm.marketToTs(sm.tsToMarket(view.tMin) + shift);
                view.tMax = sm.marketToTs(sm.tsToMarket(view.tMax) + shift);
            } else {
                view.tMin += to - from;
                view.tMax += to - from;
            }
            const h = p.horizonRef.current;
            const edge = liveEdgeRef.current;
            let clock = edge && h >= edge.from ? liveClockRef.current + (to - from) : h;
            // data shows up late and the step ends at the worst of that, behind, so new data lands on the end
            const dt = to - from;
            let target = liveLagTargetRef.current - dt / 50n;
            const painted = p.renderEngineRef.current?.paintedData();
            if (painted) {
                // the oldest of what just came in is the latest. only off a plain append, a trim would read as late
                let oldest: bigint | null = null;
                const firstNew = (arr: { ts: bigint }[], seen: { n: number; last: bigint }) => {
                    const had = seen.n;
                    if (arr.length > had && had > 0 && arr[had - 1].ts === seen.last)
                        if (oldest === null || arr[had].ts < oldest) oldest = arr[had].ts;
                    seen.n = arr.length;
                    seen.last = arr.length ? arr[arr.length - 1].ts : 0n;
                };
                firstNew(painted.priceHistory, liveSeenRef.current.ph);
                firstNew(painted.trades, liveSeenRef.current.tr);
                if (edge && oldest !== null && clock - oldest > target) target = clock - oldest;
            }
            target = target < 0n ? 0n : target > 1_000_000_000n ? 1_000_000_000n : target;
            liveLagTargetRef.current = target;
            // climbs no faster than time passes, so the end stands still instead of stepping back
            const lag = liveLagRef.current;
            liveLagRef.current = target > lag + dt ? lag + dt : target;
            if (clock < h) clock = h;
            liveClockRef.current = clock;
            liveEdgeRef.current = { from: h, to: clock - liveLagRef.current };
            p.renderEngineRef.current?.setLiveEdge(liveEdgeRef.current);
            p.transformer.update(view);
            p.renderEngineRef.current?.setView(view);
            p.renderEngineRef.current?.markDirty('base');
            p.renderEngineRef.current?.markDirty('drawings');
        }
        liveScrollRafRef.current = requestAnimationFrame(driveLiveScroll);
    };

    const startLiveScroll = () => {
        if (liveScrollRafRef.current !== null) return;
        liveScrollLastRef.current = performance.now();
        liveScrollRafRef.current = requestAnimationFrame(driveLiveScroll);
    };

    useEffect(
        () => () => {
            if (liveScrollRafRef.current !== null) cancelAnimationFrame(liveScrollRafRef.current);
        },
        [],
    );

    // applyHorizon / seekHorizon
    const followHorizonBar = useCallback((horizon: bigint) => {
        const barNs = p.activeTimeframeRef.current.barNs;
        // Same bucketing as the bars themselves, so the follow-scroll steps at the
        // moment a new candle actually opens rather than at an epoch multiple.
        const newHorizonBar = ohlcvBucketRange(horizon, barNs, p.sessionMapperRef.current).start;
        const live = liveFollowing();
        if (live) startLiveScroll();
        if (newHorizonBar !== prevHorizonBarRef.current) {
            const oldHorizonBar = prevHorizonBarRef.current;
            const fwd = newHorizonBar > oldHorizonBar;
            prevHorizonBarRef.current = newHorizonBar;
            if (fwd && live) {
                horizonScrollAnimRef.current = null;
                scheduleResample();
                return;
            }
            const inChart =
                !!p.viewRef.current &&
                p.viewRef.current.tMax > newHorizonBar &&
                p.viewRef.current.tMin < newHorizonBar;
            if (
                p.viewRef.current &&
                !(
                    p.isDragging.current &&
                    (p.dragMode.current === 'pan' || p.dragMode.current === 'scaleX')
                ) &&
                p.dragMode.current !== 'pinch' &&
                p.dragMode.current !== 'glide' &&
                fwd &&
                inChart
            ) {
                const easing = p.chartSettingsRef.current.horizonScrollEasing;
                const duration = p.chartSettingsRef.current.horizonScrollDuration;
                const now = performance.now();
                const timeSinceLastBar = now - lastBarAdvanceTimeRef.current;
                lastBarAdvanceTimeRef.current = now;
                const sm = p.sessionMapperRef.current;
                const useMarket = sm.hasSession;
                // Shift by the *actual* number of bars the horizon crossed, not a
                // single bar - a lag spike or fast playback can advance several bars
                // in one tick, and a one-bar step would let price outrun the follow.
                // Anchor the target to the pinned position (the in-flight animation's
                // target, if any) rather than the interpolated current view, so an
                // interrupted scroll can't accumulate drift: the gap from the forming
                // bar to the right edge stays fixed.
                const anim = horizonScrollAnimRef.current;
                // When playback outpaces the configured scroll animation (bars arrive
                // closer together than `duration`), an eased curve can't finish before
                // the next bar and would visibly stutter. Rather than hard-snapping,
                // glide linearly over the actual inter-bar interval: constant velocity
                // that lands right as the next bar is due, so motion stays continuous.
                const cantKeepUp = timeSinceLastBar < duration;
                const animEasing = cantKeepUp ? 'linear' : easing;
                const animDuration = cantKeepUp ? Math.max(1, timeSinceLastBar) : duration;
                if (useMarket) {
                    const mShift = sm.tsToMarket(newHorizonBar) - sm.tsToMarket(oldHorizonBar);
                    const baseMMin = anim?.targetMMin ?? sm.tsToMarket(p.viewRef.current.tMin);
                    const baseMMax = anim?.targetMMax ?? sm.tsToMarket(p.viewRef.current.tMax);
                    const targetMMin = baseMMin + mShift;
                    const targetMMax = baseMMax + mShift;
                    if (easing === 'none') {
                        p.viewRef.current.tMin = sm.marketToTs(targetMMin);
                        p.viewRef.current.tMax = sm.marketToTs(targetMMax);
                        horizonScrollAnimRef.current = null;
                    } else {
                        horizonScrollAnimRef.current = {
                            startTMin: p.viewRef.current.tMin,
                            startTMax: p.viewRef.current.tMax,
                            targetTMin: sm.marketToTs(targetMMin),
                            targetTMax: sm.marketToTs(targetMMax),
                            startMMin: sm.tsToMarket(p.viewRef.current.tMin),
                            startMMax: sm.tsToMarket(p.viewRef.current.tMax),
                            targetMMin,
                            targetMMax,
                            startTime: now,
                            easing: animEasing,
                            duration: animDuration,
                        };
                    }
                } else {
                    const rtShift = newHorizonBar - oldHorizonBar;
                    const baseTMin = anim?.targetTMin ?? p.viewRef.current.tMin;
                    const baseTMax = anim?.targetTMax ?? p.viewRef.current.tMax;
                    const targetTMin = baseTMin + rtShift;
                    const targetTMax = baseTMax + rtShift;
                    if (easing === 'none') {
                        p.viewRef.current.tMin = targetTMin;
                        p.viewRef.current.tMax = targetTMax;
                        horizonScrollAnimRef.current = null;
                    } else {
                        horizonScrollAnimRef.current = {
                            startTMin: p.viewRef.current.tMin,
                            startTMax: p.viewRef.current.tMax,
                            targetTMin,
                            targetTMax,
                            startTime: now,
                            easing: animEasing,
                            duration: animDuration,
                        };
                    }
                }
                if (horizonScrollAnimRef.current && horizonScrollRafRef.current === null) {
                    horizonScrollRafRef.current = requestAnimationFrame(driveHorizonScrollAnim);
                }
            }
        }
    }, []);

    const applyHorizon = useCallback((horizon: bigint, triggerResample = true, hotPath = false) => {
        const cb = compactBufRef.current;
        const newIdx = findFloorIndex(cb, horizon);
        const prevIdx = playheadIdxRef.current;
        const barNs = p.activeTimeframeRef.current.barNs;
        // tick has no event buffer, so its index never moves and a step back looked like a step forward
        const tick = dataLevelRef.current === 'tick';
        const isForward = tick ? horizon >= tickHorizonRef.current : newIdx >= prevIdx;
        if (tick) tickHorizonRef.current = horizon;

        followHorizonBar(horizon);
        p.onHorizonUpdate(horizon);
        // Let the status bar recompute if the cursor is parked on/right of the
        // forming bar - there's no mouse movement to drive status:compute there.
        p.eventBus.emit('status:refresh', undefined);
        {
            const s = getSessionStatus(p.resolvedSessionRef.current, horizon);
            const prev = prevSessionStatusRef.current;
            if (
                !prev ||
                prev.kind !== s.kind ||
                (s.kind === 'sub' &&
                    prev.kind === 'sub' &&
                    (prev as any).label !== (s as any).label)
            ) {
                prevSessionStatusRef.current = s;
                p.eventBus.emit('session:status', { ...s, symbol: cellSymbolRef.current });
            }
        }

        if (!isForward) {
            resetPlayhead(newIdx);
            if (barNs > 0n && newIdx >= 0) {
                const currentBarTs = (horizon / barNs) * barNs;
                openBarTsRef.current = currentBarTs;
                let barStartIdx = 0;
                for (let i = newIdx; i >= 0; i--) {
                    if ((getTsNs(cb, i) / barNs) * barNs < currentBarTs) {
                        barStartIdx = i + 1;
                        break;
                    }
                }
                for (let i = barStartIdx; i <= newIdx; i++) {
                    const ev = getEvent(cb, i);
                    if (ev.action !== 'T' || ev.price === null || ev.side === 'N') continue;
                    if (!openBarRef.current) {
                        openBarRef.current = {
                            ts: currentBarTs,
                            open: ev.price,
                            high: ev.price,
                            low: ev.price,
                            close: ev.price,
                            totalVol: 0,
                            totalDelta: 0,
                            maxLevelVol: 0,
                            maxAbsDelta: 0,
                            levels: [],
                            isBullish: true,
                            poc: ev.price,
                            stackedBuyZones: [],
                            stackedSellZones: [],
                            unfinishedTop: false,
                            unfinishedBottom: false,
                            absorptionCount: 0,
                            diagDominant: 'none',
                        };
                    }
                    const bar = openBarRef.current;
                    if (ev.price > bar.high) bar.high = ev.price;
                    if (ev.price < bar.low) bar.low = ev.price;
                    bar.close = ev.price;
                    bar.totalVol += ev.size;
                    if (ev.side === 'B') bar.totalDelta += ev.size;
                    else bar.totalDelta -= ev.size;
                    openBarTradeCountRef.current++;
                }
                if (openBarRef.current) rebuildOpenBarLevels(newIdx, barNs);
            }
            syncOhlcvOpenBar(horizon);
            rebuildFootprints(horizon);
            updatePriceHistoryToRawIdx(findPriceHistoryIdx(horizon));
            const slicedTradesBack = getTradesUpToHorizon(horizon);
            rebuildCandleCache(slicedTradesBack, barNs);
            lastHorizonForIndicatorsRef.current = horizon;
            runIndicatorWorker(slicedTradesBack, barNs);
            p.autofitIndicatorPanesRef.current();
            mergeOpenBar();
            if (p.viewRef.current && p.isYAxisAutoRef.current)
                autoFitPriceAxis(
                    p.viewRef.current,
                    priceHistoryRef.current,
                    tradesRef.current,
                    dataLevelRef.current === 'ohlcv'
                        ? ohlcvBarsRef.current.display
                        : previewBarsRef.current,
                    openBarRef.current,
                    p.chartSettingsRef.current,
                    p.horizonRef.current,
                    dataLevelRef.current,
                );
            if (triggerResample) scheduleResample();
            p.pushDrawParamsRef.current();
            p.renderEngineRef.current?.markDirty('base');
            p.renderEngineRef.current?.markDirty('ui');
            p.renderEngineRef.current?.markDirty('drawings');
            p.updateSettingsBarPosRef.current(p.selectedDrawingIdRef.current);
            return;
        }

        playheadIdxRef.current = newIdx;
        if (barNs > 0n) {
            if (tick) extendFootprints(footprintBarsRef.current, allTradesRef.current, barNs, horizon, fpSettingsFromRef());
            else foldEventsIntoOpenBar(prevIdx, newIdx, barNs, horizon);
            syncOhlcvOpenBar(horizon);
            mergeOpenBar();
        }
        updatePriceHistoryToRawIdx(findPriceHistoryIdx(horizon));
        if (p.viewRef.current && p.isYAxisAutoRef.current)
            autoFitPriceAxis(
                p.viewRef.current,
                priceHistoryRef.current,
                tradesRef.current,
                dataLevelRef.current === 'ohlcv'
                    ? ohlcvBarsRef.current.display
                    : previewBarsRef.current,
                openBarRef.current,
                p.chartSettingsRef.current,
                p.horizonRef.current,
                dataLevelRef.current,
            );

        if (hotPath) {
            if (tick && barNs > 0n && candleCacheRef.current) {
                extendCandles(candleCacheRef.current, candleSrc(allTradesRef.current), barNs, horizon);
            } else if (barNs > 0n && candleCacheRef.current && newIdx > prevIdx) {
                const prevTs = prevIdx >= 0 ? getTsNs(cb, prevIdx) : 0n;
                foldTrades(candleCacheRef.current, candleSrc(allTradesRef.current), barNs, prevTs, horizon);
            }
            runHorizonAdvance(horizon);
            p.pushDrawParamsRef.current();
            p.renderEngineRef.current?.markDirty('base');
            p.renderEngineRef.current?.markDirty('drawings');
            return;
        }

        const slicedTrades = getTradesUpToHorizon(horizon);
        rebuildCandleCache(slicedTrades, barNs);
        lastHorizonForIndicatorsRef.current = horizon;
        runIndicatorWorker(slicedTrades, barNs);
        p.autofitIndicatorPanesRef.current();
        if (triggerResample) scheduleResample();
        p.pushDrawParamsRef.current();
        p.renderEngineRef.current?.markDirty('base');
        p.renderEngineRef.current?.markDirty('ui');
        p.renderEngineRef.current?.markDirty('drawings');
        p.updateSettingsBarPosRef.current(p.selectedDrawingIdRef.current);
    }, []);

    /**
     * Slide the view onto `target`, keeping the zoom and the playhead's place on
     * screen. For explicit navigation (Go to, a step that overshoots the edge) -
     * playback's own follow deliberately won't do this, because it only moves the
     * view while the playhead is already framed, so that panning away to read
     * history isn't constantly undone.
     *
     * Shifts in market time where the symbol has sessions, so jumping across a
     * weekend keeps the same number of *bars* on screen instead of framing two
     * days of closed market.
     */
    const recenterViewOnHorizon = useCallback((target: bigint) => {
        const view = p.viewRef.current;
        if (!view) return;

        const barNs = p.activeTimeframeRef.current.barNs;
        const targetBar = (target / barNs) * barNs;
        // Already framed - a short step doesn't need the view yanked, and this
        // keeps repeated small jumps from feeling jittery.
        if (targetBar > view.tMin && targetBar < view.tMax) return;

        // An in-flight follow animation is aiming at the pre-jump view; let it go.
        horizonScrollAnimRef.current = null;

        const sm = p.sessionMapperRef.current;
        const prevBar = prevHorizonBarRef.current;

        if (sm.hasSession) {
            const mMin = sm.tsToMarket(view.tMin);
            const mMax = sm.tsToMarket(view.tMax);
            const mPrev = sm.tsToMarket(prevBar);
            const span = mMax - mMin;
            // Put the playhead back where the user had it. If it wasn't on screen
            // (they'd panned off to look at something else), park it where a fresh
            // load would: near the right edge with a small lead.
            const lead = mPrev > mMin && mPrev < mMax ? mMax - mPrev : span / 8n;
            const mTarget = sm.tsToMarket(targetBar);
            view.tMin = sm.marketToTs(mTarget + lead - span);
            view.tMax = sm.marketToTs(mTarget + lead);
        } else {
            const span = view.tMax - view.tMin;
            const lead =
                prevBar > view.tMin && prevBar < view.tMax ? view.tMax - prevBar : span / 8n;
            view.tMin = targetBar + lead - span;
            view.tMax = targetBar + lead;
        }

        p.transformer.update(view);
        p.renderEngineRef.current?.setView(view);
        // An OHLCV chart's price action lives in ohlcvBarsRef, not in the preview
        // bars - those are cleared on every load. Passing only the preview here
        // meant the fit found nothing to fit and returned, so a Go to moved the
        // view sideways and left the price axis wherever it was: the chart lands
        // on the right time with the candles far off screen.
        autoFitPriceAxis(
            view,
            priceHistoryRef.current,
            tradesRef.current,
            dataLevelRef.current === 'ohlcv'
                ? ohlcvBarsRef.current.display
                : previewBarsRef.current,
            openBarRef.current,
            p.chartSettingsRef.current,
            p.horizonRef.current,
            dataLevelRef.current,
        );
        // The visible window moved wholesale, so anything computed over it
        // (visible-range VP, scripted indicators, the heatmap resample) is stale
        // - same as after a pan, which is the closest thing to what just
        // happened. Debounced, so a burst of steps only pays once.
        scheduleResample();

        p.renderEngineRef.current.markAllDirty();
    }, []);

    /**
     * Frames a span of time, without touching the playhead.
     *
     * Sibling of recenterViewOnHorizon, and deliberately not the same function:
     * that one follows the playhead and bails when the target is already on
     * screen, because a replay stepping forward should not yank the view. This
     * one is a command - someone clicked a trade and asked to see it - so it
     * always moves, and it frames the whole span rather than centring a point.
     */
    const gotoRange = useCallback((fromNs: bigint, toNs?: bigint, padding = 0.25) => {
        const view = p.viewRef.current;
        if (!view || !p.renderEngineRef.current) return;

        const barNs = p.activeTimeframeRef.current.barNs;
        const from = fromNs < (toNs ?? fromNs) ? fromNs : (toNs ?? fromNs);
        const to = fromNs < (toNs ?? fromNs) ? (toNs ?? fromNs) : fromNs;

        // A single moment, or a span so short it would zoom to one candle, keeps
        // the zoom level the caller was already at and just recentres. Fitting
        // literally to a one-bar trade leaves the user staring at a single wick
        // with no context, which is never what "show me this trade" meant.
        const span = to - from;
        const currentSpan = view.tMax - view.tMin;
        const minSpan = barNs * 20n;

        let tMin: bigint;
        let tMax: bigint;

        if (span < minSpan) {
            const mid = from + span / 2n;
            const half = (currentSpan > minSpan ? currentSpan : minSpan) / 2n;
            tMin = mid - half;
            tMax = mid + half;
        } else {
            const padNs = BigInt(Math.round(Number(span) * Math.max(0, padding)));
            tMin = from - padNs;
            tMax = to + padNs;
        }

        // an in-flight follow animation is aiming somewhere else entirely
        horizonScrollAnimRef.current = null;

        view.tMin = tMin;
        view.tMax = tMax;

        p.transformer.update(view);
        p.renderEngineRef.current.setView(view);

        autoFitPriceAxis(
            view,
            priceHistoryRef.current,
            tradesRef.current,
            dataLevelRef.current === 'ohlcv'
                ? ohlcvBarsRef.current.display
                : previewBarsRef.current,
            openBarRef.current,
            p.chartSettingsRef.current,
            p.horizonRef.current,
            dataLevelRef.current,
        );

        // the visible window moved wholesale - same staleness as a pan
        scheduleResample();
        p.renderEngineRef.current.markAllDirty();
    }, []);

    const seekHorizon = useCallback(
        (newHorizon: bigint, triggerResample = true, hotPath = false, recenter = false) => {
            const dataEnd = datasetEndRef.current;
            if (dataEnd === 0n) return;
            const clamped = newHorizon <= dataEnd ? newHorizon : dataEnd;
            // Before applyHorizon, which is what advances prevHorizonBarRef - the
            // recenter reads it to find where the playhead was sitting.
            if (recenter) recenterViewOnHorizon(clamped);
            p.horizonRef.current = clamped;
            applyHorizon(clamped, triggerResample, hotPath);
        },
        [],
    );

    // Worker startup
    useEffect(() => {
        if (dataLoadedRef.current) return;
        dataLoadedRef.current = true;
        workerRef.current = new Worker(new URL('../lib/heatmap.worker.ts', import.meta.url));
        heatmapSentRef.current = null;
        workerRef.current.onmessage = onWorkerMessage;
        const worker = workerRef.current;
        heatmapTilesRef.current = new HeatmapTiles(
            (req) => worker.postMessage(req),
            () => p.renderEngineRef.current?.markDirty('base'),
            (recalculating) => p.eventBus.emit('heatmap:status', { recalculating, cellId: p.cellId }),
        );
        indicatorWorkerRef.current = new Worker(
            new URL('../lib/indicator-worker.ts', import.meta.url),
        );
        indicatorWorkerRef.current.onmessage = onIndicatorWorkerMessage;
        return () => {
            workerRef.current?.terminate();
            indicatorWorkerRef.current?.terminate();
            // Clear the guard so a remount rebuilds the workers. React
            // StrictMode mounts, unmounts and remounts in development; refs
            // survive that cycle, so leaving the guard set would leave the
            // second mount holding terminated workers and the chart stuck
            // forever on "Getting market data...".
            workerRef.current = null;
            heatmapTilesRef.current?.clear();
            heatmapTilesRef.current = null;
            indicatorWorkerRef.current = null;
            dataLoadedRef.current = false;
        };
    }, []);

    // Data event subscriptions
    useEffect(() => {
        const cellSymbol = p.cellSymbol;
        const unsubs = [
            p.eventBus.on('playback:play', () => (isPlayingRef.current = true)),
            p.eventBus.on('playback:pause', () => (isPlayingRef.current = false)),
            p.eventBus.on('data:load', (payload) => {
                if (payload.symbol !== cellSymbol) return;
                previewBarsRef.current = new BarStore();
                ohlcvBarsRef.current.bars = new BarStore();
                ohlcvBarsRef.current.display = new BarStore();
                p.pushDrawParamsRef.current();
                ingestLoadedData(payload as any);
            }),
            p.eventBus.on('data:append', (payload) => {
                if (payload.symbol !== cellSymbol) return;
                previewBarsRef.current = new BarStore();
                p.pushDrawParamsRef.current();
                ingestAppendedData(payload as any);
            }),
            p.eventBus.on('data:prepend', (payload) => {
                if (payload.symbol !== cellSymbol) return;
                previewBarsRef.current = new BarStore();
                ingestPrependedData(payload as any);
            }),
            p.eventBus.on('data:preview', (payload) => {
                if (payload.symbol !== cellSymbol) return;
                previewBarsRef.current = BarStore.from(payload.bars);
                if (p.isYAxisAutoRef.current)
                    autoFitPriceAxis(
                        p.viewRef.current!,
                        priceHistoryRef.current,
                        tradesRef.current,
                        previewBarsRef.current,
                        openBarRef.current,
                        p.chartSettingsRef.current,
                        p.horizonRef.current,
                        dataLevelRef.current,
                    );
                p.pushDrawParamsRef.current();
                p.renderEngineRef.current?.markDirty('base');
                runIndicatorWorker(
                    getTradesUpToHorizon(p.horizonRef.current),
                    p.activeTimeframeRef.current.barNs,
                );
            }),
            p.eventBus.on('data:symbol-resolved', ({ symbolInfo }) => {
                if (symbolInfo.symbol !== cellSymbol) return;
                p.resolvedSymbolInfoRef.current = symbolInfo ?? null;
                p.resolvedSessionRef.current = symbolInfo.session ?? null;
                // Mirror the resolved exchange onto the pane for the legend
                // display (same denormalization as symbol / tf).
                p.setPanes((prev) =>
                    prev.map((pane) =>
                        pane.isMain ? { ...pane, exchange: symbolInfo.exchange } : pane,
                    ),
                );
                p.onSymbolResolvedRef.current(symbolInfo);
            }),
        ];
        // This pane may have mounted after its symbol already resolved, in which
        // case the one-shot data:symbol-resolved above is never seen and the
        // legend's exchange stays undefined until the next symbol switch. The
        // engine answers from its resolved-symbol cache, synchronously, into the
        // handler just registered.
        p.eventBus.emit('data:request-symbol-resolved', { symbol: cellSymbol });
        return () => unsubs.forEach((fn) => fn());
    }, [p.eventBus, p.cellSymbol]);

    // Return
    return {
        compactBufRef,
        allTradesRef,
        tradesRef,
        priceHistoryRef,
        allPriceHistoryRef,
        footprintBarsRef,
        ohlcvBarsRef,
        previewBarsRef,
        openBarRef,
        openBarTsRef,
        openBarTradeCountRef,
        phCursorRef,
        playheadIdxRef,
        isPlayingRef,
        dataLevelRef,
        datasetStartRef,
        datasetEndRef,
        prevSessionStatusRef,
        candleCacheRef,
        supplementalBarsRef,
        heatmapTilesRef,
        prevHorizonBarRef,
        lastBarAdvanceTimeRef,
        horizonScrollAnimRef,
        workerRef,
        indicatorWorkerRef,
        seekHorizon,
        gotoRange,
        applyHorizon,
        scheduleResample,
        runIndicatorWorker,
        getTradesUpToHorizon,
        rebuildFootprints,
        syncOhlcvOpenBar,
        rebuildCandleCache,
        foldEventsIntoOpenBar,
        mergeOpenBar,
        resetPlayhead,
        fpSettingsFromRef,
        runHorizonAdvance,
        updatePriceHistoryToRawIdx,
        findPriceHistoryIdx,
    };
}
