/**
 * A flat typed-array store for MBO events, in place of an MboEvent[]. Rather
 * than a heap object per event at 150-200 bytes each, every event packs into 20
 * bytes:
 *
 *   [0..7]   ts_ns        BigInt64, absolute nanoseconds
 *   [8..11]  pricex100    Int32, null becomes the INT32_MIN sentinel
 *   [12..15] size         Uint32
 *   [16..18] order_id     Uint24, little-endian
 *   [19]     packed       bits 7-4 action, bits 3-2 side, bits 1-0 spare
 *
 * At 30M events that's about 600MB instead of ~5GB.
 *   findFloorIndex()       - binary search by nanosecond timestamp
 */

import type { MboEvent } from './types';

// Constants
const BYTES_PER_EVENT = 20;
const INT32_MIN = -2_147_483_648; // sentinel for null price
const PRICE_SCALE = 100; // store price x 100 as int32

// Maps must stay in the same order as buffer.ts ACTION_NAMES / SIDE_NAMES.
const ACTION_ENCODE: Record<string, number> = { A: 0, C: 1, M: 2, T: 3, F: 4, R: 5 };
const SIDE_ENCODE: Record<string, number> = { B: 0, A: 1, N: 2 };
const ACTION_DECODE = ['A', 'C', 'M', 'T', 'F', 'R'] as const;
const SIDE_DECODE = ['B', 'A', 'N'] as const;

// Types
export interface CompactBuffer {
    /** Raw backing storage. Do not read directly - use the accessor functions. */
    _buf: ArrayBuffer;
    /** DataView over _buf. */
    _view: DataView;
    /** Number of events currently stored. */
    length: number;
    /** Capacity in events (buf.byteLength / BYTES_PER_EVENT). */
    capacity: number;
    /** Absolute ns timestamp of the first stored event (or 0n if empty). */
    firstTs: bigint;
    /** Absolute ns timestamp of the last stored event (or 0n if empty). */
    lastTs: bigint;
}

// Factory
const INITIAL_CAPACITY = 1_000_000; // 1 M events = 20 MB upfront

export function createCompactBuffer(initialCapacity = INITIAL_CAPACITY): CompactBuffer {
    const buf = new ArrayBuffer(initialCapacity * BYTES_PER_EVENT);
    return {
        _buf: buf,
        _view: new DataView(buf),
        length: 0,
        capacity: initialCapacity,
        firstTs: 0n,
        lastTs: 0n,
    };
}

// Growth
function grow(cb: CompactBuffer, needed: number): void {
    const newCap = Math.max(cb.capacity * 2, cb.capacity + needed);
    const newBuf = new ArrayBuffer(newCap * BYTES_PER_EVENT);
    new Uint8Array(newBuf).set(new Uint8Array(cb._buf, 0, cb.length * BYTES_PER_EVENT));
    cb._buf = newBuf;
    cb._view = new DataView(newBuf);
    cb.capacity = newCap;
}

// Encode one event into the buffer at position `idx`
function encodeAt(view: DataView, idx: number, tsNs: bigint, event: MboEvent): void {
    const base = idx * BYTES_PER_EVENT;

    // [0..7] timestamp (BigInt64, little-endian)
    view.setBigInt64(base, tsNs, true);

    // [8..11] price x 100 as Int32 (INT32_MIN = null)
    const priceInt = event.price === null ? INT32_MIN : Math.round(event.price * PRICE_SCALE);
    view.setInt32(base + 8, priceInt, true);

    // [12..15] size as Uint32
    view.setUint32(base + 12, event.size >>> 0, true);

    // [16..18] order_id lower 24 bits (most IDs in your data fit in 3 bytes)
    const oid = parseInt(event.order_id, 10) & 0xff_ffff;
    view.setUint8(base + 16, oid & 0xff);
    view.setUint8(base + 17, (oid >> 8) & 0xff);
    view.setUint8(base + 18, (oid >> 16) & 0xff);

    // [19] packed: high nibble = action, next 2 bits = side
    const actionIdx = ACTION_ENCODE[event.action] ?? 0;
    const sideIdx = SIDE_ENCODE[event.side] ?? 2;
    view.setUint8(base + 19, ((actionIdx & 0xf) << 4) | ((sideIdx & 0x3) << 2));
}

// Append a batch of MboEvents
/**
 * Append an array of MboEvents to the buffer.
 * Events must already be sorted ascending by ts_event (they come from fetchChunk
 * in order, so this is always true).
 *
 * `isoToNs` is passed in to avoid a circular import - use the one from sampler.ts.
 */
