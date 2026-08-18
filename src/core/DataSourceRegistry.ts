// lets extension plugins serve symbols the chart treats exactly like real
// instruments - a derived one like "SPREAD:ES-NQ", or a whole venue behind the
// user's own API key.
//
// a source is an IDataAdapter with a claim on some symbols, and thats the whole
// point: DataEngine routes every fetch for a claimed symbol to the source
// instead of the host adapter, so a plugin symbol gets the same windowed loads,
// prefetch, jump-loads, refinement and playback a built-in one does.

import type { SerialTrade } from '../lib/types';
import type {
    AdapterCapabilities,
    BarPreviewResponse,
    BarResponse,
    FetchRequest,
    IDataAdapter,
    SymbolInfo,
    SymbolSearchRequest,
    SymbolSearchResponse,
} from '../interfaces/IDataAdapter';
import { searchSymbolsLocally } from '../lib/symbol-search';

/**
 * A data source registered by a plugin. Everything an {@link IDataAdapter} can
 * do, plus a claim on the symbols it serves - declare `symbols` when you can
 * list them, or `prefix` for a namespace.
 *
 * Only `fetchBars` is required. The rest have sensible fallbacks, though a
 * source without `resolveSymbol` is priced as a 24/7 two-decimal instrument.
 */
export interface PluginDataSource {
    /**
     * Exact symbols this source owns. Prefix convention: `"TYPE:DETAILS"`.
     */
    symbols?: string[];

    /**
     * Or claim a namespace: every symbol starting with this belongs to the
     * source, which is what a whole venue behind an API key wants. `''` claims
     * everything the adapter didn't. The longest matching prefix wins, so a
     * specific one still beats a catch-all.
     */
    prefix?: string;

    /**
     * Tick size, price format, session, contract details. Without one the chart
     * falls back to a 24/7 crypto-ish default, which is rarely what you want -
     * order sizing and price formatting both read this.
     */
    resolveSymbol?(symbol: string): SymbolInfo | Promise<SymbolInfo>;

    /**
     * Answer the symbol picker. Results are merged in front of the adapter's
     * own. Return a {@link SymbolSearchResponse} to page results yourself.
     * Without this, `symbols` is matched locally instead.
     */
    searchSymbols?(
        request: SymbolSearchRequest,
    ): SymbolInfo[] | SymbolSearchResponse | Promise<SymbolInfo[] | SymbolSearchResponse>;

    /**
     * Return the bars covering `request.range`. Called for the initial window,
     * for backward pans, for forward prefetch during playback, and again at a
     * finer resolution when a pane needs one - `request.direction` says which.
     */
    fetchBars(request: FetchRequest): Promise<BarResponse>;

    /**
     * Cheap bars for the loading skeleton, drawn before `fetchBars` resolves.
     * Skip it and the chart just waits.
     */
    fetchPreview?(request: FetchRequest): Promise<BarPreviewResponse>;

    /**
     * Push live bars as they arrive - a websocket, a poll, anything. Return the
     * teardown.
     */
    subscribeRealtime?(onBar: (bar: BarResponse) => void): () => void;

    /**
     * A trade arrived on the host adapter's feed. Return bars to append, or
     * null to ignore it. This is the hook for a derived instrument, which has
     * no feed of its own to subscribe to.
     */
    onTick?(params: { symbol: string; trade: SerialTrade; barNs: bigint }): BarResponse | null;

    /**
     * Declare supplemental resolutions and how symbol search is filtered. See
     * {@link AdapterCapabilities}.
     */
    getCapabilities?(): AdapterCapabilities;

    /** Called before the first fetch. Open a socket, refresh a token. */
    connect?(): Promise<void>;

    /** Called when the plugin unregisters the source. */
    destroy?(): void;
}

// a source that doesnt resolve its own symbols still has to give the chart
// something, or price formatting and order sizing run on whatever the last
// symbol left behind
function fallbackSymbolInfo(symbol: string): SymbolInfo {
    return {
        symbol,
        description: symbol,
        type: 'crypto',
        dataLevel: 'ohlcv',
        priceFormat: { minTick: 0.01, precision: 2 },
    };
}

function toSymbolList(result: SymbolInfo[] | SymbolSearchResponse): SymbolInfo[] {
    return Array.isArray(result) ? result : result.symbols;
}

