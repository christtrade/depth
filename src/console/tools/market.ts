import type { SymbolInfo } from '../../interfaces/IDataAdapter';

// idx of the 1st trade after `ts`, everything before it has happened at the horizon
export function upperBound(rows: readonly { ts: bigint }[], ts: bigint): number {
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (rows[mid].ts <= ts) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

export function tickOf(info: SymbolInfo | null, prices: number[]): number {
    const i = info as unknown as { priceFormat?: { minTick?: number }; tickSize?: number; contract?: { tickSize?: number } } | null;
    const known = i?.priceFormat?.minTick ?? i?.tickSize ?? i?.contract?.tickSize;
    if (known && known > 0) return known;

    const sorted = [...new Set(prices)].sort((a, b) => a - b);
    let gap = Infinity;
    for (let k = 1; k < sorted.length; k++) gap = Math.min(gap, sorted[k] - sorted[k - 1]);

    return Number.isFinite(gap) && gap > 0 ? Number(gap.toPrecision(6)) : 0.01;
}

export function decimalsOf(tick: number): number {
    const s = String(tick);
    if (s.includes('e-')) return Number(s.split('e-')[1]);
    return s.includes('.') ? s.split('.')[1].length : 0;
}
