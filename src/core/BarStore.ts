import type { OhlcvBar } from '../interfaces/IDataAdapter';

const COLS = ['time', 'open', 'high', 'low', 'close', 'volume'] as const;
const MIN_CAPACITY = 16;

/**
 * ohlcv bars as columns
 *
 * A bar as an object is ~176, here it's ~48 bytes + there's nothing for the
 * gc to walk. prepend and append are amortized 0(bars added).
 *
 * time, open, etc are views starting at idx 0. If you're going to use this,
 * read the bars off the store when you use them cause any mutation can swap
 * them for new views, so one held across a mutation reads stale data.
 * version bumps on every mutation and key caches on it too.
 * The chart hands out a new store on every `data:load` so dont hold one
 * across that either.
 */
export class BarStore {
    time: Float64Array = new Float64Array(0);
    open: Float64Array = new Float64Array(0);
    high: Float64Array = new Float64Array(0);
    low: Float64Array = new Float64Array(0);
    close: Float64Array = new Float64Array(0);
    volume: Float64Array = new Float64Array(0);
    /** Best bid per bar, NaN where a bar had none. Null until a bar arrives with one. */
    bid: Float64Array | null = null;
    /** Best ask per bar, NaN where a bar had none. Null until a bar arrives with one. */
    ask: Float64Array | null = null;

    length = 0;
    version = 0;

    private buf: Record<(typeof COLS)[number], Float64Array>;
    private bidBuf: Float64Array | null = null;
    private askBuf: Float64Array | null = null;
    private head = 0;
    private cap: number;

    constructor(capacity = 0) {
        this.cap = Math.max(MIN_CAPACITY, capacity);
        this.buf = {
            time: new Float64Array(this.cap),
            open: new Float64Array(this.cap),
            high: new Float64Array(this.cap),
            low: new Float64Array(this.cap),
            close: new Float64Array(this.cap),
            volume: new Float64Array(this.cap),
        };
        this.refreshViews();
    }

    /** A store holding `bars`, which must already be sorted by time */
    static from(bars: readonly OhlcvBar[]): BarStore {
        const s = new BarStore(bars.length);
        s.append(bars);
        return s;
    }

    /** An independent copy, bid/ask included. */
    clone(): BarStore {
        const s = new BarStore(this.length);
        for (const c of COLS) s.buf[c].set(this[c]);
        if (this.bid) {
            s.addBidAsk();
            s.bidBuf!.set(this.bid);
            s.askBuf!.set(this.ask!);
        }
        s.length = this.length;
        s.changed();
        return s;
    }

    /** Bars `from` (inclusive) to `to` (exclusive) as a copy, with room for `slack` more split between both ends */
    slice(from = 0, to = this.length, slack = 0): BarStore {
        from = Math.max(0, from);
        to = Math.min(this.length, to);
        const len = Math.max(0, to - from);
        const s = new BarStore(len + slack);
        const head = Math.floor((s.cap - len) / 2);
        for (const c of COLS) s.buf[c].set(this[c].subarray(from, to), head);
        if (this.bid) {
            s.addBidAsk();
            s.bidBuf!.set(this.bid.subarray(from, to), head);
            s.askBuf!.set(this.ask!.subarray(from, to), head);
        }
        s.head = head;
        s.length = len;
        s.changed();
        return s;
    }

    /** Bars `from` (inclusive) to `to` (exclusive) sharing this stores memory, no copy. Read-only, and stale once this one changes */
    view(from = 0, to = this.length): BarStore {
        from = Math.max(0, from);
        to = Math.min(this.length, to);
        const len = Math.max(0, to - from);
        const s = new BarStore();
        for (const c of COLS) s.buf[c] = this[c].subarray(from, from + len);
        if (this.bid) {
            s.bidBuf = this.bid.subarray(from, from + len);
            s.askBuf = this.ask!.subarray(from, from + len);
        }
        s.cap = len;
        s.length = len;
        s.changed();
        return s;
    }

    /** Bytes held, including spare capacity. */
    get bytes(): number {
        const cols = COLS.length + (this.bidBuf ? 2 : 0);
        return this.cap * cols * 8;
    }

