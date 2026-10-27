import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DataEngine } from './DataEngine';
import { ChartState, type ChartStateShape } from './ChartState';
import { TypedEventBus } from './TypedEventBus';
import type { IDataAdapter, SymbolInfo } from '../interfaces/IDataAdapter';
import { DataSourceRegistry, type PluginDataSource } from './DataSourceRegistry';
import type { Timeframe } from '../lib/timeframes';

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

const SEC = 1_000_000_000n;
const MIN = 60n * SEC;
const HOUR = 60n * MIN;
const DAY = 24n * HOUR;

const T2000 = Date.UTC(2000, 0, 1);
const T2026 = Date.UTC(2026, 0, 1);

function nsOf(ms: number): bigint {
    return BigInt(ms) * 1_000_000n;
}

function tfOf(barNs: bigint): Timeframe {
    return { label: String(barNs), barNs, defaultBars: 100, isPreset: false };
}

type Fetch = {
    symbol: string;
    fromNs: bigint;
    toNs: bigint;
    barNs: bigint;
    direction: string;
    supplementalBarNs?: bigint;
    supplementalRange?: { fromNs: bigint; toNs: bigint };
};

function tfEngine(opts: {
    timeframe: bigint;
    loadFrom: number;
    loadTo: number;
    supported?: bigint[];
    fail?: () => boolean;
    barren?: bigint[];
    supplemental?: bigint;
}) {
    const fetches: Fetch[] = [];
    const bus = new TypedEventBus();
    const tf = tfOf(opts.timeframe);
    const state = new ChartState({ symbol: 'NQ', timeframe: tf } as unknown as ChartStateShape);

    const adapter = {
        resolveSymbol: async (symbol: string) => ({
            ...info(symbol),
            supportedResolutions: opts.supported ?? [SEC, MIN, HOUR, DAY],
        }),
        getCapabilities: () =>
            opts.supplemental ? { supplementalResolutions: [opts.supplemental] } : {},
        fetchBars: async (req: any) => {
            fetches.push({
                symbol: req.symbolInfo.symbol,
                fromNs: req.range.fromNs,
                toNs: req.range.toNs,
                barNs: req.timeframe.barNs,
                direction: req.direction,
                supplementalBarNs: req.supplementalBarNs,
                supplementalRange: req.supplementalRange
                    ? { fromNs: req.supplementalRange.fromNs, toNs: req.supplementalRange.toNs }
                    : undefined,
            });
            if (opts.fail?.()) throw new Error('adapter is down');

            if (opts.barren?.includes(req.timeframe.barNs)) {
                return { events: [], ohlcvBars: [], hasMore: false };
            }

            const stepMs = Number(req.timeframe.barNs / 1_000_000n);
            const fromMs = Math.ceil(Number(req.range.fromNs / 1_000_000n) / stepMs) * stepMs;
            const toMs = Number(req.range.toNs / 1_000_000n);
            const bars = [];
            for (let t = fromMs; t < toMs && bars.length < 5000; t += stepMs) {
                bars.push({ time: t, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 });
            }
            return { events: [], ohlcvBars: bars, hasMore: true };
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

    const announce = (
        id: number,
        barNs: bigint,
        viewFrom?: number,
        viewTo?: number,
        symbol = 'NQ',
    ) =>
        bus.emit('data:pane-resolution', {
            id,
            symbol,
            barNs,
            ...(viewFrom !== undefined && viewTo !== undefined
                ? { viewFrom: nsOf(viewFrom), viewTo: nsOf(viewTo) }
                : {}),
        });

    const switchTo = (barNs: bigint, viewFrom: number, viewTo: number) => {
        announce(0, barNs, viewFrom, viewTo);
        state.set('timeframe', tfOf(barNs) as never, bus);
    };

    const settle = () => new Promise((r) => setTimeout(r, 30));

    const storePeriods = () => {
        const bars = de.getSnapshot().bars;
        const gaps = new Set<bigint>();
        for (let i = 1; i < bars.length; i++) {
            gaps.add(BigInt(bars.time[i] - bars.time[i - 1]) * 1_000_000n);
        }
        return gaps;
    };

    return { bus, de, state, fetches, announce, switchTo, settle, storePeriods };
}

/** Fetches issued at `barNs`, and the widest span any one of them asked for. */
function at(fetches: Fetch[], barNs: bigint) {
    const matching = fetches.filter((f) => f.barNs === barNs);
    const widest = matching.reduce(
        (max, f) => (f.toNs - f.fromNs > max ? f.toNs - f.fromNs : max),
        0n,
    );
    return { count: matching.length, widest, all: matching };
}

describe('changing timeframe', () => {
    it('reloads the window at the new resolution instead of mixing periods', async () => {
        const { de, fetches, announce, switchTo, settle, storePeriods } = tfEngine({
            timeframe: DAY,
            loadFrom: T2000,
            loadTo: T2026,
        });

        await de.load('NQ');
        announce(0, DAY, T2026 - 30 * 86_400_000, T2026);
        await settle();
        assert.deepEqual([...storePeriods()], [DAY], 'daily load, daily bars');

        switchTo(MIN, T2026 - 100 * 60_000, T2026);
        await settle();

        assert.deepEqual([...storePeriods()], [MIN], 'one period in the store, the new one');
        const minutes = at(fetches, MIN);
        assert.ok(minutes.count > 0, 'the window was fetched at 1m');
        // 26 years is 13.6m minutes - the window is a screen plus its pads
        assert.ok(
            minutes.widest <= 4n * DAY,
            `fetched ${minutes.widest / DAY} days for a 100 minute screen`,
        );
    });

    it('survives the sequence that used to mix three periods', async () => {
        // the reported repro: daily, down to minutes, pan back, up to hours,
        // down to seconds, back to minutes
        const { de, announce, switchTo, settle, storePeriods, bus } = tfEngine({
            timeframe: DAY,
            loadFrom: T2000,
            loadTo: T2026,
        });

        await de.load('NQ');
        announce(0, DAY, T2026 - 30 * 86_400_000, T2026);
        await settle();

        const steps: Array<[bigint, number, number]> = [
            [MIN, T2026 - 100 * 60_000, T2026],
            [MIN, T2026 - 200 * 60_000, T2026 - 100 * 60_000], // pan back
            [HOUR, T2026 - 100 * 3_600_000, T2026],
            [SEC, T2026 - 100_000, T2026],
            [MIN, T2026 - 100 * 60_000, T2026],
        ];

        for (const [barNs, from, to] of steps) {
            if (barNs === de.getSnapshot().barNs) {
                // a pan at the same period, which extends rather than reloads
                bus.emit('data:request-backward', { viewMin: nsOf(from), symbol: 'NQ' });
            } else {
                switchTo(barNs, from, to);
            }
            await settle();

            const periods = [...storePeriods()];
            assert.ok(
                periods.length <= 1,
                `store holds ${periods.length} periods after ${barNs}: ${periods.join()}`,
            );
            if (periods.length === 1) {
                assert.equal(periods[0], barNs, `store is at ${barNs}`);
            }
        }
    });

    it('never asks for a period the adapter cannot serve', async () => {
        const { de, fetches, switchTo, settle } = tfEngine({
            timeframe: MIN,
            loadFrom: T2026 - 86_400_000,
            loadTo: T2026,
            supported: [MIN, HOUR, DAY],
        });

        await de.load('NQ');
        await settle();

        // 90s is not a whole number of minutes, so 1m bars would straddle every
        // bucket - and seconds arent served at all
        switchTo(90n * SEC, T2026 - 100 * 90_000, T2026);
        switchTo(30n * SEC, T2026 - 100 * 30_000, T2026);
        await settle();

        for (const f of fetches) {
            assert.ok(
                [MIN, HOUR, DAY].includes(f.barNs),
                `fetched at ${f.barNs}, which the adapter does not serve`,
            );
        }
    });

    it('keeps the bars it is drawing when the switch fetch fails', async () => {
        let down = false;
        const { de, switchTo, settle, storePeriods, announce } = tfEngine({
            timeframe: DAY,
            loadFrom: T2026 - 30 * 86_400_000,
            loadTo: T2026,
            fail: () => down,
        });

        await de.load('NQ');
        announce(0, DAY, T2026 - 30 * 86_400_000, T2026);
        await settle();
        const before = de.getSnapshot().bars.length;

        down = true;
        switchTo(MIN, T2026 - 100 * 60_000, T2026);
        await settle();

        assert.deepEqual([...storePeriods()], [DAY], 'still the daily bars');
        assert.equal(de.getSnapshot().bars.length, before, 'nothing was thrown away');
    });

    it('serves two panes from one resolution that divides both', async () => {
        const { de, fetches, announce, settle, storePeriods } = tfEngine({
            timeframe: HOUR,
            loadFrom: T2026 - 30 * 86_400_000,
            loadTo: T2026,
        });

        await de.load('NQ');
        announce(0, HOUR, T2026 - 100 * 3_600_000, T2026);
        await settle();

        // a second cell on the same symbol at 1m: one window has to serve both,
        // and only a period that divides each of them can
        announce(1, MIN, T2026 - 100 * 60_000, T2026);
        await settle();

        assert.deepEqual([...storePeriods()], [MIN]);
        assert.ok(at(fetches, MIN).count > 0);
    });

    it('reloads for a pane switching coarser than another pane holds the symbol', async () => {
        const { de, fetches, announce, settle } = tfEngine({
            timeframe: MIN,
            loadFrom: T2026 - 86_400_000,
            loadTo: T2026,
        });

        await de.load('NQ');
        // cell 0 keeps the symbol at 1m over a narrow window
        announce(0, MIN, T2026 - 100 * 60_000, T2026);
        await settle();
        const before = fetches.length;

        // cell 1 goes to 1d: 1m bars can build a daily candle, but not over the
        // 100 days it is about to show, so the window has to be reloaded even
        // though the resolution is already fine enough
        announce(1, DAY, T2026 - 100 * 86_400_000, T2026);
        await settle();

        assert.ok(fetches.length > before, 'the wider window was fetched');
        const last = fetches[fetches.length - 1];
        assert.ok(
            last.toNs - last.fromNs >= 100n * DAY,
            'and it covers what the new pane shows',
        );
    });

    // A host mounts the chart on its own default symbol and then restores a
    // layout onto a different one, which leaves the default loaded with no pane
    // showing it. It used to follow every timeframe change: a 1s NQ chart going
    // to 4h fetched NQ hourly, then BTC hourly, then a day of BTC seconds per
    // day of the window - for a symbol that isn't on screen.
    it('leaves a loaded symbol no pane shows out of a timeframe switch', async () => {
        const { de, fetches, announce, switchTo, settle } = tfEngine({
            timeframe: SEC,
            loadFrom: T2026 - 86_400_000,
            loadTo: T2026,
        });

        await de.load('BTC');
        await de.load('NQ');
        announce(0, SEC, T2026 - 100 * 1000, T2026);
        await settle();
        const btcBefore = fetches.filter((f) => f.symbol === 'BTC').length;

        switchTo(4n * HOUR, T2026 - 100 * 4 * 3_600_000, T2026);
        await settle();

        assert.ok(at(fetches, HOUR).count > 0, 'the pane that switched got its reload');
        assert.equal(
            fetches.filter((f) => f.symbol === 'BTC').length,
            btcBefore,
            'nothing was fetched for the symbol nobody is looking at',
        );
    });

    // A switch announces itself twice: the pane's new period, then shared state's
    // timeframe. Both arrive before either fetch returns, so both saw a window
    // still at the old resolution and both staged a reload for it - the same
    // window fetched twice, 1s supplemental and all.
    it('fetches the window a switch needs once, not once per announcement', async () => {
        const { de, fetches, announce, switchTo, settle } = tfEngine({
            timeframe: SEC,
            loadFrom: T2026 - 86_400_000,
            loadTo: T2026,
        });

        await de.load('NQ');
        announce(0, SEC, T2026 - 100 * 1000, T2026);
        await settle();

        switchTo(HOUR, T2026 - 100 * 3_600_000, T2026);
        await settle();

        assert.equal(at(fetches, HOUR).count, 1, 'one reload for one switch');
    });

    it('still extends every pane on a playback prefetch, but only those', async () => {
        const { bus, de, fetches, announce, settle } = tfEngine({
            timeframe: MIN,
            loadFrom: T2026 - 86_400_000,
            loadTo: T2026,
        });

        await de.load('BTC');
        await de.load('NQ');
        announce(0, MIN, T2026 - 100 * 60_000, T2026);
        announce(1, MIN, T2026 - 100 * 60_000, T2026, 'BTC');
        await settle();
        const before = fetches.length;

        // no symbol: the playback clock asking the whole layout to extend
        bus.emit('data:prefetch', { spanNs: HOUR } as never);
        await settle();

        const forward = fetches.slice(before).filter((f) => f.direction === 'forward');
        assert.deepEqual(
            new Set(forward.map((f) => f.symbol)),
            new Set(['NQ', 'BTC']),
            'both panes keep up with the playhead',
        );
    });

    // The pane dims and waits for the reload to land. An empty one used to emit
    // `ready` and nothing else, so a switch onto a period the source has no bars
    // for (1s over a weekend, a day outside a seconds entitlement) left the chart
    // frozen until the 15s timeout rather than saying so.
    it('says so when the resolution a pane is waiting for has no data', async () => {
        const { bus, de, announce, switchTo, settle } = tfEngine({
            timeframe: HOUR,
            loadFrom: T2026 - 30 * 86_400_000,
            loadTo: T2026,
            barren: [SEC],
        });

        await de.load('NQ');
        announce(0, HOUR, T2026 - 100 * 3_600_000, T2026);
        await settle();

        const heard: Array<{ symbol: string; barNs: bigint }> = [];
        bus.on('data:resolution-unavailable', (p) => heard.push(p));

        switchTo(SEC, T2026 - 7200 * 1000, T2026);
        await settle();

        assert.deepEqual(heard, [{ symbol: 'NQ', barNs: SEC }]);
    });

    // Supplemental bars shape the forming bar at the playhead and the replay
    // ahead of it; the history to its left is never read. Asking for them over
    // the whole window meant a source that fetches them per day paid for every
    // day of a window that can be weeks wide.
    it('asks for supplemental bars from the playhead on, not across the window', async () => {
        const { de, fetches, announce, switchTo, settle } = tfEngine({
            timeframe: MIN,
            loadFrom: T2026 - 86_400_000,
            loadTo: T2026,
            supplemental: SEC,
        });

        await de.load('NQ');
        announce(0, MIN, T2026 - 100 * 60_000, T2026);
        await settle();

        switchTo(4n * HOUR, T2026 - 32 * 4 * 3_600_000, T2026);
        await settle();

        const staged = at(fetches, HOUR).all.at(-1)!;
        assert.equal(staged.supplementalBarNs, SEC, 'still wants the finer bars');
        const range = staged.supplementalRange;
        assert.ok(range, 'over a range of its own');
        assert.ok(
            range.fromNs > staged.fromNs,
            'that starts at the playhead, not the window edge',
        );
        assert.ok(
            range.toNs - range.fromNs < (staged.toNs - staged.fromNs) / 2n,
            'and is a fraction of the window',
        );
    });

    it('scaling up to a multiple needs no fetch at all', async () => {
        const { de, fetches, announce, settle } = tfEngine({
            timeframe: MIN,
            loadFrom: T2026 - 86_400_000,
            loadTo: T2026,
        });

        await de.load('NQ');
        announce(0, MIN, T2026 - 100 * 60_000, T2026);
        await settle();
        const before = fetches.length;

        // 1m bars already build a 5m candle exactly, so the engine has nothing to
        // do - the pane re-aggregates what it holds
        announce(0, 5n * MIN, T2026 - 100 * 300_000, T2026);
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
