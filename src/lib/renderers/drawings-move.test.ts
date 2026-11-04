import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { channelHeight, channelPrice, moveDrawingAnchorDelta } from './drawings-renderer';

describe('a channel on a log axis', () => {
    const c = (a: number, b: number, height: number) => ({ id: 'x', tool: 'parallel-channel', a: pt(a), b: pt(b), height });
    const drag = (d: any, anchor: string, cur: number, log = true) =>
        moveDrawingAnchorDelta(d, anchor as any, 0n, 0, (p) => p, 1000n, cur, false, log).drawing as any;
    const close = (got: number, want: number) => assert.ok(Math.abs(got - want) < 1e-9, `${got} against ${want}`);
    // the top over the base is the same at both ends, parallel in pixels
    const ratio = (d: any, price: number) => channelPrice(d, price, 1, true) / price;

    it('the parallel line is the same ratio over both ends', () => {
        const d = c(10, 40, 5);
        close(channelPrice(d, 10, 1, true), 15);
        close(channelPrice(d, 40, 1, true), 60);
    });

    it('a level halfway is halfway in pixels', () => {
        const d = c(10, 40, 30);
        close(channelPrice(d, 10, 0.5, true), 20);
    });

    it('on linear it is the plain offset', () => {
        const d = c(10, 40, 5);
        close(channelPrice(d, 40, 1, false), 45);
        close(channelPrice(d, 40, 0.5, false), 42.5);
    });

    it('a top at or under 0 stays the plain offset, no ratio there', () => {
        close(channelPrice(c(10, 40, -20), 40, 1, true), 20);
    });

    it('the height through a click goes through it at b', () => {
        const h = channelHeight(10, 40, 80, true);
        close(channelPrice({ a: pt(10), height: h }, 40, 1, true), 80);
        close(channelHeight(10, 40, 80, false), 40);
    });

    it('dragging a keeps the channel its pixels wide', () => {
        const out = drag(c(10, 40, 5), 'a', 20);
        close(out.a.price, 20);
        close(ratio(out, 20), 1.5);
    });

    it('dragging the top handles moves the base under them', () => {
        const left = drag(c(10, 40, 5), 'a2', 30);
        close(left.a.price, 20);
        close(ratio(left, 20), 1.5);
        const right = drag(c(10, 40, 5), 'a3', 90);
        close(right.b.price, 60);
        close(right.height, 5);
    });

    it('the base midpoint moves the base and pins the top', () => {
        const d = c(10, 40, 5);
        const out = drag(d, 'mt', 40);
        // halfway in pixels between 10 and 40 is 20
        close(out.a.price, 20);
        close(out.b.price, 80);
        close(channelPrice(out, out.a.price, 1, true), 15);
    });

    it('the top midpoint sets the width from where it sits', () => {
        const out = drag(c(10, 40, 5), 'mb', 40);
        close(out.a.price, 10);
        close(ratio(out, 10), 2);
    });

    it('on linear those handles do what they did', () => {
        close(drag(c(10, 40, 5), 'a', 20, false).height, 5);
        close(drag(c(10, 40, 5), 'a2', 30, false).a.price, 25);
        const mt = drag(c(10, 40, 5), 'mt', 30, false);
        close(mt.a.price, 15);
        close(mt.height, 0);
        close(drag(c(10, 40, 5), 'mb', 30, false).height, 5);
    });
});

const pt = (price: number) => ({ ts: 1000n, price });
const body = (d: any, shift: (p: number) => number) =>
    moveDrawingAnchorDelta(d, 'body' as any, 0n, 5, shift, 0n, 0, false).drawing as any;

const double = (p: number) => p * 2;

describe('dragging a drawing by its body', () => {
    for (const tool of ['line', 'ray', 'extended-line', 'info-line', 'trend-angle', 'fib', 'rect', 'fvp'])
        it(`${tool} moves both points with the shift`, () => {
            const out = body({ id: 'x', tool, a: pt(10), b: pt(40) }, double);
            assert.deepEqual([out.a.price, out.b.price].sort((x, y) => x - y), [20, 80]);
        });

    it('triangle moves all three', () => {
        const out = body({ id: 'x', tool: 'triangle', a: pt(10), b: pt(20), c: pt(30) }, double);
        assert.deepEqual([out.a.price, out.b.price, out.c.price], [20, 40, 60]);
    });

    for (const tool of ['cross-line', 'hray'])
        it(`${tool} moves its price`, () => {
            assert.equal(body({ id: 'x', tool, ts: 1000n, price: 10 }, double).price, 20);
        });

    it('text moves its anchor', () => {
        assert.equal(body({ id: 'x', tool: 'text', anchor: pt(10) }, double).anchor.price, 20);
    });

    it('a plugin drawing moves every anchor, and an onMove-less tool needs nothing else', () => {
        const out = body({ id: 'x', tool: 'nobody-registered', anchors: [pt(10), pt(30)] }, double);
        assert.deepEqual(out.anchors.map((a: any) => a.price), [20, 60]);
    });

    it('a channel keeps its shape, its height is a price offset', () => {
        const out = body({ id: 'x', tool: 'parallel-channel', a: pt(10), b: pt(20), height: 5 }, double);
        assert.equal(out.a.price + out.height, (10 + 5) * 2);
        assert.equal(out.b.price + out.height, (20 + 5) * 2);
    });

    for (const tool of ['long', 'short'])
        it(`${tool} keeps target and stop on the same pixels, its amounts are price offsets`, () => {
            const out = body({ id: 'x', tool, a: pt(10), b: pt(10), upAmount: 5, downAmount: 2 }, double);
            assert.equal(out.a.price, 20);
            assert.equal(out.a.price + out.upAmount, (10 + 5) * 2);
            assert.equal(out.a.price - out.downAmount, (10 - 2) * 2);
        });

    it('on a linear axis a channel height stays what it was', () => {
        const out = body({ id: 'x', tool: 'parallel-channel', a: pt(10), b: pt(20), height: 5 }, (p) => p + 3);
        assert.equal(out.height, 5);
        assert.equal(out.a.price, 13);
    });
});
