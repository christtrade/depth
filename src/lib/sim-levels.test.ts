import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { simMboEvents, simTicks } from './sim-levels';
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