// keystroke debounce for a source that declares server-side search without
// saying how long to wait. same default DataEngine uses for the host adapter
const DEFAULT_SOURCE_SEARCH_DEBOUNCE_MS = 200;

export class DataSourceRegistry {
    private readonly bySymbol = new Map<string, PluginDataSource>();
    private readonly byPrefix: Array<{ prefix: string; source: PluginDataSource }> = [];
    private readonly resolved = new Map<string, SymbolInfo>();
    // one facade per source, kept so an unsubscribe handed out earlier still
    // matches the subscription it came from
    private readonly adapters = new Map<PluginDataSource, IDataAdapter>();
    // last symbol and bar size each source was asked for, so onTick knows what
    // it is building bars of
    private readonly lastRequest = new Map<PluginDataSource, { symbol: string; barNs: bigint }>();
    private readonly realtimeSinks = new Map<PluginDataSource, (bar: BarResponse) => void>();

    register(source: PluginDataSource): () => void {
        for (const sym of source.symbols ?? []) {
            if (this.bySymbol.has(sym)) {
                console.warn(`[DataSourceRegistry] '${sym}' already registered - overwriting`);
            }
            this.bySymbol.set(sym, source);
        }
        if (source.prefix !== undefined) {
            this.byPrefix.push({ prefix: source.prefix, source });
            // longest first, so a specific namespace still beats a catch-all
            this.byPrefix.sort((a, b) => b.prefix.length - a.prefix.length);
        }
        if (!source.symbols?.length && source.prefix === undefined) {
            console.warn('[DataSourceRegistry] source registered with no symbols and no prefix');
        }

        return () => {
            for (const sym of source.symbols ?? []) {
                if (this.bySymbol.get(sym) === source) this.bySymbol.delete(sym);
            }
            for (let i = this.byPrefix.length - 1; i >= 0; i--) {
                if (this.byPrefix[i].source === source) this.byPrefix.splice(i, 1);
            }
            this.adapters.delete(source);
            this.lastRequest.delete(source);
            this.realtimeSinks.delete(source);
            try {
                source.destroy?.();
            } catch (err) {
                console.error('[DataSourceRegistry] destroy threw:', err);
            }
            // cheap to rebuild, and working out which entries were this source's
            // after it has already been unhooked isnt worth the bookkeeping
            this.resolved.clear();
        };
    }

    sourceFor(symbol: string): PluginDataSource | undefined {
        const exact = this.bySymbol.get(symbol);
        if (exact) return exact;
        return this.byPrefix.find((p) => symbol.startsWith(p.prefix))?.source;
    }

    has(symbol: string): boolean {
        return this.sourceFor(symbol) !== undefined;
    }

    /** The adapter DataEngine should fetch this symbol through, if any. */
    adapterFor(symbol: string): IDataAdapter | null {
        const source = this.sourceFor(symbol);
        return source ? this.adapterOf(source) : null;
    }

    /** The last SymbolInfo handed out for a symbol, if it has been resolved. */
    getResolved(symbol: string): SymbolInfo | null {
        return this.resolved.get(symbol) ?? null;
    }

    async resolve(symbol: string): Promise<SymbolInfo | null> {
        const source = this.sourceFor(symbol);
        if (!source) return null;
        return this.adapterOf(source).resolveSymbol(symbol);
    }

    /**
     * Every registered symbol matching a picker query. Sources with their own
     * searchSymbols answer it; the rest have their `symbols` matched here.
     */
    async search(request: SymbolSearchRequest): Promise<SymbolInfo[]> {
        const results = await Promise.all(
            this.sources().map(async (source) => {
                // the try has to wrap the call itself - a synchronous throw
                // never reaches a .catch on the promise it didnt return
                try {
                    return toSymbolList(await this.adapterOf(source).searchSymbols(request));
                } catch (err) {
                    console.error('[DataSourceRegistry] searchSymbols threw:', err);
                    return [];
                }
            }),
        );
        return results.flat();
    }

    /**
     * Longest debounce any registered source wants, or null when none care.
     * A network search behind someone's rate-limited API key shouldnt fire per
     * keystroke just because the host adapter matches in memory.
     */
    searchDebounceMs(): number | null {
        let longest: number | null = null;
        for (const source of this.sources()) {
            const caps = this.capsOf(source);
            const declared =
                typeof caps?.symbolSearchDebounceMs === 'number' && caps.symbolSearchDebounceMs >= 0
                    ? caps.symbolSearchDebounceMs
                    : caps?.symbolSearch === 'server'
                      ? DEFAULT_SOURCE_SEARCH_DEBOUNCE_MS
                      : null;
            if (declared !== null && (longest === null || declared > longest)) longest = declared;
        }
        return longest;
    }

