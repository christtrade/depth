import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { appendEvents, BYTES_PER_EVENT, createCompactBuffer } from './compact-buffer';
import { isoToNs } from './sampler';
import { COLUMN_NS } from './heatmap-build';
import type { MboEvent } from './types';
import type { HeatmapReply } from './types/heatmap-types';

const replies: HeatmapReply[] = [];
const worker: any = { postMessage: (r: HeatmapReply) => replies.push(r) };
(globalThis as any).self = worker;
(globalThis as any).ImageData = class {};
(globalThis as any).createImageBitmap = async () => ({});

const SEC = 1_000_000_000n;
const ev = (s: number, action: string, side: string, price: number, size: number, id: number): MboEvent => ({
    ts_event: new Date(s * 1000).toISOString(),
    action: action as MboEvent['action'],
    side: side as MboEvent['side'],
    price,
    size,
    order_id: String(id),
    sequence: 0,
    flags: 0,
});
// 100 lots either side for a minute, then 1 lots for a minute
const events = [
    ev(0, 'A', 'B', 99.9, 100, 1),
    ev(0, 'A', 'A', 100.1, 100, 2),
    ev(60, 'C', 'B', 99.9, 100, 1),
    ev(60, 'C', 'A', 100.1, 100, 2),
    ev(60, 'A', 'B', 99.9, 1, 3),
    ev(60, 'A', 'A', 100.1, 1, 4),
    ev(120, 'A', 'B', 99.8, 1, 5),
];
const cfg = { column: 0, tickSize: 0.01, ticks: 1, contrast: 0, palette: 'heat' };
const send = (msg: unknown) => worker.onmessage({ data: msg });
const until = async (ok: () => boolean) => {
    for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
};

describe('the heatmap worker once a view settles', () => {
    it('switches brightness to a quiet view and says so, once', async () => {
        await import('./heatmap.worker');
        const cb = createCompactBuffer();
        appendEvents(cb, events, isoToNs);
        send({ type: 'init', buf: cb._buf.slice(0, cb.length * BYTES_PER_EVENT), length: cb.length });
        await until(() => replies.some((r) => r.type === 'data'));
        const held = replies.find((r) => r.type === 'held');
        assert.ok(held && held.bytes >= cb.length * BYTES_PER_EVENT, `says it holds its copy, got ${JSON.stringify(held)}`);

        const quiet = { type: 'settle', from: (61n * SEC).toString(), to: (120n * SEC).toString(), ...cfg };
        send(quiet);
        assert.deepEqual(
            replies.filter((r) => r.type === 'norm'),
            [{ type: 'norm', normKey: '0:0.01:1' }],
        );
        send(quiet);
        assert.equal(replies.filter((r) => r.type === 'norm').length, 1, 'the same view again changes nothing');
    });

    it('says what loaded with the data', () => {
        const d = replies.find((r) => r.type === 'data');
        assert.equal(d?.type === 'data' && d.end, (120n * SEC).toString());
    });

    it('builds ahead tiles only when nothing on screen waits, and a new ask keeps them', async () => {
        const n = replies.length;
        const far = { ...cfg, column: 0 };
        send({ type: 'ahead', tiles: [10, 11, 12], ...far });
        send({ type: 'tiles', tiles: [20], ...far });
        send({ type: 'tiles', tiles: [30, 31], ...far });
        await until(() => replies.filter((r) => r.type === 'tile').length >= 5);
        const order = replies.slice(n).flatMap((r) => (r.type === 'tile' ? [r.k] : []));
        assert.deepEqual(order, [10, 30, 31, 11, 12]);
    });

    it('survives the heatmap going off while a tile is on its way, and sends nothing', async () => {
        let closed = 0;
        let land: (b: unknown) => void = () => {};
        const real = (globalThis as any).createImageBitmap;
        (globalThis as any).createImageBitmap = () => new Promise((r) => (land = r));
        const before = replies.filter((r) => r.type === 'tile').length;
        send({ type: 'tiles', tiles: [50], ...cfg });
        send({ type: 'drop' });
        await until(() => replies.at(-1)?.type === 'held' && (replies.at(-1) as any).bytes === 0);
        land({ close: () => closed++ });
        await new Promise((r) => setTimeout(r, 10));
        (globalThis as any).createImageBitmap = real;
        assert.equal(replies.filter((r) => r.type === 'tile').length, before);
        assert.equal(closed, 1);

        const cb = createCompactBuffer();
        appendEvents(cb, events, isoToNs);
        const n = replies.length;
        send({ type: 'init', buf: cb._buf.slice(0, cb.length * BYTES_PER_EVENT), length: cb.length });
        await until(() => replies.slice(n).some((r) => r.type === 'data'));
    });

    it('lets its copy go when the heatmap is turned off, and builds nothing from it', async () => {
        send({ type: 'drop' });
        await until(() => replies.at(-1)?.type === 'held');
        assert.deepEqual(replies.at(-1), { type: 'held', bytes: 0 });
        const n = replies.length;
        send({ type: 'tiles', tiles: [0], ...cfg });
        send({ type: 'ahead', tiles: [1], ...cfg });
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(replies.length, n);
    });
});

