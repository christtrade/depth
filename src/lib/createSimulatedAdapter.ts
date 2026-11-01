// Realistic simulated market data adapter.
//
// Model:
//   - Regime-switching Markov chain: TRENDING | MEAN_REVERTING | VOLATILE
//   - Per-regime GBM drift + Ornstein-Uhlenbeck mean reversion
//   - GARCH(1,1) conditional variance - vol clusters across bars
//   - Intra-bar tick simulation for realistic H/L construction
//   - Student-t innovations (df=5) for fat tails in VOLATILE regime
//
// Usage:
//   const adapter = createSimulatedAdapter();                    // defaults
//   const adapter = createSimulatedAdapter({ seed: 42, startPrice: 50000 });
//   const adapter = createSimulatedAdapter({ realtime: true });  // live feed up to now

import type {
    IDataAdapter,
    FetchRequest,
    BarResponse,
    SymbolInfo,
    OhlcvBar,
    RealtimeRequest,
} from '../interfaces/IDataAdapter';
import { simMboEvents, simTicks } from './sim-levels';

// -
// Config
// -
export interface SimulatedAdapterConfig {
    /** Reproducible seed. Omit for random. */
    seed?: number;
    /** Starting mid-price. Default 21000. */
    startPrice?: number;
    /** Bar duration in nanoseconds. Default 60_000_000_000n (1 min). */
    barDurationNs?: bigint;
    /** Number of intra-bar ticks used to construct H/L. Default 20. */
    intrabbarTicks?: number;
    /** Tick size for price rounding. Default 0.25. */
    tickSize?: number;
    /** Override regime parameters if you want to tune the sim. */
    regimes?: Partial<Record<Regime, Partial<RegimeParams>>>;
    /**
     * Run as a live feed: one price path from `historyBars` back up to now, with the
     * forming bar streamed through `subscribeRealtime`. Nothing past now is served,
     * and every fetch reads the same path. Bars come at `barDurationNs` only - the
     * chart aggregates coarser timeframes. Default false.
     */
    realtime?: boolean;
    /** Realtime only: ms between updates. Default 250. */
    realtimeUpdateMs?: number;
    /** Realtime only: bars of history before the first fetch's now. Default 10_000. */
    historyBars?: number;
    /**
     * tick serves trades along the same price path, l3 mbo events with those same trades in
     * them, both at `tickSize`. The path runs up to now, same as `realtime`, and `realtime`
     * decides whether it keeps streaming. A fetch is at most 30 minutes. Default `'ohlcv'`
     */
    dataLevel?: 'ohlcv' | 'tick' | 'l3';
}

// -
// Regime definitions
// -
type Regime = 'TRENDING' | 'MEAN_REVERTING' | 'VOLATILE';

interface RegimeParams {
    /** Annualised drift (log-return). Positive = uptrend. */
    drift: number;
    /** Baseline annualised volatility (used as GARCH long-run vol). */
    baseVol: number;
    /** OU mean-reversion speed (0 = pure GBM, higher = stronger pull). */
    ouSpeed: number;
    /** GARCH alpha (shock persistence weight). */
    garchAlpha: number;
    /** GARCH beta (variance persistence weight). alpha+beta < 1 for stationarity. */
    garchBeta: number;
    /** Student-t degrees of freedom for innovations (Infinity = Gaussian). */
    tDof: number;
    /** Average bars before regime transitions (geometric dist). */
    avgDuration: number;
}

const DEFAULT_REGIMES: Record<Regime, RegimeParams> = {
    TRENDING: {
        drift: 0.6, // ~60% annualised trend
        baseVol: 0.18,
        ouSpeed: 0.0,
        garchAlpha: 0.08,
        garchBeta: 0.88,
        tDof: Infinity,
        avgDuration: 120, // ~2 hours of 1-min bars
    },
    MEAN_REVERTING: {
        drift: 0.0,
        baseVol: 0.12,
        ouSpeed: 0.04, // gentle pull back to rolling mean
        garchAlpha: 0.06,
        garchBeta: 0.9,
        tDof: Infinity,
        avgDuration: 200,
    },
    VOLATILE: {
        drift: 0.0,
        baseVol: 0.55, // high base vol
        ouSpeed: 0.0,
        garchAlpha: 0.15,
        garchBeta: 0.8,
        tDof: 5, // fat tails
        avgDuration: 40, // short-lived chaos
    },
};

