import { BYTES_PER_EVENT } from './compact-buffer';

type Order = { price: number; size: number };
type Level = { size: number; n: number };
type Side = { orders: Map<number | string, Order>; levels: Map<number, Level> };
type Book = { bids: Side; asks: Side };

type Checkpoint = {
    index: number;
    lo: Uint32Array;
    hi: Uint32Array;
    price: Float64Array;
    size: Float64Array;
    bid: Uint8Array;
};

export type Levels = { bids: Float64Array; asks: Float64Array };

export type Replay = {
    buf: ArrayBuffer;
    view: DataView;
    length: number;
    // events between checkpoints, replay time grows with it
    every: number;
    checkpoints: Checkpoint[];
    head: Book;
    cursor: { book: Book; index: number } | null;
};

const TWO_32 = 2 ** 32;
const YIELD_EVERY = 5_000;

const newSide = (): Side => ({ orders: new Map(), levels: new Map() });
const newBook = (): Book => ({ bids: newSide(), asks: newSide() });

export function newReplay(every = 50_000): Replay {
    return {
        buf: new ArrayBuffer(0),
        view: new DataView(new ArrayBuffer(0)),
        length: 0,
        every,
        checkpoints: [],
        head: newBook(),
        cursor: null,
    };
}

export const tsAt = (r: Replay, i: number) => r.view.getBigInt64(i * BYTES_PER_EVENT, true);

export function heldBytes(r: Replay): number {
    let n = r.buf.byteLength;
    for (const c of r.checkpoints) n += c.lo.length * 25;
    return n;
}

