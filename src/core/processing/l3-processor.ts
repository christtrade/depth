// MboEvent[] -> compactBuf + trades + priceHistory + footprintBars.
//
// this is the path for adapters that hand back raw MboEvent[]. an adapter with
// its own optimised pipeline returns already-processed data and skips it.
//
// runs on the main thread, which is fine for streaming realtime or small
// historical chunks. anything over ~200k events wants a worker.

import { applyEvent, createBook, getBestAsk, getBestBid } from '../../lib/book';
import { buildFootprint, type FootprintBar, type FootprintOptions } from '../../lib/types/footprint';
import { isoToNs } from '../../lib/sampler';
import type { MboEvent, PriceHistory } from '../../lib/types';
import type { SerialTrade } from '../../lib/types';

// these have to stay in sync with compact-buffer.ts
const BYTES_PER_EVENT = 20;
const INT32_MIN = -2_147_483_648;
const PRICE_SCALE = 100;
const ACTION_ENCODE: Record<string, number> = { A: 0, C: 1, M: 2, T: 3, F: 4, R: 5 };
const SIDE_ENCODE: Record<string, number> = { B: 0, A: 1, N: 2 };

// 50ms, the price history downsample interval
const PRICE_HISTORY_INTERVAL_NS = 50_000_000n;

// Output shape
export interface ProcessedL3Chunk {
    kind: 'l3';
    /** 20-byte compact encoding of all MBO events. L3-only. */
    compactBuf: ArrayBuffer;
    trades: SerialTrade[];
    priceHistory: PriceHistory[];
    footprintBars: FootprintBar[];
    /** ISO timestamp of the first event. */
    dataStart: number;
    /** ISO timestamp of the last event. */
    dataEnd: number;
}

// ProcessedL3Chunk is the old name, kept around for compat
export type L3DataChunk = ProcessedL3Chunk;

// Encoder
function encodeEvents(events: MboEvent[], tsCache: BigInt64Array): ArrayBuffer {
    const buf = new ArrayBuffer(events.length * BYTES_PER_EVENT);
    const view = new DataView(buf);

    for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        const base = i * BYTES_PER_EVENT;

        view.setBigInt64(base, tsCache[i], true);

        const priceInt =
            ev.price === null ? INT32_MIN : Math.round(ev.price * PRICE_SCALE);
        view.setInt32(base + 8, priceInt, true);
        view.setUint32(base + 12, ev.size >>> 0, true);

        const oid = parseInt(ev.order_id, 10) & 0xff_ffff;
        view.setUint8(base + 16, oid & 0xff);
        view.setUint8(base + 17, (oid >> 8) & 0xff);
        view.setUint8(base + 18, (oid >> 16) & 0xff);

        const actionIdx = ACTION_ENCODE[ev.action] ?? 0;
        const sideIdx = SIDE_ENCODE[ev.side] ?? 2;
        view.setUint8(base + 19, ((actionIdx & 0xf) << 4) | ((sideIdx & 0x3) << 2));
    }

    return buf;
}

// Public API
/**
 * Process a batch of L3 MboEvents into the internal representation.
 *
 * @param events    Raw MBO events, sorted ascending by ts_event.
 * @param barNs     Bar size in ns for the footprint. Pass 0n to skip it.
 * @param fpOptions Forwarded to buildFootprint().
 */
export function processL3Chunk(
    events: MboEvent[],
    barNs: bigint,
    fpOptions: FootprintOptions = {},
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
    const book = createBook();

    // pre-cache the timestamps, isoToNs in the hot loop is expensive
    const tsCache = new BigInt64Array(events.length);
    for (let i = 0; i < events.length; i++) {
        tsCache[i] = isoToNs(events[i].ts_event);
    }

    let lastAsk: number | null = null;
    let lastBid: number | null = null;
    let lastPriceHistoryTs = 0n;

    for (let i = 0; i < events.length; i++) {
        const event = events[i];
        const ts = tsCache[i];

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
    };
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