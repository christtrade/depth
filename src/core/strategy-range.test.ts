import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { clipRange, hasRange, emptyRangeReason } from './strategy-range';
import type { StrategyBar } from './strategy-runtime';

const MIN = 60_000_000_000n;

function bars(n: number): StrategyBar[] {
    return Array.from({ length: n }, (_, i) => ({
        ts: BigInt(i) * MIN,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 1,
    }));
}

const TEN = bars(10);

describe('clipRange', () => {
    it('returns everything for no range at all', () => {
        const c = clipRange(TEN);
        assert.equal(c.from, 0);
        assert.equal(c.to, 10);
        assert.equal(c.count, 10);
        // count === total is how a caller knows nothing was clipped
        assert.equal(c.count, c.total);
    });

    it('includes the bar opening exactly on each bound', () => {
        // a bar's timestamp is its open, so both ends are inclusive of it
        const c = clipRange(TEN, { fromNs: 2n * MIN, toNs: 5n * MIN });
        assert.equal(c.from, 2);
        assert.equal(c.to, 6);
        assert.equal(c.count, 4);
        assert.equal(c.firstTs, 2n * MIN);
        assert.equal(c.lastTs, 5n * MIN);
    });

    it('rounds a bound falling between bars outward on from, inward on to', () => {
        // from lands on the next bar that starts at or after it
        const c = clipRange(TEN, { fromNs: 2n * MIN + 1n, toNs: 5n * MIN - 1n });
        assert.equal(c.from, 3);
        assert.equal(c.to, 5);
        assert.equal(c.firstTs, 3n * MIN);
        assert.equal(c.lastTs, 4n * MIN);
    });

    it('honours a one-sided range', () => {
        const fromOnly = clipRange(TEN, { fromNs: 7n * MIN });
        assert.equal(fromOnly.from, 7);
        assert.equal(fromOnly.to, 10);

        const toOnly = clipRange(TEN, { toNs: 2n * MIN });
        assert.equal(toOnly.from, 0);
        assert.equal(toOnly.to, 3);
    });

    it('reports the total even when nothing falls in range', () => {
        const c = clipRange(TEN, { fromNs: 100n * MIN });
        assert.equal(c.count, 0);
        assert.equal(c.total, 10);
        assert.equal(c.firstTs, null);
        assert.equal(c.lastTs, null);
    });

    it('treats an inverted range as empty rather than throwing', () => {
        const c = clipRange(TEN, { fromNs: 8n * MIN, toNs: 2n * MIN });
        assert.equal(c.count, 0);
        assert.ok(c.to >= c.from);
    });

    it('handles an empty bar array', () => {
        const c = clipRange([], { fromNs: 0n, toNs: MIN });
        assert.equal(c.count, 0);
        assert.equal(c.total, 0);
        assert.equal(c.firstTs, null);
    });

    it('clamps bounds beyond the data to the data', () => {
        const c = clipRange(TEN, { fromNs: -5n * MIN, toNs: 500n * MIN });
        assert.equal(c.from, 0);
        assert.equal(c.to, 10);
        assert.equal(c.count, 10);
    });
});

describe('hasRange', () => {
    it('is false for absent or empty', () => {
        assert.equal(hasRange(undefined), false);
        assert.equal(hasRange({}), false);
    });

    it('is true for either end alone', () => {
        assert.equal(hasRange({ fromNs: 0n }), true);
        assert.equal(hasRange({ toNs: 0n }), true);
    });
});

describe('emptyRangeReason', () => {
    it('names the inversion when the range is backwards', () => {
        const range = { fromNs: 8n * MIN, toNs: 2n * MIN };
        const msg = emptyRangeReason(clipRange(TEN, range), range);
        assert.match(msg, /after its end/);
    });

    it('says there is no data at all when nothing is loaded', () => {
        const msg = emptyRangeReason(clipRange([], {}), {});
        assert.match(msg, /No bars are loaded/);
    });

    it('reports how much data sits outside the range', () => {
        const range = { fromNs: 100n * MIN };
        const msg = emptyRangeReason(clipRange(TEN, range), range);
        assert.match(msg, /10 bars outside it/);
    });
});
