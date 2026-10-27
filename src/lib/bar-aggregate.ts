import type { OhlcvBarMs } from './types';
import type { SessionMapper } from '../core/SessionMapper';
import { BarStore } from '../core/BarStore';
import { ohlcvBucketRange } from './bar-grid';

export { ohlcvBucketRange };

// bucket start for a bar time
function bucketer(barMs: number, sessionMapper?: SessionMapper | null): (timeMs: number) => number {
    const useSession = !!sessionMapper?.hasSession;
    let segStartMs = 0;
    let segEndMs = 0;
    let haveSeg = false;

    return (timeMs: number): number => {
        if (useSession) {
            if (!haveSeg || timeMs < segStartMs || timeMs >= segEndMs) {
                const seg = sessionMapper!.segmentAt(BigInt(timeMs) * 1_000_000n);
                haveSeg = seg !== null;
                if (seg) {
                    segStartMs = Number(seg.realStart / 1_000_000n);
                    segEndMs = Number(seg.realEnd / 1_000_000n);
                }
            }
            if (haveSeg) return segStartMs + Math.floor((timeMs - segStartMs) / barMs) * barMs;
        }
        return Math.floor(timeMs / barMs) * barMs;
    };
}

export function aggregateOhlcvBars(
    bars: BarStore,
    targetBarNs: bigint,
    sessionMapper?: SessionMapper | null,
    from = 0,
    sourceBarNs?: bigint,
): BarStore {
    if (from >= bars.length || targetBarNs <= 0n) return BarStore.from(bars.toArray(from));
    const barMs = Number(targetBarNs / 1_000_000n);
    if (barMs <= 0) return BarStore.from(bars.toArray(from));
    const getBucket = bucketer(barMs, sessionMapper);

    if (sourceBarNs !== undefined && getBucket(bars.time[from]) !== bars.time[from]) {
        const firstWhole = getBucket(bars.time[from]) + barMs;
        while (from < bars.length && bars.time[from] < firstWhole) from++;
        if (from >= bars.length) return new BarStore();
    }

    const { time, open, high, low, close, volume } = bars;
    const result = new BarStore();
    let currentBucket = getBucket(time[from]);
    let o = open[from],
        h = high[from],
        l = low[from],
        c = close[from],
        v = volume[from];

    for (let i = from + 1; i < time.length; i++) {
        const bucket = getBucket(time[i]);
        if (bucket !== currentBucket) {
            result.appendRow(currentBucket, o, h, l, c, v);
            currentBucket = bucket;
            o = open[i];
            h = high[i];
            l = low[i];
            c = close[i];
            v = volume[i];
        } else {
            if (high[i] > h) h = high[i];
            if (low[i] < l) l = low[i];
            c = close[i];
            v += volume[i];
        }
    }
    result.appendRow(currentBucket, o, h, l, c, v);
    return result;
}

export function isAggregated(
    bars: BarStore,
    targetBarNs: bigint,
    sessionMapper?: SessionMapper | null,
    from = 0,
    to = bars.length,
): boolean {
    if (bars.bid || targetBarNs <= 0n) return false;
    const barMs = Number(targetBarNs / 1_000_000n);
    if (barMs <= 0) return false;
    const getBucket = bucketer(barMs, sessionMapper);
    const t = bars.time;
    for (let i = from; i < to; i++) {
        if (getBucket(t[i]) !== t[i]) return false;
        if (i > 0 && !(t[i] > t[i - 1])) return false;
    }
    return !(to > 0 && to < t.length && !(t[to] > t[to - 1]));
}

// the raw store itself when it already is the target period, else an aggregated copy
export function displayFor(
    bars: BarStore,
    sourceBarNs: bigint,
    targetBarNs: bigint,
    sessionMapper?: SessionMapper | null,
): BarStore {
    return sourceBarNs === targetBarNs && isAggregated(bars, targetBarNs, sessionMapper)
        ? bars
        : aggregateOhlcvBars(bars, targetBarNs, sessionMapper, 0, sourceBarNs);
}

// prepend fetched bars to an aggregated dissplay store in place. costs new bars only
export function prependAggregatedOhlcvBars(
    newBars: OhlcvBarMs[],
    display: BarStore,
    targetBarNs: bigint,
    sessionMapper?: SessionMapper | null,
): BarStore {
    if (newBars.length === 0) return display;
    const fresh = aggregateOhlcvBars(BarStore.from(newBars), targetBarNs, sessionMapper).toArray();
    if (fresh.length === 0) return display;

    const last = fresh[fresh.length - 1];
    if (display.length && last.time === display.time[0]) {
        display.set(0, {
            time: last.time,
            open: last.open,
            high: Math.max(last.high, display.high[0]),
            low: Math.min(last.low, display.low[0]),
            close: display.close[0],
            volume: last.volume + display.volume[0],
        });
        fresh.pop();
    }
    display.prepend(fresh);
    return display;
}
