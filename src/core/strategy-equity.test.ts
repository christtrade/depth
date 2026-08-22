import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { StrategyEngine, type StrategyBar } from './strategy-runtime';

const MIN = 60_000_000_000n;
const CAP = 100_000;

// long enough to force the stored curve past its cap several times over, so
// every assertion here is made against a decimated curve
const N = 25_000;

/** A deterministic wave with both a slow swing and a fast one, so the curve has
 *  real drawdowns rather than a monotone ramp. */
const closes = Array.from({ length: N }, (_, i) => 100 + Math.sin(i / 97) * 8 + Math.sin(i / 13) * 2);

function bar(i: number): StrategyBar {
    const c = closes[i];
    return { ts: BigInt(i) * MIN, open: c, high: c + 1, low: c - 1, close: c, volume: 1 };
}

/**
 * Buy one at the first bar and hold to the end, with no costs.
 *
 * Chosen because the resulting equity curve is exactly computable: the order
 * fills at bar 1's open, and from there equity is capital plus the move since.
 * That gives the reference below something to be a reference *to*, without
 * reimplementing the engine to check the engine.
 */
function run() {
    const engine = new StrategyEngine({
        initialCapital: CAP,
        tickSize: 1,
        commission: 0,
        slippageTicks: 0,
        contractSize: 1,
    });
    engine.setBarNs(MIN);
    const broker = engine.api();

    const bars: StrategyBar[] = [];
    for (let i = 0; i < N; i++) {
        const b = bar(i);
        bars.push(b);
        engine.beginBar(b, i);
        if (i === 0) broker.buy(1);
        engine.endBar(b);
    }
    engine.finish(bars[bars.length - 1]);
    return engine.result;
}

/** The equity the engine must have seen, bar by bar. */
function referenceEquity(): number[] {
    const entry = closes[1]; // market order placed on bar 0 fills at bar 1's open
    const eq = [CAP];
    for (let i = 1; i < N; i++) eq.push(CAP + (closes[i] - entry));
    return eq;
}

/** The statistics, computed the long way from the full per-bar curve. */
function referenceStats(eq: number[]) {
    let peak = eq[0];
    let maxDd = 0;
    let maxDdPct = 0;
    let ulcerSum = 0;

    for (const e of eq) {
        if (e > peak) peak = e;
        const dd = peak > 0 ? (peak - e) / peak : 0;
        if (peak - e > maxDd) maxDd = peak - e;
        if (dd > maxDdPct) maxDdPct = dd;
        ulcerSum += dd * dd;
    }

    const rets: number[] = [];
    for (let i = 1; i < eq.length; i++) {
        if (eq[i - 1] > 0) rets.push((eq[i] - eq[i - 1]) / eq[i - 1]);
    }

    let mean = 0;
    for (const r of rets) mean += r;
    mean /= rets.length;

    let varSum = 0;
    let downSum = 0;
    let downCount = 0;
    for (const r of rets) {
        varSum += (r - mean) * (r - mean);
        if (r < 0) {
            downSum += r * r;
            downCount++;
        }
    }

    const sd = Math.sqrt(varSum / (rets.length - 1));
    const downDev = Math.sqrt(downSum / downCount);
    const barsPerYear = Number(31_536_000_000_000_000n / MIN);

    return {
        maxDrawdown: maxDd,
        maxDrawdownPct: maxDdPct,
        ulcerIndex: Math.sqrt(ulcerSum / eq.length),
        sharpe: (mean / sd) * Math.sqrt(barsPerYear),
        sortino: (mean / downDev) * Math.sqrt(barsPerYear),
        finalEquity: eq[eq.length - 1],
    };
}

/** Relative closeness, since a streaming pass and a two-pass one differ in the
 *  last bits and only the last bits. */
function near(actual: number, expected: number, label: string) {
    const scale = Math.max(1, Math.abs(expected));
    assert.ok(
        Math.abs(actual - expected) / scale < 1e-9,
        `${label}: got ${actual}, expected ${expected}`,
    );
}

describe('equity statistics over a decimated curve', () => {
    const result = run();
    const ref = referenceStats(referenceEquity());

    it('stored the curve within its cap despite 25,000 bars', () => {
        assert.ok(
            result.equity.length < 9000,
            `curve grew to ${result.equity.length}, so it is not bounded`,
        );
        assert.equal(result.stats.totalBars, N, 'the run still covered every bar');
    });

    it('reports the drawdown of every bar, not of the points it kept', () => {
        near(result.stats.maxDrawdown, ref.maxDrawdown, 'maxDrawdown');
        near(result.stats.maxDrawdownPct, ref.maxDrawdownPct, 'maxDrawdownPct');
    });

    it('computes the ulcer index over every bar', () => {
        near(result.stats.ulcerIndex, ref.ulcerIndex, 'ulcerIndex');
    });

    it('computes sharpe from per-bar returns, not from stored points', () => {
        // the decisive one: consecutive kept points are ~4 bars apart here, so a
        // sharpe derived from the stored curve would be wrong by roughly sqrt(4)
        near(result.stats.sharpe, ref.sharpe, 'sharpe');
    });

    it('computes sortino from per-bar returns too', () => {
        near(result.stats.sortino, ref.sortino, 'sortino');
    });

    it('ends on the true final equity', () => {
        near(result.stats.finalEquity, ref.finalEquity, 'finalEquity');
        // the stride can land the last bar between kept points, and the end of
        // the curve is the part everyone reads off the right edge
        const last = result.equity[result.equity.length - 1];
        near(last.equity, ref.finalEquity, 'last stored point');
        assert.equal(last.ts, BigInt(N - 1) * MIN);
    });

    it('keeps the curve in order and spanning the whole run', () => {
        assert.equal(result.equity[0].ts, 0n);
        for (let i = 1; i < result.equity.length; i++) {
            assert.ok(
                result.equity[i].ts > result.equity[i - 1].ts,
                `point ${i} is not after point ${i - 1}`,
            );
        }
    });
});

describe('equity accounting on short runs', () => {
    it('keeps every bar when the run fits under the cap', () => {
        const engine = new StrategyEngine({ initialCapital: CAP, tickSize: 1 });
        engine.setBarNs(MIN);

        const bars = Array.from({ length: 500 }, (_, i) => bar(i));
        for (const [i, b] of bars.entries()) {
            engine.beginBar(b, i);
            engine.endBar(b);
        }
        engine.finish(bars[bars.length - 1]);

        // nothing is thinned until there is a reason to thin it
        assert.equal(engine.result.equity.length, 500);
    });

    it('is readable without finish(), the way a sweep scores a combination', () => {
        const engine = new StrategyEngine({ initialCapital: CAP, tickSize: 1 });
        engine.setBarNs(MIN);

        for (let i = 0; i < 10; i++) {
            const b = bar(i);
            engine.beginBar(b, i);
            engine.endBar(b);
        }

        // the newest point is held back a bar, so an unflushed read would be
        // one short and would report the wrong final equity
        assert.equal(engine.result.equity.length, 10);
        assert.equal(engine.result.stats.totalBars, 10);
    });
});
