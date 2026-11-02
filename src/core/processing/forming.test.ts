import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formingOf, joinForming } from './forming';
import type { FetchResponse, TickEvent } from '../../interfaces/IDataAdapter';

const MIN = 60_000_000_000n;
const T0 = Date.UTC(2026, 0, 1);

const tick = (time: number, size = 1): TickEvent => ({ time, price: 100, size, side: 'B' });
const resp = (ticks: TickEvent[]) => ({ ticks, hasMore: false }) as FetchResponse;

describe('forming bucket', () => {
    it('keeps the raw items of the newest bucket only', () => {
        const f = formingOf('tick', resp([tick(T0 - 1000), tick(T0), tick(T0 + 5000)]), MIN)!;
        assert.equal(f.bucket, BigInt(T0) * 1_000_000n);
        assert.deepEqual(f.items, [tick(T0), tick(T0 + 5000)]);
    });

    it('a chunk of nothing but re-sent items brings nothing', () => {
        const f = formingOf('tick', resp([tick(T0), tick(T0 + 5000)]), MIN);
        assert.equal(joinForming('tick', f, resp([tick(T0 + 5000)]), MIN), null);
    });

    it('a genuinely new trade at the last held ms survives', () => {
        const f = formingOf('tick', resp([tick(T0 + 5000)]), MIN);
        const j = joinForming('tick', f, resp([tick(T0 + 5000), tick(T0 + 5000, 7)]), MIN)!;
        assert.deepEqual(j.response.ticks, [tick(T0 + 5000), tick(T0 + 5000, 7)]);
    });

    it('a chunk that starts a new bucket leaves the held data alone', () => {
        const f = formingOf('tick', resp([tick(T0 + 5000)]), MIN);
        const j = joinForming('tick', f, resp([tick(T0 + 60_000)]), MIN)!;
        assert.equal(j.trimFromNs, null);
        assert.deepEqual(j.response.ticks, [tick(T0 + 60_000)]);
    });

    it('a late item inside the bucket is sorted in, not appended out of order', () => {
        const f = formingOf('tick', resp([tick(T0), tick(T0 + 5000)]), MIN);
        const j = joinForming('tick', f, resp([tick(T0 + 2000), tick(T0 + 9000)]), MIN)!;
        assert.deepEqual(
            (j.response.ticks ?? []).map((t) => t.time - T0),
            [0, 2000, 5000, 9000],
        );
    });

    it('ohlcv goes through untouched', () => {
        const r = { bars: [], hasMore: false } as FetchResponse;
        assert.deepEqual(joinForming('ohlcv', null, r, MIN), { response: r, trimFromNs: null });
    });
});
