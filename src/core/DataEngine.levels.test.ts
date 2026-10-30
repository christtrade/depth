import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DataEngine } from './DataEngine';
import { ChartState, type ChartStateShape } from './ChartState';
import { TypedEventBus } from './TypedEventBus';
import type { BarResponse, IDataAdapter } from '../interfaces/IDataAdapter';
import { installInlineSliceWorker } from '../lib/inline-slice-worker';
import { simMboEvents, simTicks } from '../lib/sim-levels';

installInlineSliceWorker();

const MIN = 60_000_000_000n;
const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const T0 = Date.UTC(2026, 0, 1);
const START = T0 - 6 * HOUR_MS;

type Level = 'tick' | 'l3';

const priceOf = (symbol: string) => (ms: number) =>
    (symbol === 'NQ' ? 100 : 50) + 3 * Math.sin(ms / 2.7e6) + 0.4 * Math.sin(ms / 7_000);

function respond(level: Level, symbol: string, fromMs: number, toMs: number): Partial<BarResponse> {
    const price = priceOf(symbol);
    return level === 'tick'
        ? { events: [], ticks: simTicks(price, fromMs, toMs) }
        : { events: simMboEvents(price, fromMs, toMs) as never };
}

const tfOf = (barNs: bigint) => ({ label: String(barNs), barNs, defaultBars: 100, isPreset: false });
const nsOf = (ms: number) => BigInt(ms) * 1_000_000n;

// an adapter serving `level` from START up to a live edge the test moves
function levelEngine(level: Level, opts: { liveEdge?: number; barNs?: bigint } = {}) {
    let edge = opts.liveEdge ?? T0;
    const fetches: { direction: string; fromMs: number; toMs: number }[] = [];
    const subs: { symbol: string; onBar: (r: BarResponse) => void; open: boolean }[] = [];
    const bus = new TypedEventBus();
    const tf = tfOf(opts.barNs ?? MIN);
    const state = new ChartState({ symbol: 'NQ', timeframe: tf } as unknown as ChartStateShape);

    const adapter = {
        resolveSymbol: async (symbol: string) => ({
            symbol,
            type: 'future',
            dataLevel: level,
            priceFormat: { minTick: 0.01, precision: 2 },
        }),
        getCapabilities: () => ({}),
        fetchBars: async (req: any) => {
            const fromMs = Math.max(START, Number(req.range.fromNs / 1_000_000n));
            const toMs = Math.min(edge, Number(req.range.toNs / 1_000_000n));
            fetches.push({ direction: req.direction, fromMs, toMs });
            const hasMore = req.direction === 'forward' ? toMs < edge : fromMs > START;
            return { ...respond(level, req.symbolInfo.symbol, fromMs, toMs), hasMore };
        },
        subscribeRealtime: (req: any, onBar: any) => {
            const sub = { symbol: req.symbolInfo.symbol, onBar, open: true };
            subs.push(sub);
            return () => (sub.open = false);
        },
    } as unknown as IDataAdapter;

    const de = new DataEngine(bus, state, {
        initialLoad: {
            start: new Date(edge - 30 * MIN_MS).toISOString(),
            end: new Date(edge).toISOString(),
        },
        horizon: new Date(edge).toISOString(),
        timeframe: tf as never,
    });
    de.setAdapter(adapter);

    // the last full master each symbol sent, whatever the event
    const latest = new Map<string, any>();
    for (const ev of ['data:load', 'data:append', 'data:prepend'] as const) {
        bus.on(ev, (p: any) => latest.set(p.symbol, p));
    }

    const announce = (barNs: bigint, viewFrom: number, viewTo: number, symbol = 'NQ') =>
        bus.emit('data:pane-resolution', { id: 0, symbol, barNs, viewFrom: nsOf(viewFrom), viewTo: nsOf(viewTo) });

    // a live chunk from the adapter, the way realtime pushes it
    const push = (fromMs: number, toMs: number, symbol = 'NQ') => {
        edge = toMs;
        const sub = subs.filter((s) => s.open && s.symbol === symbol).at(-1);
        assert.ok(sub, `a live feed for ${symbol}`);
        sub.onBar({ ...respond(level, symbol, fromMs, toMs), hasMore: false } as BarResponse);
    };

    const settle = () => new Promise((r) => setTimeout(r, 30));
    const moveEdge = (ms: number) => (edge = ms);

    // l3 processing outlasts any fixed sleep, so wait for the event itself
    const next = (ev: 'data:load' | 'data:append' | 'data:prepend', symbol = 'NQ') =>
        new Promise<any>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`no ${ev} for ${symbol}`)), 5000);
            const off = bus.on(ev, (p: any) => {
                if (p.symbol !== symbol) return;
                clearTimeout(timer);
                off();
                resolve(p);
            });
        });

    return { bus, de, state, fetches, subs, latest, announce, push, settle, moveEdge, next };
}

