import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { DataSourceRegistry, type PluginDataSource } from './DataSourceRegistry';
import { makeTimeRange, type FetchRequest, type SymbolInfo } from '../interfaces/IDataAdapter';

function info(symbol: string): SymbolInfo {
    return {
        symbol,
        type: 'custom',
        dataLevel: 'ohlcv',
        priceFormat: { minTick: 0.01, precision: 2 },
    };
}

function source(overrides: Partial<PluginDataSource> = {}): PluginDataSource {
    return {
        prefix: 'X:',
        fetchBars: async () => ({ events: [], ohlcvBars: [], hasMore: true }),
        ...overrides,
    };
}

function request(symbol: string, direction: FetchRequest['direction'] = 'initial'): FetchRequest {
    return {
        symbolInfo: info(symbol),
        range: makeTimeRange(0n, 60_000_000_000n),
        timeframe: { label: '1m', barNs: 60_000_000_000n } as never,
        direction,
    };
}

let registry: DataSourceRegistry;

beforeEach(() => {
    registry = new DataSourceRegistry();
});

describe('claiming symbols', () => {
    it('matches an exact symbol before any prefix', () => {
        const exact = source({ symbols: ['X:ONE'], prefix: undefined });
        registry.register(source());
        registry.register(exact);

        assert.equal(registry.sourceFor('X:ONE'), exact);
    });

    it('gives the longest matching prefix the symbol', () => {
        const broad = source({ prefix: '' });
        const narrow = source({ prefix: 'X:FUT:' });
        registry.register(broad);
        registry.register(narrow);

        assert.equal(registry.sourceFor('X:FUT:NQ'), narrow);
        assert.equal(registry.sourceFor('AAPL'), broad);
    });

    it('forgets the symbols on unregister', () => {
        const off = registry.register(source({ symbols: ['X:ONE'], prefix: undefined }));
        assert.equal(registry.has('X:ONE'), true);
        off();
        assert.equal(registry.has('X:ONE'), false);
        assert.equal(registry.adapterFor('X:ONE'), null);
    });

    it('destroys the source on unregister', () => {
        let destroyed = false;
        const off = registry.register(source({ destroy: () => (destroyed = true) }));
        off();
        assert.equal(destroyed, true);
    });
});

describe('the adapter it hands DataEngine', () => {
    it('resolves through the source and caches the answer', async () => {
        let calls = 0;
        registry.register(
            source({
                resolveSymbol: (symbol) => {
                    calls++;
                    return { ...info(symbol), description: 'served' };
                },
            }),
        );

        const adapter = registry.adapterFor('X:ONE')!;
        assert.equal((await adapter.resolveSymbol('X:ONE')).description, 'served');
        await adapter.resolveSymbol('X:ONE');
        assert.equal(calls, 1);
        assert.equal(registry.getResolved('X:ONE')?.description, 'served');
    });

    it('falls back to a placeholder when resolveSymbol throws', async () => {
        registry.register(
            source({
                resolveSymbol: () => {
                    throw new Error('no key');
                },
            }),
        );

        const resolved = await registry.adapterFor('X:ONE')!.resolveSymbol('X:ONE');
        assert.equal(resolved.symbol, 'X:ONE');
        assert.equal(resolved.priceFormat.minTick, 0.01);
    });

    it('leaves optional methods undefined so the engine can feature-detect', () => {
        registry.register(source());
        const bare = registry.adapterFor('X:ONE')!;
        assert.equal(bare.fetchPreview, undefined);
        assert.equal(bare.getCapabilities, undefined);
        assert.equal(bare.subscribeRealtime, undefined);

        registry.register(
            source({
                prefix: 'Y:',
                fetchPreview: async () => ({ symbol: 'Y:ONE', bars: [] }),
                getCapabilities: () => ({ supplementalResolutions: [1_000_000_000n] }),
            }),
        );
        const full = registry.adapterFor('Y:ONE')!;
        assert.equal(typeof full.fetchPreview, 'function');
        assert.deepEqual(full.getCapabilities!().supplementalResolutions, [1_000_000_000n]);
    });

    it('passes the fetch straight through', async () => {
        const seen: FetchRequest[] = [];
        registry.register(
            source({
                fetchBars: async (req) => {
                    seen.push(req);
                    return { events: [], ohlcvBars: [], hasMore: false };
                },
            }),
        );

        const response = await registry.adapterFor('X:ONE')!.fetchBars(request('X:ONE', 'forward'));
        assert.equal(response.hasMore, false);
        assert.equal(seen[0].direction, 'forward');
        assert.equal(seen[0].symbolInfo.symbol, 'X:ONE');
    });
});

