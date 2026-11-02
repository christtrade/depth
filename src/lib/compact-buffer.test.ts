import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createCompactBuffer, getEvent } from './compact-buffer';
import { processL3Chunk } from '../core/processing/l3-processor';
import { applyEvent, createBook } from './book';
import type { MboEvent } from './types';

const ev = (i: number, action: MboEvent['action'], price: number, order_id: string): MboEvent => ({
    ts_event: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
    action,
    side: 'B',
    price,
    size: 1,
    order_id,
    sequence: i,
    flags: 0,
});

function bookFromBuf(buf: ArrayBuffer, count: number) {
    const cb = createCompactBuffer(0);
    cb._buf = buf;
    cb._view = new DataView(buf);
    cb.length = cb.capacity = count;
    const book = createBook();
    for (let i = 0; i < cb.length; i++) applyEvent(book, getEvent(cb, i));
    return { book, cb };
}

describe('compact buffer prices and sizes', () => {
    for (const [price, size] of [
        [1.23456, 1],
        [0.00001234, 1],
        [25_000_000.5, 1],
        [97_123.45, 0.0153],
    ]) {
        it(`keeps ${price} x ${size} as is`, () => {
            const e = { ...ev(0, 'A', price, '1'), size };
            const { cb } = bookFromBuf(processL3Chunk([e], 60_000_000_000n).compactBuf, 1);
            const got = getEvent(cb, 0);
            assert.equal(got.price, price);
            assert.equal(got.size, size);
        });
    }

    it('keeps a null price null', () => {
        const e = { ...ev(0, 'R', 0, '0'), price: null, side: 'N' as const };
        const { cb } = bookFromBuf(processL3Chunk([e], 60_000_000_000n).compactBuf, 1);
        assert.equal(getEvent(cb, 0).price, null);
    });
});

describe('compact buffer order ids', () => {
    // cme ids are ab 13 digits, these 2 share their low 24 bits
    for (const [a, b] of [
        ['5', String(5 + 2 ** 24)],
        ['6407636466178', String(6407636466178 + 2 ** 24)],
        // past 2^53, where a js number would round them together
        ['12345678901234567', String(12345678901234567n + 2n ** 24n)],
    ]) {
        it(`keeps ${a} and ${b} apart`, () => {
            const events = [ev(0, 'A', 100, a), ev(1, 'A', 99, b), ev(2, 'C', 100, a)];
            const { book, cb } = bookFromBuf(processL3Chunk(events, 60_000_000_000n).compactBuf, events.length);
            assert.deepEqual([...book.bids.values()].map((o) => o.price), [99]);
            assert.equal(getEvent(cb, 1).order_id, b);
        });
    }
});
