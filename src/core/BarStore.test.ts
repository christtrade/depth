import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BarStore } from './BarStore';
import type { OhlcvBar } from '../interfaces/IDataAdapter';

const MIN = 60_000;

function bar(m: number, extra: Partial<OhlcvBar> = {}): OhlcvBar {
    return { time: m * MIN, open: m, high: m + 2, low: m - 1, close: m + 1, volume: m * 10, ...extra };
}

function bars(from: number, to: number): OhlcvBar[] {
    const out: OhlcvBar[] = [];
    for (let m = from; m < to; m++) out.push(bar(m));
    return out;
}

function oldRefine(existing: OhlcvBar[], fromMs: number, toMs: number, incoming: OhlcvBar[]) {
    const kept = existing.filter((b) => b.time < fromMs || b.time > toMs);
    return [...kept, ...incoming].sort((a, b) => a.time - b.time);
}

describe('BarStore', () => {
    it('round-trips bars through from/toArray', () => {
        const src = bars(0, 100);
        const s = BarStore.from(src);
        assert.equal(s.length, 100);
        assert.deepEqual(s.toArray(), src);
        assert.deepEqual(s.toArray(10, 13), src.slice(10, 13));
        assert.deepEqual([...s], src);
    });

    it('views cover exactly length and read the right values', () => {
        const s = BarStore.from(bars(5, 25));
        for (const col of ['time', 'open', 'high', 'low', 'close', 'volume'] as const) {
            assert.equal(s[col].length, 20, col);
        }
        assert.equal(s.time[0], 5 * MIN);
        assert.equal(s.close[19], 25);
    });

    it('prepends and appends through many regrows in any order', () => {
        const s = new BarStore();
        let lo = 50_000,
            hi = 50_000;
        // pages of random size in random directions, like panning both ways
        let seed = 7;
        const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
        for (let k = 0; k < 400; k++) {
            const n = 1 + Math.floor(rand() * 300);
            if (rand() < 0.5) {
                s.prepend(bars(lo - n, lo));
                lo -= n;
            } else {
                s.append(bars(hi, hi + n));
                hi += n;
            }
        }
        assert.equal(s.length, hi - lo);
        assert.deepEqual(s.toArray(), bars(lo, hi));
    });

    it('prepend is amortized - total copying stays linear', () => {
        // 1000 pages of 1000 bars: a copy-everything prepend would be ~500M writes
        const s = new BarStore();
        const t0 = performance.now();
        for (let p = 999; p >= 0; p--) s.prepend(bars(p * 1000, p * 1000 + 1000));
        const ms = performance.now() - t0;
        assert.equal(s.length, 1_000_000);
        assert.equal(s.time[0], 0);
        assert.equal(s.time[999_999], 999_999 * MIN);
        assert.ok(ms < 2000, `1M bars in 1000 prepends took ${ms.toFixed(0)}ms`);
    });

    it('appendRow writes a bar without an object', () => {
        const s = BarStore.from(bars(0, 3));
        s.appendRow(3 * MIN, 3, 5, 2, 4, 30);
        assert.deepEqual(s.at(3), bar(3));
    });

    it('lowerBound and upperBound match a linear scan', () => {
        // duplicates and gaps both
        const src = [0, 1, 1, 1, 2, 5, 5, 9, 10, 10].map((m) => bar(m));
        const s = BarStore.from(src);
        for (let m = -2; m <= 12; m++) {
            const ms = m * MIN;
            const lb = src.findIndex((b) => b.time >= ms);
            const ub = src.findIndex((b) => b.time > ms);
            assert.equal(s.lowerBound(ms), lb === -1 ? src.length : lb, `lowerBound ${m}`);
            assert.equal(s.upperBound(ms), ub === -1 ? src.length : ub, `upperBound ${m}`);
        }
        assert.equal(new BarStore().lowerBound(0), 0);
    });

    it('at handles negatives and out of range', () => {
        const s = BarStore.from(bars(0, 5));
        assert.deepEqual(s.at(-1), bar(4));
        assert.equal(s.at(5), undefined);
        assert.equal(s.at(-6), undefined);
    });

    it('set overwrites in place and refuses out of range', () => {
        const s = BarStore.from(bars(0, 5));
        s.set(4, bar(4, { close: 99 }));
        assert.equal(s.close[4], 99);
        assert.throws(() => s.set(5, bar(5)), RangeError);
    });

    it('replaceRange matches the old filter/sort refine', () => {
        let seed = 3;
        const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
        for (let t = 0; t < 500; t++) {
            const n = Math.floor(rand() * 60);
            const existing = bars(0, n);
            const from = Math.floor(rand() * 70) - 5;
            const to = from + Math.floor(rand() * 30);
            // mostly inside the range, sometimes spilling past it, sometimes unsorted
            const spill = rand() < 0.2 ? 8 : 0;
            const incoming: OhlcvBar[] = [];
            for (let m = from - spill; m <= to + spill; m++) {
                if (rand() < 0.6) incoming.push(bar(m, { close: 1000 + m }));
            }
            if (rand() < 0.2) incoming.reverse();

            const s = BarStore.from(existing);
            s.replaceRange(from * MIN, to * MIN, incoming);
            assert.deepEqual(s.toArray(), oldRefine(existing, from * MIN, to * MIN, incoming), `case ${t}`);
        }
    });

    it('replaceRange can grow and shrink the store', () => {
        const s = BarStore.from(bars(0, 10));
        s.replaceRange(2 * MIN, 3 * MIN, bars(2, 4).concat([bar(3, { close: 7 })]));
        assert.equal(s.length, 11);
        s.replaceRange(0, 100 * MIN, []);
        assert.equal(s.length, 0);
    });

    it('bid/ask columns appear on first use and stay NaN where absent', () => {
        const s = BarStore.from(bars(0, 3));
        assert.equal(s.bid, null);
        s.append([bar(3, { bid: 2.5, ask: 3.5 })]);
        assert.ok(s.bid && s.ask);
        assert.ok(Number.isNaN(s.bid[0]));
        assert.equal(s.bid[3], 2.5);
        assert.equal(s.ask![3], 3.5);
        // at() leaves the fields off rather than handing out NaN
        assert.equal('bid' in s.at(0)!, false);
        assert.deepEqual(s.at(3), bar(3, { bid: 2.5, ask: 3.5 }));
        // survives a regrow
        s.prepend(bars(-100, 0));
        assert.equal(s.bid![103], 2.5);
        assert.ok(Number.isNaN(s.bid![0]));
    });

    it('bumps version on every mutation and swaps views', () => {
        const s = BarStore.from(bars(0, 3));
        const seen = new Set([s.version]);
        const before = s.time;
        s.append([bar(3)]);
        seen.add(s.version);
        s.prepend([bar(-1)]);
        seen.add(s.version);
        s.set(0, bar(-1, { close: 1 }));
        seen.add(s.version);
        s.appendRow(4 * MIN, 1, 1, 1, 1, 1);
        seen.add(s.version);
        s.replaceRange(0, 0, [bar(0)]);
        seen.add(s.version);
        s.clear();
        seen.add(s.version);
        assert.equal(seen.size, 7);
        // a view held from before is stale, which is why readers must not hold one
        assert.equal(before.length, 3);
        assert.equal(s.time.length, 0);
    });

    it('bytes counts capacity, with bid/ask when present', () => {
        const s = new BarStore(100);
        assert.equal(s.bytes, 100 * 6 * 8);
        s.append([bar(0, { bid: 1 })]);
        assert.equal(s.bytes, 100 * 8 * 8);
    });

    it('clear keeps working for both directions after', () => {
        const s = BarStore.from(bars(0, 50));
        s.clear();
        s.append(bars(10, 20));
        s.prepend(bars(0, 10));
        assert.deepEqual(s.toArray(), bars(0, 20));
    });
});