// Transition matrix: given current regime, probability of switching to each.
// Rows: FROM, Cols: [TRENDING, MEAN_REVERTING, VOLATILE]
const TRANSITION_MATRIX: Record<Regime, Record<Regime, number>> = {
    TRENDING: { TRENDING: 0.7, MEAN_REVERTING: 0.2, VOLATILE: 0.1 },
    MEAN_REVERTING: { TRENDING: 0.25, MEAN_REVERTING: 0.6, VOLATILE: 0.15 },
    VOLATILE: { TRENDING: 0.3, MEAN_REVERTING: 0.4, VOLATILE: 0.3 },
};

const REGIME_KEYS: Regime[] = ['TRENDING', 'MEAN_REVERTING', 'VOLATILE'];

// -
// Seeded PRNG (Mulberry32 - fast, good distribution)
// -
function mulberry32(seed: number) {
    let s = seed;
    return () => {
        s |= 0;
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Box-Muller. Returns standard normal.
function boxMuller(rand: () => number): number {
    const u1 = Math.max(rand(), 1e-10);
    const u2 = rand();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// Student-t via ratio of normals and chi-squared. dof=Infinity falls back to normal.
function studentT(rand: () => number, dof: number): number {
    if (!isFinite(dof)) return boxMuller(rand);
    const z = boxMuller(rand);
    // chi-squared(dof) via sum of squared normals (approximation for dof >= 2)
    let chi2 = 0;
    const k = Math.max(2, Math.round(dof));
    for (let i = 0; i < k; i++) {
        const n = boxMuller(rand);
        chi2 += n * n;
    }
    return z / Math.sqrt(chi2 / k);
}

// -
// Core simulator
// -
interface SimState {
    price: number;
    /** Current GARCH conditional variance (annualised^2). */
    garchVar: number;
    regime: Regime;
    /** Bars remaining in current regime. */
    regimeBarsLeft: number;
    /** Rolling mean price for OU mean-reversion reference. */
    ouMean: number;
}

function pickNextRegime(current: Regime, rand: () => number): Regime {
    const probs = TRANSITION_MATRIX[current];
    let r = rand();
    for (const regime of REGIME_KEYS) {
        r -= probs[regime];
        if (r <= 0) return regime;
    }
    return 'MEAN_REVERTING';
}

function regimeDuration(params: RegimeParams, rand: () => number): number {
    // Geometric distribution: mean = avgDuration
    return Math.max(1, Math.round(-params.avgDuration * Math.log(Math.max(rand(), 1e-10))));
}

// A bar mid-simulation. `frac` is how much of it has run, so a live bar can stop at "now"
interface FormingBar {
    time: number;
    params: RegimeParams;
    dt: number;
    garchVar: number;
    /** Per-bar log drift, applied pro rata to each step. */
    drift: number;
    open: number;
    high: number;
    low: number;
    price: number;
    /** The whole bar's volume - a forming bar shows its share. */
    volume: number;
    frac: number;
}

function initState(params: RegimeParams, startPrice: number, rand: () => number): SimState {
    return {
        price: startPrice,
        garchVar: params.baseVol ** 2,
        regime: 'MEAN_REVERTING',
        regimeBarsLeft: regimeDuration(params, rand),
        ouMean: startPrice,
    };
}

function openBar(
    state: SimState,
    regimes: Record<Regime, RegimeParams>,
    barsPerYear: number,
    rand: () => number,
    time: number,
): FormingBar {
    state.regimeBarsLeft--;
    if (state.regimeBarsLeft <= 0) {
        state.regime = pickNextRegime(state.regime, rand);
        state.regimeBarsLeft = regimeDuration(regimes[state.regime], rand);
    }
    const params = regimes[state.regime];
    const dt = 1 / barsPerYear;
    const sqrtDt = Math.sqrt(dt);

    // GARCH(1,1): update conditional variance
    // σ²_t = ω + α-ε²_{t-1} + β-σ²_{t-1}
    // ω = (1 - α - β) - σ²_longrun
    const longRunVar = params.baseVol ** 2;
    const omega = (1 - params.garchAlpha - params.garchBeta) * longRunVar;
    // We track garchVar as annualised; the last shock is implicit - resample here
    const lastShock = studentT(rand, params.tDof) * Math.sqrt(state.garchVar * dt);
    const newVar = Math.max(
        omega + params.garchAlpha * (lastShock / sqrtDt) ** 2 + params.garchBeta * state.garchVar,
        1e-8,
    );
    state.garchVar = newVar;

    const p = state.price;
    // gbm drift + the ou pull toward oumean
    const drift =
        (params.drift - 0.5 * newVar) * dt +
        params.ouSpeed * (Math.log(state.ouMean) - Math.log(p)) * dt;

    return {
        time,
        params,
        dt,
        garchVar: newVar,
        drift,
        open: p,
        high: p,
        low: p,
        price: p,
        // per minute so a 1s bar isnt as heavy as a 1m one
        volume: (500 + rand() * 4500 + (newVar / longRunVar) * 2000) * ((252 * 390) / barsPerYear),
        frac: 0,
    };
}

// steps of at most 1/intrabarticks of a bar
function advanceBar(
    b: FormingBar,
    toFrac: number,
    intrabarTicks: number,
    rand: () => number,
    onStep?: (frac: number, price: number) => void,
) {
    if (toFrac <= b.frac) return;
    const steps = Math.max(1, Math.ceil((toFrac - b.frac) * intrabarTicks - 1e-9));
    const f = (toFrac - b.frac) / steps;
    const sd = Math.sqrt(b.garchVar * b.dt * f);
    for (let t = 0; t < steps; t++) {
        b.price *= Math.exp(b.drift * f + studentT(rand, b.params.tDof) * sd);
        if (b.price > b.high) b.high = b.price;
        if (b.price < b.low) b.low = b.price;
        onStep?.(t === steps - 1 ? toFrac : b.frac + f * (t + 1), b.price);
    }
    b.frac = toFrac;
}

const PATH_PAGE_MS = 30 * 60_000;

class RecordedPath {
    private readonly t: number[] = [];
    private readonly p: number[] = [];

    add(ms: number, price: number) {
        if (this.t.length && ms <= this.t[this.t.length - 1]) return;
        this.t.push(ms);
        this.p.push(price);
    }

    get start(): number {
        return this.t[0] ?? 0;
    }

    at = (ms: number): number => {
        const { t, p } = this;
        if (!t.length) return 0;
        if (ms <= t[0]) return p[0];
        if (ms >= t[t.length - 1]) return p[p.length - 1];
        let lo = 0,
            hi = t.length - 1;
        while (hi - lo > 1) {
            const mid = (lo + hi) >>> 1;
            if (t[mid] <= ms) lo = mid;
            else hi = mid;
        }
        return p[lo] + ((p[hi] - p[lo]) * (ms - t[lo])) / (t[hi] - t[lo]);
    };
}

function closeBar(state: SimState, b: FormingBar) {
    state.price = b.price;
    state.ouMean = 0.995 * state.ouMean + 0.005 * b.price;
}

function firstAtOrAfter(bars: OhlcvBar[], ms: number): number {
    let lo = 0,
        hi = bars.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (bars[mid].time < ms) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

function toOhlcv(b: FormingBar, tickSize: number): OhlcvBar {
    const snap = (x: number) => Math.round(x / tickSize) * tickSize;
    return {
        time: b.time,
        open: snap(b.open),
        high: snap(b.high),
        low: snap(b.low),
        close: snap(b.price),
        volume: Math.round(b.volume * b.frac),
    };
}

// -
// Adapter
// -
export class SimulatedMarketAdapter implements IDataAdapter {
    private readonly cfg: Required<SimulatedAdapterConfig> & {
        regimes: Record<Regime, RegimeParams>;
    };

    constructor(cfg: SimulatedAdapterConfig = {}) {
        const merged: Record<Regime, RegimeParams> = {
            TRENDING: { ...DEFAULT_REGIMES.TRENDING, ...(cfg.regimes?.TRENDING ?? {}) },
            MEAN_REVERTING: {
                ...DEFAULT_REGIMES.MEAN_REVERTING,
                ...(cfg.regimes?.MEAN_REVERTING ?? {}),
            },
            VOLATILE: { ...DEFAULT_REGIMES.VOLATILE, ...(cfg.regimes?.VOLATILE ?? {}) },
        };
        this.cfg = {
            seed: cfg.seed ?? Math.floor(Math.random() * 2 ** 32),
            startPrice: cfg.startPrice ?? 21000,
            barDurationNs: cfg.barDurationNs ?? 60_000_000_000n,
            intrabbarTicks: cfg.intrabbarTicks ?? 20,
            tickSize: cfg.tickSize ?? 0.25,
            regimes: merged,
            realtime: cfg.realtime ?? false,
            realtimeUpdateMs: cfg.realtimeUpdateMs ?? 250,
            historyBars: cfg.historyBars ?? 10_000,
            dataLevel: cfg.dataLevel ?? 'ohlcv',
        };
        // only subscribe when live
        if (this.cfg.realtime) this.subscribeRealtime = (req, onBar) => this._subscribe(req, onBar);
    }

    subscribeRealtime?: (request: RealtimeRequest, onBar: (bar: BarResponse) => void) => () => void;

    private live: {
        rand: () => number;
        state: SimState;
        closed: OhlcvBar[];
        forming: FormingBar;
        path: RecordedPath | null;
    } | null = null;
    private frozenNow: number | null = null;

    private get barsPerYear(): number {
        return (252 * 390 * 60_000_000_000) / Number(this.cfg.barDurationNs);
    }

    private _liveTo(nowMs: number) {
        const { barDurationNs, startPrice, seed, regimes, intrabbarTicks, historyBars } = this.cfg;
        const durMs = Number(barDurationNs / 1_000_000n);
        if (!this.live) {
            const rand = mulberry32(seed);
            const state = initState(regimes.MEAN_REVERTING, startPrice, rand);
            const origin = Math.floor(nowMs / durMs) * durMs - historyBars * durMs;
            const forming = openBar(state, regimes, this.barsPerYear, rand, origin);
            const path = this.cfg.dataLevel !== 'ohlcv' ? new RecordedPath() : null;
            path?.add(origin, startPrice);
            this.live = { rand, state, closed: [], forming, path };
        }
        const live = this.live;
        const rec = live.path && ((frac: number, price: number) => live.path!.add(live.forming.time + frac * durMs, price));
        while (live.forming.time + durMs <= nowMs) {
            advanceBar(live.forming, 1, intrabbarTicks, live.rand, rec ?? undefined);
            closeBar(live.state, live.forming);
            live.closed.push(toOhlcv(live.forming, this.cfg.tickSize));
            live.forming = openBar(
                live.state,
                regimes,
                this.barsPerYear,
                live.rand,
                live.forming.time + durMs,
            );
        }
        advanceBar(live.forming, (nowMs - live.forming.time) / durMs, intrabbarTicks, live.rand, rec ?? undefined);
        return live;
    }

    private _along(path: RecordedPath, fromMs: number, toMs: number): BarResponse {
        const { tickSize, seed } = this.cfg;
        if (fromMs >= toMs) return { events: [], hasMore: false };
        if (this.cfg.dataLevel === 'tick')
            return { events: [], ticks: simTicks(path.at, fromMs, toMs, { tickSize, seed }), hasMore: false };
        // a book a heatmap has something to show in
        const events = simMboEvents(path.at, fromMs, toMs, { tickSize, seed, levels: 40, lifeSlots: 600, wallOdds: 60 });
        return { events, hasMore: false };
    }

    private _fetchPath(request: FetchRequest): BarResponse {
        const now = this.cfg.realtime ? Date.now() : (this.frozenNow ??= Date.now());
        const path = this._liveTo(now).path!;
        const to = Math.min(request.range.toMs, now);
        const from = Math.max(path.start, request.range.fromMs, to - PATH_PAGE_MS);
        const hasMore = request.direction === 'forward' ? request.range.toMs < now : from > path.start;
        return { ...this._along(path, from, to), hasMore };
    }

    private _subscribe(request: RealtimeRequest, onBar: (bar: BarResponse) => void): () => void {
        if (this.cfg.dataLevel !== 'ohlcv') {
            let next = Number(request.since / 1_000_000n);
            const id = setInterval(() => {
                const now = Date.now();
                const chunk = this._along(this._liveTo(now).path!, next, now);
                next = now;
                if (chunk.events.length || chunk.ticks?.length) onBar(chunk);
            }, this.cfg.realtimeUpdateMs);
            return () => clearInterval(id);
        }
        let sent = -1;
        const id = setInterval(() => {
            const live = this._liveTo(Date.now());
            if (sent < 0) sent = firstAtOrAfter(live.closed, Number(request.since / 1_000_000n));
            const bars = live.closed.slice(sent);
            bars.push(toOhlcv(live.forming, this.cfg.tickSize));
            sent = live.closed.length;
            onBar({ events: [], ohlcvBars: bars, hasMore: false });
        }, this.cfg.realtimeUpdateMs);
        return () => clearInterval(id);
    }

    private _fetchLive(request: FetchRequest): BarResponse {
        const now = Date.now();
        const { closed, forming } = this._liveTo(now);
        const { fromMs, toMs } = request.range;
        const bars: OhlcvBar[] = [];
        for (let i = firstAtOrAfter(closed, fromMs); i < closed.length && closed[i].time < toMs; i++)
            bars.push({ ...closed[i] });
        if (forming.time >= fromMs && forming.time < toMs) bars.push(toOhlcv(forming, this.cfg.tickSize));
        const first = closed.length ? closed[0].time : forming.time;
        const hasMore = request.direction === 'forward' ? toMs < now : fromMs > first;
        return { events: [], ohlcvBars: bars, hasMore };
    }

    async searchSymbols(): Promise<SymbolInfo[]> {
        return [this.resolveSymbol()];
    }

    resolveSymbol(): SymbolInfo {
        return {
            symbol: 'SIM-MARKET',
            type: 'index',
            description: 'Simulated market - regime-switching GBM + GARCH(1,1)',
            exchange: 'SIM',
            dataLevel: this.cfg.dataLevel,
            priceFormat: {
                minTick: 0.25,
                precision: 2,
            },
            // bars only ever come at bardurationns, so the chart builds every coarser timeframe from
            // them. trades and l3 events have no period, any timeframe down to None buckets them
            ...(this.cfg.dataLevel === 'ohlcv' && { supportedResolutions: [this.cfg.barDurationNs] }),
        };
    }

    async fetchBars(request: FetchRequest): Promise<BarResponse> {
        if (this.cfg.dataLevel !== 'ohlcv') return this._fetchPath(request);
        if (this.cfg.realtime) return this._fetchLive(request);
        const { barDurationNs, intrabbarTicks, tickSize, startPrice, seed, regimes } = this.cfg;
        const barsPerYear = this.barsPerYear;

        const rand = mulberry32(seed);

        // Align bar start to bar boundary
        const { fromNs, toNs } = request.range;
        let barStart = fromNs - (fromNs % barDurationNs);

        // Generate exactly enough bars to cover the requested window (capped so a
        // pathological range can't allocate forever).
        const COUNT = Math.max(1, Math.min(20_000, Number((toNs - barStart) / barDurationNs)));

        const state = initState(regimes.MEAN_REVERTING, startPrice, rand);
        const bars: OhlcvBar[] = [];

        for (let i = 0; i < COUNT; i++) {
            const bar = openBar(state, regimes, barsPerYear, rand, Number(barStart / 1_000_000n));
            advanceBar(bar, 1, intrabbarTicks, rand);
            closeBar(state, bar);
            bars.push(toOhlcv(bar, tickSize));
            barStart += barDurationNs;
        }

        return {
            events: [],
            ohlcvBars: bars,
            hasMore: false,
        };
    }
}

/** Convenience factory matching the naming convention used in ChartPageClient. */
export function createSimulatedAdapter(cfg?: SimulatedAdapterConfig): SimulatedMarketAdapter {
    return new SimulatedMarketAdapter(cfg);
}
