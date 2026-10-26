import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DataEngine } from './DataEngine';
import { ChartState, type ChartStateShape } from './ChartState';
import { TypedEventBus } from './TypedEventBus';
import type { IDataAdapter, SymbolInfo } from '../interfaces/IDataAdapter';
import { DataSourceRegistry, type PluginDataSource } from './DataSourceRegistry';

function info(symbol: string): SymbolInfo {
    return {
        symbol,
        type: 'stock',
        dataLevel: 'ohlcv',
        priceFormat: { minTick: 0.01, precision: 2 },
    };
}

// enough of an adapter for the symbol search path; nothing here loads data
function adapter(symbols: string[]): IDataAdapter {
    return {
        resolveSymbol: async (symbol: string) => info(symbol),
        fetch: async () => ({}) as never,
        searchSymbols: async () => symbols.map(info),
    } as unknown as IDataAdapter;
}

function engine(source?: Partial<PluginDataSource>) {
    const bus = new TypedEventBus();
    const state = new ChartState({
        symbol: 'NQ',
        timeframe: { label: '1m', barNs: 60_000_000_000n },
    } as unknown as ChartStateShape);

    const plugins = new DataSourceRegistry();
    if (source) {
        plugins.register({
            prefix: 'X:',
            fetchBars: async () => ({ events: [], hasMore: false }),
            ...source,
        });
    }

    const de = new DataEngine(bus, state, {
        initialLoad: { start: '2024-01-01T00:00:00Z', end: '2024-01-02T00:00:00Z' },
        horizon: '2024-01-02T00:00:00Z',
        timeframe: { label: '1m', barNs: 60_000_000_000n } as never,
        plugins,
    });
    de.setAdapter(adapter(['NQ', 'ES']));
    return { bus, de, plugins };
}

function search(bus: TypedEventBus, query: string): Promise<SymbolInfo[]> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no search response')), 3000);
        const off = bus.on('data:search-symbols-response', ({ symbols }) => {
            clearTimeout(timer);
            off();
            resolve(symbols);
        });
        bus.emit('data:search-symbols', { requestId: '1', request: { query } });
    });
}

// a chart walked back from 2026 to 2000 on the daily holds 26 years of
// segments; dropping to 1m used to re-fetch every one of them
const MIN = 60_000_000_000n;
const DAY = 86_400_000_000_000n;

const T2000 = Date.UTC(2000, 0, 1);
const T2026 = Date.UTC(2026, 0, 1);

function nsOf(ms: number): bigint {
    return BigInt(ms) * 1_000_000n;
}

type Fetch = { fromNs: bigint; toNs: bigint; barNs: bigint; direction: string };

// serves 1m and 1d, logs every fetch, answers with a bar on each edge of the
// range - enough for segment bookkeeping without 26 years of minutes
function refineEngine(opts: { timeframe: bigint; loadFrom: number; loadTo: number }) {
    const fetches: Fetch[] = [];
    const bus = new TypedEventBus();
    const tf = { label: 'x', barNs: opts.timeframe, defaultBars: 100, isPreset: false };
    const state = new ChartState({ symbol: 'NQ', timeframe: tf } as unknown as ChartStateShape);

    const adapter = {
        resolveSymbol: async (symbol: string) => ({
            ...info(symbol),
            supportedResolutions: [MIN, DAY],
        }),
        fetchBars: async (req: any) => {
            fetches.push({
                fromNs: req.range.fromNs,
                toNs: req.range.toNs,
                barNs: req.timeframe.barNs,
                direction: req.direction,
            });
            const fromMs = Number(req.range.fromNs / 1_000_000n);
            const toMs = Number(req.range.toNs / 1_000_000n);
            const bar = (time: number) => ({
                time,
                open: 1,
                high: 2,
                low: 0.5,
                close: 1.5,
                volume: 1,
            });
            return { events: [], ohlcvBars: [bar(fromMs), bar(toMs - 1)], hasMore: true };
        },
    } as unknown as IDataAdapter;

    const de = new DataEngine(bus, state, {
        initialLoad: {
            start: new Date(opts.loadFrom).toISOString(),
            end: new Date(opts.loadTo).toISOString(),
        },
        horizon: new Date(opts.loadTo).toISOString(),
        timeframe: tf as never,
    });
    de.setAdapter(adapter);

    const announce = (id: number, barNs: bigint, viewFrom?: number, viewTo?: number) =>
        bus.emit('data:pane-resolution', {
            id,
            symbol: 'NQ',
            barNs,
            ...(viewFrom !== undefined && viewTo !== undefined
                ? { viewFrom: nsOf(viewFrom), viewTo: nsOf(viewTo) }
                : {}),
        });

    const settle = () => new Promise((r) => setTimeout(r, 20));

    return { bus, de, state, fetches, announce, settle, tf };
}

