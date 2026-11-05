import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formingOf, joinForming } from './forming';
import type { FetchResponse, TickEvent } from '../../interfaces/IDataAdapter';
import type { MboEvent } from '../../lib/types';

const MIN = 60_000_000_000n;
const T0 = Date.UTC(2026, 0, 1);

const tick = (time: number, size = 1): TickEvent => ({ time, price: 100, size, side: 'B' });
const resp = (ticks: TickEvent[]) => ({ ticks, hasMore: false }) as FetchResponse;

describe('a chunk that starts with a book reset', () => {
    const at = (ms: number) => new Date(ms).toISOString();
    const ev = (ms: number, action: MboEvent['action'], price: number | null, id: string): MboEvent => ({
        ts_event: at(ms),
        action,
        side: action === 'R' ? 'N' : 'B',
        price,
        size: action === 'R' ? 0 : 10,
        order_id: id,
        sequence: 0,
        flags: 0,
    });
    const mbo = (events: MboEvent[]) => ({ mbo: events, hasMore: false }) as FetchResponse;
    const t = T0 + 5000;

    it('keeps its levels even when one looks like one that was held, the reset wiped that', () => {
        const f = formingOf('l2', mbo([ev(t - 100, 'A', 99, '1'), ev(t, 'A', 100, '2')]), MIN);
        const chunk = [ev(t, 'R', null, '0'), ev(t, 'A', 99, '1'), ev(t, 'A', 100, '2')];
        const j = joinForming('l2', f, mbo(chunk), MIN)!;
        const events = j.response.mbo as MboEvent[];
        assert.deepEqual(events.slice(-3), chunk);
    });

    it('what was held after the reset goes, the chunk restates it', () => {
        const f = formingOf('l2', mbo([ev(t - 100, 'A', 98, '9'), ev(t, 'A', 99, '1'), ev(t + 100, 'A', 97, '8')]), MIN);
        const chunk = [ev(t, 'R', null, '0'), ev(t, 'A', 99, '1'), ev(t + 200, 'A', 100, '2')];
        const j = joinForming('l2', f, mbo(chunk), MIN)!;
        const prices = (j.response.mbo as MboEvent[]).map((e) => e.price);
        assert.ok(!prices.includes(97), `the held event after the reset, got ${prices}`);
        assert.ok(prices.includes(98), 'what was before it stays');
        assert.deepEqual(prices.slice(-3), [null, 99, 100]);
    });

    it('the very same chunk sent again still brings nothing', () => {
        const chunk = [ev(t, 'R', null, '0'), ev(t, 'A', 99, '1')];
        const f = formingOf('l2', mbo(chunk), MIN);
        assert.equal(joinForming('l2', f, mbo(chunk), MIN), null);
    });

    it('with no reset the seam still drops repeats', () => {
        const f = formingOf('l3', mbo([ev(t, 'A', 99, '1')]), MIN);
        const j = joinForming('l3', f, mbo([ev(t, 'A', 99, '1'), ev(t + 100, 'A', 100, '2')]), MIN)!;
        assert.deepEqual((j.response.mbo as MboEvent[]).map((e) => e.price), [99, 100]);
    });
});

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
