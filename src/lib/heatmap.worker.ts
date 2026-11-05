import {
    configKey,
    normKey,
    type HeatmapReply,
    type HeatmapRequest,
    type TileConfig,
    type WorkerInitMessage,
} from './types/heatmap-types';
import type { MboEvent } from './types';
import { createCompactBuffer, sliceToMboEvents } from './compact-buffer';
import { type Build, type Texels, bookColumn, buildTile, feed, newBuild, pickNorm, rowNorm, seal, snapBytes, unseal } from './heatmap-build';
import { type Replay, bboBetween, extend, heldBytes, newReplay, tsAt } from './heatmap-replay';

let build: Build | null = null;
let replay: Replay | null = null;
let buildGen = 0;
// a norm stays put until the data is rebuilt, or the tiles of one config would disagree
const norms = new Map<string, number>();

function decode(msg: WorkerInitMessage): MboEvent[] {
    const cb = createCompactBuffer(0);
    cb._buf = msg.buf;
    cb._view = new DataView(msg.buf);
    cb.length = cb.capacity = msg.length;
    return sliceToMboEvents(cb, 0, msg.length);
}

const post = (reply: HeatmapReply, transfer: Transferable[] = []) =>
    (self as unknown as Worker).postMessage(reply, transfer);

// builds run one after another so an append always lands on the build before it
let chain: Promise<unknown> = Promise.resolve();

// only the latest ask counts, a pan asks again before the last tiles are out
let wanted: HeatmapRequest | null = null;
let aheadWanted: HeatmapRequest | null = null;
let fillWanted: HeatmapRequest | null = null;
let bboWanted: HeatmapRequest | null = null;
let working = false;
let normsOutdated = false;
let rebuilding = false;
let caughtUpBy: WorkerInitMessage[] = [];

function landed(from: bigint): void {
    if (build) seal(build);
    const r = replay!;
    post({ type: 'data', from: from.toString(), start: tsAt(r, 0).toString(), end: tsAt(r, r.length - 1).toString() });
    post({ type: 'held', bytes: heldBytes(r) + (build ? snapBytes(build) : 0) });
    pump();
}

// feed and extend never yield without a stale check, so no message lands halfway through this
async function addChunk(msg: WorkerInitMessage): Promise<void> {
    const r = replay;
    const b = build;
    if (!r) return;
    const from = tsAt(r, r.length - 1);
    if (b) {
        unseal(b);
        await feed(b, decode(msg));
    }
    await extend(r, msg.buf, msg.length);
    landed(from);
}

self.onmessage = (e: MessageEvent<WorkerInitMessage | HeatmapRequest>) => {
    const msg = e.data;
    if (msg.type === 'init' || msg.type === 'append') {
        // a rebuild takes seconds on real l3, the live edge can't wait on it. the chunk goes on what's
        // drawing now, and the new build takes it when it's done
        if (msg.type === 'append' && rebuilding) {
            caughtUpBy.push(msg);
            void addChunk(msg);
            return;
        }
        // keep drawing old tiles while an init builds and a newer init stops it
        const gen = msg.type === 'init' ? ++buildGen : buildGen;
        // on arrival, this init can get cancelled by a page that keeps them
        if (msg.type === 'init' && !msg.olderData) normsOutdated = true;
        if (msg.type === 'init') {
            rebuilding = true;
            caughtUpBy = [];
        }
        chain = chain.then(async () => {
            if (gen !== buildGen) return;
            if (msg.type !== 'init') return addChunk(msg);
            const fresh = msg.linesOnly ? null : newBuild();
            const freshReplay = newReplay();
            if (fresh && !(await feed(fresh, decode(msg), () => gen !== buildGen))) return;
            if (!(await extend(freshReplay, msg.buf, msg.length, () => gen !== buildGen))) return;
            for (const chunk of caughtUpBy) {
                if (fresh) {
                    unseal(fresh);
                    await feed(fresh, decode(chunk));
                }
                await extend(freshReplay, chunk.buf, chunk.length);
            }
            caughtUpBy = [];
            rebuilding = false;
            build = fresh;
            replay = freshReplay;
            // a page off screen would recolor what's on screen
            if (normsOutdated) norms.clear();
            normsOutdated = false;
            landed(0n);
        });
        return;
    }
    if (msg.type === 'drop') {
        const gen = ++buildGen;
        rebuilding = false;
        caughtUpBy = [];
        chain = chain.then(() => {
            if (gen !== buildGen) return;
            build = null;
            replay = null;
            norms.clear();
            wanted = aheadWanted = fillWanted = bboWanted = null;
            post({ type: 'held', bytes: 0 });
        });
        return;
    }
    if (msg.type === 'settle') {
        if (!build) return;
        const current = normOf(msg);
        const next = pickNorm(current, rowNorm(build.snaps, msg.column, msg.tickSize, msg.ticks, BigInt(msg.from), BigInt(msg.to)));
        if (next === current) return;
        norms.set(normKey(msg), next);
        post({ type: 'norm', normKey: normKey(msg) });
        return;
    }
    if (msg.type === 'tiles') wanted = msg;
    else if (msg.type === 'ahead') aheadWanted = msg;
    else if (msg.type === 'fill') fillWanted = msg;
    else if (msg.type === 'bbo') bboWanted = msg;
    pump();
};

