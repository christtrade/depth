import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { SimulatedMarketAdapter } from './createSimulatedAdapter';

const MIN = 60_000;
const range = (fromMs: number, toMs: number) =>
    ({
        range: {
            fromMs,
            toMs,
            fromNs: BigInt(fromMs) * 1_000_000n,
            toNs: BigInt(toMs) * 1_000_000n,
        },
    }) as any;
const since = (ms: number) => ({ since: BigInt(ms) * 1_000_000n }) as any;

describe('SimulatedMarketAdapter realtime', () => {
    it('has no feed unless asked for one', () => {
        assert.equal(new SimulatedMarketAdapter({ seed: 7 }).subscribeRealtime, undefined);
    });

    it('serves one path up to now and streams the forming bar', async () => {
        const t0 = Date.UTC(2026, 9, 29, 12, 0, 30);
        mock.timers.enable({ apis: ['setInterval', 'Date'], now: t0 });
        try {
            const sim = new SimulatedMarketAdapter({ seed: 7, realtime: true });

            // a window running into the future stops at the forming bar
            const a = (await sim.fetchBars(range(t0 - 600 * MIN, t0 + 3600 * MIN))).ohlcvBars!;
            const last = a[a.length - 1];
            assert.equal(last.time, t0 - 30_000);
            assert.equal(a.length, 600);
            for (const x of a) {
                assert.ok(Number.isFinite(x.close));
                assert.ok(x.high >= Math.max(x.open, x.close));
                assert.ok(x.low <= Math.min(x.open, x.close));
            }

            // overlapping windows read the same path
            const b = (await sim.fetchBars(range(t0 - 100 * MIN, t0))).ohlcvBars!;
            const aByTime = new Map(a.map((x) => [x.time, x]));
            for (const x of b.slice(0, -1)) assert.deepEqual(aByTime.get(x.time), x);

            const got: any[][] = [];
            const unsub = sim.subscribeRealtime!(since(last.time), (r) => got.push(r.ohlcvBars!));
            mock.timers.tick(1000);
            assert.equal(got.length, 4);
            assert.equal(got[0][0].time, last.time);
            assert.ok(got[3][0].volume >= got[0][0].volume);

            for (let i = 0; i < 160; i++) mock.timers.tick(250);
            const now = got[got.length - 1];
            assert.equal(now[now.length - 1].time, last.time + MIN);
            // the bar that closed goes out once, finished, ahead of the new one
            const crossing = got.filter((bars) => bars.length === 2);
            assert.equal(crossing.length, 1);
            assert.equal(crossing[0][0].time, last.time);

            unsub();
            const n = got.length;
            mock.timers.tick(5000);
            assert.equal(got.length, n);
        } finally {
            mock.timers.reset();
        }
    });

    it('backfills what closed between the fetch and the subscribe', async () => {
        const t0 = Date.UTC(2026, 9, 29, 12, 0, 30);
        mock.timers.enable({ apis: ['setInterval', 'Date'], now: t0 });
        try {
            const sim = new SimulatedMarketAdapter({ seed: 7, realtime: true });
            const a = (await sim.fetchBars(range(t0 - 10 * MIN, t0))).ohlcvBars!;
            const last = a[a.length - 1];

            mock.timers.setTime(t0 + 3 * MIN);
            const got: any[][] = [];
            const unsub = sim.subscribeRealtime!(since(last.time), (r) => got.push(r.ohlcvBars!));
            mock.timers.tick(250);
            unsub();
            assert.deepEqual(
                got[0].map((b) => b.time),
                [0, 1, 2, 3].map((i) => last.time + i * MIN),
            );
        } finally {
            mock.timers.reset();
        }
    });

    it('still makes whole bars for a window when not live', async () => {
        const t0 = Date.UTC(2026, 9, 29, 12, 0, 0);
        const h = (await new SimulatedMarketAdapter({ seed: 7 }).fetchBars(range(t0 - 600 * MIN, t0)))
            .ohlcvBars!;
        assert.equal(h.length, 600);
        assert.equal(h[0].open, 21000);
        for (let i = 1; i < h.length; i++) assert.equal(h[i].open, h[i - 1].close);
    });
});
