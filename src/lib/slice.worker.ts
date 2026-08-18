/**
 * slice.worker.ts
 *
 * Message types:
 *
 *  1. 'slice'          - decode a range of a CompactBuffer to MboEvent[]
 *
 *  2. 'prepend-merge'  - full prepend hot path off-thread:
 *       merge compact chunk, trades, priceHistory + bucket, OHLCV cache
 *
 *  3. 'load-ingest'    - NEW: everything ingestLoadedData used to do on the
 *       main thread after receiving data:
 *         - rebuild the candleCache cache from trades
 *         - bucket priceHistory
 *       Returns typed-array buffers the main thread just assigns to refs.
 *
 *  4. 'append-ingest'  - NEW: everything ingestAppendedData used to do on the
 *       main thread:
 *         - compact buffer grow + memcopy
 *         - allTrades / allPriceHistory concat + trim
 *         - candleCache cache update + trim
 *       Returns typed-array buffers the main thread just assigns to refs.
 *
 * All ArrayBuffers are transferred (zero-copy) in both directions.
 */

import { sliceToMboEvents, type CompactBuffer } from '../lib/compact-buffer';

const BYTES = 20; // compact buffer bytes per event

// Serialization strides
const TRADE_STRIDE = 6; // [ts_hi, ts_lo, price, size, side(0=B/1=A), _pad]
const PH_STRIDE = 4; // [ts_hi, ts_lo, bestBid, bestAsk]
const OHLCV_STRIDE = 8; // [key_hi, key_lo, open, high, low, close, volume, delta]

// Message type declarations
export interface SliceRequest {
    kind: 'slice';
    id: string;
    buf: ArrayBuffer;
    length: number;
    capacity: number;
    start: number;
    end: number;
    messageType: 'init' | 'append' | 'prepend';
}

export interface PrependMergeRequest {
    kind: 'prepend-merge';
    id: string;
    existingBuf: ArrayBuffer;
    existingLength: number;
    existingCapacity: number;
    incomingBuf: ArrayBuffer;
    existingTradesBuf: ArrayBuffer;
    newTradesBuf: ArrayBuffer;
    existingPhBuf: ArrayBuffer;
    newPhBuf: ArrayBuffer;
    existingOhlcvBuf: ArrayBuffer;
    barNsHi: number;
    barNsLo: number;
}

/**
 * 'load-ingest' - off-thread heavy work from ingestLoadedData.
 * The data worker already built the compact buffer; we just need to
 * rebuild candleCache and bucket priceHistory.
 */
export interface LoadIngestRequest {
    kind: 'load-ingest';
    id: string;
    /** Serialised trades (TRADE_STRIDE Float64s per trade) */
    tradesBuf: ArrayBuffer;
    /** Serialised priceHistory (PH_STRIDE Float64s per point) */
    phBuf: ArrayBuffer;
    barNsHi: number;
    barNsLo: number;
}

export interface LoadIngestResponse {
    kind: 'load-ingest';
    id: string;
    ohlcvBuf: ArrayBuffer;
    bucketedPhBuf: ArrayBuffer;
    /** Returned so main thread can reattach without re-serialising */
    tradesBuf: ArrayBuffer;
    phBuf: ArrayBuffer;
}

/**
 * 'append-ingest' - off-thread heavy work from ingestAppendedData.
 */
export interface AppendIngestRequest {
    kind: 'append-ingest';
    id: string;
    existingBuf: ArrayBuffer;
    existingLength: number;
    existingCapacity: number;
    incomingBuf: ArrayBuffer;
    existingTradesBuf: ArrayBuffer;
    newTradesBuf: ArrayBuffer;
    existingPhBuf: ArrayBuffer;
    newPhBuf: ArrayBuffer;
    existingOhlcvBuf: ArrayBuffer;
    /** Trim everything older than this ns. 0 = no trim. */
    trimBeforeNsHi: number;
    trimBeforeNsLo: number;
    barNsHi: number;
    barNsLo: number;
    dataEndNsHi: number;
    dataEndNsLo: number;
}

export interface AppendIngestResponse {
    kind: 'append-ingest';
    id: string;
    mergedBuf: ArrayBuffer;
    mergedLength: number;
    mergedCapacity: number;
    mergedTradesBuf: ArrayBuffer;
    mergedPhBuf: ArrayBuffer;
    mergedOhlcvBuf: ArrayBuffer;
    appendedCount: number;
    /** Events trimmed from the compact buffer front (caller adjusts playheadIdx). */
    compactCutCount: number;
    /** Trades trimmed from front. */
    tradeCutCount: number;
    /** PriceHistory points trimmed from front. */
    phCutCount: number;
    newFirstTsHi: number;
    newFirstTsLo: number;
    newLastTsHi: number;
    newLastTsLo: number;
}

