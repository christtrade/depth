import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BYTES_PER_EVENT, encodeAt } from './compact-buffer';
import { COLUMN_NS, TILE_COLS, buildTile, feed, newBuild, seal, type Texels } from './heatmap-build';
import { type Levels, extend, indexAt, levelsAt, newReplay, peakColumns, tsAt } from './heatmap-replay';
import { isoToNs } from './sampler';
import { simMboEvents } from './sim-levels';
import type { MboEvent } from './types';

const MS = 1_000_000n;
const SEC = 1_000_000_000n;

const pack = (events: [bigint, MboEvent][]) => {
    const buf = new ArrayBuffer(events.length * BYTES_PER_EVENT);
    const view = new DataView(buf);
    events.forEach(([ts, e], i) => encodeAt(view, i, ts, e));
    return buf;
};
const ev = (ts: bigint, action: string, side: string, price: number, size: number, id: number): [bigint, MboEvent] => [
    ts,
    { ts_event: '', action: action as MboEvent['action'], side: side as MboEvent['side'], price, size, order_id: String(id), sequence: 0, flags: 0 },
];
const replayOf = async (events: [bigint, MboEvent][], every?: number) => {
    const r = newReplay(every);
    await extend(r, pack(events), events.length);
    return r;
};

const T0 = Date.UTC(2026, 0, 1);
const price = (ms: number) => 100 + 3 * Math.sin(ms / 2.7e6) + 0.4 * Math.sin(ms / 7_000);
const sim = simMboEvents(price, T0, T0 + 10 * 60_000, { slotMs: 250 });
const simPacked = sim.map((e) => [isoToNs(e.ts_event), e] as [bigint, MboEvent]);
const T0_NS = BigInt(T0) * MS;

const pairs = (a: Float64Array) => {
    const out: [number, number][] = [];
    for (let i = 0; i < a.length; i += 2) out.push([a[i], a[i + 1]]);
    return out.sort((x, y) => x[0] - y[0]);
};
const same = (l: Levels | null) => l && { bids: pairs(l.bids), asks: pairs(l.asks) };

