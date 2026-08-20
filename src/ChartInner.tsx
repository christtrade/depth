'use client';

import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import {
    Crosshair,
    X_AXIS_HEIGHT,
    nearestIndex,
    computeRightScaleWidth,
    getOrdinalModel,
    ordinalVisiblePriceRange,
} from './lib/renderers/renderer';
import { resolveTickSize } from './lib/priceFormat';
import { ViewBounds, TradeLine, TradePoint } from './lib/types';
import { MAX_TIME_SPAN, MIN_TIME_SPAN } from './lib/constants';
import { ChevronLeft, ChevronRight, Minus, Plus, RotateCcw } from 'lucide-react';
import { ChartPane, Indicator } from './lib/types/indicator-types';
import { TimeframeUnit, type Timeframe } from './lib/timeframes';
import { ChartContextMenu } from './components/chart/chart-context-menu';
import { getDrawingLabelAnchor } from './lib/renderers/drawings-renderer';
import {
    type Drawing,
    type DraftDrawing,
    type Anchor,
    defaultStyleForTool,
    DrawingAnchorId,
    ActiveDrawingTool,
    CURSOR_TOOL,
} from './lib/types/drawing-types';
import { nanoid } from 'nanoid';
import { DrawingSettingsBar } from './components/drawings/drawing-settings-bar';
import { ChartSettings, DEFAULT_CHART_SETTINGS } from './lib/types/chart-settings';
import { TradeLineHitMap } from './lib/renderers/drawTradeLines';
import { useTradeLines } from './hooks/useTradeLines';
import { PlaceOrderRequest } from './lib/matchingEngine';
import { RenderEngine } from './core/RenderEngine';
import {
    AccountManager,
    ChartModel,
    DrawingStore,
    LiveTransformer,
    SymbolInfo,
    TradingSession,
    isCompatible,
} from './core';
import { IndicatorSettingsDialog } from './components/indicators/indicators-settings-dialog';
import { drawingRegistry, PluginToolActiveContext } from './core/DrawingRegistry';
import { createSessionMapper, SessionMapper } from './core/SessionMapper';
import { Input } from './components/ui/input';
import { FeaturesOptions } from './core/DepthChart';
import { StatusBar } from './components/chart/status-bar';
import { PaneLegend, PaneLegendScale } from './components/chart/pane-legend';
import { DataStatus, HeatmapSpinner } from './components/chart/data-status';
import { ChartErrorOverlay, ChartLoadingOverlay } from './components/chart/chart-status-overlay';
import { useChartData, autoFitPriceAxis, applyHorizonScrollEasing } from './hooks/useChartData';
import { useChartInteraction } from './hooks/useChartInteraction';
import { useChartHandlers } from './hooks/useChartHandlers';
import { useChartSubscriptions } from './hooks/useChartSubscriptions';
import { useChartLayout } from './hooks/useChartLayout';
import { useChartSettings } from './hooks/useChartSettings';
import { useChartPlugin } from './hooks/useChartPlugin';
import { useRenderEngine } from './hooks/useRenderEngine';
import { useChartView } from './hooks/useChartView';
import { getEffectiveDpr } from './lib/dpr';
import { Button } from './components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from './components/ui/tooltip';
import {
    DEFAULT_SYNC_IN_LAYOUT,
    type CrosshairSync,
    type SyncInLayout,
    type TimeRangeSync,
} from './lib/types/layout-sync';
import { ChartStateShape } from './core/ChartState';

export type ChartHandle = {
    // Time / horizon
    /**
     * Move the chart to this exact data-time.
     * Works for both focused (full path) and secondary (lightweight path)
     * charts - the layout always calls this; the chart decides internally
     * how expensive the update needs to be.
     */
    seekHorizon: (horizon: bigint, recenter?: boolean) => void;
    getHorizon: () => bigint;
    /** This pane's visible time range (ns), or null before the first view exists. */
    getVisibleRange: () => { tMin: bigint; tMax: bigint } | null;
    /**
     * The edges of the data this pane has loaded (ns), both 0n before its first
     * load. This is what gates the pane's own horizon - seekHorizon clamps to
     * `end` - so the playback clock reads it from whichever pane it is following.
     */
    getDataBounds: () => { start: bigint; end: bigint };

    // Toolbar / settings
    /** `fromSync` = applied by a layout-wide interval sync; it won't re-broadcast. */
    handleTimeframeChange: (tf: any, fromSync?: boolean) => void;
    handleAddIndicator: (id: string) => void;
    handleToggleIndicator: (id: string) => void;
    handleRemoveIndicator: (id: string) => void;
    setActiveTool: (tool: ActiveDrawingTool) => void;
    getIndicators: () => any[];
    getActiveTimeframe: () => any;
    getChartSettings: () => ChartSettings;
    getActiveTool: () => ActiveDrawingTool;
    applySettings: (patch: Partial<ChartSettings>) => void;

    // Redraw helpers (used by toolbar reset button)
    scheduleBaseRedraw: () => void;
    scheduleResample: () => void;
    redrawDrawings: () => void;
    scheduleUIRedraw: () => void;

    drawTradeLine: (opts: TradeLine) => void;

    activatePluginIndicator: (indicator: Indicator, pane: any) => void;
    replacePluginIndicator: (indicator: Indicator) => void;
};

export type ChartProps = {
    /** Hide the top toolbar - multi-chart renders a shared one instead */
    hideToolbar?: boolean;
    /** Hide the DrawingToolbar left sidebar */
    hideDrawingToolbar?: boolean;

    hideBottomToolbar?: boolean;
    hidePriceScale?: boolean;
    hideTimeScale?: boolean;

    hideStatusBar?: boolean;
    hideLegend?: boolean;

    /**
     * Suppress this chart's own ChartSettingsDialog - multi-chart renders one
     * shared dialog instead. When set, opening settings calls onOpenSettings.
     */
    hideSettingsDialog?: boolean;
    /**
     * Called when the user triggers "open chart settings" (double-click legend,
     * settings button). Multi-chart uses this to open its single shared dialog.
     */
    onOpenSettings?: () => void;
    onHorizonUpdate: (h: bigint) => void;
    /** Called every rAF tick with the current horizon (for cross-chart sync) */
    onHorizonTick?: (horizon: bigint) => void;
    /** External DomPanel ref - if provided, chart uses this instead of its own */
    domPanelRef?: React.MutableRefObject<import('./lib/types').DomPanelHandle | null>;
    /**
     * Managed mode - MultiChartLayout owns the data.worker and will call
     * ingestLoad() / ingestAppend() on the handle after mount.
     * The chart skips its own data.worker but still spawns a footprint worker.
     */
    managed?: boolean;
    /**
     * Called when the chart needs more data (prefetch or stall recovery).
     * Used in managed mode so MultiChartLayout can forward the request to
     * the shared data.worker instead of the chart's own (footprint-only) worker.
     */
    onRequestMore?: () => void;
    onDataBoundsChange?: (datasetStart: bigint, dataEnd: bigint) => void;
    onCreateOrder?: (opts: PlaceOrderRequest) => void;
    tradeLines: TradeLine[];
    onGhostMove?: (lineId: string, kind: 'tp' | 'sl', index: number, price: number) => void;
    linesRef: any;
    draggingLineIdRef?: React.MutableRefObject<string | null>;
    redrawTrading: () => void;
    eventBus: any;
    onHandleReady?: (handle: ChartHandle) => void;
    transformer: LiveTransformer;
    showDataStatusInBottomRightCorner: boolean;
    initialState: {
        timeframe: Timeframe;
    };
    id: number;
    symbol: string;
    features: FeaturesOptions;
    account: AccountManager;
    drawingStore: DrawingStore;
    model: ChartModel;
    syncInLayout: SyncInLayout;
    setStatePatch: (key: keyof ChartStateShape, value: any) => void;
};