export type SliceWorkerRequest =
    | SliceRequest
    | PrependMergeRequest
    | LoadIngestRequest
    | AppendIngestRequest;

export interface SliceResponse {
    kind: 'slice';
    id: string;
    messageType: 'init' | 'append' | 'prepend';
    events: ReturnType<typeof sliceToMboEvents>;
    buf: ArrayBuffer;
}

export interface PrependMergeResponse {
    kind: 'prepend-merge';
    id: string;
    mergedBuf: ArrayBuffer;
    mergedLength: number;
    mergedCapacity: number;
    mergedTradesBuf: ArrayBuffer;
    mergedPhBuf: ArrayBuffer;
    bucketedPhBuf: ArrayBuffer;
    mergedOhlcvBuf: ArrayBuffer;
    prependedCount: number;
}

// Bigint helpers
function toBigInt(hi: number, lo: number): bigint {
    return (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
}
function bigintHi(n: bigint): number {
    return Number(n >> 32n);
}
function bigintLo(n: bigint): number {
    return Number(n & 0xffffffffn);
}

// Compact buffer ts accessor
function getTsNs(view: DataView, idx: number): bigint {
    return view.getBigInt64(idx * BYTES, true);
}

// Slice handler
function handleSlice(req: SliceRequest): [SliceResponse, Transferable[]] {
    const cb: CompactBuffer = {
        _buf: req.buf,
        _view: new DataView(req.buf),
        length: req.length,
        capacity: req.capacity,
        firstTs: 0n,
        lastTs: 0n,
    };
    const events = sliceToMboEvents(cb, req.start, req.end);
    return [
        { kind: 'slice', id: req.id, messageType: req.messageType, events, buf: cb._buf },
        [cb._buf],
    ];
}

// PrependMerge handler
function handlePrependMerge(req: PrependMergeRequest): [PrependMergeResponse, Transferable[]] {
    const prependedCount = req.incomingBuf.byteLength / BYTES;
    const needed = req.existingLength + prependedCount;
    const barNs = toBigInt(req.barNsHi, req.barNsLo);

    // 1. Compact buffer merge
    let mergedBuf: ArrayBuffer;
    let mergedCapacity: number;
    if (needed > req.existingCapacity) {
        mergedCapacity = Math.max(req.existingCapacity * 2, needed);
        mergedBuf = new ArrayBuffer(mergedCapacity * BYTES);
        new Uint8Array(mergedBuf, prependedCount * BYTES).set(
            new Uint8Array(req.existingBuf, 0, req.existingLength * BYTES),
        );
    } else {
        mergedBuf = req.existingBuf;
        mergedCapacity = req.existingCapacity;
        new Uint8Array(mergedBuf).copyWithin(prependedCount * BYTES, 0, req.existingLength * BYTES);
    }
    new Uint8Array(mergedBuf, 0).set(new Uint8Array(req.incomingBuf));

    // 2. Trades merge
    const newT = new Float64Array(req.newTradesBuf);
    const oldT = new Float64Array(req.existingTradesBuf);
    const mergedTrades = new Float64Array(newT.length + oldT.length);
    mergedTrades.set(newT, 0);
    mergedTrades.set(oldT, newT.length);

    // 3. PriceHistory merge
    const newPh = new Float64Array(req.newPhBuf);
    const oldPh = new Float64Array(req.existingPhBuf);
    const mergedPh = new Float64Array(newPh.length + oldPh.length);
    mergedPh.set(newPh, 0);
    mergedPh.set(oldPh, newPh.length);

    // 4. Bucket priceHistory
    const bucketedBuf = bucketPhBuf(mergedPh, barNs);

    // 5. OHLCV prepend
    const ohlcvMap = buildOhlcvMapFromBuf(newT, barNs);
    const existingOhlcv = new Float64Array(req.existingOhlcvBuf);
    const ec = existingOhlcv.length / OHLCV_STRIDE;
    for (let i = 0; i < ec; i++) {
        const k = toBigInt(existingOhlcv[i * OHLCV_STRIDE], existingOhlcv[i * OHLCV_STRIDE + 1]);
        if (!ohlcvMap.has(k)) {
            ohlcvMap.set(k, {
                open: existingOhlcv[i * OHLCV_STRIDE + 2],
                high: existingOhlcv[i * OHLCV_STRIDE + 3],
                low: existingOhlcv[i * OHLCV_STRIDE + 4],
                close: existingOhlcv[i * OHLCV_STRIDE + 5],
                volume: existingOhlcv[i * OHLCV_STRIDE + 6],
                delta: existingOhlcv[i * OHLCV_STRIDE + 7],
            });
        }
    }
    const mergedOhlcvBuf = serializeOhlcvMap(ohlcvMap);

    const resp: PrependMergeResponse = {
        kind: 'prepend-merge',
        id: req.id,
        mergedBuf,
        mergedLength: needed,
        mergedCapacity,
        mergedTradesBuf: mergedTrades.buffer,
        mergedPhBuf: mergedPh.buffer,
        bucketedPhBuf: bucketedBuf,
        mergedOhlcvBuf,
        prependedCount,
    };
    const transfers: Transferable[] = [
        mergedBuf,
        mergedTrades.buffer,
        mergedPh.buffer,
        bucketedBuf,
        mergedOhlcvBuf,
    ];
    if (req.existingBuf !== mergedBuf) transfers.push(req.existingBuf);
    return [resp, transfers];
}

// LoadIngest handler
function handleLoadIngest(req: LoadIngestRequest): [LoadIngestResponse, Transferable[]] {
    const barNs = toBigInt(req.barNsHi, req.barNsLo);
    const trades = new Float64Array(req.tradesBuf);
    const ph = new Float64Array(req.phBuf);

    const ohlcvMap = buildOhlcvMapFromBuf(trades, barNs);
    const ohlcvBuf = serializeOhlcvMap(ohlcvMap);
    const bucketedPhBuf = bucketPhBuf(ph, barNs);

    const resp: LoadIngestResponse = {
        kind: 'load-ingest',
        id: req.id,
        ohlcvBuf,
        bucketedPhBuf,
        tradesBuf: req.tradesBuf,
        phBuf: req.phBuf,
    };
    return [resp, [ohlcvBuf, bucketedPhBuf, req.tradesBuf, req.phBuf]];
}

// AppendIngest handler
function handleAppendIngest(req: AppendIngestRequest): [AppendIngestResponse, Transferable[]] {
    const barNs = toBigInt(req.barNsHi, req.barNsLo);
    const trimBefore = toBigInt(req.trimBeforeNsHi, req.trimBeforeNsLo);
    const doTrim = trimBefore > 0n;
    const dataEndNs = toBigInt(req.dataEndNsHi, req.dataEndNsLo);

    // 1. Compact buffer grow + append
    const appendedCount = req.incomingBuf.byteLength / BYTES;
    const needed = req.existingLength + appendedCount;
    let mergedBuf: ArrayBuffer;
    let mergedCapacity: number;

    if (needed > req.existingCapacity) {
        mergedCapacity = Math.max(req.existingCapacity * 2, needed);
        mergedBuf = new ArrayBuffer(mergedCapacity * BYTES);
        new Uint8Array(mergedBuf).set(
            new Uint8Array(req.existingBuf, 0, req.existingLength * BYTES),
        );
    } else {
        mergedBuf = req.existingBuf;
        mergedCapacity = req.existingCapacity;
    }
    new Uint8Array(mergedBuf, req.existingLength * BYTES).set(new Uint8Array(req.incomingBuf));
    let mergedLength = needed;

    const view = new DataView(mergedBuf);
    let newFirstTs = mergedLength > 0 ? getTsNs(view, 0) : 0n;

    // 2. Trim compact buffer front
    let compactCutCount = 0;
    if (doTrim && mergedLength > 0 && newFirstTs < trimBefore) {
        let lo = 0,
            hi = mergedLength - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            if (getTsNs(view, mid) < trimBefore) {
                compactCutCount = mid + 1;
                lo = mid + 1;
            } else hi = mid - 1;
        }
        if (compactCutCount > 0) {
            const keepBytes = (mergedLength - compactCutCount) * BYTES;
            const srcOff = compactCutCount * BYTES;
            new Uint8Array(mergedBuf).copyWithin(0, srcOff, srcOff + keepBytes);
            mergedLength -= compactCutCount;
            newFirstTs = mergedLength > 0 ? getTsNs(view, 0) : 0n;
        }
    }

    // 3. Trades concat + trim
    const oldT = new Float64Array(req.existingTradesBuf);
    const newT = new Float64Array(req.newTradesBuf);
    const concatT = new Float64Array(oldT.length + newT.length);
    concatT.set(oldT, 0);
    concatT.set(newT, oldT.length);

    let tradeCutCount = 0;
    let mergedTradesBuf: ArrayBuffer;
    if (doTrim && concatT.length > 0) {
        const tc = concatT.length / TRADE_STRIDE;
        let lo = 0,
            hi = tc - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            const ts = toBigInt(concatT[mid * TRADE_STRIDE], concatT[mid * TRADE_STRIDE + 1]);
            if (ts < trimBefore) {
                tradeCutCount = mid + 1;
                lo = mid + 1;
            } else hi = mid - 1;
        }
        mergedTradesBuf =
            tradeCutCount > 0 ? concatT.slice(tradeCutCount * TRADE_STRIDE).buffer : concatT.buffer;
    } else {
        mergedTradesBuf = concatT.buffer;
    }

    // 4. PriceHistory concat + trim
    const oldPh = new Float64Array(req.existingPhBuf);
    const newPh = new Float64Array(req.newPhBuf);
    const concatPh = new Float64Array(oldPh.length + newPh.length);
    concatPh.set(oldPh, 0);
    concatPh.set(newPh, oldPh.length);

    let phCutCount = 0;
    let mergedPhBuf: ArrayBuffer;
    if (doTrim && concatPh.length > 0) {
        const pc = concatPh.length / PH_STRIDE;
        let lo = 0,
            hi = pc - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            const ts = toBigInt(concatPh[mid * PH_STRIDE], concatPh[mid * PH_STRIDE + 1]);
            if (ts < trimBefore) {
                phCutCount = mid + 1;
                lo = mid + 1;
            } else hi = mid - 1;
        }
        mergedPhBuf =
            phCutCount > 0 ? concatPh.slice(phCutCount * PH_STRIDE).buffer : concatPh.buffer;
    } else {
        mergedPhBuf = concatPh.buffer;
    }

    // 5. BarOhlcv cache update + trim
    const existingOhlcv = new Float64Array(req.existingOhlcvBuf);
    const ohlcvMap = new Map<
        bigint,
        {
            open: number;
            high: number;
            low: number;
            close: number;
            volume: number;
            delta: number;
        }
    >();

    // Load existing, skipping stale buckets
    const oc = existingOhlcv.length / OHLCV_STRIDE;
    for (let i = 0; i < oc; i++) {
        const k = toBigInt(existingOhlcv[i * OHLCV_STRIDE], existingOhlcv[i * OHLCV_STRIDE + 1]);
        if (doTrim && k < trimBefore) continue;
        ohlcvMap.set(k, {
            open: existingOhlcv[i * OHLCV_STRIDE + 2],
            high: existingOhlcv[i * OHLCV_STRIDE + 3],
            low: existingOhlcv[i * OHLCV_STRIDE + 4],
            close: existingOhlcv[i * OHLCV_STRIDE + 5],
            volume: existingOhlcv[i * OHLCV_STRIDE + 6],
            delta: existingOhlcv[i * OHLCV_STRIDE + 7],
        });
    }
    // Append new trades
    if (barNs > 0n) {
        const tc = newT.length / TRADE_STRIDE;
        for (let i = 0; i < tc; i++) {
            const ts = toBigInt(newT[i * TRADE_STRIDE], newT[i * TRADE_STRIDE + 1]);
            const k = (ts / barNs) * barNs;
            const price = newT[i * TRADE_STRIDE + 2];
            const size = newT[i * TRADE_STRIDE + 3];
            const isBuy = newT[i * TRADE_STRIDE + 4] === 0;
            const b = ohlcvMap.get(k);
            if (!b) {
                ohlcvMap.set(k, {
                    open: price,
                    high: price,
                    low: price,
                    close: price,
                    volume: size,
                    delta: isBuy ? size : -size,
                });
            } else {
                if (price > b.high) b.high = price;
                if (price < b.low) b.low = price;
                b.close = price;
                b.volume += size;
                b.delta += isBuy ? size : -size;
            }
        }
    }
    const mergedOhlcvBuf = serializeOhlcvMap(ohlcvMap);

    const resp: AppendIngestResponse = {
        kind: 'append-ingest',
        id: req.id,
        mergedBuf,
        mergedLength,
        mergedCapacity,
        mergedTradesBuf,
        mergedPhBuf,
        mergedOhlcvBuf,
        appendedCount,
        compactCutCount,
        tradeCutCount,
        phCutCount,
        newFirstTsHi: bigintHi(newFirstTs),
        newFirstTsLo: bigintLo(newFirstTs),
        newLastTsHi: bigintHi(dataEndNs),
        newLastTsLo: bigintLo(dataEndNs),
    };

    const transfers: Transferable[] = [mergedBuf, mergedTradesBuf, mergedPhBuf, mergedOhlcvBuf];
    if (req.existingBuf !== mergedBuf) transfers.push(req.existingBuf);
    transfers.push(req.incomingBuf);
    // Safe to transfer the concat buffers only if they weren't already sliced+reused
    if (concatT.buffer !== mergedTradesBuf) transfers.push(concatT.buffer);
    if (concatPh.buffer !== mergedPhBuf) transfers.push(concatPh.buffer);

    return [resp, transfers];
}

