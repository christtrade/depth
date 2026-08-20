import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    parameterStability,
    pickBest,
    planWalkForward,
    walkForwardEfficiency,
    type WalkForwardWindowResult,
} from './strategy-walkforward';
import type { StrategyStats } from './strategy-runtime';

/** Only the fields the walk-forward maths reads. */
function stats(netPnl: number): StrategyStats {
    return { netPnl } as StrategyStats;
}

function windowResult(
    index: number,
    isFrom: number,
    isTo: number,
    oosFrom: number,
    oosTo: number,
    isPnl: number,
    oosPnl: number,
    params: Record<string, unknown> = {},
): WalkForwardWindowResult {
    return {
        window: { index, isFrom, isTo, oosFrom, oosTo },
        params,
        inSample: stats(isPnl),
        outOfSample: stats(oosPnl),
    };
}

describe('walk-forward scheduling', () => {
    it('rolls a fixed window forward by the out-of-sample length', () => {
        const plan = planWalkForward(1200, { windows: 3, isMultiple: 3, anchored: false });

        // 1200 / (3 + 3) = 200 out-of-sample, 600 in-sample
        assert.equal(plan.length, 3);
        assert.deepEqual(plan[0], { index: 0, isFrom: 0, isTo: 600, oosFrom: 600, oosTo: 800 });
        assert.deepEqual(plan[1], { index: 1, isFrom: 200, isTo: 800, oosFrom: 800, oosTo: 1000 });
        assert.deepEqual(plan[2], { index: 2, isFrom: 400, isTo: 1000, oosFrom: 1000, oosTo: 1200 });
    });

    it('anchors every in-sample segment at the start when asked', () => {
        const plan = planWalkForward(1200, { windows: 3, isMultiple: 3, anchored: true });

        assert.equal(plan.length, 3);
        assert.ok(plan.every((w) => w.isFrom === 0));
        // the test segments are identical either way - only the training differs
        assert.deepEqual(
            plan.map((w) => [w.oosFrom, w.oosTo]),
            [
                [600, 800],
                [800, 1000],
                [1000, 1200],
            ],
        );
    });

    it('never lets a test segment overlap the training that chose it', () => {
        const plan = planWalkForward(2000, { windows: 4, isMultiple: 3, anchored: false });
        for (const w of plan) {
            assert.ok(w.oosFrom >= w.isTo, `window ${w.index} tests on data it trained on`);
        }
    });

    it('refuses a series too short to schedule honestly', () => {
        assert.deepEqual(planWalkForward(150, { windows: 3, isMultiple: 3, anchored: false }), []);
        // 400 bars over 5 windows leaves 50 per segment
        assert.deepEqual(planWalkForward(300, { windows: 5, isMultiple: 3, anchored: false }), []);
        assert.deepEqual(planWalkForward(1200, { windows: 0, isMultiple: 3, anchored: false }), []);
    });

    it('stays inside the series', () => {
        const plan = planWalkForward(1000, { windows: 6, isMultiple: 2, anchored: false });
        for (const w of plan) assert.ok(w.oosTo <= 1000, `window ${w.index} runs past the data`);
    });
});

describe('walk-forward efficiency', () => {
    it('is 1 when out-of-sample matched in-sample per bar', () => {
        const results = [
            windowResult(0, 0, 300, 300, 400, 300, 100),
            windowResult(1, 100, 400, 400, 500, 300, 100),
        ];
        // 600 over 600 in-sample bars, 200 over 200 out-of-sample bars
        assert.equal(walkForwardEfficiency(results), 1);
    });

    it('halves when out-of-sample earned half the rate', () => {
        const results = [windowResult(0, 0, 300, 300, 400, 300, 50)];
        assert.equal(walkForwardEfficiency(results), 0.5);
    });

    it('goes negative when the optimised parameters lost on unseen data', () => {
        const results = [windowResult(0, 0, 300, 300, 400, 300, -100)];
        assert.ok(walkForwardEfficiency(results) < 0);
    });

    it('weights by bars, so a long anchored window cannot dominate', () => {
        // both windows earned the same per bar; the ratio must be 1 regardless of
        // the first being three times as long
        const results = [
            windowResult(0, 0, 900, 900, 1000, 900, 100),
            windowResult(1, 0, 300, 300, 400, 300, 100),
        ];
        assert.equal(walkForwardEfficiency(results), 1);
    });

    it('is 0 rather than infinite when in-sample made nothing', () => {
        const results = [windowResult(0, 0, 300, 300, 400, 0, 100)];
        assert.equal(walkForwardEfficiency(results), 0);
    });
});

describe('parameter stability', () => {
    it('reports agreement as a low coefficient', () => {
        const results = [
            windowResult(0, 0, 1, 1, 2, 1, 1, { period: 20 }),
            windowResult(1, 0, 1, 1, 2, 1, 1, { period: 21 }),
            windowResult(2, 0, 1, 1, 2, 1, 1, { period: 20 }),
        ];

        const [p] = parameterStability(results);
        assert.equal(p.param, 'period');
        assert.deepEqual(p.values, [20, 21, 20]);
        assert.equal(p.distinct, 2);
        assert.ok(p.coefficientOfVariation < 0.05, `expected agreement, got ${p.coefficientOfVariation}`);
    });

    it('reports disagreement as a high one', () => {
        // 14 then 87 then 31 - there is no optimum here, only noise being fitted
        const results = [
            windowResult(0, 0, 1, 1, 2, 1, 1, { period: 14 }),
            windowResult(1, 0, 1, 1, 2, 1, 1, { period: 87 }),
            windowResult(2, 0, 1, 1, 2, 1, 1, { period: 31 }),
        ];

        const [p] = parameterStability(results);
        assert.equal(p.distinct, 3);
        assert.ok(p.coefficientOfVariation > 0.5, `expected instability, got ${p.coefficientOfVariation}`);
    });

    it('is zero when every window agreed exactly', () => {
        const results = [
            windowResult(0, 0, 1, 1, 2, 1, 1, { period: 50 }),
            windowResult(1, 0, 1, 1, 2, 1, 1, { period: 50 }),
        ];
        assert.equal(parameterStability(results)[0].coefficientOfVariation, 0);
    });

    it('ignores parameters that are not numeric', () => {
        const results = [
            windowResult(0, 0, 1, 1, 2, 1, 1, { mode: 'fast', period: 10 }),
            windowResult(1, 0, 1, 1, 2, 1, 1, { mode: 'slow', period: 12 }),
        ];
        const params = parameterStability(results).map((p) => p.param);
        assert.deepEqual(params, ['period']);
    });
});

describe('picking the best row', () => {
    it('takes the highest by default', () => {
        const rows = [{ v: 1 }, { v: 5 }, { v: 3 }];
        assert.deepEqual(pickBest(rows, (r) => r.v), { v: 5 });
    });

    it('takes the lowest when smaller is better', () => {
        const rows = [{ v: 1 }, { v: 5 }, { v: 3 }];
        assert.deepEqual(pickBest(rows, (r) => r.v, false), { v: 1 });
    });

    it('skips a non-finite metric rather than letting it win', () => {
        // profit factor is Infinity for a run with no losing trade, which on a
        // thin in-sample window is noise dressed as perfection
        const rows = [{ v: Infinity }, { v: 2 }, { v: NaN }];
        assert.deepEqual(pickBest(rows, (r) => r.v), { v: 2 });
    });

    it('is null when nothing scored', () => {
        assert.equal(pickBest([{ v: NaN }], (r) => r.v), null);
        assert.equal(pickBest([], (r: { v: number }) => r.v), null);
    });
});
