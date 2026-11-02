// L2Snapshot[] (+ trades) -> the l3 chunk shape, so l2 gets the book, heatmap and fills l3 has.
// one synthetic order per price level: a new level is an A, a size change an M, a gone level a C.
// trades are T with order id 0, which removes nothing, the next snapshot fixes the level.
// R + the full first snapshot at the first snapshots time, so from there a chunk needs nothing before it

import type { L2Snapshot, OhlcvBar, TickEvent } from '../../interfaces/IDataAdapter';
import type { FootprintBar, FootprintOptions } from '../../lib/types/footprint';
import type { MboEvent, PriceHistory, SerialTrade } from '../../lib/types';
import { applyEvent, createBook, getBestAsk, getBestBid } from '../../lib/book';
import { BYTES_PER_EVENT, createCompactBuffer, getEvent, getTsNs } from '../../lib/compact-buffer';
import { processL3Chunk } from './l3-processor';

export interface L2DataChunk {
    kind: 'l2';
    compactBuf: ArrayBuffer;
    /** Empty when the feed sent no trades. */
    trades: SerialTrade[];
    priceHistory: PriceHistory[];
    /** From the trades, empty without them. */
    footprintBars: FootprintBar[];
    /** Candles off the mid price, volume 0. The bars to draw when the feed has no trades. */
    midBars: OhlcvBar[];
    /** Unix ms */
    dataStart: number;
    dataEnd: number;
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
    const events = l2Events(snapshots, ticks);
    if (events.length === 0)
        return {
            kind: 'l2',
            compactBuf: new ArrayBuffer(0),
            trades: [],
            priceHistory: [],
            footprintBars: [],
            midBars: [],
            dataStart: 0,
            dataEnd: 0,
        };
    const c = processL3Chunk(events, barNs, fpOptions);
    return {
        kind: 'l2',
        compactBuf: c.compactBuf,
        trades: c.trades,
        priceHistory: c.priceHistory,
        footprintBars: c.footprintBars,
        midBars: barNs > 0n ? midBars(c.compactBuf, barNs) : [],
        dataStart: c.dataStart,
        dataEnd: c.dataEnd,
    };
}

function l2Events(snapshots: L2Snapshot[], ticks: TickEvent[]): MboEvent[] {
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
        out.push({ ts_event: new Date(ms).toISOString(), action, side, price, size, order_id: id, sequence: out.length, flags: 0 });

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

// candles off the mid of the book `buf` replays to (vol 0)
// a side left emtpy skips that moment
export function midBars(buf: ArrayBuffer, barNs: bigint): OhlcvBar[] {
    const cb = createCompactBuffer(0);
    cb._buf = buf;
    cb._view = new DataView(buf);
    cb.length = cb.capacity = buf.byteLength / BYTES_PER_EVENT;
    const book = createBook();
    const out: OhlcvBar[] = [];
    for (let i = 0; i < cb.length; i++) {
        const ts = getTsNs(cb, i);
        applyEvent(book, getEvent(cb, i));
        // the book after everything at this ts
        if (i + 1 < cb.length && getTsNs(cb, i + 1) === ts) continue;
        const bid = getBestBid(book);
        const ask = getBestAsk(book);
        if (bid === null || ask === null) continue;
        const mid = (bid + ask) / 2;
        const time = Number((ts / barNs) * barNs / 1_000_000n);
        const bar = out.at(-1);
        if (bar && bar.time === time) {
            if (mid > bar.high) bar.high = mid;
            if (mid < bar.low) bar.low = mid;
            bar.close = mid;
        } else out.push({ time, open: mid, high: mid, low: mid, close: mid, volume: 0 });
    }
    return out;
}
