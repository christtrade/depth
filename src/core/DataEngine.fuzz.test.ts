// random pans, zooms, switches, live chunks and budgers and every level (seeded random)
// FUZZ_SEEDS=50 FUZZ_STEPS=60 npm test (more and longer)
// FUZZ_SEED=1234 FUZZ_LEVEL=l3 (replay a specific one)
// FUZZ_BASE=5000 (seeds from 5000 on. ci moves it every run)

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DataEngine } from './DataEngine';
import { ChartState, type ChartStateShape } from './ChartState';
import { TypedEventBus } from './TypedEventBus';
import type { BarResponse, IDataAdapter } from '../interfaces/IDataAdapter';
import { installInlineSliceWorker } from '../lib/inline-slice-worker';
import { simMboEvents, simTicks } from '../lib/sim-levels';
import { BYTES_PER_EVENT, createCompactBuffer, getEvent, getTsNs } from '../lib/compact-buffer';

installInlineSliceWorker();

type Level = 'ohlcv' | 'tick' | 'l3';

const SEC_MS = 1000;
const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const T0 = Date.UTC(2026, 0, 1);
const START = T0 - 3 * HOUR_MS;

const BASE = Number(process.env.FUZZ_BASE ?? 1000);
const REPLAY = !!process.env.FUZZ_SEED;
const SEEDS = REPLAY
    ? [Number(process.env.FUZZ_SEED)]
    : Array.from({ length: Number(process.env.FUZZ_SEEDS ?? 3) }, (_, i) => BASE + i);
const STEPS = Number(process.env.FUZZ_STEPS ?? 20);
const LEVELS: Level[] = process.env.FUZZ_LEVEL ? [process.env.FUZZ_LEVEL as Level] : ['ohlcv', 'tick', 'l3'];

const TIMEFRAMES_MS = [15 * SEC_MS, 30 * SEC_MS, MIN_MS, 5 * MIN_MS];
const BUDGETS: Record<Level, number[]> = {
    ohlcv: [Infinity, 20_000, 60_000],
    tick: [Infinity, 1_500_000, 4_000_000],
    l3: [Infinity, 4_000_000, 10_000_000],
};