// first event at or after ts
export function indexAt(r: Replay, ts: bigint): number {
    let lo = 0,
        hi = r.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (tsAt(r, mid) < ts) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

const keyOf = (lo: number, hi: number) => (hi < 2 ** 21 ? hi * TWO_32 + lo : `${hi}:${lo}`);

function take(s: Side, key: number | string, touched?: Set<number>): void {
    const o = s.orders.get(key);
    if (!o) return;
    s.orders.delete(key);
    drop(s, o, touched);
}

function drop(s: Side, o: Order, touched?: Set<number>): void {
    const l = s.levels.get(o.price);
    if (!l) return;
    if (--l.n === 0) s.levels.delete(o.price);
    else l.size -= o.size;
    touched?.add(o.price);
}

function put(s: Side, o: Order, touched?: Set<number>): void {
    const l = s.levels.get(o.price);
    if (l) {
        l.size += o.size;
        l.n++;
    } else s.levels.set(o.price, { size: o.size, n: 1 });
    touched?.add(o.price);
}

// the same book the snapshot build keeps
function apply(book: Book, view: DataView, i: number, tb?: Set<number>, ta?: Set<number>): void {
    const base = i * BYTES_PER_EVENT;
    const packed = view.getUint8(base + 31);
    const action = (packed >> 4) & 0xf;
    if (action === 5) {
        book.bids = newSide();
        book.asks = newSide();
        return;
    }
    const key = keyOf(view.getUint32(base + 24, true), view.getUint16(base + 28, true) | (view.getUint8(base + 30) << 16));
    if (action === 3 || action === 4) {
        take(book.bids, key, tb);
        take(book.asks, key, ta);
        return;
    }
    const bid = ((packed >> 2) & 0x3) === 0;
    const s = bid ? book.bids : book.asks;
    const touched = bid ? tb : ta;
    const price = view.getFloat64(base + 8, true);
    const size = view.getFloat64(base + 16, true);
    if (action === 0) {
        if (Number.isNaN(price)) return;
        take(s, key, touched);
        const o = { price, size };
        s.orders.set(key, o);
        put(s, o, touched);
    } else if (action === 1) {
        take(s, key, touched);
    } else if (action === 2) {
        const o = s.orders.get(key);
        if (!o) return;
        drop(s, o, touched);
        if (!Number.isNaN(price)) o.price = price;
        o.size = size;
        put(s, o, touched);
    }
}

function checkpoint(book: Book, index: number): Checkpoint {
    const n = book.bids.orders.size + book.asks.orders.size;
    const c: Checkpoint = {
        index,
        lo: new Uint32Array(n),
        hi: new Uint32Array(n),
        price: new Float64Array(n),
        size: new Float64Array(n),
        bid: new Uint8Array(n),
    };
    let k = 0;
    for (const bid of [1, 0]) {
        for (const [key, o] of (bid ? book.bids : book.asks).orders) {
            if (typeof key === 'number') {
                c.lo[k] = key % TWO_32;
                c.hi[k] = Math.floor(key / TWO_32);
            } else {
                const [hi, lo] = key.split(':');
                c.hi[k] = Number(hi);
                c.lo[k] = Number(lo);
            }
            c.price[k] = o.price;
            c.size[k] = o.size;
            c.bid[k++] = bid;
        }
    }
    return c;
}

function restore(c: Checkpoint): Book {
    const book = newBook();
    for (let k = 0; k < c.lo.length; k++) {
        const s = c.bid[k] ? book.bids : book.asks;
        const o = { price: c.price[k], size: c.size[k] };
        s.orders.set(keyOf(c.lo[k], c.hi[k]), o);
        put(s, o);
    }
    return book;
}

// adds n raw events. false when `stale` says a newer build took over
export async function extend(r: Replay, src: ArrayBuffer, n: number, stale?: () => boolean): Promise<boolean> {
    const need = (r.length + n) * BYTES_PER_EVENT;
    if (!r.length && src.byteLength === need) {
        r.buf = src;
        r.view = new DataView(src);
    } else if (need > r.buf.byteLength) {
        const grown = new ArrayBuffer(r.length ? Math.max(need, Math.floor(r.buf.byteLength * 1.5)) : need);
        new Uint8Array(grown).set(new Uint8Array(r.buf, 0, r.length * BYTES_PER_EVENT));
        r.buf = grown;
        r.view = new DataView(grown);
    }
    if (r.buf !== src) new Uint8Array(r.buf).set(new Uint8Array(src, 0, n * BYTES_PER_EVENT), r.length * BYTES_PER_EVENT);
    const from = r.length;
    r.length += n;
    for (let i = from; i < r.length; i++) {
        if (stale && i > from && (i - from) % YIELD_EVERY === 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            if (stale()) return false;
        }
        if (i % r.every === 0) r.checkpoints.push(checkpoint(r.head, i));
        apply(r.head, r.view, i);
    }
    return !stale?.();
}

// the book after events [0, index)
function bookAt(r: Replay, index: number): Book {
    const cp = r.checkpoints[Math.min(r.checkpoints.length - 1, Math.floor(index / r.every))];
    let c = r.cursor;
    if (!c || c.index > index || c.index < cp.index) c = r.cursor = { book: restore(cp), index: cp.index };
    while (c.index < index) apply(c.book, r.view, c.index++);
    return c.book;
}

// [price, size, ...] low to high
function flat(m: Map<number, number>): Float64Array {
    const prices = Float64Array.from(m.keys()).sort();
    const out = new Float64Array(prices.length * 2);
    for (let i = 0; i < prices.length; i++) {
        out[i * 2] = prices[i];
        out[i * 2 + 1] = m.get(prices[i])!;
    }
    return out;
}

const sizes = (s: Side) => {
    const m = new Map<number, number>();
    for (const [p, l] of s.levels) m.set(p, l.size);
    return m;
};

// the book as it stood at ts, after everything stamped ts
export function levelsAt(r: Replay, ts: bigint): Levels | null {
    if (!r.length || ts < tsAt(r, 0)) return null;
    const book = bookAt(r, indexAt(r, ts + 1n));
    return { bids: flat(sizes(book.bids)), asks: flat(sizes(book.asks)) };
}

// each price's peak over the instants in a column. events sharing a timestamp land as one, the book in
// between them never stood
export function peakColumns(r: Replay, t0: bigint, colNs: bigint, cols: number): (Levels | null)[] {
    const out: (Levels | null)[] = [];
    if (!r.length) return out;
    const first = tsAt(r, 0);
    const last = tsAt(r, r.length - 1);
    let j = indexAt(r, t0);
    const book = bookAt(r, j);
    const tb = new Set<number>();
    const ta = new Set<number>();
    const group = (touch: boolean) => {
        const t = tsAt(r, j);
        while (j < r.length && tsAt(r, j) === t) {
            apply(book, r.view, j++, touch ? tb : undefined, touch ? ta : undefined);
        }
        r.cursor!.index = j;
    };
    for (let x = 0; x < cols; x++) {
        const a = t0 + BigInt(x) * colNs;
        const b = a + colNs;
        if (b <= first || a > last) {
            out.push(null);
            continue;
        }
        if (j < r.length && tsAt(r, j) === a) group(false);
        const bids = sizes(book.bids);
        const asks = sizes(book.asks);
        while (j < r.length && tsAt(r, j) < b) {
            tb.clear();
            ta.clear();
            group(true);
            for (const p of tb) {
                const s = book.bids.levels.get(p)?.size;
                if (s && !(bids.get(p)! >= s)) bids.set(p, s);
            }
            for (const p of ta) {
                const s = book.asks.levels.get(p)?.size;
                if (s && !(asks.get(p)! >= s)) asks.set(p, s);
            }
        }
        out.push({ bids: flat(bids), asks: flat(asks) });
    }
    return out;
}
