import { useCallback, useRef, type MutableRefObject, type RefObject } from 'react';
import { nanoid } from 'nanoid';
import { type Drawing, defaultStyleForTool } from '../lib/types/drawing-types';
import { type ChartPane, type Indicator, type Rect } from '../lib/types/indicator-types';
import { X_AXIS_HEIGHT } from '../lib/renderers/renderer';
import { getEffectiveDpr } from '../lib/dpr';
import {
    type ViewBounds,
    type TradeLine,
    type TradePoint,
    type PriceHistory,
    type OhlcvBarMs,
} from '../lib/types';
import { type Timeframe, tfViewSpan } from '../lib/timeframes';
import { type RenderEngine } from '../core/RenderEngine';
import { type LiveTransformer } from '../interfaces/ICoordinateTransformer';
import { type DataLevel } from '../interfaces/IDataAdapter';
import { type CompactBuffer } from '../lib/compact-buffer';
import { type ChartSettings } from '../lib/types/chart-settings';
import { type SessionMapper } from '../core/SessionMapper';
import { type FootprintBar } from '../lib/types/footprint';
import { type SerialTrade } from '../lib/types';
import { autoFitPriceAxis, aggregateOhlcvBars } from './useChartData';

export interface UseChartHandlersParams {
    // Drawing refs
    drawingsRef: MutableRefObject<Drawing[]>;
    drawingsCanvasRef: RefObject<HTMLCanvasElement>;
    viewRef: MutableRefObject<ViewBounds | null>;
    selectedDrawingIdRef: MutableRefObject<string | null>;

    // Pane/indicator refs
    indicatorsRef: MutableRefObject<Indicator[]>;
    panesRef: MutableRefObject<ChartPane[]>;

    // Data refs
    ohlcvBarsRef: MutableRefObject<{ barNs: bigint; bars: OhlcvBarMs[]; display: OhlcvBarMs[] }>;
    sessionMapperRef: MutableRefObject<SessionMapper>;
    activeTimeframeRef: MutableRefObject<Timeframe>;
    horizonRef: MutableRefObject<bigint>;
    phCursorRef: MutableRefObject<number>;
    candleCacheRef: MutableRefObject<Map<bigint, any> | null>;
    tradesRef: MutableRefObject<TradePoint[]>;
    openBarRef: MutableRefObject<FootprintBar | null>;
    openBarTsRef: MutableRefObject<bigint>;
    openBarTradeCountRef: MutableRefObject<number>;
    compactBufRef: MutableRefObject<CompactBuffer>;
    isYAxisAutoRef: MutableRefObject<boolean>;
    priceHistoryRef: MutableRefObject<PriceHistory[]>;
    dataLevelRef: MutableRefObject<DataLevel | null>;
    previewBarsRef: MutableRefObject<OhlcvBarMs[]>;
    chartSettingsRef: MutableRefObject<ChartSettings>;
    tradeLinesRef: MutableRefObject<TradeLine[]>;
    hoveringLegend: MutableRefObject<boolean>;
    renderEngineRef: MutableRefObject<RenderEngine | null>;

    // Props
    transformer: LiveTransformer;

    // State
    maximizedPaneId: string | null;

    // Setters
    setIndicators: (inds: Indicator[]) => void;
    setPanes: (updater: ChartPane[] | ((prev: ChartPane[]) => ChartPane[])) => void;
    setSelectedDrawingId: (id: string | null) => void;
    setSettingsBarPos: (pos: { x: number; y: number } | null) => void;
    setIndicatorSettingsId: (id: string | null) => void;
    setActiveTimeframe: (tf: Timeframe) => void;
    setMaximizedPaneId: (updater: string | null | ((prev: string | null) => string | null)) => void;

    // Callbacks
    pushDrawParams: () => void;
    updateSettingsBarPos: (id: string | null) => void;
    recomputeLayouts: () => void;
    scheduleResample: () => void;
    runIndicatorWorker: (trades: SerialTrade[], barNs: bigint) => void;
    getTradesUpToHorizon: (horizon: bigint) => TradePoint[];
    getLayouts: () => Record<string, Rect>;
    rebuildCandleCache: (trades: TradePoint[], barNs: bigint) => void;
    syncOhlcvOpenBar: (horizon: bigint) => void;
    updatePriceHistoryToRawIdx: (rawIdx: number) => void;
    findPriceHistoryIdx: (horizon: bigint) => number;
    resetXAxis: () => void;
    resetYAxis: () => void;
    autofitIndicatorPanes: () => void;

