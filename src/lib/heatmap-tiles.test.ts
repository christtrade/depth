import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HeatmapTiles, overviewColumn, type TileView } from './heatmap-tiles';
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
const data = (from: bigint, end = SPAN) => ({ type: 'data' as const, from: from.toString(), start: '0', end: end.toString() });
// a frame looking somewhere else, the next one comes back to whatever was held
const away = (s: { tiles: HeatmapTiles; ctx: CanvasRenderingContext2D }) =>
    s.tiles.draw(s.ctx, { ...view, view: { ...view.view, tMin: SPAN * 8n, tMax: SPAN * 9n } });

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
        tiles.onReply(data(SPAN / 2n));
        tiles.draw(ctx, view);
        assert.deepEqual(drawn, [bitmap], 'no hole while the rebuild is on its way');
        assert.deepEqual(asked.filter((r) => r.type === 'tiles').map((r) => r.tiles), [[0]]);
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
        tiles.onReply(data(0n));
        tiles.draw(ctx, view);
        assert.deepEqual(drawn, [bitmap]);
    });
});

describe('what draws while a zoom waits on its tiles', () => {
    const bm = (name: string) => ({ name, width: 256, height: 10, close() {} }) as unknown as ImageBitmap;
    const reply = (k: number, column: bigint, bitmap: ImageBitmap) => ({
        type: 'tile' as const,
        key: configKey({ column: COLUMN_NS.indexOf(column), tickSize: 0.01, ticks: 1, contrast: 0, palette: 'heat' }),
        k,
        rowLo: 9990,
        rows: 10,
        bitmap,
        until: (SPAN * 100n).toString(),
    });
    const coarser = COL * 4n;
    // a view at each column, the same price range
    const at = (column: bigint, cols: bigint, to: bigint): TileView => ({ ...view, view: { ...view.view, tMin: to - column * cols, tMax: to }, w: Number(cols) });

    it('the last complete zoom alone when it has all of it', () => {
        const { tiles, ctx, drawn } = setup();
        tiles.onReply(reply(0, coarser, bm('coarse')));
        tiles.draw(ctx, view);
        drawn.length = 0;
        // 25ms columns
        tiles.draw(ctx, at(COL / 10n, BigInt(TILE_COLS), COL * 100n));
        assert.deepEqual([...new Set(drawn.map((b: any) => b.name ?? 'last'))], ['last']);
    });

    it('under the blank tail of a tile held since before the data got that far', () => {
        const { tiles, ctx, drawn, bitmap } = setup();
        tiles.onReply({ type: 'tile', key, k: 0, rowLo: 9990, rows: 10, bitmap, until: (90n * COL).toString() });
        tiles.onReply(reply(0, coarser, bm('coarse')));
        tiles.onReply(data(90n * COL));
        away({ tiles, ctx });
        drawn.length = 0;
        tiles.draw(ctx, view);
        assert.deepEqual(drawn.map((b: any) => b.name ?? 'tile'), ['coarse', 'tile']);
    });

    it('not while the tile is up to date, a tile past the end of the data is just short', () => {
        const { tiles, ctx, drawn, bitmap } = setup();
        tiles.onReply({ type: 'tile', key, k: 0, rowLo: 9990, rows: 10, bitmap, until: (90n * COL).toString() });
        tiles.onReply(reply(0, coarser, bm('coarse')));
        tiles.draw(ctx, view);
        assert.deepEqual(drawn.map((b: any) => b.name ?? 'tile'), ['tile']);
    });

    it('zooming out past it, the other zooms held fill in, the finest with data first', () => {
        const { tiles, ctx, drawn } = setup();
        tiles.onReply(reply(0, coarser, bm('coarse')));
        tiles.draw(ctx, view);
        drawn.length = 0;
        // 5s columns reach past the only tile of the last zoom
        tiles.draw(ctx, at(COL * 20n, BigInt(TILE_COLS), SPAN * 20n));
        assert.deepEqual(drawn.map((b: any) => b.name ?? 'last'), ['last', 'coarse']);
    });

    // tiles are see through, a time painted twice comes out brighter
    it('paints each time once, however many levels are held', () => {
        const s = setup();
        const painted: [number, number, string][] = [];
        let clip = [0, 0];
        (s.ctx as any).rect = (x: number, _y: number, w: number) => (clip = [x, x + w]);
        (s.ctx as any).drawImage = (b: any) => painted.push([clip[0], clip[1], b.name ?? 'tile']);
        const v = { ...view, tsToX: (ts: bigint) => Number(ts) / Number(COL) };
        // on screen with a stale tail from 90, a finer level has up to 94, a coarser one all of it
        s.tiles.onReply({ type: 'tile', key, k: 0, rowLo: 9990, rows: 10, bitmap: s.bitmap, until: (90n * COL).toString() });
        s.tiles.onReply({ ...reply(3, COL / 10n, bm('fine')), until: (94n * COL).toString() });
        s.tiles.onReply({ ...reply(0, coarser, bm('coarse')), until: SPAN.toString() });
        s.tiles.onReply(data(90n * COL));
        away(s);
        painted.length = 0;
        s.tiles.draw(s.ctx, v);
        const under = painted.filter((p) => p[2] !== 'tile');
        assert.deepEqual(under, [
            [90, 94, 'fine'],
            [94, 256, 'coarse'],
        ]);
    });

    it('a level holds no slice past where its data ends, or with no rows', () => {
        const s = setup();
        const names: string[] = [];
        (s.ctx as any).drawImage = (b: any) => names.push(b.name ?? 'tile');
        s.tiles.onReply({ ...reply(0, COL / 10n, bm('fine')), bitmap: null, until: SPAN.toString() });
        s.tiles.onReply({ ...reply(0, coarser, bm('coarse')), until: SPAN.toString() });
        s.tiles.onReply({ type: 'tile', key, k: 0, rowLo: 9990, rows: 10, bitmap: s.bitmap, until: '0' });
        s.tiles.onReply(data(0n));
        away(s);
        names.length = 0;
        s.tiles.draw(s.ctx, view);
        assert.deepEqual(names, ['coarse', 'tile'], 'the empty finer tile doesnt hide it');
    });

    it('never another tick sizes tiles', () => {
        const { tiles, ctx, drawn } = setup();
        tiles.draw(ctx, view);
        drawn.length = 0;
        tiles.draw(ctx, { ...view, tickSize: 0.25 });
        assert.deepEqual(drawn, []);
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
        tiles.onReply(data(90n * COL + 1n));
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

    it('a tile only paints up to its own end, however far the data went when it was built', () => {
        const { tiles, ctx, xs, bitmap } = liveSetup();
        tiles.onReply(fill(past.horizon));
        tiles.onReply(tile(0, SPAN + 5n * COL, bitmap));
        tiles.draw(ctx, past);
        assert.deepEqual(xs, [TILE_COLS]);
    });

    it('goes back past a tile built before any data got to it', () => {
        const { tiles, ctx, xs, bitmap } = liveSetup();
        tiles.onReply(fill(past.horizon));
        tiles.onReply(tile(0, SPAN - 5n * COL + 1n, bitmap));
        tiles.onReply(tile(1, SPAN - 5n * COL + 1n, bitmap));
        tiles.draw(ctx, past);
        assert.deepEqual(xs, [TILE_COLS - 4]);
    });

    // twice the price range, so rows of 2 ticks and every tile and the fill are from another config
    const zoomed: TileView = { ...live, view: { ...view.view, pMin: 97 } };
    const zoomedKey = configKey({ column: COLUMN_NS.indexOf(COL), tickSize: 0.01, ticks: 2, contrast: 0, palette: 'heat' });

    it('keeps drawing the old book through a zoom, on its own rows, till the new one lands', () => {
        const { tiles, ctx, asked, bitmap } = liveSetup();
        tiles.onReply(tile(0, 100n * COL, bitmap));
        tiles.draw(ctx, live);
        const at: number[][] = [];
        ctx.drawImage = ((bm: unknown, x: number, y: number, _w: number, h: number) => {
            if (bm === fillBitmap) at.push([x, y, h]);
        }) as never;
        asked.length = 0;
        tiles.draw(ctx, zoomed);
        const top = zoomed.priceToY((9990 + 10 - 0.5) * 0.01);
        const bottom = zoomed.priceToY((9990 - 0.5) * 0.01);
        assert.deepEqual(at, [[100, top, bottom - top]]);
        assert.ok(asked.some((r) => r.type === 'fill' && r.ticks === 2), 'and asks for the new one');
        at.length = 0;
        tiles.onReply({ ...fill(live.horizon), key: zoomedKey, rowLo: 1000, rows: 5 });
        tiles.draw(ctx, zoomed);
        const top2 = zoomed.priceToY((1005 * 2 - 0.5) * 0.01);
        assert.deepEqual(at.map((a) => a[1]), [top2]);
    });

    it('doesnt draw another symbols book when the tick size changed', () => {
        const { tiles, ctx, xs } = liveSetup();
        tiles.draw(ctx, { ...live, tickSize: 0.25 });
        assert.deepEqual(xs, []);
    });

    it('covers past the data of the old tiles a zoom falls back on', () => {
        const { tiles, ctx, xs, bitmap } = liveSetup();
        tiles.onReply(tile(0, 100n * COL, bitmap));
        tiles.draw(ctx, live);
        tiles.onReply(tile(0, 90n * COL + 1n, bitmap));
        xs.length = 0;
        tiles.draw(ctx, zoomed);
        assert.deepEqual(xs, [91]);
    });

    const coarseKey = configKey({ column: COLUMN_NS.indexOf(COL * 4n), tickSize: 0.01, ticks: 1, contrast: 0, palette: 'heat' });
    const coarse = (until: bigint, bitmap: ImageBitmap) => ({ type: 'tile' as const, key: coarseKey, k: 0, rowLo: 9990, rows: 10, bitmap, until: until.toString() });

    it('starts past the last column of a coarser tile, it paints that column whole', () => {
        const { tiles, ctx, xs, bitmap } = liveSetup();
        // data into 88-91, that column of 4 paints up to 92
        tiles.onReply(coarse(90n * COL + 1n, bitmap));
        (tiles as any).byConfig.get(key).clear();
        tiles.draw(ctx, live);
        assert.deepEqual(xs, [92]);
    });

    it('starts past a coarser tile under the tail of a stale one come back on screen', () => {
        const { tiles, ctx, xs, bitmap } = liveSetup();
        tiles.onReply(tile(0, 90n * COL + 1n, bitmap));
        tiles.onReply(coarse(93n * COL + 1n, bitmap));
        tiles.onReply(data(90n * COL + 1n, 100n * COL));
        away({ tiles, ctx });
        xs.length = 0;
        tiles.draw(ctx, live);
        assert.deepEqual(xs, [96]);
    });

    describe('when a live chunk lands, no other level shows at the horizon', () => {
        const names = (s: ReturnType<typeof liveSetup>) => {
            const seen: string[] = [];
            (s.ctx as any).drawImage = (b: any, x: number) => {
                if (b === fillBitmap) s.xs.push(x);
                else seen.push(b.name ?? 'tile');
            };
            return seen;
        };
        const named = { name: 'coarse', width: 256, height: 10, close() {} } as unknown as ImageBitmap;

        it('the book covers the tail of a tile that was on screen', () => {
            const s = liveSetup();
            const seen = names(s);
            s.tiles.onReply(tile(0, 90n * COL + 1n, s.bitmap));
            s.tiles.onReply(coarse(99n * COL + 1n, named));
            s.tiles.draw(s.ctx, live);
            s.tiles.onReply(data(90n * COL + 1n, 100n * COL));
            seen.length = 0;
            s.xs.length = 0;
            s.tiles.draw(s.ctx, live);
            assert.deepEqual(seen, ['tile']);
            assert.deepEqual(s.xs, [91]);
        });

        it('same when it crossed into a tile nobody has built', () => {
            const s = liveSetup();
            const seen = names(s);
            s.tiles.onReply(fill(past.horizon));
            s.tiles.onReply(tile(0, SPAN - 5n * COL + 1n, s.bitmap));
            s.tiles.onReply(coarse(SPAN + 5n * COL, named));
            const before = { ...past, horizon: SPAN - 5n * COL };
            s.tiles.draw(s.ctx, before);
            seen.length = 0;
            s.xs.length = 0;
            s.tiles.draw(s.ctx, past);
            assert.deepEqual(seen, ['tile']);
            assert.deepEqual(s.xs, [TILE_COLS - 4]);
        });

        it('even if the chunk landed between the tile arriving and its first draw', () => {
            const s = liveSetup();
            const seen = names(s);
            s.tiles.draw(s.ctx, live);
            s.tiles.onReply(tile(0, 90n * COL + 1n, s.bitmap));
            s.tiles.onReply(coarse(99n * COL + 1n, named));
            s.tiles.onReply(data(90n * COL + 1n, 100n * COL));
            seen.length = 0;
            s.tiles.draw(s.ctx, live);
            assert.deepEqual(seen, ['tile']);
        });

        it('a tail before the last tile gets the book too, or it would be a hole', () => {
            const s = liveSetup();
            const seen = names(s);
            s.tiles.onReply(fill(past.horizon));
            s.tiles.onReply(tile(0, SPAN - 5n * COL + 1n, s.bitmap));
            s.tiles.onReply(coarse(SPAN + 5n * COL, named));
            s.tiles.draw(s.ctx, { ...past, horizon: SPAN - 5n * COL });
            s.tiles.onReply(data(SPAN - 5n * COL + 1n, past.horizon));
            s.tiles.onReply(tile(1, past.horizon, s.bitmap));
            seen.length = 0;
            s.xs.length = 0;
            s.tiles.draw(s.ctx, past);
            assert.deepEqual(seen, ['tile', 'tile'], 'no other level');
            assert.equal(s.xs[0], TILE_COLS - 4, 'the book in the gap');
        });

        it('and the level under it when there is no book yet', () => {
            const s = setup();
            const seen: string[] = [];
            (s.ctx as any).drawImage = (b: any) => seen.push(b.name ?? 'tile');
            const t = (k: number, until: bigint) => ({ type: 'tile' as const, key, k, rowLo: 9990, rows: 10, bitmap: s.bitmap, until: until.toString() });
            s.tiles.onReply(t(0, SPAN - 5n * COL + 1n));
            s.tiles.onReply({ type: 'tile', key: coarseKey, k: 0, rowLo: 9990, rows: 10, bitmap: named, until: (SPAN + 5n * COL).toString() });
            s.tiles.draw(s.ctx, { ...past, horizon: SPAN - 5n * COL });
            s.tiles.onReply(data(SPAN - 5n * COL + 1n, past.horizon));
            s.tiles.onReply(t(1, past.horizon));
            seen.length = 0;
            s.tiles.draw(s.ctx, past);
            assert.deepEqual(seen, ['coarse', 'tile', 'tile']);
        });

        it('in a zoom the level under it draws, a hole shows there and a flash doesnt', () => {
            const s = liveSetup();
            const seen = names(s);
            s.tiles.onReply(tile(0, 90n * COL + 1n, s.bitmap));
            s.tiles.onReply(coarse(99n * COL + 1n, named));
            s.tiles.draw(s.ctx, live);
            s.tiles.onReply(data(90n * COL + 1n, 100n * COL));
            seen.length = 0;
            s.tiles.draw(s.ctx, { ...live, view: { ...live.view, tMin: 1n }, tsToX: live.tsToX });
            assert.deepEqual(seen, ['coarse', 'tile']);
        });

        it('a zoom still falls back past a tile that just landed, thats not the live edge', () => {
            const s = liveSetup();
            const seen = names(s);
            s.tiles.onReply(fill(past.horizon));
            s.tiles.onReply(coarse(SPAN + 5n * COL, named));
            (s.tiles as any).byConfig.get(key).clear();
            s.tiles.draw(s.ctx, past);
            s.tiles.onReply(tile(0, SPAN, s.bitmap));
            seen.length = 0;
            s.tiles.draw(s.ctx, past);
            assert.deepEqual(seen, ['tile', 'coarse']);
        });

        it('a tile coming back on screen with a blank tail still gets the level under it', () => {
            const s = liveSetup();
            const seen = names(s);
            s.tiles.onReply(tile(0, 90n * COL + 1n, s.bitmap));
            s.tiles.onReply(coarse(99n * COL + 1n, named));
            s.tiles.onReply(data(90n * COL + 1n, 100n * COL));
            s.tiles.draw(s.ctx, live);
            s.tiles.draw(s.ctx, { ...live, view: { ...live.view, tMin: SPAN * 8n, tMax: SPAN * 9n } });
            seen.length = 0;
            s.tiles.draw(s.ctx, live);
            assert.deepEqual(seen, ['coarse', 'tile']);
            seen.length = 0;
            s.tiles.draw(s.ctx, live);
            assert.deepEqual(seen, ['coarse', 'tile'], 'and stays, till its rebuild lands');
        });
    });

    it('the tiles and the book meet on a whole pixel, half covered by both leaves a dark seam', () => {
        const s = liveSetup();
        const clips: number[] = [];
        (s.ctx as any).rect = (_x: number, _y: number, w: number) => clips.push(w);
        s.tiles.onReply(tile(0, 100n * COL, s.bitmap));
        s.tiles.draw(s.ctx, { ...live, tsToX: (ts) => Number(ts / COL) + 0.4 });
        assert.deepEqual(clips, [100]);
        assert.deepEqual(s.xs, [100]);
    });

    it('never past the playhead', () => {
        const { tiles, ctx, xs, bitmap } = liveSetup();
        tiles.onReply(coarse(99n * COL + 1n, bitmap));
        (tiles as any).byConfig.get(key).clear();
        tiles.draw(ctx, { ...live, horizon: 98n * COL });
        assert.deepEqual(xs, [98]);
    });

    it('with no tile on screen yet, zooming, the book still starts at the playhead', () => {
        const { tiles, ctx, xs } = liveSetup();
        const later = { ...past, view: { ...past.view, tMin: SPAN } };
        tiles.onReply(fill(past.horizon));
        tiles.draw(ctx, later);
        assert.deepEqual(xs, [TILE_COLS + 10]);
    });
});

describe('the overview', () => {
    const DATA = SPAN * 40n;
    const column = overviewColumn(0n, DATA);
    const ovSpan = COLUMN_NS[column] * BigInt(TILE_COLS);
    const ovKey = configKey({ column, tickSize: 0.01, ticks: 1, contrast: 0, palette: 'heat' });
    const ahead = (asked: HeatmapRequest[]) => asked.filter((r) => r.type === 'ahead');
    const bm = (name: string) => ({ name, width: 256, height: 10, close() {} }) as unknown as ImageBitmap;
    const ovTile = (k: number, until: bigint, bitmap = bm('overview')) => ({
        type: 'tile' as const,
        key: ovKey,
        k,
        rowLo: 9990,
        rows: 10,
        bitmap,
        until: until.toString(),
    });
    const held = (s: ReturnType<typeof setup>) => {
        const count = Number(DATA / ovSpan) + 1;
        for (let k = 0; k < count; k++) s.tiles.onReply(ovTile(k, DATA));
        return count;
    };

    it('is the finest column that fits the data in a few tiles', () => {
        assert.ok(COLUMN_NS[column] * BigInt(TILE_COLS) * 4n >= DATA);
        assert.ok(COLUMN_NS[column - 1] * BigInt(TILE_COLS) * 4n < DATA);
        assert.equal(overviewColumn(0n, 10n ** 30n), COLUMN_NS.length - 1);
    });

    it('asks once for all of it once it knows what loaded, at the low priority', () => {
        const { tiles, ctx, asked } = setup();
        tiles.draw(ctx, view);
        assert.deepEqual(ahead(asked), [], 'nothing loaded yet');
        tiles.onReply(data(0n, DATA));
        tiles.draw(ctx, view);
        tiles.draw(ctx, view);
        const want = Array.from({ length: Number(DATA / ovSpan) + 1 }, (_, k) => k);
        assert.deepEqual(ahead(asked).map((r) => r.type === 'ahead' && r.tiles), [want]);
    });

    it('draws for time no zoom has tiles for', () => {
        const s = setup();
        s.tiles.onReply(data(0n, DATA));
        s.tiles.draw(s.ctx, view);
        held(s);
        s.drawn.length = 0;
        // no tile of this zoom, and the last zoom only has the first SPAN
        s.tiles.draw(s.ctx, { ...view, view: { ...view.view, tMin: SPAN * 2n, tMax: SPAN * 3n } });
        assert.ok(s.drawn.some((b: any) => b.name === 'overview'));
    });

    it('isnt evicted and doesnt evict what is on screen', () => {
        const s = setup();
        s.tiles.onReply(data(0n, DATA));
        s.tiles.draw(s.ctx, view);
        const old = bm('old');
        const oldKey = configKey({ column: COLUMN_NS.indexOf(COL) - 1, tickSize: 0.01, ticks: 1, contrast: 0, palette: 'heat' });
        held(s);
        for (let k = 0; k < 200; k++) s.tiles.onReply({ type: 'tile', key: oldKey, k, rowLo: 9990, rows: 10, bitmap: old, until: DATA.toString() });
        const byConfig = (s.tiles as any).byConfig as Map<string, Map<number, unknown>>;
        assert.equal(byConfig.get(ovKey)?.size, Number(DATA / ovSpan) + 1);
        s.tiles.onReply(ovTile(0, DATA));
        assert.ok(byConfig.get(key)?.has(0) || byConfig.get(oldKey)?.size, 'something on screen left');
        assert.equal(byConfig.get(ovKey)?.size, Number(DATA / ovSpan) + 1);
    });

    it('a live chunk only rebuilds it once its a view behind, or the view stops', () => {
        const s = setup();
        const live = { ...view, horizon: SPAN };
        s.tiles.onReply(data(0n, SPAN));
        s.tiles.draw(s.ctx, live);
        const liveCol = overviewColumn(0n, SPAN);
        const liveKey = configKey({ column: liveCol, tickSize: 0.01, ticks: 1, contrast: 0, palette: 'heat' });
        const liveSpan = COLUMN_NS[liveCol] * BigInt(TILE_COLS);
        const landed = () => {
            for (let k = 0n; k * liveSpan <= SPAN; k++) s.tiles.onReply({ ...ovTile(Number(k), SPAN), key: liveKey });
        };
        landed();
        s.tiles.onReply(data(SPAN - 1n, SPAN));
        s.asked.length = 0;
        s.tiles.draw(s.ctx, live);
        assert.deepEqual(ahead(s.asked), [], 'one chunk, a few ms of worker per chunk for nothing');
        s.tiles.draw(s.ctx, { ...live, horizon: SPAN * 2n + 1n });
        assert.equal(ahead(s.asked).length, 1, 'stale past the view');

        landed();
        s.tiles.onReply(data(SPAN - 1n, SPAN));
        s.asked.length = 0;
        s.tiles.draw(s.ctx, live);
        assert.deepEqual(ahead(s.asked), []);
        s.tiles.settled();
        assert.equal(ahead(s.asked).length, 1, 'the view stopped');
    });

    it('stays put when a y zoom changes the rows, a new palette builds it again', () => {
        const s = setup();
        s.tiles.onReply(data(0n, DATA));
        s.tiles.draw(s.ctx, view);
        s.asked.length = 0;
        const squeezed = { ...view, view: { ...view.view, pMin: 90, pMax: 110 } };
        s.tiles.draw(s.ctx, squeezed);
        assert.deepEqual(ahead(s.asked), []);
        s.tiles.draw(s.ctx, { ...view, palette: '#00ff00,#ff0000' });
        assert.equal(ahead(s.asked).length, 1);
    });

    it('doesnt count as the chart waiting on tiles', async () => {
        const seen: boolean[] = [];
        const tiles = new HeatmapTiles(() => {}, () => {}, (b) => seen.push(b));
        const { ctx, bitmap } = setup();
        tiles.onReply({ type: 'tile', key, k: 0, rowLo: 9990, rows: 10, bitmap, until: SPAN.toString() });
        tiles.onReply(data(0n, DATA));
        (tiles as any).byConfig.get(key).get(0).stale = false;
        tiles.draw(ctx, view);
        await Promise.resolve();
        assert.deepEqual(seen, []);
    });
});
