// a TickDataChunk from TickEvent[]. no compact buffer, the volumes are small enough for plain
// typed arrays.

import type { TickEvent } from '../../interfaces/IDataAdapter';
import type { SerialTrade } from '../../lib/types';
import type { PriceHistory } from '../../lib/types';
import { footprintFromTrades, type FootprintBar, type FootprintOptions } from '../../lib/types/footprint';

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
    fpOptions: FootprintOptions = {},
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

    return {
        kind: 'tick',
        trades,
        priceHistory,
        footprintBars: footprintFromTrades(trades, barNs, fpOptions),
        dataStart: ticks[0].time,
        dataEnd: ticks[ticks.length - 1].time,
    };
}
