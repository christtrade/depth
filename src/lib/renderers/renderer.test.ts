import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { drawPriceLabel, drawTradeLine, liveCut, type CandleCache, type LiveEdge } from './renderer';
import { BarStore } from '../../core/BarStore';
import { DEFAULT_CHART_SETTINGS } from '../types/chart-settings';

// fillStyle at every fill(), the pills top to bottom
function recordingCtx() {
    const fills: string[] = [];
    const state: Record<string, unknown> = {};
    const ctx = new Proxy(state, {
        get: (t, k) => (k === 'fill' ? () => fills.push(String(t.fillStyle)) : k in t ? t[k as string] : () => {}),
        set: (t, k, v) => ((t[k as string] = v), true),
    });
    return { ctx: ctx as unknown as CanvasRenderingContext2D, fills };
}

function draw(last: { open: number; close: number }) {
    const { ctx, fills } = recordingCtx();
    const candles: CandleCache = new Map([[10_000_000_000n, { ...last, high: 100.5, low: 99.5 }]]);
    const ys = drawPriceLabel(
        ctx,
        {} as HTMLCanvasElement,
        [{ ts: 5_000_000_000n, bestBid: 99.75, bestAsk: 100 }],
        [],
        { tMin: 0n, tMax: 10_000_000_000n } as any,
        800,
        400,
        { ...DEFAULT_CHART_SETTINGS, animatePriceUpdates: false },
        1_000_000_000n,
        10_000_000_000n,
        candles,
        null,
        null,
        0,
        { priceToY: (p: number) => 300 - (p - 99) * 100 } as any,
        'l3',
        undefined,
        60,
    );
    return { ys, fills };
}

describe('drawPriceLabel', () => {
    it('marks the ask pill when the last price is the ask, no second pill', () => {
        const { ys, fills } = draw({ open: 100.25, close: 100 });
        assert.equal(ys.length, 2);
        const s = DEFAULT_CHART_SETTINGS;
        // edge, gap, ask fill, then the bid
        assert.deepEqual(fills.slice(1), [s.axisBackgroundColor, s.askLineColor, s.bidLineColor]);
    });

    it('marks the bid pill when the last price is the bid', () => {
        const { ys, fills } = draw({ open: 99.5, close: 99.75 });
        assert.equal(ys.length, 2);
        const s = DEFAULT_CHART_SETTINGS;
        assert.deepEqual(fills.slice(1), [s.bidLineColor, s.axisBackgroundColor, s.bidLineColor]);
    });

    it('draws its own pill when the last price is between bid and ask', () => {
        const { ys } = draw({ open: 99.5, close: 99.875 });
        assert.equal(ys.length, 3);
    });
});

const ms = (n: number) => BigInt(n) * 1_000_000n;

// where the step line ends, x in ms and y the price. the last change is at 2000
function stepEnd(side: 'ask' | 'price', barNs: bigint, horizonMs: number, cutMs: number | null = null) {
    let end: [number, number] = [0, 0];
    const ctx = new Proxy({} as Record<string, unknown>, {
        get: (t, k) =>
            k === 'lineTo' || k === 'moveTo' ? (x: number, y: number) => (end = [x, y]) : k in t ? t[k as string] : () => {},
        set: (t, k, v) => ((t[k as string] = v), true),
    }) as unknown as CanvasRenderingContext2D;
    const transformer = {
        makeTsToXFn: () => (ts: bigint) => Number(ts / 1_000_000n),
        makePriceToYFn: () => (p: number) => p,
    } as any;
    drawTradeLine(
        ctx,
        [
            { ts: ms(1000), bestBid: 99, bestAsk: 100 },
            { ts: ms(2000), bestBid: 99.5, bestAsk: 101 },
        ],
        { tMin: 0n, tMax: ms(10_000) } as any,
        10_000,
        400,
        '#fff',
        side,
        DEFAULT_CHART_SETTINGS,
        ms(horizonMs),
        barNs,
        transformer,
        BarStore.from([{ time: 1000, open: 100, high: 100, low: 100, close: 100, volume: 1 }]),
        { ts: ms(2000), open: 102, high: 102, low: 102, close: 102 },
        cutMs === null ? null : ms(cutMs),
    );
    return end;
}

describe('drawTradeLine', () => {
    // live, the horizon is the last trade and only the clock is past it
    it('at None, live, the step holds on to the cut', () => {
        assert.deepEqual(stepEnd('ask', 1_000_000n, 2000, 5000), [5000, 101]);
        assert.deepEqual(stepEnd('price', 1_000_000n, 2000, 5000), [5000, 102]);
    });

    it('a trade past the cut waits for it, not drawn behind the end', () => {
        assert.deepEqual(stepEnd('ask', 1_000_000n, 1500, 1500), [1500, 100]);
        assert.deepEqual(stepEnd('price', 1_000_000n, 1500, 1500), [1500, 100]);
    });

    it('at None, in playback, the step holds on to the horizon', () => {
        assert.deepEqual(stepEnd('ask', 1_000_000n, 5000), [5000, 101]);
        assert.deepEqual(stepEnd('price', 1_000_000n, 5000), [5000, 102]);
    });

    it('stops at the last change on coarser bars', () => {
        assert.deepEqual(stepEnd('ask', 1_000_000_000n, 2000), [2000, 101]);
        assert.deepEqual(stepEnd('price', 1_000_000_000n, 2000), [2000, 102]);
    });
});

describe('liveCut', () => {
    const edge: LiveEdge = { from: ms(2000), to: ms(1950) };

    it('cuts at the edge while following at None', () => {
        assert.equal(liveCut(1_000_000n, ms(2000), edge), ms(1950));
    });

    it('a seek back to before the edge was set drops it', () => {
        assert.equal(liveCut(1_000_000n, ms(1500), edge), null);
    });

    it('not on coarser bars', () => {
        assert.equal(liveCut(1_000_000_000n, ms(2000), edge), null);
    });
});
