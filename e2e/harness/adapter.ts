import type {
    BarResponse,
    FetchRequest,
    IDataAdapter,
    OhlcvBar,
    RealtimeRequest,
    SymbolInfo,
} from '@christtrade/depth';

const SEC_NS = 1_000_000_000n;
const SEC_MS = 1000;

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
    ) {
        if (live) this.subscribeRealtime = (req, onBar) => this.stream(req, onBar);
    }

    resolveSymbol(): SymbolInfo {
        return SYMBOL;
    }

    async searchSymbols(): Promise<SymbolInfo[]> {
        return [SYMBOL];
    }

    async fetchBars({ range, timeframe, direction }: FetchRequest): Promise<BarResponse> {
        const durMs = Number(timeframe.barNs / 1_000_000n);
        const end = this.endMs();
        const from = Math.max(this.startMs, Math.ceil(range.fromMs / durMs) * durMs);
        const to = Math.min(range.toMs, end);
        const bars: OhlcvBar[] = [];
        for (let t = from; t < to; t += durMs) bars.push(bar(t, durMs));
        const hasMore = direction === 'forward' ? range.toMs < end : range.fromMs > this.startMs;
        return { events: [], ohlcvBars: bars, hasMore };
    }

    private stream(req: RealtimeRequest, onBar: (bar: BarResponse) => void): () => void {
        const durMs = Number(req.timeframe.barNs / 1_000_000n);
        let next = Number(req.since / 1_000_000n);
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
