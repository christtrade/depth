import { useEffect, useRef, type MutableRefObject, type RefObject } from 'react';
import { nanoid } from 'nanoid';
import {
    type Drawing,
    type DraftDrawing,
    type Anchor,
    type FixedVolumeProfileDrawing,
    defaultStyleForTool,
    DrawingAnchorId,
    PluginDraftDrawing,
    ActiveDrawingTool,
    CURSOR_TOOL,
    armTool,
    initialPluginData,
} from '../lib/types/drawing-types';
import {
    type ChartPane,
    type Indicator,
    type Rect,
    getPaneLayouts,
    hitTestDivider,
    hitTestPane,
    PANE_MIN_HEIGHT_RATIO,
} from '../lib/types/indicator-types';
import { findNearestTrade, type Crosshair, X_AXIS_HEIGHT } from '../lib/renderers/renderer';
import { autoFitPriceAxis } from './useChartData';
import { hitTestDrawings, moveDrawingAnchorDelta } from '../lib/renderers/drawings-renderer';
import { getEffectiveDpr } from '../lib/dpr';
import { pointerLock } from '../lib/pointer-lock';
import { TOOL_SHORTCUTS } from '../components/drawings/drawing-toolbar';
import {
    drawingRegistry,
    type PluginDrawingToolDef,
    type PluginKeyEvent,
    type PluginToolActiveContext,
    type PluginToolEvent,
} from '../core/DrawingRegistry';
import type {
    ChartTypePlugin,
    ChartTypeActiveContext,
    ChartTypePointerEvent,
    ChartTypeKeyEvent,
} from '../core/PluginRegistry';
import { type RenderEngine } from '../core/RenderEngine';
import { type BarStore } from '../core/BarStore';
import { type TypedEventBus } from '../core/TypedEventBus';
import { type SessionMapper } from '../core/SessionMapper';
import { snapTsToBarGrid } from '../lib/bar-grid';
import { type TradingSession, type DataLevel, type SymbolInfo } from '../interfaces/IDataAdapter';
import { resolveTickSize } from '../lib/priceFormat';
import { type LiveTransformer } from '../interfaces/ICoordinateTransformer';
import { type ViewBounds, type PriceHistory, type TradePoint } from '../lib/types';
import { MIN_TIME_SPAN, MAX_TIME_SPAN } from '../lib/constants';
import { type FootprintBar } from '../lib/types/footprint';
import { type ChartSettings } from '../lib/types/chart-settings';
import { type Timeframe } from '../lib/timeframes';
import { type BookState } from '../lib/types';
import { type SerialTrade } from '../lib/types';
import { type FeaturesOptions } from '../core/DepthChart';
import { type DomPanelHandle } from '../lib/types';

type ShiftAnchor = { ts: bigint; price: number; x: number; y: number };

/**
 * The CSS cursor to show for a given drawing anchor. Shared between the hover
 * path and the active-drag path so the cursor stays identical whether you're
 * hovering an anchor or dragging it (previously the drag path hardcoded
 * 'crosshair' for resize handles, so they "lost" their directional cursor mid-drag).
 */
function cursorForAnchor(anchor: DrawingAnchorId | null): string {
    switch (anchor) {
        case 'tl':
        case 'br':
            return 'nwse-resize';
        case 'tr':
        case 'bl':
            return 'nesw-resize';
        case 'mt':
        case 'mb':
            return 'ns-resize';
        case 'ml':
        case 'mr':
            return 'ew-resize';
        case 'a':
        case 'b':
        case 'c':
        case 'anchor':
            return 'crosshair';
        case 'body':
            return 'move';
        case 'all':
            return 'default'
        default:
            return 'pointer';
    }
}

/**
 * Scale the price axis by `factor` (>1 zooms out, <1 zooms in) around its
 * center. In log mode the scaling happens in log space around the geometric
 * center, so the bounds stay strictly positive no matter how far you zoom out -
 * a linear `center - span/2` would drive pMin negative and silently kick the
 * transformer back to linear scale.
 */
function scalePriceBounds(
    pMin: number,
    pMax: number,
    factor: number,
    isLog: boolean,
): [number, number] {
    if (isLog && pMin > 0 && pMax > 0) {
        const lMin = Math.log(pMin);
        const lMax = Math.log(pMax);
        const lCenter = (lMin + lMax) / 2;
        const lHalf = ((lMax - lMin) / 2) * factor;
        return [Math.exp(lCenter - lHalf), Math.exp(lCenter + lHalf)];
    }
    const span = pMax - pMin;
    const center = pMin + span / 2;
    const newSpan = span * factor;
    return [center - newSpan / 2, center + newSpan / 2];
}

function shiftPriceBounds(view: ViewBounds, dy: number, mainH: number, isLog: boolean): void {
    if (isLog && view.pMin > 0 && view.pMax > 0) {
        const factor = Math.exp((dy * (Math.log(view.pMax) - Math.log(view.pMin))) / mainH);
        view.pMin *= factor;
        view.pMax *= factor;
    } else {
        const priceShift = (dy * (view.pMax - view.pMin)) / mainH;
        view.pMin += priceShift;
        view.pMax += priceShift;
    }
}

function findTouch(list: TouchList, id: number): Touch | null {
    for (let i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i];
    return null;
}

type Pinch = {
    a: number;
    b: number;
    anchor: number;
    span0: number;
    dist0: number;
    midY: number;
    to: (ts: bigint) => number;
    from: (v: number) => bigint;
};

export interface UseChartInteractionParams {
    status: 'loading' | 'ready' | 'error';

    /**
     * This chart cell's id. In a multi-chart layout every cell shares one
     * eventBus, so status:compute emissions are tagged with this id and each
     * StatusBar only reacts to its own cell's events.
     */
    cellId: number;

    // DOM refs
    baseCanvasRef: RefObject<HTMLCanvasElement>;
    uiCanvasRef: RefObject<HTMLCanvasElement>;
    chartAreaRef: RefObject<HTMLDivElement>;
    containerRef: RefObject<HTMLDivElement>;

    // View/layout refs
    viewRef: MutableRefObject<ViewBounds | null>;
    /** Auto-computed right price-axis width (css px). */
    priceScaleWidthRef: MutableRefObject<number>;
    /** Resolved symbol info - used to derive the instrument tick size. */
    symbolInfoRef: MutableRefObject<SymbolInfo | null>;
    layoutsCacheRef: MutableRefObject<Record<string, Rect>>;
    isYAxisAutoRef: MutableRefObject<boolean>;

    // Drawing refs
    drawingsRef: MutableRefObject<Drawing[]>;
    draftRef: MutableRefObject<DraftDrawing | null>;
    selectedDrawingIdRef: MutableRefObject<string | null>;
    hoveredDrawingIdRef: MutableRefObject<string | null>;
    hotAnchorRef: MutableRefObject<DrawingAnchorId | null>;
    draggingAnchorRef: MutableRefObject<{ drawingId: string; anchor: DrawingAnchorId } | null>;
    dragStartRef: MutableRefObject<{ x: number; y: number } | null>;
    dragPrevDataRef: MutableRefObject<{ ts: bigint; price: number } | null>;
    dragPrevPixelRef: MutableRefObject<{ x: number; y: number } | null>;
    fvpLiveRecalcRef: MutableRefObject<boolean>;
    activeCtxRef: MutableRefObject<PluginToolActiveContext | null>;

    // Pane/indicator refs
    panesRef: MutableRefObject<ChartPane[]>;
    indicatorsRef: MutableRefObject<Indicator[]>;
    draggingDividerRef: MutableRefObject<number>;
    dragPaneIdRef: MutableRefObject<string | null>;
    hoveredDividerIdxRef: MutableRefObject<number>;
    hoveredDividerIdxRefLocked: MutableRefObject<boolean>;
    hoveredPaneIdRef: MutableRefObject<string | null>;

    // Chart state refs
    activeToolRef: MutableRefObject<ActiveDrawingTool>;
    chartSettingsRef: MutableRefObject<ChartSettings>;
    activeTimeframeRef: MutableRefObject<Timeframe>;
    sessionMapperRef: MutableRefObject<SessionMapper>;
    resolvedSessionRef: MutableRefObject<TradingSession | null>;
    renderEngineRef: MutableRefObject<RenderEngine | null>;
    pluginChartTypesRef: MutableRefObject<Map<string, ChartTypePlugin>>;
    activeChartTypeBottomBarIds: MutableRefObject<Set<string>>;

    // Input state refs
    crosshairRef: MutableRefObject<Crosshair | null>;
    isDragging: MutableRefObject<boolean>;
    dragMode: MutableRefObject<string>;
    isHoldingCtrlRef: MutableRefObject<boolean>;
    isHoldingShiftRef: MutableRefObject<boolean>;
    lastMouse: MutableRefObject<{ x: number; y: number }>;
    hasDragged: MutableRefObject<boolean>;
    longPressTimer: MutableRefObject<ReturnType<typeof setTimeout> | null>;
    showTooltipRef: MutableRefObject<boolean>;
    shiftAnchorRef: MutableRefObject<ShiftAnchor | null>;
    shiftAnchor2Ref: MutableRefObject<ShiftAnchor | null>;
    showShiftInfo: MutableRefObject<boolean>;
    lastStatusLineUpdateRef: MutableRefObject<number>;

    // Data refs (from useChartData)
    horizonRef: MutableRefObject<bigint>;
    tradesRef: MutableRefObject<TradePoint[]>;
    priceHistoryRef: MutableRefObject<PriceHistory[]>;
    allPriceHistoryRef: MutableRefObject<PriceHistory[]>;
    ohlcvBarsRef: MutableRefObject<{ barNs: bigint; bars: BarStore; display: BarStore }>;
    previewBarsRef: MutableRefObject<BarStore>;
    dataLevelRef: MutableRefObject<DataLevel | null>;
    openBarRef: MutableRefObject<FootprintBar | null>;
    candleCacheRef: MutableRefObject<Map<bigint, any> | null>;
    footprintBarsRef: MutableRefObject<FootprintBar[]>;
    datasetStartRef: MutableRefObject<bigint>;
    datasetEndRef: MutableRefObject<bigint>;
    horizonScrollAnimRef: MutableRefObject<any>;
    liveBookRef: MutableRefObject<BookState>;
    tradeLineInteractionRef: MutableRefObject<any>;
    selectedTradeRef: MutableRefObject<TradePoint | null>;

    // Props
    transformer: LiveTransformer;
    eventBus: TypedEventBus;
    features: FeaturesOptions;

    // State refs (for reading latest value without stale closure)
    showTimeframeWindowRef: MutableRefObject<boolean>;

    // State setters
    setActiveTool: (tool: ActiveDrawingTool) => void;
    setSelectedDrawingId: (id: string | null) => void;
    setSettingsBarPos: (pos: { x: number; y: number } | null) => void;
    setContextMenu: (ctx: any) => void;
    setPanes: (updater: ((prev: ChartPane[]) => ChartPane[]) | ChartPane[]) => void;
    setChartSettings: (updater: ((prev: ChartSettings) => ChartSettings) | ChartSettings) => void;
    setEditingTextId: (id: string | null) => void;
    setOpenSettingsDialog: (open: boolean) => void;
    setShowTimeframeWindow: (show: boolean) => void;
    setTimeframeWindowInput: (input: string) => void;
    setPendingText: (text: { x: number; y: number; anchor: Anchor } | null) => void;

    // Callbacks from ChartInner
    pushDrawParams: () => void;
    /** View settled - tells the data engine and a synced layout. Call after any
     *  change to tMin/tMax. */
    onViewSettled: () => void;
    scheduleResample: () => void;
    runIndicatorWorker: (trades: SerialTrade[], barNs: bigint) => void;
    getTradesUpToHorizon: (horizon: bigint) => TradePoint[];
    updateSettingsBarPos: (id: string | null) => void;
    handleDeleteDrawing: (id: string) => void;
    autofitPanesSilent: () => void;
    autofitIndicatorPanes: () => void;
    resetXAxis: () => void;
    getPanel: () => DomPanelHandle | null;
    getLayouts: () => Record<string, Rect>;
    recomputeLayouts: () => void;
    syncPixelLayouts: (panes?: ChartPane[]) => void;
    applyLayoutsToDom: (layouts: Record<string, Rect>) => void;
    buildChartTypeActiveCtx: () => ChartTypeActiveContext;

    hideTimeScale: boolean;
    activeTool: ActiveDrawingTool;
    touchPlusRef: RefObject<HTMLButtonElement>;
    lastInputTouchRef: MutableRefObject<boolean>;
}

