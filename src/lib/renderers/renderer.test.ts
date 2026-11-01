import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { drawPriceLabel, type CandleCache } from './renderer';
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
