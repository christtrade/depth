import { applyEvent, createBook, getBestAsk, getBestBid } from './book';
import { createL3MatchingEngine } from './matchingEngine';
import { MboEvent, PriceHistory, TradePoint } from './types';

export function isoToNs(isoString: string): bigint {
    // Get whole seconds only, zero out sub-second part to avoid Date precision loss
    const withoutFrac = isoString.replace(/\.\d+Z$/, '.000Z');
    const secondsBase = BigInt(new Date(withoutFrac).getTime()) * 1_000_000n;

    const match = isoString.match(/\.(\d+)Z$/);
    if (match) {
        // Pad/truncate to exactly 9 digits -> nanoseconds within the second
        const fracNs = BigInt(match[1].padEnd(9, '0').slice(0, 9));
        return secondsBase + fracNs;
    }
    return secondsBase;
}

export function sampleTrades(
    events: MboEvent[],
    engine: ReturnType<typeof createL3MatchingEngine>,
) {
    const tradePoints: TradePoint[] = [];
    const priceHistory: PriceHistory[] = [];
    const book = createBook();

    let lastAsk: number | null = null;
    let lastBid: number | null = null;
    // Downsample priceHistory: max 1 entry per 50ms.
    // L3 data fires a BBO change on nearly every event (every order add/cancel
    // can move the best bid/ask), producing tens of millions of entries for a
    // 2h session. At any visible zoom level, sub-50ms granularity is invisible.
    const PRICE_HISTORY_INTERVAL_NS = 50_000_000n; // 50ms in nanoseconds
    let lastPriceHistoryTs = 0n;

    for (const event of events) {
        applyEvent(book, event);

        const currentAsk = getBestAsk(book);
        const currentBid = getBestBid(book);

        if (currentAsk !== lastAsk || currentBid !== lastBid) {
            const ts = isoToNs(event.ts_event);
            // Only record if enough time has passed since the last entry,
            // OR if this is the very first entry.
            if (ts - lastPriceHistoryTs >= PRICE_HISTORY_INTERVAL_NS || lastPriceHistoryTs === 0n) {
                priceHistory.push({
                    ts,
                    bestAsk: currentAsk ?? 0,
                    bestBid: currentBid ?? 0,
                });
                lastPriceHistoryTs = ts;
            } else {
                // Overwrite the last entry with the latest values within this bucket
                // so the final visible price in each 50ms window is always current.
                const last = priceHistory[priceHistory.length - 1];
                if (last) {
                    last.bestAsk = currentAsk ?? 0;
                    last.bestBid = currentBid ?? 0;
                }
            }
            lastAsk = currentAsk;
            lastBid = currentBid;
        }

        if (event.action === 'T') {
            if (event.side !== 'N' && event.price) {
                tradePoints.push({
                    ts: isoToNs(event.ts_event),
                    price: event.price,
                    size: event.size,
                    side: event.side as 'B' | 'A',
                });
            }
        }

        engine.onMboEvent(event, isoToNs(event.ts_event));
    }

    return { tradePoints, priceHistory };
}
