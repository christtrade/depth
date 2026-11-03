import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HeatmapTiles, type TileView } from './heatmap-tiles';
import { COLUMN_NS, TILE_COLS } from './heatmap-build';
import { configKey, type HeatmapRequest } from './types/heatmap-types';

const COL = 250_000_000n;
const SPAN = COL * BigInt(TILE_COLS);

const view: TileView = {
    view: { tMin: 0n, tMax: SPAN, pMin: 99, pMax: 101 },
    w: TILE_COLS,
    h: 600,
    tsToX: (ts) => Number(ts / COL),
    priceToY: (p) => (101 - p) * 300,
    horizon: 0n,
    tickSize: 0.01,
    contrast: 0,
};
const key = configKey({ column: COLUMN_NS.indexOf(COL), tickSize: 0.01, ticks: 1, contrast: 0 });

function setup() {
    const asked: HeatmapRequest[] = [];
    const tiles = new HeatmapTiles(
        (r) => asked.push(r),
        () => {},
        () => {},
    );
    const drawn: unknown[] = [];
    const ctx = {
        imageSmoothingEnabled: true,
        save() {},
        restore() {},
        beginPath() {},
        rect() {},
        clip() {},
        drawImage: (bm: unknown) => drawn.push(bm),
    } as unknown as CanvasRenderingContext2D;
    const bitmap = { width: 256, height: 10, close() {} } as unknown as ImageBitmap;
    tiles.onReply({ type: 'tile', key, k: 0, rowLo: 9990, rows: 10, bitmap });
    return { tiles, ctx, drawn, asked, bitmap };
}

describe('heatmap tiles on screen', () => {
    it('draws the tile it has', () => {
        const { tiles, ctx, drawn, bitmap } = setup();
        tiles.draw(ctx, view);
        assert.deepEqual(drawn, [bitmap]);
    });

    it('keeps drawing a tile new data made stale until its rebuild lands, and asks for it', () => {
        const { tiles, ctx, drawn, asked, bitmap } = setup();
        tiles.onReply({ type: 'data', from: (SPAN / 2n).toString() });
        tiles.draw(ctx, view);
        assert.deepEqual(drawn, [bitmap], 'no hole while the rebuild is on its way');
        assert.deepEqual(asked.map((r) => r.type === 'tiles' && r.tiles), [[0]]);
    });

    it('does the same when the whole buffer was sent again', () => {
        const { tiles, ctx, drawn, bitmap } = setup();
        tiles.onReply({ type: 'data', from: '0' });
        tiles.draw(ctx, view);
        assert.deepEqual(drawn, [bitmap]);
    });
});
