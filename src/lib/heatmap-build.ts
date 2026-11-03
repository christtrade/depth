import type { MboEvent, BookState } from './types';
import { type Replay, levelsAt, peakColumns } from './heatmap-replay';

// for the columns too wide to replay
export const LOD_INTERVALS_NS: bigint[] = [
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

// ticks per heatmap row
export function rowTicks(tickPx: number, minPx: number): number {
    if (!(tickPx > 0)) return 1;
    let n = 1;
    while (tickPx * n < minPx && n < 2 ** 30) n *= 2;
    return n;
}

// [price, size, ...] sorted by price -> [row, summed size, ...]
export function sumRows(pairs: Float64Array, tickSize: number, ticks: number): Float64Array {
    const out = new Float64Array(pairs.length);
    let n = 0;
    for (let i = 0; i < pairs.length; i += 2) {
        const row = Math.floor(Math.round(pairs[i] / tickSize) / ticks);
        if (n > 0 && out[n - 2] === row) out[n - 1] += pairs[i + 1];
        else {
            out[n++] = row;
            out[n++] = pairs[i + 1];
        }
    }
    return out.slice(0, n);
}

// tile column widths. the chart uses the narrowest thats at least a px wide
export const COLUMN_NS: bigint[] = [
    1_000_000n,
    5_000_000n,
    25_000_000n,
    100_000_000n,
    250_000_000n,
    1_000_000_000n,
    5_000_000_000n,
    30_000_000_000n,
    120_000_000_000n,
    600_000_000_000n,
    3_600_000_000_000n,
];
export const TILE_COLS = 256;
// a book thousands of rows deep keeps these around its middle
export const MAX_TILE_ROWS = 2048;

export function columnFor(nsPerPx: number): number {
    for (let i = 0; i < COLUMN_NS.length; i++) if (Number(COLUMN_NS[i]) >= nsPerPx) return i;
    return COLUMN_NS.length - 1;
}

// the snapshots a column's peaks come from, a few per column at most
export function sourceLevel(column: number): number {
    const c = COLUMN_NS[column];
    let lvl = 0;
    for (let i = 0; i < LOD_INTERVALS_NS.length; i++) if (LOD_INTERVALS_NS[i] * 4n <= c) lvl = i;
    return lvl;
}

// a 1s tile is 256s of events, a few ms to replay
const REPLAY_MAX_NS = 1_000_000_000n;
export const replayed = (column: number) => COLUMN_NS[column] <= REPLAY_MAX_NS;

export type Source = { snaps: Snapshot[][]; replay: Replay | null };

export type TileParams = { column: number; tickSize: number; ticks: number; norm: number; contrast: number; palette: string };

export type Texels = {
    rowLo: number;
    rows: number;
    cols: number;
    data: Uint8ClampedArray;
};

type Col = { bids: Float64Array; asks: Float64Array } | null;

export function firstAtOrAfter(snaps: Snapshot[], ts: bigint): number {
    let lo = 0,
        hi = snaps.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (snaps[mid].ts < ts) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

// each price's peak over the snapshots in from, to
function peakColumn(snaps: Snapshot[], from: bigint, to: bigint): Col {
    const i0 = firstAtOrAfter(snaps, from);
    if (i0 >= snaps.length || snaps[i0].ts >= to) return null;
    if (i0 + 1 >= snaps.length || snaps[i0 + 1].ts >= to) return snaps[i0];
    const bids = new Map<number, number>();
    const asks = new Map<number, number>();
    for (let i = i0; i < snaps.length && snaps[i].ts < to; i++) {
        const s = snaps[i];
        for (let j = 0; j < s.bids.length; j += 2) if (!(bids.get(s.bids[j])! >= s.bids[j + 1])) bids.set(s.bids[j], s.bids[j + 1]);
        for (let j = 0; j < s.asks.length; j += 2) if (!(asks.get(s.asks[j])! >= s.asks[j + 1])) asks.set(s.asks[j], s.asks[j + 1]);
    }
    const flat = (m: Map<number, number>, highToLow: boolean) => {
        const a = new Float64Array(m.size * 2);
        let k = 0;
        for (const [p, s] of m) {
            a[k++] = p;
            a[k++] = s;
        }
        sortPairs(a, highToLow);
        return a;
    };
    return { bids: flat(bids, true), asks: flat(asks, false) };
}

// thin to big, like bookmap
const HEAT_STOPS: [number, number, number, number][] = [
    [0, 10, 30, 120],
    [0.25, 20, 110, 230],
    [0.45, 30, 200, 220],
    [0.65, 240, 225, 60],
    [0.82, 245, 140, 30],
    [1, 230, 40, 40],
];
const HEAT = new Uint8Array(256 * 3);
for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let s = 1;
    while (s < HEAT_STOPS.length - 1 && HEAT_STOPS[s][0] < t) s++;
    const [t0, ...a] = HEAT_STOPS[s - 1];
    const [t1, ...b] = HEAT_STOPS[s];
    const f = (t - t0) / (t1 - t0);
    for (let c = 0; c < 3; c++) HEAT[i * 3 + c] = Math.round(a[c] + (b[c] - a[c]) * f);
}

const hexRgb = (hex: string) => {
    const n = parseInt(hex.replace('#', '').slice(0, 6), 16);
    return Number.isNaN(n) ? [128, 128, 128] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

export function paintColumns(cols: Col[], p: TileParams): Texels {
    const rowCols = cols.map((c) =>
        c ? { bids: sumRows(c.bids, p.tickSize, p.ticks), asks: sumRows(c.asks, p.tickSize, p.ticks) } : null,
    );
    let lo = Infinity,
        hi = -Infinity;
    for (const c of rowCols) {
        if (!c) continue;
        for (const side of [c.bids, c.asks])
            for (let j = 0; j < side.length; j += 2) {
                if (side[j] < lo) lo = side[j];
                if (side[j] > hi) hi = side[j];
            }
    }
    if (lo > hi) return { rowLo: 0, rows: 0, cols: cols.length, data: new Uint8ClampedArray(0) };
    if (hi - lo + 1 > MAX_TILE_ROWS) {
        const mid = Math.round((lo + hi) / 2);
        lo = mid - MAX_TILE_ROWS / 2;
        hi = lo + MAX_TILE_ROWS - 1;
    }
    const rows = hi - lo + 1;
    const data = new Uint8ClampedArray(cols.length * rows * 4);
    const norm = Math.max(1, p.norm);
    const logMax = Math.log1p(norm);
    const cutoff = (p.contrast * 210 + 0.5) | 0;
    const scale = cutoff >= 210 ? 0 : 210 / (210 - cutoff);
    const heat = p.palette === 'heat';
    const [BID, ASK] = heat ? [[], []] : p.palette.split(',').map(hexRgb);
    const put = (x: number, side: Float64Array, rgb: number[]) => {
        for (let j = 0; j < side.length; j += 2) {
            const row = side[j];
            if (row < lo || row > hi) continue;
            let alpha: number;
            if (heat) {
                // linear, log pushed a 10 lot against a 40 norm into yellow. the color says the size, so a
                // thin level still gets to be seen
                const t = Math.min(1, side[j + 1] / norm);
                if (t <= p.contrast) continue;
                const h = (((t - p.contrast) / (1 - p.contrast)) * 255 + 0.5) | 0;
                rgb = [HEAT[h * 3], HEAT[h * 3 + 1], HEAT[h * 3 + 2]];
                alpha = 60 + ((h * 150) / 255) | 0;
            } else {
                const raw = (Math.min(1, Math.log1p(side[j + 1]) / logMax) * 210 + 0.5) | 0;
                if (raw <= cutoff) continue;
                alpha = Math.min(210, ((raw - cutoff) * scale + 0.5) | 0);
            }
            const i = ((hi - row) * cols.length + x) * 4;
            if (data[i + 3] >= alpha) continue;
            data[i] = rgb[0];
            data[i + 1] = rgb[1];
            data[i + 2] = rgb[2];
            data[i + 3] = alpha;
        }
    };
    rowCols.forEach((c, x) => {
        if (!c) return;
        put(x, c.bids, BID);
        put(x, c.asks, ASK);
    });
    return { rowLo: lo, rows, cols: cols.length, data };
}

export function buildTile(src: Source, k: number, p: TileParams): Texels {
    const c = COLUMN_NS[p.column];
    const t0 = BigInt(k) * BigInt(TILE_COLS) * c;
    if (src.replay && replayed(p.column)) return paintColumns(peakColumns(src.replay, t0, c, TILE_COLS), p);
    const snaps = src.snaps[sourceLevel(p.column)] ?? [];
    const cols: Col[] = [];
    for (let x = 0; x < TILE_COLS; x++) cols.push(peakColumn(snaps, t0 + BigInt(x) * c, t0 + BigInt(x + 1) * c));
    return paintColumns(cols, p);
}

export function bookColumn(src: Source, ts: bigint, p: TileParams): Texels {
    if (src.replay) return paintColumns([levelsAt(src.replay, ts)], p);
    const snaps = src.snaps[0] ?? [];
    const i = firstAtOrAfter(snaps, ts + 1n) - 1;
    return paintColumns([i >= 0 ? snaps[i] : null], p);
}

// brightness scale, the 99th percentile row over up to 512 snapshots spread over from, to
export function rowNorm(levels: Snapshot[][], column: number, tickSize: number, ticks: number, from = 0n, to = -1n): number {
    const snaps = levels[sourceLevel(column)] ?? [];
    const i0 = firstAtOrAfter(snaps, from);
    const i1 = to < 0n ? snaps.length : firstAtOrAfter(snaps, to);
    const n = i1 - i0;
    if (n <= 0) return 1;
    const step = Math.max(1, Math.floor(n / 512));
    const sizes: number[] = [];
    for (let i = i0; i < i1; i += step) {
        for (const side of [snaps[i].bids, snaps[i].asks]) {
            const r = sumRows(side, tickSize, ticks);
            for (let j = 1; j < r.length; j += 2) sizes.push(r[j]);
        }
    }
    if (!sizes.length) return 1;
    sizes.sort((a, b) => a - b);
    return Math.max(1, sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * 0.99))]);
}

// the view's norm once it's 1.5x off either way, so a small pan doesn't flip brightness back and forth
export function pickNorm(current: number, visible: number): number {
    return visible > current * 1.5 || current > visible * 1.5 ? visible : current;
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
