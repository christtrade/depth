import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { feed, newBuild, seal, unseal } from './heatmap-build';
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

    it('seals an empty build to nothing', () => {
        const b = newBuild();
        seal(b);
        assert.deepEqual(b.snaps.map((s) => s.length), [0, 0, 0, 0]);
    });
});
