// Architecture:
//   INIT:   Parse all timestamps once. Build master snapshot array at a fixed
//           fine interval covering the entire dataset.
//           Snapshots are built in async chunks to avoid blocking the worker thread.
//   RENDER: Binary-search to find visible snapshots. Bucket -> pixels.
//           Renders directly to a single full-width OffscreenCanvas - no tile
//           compositing, no price-range cache invalidation.
//           Target: <100ms per render at 1600px width.

import {
    type HeatmapRequest,
    type HeatmapResponse,
    type WorkerInitMessage,
} from './types/heatmap-types';
import type { MboEvent, BookState } from './types';
import type { ViewBounds } from './types';

// LOD levels
// Multiple snapshot pyramids built once at init from a single event-log pass.
// renderView picks the finest level where intervalNs <= nsPerPixel * LOD_RATIO,
// so the number of visible snapshots never exceeds chartW * LOD_RATIO.
// Levels: 25ms | 100ms | 500ms | 2s  (fine -> coarse)
const LOD_INTERVALS_NS: bigint[] = [
    250_000_000n, // 250ms - zoomed in tight (<= ~5 min visible)
    1_000_000_000n, // 1s   - default mid-zoom
    5_000_000_000n, // 5s   - zoomed out (a few hours)
    30_000_000_000n, // 30s  - fully zoomed out (full session)
];
// How many columns-per-pixel we tolerate before stepping up to a coarser level.
// 3 = switch levels when the snapshot count exceeds 3x the canvas width.
const LOD_RATIO = 3;

// Persistent state
type Snapshot = {
    ts: bigint;
    // Flat sorted arrays: [price0, size0, price1, size1, ...]
    // bids sorted high->low, asks sorted low->high - ready to paint directly
    bids: Float64Array;
    asks: Float64Array;
};

// One snapshot array per LOD level, indexed same as LOD_INTERVALS_NS.
let lodSnapshots: Snapshot[][] = [];
let masterSnapshots: Snapshot[] = []; // alias -> finest level for compat
let datasetTMax = 0n;
// Pending render request received before init completed
let pendingRender: (HeatmapRequest & { type: 'render' }) | null = null;
let initDone = false;

// Render serialisation
// Only one render runs at a time. If a new render request arrives while one
// is in flight, the in-flight render's result is discarded (stale requestId)
// and the new request is queued. This prevents the memory spike caused by
// dozens of concurrent OffscreenCanvas + ImageData allocations.
let renderInFlight = false;
let pendingRenderReq: (HeatmapRequest & { type: 'render' }) | null = null;

function flushRender() {
    if (renderInFlight || !pendingRenderReq) return;
    const req = pendingRenderReq;
    pendingRenderReq = null;
    renderInFlight = true;
    // Defer to a microtask so the message loop can drain
    Promise.resolve().then(() => {
        handleRender(req);
        renderInFlight = false;
        // If another request queued while we were rendering, run it now
        if (pendingRenderReq) flushRender();
    });
}

// Message router
self.onmessage = async (
    e: MessageEvent<WorkerInitMessage | HeatmapRequest | { type: 'append'; events: MboEvent[] }>,
) => {
    const msg = e.data;

    if (msg.type === 'init') {
        // Full rebuild - discard any stale snapshots first
        lodSnapshots = [];
        masterSnapshots = [];
        initDone = false;
        await buildMasterSnapshots((msg as WorkerInitMessage).events);
        initDone = true;
        if (pendingRender) {
            const req = pendingRender;
            pendingRender = null;
            pendingRenderReq = req;
            flushRender();
        }
        return;
    }

    if ((msg as any).type === 'append') {
        // Incremental extension - build snapshots only for the new events and
        // append them to the existing LOD arrays. Much cheaper than full rebuild.
        const newEvents = (msg as any).events as MboEvent[];
        if (newEvents?.length > 0 && initDone) {
            await appendSnapshots(newEvents);
        }
        return;
    }

    if (msg.type === 'render') {
        if (!initDone) {
            pendingRender = msg;
            return;
        }
        // Replace any pending render - we only care about the latest view
        pendingRenderReq = msg;
        flushRender();
    }
};

