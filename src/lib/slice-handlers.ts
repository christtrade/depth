// split from slice.worker.ts so tests can run it without a Worker

// Serialization strides
const TRADE_STRIDE = 6; // [ts_hi, ts_lo, price, size, side(0=B/1=A), _pad]
const PH_STRIDE = 4; // [ts_hi, ts_lo, bestBid, bestAsk]
const OHLCV_STRIDE = 8; // [key_hi, key_lo, open, high, low, close, volume, delta]

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

// LoadIngest handler
export function handleLoadIngest(req: LoadIngestRequest): [LoadIngestResponse, Transferable[]] {
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
