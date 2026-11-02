import type { MboEvent, BookState } from './types';

export const LOD_INTERVALS_NS: bigint[] = [
    250_000_000n, // 250ms
    1_000_000_000n, // 1s
    5_000_000_000n, // 5s
    30_000_000_000n, // 30s
];

export type Snapshot = {
    ts: bigint;
    // bids sorted high -> low
    // asks sorted low -> high
    bids: Float64Array;
    asks: Float64Array;
};

function isoToNs(isoString: string): bigint {
    const ms = Date.parse(isoString);
    const wholeSecMs = ms - (ms % 1000);
    const base = BigInt(wholeSecMs) * 1_000_000n;

    const dotIdx = isoString.indexOf('.');
    if (dotIdx === -1) return base + BigInt(ms % 1000) * 1_000_000n;

    let end = dotIdx + 1;
    while (
        end < isoString.length &&
        isoString.charCodeAt(end) >= 48 &&
        isoString.charCodeAt(end) <= 57
    )
        end++;

    const fracStr = isoString.slice(dotIdx + 1, end);
    const fracNs = BigInt(fracStr.padEnd(9, '0').slice(0, 9));
    return base + fracNs;
}

// yield control every N events so the worker stays responsive (to incoming
// render requests during long loads)
const INIT_CHUNK_SIZE = 5_000;

// every lod level keeps its own next snapshot time
export type Build = {
    book: BookState;
    snaps: Snapshot[][];
    nextSnapTimes: (bigint | null)[];
    lastEventTs: bigint;
    // a trailing snapshot at lastEventTs ends every level
    sealed: boolean;
};

export function newBuild(): Build {
    const levels = LOD_INTERVALS_NS.length;
    return {
        //@ts-ignore
        book: { bids: new Map(), asks: new Map() },
        snaps: Array.from({ length: levels }, () => []),
        nextSnapTimes: new Array(levels).fill(null),
        lastEventTs: 0n,
        sealed: false,
    };
}

// false when `stale` says a newer build took over. never yields without it
export async function feed(b: Build, events: MboEvent[], stale?: () => boolean): Promise<boolean> {
    for (let i = 0; i < events.length; i++) {
        if (stale && i > 0 && i % INIT_CHUNK_SIZE === 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            if (stale()) return false;
        }

        const event = events[i];
        const ts = isoToNs(event.ts_event);
        b.lastEventTs = ts;

        for (let lvl = 0; lvl < b.snaps.length; lvl++) {
            const interval = LOD_INTERVALS_NS[lvl];
            if (b.nextSnapTimes[lvl] === null) {
                b.nextSnapTimes[lvl] = (ts / interval) * interval;
            }
            while (ts >= b.nextSnapTimes[lvl]!) {
                b.snaps[lvl].push(snapshotToArrays(b.book, b.nextSnapTimes[lvl]!));
                b.nextSnapTimes[lvl] = b.nextSnapTimes[lvl]! + interval;
            }
        }

        applyEvent(b.book, event);
    }
    return !stale?.();
}

export function seal(b: Build): void {
    if (b.sealed || b.nextSnapTimes[0] === null) return;
    for (const level of b.snaps) level.push(snapshotToArrays(b.book, b.lastEventTs));
    b.sealed = true;
}

export function unseal(b: Build): void {
    if (!b.sealed) return;
    for (const level of b.snaps) level.pop();
    b.sealed = false;
}

// Convert book maps -> flat sorted float arrays (no allocation during render)
const _bidScratch = new Map<number, number>();
const _askScratch = new Map<number, number>();

function snapshotToArrays(book: BookState, ts: bigint): Snapshot {
    _bidScratch.clear();
    _askScratch.clear();

    for (const o of (book.bids as Map<string, { price: number; size: number }>).values()) {
        _bidScratch.set(o.price, (_bidScratch.get(o.price) ?? 0) + o.size);
    }
    for (const o of (book.asks as Map<string, { price: number; size: number }>).values()) {
        _askScratch.set(o.price, (_askScratch.get(o.price) ?? 0) + o.size);
    }

    const bids = new Float64Array(_bidScratch.size * 2);
    const asks = new Float64Array(_askScratch.size * 2);

    // Fill and sort in one pass using index tracking
    let bi = 0;
    for (const [price, size] of _bidScratch) {
        bids[bi++] = price;
        bids[bi++] = size;
    }
    let ai = 0;
    for (const [price, size] of _askScratch) {
        asks[ai++] = price;
        asks[ai++] = size;
    }

    sortPairs(bids, true);
    sortPairs(asks, false);

    return { ts, bids, asks };
}

// sort a flat [price, size, price, size, ...] float array by price.
// uses insertion sort (O(n^2)) but its faster than creating an intermediate
// array for Array.sort cus the number of price levels is small (like 50-500)
export function sortPairs(arr: Float64Array, highToLow: boolean): void {
    const n = arr.length;
    for (let i = 2; i < n; i += 2) {
        const kp = arr[i],
            ks = arr[i + 1];
        let j = i - 2;
        while (j >= 0 && (highToLow ? arr[j] < kp : arr[j] > kp)) {
            arr[j + 2] = arr[j];
            arr[j + 3] = arr[j + 1];
            j -= 2;
        }
        arr[j + 2] = kp;
        arr[j + 3] = ks;
    }
}

function applyEvent(book: BookState, event: MboEvent): void {
    if (event.action === 'R') {
        book.bids.clear();
        book.asks.clear();
        return;
    }
    let side = event.side;
    if (event.action === 'T' || event.action === 'F') side = side === 'B' ? 'A' : 'B';
    const map = side === 'B' ? book.bids : book.asks;
    if (event.action === 'A') {
        map.set(event.order_id, { price: event.price!, size: event.size } as any);
    } else if (event.action === 'C') {
        map.delete(event.order_id);
    } else if (event.action === 'M') {
        const o = map.get(event.order_id) as any;
        if (o) {
            if (event.price !== null) o.price = event.price;
            o.size = event.size;
        }
    } else if (event.action === 'T' || event.action === 'F') {
        book.bids.delete(event.order_id);
        book.asks.delete(event.order_id);
    }
}
