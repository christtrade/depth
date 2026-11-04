import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { moveDrawingAnchorDelta } from './drawings-renderer';

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
