// Run specs and parameter sweeps.
//
// A run spec is one backtest described independently of the chart: which script,
// which parameters, over which bars.
// No DOM and no imports beyond the engine's own types, so the server runner gets
// grid expansion and budgeting for free rather than reimplementing them.

import type { StrategyStats } from './strategy-runtime';

/**
 * One axis of a sweep: a parameter and the values to try for it.
 *
 * Explicit `values` for anything discrete (a boolean, a select, a handful of
 * lengths worth testing). `from`/`to`/`step` for a numeric range, which is what
 * a ParamDef with min/max/step already describes - so the UI can offer a sweep
 * over a parameter without the author declaring anything extra.
 */
export type SweepAxis =
    | { param: string; values: unknown[] }
    | { param: string; from: number; to: number; step: number };

export interface SweepSpec {
    axes: SweepAxis[];
    /**
     * Fraction of the run held back from the end as out-of-sample, 0 to 0.9.
     *
     * Optional but strongly encouraged, and the reason it is here rather than in
     * some later "advanced" feature: a sweep is a machine for overfitting. Report
     * only the best in-sample result and you have found the parameters that best
     * describe noise you already have. The out-of-sample column is what tells you
     * whether you found anything at all.
     */
    oosFraction?: number;
}

/** What one point of the grid produced. */
export interface SweepResult {
    /** The parameter values this run used - only the swept ones. */
    params: Record<string, unknown>;
    /** Over the whole window. */
    stats: StrategyStats;
    /** The leading portion, when a split was requested. */
    inSample?: StrategyStats;
    /** The held-back tail. The number that actually means something. */
    outOfSample?: StrategyStats;
}

// Refusing loudly beats a tab that freezes without explanation
export const MAX_SWEEP_BAR_ITERATIONS = 200_000_000;

// Combinations, regardless of length. Guards the result array, not the cpu
export const MAX_SWEEP_COMBOS = 20_000;

// Values an axis will try, resolved from either form
export function axisValues(axis: SweepAxis): unknown[] {
    if ('values' in axis) return axis.values;

    const { from, to, step } = axis;
    if (!isFinite(from) || !isFinite(to)) return [];

    const stride = step > 0 ? step : 0;
    if (stride === 0 || from === to) return [from];

    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const out: number[] = [];

    const count = Math.floor((hi - lo) / stride + 1e-9) + 1;
    const decimals = (String(stride).split('.')[1] ?? '').length;
    for (let i = 0; i < count; i++) {
        out.push(Number((lo + i * stride).toFixed(decimals)));
    }
    return out;
}

/**
 * The cartesian product of every axis, as parameter patches.
 *
 * Ordered so the first axis varies slowest. That makes the result array read as
 * rows of the first parameter when laid out as a grid, which is what a heatmap
 * wants without having to sort anything.
*/
export function expandGrid(axes: SweepAxis[]): Array<Record<string, unknown>> {
    const usable = axes.filter((a) => axisValues(a).length > 0);
    if (!usable.length) return [{}];

    let combos: Array<Record<string, unknown>> = [{}];

    for (const axis of usable) {
        const values = axisValues(axis);
        const next: Array<Record<string, unknown>> = [];
        for (const combo of combos) {
            for (const value of values) {
                next.push({ ...combo, [axis.param]: value });
            }
        }
        combos = next;

        if (combos.length > MAX_SWEEP_COMBOS) {
            // stop expanding rather than build an array that cannot be used -
            // the caller checks the budget and reports, this just refuses to
            // spend the memory getting there
            return combos.slice(0, MAX_SWEEP_COMBOS + 1);
        }
    }

    return combos;
}

export interface SweepBudget {
    combos: number;
    bars: number;
    iterations: number;
    ok: boolean;
    /** Populated when ok is false. Written for a user, not a log. */
    reason?: string;
}

/** Whether a sweep is worth attempting here, and what to say when it is not. */
export function checkSweepBudget(combos: number, bars: number): SweepBudget {
    const iterations = combos * bars;
    const budget: SweepBudget = { combos, bars, iterations, ok: true };

    if (combos > MAX_SWEEP_COMBOS) {
        return {
            ...budget,
            ok: false,
            reason:
                `${combos.toLocaleString()} combinations is past the limit of ` +
                `${MAX_SWEEP_COMBOS.toLocaleString()}. Widen the step, or sweep fewer parameters ` +
                `at once.`,
        };
    }

    if (iterations > MAX_SWEEP_BAR_ITERATIONS) {
        return {
            ...budget,
            ok: false,
            reason:
                `${combos.toLocaleString()} combinations over ${bars.toLocaleString()} bars is ` +
                `${iterations.toLocaleString()} bar evaluations, past what this browser will run ` +
                `(${MAX_SWEEP_BAR_ITERATIONS.toLocaleString()}). Shorten the range, widen the ` +
                `step, or sweep fewer parameters.`,
        };
    }

    return budget;
}

/**
 * Where to cut a run into in-sample and out-of-sample halves.
 *
 * The tail is held back, never the head: the point is to test on data that comes
 * *after* what the parameters were chosen on, because that is the only ordering
 * that resembles trading them.
 *
 * Returns null when there is no meaningful split - too few bars, or a fraction
 * that would leave one side empty. A missing OOS column is honest; a two-bar one
 * is worse than none.
 */
export function splitIndex(barCount: number, oosFraction: number | undefined): number | null {
    if (!oosFraction || oosFraction <= 0 || oosFraction >= 0.9) return null;
    if (barCount < 100) return null;

    const index = Math.floor(barCount * (1 - oosFraction));
    if (index < 50 || barCount - index < 50) return null;
    return index;
}
