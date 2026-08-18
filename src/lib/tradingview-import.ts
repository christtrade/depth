//  One-way import of a user's TradingView chart preferences.
//
//  Switching charting engines otherwise means re-doing every color, margin and
//  favorite by hand. The charting library leaves its preferences in localStorage
//  on the same origin, so if a user has been running TradingView here we can seed
//  their first ChristTrade session from it.
//
//  Deliberately conservative:
//    - Only runs when the corresponding ChristTrade key is UNSET - an existing
//      setting is never overwritten (unless a caller passes `force`).
//    - Runs at most once per device (a marker under the meta namespace), so
//      resetting to defaults doesn't silently pull TradingView's colors back.
//    - Anything we can't map confidently is skipped rather than guessed at, and
//      a malformed blob yields no settings instead of throwing.
import type { ChartSettings } from './types/chart-settings';
import type { ChartType } from './types';
import { META_PREFIX, StorageKey, readStored, writeJSON, writeStored } from './storage';

// Source keys
const TV_CHART_PROPERTIES = 'tradingview.chartproperties';
const TV_MAIN_SERIES = 'tradingview.chartproperties.mainSeriesProperties';
const TV_FAVORITE_DRAWINGS = 'tradingview.chart.favoriteDrawings';

/** Set once the import has been attempted, successful or not. */
const IMPORT_MARKER = `${META_PREFIX}tradingview-imported`;

// Enum tables (from charting_library.d.ts)
/** TradingView `ChartStyle` -> our ChartType. Styles we don't implement are absent. */
const CHART_STYLE: Record<number, ChartType> = {
    0: 'bars',
    1: 'candles',
    2: 'line',
    3: 'area',
    4: 'renko',
    5: 'kagi',
    // 6 = Point & Figure - not implemented
    7: 'line-break',
    8: 'heikin-ashi',
    9: 'hollow',
    10: 'baseline',
    // 12 HiLo, 13 Column, 14 LineWithMarkers, 16 HLCArea, 19 VolCandle - not implemented
    15: 'step',
};

/** Which style block holds the candle colors for a given ChartStyle. */
const CANDLE_BLOCK_FOR_STYLE: Record<number, string> = {
    0: 'barStyle',
    1: 'candleStyle',
    4: 'renkoStyle',
    8: 'haStyle',
    9: 'hollowCandleStyle',
    19: 'volCandlesStyle',
};

/** TradingView `LineStyle` -> our dash array. */
const LINE_STYLE_DASH: Record<number, number[]> = {
    0: [], // Solid
    1: [2, 3], // Dotted
    2: [6, 3], // Dashed
    3: [10, 5], // LargeDashed
};

/**
 * TradingView's internal line-tool class names (what `favoriteDrawings` stores)
 * -> our drawing tool ids. Tools we don't have are dropped.
 */
const LINE_TOOLS: Record<string, string> = {
    cursor: 'cursor',
    LineToolTrendLine: 'line',
    LineToolRay: 'ray',
    LineToolHorzLine: 'hline',
    LineToolVertLine: 'vline',
    LineToolExtended: 'extended-line',
    LineToolHorzRay: 'hray',
    LineToolCrossLine: 'cross-line',
    LineToolInfoLine: 'info-line',
    LineToolTrendAngle: 'trend-angle',
    LineToolParallelChannel: 'parallel-channel',
    LineToolFlatBottom: 'flat-channel',
    LineToolDisjointAngle: 'disjoint-channel',
    LineToolRegressionTrend: 'regression-trend',
    LineToolPitchfork: 'pitchfork',
    LineToolSchiffPitchfork: 'schiff-pitchfork',
    LineToolInsidePitchfork: 'inside-pitchfork',
    LineToolFibRetracement: 'fib',
    LineToolRectangle: 'rect',
    LineToolTriangle: 'triangle',
    LineToolText: 'text',
    LineToolRiskRewardLong: 'long',
    LineToolRiskRewardShort: 'short',
    LineToolFixedRangeVolumeProfile: 'fvp',
};

// Value coercion
const isObj = (v: unknown): v is Record<string, any> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

const byte = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
        .toString(16)
        .padStart(2, '0');

/**
 * Normalize a TradingView color to hex. It stores both `#rrggbb` and
 * `rgba(r, g, b, a)`; our color pickers expect hex, so fold rgba down to #rrggbbaa.
 * Returns undefined for anything unrecognized (including TV's `""` = "auto").
 */
function color(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const v = value.trim();
    if (!v) return undefined;
    if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(v)) return v.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(v)) {
        const [r, g, b] = v.slice(1);
        return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
    }
    const m = v.match(
        /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i,
    );
    if (!m) return undefined;
    const [, r, g, b, a] = m;
    const alpha = a === undefined ? 1 : Number(a);
    const hex = `#${byte(Number(r))}${byte(Number(g))}${byte(Number(b))}`;
    return alpha >= 1 ? hex : `${hex}${byte(alpha * 255)}`;
}

