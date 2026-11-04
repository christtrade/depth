import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FineBbo } from './fine-bbo';
import type { HeatmapReply, HeatmapRequest } from './types/heatmap-types';

const MS = 1_000_000n;
const view = (from: bigint, to: bigint) => ({ tMin: from * MS, tMax: to * MS, pMin: 0, pMax: 1 });
const pt = (ms: bigint, p: number) => ({ ts: ms * MS, bestBid: p, bestAsk: p + 1 });
const setup = () => {
    const asks: Extract<HeatmapRequest, { type: 'bbo' }>[] = [];
    const fine = new FineBbo((r) => asks.push(r as (typeof asks)[0]), () => {});
    return { asks, fine };
};
const reply = (a: { from: string; to: string }, until: bigint, ms: bigint[]): Extract<HeatmapReply, { type: 'bbo' }> => ({
    type: 'bbo',
    from: a.from,
    to: a.to,
    until: (until * MS).toString(),
    ts: BigInt64Array.from(ms.map((m) => m * MS)),
    bid: Float64Array.from(ms.map(() => 7)),
    ask: Float64Array.from(ms.map(() => 8)),
});

describe('fine bid/ask', () => {
    const history = [pt(0n, 1), pt(1000n, 2), pt(2000n, 3), pt(3000n, 4)];

    describe('telling the pane it needs a copy of the events', () => {
        const withLines = () => {
            const said: boolean[] = [];
            const fine = new FineBbo(() => {}, () => {}, (w) => said.push(w));
            return { said, fine };
        };

        it('says nothing zoomed out, so the heatmap off stays free', () => {
            const { said, fine } = withLines();
            fine.over(history, view(0n, 1000n), 40);
            fine.notNeeded();
            assert.deepEqual(said, []);
        });

        it('asks zoomed in, before the request, and lets go once', () => {
            const { said, fine } = withLines();
            fine.over(history, view(0n, 1000n), 1000);
            assert.deepEqual(said, [true]);
            fine.notNeeded();
            fine.notNeeded();
            assert.deepEqual(said, [true, false]);
        });

        it('zooming back out isnt letting go, or a wheel in and out rebuilds', () => {
            const { said, fine } = withLines();
            fine.over(history, view(0n, 1000n), 1000);
            fine.over(history, view(0n, 1000n), 40);
            assert.deepEqual(said, [true]);
            fine.notNeeded();
            assert.deepEqual(said, [true, false]);
        });

        it('asks again after the copy went, a clear from the heatmap going off', () => {
            const { said, fine } = withLines();
            fine.over(history, view(0n, 1000n), 1000);
            fine.clear();
            fine.over(history, view(0n, 1000n), 1000);
            assert.deepEqual(said, [true, true]);
        });
    });

    it('stays on the sampled history zoomed out, a 50ms sample under 2px', () => {
        const { asks, fine } = setup();
        assert.equal(fine.over(history, view(0n, 1000n), 40), history);
        assert.equal(asks.length, 0);
    });

    it('asks once for the view and a view either side, draws the answer', () => {
        const { asks, fine } = setup();
        assert.equal(fine.over(history, view(1000n, 2000n), 1000), history);
        fine.over(history, view(1000n, 2000n), 1000);
        fine.over(history, view(500n, 1500n), 1000);
        assert.equal(asks.length, 1);
        assert.equal(asks[0].from, (0n).toString());
        assert.equal(asks[0].to, (3000n * MS).toString());
        fine.onReply(reply(asks[0], 3000n, [0n, 1500n]));
        const out = fine.over(history, view(1000n, 2000n), 1000);
        assert.deepEqual(out.map((p) => p.ts), [0n, 1500n * MS]);
    });

    it('a pan off the answer asks again, the history covers the part it misses', () => {
        const { asks, fine } = setup();
        fine.over(history, view(1000n, 2000n), 1000);
        fine.onReply(reply(asks[0], 3000n, [0n, 1500n]));
        const out = fine.over(history, view(2500n, 3500n), 1000);
        assert.equal(asks.length, 2);
        assert.deepEqual(out.map((p) => p.ts), [0n, 1500n * MS, 3000n * MS]);
    });

    it('drops an answer to an older ask', () => {
        const { asks, fine } = setup();
        fine.over(history, view(1000n, 2000n), 1000);
        fine.over(history, view(5000n, 6000n), 1000);
        fine.onReply(reply(asks[0], 3000n, [0n]));
        assert.equal(fine.over(history, view(5000n, 6000n), 1000), history);
    });

    it('new data asks again and keeps drawing the old answer, new data from 0 forgets it', () => {
        const { asks, fine } = setup();
        fine.over(history, view(1000n, 2000n), 1000);
        fine.onReply(reply(asks[0], 2000n, [0n]));
        fine.dataFrom(2000n * MS);
        const kept = fine.over(history, view(1000n, 2000n), 1000);
        assert.equal(asks.length, 2);
        assert.deepEqual(kept.map((p) => p.ts), [0n]);
        fine.dataFrom(0n);
        assert.equal(fine.over(history, view(1000n, 2000n), 1000), history);
        assert.equal(asks.length, 3);
    });
});