    /**
     * Feed a trade from the host adapter to every source building bars off it.
     * Returns true if any of them produced something.
     */
    handleTick(trade: SerialTrade): boolean {
        let handled = false;
        for (const [source, sink] of this.realtimeSinks) {
            if (!source.onTick) continue;
            const last = this.lastRequest.get(source);
            if (!last) continue;

            let bar: BarResponse | null;
            try {
                bar = source.onTick({ symbol: last.symbol, trade, barNs: last.barNs });
            } catch (err) {
                console.error('[DataSourceRegistry] onTick threw:', err);
                continue;
            }
            if (!bar) continue;
            sink(bar);
            handled = true;
        }
        return handled;
    }

    destroy(): void {
        for (const source of this.sources()) {
            try {
                source.destroy?.();
            } catch (err) {
                console.error('[DataSourceRegistry] destroy threw:', err);
            }
        }
        this.bySymbol.clear();
        this.byPrefix.length = 0;
        this.resolved.clear();
        this.adapters.clear();
        this.lastRequest.clear();
        this.realtimeSinks.clear();
    }

    // registered sources, each once - a source can claim both a prefix and
    // exact symbols
    private sources(): PluginDataSource[] {
        const seen = new Set<PluginDataSource>();
        for (const source of this.bySymbol.values()) seen.add(source);
        for (const { source } of this.byPrefix) seen.add(source);
        return [...seen];
    }

    private capsOf(source: PluginDataSource): AdapterCapabilities | null {
        try {
            return source.getCapabilities?.() ?? null;
        } catch (err) {
            console.error('[DataSourceRegistry] getCapabilities threw:', err);
            return null;
        }
    }

    // wraps a source as a real adapter: fills in the optional halves of
    // IDataAdapter and remembers what was asked for so onTick has a symbol.
    // optional methods stay undefined when the source doesnt define them -
    // DataEngine feature-detects them rather than calling and catching
    private adapterOf(source: PluginDataSource): IDataAdapter {
        const existing = this.adapters.get(source);
        if (existing) return existing;

        const adapter: IDataAdapter = {
            resolveSymbol: async (symbol) => {
                const cached = this.resolved.get(symbol);
                if (cached) return cached;

                let info: SymbolInfo;
                try {
                    info = source.resolveSymbol
                        ? await source.resolveSymbol(symbol)
                        : fallbackSymbolInfo(symbol);
                } catch (err) {
                    console.error(`[DataSourceRegistry] resolveSymbol('${symbol}') threw:`, err);
                    info = fallbackSymbolInfo(symbol);
                }
                this.resolved.set(symbol, info);
                return info;
            },

            searchSymbols: async (request) => {
                if (source.searchSymbols) return source.searchSymbols(request);
                // no search of its own, so match the symbols it listed. resolved
                // info when we have it, a placeholder when we dont
                const listed = (source.symbols ?? []).map(
                    (sym) => this.resolved.get(sym) ?? fallbackSymbolInfo(sym),
                );
                return searchSymbolsLocally(listed, request);
            },

            fetchBars: (request) => {
                this.lastRequest.set(source, {
                    symbol: request.symbolInfo.symbol,
                    barNs: request.timeframe.barNs,
                });
                return source.fetchBars(request);
            },
        };

        if (source.fetchPreview) adapter.fetchPreview = (r) => source.fetchPreview!(r);
        if (source.getCapabilities) adapter.getCapabilities = () => this.capsOf(source) ?? {};
        if (source.connect) adapter.connect = () => source.connect!();

        // one sink per source covers both feeds: its own subscription and the
        // onTick bridge, which has no socket to unsubscribe from
        if (source.subscribeRealtime || source.onTick) {
            adapter.subscribeRealtime = (onBar) => {
                this.realtimeSinks.set(source, onBar);
                const unsub = source.subscribeRealtime?.(onBar);
                return () => {
                    if (this.realtimeSinks.get(source) === onBar) {
                        this.realtimeSinks.delete(source);
                    }
                    unsub?.();
                };
            };
        }

        this.adapters.set(source, adapter);
        return adapter;
    }
}
