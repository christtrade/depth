import type { PriceHistory, TradePoint } from './types';
import { footprintFromTrades, type FootprintBar, type FootprintOptions } from './types/footprint';

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
        if (trades[i].ts > horizon) break;
        addTrade(map, trades[i], barNs);
    }
}

// trades in after, horizon
export function foldTrades(
    map: Map<bigint, Candle>,
    trades: readonly TradePoint[],
    barNs: bigint,
    after: bigint,
    horizon: bigint,
): void {
    const end = firstTsAtOrAfter(trades, horizon + 1n);
    for (let i = firstTsAtOrAfter(trades, after + 1n); i < end; i++) addTrade(map, trades[i], barNs);
}

function addTrade(map: Map<bigint, Candle>, t: TradePoint, barNs: bigint): void {
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

export function extendFootprints(
    bars: FootprintBar[],
    trades: readonly TradePoint[],
    barNs: bigint,
    horizon: bigint,
    opts: FootprintOptions = {},
): void {
    const from = bars.length ? bars.pop()!.ts : null;
    const start = from === null ? 0 : firstTsAtOrAfter(trades, from);
    const end = firstTsAtOrAfter(trades, horizon + 1n);
    if (end > start) bars.push(...footprintFromTrades(trades.slice(start, end), barNs, opts));
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