const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** Assign only when the mapped value came through as something usable. */
function put<K extends keyof ChartSettings>(
    out: Partial<ChartSettings>,
    key: K,
    value: ChartSettings[K] | undefined,
): void {
    if (value !== undefined) out[key] = value;
}

// Readers
function readRaw(key: string): Record<string, any> | null {
    if (typeof window === 'undefined') return null;
    try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return isObj(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Map `tradingview.chartproperties` (plus the separately-stored
 * `mainSeriesProperties`, which the library keeps more current) onto our settings.
 * Returns null when there's nothing to import.
 */
export function readTradingViewChartSettings(): Partial<ChartSettings> | null {
    const props = readRaw(TV_CHART_PROPERTIES);
    // TradingView writes mainSeriesProperties both nested and standalone; the
    // standalone copy is the one it updates, so it wins.
    const series =
        readRaw(TV_MAIN_SERIES) ??
        (isObj(props?.mainSeriesProperties) ? props!.mainSeriesProperties : null);
    if (!props && !series) return null;

    const out: Partial<ChartSettings> = {};

    // Pane: background, grid, crosshair, margins, price axis
    const pane = isObj(props?.paneProperties) ? props!.paneProperties : {};

    const bg = color(pane.background) ?? color(pane.backgroundGradientStartColor);
    put(out, 'backgroundColor', bg);
    // TV keeps a separate `scalesProperties.backgroundColor` that it only honours
    // in some themes (the sample data has a white axis behind a dark chart), so
    // the pane background is the trustworthy source for both.
    put(out, 'axisBackgroundColor', bg);

    if (typeof pane.gridLinesMode === 'string') {
        put(out, 'showGrid', pane.gridLinesMode !== 'none');
    }
    if (isObj(pane.vertGridProperties)) {
        put(out, 'gridVerticalColor', color(pane.vertGridProperties.color));
    }
    if (isObj(pane.horzGridProperties)) {
        put(out, 'gridHorizontalColor', color(pane.horzGridProperties.color));
    }

    if (isObj(pane.crossHairProperties)) {
        const ch = pane.crossHairProperties;
        put(out, 'crosshairColor', color(ch.color));
        put(out, 'crosshairWidth', num(ch.width));
        const dash = typeof ch.style === 'number' ? LINE_STYLE_DASH[ch.style] : undefined;
        put(out, 'crosshairDash', dash);
    }

    // TV margins are percentages; ours are fractions, clamped to the 0-0.5 the UI allows.
    const margin = (v: unknown) => {
        const n = num(v);
        return n === undefined ? undefined : Math.max(0, Math.min(0.5, n / 100));
    };
    put(out, 'scaleMarginTop', margin(pane.topMargin));
    put(out, 'scaleMarginBottom', margin(pane.bottomMargin));

    if (isObj(pane.axisProperties)) {
        const ax = pane.axisProperties;
        put(out, 'autoScale', bool(ax.autoScale));
        put(out, 'invertScale', bool(ax.isInverted));
        if (ax.log === true) put(out, 'priceScaleMode', 'log');
        else if (ax.percentage === true) put(out, 'priceScaleMode', 'percent');
        else if (ax.log === false && ax.percentage === false) put(out, 'priceScaleMode', 'normal');
    }

    // Legend -> our status line
    if (isObj(pane.legendProperties)) {
        const lg = pane.legendProperties;
        put(out, 'showStatusLine', bool(lg.showLegend));
        put(out, 'statusLineOHLC', bool(lg.showSeriesOHLC));
        put(out, 'statusLineVolume', bool(lg.showVolume));
        put(out, 'statusLineChange', bool(lg.showBarChange));
    }

    // Timezone
    if (typeof props?.timezone === 'string' && props.timezone) {
        put(out, 'timezone', props.timezone === 'Etc/UTC' ? 'UTC' : props.timezone);
    }

    // Main series: chart type, candle colors, price line
    if (series) {
        const style = num(series.style);
        if (style !== undefined && CHART_STYLE[style]) put(out, 'chartType', CHART_STYLE[style]);

        // Candle colors come from whichever style block matches the active type,
        // falling back to plain candles (TV keeps them all in sync in practice).
        const styleBlock = (style !== undefined && CANDLE_BLOCK_FOR_STYLE[style]) || 'candleStyle';
        const cs = isObj(series[styleBlock])
            ? series[styleBlock]
            : isObj(series.candleStyle)
              ? series.candleStyle
              : null;

        if (cs) {
            const up = color(cs.upColor);
            const down = color(cs.downColor);
            put(out, 'upBodyColor', up);
            put(out, 'downBodyColor', down);

            const borderUp = color(cs.borderUpColor);
            const borderDown = color(cs.borderDownColor);
            put(out, 'upBorderColor', borderUp);
            put(out, 'downBorderColor', borderDown);

            const wickUp = color(cs.wickUpColor);
            const wickDown = color(cs.wickDownColor);
            put(out, 'upWickColor', wickUp);
            put(out, 'downWickColor', wickDown);

            // TV has no "matches body" flag - it just writes the body color into
            // the border/wick fields. Derive ours by comparing.
            if (up && down && borderUp && borderDown) {
                put(out, 'borderColorMatchesBody', borderUp === up && borderDown === down);
            }
            if (up && down && wickUp && wickDown) {
                put(out, 'wickColorMatchesBody', wickUp === up && wickDown === down);
            }
        }

        put(out, 'priceLineVisible', bool(series.showPriceLine));
        put(out, 'priceLineColor', color(series.priceLineColor));

        // Renko brick size is only a fixed price when the box is "Traditional";
        // ATR mode is derived per-view, which is what our `null` already means.
        const renko = isObj(series.renkoStyle) ? series.renkoStyle : null;
        if (renko && isObj(renko.inputs) && renko.inputs.style === 'Traditional') {
            put(out, 'renkoBrickSize', num(renko.inputs.boxSize));
        }
        const lineBreak = isObj(series.lineBreakStyle) ? series.lineBreakStyle : null;
        if (lineBreak && isObj(lineBreak.inputs)) {
            put(out, 'lineBreakCount', num(lineBreak.inputs.lineNumber));
        }
        const kagi = isObj(series.kagiStyle) ? series.kagiStyle : null;
        if (kagi && isObj(kagi.inputs) && kagi.inputs.style === 'Traditional') {
            put(out, 'kagiReversal', num(kagi.inputs.reversalAmount));
        }
    }

    return Object.keys(out).length > 0 ? out : null;
}

/**
 * Map `tradingview.chart.favoriteDrawings` onto our drawing tool ids, dropping
 * tools we don't implement. Returns null when there's nothing to import.
 */
export function readTradingViewFavoriteDrawings(): string[] | null {
    if (typeof window === 'undefined') return null;
    let parsed: unknown;
    try {
        const raw = window.localStorage.getItem(TV_FAVORITE_DRAWINGS);
        if (!raw) return null;
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!Array.isArray(parsed)) return null;

    const tools: string[] = [];
    for (const name of parsed) {
        // The toolbar's favorites row is for actual drawings; the cursor already
        // has its own permanent slot.
        const mapped = typeof name === 'string' ? LINE_TOOLS[name] : undefined;
        if (mapped && mapped !== 'cursor' && !tools.includes(mapped)) tools.push(mapped);
    }
    return tools.length > 0 ? tools : null;
}

/** True when this browser has TradingView preferences worth importing. */
export function hasTradingViewSettings(): boolean {
    return readTradingViewChartSettings() !== null || readTradingViewFavoriteDrawings() !== null;
}

// Import
export interface TradingViewImportResult {
    /** Chart settings (colors, grid, margins, chart type, …) were written. */
    settings: boolean;
    /** Favorite drawing tools were written. */
    favorites: boolean;
}

/**
 * Seed empty ChristTrade preferences from TradingView's.
 *
 * Each target is imported independently and only when currently unset, so a user
 * who has customized colors but never starred a drawing still gets their
 * favorites across. Runs at most once per device unless `force` is passed.
 */
export function importTradingViewSettings(opts: { force?: boolean } = {}): TradingViewImportResult {
    const result: TradingViewImportResult = { settings: false, favorites: false };
    if (typeof window === 'undefined') return result;
    if (!opts.force && readStored(IMPORT_MARKER) !== null) return result;

    if (opts.force || readStored(StorageKey.chartSettings) === null) {
        const settings = readTradingViewChartSettings();
        if (settings) {
            // Written as a diff - useChartSettings merges it onto the defaults, so
            // anything TradingView didn't cover keeps our default rather than
            // whatever the last mapping guessed.
            writeJSON(StorageKey.chartSettings, settings);
            result.settings = true;
        }
    }

    if (opts.force || readStored(StorageKey.drawingFavorites) === null) {
        const favorites = readTradingViewFavoriteDrawings();
        if (favorites) {
            writeJSON(StorageKey.drawingFavorites, favorites);
            result.favorites = true;
        }
    }

    // Marker is written even when nothing matched, so a user without TradingView
    // data doesn't pay for the lookup on every load.
    writeStored(IMPORT_MARKER, String(Date.now()));
    return result;
}

/** Forget that the import ran, so the next chart construction retries it. */
export function resetTradingViewImport(): void {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.removeItem(IMPORT_MARKER);
    } catch {
        /* ignore */
    }
}
