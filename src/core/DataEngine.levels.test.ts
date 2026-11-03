import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DataEngine } from './DataEngine';
import { ChartState, type ChartStateShape } from './ChartState';
import { TypedEventBus } from './TypedEventBus';
import type { FetchResponse, IDataAdapter } from '../interfaces/IDataAdapter';
import { installInlineSliceWorker } from '../lib/inline-slice-worker';
import { simL2Snapshots, simMboEvents, simTicks } from '../lib/sim-levels';
import { applyEvent, createBook } from '../lib/book';
import { processL3Chunk } from './processing/l3-processor';
import { footprintFromTrades } from '../lib/types/footprint';
import { BYTES_PER_EVENT, createCompactBuffer, getEvent, getTsNs } from '../lib/compact-buffer';

installInlineSliceWorker();

const MIN = 60_000_000_000n;
const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const T0 = Date.UTC(2026, 0, 1);
const START = T0 - 6 * HOUR_MS;

// l2-book is l2 without trades
type Level = 'tick' | 'l3' | 'l2' | 'l2-book';

const priceOf = (symbol: string) => (ms: number) =>
    (symbol === 'NQ' ? 100 : 50) + 3 * Math.sin(ms / 2.7e6) + 0.4 * Math.sin(ms / 7_000);

function respond(level: Level, symbol: string, fromMs: number, toMs: number): Partial<FetchResponse> {
    const price = priceOf(symbol);
    if (level === 'tick') return { ticks: simTicks(price, fromMs, toMs) };
    if (level === 'l2') return { depth: simL2Snapshots(price, fromMs, toMs), ticks: simTicks(price, fromMs, toMs) };
    if (level === 'l2-book') return { depth: simL2Snapshots(price, fromMs, toMs) };
    return { mbo: simMboEvents(price, fromMs, toMs) as never };
}

const tfOf = (barNs: bigint) => ({ label: String(barNs), barNs, defaultBars: 100, isPreset: false });
const nsOf = (ms: number) => BigInt(ms) * 1_000_000n;

