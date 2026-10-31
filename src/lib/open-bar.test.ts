import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { appendEvents, createCompactBuffer } from './compact-buffer';
import { openBarFrom } from './open-bar';
import { isoToNs } from './sampler';
import { buildFootprint } from './types/footprint';
import type { MboEvent } from './types';

const MIN = 60_000_000_000n;

const trade = (s: number, price: number, size: number, side: 'B' | 'A'): MboEvent => ({
    ts_event: new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString(),
    action: 'T',
    side,
    price,
    size,
    order_id: '1',
    sequence: s,
    flags: 0,
});

describe('openBarFrom', () => {
    it('builds the forming bar like the closed ones', () => {
        const events = [
            trade(1, 100, 3, 'B'),
            trade(2, 100.25, 2, 'A'),
            trade(3, 100.25, 9, 'A'),
            trade(4, 100, 1, 'B'),
        ];
        const cb = createCompactBuffer();
        appendEvents(cb, events, isoToNs);

        const open = openBarFrom(cb, 0, events.length - 1, MIN);
        const [closed] = buildFootprint(events, MIN);
        assert.deepEqual(open, closed);
        assert.equal(open!.levels.find((l) => l.price === 100)!.askVol, 4);
    });
});
