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

import type {
    IDataAdapter,
    FetchRequest,
    BarResponse,
    SymbolInfo,
    OhlcvBar,
} from '../interfaces/IDataAdapter';

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

function simulateBar(
    state: SimState,
    params: RegimeParams,
    barsPerYear: number,
    intrabbarTicks: number,
    tickSize: number,
    rand: () => number,
): OhlcvBar & { _closePrice: number; _time: string } {
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


    // Simulate intra-bar price path (GBM + optional OU) to get realistic H/L
    let p = state.price;
    let high = p;
    let low = p;

    const tickDt = dt / intrabbarTicks;

    // OU: drift term pulls toward ouMean
    const ouDriftPerTick = params.ouSpeed * (Math.log(state.ouMean) - Math.log(p)) * tickDt;
    const gbmDriftPerTick = (params.drift - 0.5 * newVar) * tickDt;

    for (let t = 0; t < intrabbarTicks; t++) {
        const shock = studentT(rand, params.tDof) * Math.sqrt(newVar * tickDt);
        const logReturn = gbmDriftPerTick + ouDriftPerTick + shock;
        p = p * Math.exp(logReturn);
        if (p > high) high = p;
        if (p < low) low = p;
    }

    const close = p;
    const open = state.price;

    // Update OU mean slowly (exponential smoothing)
    state.ouMean = 0.995 * state.ouMean + 0.005 * close;

    // Round to tick size
    const snap = (x: number) => Math.round(x / tickSize) * tickSize;

    const volume = Math.round(
        500 + rand() * 4500 + (newVar / longRunVar) * 2000, // vol spikes on high GARCH vol
    );

    return {
        time: 0, // filled by caller
        open: snap(open),
        high: snap(Math.max(open, high, close)), // H >= O,C always
        low: snap(Math.min(open, low, close)), // L <= O,C always
        close: snap(close),
        volume,
        _closePrice: close,
        _time: '',
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
        };
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
            dataLevel: 'ohlcv',
            priceFormat: {
                minTick: 0.25,
                precision: 2,
            },
        };
    }

    async fetchBars(request: FetchRequest): Promise<BarResponse> {
        const { barDurationNs, intrabbarTicks, tickSize, startPrice, seed } = this.cfg;

        // Number of 1-min bars per trading year (252 days x 6.5 h x 60 min).
        // If your bars aren't 1-min, scale accordingly.
        const barMinutes = Number(barDurationNs / 60_000_000_000n);
        const barsPerYear = (252 * 390) / barMinutes;

        const rand = mulberry32(seed);

        // Align bar start to bar boundary
        const { fromNs, toNs } = request.range;
        let barStart = fromNs - (fromNs % barDurationNs);

        // Generate exactly enough bars to cover the requested window (capped so a
        // pathological range can't allocate forever).
        const COUNT = Math.max(1, Math.min(20_000, Number((toNs - barStart) / barDurationNs)));

        // Initialise simulation state
        const initRegime: Regime = 'MEAN_REVERTING';
        const initParams = this.cfg.regimes[initRegime];
        const state: SimState = {
            price: startPrice,
            garchVar: initParams.baseVol ** 2,
            regime: initRegime,
            regimeBarsLeft: regimeDuration(initParams, rand),
            ouMean: startPrice,
        };

        const bars: OhlcvBar[] = [];

        for (let i = 0; i < COUNT; i++) {
            // Regime transition check
            state.regimeBarsLeft--;
            if (state.regimeBarsLeft <= 0) {
                state.regime = pickNextRegime(state.regime, rand);
                state.regimeBarsLeft = regimeDuration(this.cfg.regimes[state.regime], rand);
            }

            const params = this.cfg.regimes[state.regime];
            const bar = simulateBar(state, params, barsPerYear, intrabbarTicks, tickSize, rand);

            // Advance state price to close
            state.price = bar._closePrice;

            bars.push({
                time: Number(barStart / 1_000_000n),
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
                volume: bar.volume,
            });

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
