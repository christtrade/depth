import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { simL2Snapshots, simMboEvents, simTicks } from './sim-levels';
import { applyEvent, createBook } from './book';
import { processL3Chunk } from '../core/processing/l3-processor';
import { processTickChunk } from '../core/processing/tick-processor';

const T0 = Date.UTC(2026, 0, 1);
const MIN_MS = 60_000;
const MIN = 60_000_000_000n;

const price = (ms: number) => 100 + 3 * Math.sin(ms / 2.7e6) + 0.4 * Math.sin(ms / 7_000);

// deepequals diff of 2 big arrays takes too much memory for node
// so only report the first mismatch
function same(actual: unknown[], expected: unknown[], what: string) {
    const n = Math.max(actual.length, expected.length);
    for (let i = 0; i < n; i++) {
        const a = JSON.stringify(actual[i]);
        const e = JSON.stringify(expected[i]);
        assert.ok(a === e, `${what}: first difference at ${i}\n  got      ${a}\n  expected ${e}`);
    }
}

describe('simulated levels', () => {
    it('pages join: two halves are the whole', () => {
        // a split off the 100ms grid too
        for (const split of [T0 + 5 * MIN_MS, T0 + 5 * MIN_MS + 37]) {
            same(
                simTicks(price, T0, split).concat(simTicks(price, split, T0 + 10 * MIN_MS)),
                simTicks(price, T0, T0 + 10 * MIN_MS),
                'ticks',
            );
            same(
                simMboEvents(price, T0, split).concat(simMboEvents(price, split, T0 + 10 * MIN_MS)),
                simMboEvents(price, T0, T0 + 10 * MIN_MS),
                'events',
            );
        }
    });

    it('stays inside the range and in time order', () => {
        const from = T0 + 123;
        const to = T0 + MIN_MS;
        const ticks = simTicks(price, from, to);
        const events = simMboEvents(price, from, to);
        assert.ok(ticks.length > 0 && events.length > 0);
        for (let i = 0; i < ticks.length; i++) {
            assert.ok(ticks[i].time >= from && ticks[i].time < to);
            if (i) assert.ok(ticks[i].time >= ticks[i - 1].time);
        }
        for (let i = 0; i < events.length; i++) {
            const t = Date.parse(events[i].ts_event);
            assert.ok(t >= from && t < to);
            if (i) assert.ok(events[i].sequence > events[i - 1].sequence);
        }
    });

    it('the book never crosses, and once warm every cancel hits a resting order', () => {
        const events = simMboEvents(price, T0, T0 + 30 * MIN_MS);
        const book = createBook();
        const warm = T0 + 10_000;
        let checked = 0;
        for (const e of events) {
            if (e.action === 'C' && Date.parse(e.ts_event) >= warm) {
                const side = e.side === 'B' ? book.bids : book.asks;
                assert.ok(side.has(e.order_id), `cancel of unknown order ${e.order_id}`);
            }
            applyEvent(book, e);
            if (book.bestBid !== null && book.bestAsk !== null) {
                assert.ok(book.bestBid < book.bestAsk, `crossed at ${e.ts_event}`);
                checked++;
            }
        }
        assert.ok(checked > events.length / 2);
    });

    it('the touch is often a tick wide', () => {
        const { priceHistory } = processL3Chunk(simMboEvents(price, T0, T0 + 30 * MIN_MS, { levels: 40 }), MIN);
        const ticks = priceHistory.map((p) => Math.round((p.bestAsk - p.bestBid) / 0.01));
        const oneTick = ticks.filter((t) => t === 1).length / ticks.length;
        assert.ok(oneTick > 0.3, `a tick wide ${(oneTick * 100).toFixed(0)}% of the time`);
    });

    it('l2: pages join, a repeat of the last snapshot at the seam aside', () => {
        const to = T0 + 10 * MIN_MS;
        for (const split of [T0 + 5 * MIN_MS, T0 + 5 * MIN_MS + 37]) {
            const joined = simL2Snapshots(price, T0, split).concat(simL2Snapshots(price, split, to));
            const deduped = joined.filter(
                (s, i) => i === 0 || JSON.stringify([s.bids, s.asks]) !== JSON.stringify([joined[i - 1].bids, joined[i - 1].asks]),
            );
            same(deduped, simL2Snapshots(price, T0, to), 'snapshots');
        }
    });

    it('l2: in range, in order, sorted, one row a price, never crossed', () => {
        const from = T0 + 123;
        const to = T0 + 5 * MIN_MS;
        const snaps = simL2Snapshots(price, from, to, { depth: 5 });
        assert.ok(snaps.length > 100);
        for (let i = 0; i < snaps.length; i++) {
            const { time, bids, asks } = snaps[i];
            assert.ok(time >= from && time < to);
            if (i) assert.ok(time > snaps[i - 1].time);
            assert.ok(bids.length <= 5 && asks.length <= 5);
            for (let j = 1; j < bids.length; j++) assert.ok(bids[j].price < bids[j - 1].price);
            for (let j = 1; j < asks.length; j++) assert.ok(asks[j].price > asks[j - 1].price);
            if (bids.length && asks.length) assert.ok(bids[0].price < asks[0].price, `crossed at ${time}`);
        }
    });

    it('l2: the touch and its size match the l3 book', () => {
        const events = simMboEvents(price, T0, T0 + 5 * MIN_MS);
        const snaps = simL2Snapshots(price, T0, T0 + 5 * MIN_MS);
        const book = createBook();
        // past the first lifeSlots the l3 replay holds every resting order too
        const warm = T0 + 10_000;
        let s = 0;
        let checked = 0;
        for (let i = 0; i < events.length; i++) {
            applyEvent(book, events[i]);
            const t = Date.parse(events[i].ts_event);
            if (i + 1 < events.length && Date.parse(events[i + 1].ts_event) === t) continue;
            while (s + 1 < snaps.length && snaps[s + 1].time <= t) s++;
            if (t < warm || snaps[s].time > t) continue;
            const sizeAt = (m: Map<string, { price: number; size: number }>, p: number) =>
                [...m.values()].filter((o) => o.price === p).reduce((n, o) => n + o.size, 0);
            const { bids, asks } = snaps[s];
            assert.equal(bids[0]?.price ?? null, book.bestBid, `best bid at ${t}`);
            assert.equal(asks[0]?.price ?? null, book.bestAsk, `best ask at ${t}`);
            if (bids[0]) assert.equal(bids[0].size, sizeAt(book.bids as any, bids[0].price));
            checked++;
        }
        assert.ok(checked > 1000, `checked ${checked}`);
    });

    it('tick and l3 print the same trades', () => {
        const ticks = simTicks(price, T0, T0 + 5 * MIN_MS);
        const trades = simMboEvents(price, T0, T0 + 5 * MIN_MS)
            .filter((e) => e.action === 'T')
            .map((e) => ({ time: Date.parse(e.ts_event), price: e.price, size: e.size, side: e.side }));
        same(trades, ticks, 'trades');
    });

    it('trades follow the price path', () => {
        for (const t of simTicks(price, T0, T0 + 5 * MIN_MS)) {
            assert.ok(Math.abs(t.price - price(t.time)) <= 0.015, `${t.price} vs ${price(t.time)}`);
        }
    });

    it('feeds the processors: a footprint bar per minute at both levels', () => {
        const hour = [T0, T0 + 60 * MIN_MS] as const;
        assert.equal(processTickChunk(simTicks(price, ...hour), MIN).footprintBars.length, 60);
        const l3 = processL3Chunk(simMboEvents(price, ...hour), MIN);
        assert.equal(l3.footprintBars.length, 60);
        assert.ok(l3.priceHistory.length > 0);
    });
});
