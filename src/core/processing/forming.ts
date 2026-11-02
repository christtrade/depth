import type { FetchResponse, TickEvent } from '../../interfaces/IDataAdapter';
import type { MboEvent } from '../../lib/types';
import { isoToNs } from '../../lib/sampler';

// the raw items of the newest bucket
// they're kept so the next chunk can rebuild that bucket whole
export interface Forming {
    bucket: bigint;
    items: (TickEvent | MboEvent)[];
}

type Level = 'tick' | 'l3' | 'l2';
type Item = TickEvent | MboEvent;

const raw = (level: string): level is Level => level === 'tick' || level === 'l3' || level === 'l2';

const field = (level: Level) => (level === 'tick' ? 'ticks' : 'mbo');

const tsOf = (level: Level, it: Item): bigint =>
    level === 'tick'
        ? BigInt((it as TickEvent).time) * 1_000_000n
        : isoToNs((it as MboEvent).ts_event);

function keyOf(level: Level, it: Item): string {
    if (level === 'tick') {
        const t = it as TickEvent;
        return `${t.time}|${t.price}|${t.size}|${t.side}`;
    }
    const e = it as MboEvent;
    return `${e.ts_event}|${e.action}|${e.side}|${e.price}|${e.size}|${e.order_id}|${e.sequence}`;
}

function itemsOf(level: Level, response: FetchResponse): Item[] | null {
    if (response._preProcessed) return null;
    return ((level === 'tick' ? response.ticks : response.mbo) as Item[] | undefined) ?? [];
}

export function formingOf(level: string, response: FetchResponse, barNs: bigint): Forming | null {
    if (!raw(level) || barNs <= 0n) return null;
    const items = itemsOf(level, response);
    if (!items?.length) return null;
    const last = tsOf(level, items[items.length - 1]);
    const bucket = last - (last % barNs);
    let i = items.length;
    while (i > 0 && tsOf(level, items[i - 1]) >= bucket) i--;
    return { bucket, items: items.slice(i) };
}

// the forming bucket at a finer period
export function narrowForming(
    level: string,
    forming: Forming | null,
    barNs: bigint,
): { forming: Forming; before: Item[] } | null {
    if (!raw(level) || barNs <= 0n || !forming?.items.length) return null;
    const items = forming.items;
    const last = tsOf(level, items[items.length - 1]);
    const bucket = last - (last % barNs);
    if (bucket < forming.bucket) return null;
    let i = items.length;
    while (i > 0 && tsOf(level, items[i - 1]) >= bucket) i--;
    return { forming: { bucket, items: items.slice(i) }, before: items.slice(0, i) };
}

// a chunk joined onto what's held
// so anything it re-sends is dropped, and if it carries on the forming bucket the held items
// go in front so that bucket gets built whole.
export function joinForming(
    level: string,
    forming: Forming | null,
    response: FetchResponse,
    barNs: bigint,
): { response: FetchResponse; trimFromNs: bigint | null } | null {
    if (!raw(level)) return { response, trimFromNs: null };
    const items = itemsOf(level, response);
    if (items === null) return { response, trimFromNs: null };
    if (!items.length) return null;
    if (!forming?.items.length) return { response, trimFromNs: null };

    const lastTs = tsOf(level, forming.items[forming.items.length - 1]);
    const held = new Map<string, number>();
    for (const it of forming.items) {
        const k = keyOf(level, it);
        held.set(k, (held.get(k) ?? 0) + 1);
    }

    const kept: Item[] = [];
    let late = false;
    for (const it of items) {
        const ts = tsOf(level, it);
        if (ts <= lastTs) {
            const k = keyOf(level, it);
            const n = held.get(k);
            if (n) {
                held.set(k, n - 1);
                continue;
            }
            if (ts < forming.bucket) continue;
            if (ts < lastTs) late = true;
        }
        kept.push(it);
    }
    if (!kept.length) return null;

    const first = tsOf(level, kept[0]);
    if (barNs <= 0n || first - (first % barNs) !== forming.bucket) {
        return { response: { ...response, [field(level)]: kept }, trimFromNs: null };
    }
    const merged = forming.items.concat(kept);
    // sort is stable, so equal timestamps keep their order
    if (late) {
        merged.sort((a, b) => {
            const d = tsOf(level, a) - tsOf(level, b);
            return d < 0n ? -1 : d > 0n ? 1 : 0;
        });
    }
    return { response: { ...response, [field(level)]: merged }, trimFromNs: forming.bucket };
}
