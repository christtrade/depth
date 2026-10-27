import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BarStore } from '../core/BarStore';
import { aggregateOhlcvBars, displayFor, isAggregated } from '../lib/bar-aggregate';

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;

const MIN = 60_000_000_000n;
const HOUR = 60n * MIN;

const T0 = Date.UTC(2026, 0, 5, 14, 0, 0);

function store(startMs: number, stepMs: number, count: number): BarStore {
    const out = new BarStore(count);
    for (let i = 0; i < count; i++) {
        out.appendRow(startMs + i * stepMs, 1, 2, 0.5, 1.5, 1);
    }
    return out;
}

describe('what a store can be displayed as', () => {
    it('does not pass hourly bars off as minutes', () => {
        const hourly = store(T0, HOUR_MS, 4);

        assert.equal(isAggregated(hourly, MIN), true, 'timestamps cannot tell');

        const display = displayFor(hourly, HOUR, MIN);
        assert.notEqual(display, hourly, 'the raw store must not be handed over');
    });

    it('hands the store straight over when it already is the target period', () => {
        const minutes = store(T0, MIN_MS, 10);
        assert.equal(displayFor(minutes, MIN, MIN), minutes);
    });

    it('aggregates up when the source divides the target', () => {
        const minutes = store(T0, MIN_MS, 120);
        const display = displayFor(minutes, MIN, HOUR);

        assert.equal(display.length, 2);
        assert.equal(display.time[0], T0);
        assert.equal(display.time[1], T0 + HOUR_MS);
    });

    it('drops a leading bucket the source only covers part of', () => {
        // starts 30 minutes into the hour, so that hour's candle would be built
        // from half an hour of data
        const minutes = store(T0 + 30 * MIN_MS, MIN_MS, 90);

        const trimmed = aggregateOhlcvBars(minutes, HOUR, null, 0, MIN);
        assert.equal(trimmed.time[0], T0 + HOUR_MS, 'first whole hour');

        const untrimmed = aggregateOhlcvBars(minutes, HOUR, null, 0);
        assert.equal(untrimmed.time[0], T0, 'without a source period there is nothing to judge');
    });
});
