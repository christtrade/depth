import {
    DataAdapterError,
    type BarResponse,
    type DataAdapterErrorCode,
    type FetchRequest,
    type IDataAdapter,
    type OhlcvBar,
    type RealtimeRequest,
    type SymbolInfo,
} from '@christtrade/depth';
import { simL2Snapshots, simMboEvents, simTicks } from '../../src/lib/sim-levels';

type Level = 'ohlcv' | 'tick' | 'l2' | 'l3';

// what the adapter does wrong, changeable whlile the page runs
export interface Faults {
    down: boolean;
    failRate: number;
    slowMs: number;
    code: DataAdapterErrorCode;
}

const SEC_NS = 1_000_000_000n;
const SEC_MS = 1000;
const L3_PAGE_MS = 30 * 60_000;

const SYMBOL: SymbolInfo = {
    symbol: 'HARNESS',
    type: 'crypto',
    dataLevel: 'ohlcv',
    priceFormat: { minTick: 0.01, precision: 2 },
    supportedResolutions: [SEC_NS, 60n * SEC_NS, 3600n * SEC_NS],
};

// price as a pure function of time, so every resolution and every refetch agrees
function noise(sec: number): number {
    let x = Math.imul(sec | 0, 0x9e3779b1) ^ (sec / 4294967296);
    x = Math.imul(x ^ (x >>> 15), 0x85ebca6b);
    x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
    return ((x ^ (x >>> 16)) >>> 0) / 4294967296 - 0.5;
}

function price(ms: number): number {
    const sec = Math.floor(ms / SEC_MS);
    return 100 + 10 * Math.sin(ms / 3.6e7) + 3 * Math.sin(ms / 2.7e6) + noise(sec);
}

function bar(time: number, durMs: number): OhlcvBar {
    const open = price(time);
    const close = price(time + durMs - SEC_MS);
    let high = Math.max(open, close);
    let low = Math.min(open, close);
    const step = Math.max(SEC_MS, Math.floor(durMs / 16));
    for (let t = time; t < time + durMs; t += step) {
        const p = price(t);
        if (p > high) high = p;
        if (p < low) low = p;
    }
    return { time, open, high, low, close, volume: 1 + Math.abs(noise(time / SEC_MS + 7)) * 10 };
}

export class HarnessAdapter implements IDataAdapter {
    subscribeRealtime?: IDataAdapter['subscribeRealtime'];

    constructor(
        // no bars b4 this
        private readonly startMs: number,
        // the live edge. now when live, a fixed tiem otherwise
        private readonly endMs: () => number,
        live: boolean,
        readonly faults: Faults = { down: false, failRate: 0, slowMs: 0, code: 'network_error' },
        private readonly level: Level = 'ohlcv',
        private readonly l2Trades = true,
    ) {
        if (live) this.subscribeRealtime = (req, onBar) => this.stream(req, onBar);
    }

    private levelOf(symbol: string): Level {
        const s = symbol.split('-')[1]?.toLowerCase();
        return s === 'l3' || s === 'l2' || s === 'tick' || s === 'ohlcv' ? s : this.level;
    }

    private events(level: string, from: number, to: number): BarResponse {
        const o = { slotMs: 250 };
        if (level === 'tick') return { events: [], ticks: simTicks(price, from, to, o), hasMore: false };
        if (level === 'l2')
            return {
                events: [],
                l2Snapshots: simL2Snapshots(price, from, to, o),
                ...(this.l2Trades && { ticks: simTicks(price, from, to, o) }),
                hasMore: false,
            };
        return { events: simMboEvents(price, from, to, o), hasMore: false };
    }

    resolveSymbol(symbol = SYMBOL.symbol): SymbolInfo {
        return { ...SYMBOL, symbol, dataLevel: this.levelOf(symbol) };
    }

    async searchSymbols(): Promise<SymbolInfo[]> {
        return [this.resolveSymbol()];
    }

    async fetchBars({ symbolInfo, range, timeframe, direction }: FetchRequest): Promise<BarResponse> {
        const level = this.levelOf(symbolInfo.symbol);
        const f = this.faults;
        if (f.slowMs) await new Promise((r) => setTimeout(r, f.slowMs * (0.5 + Math.random())));
        if (f.down || Math.random() < f.failRate) {
            throw new DataAdapterError(f.code, `harness: ${direction} fetch failed on purpose`);
        }
        const end = this.endMs();
        if (level !== 'ohlcv') {
            // at most half an hour a fetch, a day of l3 is millions of events
            const to = Math.min(range.toMs, end);
            const from = Math.max(this.startMs, range.fromMs, to - L3_PAGE_MS);
            const hasMore = direction === 'forward' ? range.toMs < end : from > this.startMs;
            return { ...this.events(level, from, to), hasMore };
        }
        const durMs = Number(timeframe.barNs / 1_000_000n);
        const from = Math.max(this.startMs, Math.ceil(range.fromMs / durMs) * durMs);
        const to = Math.min(range.toMs, end);
        const bars: OhlcvBar[] = [];
        for (let t = from; t < to; t += durMs) bars.push(bar(t, durMs));
        const hasMore = direction === 'forward' ? range.toMs < end : range.fromMs > this.startMs;
        return { events: [], ohlcvBars: bars, hasMore };
    }

    private stream(req: RealtimeRequest, onBar: (bar: BarResponse) => void): () => void {
        let next = Number(req.since / 1_000_000n);
        const level = this.levelOf(req.symbolInfo.symbol);
        if (level !== 'ohlcv') {
            const id = setInterval(() => {
                const now = Date.now();
                const chunk = this.events(level, next, now);
                next = now;
                if (chunk.events.length || chunk.ticks?.length || chunk.l2Snapshots?.length) onBar(chunk);
            }, 250);
            return () => clearInterval(id);
        }
        const durMs = Number(req.timeframe.barNs / 1_000_000n);
        const id = setInterval(() => {
            const now = Date.now();
            const bars: OhlcvBar[] = [];
            for (let t = next; t <= now; t += durMs) bars.push(bar(t, durMs));
            if (bars.length > 1) next = bars[bars.length - 1].time;
            if (bars.length) onBar({ events: [], ohlcvBars: bars, hasMore: false });
        }, 250);
        return () => clearInterval(id);
    }
}
