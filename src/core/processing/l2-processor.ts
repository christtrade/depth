// an L2DataChunk from L2Snapshot[]. l2 has no trade events or order-level
// detail, so only priceHistory gets populated.

import type { L2Snapshot } from '../../interfaces/IDataAdapter';
import type { PriceHistory } from '../../lib/types';

export interface L2DataChunk {
    kind: 'l2';
    priceHistory: PriceHistory[];
    /** Unix ms timestamps */
    dataStart: number;
    dataEnd: number;
}

const PRICE_HISTORY_INTERVAL_NS = 50_000_000n;

export function processL2Chunk(snapshots: L2Snapshot[], _barNs: bigint): L2DataChunk {
    if (snapshots.length === 0) {
        return { kind: 'l2', priceHistory: [], dataStart: 0, dataEnd: 0 };
    }

    const priceHistory: PriceHistory[] = [];
    let lastPriceHistoryTs = 0n;

    for (const snap of snapshots) {
        const ts = BigInt(snap.time) * 1_000_000n;
        const bestBid = snap.bids.length > 0 ? snap.bids[0].price : 0;
        const bestAsk = snap.asks.length > 0 ? snap.asks[0].price : 0;

        if (ts - lastPriceHistoryTs >= PRICE_HISTORY_INTERVAL_NS || lastPriceHistoryTs === 0n) {
            priceHistory.push({ ts, bestBid, bestAsk });
            lastPriceHistoryTs = ts;
        } else {
            const last = priceHistory[priceHistory.length - 1];
            if (last) {
                last.bestBid = bestBid;
                last.bestAsk = bestAsk;
            }
        }
    }

    return {
        kind: 'l2',
        priceHistory,
        dataStart: snapshots[0].time,
        dataEnd: snapshots[snapshots.length - 1].time,
    };
}
