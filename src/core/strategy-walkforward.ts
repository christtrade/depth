// Walk-forward analysis: optimise on a window, test on what comes next, roll.
//
// The problem it exists to solve is the one a parameter sweep creates. Optimise
// across your whole dataset and the best row is, by construction, the parameters
// that best describe noise you already have. Walk-forward never lets the
// optimiser see the data it is scored on: each window picks parameters on its
// in-sample segment and is judged on the segment that follows, which is the only
// ordering that resembles trading them.
//
// Two numbers come out that nothing else produces:
//
//   efficiency - how much of the optimised performance survived contact with
//                unseen data. Reliably near 100% means the parameters are real.
//                Reliably near zero means the sweep was fitting noise.
//
//   stability  - whether the chosen parameters agree between windows. One window
//                picking a period of 14 and the next picking 87 says there is no
//                optimum to find, only noise to fit - and that is often more
//                informative than the returns.
//
// Pure and DOM-free, same as strategy-sweep.ts, so a server runner schedules
// windows exactly the way the browser does.

import type { StrategyStats } from './strategy-runtime';

export interface WalkForwardSpec {
    /** How many out-of-sample segments to test. */
    windows: number;
    /**
     * In-sample length as a multiple of out-of-sample length.
     *
     * 3 or 4 is conventional: enough history to optimise on, tested against a
     * meaningful stretch of what followed. At 1 the optimiser sees as much data
     * as it is judged on, which makes every window statistically thin.
     */
    isMultiple: number;
    /**
     * Anchored keeps the in-sample start fixed and lets it grow; rolling slides
     * a fixed-width window.
     *
     * Neither is correct in general. Anchored uses more data and assumes the
     * distant past still applies; rolling adapts to regime change and forgets.
     * Which one flatters a strategy is itself a finding.
     */
    anchored: boolean;
}

export interface WalkForwardWindow {
    index: number;
    /** Bar indices, half-open: [from, to). */
    isFrom: number;
    isTo: number;
    oosFrom: number;
    oosTo: number;
}

export interface WalkForwardWindowResult {
    window: WalkForwardWindow;
    /** What the optimiser chose on the in-sample segment. */
    params: Record<string, unknown>;
    inSample: StrategyStats;
    outOfSample: StrategyStats;
}

export interface ParameterStability {
    param: string;
    /** The value chosen in each window, in order. */
    values: number[];
    distinct: number;
    /**
     * Standard deviation over the mean. Scale-free, so a period and a percentage
     * are comparable.
     *
     * Under ~0.15 the windows broadly agree. Over ~0.5 they do not, and a single
     * "optimal" value quoted from the full-history sweep is a coincidence.
     */
    coefficientOfVariation: number;
}

/**
 * Divides a series into overlapping optimise/test windows.
 *
 * Anchored keeps every in-sample segment starting at bar zero instead.
 *
 * Returns an empty array when the series cannot support the schedule. Refusing
 * is the honest answer - a walk-forward over 40-bar windows produces numbers
 * that look like analysis and are noise.
 */
export function planWalkForward(barCount: number, spec: WalkForwardSpec): WalkForwardWindow[] {
    const windows = Math.floor(spec.windows);
    const isMultiple = Math.max(1, Math.floor(spec.isMultiple));

    if (windows < 1 || barCount < 200) return [];

    // the series has to hold one in-sample block plus one out-of-sample block
    // per window
    const oosLen = Math.floor(barCount / (windows + isMultiple));
    const isLen = oosLen * isMultiple;

    // 50 is the same floor the single split uses: below it a segment cannot
    // produce a trade count worth reading
    if (oosLen < 50 || isLen < 50) return [];

    const out: WalkForwardWindow[] = [];
    for (let i = 0; i < windows; i++) {
        const isTo = i * oosLen + isLen;
        const oosTo = isTo + oosLen;
        if (oosTo > barCount) break;

        out.push({
            index: i,
            isFrom: spec.anchored ? 0 : i * oosLen,
            isTo,
            oosFrom: isTo,
            oosTo,
        });
    }

    return out;
}

/**
 * How much of the optimised edge survived on unseen data.
 *
 * Per-bar instead of total - anchored windows differ in length and an
 * unweighted ratio would let the longest in-sample segment dominate.
 *
 * 1.0 means out-of-sample matched in-sample. Below ~0.5 is the usual warning
 * line. Negative means the optimised parameters lost money on what followed,
 * which is the most useful result a backtest can give you.
 *
 * Returns 0 when in-sample made nothing - there is no ratio to a zero
 * denominator, and reporting Infinity as "infinitely efficient" would be absurd.
 */
export function walkForwardEfficiency(results: WalkForwardWindowResult[]): number {
    let isPnl = 0;
    let isBars = 0;
    let oosPnl = 0;
    let oosBars = 0;

    for (const r of results) {
        isPnl += r.inSample.netPnl;
        isBars += r.window.isTo - r.window.isFrom;
        oosPnl += r.outOfSample.netPnl;
        oosBars += r.window.oosTo - r.window.oosFrom;
    }

    if (!isBars || !oosBars) return 0;

    const isPerBar = isPnl / isBars;
    const oosPerBar = oosPnl / oosBars;

    if (isPerBar <= 0) return 0;
    return oosPerBar / isPerBar;
}

/**
 * Whether the optimiser kept choosing the same thing.
 *
 * Only numeric parameters - the spread of a boolean or a string across windows
 * has no meaningful coefficient.
 */
export function parameterStability(results: WalkForwardWindowResult[]): ParameterStability[] {
    if (!results.length) return [];

    const keys = new Set<string>();
    for (const r of results) for (const k of Object.keys(r.params)) keys.add(k);

    const out: ParameterStability[] = [];

    for (const param of keys) {
        const values: number[] = [];
        for (const r of results) {
            const v = r.params[param];
            if (typeof v === 'number' && Number.isFinite(v)) values.push(v);
        }
        if (values.length < 2) continue;

        let mean = 0;
        for (const v of values) mean += v;
        mean /= values.length;

        let varSum = 0;
        for (const v of values) varSum += (v - mean) * (v - mean);
        const sd = Math.sqrt(varSum / values.length);

        out.push({
            param,
            values,
            distinct: new Set(values).size,
            // a mean of zero has no scale to be relative to; 0 spread is the only
            // defensible reading when every window also chose zero
            coefficientOfVariation: mean !== 0 ? sd / Math.abs(mean) : sd === 0 ? 0 : Infinity,
        });
    }

    return out;
}

/**
 * Picks the best row of a scored grid.
 *
 * `higherIsBetter` is false for drawdown-like objectives. Rows whose metric is
 * not finite are skipped rather than winning: a profit factor of Infinity means
 * a run with no losing trade, which on a two-trade in-sample window is noise
 * dressed as perfection.
 */
export function pickBest<T>(
    rows: T[],
    metric: (row: T) => number | undefined,
    higherIsBetter = true,
): T | null {
    let best: T | null = null;
    let bestValue = higherIsBetter ? -Infinity : Infinity;

    for (const row of rows) {
        const v = metric(row);
        if (v === undefined || !Number.isFinite(v)) continue;
        if (higherIsBetter ? v > bestValue : v < bestValue) {
            bestValue = v;
            best = row;
        }
    }

    return best;
}