describe('a live chunk during a rebuild', () => {
    const packed = (list: MboEvent[]) => {
        const cb = createCompactBuffer();
        appendEvents(cb, list, isoToNs);
        return { buf: cb._buf.slice(0, cb.length * BYTES_PER_EVENT), length: cb.length };
    };
    const datas = () => replies.filter((r) => r.type === 'data') as Extract<HeatmapReply, { type: 'data' }>[];
    const quiet = async () => {
        const n = datas().length;
        send({ type: 'init', ...packed(events.slice(0, 6)) });
        await until(() => datas().length > n);
    };
    const chunk = () => packed(events.slice(6));

    // big enough that the build yields, the way a real one does
    const slow = () => {
        const more: MboEvent[] = [];
        for (let i = 0; i < 40_000; i++) more.push(ev(30, 'A', 'B', 99, 1, 1000 + i));
        return packed([...events.slice(0, 1), ...more, ...events.slice(1, 6)]);
    };

    it('lands on what is drawing right away, it doesnt wait for the build', async () => {
        await quiet();
        const n = datas().length;
        send({ type: 'init', ...slow(), olderData: true });
        await new Promise((r) => setTimeout(r, 0));
        send({ type: 'append', ...chunk() });
        await new Promise((r) => setTimeout(r, 0));
        const got = datas().slice(n);
        assert.equal(got[0]?.from, (60n * SEC).toString(), 'the chunk came first');
        assert.equal(got[0].end, (120n * SEC).toString());
        await until(() => datas().at(-1)!.from === '0');
        assert.equal(datas().at(-1)!.end, (120n * SEC).toString());
    });

    it('the new build has it too when it lands', async () => {
        await quiet();
        const n = datas().length;
        send({ type: 'init', ...packed(events.slice(0, 6)), olderData: true });
        send({ type: 'append', ...chunk() });
        await until(() => datas().length > n + 1);
        const built = datas().at(-1)!;
        assert.equal(built.from, '0');
        assert.equal(built.end, (120n * SEC).toString());
        // and it's a whole book, the lines read off it
        const b = replies.filter((r) => r.type === 'bbo').length;
        send({ type: 'bbo', from: (119n * SEC).toString(), to: (121n * SEC).toString() });
        await until(() => replies.filter((r) => r.type === 'bbo').length > b);
        const bbo = replies.filter((r) => r.type === 'bbo').at(-1) as Extract<HeatmapReply, { type: 'bbo' }>;
        assert.equal(bbo.until, (120n * SEC + 1n).toString());
    });

    it('a chunk from before a newer init isnt taken twice, that init has it', async () => {
        const held = () => (replies.filter((r) => r.type === 'held').at(-1) as Extract<HeatmapReply, { type: 'held' }>).bytes;
        let n = datas().length;
        send({ type: 'init', ...packed(events) });
        await until(() => datas().length > n);
        const once = held();

        await quiet();
        n = datas().length;
        send({ type: 'init', ...slow(), olderData: true });
        await new Promise((r) => setTimeout(r, 0));
        send({ type: 'append', ...chunk() });
        await new Promise((r) => setTimeout(r, 0));
        n = datas().length;
        send({ type: 'init', ...packed(events), olderData: true });
        await until(() => datas().length > n && datas().at(-1)!.from === '0');
        assert.equal(held(), once);
    });

    it('after the build lands a chunk goes the usual way', async () => {
        await quiet();
        const n = datas().length;
        send({ type: 'append', ...chunk() });
        await until(() => datas().length > n);
        assert.equal(datas().at(-1)!.from, (60n * SEC).toString());
    });

    it('a drop stops it all', async () => {
        await quiet();
        send({ type: 'init', ...packed(events.slice(0, 6)) });
        send({ type: 'append', ...chunk() });
        send({ type: 'drop' });
        await until(() => (replies.at(-1) as any)?.bytes === 0);
        const n = datas().length;
        send({ type: 'append', ...chunk() });
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(datas().length, n);
    });
});

