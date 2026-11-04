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
    palette: 'heat',
    finestNs: 1_000_000,
};
const key = configKey({ column: COLUMN_NS.indexOf(COL), tickSize: 0.01, ticks: 1, contrast: 0, palette: 'heat' });

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
    tiles.onReply({ type: 'tile', key, k: 0, rowLo: 9990, rows: 10, bitmap, until: (SPAN * 100n).toString() });
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

    it('asks for brightness over what it showed once the view stops, up to the playhead', () => {
        const { tiles, ctx, asked } = setup();
        tiles.draw(ctx, { ...view, horizon: SPAN / 2n });
        tiles.settled();
        const s = asked.find((r) => r.type === 'settle');
        assert.deepEqual(s && [s.from, s.to], ['0', (SPAN / 2n).toString()]);
    });

    it('keeps drawing at the old brightness while tiles at the new one are built', () => {
        const { tiles, ctx, drawn, asked, bitmap } = setup();
        tiles.onReply({ type: 'norm', normKey: key.split(':').slice(0, 3).join(':') });
        tiles.draw(ctx, view);
        assert.deepEqual(drawn, [bitmap]);
        assert.deepEqual(asked.map((r) => r.type === 'tiles' && r.tiles), [[0]]);
    });

    it('leaves tiles of another row size alone when one brightness changes', () => {
        const { tiles, ctx, asked } = setup();
        tiles.onReply({ type: 'norm', normKey: `${COLUMN_NS.indexOf(COL)}:0.01:2` });
        tiles.draw(ctx, view);
        assert.deepEqual(asked, []);
    });

    it('does the same when the whole buffer was sent again', () => {
        const { tiles, ctx, drawn, bitmap } = setup();
        tiles.onReply({ type: 'data', from: '0' });
        tiles.draw(ctx, view);
        assert.deepEqual(drawn, [bitmap]);
    });
});

describe('the book past the data a tile has', () => {
    const cutCol = 100n;
    const live: TileView = { ...view, horizon: cutCol * COL };
    const fillBitmap = { width: 1, height: 10, close() {} } as unknown as ImageBitmap;
    const fill = (ts: bigint) => ({ type: 'fill' as const, key, ts: ts.toString(), rowLo: 9990, rows: 10, bitmap: fillBitmap });

    function liveSetup() {
        const s = setup();
        const xs: number[] = [];
        s.ctx.drawImage = ((bm: unknown, x: number) => {
            if (bm === fillBitmap) xs.push(x);
        }) as never;
        s.tiles.onReply(fill(live.horizon));
        return { ...s, xs };
    }

    it('starts at the playhead while the tile is up to date', () => {
        const { tiles, ctx, xs } = liveSetup();
        tiles.draw(ctx, live);
        assert.deepEqual(xs, [100]);
    });

    const tile = (k: number, until: bigint, bitmap: ImageBitmap) => ({ type: 'tile' as const, key, k, rowLo: 9990, rows: 10, bitmap, until: until.toString() });

    it('covers what a live chunk added before the worker even heard of it, till the rebuilt tile lands', () => {
        const { tiles, ctx, xs, bitmap } = liveSetup();
        // built with data into column 90, the chunk took the playhead to 100
        tiles.onReply(tile(0, 90n * COL + 1n, bitmap));
        tiles.draw(ctx, live);
        assert.deepEqual(xs, [91], 'column 90 has its data up to there');
        xs.length = 0;
        tiles.onReply({ type: 'data', from: (90n * COL + 1n).toString() });
        tiles.draw(ctx, live);
        assert.deepEqual(xs, [91], 'still, the old tile is what draws');
        xs.length = 0;
        tiles.onReply(tile(0, 100n * COL, bitmap));
        tiles.draw(ctx, live);
        assert.deepEqual(xs, [100]);
    });

    const past = { ...live, horizon: SPAN + 10n * COL, view: { ...view.view, tMax: SPAN * 2n }, w: TILE_COLS * 2 };

    it('covers a tile that doesnt exist yet when a chunk crossed into it', () => {
        const { tiles, ctx, xs, bitmap } = liveSetup();
        tiles.onReply(fill(past.horizon));
        tiles.onReply(tile(0, SPAN - 5n * COL + 1n, bitmap));
        tiles.draw(ctx, past);
        assert.deepEqual(xs, [TILE_COLS - 4]);
    });

    it('goes back past a tile built before any data got to it', () => {
        const { tiles, ctx, xs, bitmap } = liveSetup();
        tiles.onReply(fill(past.horizon));
        tiles.onReply(tile(0, SPAN - 5n * COL + 1n, bitmap));
        tiles.onReply(tile(1, SPAN - 5n * COL + 1n, bitmap));
        tiles.draw(ctx, past);
        assert.deepEqual(xs, [TILE_COLS - 4]);
    });

    it('with no tile on screen yet, zooming, the book still starts at the playhead', () => {
        const { tiles, ctx, xs } = liveSetup();
        const later = { ...past, view: { ...past.view, tMin: SPAN } };
        tiles.onReply(fill(past.horizon));
        tiles.draw(ctx, later);
        assert.deepEqual(xs, [TILE_COLS + 10]);
    });
});
