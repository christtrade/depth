//  Timeframe definitions for the L3 visualiser.
//
//  A "timeframe" here represents a view span preset - how much time is visible
//  in the chart viewport at once.  On plain-line mode (current), selecting a TF
//  snaps the tMax->tMin span to that duration while keeping tMax fixed.
//  Later, TF will also drive candle aggregation.
import { StorageKey, readJSON, writeJSON } from './storage';

export type TimeframeUnit = 'none' | 'ms' | 's' | 'm' | 'h' | 'd' | 'w';

export type Timeframe = {
    /** Human-readable label, e.g. "1m", "5m", "1h", "213m" */
    label: string;
    /** Duration of ONE candle/bar in nanoseconds (also used as the view snap span multiplier) */
    barNs: bigint;
    /** Default number of bars to show in the viewport when this TF is selected */
    defaultBars: number;
    /** Whether this is a built-in preset (false = user-created custom) */
    isPreset: boolean;
};

// How many bars fit comfortably in view per timeframe
export const DEFAULT_BARS: Record<string, number> = {
    none: 100,
    '1s': 120,
    '5s': 120,
    '15s': 96,
    '30s': 80,
    '1m': 100,
    '3m': 80,
    '5m': 80,
    '15m': 60,
    '30m': 48,
    '1h': 48,
    '4h': 32,
    '1d': 30,
};

function makeNs(value: number, unit: TimeframeUnit): bigint {
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
}

// Built-in presets
export const PRESET_TIMEFRAMES: Timeframe[] = [
    { label: 'None', barNs: makeNs(1, 'none'), defaultBars: DEFAULT_BARS['none'], isPreset: true },
    { label: '1s', barNs: makeNs(1, 's'), defaultBars: DEFAULT_BARS['1s'], isPreset: true },
    { label: '5s', barNs: makeNs(5, 's'), defaultBars: DEFAULT_BARS['5s'], isPreset: true },
    { label: '15s', barNs: makeNs(15, 's'), defaultBars: DEFAULT_BARS['15s'], isPreset: true },
    { label: '30s', barNs: makeNs(30, 's'), defaultBars: DEFAULT_BARS['30s'], isPreset: true },
    { label: '1m', barNs: makeNs(1, 'm'), defaultBars: DEFAULT_BARS['1m'], isPreset: true },
    { label: '3m', barNs: makeNs(3, 'm'), defaultBars: DEFAULT_BARS['3m'], isPreset: true },
    { label: '5m', barNs: makeNs(5, 'm'), defaultBars: DEFAULT_BARS['5m'], isPreset: true },
    { label: '15m', barNs: makeNs(15, 'm'), defaultBars: DEFAULT_BARS['15m'], isPreset: true },
    { label: '30m', barNs: makeNs(30, 'm'), defaultBars: DEFAULT_BARS['30m'], isPreset: true },
    { label: '1h', barNs: makeNs(1, 'h'), defaultBars: DEFAULT_BARS['1h'], isPreset: true },
    { label: '4h', barNs: makeNs(4, 'h'), defaultBars: DEFAULT_BARS['4h'], isPreset: true },
    { label: '1d', barNs: makeNs(1, 'd'), defaultBars: DEFAULT_BARS['1d'], isPreset: true },
];

// Resolving a raw duration back into a Timeframe
/** Reverse of makeNs: produce a short label like "2m", "1h", "1d" from a duration. */
function labelFromNs(barNs: bigint): string {
    const units: Array<[TimeframeUnit, bigint]> = [
        ['w', 604_800_000_000_000n],
        ['d', 86_400_000_000_000n],
        ['h', 3_600_000_000_000n],
        ['m', 60_000_000_000n],
        ['s', 1_000_000_000n],
        ['ms', 1_000_000n],
    ];
    for (const [unit, ns] of units) {
        if (barNs % ns === 0n) return `${barNs / ns}${unit}`;
    }
    return `${barNs}ns`;
}

/**
 * Resolve a timeframe LABEL (e.g. "5m", "213m") back into a Timeframe - a preset
 * when one matches, else a parsed custom one. Lenient: falls back to 1m on an
 * unrecognized label rather than throwing, so a restore never hard-fails.
 */