function handleRender(msg: HeatmapRequest & { type: 'render' }) {
    const { requestId, bounds: rawBounds, chartW, chartH, horizonNs } = msg;
    const bounds: ViewBounds = {
        tMin: BigInt(rawBounds.tMin),
        tMax: BigInt(rawBounds.tMax),
        pMin: rawBounds.pMin,
        pMax: rawBounds.pMax,
    };

    const horizon = horizonNs ? BigInt(horizonNs) : null;
    const bitmap = renderView(bounds, chartW, chartH, horizon);
    if (!bitmap) return;

    const response: HeatmapResponse = { requestId, bitmap, bounds: rawBounds };
    (self as unknown as Worker).postMessage(response, [bitmap]);
}

// Init: parse timestamps once, build master snapshots
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

// Chunk size for async init - yields control every N events so the worker
// stays responsive to incoming render requests during long dataset loads.
const INIT_CHUNK_SIZE = 5_000;

async function buildMasterSnapshots(events: MboEvent[]) {
    // Single pass through the event log. For each LOD level we maintain an
    // independent nextSnapTime cursor and append to its own array.
    //@ts-ignore
    const book: BookState = { bids: new Map(), asks: new Map() };
    const levels = LOD_INTERVALS_NS.length;
    const snapsArrays: Snapshot[][] = Array.from({ length: levels }, () => []);
    const nextSnapTimes: (bigint | null)[] = new Array(levels).fill(null);
    let lastEventTs = 0n;

    for (let i = 0; i < events.length; i++) {
        if (i > 0 && i % INIT_CHUNK_SIZE === 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }

        const event = events[i];
        const ts = isoToNs(event.ts_event);
        lastEventTs = ts;

        for (let lvl = 0; lvl < levels; lvl++) {
            const interval = LOD_INTERVALS_NS[lvl];
            if (nextSnapTimes[lvl] === null) {
                nextSnapTimes[lvl] = (ts / interval) * interval;
            }
            while (ts >= nextSnapTimes[lvl]!) {
                snapsArrays[lvl].push(snapshotToArrays(book, nextSnapTimes[lvl]!));
                nextSnapTimes[lvl] = nextSnapTimes[lvl]! + interval;
            }
        }

        applyEvent(book, event);
    }

    // Push a trailing snapshot at the actual last event timestamp for all levels.
    if (events.length > 0) {
        for (let lvl = 0; lvl < levels; lvl++) {
            snapsArrays[lvl].push(snapshotToArrays(book, lastEventTs));
        }
        datasetTMax = lastEventTs;
    }

    lodSnapshots = snapsArrays;
    masterSnapshots = snapsArrays[0]; // finest level - keeps compat with any direct refs

    // Sync the persistent append book so incremental appends start from the
    // correct book state rather than an empty book.
    appendBook.bids.clear();
    appendBook.asks.clear();
    for (const [k, v] of book.bids as Map<string, any>) appendBook.bids.set(k, { ...v });
    for (const [k, v] of book.asks as Map<string, any>) appendBook.asks.set(k, { ...v });
}

/**
 * Incrementally extend the LOD pyramids with new events.
 * Picks up exactly where buildMasterSnapshots left off - no full rebuild needed.
 */
