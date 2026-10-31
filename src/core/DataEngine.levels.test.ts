import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DataEngine } from './DataEngine';
import { ChartState, type ChartStateShape } from './ChartState';
import { TypedEventBus } from './TypedEventBus';
import type { BarResponse, IDataAdapter } from '../interfaces/IDataAdapter';
import { installInlineSliceWorker } from '../lib/inline-slice-worker';
import { simMboEvents, simTicks } from '../lib/sim-levels';
import { processL3Chunk } from './processing/l3-processor';
import { footprintFromTrades } from '../lib/types/footprint';

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

// l3 only - every event the generator prints for the span
// once, in order
function assertEventsAre(p: any, symbol: string, fromMs: number, toMs: number) {
    if (p.dataLevel !== 'l3') return;
    const want = simMboEvents(priceOf(symbol), fromMs, toMs);
    const view = new DataView(p.compactBuf);
    const held = p.compactBuf.byteLength / 20;
    assert.equal(held, want.length, `${held} events held, ${want.length} in the span`);
    for (let i = 0; i < want.length; i++) {
        const ts = view.getBigInt64(i * 20, true);
        const oid = view.getUint8(i * 20 + 16) | (view.getUint8(i * 20 + 17) << 8) | (view.getUint8(i * 20 + 18) << 16);
        const wantOid = parseInt(want[i].order_id, 10) & 0xffffff;
        assert.ok(
            ts === nsOf(Date.parse(want[i].ts_event)) && oid === wantOid,
            `event ${i}: ${ts}/${oid}, expected ${want[i].ts_event}/${wantOid}`,
        );
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

        it('pages forward without repeating the seam', async () => {
            const { bus, de, next, moveEdge } = levelEngine(level);
            const loaded = next('data:load');
            await de.load('NQ');
            await loaded;
            moveEdge(T0 + 10 * MIN_MS);
            const appended = next('data:append');
            bus.emit('data:prefetch', { symbol: 'NQ' });
            const p = await appended;
            assertTradesAre(p, 'NQ', T0 - 30 * MIN_MS, T0 + 10 * MIN_MS);
            assertEventsAre(p, 'NQ', T0 - 30 * MIN_MS, T0 + 10 * MIN_MS);
            assertFootprintsClean(p, MIN);
        });

        if (level === 'l3') {
            // bid/ask after chunks were joined on, against one pass over the whole span
            const assertBboIsOnePass = (p: any, fromMs: number, toMs: number) => {
                const want = processL3Chunk(simMboEvents(priceOf('NQ'), fromMs, toMs), 0n).priceHistory;
                const got = p.priceHistory;
                for (let i = 0; i < Math.max(got.length, want.length); i++) {
                    const g = got[i] && `${got[i].ts} ${got[i].bestBid}/${got[i].bestAsk}`;
                    const w = want[i] && `${want[i].ts} ${want[i].bestBid}/${want[i].bestAsk}`;
                    assert.ok(g === w, `bbo ${i} of ${want.length}: got ${g}, expected ${w}`);
                }
            };

            it('live chunks carry the book on, so bid/ask match one pass', async () => {
                const { de, next, announce, push, settle } = levelEngine(level);
                const loaded = next('data:load');
                await de.load('NQ');
                await loaded;
                announce(MIN, T0 - 20 * MIN_MS, T0);
                await settle();
                let appended = next('data:append');
                push(T0, T0 + 15_000);
                await appended;
                appended = next('data:append');
                // into the next minute too
                // so both rebuilt and fresh bucket get a carried book
                push(T0 + 15_000, T0 + 75_000);
                assertBboIsOnePass(await appended, T0 - 30 * MIN_MS, T0 + 75_000);
            });

            it('a forward page carries the book on too', async () => {
                const { bus, de, next, moveEdge } = levelEngine(level);
                const loaded = next('data:load');
                await de.load('NQ');
                await loaded;
                moveEdge(T0 + 10 * MIN_MS);
                const appended = next('data:append');
                bus.emit('data:prefetch', { symbol: 'NQ' });
                assertBboIsOnePass(await appended, T0 - 30 * MIN_MS, T0 + 10 * MIN_MS);
            });
        }

        it('live chunks inside one minute leave one bar for it', async () => {
            const { de, next, announce, push, settle } = levelEngine(level);
            const loaded = next('data:load');
            await de.load('NQ');
            await loaded;
            // inside whats loaded so the announce doesnt reload
            announce(MIN, T0 - 20 * MIN_MS, T0);
            await settle();
            let appended = next('data:append');
            push(T0, T0 + 15_000);
            await appended;
            appended = next('data:append');
            push(T0 + 15_000, T0 + 30_000);
            const p = await appended;
            assertTradesAre(p, 'NQ', T0 - 30 * MIN_MS, T0 + 30_000);
            assertEventsAre(p, 'NQ', T0 - 30 * MIN_MS, T0 + 30_000);
            assertFootprintsClean(p, MIN);
            const last = p.footprintBars.at(-1);
            assert.equal(last.ts, nsOf(T0), 'the forming minute');
            const vol = simTicks(priceOf('NQ'), T0, T0 + 30_000).reduce((s, t) => s + t.size, 0);
            assert.equal(last.totalVol, vol, 'holds both chunks, once');
        });

        it('a rehydrate after live chunks plays from the new edge', async () => {
            const { de, next, announce, push, settle } = levelEngine(level);
            const loaded = next('data:load');
            await de.load('NQ');
            await loaded;
            announce(MIN, T0 - 20 * MIN_MS, T0);
            await settle();
            const appended = next('data:append');
            push(T0, T0 + 15_000);
            await appended;
            const again = next('data:load');
            de.rehydrate();
            const p = await again;
            assert.equal(new Date(p.playFromIso).getTime(), p.dataEnd);
        });

        it('a live chunk that re-sends the seam keeps one copy of it', async () => {
            const { de, next, announce, push, settle } = levelEngine(level);
            const loaded = next('data:load');
            await de.load('NQ');
            await loaded;
            announce(MIN, T0 - 20 * MIN_MS, T0);
            await settle();
            let appended = next('data:append');
            push(T0, T0 + 15_000);
            await appended;
            // `since` is inclusive, so an adapter could send the last held ms again
            appended = next('data:append');
            push(T0 + 15_000 - 100, T0 + 30_000);
            const p = await appended;
            assertTradesAre(p, 'NQ', T0 - 30 * MIN_MS, T0 + 30_000);
            assertEventsAre(p, 'NQ', T0 - 30 * MIN_MS, T0 + 30_000);
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

        // the chart's pane announces first, the shared timeframe follows
        for (const paneFirst of [false, true])
        it(`a switch to a finer timeframe rebuckets what is held, no fetch${paneFirst ? ', pane first' : ''}`, async () => {
            const { de, state, bus, fetches, announce, push, next, settle } = levelEngine(level);
            const loaded = next('data:load');
            await de.load('NQ');
            await loaded;
            announce(MIN, T0 - 20 * MIN_MS, T0);
            await settle();
            let appended = next('data:append');
            push(T0, T0 + 20_500);
            await appended;

            const SEC = 1_000_000_000n;
            const fetched = fetches.length;
            const replaced = next('data:load');
            if (!paneFirst) state.set('timeframe', tfOf(SEC) as never, bus);
            announce(SEC, T0 - 10_000, T0 + 20_500);
            const p = await replaced;
            if (paneFirst) state.set('timeframe', tfOf(SEC) as never, bus);
            assert.equal(p.replaced, true);
            assert.equal(p.barNs, SEC);
            assert.equal(fetches.length, fetched, 'nothing fetched');
            assertTradesAre(p, 'NQ', T0 - 30 * MIN_MS, T0 + 20_500);
            assertFootprintsClean(p, SEC);
            const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? String(x) : x));
            const fresh = (q: any) => json(footprintFromTrades(q.trades, SEC));
            assert.equal(json(p.footprintBars), fresh(p));

            // the forming second carries on
            appended = next('data:append');
            push(T0 + 20_500, T0 + 22_500);
            const a = await appended;
            assertTradesAre(a, 'NQ', T0 - 30 * MIN_MS, T0 + 22_500);
            assertEventsAre(a, 'NQ', T0 - 30 * MIN_MS, T0 + 22_500);
            assert.equal(json(a.footprintBars), fresh(a));
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