    /** Add bars after the last one. `bars` must be sorted and start at or after it */
    append(bars: readonly OhlcvBar[]): void {
        if (bars.length === 0) return;
        this.reserve(0, bars.length);
        const at = this.head + this.length;
        for (let i = 0; i < bars.length; i++) this.write(at + i, bars[i]);
        this.length += bars.length;
        this.changed();
    }

    /** Add one bar after the last one without building an object */
    appendRow(time: number, open: number, high: number, low: number, close: number, volume: number): void {
        this.reserve(0, 1);
        const i = this.head + this.length;
        const b = this.buf;
        b.time[i] = time;
        b.open[i] = open;
        b.high[i] = high;
        b.low[i] = low;
        b.close[i] = close;
        b.volume[i] = volume;
        if (this.bidBuf) {
            this.bidBuf[i] = NaN;
            this.askBuf![i] = NaN;
        }
        this.length++;
        this.changed();
    }

    /** Add bars before the first one. `bars` must be sorted and end at or before it. */
    prepend(bars: readonly OhlcvBar[]): void {
        if (bars.length === 0) return;
        this.reserve(bars.length, 0);
        this.head -= bars.length;
        for (let i = 0; i < bars.length; i++) this.write(this.head + i, bars[i]);
        this.length += bars.length;
        this.changed();
    }

    /** Overwrite bar `i` in place. */
    set(i: number, bar: OhlcvBar): void {
        if (i < 0 || i >= this.length) throw new RangeError(`BarStore.set: ${i} out of 0..${this.length - 1}`);
        this.write(this.head + i, bar);
        this.changed();
    }

    /**
     * Drop every bar with `fromMs <= time <= toMs` and merge `bars` in. On equal
     * times the kept bar sorts first, then the new one.
     */
    replaceRange(fromMs: number, toMs: number, bars: readonly OhlcvBar[]): void {
        const lo = this.lowerBound(fromMs);
        const hi = this.upperBound(toMs);
        const sorted = isSorted(bars) ? bars : [...bars].sort((a, b) => a.time - b.time);
        const inRange =
            sorted.length === 0 || (sorted[0].time >= fromMs && sorted[sorted.length - 1].time <= toMs);

        if (inRange) {
            this.splice(lo, hi, sorted);
        } else {
            // new bars spill past the range, so they interleave with kept ones
            const kept = [...this.toArray(0, lo), ...this.toArray(hi)];
            this.splice(0, this.length, mergeByTime(kept, sorted));
        }
    }

    /** Remove every bar. Keeps the allocation. */
    clear(): void {
        this.length = 0;
        this.head = Math.floor(this.cap / 2);
        this.changed();
    }