const Chart = forwardRef<ChartHandle, ChartProps>(function Chart(
    {
        hideToolbar,
        hideDrawingToolbar,
        hideBottomToolbar,
        hidePriceScale,
        hideTimeScale,
        hideStatusBar,
        hideLegend,
        hideSettingsDialog,
        onOpenSettings,
        onHorizonUpdate,
        onHorizonTick,
        domPanelRef: externalDomPanelRef,
        managed = false,
        onRequestMore,
        onDataBoundsChange,
        onCreateOrder,
        tradeLines,
        onGhostMove,
        linesRef,
        draggingLineIdRef,
        redrawTrading,
        eventBus,
        onHandleReady,
        transformer: _sharedTransformer,
        showDataStatusInBottomRightCorner,
        initialState,
        id: _id,
        symbol: cellSymbol,
        features,
        account,
        drawingStore,
        model,
        syncInLayout,
        setStatePatch,
    },
    ref,
) {
    const _seekHorizonRef = useRef<((h: bigint, recenter?: boolean) => void) | null>(null);
    const _handleTimeframeChangeRef = useRef<((tf: any, fromSync?: boolean) => void) | null>(null);
    const _handleAddIndicatorRef = useRef<((id: string) => void) | null>(null);
    const _handleToggleIndicatorRef = useRef<((id: string) => void) | null>(null);
    const _handleRemoveIndicatorRef = useRef<((id: string) => void) | null>(null);
    const _setActiveToolRef = useRef<((t: any) => void) | null>(null);
    const _getIndicatorsRef = useRef<(() => any[]) | null>(null);
    const _getActiveTimeframeRef = useRef<(() => any) | null>(null);
    const _getHorizonRef = useRef<(() => bigint) | null>(null);
    const _applySettingsRef = useRef<((patch: Partial<ChartSettings>) => void) | null>(null);
    const _getChartSettingsRef = useRef<(() => ChartSettings) | null>(null);
    const _scheduleResample = useRef<(() => void) | null>(null);
    const _handleAddTradeLineRef = useRef<(opts: TradeLine) => void | null>(null);
    const _activatePluginIndicator = useRef<(indicator: Indicator, pane: any) => void | null>(null);
    // assigned once everything it reads exists, further down
    const _enforceDataLevelRef = useRef<() => void>(() => {});
    const _replacePluginIndicator = useRef<(indicator: Indicator) => void | null>(null);
    const transformer = useRef(new LiveTransformer()).current;

    const buildHandle = (): ChartHandle => ({
        seekHorizon: (h, recenter) => _seekHorizonRef.current?.(h, recenter),
        handleTimeframeChange: (tf, fromSync) => _handleTimeframeChangeRef.current?.(tf, fromSync),
        handleAddIndicator: (id) => _handleAddIndicatorRef.current?.(id),
        handleToggleIndicator: (id) => _handleToggleIndicatorRef.current?.(id),
        handleRemoveIndicator: (id) => _handleRemoveIndicatorRef.current?.(id),
        setActiveTool: (t) => _setActiveToolRef.current?.(t),
        getIndicators: () => _getIndicatorsRef.current?.() ?? [],
        getActiveTimeframe: () => _getActiveTimeframeRef.current?.(),
        getHorizon: () => _getHorizonRef.current?.() ?? 0n,
        getVisibleRange: () =>
            viewRef.current ? { tMin: viewRef.current.tMin, tMax: viewRef.current.tMax } : null,
        getDataBounds: () => ({ start: datasetStartRef.current, end: datasetEndRef.current }),
        applySettings: (patch) => _applySettingsRef.current?.(patch),
        getChartSettings: () => _getChartSettingsRef.current?.() ?? DEFAULT_CHART_SETTINGS,
        getActiveTool: () => activeToolRef.current,
        scheduleResample: () => _scheduleResample.current?.(),
        scheduleBaseRedraw: () => {
            pushDrawParams();
            renderEngineRef.current?.markDirty('base');
        },
        scheduleUIRedraw: () => {
            pushDrawParams();
            renderEngineRef.current?.markDirty('ui');
        },
        redrawDrawings: () => {
            pushDrawParams();
            renderEngineRef.current?.markDirty('drawings');
        },
        drawTradeLine: (opts) => _handleAddTradeLineRef.current?.(opts),
        activatePluginIndicator: (indicator: Indicator, pane: any) =>
            _activatePluginIndicator.current?.(indicator, pane),
        replacePluginIndicator: (indicator: Indicator) =>
            _replacePluginIndicator.current?.(indicator),
    });

    useImperativeHandle(ref, buildHandle, []);

    useEffect(() => {
        onHandleReady?.(buildHandle());
    }, []);

    const containerRef = useRef<HTMLDivElement | null>(null);

    // Keep a stable ref so the rAF loop always sees the latest callback
    const onRequestMoreRef = useRef<(() => void) | undefined>(onRequestMore);
    useEffect(() => {
        onRequestMoreRef.current = onRequestMore;
    }, [onRequestMore]);

    const baseCanvasRef = useRef<HTMLCanvasElement>(null);
    const uiCanvasRef = useRef<HTMLCanvasElement>(null);

    const accountSnapRef = useRef(null);

    const renderEngineRef = useRef<RenderEngine | null>(null);

    // Tracks whether the previous frame used the ordinal axis, so we can snap to
    // the last-N-columns view the first time an ordinal chart type is selected.
    const prevOrdinalActiveRef = useRef(false);

    function pushDrawParams() {
        // Keep the transformer's price-scale math in sync with the user's choice.
        // ChartSettings uses 'normal' for the default; the transformer calls it
        // 'linear'. Every priceToY / yToPrice call (candles, axis, lines, plugins)
        // reads this mode, so setting it here is all that's needed to switch the
        // whole chart between linear / log / percent.
        transformer.setScaleMode(
            chartSettingsRef.current.priceScaleMode === 'normal'
                ? 'linear'
                : chartSettingsRef.current.priceScaleMode,
        );
        if (viewRef.current) {
            priceScaleWidthRef.current = computeRightScaleWidth(
                viewRef.current,
                resolvedSymbolInfoRef.current ?? undefined,
                chartSettingsRef.current,
                hidePriceScale,
                baseCanvasRef.current?.getContext('2d'),
            );
        }
        // Drive the transformer's ordinal (equal-width column) axis for the
        // price-driven chart types; null restores the time-based mapping. Columns
        // only change with data/chart-type/params, but recomputing here (memoised)
        // keeps the persistent transformer instance correct for pan/zoom frames.
        const ordinalModel = getOrdinalModel(
            chartSettingsRef.current.chartType,
            chartSettingsRef.current,
            dataLevelRef.current === 'ohlcv'
                ? ohlcvBarsRef.current.display
                : previewBarsRef.current,
            candleCacheRef.current,
            tradesRef.current,
            activeTimeframeRef.current.barNs,
        );
        transformer.setOrdinal(ordinalModel?.columnTs ?? null);

        // On entering an ordinal chart type, snap to the last ~N columns so the
        // stale time-based view doesn't map to an awkward column range.
        const ordinalActive = ordinalModel !== null;
        if (ordinalActive && !prevOrdinalActiveRef.current && ordinalModel && viewRef.current) {
            const n = ordinalModel.columnTs.length;
            const N = Math.min(n, 200);
            viewRef.current.tMin = transformer.indexToTs(n - N);
            viewRef.current.tMax = transformer.indexToTs(n - 1 + Math.min(N * 0.1, 10));
            transformer.update(viewRef.current);
        }
        prevOrdinalActiveRef.current = ordinalActive;

        // Ordinal y-axis auto-scale: the time-based autoFitPriceAxis scans bars by
        // ts and can't see the model's prices, so fit to the visible columns here.
        if (ordinalModel && isYAxisAutoRef.current && viewRef.current) {
            const r = ordinalVisiblePriceRange(ordinalModel, transformer);
            if (r) {
                const range = r.max - r.min || Math.abs(r.max) * 0.01 || 1;
                const top = chartSettingsRef.current.scaleMarginTop ?? 0.1;
                const bot = chartSettingsRef.current.scaleMarginBottom ?? 0.1;
                viewRef.current.pMin = r.min - range * bot;
                viewRef.current.pMax = r.max + range * top;
                transformer.update(viewRef.current);
            }
        }

        renderEngineRef.current?.setDrawParams({
            panes: panesRef.current,
            layouts: layoutsCacheRef.current,
            indicators: indicatorsRef.current,
            trades: tradesRef.current,
            priceHistory: priceHistoryRef.current,
            footprintBars: footprintBarsRef.current,
            heatmapBitmap: heatmapBitmapRef.current,
            bitmapOffsets: heatmapBitmapOffsetsRef.current,
            barNs: activeTimeframeRef.current.barNs,
            chartSettings: chartSettingsRef.current,
            horizon: horizonRef.current,
            candleCache: candleCacheRef.current,
            openBar: openBarRef.current,
            ohlcvBars:
                dataLevelRef.current === 'ohlcv'
                    ? ohlcvBarsRef.current.display
                    : previewBarsRef.current,
            // UI layer specific
            crosshair: crosshairRef.current,
            drawings: drawingsRef.current,
            draft: draftRef.current,
            tradeLines: tradeLinesRef.current,
            hoveredDividerIdx: hoveredDividerIdxRef.current,
            hoveringLegend: hoveringLegend.current,
            showTooltip: showTooltipRef.current,
            selectedTrade: selectedTradeRef.current,
            activeTool: activeToolRef.current,
            draggingAnchor: draggingAnchorRef.current,
            isHoldingCtrl: isHoldingCtrlRef.current,
            isHoldingShift: isHoldingShiftRef.current,
            showShiftInfo: showShiftInfo.current,
            shiftInfoAnchor: shiftAnchorRef.current,
            shiftInfoAnchor2: shiftAnchor2Ref.current,
            //drawings
            tradeLineInteraction: tradeLineInteractionRef.current,
            selectedDrawingId: selectedDrawingIdRef.current,
            hoveredDrawingId: hoveredDrawingIdRef.current,
            hotAnchor: hotAnchorRef.current,
            editingTextId: editingTextIdRef.current,
            transformer,
            sessionMapper: sessionMapperRef.current,
            //chart type plugins
            isPluginChartType: pluginChartTypesRef.current.has(chartSettingsRef.current.chartType),
            chartPlugin: pluginChartTypesRef.current.get(chartSettingsRef.current.chartType),
            pluginComputed: pluginChartTypeComputedRef.current.get(
                chartSettingsRef.current.chartType,
            ),
            dataLevel: dataLevelRef.current,
            accountSnapshot: accountSnapRef.current,
            symbolInfo: resolvedSymbolInfoRef.current,
            priceScaleWidth: priceScaleWidthRef.current,
            hidePriceScale,
            hideTimeScale,
            syncCrosshair: syncCrosshairRef.current,
        });

        publishCrosshairSync();
    }

    // Sync in layout: crosshair
    // This pane broadcasts where its pointer is in DATA space (time + price), not
    // pixels, and only when that lands somewhere new. Followers keep the payload
    // and re-project it as they paint, so mirroring costs one conversion on the
    // hovered chart and one per follower per repaint - never a conversion per
    // chart per frame.

    /** Position mirrored from whichever other cell owns the pointer. */
    const syncCrosshairRef = useRef<CrosshairSync | null>(null);
    /** Last payload this pane put on the bus, to suppress duplicates. */
    const lastCrosshairSyncRef = useRef<CrosshairSync | null>(null);

    function clearCrosshairSync() {
        if (!lastCrosshairSyncRef.current) return;
        lastCrosshairSyncRef.current = null;
        eventBus.emit('layout:crosshair', null);
    }

    function publishCrosshairSync() {
        if (!syncInLayoutRef.current.crosshair) {
            clearCrosshairSync();
            return;
        }

        const ch = crosshairRef.current;
        const canvas = uiCanvasRef.current;
        if (!ch || !canvas || !viewRef.current) {
            clearCrosshairSync();
            return;
        }

        const layouts = layoutsCacheRef.current;
        const pane = panesRef.current.find((p) => {
            const l = layouts[p.id];
            return l && ch.y >= l.y && ch.y < l.y + l.h;
        });
        const rect = pane ? layouts[pane.id] : null;
        if (!pane || !rect || rect.h < 2) {
            clearCrosshairSync();
            return;
        }

        const chartW = canvas.width / getEffectiveDpr() - priceScaleWidthRef.current;
        if (chartW <= 0) return;

        // Parked on the price scale, or dragged clean off this cell (the move
        // handler is on window, so a drag keeps feeding us coordinates that are
        // no longer over our canvas): nothing here for the others to mirror.
        if (ch.x < 0 || ch.x >= chartW) {
            clearCrosshairSync();
            return;
        }

        const localY = ch.y - rect.y;
        const next: CrosshairSync = {
            id: _id,
            ts: transformer.xToTs(ch.x, chartW),
            // Only the main pane's scale is a price; an indicator pane's units
            // mean nothing on another chart, so followers fall back to yFrac.
            price: pane.isMain ? transformer.yToPrice(localY, rect.h) : 0,
            paneId: pane.id,
            yFrac: localY / rect.h,
            symbol: cellSymbolRef.current ?? null,
        };

        const prev = lastCrosshairSyncRef.current;
        if (
            prev &&
            prev.ts === next.ts &&
            prev.price === next.price &&
            prev.paneId === next.paneId &&
            prev.yFrac === next.yFrac &&
            prev.symbol === next.symbol
        ) {
            return;
        }

        lastCrosshairSyncRef.current = next;
        eventBus.emit('layout:crosshair', next);
    }

    /**
     * Take (or drop) the crosshair another cell is broadcasting.
     *
     * Only the payload is stored - the pixel position is worked out at paint
     * time. The status line follows too, so a mirrored crosshair reads out the
     * bar it is actually pointing at on THIS chart, at THIS chart's timeframe.
     */
    function applyCrosshairSync(sync: CrosshairSync | null) {
        const next = sync && syncInLayoutRef.current.crosshair ? sync : null;
        if (!next && !syncCrosshairRef.current) return;

        syncCrosshairRef.current = next;
        pushDrawParams();
        renderEngineRef.current?.markDirty('ui');

        if (!next || !viewRef.current) return;

        // Same ~30fps budget the pointer-owning chart gives its own status line;
        // this one is driven by someone else's pointer but costs the same render.
        const now = performance.now();
        if (now - lastSyncStatusUpdateRef.current <= 33) return;
        lastSyncStatusUpdateRef.current = now;

        const canvas = uiCanvasRef.current;
        if (!canvas) return;
        const chartW = canvas.width / getEffectiveDpr() - priceScaleWidthRef.current;
        if (chartW <= 0) return;
        const x = transformer.tsToX(next.ts, chartW);
        if (!Number.isFinite(x) || x < 0 || x >= chartW) return;

        eventBus.emit('status:compute', {
            cellId: _id,
            x,
            priceHistory: priceHistoryRef.current,
            trades: tradesRef.current,
            bounds: viewRef.current,
            chartW,
            barNs: activeTimeframeRef.current.barNs,
            candleCache: candleCacheRef.current,
            bars: ohlcvBarsRef.current.display,
            openBar: openBarRef.current,
            horizon: horizonRef.current,
            dataLevel: dataLevelRef.current,
            transformer,
        });
    }

    const lastSyncStatusUpdateRef = useRef(0);

    // Defaulted: ChartOuter always passes this, but ChartInner is also mounted
    // directly in tests/embeds where a missing switch set must not throw.
    const syncInLayoutRef = useRef(syncInLayout ?? DEFAULT_SYNC_IN_LAYOUT);
    useEffect(() => {
        syncInLayoutRef.current = syncInLayout ?? DEFAULT_SYNC_IN_LAYOUT;
        // Turning the switch off has to take effect now, not on the next pointer
        // move: drop anything we are mirroring and stop mirroring ourselves.
        if (!syncInLayoutRef.current.crosshair) {
            clearCrosshairSync();
            if (syncCrosshairRef.current) {
                syncCrosshairRef.current = null;
                pushDrawParamsRef.current?.();
                renderEngineRef.current?.markDirty('ui');
            }
        }
    }, [syncInLayout]);

    // Sync in layout: time / date range
    // Published by the cell being scrolled or zoomed. Receivers apply it and do
    // NOT re-publish (see applyTimeRangeSync), so a layout can't oscillate.

    const applyingTimeRangeRef = useRef(false);
    const lastTimeRangeSyncRef = useRef<{ tMin: bigint; tMax: bigint } | null>(null);

    function publishTimeRangeSync() {
        if (applyingTimeRangeRef.current) return;
        const sync = syncInLayoutRef.current;
        if (!sync.time && !sync.dateRange) return;
        const view = viewRef.current;
        if (!view) return;

        const prev = lastTimeRangeSyncRef.current;
        if (prev && prev.tMin === view.tMin && prev.tMax === view.tMax) return;
        lastTimeRangeSyncRef.current = { tMin: view.tMin, tMax: view.tMax };

        eventBus.emit('layout:time-range', { id: _id, tMin: view.tMin, tMax: view.tMax });
    }

    /**
     * Follow another cell's time axis.
     *
     * `dateRange` takes the range verbatim - both cells end up showing exactly
     * the same span, whatever their timeframes. `time` only follows the right
     * edge, so each cell keeps the zoom level (bar count) the user gave it.
     */
    function applyTimeRangeSync({ tMin, tMax }: TimeRangeSync) {
        const view = viewRef.current;
        if (!view) return;
        const sync = syncInLayoutRef.current;

        const next = { tMin, tMax };
        if (!sync.dateRange) {
            const span = view.tMax - view.tMin;
            if (span <= 0n) return;
            next.tMin = tMax - span;
            next.tMax = tMax;
        }

        const clamped = { ...view, ...next } as ViewBounds;
        clampPanView(clamped);
        if (clamped.tMin === view.tMin && clamped.tMax === view.tMax) return;

        view.tMin = clamped.tMin;
        view.tMax = clamped.tMax;

        // Applying is not a user gesture: record the range as already published
        // and gate the publisher, so the follower never answers back.
        lastTimeRangeSyncRef.current = { tMin: view.tMin, tMax: view.tMax };
        applyingTimeRangeRef.current = true;
        try {
            afterViewChange();
        } finally {
            applyingTimeRangeRef.current = false;
        }
    }

    //#endregion Render Engine

    const resolvedSessionRef = useRef<TradingSession | null>(null);
    const resolvedSymbolInfoRef = useRef<SymbolInfo | null>(null);

    //#endregion
    //
    const activeCtxRef = useRef<PluginToolActiveContext | null>(null);

    const sessionMapperRef = useRef<SessionMapper>(createSessionMapper());

    const [showTimeframeWindow, setShowTimeframeWindow] = useState(false);
    const showTimeframeWindowRef = useRef(false);
    useEffect(() => {
        showTimeframeWindowRef.current = showTimeframeWindow;
    }, [showTimeframeWindow]);
    const [timeframeWindowInput, setTimeframeWindowInput] = useState('');

    // tradesRef / priceHistoryRef always hold the FULL dataset - never sliced.
    // During playback the renderer clips naturally to bounds.tMax === horizonRef,
    // so future events are invisible without any per-tick array allocation.
    type ShiftAnchor = { ts: bigint; price: number; x: number; y: number };

    const shiftAnchorRef = useRef<ShiftAnchor | null>(null);
    const shiftAnchor2Ref = useRef<ShiftAnchor | null>(null);
    const showShiftInfo = useRef(false);
    const isHoldingCtrlRef = useRef(false);
    const isHoldingShiftRef = useRef(false);
    const chartSettingsRef = useRef<ChartSettings>(DEFAULT_CHART_SETTINGS);

    // Right price-axis width (css px). Derived automatically from the symbol's
    // price precision and the visible price range - never a user setting. Kept
    // here as the single source of truth so draw, hit-test and layout all agree.
    // Recomputed in pushDrawParams whenever anything that affects it changes.
    const priceScaleWidthRef = useRef<number>(64);

    // Throttle status:compute event bus emissions to ~30fps to avoid unnecessary work.
    const lastStatusLineUpdateRef = useRef(0);

    // FIX #3: rAF scheduling - never call draw functions synchronously
    // Base and UI redraws are coalesced per animation frame. This means even if
    // pan/zoom triggers 10 redraws in one event handler, only 1 canvas paint
    // happens per frame. The UI canvas (crosshair) has its own independent rAF
    // so it's never gated behind the heavier base redraw.

    type ContextMenuTarget = 'chart' | 'xaxis';
    const [contextMenu, setContextMenu] = useState<{
        x: number;
        y: number;
        target: ContextMenuTarget;
        priceAtClick: number | null;
    } | null>(null);
    const contextMenuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!contextMenu) return;
        const handler = (e: MouseEvent) => {
            if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
                setContextMenu(null);
            }
        };
        window.addEventListener('mousedown', handler);
        return () => window.removeEventListener('mousedown', handler);
    }, [contextMenu]);

    // Timeframe
    const [activeTimeframe, setActiveTimeframe] = useState<Timeframe>(initialState.timeframe);
    const activeTimeframeRef = useRef<Timeframe>(initialState.timeframe);

    useEffect(() => {
        activeTimeframeRef.current = activeTimeframe;
        // Mirror this pane's timeframe into its model (persisted representation
        // for serialize/restore). ChartInner stays the live owner.
        model.setTimeframe(activeTimeframe);
        if (compactBufRef.current.length > 0) {
            // invalidate bar OHLCV cache and open bar on TF change
            candleCacheRef.current = null;
            openBarRef.current = null;
            openBarTsRef.current = 0n;
            openBarTradeCountRef.current = 0;
            requestFootprintRebuild();
            pushDrawParams();
            renderEngineRef.current?.markDirty('base');
            renderEngineRef.current?.markDirty('drawings');
            updateSettingsBarPos(selectedDrawingIdRef.current);
        }
    }, [activeTimeframe]);

    const [panes, setPanes] = useState<ChartPane[]>([
        {
            id: 'main',
            isMain: true,
            heightRatio: 3,
            symbol: cellSymbol,
            tf: initialState.timeframe.label,
            // exchange is populated from the resolved SymbolInfo on
            // `data:symbol-resolved` (see useChartData), not hardcoded.
            exchange: undefined,
            yMin: 0,
            yMax: 0,
            yAxisAuto: true,
            collapsed: false,
        },
    ]);
    const panesRef = useRef(panes);
    useEffect(() => {
        panesRef.current = panes;
    }, [panes]);

    const [indicators, setIndicators] = useState<Indicator[]>([]);
    const indicatorsRef = useRef(indicators);
    useEffect(() => {
        indicatorsRef.current = indicators;
    }, [indicators]);

    // Mirror this pane's active indicators into its model as plugin references -
    // the persisted representation for serialize/restore. The plugin code lives
    // once in the shared pool (referenced by `id`); each ref carries only the
    // instance + its config. Both built-in and plugin indicators land in this
    // list, so this captures everything the pane has activated.
    useEffect(() => {
        model.setPlugins(
            indicators.map((ind) => ({
                id: ind.id.replace(/:(\d+)$/, ''),
                instanceId: ind.id,
                config: {
                    settings: ind.settings ?? {},
                    visible: ind.visible,
                    layout: ind.layout,
                    paneId: ind.paneId,
                },
            })),
        );
    }, [indicators, model]);

    const draggingDividerRef = useRef<number>(-1);
    const dragPaneIdRef = useRef<string | null>(null);

    const hoveredPaneIdRef = useRef<string | null>(null);
    const [maximizedPaneId, setMaximizedPaneId] = useState<string | null>(null);
    const hoveredDividerIdxRef = useRef<number>(-1);
    const hoveredDividerIdxRefLocked = useRef(false);
    const hoveringLegend = useRef(false);

    // up here so the useChartData call below can take them
    const horizonRef = useRef<bigint>(0n);
    const viewRef = useRef<ViewBounds | null>(null);
    const isYAxisAutoRef = useRef(true);
    const isDragging = useRef(false);
    const dragMode = useRef<'pan' | 'scaleY' | 'scaleX' | 'none'>('none');
    const selectedDrawingIdRef = useRef<string | null>(null);

    // Late-bound refs - filled in after hook call to break circular deps
    const pushDrawParamsRef = useRef<() => void>(() => {});
    const autofitIndicatorPanesRef = useRef<() => void>(() => {});
    const updateSettingsBarPosRef = useRef<(id: string | null) => void>(() => {});
    const resetViewRef = useRef<() => void>(() => {});
    const syncPixelLayoutsRef = useRef<(panes?: ChartPane[]) => void>(() => {});
    const doBaseRedrawRef = useRef<() => void>(() => {});

    const {
        layoutsCacheRef,
        legendElemsRef,
        panePixelLayouts,
        recomputeLayouts,
        getLayouts,
        syncPixelLayouts,
        applyLayoutsToDom,
    } = useChartLayout({
        baseCanvasRef,
        panesRef,
        chartSettingsRef,
        priceScaleWidthRef,
        hideTimeScale,
    });

    const chartData = useChartData({
        eventBus,
        activeTimeframeRef,
        horizonRef,
        chartSettingsRef,
        sessionMapperRef,
        resolvedSessionRef,
        resolvedSymbolInfoRef,
        viewRef,
        priceScaleWidthRef,
        panesRef,
        indicatorsRef,
        transformer,
        renderEngineRef,
        isYAxisAutoRef,
        isDragging,
        dragMode,
        layoutsCacheRef,
        baseCanvasRef,
        selectedDrawingIdRef,
        pushDrawParamsRef,
        autofitIndicatorPanesRef,
        updateSettingsBarPosRef,
        resetViewRef,
        syncPixelLayoutsRef,
        doBaseRedrawRef,
        setIndicators,
        setPanes,
        getPanel: () => null,
        onDataBoundsChange,
        onHorizonUpdate,
        cellSymbol,
        cellId: _id,
        managed,
        externalDomPanelRef,
        hidePriceScale,
        hideTimeScale,
        onDataLevelChangeRef: _enforceDataLevelRef,
    });

    const {
        compactBufRef,
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
        dataLevelRef,
        datasetStartRef,
        datasetEndRef,
        prevSessionStatusRef,
        candleCacheRef,
        heatmapBitmapRef,
        heatmapBitmapOffsetsRef,
        cacheBoundsRef,
        liveBookRef,
        horizonScrollAnimRef,
        _internalDomPanelRef,
        seekHorizon,
        gotoRange,
        scheduleResample,
        runIndicatorWorker,
        getTradesUpToHorizon,
        requestFootprintRebuild,
        syncOhlcvOpenBar,
        rebuildCandleCache,
        rebuildContrastBitmap,
        updatePriceHistoryToRawIdx,
        findPriceHistoryIdx,
        loadData,
    } = chartData;

    // hand the forming bar to DepthChart so ctx.openBar() can reach it. a getter,
    // not the bar: openBarRef.current is replaced on every bar close and mutated
    // in place in between
    useEffect(() => {
        eventBus.emit('data:open-bar-provider', {
            cellId: _id,
            get: () => openBarRef.current,
        });
        return () => {
            eventBus.emit('data:open-bar-provider', { cellId: _id, get: null });
        };
    }, [eventBus, _id]);

    const getPanel = () => externalDomPanelRef?.current ?? _internalDomPanelRef.current;

    // pushDrawParams is a hoisted function declaration - safe to bind immediately
    pushDrawParamsRef.current = pushDrawParams;

    const drawingsCanvasRef = useRef<HTMLCanvasElement>(null);

    const { doBaseRedraw: _doBaseRedraw } = useRenderEngine({
        renderEngineRef,
        baseCanvasRef,
        drawingsCanvasRef,
        uiCanvasRef,
        eventBus,
        chartId: _id,
        viewRef,
        priceScaleWidthRef,
        tradesRef,
        getLayouts,
        heatmapBitmapRef,
        cacheBoundsRef,
        heatmapBitmapOffsetsRef,
        panesRef,
        indicatorsRef,
        priceHistoryRef,
        footprintBarsRef,
        activeTimeframeRef,
        chartSettingsRef,
        horizonRef,
        candleCacheRef,
        openBarRef,
        dataLevelRef,
        ohlcvBarsRef,
        previewBarsRef,
        transformer,
        hideTimeScale,
    });

    const {
        pluginChartTypesRef,
        activeChartTypeBottomBarIds,
        setPluginChartTypes,
        pluginChartTypeComputedRef,
        activatePluginIndicator,
        replacePluginIndicator,
        buildChartTypeActiveCtx,
    } = useChartPlugin({
        renderEngineRef,
        uiCanvasRef,
        eventBus,
        indicatorsRef,
        panesRef,
        horizonRef,
        activeTimeframeRef,
        dataLevelRef,
        setPanes,
        setIndicators,
        runIndicatorWorker,
        getTradesUpToHorizon,
        pushDrawParams,
    });

    const crosshairRef = useRef<Crosshair>(null);
    const lastMouse = useRef({ x: 0, y: 0 });
    const hasDragged = useRef(false);
    const selectedTradeRef = useRef<TradePoint | null>(null);

    const chartAreaRef = useRef<HTMLDivElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const viewAnimRef = useRef<number | null>(null);
    // Always-current symbol for this pane, readable from the stable closures
    // below (the drawingsRef proxy, the store subscription). The prop is the
    // authoritative symbol across renders; onSymbolChange keeps it fresh within a
    // render before the prop propagates.
    const cellSymbolRef = useRef(cellSymbol);
    // True once this pane has ingested data for the symbol it currently shows -
    // i.e. it has something on screen. Only a symbol change invalidates it: the
    // held data then belongs to the old symbol and there is genuinely nothing to
    // draw. See the data:status subscription for what it gates.
    const paneHasDataRef = useRef(false);
    if (cellSymbolRef.current !== cellSymbol) paneHasDataRef.current = false;
    cellSymbolRef.current = cellSymbol;

    // drawingsRef is a stable proxy over the controller's per-symbol DrawingStore:
    // reads return this pane's current-symbol bucket, writes route into the store
    // (notifying subscribers). Every existing `drawingsRef.current` read/write
    // keeps working unchanged, while the store becomes the single source of truth
    // - so drawings persist per-symbol and are shared live between same-symbol panes.
    // Set while THIS pane writes to the store, so its own store notification is
    // skipped (the write sites already repaint) - only external changes drive the
    // subscription's repaint, keeping drawing drags single-pass.
    const suppressSelfRef = useRef(false);
    const drawingsProxyRef = useRef<React.MutableRefObject<Drawing[]> | null>(null);
    if (!drawingsProxyRef.current) {
        drawingsProxyRef.current = {
            get current(): Drawing[] {
                return drawingStore.forSymbol(cellSymbolRef.current) as Drawing[];
            },
            set current(next: Drawing[]) {
                suppressSelfRef.current = true;
                drawingStore.setForSymbol(cellSymbolRef.current, next);
                suppressSelfRef.current = false;
            },
        };
    }
    const drawingsRef = drawingsProxyRef.current;

    // Repaint when this pane's symbol bucket changes - a symbol switch, a restore,
    // or another pane editing the same symbol. pushDrawParams re-snapshots the (new)
    // drawings array into the RenderEngine's params; markDirty redraws. Self-writes
    // are suppressed above since their write site already repaints.
    useEffect(() => {
        const repaint = () => {
            if (suppressSelfRef.current) return;
            pushDrawParamsRef.current?.();
            renderEngineRef.current?.markDirty('drawings');
        };
        repaint();
        return drawingStore.subscribe(cellSymbol, repaint);
    }, [drawingStore, cellSymbol]);
    const draftRef = useRef<DraftDrawing | null>(null);
    const [pendingText, setPendingText] = useState<{ x: number; y: number; anchor: Anchor } | null>(
        null,
    );
    const [editingTextId, setEditingTextId] = useState<string | null>(null);
    const editingTextIdRef = useRef<string | null>(null);
    useEffect(() => {
        editingTextIdRef.current = editingTextId;
        pushDrawParams();
        renderEngineRef.current?.markDirty('drawings');
    }, [editingTextId]);

    const hoveredDrawingIdRef = useRef<string | null>(null);
    const hotAnchorRef = useRef<DrawingAnchorId | null>(null);
    const draggingAnchorRef = useRef<{ drawingId: string; anchor: DrawingAnchorId } | null>(null);
    const dragStartRef = useRef<{ x: number; y: number } | null>(null);
    const dragPrevDataRef = useRef<{ ts: bigint; price: number } | null>(null);
    const dragPrevPixelRef = useRef<{ x: number; y: number } | null>(null);

    const fvpLiveRecalcRef = useRef(true);

    const tradeLinesRef = useRef<TradeLine[]>([]);
    const hitMapRef = useRef<TradeLineHitMap>({ lines: [], pricePills: [], ghostPills: [] });

    /**
     * Ghost lines for an order that hasn't been placed yet.
     *
     * Kept apart from the real ones and re-merged on every change, so a preview
     * can never outlive the ticket that emitted it, and a drag of a real line
     * (which writes the whole array back) can't strand one.
     */
    const previewLinesRef = useRef<TradeLine[]>([]);
    /**
     * The real lines, as last published by the prop or by a drag.
     *
     * Held separately from the preview so the merge is the single way the
     * rendered array is built: the drag machinery writes the whole array back
     * when a line moves, and without splitting them a drag of a real line would
     * either drop the previews or freeze a stale copy of them.
     */
    const realLinesRef = useRef<TradeLine[]>([]);
    const syncTradeLines = useCallback(() => {
        tradeLinesRef.current = [...realLinesRef.current, ...previewLinesRef.current];
        pushDrawParams();
        renderEngineRef.current?.markDirty('ui');
    }, []);

    /** Live lookup, so a preview can be grabbed without a React render. */
    const resolveTradeLine = useCallback(
        (id: string) => tradeLinesRef.current.find((line) => line.id === id),
        [],
    );

    useEffect(() => {
        if (tradeLines === undefined) return;
        realLinesRef.current = tradeLines;
        syncTradeLines();
    }, [tradeLines, syncTradeLines]);

    useEffect(() => {
        return eventBus.on('trading:preview', ({ lines, symbol }) => {
            // Only this pane's instrument: one bus serves every cell, and a
            // preview belongs to the symbol the ticket is writing an order for.
            if (symbol && symbol !== cellSymbolRef.current) return;
            previewLinesRef.current = lines;
            syncTradeLines();
        });
    }, [eventBus, syncTradeLines]);

    const [activeTool, setActiveTool] = useState<ActiveDrawingTool>(CURSOR_TOOL);
    const activeToolRef = useRef<ActiveDrawingTool>(CURSOR_TOOL);
    useEffect(() => {
        setStatePatch('activeTool', activeTool);
    }, [activeTool]);
    const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null);
    // Mirrored into chart state so DepthChart.getSelectedDrawing() can
    // resolve it against the drawing store.
    useEffect(() => {
        setStatePatch('selectedDrawingId', selectedDrawingId);
    }, [selectedDrawingId]);
    const [openSettingsDialog, setOpenSettingsDialog] = useState(false);
    useEffect(() => {
        if (openSettingsDialog) setOpenSettingsDialog(false);
    }, [openSettingsDialog]);
    const [settingsBarPos, setSettingsBarPos] = useState<{ x: number; y: number } | null>(null);

    const [indicatorSettingsId, setIndicatorSettingsId] = useState<string | null>(null);

    const updateSettingsBarPos = useCallback((id: string | null) => {
        if (!id) {
            setSettingsBarPos(null);
            return;
        }
        const d = drawingsRef.current.find((d) => d.id === id);
        const canvas = drawingsCanvasRef.current;
        const view = viewRef.current;
        if (!d || !canvas || !view) {
            setSettingsBarPos(null);
            return;
        }
        const pos = getDrawingLabelAnchor(
            d,
            view,
            panesRef.current,
            canvas.width,
            canvas.height,
            transformer,
            hideTimeScale,
            priceScaleWidthRef.current,
        );
        // Bail on an unchanged position. This is called on every pointer move of
        // a pan, and a fresh object each time re-rendered the whole pane - the
        // one React render in the drag path - for a toolbar that hadn't moved.
        setSettingsBarPos((prev) =>
            prev && pos && prev.x === pos.x && prev.y === pos.y ? prev : pos,
        );
    }, []);

    useEffect(() => {
        activeToolRef.current = activeTool;
    }, [activeTool]);
    useEffect(() => {
        selectedDrawingIdRef.current = selectedDrawingId;
        updateSettingsBarPos(selectedDrawingId);
    }, [selectedDrawingId]);

    const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
    const [errorInfo, setErrorInfo] = useState<{ code: string; message: string } | null>(null);

    useEffect(() => {
        const unsub = eventBus.on('data:status', ({ status, error, symbol }) => {
            // Every chart cell shares one eventBus. A symbol-scoped status belongs
            // to whichever cells display that symbol - without this, switching
            // symbol on one pane flashes "Getting market data" on all of them.
            // No symbol = chart-wide, so every cell takes it.
            if (symbol !== undefined && symbol !== cellSymbolRef.current) return;
            if (status === 'ready' && symbol !== undefined) paneHasDataRef.current = true;
            // The overlay means "nothing to show". A symbol-scoped load is a full
            // refetch of that symbol, which another pane can trigger just by
            // switching onto a symbol we are already displaying - so when we have
            // a chart up, let it refresh underneath us and swap in the new data
            // when it lands rather than blanking a pane the user didn't touch.
            if (status === 'loading' && symbol !== undefined && paneHasDataRef.current) return;
            setStatus(status);
            if (error) setErrorInfo(error);
        });
        return unsub;
    }, []);
    useEffect(() => {
        const unsub = [
            eventBus.on('data:bounds', ({ start, end, symbol }) => {
                // Another cell's dataset edges are not ours - taking them would
                // clamp panning and trigger backward fetches against the wrong
                // instrument's history. (Undefined symbol = chart-wide, take it.)
                if (symbol !== undefined && symbol !== cellSymbolRef.current) return;
                datasetStartRef.current = start;
                datasetEndRef.current = end;
                onDataBoundsChange?.(start, end);
            }),
        ];
        return unsub.forEach((fn) => fn());
    }, []);

    const { chartSettings, setChartSettings } = useChartSettings({
        chartSettingsRef,
        isYAxisAutoRef,
        viewRef,
        priceHistoryRef,
        tradesRef,
        dataLevelRef,
        ohlcvBarsRef,
        previewBarsRef,
        openBarRef,
        horizonRef,
        compactBufRef,
        selectedDrawingIdRef,
        renderEngineRef,
        scheduleResample,
        rebuildContrastBitmap,
        requestFootprintRebuild,
        pushDrawParams,
        updateSettingsBarPos,
        hidePriceScale,
        hideTimeScale,
        modelSettings: model.settings as ChartSettings,
    });

    // Mirror this pane's live settings into its ChartModel - the persisted
    // representation read by serialize/restore. ChartInner stays the live owner;
    // the model trails it by a tick. (Restore reads model.settings back in here on
    // init; wired with the serialization step.)
    useEffect(() => {
        model.setSettings(chartSettings);
    }, [chartSettings, model]);

    const { resetYAxis, resetXAxis, resetView, autofitPanesSilent, autofitIndicatorPanes } =
        useChartView({
            viewRef,
            transformer,
            isYAxisAutoRef,
            setChartSettings,
            priceHistoryRef,
            tradesRef,
            previewBarsRef,
            ohlcvBarsRef,
            openBarRef,
            chartSettingsRef,
            horizonRef,
            dataLevelRef,
            activeTimeframeRef,
            scheduleResample,
            pushDrawParams,
            publishTimeRangeSync,
            renderEngineRef,
            updateSettingsBarPos,
            selectedDrawingIdRef,
            panesRef,
            indicatorsRef,
            setPanes,
        });

    resetViewRef.current = resetView;
    autofitIndicatorPanesRef.current = autofitIndicatorPanes;

    const showTooltipRef = useRef(false);
    const longPressTimer = useRef<NodeJS.Timeout | null>(null);

    const tradeLineChartWRef = useRef<number>(0);
    const tradeLineChartHRef = useRef<number>(0);
    const tradeLineChartOYRef = useRef<number>(0);

    const tradeLineInteraction = useTradeLines({
        tradeLines: tradeLinesRef.current,
        resolveLine: resolveTradeLine,
        // Every write-back keeps only the real lines and re-merges, so the
        // previews are appended by exactly one code path and a drag can never
        // drop them or leave a stale copy behind.
        onLinesChange: (t) => {
            realLinesRef.current = t.filter((line) => !line.preview);
            syncTradeLines();
        },
        onSyncLines: (lines) => {
            realLinesRef.current = lines.filter((line) => !line.preview);
            syncTradeLines();
        },
        onLineDelete: (l) => {
            realLinesRef.current = realLinesRef.current.filter((line) => line.id !== l.id);
            previewLinesRef.current = previewLinesRef.current.filter((line) => line.id !== l.id);
            syncTradeLines();
        },
        hitMapRef,
        chartWRef: tradeLineChartWRef,
        chartHRef: tradeLineChartHRef,
        chartOYRef: tradeLineChartOYRef,
        getLayouts,
        boundsRef: viewRef,
        chartSettingsRef,
        redraw: () => {
            redrawTrading();
            pushDrawParams();
            renderEngineRef.current?.markDirty('ui');
        }, // your existing fast-redraw trigger
        symbolInfoRef: resolvedSymbolInfoRef,
        onGhostMove,
        linesRef,
        draggingLineIdRef,
        transformer,
    });

    // Stable ref so native event listeners (which close over this ref once)
    // always call the latest interaction callbacks without needing to re-register.
    const tradeLineInteractionRef = useRef(tradeLineInteraction);
    tradeLineInteractionRef.current = tradeLineInteraction;

    useEffect(() => {
        if (status === 'ready') {
            pushDrawParams();
            renderEngineRef.current?.markDirty('base');
            renderEngineRef.current?.markDirty('drawings');
            updateSettingsBarPos(selectedDrawingIdRef.current);
            scheduleResample();
        }
    }, [status]);

    useEffect(() => {
        syncPixelLayouts();
        pushDrawParams();
        renderEngineRef.current?.markAllDirty();
    }, [panes, status]);

    // Everything the canvas paints from lives in refs, and each mutation site
    // re-snapshots them by hand. A site that marks dirty without pushing - or
    // pushes before the state it reads has landed (activatePluginIndicator pushes
    // before the new pane's layout exists) - leaves the engine holding the
    // previous snapshot, and the chart only catches up on the next unrelated
    // redraw. That's the "add an indicator, pan to see it" gap.
    //
    // Declared after the ref-sync and layout effects above, so by the time this
    // runs the refs and pane rects are both current.
    useEffect(() => {
        pushDrawParams();
        renderEngineRef.current?.markDirty('base');
        renderEngineRef.current?.markDirty('ui');
    }, [indicators]);

    const {
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
    } = useChartHandlers({
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
        hideTimeScale,
        priceScaleWidthRef,
    });

    useChartSubscriptions({
        eventBus,
        chartId: _id,
        account,
        pluginChartTypesRef,
        activeChartTypeBottomBarIds,
        hitMapRef,
        indicatorsRef,
        panesRef,
        renderEngineRef,
        horizonRef,
        activeTimeframeRef,
        chartSettingsRef,
        pluginChartTypeComputedRef,
        dataLevelRef,
        previewBarsRef,
        candleCacheRef,
        ohlcvBarsRef,
        openBarRef,
        viewRef,
        accountSnapRef,
        setActiveTool,
        setActiveTimeframe,
        handleTimeframeChange,
        setPanes,
        setIndicators,
        setPluginChartTypes,
        setChartSettings,
        resetView,
        gotoRange,
        buildChartTypeActiveCtx,
        pushDrawParams,
        runIndicatorWorker,
        getTradesUpToHorizon,
        syncPixelLayouts,
        autofitIndicatorPanes,
        handleAddIndicator,
        handleRemoveIndicator,
        onSymbolChange: (symbol) => {
            // Whatever is drawn belongs to the old symbol, so this pane has
            // nothing valid to show until the new symbol lands - let its loading
            // status through. Runs before the load starts (the engine defers it
            // through _loadChain), so the overlay is never missed.
            if (symbol !== cellSymbolRef.current) paneHasDataRef.current = false;
            cellSymbol = symbol;
            cellSymbolRef.current = symbol;
            // Render this symbol's drawing bucket (the proxy now resolves to it).
            pushDrawParamsRef.current?.();
            renderEngineRef.current?.markDirty('drawings');
        },
        syncInLayoutRef,
        applyCrosshairSync,
        applyTimeRangeSync,
    });

    useChartInteraction({
        status,
        cellId: _id,
        baseCanvasRef,
        uiCanvasRef,
        chartAreaRef,
        containerRef,
        viewRef,
        priceScaleWidthRef,
        symbolInfoRef: resolvedSymbolInfoRef,
        layoutsCacheRef,
        isYAxisAutoRef,
        drawingsRef,
        draftRef,
        selectedDrawingIdRef,
        hoveredDrawingIdRef,
        hotAnchorRef,
        draggingAnchorRef,
        dragStartRef,
        dragPrevDataRef,
        dragPrevPixelRef,
        fvpLiveRecalcRef,
        activeCtxRef,
        panesRef,
        indicatorsRef,
        draggingDividerRef,
        dragPaneIdRef,
        hoveredDividerIdxRef,
        hoveredDividerIdxRefLocked,
        hoveredPaneIdRef,
        activeToolRef,
        chartSettingsRef,
        activeTimeframeRef,
        sessionMapperRef,
        resolvedSessionRef,
        renderEngineRef,
        pluginChartTypesRef,
        activeChartTypeBottomBarIds,
        crosshairRef,
        isDragging,
        dragMode,
        isHoldingCtrlRef,
        isHoldingShiftRef,
        lastMouse,
        hasDragged,
        longPressTimer,
        showTooltipRef,
        shiftAnchorRef,
        shiftAnchor2Ref,
        showShiftInfo,
        lastStatusLineUpdateRef,
        horizonRef,
        tradesRef,
        priceHistoryRef,
        allPriceHistoryRef,
        ohlcvBarsRef,
        previewBarsRef,
        dataLevelRef,
        openBarRef,
        candleCacheRef,
        footprintBarsRef,
        datasetStartRef,
        datasetEndRef,
        horizonScrollAnimRef,
        liveBookRef,
        tradeLineInteractionRef,
        selectedTradeRef,
        transformer,
        eventBus,
        features,
        showTimeframeWindowRef,
        setActiveTool,
        setSelectedDrawingId,
        setSettingsBarPos,
        setContextMenu,
        setPanes,
        setChartSettings,
        setEditingTextId,
        setOpenSettingsDialog,
        setShowTimeframeWindow,
        setTimeframeWindowInput,
        setPendingText,
        pushDrawParams,
        publishTimeRangeSync,
        scheduleResample,
        runIndicatorWorker,
        getTradesUpToHorizon,
        updateSettingsBarPos,
        handleDeleteDrawing,
        autofitPanesSilent,
        autofitIndicatorPanes,
        getPanel,
        getLayouts,
        recomputeLayouts,
        syncPixelLayouts,
        applyLayoutsToDom,
        buildChartTypeActiveCtx,
        hideTimeScale,
    });

    // Tell the DataEngine what this pane needs fetched. Shared state only knows
    // the focused pane's timeframe, so without this a pane on a finer one is
    // served the focused pane's bars - a 1m chart drawing hourly candles, one
    // per hour, with gaps between them. Fires on mount and on every symbol or
    // timeframe change, which is exactly when the answer changes.
    useEffect(() => {
        if (!cellSymbol) return;
        eventBus.emit('data:pane-resolution', {
            id: _id,
            symbol: cellSymbol,
            barNs: activeTimeframe.barNs,
        });
        // Withdraw the requirement when this pane goes away (or moves on), so a
        // closed 1m pane doesn't keep the whole layout fetching 1m bars.
        return () => {
            eventBus.emit('data:pane-resolution', { id: _id, symbol: cellSymbol, barNs: 0n });
        };
    }, [eventBus, _id, cellSymbol, activeTimeframe]);

    useEffect(() => {
        return eventBus.on('view:change', () => {
            const _uiCanvas = uiCanvasRef.current;
            const _layouts = getLayouts();
            if (!_uiCanvas) return;
            tradeLineChartWRef.current = _uiCanvas.width - priceScaleWidthRef.current;
            tradeLineChartHRef.current =
                _layouts['main']?.h ?? _uiCanvas.height - (hideTimeScale ? 0 : X_AXIS_HEIGHT);
            tradeLineChartOYRef.current = _layouts['main']?.y ?? 0;
            recomputeLayouts();
            syncPixelLayouts();
            pushDrawParams();
            renderEngineRef.current?.markAllDirty();
        });
    }, [eventBus]);

    // Fade the bottom control menu in only when the pointer is near it. The menu
    // container itself is pointer-events-none (only the buttons are clickable), so
    // panning/dragging the chart still works while the menu is hovered & visible.
    useEffect(() => {
        const area = chartAreaRef.current;
        if (status !== 'ready' || !area) return;
        const PROXIMITY = 100; // px from the menu's edges
        const onMove = (e: MouseEvent) => {
            const menu = menuRef.current;
            if (!menu) return;
            const r = menu.getBoundingClientRect();
            const dx = Math.max(r.left - e.clientX, 0, e.clientX - r.right);
            const dy = Math.max(r.top - e.clientY, 0, e.clientY - r.bottom);
            menu.style.opacity = Math.hypot(dx, dy) < PROXIMITY ? '1' : '0';
        };
        const onLeave = () => {
            if (menuRef.current) menuRef.current.style.opacity = '0';
        };
        area.addEventListener('mousemove', onMove);
        area.addEventListener('mouseleave', onLeave);
        return () => {
            area.removeEventListener('mousemove', onMove);
            area.removeEventListener('mouseleave', onLeave);
        };
    }, [status]);

    // Stop any in-flight view tween when the chart unmounts.
    useEffect(() => {
        return () => {
            if (viewAnimRef.current !== null) cancelAnimationFrame(viewAnimRef.current);
        };
    }, []);

    _seekHorizonRef.current = (h: bigint, recenter?: boolean) =>
        seekHorizon(h, true, true, recenter);
    // Single chokepoint for the timeframe gate.
    //
    // Every route into a timeframe change lands here: the selector and
    // chart.setTimeframe() arrive through the imperative handle, and typing a
    // number on the chart calls it directly - that last one bypassed the
    // selector's check entirely, so a gated timeframe could be reached with the
    // keyboard. `features` is read at call time so runtime grants
    // (chart.allowTimeframes) take effect immediately.
    //
    // Client-side, so it is UX rather than security: it keeps honest users out
    // of states the data layer won't serve. Enforcement that matters belongs to
    // whatever serves the bytes.
    const applyTimeframe = (tf: Timeframe, fromSync = false) => {
        const allowed = features?.timeframe?.timeframes ?? 'any';
        if (allowed !== 'any' && !allowed.includes(tf.label)) {
            eventBus?.emit('timeframe:add-failed', {
                message: 'Timeframe not allowed',
                code: 'TIMEFRAME_NOT_ALLOWED',
                label: tf.label,
            });
            return;
        }
        handleTimeframeChange(tf);
        // Announce it so an interval-synced layout can follow. `fromSync` marks
        // the pane as the follower rather than the source, which is what keeps
        // the fan-out from bouncing back around the layout.
        if (!fromSync) eventBus?.emit('layout:timeframe', { id: _id, tf });
    };

    _handleTimeframeChangeRef.current = applyTimeframe;
    _handleAddIndicatorRef.current = handleAddIndicator;
    _handleToggleIndicatorRef.current = handleToggleIndicator;
    _handleRemoveIndicatorRef.current = handleRemoveIndicator;
    _setActiveToolRef.current = (t: ActiveDrawingTool) => {
        // Plugin tools are registered under their tool *name*, never a drawing id.
        const prevPlugin = drawingRegistry.get(activeToolRef.current.name);
        if (prevPlugin?.onDeactivate) prevPlugin.onDeactivate();

        setActiveTool(t);
        activeToolRef.current = t;

        const nextPlugin = drawingRegistry.get(t.name);
        if (nextPlugin?.onActivate) nextPlugin.onActivate(activeCtxRef.current);
    };
    _getIndicatorsRef.current = () => indicatorsRef.current;
    _getActiveTimeframeRef.current = () => activeTimeframeRef.current;
    _getHorizonRef.current = () => horizonRef.current;
    // A plugin chart type computes from whatever level it declared. Point it at a
    // symbol that serves less and it draws nothing at all - so refuse the switch
    // instead of showing an empty chart. Built-ins arent in the map and answer
    // 'ohlcv', which every level satisfies.
    const chartTypeRefused = (id: string): boolean => {
        const plugin = pluginChartTypesRef.current.get(id);
        if (!plugin) return false;
        const required = plugin.require ?? 'ohlcv';
        const actual = dataLevelRef.current;
        if (!actual || isCompatible(required, actual)) return false;
        eventBus?.emit('plugin:incompatible', {
            id,
            name: plugin.label ?? plugin.name,
            kind: 'chart-type',
            required,
            actual,
        });
        return true;
    };

    // The picker greys these out, so this is for the routes that skip it -
    // chart.applySettings(), the shared settings dialog, a restored save.
    _applySettingsRef.current = (patch: Partial<ChartSettings>) => {
        if (patch.chartType && chartTypeRefused(patch.chartType)) {
            const { chartType: _refused, ...rest } = patch;
            patch = rest;
        }
        setChartSettings((prev) => ({ ...prev, ...patch }));
    };

    // The loaded symbol serves a different level than the last one did, so
    // everything that was fine a moment ago has to be re-asked. Two ways to get
    // here: a symbol switch, and the very first load, which is where a restored
    // chart's saved indicators and chart type finally meet real data - they are
    // rebuilt long before it arrives, when the level is still unknown.
    //
    // Anything left behind would draw nothing and read as broken, so it comes
    // off. Candles is the same fallback an unregistered chart type gets.
    _enforceDataLevelRef.current = () => {
        const actual = dataLevelRef.current;
        if (!actual) return;

        for (const ind of [...indicatorsRef.current]) {
            const required = ind.require ?? 'ohlcv';
            if (isCompatible(required, actual)) continue;
            eventBus?.emit('plugin:incompatible', {
                id: ind.id,
                name: ind.name,
                kind: 'indicator',
                required,
                actual,
            });
            handleRemoveIndicator(ind.id);
        }

        if (chartTypeRefused(chartSettingsRef.current.chartType)) {
            setChartSettings((prev) => ({ ...prev, chartType: 'candles' }));
        }
    };
    _getChartSettingsRef.current = () => chartSettingsRef.current;
    _scheduleResample.current = scheduleResample;
    _handleAddTradeLineRef.current = handleAddTradeLine;
    _activatePluginIndicator.current = activatePluginIndicator;
    _replacePluginIndicator.current = replacePluginIndicator;

    // A data error is an OVERLAY, never an early return.
    //
    // Returning here instead of rendering the chart unmounts the three canvases.
    // The RenderEngine and every native listener bind to those elements once, in
    // []-deps effects that only run on mount - ChartInner itself stays mounted
    // through the error, so they never re-run. Recovering (bad symbol -> good
    // symbol) then mounts brand-new canvas nodes that nothing is attached to, and
    // the chart is permanently blank: no candles, no crosshair, no interaction,
    // just the chrome above it. Keep the canvases mounted and paint over them.
    let errorOverlay: React.ReactNode = null;
    if (status === 'error') {
        errorOverlay = (
            <ChartErrorOverlay
                code={errorInfo?.code ?? 'unknown'}
                message={errorInfo?.message}
                symbol={resolvedSymbolInfoRef.current?.longName ?? cellSymbolRef.current}
                timeframe={activeTimeframe?.label}
                onRetry={() => {
                    // Clear the error before retrying - re-emitting 'error' here
                    // (as this used to) just puts the overlay straight back up.
                    setErrorInfo(null);
                    setStatus('loading');
                    loadData();
                }}
            />
        );
    }

    updateSettingsBarPosRef.current = updateSettingsBarPos;
    syncPixelLayoutsRef.current = syncPixelLayouts;
    doBaseRedrawRef.current = _doBaseRedraw;

    // Bottom control-menu actions (zoom / pan)
    // Shared post-update step: refit axes, request more data if we've scrolled
    // past the dataset start, then resample + repaint. Mirrors the wheel handler.
    const afterViewChange = () => {
        const view = viewRef.current;
        if (!view) return;
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
        autofitPanesSilent();
        if (view.tMin < datasetStartRef.current) {
            eventBus.emit('data:request-backward', {
                viewMin: view.tMin,
                symbol: cellSymbolRef.current,
            });
        }
        scheduleResample();
        pushDrawParams();
        publishTimeRangeSync();
        renderEngineRef.current?.markDirty('base');
        renderEngineRef.current?.markDirty('drawings');
        renderEngineRef.current?.markDirty('ui');
        updateSettingsBarPos(selectedDrawingIdRef.current);
    };

    const clampPanView = (view: ViewBounds) => {
        const start = datasetStartRef.current + activeTimeframeRef.current.barNs / 2n;
        const dataEnd = datasetEndRef.current;
        if (start === 0n || dataEnd === 0n) return;
        const span = view.tMax - view.tMin;
        const horizon = horizonRef.current;
        const end =
            horizon > 0n && horizon < dataEnd
                ? horizon - (activeTimeframeRef.current.barNs * 3n) / 2n
                : dataEnd - (activeTimeframeRef.current.barNs * 3n) / 2n;
        if (view.tMin + span < start) {
            view.tMin = start - span;
            view.tMax = start;
        }
        if (view.tMin > end) {
            view.tMin = end;
            view.tMax = end + span;
        }
    };

    // Tween the view's time bounds to a target over `duration` ms with an
    // ease-out curve. Each frame only marks the canvas dirty (cheap) and pokes
    // the debounced resample, so the heavy heatmap recompute fires once at rest.
    const animateViewTo = (targetTMin: bigint, targetTMax: bigint, duration = 220) => {
        const view = viewRef.current;
        if (!view) return;
        if (viewAnimRef.current !== null) cancelAnimationFrame(viewAnimRef.current);
        const startTMin = view.tMin;
        const startTMax = view.tMax;
        const dMin = Number(targetTMin - startTMin);
        const dMax = Number(targetTMax - startTMax);
        const startTime = performance.now();
        const step = (now: number) => {
            const v = viewRef.current;
            if (!v) {
                viewAnimRef.current = null;
                return;
            }
            const raw = Math.min(1, (now - startTime) / duration);
            const eased = applyHorizonScrollEasing(raw, 'easeOut');
            v.tMin = startTMin + BigInt(Math.round(dMin * eased));
            v.tMax = startTMax + BigInt(Math.round(dMax * eased));
            afterViewChange();
            if (raw < 1) {
                viewAnimRef.current = requestAnimationFrame(step);
            } else {
                viewAnimRef.current = null;
            }
        };
        viewAnimRef.current = requestAnimationFrame(step);
    };

    // factor < 1 zooms in (shorter span), factor > 1 zooms out. Anchored to the
    // right edge (latest bar stays put), matching the default wheel zoom.
    const zoomTime = (factor: number) => {
        const view = viewRef.current;
        if (!view) return;
        const barNs = activeTimeframeRef.current.barNs;
        const minSpan = barNs > 0n ? Number(barNs * 3n) : Number(MIN_TIME_SPAN);
        const maxSpan = barNs > 0n ? Number(barNs * 3400n) : Number(MAX_TIME_SPAN);
        const sm = transformer.getSessionMapper();
        if (sm && sm.hasSession) {
            const mMin = sm.tsToMarket(view.tMin);
            const mMax = sm.tsToMarket(view.tMax);
            const newSpan = Math.max(minSpan, Math.min(maxSpan, Number(mMax - mMin) * factor));
            animateViewTo(sm.marketToTs(mMax - BigInt(Math.round(newSpan))), view.tMax);
        } else {
            const newSpan = Math.max(
                minSpan,
                Math.min(maxSpan, Number(view.tMax - view.tMin) * factor),
            );
            animateViewTo(view.tMax - BigInt(Math.round(newSpan)), view.tMax);
        }
    };

    // dir -1 pans toward older bars (left), +1 toward newer bars (right).
    const panTime = (dir: -1 | 1) => {
        const view = viewRef.current;
        if (!view) return;
        const FRAC = 0.25;
        let targetTMin: bigint;
        let targetTMax: bigint;
        const sm = transformer.getSessionMapper();
        if (sm && sm.hasSession) {
            const mMin = sm.tsToMarket(view.tMin);
            const mMax = sm.tsToMarket(view.tMax);
            const dm = BigInt(Math.round(dir * FRAC * Number(mMax - mMin)));
            targetTMin = sm.marketToTs(mMin + dm);
            targetTMax = sm.marketToTs(mMax + dm);
        } else {
            const dt = BigInt(Math.round(dir * FRAC * Number(view.tMax - view.tMin)));
            targetTMin = view.tMin + dt;
            targetTMax = view.tMax + dt;
        }
        // Clamp the target (not the live view) so the tween lands inside bounds.
        const clamped = { ...view, tMin: targetTMin, tMax: targetTMax } as ViewBounds;
        clampPanView(clamped);
        animateViewTo(clamped.tMin, clamped.tMax);
    };

    return (
        <div
            className="depth-root relative w-full h-full flex flex-col bg-background text-foreground overflow-hidden max-h-screen"
            ref={containerRef}
            tabIndex={0}
        >
            {errorOverlay}
            {status === 'loading' && (
                <ChartLoadingOverlay
                    symbol={resolvedSymbolInfoRef.current?.longName ?? cellSymbolRef.current}
                    timeframe={activeTimeframe?.label}
                />
            )}
            <div className="flex flex-1 min-h-0">
                <div ref={chartAreaRef} className="relative flex-1 min-h-0">
                    <canvas
                        ref={baseCanvasRef}
                        className="absolute inset-0 w-full h-full block touch-none"
                    />
                    <canvas
                        ref={drawingsCanvasRef}
                        className="absolute inset-0 w-full h-full block touch-none pointer-events-none"
                    />
                    <canvas
                        ref={uiCanvasRef}
                        className="absolute inset-0 w-full h-full block touch-none pointer-events-none"
                    />

                    {status === 'ready' && (
                        <div
                            ref={menuRef}
                            style={{ opacity: 0 }}
                            className="absolute left-1/2 bottom-8 -translate-x-1/2 w-fit px-2 backdrop-blur-sm h-8 rounded-lg flex gap-3 items-center transition-opacity duration-200 pointer-events-none"
                        >
                            <div className="flex gap-1">
                                <Tooltip delayDuration={700}>
                                    <TooltipTrigger asChild>
                                        <Button
                                            variant="ghost"
                                            className="p-1 h-6 pointer-events-auto"
                                            onClick={() => zoomTime(1.25)}
                                        >
                                            <Minus className="!w-3.5" />
                                        </Button>
                                    </TooltipTrigger>
                                    <TooltipContent className="border border-border bg-background">
                                        Zoom out
                                    </TooltipContent>
                                </Tooltip>
                                <Tooltip delayDuration={700}>
                                    <TooltipTrigger asChild>
                                        <Button
                                            variant="ghost"
                                            className="p-1 h-6 pointer-events-auto"
                                            onClick={() => zoomTime(0.8)}
                                        >
                                            <Plus className="!w-3.5" />
                                        </Button>
                                    </TooltipTrigger>
                                    <TooltipContent className="border border-border bg-background">
                                        Zoom in
                                    </TooltipContent>
                                </Tooltip>
                            </div>
                            <div className="flex gap-1">
                                <Tooltip delayDuration={700}>
                                    <TooltipTrigger asChild>
                                        <Button
                                            variant="ghost"
                                            className="p-1 h-6 pointer-events-auto"
                                            onClick={() => panTime(-1)}
                                        >
                                            <ChevronLeft className="!w-3.5" />
                                        </Button>
                                    </TooltipTrigger>
                                    <TooltipContent className="border border-border bg-background">
                                        Pan left
                                    </TooltipContent>
                                </Tooltip>
                                <Tooltip delayDuration={700}>
                                    <TooltipTrigger asChild>
                                        <Button
                                            variant="ghost"
                                            className="p-1 h-6 pointer-events-auto"
                                            onClick={() => panTime(1)}
                                        >
                                            <ChevronRight className="!w-3.5" />
                                        </Button>
                                    </TooltipTrigger>
                                    <TooltipContent className="border border-border bg-background">
                                        Pan right
                                    </TooltipContent>
                                </Tooltip>
                            </div>
                            <div className="flex gap-1">
                                <Tooltip delayDuration={700}>
                                    <TooltipTrigger asChild>
                                        <Button
                                            variant="ghost"
                                            className="p-1 h-6 pointer-events-auto"
                                            onClick={() => resetView()}
                                        >
                                            <RotateCcw className="!w-3.5" />
                                        </Button>
                                    </TooltipTrigger>
                                    <TooltipContent className="border border-border bg-background">
                                        Reset view
                                    </TooltipContent>
                                </Tooltip>
                            </div>
                        </div>
                    )}

                    {selectedDrawingId &&
                        settingsBarPos &&
                        (() => {
                            const d = drawingsRef.current.find((d) => d.id === selectedDrawingId);
                            if (!d) return null;
                            return (
                                <>
                                    <DrawingSettingsBar
                                        drawing={d}
                                        containerRef={chartAreaRef}
                                        openDialog={openSettingsDialog}
                                        onUpdate={(patch) =>
                                            handleUpdateDrawing(selectedDrawingId, patch)
                                        }
                                        onDelete={() => handleDeleteDrawing(selectedDrawingId)}
                                        onDuplicate={() =>
                                            handleDuplicateDrawing(selectedDrawingId)
                                        }
                                        onClose={() => {
                                            setSelectedDrawingId(null);
                                            setSettingsBarPos(null);
                                            selectedDrawingIdRef.current = null;
                                            setOpenSettingsDialog(false);
                                            pushDrawParams();
                                            renderEngineRef.current?.markDirty('drawings');
                                        }}
                                        // Asked for on the bus rather than
                                        // handed down: the ticket is a panel
                                        // the host mounts beside the chart, so
                                        // the chart can only put in the
                                        // request. Left off entirely when
                                        // nothing is listening - a host with no
                                        // ticket should get no button, not a
                                        // dead one.
                                        onRequestOrderTicket={
                                            eventBus.hasListeners('trading:ticket-requested')
                                                ? (drawingId: string) =>
                                                      eventBus.emit('trading:ticket-requested', {
                                                          drawingId,
                                                          requestId: nanoid(8),
                                                      })
                                                : undefined
                                        }
                                    />
                                </>
                            );
                        })()}

                    {status === 'ready' &&
                        panes.map((pane, idx) => {
                            const rect = panePixelLayouts[pane.id];
                            if (!rect) return null;
                            const statusBar =
                                pane.isMain && !hideStatusBar ? (
                                    // State, not chartSettingsRef: the ref is synced in an
                                    // effect that runs after this render, so reading it here
                                    // renders the previous settings and only catches up on
                                    // the next unrelated re-render.
                                    <StatusBar
                                        cellId={_id}
                                        chartSettings={chartSettings}
                                        chartType={chartSettings.chartType}
                                        eventBus={eventBus}
                                    />
                                ) : null;
                            return (
                                <div
                                    key={pane.id}
                                    ref={(el) => {
                                        if (el) legendElemsRef.current.set(pane.id, el);
                                        else legendElemsRef.current.delete(pane.id);
                                    }}
                                    className="absolute left-0 pointer-events-none"
                                    style={{
                                        top: rect.y,
                                        height: rect.h,
                                        right: `${priceScaleWidthRef.current}px`,
                                        visibility: rect.h < 2 ? 'hidden' : 'visible',
                                    }}
                                >
                                    <div className="flex flex-row items-center justify-between w-full">
                                        <div className="flex flex-row items-center gap-1 flex-1 min-w-0">
                                            {!hideLegend ? (
                                                <PaneLegend
                                                    pane={pane}
                                                    indicators={indicators}
                                                    onToggleIndicator={handleToggleIndicator}
                                                    onRemoveIndicator={handleRemoveIndicator}
                                                    onOpenSettings={handleOpenIndicatorSettings}
                                                    onOpenTfSelect={() => {
                                                        setTimeframeWindowInput('');
                                                        setShowTimeframeWindow(true);
                                                    }}
                                                    eventBus={eventBus}
                                                    session={resolvedSessionRef.current}
                                                    horizon={horizonRef.current}
                                                    sessionStatus={prevSessionStatusRef.current}
                                                    statusBar={statusBar}
                                                    symbolInfo={resolvedSymbolInfoRef.current}
                                                />
                                            ) : (
                                                statusBar
                                            )}
                                        </div>

                                        <PaneLegendScale
                                            pane={pane}
                                            paneIndex={idx}
                                            totalPanes={panes.length}
                                            onMoveUp={handleMoveUp}
                                            onMoveDown={handleMoveDown}
                                            onRemovePane={handleRemovePane}
                                            onCollapse={handleCollapse}
                                            onExpand={handleExpand}
                                            onMaximize={handleMaximize}
                                            isMaximized={maximizedPaneId === pane.id}
                                            isCollapsed={pane.collapsed}
                                            onEnter={handleEnter}
                                            onLeave={handleLeave}
                                            eventBus={eventBus}
                                        />
                                    </div>
                                </div>
                            );
                        })}

                    {contextMenu && features.contextMenu && (
                        <ChartContextMenu
                            x={contextMenu.x}
                            y={contextMenu.y}
                            target={contextMenu.target}
                            priceAtClick={(() => {
                                const tick = resolveTickSize(resolvedSymbolInfoRef.current);
                                return Math.round(contextMenu.priceAtClick / tick) * tick;
                            })()}
                            tickSize={resolveTickSize(resolvedSymbolInfoRef.current)}
                            currentAsk={(() => {
                                if (dataLevelRef.current === 'l3') {
                                    const idx = nearestIndex(
                                        priceHistoryRef.current,
                                        horizonRef.current,
                                    );
                                    return idx >= 0 ? priceHistoryRef.current[idx].bestAsk : 0;
                                } else if (dataLevelRef.current === 'ohlcv') {
                                    if (!openBarRef.current) {
                                        return 0;
                                    }
                                    return openBarRef.current.close;
                                }
                            })()}
                            currentBid={(() => {
                                if (dataLevelRef.current === 'l3') {
                                    const idx = nearestIndex(
                                        priceHistoryRef.current,
                                        horizonRef.current,
                                    );
                                    return idx >= 0 ? priceHistoryRef.current[idx].bestBid : 0;
                                } else if (dataLevelRef.current === 'ohlcv') {
                                    if (!openBarRef.current) {
                                        return 0;
                                    }
                                    return openBarRef.current.close;
                                }
                            })()}
                            drawings={drawingsRef.current}
                            indicators={indicatorsRef.current}
                            chartSettings={chartSettingsRef.current}
                            dataLevel={dataLevelRef.current}
                            onClose={() => {
                                setContextMenu(null);
                            }}
                            onResetView={resetView}
                            onFitYAxis={resetYAxis}
                            onResetXAxis={resetXAxis}
                            onRemoveIndicators={handleRemoveIndicators}
                            onRemoveDrawings={handleDeleteDrawings}
                            onScreenshot={() => {
                                const base = baseCanvasRef.current;
                                const ui = uiCanvasRef.current;
                                const drawings = drawingsCanvasRef.current;
                                if (!base || !ui || !drawings) return;

                                // Create a temporary canvas to merge everything
                                const tempCanvas = document.createElement('canvas');
                                tempCanvas.width = base.width;
                                tempCanvas.height = base.height;
                                const ctx = tempCanvas.getContext('2d');
                                if (!ctx) return;

                                // Draw in order: base -> drawings -> ui
                                ctx.drawImage(base, 0, 0);
                                ctx.drawImage(drawings, 0, 0);
                                ctx.drawImage(ui, 0, 0);

                                // Save as image
                                const a = document.createElement('a');
                                a.download = 'chart.png';
                                a.href = tempCanvas.toDataURL();
                                a.click();

                                setContextMenu(null);
                            }}
                            onToggleHeatmap={() => {
                                setChartSettings((prev) => ({
                                    ...prev,
                                    showHeatmap: !prev.showHeatmap,
                                }));
                            }}
                            onOpenSettings={() => onOpenSettings()}
                            onCreateOrder={onCreateOrder}
                        />
                    )}

                    {indicatorSettingsId &&
                        (() => {
                            const ind = indicatorsRef.current.find(
                                (i) => i.id === indicatorSettingsId,
                            );
                            if (!ind) return null;
                            return (
                                <IndicatorSettingsDialog
                                    indicator={ind}
                                    redrawDebounceMs={50}
                                    onUpdate={(next) => {
                                        Object.assign(ind.settings as object, next);
                                        const paramKeys: Set<string> =
                                            (ind as any).__paramKeys ?? new Set();
                                        const onParamsChanged:
                                            | ((p: Record<string, unknown>) => void)
                                            | undefined = (ind as any).__onParamsChanged;
                                        if (onParamsChanged) {
                                            const changedParams: Record<string, unknown> = {};
                                            let hasParam = false;
                                            for (const key of Object.keys(next)) {
                                                if (paramKeys.has(key)) {
                                                    changedParams[key] = (
                                                        next as Record<string, unknown>
                                                    )[key];
                                                    hasParam = true;
                                                }
                                            }
                                            if (hasParam) onParamsChanged(changedParams);
                                        }
                                        pushDrawParams();
                                        renderEngineRef.current?.markDirty('base');
                                    }}
                                    onClose={() => setIndicatorSettingsId(null)}
                                />
                            );
                        })()}

                    {showDataStatusInBottomRightCorner && (
                        <DataStatus
                            eventBus={eventBus}
                            symbol={cellSymbol}
                            priceScaleWidth={priceScaleWidthRef.current}
                        />
                    )}
                    <HeatmapSpinner eventBus={eventBus} cellId={_id} />

                    {pendingText && (
                        <InlineTextInput
                            x={pendingText.x}
                            y={pendingText.y}
                            fontSize={12}
                            color="#e0e0e0"
                            initialValue=""
                            onCommit={(text) => {
                                if (text.trim()) {
                                    const newD: Drawing = {
                                        id: nanoid(),
                                        tool: 'text',
                                        anchor: pendingText.anchor,
                                        text: text.trim(),
                                        ...(defaultStyleForTool('text') as any),
                                    } as Drawing;
                                    drawingsRef.current = [...drawingsRef.current, newD];
                                    pushDrawParams();
                                    renderEngineRef.current?.markDirty('drawings');
                                }
                                setPendingText(null);
                                setActiveTool(CURSOR_TOOL);
                                activeToolRef.current = CURSOR_TOOL;
                            }}
                            onCancel={() => setPendingText(null)}
                        />
                    )}

                    {editingTextId &&
                        (() => {
                            const d = drawingsRef.current.find((d) => d.id === editingTextId);
                            if (!d || d.tool !== 'text' || 'anchors' in d) return null;
                            const canvas = drawingsCanvasRef.current;
                            const dpr = getEffectiveDpr();

                            const cssW = canvas.width / dpr;
                            const cssH = canvas.height / dpr;
                            if (!canvas) return null;
                            const layouts = getLayouts();
                            const mainRect = layouts['main'];
                            const mainH = mainRect?.h ?? cssH - (hideTimeScale ? 0 : X_AXIS_HEIGHT);
                            const mainOY = mainRect?.y ?? 0;
                            const chartW = cssW - priceScaleWidthRef.current;
                            const px = transformer.tsToX(d.anchor.ts, chartW);
                            const py = transformer.priceToY(d.anchor.price, mainH) + mainOY;
                            return (
                                <InlineTextInput
                                    x={px + 4}
                                    y={py - d.fontSize - 2}
                                    fontSize={d.fontSize}
                                    color={d.color}
                                    initialValue={d.text}
                                    onKeyStroke={(text) => {
                                        drawingsRef.current = drawingsRef.current.map((dr) =>
                                            dr.id === editingTextId ? { ...dr, text } : dr,
                                        );
                                    }}
                                    onCommit={(text) => {
                                        drawingsRef.current = drawingsRef.current.map((dr) =>
                                            dr.id === editingTextId
                                                ? //@ts-ignore
                                                  { ...dr, text: text.trim() || dr.text }
                                                : dr,
                                        );
                                        setEditingTextId(null);
                                        editingTextIdRef.current = null;
                                    }}
                                    onCancel={() => {
                                        setEditingTextId(null);
                                        editingTextIdRef.current = null;
                                    }}
                                />
                            );
                        })()}
                </div>
            </div>

            {showTimeframeWindow && (
                <div
                    className="absolute left-0 top-0 w-full h-full flex flex-1 bg-background/40 justify-center items-center z-50"
                    id="change-timeframe"
                >
                    <div className="bg-background border border-border rounded-lg shadow-lg shadow-black/30 p-5 w-64 flex flex-col gap-3">
                        <div className="flex flex-col gap-0.5">
                            <div className="text-[13px] font-semibold text-white/90">
                                Set timeframe
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                                Digits, then a unit: s m h d w
                            </div>
                        </div>
                        <Input
                            autoFocus
                            value={timeframeWindowInput}
                            placeholder="e.g. 15m"
                            className="text-center text-base font-mono h-11 tracking-[0.2em]"
                            onChange={() => {}}
                            onKeyDown={(e) => {
                                e.stopPropagation();

                                const ALLOWED_LETTERS = ['s', 'm', 'h', 'd'];
                                const key = e.key;
                                const val = timeframeWindowInput;
                                const hasLetter = ALLOWED_LETTERS.some((l) => val.includes(l));
                                const lastChar = val.slice(-1);
                                const isDigit = key >= '0' && key <= '9';
                                const isLetter = ALLOWED_LETTERS.includes(key.toLowerCase());

                                if (key === 'Escape') {
                                    e.preventDefault();
                                    setShowTimeframeWindow(false);
                                    setTimeframeWindowInput('');
                                } else if (key === 'Backspace') {
                                    e.preventDefault();
                                    if (!e.ctrlKey)
                                        setTimeframeWindowInput((prev) => prev.slice(0, -1));
                                    else setTimeframeWindowInput('');
                                } else if (key === 'Enter') {
                                    e.preventDefault();
                                    const input = val.trim().toLowerCase();
                                    if (!input) return;

                                    const makeNs = (value: number, unit: TimeframeUnit): bigint => {
                                        const ns: Record<TimeframeUnit, bigint> = {
                                            none: 1_000_000n,
                                            ms: 1_000_000n,
                                            s: 1_000_000_000n,
                                            m: 60_000_000_000n,
                                            h: 3_600_000_000_000n,
                                            d: 86_400_000_000_000n,
                                            w: 604_800_000_000_000n,
                                        };
                                        return BigInt(value) * ns[unit];
                                    };

                                    const lastInputChar = input.charAt(input.length - 1);
                                    const isLastDigit =
                                        lastInputChar >= '0' && lastInputChar <= '9';
                                    const scale: TimeframeUnit = isLastDigit
                                        ? 'm'
                                        : (lastInputChar as TimeframeUnit);
                                    const amount = isLastDigit
                                        ? Number(input)
                                        : Number(input.slice(0, -1));

                                    if (amount > 0) {
                                        applyTimeframe({
                                            label: amount + scale,
                                            barNs: makeNs(amount, scale),
                                            defaultBars: 300,
                                            isPreset: false,
                                        });
                                    }
                                    setShowTimeframeWindow(false);
                                    setTimeframeWindowInput('');
                                } else if (isDigit && !hasLetter) {
                                    e.preventDefault();
                                    setTimeframeWindowInput((prev) => prev + key);
                                } else if (
                                    isLetter &&
                                    !hasLetter &&
                                    lastChar >= '0' &&
                                    lastChar <= '9'
                                ) {
                                    e.preventDefault();
                                    setTimeframeWindowInput((prev) => prev + key.toLowerCase());
                                } else {
                                    e.preventDefault();
                                }
                            }}
                        />
                        <div className="text-xs text-muted-foreground text-center">
                            Enter to confirm · Esc to cancel
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
});

export default Chart;

function InlineTextInput({
    x,
    y,
    initialValue = '',
    fontSize = 12,
    color = '#e0e0e0',
    onKeyStroke,
    onCommit,
    onCancel,
}: {
    x: number;
    y: number;
    initialValue?: string;
    fontSize?: number;
    color?: string;
    onKeyStroke?: (text: string) => void;
    onCommit: (text: string) => void;
    onCancel: () => void;
}) {
    const ref = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        const id = requestAnimationFrame(() => {
            const el = ref.current;
            if (!el) return;
            el.focus();
            el.style.width = '1px';
            el.style.width = Math.max(120, el.scrollWidth) + 'px';
            el.style.height = '1px';
            el.style.height = el.scrollHeight + 'px';
            el.selectionStart = el.selectionEnd = el.value.length;
        });
        return () => cancelAnimationFrame(id);
    }, []);

    return (
        <div
            className="absolute"
            style={{ left: x, top: y }}
            onMouseDown={(e) => e.stopPropagation()}
        >
            <textarea
                ref={ref}
                rows={1}
                defaultValue={initialValue}
                spellCheck={false}
                autoComplete="off"
                className="resize-none overflow-hidden bg-transparent border-none outline-none ring-0 focus:ring-0 focus:outline-none p-0 m-0 min-w-[120px]"
                style={{
                    color,
                    fontSize,
                    fontFamily: 'inherit',
                    lineHeight: '1.33',
                    background: 'transparent',
                    border: 'none',
                    outline: 'none',
                    boxShadow: 'none',
                    caretColor: '#e0e0e0',
                    whiteSpace: 'pre',
                    width: 120,
                }}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        onCommit((e.target as HTMLTextAreaElement).value);
                    } else if (e.key === 'Escape') {
                        e.preventDefault();
                        onCancel();
                    }
                    const el = e.currentTarget;
                    el.style.width = '1px';
                    el.style.width = Math.max(120, el.scrollWidth) + 'px';
                    el.style.height = '1px';
                    el.style.height = el.scrollHeight + 'px';
                }}
                onInput={(e) => {
                    const el = e.currentTarget;
                    onKeyStroke?.(el.value);
                    el.style.width = '1px';
                    el.style.width = Math.max(120, el.scrollWidth) + 'px';
                    el.style.height = '1px';
                    el.style.height = el.scrollHeight + 'px';
                }}
                onBlur={(e) => {
                    onCommit((e.target as HTMLTextAreaElement).value);
                }}
            />
        </div>
    );
}
