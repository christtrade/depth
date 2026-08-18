/**
 * KEY DESIGN PRINCIPLE - NO MAIN-THREAD DESERIALIZATION:
 *
 * The onmessage handler does ZERO object allocation. It reattaches ArrayBuffers
 * and resolves with raw Float64Array-backed data only. Callers that need JS
 * objects (TradePoint[], PriceHistory[], Map) call the exported lazy helpers.
 *
 * Public API:
 *   sliceToMboEventsAsync   - off-thread slice, returns MboEvent[]
 *   prependMergeAsync       - off-thread prepend (raw buffer result)
 *   loadIngestAsync         - off-thread load post-processing (raw buffer result)
 *   appendIngestAsync       - off-thread append (raw buffer result)
 *
 * Raw-buffer result helpers (call ONLY when you actually need JS objects,
 * never in the hot onmessage path):
 *   deserializeTradesFromBuf
 *   deserializePriceHistoryFromBuf
 *   deserializeOhlcvCacheFromBuf
 *   serializeTrades / serializePriceHistory / serializeOhlcvCache
 *
 *   destroySliceWorker()
 */

import type { CompactBuffer } from '../lib/compact-buffer';
import type { MboEvent, PriceHistory } from '../lib/types';
import type {
    SliceWorkerRequest,
    SliceResponse,
    PrependMergeResponse,
    PrependMergeRequest,
    LoadIngestRequest,
    LoadIngestResponse,
    AppendIngestRequest,
    AppendIngestResponse,
} from './slice.worker';

// Types
type TradePoint = { ts: bigint; price: number; size: number; side: string };

type OhlcvEntry = {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    delta: number;
};

export interface PrependMergeOptions {
    cb: CompactBuffer;
    incomingBuf: ArrayBuffer;
    existingTrades: TradePoint[];
    newTrades: TradePoint[];
    existingPriceHistory: PriceHistory[];
    newPriceHistory: PriceHistory[];
    existingOhlcvCache: Map<bigint, OhlcvEntry> | null;
    barNs: bigint;
    existingTradesBufRaw?: ArrayBuffer;
    existingPhBufRaw?: ArrayBuffer;
    existingOhlcvBufRaw?: ArrayBuffer;
}

export interface LoadIngestOptions {
    tradesBuf: ArrayBuffer;
    phBuf: ArrayBuffer;
    barNs: bigint;
}

export interface AppendIngestOptions {
    cb: CompactBuffer;
    incomingBuf: ArrayBuffer;
    existingTradesBuf: ArrayBuffer;
    newTrades: TradePoint[];
    existingPhBuf: ArrayBuffer;
    newPriceHistory: PriceHistory[];
    existingOhlcvBuf: ArrayBuffer;
    trimBeforeNs: bigint;
    barNs: bigint;
    dataEndNs: bigint;
}

/**
 * Raw-buffer results - no JS objects allocated on the main thread.
 * Call deserialize* helpers only when you actually need to iterate.
 */
export interface RawIngestResult {
    /** Raw Float64Array (TRADE_STRIDE f64s per trade). */
    tradesBuf: ArrayBuffer;
    /** Raw Float64Array (PH_STRIDE f64s per point). */
    phBuf: ArrayBuffer;
    /** Raw Float64Array - bucketed price history. */
    bucketedPhBuf: ArrayBuffer;
    /** Raw Float64Array (OHLCV_STRIDE f64s per entry). */
    ohlcvBuf: ArrayBuffer;
}

export interface PrependMergeRawResult extends RawIngestResult {
    cb: CompactBuffer;
    prependedCount: number;
}

export interface LoadIngestRawResult {
    ohlcvBuf: ArrayBuffer;
    bucketedPhBuf: ArrayBuffer;
    tradesBuf: ArrayBuffer;
    phBuf: ArrayBuffer;
}

