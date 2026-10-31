import { getEvent, getTsNs, type CompactBuffer } from './compact-buffer';
import { footprintFromTrades, type FootprintBar, type FootprintOptions } from './types/footprint';
import type { SerialTrade } from './types';

// the forming bar from events [from, to] built like closed ones
export function openBarFrom(
    cb: CompactBuffer,
    from: number,
    to: number,
    barNs: bigint,
    opts: FootprintOptions = {},
): FootprintBar | null {
    const trades: SerialTrade[] = [];
    for (let i = from; i <= to; i++) {
        const ev = getEvent(cb, i);
        if (ev.action !== 'T' || ev.price === null || ev.side === 'N') continue;
        trades.push({ ts: getTsNs(cb, i), price: ev.price, size: ev.size, side: ev.side });
    }
    return footprintFromTrades(trades, barNs, opts)[0] ?? null;
}
