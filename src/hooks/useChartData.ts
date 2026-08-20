import { useCallback, useEffect, useRef, type MutableRefObject, type RefObject } from 'react';
import { isoToNs } from '../lib/sampler';
import { applyEvent, createBook } from '../lib/book';
import { type BookState } from '../lib/types';
import { type PriceHistory, type TradePoint, type ViewBounds, type OhlcvBarMs } from '../lib/types';
import { type FootprintBar } from '../lib/types/footprint';
import {
    type CompactBuffer,
    createCompactBuffer,
    findFloorIndex,
    getTsNs,
    getEvent,
} from '../lib/compact-buffer';
import {
    sliceToMboEventsAsync,
    deserializePriceHistoryFromBuf,
    deserializeOhlcvCacheFromBuf,
} from '../lib/slice-worker-client';
import { type SerialTrade } from '../lib/types';
import { SymbolInfo, type TickEvent } from '../interfaces/IDataAdapter';
import { type DataLevel, type TradingSession } from '../interfaces/IDataAdapter';
import { type LiveTransformer } from '../interfaces/ICoordinateTransformer';
import { type DomPanelHandle } from '../lib/types';
import { type Indicator, type ChartPane, type Rect } from '../lib/types/indicator-types';
import { type Timeframe } from '../lib/timeframes';
import { type ChartSettings } from '../lib/types/chart-settings';
import { type TypedEventBus } from '../core/TypedEventBus';
import { type RenderEngine } from '../core/RenderEngine';
import { type SessionMapper } from '../core/SessionMapper';
import { ohlcvBucketRange } from '../lib/bar-grid';
import { getSessionStatus, type SessionStatus } from '../core/SessionUtils';
import { type HeatmapRequest } from '../lib/types/heatmap-types';
import { serializeBounds } from '../lib/types/heatmap-types';
import { applyHeatmapContrast } from '../lib/renderers/renderer';
import { X_AXIS_HEIGHT } from '../lib/renderers/renderer';
import { nanoid } from 'nanoid';

// Local types
// Pure utility functions
export { ohlcvBucketRange };

export function aggregateOhlcvBars(
    bars: OhlcvBarMs[],
    targetBarNs: bigint,
    sessionMapper?: SessionMapper | null,
): OhlcvBarMs[] {
    if (bars.length === 0 || targetBarNs <= 0n) return bars;
    const barMs = Number(targetBarNs / 1_000_000n);
    if (barMs <= 0) return bars;

    // ohlcvBucketRange's rule, in ms and without the per-bar BigInt: bars arrive
    // time-ordered, so the containing session segment only has to be looked up
    // when one is left behind. Deliberately the same arithmetic - anchor to the
    // session open, step barMs, restart each session - because this must land on
    // the exact columns the renderer draws.
    //
    // It used to bucket in MARKET time, whose origin is wherever the session
    // mapper's range happens to start. At 2h+ that put boundaries both off the
    // drawn columns and on the move: panning back prepends history, which shifts
    // the origin, which re-buckets every bar on the chart.
    const useSession = !!sessionMapper?.hasSession;
    let segStartMs = 0;
    let segEndMs = 0;
    let haveSeg = false;

    const getBucket = (timeMs: number): number => {
        if (useSession) {
            if (!haveSeg || timeMs < segStartMs || timeMs >= segEndMs) {
                const seg = sessionMapper!.segmentAt(BigInt(timeMs) * 1_000_000n);
                haveSeg = seg !== null;
                if (seg) {
                    segStartMs = Number(seg.realStart / 1_000_000n);
                    segEndMs = Number(seg.realEnd / 1_000_000n);
                }
            }
            // Closed window (a stray bar outside session hours): epoch-aligned,
            // matching the renderer's own fallback.
            if (haveSeg) return segStartMs + Math.floor((timeMs - segStartMs) / barMs) * barMs;
        }
        return Math.floor(timeMs / barMs) * barMs;
    };

    const result: OhlcvBarMs[] = [];
    let currentBucket = getBucket(bars[0].time);
    let o = bars[0].open,
        h = bars[0].high,
        l = bars[0].low,
        c = bars[0].close,
        v = bars[0].volume;

    for (let i = 1; i < bars.length; i++) {
        const bar = bars[i];
        const bucket = getBucket(bar.time);
        if (bucket !== currentBucket) {
            result.push({
                time: currentBucket,
                open: o,
                high: h,
                low: l,
                close: c,
                volume: v,
            });
            currentBucket = bucket;
            o = bar.open;
            h = bar.high;
            l = bar.low;
            c = bar.close;
            v = bar.volume;
        } else {
            if (bar.high > h) h = bar.high;
            if (bar.low < l) l = bar.low;
            c = bar.close;
            v += bar.volume;
        }
    }
    result.push({
        time: currentBucket,
        open: o,
        high: h,
        low: l,
        close: c,
        volume: v,
    });
    return result;
}

/**
 * Incrementally prepend newly fetched bars to an existing aggregated display array.
 * O(new_bars) instead of O(total_bars) - only re-aggregates the new chunk.
 * Handles the boundary bucket that might straddle the old/new data boundary.
 */
export function prependAggregatedOhlcvBars(
    newBars: OhlcvBarMs[],
    existingDisplay: OhlcvBarMs[],
    targetBarNs: bigint,
    sessionMapper?: SessionMapper | null,
): OhlcvBarMs[] {
    if (newBars.length === 0) return existingDisplay;
    const newDisplay = aggregateOhlcvBars(newBars, targetBarNs, sessionMapper);
    if (newDisplay.length === 0) return existingDisplay;
    if (existingDisplay.length === 0) return newDisplay;

    // If the last new bucket and the first existing bucket share the same time,
    // they represent the same bar - merge them.
    const lastNew = newDisplay[newDisplay.length - 1];
    const firstExisting = existingDisplay[0];
    if (lastNew.time === firstExisting.time) {
        const merged: OhlcvBarMs = {
            time: lastNew.time,
            open: lastNew.open,
            high: Math.max(lastNew.high, firstExisting.high),
            low: Math.min(lastNew.low, firstExisting.low),
            close: firstExisting.close,
            volume: lastNew.volume + firstExisting.volume,
        };
        return [...newDisplay.slice(0, -1), merged, ...existingDisplay.slice(1)];
    }

    return [...newDisplay, ...existingDisplay];
}