// the trades a symbol holds, as the generator would print them for that span
function assertTradesAre(p: any, symbol: string, fromMs: number, toMs: number) {
    const want = simTicks(priceOf(symbol), fromMs, toMs);
    const got = p.trades.map((t: any) => ({
        time: Number(t.ts / 1_000_000n),
        price: t.price,
        size: t.size,
        side: t.side,
    }));
    assert.equal(got.length, want.length, `${got.length} trades held, ${want.length} in the span`);
    for (let i = 0; i < want.length; i++) {
        assert.deepEqual(got[i], want[i], `trade ${i}`);
    }
}

// one footprint bar per period, in order, no repeats
function assertFootprintsClean(p: any, barNs: bigint) {
    const ts: bigint[] = p.footprintBars.map((b: any) => b.ts);
    assert.ok(ts.length > 0, 'some footprint bars');
    for (let i = 1; i < ts.length; i++) {
        assert.ok(ts[i] > ts[i - 1], `footprint ${i} at ${ts[i]} after ${ts[i - 1]}`);
        assert.equal((ts[i] - ts[0]) % barNs, 0n, 'on the period grid');
    }
    assert.equal(p.bars.length, ts.length, 'a bar for every footprint');
}

const firstMs = (p: any) => Number(p.trades[0].ts / 1_000_000n);

for (const level of ['tick', 'l3'] as const) {
    describe(`${level} level`, () => {
        it('loads the initial window', async () => {
            const { de, next } = levelEngine(level);
            const loaded = next('data:load');
            await de.load('NQ');
            const p = await loaded;
            assert.equal(p.dataLevel, level);
            assert.ok(p.ingestOhlcvBuf.byteLength > 0, 'the slice worker bucketed the trades');
            assertTradesAre(p, 'NQ', T0 - 30 * MIN_MS, T0);
            assertFootprintsClean(p, MIN);
            assert.equal(p.footprintBars.length, 30);
        });

        it('pages back into history without a gap or a repeat', async () => {
            const { bus, de, fetches, next } = levelEngine(level);
            const loaded = next('data:load');
            await de.load('NQ');
            await loaded;
            const prepended = next('data:prepend');
            bus.emit('data:request-backward', { viewMin: nsOf(T0 - 90 * MIN_MS), symbol: 'NQ' });
            const p = await prepended;
            // the first trade can land a slot or two after the range starts
            assert.ok(
                firstMs(p) < T0 - 89 * MIN_MS,
                `reached the asked-for view, fetched ${JSON.stringify(fetches)}`,
            );
            assertTradesAre(p, 'NQ', firstMs(p), T0);
            assertFootprintsClean(p, MIN);
        });

        it('a timeframe switch rebuckets the same trades', async () => {
            const { de, state, bus, announce, next } = levelEngine(level);
            const loaded = next('data:load');
            await de.load('NQ');
            await loaded;
            const FIVE = 5n * MIN;
            const replaced = next('data:load');
            announce(FIVE, T0 - 30 * MIN_MS, T0);
            state.set('timeframe', tfOf(FIVE) as never, bus);
            const p = await replaced;
            assert.equal(p.replaced, true);
            assertTradesAre(p, 'NQ', firstMs(p), T0);
            assertFootprintsClean(p, FIVE);
        });

        it('switching symbol and back hands each pane its own data', async () => {
            const { de, bus, next } = levelEngine(level);
            const loaded = next('data:load');
            await de.load('NQ');
            await loaded;
            const es = next('data:load', 'ES');
            bus.emit('chart:set-symbol', { symbol: 'ES', id: 0 });
            assertTradesAre(await es, 'ES', T0 - 30 * MIN_MS, T0);

            const nq = next('data:load');
            bus.emit('chart:set-symbol', { symbol: 'NQ', id: 0 });
            const p = await nq;
            assert.equal(p.rehydrate, true, 'NQ was still loaded, so no refetch');
            assertTradesAre(p, 'NQ', T0 - 30 * MIN_MS, T0);
        });
    });
}