describe('the heatmap replay', () => {
    // a 1 lot either side all along, a 50 lot ask at 100.03 from 1.100s to 1.103s
    const flash = [
        ev(0n, 'A', 'B', 99.95, 1, 1),
        ev(0n, 'A', 'A', 100.05, 1, 2),
        ev(1100n * MS, 'A', 'A', 100.03, 50, 3),
        ev(1103n * MS, 'C', 'A', 100.03, 50, 3),
        ev(2000n * MS, 'A', 'A', 100.04, 80, 4),
        ev(2000n * MS, 'C', 'A', 100.04, 80, 4),
        ev(10n * SEC, 'A', 'B', 99.9, 1, 5),
    ];
    const params = { column: COLUMN_NS.indexOf(MS), tickSize: 0.01, ticks: 1, norm: 50, contrast: 0, palette: 'heat' };
    const alpha = (t: Texels, price: number, col: number) => {
        const row = Math.round(price / 0.01);
        if (row < t.rowLo || row >= t.rowLo + t.rows) return 0;
        return t.data[((t.rowLo + t.rows - 1 - row) * t.cols + col) * 4 + 3];
    };

    it('lights a level that rested 3 ms between two 250 ms marks, in the 1 ms columns it was there', async () => {
        const replay = await replayOf(flash);
        // 1.024s to 1.280s
        const t = buildTile({ snaps: [], replay }, 4, params);
        assert.equal(alpha(t, 100.03, 75), 0, '1.099s, not yet');
        for (const x of [76, 77, 78]) assert.ok(alpha(t, 100.03, x) > 150, `${1024 + x} ms`);
        assert.equal(alpha(t, 100.03, 79), 0, 'pulled at 1.103s');
        assert.ok(alpha(t, 100.05, 79) > 0, 'the 1 lot stays');
    });

    it('never lights a level added and pulled on the same timestamp, that book never stood', async () => {
        const replay = await replayOf(flash);
        const t = buildTile({ snaps: [], replay }, Number((2n * SEC) / (BigInt(TILE_COLS) * MS)), params);
        for (let x = 0; x < TILE_COLS; x++) assert.equal(alpha(t, 100.04, x), 0);
    });

    it('stands the book at a time as it was after everything stamped then', async () => {
        const r = await replayOf(flash);
        assert.equal(levelsAt(r, -1n), null, 'nothing before the data');
        assert.deepEqual(same(levelsAt(r, 1100n * MS - 1n))!.asks, [[100.05, 1]]);
        assert.deepEqual(same(levelsAt(r, 1100n * MS))!.asks, [[100.03, 50], [100.05, 1]]);
        assert.deepEqual(same(levelsAt(r, 1103n * MS))!.asks, [[100.05, 1]]);
    });

    it('stands the same book as the snapshot build at every mark', async () => {
        const b = newBuild();
        await feed(b, sim);
        seal(b);
        const r = await replayOf(simPacked, 1000);
        const snaps = b.snaps[0].slice(1, -1);
        assert.ok(snaps.length > 500);
        for (const s of snaps) {
            assert.deepEqual(same(levelsAt(r, s.ts - 1n)), same(s), `at ${s.ts}`);
        }
    });

    it('lands on the same book from a checkpoint as from the start, in any order of asking', async () => {
        const far = await replayOf(simPacked, 1e9);
        const near = await replayOf(simPacked, 500);
        assert.ok(near.checkpoints.length > 20);
        const span = tsAt(near, near.length - 1) - T0_NS;
        // forward, back, and back past a checkpoint
        for (const f of [0.9, 0.1, 0.5, 0.49, 0.95, 0.3]) {
            const ts = T0_NS + (span * BigInt(Math.round(f * 1000))) / 1000n;
            assert.deepEqual(same(levelsAt(near, ts)), same(levelsAt(far, ts)), `at ${f}`);
        }
    });

    it('ends up the same built whole or an init and appends at a time', async () => {
        const whole = await replayOf(simPacked, 700);
        const parts = newReplay(700);
        let at = 0;
        for (const n of [5000, 37, 1, 2500, 999, simPacked.length]) {
            const chunk = simPacked.slice(at, at + n);
            await extend(parts, pack(chunk), chunk.length);
            at += n;
            if (at >= simPacked.length) break;
        }
        assert.equal(parts.length, whole.length);
        assert.deepEqual(parts.checkpoints, whole.checkpoints);
        const mid = T0_NS + 300n * SEC;
        assert.deepEqual(same(levelsAt(parts, mid)), same(levelsAt(whole, mid)));
    });

    it('peaks each column at the biggest each price stood at any instant in it', async () => {
        const r = await replayOf(simPacked, 1000);
        // the sim moves on 250 ms slots, so a few moves per column and none on its edge
        const col = SEC;
        const t0 = T0_NS + 200n * SEC + 7n * MS;
        const cols = peakColumns(r, t0, col, 32);
        for (let x = 0; x < cols.length; x++) {
            const a = t0 + BigInt(x) * col;
            const want = { bids: new Map<number, number>(), asks: new Map<number, number>() };
            const take = (l: Levels | null) => {
                for (const [side, m] of [[l!.bids, want.bids], [l!.asks, want.asks]] as const)
                    for (const [p, s] of pairs(side)) if (!(m.get(p)! >= s)) m.set(p, s);
            };
            take(levelsAt(r, a));
            for (let i = indexAt(r, a + 1n); i < r.length && tsAt(r, i) < a + col; i++) take(levelsAt(r, tsAt(r, i)));
            const sorted = (m: Map<number, number>) => [...m].filter(([, s]) => s > 0).sort((p, q) => p[0] - q[0]);
            assert.deepEqual(same(cols[x]), { bids: sorted(want.bids), asks: sorted(want.asks) }, `column ${x}`);
        }
    });
});