export function useChartInteraction(p: UseChartInteractionParams): void {
    const {
        status,
        cellId,
        baseCanvasRef,
        uiCanvasRef,
        chartAreaRef,
        containerRef,
        viewRef,
        priceScaleWidthRef,
        symbolInfoRef,
        isYAxisAutoRef,
        drawingsRef,
        draftRef,
        selectedDrawingIdRef,
        hoveredDrawingIdRef,
        hotAnchorRef,
        draggingAnchorRef,
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
        onViewSettled,
        scheduleResample,
        runIndicatorWorker,
        getTradesUpToHorizon,
        updateSettingsBarPos,
        handleDeleteDrawing,
        autofitPanesSilent,
        autofitIndicatorPanes,
        resetXAxis,
        getPanel,
        getLayouts,
        recomputeLayouts,
        applyLayoutsToDom,
        buildChartTypeActiveCtx,
        activeTool,
        touchPlusRef,
        lastInputTouchRef,
    } = p;

    const touchCrosshairRef = useRef<{ x: number; y: number } | null>(null);
    const touchCrosshairApiRef = useRef<{
        show: (x: number, y: number) => void;
        hide: () => void;
        center: () => { x: number; y: number };
    } | null>(null);

    /**
     * Arm a tool. The ref is what every pointer handler reads (they run outside
     * React), the state is what the toolbar and `getActiveTool()` see - so both
     * always move together.
     */
    function applyTool(tool: ActiveDrawingTool): void {
        activeToolRef.current = tool;
        setActiveTool(tool);
    }

    /** Back to the cursor: nothing armed, no draft in flight. */
    function disarmTool(): void {
        draftRef.current = null;
        applyTool(CURSOR_TOOL);
    }

    function getZoomLimits(): { min: bigint; max: bigint } {
        // Ordinal mode: limits are column counts, not time spans.
        const ord = transformer.getOrdinal();
        if (ord) {
            const maxCols = Math.min(3400, Math.max(10, ord.length + 20));
            return { min: 3n, max: BigInt(maxCols) };
        }
        const barNs = activeTimeframeRef.current.barNs;
        if (barNs <= 0n) return { min: MIN_TIME_SPAN, max: MAX_TIME_SPAN };
        const minSpan = barNs * 3n;
        const maxSpan = barNs * 3400n;
        return { min: minSpan, max: maxSpan };
    }

    function lastBarTs(): bigint | null {
        const dataEnd = datasetEndRef.current;
        if (dataEnd === 0n) return null;
        const horizon = horizonRef.current;
        return horizon > 0n && horizon < dataEnd ? horizon : dataEnd;
    }

    function clampPan(view: ViewBounds): void {
        // Ordinal mode: clamp the visible column range to [0, lastColumn + pad].
        const ord = transformer.getOrdinal();
        if (ord) {
            const n = ord.length;
            let lo = transformer.tsToFracIndex(view.tMin);
            let hi = transformer.tsToFracIndex(view.tMax);
            const span = hi - lo;
            if (span <= 0) return;
            const rightPad = Math.min(span * 0.5, 20);
            const maxRight = n - 1 + rightPad;
            if (hi > maxRight) {
                lo -= hi - maxRight;
                hi = maxRight;
            }
            if (lo < 0) {
                hi += -lo;
                lo = 0;
            }
            view.tMin = transformer.indexToTs(lo);
            view.tMax = transformer.indexToTs(hi);
            return;
        }
        const start = datasetStartRef.current + activeTimeframeRef.current.barNs / 2n;
        const last = lastBarTs();
        if (start === 0n || last === null) return;
        const end = last - (activeTimeframeRef.current.barNs * 3n) / 2n;
        const span = view.tMax - view.tMin;
        if (view.tMin + span < start) {
            view.tMin = start - span;
            view.tMax = start;
        }
        if (view.tMin > end) {
            view.tMin = end;
            view.tMax = end + span;
        }
    }

    function snapPrice(snappedTs: bigint, rawPrice: number): number {
        if (snappedTs > horizonRef.current) return rawPrice;
        const chartType = chartSettingsRef.current.chartType;
        if (dataLevelRef.current === 'ohlcv') {
            const display = ohlcvBarsRef.current.display;
            const ms = Number(snappedTs / 1_000_000n);
            const i = display.lowerBound(ms);
            const bar = i < display.length && display.time[i] === ms ? display.at(i) : undefined;
            if (!bar) return rawPrice;
            const distances = [
                Math.abs(bar.open - rawPrice),
                Math.abs(bar.high - rawPrice),
                Math.abs(bar.low - rawPrice),
                Math.abs(bar.close - rawPrice),
            ];
            const minDist = Math.min(...distances);
            const map = ['open', 'high', 'low', 'close'];
            let point = null;
            for (let i = 0; i < distances.length; i++) {
                if (distances[i] === minDist) {
                    point = map[i];
                }
            }
            if (point) {
                return bar[point];
            } else {
                return rawPrice;
            }
        } else {
            if (
                chartType === 'candles' ||
                chartType === 'footprint' ||
                chartType === 'hollow' ||
                chartType === 'bars'
            ) {
                const bars = footprintBarsRef.current;
                if (bars.length === 0) return rawPrice;
                let lo = 0,
                    hi = bars.length - 1,
                    best = 0;
                while (lo <= hi) {
                    const mid = (lo + hi) >>> 1;
                    if (bars[mid].ts <= snappedTs) {
                        best = mid;
                        lo = mid + 1;
                    } else hi = mid - 1;
                }
                const bar = bars[best];
                const candidates = [bar.open, bar.high, bar.low, bar.close];
                return candidates.reduce((a, b) =>
                    Math.abs(b - rawPrice) < Math.abs(a - rawPrice) ? b : a,
                );
            }
            const history = priceHistoryRef.current;
            if (history.length === 0) return rawPrice;
            let lo = 0,
                hi = history.length - 1,
                best = 0;
            while (lo <= hi) {
                const mid = (lo + hi) >>> 1;
                if (history[mid].ts <= snappedTs) {
                    best = mid;
                    lo = mid + 1;
                } else hi = mid - 1;
            }
            const pt = history[best];
            const candidates = [pt.bestBid, pt.bestAsk];
            return candidates.reduce((a, b) =>
                Math.abs(b - rawPrice) < Math.abs(a - rawPrice) ? b : a,
            );
        }
    }

    function snapTs(ts: bigint): bigint {
        return snapTsToBarGrid(ts, activeTimeframeRef.current.barNs, sessionMapperRef.current);
    }

    function buildChartTypePointerEvent(
        e: MouseEvent,
        ts: bigint,
        price: number,
    ): ChartTypePointerEvent {
        return {
            ts,
            price,
            x: e.clientX - uiCanvasRef.current!.getBoundingClientRect().left,
            y: e.clientY - uiCanvasRef.current!.getBoundingClientRect().top,
            shiftKey: e.shiftKey,
            ctrlKey: e.ctrlKey,
            altKey: e.altKey,
            buttons: e.buttons,
            ctx: buildChartTypeActiveCtx(),
        };
    }

    function buildChartTypeKeyEvent(e: KeyboardEvent): ChartTypeKeyEvent {
        return {
            key: e.key,
            code: e.code,
            shiftKey: e.shiftKey,
            ctrlKey: e.ctrlKey,
            ctx: buildChartTypeActiveCtx(),
        };
    }

    function getActiveChartTypePlugin(): ChartTypePlugin | null {
        const id = chartSettingsRef.current.chartType;
        return pluginChartTypesRef.current.get(id) ?? null;
    }

    function computeFvpSync(drawing: FixedVolumeProfileDrawing, horizon: bigint) {
        const VP_TICK = resolveTickSize(symbolInfoRef.current);
        const tStart = drawing.a.ts < drawing.b.ts ? drawing.a.ts : drawing.b.ts;
        const tEnd = drawing.a.ts < drawing.b.ts ? drawing.b.ts : drawing.a.ts;
        const slice = tradesRef.current.filter((t) => t.ts >= tStart && t.ts <= tEnd);

        const map = new Map<number, [number, number]>();
        for (const t of slice) {
            if (t.ts > horizon) break;
            const p = Math.round(t.price / VP_TICK) * VP_TICK;
            const existing = map.get(p);
            if (existing) {
                if (t.side === 'B') existing[0] += t.size;
                else existing[1] += t.size;
            } else {
                map.set(p, t.side === 'B' ? [t.size, 0] : [0, t.size]);
            }
        }

        const sorted = Array.from(map.entries()).sort((a, b) => a[0] - b[0]);
        const n = sorted.length;
        const prices = new Float64Array(n);
        const buyVol = new Float64Array(n);
        const sellVol = new Float64Array(n);
        const totalVol = new Float64Array(n);
        let poc = NaN,
            maxVol = -1;

        for (let i = 0; i < n; i++) {
            const [price, [bv, sv]] = sorted[i];
            prices[i] = price;
            buyVol[i] = bv;
            sellVol[i] = sv;
            totalVol[i] = bv + sv;
            if (bv + sv > maxVol) {
                maxVol = bv + sv;
                poc = price;
            }
        }

        return { prices, buyVol, sellVol, totalVol, poc };
    }

    useEffect(() => {
        const canvas = baseCanvasRef.current;
        const chartArea = chartAreaRef.current;
        if (!canvas || status !== 'ready') return;

        const activeCtx: PluginToolActiveContext = {
            commitDrawing(drawing) {
                const d = drawing as any;
                const toolId = d.pluginToolId ?? drawing.tool;
                const { keepActive, ...rest } = drawing;
                const committed = {
                    ...rest,
                    id: nanoid(),
                    tool: toolId,
                    // a tool committing its own drawing still wants the params
                    // it declared, under whatever it put there itself
                    data: { ...initialPluginData(toolId), ...(d.data as object) },
                };
                drawingsRef.current = [...drawingsRef.current, committed as any];
                draftRef.current = null;
                if (keepActive) {
                    // Staying armed means the next drawing needs its own identity.
                    applyTool(armTool(activeToolRef.current.name));
                } else {
                    applyTool(CURSOR_TOOL);
                }
                selectedDrawingIdRef.current = committed.id;
                setSelectedDrawingId(committed.id);
                pushDrawParams();
                renderEngineRef.current?.markDirty('drawings');
            },

            setDraft(draft) {
                draftRef.current = draft && {
                    data: initialPluginData(draft.pluginToolId),
                    ...draftRef.current,
                    ...draft,
                };
                pushDrawParams();
                renderEngineRef.current?.markDirty('drawings');
            },

            requestRedraw() {
                renderEngineRef.current?.markDirty('drawings');
            },

            deactivate() {
                disarmTool();
                pushDrawParams();
                renderEngineRef.current?.markDirty('drawings');
            },

            getOverlayCanvas() {
                return uiCanvasRef.current!;
            },
        };
        activeCtxRef.current = activeCtx;

        function buildPluginToolEvent(
            e: MouseEvent,
            ts: bigint,
            price: number,
            plugin: PluginDrawingToolDef,
        ): PluginToolEvent {
            return {
                ts,
                price,
                x: e.clientX - uiCanvasRef.current!.getBoundingClientRect().left,
                y: e.clientY - uiCanvasRef.current!.getBoundingClientRect().top,
                shiftKey: e.shiftKey,
                ctrlKey: e.ctrlKey,
                altKey: e.altKey,
                buttons: e.buttons,
                tool: activeCtx,
                plugin,
            };
        }

        function buildPluginKeyEvent(e: KeyboardEvent): PluginKeyEvent {
            return {
                key: e.key,
                code: e.code,
                shiftKey: e.shiftKey,
                ctrlKey: e.ctrlKey,
                tool: activeCtx,
            };
        }

        let scaleXStart: { x0: number; tMin0: bigint; tMax0: bigint } | null = null;
        let touchTapSelect: string | null = null;
        let touchTapDeselect = false;
        let pressAt: { x: number; y: number } | null = null;

        const clearDrawingHover = () => {
            if (!hoveredDrawingIdRef.current) return;
            hoveredDrawingIdRef.current = null;
            hotAnchorRef.current = null;
            pushDrawParams();
            renderEngineRef.current?.markDirty('drawings');
        };
        const panBy = (
            view: ViewBounds,
            dx: number,
            dy: number,
            chartW: number,
            cssH: number,
            activePane: { id: string; isMain?: boolean } | null | undefined,
        ) => {
            const sm = transformer.getSessionMapper();
            const ord = transformer.getOrdinal();
            if (ord) {
                const colW = transformer.getBarPx(chartW);
                if (colW > 0) {
                    const dIdx = dx / colW;
                    const idxMin = transformer.tsToFracIndex(view.tMin);
                    const idxMax = transformer.tsToFracIndex(view.tMax);
                    view.tMin = transformer.indexToTs(idxMin - dIdx);
                    view.tMax = transformer.indexToTs(idxMax - dIdx);
                }
            } else if (sm && sm.hasSession) {
                const mMin = sm.tsToMarket(view.tMin);
                const mMax = sm.tsToMarket(view.tMax);
                const mSpan = Number(mMax - mMin);
                if (mSpan > 0) {
                    const dm = BigInt(Math.round(dx * (mSpan / chartW)));
                    view.tMin = sm.marketToTs(mMin - dm);
                    view.tMax = sm.marketToTs(mMax - dm);
                }
            } else {
                const timeSpan = Number(view.tMax - view.tMin);
                view.tMin -= BigInt(Math.round(dx * (timeSpan / chartW)));
                view.tMax -= BigInt(Math.round(dx * (timeSpan / chartW)));
            }
            clampPan(view);

            const layouts = getLayouts();

            if (activePane && !activePane.isMain) {
                const paneRect = layouts[activePane.id];
                if (paneRect) {
                    const updated = panesRef.current.map((p) => {
                        if (p.id !== activePane.id) return p;
                        if (!p.yAxisAuto) {
                            const span = p.yMax - p.yMin;
                            const shift = dy * (span / paneRect.h);
                            return {
                                ...p,
                                yMin: p.yMin + shift,
                                yMax: p.yMax + shift,
                            };
                        } else {
                            const ind = indicatorsRef.current.find((i) => i.paneId === p.id);
                            if (!ind?.getAutoYBounds) return p;
                            const b = ind.getAutoYBounds(
                                viewRef.current.tMin,
                                viewRef.current.tMax,
                                horizonRef.current,
                            );
                            if (!b) return p;
                            return { ...p, yMin: b.min, yMax: b.max };
                        }
                    });
                    panesRef.current = updated;
                    setPanes(updated);
                }
            } else {
                if (!isYAxisAutoRef.current) {
                    const mainH =
                        layouts['main']?.h ?? cssH - (p.hideTimeScale ? 0 : X_AXIS_HEIGHT);
                    shiftPriceBounds(view, dy, mainH, transformer.getScaleMode() === 'log');
                } else {
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
                }
                autofitPanesSilent();
            }
            transformer.update(view);
            transformer.setSessionMapper(sessionMapperRef.current);
            transformer.setSession(resolvedSessionRef.current);
            scheduleResample();
            renderEngineRef.current?.markDirty('base');
            renderEngineRef.current?.markDirty('drawings');
            updateSettingsBarPos(selectedDrawingIdRef.current);
        };

        // touch pan velocity, px/ms, from the last ~100ms of moves
        let panSamples: { t: number; x: number; y: number }[] = [];
        let glideRaf: number | null = null;
        let touchStoppedGlide = false;

        const stopGlide = () => {
            if (glideRaf === null) return;
            cancelAnimationFrame(glideRaf);
            glideRaf = null;
            if (dragMode.current === 'glide') dragMode.current = 'none';
        };

        const startGlide = (paneId: string | null) => {
            const now = performance.now();
            const recent = panSamples.filter((s) => now - s.t < 100);
            panSamples = [];
            if (recent.length < 2) return;
            const first = recent[0];
            const last = recent[recent.length - 1];
            const dt = last.t - first.t;

            if (dt <= 0 || now - last.t > 40) return;
            let vx = (last.x - first.x) / dt;
            let vy = isYAxisAutoRef.current ? 0 : (last.y - first.y) / dt;
            if (Math.hypot(vx, vy) < 0.3) return;

            // stop playback follow scroll while gliding
            dragMode.current = 'glide';
            horizonScrollAnimRef.current = null;
            let prev = now;
            const step = (t: number) => {
                const view = viewRef.current;
                if (!view) return stopGlide();
                const elapsed = Math.min(t - prev, 50);
                prev = t;
                // ios scroll views use ca 325ms time constant
                const decay = Math.exp(-elapsed / 325);
                vx *= decay;
                vy *= decay;
                if (Math.hypot(vx, vy) < 0.02) return stopGlide();

                const dpr = getEffectiveDpr();
                const cssW = canvas.width / dpr;
                const cssH = canvas.height / dpr;
                const pane = paneId ? panesRef.current.find((p) => p.id === paneId) : null;
                panBy(view, vx * elapsed, vy * elapsed, cssW - priceScaleWidthRef.current, cssH, pane);
                pushDrawParams();
                onViewSettled();
                renderEngineRef.current?.markDirty('ui');
                if (view.tMin < datasetStartRef.current) {
                    eventBus.emit('data:request-backward', {
                        viewMin: view.tMin,
                        symbol: symbolInfoRef.current?.symbol,
                    });
                }
                glideRaf = requestAnimationFrame(step);
            };
            glideRaf = requestAnimationFrame(step);
        };

        // panning shouldnt drag crosshair along with it
        let hideTouchPointer = false;
        let touchCrosshairMoving = false;

        const handleMouseDown = (e: MouseEvent) => {
            stopGlide();
            if (e.button === 0) {
                pressAt = { x: e.clientX, y: e.clientY };
                hasDragged.current = false;
            }
            // Trade line interaction
            {
                const tl = tradeLineInteractionRef.current;
                let captured = false;
                const synth = {
                    ...e,
                    currentTarget: canvas,
                    stopPropagation: () => {
                        captured = true;
                    },
                    preventDefault: () => e.preventDefault(),
                    clientX: e.clientX,
                    clientY: e.clientY,
                    button: e.button,
                } as any;
                tl.onMouseDown(synth);
                if (captured) return;
            }

            if (e.button === 1) {
                const rect = canvas.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                const view = viewRef.current;
                if (!view) return;
                // Named apart from the `dpr` declared further down this handler - that
                // one is in the function scope and would be in its TDZ here.
                const hitDpr = getEffectiveDpr();

                const hit = hitTestDrawings(
                    x,
                    y,
                    drawingsRef.current,
                    view,
                    panesRef.current,
                    canvas.width / hitDpr,
                    canvas.height / hitDpr,
                    transformer,
                    p.hideTimeScale,
                    p.priceScaleWidthRef.current,
                    p.symbolInfoRef.current
                );
                if (hit) {
                    e.preventDefault();
                    handleDeleteDrawing(hit.drawingId);
                }
                return;
            }

            if (e.button !== 0) return;

            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const view = viewRef.current;
            if (!view) return;
            const dpr = getEffectiveDpr();

            const cssW = canvas.width / dpr;
            const cssH = canvas.height / dpr;

            const chartW = cssW - priceScaleWidthRef.current;
            const inChart = x < chartW && y < cssH - (p.hideTimeScale ? 0 : X_AXIS_HEIGHT);

            const layouts = getLayouts();
            const mainRect = layouts['main'];
            const mainH = mainRect?.h ?? cssH - (p.hideTimeScale ? 0 : X_AXIS_HEIGHT);
            const mainOY = mainRect?.y ?? 0;
            const rawTs = transformer.xToTs(x, chartW);
            const ts = snapTs(rawTs);
            const rawPrice = transformer.yToPrice(y - mainOY, mainH);
            let price = rawPrice;

            const ctPlugin = getActiveChartTypePlugin();
            if (ctPlugin?.onPointerDown) {
                const consumed = ctPlugin.onPointerDown(buildChartTypePointerEvent(e, ts, price));
                if (consumed) {
                    e.preventDefault();
                    return;
                }
            }

            if (activeToolRef.current.name !== 'cursor') {
                if (!inChart) return;
                const layouts = getLayouts();
                const mainRect = layouts['main'];
                const mainH = mainRect?.h ?? cssH - (p.hideTimeScale ? 0 : X_AXIS_HEIGHT);
                const mainOY = mainRect?.y ?? 0;
                const rawTs = transformer.xToTs(x, chartW);
                const ts = snapTs(rawTs);
                const rawPrice = transformer.yToPrice(y - mainOY, mainH);
                const draft = draftRef.current;
                let price = rawPrice;
                if (isHoldingShiftRef.current && draft?.['a']?.price) {
                    price = draft['a'].price;
                } else if (e.ctrlKey || chartSettingsRef.current.crosshairMode === 'magnet') {
                    price = snapPrice(ts, rawPrice);
                }
                const anchor: Anchor = { ts, price };
                const tool = activeToolRef.current;
                // The armed tool already carries the id the drawing will take and
                // the style it will be created with (the toolbar seeds both), so
                // every branch below builds its shape and lets these fill the rest.
                // Defaults underneath in case a host armed the tool by hand with a
                // partial style.
                const id = tool.id || nanoid();
                const style = { ...(defaultStyleForTool(tool.name) as any), ...tool.state };

                const commit = (d: Drawing) => {
                    drawingsRef.current = [...drawingsRef.current, d];
                    draftRef.current = null;
                    applyTool(CURSOR_TOOL);
                    selectedDrawingIdRef.current = d.id;
                    setSelectedDrawingId(d.id);
                    pushDrawParams();
                    renderEngineRef.current?.markDirty('drawings');
                    updateSettingsBarPos(d.id);
                    if (d.tool === 'fvp') {
                        runIndicatorWorker(
                            getTradesUpToHorizon(horizonRef.current),
                            activeTimeframeRef.current.barNs,
                        );
                    }
                };

                // Plugin drawing tool
                const pluginTool = drawingRegistry.get(tool.name);

                if (pluginTool?.onPointerDown) {
                    const consumed = pluginTool.onPointerDown(
                        buildPluginToolEvent(e, ts, price, pluginTool),
                    );
                    if (consumed) return;
                }
                if (pluginTool && pluginTool.anchorCount === 0) return;
                if (pluginTool) {
                    const pd = draft as PluginDraftDrawing | null;
                    const newAnchors = pd ? [...pd.anchors, anchor] : [anchor];

                    if (
                        typeof pluginTool.anchorCount === 'number' &&
                        newAnchors.length >= pluginTool.anchorCount
                    ) {
                        commit({
                            id: nanoid(),
                            tool: pluginTool.id,
                            anchors: newAnchors,
                            data: initialPluginData(pluginTool.id),
                        } as any);
                    } else {
                        draftRef.current = {
                            pluginToolId: pluginTool.id,
                            anchors: newAnchors,
                            data: pd?.data ?? initialPluginData(pluginTool.id),
                        } as any;
                        pushDrawParams();
                        renderEngineRef.current?.markDirty('drawings');
                    }
                    return;
                }

                // `base` is everything a new drawing gets for free: its identity
                // and the armed style. Each branch adds only its own geometry.
                const base = { ...style, id, tool: tool.name };

                switch (tool.name) {
                    // One click is the whole drawing
                    case 'hline':
                        commit({ ...base, price } as Drawing);
                        break;
                    case 'vline':
                        commit({ ...base, ts } as Drawing);
                        break;
                    case 'hray':
                    case 'cross-line':
                        commit({ ...base, price, ts } as Drawing);
                        break;
                    case 'text':
                        setPendingText({ x, y, anchor });
                        break;

                    // Positions are placed whole: one click drops a box sized off
                    // the visible price range, so a fresh trade reads the same on
                    // NQ as on BTC - a 2:1 taking up roughly a fifth of the screen.
                    case 'long':
                    case 'short': {
                        const tick = resolveTickSize(symbolInfoRef.current);
                        const span = Math.abs(
                            transformer.yToPrice(0, mainH) - transformer.yToPrice(mainH, mainH),
                        );
                        const risk = Math.max(Math.round((span * 0.05) / tick), 1) * tick;
                        const isLong = tool.name === 'long';
                        commit({
                            ...base,
                            a: anchor,
                            b: { ...anchor, ts: anchor.ts + activeTimeframeRef.current.barNs * 10n },
                            upAmount: isLong ? risk * 2 : risk,
                            downAmount: isLong ? risk : risk * 2,
                        } as Drawing);
                        break;
                    }

                    // Multi-click tools
                    // The first click opens a draft carrying the style, so the
                    // ghost looks like what it will commit to; later clicks close
                    // it. Unknown tools land here too and simply open a draft.
                    default: {
                        if (!draft) {
                            draftRef.current = { ...base, a: anchor, b: null } as DraftDrawing;
                            pushDrawParams();
                            renderEngineRef.current?.markDirty('drawings');
                            updateSettingsBarPos(selectedDrawingIdRef.current);
                            break;
                        }

                        const a = (draft as any).a as Anchor;
                        const b = (draft as any).b as Anchor | null;

                        switch (tool.name) {
                            case 'line':
                            case 'info-line':
                            case 'trend-angle':
                            case 'ray':
                            case 'extended-line':
                            case 'rect':
                            case 'fib':
                            case 'fvp':
                                commit({ ...base, a, b: anchor } as Drawing);
                                break;
                            // Three-point tools: the second click sets `b` and the
                            // third one closes the shape.
                            case 'triangle':
                                if (b) commit({ ...base, a, b, c: anchor } as Drawing);
                                else draftRef.current = { ...draft, b: anchor } as DraftDrawing;
                                break;
                            case 'parallel-channel':
                                if (b)
                                    commit({
                                        ...base,
                                        a,
                                        b,
                                        height: price - b.price,
                                    } as Drawing);
                                else draftRef.current = { ...draft, b: anchor } as DraftDrawing;
                                break;
                        }
                    }
                }
                e.stopPropagation();
                return;
            }

            if (inChart) {
                const hit = hitTestDrawings(
                    x,
                    y,
                    drawingsRef.current,
                    view,
                    panesRef.current,
                    cssW,
                    cssH,
                    transformer,
                    p.hideTimeScale,
                    p.priceScaleWidthRef.current,
                    p.symbolInfoRef.current
                );

                const d = hit ? drawingsRef.current.find((d) => d.id === hit.drawingId) : undefined;
                const isFvpBodyHit = d?.tool === 'fvp' && hit?.anchor === 'body';

                const tapFirst =
                    lastInputTouchRef.current && selectedDrawingIdRef.current !== hit?.drawingId;
                if (hit && tapFirst) touchTapSelect = hit.drawingId;
                if (hit && !tapFirst) {
                    if (d) {
                        // Selection only. The active tool stays on the cursor -
                        // arming it here would turn the next click into a second
                        // copy of whatever was just selected. What is selected is
                        // published separately, via selectedDrawingId.
                        selectedDrawingIdRef.current = hit.drawingId;
                        setSelectedDrawingId(hit.drawingId);
                        updateSettingsBarPos(hit.drawingId);

                        //@ts-ignore
                        if (!d.locked && !isFvpBodyHit) {
                            const layouts = getLayouts();
                            const mainRect = layouts['main'];
                            const mainH =
                                mainRect?.h ?? cssH - (p.hideTimeScale ? 0 : X_AXIS_HEIGHT);
                            const mainOY = mainRect?.y ?? 0;
                            draggingAnchorRef.current = hit;
                            dragPrevDataRef.current = {
                                ts: transformer.xToTs(x, chartW),
                                price: transformer.yToPrice(y - mainOY, mainH),
                            };
                            dragPrevPixelRef.current = { x, y };
                            canvas.style.cursor = cursorForAnchor(hit.anchor);
                        }

                        pushDrawParams();
                        renderEngineRef.current?.markDirty('drawings');
                        if (!isFvpBodyHit) {
                            e.stopPropagation();
                            return;
                        }
                    }
                }

                if (!isFvpBodyHit && selectedDrawingIdRef.current && lastInputTouchRef.current) {
                    touchTapDeselect = true;
                } else if (!isFvpBodyHit && selectedDrawingIdRef.current) {
                    selectedDrawingIdRef.current = null;
                    setSelectedDrawingId(null);
                    setSettingsBarPos(null);
                    pushDrawParams();
                    renderEngineRef.current?.markDirty('drawings');
                }
            }

            if (inChart && activeToolRef.current.name === 'cursor') {
                if (showShiftInfo.current && !shiftAnchor2Ref.current) {
                    const layouts = getLayouts();
                    const mainRect = layouts['main'];
                    const mainH = mainRect?.h ?? cssH - (p.hideTimeScale ? 0 : X_AXIS_HEIGHT);
                    const mainOY = mainRect?.y ?? 0;
                    const chartWInner = cssW - priceScaleWidthRef.current;

                    const tRange = Number(viewRef.current.tMax - viewRef.current.tMin);
                    const fraction = Math.max(0, Math.min(1, x / chartWInner));
                    const ts = viewRef.current.tMin + BigInt(Math.round(fraction * tRange));

                    const priceRange = viewRef.current.pMax - viewRef.current.pMin;
                    const priceFrac = 1 - Math.max(0, Math.min(1, (y - mainOY) / mainH));
                    const price = viewRef.current.pMin + priceRange * priceFrac;
                    shiftAnchor2Ref.current = { ts, price, x, y };

                    pushDrawParams();
                    renderEngineRef.current?.markDirty('ui');
                } else {
                    showShiftInfo.current = false;
                    shiftAnchorRef.current = null;
                    shiftAnchor2Ref.current = null;
                    pushDrawParams();
                    renderEngineRef.current?.markDirty('ui');
                }
            }

            if (
                e.shiftKey &&
                inChart &&
                activeToolRef.current.name === 'cursor' &&
                !showShiftInfo.current
            ) {
                const layouts = getLayouts();
                const mainRect = layouts['main'];
                const mainH = mainRect?.h ?? cssH - (p.hideTimeScale ? 0 : X_AXIS_HEIGHT);
                const mainOY = mainRect?.y ?? 0;
                const chartWInner = cssW - priceScaleWidthRef.current;

                const tRange = Number(viewRef.current.tMax - viewRef.current.tMin);
                const fraction = Math.max(0, Math.min(1, x / chartWInner));
                const ts = viewRef.current.tMin + BigInt(Math.round(fraction * tRange));

                const priceRange = viewRef.current.pMax - viewRef.current.pMin;
                const priceFrac = 1 - Math.max(0, Math.min(1, (y - mainOY) / mainH));
                const price = viewRef.current.pMin + priceRange * priceFrac;

                showShiftInfo.current = true;
                shiftAnchorRef.current = { ts, price, x, y };
                shiftAnchor2Ref.current = null;
                pushDrawParams();
                renderEngineRef.current?.markDirty('ui');
                e.stopPropagation();
                return; // don't start a pan
            }

            isDragging.current = true;
            hasDragged.current = false;
            lastMouse.current = { x: e.clientX, y: e.clientY };

            if (hoveredDividerIdxRef.current >= 0) hoveredDividerIdxRefLocked.current = true;

            const dividerIdx = hitTestDivider(y, panesRef.current, layouts);
            if (dividerIdx !== -1) {
                draggingDividerRef.current = dividerIdx;
                dragPaneIdRef.current = null;
                dragMode.current = 'none';
            } else if (x > cssW - priceScaleWidthRef.current) {
                draggingDividerRef.current = -1;
                dragPaneIdRef.current = hitTestPane(y, panesRef.current, layouts)?.id ?? null;
                dragMode.current = 'scaleY';
            } else if (y > cssH - (p.hideTimeScale ? 0 : X_AXIS_HEIGHT)) {
                draggingDividerRef.current = -1;
                dragPaneIdRef.current = null;
                dragMode.current = 'scaleX';
                horizonScrollAnimRef.current = null;
                const chartW = cssW - priceScaleWidthRef.current;
                const v = viewRef.current;
                scaleXStart = v && chartW - x > 24 ? { x0: x, tMin0: v.tMin, tMax0: v.tMax } : null;
            } else {
                draggingDividerRef.current = -1;
                dragPaneIdRef.current = hitTestPane(y, panesRef.current, layouts)?.id ?? null;
                dragMode.current = 'pan';
                horizonScrollAnimRef.current = null;
            }
            longPressTimer.current = setTimeout(() => {
                showTooltipRef.current = true;
            }, 500);
            pushDrawParams();
            renderEngineRef.current?.markDirty('ui');
            renderEngineRef.current?.markDirty('base');
        };

        const handleMouseUp = (e: MouseEvent) => {
            pressAt = null;
            // Trade line drag end
            {
                const tl = tradeLineInteractionRef.current;
                const synth = {
                    currentTarget: canvas,
                    stopPropagation: () => {},
                    preventDefault: () => {},
                    clientX: e.clientX,
                    clientY: e.clientY,
                    button: e.button,
                } as any;
                tl.onMouseUp(synth);
            }
            const dpr = getEffectiveDpr();

            const cssW = canvas.width / dpr;
            const cssH = canvas.height / dpr;

            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            if (draggingAnchorRef.current) {
                const id = draggingAnchorRef.current.drawingId;
                draggingAnchorRef.current = null;
                dragPrevDataRef.current = null;
                dragPrevPixelRef.current = null;
                pushDrawParams();
                renderEngineRef.current?.markDirty('drawings');
                canvas.style.cursor = 'crosshair';
                updateSettingsBarPos(id);
                const movedDrawing = drawingsRef.current.find((d) => d.id === id);
                if (movedDrawing?.tool === 'fvp') {
                    runIndicatorWorker(
                        getTradesUpToHorizon(horizonRef.current),
                        activeTimeframeRef.current.barNs,
                    );
                }
                return;
            }

            if (activeToolRef.current.name !== 'cursor') {
                const pluginTool = drawingRegistry.get(activeToolRef.current.name);
                if (pluginTool?.onPointerUp) {
                    const chartW = cssW - priceScaleWidthRef.current;
                    const inChart = x < chartW && y < cssH - (p.hideTimeScale ? 0 : X_AXIS_HEIGHT);
                    if (inChart) {
                        const layouts = getLayouts();
                        const mainRect = layouts['main'];
                        const mainH = mainRect?.h ?? cssH - (p.hideTimeScale ? 0 : X_AXIS_HEIGHT);
                        const mainOY = mainRect?.y ?? 0;
                        const rawTs = transformer.xToTs(x, chartW);
                        const ts = snapTs(rawTs);
                        const rawPrice = transformer.yToPrice(y - mainOY, mainH);
                        let price = rawPrice;
                        const consumed = pluginTool.onPointerUp(
                            buildPluginToolEvent(e, ts, price, pluginTool),
                        );
                        if (consumed) return;
                    }
                }
            }

            if (longPressTimer.current) clearTimeout(longPressTimer.current);
            hoveredDividerIdxRefLocked.current = false;
            showTooltipRef.current = false;
            isDragging.current = false;
            dragMode.current = 'none';
            draggingDividerRef.current = -1;
            dragPaneIdRef.current = null;
            autofitIndicatorPanes();
            // Let go of a TP/SL drag without moving the mouse and the pointer is
            // still sitting on that line - it should still say so, rather than
            // snapping back to the crosshair until the next mouse move.
            const tlCursorUp = tradeLineInteractionRef.current.cursorRef?.current ?? 'default';
            if (tlCursorUp !== 'default') {
                canvas.style.cursor = tlCursorUp;
            } else if (x > cssW - priceScaleWidthRef.current) {
                canvas.style.cursor = 'ns-resize';
            } else if (y > cssH - (p.hideTimeScale ? 0 : X_AXIS_HEIGHT)) {
                canvas.style.cursor = 'ew-resize';
            } else {
                canvas.style.cursor = 'crosshair';
            }
            if (!hasDragged.current) handleClick(e);

            // viewRef is null until this pane has data/a view - guard so panning a
            // not-yet-loaded pane doesn't throw.
            if (viewRef.current && viewRef.current.tMin < datasetStartRef.current) {
                eventBus.emit('data:request-backward', {
                    viewMin: viewRef.current.tMin,
                    symbol: symbolInfoRef.current?.symbol,
                });
            }
        };

        const handleClick = (e: MouseEvent) => {
            const view = viewRef.current;
            if (!view) return;
            // Don't treat a click as a chart click when the cursor is over something
            // covering the canvas (overlay, toolbar, external component, etc.)
            if (document.elementFromPoint(e.clientX, e.clientY) !== canvas) return;

            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const dpr = getEffectiveDpr();

            const cssW = canvas.width / dpr;
            const cssH = canvas.height / dpr;
            const chartW = cssW - priceScaleWidthRef.current;
            const chartH = cssH - (p.hideTimeScale ? 0 : X_AXIS_HEIGHT);
            if (x > chartW || y > chartH) return;

            {
                const tl = tradeLineInteractionRef.current;
                const synth = {
                    currentTarget: canvas,
                    stopPropagation: () => {},
                    preventDefault: () => {},
                    clientX: e.clientX,
                    clientY: e.clientY,
                } as any;
                tl.onClick(synth);
                const tlCursor = tl.cursorRef?.current ?? tl.cursor;
                if (!isDragging.current && tlCursor !== 'default') {
                    canvas.style.cursor = tlCursor;
                }
            }

            if (!chartSettingsRef.current.showTradeDots) return;
            const mainPaneH = getLayouts()['main']?.h ?? chartH;
            selectedTradeRef.current = findNearestTrade(
                x,
                y,
                tradesRef.current,
                view,
                chartW,
                mainPaneH,
                chartSettingsRef.current,
                horizonRef.current,
                transformer,
            );
            pushDrawParams();
            renderEngineRef.current?.markDirty('ui');
        };

        const handleMouseDownWindow = (e: MouseEvent) => {
            if(showTimeframeWindowRef.current){
                if(e.target){
                    //@ts-ignore
                    if(e.target.id === 'change-timeframe'){
                        setShowTimeframeWindow(false);
                        setTimeframeWindowInput('');
                    }
                }
            }
        }

        const handleDoubleClick = (e: MouseEvent) => {
            // Trade line double-click
            {
                const tl = tradeLineInteractionRef.current;
                let captured = false;
                const synth = {
                    currentTarget: canvas,
                    stopPropagation: () => {
                        captured = true;
                    },
                    preventDefault: () => {},
                    clientX: e.clientX,
                    clientY: e.clientY,
                } as any;
                tl.onDoubleClick(synth);
                if (captured) return;
            }

            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const dpr = getEffectiveDpr();

            const cssW = canvas.width / dpr;
            const cssH = canvas.height / dpr;

            if (
                x <= cssW - priceScaleWidthRef.current &&
                y <= cssH - (p.hideTimeScale ? 0 : X_AXIS_HEIGHT)
            ) {
                const hit = hitTestDrawings(
                    x,
                    y,
                    drawingsRef.current,
                    viewRef.current,
                    panesRef.current,
                    cssW,
                    cssH,
                    transformer,
                    p.hideTimeScale,
                    p.priceScaleWidthRef.current,
                    p.symbolInfoRef.current
                );
                if (hit) {
                    const d = drawingsRef.current.find((d) => d.id === hit.drawingId);
                    if (d?.tool === 'text') {
                        setSelectedDrawingId(hit.drawingId);
                        selectedDrawingIdRef.current = hit.drawingId;
                        setEditingTextId(hit.drawingId);
                        return;
                    }

                    setSelectedDrawingId(hit.drawingId);
                    selectedDrawingIdRef.current = hit.drawingId;
                    updateSettingsBarPos(hit.drawingId);
                    setOpenSettingsDialog(true);
                    pushDrawParams();
                    renderEngineRef.current?.markDirty('drawings');
                    return;
                }
            }

            if (x > cssW - priceScaleWidthRef.current) {
                const layouts = getLayouts();
                const clickedPane = hitTestPane(y, panesRef.current, layouts);
                if (clickedPane && !clickedPane.isMain) {
                    const ind = indicatorsRef.current.find((i) => i.paneId === clickedPane.id);
                    const { tMin, tMax } = viewRef.current;
                    const autoBounds = ind?.getAutoYBounds?.(tMin, tMax, horizonRef.current);
                    setPanes((prev) => {
                        const next = prev.map((p) => {
                            if (p.id !== clickedPane.id) return p;
                            return {
                                ...p,
                                yAxisAuto: true,
                                ...(autoBounds
                                    ? { yMin: autoBounds.min, yMax: autoBounds.max }
                                    : {}),
                            };
                        });
                        panesRef.current = next;
                        recomputeLayouts();
                        return next;
                    });
                    if (autoBounds) {
                        panesRef.current = panesRef.current.map((p) =>
                            p.id === clickedPane.id
                                ? {
                                      ...p,
                                      yAxisAuto: true,
                                      yMin: autoBounds.min,
                                      yMax: autoBounds.max,
                                  }
                                : p,
                        );
                    }
                    pushDrawParams();
                    updateSettingsBarPos(selectedDrawingIdRef.current);
                    renderEngineRef.current?.markAllDirty();
                    return;
                }
                isYAxisAutoRef.current = true;
                setChartSettings((prev) => ({ ...prev, autoScale: isYAxisAutoRef.current }));
                const view = viewRef.current;
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
                scheduleResample();
                pushDrawParams();
                renderEngineRef.current?.markAllDirty();
            } else if (y > cssH - (p.hideTimeScale ? 0 : X_AXIS_HEIGHT)) {
                resetXAxis();
            }
        };

        // Re-emit the status-bar OHLCV computation for a given crosshair x.
        // Throttled to ~30fps and shared by the mouse-move and playback-tick
        // paths so both refresh at the same rate.
        const emitStatusCompute = (x: number) => {
            const view = viewRef.current;
            if (!view) return;
            const now = performance.now();
            if (now - lastStatusLineUpdateRef.current <= 33) return;
            lastStatusLineUpdateRef.current = now;
            const dpr = getEffectiveDpr();
            const chartW = canvas.width / dpr - priceScaleWidthRef.current;
            eventBus.emit('status:compute', {
                cellId,
                x,
                priceHistory: priceHistoryRef.current,
                trades: tradesRef.current,
                bounds: view,
                chartW,
                barNs: activeTimeframeRef.current.barNs,
                candleCache: candleCacheRef.current,
                bars: ohlcvBarsRef.current.display,
                openBar: openBarRef.current,
                horizon: horizonRef.current,
                dataLevel: dataLevelRef.current,
                transformer: transformer,
            });
        };

        const handleMouseMove = (e: MouseEvent) => {
            // A grid-divider resize owns the pointer - stand down (no crosshair/pan)
            // and clear any lingering crosshair so it doesn't sit under the cursor.
            if (pointerLock.locked) {
                if (crosshairRef.current) {
                    crosshairRef.current = null;
                    renderEngineRef.current?.markDirty('ui');
                }
                return;
            }

            isHoldingCtrlRef.current = e.ctrlKey;
            isHoldingShiftRef.current = e.shiftKey;

            const slop = lastInputTouchRef.current ? 8 : 3;
            if (
                pressAt &&
                (Math.abs(e.clientX - pressAt.x) > slop || Math.abs(e.clientY - pressAt.y) > slop)
            ) {
                hasDragged.current = true;
            }

            const dpr = getEffectiveDpr();
            const cssW = canvas.width / dpr;
            const cssH = canvas.height / dpr;

            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const view = viewRef.current;
            if (!view) return;

            // Trade line hover/drag (runs every move, doesn't block chart)
            let tradeLineClaimed = false;
            {
                const tl = tradeLineInteractionRef.current;
                const synth = {
                    currentTarget: canvas,
                    stopPropagation: () => {},
                    preventDefault: () => {},
                    clientX: e.clientX,
                    clientY: e.clientY,
                } as any;
                tl.onMouseMove(synth);
                // Read the ref, not the state: onMouseMove just set it, and the
                // state won't carry the new value until the next render.
                const tlCursor = tl.cursorRef?.current ?? tl.cursor;
                if (!isDragging.current && tlCursor !== 'default') {
                    canvas.style.cursor = tlCursor;
                    tradeLineClaimed = true;
                }
            }

            const outsideCanvas = x < 0 || y < 0 || x > cssW || y > cssH;
            if (outsideCanvas && !isDragging.current && !draggingAnchorRef.current) {
                if (crosshairRef.current !== null) {
                    crosshairRef.current = null;
                    pushDrawParams();
                    renderEngineRef.current?.markDirty('ui');
                }
                return;
            }

            // Auto-suppress when something is visually covering the canvas at the cursor
            // position - toolbar buttons, dialogs, overlaid React components, or any external
            // component rendered on top of the chart.  Because uiCanvas and drawingsCanvas are
            // pointer-events:none, elementFromPoint falls through to baseCanvas when the cursor
            // is genuinely over the chart area; anything else means "something is on top".
            // We skip this check while dragging so that pan/zoom still tracks the mouse even
            // when it strays outside the canvas.
            if (!isDragging.current && !draggingAnchorRef.current && !touchCrosshairMoving) {
                const topEl = document.elementFromPoint(e.clientX, e.clientY);
                if (topEl !== canvas) {
                    if (crosshairRef.current !== null) {
                        crosshairRef.current = null;
                        pushDrawParams();
                        renderEngineRef.current?.markDirty('ui');
                    }
                    return;
                }
            }

            const chartW = cssW - priceScaleWidthRef.current;
            const inChart = x < chartW && y < cssH - (p.hideTimeScale ? 0 : X_AXIS_HEIGHT);

            crosshairRef.current = hideTouchPointer ? null : { x, y };
            if (!hideTouchPointer) {
                eventBus.emit('crosshair:move', { x, y });
                emitStatusCompute(x);
            }

            if (draggingAnchorRef.current) {
                const { drawingId, anchor } = draggingAnchorRef.current;
                const layouts = getLayouts();
                const mainRect = layouts['main'];
                const mainH = mainRect?.h ?? cssH - (p.hideTimeScale ? 0 : X_AXIS_HEIGHT);
                const mainOY = mainRect?.y ?? 0;

                const rawCurTs = transformer.xToTs(x, chartW);
                const curTs = snapTs(rawCurTs);
                let rawCurPrice = transformer.yToPrice(y - mainOY, mainH);
                let curPrice = rawCurPrice;
                if (
                    (e.ctrlKey || chartSettingsRef.current.crosshairMode === 'magnet') &&
                    anchor !== 'body'
                ) {
                    curPrice = snapPrice(curTs, rawCurPrice);
                    rawCurPrice = curPrice;
                }
                const prev = dragPrevDataRef.current;

                if (prev) {
                    const dts =
                        ((curTs - prev.ts) / activeTimeframeRef.current.barNs) *
                        activeTimeframeRef.current.barNs;
                    const dprice = curPrice - prev.price;

                    drawingsRef.current = drawingsRef.current.map((d) => {
                        if (d.id !== drawingId) return d;

                        if (d.tool === 'text' && (d as any).screenAnchored) {
                            const prevPx = dragPrevPixelRef.current;
                            if (prevPx) {
                                const dx = x - prevPx.x;
                                const dy = y - prevPx.y;
                                const curScreenX = ((d as any).screenX ?? x) + dx;
                                const curScreenY = ((d as any).screenY ?? y) + dy;
                                return { ...d, screenX: curScreenX, screenY: curScreenY } as any;
                            }
                            return d;
                        }

                        const { drawing, anchor: newAnchor } = moveDrawingAnchorDelta(
                            d,
                            anchor,
                            dts,
                            dprice,
                            curTs,
                            curPrice,
                            isHoldingShiftRef.current,
                        );
                        if (newAnchor !== anchor && draggingAnchorRef.current) {
                            draggingAnchorRef.current = { drawingId, anchor: newAnchor };
                        }
                        return drawing;
                    });
                }

                dragPrevDataRef.current = { ts: curTs, price: curPrice };
                dragPrevPixelRef.current = { x, y };

                if (fvpLiveRecalcRef.current) {
                    const dragged = drawingsRef.current.find(
                        (d) => d.id === draggingAnchorRef.current?.drawingId,
                    );
                    if (dragged?.tool === 'fvp') {
                        const fvpDrawing = dragged as FixedVolumeProfileDrawing;
                        const result = computeFvpSync(fvpDrawing, horizonRef.current);
                        (dragged as any).vpData = result;
                        if (result.prices.length > 0) {
                            const pad = resolveTickSize(symbolInfoRef.current) / 2;
                            (dragged as any).a = {
                                ts: fvpDrawing.a.ts,
                                price: result.prices[0] - pad,
                            };
                            (dragged as any).b = {
                                ts: fvpDrawing.b.ts,
                                price: result.prices[result.prices.length - 1] + pad,
                            };
                        }
                        drawingsRef.current = [...drawingsRef.current];
                    }
                }

                setSettingsBarPos(null);

                // Keep the cursor in sync - moveDrawingAnchorDelta may have
                // flipped which handle is active (e.g. dragging a corner past the
                // opposite edge swaps tl<->br).
                canvas.style.cursor = cursorForAnchor(draggingAnchorRef.current?.anchor ?? null);

                pushDrawParams();
                renderEngineRef.current?.markDirty('drawings');
                renderEngineRef.current?.markDirty('ui');
                return;
            }

            if (activeToolRef.current.name !== 'cursor') {
                const draft = draftRef.current;

                const layouts = getLayouts();
                const mainRect = layouts['main'];
                const mainH = mainRect?.h ?? cssH - (p.hideTimeScale ? 0 : X_AXIS_HEIGHT);
                const mainOY = mainRect?.y ?? 0;
                const rawCurTs = transformer.xToTs(x, chartW);
                const curTs = snapTs(rawCurTs);
                const rawCurPrice = transformer.yToPrice(y - mainOY, mainH);
                const curPrice =
                    e.ctrlKey || chartSettingsRef.current.crosshairMode === 'magnet'
                        ? snapPrice(curTs, rawCurPrice)
                        : rawCurPrice;

                if (
                    draft &&
                    (draft.tool === 'rect' ||
                        draft.tool === 'fib' ||
                        draft.tool === 'line' ||
                        draft.tool === 'ray' ||
                        draft.tool === 'fvp')
                ) {
                    (draft as any).b = { ts: curTs, price: curPrice };

                    if (draft && 'pluginToolId' in draft) {
                        pushDrawParams();
                        renderEngineRef.current?.markDirty('drawings');
                    }
                }

                const pluginTool = drawingRegistry.get(activeToolRef.current.name);
                if (pluginTool?.onPointerMove) {
                    const consumed = pluginTool.onPointerMove(
                        buildPluginToolEvent(e, curTs, curPrice, pluginTool),
                    );
                    if (consumed) return;
                }
                pushDrawParams();
                renderEngineRef.current?.markDirty('drawings');
                updateSettingsBarPos(selectedDrawingIdRef.current);
                renderEngineRef.current?.markDirty('ui');
                canvas.style.cursor = 'crosshair';
                return;
            }

            if (inChart && !isDragging.current) {
                const hit = hitTestDrawings(
                    x,
                    y,
                    drawingsRef.current,
                    view,
                    panesRef.current,
                    cssW,
                    cssH,
                    transformer,
                    p.hideTimeScale,
                    p.priceScaleWidthRef.current,
                    p.symbolInfoRef.current
                );
                const newHoverId = hit?.drawingId ?? null;
                const newHotAnchor = hit?.anchor ?? null;

                if (
                    newHoverId !== hoveredDrawingIdRef.current ||
                    newHotAnchor !== hotAnchorRef.current
                ) {
                    hoveredDrawingIdRef.current = newHoverId;
                    hotAnchorRef.current = newHotAnchor;
                    pushDrawParams();
                    renderEngineRef.current?.markDirty('drawings');
                    updateSettingsBarPos(selectedDrawingIdRef.current);
                }

                if (newHoverId && !tradeLineClaimed) {
                    const d = drawingsRef.current.find((d) => d.id === newHoverId);
                    //@ts-ignore
                    if (d && !d?.locked) {
                        canvas.style.cursor = cursorForAnchor(newHotAnchor);
                    } else {
                        canvas.style.cursor = 'default';
                    }
                } else if (!tradeLineClaimed) {
                    // Was unconditional, which put the crosshair straight back
                    // over the ns-resize/pointer the trade lines had just asked
                    // for - the reason those lines gave no cursor feedback at all.
                    canvas.style.cursor = 'crosshair';
                }
            }

            const layouts = getLayouts();
            const dividerIdx = hitTestDivider(y, panesRef.current, layouts);
            const hoverPane = hitTestPane(y, panesRef.current, layouts);
            const activePane =
                isDragging.current && dragPaneIdRef.current
                    ? (panesRef.current.find((p) => p.id === dragPaneIdRef.current) ?? hoverPane)
                    : hoverPane;

            if (isDragging.current) {
                if (longPressTimer.current) {
                    clearTimeout(longPressTimer.current);
                    longPressTimer.current = null;
                }
                showTooltipRef.current = false;
            }

            const onDivider = !isDragging.current && dividerIdx !== -1;
            const isScaling =
                isDragging.current &&
                (dragMode.current === 'scaleY' || dragMode.current === 'scaleX');

            crosshairRef.current = onDivider || isScaling || hideTouchPointer ? null : { x, y };

            const newPaneId = hoverPane?.id ?? null;
            if (newPaneId !== hoveredPaneIdRef.current) {
                if (hoveredDividerIdxRef.current < 0) {
                    hoveredPaneIdRef.current = newPaneId;
                    if (newPaneId) eventBus.emit('pane:hovered', { id: newPaneId });
                }
            }

            const newDivIdx = onDivider ? dividerIdx : -1;
            if (newDivIdx !== hoveredDividerIdxRef.current && !hoveredDividerIdxRefLocked.current) {
                hoveredDividerIdxRef.current = newDivIdx;
                eventBus.emit('pane:hovered', null);
            }

            if (isDragging.current && dragMode.current === 'pan') {
                canvas.style.cursor = 'grabbing';
            } else if (
                isDragging.current &&
                (dragMode.current === 'scaleY' || dragMode.current === 'scaleX')
            ) {
                canvas.style.cursor = dragMode.current === 'scaleY' ? 'ns-resize' : 'ew-resize';
            } else if (!isDragging.current && !tradeLineClaimed) {
                if (draggingDividerRef.current === -1 && dividerIdx !== -1) {
                    canvas.style.cursor = 'ns-resize';
                } else if (x > cssW - priceScaleWidthRef.current) {
                    canvas.style.cursor = 'ns-resize';
                } else if (y > cssH - (p.hideTimeScale ? 0 : X_AXIS_HEIGHT)) {
                    canvas.style.cursor = 'ew-resize';
                }
            }

            if (isDragging.current && viewRef.current) {
                const dx = e.clientX - lastMouse.current.x;
                const dy = e.clientY - lastMouse.current.y;
                lastMouse.current = { x: e.clientX, y: e.clientY };
                const view = viewRef.current;
                const chartW = cssW - priceScaleWidthRef.current;

                if (draggingDividerRef.current !== -1) {
                    const divIdx = draggingDividerRef.current;
                    const next = panesRef.current.map((p) => ({ ...p }));
                    const totalH = cssH - (p.hideTimeScale ? 0 : X_AXIS_HEIGHT);
                    const totalRatio = next.reduce((s, p) => s + p.heightRatio, 0);
                    const pixPerRatio = totalH / totalRatio;
                    const delta = dy / pixPerRatio;
                    const newAbove = next[divIdx].heightRatio + delta;
                    const newBelow = next[divIdx + 1].heightRatio - delta;
                    const minRatio = PANE_MIN_HEIGHT_RATIO * totalRatio;
                    if (newAbove >= minRatio && newBelow >= minRatio) {
                        next[divIdx].heightRatio = newAbove;
                        next[divIdx + 1].heightRatio = newBelow;
                    }
                    panesRef.current = next;
                    setPanes(next);
                    const layouts = getPaneLayouts(next, totalH, cssW, priceScaleWidthRef.current);
                    applyLayoutsToDom(layouts);
                    // No pushDrawParams here (or in the drag branches below): the
                    // tail of this handler pushes once for every mouse move, and
                    // nothing paints in between - it runs in the rAF loop. Pushing
                    // in the branch as well rebuilt the whole draw-params snapshot
                    // twice per frame for the entire duration of a drag.
                    renderEngineRef.current?.markDirty('base');
                    renderEngineRef.current?.markDirty('drawings');
                    updateSettingsBarPos(selectedDrawingIdRef.current);
                    renderEngineRef.current?.markDirty('ui');
                } else if (dragMode.current === 'pan') {
                    panBy(view, dx, dy, chartW, cssH, activePane);
                } else if (dragMode.current === 'scaleY') {
                    if (activePane && !activePane.isMain) {
                        const updated = panesRef.current.map((p) => {
                            if (p.id !== activePane.id) return p;
                            const span = p.yMax - p.yMin;
                            const center = p.yMin + span / 2;
                            const newSpan =
                                span *
                                (1 +
                                    dy *
                                        0.002 *
                                        chartSettingsRef.current.priceAxisResizeSensitivity);
                            return {
                                ...p,
                                yMin: center - newSpan / 2,
                                yMax: center + newSpan / 2,
                                yAxisAuto: false,
                            };
                        });
                        panesRef.current = updated;
                        setPanes(updated);
                    } else {
                        isYAxisAutoRef.current = false;
                        setChartSettings((prev) => ({
                            ...prev,
                            autoScale: isYAxisAutoRef.current,
                        }));
                        const factor =
                            1 + dy * 0.002 * chartSettingsRef.current.priceAxisResizeSensitivity;
                        [view.pMin, view.pMax] = scalePriceBounds(
                            view.pMin,
                            view.pMax,
                            factor,
                            transformer.getScaleMode() === 'log',
                        );
                    }
                    scheduleResample();
                    renderEngineRef.current?.markDirty('base');
                    renderEngineRef.current?.markDirty('drawings');
                    updateSettingsBarPos(selectedDrawingIdRef.current);
                } else if (dragMode.current === 'scaleX') {
                    const sm = transformer.getSessionMapper();
                    const ord = transformer.getOrdinal();
                    const { min: MIN_SPAN, max: MAX_SPAN } = getZoomLimits();

                    const start = scaleXStart;
                    const tMin0 = start ? start.tMin0 : view.tMin;
                    const tMax0 = start ? start.tMax0 : view.tMax;
                    const factor = start
                        ? (chartW - start.x0) / Math.max(1, chartW - x)
                        : 1 + dx * 0.001;
                    // scales from the right edge until it uses the left to not push out the last bar
                    const last = lastBarTs();
                    const end =
                        last === null ? null : last - (activeTimeframeRef.current.barNs * 3n) / 2n;
                    let capped = false;
                    if (ord) {
                        const idxMax = transformer.tsToFracIndex(tMax0);
                        const idxSpan = idxMax - transformer.tsToFracIndex(tMin0);
                        const newSpan = Math.max(
                            Number(MIN_SPAN),
                            Math.min(Number(MAX_SPAN), idxSpan * factor),
                        );
                        const idxEnd = last === null ? null : transformer.tsToFracIndex(last) - 1.5;
                        if (idxEnd !== null && idxMax - newSpan > idxEnd) {
                            capped = true;
                            view.tMin = transformer.indexToTs(idxEnd);
                            view.tMax = transformer.indexToTs(idxEnd + newSpan);
                        } else {
                            view.tMin = transformer.indexToTs(idxMax - newSpan);
                            view.tMax = tMax0;
                        }
                    } else if (sm && sm.hasSession) {
                        const mMax = sm.tsToMarket(tMax0);
                        const mSpan = Number(mMax - sm.tsToMarket(tMin0));
                        const newMSpan = BigInt(Math.round(mSpan * factor));
                        const clamped =
                            newMSpan < MIN_SPAN
                                ? MIN_SPAN
                                : newMSpan > MAX_SPAN
                                  ? MAX_SPAN
                                  : newMSpan;
                        const mEnd = end === null ? null : sm.tsToMarket(end);
                        if (mEnd !== null && mMax - clamped > mEnd) {
                            capped = true;
                            view.tMin = sm.marketToTs(mEnd);
                            view.tMax = sm.marketToTs(mEnd + clamped);
                        } else {
                            view.tMin = sm.marketToTs(mMax - clamped);
                            view.tMax = tMax0;
                        }
                    } else {
                        const timeSpan = Number(tMax0 - tMin0);
                        const newSpan = BigInt(Math.round(timeSpan * factor));
                        const clamped =
                            newSpan < MIN_SPAN ? MIN_SPAN : newSpan > MAX_SPAN ? MAX_SPAN : newSpan;
                        capped = end !== null && tMax0 - clamped > end;
                        const tMin = capped ? end! : tMax0 - clamped;
                        view.tMin = tMin;
                        view.tMax = tMin + clamped;
                    }
                    // update the drag start to stick to current value once not capped
                    if (capped) {
                        scaleXStart =
                            chartW - x > 24 ? { x0: x, tMin0: view.tMin, tMax0: view.tMax } : null;
                    }

                    scheduleResample();
                    renderEngineRef.current?.markDirty('base');
                    renderEngineRef.current?.markDirty('drawings');
                    updateSettingsBarPos(selectedDrawingIdRef.current);
                }
            }

            getPanel()?.update(liveBookRef.current);
            pushDrawParams();
            onViewSettled();
            renderEngineRef.current?.markDirty('ui');
        };

        const handleMouseLeave = () => {
            // Trade line leave
            {
                const tl = tradeLineInteractionRef.current;
                const synth = {
                    currentTarget: canvas,
                    stopPropagation: () => {},
                    preventDefault: () => {},
                } as any;
                tl.onMouseLeave(synth);
            }

            crosshairRef.current = null;
            eventBus.emit('pane:hovered', null);
            hoveredDividerIdxRef.current = -1;
            clearDrawingHover();
            if (!isDragging.current) {
                pushDrawParams();
                renderEngineRef.current?.markDirty('ui');
            }
        };

        const handleWheel = (e: WheelEvent) => {
            e.preventDefault();
            stopGlide();
            if (!viewRef.current) return;
            const view = viewRef.current;
            const rect = canvas.getBoundingClientRect();
            const dpr = getEffectiveDpr();

            const cssW = canvas.width / dpr;
            const cssH = canvas.height / dpr;

            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;

            if (mouseX > cssW - priceScaleWidthRef.current) {
                const layouts = getLayouts();
                const hoveredPane = hitTestPane(mouseY, panesRef.current, layouts);
                if (hoveredPane && !hoveredPane.isMain) {
                    const updated = panesRef.current.map((p) => {
                        if (p.id !== hoveredPane.id) return p;
                        const span = p.yMax - p.yMin;
                        const center = p.yMin + span / 2;
                        const newSpan = span * (1 + e.deltaY * 0.001);
                        return {
                            ...p,
                            yMin: center - newSpan / 2,
                            yMax: center + newSpan / 2,
                            yAxisAuto: false,
                        };
                    });
                    panesRef.current = updated;
                    setPanes(updated);
                } else {
                    isYAxisAutoRef.current = false;
                    setChartSettings((prev) => ({ ...prev, autoScale: isYAxisAutoRef.current }));
                    const factor = 1 + e.deltaY * 0.001;
                    [view.pMin, view.pMax] = scalePriceBounds(
                        view.pMin,
                        view.pMax,
                        factor,
                        transformer.getScaleMode() === 'log',
                    );
                }
                scheduleResample();
                pushDrawParams();
                renderEngineRef.current?.markDirty('base');
                renderEngineRef.current?.markDirty('drawings');
                updateSettingsBarPos(selectedDrawingIdRef.current);
            } else if (mouseY <= cssH - (p.hideTimeScale ? 0 : X_AXIS_HEIGHT)) {
                const sm = transformer.getSessionMapper();
                const ord = transformer.getOrdinal();
                const { min: MIN_SPAN, max: MAX_SPAN } = getZoomLimits();
                const chartWidth = cssW - priceScaleWidthRef.current;

                if (ord) {
                    // Ordinal zoom: scale the visible column count.
                    const idxMin = transformer.tsToFracIndex(view.tMin);
                    const idxMax = transformer.tsToFracIndex(view.tMax);
                    const idxSpan = idxMax - idxMin;
                    const clampSpan = (s: number) =>
                        Math.max(Number(MIN_SPAN), Math.min(Number(MAX_SPAN), s));
                    if (!e.ctrlKey) {
                        const newSpan = clampSpan(idxSpan * (1 + e.deltaY * 0.0006));
                        view.tMin = transformer.indexToTs(idxMax - newSpan);
                    } else {
                        const f = mouseX / chartWidth;
                        const newSpan = clampSpan(idxSpan * (e.deltaY > 0 ? 1.1 : 0.9));
                        const cursorIdx = idxMin + f * idxSpan;
                        view.tMin = transformer.indexToTs(cursorIdx - newSpan * f);
                        view.tMax = transformer.indexToTs(cursorIdx + newSpan * (1 - f));
                    }
                } else if (sm && sm.hasSession) {
                    const mMin = sm.tsToMarket(view.tMin);
                    const mMax = sm.tsToMarket(view.tMax);
                    const mSpan = Number(mMax - mMin);
                    const zoomFactor = 1 + e.deltaY * 0.0006;
                    const newMSpan = BigInt(Math.round(mSpan * zoomFactor));
                    const clamped =
                        newMSpan < MIN_SPAN ? MIN_SPAN : newMSpan > MAX_SPAN ? MAX_SPAN : newMSpan;

                    if (!e.ctrlKey) {
                        view.tMin = sm.marketToTs(mMax - clamped);
                    } else {
                        const f = mouseX / chartWidth;
                        const mCursor = mMin + BigInt(Math.round(f * mSpan));
                        const ctrlZoom = e.deltaY > 0 ? 1.1 : 0.9;
                        const newMSpanCtrl = mSpan * ctrlZoom;
                        const c2 = Math.max(
                            Number(MIN_SPAN),
                            Math.min(Number(MAX_SPAN), newMSpanCtrl),
                        );
                        view.tMin = sm.marketToTs(mCursor - BigInt(Math.round(c2 * f)));
                        view.tMax = sm.marketToTs(mCursor + BigInt(Math.round(c2 * (1 - f))));
                    }
                } else {
                    const timeSpan = Number(view.tMax - view.tMin);
                    const newSpan = BigInt(Math.round(timeSpan * (1 + e.deltaY * 0.0006)));
                    const clamped =
                        newSpan < MIN_SPAN ? MIN_SPAN : newSpan > MAX_SPAN ? MAX_SPAN : newSpan;

                    if (!e.ctrlKey) {
                        view.tMin = view.tMax - clamped;
                    } else {
                        const f = mouseX / chartWidth;
                        const zoomFactor = e.deltaY > 0 ? 1.1 : 0.9;
                        const newTimeSpan = timeSpan * zoomFactor;
                        const c2 = Math.max(
                            Number(MIN_SPAN),
                            Math.min(Number(MAX_SPAN), newTimeSpan),
                        );
                        const cursorTime = view.tMin + BigInt(Math.round(timeSpan * f));
                        view.tMin = cursorTime - BigInt(Math.round(c2 * f));
                        view.tMax = view.tMin + BigInt(Math.round(c2));
                    }
                }

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
                const chartW = cssW - priceScaleWidthRef.current;
                const prevTMin = view.tMin;
                {
                    const timeSpan = Number(view.tMax - view.tMin);
                    const sm = transformer.getSessionMapper();
                    const ordScroll = transformer.getOrdinal();
                    if (ordScroll) {
                        const colW = transformer.getBarPx(chartW);
                        if (colW > 0) {
                            const dIdx = -e.deltaX / colW;
                            const idxMin = transformer.tsToFracIndex(view.tMin);
                            const idxMax = transformer.tsToFracIndex(view.tMax);
                            view.tMin = transformer.indexToTs(idxMin - dIdx);
                            view.tMax = transformer.indexToTs(idxMax - dIdx);
                        }
                    } else if (sm && sm.hasSession) {
                        const mMin = sm.tsToMarket(view.tMin);
                        const mMax = sm.tsToMarket(view.tMax);
                        const mSpan = Number(mMax - mMin);
                        if (mSpan > 0) {
                            const dm = BigInt(Math.round(-e.deltaX * (mSpan / chartW)));
                            view.tMin = sm.marketToTs(mMin - dm);
                            view.tMax = sm.marketToTs(mMax - dm);
                        }
                    } else {
                        view.tMin -= BigInt(Math.round(-e.deltaX * (timeSpan / chartW)));
                        view.tMax -= BigInt(Math.round(-e.deltaX * (timeSpan / chartW)));
                    }
                }
                clampPan(view);

                const anim = horizonScrollAnimRef.current;
                if (anim) {
                    if (anim.startMMin !== undefined) {
                        const sm = sessionMapperRef.current;
                        const dm = sm.tsToMarket(view.tMin) - sm.tsToMarket(prevTMin);
                        horizonScrollAnimRef.current = {
                            ...anim,
                            startMMin: anim.startMMin + dm,
                            startMMax: anim.startMMax + dm,
                            targetMMin: anim.targetMMin + dm,
                            targetMMax: anim.targetMMax + dm,
                        };
                    } else {
                        const dt = view.tMin - prevTMin;
                        horizonScrollAnimRef.current = {
                            ...anim,
                            startTMin: anim.startTMin + dt,
                            startTMax: anim.startTMax + dt,
                            targetTMin: anim.targetTMin + dt,
                            targetTMax: anim.targetTMax + dt,
                        };
                    }
                }

                scheduleResample();
                pushDrawParams();
                renderEngineRef.current?.markDirty('base');
                renderEngineRef.current?.markDirty('drawings');
                updateSettingsBarPos(selectedDrawingIdRef.current);
            }
            if (viewRef.current.tMin < datasetStartRef.current) {
                eventBus.emit('data:request-backward', {
                    viewMin: viewRef.current.tMin,
                    symbol: symbolInfoRef.current?.symbol,
                });
            }

            pushDrawParams();
            onViewSettled();
            renderEngineRef.current?.markDirty('ui');
        };

        const handleKeyDown = (e: KeyboardEvent) => {
            const container = containerRef.current;
            const active = document.activeElement;

            if (!container || !active || !container.contains(active)) {
                return;
            }
            if(showTimeframeWindowRef.current && e.key === 'Escape'){
                setShowTimeframeWindow(false);
                setTimeframeWindowInput('');
            }
            const ctPlugin = getActiveChartTypePlugin();
            if (ctPlugin?.onKeyDown) {
                const consumed = ctPlugin.onKeyDown(buildChartTypeKeyEvent(e));
                if (consumed) {
                    e.preventDefault();
                    return;
                }
            }
            if (e.ctrlKey) {
                isHoldingCtrlRef.current = true;
            }
            if (e.shiftKey) {
                isHoldingShiftRef.current = true;
            }
            const focus = document.activeElement;
            const isTyping =
                focus instanceof HTMLInputElement ||
                focus instanceof HTMLTextAreaElement ||
                (focus instanceof HTMLElement && focus.isContentEditable);
            if (isTyping) return;

            // before Escape, not after: a tool that collects its own anchors has
            // to be able to see the key that ends it. chart types already get
            // first refusal above
            const pluginTool = drawingRegistry.get(activeToolRef.current.name);
            if (pluginTool?.onKeyDown) {
                const consumed = pluginTool.onKeyDown(buildPluginKeyEvent(e));
                if (consumed) return;
            }

            // Alt-prefixed so the plain letters stay free for other handlers.
            if (e.altKey && e.key !== 'Escape' && TOOL_SHORTCUTS[e.key] !== undefined) {
                const next = TOOL_SHORTCUTS[e.key];
                if (next === 'cursor') {
                    disarmTool();
                    pushDrawParams();
                    renderEngineRef.current?.markDirty('drawings');
                    updateSettingsBarPos(selectedDrawingIdRef.current);
                } else {
                    applyTool(armTool(next));
                }
                return;
            }

            if (e.key === 'Escape') {
                if (showTimeframeWindowRef.current) {
                    setShowTimeframeWindow(false);
                    setTimeframeWindowInput('');
                }
                if (shiftAnchorRef.current) {
                    shiftAnchorRef.current = null;
                    showShiftInfo.current = false;
                    pushDrawParams();
                    renderEngineRef.current?.markDirty('ui');
                    return;
                }
                // an anchorCount of 'dynamic' means the user keeps clicking and
                // Escape is what finishes it - without this it only ever threw
                // the draft away
                const dynDraft = draftRef.current as PluginDraftDrawing | null;
                if (
                    pluginTool?.anchorCount === 'dynamic' &&
                    dynDraft?.pluginToolId === pluginTool.id &&
                    dynDraft.anchors.length > 0
                ) {
                    const placed = {
                        id: nanoid(),
                        tool: pluginTool.id,
                        anchors: dynDraft.anchors,
                        data: { ...(pluginTool.defaultData as object) },
                    } as unknown as Drawing;
                    drawingsRef.current = [...drawingsRef.current, placed];
                    draftRef.current = null;
                    applyTool(CURSOR_TOOL);
                    selectedDrawingIdRef.current = placed.id;
                    setSelectedDrawingId(placed.id);
                    pushDrawParams();
                    renderEngineRef.current?.markDirty('drawings');
                    updateSettingsBarPos(placed.id);
                    return;
                }
                disarmTool();
                selectedDrawingIdRef.current = null;
                setSelectedDrawingId(null);
                setSettingsBarPos(null);
                pushDrawParams();
                renderEngineRef.current?.markDirty('drawings');
                updateSettingsBarPos(selectedDrawingIdRef.current);
                return;
            }
            if (
                (e.key === 'Delete' || e.key === 'Backspace') &&
                selectedDrawingIdRef.current &&
                !isTyping
            ) {
                const id = selectedDrawingIdRef.current;
                drawingsRef.current = drawingsRef.current.filter((d) => d.id !== id);
                selectedDrawingIdRef.current = null;
                setSelectedDrawingId(null);
                setSettingsBarPos(null);
                pushDrawParams();
                renderEngineRef.current?.markDirty('drawings');
                updateSettingsBarPos(selectedDrawingIdRef.current);
                return;
            }

            if (e.key >= '0' && e.key <= '9') {
                setShowTimeframeWindow(true);
                setTimeframeWindowInput(e.key);
            }
        };

        const handleKeyUp = (e: KeyboardEvent) => {
            if (e.key === 'Control' || e.key === 'Meta') {
                isHoldingCtrlRef.current = false;
            }
            if (e.key === 'Shift') {
                isHoldingShiftRef.current = false;
            }
        };

        const handleContextMenu = (e: MouseEvent) => {
            e.preventDefault();
            if (!features.contextMenu) return;
            // Trade line right-click (fires first, suppresses chart menu if captured)
            {
                const tl = tradeLineInteractionRef.current;
                let captured = false;
                const synth = {
                    currentTarget: canvas,
                    stopPropagation: () => {
                        captured = true;
                    },
                    preventDefault: () => {},
                    clientX: e.clientX,
                    clientY: e.clientY,
                } as any;
                tl.onContextMenu(synth);
                if (captured) return;
            }

            const rect = canvas.getBoundingClientRect();
            const dpr = getEffectiveDpr();

            const cssH = canvas.height / dpr;
            const y = e.clientY - rect.top;
            const isXAxis = y > cssH - (p.hideTimeScale ? 0 : X_AXIS_HEIGHT);
            const main = getLayouts()['main'];
            const priceAtClick =
                viewRef.current && main && !isXAxis && y >= main.y && y < main.y + main.h
                    ? transformer.yToPrice(y - main.y, main.h)
                    : null;
            setContextMenu({
                x: e.clientX,
                y: e.clientY,
                target: isXAxis ? 'xaxis' : 'chart',
                priceAtClick,
            });
            crosshairRef.current = null;
            pushDrawParams();
            renderEngineRef.current?.markDirty('ui');
        };

        // 1 finger pans with no crosshair, long press (or armed tool) spawns crosshair that
        // drags move relatively and taps act at, 2 fingers pinch
        const touchAsMouse = (t: { clientX: number; clientY: number }, buttons: number) =>
            ({
                clientX: t.clientX,
                clientY: t.clientY,
                button: 0,
                buttons,
                shiftKey: false,
                ctrlKey: false,
                altKey: false,
                metaKey: false,
                target: canvas,
                currentTarget: canvas,
                preventDefault() {},
                stopPropagation() {},
            }) as unknown as MouseEvent;

        let touchId: number | null = null;
        let touchMode: 'direct' | 'crosshair' = 'direct';
        let touchStart = { x: 0, y: 0, t: 0 };
        let touchLast = { clientX: 0, clientY: 0 };
        let touchMoved = false;
        let crossStart = { x: 0, y: 0 };
        let lastTap = { t: 0, x: 0, y: 0 };
        let pressTimer: ReturnType<typeof setTimeout> | null = null;
        let pinch: Pinch | null = null;
        // after a pinch, leftover fingers do nothing until all lift
        let gestureDead = false;

        const clearPressTimer = () => {
            if (pressTimer) clearTimeout(pressTimer);
            pressTimer = null;
        };

        const chartBox = () => {
            const rect = canvas.getBoundingClientRect();
            const dpr = getEffectiveDpr();
            const chartW = canvas.width / dpr - priceScaleWidthRef.current;
            const chartH = canvas.height / dpr - (p.hideTimeScale ? 0 : X_AXIS_HEIGHT);
            return { rect, chartW, chartH };
        };

        const placePlus = () => {
            const btn = touchPlusRef.current;
            if (!btn) return;
            const ch = touchCrosshairRef.current;
            if (
                !ch ||
                hideTouchPointer ||
                pinch ||
                !features.contextMenu ||
                activeToolRef.current.name !== 'cursor'
            ) {
                btn.style.display = 'none';
                return;
            }
            const { chartW } = chartBox();
            btn.style.display = 'flex';
            btn.style.left = `${chartW - btn.offsetWidth}px`;
            btn.style.top = `${ch.y - btn.offsetHeight / 2}px`;
        };

        const showTouchCrosshair = (x: number, y: number) => {
            const { rect, chartW, chartH } = chartBox();
            const cx = Math.max(0, Math.min(chartW - 1, x));
            const cy = Math.max(0, Math.min(chartH - 1, y));
            touchCrosshairRef.current = { x: cx, y: cy };
            touchCrosshairMoving = true;
            handleMouseMove(touchAsMouse({ clientX: rect.left + cx, clientY: rect.top + cy }, 0));
            touchCrosshairMoving = false;
            placePlus();
        };

        const hideTouchCrosshair = () => {
            if (!touchCrosshairRef.current) return;
            touchCrosshairRef.current = null;
            placePlus();
            handleMouseLeave();
        };

        const crosshairCenter = () => {
            const { chartW, chartH } = chartBox();
            const main = getLayouts()['main'];
            return { x: chartW / 2, y: main ? main.y + main.h / 2 : chartH / 2 };
        };

        touchCrosshairApiRef.current = {
            show: showTouchCrosshair,
            hide: hideTouchCrosshair,
            center: crosshairCenter,
        };

        const toolArmed = () => activeToolRef.current.name !== 'cursor';

        const tapAtCrosshair = () => {
            const ch = touchCrosshairRef.current!;
            if (!toolArmed()) {
                hideTouchCrosshair();
                return;
            }
            const { rect } = chartBox();
            const at = { clientX: rect.left + ch.x, clientY: rect.top + ch.y };
            hasDragged.current = false;
            handleMouseDown(touchAsMouse(at, 1));
            handleMouseUp(touchAsMouse(at, 0));
            if (toolArmed()) showTouchCrosshair(ch.x, ch.y);
            else hideTouchCrosshair();
        };

        const endSingleTouch = () => {
            if (touchMode === 'direct') {
                hasDragged.current = true;
                handleMouseUp(touchAsMouse(touchLast, 0));
                hideTouchPointer = false;
            }
            touchId = null;
        };

        const enterCrosshairMode = () => {
            const id = touchId;
            endSingleTouch();
            touchId = id;
            touchMode = 'crosshair';
            touchMoved = true;
            const { rect } = chartBox();
            showTouchCrosshair(touchLast.clientX - rect.left, touchLast.clientY - rect.top);
            crossStart = { ...touchCrosshairRef.current! };
            touchStart = { x: touchLast.clientX, y: touchLast.clientY, t: 0 };
        };

        const onAxis = (clientX: number, clientY: number) => {
            const { rect, chartW, chartH } = chartBox();
            return clientX - rect.left >= chartW || clientY - rect.top >= chartH;
        };

        const startPinch = (t1: Touch, t2: Touch) => {
            const view = viewRef.current;
            if (!view) return;
            const rect = canvas.getBoundingClientRect();
            const chartW = canvas.width / getEffectiveDpr() - priceScaleWidthRef.current;
            const ord = transformer.getOrdinal();
            const sm = transformer.getSessionMapper();
            let to: (ts: bigint) => number;
            let from: (v: number) => bigint;
            // a bunch of this shii
            if (ord) {
                to = (ts) => transformer.tsToFracIndex(ts);
                from = (v) => transformer.indexToTs(v);
            } else if (sm && sm.hasSession) {
                const base = sm.tsToMarket(view.tMin);
                to = (ts) => Number(sm.tsToMarket(ts) - base);
                from = (v) => sm.marketToTs(base + BigInt(Math.round(v)));
            } else {
                const base = view.tMin;
                to = (ts) => Number(ts - base);
                from = (v) => base + BigInt(Math.round(v));
            }
            const lo = to(view.tMin);
            const span0 = to(view.tMax) - lo;
            const midX = (t1.clientX + t2.clientX) / 2 - rect.left;
            pinch = {
                a: t1.identifier,
                b: t2.identifier,
                anchor: lo + (midX / chartW) * span0,
                span0,
                dist0: Math.max(Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY), 1),
                midY: (t1.clientY + t2.clientY) / 2,
                to,
                from,
            };
            horizonScrollAnimRef.current = null;
            dragMode.current = 'pinch';
            crosshairRef.current = null;
        };

        const movePinch = (e: TouchEvent) => {
            const pc = pinch!;
            const t1 = findTouch(e.touches, pc.a);
            const t2 = findTouch(e.touches, pc.b);
            const view = viewRef.current;
            if (!t1 || !t2 || !view) return;
            const rect = canvas.getBoundingClientRect();
            const dpr = getEffectiveDpr();
            const cssW = canvas.width / dpr;
            const cssH = canvas.height / dpr;
            const chartW = cssW - priceScaleWidthRef.current;

            // fingers midpoint keeps that time in the middle
            const dist = Math.max(Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY), 1);
            const { min, max } = getZoomLimits();
            const span = Math.max(
                Number(min),
                Math.min(Number(max), (pc.span0 * pc.dist0) / dist),
            );
            const midX = (t1.clientX + t2.clientX) / 2 - rect.left;
            const lo = pc.anchor - (midX / chartW) * span;
            view.tMin = pc.from(lo);
            view.tMax = pc.from(lo + span);
            clampPan(view);

            const midY = (t1.clientY + t2.clientY) / 2;
            const dy = midY - pc.midY;
            pc.midY = midY;
            if (!isYAxisAutoRef.current) {
                const mainH = getLayouts()['main']?.h ?? cssH - (p.hideTimeScale ? 0 : X_AXIS_HEIGHT);
                shiftPriceBounds(view, dy, mainH, transformer.getScaleMode() === 'log');
            } else {
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
            }
            autofitPanesSilent();
            transformer.update(view);
            transformer.setSessionMapper(sessionMapperRef.current);
            transformer.setSession(resolvedSessionRef.current);
            scheduleResample();
            pushDrawParams();
            onViewSettled();
            renderEngineRef.current?.markDirty('base');
            renderEngineRef.current?.markDirty('drawings');
            renderEngineRef.current?.markDirty('ui');
            updateSettingsBarPos(selectedDrawingIdRef.current);
            if (view.tMin < datasetStartRef.current) {
                eventBus.emit('data:request-backward', {
                    viewMin: view.tMin,
                    symbol: symbolInfoRef.current?.symbol,
                });
            }
        };

        const handleTouchStart = (e: TouchEvent) => {
            // also stops the browsers emulated mouse events which would double every tap
            e.preventDefault();
            if (e.touches.length === 1) touchStoppedGlide = glideRaf !== null;
            stopGlide();
            lastInputTouchRef.current = true;
            setContextMenu(null);
            if (e.touches.length === e.changedTouches.length) gestureDead = false;
            if (gestureDead) return;

            if (e.touches.length === 1) {
                const t = e.touches[0];
                touchId = t.identifier;
                touchStart = { x: t.clientX, y: t.clientY, t: performance.now() };
                touchLast = { clientX: t.clientX, clientY: t.clientY };
                touchMoved = false;
                touchTapSelect = null;
                touchTapDeselect = false;
                clearPressTimer();

                // axes keep scaling even with the crosshair up
                if (!onAxis(t.clientX, t.clientY) && (touchCrosshairRef.current || toolArmed())) {
                    touchMode = 'crosshair';
                    if (!touchCrosshairRef.current) {
                        const c = crosshairCenter();
                        showTouchCrosshair(c.x, c.y);
                    }
                    crossStart = { ...touchCrosshairRef.current! };
                    return;
                }

                touchMode = 'direct';
                hideTouchPointer = true;
                placePlus();
                panSamples = [{ t: performance.now(), x: t.clientX, y: t.clientY }];
                const m = touchAsMouse(t, 1);
                handleMouseMove(m);
                handleMouseDown(m);
                if (touchTapSelect) clearDrawingHover();
                if (onAxis(t.clientX, t.clientY)) return;
                pressTimer = setTimeout(() => {
                    pressTimer = null;
                    if (touchId === null || touchMoved || draggingAnchorRef.current) return;
                    enterCrosshairMode();
                }, 400);
            } else if (e.touches.length === 2) {
                clearPressTimer();
                if (touchId !== null) endSingleTouch();
                startPinch(e.touches[0], e.touches[1]);
                placePlus();
            }
        };

        const handleTouchMove = (e: TouchEvent) => {
            e.preventDefault();
            if (pinch) {
                movePinch(e);
                return;
            }
            if (touchId === null || gestureDead) return;
            const t = findTouch(e.changedTouches, touchId);
            if (!t) return;
            touchLast = { clientX: t.clientX, clientY: t.clientY };
            const dx = t.clientX - touchStart.x;
            const dy = t.clientY - touchStart.y;
            if (Math.hypot(dx, dy) > 8) {
                touchMoved = true;
                clearPressTimer();
            }
            if (touchMode === 'crosshair') {
                showTouchCrosshair(crossStart.x + dx, crossStart.y + dy);
                return;
            }
            const now = performance.now();
            panSamples.push({ t: now, x: t.clientX, y: t.clientY });
            while (panSamples.length > 2 && now - panSamples[0].t > 100) panSamples.shift();
            handleMouseMove(touchAsMouse(t, 1));
        };

        const handleTouchEnd = (e: TouchEvent) => {
            e.preventDefault();
            clearPressTimer();
            if (pinch) {
                if (e.touches.length < 2) {
                    pinch = null;
                    dragMode.current = 'none';
                    gestureDead = true;
                    autofitIndicatorPanes();
                    const ch = touchCrosshairRef.current;
                    if (ch) showTouchCrosshair(ch.x, ch.y);
                }
                return;
            }
            if (touchId === null) return;
            const t = findTouch(e.changedTouches, touchId);
            if (!t) return;
            touchId = null;

            if (touchMode === 'crosshair') {
                if (!touchMoved && performance.now() - touchStart.t < 400) {
                    touchCrosshairRef.current = crossStart;
                    tapAtCrosshair();
                }
                return;
            }

            const m = touchAsMouse(t, 0);
            const fling =
                chartSettingsRef.current.touchMomentum &&
                isDragging.current &&
                dragMode.current === 'pan';
            const flingPane = dragPaneIdRef.current;
            // the tap that stops a glide isnt a tap
            if (touchStoppedGlide) hasDragged.current = true;
            handleMouseUp(m);
            if (fling && hasDragged.current) startGlide(flingPane);
            hideTouchPointer = false;
            if ((touchTapSelect || touchTapDeselect) && !hasDragged.current) {
                selectedDrawingIdRef.current = touchTapSelect;
                setSelectedDrawingId(touchTapSelect);
                if (touchTapSelect) updateSettingsBarPos(touchTapSelect);
                else setSettingsBarPos(null);
                pushDrawParams();
                renderEngineRef.current?.markDirty('drawings');
            }
            touchTapSelect = null;
            touchTapDeselect = false;
            const ch = touchCrosshairRef.current;
            if (ch) {
                showTouchCrosshair(ch.x, ch.y);
                return;
            }

            if (!hasDragged.current) {
                const now = performance.now();
                const near = Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < 24;
                if (now - lastTap.t < 300 && near) {
                    lastTap.t = 0;
                    handleDoubleClick(m);
                } else {
                    lastTap = { t: now, x: t.clientX, y: t.clientY };
                }
            } else {
                lastTap.t = 0;
            }
            handleMouseLeave();
        };

        const handleTouchCancel = () => {
            clearPressTimer();
            if (pinch) dragMode.current = 'none';
            pinch = null;
            if (touchId !== null) endSingleTouch();
            hideTouchPointer = false;
            const ch = touchCrosshairRef.current;
            if (ch) showTouchCrosshair(ch.x, ch.y);
            else handleMouseLeave();
        };

        const dropTouchCrosshairFor = (e: PointerEvent) => {
            if (e.pointerType !== 'mouse' || !touchCrosshairRef.current) return;
            touchCrosshairRef.current = null;
            placePlus();
        };

        const handlePointerDownWindow = (e: PointerEvent) => {
            lastInputTouchRef.current = e.pointerType === 'touch';
            dropTouchCrosshairFor(e);
        };

        const handlePlusClick = () => {
            const ch = touchCrosshairRef.current;
            const btn = touchPlusRef.current;
            if (!ch || !btn) return;
            const { rect } = chartBox();
            const at = touchAsMouse(
                { clientX: btn.getBoundingClientRect().left, clientY: rect.top + ch.y },
                0,
            );
            hideTouchCrosshair();
            handleContextMenu(at);
        };

        canvas.addEventListener('touchstart', handleTouchStart, { passive: false });
        canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
        canvas.addEventListener('touchend', handleTouchEnd, { passive: false });
        canvas.addEventListener('touchcancel', handleTouchCancel);
        window.addEventListener('pointerdown', handlePointerDownWindow, true);
        window.addEventListener('pointermove', dropTouchCrosshairFor, true);
        const plusBtn = touchPlusRef.current;
        plusBtn?.addEventListener('click', handlePlusClick);
        canvas.addEventListener('mousedown', handleMouseDown);
        canvas.addEventListener('dblclick', handleDoubleClick);
        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mousedown', handleMouseDownWindow);
        window.addEventListener('mouseup', handleMouseUp);
        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);
        chartArea.addEventListener('mouseleave', handleMouseLeave);
        canvas.addEventListener('wheel', handleWheel, { passive: false });
        canvas.addEventListener('contextmenu', handleContextMenu);

        // While playback advances, the forming bar at the horizon keeps changing
        // even though the cursor isn't moving. If the crosshair is parked on or
        // right of that rightmost bar, refresh the status line on each horizon
        // tick (emitStatusCompute self-throttles to ~30fps).
        const unsubStatusRefresh = eventBus.on('status:refresh', () => {
            const ch = crosshairRef.current;
            const view = viewRef.current;
            if (!ch || !view) return;
            emitStatusCompute(ch.x);
        });

        return () => {
            clearPressTimer();
            canvas.removeEventListener('touchstart', handleTouchStart);
            canvas.removeEventListener('touchmove', handleTouchMove);
            canvas.removeEventListener('touchend', handleTouchEnd);
            canvas.removeEventListener('touchcancel', handleTouchCancel);
            window.removeEventListener('pointerdown', handlePointerDownWindow, true);
            window.removeEventListener('pointermove', dropTouchCrosshairFor, true);
            plusBtn?.removeEventListener('click', handlePlusClick);
            touchCrosshairApiRef.current = null;
            stopGlide();
            canvas.removeEventListener('mousedown', handleMouseDown);
            canvas.removeEventListener('dblclick', handleDoubleClick);
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
            chartArea.removeEventListener('mouseleave', handleMouseLeave);
            canvas.removeEventListener('wheel', handleWheel);
            canvas.removeEventListener('contextmenu', handleContextMenu);
            unsubStatusRefresh();
        };
    }, [status]);

    // spawn crosshair when arming a tool from touch
    useEffect(() => {
        const api = touchCrosshairApiRef.current;
        if (!api) return;
        if (activeTool.name === 'cursor') {
            api.hide();
        } else if (lastInputTouchRef.current) {
            const ch = touchCrosshairRef.current ?? api.center();
            api.show(ch.x, ch.y);
        }
    }, [activeTool.name, status]);
}
