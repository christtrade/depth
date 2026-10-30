import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BarStore } from '../core/BarStore';
import {
    makeTimeRange,
    type EvictedBars,
    type FetchRequest,
    type IDataAdapter,
    type OhlcvBar,
    type SymbolInfo,
} from '../interfaces/IDataAdapter';
import { withBarCache, withOpfsCache, type ChunkStore } from './withOpfsCache';

const MIN_MS = 60_000;
const MIN = 60_000_000_000n;
const T = Date.UTC(2026, 0, 1);
const info: SymbolInfo = {
    symbol: 'NQ',
    type: 'stock',
    dataLevel: 'ohlcv',
    priceFormat: { minTick: 0.25, precision: 2 },
};
const tf = { label: '1m', barNs: MIN } as never;

function bars(fromMs: number, n: number): OhlcvBar[] {
    return Array.from({ length: n }, (_, i) => ({
        time: fromMs + i * MIN_MS,
        open: i,
        high: i + 1,
        low: i - 1,
        close: i + 0.5,
        volume: 10,
    }));
}

function evicted(fromMs: number, n: number): EvictedBars {
    return {
        symbolInfo: info,
        timeframe: tf,
        range: makeTimeRange(BigInt(fromMs) * 1_000_000n, BigInt(fromMs + n * MIN_MS) * 1_000_000n),
        bars: BarStore.from(bars(fromMs, n)),
    };
}

function request(fromMs: number, toMs: number, direction: FetchRequest['direction'] = 'backward'): FetchRequest {
    return {
        symbolInfo: info,
        timeframe: tf,
        range: makeTimeRange(BigInt(fromMs) * 1_000_000n, BigInt(toMs) * 1_000_000n),
        direction,
    } as FetchRequest;
}

function memStore(opts: { holdWrites?: boolean } = {}) {
    const files = new Map<string, Float64Array>();
    const held: (() => void)[] = [];
    const store: ChunkStore = {
        list: async () =>
            [...files].map(([key, data]) => {
                const [dir, name] = key.split('|');
                return { dir, name, bytes: data.byteLength };
            }),
        write: (dir, name, data) =>
            new Promise((resolve) => {
                const land = () => {
                    files.set(`${dir}|${name}`, data.slice());
                    resolve();
                };
                if (opts.holdWrites) held.push(land);
                else land();
            }),
        read: async (dir, name) => files.get(`${dir}|${name}`)!,
        remove: async (dir, name) => void files.delete(`${dir}|${name}`),
        clear: async () => files.clear(),
    };
    return { store, files, land: () => held.splice(0).forEach((f) => f()) };
}

function source() {
    const fetches: FetchRequest[] = [];
    const evictions: EvictedBars[] = [];
    const adapter = {
        resolveSymbol: () => info,
        searchSymbols: async () => [info],
        fetchBars: async (req: FetchRequest) => {
            fetches.push(req);
            return { events: [], ohlcvBars: bars(req.range.fromMs, 3), hasMore: false };
        },
        onEvict: (e: EvictedBars) => void evictions.push(e),
    } as unknown as IDataAdapter;
    return { adapter, fetches, evictions };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('withOpfsCache', () => {
    it('serves a page it holds without asking the source', async () => {
        const { adapter, fetches } = source();
        const cached = withBarCache(adapter, memStore().store, Infinity);
        cached.onEvict!(evicted(T, 100));
        await settle();

        const res = await cached.fetchBars(request(T + 10 * MIN_MS, T + 100 * MIN_MS));
        assert.equal(fetches.length, 0);
        assert.equal(res.hasMore, true, 'whether there is more is the source to say');
        assert.deepEqual(res.ohlcvBars, bars(T, 100).slice(10));
    });

    it('asks the source when the cache only covers part of it', async () => {
        const { adapter, fetches } = source();
        const cached = withBarCache(adapter, memStore().store, Infinity);
        cached.onEvict!(evicted(T, 100));
        await settle();

        await cached.fetchBars(request(T - 10 * MIN_MS, T + 50 * MIN_MS));
        assert.equal(fetches.length, 1);
    });

    it('serves a forward page from the last held bar on', async () => {
        const { adapter, fetches } = source();
        const cached = withBarCache(adapter, memStore().store, Infinity);
        cached.onEvict!(evicted(T, 100));
        await settle();

        const res = await cached.fetchBars(request(T - MIN_MS, T + 100 * MIN_MS, 'forward'));
        assert.equal(fetches.length, 0);
        assert.equal(res.ohlcvBars!.length, 100);
    });

    it('answers from memory while the write is still out', async () => {
        const { adapter, fetches } = source();
        const mem = memStore({ holdWrites: true });
        const cached = withBarCache(adapter, mem.store, Infinity);
        cached.onEvict!(evicted(T, 100));

        const res = await cached.fetchBars(request(T, T + 100 * MIN_MS));
        assert.equal(fetches.length, 0);
        assert.equal(res.ohlcvBars!.length, 100);
        assert.equal(mem.files.size, 0, 'not on disk yet');
        mem.land();
    });

    it('finds what an earlier session cached', async () => {
        const mem = memStore();
        withBarCache(source().adapter, mem.store, Infinity).onEvict!(evicted(T, 100));
        await settle();

        const { adapter, fetches } = source();
        const res = await withBarCache(adapter, mem.store, Infinity).fetchBars(request(T, T + 100 * MIN_MS));
        assert.equal(fetches.length, 0);
        assert.deepEqual(res.ohlcvBars, bars(T, 100));
    });

    it('drops the oldest chunk past maxBytes', async () => {
        const mem = memStore();
        // 100 bars x 6 columns x 8 bytes
        const cached = withBarCache(source().adapter, mem.store, 4800 * 1.5);
        cached.onEvict!(evicted(T, 100));
        cached.onEvict!(evicted(T + 1000 * MIN_MS, 100));
        await settle();
        assert.equal(mem.files.size, 1);
        assert.ok([...mem.files.keys()][0].includes(`${T + 1000 * MIN_MS}-`));
    });

    it('still hands evictions to the source, and sends supplemental requests through', async () => {
        const { adapter, fetches, evictions } = source();
        const cached = withBarCache(adapter, memStore().store, Infinity);
        cached.onEvict!(evicted(T, 100));
        await settle();
        assert.equal(evictions.length, 1);

        await cached.fetchBars({ ...request(T, T + 100 * MIN_MS), supplementalBarNs: 1_000_000_000n });
        assert.equal(fetches.length, 1);
    });

    it('hands the adapter back without OPFS', () => {
        const { adapter } = source();
        assert.equal(withOpfsCache(adapter), adapter);
    });
});
