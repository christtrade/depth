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
        bus.on('data:load', (p) => loaded.push(p.ohlcvBars?.length ?? 0));
        bus.on('data:append', (p) => appended.push(p.ohlcvBars?.length ?? 0));

        bus.emit('chart:set-symbol', { symbol: 'X:ONE', id: 0 });
        await new Promise((r) => setTimeout(r, 20));
        bus.emit('data:prefetch', { symbol: 'X:ONE' });
        await new Promise((r) => setTimeout(r, 20));

        assert.deepEqual(directions, ['initial', 'forward']);
        // the bars have to reach the payload, not just the response - an ohlcv
        // data:load with an empty ohlcvBars draws nothing at all
        assert.deepEqual(loaded, [1]);
        assert.deepEqual(appended, [1]);
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
