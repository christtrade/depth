// MboEvent[] -> compactBuf + trades + priceHistory + footprintBars.
//
// this is the path for adapters that hand back raw MboEvent[]. an adapter with
// its own optimised pipeline returns already-processed data and skips it.
//
// runs on the main thread, which is fine for streaming realtime or small
// historical chunks. anything over ~200k events wants a worker.

import { applyEvent, cloneBook, createBook, getBestAsk, getBestBid } from '../../lib/book';
import { buildFootprint, type FootprintBar, type FootprintOptions } from '../../lib/types/footprint';
import { isoToNs } from '../../lib/sampler';
import type { BookState, MboEvent, PriceHistory } from '../../lib/types';
import type { SerialTrade } from '../../lib/types';
import {
    BYTES_PER_EVENT,
    createCompactBuffer,
    encodeAt,
    findFloorIndex,
    getEvent,
    getTsNs,
    type CompactBuffer,
} from '../../lib/compact-buffer';

// 50ms, the price history downsample interval
const PRICE_HISTORY_INTERVAL_NS = 50_000_000n;

// Output shape
export interface ProcessedL3Chunk {
    kind: 'l3';
    compactBuf: ArrayBuffer;
    trades: SerialTrade[];
    priceHistory: PriceHistory[];
    footprintBars: FootprintBar[];
    /** ISO timestamp of the first event. */
    dataStart: number;
    /** ISO timestamp of the last event. */
    dataEnd: number;
    /** The book at `carry.snapAt`, when asked for it */
    bookAt?: BookState;
}

// ProcessedL3Chunk is the old name, kept around for compat
export type L3DataChunk = ProcessedL3Chunk;

function encodeEvents(events: MboEvent[], tsCache: BigInt64Array): ArrayBuffer {
    const buf = new ArrayBuffer(events.length * BYTES_PER_EVENT);
    const view = new DataView(buf);
    for (let i = 0; i < events.length; i++) encodeAt(view, i, tsCache[i], events[i]);
    return buf;
}

// Public API
/**
 * Process a batch of L3 MboEvents into the internal representation
 *
 * @param events    Raw mbo events, sorted ascending by ts_event.
 * @param barNs     Bar size in ns for the footprint. Pass 0n to skip it.
 * @param fpOptions Forwarded to buildFootprint().
 * @param carry     `book`: the book before `events`, so a chunk that follows another
 *                  doesnt start empty but mutates instead. `snapAt`: give back a copy of the book
 *                  just before the first event at or after this ns, as `bookAt`
 */
export function processL3Chunk(
    events: MboEvent[],
    barNs: bigint,
    fpOptions: FootprintOptions = {},
    carry: { book?: BookState; snapAt?: bigint } = {},
): ProcessedL3Chunk {
    if (events.length === 0) {
        return {
            kind: 'l3',
            compactBuf: new ArrayBuffer(0),
            trades: [],
            priceHistory: [],
            footprintBars: [],
            dataStart: 0,
            dataEnd: 0,
        };
    }

    const trades: SerialTrade[] = [];
    const priceHistory: PriceHistory[] = [];
    const book = carry.book ?? createBook();
    let bookAt: BookState | undefined;

    // pre-cache the timestamps, isoToNs in the hot loop is expensive
    const tsCache = new BigInt64Array(events.length);
    for (let i = 0; i < events.length; i++) {
        tsCache[i] = isoToNs(events[i].ts_event);
    }

    let lastAsk: number | null = carry.book ? getBestAsk(book) : null;
    let lastBid: number | null = carry.book ? getBestBid(book) : null;
    let lastPriceHistoryTs = 0n;

    for (let i = 0; i < events.length; i++) {
        const event = events[i];
        const ts = tsCache[i];

        if (bookAt === undefined && carry.snapAt !== undefined && ts >= carry.snapAt) {
            bookAt = cloneBook(book);
        }
        applyEvent(book, event);

        const currentAsk = getBestAsk(book);
        const currentBid = getBestBid(book);

        if (currentAsk !== lastAsk || currentBid !== lastBid) {
            if (
                ts - lastPriceHistoryTs >= PRICE_HISTORY_INTERVAL_NS ||
                lastPriceHistoryTs === 0n
            ) {
                priceHistory.push({ ts, bestAsk: currentAsk ?? 0, bestBid: currentBid ?? 0 });
                lastPriceHistoryTs = ts;
            } else {
                // overwrite the last entry in the bucket, so each 50ms window
                // keeps the most recent BBO
                const last = priceHistory[priceHistory.length - 1];
                if (last) {
                    last.bestAsk = currentAsk ?? 0;
                    last.bestBid = currentBid ?? 0;
                }
            }
            lastAsk = currentAsk;
            lastBid = currentBid;
        }

        if (event.action === 'T' && event.side !== 'N' && event.price !== null) {
            trades.push({
                ts,
                price: event.price,
                size: event.size,
                side: event.side as 'B' | 'A',
            });
        }
    }

    const footprintBars = barNs > 0n ? buildFootprint(events, barNs, fpOptions) : [];

    return {
        kind: 'l3',
        compactBuf: encodeEvents(events, tsCache),
        trades,
        priceHistory,
        footprintBars,
        dataStart: new Date(events[0].ts_event).getTime(),
        dataEnd: new Date(events[events.length - 1].ts_event).getTime(),
        ...(carry.snapAt !== undefined && { bookAt: bookAt ?? cloneBook(book) }),
    };
}