/** Fetches issued at `barNs`, and the widest span any one of them asked for. */
function refines(fetches: Fetch[], barNs: bigint) {
    const at = fetches.filter((f) => f.barNs === barNs);
    const widest = at.reduce((max, f) => (f.toNs - f.fromNs > max ? f.toNs - f.fromNs : max), 0n);
    return { count: at.length, widest, at };
}

describe('refining a scale-down', () => {
    it('re-fetches the pane window, not every year ever loaded', async () => {
        const { de, state, fetches, announce, settle, bus } = refineEngine({
            timeframe: DAY,
            loadFrom: T2000,
            loadTo: T2026,
        });

        await de.load('NQ');
        announce(0, DAY, T2026 - 30 * 86_400_000, T2026);
        await settle();
        assert.equal(refines(fetches, DAY).count, 1, 'one initial daily load');

        // the pane snaps its axis and announces before state fans the change out
        const minute = { label: '1m', barNs: MIN, defaultBars: 100, isPreset: false };
        announce(0, MIN, T2026 - 100 * 60_000, T2026);
        state.set('timeframe', minute as never, bus);
        await settle();

        const refined = refines(fetches, MIN);
        assert.ok(refined.count > 0, 'the visible window gets 1m bars');
        // 26 years is 13.6m minutes; the slack is the pad plus daily rounding
        assert.ok(
            refined.widest <= 4n * DAY,
            `refined ${refined.widest / DAY} days, want a window not a history`,
        );
    });

    it('leaves the rest coarse, and fills it in when the view pans into it', async () => {
        const { de, fetches, announce, settle } = refineEngine({
            timeframe: DAY,
            loadFrom: T2000,
            loadTo: T2026,
        });

        await de.load('NQ');
        announce(0, DAY, T2026 - 30 * 86_400_000, T2026);
        await settle();

        announce(0, MIN, T2026 - 100 * 60_000, T2026);
        await settle();
        const first = refines(fetches, MIN).count;
        assert.ok(first > 0);

        // the segment covering 2010 is still daily, so reaching it must refine it
        const t2010 = Date.UTC(2010, 5, 1);
        announce(0, MIN, t2010, t2010 + 100 * 60_000);
        await settle();

        const after = refines(fetches, MIN);
        assert.ok(after.count > first, 'panning into coarse history refines it');
        const last = after.at[after.at.length - 1];
        assert.ok(last.fromNs >= nsOf(t2010) - 4n * DAY, 'around the new window');
        assert.ok(last.toNs <= nsOf(t2010) + 4n * DAY, 'and no wider than it needs');
    });

    it('does not re-ask for a window it already refined', async () => {
        const { de, fetches, announce, settle } = refineEngine({
            timeframe: DAY,
            loadFrom: T2000,
            loadTo: T2026,
        });

        await de.load('NQ');
        announce(0, DAY, T2026 - 30 * 86_400_000, T2026);
        await settle();

        announce(0, MIN, T2026 - 100 * 60_000, T2026);
        await settle();
        const once = refines(fetches, MIN).count;

        // a few bars inside the same block - snapped to the identical range
        announce(0, MIN, T2026 - 110 * 60_000, T2026 - 10 * 60_000);
        await settle();

        assert.equal(refines(fetches, MIN).count, once, 'nothing new to fetch');
    });

    it("a coarse pane's twenty-year window does not widen a fine pane's", async () => {
        const { de, fetches, announce, settle } = refineEngine({
            timeframe: DAY,
            loadFrom: T2000,
            loadTo: T2026,
        });

        await de.load('NQ');
        // cell 0 shows the whole history on the daily, cell 1 a day at 1m
        announce(0, DAY, T2000, T2026);
        announce(1, MIN, T2026 - 86_400_000, T2026);
        await settle();

        const refined = refines(fetches, MIN);
        assert.ok(refined.count > 0);
        assert.ok(
            refined.widest <= 6n * DAY,
            `refined ${refined.widest / DAY} days for a one-day pane`,
        );
    });

    it('two cells a decade apart get two windows, not the decade between them', async () => {
        const { de, fetches, announce, settle } = refineEngine({
            timeframe: DAY,
            loadFrom: T2000,
            loadTo: T2026,
        });

        await de.load('NQ');
        announce(0, DAY, T2026 - 30 * 86_400_000, T2026);
        await settle();

        const t2010 = Date.UTC(2010, 5, 1);
        announce(0, MIN, t2010, t2010 + 100 * 60_000);
        announce(1, MIN, T2026 - 100 * 60_000, T2026);
        await settle();

        const refined = refines(fetches, MIN);
        assert.equal(refined.count, 2, 'one fetch per screen');
        for (const f of refined.at) {
            assert.ok(f.toNs - f.fromNs <= 4n * DAY, 'each one a screenful');
        }
    });

    it('falls back to the horizon when no pane has said where it is looking', async () => {
        const { de, fetches, settle, state, bus } = refineEngine({
            timeframe: DAY,
            loadFrom: T2000,
            loadTo: T2026,
        });

        await de.load('NQ');
        await settle();

        const minute = { label: '1m', barNs: MIN, defaultBars: 100, isPreset: false };
        state.set('timeframe', minute as never, bus);
        await settle();

        const refined = refines(fetches, MIN);
        assert.ok(refined.count > 0, 'a headless host still gets fine bars');
        assert.ok(refined.widest <= 6n * DAY, `refined ${refined.widest / DAY} days`);
        for (const f of refined.at) {
            assert.ok(f.toNs >= nsOf(T2026) - 6n * DAY, 'around the horizon');
        }
    });

    it('scaling back up fetches nothing - the bars in hand are finer than needed', async () => {
        const { de, fetches, announce, settle, state, bus } = refineEngine({
            timeframe: MIN,
            loadFrom: T2026 - 86_400_000,
            loadTo: T2026,
        });

        await de.load('NQ');
        announce(0, MIN, T2026 - 100 * 60_000, T2026);
        await settle();
        const before = fetches.length;

        const daily = { label: '1d', barNs: DAY, defaultBars: 30, isPreset: false };
        announce(0, DAY, T2026 - 30 * 86_400_000, T2026);
        state.set('timeframe', daily as never, bus);
        await settle();

        assert.equal(fetches.length, before, 'no refetch on the way up');
    });
});