    /** First index with `time >= ms`, or `length` if none. */
    lowerBound(ms: number): number {
        const t = this.time;
        let lo = 0,
            hi = this.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (t[mid] < ms) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    /** First index with `time > ms`, or `length` if none. */
    upperBound(ms: number): number {
        const t = this.time;
        let lo = 0,
            hi = this.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (t[mid] <= ms) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    /** Bar `i` as a new object, negative counts from the end. Allocates - not for hot loops. */
    at(i: number): OhlcvBar | undefined {
        if (i < 0) i += this.length;
        if (i < 0 || i >= this.length) return undefined;
        const bar: OhlcvBar = {
            time: this.time[i],
            open: this.open[i],
            high: this.high[i],
            low: this.low[i],
            close: this.close[i],
            volume: this.volume[i],
        };
        if (this.bid && !Number.isNaN(this.bid[i])) bar.bid = this.bid[i];
        if (this.ask && !Number.isNaN(this.ask[i])) bar.ask = this.ask[i];
        return bar;
    }

    /** Bars `from` (inclusive) to `to` (exclusive) as new objects. */
    toArray(from = 0, to = this.length): OhlcvBar[] {
        from = Math.max(0, from);
        to = Math.min(this.length, to);
        const out: OhlcvBar[] = new Array(Math.max(0, to - from));
        for (let i = from; i < to; i++) out[i - from] = this.at(i)!;
        return out;
    }

    *[Symbol.iterator](): IterableIterator<OhlcvBar> {
        for (let i = 0; i < this.length; i++) yield this.at(i)!;
    }

    private write(j: number, bar: OhlcvBar): void {
        const b = this.buf;
        b.time[j] = bar.time;
        b.open[j] = bar.open;
        b.high[j] = bar.high;
        b.low[j] = bar.low;
        b.close[j] = bar.close;
        b.volume[j] = bar.volume;
        if ((bar.bid !== undefined || bar.ask !== undefined) && !this.bidBuf) this.addBidAsk();
        if (this.bidBuf) {
            this.bidBuf[j] = bar.bid ?? NaN;
            this.askBuf![j] = bar.ask ?? NaN;
        }
    }

    // replaces [lo, hi) with bars, in place when it fits
    private splice(lo: number, hi: number, bars: readonly OhlcvBar[]): void {
        const removed = hi - lo;
        const delta = bars.length - removed;
        if (delta > 0) this.reserve(0, delta);
        const start = this.head + lo;
        const tailFrom = this.head + hi;
        const tailLen = this.length - hi;
        if (delta !== 0) {
            for (const c of COLS) this.buf[c].copyWithin(tailFrom + delta, tailFrom, tailFrom + tailLen);
            if (this.bidBuf) {
                this.bidBuf.copyWithin(tailFrom + delta, tailFrom, tailFrom + tailLen);
                this.askBuf!.copyWithin(tailFrom + delta, tailFrom, tailFrom + tailLen);
            }
        }
        for (let i = 0; i < bars.length; i++) this.write(start + i, bars[i]);
        this.length += delta;
        this.changed();
    }

    // makes room for `front` more bars before head and `back` more after the tail
    private reserve(front: number, back: number): void {
        const tail = this.cap - this.head - this.length;
        if (this.head >= front && tail >= back) return;

        const needed = this.length + front + back;
        const cap = Math.max(MIN_CAPACITY, needed * 2);
        // split the spare room so the next prepend and append both have slack
        const head = front + Math.floor((cap - needed) / 2);
        const from = this.head;
        const to = this.head + this.length;

        for (const c of COLS) {
            const next = new Float64Array(cap);
            next.set(this.buf[c].subarray(from, to), head);
            this.buf[c] = next;
        }
        if (this.bidBuf) {
            this.bidBuf = regrow(this.bidBuf, from, to, cap, head);
            this.askBuf = regrow(this.askBuf!, from, to, cap, head);
        }
        this.cap = cap;
        this.head = head;
    }

    private addBidAsk(): void {
        this.bidBuf = new Float64Array(this.cap).fill(NaN);
        this.askBuf = new Float64Array(this.cap).fill(NaN);
    }

    private changed(): void {
        this.version++;
        this.refreshViews();
    }

    private refreshViews(): void {
        const from = this.head;
        const to = this.head + this.length;
        this.time = this.buf.time.subarray(from, to);
        this.open = this.buf.open.subarray(from, to);
        this.high = this.buf.high.subarray(from, to);
        this.low = this.buf.low.subarray(from, to);
        this.close = this.buf.close.subarray(from, to);
        this.volume = this.buf.volume.subarray(from, to);
        this.bid = this.bidBuf ? this.bidBuf.subarray(from, to) : null;
        this.ask = this.askBuf ? this.askBuf.subarray(from, to) : null;
    }
}

function regrow(src: Float64Array, from: number, to: number, cap: number, head: number): Float64Array {
    const next = new Float64Array(cap).fill(NaN);
    next.set(src.subarray(from, to), head);
    return next;
}

function isSorted(bars: readonly OhlcvBar[]): boolean {
    for (let i = 1; i < bars.length; i++) if (bars[i].time < bars[i - 1].time) return false;
    return true;
}

// stable: on equal times `a` comes first
function mergeByTime(a: readonly OhlcvBar[], b: readonly OhlcvBar[]): OhlcvBar[] {
    const out: OhlcvBar[] = [];
    let i = 0,
        j = 0;
    while (i < a.length && j < b.length) out.push(b[j].time < a[i].time ? b[j++] : a[i++]);
    while (i < a.length) out.push(a[i++]);
    while (j < b.length) out.push(b[j++]);
    return out;
}
