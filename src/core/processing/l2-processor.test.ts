import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { midBars, processL2Chunk } from './l2-processor';
import { simL2Snapshots, simTicks } from '../../lib/sim-levels';
import { applyEvent, createBook } from '../../lib/book';
import { BYTES_PER_EVENT, createCompactBuffer, getEvent, getTsNs } from '../../lib/compact-buffer';
import { footprintFromTrades } from '../../lib/types/footprint';
import type { L2Snapshot } from '../../interfaces/IDataAdapter';

const T0 = Date.UTC(2026, 0, 1);
const MIN_MS = 60_000;
const MIN = 60_000_000_000n;
const price = (ms: number) => 100 + 3 * Math.sin(ms / 2.7e6) + 0.4 * Math.sin(ms / 7_000);

const join = (...bufs: ArrayBuffer[]) => {
    const out = new Uint8Array(bufs.reduce((n, b) => n + b.byteLength, 0));
    let at = 0;
    for (const b of bufs) {
        out.set(new Uint8Array(b), at);
        at += b.byteLength;
    }
    return out.buffer;
};

const side = (levels: { price: number; size: number }[]) => levels.map((l) => `${l.price.toFixed(6)}x${l.size}`).join(' ');

// replays buf and checks the book against each snapshot at its time
function assertReplaysTo(buf: ArrayBuffer, snaps: L2Snapshot[]) {
    const cb = createCompactBuffer(0);
    cb._buf = buf;
    cb._view = new DataView(buf);
    cb.length = cb.capacity = buf.byteLength / BYTES_PER_EVENT;
    for (let i = 1; i < cb.length; i++) assert.ok(getTsNs(cb, i) >= getTsNs(cb, i - 1), `event ${i} out of order`);
    const book = createBook();
    const top = (m: Map<string, { price: number; size: number }>, desc: boolean) => {
        const by = new Map<number, number>();
        for (const o of m.values()) by.set(o.price, (by.get(o.price) ?? 0) + o.size);
        return side([...by].sort((a, b) => (desc ? b[0] - a[0] : a[0] - b[0])).map(([price, size]) => ({ price, size })));
    };
    let i = 0;
    for (const s of snaps) {
        const at = BigInt(s.time) * 1_000_000n;
        while (i < cb.length && getTsNs(cb, i) <= at) applyEvent(book, getEvent(cb, i++));
        const got = `${top(book.bids as any, true)} | ${top(book.asks as any, false)}`;
        const exp = `${side(s.bids)} | ${side(s.asks)}`;
        assert.ok(got === exp, `book at ${new Date(s.time).toISOString()}:\n  got      ${got}\n  expected ${exp}`);
    }
}

describe('processL2Chunk', () => {
    const from = T0 - 30 * MIN_MS;
    const snaps = simL2Snapshots(price, from, T0);
    const ticks = simTicks(price, from, T0);

    it('the events replay to every snapshot', () => {
        assertReplaysTo(processL2Chunk(snaps, ticks, MIN).compactBuf, snaps);
    });

    it('chunks joined replay the same, and each one alone from its first snapshot', () => {
        const mid = T0 - 13 * MIN_MS - 37;
        const a = processL2Chunk(simL2Snapshots(price, from, mid), simTicks(price, from, mid), MIN);
        const bSnaps = simL2Snapshots(price, mid, T0);
        const b = processL2Chunk(bSnaps, simTicks(price, mid, T0), MIN);
        assertReplaysTo(join(a.compactBuf, b.compactBuf), snaps);
        assertReplaysTo(b.compactBuf, bSnaps);
    });

    it('trades are the ticks, footprints are built from them', () => {
        const c = processL2Chunk(snaps, ticks, MIN);
        assert.equal(
            JSON.stringify(c.trades.map((t) => [Number(t.ts / 1_000_000n), t.price, t.size, t.side])),
            JSON.stringify(ticks.map((t) => [t.time, t.price, t.size, t.side])),
        );
        const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? String(x) : x));
        assert.equal(json(c.footprintBars), json(footprintFromTrades(c.trades, MIN)));
        assert.equal(c.footprintBars.length, 30);
    });

    it('book only: no trades or footprints, mid candles a minute each', () => {
        const c = processL2Chunk(snaps, [], MIN);
        assert.equal(c.trades.length, 0);
        assert.equal(c.footprintBars.length, 0);
        assert.equal(c.midBars.length, 30);
        // a tick is the mid changing, like a trade for trade candles
        const ticks: { time: number; mid: number }[] = [];
        for (const s of snaps) {
            // in cents, or the same mid off another bid/ask pair reads as a change
            const mid = (Math.round(s.bids[0].price * 100) + Math.round(s.asks[0].price * 100)) / 200;
            if (mid !== ticks.at(-1)?.mid) ticks.push({ time: s.time, mid });
        }
        // prices come back off the compact buffer, last bits differ
        const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
        assert.equal(c.midPrints.length, ticks.length);
        c.midPrints.forEach((p, i) => {
            assert.equal(Number(p.ts / 1_000_000n), ticks[i].time);
            assert.ok(near(p.price, ticks[i].mid), `print ${i} ${p.price} want ${ticks[i].mid}`);
            assert.equal(p.size, 0);
        });
        for (const b of c.midBars) {
            const inBar = ticks.filter((t) => Math.floor(t.time / MIN_MS) * MIN_MS === b.time).map((t) => t.mid);
            const want = [inBar[0], Math.max(...inBar), Math.min(...inBar), inBar.at(-1)!];
            [b.open, b.high, b.low, b.close].forEach((v, i) => assert.ok(near(v, want[i]), `${b.time} ${v} want ${want[i]}`));
            assert.equal(b.volume, 0);
        }
    });

    it('an empty side is gone, not a level at 0, and the mid skips it', () => {
        const s: L2Snapshot[] = [
            { time: T0, bids: [{ price: 99, size: 5 }], asks: [{ price: 101, size: 5 }] },
            { time: T0 + 1000, bids: [{ price: 99, size: 5 }], asks: [] },
            { time: T0 + 2000, bids: [{ price: 99, size: 5 }], asks: [{ price: 103, size: 2 }] },
        ];
        const c = processL2Chunk(s, [], MIN);
        assertReplaysTo(c.compactBuf, s);
        assert.equal(c.midBars.length, 1);
        assert.equal(c.midBars[0].high, 101, 'the one-sided moment left out');
        assert.equal(c.midBars[0].close, 101);
    });

    it('trades before the first snapshot play on the book before it', () => {
        const s: L2Snapshot[] = [{ time: T0 + 500, bids: [{ price: 99, size: 5 }], asks: [{ price: 101, size: 5 }] }];
        const t = [{ time: T0, price: 100, size: 1, side: 'B' as const }];
        const c = processL2Chunk(s, t, MIN);
        assertReplaysTo(c.compactBuf, s);
        assert.equal(c.dataStart, T0);
        assert.equal(c.trades.length, 1);
    });

    it('nothing in, nothing out', () => {
        const c = processL2Chunk([], [], MIN);
        assert.equal(c.compactBuf.byteLength, 0);
        assert.equal(c.midBars.length, 0);
    });

    it('midBars rebuckets what is held at another size', () => {
        const c = processL2Chunk(snaps, [], MIN);
        const five = midBars(c.midPrints, 5n * MIN);
        assert.equal(five.length, 6);
        assert.equal(five[0].high, Math.max(...c.midBars.slice(0, 5).map((b) => b.high)));
        assert.equal(five.at(-1)!.close, c.midBars.at(-1)!.close);
    });
});
