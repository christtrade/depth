import { MAX_DOT_RADIUS, MIN_DOT_RADIUS } from '../constants';

export type TradeDot = { x: number; price: number; size: number; buySize: number; count: number; ts: bigint };

type Trade = { ts: bigint; price: number; size: number; side: string };

export const COL_PX = 8;
const PICK_SLACK_PX = 4;

// power of 2 ns so a column holds the same trades wherever you pan, it only changes when the zoom doubles
export function columnNs(nsPerPx: number): bigint {
    let ns = 1n;
    const want = nsPerPx * COL_PX;
    while (Number(ns) < want && ns < 1n << 62n) ns <<= 1n;
    return ns;
}

// bookmap style, one bubble per time column holding both sides, at the volume weighted price and time
export function tradeDots(
    trades: Trade[],
    from: bigint,
    to: bigint,
    xOf: (ts: bigint) => number,
    colNs: bigint,
): TradeDot[] {
    const out: TradeDot[] = [];
    let col = -1n;
    let sx = 0, sp = 0, sw = 0, size = 0, buySize = 0, count = 0, first = 0n;
    const flush = () => {
        if (sw > 0) out.push({ x: sx / sw, price: sp / sw, size, buySize, count, ts: first });
        sx = sp = sw = size = buySize = count = 0;
    };
    let lo = 0, hi = trades.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (trades[mid].ts < from) lo = mid + 1;
        else hi = mid;
    }
    for (let i = lo; i < trades.length; i++) {
        const t = trades[i];
        if (t.ts > to) break;
        const c = t.ts / colNs;
        if (c !== col) {
            flush();
            col = c;
        }
        if (count === 0) first = t.ts;
        count++;
        const w = t.size > 0 ? t.size : 1;
        sx += xOf(t.ts) * w;
        sp += t.price * w;
        sw += w;
        size += t.size;
        if (t.side === 'B') buySize += t.size;
    }
    flush();
    return out;
}

// a zoom changes the column and live grows it, so a selection regroups from its time
export function dotAt(
    trades: Trade[],
    ts: bigint,
    from: bigint,
    to: bigint,
    xOf: (ts: bigint) => number,
    colNs: bigint,
): TradeDot | null {
    const start = (ts / colNs) * colNs;
    const end = start + colNs - 1n;
    const lo = start > from ? start : from;
    const hi = end < to ? end : to;
    if (lo > hi) return null;
    return tradeDots(trades, lo, hi, xOf, colNs)[0] ?? null;
}

// dots in draw order, the last one covering the cursor is the one on top
export function pickDot(
    dots: TradeDot[],
    px: number,
    py: number,
    yOf: (price: number) => number,
    radiusOf: (dot: TradeDot) => number,
): TradeDot | null {
    let onTop: TradeDot | null = null;
    let near: TradeDot | null = null;
    let nearGap = PICK_SLACK_PX;
    for (const d of dots) {
        const gap = Math.hypot(d.x - px, yOf(d.price) - py) - radiusOf(d);
        if (gap <= 0) onTop = d;
        else if (gap < nearGap) {
            nearGap = gap;
            near = d;
        }
    }
    return onTop ?? near;
}

const fmtSize = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 8 });

export function dotRows(d: TradeDot, price: string, time: string): [string, string][] {
    const buyPct = d.size > 0 ? Math.round((d.buySize / d.size) * 100) : 0;
    const sellPct = d.size > 0 ? 100 - buyPct : 0;
    return [
        ['Total', fmtSize(d.size)],
        ['Buy', `${fmtSize(d.buySize)}  ${buyPct}%`],
        ['Sell', `${fmtSize(d.size - d.buySize)}  ${sellPct}%`],
        ['VWAP', price],
        ['Trades', d.count.toString()],
        ['Time', time],
    ];
}

export type SizeRef = { mid: number; top: number };

// median and 99th percentile column over everything loaded, not the screen, so a size doesn't jump as you pan
export function refSize(trades: Trade[], colNs: bigint): SizeRef {
    const sums: number[] = [];
    let col = -1n;
    let sum = 0;
    for (const t of trades) {
        const c = t.ts / colNs;
        if (c !== col) {
            if (sum > 0) sums.push(sum);
            col = c;
            sum = 0;
        }
        sum += t.size;
    }
    if (sum > 0) sums.push(sum);
    if (sums.length === 0) return { mid: 0, top: 1 };
    sums.sort((a, b) => a - b);
    const top = Math.max(1, sums[Math.min(sums.length - 1, Math.floor(sums.length * 0.99))]);
    return { mid: Math.min(sums[sums.length >> 1], top / 2), top };
}

// 0..1, the usual column small and only the big prints grow
export function sizeT(size: number, ref: SizeRef): number {
    const lo = ref.mid / 2;
    return Math.min(1, Math.max(0, (size - lo) / (ref.top - lo)) ** 0.75);
}

export function dotRadius(size: number, ref: SizeRef, mult: number): number {
    const maxR = MAX_DOT_RADIUS * (1 + (mult - 1) / 2);
    return MIN_DOT_RADIUS + sizeT(size, ref) * (maxR - MIN_DOT_RADIUS);
}

const refCache = new WeakMap<Trade[], { colNs: bigint; len: number; ref: SizeRef }>();

// live appends every trade
export function cachedRefSize(trades: Trade[], colNs: bigint): SizeRef {
    const c = refCache.get(trades);
    if (c && c.colNs === colNs && trades.length >= c.len && trades.length <= c.len * 1.1) return c.ref;
    const ref = refSize(trades, colNs);
    refCache.set(trades, { colNs, len: trades.length, ref });
    return ref;
}
