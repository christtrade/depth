import { useCallback, useEffect, type MutableRefObject, type RefObject } from 'react';
import { RenderEngine } from '../core/RenderEngine';
import { type TypedEventBus } from '../core/TypedEventBus';
import { type ViewBounds, type TradePoint, type PriceHistory, type OhlcvBarMs } from '../lib/types';
import { type ChartPane, type Indicator, type Rect } from '../lib/types/indicator-types';
import { type FootprintBar } from '../lib/types/footprint';
import { type ChartSettings } from '../lib/types/chart-settings';
import { type DataLevel } from '../interfaces/IDataAdapter';
import { type LiveTransformer } from '../interfaces/ICoordinateTransformer';
import { drawBaseLayer, X_AXIS_HEIGHT } from '../lib/renderers/renderer';

type HeatmapBitmapOffsets = { x: number; y: number; w: number; h: number };
type CacheBounds = { tMin: bigint; tMax: bigint; pMin: number; pMax: number };

export interface UseRenderEngineParams {
    renderEngineRef: MutableRefObject<RenderEngine | null>;
    baseCanvasRef: RefObject<HTMLCanvasElement>;
    drawingsCanvasRef: RefObject<HTMLCanvasElement>;
    uiCanvasRef: RefObject<HTMLCanvasElement>;
    eventBus: TypedEventBus;
    /** Which cell of the layout this chart is - stamped onto bus events so the
     *  other cells can tell our repaints from theirs. */
    chartId: number;
    viewRef: MutableRefObject<ViewBounds | null>;
    /** Auto-computed right price-axis width (css px). */
    priceScaleWidthRef: MutableRefObject<number>;
    tradesRef: MutableRefObject<TradePoint[]>;
    getLayouts: () => Record<string, Rect>;
    heatmapBitmapRef: MutableRefObject<ImageBitmap | null>;
    cacheBoundsRef: MutableRefObject<CacheBounds | null>;
    heatmapBitmapOffsetsRef: MutableRefObject<HeatmapBitmapOffsets>;
    panesRef: MutableRefObject<ChartPane[]>;
    indicatorsRef: MutableRefObject<Indicator[]>;
    priceHistoryRef: MutableRefObject<PriceHistory[]>;
    footprintBarsRef: MutableRefObject<FootprintBar[]>;
    activeTimeframeRef: MutableRefObject<{ barNs: bigint }>;
    chartSettingsRef: MutableRefObject<ChartSettings>;
    horizonRef: MutableRefObject<bigint>;
    candleCacheRef: MutableRefObject<Map<bigint, any> | null>;
    openBarRef: MutableRefObject<FootprintBar | null>;
    dataLevelRef: MutableRefObject<DataLevel | null>;
    ohlcvBarsRef: MutableRefObject<{ barNs: bigint; bars: OhlcvBarMs[]; display: OhlcvBarMs[] }>;
    previewBarsRef: MutableRefObject<OhlcvBarMs[]>;
    transformer: LiveTransformer;
    hideTimeScale: boolean;
}

export interface UseRenderEngineResult {
    doBaseRedraw: () => void;
}

export function useRenderEngine(p: UseRenderEngineParams): UseRenderEngineResult {
    const {
        renderEngineRef,
        baseCanvasRef,
        drawingsCanvasRef,
        uiCanvasRef,
        eventBus,
        chartId,
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
    } = p;

    useEffect(() => {
        const base = baseCanvasRef.current;
        const drawings = drawingsCanvasRef.current;
        const ui = uiCanvasRef.current;
        if (!base || !drawings || !ui) return;

        const engine = new RenderEngine(base, drawings, ui, eventBus, chartId);
        renderEngineRef.current = engine;
        eventBus.emit('render-engine:ready', { engine: renderEngineRef.current });

        if (viewRef.current) engine.setView(viewRef.current);

        return () => engine.destroy();
    }, []);

    const doBaseRedraw = useCallback(() => {
        if (!baseCanvasRef.current || !viewRef.current || tradesRef.current.length === 0) return;

        const canvas = baseCanvasRef.current;
        const view = viewRef.current;
        const chartW = canvas.width - priceScaleWidthRef.current;

        const layouts = getLayouts();
        const mainRect = layouts['main'];
        const mainH = mainRect ? mainRect.h : canvas.height - (p.hideTimeScale ? 0 : X_AXIS_HEIGHT);

        let bitmapOffsetX = 0;
        let bitmapOffsetY = 0;
        let bitmapOffsetW = chartW;
        let bitmapOffsetH = mainH;

        if (heatmapBitmapRef.current && cacheBoundsRef.current) {
            const cb = cacheBoundsRef.current;
            const tRange = Number(view.tMax - view.tMin);
            const pRange = view.pMax - view.pMin;

            if (tRange > 0) {
                bitmapOffsetX = (Number(cb.tMin - view.tMin) / tRange) * chartW;
                bitmapOffsetW = (Number(cb.tMax - cb.tMin) / tRange) * chartW;
            }
            if (pRange > 0) {
                bitmapOffsetY = ((view.pMax - cb.pMax) / pRange) * mainH;
                bitmapOffsetH = ((cb.pMax - cb.pMin) / pRange) * mainH;
            }
        }

        heatmapBitmapOffsetsRef.current = {
            x: bitmapOffsetX,
            y: bitmapOffsetY,
            h: bitmapOffsetH,
            w: bitmapOffsetW,
        };

        drawBaseLayer(
            canvas,
            panesRef.current,
            layouts,
            indicatorsRef.current,
            tradesRef.current,
            priceHistoryRef.current,
            [],
            view,
            footprintBarsRef.current,
            heatmapBitmapRef.current,
            bitmapOffsetX,
            bitmapOffsetY,
            bitmapOffsetW,
            bitmapOffsetH,
            activeTimeframeRef.current.barNs,
            chartSettingsRef.current,
            horizonRef.current,
            candleCacheRef.current,
            openBarRef.current,
            dataLevelRef.current === 'ohlcv'
                ? ohlcvBarsRef.current.display
                : previewBarsRef.current,
            transformer,
            undefined, // isPluginChartType
            undefined, // sessionMapper
            undefined, // dataLevel
            undefined, // hidePriceScale
            undefined, // hideTimeScale
            undefined, // symbolInfo
            priceScaleWidthRef.current,
        );
    }, []);

    return { doBaseRedraw };
}
