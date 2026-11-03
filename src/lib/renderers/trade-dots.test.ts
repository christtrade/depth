import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cachedRefSize, columnNs, refSize, sizeT, tradeDots } from './trade-dots';

const tr = (ts: number, price: number, size: number, side = 'B') => ({ ts: BigInt(ts), price, size, side });
// 1 px per ns
const x = (ts: bigint) => Number(ts);

describe('trade dots', () => {
    it('column width rounds up to a power of 2 ns', () => {
        assert.equal(columnNs(1), 8n);
        assert.equal(columnNs(3), 32n);
        assert.equal(columnNs(0.1), 1n);
    });

    it('zoomed in, one bubble per trade where it printed', () => {
        const trades = [tr(0, 100, 2), tr(10, 100.01, 5, 'A'), tr(20, 100.02, 1)];
        assert.deepEqual(tradeDots(trades, 0n, 100n, x, 1n), [
            { x: 0, price: 100, size: 2, buySize: 2 },
            { x: 10, price: 100.01, size: 5, buySize: 0 },
            { x: 20, price: 100.02, size: 1, buySize: 1 },
        ]);
    });

    it('both sides and all prices in a column make one bubble at the volume weighted price', () => {
        const dots = tradeDots([tr(0, 100, 3), tr(1, 100.04, 1, 'A'), tr(4, 100.08, 1)], 0n, 100n, x, 4n);
        assert.equal(dots.length, 2);
        assert.equal(dots[0].size, 4);
        assert.equal(dots[0].buySize, 3);
        assert.ok(Math.abs(dots[0].price - 100.01) < 1e-9, `got ${dots[0].price}`);
        assert.ok(Math.abs(dots[0].x - 0.25) < 1e-9);
        assert.equal(dots[1].price, 100.08);
    });

    it('a column holds the same trades wherever the view starts', () => {
        const trades = [tr(5, 100, 1), tr(6, 100, 1), tr(9, 100, 1)];
        const a = tradeDots(trades, 0n, 100n, x, 8n).map((d) => d.size);
        const b = tradeDots(trades, 5n, 100n, x, 8n).map((d) => d.size);
        assert.deepEqual(a, [2, 1]);
        assert.deepEqual(b, a);
    });

    it('leaves out what printed past the playhead', () => {
        assert.equal(tradeDots([tr(0, 100, 1), tr(50, 100, 1)], 0n, 40n, x, 1n).length, 1);
    });

    it('full size is the 99th percentile column, so one huge print does not shrink the rest', () => {
        const trades = Array.from({ length: 200 }, (_, i) => tr(i, 100, i === 100 ? 10_000 : i < 100 ? 2 : 8));
        assert.deepEqual(refSize(trades, 1n), { mid: 4, top: 8 });
        assert.deepEqual(refSize([], 1n), { mid: 0, top: 1 });
    });

    it('the usual column stays small, the top one is full size', () => {
        const ref = { mid: 4, top: 10 };
        assert.equal(sizeT(2, ref), 0);
        assert.equal(sizeT(10, ref), 1);
        assert.equal(sizeT(10_000, ref), 1);
        assert.ok(sizeT(4, ref) < 0.4);
    });

    it('cached full size redoes it when the zoom step changes', () => {
        const trades = [tr(0, 100, 1), tr(1, 100, 1)];
        assert.equal(cachedRefSize(trades, 1n).top, 1);
        assert.equal(cachedRefSize(trades, 2n).top, 2);
    });
});
