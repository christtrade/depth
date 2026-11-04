import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { drawFootprintChart } from './drawFootprintChart';
import { LiveTransformer } from '../../interfaces/ICoordinateTransformer';
import { DEFAULT_CHART_SETTINGS } from '../types/chart-settings';

const MIN = 60_000_000_000n;
const H = 600;
const W = 1000;
const CELL_BG = 'rgba(42,45,55,0.85)';

function draw(mode: 'log' | 'linear', pMin: number, pMax: number, low: number, high: number, tick = 1) {
    const view = { tMin: 0n, tMax: MIN * 4n, pMin, pMax, pRef: 0 };
    const t = new LiveTransformer();
    t.update(view as never);
    t.setScaleMode(mode);
    const levels = [];
    for (let p = low; p <= high; p += tick)
        levels.push({ price: p, bidVol: 1, askVol: 1, totalVol: 2, delta: 0 });
    const bar = {
        ts: MIN,
        open: low,
        close: high,
        high,
        low,
        levels,
        isBullish: true,
        totalDelta: 0,
        stackedBuyZones: [],
        stackedSellZones: [],
        diagDominant: 'none',
    };
    const rows = new Map<number, { top: number; h: number }>();
    const fonts = new Set<string>();
    const texts: { text: string; y: number }[] = [];
    const ctx: any = new Proxy(
        {
            fillStyle: '',
            set font(f: string) {
                fonts.add(f);
            },
            fillRect(_x: number, y: number, _w: number, rowH: number) {
                if (this.fillStyle === CELL_BG) rows.set(Math.round(y * 100), { top: y, h: rowH });
            },
            fillText(text: string, _x: number, y: number) {
                texts.push({ text, y });
            },
        },
        {
            get: (o: any, k) => (k in o ? o[k] : () => {}),
            set: (o: any, k, v) => ((o[k] = v), true),
        },
    );
    drawFootprintChart(ctx, [bar as never], view as never, W, H, MIN, 'bid-ask', tick, 'split', DEFAULT_CHART_SETTINGS, MIN * 4n, t);
    return { rows: [...rows.values()].sort((a, b) => a.top - b.top), fonts, texts, t };
}

describe('footprint rows', () => {
    it('on log every row meets the next one, no gaps low down, no overlap up high', () => {
        const { rows } = draw('log', 10, 100, 12, 90);
        assert.ok(rows.length > 2, `${rows.length} rows`);
        for (let i = 1; i < rows.length; i++) {
            const gap = rows[i].top - (rows[i - 1].top + rows[i - 1].h);
            assert.ok(Math.abs(gap) <= 1.01, `row ${i} is ${gap}px off the one above`);
        }
    });

    it('on log rows get taller going down, a tick is more pixels at a low price', () => {
        const { rows } = draw('log', 10, 100, 12, 90);
        assert.ok(rows[rows.length - 1].h > rows[0].h * 2, `${rows[0].h} up top, ${rows[rows.length - 1].h} down low`);
    });

    it('on log no row is under the minimum at the top of the view', () => {
        const { rows } = draw('log', 10, 100, 12, 90);
        for (const r of rows) assert.ok(r.h >= 29, `a row of ${r.h}px`);
    });

    it('on linear rows are all one height and stack exactly', () => {
        const { rows } = draw('linear', 10, 100, 12, 90);
        const h = rows[0].h;
        for (const r of rows) assert.ok(Math.abs(r.h - h) < 1e-6);
        for (let i = 1; i < rows.length; i++) {
            assert.ok(Math.abs(rows[i].top - rows[i - 1].top - (h + 1)) < 1e-6);
        }
    });

    it('on linear a row sits centered on its bucket', () => {
        const { rows, t } = draw('linear', 10, 100, 12, 90);
        const row = rows[Math.floor(rows.length / 2)];
        const center = row.top + row.h / 2;
        const price = t.yToPrice(center, H);
        // tick 1 at 600px over 90: 6.67px a tick, buckets of 8 ticks hit 30px
        const lod = 8;
        assert.ok(Math.abs(price / lod - (Math.floor(price / lod) + 0.5)) < 0.05, `center at ${price}`);
    });

    it('on log a row text sits inside its row', () => {
        const { rows, texts } = draw('log', 10, 100, 12, 90);
        const y = texts.filter((t) => t.text === '2' || t.text === '4' || t.text === '8').map((t) => t.y);
        assert.ok(y.length > 0);
        for (const v of y) assert.ok(rows.some((r) => v >= r.top && v <= r.top + r.h), `text at ${v}`);
    });
});
