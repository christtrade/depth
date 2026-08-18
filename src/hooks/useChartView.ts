import { useCallback, type MutableRefObject } from 'react';
import { type ViewBounds, type TradePoint, type PriceHistory, type OhlcvBarMs } from '../lib/types';
import { type ChartSettings } from '../lib/types/chart-settings';
import { type DataLevel } from '../interfaces/IDataAdapter';
import { type RenderEngine } from '../core/RenderEngine';
import { type ChartPane, type Indicator } from '../lib/types/indicator-types';
import { autoFitPriceAxis } from './useChartData';
import { FootprintBar } from '../core';

export interface UseChartViewParams {
    viewRef: MutableRefObject<ViewBounds | null>;
    transformer: import('../interfaces/ICoordinateTransformer').LiveTransformer;
    isYAxisAutoRef: MutableRefObject<boolean>;
    setChartSettings: (updater: ChartSettings | ((prev: ChartSettings) => ChartSettings)) => void;
    priceHistoryRef: MutableRefObject<PriceHistory[]>;
    tradesRef: MutableRefObject<TradePoint[]>;
    previewBarsRef: MutableRefObject<OhlcvBarMs[]>;
    ohlcvBarsRef: MutableRefObject<{ barNs: bigint; bars: OhlcvBarMs[]; display: OhlcvBarMs[] }>;
    openBarRef: MutableRefObject<FootprintBar>;
    chartSettingsRef: MutableRefObject<ChartSettings>;
    horizonRef: MutableRefObject<bigint>;
    dataLevelRef: MutableRefObject<DataLevel | null>;
    activeTimeframeRef: MutableRefObject<{ barNs: bigint; label?: string }>;
    scheduleResample: () => void;
    pushDrawParams: () => void;
    /** Publish this pane's visible time range to a time/date-range-synced layout. */
    publishTimeRangeSync: () => void;
    renderEngineRef: MutableRefObject<RenderEngine | null>;
    updateSettingsBarPos: (id: string | null) => void;
    selectedDrawingIdRef: MutableRefObject<string | null>;
    panesRef: MutableRefObject<ChartPane[]>;
    indicatorsRef: MutableRefObject<Indicator[]>;
    setPanes: (updater: ChartPane[] | ((prev: ChartPane[]) => ChartPane[])) => void;
}

export interface UseChartViewResult {
    resetYAxis: (setPersistent?: boolean) => void;
    resetXAxis: () => void;
    resetView: () => void;
    autofitPanesSilent: () => void;
    autofitIndicatorPanes: () => void;
}

export function useChartView(p: UseChartViewParams): UseChartViewResult {
    const {
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
    } = p;

    const autofitPanesSilent = useCallback(() => {
        if (!viewRef.current) return;
        const { tMin, tMax } = viewRef.current;
        const current = panesRef.current;
        let changed = false;
        const next = current.map((pane) => {
            if (pane.isMain || !pane.yAxisAuto) return pane;
            const ind = indicatorsRef.current.find((i) => i.paneId === pane.id);
            if (!ind?.getAutoYBounds) return pane;
            const b = ind.getAutoYBounds(tMin, tMax, horizonRef.current);
            if (!b) return pane;
            changed = true;
            return { ...pane, yMin: b.min, yMax: b.max };
        });
        if (changed) panesRef.current = next;
    }, []);

    const autofitIndicatorPanes = useCallback(() => {
        if (!viewRef.current) return;
        const { tMin, tMax } = viewRef.current;
        setPanes((prev) => {
            let changed = false;
            const next = prev.map((pane) => {
                if (pane.isMain || !pane.yAxisAuto) return pane;
                const ind = indicatorsRef.current.find((i) => i.paneId === pane.id);
                if (!ind?.getAutoYBounds) return pane;
                const b = ind.getAutoYBounds(tMin, tMax, horizonRef.current);
                if (!b) return pane;
                changed = true;
                return { ...pane, yMin: b.min, yMax: b.max };
            });
            if (changed) panesRef.current = next;
            return changed ? next : prev;
        });
    }, []);

    const resetYAxis = useCallback((setPersistent = false) => {
        const view = viewRef.current;
        if (!view) return;
        if (setPersistent) {
            isYAxisAutoRef.current = true;
            setChartSettings((prev) => ({ ...prev, autoScale: isYAxisAutoRef.current }));
        }
        autoFitPriceAxis(
            view,
            priceHistoryRef.current,
            tradesRef.current,
            [...previewBarsRef.current, ...ohlcvBarsRef.current.display],
            openBarRef.current,
            chartSettingsRef.current,
            horizonRef.current,
            dataLevelRef.current,
        );
        autofitIndicatorPanes();
        scheduleResample();
        pushDrawParams();
        renderEngineRef.current?.markDirty('base');
        renderEngineRef.current?.markDirty('drawings');
        updateSettingsBarPos(selectedDrawingIdRef.current);
        renderEngineRef.current?.markDirty('ui');
    }, []);

    const resetXAxis = useCallback(() => {
        const view = viewRef.current;
        if (!view) return;
        // Ordinal (column) charts: show the last ~N columns instead of a time span.
        const ord = transformer.getOrdinal();
        if (ord) {
            const n = ord.length;
            const N = Math.min(n, 200);
            view.tMin = transformer.indexToTs(n - N);
            view.tMax = transformer.indexToTs(n - 1 + Math.min(N * 0.1, 10));
        } else {
            const timeSpan = activeTimeframeRef.current.barNs * 270n;
            const offset = 20n * activeTimeframeRef.current.barNs;
            const last = horizonRef.current;
            if (!last) return;
            view.tMin = last - timeSpan + offset;
            view.tMax = last + offset;
        }
        scheduleResample();
        pushDrawParams();
        publishTimeRangeSync();
        renderEngineRef.current?.markDirty('base');
        renderEngineRef.current?.markDirty('drawings');
        updateSettingsBarPos(selectedDrawingIdRef.current);
        renderEngineRef.current?.markDirty('ui');
    }, []);

    const resetView = useCallback(() => {
        resetXAxis();
        resetYAxis(true);
    }, []);

    return { resetYAxis, resetXAxis, resetView, autofitPanesSilent, autofitIndicatorPanes };
}