describe('a tile while a chunk lands', () => {
    it('says how far its own data goes, not how far the data got while its bitmap was made', async () => {
        const packed = (list: MboEvent[]) => {
            const cb = createCompactBuffer();
            appendEvents(cb, list, isoToNs);
            return { buf: cb._buf.slice(0, cb.length * BYTES_PER_EVENT), length: cb.length };
        };
        const count = (type: string) => replies.filter((r) => r.type === type).length;
        const n = count('data');
        send({ type: 'init', ...packed(events.slice(0, 6)) });
        await until(() => count('data') > n);

        const real = (globalThis as any).createImageBitmap;
        let release: (b: unknown) => void = () => {};
        let asked = false;
        (globalThis as any).createImageBitmap = () =>
            new Promise((r) => {
                asked = true;
                release = r;
            });
        try {
            const tiles = count('tile');
            send({ type: 'tiles', tiles: [0], ...cfg, column: COLUMN_NS.length - 1 });
            await until(() => asked);
            assert.ok(asked, 'the bitmap is being made');
            const d = count('data');
            send({ type: 'append', ...packed(events.slice(6)) });
            await until(() => count('data') > d);
            release({});
            await until(() => count('tile') > tiles);
            const t = replies.filter((r) => r.type === 'tile').at(-1) as Extract<HeatmapReply, { type: 'tile' }>;
            assert.equal(t.until, (60n * SEC + 1n).toString());
        } finally {
            (globalThis as any).createImageBitmap = real;
        }
    });
});

describe('just the lines, heatmap off', () => {
    const init = (length = events.length) => {
        const cb = createCompactBuffer();
        appendEvents(cb, events.slice(0, length), isoToNs);
        return { buf: cb._buf.slice(0, cb.length * BYTES_PER_EVENT), length: cb.length };
    };
    const count = (type: string) => replies.filter((r) => r.type === type).length;
    const nextData = async (send_: () => void) => {
        const n = count('data');
        send_();
        await until(() => count('data') > n);
        assert.ok(count('data') > n, 'landed');
        return replies.filter((r) => r.type === 'data').at(-1) as Extract<HeatmapReply, { type: 'data' }>;
    };

    it('holds the events without the snapshots and says what loaded', async () => {
        const m = init();
        const d = await nextData(() => send({ type: 'init', ...m, linesOnly: true }));
        assert.equal(d.from, '0');
        assert.equal(d.start, '0');
        assert.equal(d.end, (120n * SEC).toString());
        const held = replies.filter((r) => r.type === 'held').at(-1) as Extract<HeatmapReply, { type: 'held' }>;
        assert.equal(held.bytes, events.length * BYTES_PER_EVENT);
    });

    it('answers the lines and builds no tile', async () => {
        const n = count('bbo');
        const tiles = count('tile');
        send({ type: 'tiles', tiles: [0], ...cfg });
        send({ type: 'bbo', from: '0', to: (130n * SEC).toString() });
        await until(() => count('bbo') > n);
        const b = replies.filter((r) => r.type === 'bbo').at(-1) as Extract<HeatmapReply, { type: 'bbo' }>;
        assert.deepEqual([...b.bid], [99.9]);
        assert.deepEqual([...b.ask], [100.1]);
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(count('tile'), tiles);
    });

    it('takes a live chunk on top', async () => {
        const m = init(6);
        await nextData(() => send({ type: 'init', ...m, linesOnly: true }));
        const cb = createCompactBuffer();
        appendEvents(cb, events.slice(6), isoToNs);
        const d = await nextData(() =>
            send({ type: 'append', buf: cb._buf.slice(0, cb.length * BYTES_PER_EVENT), length: cb.length }),
        );
        assert.equal(d.from, (60n * SEC).toString());
        assert.equal(d.end, (120n * SEC).toString());
    });

    it('a full init after it draws tiles again', async () => {
        const m = init();
        await nextData(() => send({ type: 'init', ...m }));
        const n = count('tile');
        send({ type: 'tiles', tiles: [0], ...cfg });
        await until(() => count('tile') > n);
        assert.ok(count('tile') > n);
    });
});

describe('brightness across a rebuild', () => {
    const quiet = { type: 'settle', from: (61n * SEC).toString(), to: (120n * SEC).toString(), ...cfg };
    const norms = () => replies.filter((r) => r.type === 'norm').length;
    const datas = () => replies.filter((r) => r.type === 'data').length;
    const init = (olderData?: boolean) => {
        const cb = createCompactBuffer();
        appendEvents(cb, events, isoToNs);
        send({ type: 'init', buf: cb._buf.slice(0, cb.length * BYTES_PER_EVENT), length: cb.length, olderData });
    };
    const landed = async (before: number) => {
        await until(() => datas() > before);
        assert.ok(datas() > before, 'a build landed');
    };
    // a quiet view's brightness is in place, so a settle says nothing unless a rebuild reset it
    const onQuietView = async () => {
        const d = datas();
        init();
        await landed(d);
        send(quiet);
    };

    it('older data keeps it, it would recolor what is on screen', async () => {
        await onQuietView();
        const d = datas();
        init(true);
        await landed(d);
        const n = norms();
        send(quiet);
        assert.equal(norms(), n);
    });

    it('anything else starts over', async () => {
        await onQuietView();
        const d = datas();
        init();
        await landed(d);
        const n = norms();
        send(quiet);
        assert.equal(norms(), n + 1);
    });

    it('a page that cancels a fresh load still starts over', async () => {
        await onQuietView();
        const d = datas();
        init();
        init(true);
        await landed(d);
        const n = norms();
        send(quiet);
        assert.equal(norms(), n + 1);
    });
});