async function appendSnapshots(events: MboEvent[]) {
    const levels = LOD_INTERVALS_NS.length;
    if (lodSnapshots.length !== levels) return; // safety: init not done yet

    // Reconstruct the book state at the end of the existing data by replaying
    // the trailing events. We only need book state - so we re-derive it from
    // the last snapshot's ts and replay forward. Since we don't store the book
    // between calls, we replay only the new events against a blank book, then
    // merge with the last known snapshot via a "continuation book".
    //
    // Simpler approach that works correctly: keep a persistent book alongside
    // the snapshots. We track it in appendBook below.
    const book = appendBook; // mutable, persisted between append calls

    const nextSnapTimes: bigint[] = LOD_INTERVALS_NS.map((interval, lvl) => {
        const last = lodSnapshots[lvl];
        if (last.length === 0) return 0n;
        // Next expected snapshot time = last stored ts + interval
        return last[last.length - 1].ts + interval;
    });

    for (let i = 0; i < events.length; i++) {
        if (i > 0 && i % INIT_CHUNK_SIZE === 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }

        const event = events[i];
        const ts = isoToNs(event.ts_event);

        for (let lvl = 0; lvl < levels; lvl++) {
            const interval = LOD_INTERVALS_NS[lvl];
            while (ts >= nextSnapTimes[lvl]) {
                lodSnapshots[lvl].push(snapshotToArrays(book, nextSnapTimes[lvl]));
                nextSnapTimes[lvl] += interval;
            }
        }

        applyEvent(book, event);
        datasetTMax = ts;
    }

    // Push a trailing snapshot at the last event
    if (events.length > 0) {
        for (let lvl = 0; lvl < levels; lvl++) {
            lodSnapshots[lvl].push(snapshotToArrays(book, datasetTMax));
        }
    }

    masterSnapshots = lodSnapshots[0];
}

// Persistent book for incremental append - survives between append calls
//@ts-ignore
const appendBook: BookState = { bids: new Map(), asks: new Map() };

/** Pick the LOD level whose interval best matches the current ns-per-pixel density. */
function pickLodLevel(nsPerPixel: number): Snapshot[] {
    // Walk from finest to coarsest; use the finest level where the snapshot
    // density doesn't exceed LOD_RATIO columns per pixel.
    for (let lvl = 0; lvl < LOD_INTERVALS_NS.length; lvl++) {
        const intervalNs = Number(LOD_INTERVALS_NS[lvl]);
        if (intervalNs >= nsPerPixel / LOD_RATIO) {
            return lodSnapshots[lvl] ?? masterSnapshots;
        }
    }
    return lodSnapshots[lodSnapshots.length - 1] ?? masterSnapshots;
}

// Convert book Maps -> flat sorted Float64Arrays (no allocation during render)
// Reusable scratch maps - avoids allocating new Maps on every snapshot.
// Safe because snapshotToArrays is always called synchronously (never concurrent).
const _bidScratch = new Map<number, number>();
const _askScratch = new Map<number, number>();

