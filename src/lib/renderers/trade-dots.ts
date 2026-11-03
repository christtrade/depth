export type TradeDot = { x: number; price: number; size: number; buySize: number };

type Trade = { ts: bigint; price: number; size: number; side: string };

export const COL_PX = 8;

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
    let sx = 0, sp = 0, sw = 0, size = 0, buySize = 0;
    const flush = () => {
        if (sw > 0) out.push({ x: sx / sw, price: sp / sw, size, buySize });
        sx = sp = sw = size = buySize = 0;
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

const refCache = new WeakMap<Trade[], { colNs: bigint; len: number; ref: SizeRef }>();

// live appends every trade
export function cachedRefSize(trades: Trade[], colNs: bigint): SizeRef {
    const c = refCache.get(trades);
    if (c && c.colNs === colNs && trades.length >= c.len && trades.length <= c.len * 1.1) return c.ref;
    const ref = refSize(trades, colNs);
    refCache.set(trades, { colNs, len: trades.length, ref });
    return ref;
}
