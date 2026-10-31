import type { TickEvent } from '../interfaces/IDataAdapter';
import type { MboEvent } from './types';

// tick and l3 data as pure fns of time
// so pages join and every refetch agrees

export interface SimLevelOptions {
    /** default 0.01 */
    tickSize?: number;
    /** one slot of activity per this many ms. Default 100. */
    slotMs?: number;
    seed?: number;
    /** l3: how many ticks from the mid an order can rest. Default 8. */
    levels?: number;
    /** l3: slots an order rests before it's canceled, unless the mid reaches it first. Default 50. */
    lifeSlots?: number;
    /** l3: one order in this many is a wall, 12x the size. Default 0, none. */
    wallOdds?: number;
}

function hash(k: number, salt: number, seed: number): number {
    let x = Math.imul((k >>> 0) ^ seed, 0x9e3779b1) ^ Math.imul(Math.floor(k / 4294967296), 0x85ebca6b);
    x = Math.imul(x ^ salt ^ (x >>> 15), 0x85ebca6b);
    x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
    return (x ^ (x >>> 16)) >>> 0;
}

function setup(price: (ms: number) => number, fromMs: number, toMs: number, o: SimLevelOptions) {
    // setup these
    const tick = o.tickSize ?? 0.01;
    const slot = o.slotMs ?? 100;
    const seed = o.seed ?? 0;
    const levels = o.levels ?? 8;
    const life = o.lifeSlots ?? 50;
    const k0 = Math.ceil(fromMs / slot);
    const k1 = Math.max(k0, Math.ceil(toMs / slot));

    // set up mids
    // mid in ticks, life either side of the range for the orders that straddle it
    const base = k0 - life;
    const mids = new Float64Array(k1 + life - base);
    for (let i = 0; i < mids.length; i++) mids[i] = Math.round(price((base + i) * slot) / tick);
    const mid = (k: number) => mids[k - base];
    return { tick, slot, seed, levels, life, k0, k1, mid };
}

type Trade = { side: 'B' | 'A'; ticks: number; size: number };

function tradeAt(k: number, mid: (k: number) => number, seed: number): Trade | null {
    if (hash(k, 3, seed) % 10 >= 6) return null;
    const dq = mid(k) - mid(k - 1);
    const side = dq > 0 ? 'B' : dq < 0 ? 'A' : hash(k, 4, seed) & 1 ? 'B' : 'A';
    // a buy lifts the nearest ask and a sell hits the nearest bid
    return { side, ticks: side === 'B' ? mid(k) + 1 : mid(k) - 1, size: 1 + (hash(k, 5, seed) % 5) };
}

export function simTicks(
    price: (ms: number) => number,
    fromMs: number,
    toMs: number,
    opts: SimLevelOptions = {},
): TickEvent[] {
    const { tick, slot, seed, k0, k1, mid } = setup(price, fromMs, toMs, opts);
    const out: TickEvent[] = [];
    for (let k = k0; k < k1; k++) {
        const t = tradeAt(k, mid, seed);
        if (t) out.push({ time: k * slot, price: t.ticks * tick, size: t.size, side: t.side });
    }
    return out;
}

// 1 bid and 1 ask added per slot, each canceled once the mid reaches it or after life_slots. so that
// the book never crosses.
// Trades carry order_id 0 and leave the book alone
export function simMboEvents(
    price: (ms: number) => number,
    fromMs: number,
    toMs: number,
    opts: SimLevelOptions = {},
): MboEvent[] {
    const { tick, slot, seed, levels, life, k0, k1, mid } = setup(price, fromMs, toMs, opts);
    const wallOdds = opts.wallOdds ?? 0;
    type Order = { id: number; side: 'B' | 'A'; ticks: number; size: number };
    const orderAt = (k: number, side: 'B' | 'A'): Order => {
        // most rest near the mid, or a deep book leaves the touch empty and the spread wide
        const u = hash(k, side === 'B' ? 1 : 2, seed) / 4294967296;
        const away = 1 + Math.floor(levels * u * u);
        const size = 1 + (hash(k, side === 'B' ? 6 : 7, seed) % 20);
        const wall = wallOdds > 0 && hash(k, side === 'B' ? 8 : 9, seed) % wallOdds === 0;
        return {
            id: 2 * k + (side === 'A' ? 1 : 0),
            side,
            ticks: side === 'B' ? mid(k) - away : mid(k) + away,
            size: wall ? size * 12 : size,
        };
    };

    const cancels: Order[][] = Array.from({ length: k1 - k0 }, () => []);
    for (let k = k0 - life; k < k1; k++) {
        for (const side of ['B', 'A'] as const) {
            const o = orderAt(k, side);
            let end = k + life;
            for (let j = k + 1; j < k + life; j++) {
                if (side === 'B' ? mid(j) <= o.ticks : mid(j) >= o.ticks) {
                    end = j;
                    break;
                }
            }
            if (end >= k0 && end < k1) cancels[end - k0].push(o);
        }
    }

    const out: MboEvent[] = [];
    for (let k = k0; k < k1; k++) {
        const ts_event = new Date(k * slot).toISOString();
        let seq = k * 16;
        const ev = (action: MboEvent['action'], side: 'B' | 'A', ticks: number, size: number, id: number) =>
            out.push({
                ts_event,
                action,
                side,
                price: ticks * tick,
                size,
                order_id: String(id),
                sequence: seq++,
                flags: 0,
            });
        for (const o of cancels[k - k0]) ev('C', o.side, o.ticks, o.size, o.id);
        for (const side of ['B', 'A'] as const) {
            const o = orderAt(k, side);
            ev('A', side, o.ticks, o.size, o.id);
        }
        const t = tradeAt(k, mid, seed);
        if (t) ev('T', t.side, t.ticks, t.size, 0);
    }
    return out;
}
