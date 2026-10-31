import type { CompactBuffer } from '../lib/compact-buffer';
import type { MboEvent, PriceHistory } from '../lib/types';
import type {
    SliceWorkerRequest,
    SliceResponse,
    LoadIngestRequest,
    LoadIngestResponse,
} from './slice-handlers';

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

export interface LoadIngestOptions {
    tradesBuf: ArrayBuffer;
    phBuf: ArrayBuffer;
    barNs: bigint;
}

export interface LoadIngestRawResult {
    ohlcvBuf: ArrayBuffer;
    bucketedPhBuf: ArrayBuffer;
    tradesBuf: ArrayBuffer;
    phBuf: ArrayBuffer;
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

// Lazy deserializers - call ONLY when you actually need JS objects
// Never call these in the onmessage handler or in a .then() that runs immediately
// after a worker response (that IS the main thread).

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
type PendingLoadIngest = {
    kind: 'load-ingest';
    resolve: (r: LoadIngestRawResult) => void;
    reject: (e: Error) => void;
};
type PendingEntry = PendingSlice | PendingLoadIngest;

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
        const msg = e.data as SliceResponse | LoadIngestResponse;

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

export function destroySliceWorker(): void {
    _worker?.terminate();
    _worker = null;
    for (const [, e] of _pending) (e as any).reject(new Error('SliceWorker destroyed'));
    _pending.clear();
}
