import type { FootprintMode } from './footprint';
import type { ChartType } from './index';

export type ChartSettings = {
    // Chart type
    chartType: ChartType;
    // Candles
    upBodyColor: string;
    downBodyColor: string;
    upWickColor: string;
    downWickColor: string;
    upBorderColor: string;
    downBorderColor: string;
    wickColorMatchesBody: boolean;
    borderColorMatchesBody: boolean;
    wickWidth: number; // px
    borderWidth: number; // px
    drawEmptyCandles: boolean;
    // Baseline chart: the price level the series is split above/below. When null
    // the first bar of the series is used as a stable anchor.
    baselineValue: number | null;
    // Japanese price-driven charts. null brick/reversal = auto-derived from the
    // visible price range.
    renkoBrickSize: number | null;
    kagiReversal: number | null;
    lineBreakCount: number; // Three Line Break: blocks to break for a reversal
    footprintMode: FootprintMode;
    footprintVolume: 'none' | 'split' | 'total';
    // Footprint signals
    footprintImbalanceRatio: number;
    footprintStackMinCount: number;
    footprintShowStackedImbalance: boolean;
    footprintShowAbsorption: boolean;
    footprintShowUnfinishedAuction: boolean;
    footprintShowDiagonalImbalance: boolean;
    footprintDiagRatio: number;
    footprintAbsorptionMult: number;
    footprintAbsorptionDeltaFrac: number;
    // Scales
    priceScaleMode: 'normal' | 'log' | 'percent';
    autoScale: boolean;
    priceAxisResizeSensitivity: number;
    invertScale: boolean;
    allowLabelOverlap: boolean;
    /** Smoothly ease the live price line + axis pills toward each new value instead of snapping. */
    animatePriceUpdates: boolean;
    scaleMarginTop: number; // fraction 0-0.5
    scaleMarginBottom: number; // fraction 0-0.5
    // Note: the right price-axis width is no longer a setting - it is computed
    // automatically from the symbol's price precision and the visible range.
    // Lines
    showGrid: boolean;
    gridHorizontalColor: string;
    gridVerticalColor: string;
    crosshairMode: 'normal' | 'magnet' | 'hidden';
    crosshairColor: string;
    crosshairWidth: number;
    crosshairDash: number[];
    showBreaks: boolean;
    breaksColor: string;
    breaksWidth: number;
    breaksDash: number[];
    // Status line
    showStatusLine: boolean;
    statusLineOHLC: boolean;
    statusLineVolume: boolean;
    statusLineDelta: boolean;
    statusLineChange: boolean;
    statusLineFontSize: number;
    // Chart
    backgroundColor: string;
    axisBackgroundColor: string;
    // Overlays
    showBidLine: boolean;
    showAskLine: boolean;
    showMidLine: boolean;
    showLastTradeLine: boolean;
    showFills: boolean;
    showTradeDots: boolean;
    tradeDotsSizeMult: number; // 1-5
    // Heatmap
    showHeatmap: boolean;
    heatmapContrast: number; // 0-100
    heatmapColorBid: string;
    heatmapColorAsk: string;
    // Resampling
    resamplingDebounce: number;
    // Price line
    priceLineVisible: boolean;
    priceLineColor: string;
    // Session
    sessionHighlightEnabled: boolean;
    sessionHighlightColor: string;
    // Horizon scroll animation
    horizonScrollEasing: 'none' | 'linear' | 'easeOut' | 'easeInOut';
    horizonScrollDuration: number; // ms
    // Timezone
    timezone: string;
    use24HourClock: boolean;
    showTimezoneLabel: boolean;
    /**
     * Settings belonging to plugin chart types, keyed by chart type id. Each
     * plugin owns its own bag - see `ChartTypePlugin.settingsSchema`.
     */
    pluginSettings: Record<string, Record<string, unknown>>;
};

export const DEFAULT_CHART_SETTINGS: ChartSettings = {
    chartType: 'area',
    upBodyColor: '#00e676',
    downBodyColor: '#ff1744',
    upWickColor: '#00e676aa',
    downWickColor: '#ff1744aa',
    upBorderColor: '#00e676',
    downBorderColor: '#ff1744',
    wickColorMatchesBody: true,
    borderColorMatchesBody: true,
    wickWidth: 1,
    borderWidth: 1,
    drawEmptyCandles: false,
    baselineValue: null,
    renkoBrickSize: null,
    kagiReversal: null,
    lineBreakCount: 3,
    footprintMode: 'bid-ask',
    footprintVolume: 'total',
    footprintImbalanceRatio: 3.0,
    footprintStackMinCount: 3,
    footprintShowStackedImbalance: true,
    footprintShowAbsorption: true,
    footprintShowUnfinishedAuction: true,
    footprintShowDiagonalImbalance: true,
    footprintDiagRatio: 3.0,
    footprintAbsorptionMult: 2.5,
    footprintAbsorptionDeltaFrac: 0.25,
    priceScaleMode: 'normal',
    autoScale: true,
    priceAxisResizeSensitivity: 1,
    invertScale: false,
    allowLabelOverlap: false,
    animatePriceUpdates: true,
    scaleMarginTop: 0.1,
    scaleMarginBottom: 0.1,
    showGrid: true,
    gridHorizontalColor: '#ffffff0d',
    gridVerticalColor: '#ffffff0d',
    crosshairMode: 'normal',
    crosshairColor: '#758696',
    crosshairWidth: 1,
    crosshairDash: [6, 6],
    showBreaks: false,
    breaksColor: '#3b82f6',
    breaksWidth: 1,
    breaksDash: [],
    showStatusLine: true,
    statusLineOHLC: true,
    statusLineVolume: true,
    statusLineDelta: true,
    statusLineChange: true,
    statusLineFontSize: 12,
    backgroundColor: '#16181d',
    axisBackgroundColor: '#16181d',
    showBidLine: true,
    showAskLine: true,
    showMidLine: false,
    showLastTradeLine: false,
    showFills: true,
    showTradeDots: false,
    tradeDotsSizeMult: 1,
    showHeatmap: true,
    heatmapContrast: 0,
    heatmapColorBid: '#3b82f6',
    heatmapColorAsk: '#ef4444',
    priceLineVisible: true,
    priceLineColor: '#758696',
    resamplingDebounce: 50,
    sessionHighlightEnabled: false,
    sessionHighlightColor: '#ffffff08',
    horizonScrollEasing: 'easeOut',
    horizonScrollDuration: 80,
    timezone: 'America/New_York',
    use24HourClock: true,
    showTimezoneLabel: true,
    pluginSettings: {},
};

// (De)serialization
//  Settings are persisted as a diff against the defaults: small saves, and new
//  default fields added later neither bloat nor invalidate old saves.

/** Keys whose value differs from DEFAULT_CHART_SETTINGS (deep value compare). */
export function diffChartSettings(settings: ChartSettings): Partial<ChartSettings> {
    const out: Partial<ChartSettings> = {};
    for (const key of Object.keys(DEFAULT_CHART_SETTINGS) as (keyof ChartSettings)[]) {
        if (JSON.stringify(settings[key]) !== JSON.stringify(DEFAULT_CHART_SETTINGS[key])) {
            (out as Record<string, unknown>)[key] = settings[key];
        }
    }
    return out;
}

/** Re-expand a settings diff back onto the current defaults. */
export function mergeChartSettings(diff?: Partial<ChartSettings>): ChartSettings {
    return { ...DEFAULT_CHART_SETTINGS, ...(diff ?? {}) };
}