export interface AppendIngestRawResult {
    cb: CompactBuffer;
    mergedTradesBuf: ArrayBuffer;
    mergedPhBuf: ArrayBuffer;
    mergedOhlcvBuf: ArrayBuffer;
    appendedCount: number;
    compactCutCount: number;
    tradeCutCount: number;
    phCutCount: number;
}

// Serialization strides
const TRADE_STRIDE = 6;
const PH_STRIDE = 4;
const OHLCV_STRIDE = 8;

// Bigint helpers
function bigintHi(n: bigint): number {
    return Number(n >> 32n);
}
function bigintLo(n: bigint): number {
    return Number(n & 0xffffffffn);
}
function fromHiLo(hi: number, lo: number): bigint {
    return (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
}

// Serializers
// Call on SMALL incremental arrays only. Never call on the full dataset.

export function serializeTrades(trades: TradePoint[]): ArrayBuffer {
    const buf = new Float64Array(trades.length * TRADE_STRIDE);
    for (let i = 0; i < trades.length; i++) {
        const t = trades[i];
        buf[i * TRADE_STRIDE + 0] = bigintHi(t.ts);
        buf[i * TRADE_STRIDE + 1] = bigintLo(t.ts);
        buf[i * TRADE_STRIDE + 2] = t.price;
        buf[i * TRADE_STRIDE + 3] = t.size;
        buf[i * TRADE_STRIDE + 4] = t.side === 'B' ? 0 : 1;
        buf[i * TRADE_STRIDE + 5] = 0;
    }
    return buf.buffer;
}

export function serializePriceHistory(ph: PriceHistory[]): ArrayBuffer {
    const buf = new Float64Array(ph.length * PH_STRIDE);
    for (let i = 0; i < ph.length; i++) {
        buf[i * PH_STRIDE + 0] = bigintHi(ph[i].ts);
        buf[i * PH_STRIDE + 1] = bigintLo(ph[i].ts);
        buf[i * PH_STRIDE + 2] = ph[i].bestBid;
        buf[i * PH_STRIDE + 3] = ph[i].bestAsk;
    }
    return buf.buffer;
}

export function serializeOhlcvCache(map: Map<bigint, OhlcvEntry> | null): ArrayBuffer {
    if (!map || map.size === 0) return new ArrayBuffer(0);
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

// Lazy deserializers - call ONLY when you actually need JS objects
// Never call these in the onmessage handler or in a .then() that runs immediately
// after a worker response (that IS the main thread).

export function deserializeTradesFromBuf(buf: ArrayBuffer): TradePoint[] {
    const f = new Float64Array(buf);
    const count = f.length / TRADE_STRIDE;
    const out: TradePoint[] = new Array(count);
    for (let i = 0; i < count; i++) {
        out[i] = {
            ts: fromHiLo(f[i * TRADE_STRIDE + 0], f[i * TRADE_STRIDE + 1]),
            price: f[i * TRADE_STRIDE + 2],
            size: f[i * TRADE_STRIDE + 3],
            side: f[i * TRADE_STRIDE + 4] === 0 ? 'B' : 'A',
        };
    }
    return out;
}

export function deserializePriceHistoryFromBuf(buf: ArrayBuffer): PriceHistory[] {
    const f = new Float64Array(buf);
    const count = f.length / PH_STRIDE;
    const out: PriceHistory[] = new Array(count);
    for (let i = 0; i < count; i++) {
        out[i] = {
            ts: fromHiLo(f[i * PH_STRIDE + 0], f[i * PH_STRIDE + 1]),
            bestBid: f[i * PH_STRIDE + 2],
            bestAsk: f[i * PH_STRIDE + 3],
        };
    }
    return out;
}

export function deserializeOhlcvCacheFromBuf(
    buf: ArrayBuffer,
    horizon: bigint,
): Map<bigint, OhlcvEntry> {
    const f = new Float64Array(buf);
    const count = f.length / OHLCV_STRIDE;
    const map = new Map<bigint, OhlcvEntry>();
    for (let i = 0; i < count; i++) {
        const k = fromHiLo(f[i * OHLCV_STRIDE + 0], f[i * OHLCV_STRIDE + 1]);
        if (k > horizon) break;
        map.set(k, {
            open: f[i * OHLCV_STRIDE + 2],
            high: f[i * OHLCV_STRIDE + 3],
            low: f[i * OHLCV_STRIDE + 4],
            close: f[i * OHLCV_STRIDE + 5],
            volume: f[i * OHLCV_STRIDE + 6],
            delta: f[i * OHLCV_STRIDE + 7],
        });
    }
    return map;
}

/**
 * Fast typed-array lookup for the candle cache - avoids deserializing the whole cache
 * into a Map just to do a single key lookup during mousemove / status line.
 * Returns null if not found.
 */
export function lookupOhlcvFromBuf(buf: ArrayBuffer, targetKey: bigint): OhlcvEntry | null {
    const f = new Float64Array(buf);
    const count = f.length / OHLCV_STRIDE;
    for (let i = 0; i < count; i++) {
        const k = fromHiLo(f[i * OHLCV_STRIDE + 0], f[i * OHLCV_STRIDE + 1]);
        if (k === targetKey) {
            return {
                open: f[i * OHLCV_STRIDE + 2],
                high: f[i * OHLCV_STRIDE + 3],
                low: f[i * OHLCV_STRIDE + 4],
                close: f[i * OHLCV_STRIDE + 5],
                volume: f[i * OHLCV_STRIDE + 6],
                delta: f[i * OHLCV_STRIDE + 7],
            };
        }
    }
    return null;
}

// Singleton worker
let _worker: Worker | null = null;
let _reqCounter = 0;

type PendingSlice = {
    kind: 'slice';
    resolve: (r: {
        events: MboEvent[];
        cb: CompactBuffer;
        messageType: 'init' | 'append' | 'prepend';
    }) => void;
    reject: (e: Error) => void;
    originalCb: CompactBuffer;
    messageType: 'init' | 'append' | 'prepend';
};
type PendingMerge = {
    kind: 'prepend-merge';
    resolve: (r: PrependMergeRawResult) => void;
    reject: (e: Error) => void;
    originalCb: CompactBuffer;
};
type PendingLoadIngest = {
    kind: 'load-ingest';
    resolve: (r: LoadIngestRawResult) => void;
    reject: (e: Error) => void;
};
type PendingAppendIngest = {
    kind: 'append-ingest';
    resolve: (r: AppendIngestRawResult) => void;
    reject: (e: Error) => void;
    originalCb: CompactBuffer;
};
type PendingEntry = PendingSlice | PendingMerge | PendingLoadIngest | PendingAppendIngest;

const _pending = new Map<string, PendingEntry>();

function getWorker(): Worker {
    if (_worker) return _worker;

    _worker = new Worker(new URL('./slice.worker.ts', import.meta.url));

    _worker.onmessage = (e: MessageEvent) => {
        // ZERO object allocation in this handler
        // We only reattach ArrayBuffers and hand raw results to the caller.
        // All deserialisation (TradePoint[], PriceHistory[], Map) happens
        // lazily in a scheduler tick AFTER this handler returns, so the
        // browser can paint between the postMessage response and the JS work.
        const msg = e.data as
            | SliceResponse
            | PrependMergeResponse
            | LoadIngestResponse
            | AppendIngestResponse;

        const entry = _pending.get(msg.id);
        if (!entry) return;
        _pending.delete(msg.id);

        if (msg.kind === 'slice') {
            const se = entry as PendingSlice;
            se.originalCb._buf = (msg as SliceResponse).buf;
            se.originalCb._view = new DataView((msg as SliceResponse).buf);
            se.resolve({
                events: (msg as SliceResponse).events,
                cb: se.originalCb,
                messageType: (msg as SliceResponse).messageType,
            });
        } else if (msg.kind === 'prepend-merge') {
            const me = entry as PendingMerge;
            const m = msg as PrependMergeResponse;
            const cb = me.originalCb;
            cb._buf = m.mergedBuf;
            cb._view = new DataView(m.mergedBuf);
            cb.length = m.mergedLength;
            cb.capacity = m.mergedCapacity;
            // RAW: no deserialize calls here
            me.resolve({
                cb,
                tradesBuf: m.mergedTradesBuf,
                phBuf: m.mergedPhBuf,
                bucketedPhBuf: m.bucketedPhBuf,
                ohlcvBuf: m.mergedOhlcvBuf,
                prependedCount: m.prependedCount,
            });
        } else if (msg.kind === 'load-ingest') {
            const le = entry as PendingLoadIngest;
            const m = msg as LoadIngestResponse;
            // RAW: no deserialize calls here
            le.resolve({
                ohlcvBuf: m.ohlcvBuf,
                bucketedPhBuf: m.bucketedPhBuf,
                tradesBuf: m.tradesBuf,
                phBuf: m.phBuf,
            });
        } else if (msg.kind === 'append-ingest') {
            const ae = entry as PendingAppendIngest;
            const m = msg as AppendIngestResponse;
            const cb = ae.originalCb;
            cb._buf = m.mergedBuf;
            cb._view = new DataView(m.mergedBuf);
            cb.length = m.mergedLength;
            cb.capacity = m.mergedCapacity;
            cb.firstTs = fromHiLo(m.newFirstTsHi, m.newFirstTsLo);
            cb.lastTs = fromHiLo(m.newLastTsHi, m.newLastTsLo);
            // RAW: no deserialize calls here
            ae.resolve({
                cb,
                mergedTradesBuf: m.mergedTradesBuf,
                mergedPhBuf: m.mergedPhBuf,
                mergedOhlcvBuf: m.mergedOhlcvBuf,
                appendedCount: m.appendedCount,
                compactCutCount: m.compactCutCount,
                tradeCutCount: m.tradeCutCount,
                phCutCount: m.phCutCount,
            });
        }
    };

    _worker.onerror = (err) => {
        console.error('[SliceWorker] crashed', err);
        for (const [, e] of _pending) {
            (e as any).reject(new Error(`SliceWorker crashed: ${err.message}`));
        }
        _pending.clear();
        _worker = null;
    };

    return _worker;
}

// Public API
export function sliceToMboEventsAsync(
    cb: CompactBuffer,
    start: number,
    end: number,
    messageType: 'init' | 'append' | 'prepend',
): Promise<{ events: MboEvent[]; cb: CompactBuffer; messageType: typeof messageType }> {
    return new Promise((resolve, reject) => {
        const id = `slice-${++_reqCounter}`;
        _pending.set(id, {
            kind: 'slice',
            resolve: resolve as any,
            reject,
            originalCb: cb,
            messageType,
        });
        getWorker().postMessage(
            {
                kind: 'slice',
                id,
                buf: cb._buf,
                length: cb.length,
                capacity: cb.capacity,
                start,
                end,
                messageType,
            } satisfies SliceWorkerRequest,
            [cb._buf],
        );
    });
}

/**
 * Off-thread prepend merge. Returns RAW buffers - caller deserializes lazily.
 * Pass existingTradesBufRaw / existingPhBufRaw / existingOhlcvBufRaw when
 * available (from previous ingest result) to avoid serialising full dataset.
 */
export function prependMergeAsync(opts: PrependMergeOptions): Promise<PrependMergeRawResult> {
    return new Promise((resolve, reject) => {
        const id = `merge-${++_reqCounter}`;
        _pending.set(id, { kind: 'prepend-merge', resolve, reject, originalCb: opts.cb });

        const existingTradesBuf = opts.existingTradesBufRaw ?? serializeTrades(opts.existingTrades);
        const newTradesBuf = serializeTrades(opts.newTrades);
        const existingPhBuf =
            opts.existingPhBufRaw ?? serializePriceHistory(opts.existingPriceHistory);
        const newPhBuf = serializePriceHistory(opts.newPriceHistory);
        const existingOhlcvBuf =
            opts.existingOhlcvBufRaw ?? serializeOhlcvCache(opts.existingOhlcvCache);

        const req: PrependMergeRequest = {
            kind: 'prepend-merge',
            id,
            existingBuf: opts.cb._buf,
            existingLength: opts.cb.length,
            existingCapacity: opts.cb.capacity,
            incomingBuf: opts.incomingBuf,
            existingTradesBuf,
            newTradesBuf,
            existingPhBuf,
            newPhBuf,
            existingOhlcvBuf,
            barNsHi: bigintHi(opts.barNs),
            barNsLo: bigintLo(opts.barNs),
        };

        getWorker().postMessage(req, [
            opts.cb._buf,
            opts.incomingBuf,
            existingTradesBuf,
            newTradesBuf,
            existingPhBuf,
            newPhBuf,
            existingOhlcvBuf,
        ]);
    });
}

/**
 * Off-thread load-ingest. Returns RAW buffers - caller deserializes lazily.
 * tradesBuf and phBuf are TRANSFERRED.
 */
export function loadIngestAsync(opts: LoadIngestOptions): Promise<LoadIngestRawResult> {
    return new Promise((resolve, reject) => {
        const id = `load-ingest-${++_reqCounter}`;
        _pending.set(id, { kind: 'load-ingest', resolve, reject });

        const req: LoadIngestRequest = {
            kind: 'load-ingest',
            id,
            tradesBuf: opts.tradesBuf,
            phBuf: opts.phBuf,
            barNsHi: bigintHi(opts.barNs),
            barNsLo: bigintLo(opts.barNs),
        };
        getWorker().postMessage(req, [opts.tradesBuf, opts.phBuf]);
    });
}

/**
 * Off-thread append-ingest. Returns RAW buffers - caller deserializes lazily.
 * Only serialise the SMALL incremental newTrades / newPriceHistory on the
 * main thread. All existingXxxBuf are transferred (zero-copy).
 */
export function appendIngestAsync(opts: AppendIngestOptions): Promise<AppendIngestRawResult> {
    return new Promise((resolve, reject) => {
        const id = `append-ingest-${++_reqCounter}`;
        _pending.set(id, { kind: 'append-ingest', resolve, reject, originalCb: opts.cb });

        const newTradesBuf = serializeTrades(opts.newTrades);
        const newPhBuf = serializePriceHistory(opts.newPriceHistory);

        const req: AppendIngestRequest = {
            kind: 'append-ingest',
            id,
            existingBuf: opts.cb._buf,
            existingLength: opts.cb.length,
            existingCapacity: opts.cb.capacity,
            incomingBuf: opts.incomingBuf,
            existingTradesBuf: opts.existingTradesBuf,
            newTradesBuf,
            existingPhBuf: opts.existingPhBuf,
            newPhBuf,
            existingOhlcvBuf: opts.existingOhlcvBuf,
            trimBeforeNsHi: bigintHi(opts.trimBeforeNs),
            trimBeforeNsLo: bigintLo(opts.trimBeforeNs),
            barNsHi: bigintHi(opts.barNs),
            barNsLo: bigintLo(opts.barNs),
            dataEndNsHi: bigintHi(opts.dataEndNs),
            dataEndNsLo: bigintLo(opts.dataEndNs),
        };

        getWorker().postMessage(req, [
            opts.cb._buf,
            opts.incomingBuf,
            opts.existingTradesBuf,
            newTradesBuf,
            opts.existingPhBuf,
            newPhBuf,
            opts.existingOhlcvBuf,
        ]);
    });
}

export function destroySliceWorker(): void {
    _worker?.terminate();
    _worker = null;
    for (const [, e] of _pending) (e as any).reject(new Error('SliceWorker destroyed'));
    _pending.clear();
}