describe('symbol search', () => {
    it('matches the listed symbols when the source has no search of its own', async () => {
        registry.register(source({ symbols: ['X:GOLD', 'X:SILVER'], prefix: undefined }));

        const found = await registry.search({ query: 'gol' });
        assert.deepEqual(
            found.map((s) => s.symbol),
            ['X:GOLD'],
        );
    });

    it('hands the query to a source that searches for itself', async () => {
        registry.register(source({ searchSymbols: async ({ query }) => [info('X:' + query)] }));

        const found = await registry.search({ query: 'ANY' });
        assert.deepEqual(
            found.map((s) => s.symbol),
            ['X:ANY'],
        );
    });

    it('accepts a paged response as well as a bare array', async () => {
        registry.register(
            source({ searchSymbols: async () => ({ symbols: [info('X:ONE')], hasMore: true }) }),
        );

        const found = await registry.search({ query: '' });
        assert.deepEqual(
            found.map((s) => s.symbol),
            ['X:ONE'],
        );
    });

    it('survives a source that throws synchronously', async () => {
        registry.register(
            source({
                searchSymbols: () => {
                    throw new Error('rate limited');
                },
            }),
        );
        registry.register(source({ prefix: 'Y:', searchSymbols: async () => [info('Y:ONE')] }));

        const found = await registry.search({ query: '' });
        assert.deepEqual(
            found.map((s) => s.symbol),
            ['Y:ONE'],
        );
    });

    it('reports the longest debounce any source asks for', () => {
        assert.equal(registry.searchDebounceMs(), null);

        registry.register(source({ getCapabilities: () => ({ symbolSearch: 'server' }) }));
        assert.equal(registry.searchDebounceMs(), 200);

        registry.register(
            source({ prefix: 'Y:', getCapabilities: () => ({ symbolSearchDebounceMs: 500 }) }),
        );
        assert.equal(registry.searchDebounceMs(), 500);
    });
});

describe('the tick bridge', () => {
    const trade = { ts: 1_000_000_000n, price: 10, size: 1, side: 'B' as const };

    it('feeds trades to onTick and pushes what comes back', async () => {
        const pushed: number[] = [];
        registry.register(
            source({
                onTick: ({ trade: t }) => ({
                    events: [],
                    ohlcvBars: [
                        {
                            time: Number(t.ts / 1_000_000n),
                            open: t.price,
                            high: t.price,
                            low: t.price,
                            close: t.price,
                            volume: t.size,
                        },
                    ],
                    hasMore: true,
                }),
            }),
        );

        const adapter = registry.adapterFor('X:ONE')!;
        // the symbol and bar size come from the last fetch, so onTick knows what
        // it is building bars of
        await adapter.fetchBars(request('X:ONE'));
        adapter.subscribeRealtime!((bar) => pushed.push(bar.ohlcvBars![0].close));

        assert.equal(registry.handleTick(trade), true);
        assert.deepEqual(pushed, [10]);
    });

    it('goes quiet once the subscription is torn down', async () => {
        let pushes = 0;
        registry.register(
            source({ onTick: () => ({ events: [], ohlcvBars: [], hasMore: true }) }),
        );

        const adapter = registry.adapterFor('X:ONE')!;
        await adapter.fetchBars(request('X:ONE'));
        const unsub = adapter.subscribeRealtime!(() => pushes++);
        registry.handleTick(trade);
        unsub();
        registry.handleTick(trade);

        assert.equal(pushes, 1);
    });

    it('ignores a source that never fetched anything', () => {
        let called = false;
        registry.register(source({ onTick: () => ((called = true), null) }));
        registry.adapterFor('X:ONE')!.subscribeRealtime!(() => {});

        assert.equal(registry.handleTick(trade), false);
        assert.equal(called, false);
    });
});