export function resolveTimeframe(label: string): Timeframe {
    const preset = PRESET_TIMEFRAMES.find((t) => t.label.toLowerCase() === label.toLowerCase());
    if (preset) return preset;
    return (
        parseCustomTimeframe(label) ??
        PRESET_TIMEFRAMES.find((t) => t.label === '1m') ??
        PRESET_TIMEFRAMES[0]
    );
}

/**
 * Resolve a raw bar duration (ns) into a full Timeframe. Reuses a built-in
 * preset when one matches exactly; otherwise synthesizes the label and a
 * sensible defaultBars. Used to give data adapters the rich timeframe object
 * for whatever resolution the engine actually decided to fetch at.
 */
export function timeframeFromBarNs(barNs: bigint): Timeframe {
    const preset = PRESET_TIMEFRAMES.find((tf) => tf.barNs === barNs);
    if (preset) return preset;

    const twoHourNs = 7_200_000_000_000n;
    const defaultBars = barNs > 0n ? Math.max(10, Math.min(500, Number(twoHourNs / barNs))) : 100;

    return { label: labelFromNs(barNs), barNs, defaultBars, isPreset: false };
}

// View span calculation
/**
 * Given a timeframe and optional bar count, return the total nanosecond span
 * that should be visible in the viewport.
 */
export function tfViewSpan(tf: Timeframe, bars?: number): bigint {
    return tf.barNs * BigInt(bars ?? tf.defaultBars);
}

// Custom timeframe parsing
/**
 * Parse a user-entered string like "213m", "2h", "45s", "3d" into a Timeframe.
 * Returns null if the input is invalid.
 */
export function parseCustomTimeframe(input: string): Timeframe | null {
    const trimmed = input.trim().toLowerCase();
    const match = trimmed.match(/^(\d+)(s|m|h|d|w)$/);
    if (!match) return null;

    const value = parseInt(match[1], 10);
    const unit = match[2] as TimeframeUnit;
    if (value <= 0 || value > 100_000) return null;

    const barNs = makeNs(value, unit);

    // sensible default bars: aim for ~2h of data visible
    const twoHourNs = 7_200_000_000_000n;
    const defaultBars = Math.max(10, Math.min(500, Number(twoHourNs / barNs)));

    return {
        label: `${value}${unit}`,
        barNs,
        defaultBars,
        isPreset: false,
    };
}

/**
 * Snap tMin to the nearest bar boundary aligned to Unix epoch.
 * This keeps grid lines consistent regardless of where you're panning.
 */
export function snapToBars(ts: bigint, barNs: bigint): bigint {
    if (barNs === 0n) return ts;
    return (ts / barNs) * barNs;
}

// localStorage persistence for custom timeframes
export function loadCustomTimeframes(): Timeframe[] {
    try {
        const arr = readJSON<Array<{ label: string; barNs: string; defaultBars: number }> | null>(
            StorageKey.customTimeframes,
            null,
        );
        if (!Array.isArray(arr)) return [];
        return arr.map((item) => ({
            label: item.label,
            barNs: BigInt(item.barNs),
            defaultBars: item.defaultBars,
            isPreset: false,
        }));
    } catch {
        return [];
    }
}

export function saveCustomTimeframes(tfs: Timeframe[]): void {
    writeJSON(
        StorageKey.customTimeframes,
        tfs.map((tf) => ({
            label: tf.label,
            barNs: tf.barNs.toString(),
            defaultBars: tf.defaultBars,
        })),
    );
}

// localStorage persistence for favorite (quick-pick) timeframes
//  Favorites are the timeframes pinned to the inline toolbar row. We store just
//  the labels and resolve them against presets/customs at render time.

export const DEFAULT_FAVORITE_LABELS = ['1m', '5m', '15m', '1h', '4h', '1d'];

export function loadFavoriteTimeframes(): string[] {
    const arr = readJSON<unknown>(StorageKey.favoriteTimeframes, null);
    if (!Array.isArray(arr)) return [...DEFAULT_FAVORITE_LABELS];
    return arr.filter((x): x is string => typeof x === 'string');
}

export function saveFavoriteTimeframes(labels: string[]): void {
    writeJSON(StorageKey.favoriteTimeframes, labels);
}