export function autoFitPriceAxis(
    view: ViewBounds,
    priceHistory: PriceHistory[],
    trades: TradePoint[],
    bars: OhlcvBarMs[],
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

    // Binary search helpers for the sorted bars array.
    const barsStartIdx = (() => {
        let blo = 0,
            bhi = bars.length - 1;
        while (blo <= bhi) {
            const mid = (blo + bhi) >>> 1;
            if (bars[mid].time < tMinMs) blo = mid + 1;
            else bhi = mid - 1;
        }
        return blo;
    })();

    if (
        settings.chartType === 'area' ||
        settings.chartType === 'line' ||
        settings.chartType === 'step' ||
        settings.chartType === 'baseline'
    ) {
        if (dataLevel === 'l3') {
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
            for (let i = barsStartIdx; i < bars.length; i++) {
                const bar = bars[i];
                if (bar.time >= tMaxMs) break;
                if (bar.time >= scanEndMs) break;
                if (bar.high > hi) hi = bar.high;
                if (bar.low < lo) lo = bar.low;
                if (!found) {
                    view.pRef = bar.high;
                    found = true;
                }
            }
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
        if (dataLevel === 'l3') {
            for (const t of trades) {
                if (t.ts > horizon || t.ts < view.tMin || t.ts >= view.tMax) continue;
                if (t.price > hi) hi = t.price;
                if (t.price < lo) lo = t.price;
                if (!found) {
                    view.pRef = t.price;
                    found = true;
                }
            }
        }
        for (let i = barsStartIdx; i < bars.length; i++) {
            const bar = bars[i];
            if (bar.time >= tMaxMs) break;
            if (bar.time >= scanEndMs) break;
            if (bar.high > hi) hi = bar.high;
            if (bar.low < lo) lo = bar.low;
            if (!found) {
                view.pRef = bar.high;
                found = true;
            }
        }
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
    doBaseRedrawRef: MutableRefObject<() => void>;
    // Direct callbacks
    setIndicators: (inds: Indicator[]) => void;
    setPanes: (updater: ((prev: ChartPane[]) => ChartPane[]) | ChartPane[]) => void;
    getPanel: () => DomPanelHandle | null;
    onDataBoundsChange?: (start: bigint, end: bigint) => void;
    onHorizonUpdate: (h: bigint) => void;
    cellSymbol: string;
    /** Which cell this is, for events that are this pane's own business. */
    cellId: number;
    managed?: boolean;
    externalDomPanelRef?: MutableRefObject<DomPanelHandle | null>;
    hidePriceScale: boolean;
    hideTimeScale: boolean;
    /** The loaded symbol serves a different data level than the last one did. */
    onDataLevelChangeRef: MutableRefObject<() => void>;
}

export interface ChartDataResult {
    // Core data refs
    compactBufRef: MutableRefObject<CompactBuffer>;
    allTradesRef: MutableRefObject<TradePoint[]>;
    tradesRef: MutableRefObject<TradePoint[]>;
    priceHistoryRef: MutableRefObject<PriceHistory[]>;
    allPriceHistoryRef: MutableRefObject<PriceHistory[]>;
    footprintBarsRef: MutableRefObject<FootprintBar[]>;
    ohlcvBarsRef: MutableRefObject<{ barNs: bigint; bars: OhlcvBarMs[]; display: OhlcvBarMs[] }>;
    previewBarsRef: MutableRefObject<OhlcvBarMs[]>;
    openBarRef: MutableRefObject<FootprintBar | null>;
    openBarTsRef: MutableRefObject<bigint>;
    openBarTradeCountRef: MutableRefObject<number>;
    phCursorRef: MutableRefObject<number>;
    playheadIdxRef: MutableRefObject<number>;
    replayedUpToRef: MutableRefObject<number>;
    dataLevelRef: MutableRefObject<DataLevel | null>;
    datasetStartRef: MutableRefObject<bigint>;
    datasetEndRef: MutableRefObject<bigint>;
    prevSessionStatusRef: MutableRefObject<SessionStatus | null>;
    candleCacheRef: MutableRefObject<Map<
        bigint,
        { open: number; high: number; low: number; close: number; volume: number; delta: number }
    > | null>;
    supplementalBarsRef: MutableRefObject<any>;
    serialisedTradesBufRef: MutableRefObject<ArrayBuffer | null>;
    serialisedPhBufRef: MutableRefObject<ArrayBuffer | null>;
    serialisedOhlcvBufRef: MutableRefObject<ArrayBuffer | null>;
    fpRebuildSeqRef: MutableRefObject<number>;
    rawBitmapRef: MutableRefObject<ImageBitmap | null>;
    heatmapBitmapRef: MutableRefObject<ImageBitmap | null>;
    heatmapBitmapOffsetsRef: MutableRefObject<{
        x: number;
        y: number;
        w: number;
        h: number;
    } | null>;
    cacheBoundsRef: MutableRefObject<ViewBounds | null>;
    liveBookRef: MutableRefObject<BookState>;
    prevHorizonBarRef: MutableRefObject<bigint>;
    lastBarAdvanceTimeRef: MutableRefObject<number>;
    horizonScrollAnimRef: MutableRefObject<any>;
    // Worker refs (needed by ChartInner for worker-related logic)
    workerRef: MutableRefObject<Worker | null>;
    dataWorkerRef: MutableRefObject<Worker | null>;
    indicatorWorkerRef: MutableRefObject<Worker | null>;
    workerReadyRef: MutableRefObject<boolean>;
    workerRequestIdRef: MutableRefObject<number>;
    // Internal panel ref
    _internalDomPanelRef: MutableRefObject<DomPanelHandle | null>;
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
    requestFootprintRebuild: () => void;
    syncOhlcvOpenBar: (horizon: bigint) => void;
    rebuildCandleCache: (trades: TradePoint[], barNs: bigint) => void;
    rebuildContrastBitmap: (contrast: number) => void;
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
    cancelAndRestartWorker: () => void;
    runHorizonAdvance: (horizon: bigint) => void;
    updatePriceHistoryToRawIdx: (rawIdx: number) => void;
    findPriceHistoryIdx: (horizon: bigint) => number;
    loadData: () => void;
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
    const tradesRef = useRef<TradePoint[]>([]);
    const priceHistoryRef = useRef<PriceHistory[]>([]);
    const allPriceHistoryRef = useRef<PriceHistory[]>([]);
    const footprintBarsRef = useRef<FootprintBar[]>([]);
    const ohlcvBarsRef = useRef<{ barNs: bigint; bars: OhlcvBarMs[]; display: OhlcvBarMs[] }>({
        barNs: 0n,
        bars: [],
        display: [],
    });
    const previewBarsRef = useRef<OhlcvBarMs[]>([]);
    const openBarRef = useRef<FootprintBar | null>(null);
    const openBarTsRef = useRef<bigint>(0n);
    const openBarTradeCountRef = useRef<number>(0);
    const phCursorRef = useRef<number>(-1);
    const playheadIdxRef = useRef<number>(-1);
    const replayedUpToRef = useRef<number>(-1);
    const dataLevelRef = useRef<DataLevel | null>(null);
    const datasetStartRef = useRef<bigint>(0n);
    const datasetEndRef = useRef<bigint>(0n);
    const prevSessionStatusRef = useRef<SessionStatus | null>(null);
    const candleCacheRef = useRef<Map<
        bigint,
        { open: number; high: number; low: number; close: number; volume: number; delta: number }
    > | null>(null);
    const supplementalBarsRef = useRef<any>(null);
    const serialisedTradesBufRef = useRef<ArrayBuffer | null>(null);
    const serialisedPhBufRef = useRef<ArrayBuffer | null>(null);
    const serialisedOhlcvBufRef = useRef<ArrayBuffer | null>(null);
    const fpRebuildSeqRef = useRef(0);
    const rawBitmapRef = useRef<ImageBitmap | null>(null);
    const heatmapBitmapRef = useRef<ImageBitmap | null>(null);
    const heatmapBitmapOffsetsRef = useRef<{ x: number; y: number; w: number; h: number } | null>(
        null,
    );
    const cacheBoundsRef = useRef<ViewBounds | null>(null);
    const liveBookRef = useRef<BookState>(createBook());
    const prevHorizonBarRef = useRef(0n);
    const lastBarAdvanceTimeRef = useRef<number>(0);
    const horizonScrollAnimRef = useRef<any>(null);
    const lastHorizonForIndicatorsRef = useRef<bigint>(0n);
    const resampleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const _internalDomPanelRef = useRef<DomPanelHandle | null>(null);

    // Worker refs
    const workerRef = useRef<Worker | null>(null);
    const workerRequestIdRef = useRef(0);
    const workerReadyRef = useRef(false);
    const dataWorkerRef = useRef<Worker | null>(null);
    const indicatorWorkerRef = useRef<Worker | null>(null);
    const indicatorRequestIdRef = useRef(0);
    const dataLoadedRef = useRef(false);
    // Tracks whether playback is actively running. During playback the playback
    // engine owns the horizon, so appended (future) data must NOT yank it.
    const isPlayingRef = useRef(false);

    // Stable accessors
    const getPanel = useCallback(() => {
        return p.externalDomPanelRef?.current ?? _internalDomPanelRef.current;
    }, []);

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
        for (const t of trades) {
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

    const rebuildContrastBitmap = useCallback((contrast: number) => {
        const raw = rawBitmapRef.current;
        if (!raw) return;
        const imageData = applyHeatmapContrast(raw, raw.width, raw.height, contrast);
        const scratch = new OffscreenCanvas(raw.width, raw.height);
        const ctx = scratch.getContext('2d') as OffscreenCanvasRenderingContext2D;
        ctx.putImageData(imageData, 0, 0);
        heatmapBitmapRef.current?.close();
        heatmapBitmapRef.current = scratch.transferToImageBitmap();
        p.pushDrawParamsRef.current();
        p.renderEngineRef.current?.markDirty('base');
        p.renderEngineRef.current?.markDirty('drawings');
        p.updateSettingsBarPosRef.current(p.selectedDrawingIdRef.current);
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

    const requestFootprintRebuild = useCallback(() => {
        const cb = compactBufRef.current;
        const horizonIdx = playheadIdxRef.current;
        if (horizonIdx < 0 || !dataWorkerRef.current) return;
        const relevantLength = horizonIdx + 1;
        const copy = cb._buf.slice(0, relevantLength * 20);
        const seq = ++fpRebuildSeqRef.current;
        dataWorkerRef.current.postMessage(
            {
                event: 'rebuild_footprint',
                requestId: nanoid(),
                compactBuf: copy,
                barNs: p.activeTimeframeRef.current.barNs,
                fpSeq: seq,
                fpHorizonIdx: horizonIdx,
                fpOptions: fpSettingsFromRef(),
            },
            [copy],
        );
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
        bar.totalVol = 0;
        bar.totalDelta = 0;
        const levelMap = new Map<number, { bidVol: number; askVol: number }>();
        for (let i = startIdx; i <= toEvIdx; i++) {
            const ev = getEvent(cb, i);
            if (ev.action !== 'T' || ev.price === null || ev.side === 'N') continue;
            bar.totalVol += ev.size;
            if (ev.side === 'B') bar.totalDelta += ev.size;
            else bar.totalDelta -= ev.size;
            const entry = levelMap.get(ev.price) ?? { bidVol: 0, askVol: 0 };
            if (ev.side === 'B') entry.bidVol += ev.size;
            else entry.askVol += ev.size;
            levelMap.set(ev.price, entry);
        }
        let maxVol = 0,
            maxAbsDelta = 0;
        bar.levels = Array.from(levelMap.entries()).map(([price, { bidVol, askVol }]) => {
            const vol = bidVol + askVol;
            const delta = bidVol - askVol;
            if (vol > maxVol) maxVol = vol;
            if (Math.abs(delta) > maxAbsDelta) maxAbsDelta = Math.abs(delta);
            return {
                price,
                bidVol,
                askVol,
                delta,
                totalVol: vol,
                bidImbalance: false,
                askImbalance: false,
                diagAskImbalance: false,
                diagBidImbalance: false,
                absorption: false,
            };
        });
        bar.maxLevelVol = maxVol;
        bar.maxAbsDelta = maxAbsDelta;
        if (bar.levels.length > 0) {
            const pocLevel = bar.levels.reduce(
                (best, l) => (l.bidVol + l.askVol > best.bidVol + best.askVol ? l : best),
                bar.levels[0],
            );
            bar.poc = pocLevel.price;
        }
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
        replayedUpToRef.current = idx;
        openBarRef.current = null;
        openBarTsRef.current = 0n;
        openBarTradeCountRef.current = 0;
        phCursorRef.current = -1;
    }, []);

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
            // Last display bar strictly before this bucket. display is time-sorted, so
            // binary-search for the insertion point rather than filtering the whole array.
            const disp = ohlcvBarsRef.current.display;
            let flo = 0,
                fhi = disp.length - 1,
                prevIdx = -1;
            while (flo <= fhi) {
                const fmid = (flo + fhi) >>> 1;
                if (disp[fmid].time < barTimeMs) {
                    prevIdx = fmid;
                    flo = fmid + 1;
                } else fhi = fmid - 1;
            }
            const bar = prevIdx >= 0 ? disp[prevIdx] : undefined;
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
    const onWorkerMessage = (e: MessageEvent) => {
        const { bitmap, bounds, requestId } = e.data;
        if (requestId !== workerRequestIdRef.current) {
            bitmap.close();
            return;
        }
        rawBitmapRef.current?.close();
        rawBitmapRef.current = bitmap;
        cacheBoundsRef.current = {
            tMin: BigInt(bounds.tMin),
            tMax: BigInt(bounds.tMax),
            pMin: bounds.pMin,
            pMax: bounds.pMax,
        };
        rebuildContrastBitmap(p.chartSettingsRef.current.heatmapContrast);
        p.eventBus.emit('heatmap:status', { recalculating: false, cellId: p.cellId });
    };

    const cancelAndRestartWorker = useCallback(() => {
        workerRequestIdRef.current++;
    }, []);

    const runIndicatorWorker = useCallback((trades: SerialTrade[], barNs: bigint) => {
        const worker = indicatorWorkerRef.current;
        if (!worker) return;
        const SCRIPTED_SENTINEL = '__scripted__';

        const computable = p.indicatorsRef.current.filter(
            (ind) => ind.workerInit && ind.workerInit !== SCRIPTED_SENTINEL && ind.hydrate,
        );

        function toNs(ts: number | bigint): bigint {
            const t = typeof ts === 'bigint' ? ts : BigInt(ts);
            if (t < 1_000_000_000_000n) return t * 1_000_000_000n;
            else if (t < 1_000_000_000_000_000n) return t * 1_000_000n;
            else if (t < 1_000_000_000_000_000_000n) return t * 1_000n;
            else return t;
        }

        const ohlcv: any[] = [];
        if (dataLevelRef.current === 'l3') {
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

        // Scripted (plugin) indicators don't run in the shared indicator worker -
        // each owns its own script.worker and recomputes via this event, which
        // rebuilds its data from the current bars/horizon. (The old
        // `compute-scripted` postMessage was a no-op: the shared worker never
        // handled that type, so scripted indicators only ever computed once at
        // worker init - before data was loaded - and never drew.)
        for (const ind of p.indicatorsRef.current) {
            if (ind.workerInit === SCRIPTED_SENTINEL) {
                p.eventBus.emit('plugin:scripted-recompute' as any, { id: ind.id });
            }
        }

        if (computable.length > 0) {
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
        }
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
        if (dataLevelRef.current === 'l3') {
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
            if (!workerReadyRef.current || !p.chartSettingsRef.current.showHeatmap) return;
            const bitmapW = canvas.width - p.priceScaleWidthRef.current;
            const mainLayout = p.layoutsCacheRef.current['main'];
            const bitmapH = mainLayout
                ? mainLayout.h
                : canvas.height - (p.hideTimeScale ? 0 : X_AXIS_HEIGHT);
            if (bitmapW <= 0 || bitmapH <= 0) return;
            cancelAndRestartWorker();
            const requestId = ++workerRequestIdRef.current;
            const horizon = p.horizonRef.current;
            const msg: HeatmapRequest = {
                type: 'render',
                requestId,
                bounds: serializeBounds(view),
                chartW: bitmapW,
                chartH: bitmapH,
                horizonNs: horizon > 0n ? horizon.toString() : undefined,
            };
            p.eventBus.emit('heatmap:status', { recalculating: true, cellId: p.cellId });
            workerRef.current!.postMessage(msg);
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

    const loadData = () => {
        dataWorkerRef.current?.postMessage({
            requestId: nanoid(),
            event: 'load',
            barNs: p.activeTimeframeRef.current.barNs,
            horizon: p.horizonRef.current,
            fpOptions: fpSettingsFromRef(),
        });
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
            const ohlcvBars = payload.ohlcvBars ?? [];
            if (payload.session !== undefined) {
                p.resolvedSessionRef.current = payload.session;
            }
            compactBufRef.current = createCompactBuffer(0);
            allTradesRef.current = [];
            tradesRef.current = [];
            allPriceHistoryRef.current = [];
            priceHistoryRef.current = [];
            footprintBarsRef.current = [];
            candleCacheRef.current = null;
            const _activeTfBarNs = p.activeTimeframeRef.current.barNs;
            const _mappedOhlcvBars: OhlcvBarMs[] = ohlcvBars.map((bar: any) => ({
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
                volume: bar.volume,
                time: bar.time,
            }));
            ohlcvBarsRef.current = { barNs: _activeTfBarNs, bars: _mappedOhlcvBars, display: [] };
            const ds = BigInt(payload.dataStart) * 1_000_000n;
            const de = BigInt(payload.dataEnd) * 1_000_000n;
            datasetStartRef.current = ds;
            datasetEndRef.current = de;
            p.onDataBoundsChange?.(ds, de);
            const playFrom = payload.playFromIso ? isoToNs(payload.playFromIso) : de;
            p.horizonRef.current = playFrom;
            prevHorizonBarRef.current = playFrom;
            playheadIdxRef.current = 0;
            replayedUpToRef.current = 0;
            openBarRef.current = null;
            openBarTsRef.current = 0n;
            const PAD = 14n * 24n * 60n * 60n * 1_000_000_000n;
            p.sessionMapperRef.current.build(p.resolvedSessionRef.current, ds - PAD, de + PAD);
            ohlcvBarsRef.current.display = aggregateOhlcvBars(
                _mappedOhlcvBars,
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
            const timeSpan = 800_000_000_000n;
            const offset = 100_000_000_000n;
            p.viewRef.current = {
                ...(p.viewRef.current ?? { tMin: 0n, tMax: 0n, pMin: 0, pMax: 0, pRef: 0 }),
                tMin: de - timeSpan + offset,
                tMax: de + offset,
            };
            p.resetViewRef.current();
            p.transformer.update(p.viewRef.current);
            p.transformer.setSessionMapper(p.sessionMapperRef.current);
            p.transformer.setSession(p.resolvedSessionRef.current);
            p.renderEngineRef.current?.setView(p.viewRef.current);
            const _SCRIPTED = '__scripted__';
            const _keptInds = p.indicatorsRef.current.filter((i) => i.workerInit === _SCRIPTED);
            p.indicatorsRef.current = _keptInds;
            p.setIndicators(_keptInds);
            p.eventBus.emit('data:status', {
                status: 'ready',
                symbol: payload.symbol ?? cellSymbolRef.current,
            });
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
                barNs: workerBarNs,
                dataStart,
                dataEnd,
                session: payloadSession,
            } = payload;
            if (payloadSession !== undefined) p.resolvedSessionRef.current = payloadSession;
            compactBufRef.current = createCompactBuffer(0);
            compactBufRef.current._buf = inBuf as ArrayBuffer;
            compactBufRef.current._view = new DataView(inBuf as ArrayBuffer);
            compactBufRef.current.length = (inBuf as ArrayBuffer).byteLength / 20;
            compactBufRef.current.capacity = compactBufRef.current.length;
            compactBufRef.current.firstTs = BigInt(dataStart) * 1_000_000n;
            compactBufRef.current.lastTs = BigInt(dataEnd) * 1_000_000n;
            allTradesRef.current = newTrades;
            allPriceHistoryRef.current = newHistory;
            tradesRef.current = newTrades;
            openBarRef.current = null;
            phCursorRef.current = newHistory.length - 1;
            candleCacheRef.current = null;
            const activeTfBarNs = p.activeTimeframeRef.current.barNs;
            if (workerBarNs === activeTfBarNs) footprintBarsRef.current = newFpBars;
            else requestFootprintRebuild();
            const ds = BigInt(dataStart) * 1_000_000n;
            const de = BigInt(dataEnd) * 1_000_000n;
            datasetStartRef.current = ds;
            datasetEndRef.current = de;
            p.onDataBoundsChange?.(ds, de);
            const playFrom = payload.playFromIso ? isoToNs(payload.playFromIso) : de;
            const playFromIdx = findFloorIndex(compactBufRef.current, playFrom);
            playheadIdxRef.current = playFromIdx;
            replayedUpToRef.current = playFromIdx;
            openBarRef.current = null;
            openBarTsRef.current = 0n;
            openBarTradeCountRef.current = 0;
            p.horizonRef.current = playFrom;
            const liveBook = createBook();
            const cb = compactBufRef.current;
            for (let i = 0; i <= playFromIdx; i++) applyEvent(liveBook, getEvent(cb, i));
            liveBookRef.current = liveBook;
            getPanel()?.update(liveBook);
            const _SCRIPTED = '__scripted__';
            const _keptIndsL3 = p.indicatorsRef.current.filter((i) => i.workerInit === _SCRIPTED);
            p.indicatorsRef.current = _keptIndsL3;
            p.setIndicators(_keptIndsL3);
            const { ingestOhlcvBuf, ingestBucketedPhBuf, ingestTradesBuf, ingestPhBuf } = payload;
            serialisedTradesBufRef.current = ingestTradesBuf ?? null;
            serialisedPhBufRef.current = ingestPhBuf ?? null;
            serialisedOhlcvBufRef.current = ingestOhlcvBuf ?? null;
            candleCacheRef.current = null;
            priceHistoryRef.current = [];
            const PAD = 14n * 24n * 60n * 60n * 1_000_000_000n;
            p.sessionMapperRef.current.build(p.resolvedSessionRef.current, ds - PAD, de + PAD);
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
            const timeSpan = 800_000_000_000n;
            const offset = 100_000_000_000n;
            p.viewRef.current = {
                ...(p.viewRef.current ?? { tMin: 0n, tMax: 0n, pMin: 0, pMax: 0, pRef: 0 }),
                tMin: playFrom - timeSpan + offset,
                tMax: playFrom + offset,
            };
            p.transformer.update(p.viewRef.current);
            p.transformer.setSessionMapper(p.sessionMapperRef.current);
            p.transformer.setSession(p.resolvedSessionRef.current);
            p.renderEngineRef.current?.setView(p.viewRef.current);
            p.eventBus.emit('data:status', {
                status: 'ready',
                symbol: payload.symbol ?? cellSymbolRef.current,
            });
            if (_keptIndsL3.length > 0)
                runIndicatorWorker(getTradesUpToHorizon(playFrom), activeTfBarNs);
            if (ingestBucketedPhBuf) {
                priceHistoryRef.current = deserializePriceHistoryFromBuf(ingestBucketedPhBuf);
                autoFitPriceAxis(
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
            if (workerRef.current) {
                sliceToMboEventsAsync(
                    compactBufRef.current,
                    0,
                    compactBufRef.current.length,
                    'init',
                ).catch(() => {});
                workerReadyRef.current = true;
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
                const bars = ohlcvBarsRef.current.bars;
                const firstNewTime = newBars[0].time;
                // Drop trailing raw bars the chunk re-fetched (e.g. the forming bar
                // at the loaded edge), then append the new ones.
                while (bars.length && bars[bars.length - 1].time >= firstNewTime) bars.pop();
                for (const b of newBars) bars.push(b);
                ohlcvBarsRef.current.barNs = _appendTargetBarNs;
                const disp = ohlcvBarsRef.current.display;
                if (disp.length === 0) {
                    ohlcvBarsRef.current.display = aggregateOhlcvBars(
                        bars,
                        _appendTargetBarNs,
                        p.sessionMapperRef.current,
                    );
                } else {
                    const lastBucketTime = disp[disp.length - 1].time;
                    let ri = bars.length;
                    while (ri > 0 && bars[ri - 1].time >= lastBucketTime) ri--;
                    const tail = aggregateOhlcvBars(
                        bars.slice(ri),
                        _appendTargetBarNs,
                        p.sessionMapperRef.current,
                    );
                    disp.pop();
                    for (const d of tail) disp.push(d);
                }
            }
            // Only jump the horizon to the new edge when we're idle AND already
            // sitting at the live edge (live-follow). During playback the engine
            // owns the horizon; appended data is future data and must not yank it
            // - that yank is what snapped whole batches onto the chart.
            const followLive = !isPlayingRef.current && p.horizonRef.current >= oldEnd;
            const effHorizon = followLive ? de : p.horizonRef.current;
            p.horizonRef.current = effHorizon;
            prevHorizonBarRef.current = effHorizon;
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
                barNs: workerBarNs,
                dataEnd,
            } = payload;
            const ownBuf = (inBuf as ArrayBuffer).slice(0);
            const cb = createCompactBuffer(0);
            cb._buf = ownBuf;
            cb._view = new DataView(ownBuf);
            cb.length = ownBuf.byteLength / 20;
            cb.capacity = cb.length;
            cb.firstTs = datasetStartRef.current;
            cb.lastTs = BigInt(dataEnd) * 1_000_000n;
            compactBufRef.current = cb;
            allTradesRef.current = newTrades;
            allPriceHistoryRef.current = newHistory;
            tradesRef.current = newTrades;
            const activeTfBarNs = p.activeTimeframeRef.current.barNs;
            if (workerBarNs === activeTfBarNs) footprintBarsRef.current = newFpBars;
            else requestFootprintRebuild();
            const de = BigInt(dataEnd) * 1_000_000n;
            const oldEnd = datasetEndRef.current;
            datasetEndRef.current = de;
            // See OHLCV path above: only follow the edge when idle at the live
            // edge; during playback keep the playback-owned horizon so future
            // data doesn't snap onto the chart.
            const followLive = !isPlayingRef.current && p.horizonRef.current >= oldEnd;
            const effHorizon = followLive ? de : p.horizonRef.current;
            const newPlayFromIdx = findFloorIndex(compactBufRef.current, effHorizon);
            playheadIdxRef.current = newPlayFromIdx;
            replayedUpToRef.current = newPlayFromIdx;
            p.horizonRef.current = effHorizon;
            const {
                ingestOhlcvBuf: appendOhlcvBuf,
                ingestBucketedPhBuf: appendBucketedPhBuf,
                ingestTradesBuf: appendTradesBuf,
                ingestPhBuf: appendPhBuf,
            } = payload;
            serialisedTradesBufRef.current = appendTradesBuf ?? null;
            serialisedPhBufRef.current = appendPhBuf ?? null;
            serialisedOhlcvBufRef.current = appendOhlcvBuf ?? null;
            if (appendBucketedPhBuf)
                priceHistoryRef.current = deserializePriceHistoryFromBuf(appendBucketedPhBuf);
            if (appendOhlcvBuf)
                candleCacheRef.current = deserializeOhlcvCacheFromBuf(
                    appendOhlcvBuf,
                    p.horizonRef.current,
                );
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
            if (workerRef.current)
                sliceToMboEventsAsync(
                    compactBufRef.current,
                    0,
                    compactBufRef.current.length,
                    'append',
                ).catch(() => {});
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

            // Aggregate only the new bars and prepend to existing display - O(new_bars).
            const newDisplay = prependAggregatedOhlcvBars(
                newBars,
                ohlcvBarsRef.current.display,
                _prependTargetBarNs,
                p.sessionMapperRef.current,
            );

            ohlcvBarsRef.current.bars = [...newBars, ...ohlcvBarsRef.current.bars];
            ohlcvBarsRef.current.barNs = _prependTargetBarNs;
            ohlcvBarsRef.current.display = newDisplay;
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
                dataStart,
            } = payload;
            const ds = BigInt(dataStart) * 1_000_000n;
            const ownBuf = (inBuf as ArrayBuffer).slice(0);
            const cb = createCompactBuffer(0);
            cb._buf = ownBuf;
            cb._view = new DataView(ownBuf);
            cb.length = ownBuf.byteLength / 20;
            cb.capacity = cb.length;
            cb.firstTs = ds;
            cb.lastTs = datasetEndRef.current;
            compactBufRef.current = cb;
            allTradesRef.current = newTrades;
            allPriceHistoryRef.current = newHistory;
            tradesRef.current = newTrades;
            if (newFpBars.length > 0) {
                if (payload.barNs === p.activeTimeframeRef.current.barNs)
                    footprintBarsRef.current = newFpBars;
                else requestFootprintRebuild();
            }
            playheadIdxRef.current = findFloorIndex(compactBufRef.current, p.horizonRef.current);
            replayedUpToRef.current = playheadIdxRef.current;
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
            const {
                ingestOhlcvBuf: prependOhlcvBuf,
                ingestBucketedPhBuf: prependBucketedPhBuf,
                ingestTradesBuf: prependTradesBuf,
                ingestPhBuf: prependPhBuf,
            } = payload;
            serialisedTradesBufRef.current = prependTradesBuf ?? null;
            serialisedPhBufRef.current = prependPhBuf ?? null;
            serialisedOhlcvBufRef.current = prependOhlcvBuf ?? null;
            if (prependBucketedPhBuf)
                priceHistoryRef.current = deserializePriceHistoryFromBuf(prependBucketedPhBuf);
            if (prependOhlcvBuf)
                candleCacheRef.current = deserializeOhlcvCacheFromBuf(
                    prependOhlcvBuf,
                    p.horizonRef.current,
                );
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

    // applyHorizon / seekHorizon
    const applyHorizon = useCallback((horizon: bigint, triggerResample = true, hotPath = false) => {
        const cb = compactBufRef.current;
        const newIdx = findFloorIndex(cb, horizon);
        const prevIdx = playheadIdxRef.current;
        const barNs = p.activeTimeframeRef.current.barNs;
        const isForward = newIdx >= prevIdx;

        // Same bucketing as the bars themselves, so the follow-scroll steps at the
        // moment a new candle actually opens rather than at an epoch multiple.
        const newHorizonBar = ohlcvBucketRange(horizon, barNs, p.sessionMapperRef.current).start;
        if (newHorizonBar !== prevHorizonBarRef.current) {
            const oldHorizonBar = prevHorizonBarRef.current;
            const fwd = newHorizonBar > oldHorizonBar;
            prevHorizonBarRef.current = newHorizonBar;
            const inChart =
                p.viewRef.current!.tMax > newHorizonBar && p.viewRef.current!.tMin < newHorizonBar;
            if (
                p.viewRef.current &&
                !(p.isDragging.current && p.dragMode.current === 'pan') &&
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
            }
        }

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
            requestFootprintRebuild();
            updatePriceHistoryToRawIdx(findPriceHistoryIdx(horizon));
            const targetIdx = newIdx;
            if (getPanel()) {
                const CHUNK = 50_000;
                let i = 0;
                const book = createBook();
                const applyChunk = () => {
                    if (playheadIdxRef.current !== targetIdx) return;
                    const end = Math.min(i + CHUNK, targetIdx + 1);
                    for (; i < end; i++) applyEvent(book, getEvent(cb, i));
                    if (i <= targetIdx) setTimeout(applyChunk, 0);
                    else {
                        liveBookRef.current = book;
                        replayedUpToRef.current = targetIdx;
                        getPanel()?.update(book);
                    }
                };
                applyChunk();
            }
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
            syncOhlcvOpenBar(horizon);
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
            const barClosed = foldEventsIntoOpenBar(prevIdx, newIdx, barNs, horizon);
            if (barClosed) requestFootprintRebuild();
            mergeOpenBar();
        }
        updatePriceHistoryToRawIdx(findPriceHistoryIdx(horizon));
        if (getPanel() && newIdx > replayedUpToRef.current) {
            const book = liveBookRef.current;
            for (let i = replayedUpToRef.current + 1; i <= newIdx; i++)
                applyEvent(book, getEvent(cb, i));
            replayedUpToRef.current = newIdx;
            getPanel()?.update(book);
        }
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
            if (barNs > 0n && candleCacheRef.current && newIdx > prevIdx) {
                const all = allTradesRef.current;
                const prevTs = prevIdx >= 0 ? getTsNs(cb, prevIdx) : 0n;
                let tradeStart = 0,
                    lo2 = 0,
                    hi2 = all.length - 1;
                while (lo2 <= hi2) {
                    const m2 = (lo2 + hi2) >>> 1;
                    if (all[m2].ts <= prevTs) {
                        tradeStart = m2 + 1;
                        lo2 = m2 + 1;
                    } else hi2 = m2 - 1;
                }
                let tradeEnd = tradeStart,
                    lo3 = tradeStart,
                    hi3 = all.length - 1;
                while (lo3 <= hi3) {
                    const m3 = (lo3 + hi3) >>> 1;
                    if (all[m3].ts <= horizon) {
                        tradeEnd = m3;
                        lo3 = m3 + 1;
                    } else hi3 = m3 - 1;
                }
                if (tradeEnd >= tradeStart) {
                    const map = candleCacheRef.current;
                    for (let ti = tradeStart; ti <= tradeEnd; ti++) {
                        const t = all[ti];
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
                }
            }
            runHorizonAdvance(horizon);
            if (horizonScrollAnimRef.current && p.viewRef.current) {
                const anim = horizonScrollAnimRef.current;
                // Honor the easing/duration captured when this animation started, so a
                // linear "can't keep up" glide stays linear even if the setting is eased.
                const duration = anim.duration ?? p.chartSettingsRef.current.horizonScrollDuration;
                const raw = Math.min((performance.now() - anim.startTime) / duration, 1.0);
                const eased = applyHorizonScrollEasing(
                    raw,
                    anim.easing ?? p.chartSettingsRef.current.horizonScrollEasing,
                );
                const lerp = (a: bigint, b: bigint, f: number) =>
                    a + BigInt(Math.round(Number(b - a) * f));
                if (anim.startMMin !== undefined && anim.targetMMin !== undefined) {
                    const sm = p.sessionMapperRef.current;
                    p.viewRef.current.tMin = sm.marketToTs(
                        lerp(anim.startMMin, anim.targetMMin, eased),
                    );
                    p.viewRef.current.tMax = sm.marketToTs(
                        lerp(anim.startMMax, anim.targetMMax, eased),
                    );
                } else {
                    p.viewRef.current.tMin = lerp(anim.startTMin, anim.targetTMin, eased);
                    p.viewRef.current.tMax = lerp(anim.startTMax, anim.targetTMax, eased);
                }
                if (raw >= 1.0) horizonScrollAnimRef.current = null;
            }
            syncOhlcvOpenBar(horizon);
            p.pushDrawParamsRef.current();
            if (tradesRef.current.length > 0) p.doBaseRedrawRef.current();
            else p.renderEngineRef.current?.markDirty('base');
            p.renderEngineRef.current?.markDirty('drawings');
            return;
        }

        const slicedTrades = getTradesUpToHorizon(horizon);
        rebuildCandleCache(slicedTrades, barNs);
        lastHorizonForIndicatorsRef.current = horizon;
        runIndicatorWorker(slicedTrades, barNs);
        p.autofitIndicatorPanesRef.current();
        syncOhlcvOpenBar(horizon);
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
        workerRef.current.onmessage = onWorkerMessage;
        indicatorWorkerRef.current = new Worker(
            new URL('../lib/indicator-worker.ts', import.meta.url),
        );
        indicatorWorkerRef.current.onmessage = onIndicatorWorkerMessage;
        return () => {
            workerRef.current?.terminate();
            dataWorkerRef.current?.terminate();
            indicatorWorkerRef.current?.terminate();
            // Clear the guard so a remount rebuilds the workers. React
            // StrictMode mounts, unmounts and remounts in development; refs
            // survive that cycle, so leaving the guard set would leave the
            // second mount holding terminated workers and the chart stuck
            // forever on "Getting market data...".
            workerRef.current = null;
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
                previewBarsRef.current = [];
                ohlcvBarsRef.current.bars = [];
                ohlcvBarsRef.current.display = [];
                p.pushDrawParamsRef.current();
                const safeBuf = (payload.compactBuf as ArrayBuffer).slice(0);
                ingestLoadedData({ ...(payload as any), compactBuf: safeBuf });
            }),
            p.eventBus.on('data:append', (payload) => {
                if (payload.symbol !== cellSymbol) return;
                previewBarsRef.current = [];
                p.pushDrawParamsRef.current();
                ingestAppendedData(payload as any);
            }),
            p.eventBus.on('data:prepend', (payload) => {
                if (payload.symbol !== cellSymbol) return;
                previewBarsRef.current = [];
                ingestPrependedData(payload as any);
            }),
            p.eventBus.on('data:refine', (payload) => {
                // Every cell shares one event bus, so a refine belongs to whichever
                // cells are showing THAT symbol. Without this check a refetch
                // triggered by one pane (switching to a finer timeframe re-fetches
                // its segments at a finer resolution) replaced every other pane's
                // bars with the refining symbol's - four charts, one instrument.
                if (payload.symbol !== cellSymbol) return;
                if (payload.dataLevel !== 'ohlcv') return;
                const fromMs = new Date(payload.from).getTime();
                const toMs = new Date(payload.to).getTime();
                const activeBarNs = p.activeTimeframeRef.current.barNs;
                const incomingBars: OhlcvBarMs[] = payload.ohlcvBars.map((bar: any) => ({
                    open: bar.open,
                    high: bar.high,
                    low: bar.low,
                    close: bar.close,
                    volume: bar.volume,
                    time: bar.time,
                }));
                const kept = ohlcvBarsRef.current.bars.filter(
                    (b) => b.time < fromMs || b.time > toMs,
                );
                const merged = [...kept, ...incomingBars].sort((a, b) => a.time - b.time);
                ohlcvBarsRef.current.bars = merged;
                ohlcvBarsRef.current.barNs = activeBarNs;
                ohlcvBarsRef.current.display = aggregateOhlcvBars(
                    merged,
                    activeBarNs,
                    p.sessionMapperRef.current,
                );
                p.pushDrawParamsRef.current();
                p.renderEngineRef.current?.markDirty('base');
            }),
            p.eventBus.on('data:preview', (payload) => {
                if (payload.symbol !== cellSymbol) return;
                previewBarsRef.current = payload.bars;
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
        replayedUpToRef,
        dataLevelRef,
        datasetStartRef,
        datasetEndRef,
        prevSessionStatusRef,
        candleCacheRef,
        supplementalBarsRef,
        serialisedTradesBufRef,
        serialisedPhBufRef,
        serialisedOhlcvBufRef,
        fpRebuildSeqRef,
        rawBitmapRef,
        heatmapBitmapRef,
        heatmapBitmapOffsetsRef,
        cacheBoundsRef,
        liveBookRef,
        prevHorizonBarRef,
        lastBarAdvanceTimeRef,
        horizonScrollAnimRef,
        workerRef,
        dataWorkerRef,
        indicatorWorkerRef,
        workerReadyRef,
        workerRequestIdRef,
        _internalDomPanelRef,
        seekHorizon,
        gotoRange,
        applyHorizon,
        scheduleResample,
        runIndicatorWorker,
        getTradesUpToHorizon,
        requestFootprintRebuild,
        syncOhlcvOpenBar,
        rebuildCandleCache,
        rebuildContrastBitmap,
        foldEventsIntoOpenBar,
        mergeOpenBar,
        resetPlayhead,
        fpSettingsFromRef,
        cancelAndRestartWorker,
        runHorizonAdvance,
        updatePriceHistoryToRawIdx,
        findPriceHistoryIdx,
        loadData,
    };
}
