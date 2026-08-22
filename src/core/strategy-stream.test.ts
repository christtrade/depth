import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { planChunks, streamRangeChunks } from './strategy-stream';

const MINUTE = 60_000_000_000n;

// The property that matters is not throughput, it is that overlapping the
// requests changed nothing about what the engine sees. Bars have to arrive in
// order, once each, with no gap - a run that quietly drops a year still draws a
// perfectly plausible equity curve, and there is nothing on screen to say it is
// describing three years instead of four.

type Bar = { ts: bigint };

/**
 * A source that answers after a delay, records concurrency, and can be told to
 * serve short answers or to fail on a given chunk.
 */
function makeSource(opts?: {
    /** Serve only this many bars per request, reporting the rest as uncovered. */
    capBars?: number;
    delayMs?: number;
    failAt?: bigint;
}) {
    const cap = opts?.capBars ?? Infinity;
    const delay = opts?.delayMs ?? 0;

    let inFlight = 0;
    let peak = 0;
    let requests = 0;

    const fetch = async ({
        fromNs,
        toNs,
        barNs,
    }: {
        fromNs: bigint;
        toNs: bigint;
        barNs: bigint;
    }) => {
        requests++;
        inFlight++;
        peak = Math.max(peak, inFlight);
        try {
            if (delay > 0) await new Promise((r) => setTimeout(r, delay));
            else await Promise.resolve();

            if (opts?.failAt != null && fromNs <= opts.failAt && opts.failAt <= toNs) {
                throw new Error(`source failed at ${opts.failAt}`);
            }

            const bars: Bar[] = [];
            let ts = fromNs;
            while (ts <= toNs && bars.length < cap) {
                bars.push({ ts });
                ts += barNs;
            }
            const lastServed = bars.length > 0 ? bars[bars.length - 1].ts : null;
            const coveredTo = lastServed != null && lastServed < toNs ? lastServed : toNs;
            return { bars, coveredTo };
        } finally {
            inFlight--;
        }
    };

    return {
        fetch,
        get peakConcurrency() {
            return peak;
        },
        get requests() {
            return requests;
        },
    };
}

/** Every bar the run saw, in the order the engine would have seen it. */
function collect() {
    const seen: bigint[] = [];
    return {
        seen,
        deliver: (bars: Bar[]) => {
            for (const b of bars) seen.push(b.ts);
        },
    };
}

describe('planChunks', () => {
    it('covers the span exactly once, with no gap and no overlap', () => {
        const from = 0n;
        const to = 999n * MINUTE;
        const plan = planChunks(from, to, MINUTE, 100n, 1000);

        assert.equal(plan[0].fromNs, from);
        assert.equal(plan[plan.length - 1].toNs, to);
        for (let i = 1; i < plan.length; i++) {
            assert.equal(
                plan[i].fromNs,
                plan[i - 1].toNs + MINUTE,
                `chunk ${i} does not start one bar after chunk ${i - 1} ends`,
            );
        }
    });

    it('clips the last chunk to the end of the span', () => {
        const plan = planChunks(0n, 250n * MINUTE, MINUTE, 100n, 1000);
        assert.equal(plan[plan.length - 1].toNs, 250n * MINUTE);
    });

    it('returns nothing for an empty or inverted span', () => {
        assert.deepEqual(planChunks(100n, 50n, MINUTE, 100n, 10), []);
        assert.deepEqual(planChunks(0n, 100n, 0n, 100n, 10), []);
        assert.deepEqual(planChunks(0n, 100n, MINUTE, 0n, 10), []);
    });

    it('stops at the chunk cap rather than planning forever', () => {
        const plan = planChunks(0n, 1_000_000n * MINUTE, MINUTE, 10n, 25);
        assert.equal(plan.length, 25);
    });
});