function snapshotToArrays(book: BookState, ts: bigint): Snapshot {
    _bidScratch.clear();
    _askScratch.clear();

    for (const o of (book.bids as Map<string, { price: number; size: number }>).values()) {
        const r = Math.round(o.price * 100) / 100;
        _bidScratch.set(r, (_bidScratch.get(r) ?? 0) + o.size);
    }
    for (const o of (book.asks as Map<string, { price: number; size: number }>).values()) {
        const r = Math.round(o.price * 100) / 100;
        _askScratch.set(r, (_askScratch.get(r) ?? 0) + o.size);
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

    // Sort bids high->low, asks low->high - typed array sort is in-place, no extra alloc
    // We sort pairs by swapping, using a simple insertion sort shim on Float64Array pairs
    sortPairs(bids, true);
    sortPairs(asks, false);

    return { ts, bids, asks };
}

/** Sort a flat [price, size, price, size, ...] Float64Array by price.
 *  highToLow=true for bids, false for asks. Uses insertion sort - O(n²) but
 *  the number of price levels is small (~50-500) so it's faster than creating
 *  an intermediate array for Array.sort. */
function sortPairs(arr: Float64Array, highToLow: boolean): void {
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

// Render: direct single-pass paint, no tile compositing
//
// The old tile approach keyed on pMin/pMax, so every vertical pan/zoom blew
// the entire cache and forced a full repaint. Now we render straight to one
// full-width OffscreenCanvas per request - simpler, faster, and correct on
// price zoom without any cache invalidation logic.

function renderView(
    bounds: ViewBounds,
    chartW: number,
    chartH: number,
    horizon: bigint | null = null,
): ImageBitmap | null {
    if (lodSnapshots.length === 0 && masterSnapshots.length === 0) return null;

    const tRangeNs = Number(bounds.tMax - bounds.tMin);
    const nsPerPixel = tRangeNs / chartW;

    // Pick the LOD level whose granularity matches the current zoom.
    const snapshots = pickLodLevel(nsPerPixel);
    if (snapshots.length === 0) return null;

    // Find the slice of snapshots that overlap the visible window.
    let first = bsFloor(snapshots, bounds.tMin);
    let last = bsCeil(snapshots, bounds.tMax);

    if (first === -1) first = 0;
    else first = Math.max(0, first - 1);

    if (last === -1) last = snapshots.length - 1;
    else last = Math.min(snapshots.length - 1, last + 1);

    // Playback horizon: clamp last to the last snapshot at or before the
    // horizon. The i === last -> xEnd = chartW - 1 forward-fill in paintSnapshots
    // then holds that final column flat to the right edge.
    if (horizon !== null) {
        const horizonLast = bsFloor(snapshots, horizon);
        if (horizonLast !== -1 && horizonLast < last) last = horizonLast;
    }

    if (first > last) return null;

    const offscreen = new OffscreenCanvas(chartW, chartH);
    const ctx = offscreen.getContext('2d') as OffscreenCanvasRenderingContext2D;
    if (!ctx) return null;

    paintSnapshots(ctx, snapshots, first, last, bounds, chartW, chartH);

    return offscreen.transferToImageBitmap();
}

// Core pixel painter
function paintSnapshots(
    ctx: OffscreenCanvasRenderingContext2D,
    snapshots: Snapshot[],
    first: number,
    last: number,
    bounds: ViewBounds,
    chartW: number,
    chartH: number,
): void {
    const tRange = Number(bounds.tMax - bounds.tMin);
    const pRange = bounds.pMax - bounds.pMin;
    if (tRange === 0 || pRange === 0) return;

    const snapshotCount = last - first + 1;
    const needsDownsample = snapshotCount > chartW;

    // Build columns
    type Col = { x0: number; x1: number; bids: Float64Array; asks: Float64Array };
    const columns: Col[] = [];

    if (needsDownsample) {
        // Merge snapshots into pixel-wide buckets using max-size per price level.
        // Use plain objects with number keys for fast merging (vs Map).
        const bidBuckets: (Record<number, number> | null)[] = new Array(chartW).fill(null);
        const askBuckets: (Record<number, number> | null)[] = new Array(chartW).fill(null);

        for (let i = first; i <= last; i++) {
            const snap = snapshots[i];
            const col = Math.min(
                chartW - 1,
                Math.max(0, Math.round((Number(snap.ts - bounds.tMin) / tRange) * chartW)),
            );

            if (!bidBuckets[col]) bidBuckets[col] = {};
            if (!askBuckets[col]) askBuckets[col] = {};
            const bb = bidBuckets[col]!;
            const ab = askBuckets[col]!;

            const bids = snap.bids;
            for (let j = 0; j < bids.length; j += 2) {
                const p = bids[j],
                    s = bids[j + 1];
                if (bb[p] === undefined || s > bb[p]) bb[p] = s;
            }
            const asks = snap.asks;
            for (let j = 0; j < asks.length; j += 2) {
                const p = asks[j],
                    s = asks[j + 1];
                if (ab[p] === undefined || s > ab[p]) ab[p] = s;
            }
        }

        // Forward-fill empty columns and convert to sorted Float64Arrays
        let lastBids: Float64Array = new Float64Array(0);
        let lastAsks: Float64Array = new Float64Array(0);
        for (let col = 0; col < chartW; col++) {
            if (bidBuckets[col]) {
                lastBids = recordToSortedArray(bidBuckets[col]!, true);
                lastAsks = recordToSortedArray(askBuckets[col]!, false);
            }
            if (lastBids.length > 0) {
                columns.push({ x0: col, x1: col, bids: lastBids, asks: lastAsks });
            }
        }
    } else {
        // Compute all xStarts first as integers
        const xStarts: number[] = [];
        for (let i = first; i <= last; i++) {
            xStarts.push(Math.round((Number(snapshots[i].ts - bounds.tMin) / tRange) * chartW));
        }

        for (let i = 0; i < xStarts.length; i++) {
            const snap = snapshots[first + i];
            const x0 = Math.max(0, xStarts[i]);
            // Extend right up to where the next snapshot starts - guarantees no gaps
            const x1 = i === xStarts.length - 1 ? chartW - 1 : Math.max(x0, xStarts[i + 1] - 1);
            if (x1 < 0 || x0 >= chartW) continue;
            columns.push({ x0, x1, bids: snap.bids, asks: snap.asks });
        }
    }

    // Find global max for normalisation
    let maxSize = 1;
    for (const col of columns) {
        for (let j = 1; j < col.bids.length; j += 2)
            if (col.bids[j] > maxSize) maxSize = col.bids[j];
        for (let j = 1; j < col.asks.length; j += 2)
            if (col.asks[j] > maxSize) maxSize = col.asks[j];
    }
    const logMax = Math.log1p(maxSize);

    // Write pixels
    const imageData = ctx.createImageData(chartW, chartH);
    const data = imageData.data;

    const paintSide = (arr: Float64Array, isBid: boolean, x0: number, x1: number) => {
        const len = arr.length;
        for (let i = 0; i < len; i += 2) {
            const price = arr[i];
            const size = arr[i + 1];

            // Encode raw log-intensity (0-1) into alpha channel at full range.
            // Contrast remapping happens on the main thread as a fast pixel pass -
            // no re-render needed when the user drags the contrast slider.
            const intensity = Math.log1p(size) / logMax; // 0..1
            const alpha = (intensity * 210 + 0.5) | 0; // 0..210
            if (alpha === 0) continue;

            // Colours at full saturation (intensity=1).
            // The main thread contrast pass only touches alpha, not RGB.
            let r: number, g: number, b: number;
            if (isBid) {
                r = 20;
                g = 220;
                b = 80;
            } else {
                r = 255;
                g = 30;
                b = 50;
            }

            const yThis = (chartH - ((price - bounds.pMin) / pRange) * chartH + 0.5) | 0;
            const nextPrice = i + 2 < len ? arr[i + 2] : isBid ? -Infinity : Infinity;
            const yNext =
                i + 2 < len
                    ? (chartH - ((nextPrice - bounds.pMin) / pRange) * chartH + 0.5) | 0
                    : isBid
                      ? chartH
                      : 0;

            const yFrom = Math.max(0, yThis < yNext ? yThis : yNext);
            const yTo = Math.min(chartH - 1, (yThis > yNext ? yThis : yNext) - 1);

            for (let y = yFrom; y <= yTo; y++) {
                const rowBase = (y * chartW + x0) * 4;
                for (let x = x0; x <= x1; x++) {
                    const idx = rowBase + (x - x0) * 4;
                    if (data[idx + 3] < alpha) {
                        data[idx] = r;
                        data[idx + 1] = g;
                        data[idx + 2] = b;
                        data[idx + 3] = alpha;
                    }
                }
            }
        }
    };

    for (const col of columns) {
        paintSide(col.bids, true, col.x0, col.x1);
        paintSide(col.asks, false, col.x0, col.x1);
    }

    ctx.putImageData(imageData, 0, 0);
}

// Helpers
function recordToSortedArray(rec: Record<number, number>, highToLow: boolean): Float64Array {
    // Count keys first to size the array exactly - avoids Object.entries allocation
    let count = 0;
    for (const _ in rec) count++;
    const arr = new Float64Array(count * 2);
    let i = 0;
    for (const k in rec) {
        arr[i++] = +k;
        arr[i++] = rec[k as any];
    }
    sortPairs(arr, highToLow);
    return arr;
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

function bsFloor(arr: { ts: bigint }[], target: bigint): number {
    let lo = 0,
        hi = arr.length - 1,
        r = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (arr[mid].ts <= target) {
            r = mid;
            lo = mid + 1;
        } else hi = mid - 1;
    }
    return r;
}

function bsCeil(arr: { ts: bigint }[], target: bigint): number {
    let lo = 0,
        hi = arr.length - 1,
        r = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (arr[mid].ts >= target) {
            r = mid;
            hi = mid - 1;
        } else lo = mid + 1;
    }
    return r;
}