    hideTimeScale: boolean;
    priceScaleWidthRef: MutableRefObject<number>;
}

export interface UseChartHandlersResult {
    handleUpdateDrawing: (id: string, patch: Partial<Drawing>) => void;
    handleDeleteDrawing: (id: string) => void;
    handleDeleteDrawings: () => void;
    handleDuplicateDrawing: (id: string) => void;
    handleToggleIndicator: (indicatorId: string) => void;
    handleRemoveIndicator: (indicatorId: string) => void;
    handleOpenIndicatorSettings: (indicatorId: string) => void;
    handleRemoveIndicators: () => void;
    handleMoveUp: (paneId: string) => void;
    handleMoveDown: (paneId: string) => void;
    handleRemovePane: (paneId: string) => void;
    handleExpand: (paneId: string) => void;
    handleCollapse: (paneId: string) => void;
    handleMaximize: (paneId: string) => void;
    handleEnter: () => void;
    handleLeave: () => void;
    handleTimeframeChange: (tf: Timeframe) => void;
    handleAddIndicator: (defId: string) => void;
    handleAddTradeLine: (opts: TradeLine) => void;
}

const COLLAPSED_HEIGHT_RATIO = 0.08;

export function useChartHandlers(p: UseChartHandlersParams): UseChartHandlersResult {
    const {
        drawingsRef,
        drawingsCanvasRef,
        viewRef,
        selectedDrawingIdRef,
        indicatorsRef,
        panesRef,
        ohlcvBarsRef,
        sessionMapperRef,
        activeTimeframeRef,
        horizonRef,
        phCursorRef,
        candleCacheRef,
        tradesRef,
        openBarRef,
        openBarTsRef,
        openBarTradeCountRef,
        compactBufRef,
        isYAxisAutoRef,
        priceHistoryRef,
        dataLevelRef,
        previewBarsRef,
        chartSettingsRef,
        tradeLinesRef,
        hoveringLegend,
        renderEngineRef,
        transformer,
        maximizedPaneId,
        setIndicators,
        setPanes,
        setSelectedDrawingId,
        setSettingsBarPos,
        setIndicatorSettingsId,
        setActiveTimeframe,
        setMaximizedPaneId,
        pushDrawParams,
        updateSettingsBarPos,
        recomputeLayouts,
        scheduleResample,
        runIndicatorWorker,
        getTradesUpToHorizon,
        getLayouts,
        rebuildCandleCache,
        syncOhlcvOpenBar,
        updatePriceHistoryToRawIdx,
        findPriceHistoryIdx,
        resetXAxis,
        resetYAxis,
        autofitIndicatorPanes,
    } = p;

    const preMaxHeightsRef = useRef<Map<string, number>>(new Map());

    // Drawing handlers
    const handleUpdateDrawing = useCallback((id: string, patch: Partial<Drawing>) => {
        //@ts-ignore
        drawingsRef.current = drawingsRef.current.map((d) => {
            if (d.id !== id) return d;
            if (
                d.tool === 'text' &&
                (patch as any).screenAnchored === true &&
                !(d as any).screenAnchored
            ) {
                const canvas = drawingsCanvasRef.current;
                const view = viewRef.current;
                const dpr = getEffectiveDpr();

                const cssW = canvas.width / dpr;
                const cssH = canvas.height / dpr;
                const layouts = getLayouts();
                const mainRect = layouts['main'];
                const mainH = mainRect?.h ?? (cssH ?? 0) - (p.hideTimeScale ? 0 : X_AXIS_HEIGHT);
                const mainOY = mainRect?.y ?? 0;
                const chartW = canvas ? cssW - p.priceScaleWidthRef.current : 0;
                if (canvas && view) {
                    //@ts-ignore
                    const sx = transformer.tsToX(d.anchor.ts, chartW);
                    //@ts-ignore
                    const sy = transformer.priceToY(d.anchor.price, mainH) + mainOY;
                    return { ...d, ...patch, screenX: sx, screenY: sy };
                }
            }
            return { ...d, ...patch };
        });
        pushDrawParams();
        renderEngineRef.current?.markDirty('drawings');
    }, []);

    const handleDeleteDrawing = useCallback((id: string) => {
        drawingsRef.current = drawingsRef.current.filter((d) => d.id !== id);
        selectedDrawingIdRef.current = null;
        setSelectedDrawingId(null);
        setSettingsBarPos(null);
        pushDrawParams();
        renderEngineRef.current?.markDirty('drawings');
    }, []);

    const handleDeleteDrawings = useCallback(() => {
        drawingsRef.current = [];
        selectedDrawingIdRef.current = null;
        setSelectedDrawingId(null);
        setSettingsBarPos(null);
        pushDrawParams();
        renderEngineRef.current?.markDirty('drawings');
    }, []);

    const handleDuplicateDrawing = useCallback((id: string) => {
        const orig = drawingsRef.current.find((d) => d.id === id);
        if (!orig) return;
        const copy = { ...orig, id: nanoid() };
        if ('price' in copy) (copy as any).price += 0.5;
        drawingsRef.current = [...drawingsRef.current, copy];
        selectedDrawingIdRef.current = copy.id;
        setSelectedDrawingId(copy.id);
        pushDrawParams();
        renderEngineRef.current?.markDirty('drawings');
        updateSettingsBarPos(copy.id);
    }, []);

    // Indicator handlers
    const handleToggleIndicator = useCallback((indicatorId: string) => {
        const updated = indicatorsRef.current.map((ind) =>
            ind.id === indicatorId ? { ...ind, visible: !ind.visible } : ind,
        );
        indicatorsRef.current = updated;
        setIndicators(updated);
        pushDrawParams();
        renderEngineRef.current?.markDirty('base');
        renderEngineRef.current?.markDirty('drawings');
        updateSettingsBarPos(selectedDrawingIdRef.current);
        renderEngineRef.current?.markDirty('ui');
    }, []);

    const handleRemovePane = useCallback((paneId: string) => {
        const next = panesRef.current.filter((p) => p.id !== paneId);
        panesRef.current = next;
        setPanes(next);
        const updatedInds = indicatorsRef.current.filter((ind) => ind.paneId !== paneId);
        indicatorsRef.current = updatedInds;
        setIndicators(updatedInds);
        recomputeLayouts();
        pushDrawParams();
        renderEngineRef.current?.markDirty('base');
        renderEngineRef.current?.markDirty('drawings');
        updateSettingsBarPos(selectedDrawingIdRef.current);
        renderEngineRef.current?.markDirty('ui');
    }, []);

    const handleRemoveIndicator = useCallback((indicatorId: string) => {
        const ind = indicatorsRef.current.find((ind) => ind.id === indicatorId);
        const updated = indicatorsRef.current.filter((ind) => ind.id !== indicatorId);
        indicatorsRef.current = updated;
        setIndicators(updated);
        if (ind?.paneId && panesRef.current.some((pane) => pane.id === ind?.paneId)) {
            if (ind.paneId !== 'main') handleRemovePane(ind.paneId);
        }
        pushDrawParams();
        renderEngineRef.current?.markDirty('base');
        renderEngineRef.current?.markDirty('drawings');
        updateSettingsBarPos(selectedDrawingIdRef.current);
        renderEngineRef.current?.markDirty('ui');
    }, []);

    const handleOpenIndicatorSettings = useCallback((indicatorId: string) => {
        const ind = indicatorsRef.current.find((ind) => ind.id === indicatorId);
        if (ind) setIndicatorSettingsId(indicatorId);
    }, []);

    const handleRemoveIndicators = useCallback(() => {
        indicatorsRef.current = [];
        setIndicators([]);
        const updated = panesRef.current.filter((pane) => pane.isMain);
        panesRef.current = updated;
        setPanes(updated);
        recomputeLayouts();
        pushDrawParams();
        renderEngineRef.current?.markDirty('base');
        renderEngineRef.current?.markDirty('drawings');
        updateSettingsBarPos(selectedDrawingIdRef.current);
        renderEngineRef.current?.markDirty('ui');
    }, []);

    // Pane handlers
    const handleMoveUp = useCallback((paneId: string) => {
        const idx = panesRef.current.findIndex((p) => p.id === paneId);
        if (idx <= 0) return;
        const next = [...panesRef.current];
        [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
        panesRef.current = next;
        setPanes(next);
        recomputeLayouts();
        pushDrawParams();
        renderEngineRef.current?.markDirty('base');
        renderEngineRef.current?.markDirty('drawings');
        updateSettingsBarPos(selectedDrawingIdRef.current);
        renderEngineRef.current?.markDirty('ui');
    }, []);

    const handleMoveDown = useCallback((paneId: string) => {
        const idx = panesRef.current.findIndex((p) => p.id === paneId);
        if (idx < 0 || idx >= panesRef.current.length - 1) return;
        const next = [...panesRef.current];
        [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
        panesRef.current = next;
        setPanes(next);
        recomputeLayouts();
        pushDrawParams();
        renderEngineRef.current?.markDirty('base');
        renderEngineRef.current?.markDirty('drawings');
        updateSettingsBarPos(selectedDrawingIdRef.current);
        renderEngineRef.current?.markDirty('ui');
    }, []);

    const handleExpand = useCallback((paneId: string) => {
        const next = panesRef.current.map((p) =>
            p.id === paneId ? { ...p, collapsed: false, heightRatio: p.savedHeightRatio ?? 1 } : p,
        );
        panesRef.current = next;
        setPanes(next);
        recomputeLayouts();
        scheduleResample();
        pushDrawParams();
        renderEngineRef.current?.markDirty('base');
        renderEngineRef.current?.markDirty('drawings');
        updateSettingsBarPos(selectedDrawingIdRef.current);
        renderEngineRef.current?.markDirty('ui');
    }, []);

    const handleCollapse = useCallback(
        (paneId: string) => {
            if (maximizedPaneId !== null) return;

            const next = panesRef.current.map((p) =>
                p.id === paneId
                    ? {
                          ...p,
                          collapsed: !p.collapsed,
                          savedHeightRatio: p.collapsed ? p.savedHeightRatio : p.heightRatio,
                          heightRatio: p.collapsed
                              ? (p.savedHeightRatio ?? 1)
                              : COLLAPSED_HEIGHT_RATIO,
                      }
                    : p,
            );

            panesRef.current = next;
            setPanes(next);
            recomputeLayouts();
            scheduleResample();
            pushDrawParams();
            renderEngineRef.current?.markDirty('base');
            renderEngineRef.current?.markDirty('drawings');
            updateSettingsBarPos(selectedDrawingIdRef.current);
            renderEngineRef.current?.markDirty('ui');
        },
        [maximizedPaneId],
    );

    const handleMaximize = useCallback((paneId: string) => {
        setMaximizedPaneId((prev) => {
            const next = prev === paneId ? null : paneId;
            let updatedPanes: ChartPane[];
            if (next === null) {
                updatedPanes = panesRef.current.map((p) => {
                    const restored = preMaxHeightsRef.current.get(p.id);
                    return {
                        ...p,
                        heightRatio: restored ?? p.heightRatio,
                    };
                });
                preMaxHeightsRef.current.clear();
            } else {
                preMaxHeightsRef.current.clear();
                panesRef.current.forEach((p) => preMaxHeightsRef.current.set(p.id, p.heightRatio));
                updatedPanes = panesRef.current.map((p) => ({
                    ...p,
                    heightRatio: p.id === next ? 100 : 0,
                }));
            }
            panesRef.current = updatedPanes;
            setPanes(updatedPanes);
            recomputeLayouts();
            scheduleResample();
            pushDrawParams();
            renderEngineRef.current?.markDirty('base');
            renderEngineRef.current?.markDirty('drawings');
            updateSettingsBarPos(selectedDrawingIdRef.current);
            renderEngineRef.current?.markDirty('ui');
            return next;
        });
    }, []);

    const handleEnter = useCallback(() => {
        hoveringLegend.current = true;
    }, []);

    const handleLeave = useCallback(() => {
        hoveringLegend.current = false;
    }, []);

    // Timeframe handler
    const handleTimeframeChange = useCallback((tf: Timeframe) => {
        if (ohlcvBarsRef.current.bars.length) {
            ohlcvBarsRef.current.barNs = tf.barNs;
            ohlcvBarsRef.current.display = aggregateOhlcvBars(
                ohlcvBarsRef.current.bars,
                tf.barNs,
                sessionMapperRef.current,
            );
        }

        setActiveTimeframe(tf);
        activeTimeframeRef.current = tf;
        setPanes((prev) => prev.map((p) => (p.isMain ? { ...p, tf: tf.label } : p)));

        const view = viewRef.current;
        if (!view) return;

        phCursorRef.current = -1;
        updatePriceHistoryToRawIdx(findPriceHistoryIdx(horizonRef.current));

        candleCacheRef.current = null;
        rebuildCandleCache(tradesRef.current, tf.barNs);

        openBarRef.current = null;
        openBarTsRef.current = 0n;
        openBarTradeCountRef.current = 0;

        // ...and rebuild it for the new timeframe right away. Clearing alone left
        // the chart with no forming bar until the horizon next moved, so switching
        // timeframe while paused (which is most of a replay) dropped the candle at
        // the playhead until you pressed play or stepped.
        syncOhlcvOpenBar(horizonRef.current);

        indicatorsRef.current.forEach((ind) => {
            // @ts-ignore
            if (!ind.hydrate && ind.compute)
                // @ts-ignore
                ind.compute(compactBufRef.current as any, tradesRef.current);
        });
        runIndicatorWorker(
            getTradesUpToHorizon(horizonRef.current),
            activeTimeframeRef.current.barNs,
        );

        const span = tfViewSpan(tf);
        view.tMin = view.tMax - span;

        if (isYAxisAutoRef.current)
            autoFitPriceAxis(
                view,
                priceHistoryRef.current,
                tradesRef.current,
                dataLevelRef.current === 'ohlcv'
                    ? ohlcvBarsRef.current.display
                    : previewBarsRef.current,
                openBarRef.current,
                chartSettingsRef.current,
                horizonRef.current,
                dataLevelRef.current,
            );

        resetXAxis();
        resetYAxis();
        autofitIndicatorPanes();
        scheduleResample();
        pushDrawParams();
        renderEngineRef.current?.markDirty('base');
        renderEngineRef.current?.markDirty('drawings');
        updateSettingsBarPos(selectedDrawingIdRef.current);
        renderEngineRef.current?.markDirty('ui');
    }, []);

    // Misc handlers
    const handleAddIndicator = useCallback((defId: string) => {
        if (defId === 'vp_fixed') {
            const tS = viewRef.current.tMin;
            const tE = viewRef.current.tMax;
            const midPrice = (viewRef.current.pMin + viewRef.current.pMax) / 2;
            const halfRange = (viewRef.current.pMax - viewRef.current.pMin) / 2;
            const newDrawing: Drawing = {
                id: nanoid(),
                tool: 'fvp',
                a: { ts: tS, price: midPrice - halfRange },
                b: { ts: tE, price: midPrice + halfRange },
                ...(defaultStyleForTool('fvp') as any),
            };
            drawingsRef.current = [...drawingsRef.current, newDrawing];
            selectedDrawingIdRef.current = newDrawing.id;
            setSelectedDrawingId(newDrawing.id);
            pushDrawParams();
            renderEngineRef.current?.markDirty('drawings');
            runIndicatorWorker(
                getTradesUpToHorizon(horizonRef.current),
                activeTimeframeRef.current.barNs,
            );
        }
    }, []);

    const handleAddTradeLine = useCallback((opts: TradeLine) => {
        tradeLinesRef.current = [...tradeLinesRef.current, opts];
        pushDrawParams();
        renderEngineRef.current?.markDirty('ui');
    }, []);

    return {
        handleUpdateDrawing,
        handleDeleteDrawing,
        handleDeleteDrawings,
        handleDuplicateDrawing,
        handleToggleIndicator,
        handleRemoveIndicator,
        handleOpenIndicatorSettings,
        handleRemoveIndicators,
        handleMoveUp,
        handleMoveDown,
        handleRemovePane,
        handleExpand,
        handleCollapse,
        handleMaximize,
        handleEnter,
        handleLeave,
        handleTimeframeChange,
        handleAddIndicator,
        handleAddTradeLine,
    };
}
