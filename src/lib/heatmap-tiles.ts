import { FineBbo } from './fine-bbo';
import { COLUMN_NS, TILE_COLS, columnFor, rowTicks } from './heatmap-build';
import { configKey, type HeatmapReply, type HeatmapRequest, type TileConfig } from './types/heatmap-types';
import type { ViewBounds } from './types';

const MIN_ROW_PX = 3;
const MAX_TILES = 128;
const FILL_STEP_NS = 250_000_000n;

type Tile = { k: number; rowLo: number; rows: number; bitmap: ImageBitmap | null; stale?: boolean };
type Fill = { key: string; ts: bigint; rowLo: number; rows: number; bitmap: ImageBitmap | null; stale?: boolean };

export type TileView = {
    view: ViewBounds;
    w: number;
    h: number;
    tsToX: (ts: bigint) => number;
    priceToY: (price: number) => number;
    /** 0n when there's no playhead */
    horizon: bigint;
    tickSize: number;
    contrast: number;
    palette: string;
    finestNs: number;
};

export class HeatmapTiles {
    private byConfig = new Map<string, Map<number, Tile>>();
    private count = 0;
    private lastDrawn: string | null = null;
    private asked = '';
    private fill: Fill | null = null;
    private fillAsked = '';
    private missing = false;
    private seen: { config: TileConfig; from: bigint; to: bigint } | null = null;
    //bitmaps the last frame drew, for tests
    drawn: ImageBitmap[] = [];
    readonly bbo: FineBbo;

    constructor(
        private post: (req: HeatmapRequest) => void,
        private changed: () => void,
        private status: (recalculating: boolean) => void,
    ) {
        this.bbo = new FineBbo(post, changed);
    }

    onReply(r: Exclude<HeatmapReply, { type: 'held' }>): void {
        if (r.type === 'bbo') {
            this.bbo.onReply(r);
            return;
        }
        if (r.type === 'data') {
            this.bbo.dataFrom(BigInt(r.from));
            this.invalidate(BigInt(r.from));
            return;
        }
        if (r.type === 'norm') {
            for (const [key, tiles] of this.byConfig)
                if (key.startsWith(r.normKey + ':')) for (const t of tiles.values()) t.stale = true;
            if (this.fill?.key.startsWith(r.normKey + ':')) this.fill.stale = true;
            this.asked = '';
            this.fillAsked = '';
            this.changed();
            return;
        }
        if (r.type === 'fill') {
            this.fill?.bitmap?.close();
            this.fill = { key: r.key, ts: BigInt(r.ts), rowLo: r.rowLo, rows: r.rows, bitmap: r.bitmap };
            this.fillAsked = '';
            this.changed();
            return;
        }
        let tiles = this.byConfig.get(r.key);
        if (!tiles) this.byConfig.set(r.key, (tiles = new Map()));
        tiles.get(r.k)?.bitmap?.close();
        if (!tiles.has(r.k)) this.count++;
        tiles.set(r.k, { k: r.k, rowLo: r.rowLo, rows: r.rows, bitmap: r.bitmap });
        this.evict(r.key);
        this.changed();
    }

    // the tiles that reach past `from` (all of them at 0) get asked for again. they keep drawing until
    // the new ones land, a dropped tile left a black strip for a frame on every live chunk
    invalidate(from: bigint): void {
        for (const [key, tiles] of this.byConfig) {
            const span = this.spanOf(key);
            for (const [k, t] of tiles) if (from === 0n || BigInt(k + 1) * span > from) t.stale = true;
        }
        if (this.fill) this.fill.stale = true;
        this.asked = '';
        this.fillAsked = '';
        this.changed();
    }

    clear(): void {
        for (const tiles of this.byConfig.values()) for (const t of tiles.values()) t.bitmap?.close();
        this.fill?.bitmap?.close();
        this.fill = null;
        this.byConfig.clear();
        this.count = 0;
        this.lastDrawn = null;
        this.bbo.clear();
    }

