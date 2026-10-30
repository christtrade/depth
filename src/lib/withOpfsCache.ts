import type {
    BarResponse,
    EvictedBars,
    FetchRequest,
    IDataAdapter,
    OhlcvBar,
} from '../interfaces/IDataAdapter';

export interface OpfsCacheOptions {
    /** Cap on what the cache keeps on disk. Oldest chunks go first. Default 1 GB. */
    maxBytes?: number;
    /** Directory in the origin's private file system. Default `"depth-cache"`. */
    dir?: string;
}

/** An adapter wrapped by {@link withOpfsCache}. */
export type CachedAdapter = IDataAdapter & {
    /** Delete everything cached, say after the source corrected its history. */
    clearCache(): Promise<void>;
};

/**
 * Wrap an adapter so bars the chart evicts go to the browser's origin private
 * file system, and `fetchBars` answers from there when it can. Panning back
 * over history the chart dropped costs a disk read instead of the network.
 *
 * Only a request the cache covers end to end is served from it, everything
 * else goes to `adapter`. The adapter's own `onEvict` still gets called.
 * Without opfs the adapter comes back as is.
 */
export function withOpfsCache(adapter: IDataAdapter, opts: OpfsCacheOptions = {}): CachedAdapter {
    const root = (globalThis as any).navigator?.storage?.getDirectory;
    if (typeof root !== 'function') {
        return Object.assign(adapter, { clearCache: async () => {} });
    }
    return withBarCache(adapter, opfsStore(opts.dir ?? 'depth-cache'), opts.maxBytes ?? 2 ** 30);
}

export interface ChunkStore {
    /** Every chunk on disk, oldest first */
    list(): Promise<{ dir: string; name: string; bytes: number }[]>;
    write(dir: string, name: string, data: Float64Array): Promise<void>;
    read(dir: string, name: string): Promise<Float64Array>;
    remove(dir: string, name: string): Promise<void>;
    clear(): Promise<void>;
}

interface Chunk {
    dir: string;
    name: string;
    fromMs: number;
    /** Exclusive: the last bar's close. */
    toMs: number;
    cols: number;
    bytes: number;
    /** Held until the write lands, so a fetch right after the evict doesnt need to wait on it. */
    pending: Float64Array | null;
}

const COLS = ['time', 'open', 'high', 'low', 'close', 'volume'] as const;

