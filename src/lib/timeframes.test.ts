import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { servableBarNs } from './timeframes';

const SEC = 1_000_000_000n;
const MIN = 60n * SEC;
const HOUR = 60n * MIN;
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
