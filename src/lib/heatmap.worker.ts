import {
    type HeatmapRequest,
    type HeatmapResponse,
    type WorkerInitMessage,
} from './types/heatmap-types';
import type { MboEvent } from './types';
import { createCompactBuffer, sliceToMboEvents } from './compact-buffer';
import type { ViewBounds } from './types';
import {
    type Build,
    type Snapshot,
    LOD_INTERVALS_NS,
    feed,
    newBuild,
    seal,
    sortPairs,
    unseal,
} from './heatmap-build';

// How many columns-per-pixel we tolerate before stepping up to a coarser level.
// 3 = switch levels when the snapshot count exceeds 3x the canvas width.
const LOD_RATIO = 3;

// One snapshot array per LOD level, indexed same as LOD_INTERVALS_NS.
let lodSnapshots: Snapshot[][] = [];
let masterSnapshots: Snapshot[] = []; // alias -> finest level for compat
// Pending render request received before init completed
let pendingRender: (HeatmapRequest & { type: 'render' }) | null = null;
let lastRender: (HeatmapRequest & { type: 'render' }) | null = null;
let initDone = false;
let buildGen = 0;

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

function decode(msg: WorkerInitMessage): MboEvent[] {
    const cb = createCompactBuffer(0);
    cb._buf = msg.buf;
    cb._view = new DataView(msg.buf);
    cb.length = cb.capacity = msg.length;
    return sliceToMboEvents(cb, 0, msg.length);
}

// builds run one after another so an append always lands on the build before it
let chain: Promise<unknown> = Promise.resolve();

// Message router
self.onmessage = (e: MessageEvent<WorkerInitMessage | HeatmapRequest>) => {
    const msg = e.data;

    if (msg.type === 'init' || msg.type === 'append') {
        // keep drawing old snapshots while an init bulds and a newer init stops it
        const gen = msg.type === 'init' ? ++buildGen : buildGen;
        chain = chain.then(async () => {
            // a newer init holds these events too
            if (gen !== buildGen) return;
            if (msg.type === 'init') {
                const fresh = newBuild();
                if (!(await feed(fresh, decode(msg), () => gen !== buildGen))) return;
                build = fresh;
            } else {
                if (!build) return;
                unseal(build);
                await feed(build, decode(msg));
            }
            seal(build);
            lodSnapshots = build.snaps;
            masterSnapshots = build.snaps[0];
            initDone = true;
            if (pendingRender) {
                const req = pendingRender;
                pendingRender = null;
                pendingRenderReq = req;
                flushRender();
            } else if (lastRender) {
                // same view new data
                pendingRenderReq = lastRender;
                flushRender();
            }
        });
        return;
    }

    if (msg.type === 'render') {
        lastRender = msg;
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

let build: Build | null = null;

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
