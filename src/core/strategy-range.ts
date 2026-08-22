// Bounding a run to a span of time.
//
// A sibling of the parameters, not one of them - the server runner keys its
// chunk cache on hash(script + params), so folding range in there would turn
// every range change into a cache miss.
//
// No DOM, no imports beyond the engine's bar type: the server runner clips
// with the same arithmetic the browser does.

import type { StrategyBar } from './strategy-runtime';

/** Inclusive both ends, nanoseconds. An omitted end means "as far as the data goes". */
export interface StrategyRange {
    fromNs?: bigint;
    toNs?: bigint;
}

/** Where a range lands in a bar array, plus what it cost. */
export interface ClippedRange {
    /** First bar in range. */
    from: number;
    /** One past the last bar in range, so `bars.slice(from, to)` is the run. */
    to: number;
    /** How many bars the run will see. */
    count: number;
    /** How many bars were available before clipping. */
    total: number;
    /** Timestamps of the first and last bar actually in range. */
    firstTs: bigint | null;
    lastTs: bigint | null;
    /** Span the whole data set covers, ignoring the range - lets a picker bound itself to what exists. */
    dataFromNs: bigint | null;
    dataToNs: bigint | null;
}

/** First index whose ts is >= target. `bars.length` when none is. */
function lowerBound(bars: readonly StrategyBar[], target: bigint): number {
    let lo = 0;
    let hi = bars.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (bars[mid].ts < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/** First index whose ts is > target. `bars.length` when none is. */
function upperBound(bars: readonly StrategyBar[], target: bigint): number {
    let lo = 0;
    let hi = bars.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (bars[mid].ts <= target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/**
 * Resolve a range against a sorted bar array. `toNs` includes the bar that opens
 * exactly on it. Binary search, not a filter - this runs once per sweep
 * combination, and a linear scan over a million bars twenty thousand times
 * turns a sweep into a hang.
 *
 * No warmup before `from`: feeding a run bars it isn't allowed to trade is how
 * an out-of-sample window quietly stops being out of sample.
 */
export function clipRange(bars: readonly StrategyBar[], range?: StrategyRange): ClippedRange {
    const total = bars.length;

    if (!total) {
        return {
            from: 0,
            to: 0,
            count: 0,
            total: 0,
            firstTs: null,
            lastTs: null,
            dataFromNs: null,
            dataToNs: null,
        };
    }

    const from = range?.fromNs != null ? lowerBound(bars, range.fromNs) : 0;
    const to = range?.toNs != null ? upperBound(bars, range.toNs) : total;

    // inverted or fully out-of-bounds is empty, not an error - the caller
    // decides whether that's worth refusing
    const lo = Math.min(from, total);
    const hi = Math.max(lo, Math.min(to, total));

    return {
        from: lo,
        to: hi,
        count: hi - lo,
        total,
        // optional, so a budget check with no materialized bars yet gets an
        // answer instead of a TypeError
        firstTs: hi > lo ? (bars[lo]?.ts ?? null) : null,
        lastTs: hi > lo ? (bars[hi - 1]?.ts ?? null) : null,
        dataFromNs: bars[0]?.ts ?? null,
        dataToNs: bars[total - 1]?.ts ?? null,
    };
}

/** True when the range asks for something, rather than being absent or empty. */
export function hasRange(range?: StrategyRange): boolean {
    return !!range && (range.fromNs != null || range.toNs != null);
}

/**
 * Why a clipped run has nothing to run over. Spelled out rather than an empty
 * result, since a strategy with no trades and one given no bars look identical
 * in a results panel, and only one of those is the user's fault.
 */
export function emptyRangeReason(clipped: ClippedRange, range?: StrategyRange): string {
    if (!clipped.total) return 'No bars are loaded for this symbol and timeframe.';

    if (range?.fromNs != null && range?.toNs != null && range.fromNs > range.toNs) {
        return 'The start of the range is after its end.';
    }

    return (
        `No bars fall inside the selected range. The loaded data holds ` +
        `${clipped.total.toLocaleString()} bars outside it.`
    );
}
