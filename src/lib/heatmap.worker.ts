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
import { type Replay, extend, heldBytes, newReplay } from './heatmap-replay';

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
let fillWanted: HeatmapRequest | null = null;
let working = false;

self.onmessage = (e: MessageEvent<WorkerInitMessage | HeatmapRequest>) => {
    const msg = e.data;
    if (msg.type === 'init' || msg.type === 'append') {
        // keep drawing old tiles while an init builds and a newer init stops it
        const gen = msg.type === 'init' ? ++buildGen : buildGen;
        chain = chain.then(async () => {
            if (gen !== buildGen) return;
            let from = 0n;
            if (msg.type === 'init') {
                const fresh = newBuild();
                const freshReplay = newReplay();
                if (!(await feed(fresh, decode(msg), () => gen !== buildGen))) return;
                if (!(await extend(freshReplay, msg.buf, msg.length, () => gen !== buildGen))) return;
                build = fresh;
                replay = freshReplay;
                norms.clear();
            } else {
                if (!build) return;
                from = build.lastEventTs;
                unseal(build);
                await feed(build, decode(msg));
                await extend(replay!, msg.buf, msg.length);
            }
            seal(build);
            post({ type: 'data', from: from.toString() });
            post({ type: 'held', bytes: heldBytes(replay!) + snapBytes(build) });
            pump();
        });
        return;
    }
    if (msg.type === 'drop') {
        const gen = ++buildGen;
        chain = chain.then(() => {
            if (gen !== buildGen) return;
            build = null;
            replay = null;
            norms.clear();
            wanted = fillWanted = null;
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
    else if (msg.type === 'fill') fillWanted = msg;
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
    if (working || !build) return;
    working = true;
    try {
        while (build && (wanted || fillWanted)) {
            if (fillWanted?.type === 'fill') {
                const req = fillWanted;
                fillWanted = null;
                const t = bookColumn({ snaps: build.snaps, replay }, BigInt(req.ts), { ...req, norm: normOf(req) });
                const bitmap = await bitmapOf(t);
                post({ type: 'fill', key: configKey(req), ts: req.ts, rowLo: t.rowLo, rows: t.rows, bitmap }, bitmap ? [bitmap] : []);
                continue;
            }
            const req = wanted;
            if (req?.type !== 'tiles' || !req.tiles.length) {
                wanted = null;
                continue;
            }
            const k = req.tiles[0];
            // the rest stay wanted unless a newer ask replaces them
            wanted = { ...req, tiles: req.tiles.slice(1) };
            const t = buildTile({ snaps: build.snaps, replay }, k, { ...req, norm: normOf(req) });
            const bitmap = await bitmapOf(t);
            post({ type: 'tile', key: configKey(req), k, rowLo: t.rowLo, rows: t.rows, bitmap }, bitmap ? [bitmap] : []);
        }
    } finally {
        working = false;
    }
}