function mulberry32(seed: number) {
    return () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
type Rand = ReturnType<typeof mulberry32>;
const int = (r: Rand, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T,>(r: Rand, xs: readonly T[]) => xs[Math.floor(r() * xs.length)];

const nsOf = (ms: number) => BigInt(Math.round(ms)) * 1_000_000n;
const msOf = (ns: bigint) => Number(ns / 1_000_000n);
const tfOf = (ms: number) => ({ label: String(ms), barNs: nsOf(ms), defaultBars: 100, isPreset: false });

const priceOf = (symbol: string) => (ms: number) =>
    (symbol === 'NQ' ? 100 : 50) + 3 * Math.sin(ms / 2.7e6) + 0.4 * Math.sin(ms / 7_000);

// every period from START
// so a store at one resolution has no holes
function ohlcvBars(symbol: string, fromMs: number, toMs: number, periodMs: number) {
    const price = priceOf(symbol);
    const bars = [];
    for (let t = Math.ceil(fromMs / periodMs) * periodMs; t < toMs; t += periodMs) {
        const p = price(t);
        bars.push({ time: t, open: p, high: p + 0.1, low: p - 0.1, close: p, volume: 1 });
    }
    return bars;
}

function respond(level: Level, symbol: string, fromMs: number, toMs: number, periodMs: number): Partial<BarResponse> {
    if (level === 'ohlcv') return { events: [], ohlcvBars: ohlcvBars(symbol, fromMs, toMs, periodMs) };
    if (level === 'tick') return { events: [], ticks: simTicks(priceOf(symbol), fromMs, toMs) };
    return { events: simMboEvents(priceOf(symbol), fromMs, toMs) as never };
}

function fuzzEngine(level: Level, maxBytes: number, timeframeMs: number) {
    let edge = T0;
    const subs: { symbol: string; periodMs: number; sentTo: number; onBar: (r: BarResponse) => void; open: boolean }[] = [];
    const bus = new TypedEventBus();
    const state = new ChartState({ symbol: 'NQ', timeframe: tfOf(timeframeMs) } as unknown as ChartStateShape);

    const send = (sub: (typeof subs)[number], toMs: number) => {
        if (!sub.open || toMs <= sub.sentTo) return;
        const fromMs = sub.sentTo;
        sub.sentTo = toMs;
        sub.onBar({ ...respond(level, sub.symbol, fromMs, toMs, sub.periodMs), hasMore: false } as BarResponse);
    };

    const adapter = {
        resolveSymbol: async (symbol: string) => ({
            symbol,
            type: 'future',
            dataLevel: level,
            priceFormat: { minTick: 0.01, precision: 2 },
        }),
        getCapabilities: () => ({}),
        fetchBars: async (req: any) => {
            const fromMs = Math.max(START, msOf(req.range.fromNs));
            const toMs = Math.min(edge, msOf(req.range.toNs));
            const hasMore = req.direction === 'forward' ? toMs < edge : fromMs > START;
            const r = respond(level, req.symbolInfo.symbol, fromMs, Math.max(fromMs, toMs), msOf(req.timeframe.barNs));
            return { ...r, hasMore };
        },
        // act like a real feed - catch up from `since` then stream
        subscribeRealtime: (req: any, onBar: any) => {
            const sub = {
                symbol: req.symbolInfo.symbol,
                periodMs: msOf(req.timeframe.barNs),
                sentTo: msOf(req.since),
                onBar,
                open: true,
            };
            subs.push(sub);
            setTimeout(() => send(sub, edge), 0);
            return () => (sub.open = false);
        },
    } as unknown as IDataAdapter;

    const de = new DataEngine(bus, state, {
        initialLoad: {
            start: new Date(edge - 30 * MIN_MS).toISOString(),
            end: new Date(edge).toISOString(),
        },
        horizon: new Date(edge).toISOString(),
        timeframe: tfOf(timeframeMs) as never,
        dataBudget: { maxBytes },
    });
    de.setAdapter(adapter);

    let lastEvent = Date.now();
    for (const ev of ['data:load', 'data:append', 'data:prepend', 'data:status'] as const) {
        bus.on(ev, () => (lastEvent = Date.now()));
    }

    const st = (symbol: string) => (de as any)._states.get(symbol);
    const busy = () =>
        (de as any).budgetTimer !== null ||
        [...(de as any)._states.values()].some((s: any) => s.forwardInFlight || s.backwardInFlight || s.staging);

    // nothing in flight and nothing emitted for a while
    const settle = async () => {
        const until = Date.now() + 15_000;
        await new Promise((r) => setTimeout(r, 10));
        while (busy() || Date.now() - lastEvent < 60) {
            if (Date.now() > until) throw new Error('never settled');
            await new Promise((r) => setTimeout(r, 10));
        }
    };

    const advance = (ms: number) => {
        edge += ms;
        for (const sub of subs) send(sub, edge);
    };

    return { bus, de, state, subs, st, settle, advance, edge: () => edge };
}

type View = { symbol: string; periodMs: number; from: number; to: number };

// nothing past the playhead is drawn in a replay, so it doesnt need to be held
function check(level: Level, f: ReturnType<typeof fuzzEngine>, view: View, deep: boolean, playhead: number | null) {
    const s = f.st(view.symbol);
    assert.ok(s?.master, `${view.symbol} is held`);
    const m = s.master;
    const bars = m.ohlcvBars;
    const periodMs = level === 'ohlcv' ? msOf(s.fetchBarNs) : msOf(m.barNs);
    assert.ok(bars.length > 0, 'some bars');

    for (let i = 1; i < bars.length; i++) {
        assert.equal(bars.time[i] - bars.time[i - 1], periodMs, `bar ${i} at ${bars.time[i]}, one period after ${bars.time[i - 1]}`);
    }

    // store covers what the pane shows
    const edge = f.edge();
    const needFrom = Math.max(view.from, START);
    const needTo = Math.min(view.to, edge, playhead ?? Infinity);
    if (needFrom < needTo) {
        assert.ok(bars.time[0] <= Math.max(needFrom, START + periodMs), `first bar ${bars.time[0]} after the view's ${needFrom}`);
        assert.ok(bars.time[bars.length - 1] + periodMs >= Math.min(needTo, edge - periodMs), `last bar ${bars.time[bars.length - 1]} before the view's ${needTo}`);
    }

    // loaded range is whats held +- a bar
    const first = level === 'ohlcv' ? bars.time[0] : m.dataStart;
    const last = level === 'ohlcv' ? bars.time[bars.length - 1] : m.dataEnd;
    assert.ok(s.loadedFrom !== null && s.loadedTo !== null, 'a loaded range');
    assert.ok(msOf(s.loadedFrom) <= first, `loadedFrom ${msOf(s.loadedFrom)} after the data's ${first}`);
    assert.ok(first - msOf(s.loadedFrom) <= periodMs, `loadedFrom ${msOf(s.loadedFrom)} a hole before the data's ${first}`);
    assert.ok(msOf(s.loadedTo) + periodMs >= last, `loadedTo ${msOf(s.loadedTo)} before the data's ${last}`);
    assert.ok(msOf(s.loadedTo) - last <= periodMs, `loadedTo ${msOf(s.loadedTo)} a hole past the data's ${last}`);

    // the feed is open only on data that reaches the live edge
    const open = f.subs.filter((x) => x.open);
    assert.ok(open.length <= 1, `${open.length} feeds open`);
    for (const sub of open) {
        const held = f.st(sub.symbol);
        assert.ok(held.reachesLive, `a feed on ${sub.symbol} with a hole before the live edge`);
        assert.ok(held.master, `a feed on ${sub.symbol}, nothing held`);
    }

    if (level === 'ohlcv') return;

    // every tarde the generator created between the first and last held
    const trades = m.trades;
    assert.ok(trades.length > 0, 'some trades');
    const fromMs = msOf(trades[0].ts);
    const toMs = msOf(trades[trades.length - 1].ts) + 1;
    const want = simTicks(priceOf(view.symbol), fromMs, toMs);
    assert.equal(trades.length, want.length, `${trades.length} trades held, ${want.length} printed in ${fromMs}..${toMs}`);
    for (let i = 0; i < want.length; i++) {
        const t = trades[i];
        assert.ok(
            msOf(t.ts) === want[i].time && t.price === want[i].price && t.size === want[i].size,
            `trade ${i}: ${msOf(t.ts)} ${t.price}x${t.size}, expected ${want[i].time} ${want[i].price}x${want[i].size}`,
        );
    }

    const fp = m.footprintBars;
    for (let i = 1; i < fp.length; i++) assert.ok(fp[i].ts > fp[i - 1].ts, `footprint ${i} out of order`);
    assert.equal(fp.length, bars.length, 'a bar for every footprint');

    if (level !== 'l3' || !deep) return;
    const cb = createCompactBuffer(0);
    cb._buf = m.compactBuf;
    cb._view = new DataView(m.compactBuf);
    cb.length = cb.capacity = m.compactBuf.byteLength / BYTES_PER_EVENT;
    assert.ok(cb.length > 0, 'some events');
    const evFrom = msOf(getTsNs(cb, 0));
    const evTo = msOf(getTsNs(cb, cb.length - 1)) + 1;
    const events = simMboEvents(priceOf(view.symbol), evFrom, evTo);
    assert.equal(cb.length, events.length, `${cb.length} events held, ${events.length} printed in ${evFrom}..${evTo}`);
    for (let i = 0; i < events.length; i++) {
        const ts = getTsNs(cb, i);
        const oid = getEvent(cb, i).order_id;
        assert.ok(
            ts === nsOf(Date.parse(events[i].ts_event)) && oid === events[i].order_id,
            `event ${i}: ${ts}/${oid}, expected ${events[i].ts_event}/${events[i].order_id}`,
        );
    }
}

async function run(level: Level, seed: number) {
    const r = mulberry32(seed);
    const budget = pick(r, BUDGETS[level]);
    let view: View = { symbol: 'NQ', periodMs: pick(r, TIMEFRAMES_MS), from: 0, to: T0 };
    const f = fuzzEngine(level, budget, view.periodMs);
    view.from = T0 - Math.min(30 * MIN_MS, 100 * view.periodMs);
    const log: string[] = [`${level}, budget ${budget}, ${view.periodMs / 1000}s`];

    const announce = () =>
        f.bus.emit('data:pane-resolution', {
            id: 0,
            symbol: view.symbol,
            barNs: nsOf(view.periodMs),
            viewFrom: nsOf(view.from),
            viewTo: nsOf(view.to),
        });

    const drive = async () => {
        for (let i = 0; i < 40; i++) {
            const s = f.st(view.symbol);
            const bars = s?.master?.ohlcvBars;
            const left = !bars?.length || bars.time[0] > Math.max(view.from, START + view.periodMs);
            const right = !bars?.length || bars.time[bars.length - 1] + view.periodMs < Math.min(view.to, f.edge() - view.periodMs, playhead ?? Infinity);
            if (!left && !right) return;
            if (left) f.bus.emit('data:request-backward', { viewMin: nsOf(view.from), symbol: view.symbol });
            if (right) f.bus.emit('data:request-forward', { viewMax: nsOf(view.to), symbol: view.symbol });
            await f.settle();
        }
    };

    let playhead: number | null = null;

    const clampSpan = () => {
        const span = Math.min(Math.max(view.to - view.from, 20 * view.periodMs), 150 * view.periodMs);
        const mid = (view.from + view.to) / 2;
        view.from = mid - span / 2;
        view.to = mid + span / 2;
    };

    const actions: { weight: number; run: () => Promise<string> | string }[] = [
        {
            weight: 5,
            run: () => {
                const span = view.to - view.from;
                const by = (r() * 6 - 3) * span;
                view.from += by;
                view.to += by;
                return `pan ${Math.round(by / MIN_MS)}m`;
            },
        },
        {
            weight: 2,
            run: () => {
                const span = view.to - view.from;
                const at = START + r() * (f.edge() - START);
                view.from = at - span / 2;
                view.to = at + span / 2;
                return `jump to ${Math.round((T0 - at) / MIN_MS)}m before T0`;
            },
        },
        {
            weight: 2,
            run: () => {
                const k = 0.3 + r() * 2.7;
                const mid = (view.from + view.to) / 2;
                const half = ((view.to - view.from) * k) / 2;
                view.from = mid - half;
                view.to = mid + half;
                clampSpan();
                return `zoom x${k.toFixed(2)}`;
            },
        },
        {
            weight: 3,
            run: () => {
                view.periodMs = pick(r, TIMEFRAMES_MS);
                clampSpan();
                announce();
                f.state.set('timeframe', tfOf(view.periodMs) as never, f.bus);
                return `timeframe ${view.periodMs / 1000}s`;
            },
        },
        {
            weight: 3,
            run: () => {
                const ms = int(r, 1, 90) * SEC_MS;
                const following = view.to >= f.edge() - view.periodMs;
                const atEdge = playhead !== null && playhead >= f.edge() - view.periodMs;
                f.advance(ms);
                // the horizon follows the live edge
                if (atEdge) {
                    playhead = f.edge();
                    f.bus.emit('playback:seek', { tNs: nsOf(playhead) });
                }
                if (following) {
                    view.from += ms;
                    view.to += ms;
                }
                return `live +${ms / 1000}s${following ? ', following' : ''}`;
            },
        },
        {
            weight: 1,
            run: () => {
                view.symbol = view.symbol === 'NQ' ? 'ES' : 'NQ';
                f.bus.emit('chart:set-symbol', { symbol: view.symbol, id: 0 });
                return `symbol ${view.symbol}`;
            },
        },
        {
            weight: 1,
            run: () => {
                f.de.rehydrate();
                return 'rehydrate';
            },
        },
        {
            weight: 3,
            run: async () => {
                // seek eatch frame and prefech once past the held data (like the playback clock)
                const span = view.to - view.from;
                if (playhead === null) playhead = view.from + span * (0.2 + r() * 0.6);
                const n = int(r, 1, 6);
                const log: string[] = [];
                for (let i = 0; i < n; i++) {
                    playhead = Math.min(f.edge(), playhead + int(r, 1, 40) * view.periodMs);
                    view.to = playhead + span / 4;
                    view.from = view.to - span;
                    f.bus.emit('playback:seek', { tNs: nsOf(playhead) });
                    announce();
                    const bars = f.st(view.symbol)?.master?.ohlcvBars;
                    const end = bars?.length ? bars.time[bars.length - 1] + view.periodMs : 0;
                    if (playhead > end) {
                        const gap = nsOf(playhead - end);
                        f.bus.emit('data:prefetch', { spanNs: gap + gap / 8n });
                        log.push('prefetch');
                    }
                    if (r() < 0.5) await f.settle();
                }
                return `replay ${n} steps to ${Math.round((playhead - T0) / 1000)}s from T0 ${log.join(' ')}`;
            },
        },
        {
            weight: 1,
            run: () => {
                const from = playhead ?? f.edge();
                const span = view.to - view.from;
                playhead = START + r() * (f.edge() - START);
                view.from = playhead - span / 2;
                view.to = playhead + span / 2;
                f.bus.emit('playback:seek', { tNs: nsOf(playhead) });
                f.bus.emit('data:seek-load', { tNs: nsOf(playhead), fromNs: nsOf(from) });
                return `seek-load to ${Math.round((playhead - T0) / 1000)}s from T0`;
            },
        },
    ];
    const total = actions.reduce((s, a) => s + a.weight, 0);
    const next = () => {
        let x = r() * total;
        for (const a of actions) if ((x -= a.weight) < 0) return a;
        return actions[0];
    };

    try {
        await f.de.load('NQ');
        await f.settle();
        announce();
        await f.settle();
        check(level, f, view, true, playhead);
        for (let step = 0; step < STEPS; step++) {
            log.push(await next().run());
            announce();
            await f.settle();
            await drive();
            log.push(`  view ${view.from - T0}..${view.to - T0} at ${view.periodMs / 1000}s`);
            check(level, f, view, REPLAY || step % 5 === 4 || step === STEPS - 1, playhead);
        }
    } catch (err) {
        (err as Error).message +=
            `\nseed ${seed}, replay with FUZZ_SEED=${seed} FUZZ_LEVEL=${level}\n  ${log.slice(-16).join('\n  ')}`;
        throw err;
    } finally {
        f.de.destroy();
    }
}

for (const level of LEVELS) {
    describe(`fuzz ${level}`, () => {
        for (const seed of SEEDS) it(`seed ${seed}`, { timeout: 120_000 }, () => run(level, seed));
    });
}
