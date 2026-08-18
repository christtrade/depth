import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { type ViewBounds, type TradePoint, type PriceHistory, type OhlcvBarMs } from '../lib/types';
import { type FootprintBar } from '../lib/types/footprint';
import { type ChartSettings, DEFAULT_CHART_SETTINGS } from '../lib/types/chart-settings';
import { type DataLevel } from '../interfaces/IDataAdapter';
import { type RenderEngine } from '../core/RenderEngine';
import { type CompactBuffer } from '../lib/compact-buffer';
import { StorageKey, readJSON, writeJSON } from '../lib/storage';
import { autoFitPriceAxis } from './useChartData';

export interface UseChartSettingsParams {
    chartSettingsRef: MutableRefObject<ChartSettings>;
    isYAxisAutoRef: MutableRefObject<boolean>;
    viewRef: MutableRefObject<ViewBounds | null>;
    priceHistoryRef: MutableRefObject<PriceHistory[]>;
    tradesRef: MutableRefObject<TradePoint[]>;
    dataLevelRef: MutableRefObject<DataLevel | null>;
    ohlcvBarsRef: MutableRefObject<{ barNs: bigint; bars: OhlcvBarMs[]; display: OhlcvBarMs[] }>;
    previewBarsRef: MutableRefObject<OhlcvBarMs[]>;
    openBarRef: MutableRefObject<FootprintBar | null>;
    horizonRef: MutableRefObject<bigint>;
    compactBufRef: MutableRefObject<CompactBuffer>;
    selectedDrawingIdRef: MutableRefObject<string | null>;
    renderEngineRef: MutableRefObject<RenderEngine | null>;
    scheduleResample: () => void;
    rebuildContrastBitmap: (contrast: number) => void;
    requestFootprintRebuild: () => void;
    pushDrawParams: () => void;
    updateSettingsBarPos: (id: string | null) => void;
    hidePriceScale: boolean;
    hideTimeScale: boolean;
    /**
     * This pane's model settings. When they differ from the defaults (i.e. the
     * pane was restored from a save, or already customized), they take precedence
     * over the localStorage fallback as the initial settings.
     */
    modelSettings?: ChartSettings;
}

export interface UseChartSettingsResult {
    chartSettings: ChartSettings;
    setChartSettings: (updater: ChartSettings | ((prev: ChartSettings) => ChartSettings)) => void;
}

function validateChartSettings(settings: any): ChartSettings {
    if (typeof settings !== 'object' || settings === null) {
        return { ...DEFAULT_CHART_SETTINGS };
    }
    const validated: ChartSettings = { ...DEFAULT_CHART_SETTINGS };
    for (const key in DEFAULT_CHART_SETTINGS) {
        const defaultValue = DEFAULT_CHART_SETTINGS[key];
        const value = settings[key];
        // A null default (baselineValue, renkoBrickSize, kagiReversal) means
        // "number | null, auto-derived when null" - a plain typeof compare against
        // null would reject every actual number and silently drop the setting.
        if (defaultValue === null) {
            if (value === null || typeof value === 'number') validated[key] = value;
        } else if (typeof value === typeof defaultValue) {
            validated[key] = value;
        }
    }
    return validated;
}

function getChartSettings(): ChartSettings {
    const stored = readJSON<unknown>(StorageKey.chartSettings, null);
    if (stored === null) return DEFAULT_CHART_SETTINGS;
    return validateChartSettings(stored);
}

export function useChartSettings(p: UseChartSettingsParams): UseChartSettingsResult {
    const {
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
    } = p;

    const [chartSettings, setChartSettings] = useState<ChartSettings>(() => {
        // Restored / customized model settings win over the localStorage default.
        const m = p.modelSettings;
        if (m && JSON.stringify(m) !== JSON.stringify(DEFAULT_CHART_SETTINGS)) return m;
        return getChartSettings();
    });
    const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const prevChartSettingsRef = useRef<ChartSettings>(DEFAULT_CHART_SETTINGS);

    const saveChartSettings = useCallback(() => {
        writeJSON(StorageKey.chartSettings, chartSettingsRef.current);
    }, []);

    useEffect(() => {
        return () => {
            if (saveTimeoutRef.current) {
                clearTimeout(saveTimeoutRef.current);
            }
        };
    }, []);

    useEffect(() => {
        const prev = prevChartSettingsRef.current;
        prevChartSettingsRef.current = chartSettings;
        chartSettingsRef.current = chartSettings;

        if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = setTimeout(() => saveChartSettings(), 500);

        if (chartSettings.autoScale && !prev.autoScale) {
            isYAxisAutoRef.current = true;
            const view = viewRef.current;
            if (view)
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
        } else {
            isYAxisAutoRef.current = chartSettings.autoScale;
        }

        if (chartSettings.showHeatmap !== prev.showHeatmap) scheduleResample();

        if (chartSettings.heatmapContrast !== prev.heatmapContrast) {
            rebuildContrastBitmap(chartSettings.heatmapContrast);
            pushDrawParams();
            renderEngineRef.current?.markDirty('ui');
            return;
        }

        if (
            isYAxisAutoRef.current &&
            (chartSettings.scaleMarginTop !== prev.scaleMarginTop ||
                chartSettings.scaleMarginBottom !== prev.scaleMarginBottom)
        ) {
            const view = viewRef.current;
            if (view)
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

        const footprintRebuildKeys = [
            'footprintImbalanceRatio',
            'footprintStackMinCount',
            'footprintDiagRatio',
            'footprintAbsorptionMult',
            'footprintAbsorptionDeltaFrac',
        ] as const;
        if (
            footprintRebuildKeys.some((k) => chartSettings[k] !== prev[k]) &&
            compactBufRef.current.length > 0
        ) {
            requestFootprintRebuild();
        }

        pushDrawParams();
        renderEngineRef.current?.markDirty('base');
        renderEngineRef.current?.markDirty('drawings');
        updateSettingsBarPos(selectedDrawingIdRef.current);
        renderEngineRef.current?.markDirty('ui');
    }, [chartSettings]);

    return { chartSettings, setChartSettings };
}
