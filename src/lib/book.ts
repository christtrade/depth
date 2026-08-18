//  Book - applies MBO events to maintain order book state
//
//  Input:  MboEvent
//  Output: mutates BookState in-place
//
//  PERF: bestBid / bestAsk are maintained incrementally.
//  getBestBid() / getBestAsk() are now O(1) instead of O(N).
//  The only expensive case is when the current best is removed and we must
//  rescan - but that is amortised to near-zero over a realistic event stream
//  because the best level changes only a tiny fraction of the time.
import { BookState, MboEvent } from './types';

// Creates a fresh, empty order book
export function createBook(): BookState {
    return {
        bids: new Map(),
        asks: new Map(),
        bestBid: null,
        bestAsk: null,
    };
}

// Internal: recompute best from scratch (O(N), called rarely)
function recomputeBestBid(book: BookState): void {
    let best: number | null = null;
    for (const order of book.bids.values()) {
        if (best === null || order.price > best) best = order.price;
    }
    book.bestBid = best;
}

function recomputeBestAsk(book: BookState): void {
    let best: number | null = null;
    for (const order of book.asks.values()) {
        if (best === null || order.price < best) best = order.price;
    }
    book.bestAsk = best;
}

// applyEvent
export function applyEvent(book: BookState, event: MboEvent): void {
    if (event.action === 'R') {
        book.bids.clear();
        book.asks.clear();
        book.bestBid = null;
        book.bestAsk = null;
        return;
    }

    // Identify the side of the RESTING order
    let targetSide = event.side;

    // TRADES: The event.side is the AGGRESSOR.
    // We need to delete the RESTING order (the opposite side).
    if (event.action === 'T' || event.action === 'F') {
        targetSide = event.side === 'B' ? 'A' : 'B';
    }

    if (event.action === 'A') {
        const map = targetSide === 'B' ? book.bids : book.asks;
        const price = event.price!;
        map.set(event.order_id, { price, size: event.size });

        // Incremental update - only a comparison, never a scan
        if (targetSide === 'B') {
            if (book.bestBid === null || price > book.bestBid) book.bestBid = price;
        } else {
            if (book.bestAsk === null || price < book.bestAsk) book.bestAsk = price;
        }
    } else if (event.action === 'C') {
        const map = targetSide === 'B' ? book.bids : book.asks;
        const order = map.get(event.order_id);
        if (!order) return;
        const removedPrice = order.price;
        map.delete(event.order_id);

        // Only rescan if we just removed the current best
        if (targetSide === 'B') {
            if (removedPrice === book.bestBid) recomputeBestBid(book);
        } else {
            if (removedPrice === book.bestAsk) recomputeBestAsk(book);
        }
    } else if (event.action === 'M') {
        const map = targetSide === 'B' ? book.bids : book.asks;
        const order = map.get(event.order_id);
        if (!order) return;

        const oldPrice = order.price;
        // price === 0 means "no price change" in Databento MBO modify events
        const newPrice = event.price !== null && event.price !== 0 ? event.price : oldPrice;

        const priceChanged = newPrice !== oldPrice;

        order.size = event.size;
        if (priceChanged) order.price = newPrice;

        if (priceChanged) {
            // Re-derive best for the affected side
            if (targetSide === 'B') {
                if (newPrice > (book.bestBid ?? -Infinity)) {
                    book.bestBid = newPrice;
                } else if (oldPrice === book.bestBid) {
                    recomputeBestBid(book);
                }
            } else {
                if (newPrice < (book.bestAsk ?? Infinity)) {
                    book.bestAsk = newPrice;
                } else if (oldPrice === book.bestAsk) {
                    recomputeBestAsk(book);
                }
            }
        }
    } else if (event.action === 'T' || event.action === 'F') {
        // Robust delete: wipe from both sides to handle ambiguous side flags.
        const bidOrder = book.bids.get(event.order_id);
        const askOrder = book.asks.get(event.order_id);

        if (bidOrder) {
            const p = bidOrder.price;
            book.bids.delete(event.order_id);
            if (p === book.bestBid) recomputeBestBid(book);
        }
        if (askOrder) {
            const p = askOrder.price;
            book.asks.delete(event.order_id);
            if (p === book.bestAsk) recomputeBestAsk(book);
        }
    }
}

// Public accessors - now O(1)
export function getBestBid(book: BookState): number | null {
    return book.bestBid;
}

export function getBestAsk(book: BookState): number | null {
    return book.bestAsk;
}