describe('symbol search with plugin sources', () => {
    it('returns just the adapter when nothing is registered', async () => {
        const { bus } = engine();
        const found = await search(bus, '');
        assert.deepEqual(
            found.map((s) => s.symbol),
            ['NQ', 'ES'],
        );
    });

    it('puts plugin symbols in front of the adapter universe', async () => {
        const { bus } = engine({ searchSymbols: async () => [info('MASS:AAPL')] });
        const found = await search(bus, '');
        assert.deepEqual(
            found.map((s) => s.symbol),
            ['MASS:AAPL', 'NQ', 'ES'],
        );
    });

    it('lets a plugin shadow an adapter symbol rather than listing it twice', async () => {
        const { bus } = engine({ searchSymbols: async () => [info('NQ')] });
        const found = await search(bus, '');
        assert.deepEqual(
            found.map((s) => s.symbol),
            ['NQ', 'ES'],
        );
    });

    it('still answers with the adapter when the plugin search throws', async () => {
        const { bus } = engine({
            searchSymbols: () => {
                throw new Error('rate limited');
            },
        });
        const found = await search(bus, '');
        assert.deepEqual(
            found.map((s) => s.symbol),
            ['NQ', 'ES'],
        );
    });
});

describe('routing a claimed symbol', () => {
    // the whole point of the rewrite: a plugin symbol goes through the same
    // fetchBars path a built-in one does, so playback can prefetch it
    it('fetches through the source, not the adapter', async () => {
        const seen: string[] = [];
        const { bus, plugins } = engine();
        plugins.register({
            prefix: 'X:',
            resolveSymbol: () => info('X:ONE'),
            fetchBars: async (req) => {
                seen.push(req.direction);
                return { events: [], ohlcvBars: [], hasMore: true };
            },
        });

        bus.emit('chart:set-symbol', { symbol: 'X:ONE', id: 0 });
        await new Promise((r) => setTimeout(r, 20));

        assert.deepEqual(seen, ['initial']);
    });

    it('prefetches forward, which is what playback runs on', async () => {
        const directions: string[] = [];
        const { bus, plugins } = engine();
        plugins.register({
            prefix: 'X:',
            resolveSymbol: () => info('X:ONE'),
            fetchBars: async (req) => {
                directions.push(req.direction);
                const fromMs = Number(req.range.fromNs / 1_000_000n);
                return {
                    events: [],
                    ohlcvBars: [
                        { time: fromMs, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
                    ],
                    hasMore: true,
                };
            },
        });

        const loaded: number[] = [];
        const appended: number[] = [];
        bus.on('data:load', (p) => loaded.push(p.bars?.length ?? 0));
        bus.on('data:append', (p) => appended.push(p.ohlcvBars?.length ?? 0));

        bus.emit('chart:set-symbol', { symbol: 'X:ONE', id: 0 });
        await new Promise((r) => setTimeout(r, 20));
        bus.emit('data:prefetch', { symbol: 'X:ONE' });
        await new Promise((r) => setTimeout(r, 20));

        assert.deepEqual(directions, ['initial', 'forward']);
        // the bars have to reach the payload, not just the response - an ohlcv
        assert.deepEqual(loaded, [1]);
        assert.deepEqual(appended, [1]);
    });

    it('getData() hands out the store, with ohlcvBars kept as a cached copy', async () => {
        const { bus, de, plugins } = engine();
        plugins.register({
            prefix: 'X:',
            resolveSymbol: () => info('X:ONE'),
            fetchBars: async (req) => {
                const fromMs = Number(req.range.fromNs / 1_000_000n);
                return {
                    events: [],
                    ohlcvBars: [
                        { time: fromMs, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
                        { time: fromMs + 60_000, open: 1.5, high: 3, low: 1, close: 2.5, volume: 4 },
                    ],
                    hasMore: true,
                };
            },
        });

        bus.emit('chart:set-symbol', { symbol: 'X:ONE', id: 0 });
        await new Promise((r) => setTimeout(r, 20));

        const snap = de.getSnapshot();
        const firstCopy = snap.ohlcvBars;
        assert.equal(snap.bars.length, 2);
        assert.deepEqual(firstCopy, snap.bars.toArray());
        assert.equal(de.getSnapshot().ohlcvBars, firstCopy);

        bus.emit('data:prefetch', { symbol: 'X:ONE' });
        await new Promise((r) => setTimeout(r, 20));

        const after = de.getSnapshot();
        assert.equal(after.bars, snap.bars, 'one store for the symbol, grown in place');
        assert.equal(after.bars.length, 3);
        assert.ok(after.bars.time.every((t, i, a) => i === 0 || t > a[i - 1]), 'no duplicate bars');
        assert.notEqual(after.ohlcvBars, firstCopy, 'rebuilt once the bars changed');
        assert.equal(after.ohlcvBars.length, 3);
    });

    it('resolves the symbol before the data, so the first frame is priced right', async () => {
        const order: string[] = [];
        const { bus, plugins } = engine();
        plugins.register({
            prefix: 'X:',
            resolveSymbol: () => ({ ...info('X:ONE'), priceFormat: { minTick: 0.25, precision: 2 } }),
            fetchBars: async () => ({ events: [], ohlcvBars: [], hasMore: true }),
        });

        bus.on('data:symbol-resolved', ({ symbolInfo }) =>
            order.push('resolved:' + symbolInfo.priceFormat.minTick),
        );
        bus.on('data:load', () => order.push('load'));

        bus.emit('chart:set-symbol', { symbol: 'X:ONE', id: 0 });
        await new Promise((r) => setTimeout(r, 20));

        assert.equal(order[0], 'resolved:0.25');
    });
});
