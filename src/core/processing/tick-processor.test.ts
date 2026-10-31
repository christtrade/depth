import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { processTickChunk } from './tick-processor';
import type { TickEvent } from '../../interfaces/IDataAdapter';

const MIN = 60_000_000_000n;
const T0 = 1_767_225_600_000;

describe('processTickChunk', () => {
    it('builds footprints the renderer can draw, buys on the ask', () => {
        const ticks: TickEvent[] = [
            { time: T0, price: 100, size: 3, side: 'B' },
            { time: T0 + 1000, price: 100.25, size: 2, side: 'A' },
            { time: T0 + 2000, price: 100, size: 1, side: 'B' },
        ];
        const [bar] = processTickChunk(ticks, MIN).footprintBars;

        assert.ok(Array.isArray(bar.levels));
        assert.deepEqual(
            bar.levels.map((l) => [l.price, l.bidVol, l.askVol]),
            [
                [100.25, 2, 0],
                [100, 0, 4],
            ],
        );
        assert.equal(bar.totalDelta, 2);
        assert.equal(bar.maxLevelVol, 4);
        assert.equal(bar.poc, 100);
    });
});
