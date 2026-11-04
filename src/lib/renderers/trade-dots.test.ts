import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    cachedRefSize,
    columnNs,
    dotAt,
    dotRows,
    drawnDots,
    pickDot,
    refSize,
    rememberDots,
    sizeT,
    tradeDots,
    type TradeDot,
} from './trade-dots';

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
            { x: 0, price: 100, size: 2, buySize: 2, count: 1, ts: 0n },
            { x: 10, price: 100.01, size: 5, buySize: 0, count: 1, ts: 10n },
            { x: 20, price: 100.02, size: 1, buySize: 1, count: 1, ts: 20n },
        ]);
    });

    it('a dot counts its trades and starts at the first one', () => {
        const [d] = tradeDots([tr(9, 100, 1), tr(10, 100, 1, 'A'), tr(15, 100, 1)], 0n, 100n, x, 8n);
        assert.equal(d.count, 3);
        assert.equal(d.ts, 9n);
    });

    it('dotAt regroups from the time at any zoom, same as the draw', () => {
        const trades = [tr(0, 100, 1), tr(3, 100, 2), tr(5, 100, 4), tr(9, 100, 8)];
        assert.equal(dotAt(trades, 3n, 0n, 100n, x, 4n)?.size, 3);
        assert.equal(dotAt(trades, 3n, 0n, 100n, x, 8n)?.size, 7);
        assert.equal(dotAt(trades, 3n, 0n, 100n, x, 16n)?.size, 15);
        assert.equal(dotAt(trades, 3n, 0n, 100n, x, 16n)?.count, 4);
    });

    it('dotAt sees what the view and the playhead leave of the column', () => {
        const trades = [tr(0, 100, 1), tr(3, 100, 2), tr(5, 100, 4)];
        assert.equal(dotAt(trades, 0n, 3n, 100n, x, 8n)?.size, 6);
        assert.equal(dotAt(trades, 0n, 0n, 3n, x, 8n)?.size, 3);
        assert.equal(dotAt(trades, 0n, 8n, 100n, x, 8n), null);
        assert.equal(dotAt(trades, 16n, 0n, 8n, x, 8n), null);
    });

    it('drawn dots only count for the view and data they were drawn at', () => {
        const trades = [tr(0, 100, 1)];
        const dots = tradeDots(trades, 0n, 100n, x, 8n);
        assert.equal(drawnDots(trades, 0n, 100n, 800), null);
        rememberDots(trades, 0n, 100n, 800, dots);
        assert.equal(drawnDots(trades, 0n, 100n, 800), dots);
        assert.equal(drawnDots(trades, 1n, 100n, 800), null);
        assert.equal(drawnDots(trades, 0n, 101n, 800), null);
        assert.equal(drawnDots(trades, 0n, 100n, 801), null);
        assert.equal(drawnDots([tr(0, 100, 1)], 0n, 100n, 800), null);
        trades.push(tr(1, 100, 1));
        assert.equal(drawnDots(trades, 0n, 100n, 800), null);
    });

    describe('pickDot', () => {
        const dot = (px: number, size: number): TradeDot => ({ x: px, price: 0, size, buySize: 0, count: 1, ts: 0n });
        const pick = (dots: TradeDot[], px: number, py = 0) => pickDot(dots, px, py, () => 0, (d) => d.size);

        it('hits anywhere on the bubble, not only near a trade', () => {
            const big = dot(100, 10);
            assert.equal(pick([big], 109), big);
            assert.equal(pick([big], 100, 9), big);
        });

        it('takes the one on top where they overlap', () => {
            const big = dot(100, 10);
            const small = dot(104, 2);
            assert.equal(pick([big, small], 104), small);
            assert.equal(pick([big, small], 96), big);
        });

        it('a small one close by still counts, empty space does not', () => {
            const small = dot(100, 1.5);
            assert.equal(pick([small], 104), small);
            assert.equal(pick([small], 106), null);
        });

        it('being on one beats being closer to another', () => {
            const big = dot(100, 10);
            const small = dot(112, 2);
            assert.equal(pick([big, small], 109), big);
        });
    });

    it('card rows add up, and float sums stay readable', () => {
        const d: TradeDot = { x: 0, price: 1, size: 0.1 + 0.2, buySize: 0.1, count: 2, ts: 0n };
        assert.deepEqual(dotRows(d, '1.00', 't'), [
            ['Total', '0.3'],
            ['Buy', '0.1  33%'],
            ['Sell', '0.2  67%'],
            ['VWAP', '1.00'],
            ['Trades', '2'],
            ['Time', 't'],
        ]);
    });

    it('card with no size shows no share', () => {
        const d: TradeDot = { x: 0, price: 1, size: 0, buySize: 0, count: 1, ts: 0n };
        const rows = dotRows(d, '1', 't');
        assert.equal(rows[1][1], '0  0%');
        assert.equal(rows[2][1], '0  0%');
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