// Shared helpers
type OhlcvEntry = {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    delta: number;
};

function buildOhlcvMapFromBuf(trades: Float64Array, barNs: bigint): Map<bigint, OhlcvEntry> {
    const map = new Map<bigint, OhlcvEntry>();
    if (barNs === 0n) return map;
    const tc = trades.length / TRADE_STRIDE;
    for (let i = 0; i < tc; i++) {
        const ts = toBigInt(trades[i * TRADE_STRIDE], trades[i * TRADE_STRIDE + 1]);
        const k = (ts / barNs) * barNs;
        const price = trades[i * TRADE_STRIDE + 2];
        const size = trades[i * TRADE_STRIDE + 3];
        const isBuy = trades[i * TRADE_STRIDE + 4] === 0;
        const b = map.get(k);
        if (!b) {
            map.set(k, {
                open: price,
                high: price,
                low: price,
                close: price,
                volume: size,
                delta: isBuy ? size : -size,
            });
        } else {
            if (price > b.high) b.high = price;
            if (price < b.low) b.low = price;
            b.close = price;
            b.volume += size;
            b.delta += isBuy ? size : -size;
        }
    }
    return map;
}

function serializeOhlcvMap(map: Map<bigint, OhlcvEntry>): ArrayBuffer {
    const buf = new Float64Array(map.size * OHLCV_STRIDE);
    let i = 0;
    for (const [k, v] of map) {
        buf[i * OHLCV_STRIDE + 0] = bigintHi(k);
        buf[i * OHLCV_STRIDE + 1] = bigintLo(k);
        buf[i * OHLCV_STRIDE + 2] = v.open;
        buf[i * OHLCV_STRIDE + 3] = v.high;
        buf[i * OHLCV_STRIDE + 4] = v.low;
        buf[i * OHLCV_STRIDE + 5] = v.close;
        buf[i * OHLCV_STRIDE + 6] = v.volume;
        buf[i * OHLCV_STRIDE + 7] = v.delta;
        i++;
    }
    return buf.buffer;
}