// an adapter serving `level` from START up to a live edge the test moves
function levelEngine(
    level: Level,
    opts: {
        liveEdge?: number;
        barNs?: bigint;
        quietFrom?: number;
        preProcessed?: boolean;
        maxBytes?: number;
        /** a fetch returns at most this much, the newest of it unless it's a forward one */
        pageMs?: number;
        initialMs?: number;
    } = {},
) {
    let edge = opts.liveEdge ?? T0;
    const fetches: { direction: string; fromMs: number; toMs: number }[] = [];
    const subs: { symbol: string; onData: (r: FetchResponse) => void; open: boolean }[] = [];
    const bus = new TypedEventBus();
    const tf = tfOf(opts.barNs ?? MIN);
    const state = new ChartState({ symbol: 'NQ', timeframe: tf } as unknown as ChartStateShape);

    const adapter = {
        resolveSymbol: async (symbol: string) => ({
            symbol,
            type: 'future',
            dataLevel: level === 'l2-book' ? 'l2' : level,
            priceFormat: { minTick: 0.01, precision: 2 },
        }),
        getCapabilities: () => ({}),
        fetchBars: async (req: any) => {
            let fromMs = Math.max(START, Number(req.range.fromNs / 1_000_000n));
            let toMs = Math.min(edge, Number(req.range.toNs / 1_000_000n));
            if (opts.pageMs && req.direction === 'forward') toMs = Math.min(toMs, fromMs + opts.pageMs);
            else if (opts.pageMs) fromMs = Math.max(fromMs, toMs - opts.pageMs);
            fetches.push({ direction: req.direction, fromMs, toMs });
            const hasMore = req.direction === 'forward' ? toMs < edge : fromMs > START;
            // nothing printed from quietFrom on
            const printTo = Math.max(fromMs, Math.min(toMs, opts.quietFrom ?? toMs));
            const r = respond(level, req.symbolInfo.symbol, fromMs, printTo);
            if (opts.preProcessed && req.direction === 'backward')
                return { _preProcessed: processL3Chunk(r.mbo as never, tf.barNs), hasMore };
            return { ...r, hasMore };
        },
        subscribeRealtime: (req: any, onData: any) => {
            const sub = { symbol: req.symbolInfo.symbol, onData, open: true };
            subs.push(sub);
            return () => (sub.open = false);
        },
    } as unknown as IDataAdapter;

    const de = new DataEngine(bus, state, {
        initialLoad: {
            start: new Date(edge - (opts.initialMs ?? 30 * MIN_MS)).toISOString(),
            end: new Date(edge).toISOString(),
        },
        horizon: new Date(edge).toISOString(),
        timeframe: tf as never,
        dataBudget: { maxBytes: opts.maxBytes ?? Infinity },
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
        sub.onData({ ...respond(level, symbol, fromMs, toMs), hasMore: false } as FetchResponse);
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
    const cb = createCompactBuffer(0);
    cb._buf = p.compactBuf;
    cb._view = new DataView(p.compactBuf);
    cb.length = cb.capacity = p.compactBuf.byteLength / BYTES_PER_EVENT;
    const held = cb.length;
    assert.equal(held, want.length, `${held} events held, ${want.length} in the span`);
    for (let i = 0; i < want.length; i++) {
        const ts = getTsNs(cb, i);
        const oid = getEvent(cb, i).order_id;
        const wantOid = want[i].order_id;
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

// l2 only - replaying the held events gives the adapters book at every snapshot
function assertBookIs(p: any, symbol: string, fromMs: number, toMs: number) {
    if (p.dataLevel !== 'l2') return;
    const want = simL2Snapshots(priceOf(symbol), fromMs, toMs);
    assert.ok(want.length > 0);
    const cb = createCompactBuffer(0);
    cb._buf = p.compactBuf;
    cb._view = new DataView(p.compactBuf);
    cb.length = cb.capacity = p.compactBuf.byteLength / BYTES_PER_EVENT;
    const book = createBook();
    const levels = (m: Map<string, { price: number; size: number }>, desc: boolean) => {
        const by = new Map<number, number>();
        for (const o of m.values()) by.set(o.price, (by.get(o.price) ?? 0) + o.size);
        return [...by]
            .sort((a, b) => (desc ? b[0] - a[0] : a[0] - b[0]))
            .slice(0, 10)
            .map(([price, size]) => `${price.toFixed(6)}x${size}`)
            .join(' ');
    };
    let i = 0;
    for (const s of want) {
        const at = nsOf(s.time);
        while (i < cb.length && getTsNs(cb, i) <= at) applyEvent(book, getEvent(cb, i++));
        const got = `${levels(book.bids as any, true)} | ${levels(book.asks as any, false)}`;
        const exp = `${s.bids.map((l) => `${l.price.toFixed(6)}x${l.size}`).join(' ')} | ${s.asks.map((l) => `${l.price.toFixed(6)}x${l.size}`).join(' ')}`;
        assert.ok(got === exp, `book at ${new Date(s.time).toISOString()}:\n  got      ${got}\n  expected ${exp}`);
    }
}

const firstMs = (p: any) => Number(p.trades[0].ts / 1_000_000n);

for (const level of ['tick', 'l3', 'l2'] as const) {
    describe(`${level} level`, () => {
        it('loads the initial window', async () => {
            const { de, next } = levelEngine(level);
            const loaded = next('data:load');
            await de.load('NQ');
            const p = await loaded;
            assert.equal(p.dataLevel, level);
            assert.ok(p.ingestOhlcvBuf.byteLength > 0, 'the slice worker bucketed the trades');
            assertTradesAre(p, 'NQ', T0 - 30 * MIN_MS, T0);
            assertBookIs(p, 'NQ', T0 - 30 * MIN_MS, T0);
            assertFootprintsClean(p, MIN);
            assert.equal(p.footprintBars.length, 30);
        });

        it('rebuildFootprint rebuilds what is held with the new options', async () => {
            const { de, next } = levelEngine(level);
            const loaded = next('data:load');
            await de.load('NQ');
            const before = await loaded;
            const fp = { imbalanceRatio: 1.01 };
            const reloaded = next('data:load');
            de.rebuildFootprint(fp);
            const p = await reloaded;
            assert.deepEqual(p.fpOptions, fp);
            assert.equal(
                JSON.stringify(p.footprintBars, (_, v) => (typeof v === 'bigint' ? String(v) : v)),
                JSON.stringify(footprintFromTrades(before.trades, MIN, fp), (_, v) =>
                    typeof v === 'bigint' ? String(v) : v,
                ),
            );
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
            assertBookIs(p, 'NQ', p.dataStart, T0);
            assertFootprintsClean(p, MIN);
        });

        it('a page back onto history that starts mid-bucket keeps one bar for that bucket', async () => {
            const { bus, de, next } = levelEngine(level, { liveEdge: T0 + 30_000 });
            const loaded = next('data:load');
            await de.load('NQ');
            await loaded;
            const prepended = next('data:prepend');
            bus.emit('data:request-backward', { viewMin: nsOf(T0 - 90 * MIN_MS), symbol: 'NQ' });
            const p = await prepended;
            assertFootprintsClean(p, MIN);
            const seam = p.footprintBars.find((b: any) => b.ts === nsOf(T0 - 30 * MIN_MS));
            const vol = simTicks(priceOf('NQ'), T0 - 30 * MIN_MS, T0 - 29 * MIN_MS).reduce((s, t) => s + t.size, 0);
            assert.equal(seam.totalVol, vol, 'both halves of the seam minute');
        });

        it('pages back from an empty first window', async () => {
            const { bus, de, fetches, next } = levelEngine(level, { quietFrom: T0 - 40 * MIN_MS });
            const loaded = next('data:load');
            await de.load('NQ');
            await loaded;
            const fetched = fetches.length;
            const prepended = next('data:prepend');
            bus.emit('data:request-backward', { viewMin: nsOf(T0 - 90 * MIN_MS), symbol: 'NQ' });
            const p = await prepended;
            assert.equal(fetches.length, fetched + 1);
            assertTradesAre(p, 'NQ', firstMs(p), T0 - 40 * MIN_MS);
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
            assertBookIs(p, 'NQ', T0 - 30 * MIN_MS, T0 + 10 * MIN_MS);
            assertFootprintsClean(p, MIN);
        });

        // l3 only - bid/ask after chunks were joined on, against one pass over the whole span
        const assertBboIsOnePass = (p: any, fromMs: number, toMs: number) => {
            if (level !== 'l3') return;
            const want = processL3Chunk(simMboEvents(priceOf('NQ'), fromMs, toMs), 0n).priceHistory;
            const got = p.priceHistory;
            // the held buffer stores prices as scaled ints
            const s = (h: any) => h && `${h.ts} ${h.bestBid.toFixed(6)}/${h.bestAsk.toFixed(6)}`;
            for (let i = 0; i < Math.max(got.length, want.length); i++) {
                const g = s(got[i]);
                const w = s(want[i]);
                assert.ok(g === w, `bbo ${i} of ${want.length}: got ${g}, expected ${w}`);
            }
        };

        const budget = level === 'tick' ? 4_000_000 : 8_000_000;

        it('the budget drops history far from the view, and pages it back in', async () => {
            const { bus, de, fetches, next, announce, settle } = levelEngine(level, { maxBytes: budget });
            const loaded = next('data:load');
            await de.load('NQ');
            await loaded;
            announce(MIN, T0 - 10 * MIN_MS, T0);
            await settle();
            const cut = next('data:load');
            bus.emit('data:request-backward', { viewMin: nsOf(T0 - 2 * HOUR_MS), symbol: 'NQ' });
            const p = await cut;
            assert.equal(p.replaced, true);
            const back = (T0 - firstMs(p)) / MIN_MS;
            assert.ok(back < 60 && back >= 20, `kept ${back} min back`);
            assertTradesAre(p, 'NQ', p.dataStart, T0);
            assertEventsAre(p, 'NQ', p.dataStart, T0);
            assertBookIs(p, 'NQ', p.dataStart, T0);
            assertFootprintsClean(p, MIN);

            const edge = Math.floor(p.dataStart / MIN_MS) * MIN_MS;
            const prepended = next('data:prepend');
            bus.emit('data:request-backward', { viewMin: nsOf(edge - 10 * MIN_MS), symbol: 'NQ' });
            const q = await prepended;
            assert.equal(fetches.at(-1)!.toMs, edge, 'from the new edge');
            assertTradesAre(q, 'NQ', firstMs(q), T0);
            assertEventsAre(q, 'NQ', q.dataStart, T0);
            assertBookIs(q, 'NQ', q.dataStart, T0);
            assertFootprintsClean(q, MIN);
        });

        it('the budget drops what is past the view, and pages it back in on the book left', async () => {
            const { bus, de, fetches, next, announce } = levelEngine(level, { maxBytes: budget });
            const loaded = next('data:load');
            await de.load('NQ');
            await loaded;
            // the window reloads around the view, up to the old edge, and that's over the budget
            const cut = new Promise<any>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('no cut')), 5000);
                bus.on('data:load', (p: any) => {
                    if (p.dataEnd >= T0 - HOUR_MS) return;
                    clearTimeout(timer);
                    resolve(p);
                });
            });
            announce(MIN, T0 - 2 * HOUR_MS, T0 - 2 * HOUR_MS + 10 * MIN_MS);
            const p = await cut;
            assert.equal(p.replaced, true);
            const end = Math.floor(p.dataEnd / MIN_MS) * MIN_MS + MIN_MS;
            assert.ok(end < T0 - HOUR_MS, `kept up to ${(T0 - end) / MIN_MS} min back`);
            assertTradesAre(p, 'NQ', p.dataStart, end);
            assertEventsAre(p, 'NQ', p.dataStart, end);
            assertBookIs(p, 'NQ', p.dataStart, end);

            const appended = next('data:append');
            bus.emit('data:request-forward', { viewMax: nsOf(end + 10 * MIN_MS), symbol: 'NQ' });
            const q = await appended;
            const fetched = fetches.at(-1)!;
            assert.equal(fetched.fromMs, end, 'from the new edge');
            assertTradesAre(q, 'NQ', p.dataStart, fetched.toMs);
            assertEventsAre(q, 'NQ', p.dataStart, fetched.toMs);
            assertBookIs(q, 'NQ', p.dataStart, fetched.toMs);
            assertFootprintsClean(q, MIN);
            assertBboIsOnePass(q, p.dataStart, fetched.toMs);
        });

        if (level === 'l3') {
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

            it('a backward page carries its book into what was held', async () => {
                const { bus, de, next } = levelEngine(level);
                const loaded = next('data:load');
                await de.load('NQ');
                await loaded;
                const prepended = next('data:prepend');
                bus.emit('data:request-backward', { viewMin: nsOf(T0 - 90 * MIN_MS), symbol: 'NQ' });
                const p = await prepended;
                assertBboIsOnePass(p, p.dataStart, T0);
            });

            it('a pre-processed backward page carries its book in too', async () => {
                const { bus, de, next } = levelEngine(level, { preProcessed: true });
                const loaded = next('data:load');
                await de.load('NQ');
                await loaded;
                const prepended = next('data:prepend');
                bus.emit('data:request-backward', { viewMin: nsOf(T0 - 90 * MIN_MS), symbol: 'NQ' });
                const p = await prepended;
                assertBboIsOnePass(p, p.dataStart, T0);
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
            assertBookIs(p, 'NQ', T0 - 30 * MIN_MS, T0 + 30_000);
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

        for (const paneFirst of [false, true])
        it(`a timeframe switch rebuckets the same trades${paneFirst ? ', pane first' : ''}`, async () => {
            const { de, state, bus, announce, next } = levelEngine(level);
            const loaded = next('data:load');
            await de.load('NQ');
            await loaded;
            const FIVE = 5n * MIN;
            const replaced = next('data:load');
            announce(FIVE, T0 - 30 * MIN_MS, T0);
            if (!paneFirst) state.set('timeframe', tfOf(FIVE) as never, bus);
            const p = await replaced;
            assert.equal(p.replaced, true);
            assert.equal(p.barNs, FIVE);
            assertTradesAre(p, 'NQ', firstMs(p), T0);
            assertFootprintsClean(p, FIVE);
        });

        it('a finer switch over exactly the loaded window rebuckets, no fetch', async () => {
            const { de, state, bus, fetches, announce, next } = levelEngine(level);
            const loaded = next('data:load');
            await de.load('NQ');
            await loaded;
            const HALF = MIN / 2n;
            const fetched = fetches.length;
            const replaced = next('data:load');
            announce(HALF, T0 - 30 * MIN_MS, T0);
            state.set('timeframe', tfOf(HALF) as never, bus);
            await replaced;
            assert.equal(fetches.length, fetched, `fetched ${JSON.stringify(fetches.slice(fetched))}`);
        });

        for (const shared of ['first', 'after', 'after a chunk'] as const)
        it(`a switch to a finer timeframe rebuckets what is held, no fetch, shared timeframe ${shared}`, async () => {
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
            if (shared === 'first') state.set('timeframe', tfOf(SEC) as never, bus);
            announce(SEC, T0 - 10_000, T0 + 20_500);
            const p = await replaced;
            if (shared === 'after') state.set('timeframe', tfOf(SEC) as never, bus);
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
            assert.equal(de.sharedData.barNs, SEC);
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

// mid candles are tick candles where a tick is the mid changing
function assertMidBars(p: any, fromMs: number, toMs: number) {
    const want: any[] = [];
    let last: number | null = null;
    for (const s of simL2Snapshots(priceOf('NQ'), fromMs, toMs)) {
        // in cents, or the same mid off another bid/ask pair reads as a change
        const mid = s.bids.length && s.asks.length ? (Math.round(s.bids[0].price * 100) + Math.round(s.asks[0].price * 100)) / 200 : null;
        if (mid === last) continue;
        last = mid;
        if (mid === null) continue;
        const time = Math.floor(s.time / MIN_MS) * MIN_MS;
        const b = want.at(-1);
        if (b?.time === time) {
            b.high = Math.max(b.high, mid);
            b.low = Math.min(b.low, mid);
            b.close = mid;
        } else want.push({ time, open: mid, high: mid, low: mid, close: mid, volume: 0 });
    }
    const got = p.bars.toArray();
    assert.equal(got.length, want.length, 'one bar per minute the mid moved in');
    for (let i = 0; i < want.length; i++) {
        const g = got[i], w = want[i];
        const at = new Date(w.time).toISOString();
        assert.equal(g.time, w.time, `bar ${i} at ${at}`);
        for (const k of ['open', 'high', 'low', 'close'] as const) assert.ok(Math.abs(g[k] - w[k]) < 1e-9, `${at} ${k} ${g[k]} want ${w[k]}`);
        assert.equal(g.volume, 0);
    }
}

describe('l2 level, bar source', () => {
    it('a feed with trades keeps trade bars through a chunk with none', async () => {
        const { de, next, announce, subs, settle } = levelEngine('l2');
        const loaded = next('data:load');
        await de.load('NQ');
        await loaded;
        announce(MIN, T0 - 20 * MIN_MS, T0);
        await settle();
        const appended = next('data:append');
        const sub = subs.filter((s) => s.open).at(-1)!;
        sub.onData({ depth: simL2Snapshots(priceOf('NQ'), T0, T0 + 30_000), hasMore: false } as FetchResponse);
        const p = await appended;
        const bars = p.bars.toArray();
        assert.equal(bars.length, 30);
        assert.ok(bars.every((b: any) => b.volume > 0), 'still the trade bars, not mid candles');
    });
});

describe('l2 level, book only', () => {
    it('loads mid candles and the book, no trades', async () => {
        const { de, next } = levelEngine('l2-book');
        const loaded = next('data:load');
        await de.load('NQ');
        const p = await loaded;
        assert.equal(p.dataLevel, 'l2');
        assert.equal(p.trades.length, 0);
        assert.equal(p.footprintBars.length, 0);
        assertMidBars(p, T0 - 30 * MIN_MS, T0);
        assertBookIs(p, 'NQ', T0 - 30 * MIN_MS, T0);
    });

    it('pages back with the book whole across the seam', async () => {
        const { bus, de, next } = levelEngine('l2-book');
        const loaded = next('data:load');
        await de.load('NQ');
        await loaded;
        const prepended = next('data:prepend');
        bus.emit('data:request-backward', { viewMin: nsOf(T0 - 90 * MIN_MS), symbol: 'NQ' });
        const p = await prepended;
        assert.ok(p.dataStart < T0 - 30 * MIN_MS, 'got older data');
        assertMidBars(p, p.dataStart, T0);
        assertBookIs(p, 'NQ', p.dataStart, T0);
    });

    it('the budget drops history far from the view, and the candles stay the mid ticks', async () => {
        const { bus, de, next, announce, settle } = levelEngine('l2-book', { maxBytes: 3_000_000 });
        const loaded = next('data:load');
        await de.load('NQ');
        await loaded;
        announce(MIN, T0 - 10 * MIN_MS, T0);
        await settle();
        const cut = next('data:load');
        bus.emit('data:request-backward', { viewMin: nsOf(T0 - 2 * HOUR_MS), symbol: 'NQ' });
        const p = await cut;
        assert.equal(p.replaced, true);
        assert.ok(p.dataStart > T0 - 2 * HOUR_MS, 'dropped some');
        assertMidBars(p, p.dataStart, T0);
        assertBookIs(p, 'NQ', p.dataStart, T0);

        const edge = Math.floor(p.dataStart / MIN_MS) * MIN_MS;
        const prepended = next('data:prepend');
        bus.emit('data:request-backward', { viewMin: nsOf(edge - 10 * MIN_MS), symbol: 'NQ' });
        const q = await prepended;
        assertMidBars(q, q.dataStart, T0);
    });

    it('the budget drops what is past the view, and the next page carries the mid on', async () => {
        const { bus, de, fetches, next, announce } = levelEngine('l2-book', { maxBytes: 3_000_000 });
        const loaded = next('data:load');
        await de.load('NQ');
        await loaded;
        const cut = new Promise<any>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('no cut')), 5000);
            bus.on('data:load', (p: any) => {
                if (p.dataEnd >= T0 - HOUR_MS) return;
                clearTimeout(timer);
                resolve(p);
            });
        });
        announce(MIN, T0 - 2 * HOUR_MS, T0 - 2 * HOUR_MS + 10 * MIN_MS);
        const p = await cut;
        const end = Math.floor(p.dataEnd / MIN_MS) * MIN_MS + MIN_MS;
        assertMidBars(p, p.dataStart, end);

        const appended = next('data:append');
        bus.emit('data:request-forward', { viewMax: nsOf(end + 10 * MIN_MS), symbol: 'NQ' });
        const q = await appended;
        assertMidBars(q, p.dataStart, fetches.at(-1)!.toMs);
    });

    it('live chunks extend the mid candles and the book', async () => {
        const { de, next, announce, push, settle } = levelEngine('l2-book');
        const loaded = next('data:load');
        await de.load('NQ');
        await loaded;
        announce(MIN, T0 - 20 * MIN_MS, T0);
        await settle();
        let appended = next('data:append');
        push(T0, T0 + 15_000);
        await appended;
        appended = next('data:append');
        push(T0 + 15_000, T0 + 75_000);
        const p = await appended;
        assertMidBars(p, T0 - 30 * MIN_MS, T0 + 75_000);
        assertBookIs(p, 'NQ', T0 - 30 * MIN_MS, T0 + 75_000);
    });
});

for (const level of ['tick', 'l3', 'l2'] as const) {
    describe(`${level} level, an adapter that returns less than asked`, () => {
        it('a jump back lands on data, paging back to it when the window came back short', async () => {
            const { de, latest, fetches } = levelEngine(level, { pageMs: 30 * MIN_MS, initialMs: 3 * HOUR_MS });
            await de.load('NQ');
            const target = T0 - 100 * MIN_MS;
            await de.seekLoad(nsOf(target));
            for (let i = 0; i < 100 && !(latest.get('NQ')?.dataStart <= target); i++) await new Promise((r) => setTimeout(r, 20));
            const p = latest.get('NQ');
            const lastMs = Number(p.trades.at(-1).ts / 1_000_000n);
            assert.ok(
                p.dataStart <= target && lastMs >= target,
                `held ${p.dataStart - T0}..${lastMs - T0}, the target is ${target - T0}. fetched ${JSON.stringify(fetches.map((x) => [x.direction, x.fromMs - T0, x.toMs - T0]))}`,
            );
            assertTradesAre(p, 'NQ', firstMs(p), lastMs + 1);
        });
    });
}