export function withBarCache(adapter: IDataAdapter, store: ChunkStore, maxBytes: number): CachedAdapter {
    // by `symbol|barNs`, each sorted by fromMs
    const chunks = new Map<string, Chunk[]>();
    let order: Chunk[] = [];
    let total = 0;

    const ready = store
        .list()
        .then((files) => {
            for (const f of files) {
                const c = parseChunk(f.dir, f.name, f.bytes);
                if (c) add(c);
            }
        })
        .catch((err) => console.error('[withOpfsCache] reading the cache failed', err));

    function add(c: Chunk): void {
        const list = chunks.get(c.dir) ?? [];
        list.push(c);
        list.sort((a, b) => a.fromMs - b.fromMs);
        chunks.set(c.dir, list);
        order.push(c);
        total += c.bytes;
    }

    function drop(c: Chunk): void {
        const list = chunks.get(c.dir);
        if (list) chunks.set(c.dir, list.filter((x) => x !== c));
        order = order.filter((x) => x !== c);
        total -= c.bytes;
        store.remove(c.dir, c.name).catch(() => {});
    }

    function onEvict(e: EvictedBars): void {
        const bars = e.bars;
        if (bars.length === 0) return;
        const dir = `${encodeURIComponent(e.symbolInfo.symbol)}/${e.timeframe.barNs}`;
        const fromMs = e.range.fromMs;
        const toMs = e.range.toMs;
        const list = chunks.get(dir) ?? [];
        // came from the cache in the first place, or got evicted twice
        if (list.some((c) => c.fromMs <= fromMs && c.toMs >= toMs)) return;

        const bidAsk = bars.bid !== null;
        const cols = bidAsk ? 8 : 6;
        const n = bars.length;
        const data = new Float64Array(n * cols);
        COLS.forEach((col, k) => data.set(bars[col], k * n));
        if (bidAsk) {
            data.set(bars.bid!, 6 * n);
            data.set(bars.ask!, 7 * n);
        }

        const chunk: Chunk = {
            dir,
            name: `${fromMs}-${toMs}-${cols}.bin`,
            fromMs,
            toMs,
            cols,
            bytes: data.byteLength,
            pending: data,
        };
        add(chunk);
        store
            .write(dir, chunk.name, data)
            .then(() => {
                chunk.pending = null;
            })
            .catch((err) => {
                console.error('[withOpfsCache] write failed', err);
                drop(chunk);
            });
        while (total > maxBytes && order.length > 1) drop(order[0]);
    }

    async function fromCache(req: FetchRequest): Promise<OhlcvBar[] | null> {
        await ready;
        const dir = `${encodeURIComponent(req.symbolInfo.symbol)}/${req.timeframe.barNs}`;
        const { fromMs, toMs } = req.range;
        const hits = (chunks.get(dir) ?? []).filter((c) => c.toMs > fromMs && c.fromMs < toMs);

        // the hits have to cover fromMs, toMs with no gap. a forward page starts
        // at the open of the last bar the chart still holds, a bar before any cut
        let reached =
            req.direction === 'forward' ? fromMs + Number(req.timeframe.barNs / 1_000_000n) : fromMs;
        for (const c of hits) {
            if (c.fromMs > reached) return null;
            if (c.toMs > reached) reached = c.toMs;
        }
        if (reached < toMs) return null;

        const byTime = new Map<number, OhlcvBar>();
        for (const c of hits) {
            const data = c.pending ?? (await store.read(c.dir, c.name));
            const n = data.length / c.cols;
            for (let i = 0; i < n; i++) {
                const time = data[i];
                if (time < fromMs || time >= toMs) continue;
                const bar: OhlcvBar = {
                    time,
                    open: data[n + i],
                    high: data[2 * n + i],
                    low: data[3 * n + i],
                    close: data[4 * n + i],
                    volume: data[5 * n + i],
                };
                if (c.cols === 8) {
                    if (!Number.isNaN(data[6 * n + i])) bar.bid = data[6 * n + i];
                    if (!Number.isNaN(data[7 * n + i])) bar.ask = data[7 * n + i];
                }
                byTime.set(time, bar);
            }
        }
        return [...byTime.values()].sort((a, b) => a.time - b.time);
    }

    const cached: CachedAdapter = {
        resolveSymbol: (symbol) => adapter.resolveSymbol(symbol),
        searchSymbols: (request) => adapter.searchSymbols(request),

        async fetchBars(req: FetchRequest): Promise<BarResponse> {
            // supplemental bars aren't cached, so those go to the source whole
            if (req.supplementalBarNs === undefined) {
                try {
                    const bars = await fromCache(req);
                    // whether there's more past it is the source's call, on the next miss
                    if (bars) return { events: [], ohlcvBars: bars, hasMore: true };
                } catch (err) {
                    console.error('[withOpfsCache] read failed', err);
                }
            }
            return adapter.fetchBars(req);
        },

        onEvict(e: EvictedBars) {
            onEvict(e);
            return adapter.onEvict?.(e);
        },

        async clearCache() {
            await ready;
            chunks.clear();
            order = [];
            total = 0;
            await store.clear();
        },
    };

    if (adapter.fetchPreview) cached.fetchPreview = (r) => adapter.fetchPreview!(r);
    if (adapter.subscribeRealtime) {
        cached.subscribeRealtime = (r, onBar) => adapter.subscribeRealtime!(r, onBar);
    }
    if (adapter.connect) cached.connect = () => adapter.connect!();
    if (adapter.destroy) cached.destroy = () => adapter.destroy!();
    if (adapter.getCapabilities) cached.getCapabilities = () => adapter.getCapabilities!();
    return cached;
}

function parseChunk(dir: string, name: string, bytes: number): Chunk | null {
    const m = /^(-?\d+)-(-?\d+)-(6|8)\.bin$/.exec(name);
    if (!m) return null;
    return { dir, name, fromMs: +m[1], toMs: +m[2], cols: +m[3], bytes, pending: null };
}

function opfsStore(rootName: string): ChunkStore {
    const root = async () =>
        (await (navigator.storage.getDirectory() as Promise<FileSystemDirectoryHandle>)).getDirectoryHandle(
            rootName,
            { create: true },
        );

    const dirOf = async (path: string) => {
        let d = await root();
        for (const part of path.split('/')) d = await d.getDirectoryHandle(part, { create: true });
        return d;
    };

    return {
        async list() {
            const out: { dir: string; name: string; bytes: number; at: number }[] = [];
            const walk = async (d: FileSystemDirectoryHandle, path: string) => {
                for await (const [name, h] of (d as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
                    const sub = path ? `${path}/${name}` : name;
                    if (h.kind === 'directory') await walk(h as FileSystemDirectoryHandle, sub);
                    else {
                        const file = await (h as FileSystemFileHandle).getFile();
                        out.push({ dir: path, name, bytes: file.size, at: file.lastModified });
                    }
                }
            };
            await walk(await root(), '');
            return out.sort((a, b) => a.at - b.at);
        },
        async write(dir, name, data) {
            const handle = await (await dirOf(dir)).getFileHandle(name, { create: true });
            const w = await (handle as any).createWritable();
            await w.write(data);
            await w.close();
        },
        async read(dir, name) {
            const handle = await (await dirOf(dir)).getFileHandle(name);
            return new Float64Array(await (await handle.getFile()).arrayBuffer());
        },
        async remove(dir, name) {
            await (await dirOf(dir)).removeEntry(name);
        },
        async clear() {
            const top = await navigator.storage.getDirectory();
            await top.removeEntry(rootName, { recursive: true });
        },
    };
}
