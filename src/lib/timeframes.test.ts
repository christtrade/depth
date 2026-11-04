import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PRESET_TIMEFRAMES, carryView, servableBarNs, switchView, unsupportedReason, zoomSpanLimits } from './timeframes';

const SEC = 1_000_000_000n;
const MIN = 60n * SEC;
const HOUR = 60n * MIN;

describe('carryView', () => {
    const target = { from: 100n, to: 130n };

    it('moves with the horizon while the data loaded', () => {
        assert.deepEqual(carryView(target, 127n, 135n), { from: 108n, to: 138n });
    });

    it('nothing moved on a chart that isnt live', () => {
        assert.deepEqual(carryView(target, 127n, 127n), target);
    });

    it('leaves a view that never had the horizon, the user is looking back', () => {
        assert.deepEqual(carryView(target, 500n, 510n), target);
        assert.deepEqual(carryView(target, 50n, 60n), target);
    });
});
const DAY = 24n * HOUR;

const SUPPORTED = [SEC, MIN, HOUR, DAY];

describe('servableBarNs', () => {
    it('takes the coarsest resolution that divides the timeframe', () => {
        assert.equal(servableBarNs(SUPPORTED, 5n * MIN), MIN);
        assert.equal(servableBarNs(SUPPORTED, 4n * HOUR), HOUR);
        assert.equal(servableBarNs(SUPPORTED, 30n * SEC), SEC);
        assert.equal(servableBarNs(SUPPORTED, DAY), DAY);
    });

    it('skips a coarser resolution that would straddle the buckets', () => {
        // 1m is the closest at or under 90s and the one the old rule picked, but
        // 90s buckets are not multiples of a minute
        assert.equal(servableBarNs(SUPPORTED, 90n * SEC), SEC);
        assert.equal(servableBarNs(SUPPORTED, 7n * MIN), MIN);
        // 90m is not a whole number of hours either
        assert.equal(servableBarNs(SUPPORTED, 90n * MIN), MIN);
    });

    it('says no rather than approximating below the floor', () => {
        assert.equal(servableBarNs([MIN, HOUR], 30n * SEC), null);
        assert.equal(servableBarNs([MIN, HOUR], 90n * SEC), null);
    });

    it('serves anything when the adapter declares nothing', () => {
        assert.equal(servableBarNs(undefined, 30n * SEC), 30n * SEC);
        assert.equal(servableBarNs([], 90n * SEC), 90n * SEC);
    });

    it('is order-independent and ignores junk resolutions', () => {
        assert.equal(servableBarNs([DAY, SEC, HOUR, MIN], 5n * MIN), MIN);
        assert.equal(servableBarNs([0n, -MIN, MIN], 5n * MIN), MIN);
        assert.equal(servableBarNs(SUPPORTED, 0n), null);
    });
});

describe('unsupportedReason', () => {
    it('None needs events, trades or book', () => {
        const none = PRESET_TIMEFRAMES.find((t) => t.label === 'None')!;
        for (const level of [undefined, 'ohlcv']) assert.notEqual(unsupportedReason(none, undefined, level), null);
        for (const level of ['tick', 'l3', 'l2']) assert.equal(unsupportedReason(none, undefined, level), null);
    });
});

describe('zoomSpanLimits', () => {
    const tf = (label: string) => PRESET_TIMEFRAMES.find((t) => t.label === label)!;

    it('lets None zoom in to 3 of the heatmap finest columns', () => {
        assert.equal(zoomSpanLimits(tf('None')).min, 3_000_000n, '3ms at the 1ms default');
        assert.equal(zoomSpanLimits(tf('None'), 1).min, 3n);
        assert.equal(zoomSpanLimits(tf('None'), 1_000).min, 3_000n);
    });

    it('keeps 3 bars for the rest', () => {
        assert.equal(zoomSpanLimits(tf('1s'), 1).min, 3_000_000_000n);
    });
});

describe('the view a timeframe switch lands on', () => {
    const view = { tMin: 0n, tMax: 800n * SEC };

    it('keeps the center when the horizon stays on screen', () => {
        assert.deepEqual(switchView(view, 550n * SEC, 400n * SEC), { from: 200n * SEC, to: 600n * SEC });
    });

    it('keeps the center going wider', () => {
        assert.deepEqual(switchView(view, 640n * SEC, 1600n * SEC), { from: -400n * SEC, to: 1200n * SEC });
    });

    it('a span too narrow for the horizon zooms around it, at the same spot on screen', () => {
        // the horizon 80% across, 5 min right of the center
        const v = switchView(view, 640n * SEC, 30n * SEC);
        assert.deepEqual(v, { from: 616n * SEC, to: 646n * SEC });
    });

    it('stays on what you panned to when the horizon was off screen', () => {
        assert.deepEqual(switchView(view, 5000n * SEC, 30n * SEC), { from: 385n * SEC, to: 415n * SEC });
    });
});
