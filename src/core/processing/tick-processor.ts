// a TickDataChunk from TickEvent[]. tick data has real trades and real per-price
// bid/ask volumes, so the footprint bars are genuinely populated. no compact
// buffer, the volumes are small enough for plain typed arrays.

import type { TickEvent } from '../../interfaces/IDataAdapter';
import type { SerialTrade } from '../../lib/types';
import type { PriceHistory } from '../../lib/types';
import type { FootprintBar } from '../../lib/types/footprint';

export interface TickDataChunk {
    kind: 'tick';
    trades: SerialTrade[];
    priceHistory: PriceHistory[];
    footprintBars: FootprintBar[];
    /** Unix ms timestamps */
    dataStart: number;
    dataEnd: number;
}

const PRICE_HISTORY_INTERVAL_NS = 50_000_000n;

export function processTickChunk(
    ticks: TickEvent[],
    barNs: bigint,
): TickDataChunk {
    if (ticks.length === 0) {
        return {
            kind: 'tick',
            trades: [],
            priceHistory: [],
            footprintBars: [],
            dataStart: 0,
            dataEnd: 0,
        };
    }

    const trades: SerialTrade[] = [];
    const priceHistory: PriceHistory[] = [];

    let lastBid = 0;
    let lastAsk = 0;
    let lastPriceHistoryTs = 0n;

    for (const tick of ticks) {
        const ts = BigInt(tick.time) * 1_000_000n;

        if (tick.side === 'B') lastBid = tick.price;
        else if (tick.side === 'A') lastAsk = tick.price;

        if (tick.side !== 'N') {
            trades.push({ ts, price: tick.price, size: tick.size, side: tick.side as 'B' | 'A' });
        }

        if (ts - lastPriceHistoryTs >= PRICE_HISTORY_INTERVAL_NS || lastPriceHistoryTs === 0n) {
            priceHistory.push({ ts, bestBid: lastBid, bestAsk: lastAsk });
            lastPriceHistoryTs = ts;
        } else {
            const last = priceHistory[priceHistory.length - 1];
            if (last) {
                last.bestBid = lastBid;
                last.bestAsk = lastAsk;
            }
        }
    }

    const footprintBars: FootprintBar[] = [];
    if (barNs > 0n) {
        const barMap = new Map<
            bigint,
            {
                ts: bigint;
                open: number;
                high: number;
                low: number;
                close: number;
                totalVol: number;
                totalDelta: number;
                levels: Record<number, { bidVol: number; askVol: number }>;
            }
        >();

        for (const tick of ticks) {
            const ts = BigInt(tick.time) * 1_000_000n;
            const bucketKey = ts - (ts % barNs);

            if (!barMap.has(bucketKey)) {
                barMap.set(bucketKey, {
                    ts: bucketKey,
                    open: tick.price,
                    high: tick.price,
                    low: tick.price,
                    close: tick.price,
                    totalVol: 0,
                    totalDelta: 0,
                    levels: {},
                });
            }

            const bar = barMap.get(bucketKey)!;
            if (tick.price > bar.high) bar.high = tick.price;
            if (tick.price < bar.low) bar.low = tick.price;
            bar.close = tick.price;
            bar.totalVol += tick.size;

            if (tick.side !== 'N') {
                if (!bar.levels[tick.price]) bar.levels[tick.price] = { bidVol: 0, askVol: 0 };
                if (tick.side === 'B') {
                    bar.levels[tick.price].bidVol += tick.size;
                    bar.totalDelta += tick.size;
                } else {
                    bar.levels[tick.price].askVol += tick.size;
                    bar.totalDelta -= tick.size;
                }
            }
        }

        const sortedKeys = Array.from(barMap.keys()).sort((a, b) => (a < b ? -1 : 1));
        for (const key of sortedKeys) {
            const b = barMap.get(key)!;
            footprintBars.push({
                ts: b.ts,
                open: b.open,
                high: b.high,
                low: b.low,
                close: b.close,
                totalVol: b.totalVol,
                totalDelta: b.totalDelta,
                levels: b.levels,
            } as unknown as FootprintBar);
        }
    }

    return {
        kind: 'tick',
        trades,
        priceHistory,
        footprintBars,
        dataStart: ticks[0].time,
        dataEnd: ticks[ticks.length - 1].time,
    };
}