    draw(ctx: CanvasRenderingContext2D, v: TileView): void {
        this.drawn = [];
        const { view, w, h } = v;
        const tRange = Number(view.tMax - view.tMin);
        const pRange = view.pMax - view.pMin;
        if (w <= 0 || h <= 0 || tRange <= 0 || pRange <= 0) return;

        const config: TileConfig = {
            column: columnFor(tRange / w, v.finestNs),
            tickSize: v.tickSize,
            ticks: rowTicks((v.tickSize / pRange) * h, MIN_ROW_PX),
            contrast: v.contrast,
            palette: v.palette,
        };
        const key = configKey(config);
        const colNs = COLUMN_NS[config.column];
        const span = colNs * BigInt(TILE_COLS);
        const cut = v.horizon > 0n ? (v.horizon / colNs) * colNs : null;
        const end = cut !== null && cut < view.tMax ? cut : view.tMax;
        const tiles = this.byConfig.get(key);
        this.seen = { config, from: view.tMin, to: end };

        const smoothing = ctx.imageSmoothingEnabled;
        ctx.imageSmoothingEnabled = false;
        ctx.save();
        if (cut !== null) {
            ctx.beginPath();
            ctx.rect(0, 0, Math.max(0, v.tsToX(cut)), h);
            ctx.clip();
        }

        const missing: number[] = [];
        const kFrom = Number(view.tMin / span);
        const kTo = Number((end - 1n) / span);
        for (let k = kFrom; k <= kTo && end > view.tMin; k++) {
            const t = tiles?.get(k);
            if (t) {
                this.paint(ctx, t, span, config, v);
                // keeps it last in line for eviction
                tiles!.delete(k);
                tiles!.set(k, t);
                if (t.stale) missing.push(k);
            } else {
                missing.push(k);
                this.fallback(ctx, k, span, v);
            }
        }
        ctx.restore();

        if (cut !== null && cut < view.tMax) this.drawFill(ctx, key, config, cut, v);
        ctx.imageSmoothingEnabled = smoothing;

        if (!missing.length) this.lastDrawn = key;
        else {
            // middle of the view first
            const mid = Number((view.tMin + view.tMax) / 2n / span);
            missing.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
            const ask = key + '|' + missing.join(',');
            if (ask !== this.asked) {
                this.asked = ask;
                this.post({ type: 'tiles', tiles: missing, ...config });
            }
        }
        if (this.missing !== missing.length > 0) {
            this.missing = missing.length > 0;
            const busy = this.missing;
            queueMicrotask(() => this.status(busy));
        }
    }

    // the view stopped moving
    settled(): void {
        const s = this.seen;
        if (!s || s.to <= s.from) return;
        this.post({ type: 'settle', from: s.from.toString(), to: s.to.toString(), ...s.config });
    }

    private paint(ctx: CanvasRenderingContext2D, t: Tile, span: bigint, c: TileConfig, v: TileView): void {
        if (!t.bitmap) return;
        const x0 = v.tsToX(BigInt(t.k) * span);
        const x1 = v.tsToX(BigInt(t.k + 1) * span);
        // row r is the prices from half a tick under r * ticks, so one tick rows sit on their price
        const top = v.priceToY(((t.rowLo + t.rows) * c.ticks - 0.5) * c.tickSize);
        const bottom = v.priceToY((t.rowLo * c.ticks - 0.5) * c.tickSize);
        ctx.drawImage(t.bitmap, x0, top, x1 - x0, bottom - top);
        this.drawn.push(t.bitmap);
    }

    // what the last complete zoom drew there, scaled, until the tile comes
    private fallback(ctx: CanvasRenderingContext2D, k: number, span: bigint, v: TileView): void {
        if (!this.lastDrawn) return;
        const tiles = this.byConfig.get(this.lastDrawn);
        if (!tiles) return;
        const c = parseKey(this.lastDrawn);
        const oldSpan = COLUMN_NS[c.column] * BigInt(TILE_COLS);
        const from = BigInt(k) * span;
        const to = from + span;
        ctx.save();
        ctx.beginPath();
        const x0 = v.tsToX(from);
        ctx.rect(x0, 0, v.tsToX(to) - x0, v.h);
        ctx.clip();
        for (const t of tiles.values()) {
            if (BigInt(t.k + 1) * oldSpan <= from || BigInt(t.k) * oldSpan >= to) continue;
            this.paint(ctx, t, oldSpan, c, v);
        }
        ctx.restore();
    }

    private drawFill(ctx: CanvasRenderingContext2D, key: string, c: TileConfig, cut: bigint, v: TileView): void {
        const step = COLUMN_NS[c.column] < FILL_STEP_NS ? COLUMN_NS[c.column] : FILL_STEP_NS;
        const ts = (v.horizon / step) * step;
        const f = this.fill;
        if (!f || f.key !== key || f.ts !== ts || f.stale) {
            const ask = key + '|' + ts;
            if (ask !== this.fillAsked) {
                this.fillAsked = ask;
                this.post({ type: 'fill', ts: ts.toString(), ...c });
            }
        }
        // a stale fill beats a gap while the new one is on its way
        if (!f?.bitmap || f.key !== key) return;
        const x0 = Math.max(0, v.tsToX(cut));
        const top = v.priceToY(((f.rowLo + f.rows) * c.ticks - 0.5) * c.tickSize);
        const bottom = v.priceToY((f.rowLo * c.ticks - 0.5) * c.tickSize);
        ctx.drawImage(f.bitmap, x0, top, v.w - x0, bottom - top);
        this.drawn.push(f.bitmap);
    }

    private spanOf(key: string): bigint {
        return COLUMN_NS[parseKey(key).column] * BigInt(TILE_COLS);
    }

    // oldest first, the config in use last
    private evict(keep: string): void {
        const order = [...this.byConfig.keys()].sort((a, b) => (a === keep ? 1 : b === keep ? -1 : 0));
        for (const key of order) {
            const tiles = this.byConfig.get(key)!;
            for (const [k, t] of tiles) {
                if (this.count <= MAX_TILES) return;
                t.bitmap?.close();
                tiles.delete(k);
                this.count--;
            }
            if (!tiles.size && key !== keep) this.byConfig.delete(key);
        }
    }
}

function parseKey(key: string): TileConfig {
    const [column, tickSize, ticks, contrast, palette] = key.split(':');
    return { column: +column, tickSize: +tickSize, ticks: +ticks, contrast: +contrast, palette };
}
