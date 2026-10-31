import type { PriceHistory, TradePoint } from './types';

export type Candle = { open: number; high: number; low: number; close: number; volume: number; delta: number };

export function firstTsAtOrAfter(arr: readonly { ts: bigint }[], ns: bigint): number {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (arr[mid].ts < ns) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

// a live chunk only changes the last bucket on, so the rest is kept

export function extendCandles(
    map: Map<bigint, Candle>,
    trades: readonly TradePoint[],
    barNs: bigint,
    horizon: bigint,
): void {
    let last: bigint | null = null;
    for (const k of map.keys()) last = k;
    if (last !== null) map.delete(last);
    for (let i = last === null ? 0 : firstTsAtOrAfter(trades, last); i < trades.length; i++) {
        const t = trades[i];
        if (t.ts > horizon) break;
        const k = (t.ts / barNs) * barNs;
        const delta = t.side === 'B' ? t.size : -t.size;
        const b = map.get(k);
        if (!b) {
            map.set(k, { open: t.price, high: t.price, low: t.price, close: t.price, volume: t.size, delta });
        } else {
            if (t.price > b.high) b.high = t.price;
            if (t.price < b.low) b.low = t.price;
            b.close = t.price;
            b.volume += t.size;
            b.delta += delta;
        }
    }
}

// one entry a bucket, its last bid/ask
export function extendBucketedPh(
    out: PriceHistory[],
    raw: readonly PriceHistory[],
    barNs: bigint,
    horizon: bigint,
): number {
    const from = out.length ? out[out.length - 1].ts : null;
    if (from !== null) out.pop();
    let i = from === null ? 0 : firstTsAtOrAfter(raw, from);
    for (; i < raw.length; i++) {
        const { ts, bestBid, bestAsk } = raw[i];
        if (ts > horizon) break;
        const k = (ts / barNs) * barNs;
        const tail = out[out.length - 1];
        if (tail?.ts === k) {
            tail.bestBid = bestBid;
            tail.bestAsk = bestAsk;
        } else {
            out.push({ ts: k, bestBid, bestAsk });
        }
    }
    return i - 1;
}
