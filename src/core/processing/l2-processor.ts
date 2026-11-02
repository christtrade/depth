// L2Snapshot[] (+ trades) -> the l3 chunk shape, so l2 gets the book, heatmap and fills l3 has.
// one synthetic order per price level: a new level is an A, a size change an M, a gone level a C.
// trades are T with order id 0, which removes nothing, the next snapshot fixes the level.
// R + the full first snapshot at the first snapshots time, so from there a chunk needs nothing before it

import type { L2Snapshot, OhlcvBar, TickEvent } from '../../interfaces/IDataAdapter';
import type { FootprintBar, FootprintOptions } from '../../lib/types/footprint';
import type { BookState, MboEvent, PriceHistory, SerialTrade } from '../../lib/types';
import { applyEvent, cloneBook, createBook, getBestAsk, getBestBid } from '../../lib/book';
import { BYTES_PER_EVENT, createCompactBuffer, getEvent, getTsNs } from '../../lib/compact-buffer';
import { encodeEvents, processL3Chunk } from './l3-processor';

export interface L2DataChunk {
    kind: 'l2';
    compactBuf: ArrayBuffer;
    /** Empty when the feed sent no trades. */
    trades: SerialTrade[];
    priceHistory: PriceHistory[];
    /** From the trades, empty without them. */
    footprintBars: FootprintBar[];
    /** The mid each time it changes, size 0. What the mid candles are built from. */
    midPrints: SerialTrade[];
    /** Candles off the mid price, volume 0. The bars to draw when the feed has no trades. */
    midBars: OhlcvBar[];
    /** Unix ms */
    dataStart: number;
    dataEnd: number;
    bookAt?: BookState;
}

/**
 * Turn l2 snapshots, and the trades that came with them, into the chunk depth holds.
 *
 * @param snapshots Full-depth snapshots, sorted by time, best price first on each side.
 * @param ticks     Trades in the same span, sorted by time. Empty for a book-only feed.
 * @param barNs     Bar size for the footprint and the mid candles. 0n skips both.
 */
export function processL2Chunk(
    snapshots: L2Snapshot[],
    ticks: TickEvent[],
    barNs: bigint,
    fpOptions: FootprintOptions = {},
): L2DataChunk {
    return l2Chunk(l2Events(snapshots, ticks), barNs, fpOptions);
}

export function l2Chunk(
    events: MboEvent[],
    barNs: bigint,
    fpOptions: FootprintOptions = {},
    carry: { book?: BookState; snapAt?: bigint } = {},
): L2DataChunk {
    if (events.length === 0)
        return {
            kind: 'l2',
            compactBuf: new ArrayBuffer(0),
            trades: [],
            priceHistory: [],
            footprintBars: [],
            midPrints: [],
            midBars: [],
            dataStart: 0,
            dataEnd: 0,
        };
    // processL3Chunk mutates the carried book
    const before = carry.book && cloneBook(carry.book);
    const c = processL3Chunk(events, barNs, fpOptions, carry);
    const prints = midPrints(c.compactBuf, before);
    return {
        kind: 'l2',
        compactBuf: c.compactBuf,
        trades: c.trades,
        priceHistory: c.priceHistory,
        footprintBars: c.footprintBars,
        midPrints: prints,
        midBars: barNs > 0n ? midBars(prints, barNs) : [],
        dataStart: c.dataStart,
        dataEnd: c.dataEnd,
        ...(c.bookAt && { bookAt: c.bookAt }),
    };
}

