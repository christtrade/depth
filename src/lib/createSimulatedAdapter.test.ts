import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { SimulatedMarketAdapter } from './createSimulatedAdapter';
import { servableBarNs } from './timeframes';

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

    it('says there is more until a fetch reaches the end of the path that way', async () => {
        const t0 = Date.UTC(2026, 9, 29, 12, 0, 30);
        mock.timers.enable({ apis: ['Date'], now: t0 });
        try {
            const sim = new SimulatedMarketAdapter({ seed: 7, realtime: true, historyBars: 1000 });
            const more = async (direction: string, fromMs: number, toMs: number) =>
                (await sim.fetchBars({ ...range(fromMs, toMs), direction })).hasMore;

            assert.equal(await more('initial', t0 - 100 * MIN, t0), true);
            assert.equal(await more('backward', t0 - 2000 * MIN, t0 - 100 * MIN), false);
            assert.equal(await more('forward', t0 - 100 * MIN, t0 - 50 * MIN), true);
            assert.equal(await more('forward', t0 - 50 * MIN, t0 + MIN), false);
        } finally {
            mock.timers.reset();
        }
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

    for (const level of ['tick', 'l3'] as const)
    it(`${level}: pages, live chunks and refetches all read the same events`, async () => {
        const t0 = Date.UTC(2026, 9, 29, 12, 0, 30);
        mock.timers.enable({ apis: ['setInterval', 'Date'], now: t0 });
        try {
            const sim = new SimulatedMarketAdapter({ seed: 7, realtime: true, historyBars: 200, dataLevel: level });
            assert.equal(sim.resolveSymbol().dataLevel, level);
            const items = (r: any): any[] => (level === 'tick' ? r.ticks : r.events);
            const events = async (fromMs: number, toMs: number) =>
                items(await sim.fetchBars({ ...range(fromMs, toMs), direction: 'initial' }));
            // thousands of events, a deepEqual diff of them runs out of memory
            const same = (a: unknown[], b: unknown[], msg: string) =>
                assert.ok(JSON.stringify(a) === JSON.stringify(b), msg);

            const whole = await events(t0 - 20 * MIN, t0);
            assert.ok(whole.length > 1000);
            same(
                [...(await events(t0 - 20 * MIN, t0 - 7 * MIN)), ...(await events(t0 - 7 * MIN, t0))],
                whole,
                'two pages join into the one',
            );

            const live: any[] = [];
            const unsub = sim.subscribeRealtime!(since(t0), (r) => live.push(...items(r)));
            mock.timers.tick(3000);
            unsub();
            assert.ok(live.length > 0);
            same(live, await events(t0, t0 + 3000), 'live chunks are what a fetch reads');

            same(await events(t0 - 20 * MIN, t0), whole, 'the path moved on and nothing before it changed');
        } finally {
            mock.timers.reset();
        }
    });

    it('tick prints the trades l3 does', async () => {
        const t0 = Date.UTC(2026, 9, 29, 12, 0, 30);
        mock.timers.enable({ apis: ['Date'], now: t0 });
        try {
            const fetch = (dataLevel: 'tick' | 'l3') =>
                new SimulatedMarketAdapter({ seed: 7, realtime: true, historyBars: 60, dataLevel }).fetchBars({
                    ...range(t0 - 10 * MIN, t0),
                    direction: 'initial',
                });
            const ticks = (await fetch('tick')).ticks!.map((t) => [t.time, t.price, t.size, t.side]);
            const trades = (await fetch('l3')).events
                .filter((e) => e.action === 'T')
                .map((e) => [Date.parse(e.ts_event), e.price, e.size, e.side]);
            assert.ok(ticks.length > 100);
            assert.equal(JSON.stringify(ticks), JSON.stringify(trades));
        } finally {
            mock.timers.reset();
        }
    });

    it('l2: the l3 book as snapshots, with the same trades unless l2Trades is false', async () => {
        const t0 = Date.UTC(2026, 9, 29, 12, 0, 30);
        mock.timers.enable({ apis: ['Date'], now: t0 });
        try {
            const fetch = (cfg: object) =>
                new SimulatedMarketAdapter({ seed: 7, realtime: true, historyBars: 60, ...cfg }).fetchBars({
                    ...range(t0 - 30 * MIN, t0),
                    direction: 'initial',
                });
            const started = performance.now();
            const l2 = await fetch({ dataLevel: 'l2' });
            const ms = performance.now() - started;
            const tick = await fetch({ dataLevel: 'tick' });
            assert.ok(l2.l2Snapshots!.length > 1000, `${l2.l2Snapshots!.length} snapshots`);
            const { bids, asks } = l2.l2Snapshots!.at(-1)!;
            assert.ok(bids.length === 10 && asks.length === 10, 'a full 10 a side');
            assert.equal(JSON.stringify(l2.ticks), JSON.stringify(tick.ticks));
            assert.ok(ms < 3000, `half an hour took ${ms.toFixed(0)} ms`);
            assert.equal((await fetch({ dataLevel: 'l2', l2Trades: false })).ticks, undefined);
        } finally {
            mock.timers.reset();
        }
    });

    it('l3: half an hour a fetch, back to where the path starts', async () => {
        const t0 = Date.UTC(2026, 9, 29, 12, 0, 30);
        mock.timers.enable({ apis: ['Date'], now: t0 });
        try {
            const sim = new SimulatedMarketAdapter({ seed: 7, realtime: true, historyBars: 60, dataLevel: 'l3' });
            const r = await sim.fetchBars({ ...range(t0 - 3 * 60 * MIN, t0), direction: 'initial' });
            assert.ok(Date.parse(r.events[0].ts_event) >= t0 - 30 * MIN);
            assert.equal(r.hasMore, true);
            const back = await sim.fetchBars({ ...range(t0 - 3 * 60 * MIN, t0 - 50 * MIN), direction: 'backward' });
            assert.equal(back.hasMore, false, 'the path starts 60 bars back');
        } finally {
            mock.timers.reset();
        }
    });

    // the chart assumed it served any period, asked for 1s and got minutes back
    it('declares the one resolution it makes bars at, live or not', () => {
        const SEC_NS = 1_000_000_000n;
        for (const realtime of [false, true]) {
            const sim = new SimulatedMarketAdapter({ seed: 7, realtime, barDurationNs: 5n * SEC_NS });
            assert.deepEqual(sim.resolveSymbol().supportedResolutions, [5n * SEC_NS]);
        }
        assert.deepEqual(new SimulatedMarketAdapter().resolveSymbol().supportedResolutions, [60n * SEC_NS]);
    });

    it('at l3 serves any period, down to None', () => {
        const info = new SimulatedMarketAdapter({ seed: 7, dataLevel: 'l3' }).resolveSymbol();
        assert.equal(info.supportedResolutions, undefined);
        assert.equal(servableBarNs(info.supportedResolutions, 1_000_000n), 1_000_000n);
    });
});
