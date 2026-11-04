import { FineBbo } from './fine-bbo';
import { COLUMN_NS, TILE_COLS, columnFor, rowTicks } from './heatmap-build';
import { configKey, type HeatmapReply, type HeatmapRequest, type TileConfig } from './types/heatmap-types';
import type { ViewBounds } from './types';

const MIN_ROW_PX = 3;
const MAX_DRIFT_PX = 0.5;
const MAX_TILES = 128;
const FILL_STEP_NS = 250_000_000n;
const OVERVIEW_TILES = 4n;

// the finest column that fits all the data in a few tiles
export function overviewColumn(start: bigint, end: bigint): number {
    const want = end - start;
    for (let i = 0; i < COLUMN_NS.length; i++) if (COLUMN_NS[i] * BigInt(TILE_COLS) * OVERVIEW_TILES >= want) return i;
    return COLUMN_NS.length - 1;
}

type Tile = {
    k: number;
    rowLo: number;
    rows: number;
    bitmap: ImageBitmap | null;
    until: bigint;
    stale?: boolean;
    drawnAt?: number;
    // a chunk can land between this and its first draw, that tail is short too
    landedAt?: number;
    // came back on screen with a blank tail, not a live chunk's short one
    oldTail?: boolean;
};
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
    private range: { start: bigint; end: bigint } | null = null;
    // zooming out shows time no zoom has tiles for, this always has it
    private overview: TileConfig | null = null;
    private oldOverview: string | null = null;
    private overviewAsked = '';
    private frame = 0;
    private lastRange = 0;
    //bitmaps the last frame drew, for tests
    drawn: ImageBitmap[] = [];
    readonly bbo: FineBbo;

    constructor(
        private post: (req: HeatmapRequest) => void,
        private changed: () => void,
        private status: (recalculating: boolean) => void,
        exactLines?: (wanted: boolean) => void,
    ) {
        this.bbo = new FineBbo(post, changed, exactLines);
    }

    get workerStart(): bigint | null {
        return this.range?.start ?? null;
    }

    onReply(r: Exclude<HeatmapReply, { type: 'held' }>): void {
        if (r.type === 'bbo') {
            this.bbo.onReply(r);
            return;
        }
        if (r.type === 'data') {
            this.bbo.dataFrom(BigInt(r.from));
            this.range = { start: BigInt(r.start), end: BigInt(r.end) };
            this.invalidate(BigInt(r.from));
            if (r.from === '0') this.dropOtherZooms();
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
        const was = tiles.get(r.k);
        was?.bitmap?.close();
        if (!was) this.count++;
        tiles.set(r.k, {
            k: r.k,
            rowLo: r.rowLo,
            rows: r.rows,
            bitmap: r.bitmap,
            until: BigInt(r.until),
            drawnAt: was?.drawnAt,
            landedAt: this.frame,
        });
        // an overview tile landing shouldn't push out what's on screen
        const shown = this.seen ? configKey(this.seen.config) : r.key;
        this.evict(this.overview && r.key === configKey(this.overview) ? shown : r.key);
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
        this.overviewAsked = '';
        this.changed();
    }

    // older orders changed the book in all of them, and they're near empty where the old data began
    private dropOtherZooms(): void {
        const s = this.seen;
        if (!s) return;
        const before = this.overview && configKey(this.overview);
        this.askOverview(s.config, null);
        const now = this.overview && configKey(this.overview);
        for (const [key, tiles] of this.byConfig) {
            if (key === configKey(s.config) || key === before || key === now) continue;
            this.dropZoom(key, tiles);
        }
        this.oldOverview = before !== now ? before : null;
    }

    private dropZoom(key: string, tiles: Map<number, Tile>): void {
        for (const t of tiles.values()) t.bitmap?.close();
        this.count -= tiles.size;
        this.byConfig.delete(key);
    }

    clear(): void {
        this.range = null;
        this.seen = null;
        this.overview = null;
        this.oldOverview = null;
        this.overviewAsked = '';
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
        this.frame++;
        const { view, w, h } = v;
        const tRange = Number(view.tMax - view.tMin);
        const pRange = view.pMax - view.pMin;
        if (w <= 0 || h <= 0 || tRange <= 0 || pRange <= 0) return;

        // at the top of the view, where a tick is smallest on a log axis
        const tickPx = v.priceToY(view.pMax - v.tickSize) - v.priceToY(view.pMax);
        const config: TileConfig = {
            column: columnFor(tRange / w, v.finestNs),
            tickSize: v.tickSize,
            // rounded so linear's float noise can't flip a zoom's row size over the line
            ticks: rowTicks(Number(tickPx.toFixed(6)), MIN_ROW_PX),
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
            // on a whole pixel like the book, half covered by both comes out thinner than either
            ctx.rect(0, 0, Math.max(0, Math.round(v.tsToX(cut))), h);
            ctx.clip();
        }

        // only then can a chunk's flash be seen, in a zoom a hole is what shows
        const steady = this.lastRange === tRange;
        this.lastRange = tRange;
        const missing: number[] = [];
        let lastOnScreen = false;
        let liveEdge = false;
        const kFrom = Number(view.tMin / span);
        const kTo = Number((end - 1n) / span);
        for (let k = kFrom; k <= kTo && end > view.tMin; k++) {
            const t = tiles?.get(k);
            const tileEnd = BigInt(k + 1) * span;
            if (t) {
                // held since before the data got this far, zoom away and back and its tail is blank. a live
                // chunk's tail gets the book, it's this level's brightness, another level flashes every chunk
                const wasOn = t.drawnAt === this.frame - 1;
                if (t.stale && t.until < tileEnd && (!steady || (!wasOn && t.landedAt !== this.frame - 1))) t.oldTail = true;
                t.drawnAt = this.frame;
                lastOnScreen = wasOn && steady && !t.oldTail;
                if (t.stale && t.until < tileEnd) {
                    const start = BigInt(k) * span;
                    const tail = t.until > start ? ceilTo(t.until, colNs) : start;
                    // the last tile's tail gets the book further down, a chunk that crossed into the next tile needs it here
                    if (t.oldTail) this.fallback(ctx, tail, tileEnd, key, config.tickSize, v);
                    else if (k < kTo && !this.paintBook(ctx, tail, tileEnd, config.tickSize, v))
                        this.fallback(ctx, tail, tileEnd, key, config.tickSize, v);
                }
                this.paint(ctx, t, span, config, v);
                // keeps it last in line for eviction
                tiles!.delete(k);
                tiles!.set(k, t);
                if (t.stale) missing.push(k);
            } else {
                missing.push(k);
                // a chunk crossed into a tile nobody's built, that's a tail too
                if (cut !== null && k === kTo && lastOnScreen) liveEdge = true;
                else this.fallback(ctx, BigInt(k) * span, tileEnd, key, config.tickSize, v);
                lastOnScreen = false;
            }
        }
        ctx.restore();

        if (cut !== null) {
            // the horizon moves when a live chunk lands, the tile that has it comes later. blank strip every chunk
            const until = this.paintedUntil(tiles, kFrom, kTo, span, key, config.tickSize, liveEdge);
            let from = cut;
            if (until !== null) {
                const end = ((until + colNs - 1n) / colNs) * colNs;
                if (end < from) from = end;
            }
            if (from < view.tMax) this.drawFill(ctx, key, config, from, v);
        }
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
        this.askOverview(config, v.horizon > 0n ? v.horizon - (view.tMax - view.tMin) : 0n);
    }

    // the view stopped moving
    settled(): void {
        const s = this.seen;
        if (!s || s.to <= s.from) return;
        this.post({ type: 'settle', from: s.from.toString(), to: s.to.toString(), ...s.config });
        this.askOverview(s.config, null);
    }

    // a live chunk stales its last tile, rebuilt once a view's width behind or the view stops, null means now
    private askOverview(c: TileConfig, staleBefore: bigint | null): void {
        const r = this.range;
        if (!r) return;
        const column = overviewColumn(r.start, r.end);
        const o = this.overview;
        if (!o || o.column !== column || o.tickSize !== c.tickSize || o.contrast !== c.contrast || o.palette !== c.palette)
            this.overview = { ...c, column };
        const config = this.overview!;
        const key = configKey(config);
        const span = COLUMN_NS[column] * BigInt(TILE_COLS);
        const tiles = this.byConfig.get(key);
        const want: number[] = [];
        for (let k = r.start / span; k * span <= r.end; k++) {
            const t = tiles?.get(Number(k));
            if (!t || (t.stale && (staleBefore === null || t.until < staleBefore))) want.push(Number(k));
        }
        if (!want.length) {
            const old = this.oldOverview;
            this.oldOverview = null;
            const held = old && old !== configKey(c) ? this.byConfig.get(old) : null;
            if (held) this.dropZoom(old!, held);
            return;
        }
        const ask = key + '|' + want.join(',');
        if (ask === this.overviewAsked) return;
        this.overviewAsked = ask;
        this.post({ type: 'ahead', tiles: want, ...config });
    }

    private paint(ctx: CanvasRenderingContext2D, t: Tile, span: bigint, c: TileConfig, v: TileView): void {
        if (!t.bitmap) return;
        const x0 = v.tsToX(BigInt(t.k) * span);
        const x1 = v.tsToX(BigInt(t.k + 1) * span);
        this.blit(ctx, t.bitmap, t.rowLo, t.rows, c.ticks, c.tickSize, x0, x1 - x0, v);
    }

    // a bitmap's rows are even in price, a log axis isn't. straight through while that's under half a pixel off
    private blit(
        ctx: CanvasRenderingContext2D,
        bitmap: ImageBitmap,
        rowLo: number,
        rows: number,
        ticks: number,
        tickSize: number,
        x: number,
        w: number,
        v: TileView,
    ): void {
        this.drawn.push(bitmap);
        // row r is the prices from half a tick under r * ticks, so one tick rows sit on their price
        const yOf = (row: number) => v.priceToY((row * ticks - 0.5) * tickSize);
        // from the top of the bitmap down
        const yAt = (r: number) => yOf(rowLo + rows - r);
        const drift = (from: number, to: number) => {
            const mid = (from + to) >> 1;
            const between = yAt(from) + ((yAt(to) - yAt(from)) * (mid - from)) / (to - from);
            return Math.abs(yAt(mid) - between);
        };
        if (rows < 2 || !(drift(0, rows) > MAX_DRIFT_PX)) {
            ctx.drawImage(bitmap, x, yAt(0), w, yAt(rows) - yAt(0));
            return;
        }
        // log bends more down low, so split where it's off rather than evenly
        const strip = (from: number, to: number) => {
            if (to - from > 1 && drift(from, to) > MAX_DRIFT_PX) {
                const mid = (from + to) >> 1;
                strip(from, mid);
                strip(mid, to);
                return;
            }
            // on whole pixels, the bitmaps are see through so an overlap shows
            const y0 = Math.round(yAt(from));
            const y1 = Math.round(yAt(to));
            if (y1 > y0 && y1 > 0 && y0 < v.h) ctx.drawImage(bitmap, 0, from, bitmap.width, to - from, x, y0, w, y1 - y0);
        };
        strip(0, rows);
    }

    // what's held for there, scaled, until the tile comes. the last complete zoom when it has all of it,
    // zooming out goes past that, then every other zoom held too. tiles are see through so each time gets
    // one level, the finest with data there, stacked ones came out brighter
    private fallback(ctx: CanvasRenderingContext2D, from: bigint, to: bigint, key: string, tickSize: number, v: TileView): void {
        const keys = this.fallbacks(key, tickSize, from, to);
        let covered: Slice[] = [];
        for (let i = keys.length - 1; i >= 0; i--) {
            const c = parseKey(keys[i]);
            const oldCol = COLUMN_NS[c.column];
            const oldSpan = oldCol * BigInt(TILE_COLS);
            const mine: Slice[] = [];
            for (const t of this.byConfig.get(keys[i])!.values()) {
                if (!t.bitmap) continue;
                const start = BigInt(t.k) * oldSpan;
                const end = start + oldSpan;
                const reach = ceilTo(t.until < end ? t.until : end, oldCol);
                const lo = start > from ? start : from;
                const hi = reach < to ? reach : to;
                if (lo >= hi) continue;
                for (const [a, b] of without(lo, hi, covered)) {
                    ctx.save();
                    ctx.beginPath();
                    const x0 = v.tsToX(a);
                    ctx.rect(x0, 0, v.tsToX(b) - x0, v.h);
                    ctx.clip();
                    this.paint(ctx, t, oldSpan, c, v);
                    ctx.restore();
                }
                mine.push([lo, hi]);
            }
            covered = covered.concat(mine);
        }
    }

    private covers(key: string, from: bigint, to: bigint): boolean {
        const tiles = this.byConfig.get(key);
        if (!tiles) return false;
        const span = this.spanOf(key);
        const col = COLUMN_NS[parseKey(key).column];
        for (let k = from / span; k * span < to; k++) {
            const t = tiles.get(Number(k));
            if (!t) return false;
            // a tile from before the last chunks stops short, another zoom may have what's after it
            const end = (k + 1n) * span;
            if (ceilTo(t.until, col) < (end < to ? end : to)) return false;
        }
        return true;
    }

    private fallbacks(key: string, tickSize: number, from: bigint, to: bigint): string[] {
        const held = [...this.byConfig.keys()]
            .filter((o) => o !== key && parseKey(o).tickSize === tickSize)
            .sort((a, b) => Number(this.spanOf(b) - this.spanOf(a)));
        const last = this.lastDrawn;
        return last && held.includes(last) && this.covers(last, from, to) ? [last] : held;
    }

    private drawFill(ctx: CanvasRenderingContext2D, key: string, c: TileConfig, from: bigint, v: TileView): void {
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
        // a stale fill beats a gap while the new one is on its way, a zoom changes the key
        this.paintBook(ctx, from, null, c.tickSize, v);
    }

    // to the right edge when `to` is null. false if there's no book of this tick size to draw
    private paintBook(ctx: CanvasRenderingContext2D, from: bigint, to: bigint | null, tickSize: number, v: TileView): boolean {
        const f = this.fill;
        if (!f?.bitmap) return false;
        const own = parseKey(f.key);
        if (own.tickSize !== tickSize) return false;
        const x0 = Math.max(0, Math.round(v.tsToX(from)));
        const x1 = to === null ? v.w : Math.round(v.tsToX(to));
        this.blit(ctx, f.bitmap, f.rowLo, f.rows, own.ticks, own.tickSize, x0, x1 - x0, v);
        return true;
    }

    // how far the data goes in what this frame painted, the tile at the end or what fell back for it
    private paintedUntil(
        tiles: Map<number, Tile> | undefined,
        kFrom: number,
        kTo: number,
        span: bigint,
        key: string,
        tickSize: number,
        liveEdge: boolean,
    ): bigint | null {
        let until: bigint | null = null;
        for (let k = kTo; k >= kFrom; k--) {
            const t = tiles?.get(k);
            if (!t || t.until <= BigInt(k) * span) continue;
            const end = BigInt(k + 1) * span;
            if (k === kTo && !(t.oldTail && t.until < end)) return t.until;
            until = t.until < end ? t.until : end;
            break;
        }
        if (liveEdge) return until;
        const from = BigInt(kTo) * span;
        const to = from + span;
        for (const old of this.fallbacks(key, tickSize, from, to)) {
            const oldSpan = this.spanOf(old);
            const oldCol = COLUMN_NS[parseKey(old).column];
            for (const t of this.byConfig.get(old)!.values()) {
                const end = BigInt(t.k + 1) * oldSpan;
                if (end <= from || BigInt(t.k) * oldSpan >= to) continue;
                // it paints its last column whole, a fill on top of that doubles the color
                const reach = ceilTo(t.until < end ? t.until : end, oldCol);
                if (until === null || reach > until) until = reach;
            }
        }
        return until;
    }

    private spanOf(key: string): bigint {
        return COLUMN_NS[parseKey(key).column] * BigInt(TILE_COLS);
    }

    // oldest first, the config in use last
    private evict(keep: string): void {
        const overview = this.overview && configKey(this.overview);
        const order = [...this.byConfig.keys()].sort((a, b) => (a === keep ? 1 : b === keep ? -1 : 0));
        for (const key of order) {
            if (key === overview) continue;
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

type Slice = [bigint, bigint];

const ceilTo = (ts: bigint, step: bigint) => ((ts + step - 1n) / step) * step;

function without(from: bigint, to: bigint, taken: Slice[]): Slice[] {
    const out: Slice[] = [];
    let at = from;
    for (const [a, b] of [...taken].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
        if (b <= at) continue;
        if (a >= to) break;
        if (a > at) out.push([at, a]);
        at = b;
    }
    if (at < to) out.push([at, to]);
    return out;
}

function parseKey(key: string): TileConfig {
    const [column, tickSize, ticks, contrast, palette] = key.split(':');
    return { column: +column, tickSize: +tickSize, ticks: +ticks, contrast: +contrast, palette };
}
