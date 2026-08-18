import { type SessionMapper } from '../core/SessionMapper';

export function ohlcvBucketRange(
    tsNs: bigint,
    barNs: bigint,
    sessionMapper?: SessionMapper | null,
): { start: bigint; end: bigint } {
    if (barNs <= 0n) return { start: tsNs, end: tsNs };

    const seg = sessionMapper?.hasSession ? sessionMapper.segmentAt(tsNs) : null;
    if (!seg) {
        const start = (tsNs / barNs) * barNs;
        return { start, end: start + barNs };
    }

    const start = seg.realStart + ((tsNs - seg.realStart) / barNs) * barNs;
    const end = start + barNs;
    return { start, end: end < seg.realEnd ? end : seg.realEnd };
}

export function snapTsToBarGrid(
    tsNs: bigint,
    barNs: bigint,
    sessionMapper?: SessionMapper | null,
): bigint {
    if (barNs <= 0n) return tsNs;

    const { start, end } = ohlcvBucketRange(tsNs, barNs, sessionMapper);
    if (tsNs - start <= end - tsNs) return start;

    // the next column isn't start + barNs: a session close truncates the bucket
    // and the following session restarts the grid at its own open
    const next = ohlcvBucketRange(end, barNs, sessionMapper).start;
    return next > start ? next : end;
}
