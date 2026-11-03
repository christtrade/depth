import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { feed, newBuild, rowTicks, seal, sumRows, unseal } from './heatmap-build';
import { simMboEvents } from './sim-levels';

const T0 = Date.UTC(2026, 0, 1);
const price = (ms: number) => 100 + 3 * Math.sin(ms / 2.7e6) + 0.4 * Math.sin(ms / 7_000);
const events = simMboEvents(price, T0, T0 + 10 * 60_000, { slotMs: 250 });

describe('the heatmap build', () => {
    it('ends up the same built whole or an init and appends at a time', async () => {
        const whole = newBuild();
        await feed(whole, events);
        seal(whole);

        const parts = newBuild();
        let at = 0;
        // uneven cuts, some inside a snapshot interval
        for (const n of [5000, 37, 1, 2500, 999, events.length]) {
            unseal(parts);
            await feed(parts, events.slice(at, at + n));
            seal(parts);
            at += n;
            if (at >= events.length) break;
        }

        assert.ok(whole.snaps[0].length > 100, 'enough snapshots to mean something');
        assert.deepEqual(parts.snaps, whole.snaps);
    });

    it('keeps fx levels a pip apart as their own levels', async () => {
        const at = (i: number) => new Date(T0 + i).toISOString();
        const b = newBuild();
        await feed(b, [
            { ts_event: at(0), action: 'A', side: 'B', price: 1.23451, size: 3, order_id: '1', sequence: 0, flags: 0 },
            { ts_event: at(1), action: 'A', side: 'B', price: 1.23454, size: 5, order_id: '2', sequence: 1, flags: 0 },
        ]);
        seal(b);
        const bids = [...b.snaps[0].at(-1)!.bids];
        assert.deepEqual(bids.length, 4, `2 levels, got ${bids}`);
        assert.deepEqual(new Set([bids[0], bids[2]]), new Set([1.23451, 1.23454]));
    });

    it('seals an empty build to nothing', () => {
        const b = newBuild();
        seal(b);
        assert.deepEqual(b.snaps.map((s) => s.length), [0, 0, 0, 0]);
    });
});

describe('heatmap rows', () => {
    it('are the fewest ticks, a power of 2, that make a row tall enough', () => {
        assert.equal(rowTicks(5, 3), 1);
        assert.equal(rowTicks(3, 3), 1);
        assert.equal(rowTicks(1, 3), 4);
        assert.equal(rowTicks(0.01, 3), 512);
    });

    it('add up the sizes of the prices in them, so a spread out wall outweighs one big level', () => {
        // ten 1 lot asks 100.00..100.09 and a 5 lot at 100.11, rows of 8 ticks
        const asks = new Float64Array([...Array.from({ length: 10 }, (_, i) => [100 + i / 100, 1]).flat(), 100.11, 5]);
        assert.deepEqual([...sumRows(asks, 0.01, 8)], [1250, 8, 1251, 7]);
    });

    it('come out the same with the prices high to low, like bids', () => {
        const bids = new Float64Array([100.09, 2, 100.03, 1, 99.99, 4, 99.98, 1]);
        assert.deepEqual([...sumRows(bids, 0.01, 4)], [2502, 2, 2500, 1, 2499, 5]);
    });

    it('put a price off by float noise in its own tick', () => {
        const asks = new Float64Array([0.1 + 0.2, 3, 0.31, 1]);
        assert.deepEqual([...sumRows(asks, 0.01, 1)], [30, 3, 31, 1]);
    });
});
