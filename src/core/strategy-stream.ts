export type ChunkPlan = {
    fromNs: bigint;
    toNs: bigint;
};

/** `coveredTo`: how far the source actually got - adapters cap responses and report the cap here, not as an error. */
export type RangeFetchResult<B> = {
    bars: B[];
    coveredTo: bigint | null;
};

export type RangeFetch<B> = (opts: {
    fromNs: bigint;
    toNs: bigint;
    barNs: bigint;
}) => Promise<RangeFetchResult<B>>;

export const DEFAULT_STREAM_DEPTH = 4;
export const DEFAULT_MAX_CONTINUATIONS = 16;

/**
 * Chunk boundaries decided up front, not lazily - a request has to fire before
 * its predecessor answers. `chunkBars` is bars in a chunk, not the width: a
 * hundred-bar chunk spans ninety-nine periods, ends inclusive.
 */
export function planChunks(
    fromNs: bigint,
    toNs: bigint,
    barNs: bigint,
    chunkBars: bigint,
    maxChunks: number,
): ChunkPlan[] {
    const plan: ChunkPlan[] = [];
    if (toNs < fromNs || barNs <= 0n || chunkBars <= 0n || maxChunks <= 0) return plan;

    const span = (chunkBars - 1n) * barNs;
    for (let cursor = fromNs; cursor <= toNs && plan.length < maxChunks; ) {
        const chunkTo = cursor + span > toNs ? toNs : cursor + span;
        plan.push({ fromNs: cursor, toNs: chunkTo });
        cursor = chunkTo + barNs;
    }
    return plan;
}

export type StreamOptions<B> = {
    plan: readonly ChunkPlan[];
    barNs: bigint;
    fetch: RangeFetch<B>;
    /** Pieces, not whole chunks - a two-request chunk arrives as two calls rather than paying to join them. */
    deliver: (bars: B[], chunkIndex: number) => void;
    /** False once superseded - checked after every await so a stale walk's late chunks don't reach the new run. */
    isAlive?: () => boolean;
    onProgress?: (delivered: number, total: number) => void;
    depth?: number;
    maxContinuations?: number;
};

/**
 * Rejects with the first failure *in plan order*, not time order - otherwise a
 * later failure could skip the bars an earlier, still-outstanding chunk owns,
 * and a run that quietly drops a year still produces a plausible equity curve.
 */
export async function streamRangeChunks<B>(opts: StreamOptions<B>): Promise<number> {
    const {
        plan,
        barNs,
        fetch,
        deliver,
        isAlive = () => true,
        onProgress,
        depth = DEFAULT_STREAM_DEPTH,
        maxContinuations = DEFAULT_MAX_CONTINUATIONS,
    } = opts;

    const total = plan.length;
    if (total === 0) return 0;

    const fetchSpan = async (chunk: ChunkPlan): Promise<B[][]> => {
        const segments: B[][] = [];
        let cursor = chunk.fromNs;

        for (let step = 0; step < maxContinuations && cursor <= chunk.toNs; step++) {
            const res = await fetch({ fromNs: cursor, toNs: chunk.toNs, barNs });
            if (!isAlive()) return segments;
            if (res.bars.length > 0) segments.push(res.bars);

            const covered = res.coveredTo;
            const next =
                covered != null && covered > cursor && covered < chunk.toNs
                    ? covered + barNs
                    : chunk.toNs + barNs; // covered, or the source said nothing useful
            if (next <= cursor) break; // no forward progress; stop rather than spin
            cursor = next;
        }
        return segments;
    };

    // settled, not raw - so a chunk failing early doesn't surface as an
    // unhandled rejection before its turn; still thrown, just in plan order.
    // a record, not a discriminated union: strictNullChecks is off here, where
    // narrowing on a boolean discriminant doesn't hold
    type Settled = { segments: B[][]; failed: boolean; error: unknown };

    const inflight = new Map<number, Promise<Settled>>();
    let nextToLaunch = 0;

    const launch = () => {
        while (inflight.size < depth && nextToLaunch < total) {
            const i = nextToLaunch++;
            inflight.set(
                i,
                fetchSpan(plan[i]).then(
                    (segments): Settled => ({ segments, failed: false, error: null }),
                    (error): Settled => ({ segments: [], failed: true, error }),
                ),
            );
        }
    };

    launch();

    let delivered = 0;
    for (let i = 0; i < total; i++) {
        if (!isAlive()) return delivered;

        const settled = await inflight.get(i)!;
        inflight.delete(i);
        if (!isAlive()) return delivered;
        if (settled.failed) throw settled.error;

        for (const bars of settled.segments) deliver(bars, i);

        delivered = i + 1;
        onProgress?.(delivered, total);
        launch(); // top the pipeline back up now that one has drained
    }

    return delivered;
}