describe('streamRangeChunks', () => {
    it('delivers every bar exactly once, in order', async () => {
        const to = 999n * MINUTE;
        const plan = planChunks(0n, to, MINUTE, 100n, 1000);
        const src = makeSource();
        const sink = collect();

        const delivered = await streamRangeChunks<Bar>({
            plan,
            barNs: MINUTE,
            fetch: src.fetch,
            deliver: sink.deliver,
        });

        assert.equal(delivered, plan.length);
        assert.equal(sink.seen.length, 1000);
        for (let i = 0; i < sink.seen.length; i++) {
            assert.equal(sink.seen[i], BigInt(i) * MINUTE, `bar ${i} out of place`);
        }
    });

    it('actually overlaps the requests', async () => {
        const plan = planChunks(0n, 999n * MINUTE, MINUTE, 100n, 1000);
        const src = makeSource({ delayMs: 5 });
        const sink = collect();

        await streamRangeChunks<Bar>({
            plan,
            barNs: MINUTE,
            fetch: src.fetch,
            deliver: sink.deliver,
            depth: 4,
        });

        assert.equal(src.peakConcurrency, 4, `peak concurrency ${src.peakConcurrency}`);
        assert.equal(sink.seen.length, 1000);
    });

    it('never exceeds the requested depth', async () => {
        const plan = planChunks(0n, 999n * MINUTE, MINUTE, 100n, 1000);
        const src = makeSource({ delayMs: 2 });

        await streamRangeChunks<Bar>({
            plan,
            barNs: MINUTE,
            fetch: src.fetch,
            deliver: () => {},
            depth: 2,
        });

        assert.ok(src.peakConcurrency <= 2, `peak concurrency ${src.peakConcurrency}`);
    });

    it('covers a chunk the source answers short, leaving no hole', async () => {
        // 25 bars per answer against 100-bar chunks: every chunk needs four
        // requests. A driver that trusted the first answer would deliver a
        // quarter of the data and say nothing about it.
        const plan = planChunks(0n, 999n * MINUTE, MINUTE, 100n, 1000);
        const src = makeSource({ capBars: 25 });
        const sink = collect();

        await streamRangeChunks<Bar>({
            plan,
            barNs: MINUTE,
            fetch: src.fetch,
            deliver: sink.deliver,
        });

        assert.equal(sink.seen.length, 1000);
        for (let i = 0; i < sink.seen.length; i++) {
            assert.equal(sink.seen[i], BigInt(i) * MINUTE);
        }
    });

    it('stops rather than spinning against a source that never advances', async () => {
        const plan = planChunks(0n, 999n * MINUTE, MINUTE, 100n, 1000);
        let requests = 0;

        await streamRangeChunks<Bar>({
            plan,
            barNs: MINUTE,
            fetch: async () => {
                requests++;
                // no bars, and a coveredTo that goes backwards
                return { bars: [], coveredTo: 0n };
            },
            deliver: () => {},
            maxContinuations: 4,
        });

        assert.ok(requests <= plan.length * 4, `${requests} requests - it is spinning`);
    });

    it('reports a failure in plan order, not in the order it happened', async () => {
        // Chunk 1 fails immediately; chunk 0 is slow. The failure must not
        // surface before chunk 0 has been delivered, or the bars in between are
        // skipped on the way to reporting it.
        const plan = planChunks(0n, 399n * MINUTE, MINUTE, 100n, 1000);
        const sink = collect();

        const fetch = async ({
            fromNs,
            toNs,
            barNs,
        }: {
            fromNs: bigint;
            toNs: bigint;
            barNs: bigint;
        }) => {
            if (fromNs >= 100n * MINUTE) throw new Error('boom');
            await new Promise((r) => setTimeout(r, 10));
            const bars: Bar[] = [];
            for (let ts = fromNs; ts <= toNs; ts += barNs) bars.push({ ts });
            return { bars, coveredTo: toNs };
        };

        await assert.rejects(
            streamRangeChunks<Bar>({ plan, barNs: MINUTE, fetch, deliver: sink.deliver }),
            /boom/,
        );
        // chunk 0 still arrived, whole, before the failure was raised
        assert.equal(sink.seen.length, 100);
        assert.equal(sink.seen[0], 0n);
        assert.equal(sink.seen[99], 99n * MINUTE);
    });

    it('stops delivering once the run is superseded', async () => {
        const plan = planChunks(0n, 999n * MINUTE, MINUTE, 100n, 1000);
        const src = makeSource({ delayMs: 1 });
        const sink = collect();
        let alive = true;

        const run = streamRangeChunks<Bar>({
            plan,
            barNs: MINUTE,
            fetch: src.fetch,
            deliver: sink.deliver,
            onProgress: (done) => {
                if (done >= 2) alive = false;
            },
            isAlive: () => alive,
        });

        const delivered = await run;
        assert.ok(delivered <= 3, `delivered ${delivered} after being superseded`);
        assert.ok(sink.seen.length <= 300);
    });

    it('reports progress once per chunk, counting up to the total', async () => {
        const plan = planChunks(0n, 499n * MINUTE, MINUTE, 100n, 1000);
        const src = makeSource();
        const seenProgress: Array<[number, number]> = [];

        await streamRangeChunks<Bar>({
            plan,
            barNs: MINUTE,
            fetch: src.fetch,
            deliver: () => {},
            onProgress: (done, total) => seenProgress.push([done, total]),
        });

        assert.deepEqual(
            seenProgress.map(([d]) => d),
            [1, 2, 3, 4, 5],
        );
        assert.ok(seenProgress.every(([, t]) => t === 5));
    });

    it('does nothing for an empty plan', async () => {
        const delivered = await streamRangeChunks<Bar>({
            plan: [],
            barNs: MINUTE,
            fetch: async () => {
                throw new Error('should not be called');
            },
            deliver: () => {},
        });
        assert.equal(delivered, 0);
    });
});