export function appendEvents(
    cb: CompactBuffer,
    events: MboEvent[],
    isoToNs: (iso: string) => bigint,
): void {
    if (events.length === 0) return;

    const needed = cb.length + events.length;
    if (needed > cb.capacity) grow(cb, events.length);

    const view = cb._view;
    let writeIdx = cb.length;

    for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        const ts = isoToNs(ev.ts_event);
        encodeAt(view, writeIdx++, ts, ev);
    }

    cb.length = needed;

    // Update extent timestamps
    if (cb.firstTs === 0n) {
        cb.firstTs = isoToNs(events[0].ts_event);
    }
    cb.lastTs = isoToNs(events[events.length - 1].ts_event);
}

// Random-access decode
// A pre-allocated scratch object so callers that just need a quick read
// don't trigger GC. NOT safe to keep references across calls.
const SCRATCH: MboEvent = {
    ts_event: '',
    action: 'A',
    side: 'N',
    price: null,
    size: 0,
    order_id: '0',
    sequence: 0,
    flags: 0,
};

/**
 * Decode event at index `idx` into a scratch object.
 * The returned reference is reused on the next call - copy fields if you need
 * to store the result.
 */
export function getEvent(cb: CompactBuffer, idx: number): Readonly<MboEvent> {
    const base = idx * BYTES_PER_EVENT;
    const view = cb._view;

    const tsNs = view.getBigInt64(base, true);
    const priceI = view.getInt32(base + 8, true);
    const size = view.getUint32(base + 12, true);
    const oidB0 = view.getUint8(base + 16);
    const oidB1 = view.getUint8(base + 17);
    const oidB2 = view.getUint8(base + 18);
    const packed = view.getUint8(base + 19);

    SCRATCH.action = ACTION_DECODE[(packed >> 4) & 0xf] ?? 'A';
    SCRATCH.side = SIDE_DECODE[(packed >> 2) & 0x3] ?? 'N';
    SCRATCH.price = priceI === INT32_MIN ? null : priceI / PRICE_SCALE;
    SCRATCH.size = size;
    SCRATCH.order_id = String(oidB0 | (oidB1 << 8) | (oidB2 << 16));
    SCRATCH.ts_event = nsToIso(tsNs);
    SCRATCH.sequence = idx;
    SCRATCH.flags = 0;

    return SCRATCH;
}

/**
 * Read just the nanosecond timestamp of event at index `idx`.
 * Faster than getEvent() when you only need the time (e.g., binary search).
 */
export function getTsNs(cb: CompactBuffer, idx: number): bigint {
    return cb._view.getBigInt64(idx * BYTES_PER_EVENT, true);
}

// Binary search
/**
 * Returns the index of the last event with ts <= `targetNs`, or -1 if none.
 * Equivalent to the existing binary-search pattern in chart.tsx.
 */
export function findFloorIndex(cb: CompactBuffer, targetNs: bigint): number {
    if (cb.length === 0) return -1;
    let lo = 0,
        hi = cb.length - 1,
        result = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (getTsNs(cb, mid) <= targetNs) {
            result = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return result;
}

// Front trim
/**
 * Remove the first `count` events from the buffer.
 * This does a single memmove - O(N) but infrequent (only called on hour boundary).
 */
export function trimFront(cb: CompactBuffer, count: number): void {
    if (count <= 0 || count > cb.length) return;

    const keepCount = cb.length - count;
    const keepBytes = keepCount * BYTES_PER_EVENT;
    const srcOffset = count * BYTES_PER_EVENT;

    // Move remaining bytes to front
    const u8 = new Uint8Array(cb._buf);
    u8.copyWithin(0, srcOffset, srcOffset + keepBytes);

    cb.length = keepCount;
    cb.firstTs = keepCount > 0 ? getTsNs(cb, 0) : 0n;
    // lastTs stays unchanged
}

// Slice to MboEvent[]
/**
 * Decode a range [start, end) of the buffer back to MboEvent[].
 * Used when workers need the full event objects (heatmap worker init,
 * footprint rebuild on TF change, etc).
 * Keep calls infrequent - this allocates one object per event.
 */
export function sliceToMboEvents(cb: CompactBuffer, start: number, end: number): MboEvent[] {
    const from = Math.max(0, start);
    const to = Math.min(cb.length, end);
    const out: MboEvent[] = new Array(to - from);

    for (let i = from; i < to; i++) {
        const ev = getEvent(cb, i);
        out[i - from] = {
            ts_event: ev.ts_event,
            action: ev.action,
            side: ev.side,
            price: ev.price,
            size: ev.size,
            order_id: ev.order_id,
            sequence: ev.sequence,
            flags: ev.flags,
        };
    }
    return out;
}

// Helpers
/** Mirrors the nsToIso function in buffer.ts */
function nsToIso(ns: bigint): string {
    const ms = Number(ns / 1_000_000n);
    const subMs = Number(ns % 1_000_000n);
    return new Date(ms).toISOString().slice(0, -1) + String(subMs).padStart(6, '0') + 'Z';
}