function wrap(buf: ArrayBuffer): CompactBuffer {
    const cb = createCompactBuffer(0);
    cb._buf = buf;
    cb._view = new DataView(buf);
    cb.length = cb.capacity = buf.byteLength / BYTES_PER_EVENT;
    return cb;
}

export function bookAfter(buf: ArrayBuffer): BookState {
    const cb = wrap(buf);
    const book = createBook();
    for (let i = 0; i < cb.length; i++) applyEvent(book, getEvent(cb, i));
    return book;
}

export function eventsBetween(buf: ArrayBuffer, fromNs: bigint | null, toNs: bigint | null): ArrayBuffer {
    const cb = wrap(buf);
    const lo = fromNs === null ? 0 : findFloorIndex(cb, fromNs - 1n) + 1;
    const hi = toNs === null ? cb.length : findFloorIndex(cb, toNs - 1n) + 1;
    return buf.slice(lo * BYTES_PER_EVENT, hi * BYTES_PER_EVENT);
}

// bid/ask of `buf` again with `book` carried in
export function carryBookInto(
    book: BookState,
    buf: ArrayBuffer,
    held: PriceHistory[],
    before: PriceHistory | undefined,
): PriceHistory[] {
    const carried = new Set([...book.bids.keys(), ...book.asks.keys()]);
    if (carried.size === 0) return held;
    const cb = wrap(buf);
    const out: PriceHistory[] = [];
    let last = before;
    let lastTs = before?.ts ?? 0n;
    let lastAsk = getBestAsk(book);
    let lastBid = getBestBid(book);
    let j = 0;

    for (let i = 0; i < cb.length; i++) {
        const ts = getTsNs(cb, i);
        const e = getEvent(cb, i);
        applyEvent(book, e);
        if (e.action === 'R') carried.clear();
        else if (e.action === 'A' || !(book.bids.has(e.order_id) || book.asks.has(e.order_id)))
            carried.delete(e.order_id);

        const ask = getBestAsk(book);
        const bid = getBestBid(book);
        if (ask !== lastAsk || bid !== lastBid) {
            if (ts - lastTs >= PRICE_HISTORY_INTERVAL_NS || lastTs === 0n) {
                last = { ts, bestAsk: ask ?? 0, bestBid: bid ?? 0 };
                out.push(last);
                lastTs = ts;
            } else if (last) {
                last.bestAsk = ask ?? 0;
                last.bestBid = bid ?? 0;
            }
            lastAsk = ask;
            lastBid = bid;
        }

        // same book and same sampling phase
        // so the rest of `held` is what this would give
        if (carried.size > 0) continue;
        while (j < held.length && held[j].ts <= ts) j++;

        const heldTs = j > 0 ? held[j - 1].ts : 0n;
        if (heldTs !== lastTs) continue;
        if (out.length === 0) return held.slice(j > 0 ? j - 1 : 0);

        return out.slice(0, -1).concat(held.slice(j - 1));
    }
    return out;
}

/** Merge two chunks in order, earlier one first. */
export function mergeL3Chunks(a: ProcessedL3Chunk, b: ProcessedL3Chunk): ProcessedL3Chunk {
    const totalBytes = a.compactBuf.byteLength + b.compactBuf.byteLength;
    const merged = new Uint8Array(totalBytes);
    merged.set(new Uint8Array(a.compactBuf), 0);
    merged.set(new Uint8Array(b.compactBuf), a.compactBuf.byteLength);

    return {
        kind: 'l3',
        compactBuf: merged.buffer,
        trades: a.trades.concat(b.trades),
        priceHistory: a.priceHistory.concat(b.priceHistory),
        footprintBars: a.footprintBars.concat(b.footprintBars),
        dataStart: a.dataStart > 0 ? a.dataStart : b.dataStart,
        dataEnd: b.dataEnd > 0 ? b.dataEnd : a.dataEnd,
    };
}