function normOf(c: TileConfig): number {
    const key = normKey(c);
    let n = norms.get(key);
    if (n === undefined) norms.set(key, (n = rowNorm(build!.snaps, c.column, c.tickSize, c.ticks)));
    return n;
}

async function bitmapOf(t: Texels): Promise<ImageBitmap | null> {
    if (!t.rows) return null;
    return createImageBitmap(new ImageData(t.data as Uint8ClampedArray<ArrayBuffer>, t.cols, t.rows));
}

async function pump(): Promise<void> {
    if (working || !replay) return;
    working = true;
    try {
        while (replay && (bboWanted || (build && (wanted || aheadWanted || fillWanted)))) {
            if (bboWanted?.type === 'bbo') {
                const { from, to } = bboWanted;
                bboWanted = null;
                const b = bboBetween(replay!, BigInt(from), BigInt(to));
                post(
                    { type: 'bbo', from, to, until: b.to.toString(), ts: b.ts, bid: b.bid, ask: b.ask },
                    [b.ts.buffer, b.bid.buffer, b.ask.buffer],
                );
                continue;
            }
            if (!build) break;
            if (fillWanted?.type === 'fill') {
                const req = fillWanted;
                fillWanted = null;
                const t = bookColumn({ snaps: build.snaps, replay }, BigInt(req.ts), { ...req, norm: normOf(req) });
                const bitmap = await bitmapOf(t);
                post({ type: 'fill', key: configKey(req), ts: req.ts, ticks: t.ticks, rowLo: t.rowLo, rows: t.rows, bitmap }, bitmap ? [bitmap] : []);
                continue;
            }
            if (wanted?.type === 'tiles' && !wanted.tiles.length) wanted = null;
            if (aheadWanted?.type === 'ahead' && !aheadWanted.tiles.length) aheadWanted = null;
            const req = wanted ?? aheadWanted;
            if (req?.type !== 'tiles' && req?.type !== 'ahead') continue;
            const k = req.tiles[0];
            // the rest stay wanted unless a newer ask replaces them
            if (req === wanted) wanted = { ...req, tiles: req.tiles.slice(1) };
            else aheadWanted = { ...req, tiles: req.tiles.slice(1) };
            const built = build;
            // before the await, a chunk landing during it isn't in this bitmap. it'd claim data it hasn't got, and
            // the book at the horizon starts after a blank strip
            const until = (built.lastEventTs + 1n).toString();
            const t = buildTile({ snaps: built.snaps, replay }, k, { ...req, norm: normOf(req) });
            const bitmap = await bitmapOf(t);
            // a drop or a new init during that await
            if (build !== built) {
                bitmap?.close();
                continue;
            }
            post({ type: 'tile', key: configKey(req), k, ticks: t.ticks, rowLo: t.rowLo, rows: t.rows, bitmap, until }, bitmap ? [bitmap] : []);
        }
    } finally {
        working = false;
    }
}