export function l2Events(snapshots: L2Snapshot[], ticks: TickEvent[]): MboEvent[] {
    const out: MboEvent[] = [];
    const ids = new Map<string, number>();
    let nextId = 1;
    const idOf = (side: 'B' | 'A', price: number) => {
        const k = side + price;
        let id = ids.get(k);
        if (id === undefined) ids.set(k, (id = nextId++));
        return String(id);
    };
    const push = (ms: number, action: MboEvent['action'], side: MboEvent['side'], price: number | null, size: number, id: string) =>
        // seq 0, the seam dedupe keys on it and a re-sent chunk would number from 0 again
        out.push({ ts_event: new Date(ms).toISOString(), action, side, price, size, order_id: id, sequence: 0, flags: 0 });

    const bids = new Map<number, number>();
    const asks = new Map<number, number>();
    const diff = (ms: number, side: 'B' | 'A', held: Map<number, number>, levels: L2Snapshot['bids']) => {
        const seen = new Set<number>();
        for (const { price, size } of levels) {
            if (size <= 0) continue;
            seen.add(price);
            const was = held.get(price);
            if (was === size) continue;
            push(ms, was === undefined ? 'A' : 'M', side, price, size, idOf(side, price));
            held.set(price, size);
        }
        for (const price of held.keys()) {
            if (seen.has(price)) continue;
            push(ms, 'C', side, price, 0, idOf(side, price));
            held.delete(price);
        }
    };

    let t = 0;
    for (let s = 0; s < snapshots.length; s++) {
        const snap = snapshots[s];
        // trades up to and at the snapshot go first, the snapshot is the book after them
        while (t < ticks.length && ticks[t].time <= snap.time) {
            const k = ticks[t++];
            push(k.time, 'T', k.side, k.price, k.size, '0');
        }
        // trades before it play on the book the chunk before left
        if (s === 0) push(snap.time, 'R', 'N', null, 0, '0');
        diff(snap.time, 'B', bids, snap.bids);
        diff(snap.time, 'A', asks, snap.asks);
    }
    while (t < ticks.length) {
        const k = ticks[t++];
        push(k.time, 'T', k.side, k.price, k.size, '0');
    }
    return out;
}

// R + the book as it stood, for a buffer cut at its head. reuses the books ids, since later
// events in the same chunk still point at them
export function anchorEvents(book: BookState, tsNs: bigint): ArrayBuffer {
    const ts_event = new Date(Number(tsNs / 1_000_000n)).toISOString();
    const ev = (action: MboEvent['action'], side: MboEvent['side'], price: number | null, size: number, order_id: string): MboEvent =>
        ({ ts_event, action, side, price, size, order_id, sequence: 0, flags: 0 });
    const out = [ev('R', 'N', null, 0, '0')];
    for (const [id, o] of book.bids) out.push(ev('A', 'B', o.price, o.size, id));
    for (const [id, o] of book.asks) out.push(ev('A', 'A', o.price, o.size, id));
    return encodeEvents(out, new BigInt64Array(out.length).fill(tsNs));
}

// the mid each time it changes, after everything at that ts. a side left empty has no mid.
// size 0 so the trade candle code builds mid candles off them with volume 0
export function midPrints(buf: ArrayBuffer, book: BookState = createBook()): SerialTrade[] {
    const cb = createCompactBuffer(0);
    cb._buf = buf;
    cb._view = new DataView(buf);
    cb.length = cb.capacity = buf.byteLength / BYTES_PER_EVENT;
    const out: SerialTrade[] = [];
    let last = midOf(book);
    for (let i = 0; i < cb.length; i++) {
        const ts = getTsNs(cb, i);
        applyEvent(book, getEvent(cb, i));
        if (i + 1 < cb.length && getTsNs(cb, i + 1) === ts) continue;
        const mid = midOf(book);
        if (sameMid(mid, last)) continue;
        last = mid;
        if (mid !== null) out.push({ ts, price: mid, size: 0, side: 'B' });
    }
    return out;
}

export function midOf(book: BookState): number | null {
    const bid = getBestBid(book);
    const ask = getBestAsk(book);
    return bid === null || ask === null ? null : (bid + ask) / 2;
}

// the same mid off another bid/ask pair can be off in the last bits
export const sameMid = (a: number | null, b: number | null) =>
    a === b || (a !== null && b !== null && Math.abs(a - b) <= 1e-9 * Math.abs(a));

// candles off midPrints, from index `from` on
export function midBars(prints: readonly SerialTrade[], barNs: bigint, from = 0): OhlcvBar[] {
    const out: OhlcvBar[] = [];
    for (let i = from; i < prints.length; i++) {
        const { ts, price } = prints[i];
        const time = Number(((ts / barNs) * barNs) / 1_000_000n);
        const bar = out.at(-1);
        if (bar && bar.time === time) {
            if (price > bar.high) bar.high = price;
            if (price < bar.low) bar.low = price;
            bar.close = price;
        } else out.push({ time, open: price, high: price, low: price, close: price, volume: 0 });
    }
    return out;
}