function bucketPhBuf(ph: Float64Array, barNs: bigint): ArrayBuffer {
    if (barNs === 0n || ph.length === 0) return ph.slice().buffer;
    const map = new Map<bigint, { ts: bigint; bestBid: number; bestAsk: number }>();
    const total = ph.length / PH_STRIDE;
    for (let i = 0; i < total; i++) {
        const ts = toBigInt(ph[i * PH_STRIDE], ph[i * PH_STRIDE + 1]);
        const bucket = (ts / barNs) * barNs;
        map.set(bucket, {
            ts: bucket,
            bestBid: ph[i * PH_STRIDE + 2],
            bestAsk: ph[i * PH_STRIDE + 3],
        });
    }
    const sorted = Array.from(map.values()).sort((a, b) => (a.ts < b.ts ? -1 : 1));
    const out = new Float64Array(sorted.length * PH_STRIDE);
    for (let i = 0; i < sorted.length; i++) {
        out[i * PH_STRIDE + 0] = bigintHi(sorted[i].ts);
        out[i * PH_STRIDE + 1] = bigintLo(sorted[i].ts);
        out[i * PH_STRIDE + 2] = sorted[i].bestBid;
        out[i * PH_STRIDE + 3] = sorted[i].bestAsk;
    }
    return out.buffer;
}

// Dispatch
self.onmessage = (e: MessageEvent<SliceWorkerRequest>) => {
    const req = e.data;
    if (req.kind === 'slice') {
        const [resp, transfers] = handleSlice(req);
        (self as any).postMessage(resp, transfers);
    } else if (req.kind === 'prepend-merge') {
        const [resp, transfers] = handlePrependMerge(req);
        (self as any).postMessage(resp, transfers);
    } else if (req.kind === 'load-ingest') {
        const [resp, transfers] = handleLoadIngest(req);
        (self as any).postMessage(resp, transfers);
    } else if (req.kind === 'append-ingest') {
        const [resp, transfers] = handleAppendIngest(req);
        (self as any).postMessage(resp, transfers);
    }
};
