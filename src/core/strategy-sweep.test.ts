import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    axisValues,
    checkSweepBudget,
    expandGrid,
    MAX_SWEEP_COMBOS,
    splitIndex,
} from './strategy-sweep';

describe('sweep axis values', () => {
    it('takes explicit values as given', () => {
        assert.deepEqual(axisValues({ param: 'x', values: [1, 'a', true] }), [1, 'a', true]);
    });

    it('walks a numeric range inclusively', () => {
        assert.deepEqual(axisValues({ param: 'x', from: 10, to: 50, step: 10 }), [10, 20, 30, 40, 50]);
    });

    it('does not drift on fractional steps', () => {
        // accumulating 0.1 thirty times lands on 0.30000000000000004 and then
        // every later value is wrong in the ugliest possible way
        const values = axisValues({ param: 'x', from: 0, to: 1, step: 0.1 }) as number[];
        assert.equal(values.length, 11);
        assert.equal(values[3], 0.3);
        assert.equal(values[7], 0.7);
    });

    it('handles a reversed range', () => {
        assert.deepEqual(axisValues({ param: 'x', from: 5, to: 1, step: 2 }), [1, 3, 5]);
    });

    it('returns a single value rather than looping forever on a zero step', () => {
        assert.deepEqual(axisValues({ param: 'x', from: 1, to: 10, step: 0 }), [1]);
        assert.deepEqual(axisValues({ param: 'x', from: 4, to: 4, step: 1 }), [4]);
    });
});

describe('sweep grid', () => {
    it('is the cartesian product of its axes', () => {
        const grid = expandGrid([
            { param: 'fast', values: [5, 10] },
            { param: 'slow', values: [50, 100, 200] },
        ]);

        assert.equal(grid.length, 6);
        assert.deepEqual(grid[0], { fast: 5, slow: 50 });
        assert.deepEqual(grid[5], { fast: 10, slow: 200 });
    });

    it('varies the first axis slowest, so the array reads as grid rows', () => {
        const grid = expandGrid([
            { param: 'a', values: [1, 2] },
            { param: 'b', values: [1, 2] },
        ]);
        assert.deepEqual(
            grid.map((g) => `${g.a}${g.b}`),
            ['11', '12', '21', '22'],
        );
    });

    it('yields one empty combination when there is nothing to sweep', () => {
        assert.deepEqual(expandGrid([]), [{}]);
        assert.deepEqual(expandGrid([{ param: 'x', values: [] }]), [{}]);
    });

    it('stops expanding rather than building an unusable array', () => {
        const grid = expandGrid([
            { param: 'a', from: 1, to: 200, step: 1 },
            { param: 'b', from: 1, to: 200, step: 1 },
        ]);
        // 40,000 combinations - it must refuse to materialise all of them
        assert.ok(grid.length <= MAX_SWEEP_COMBOS + 1);
    });
});

describe('sweep budget', () => {
    it('allows a grid a browser can finish', () => {
        const budget = checkSweepBudget(200, 50_000);
        assert.equal(budget.ok, true);
        assert.equal(budget.iterations, 10_000_000);
    });

    it('refuses on combinations alone', () => {
        const budget = checkSweepBudget(MAX_SWEEP_COMBOS + 1, 10);
        assert.equal(budget.ok, false);
        assert.match(budget.reason!, /combinations/);
    });

    it('refuses on combinations times bars, not either alone', () => {
        // each is individually fine; together they are not, which is the whole
        // reason the budget multiplies
        assert.equal(checkSweepBudget(5000, 1000).ok, true);
        const budget = checkSweepBudget(5000, 100_000);
        assert.equal(budget.ok, false);
        assert.match(budget.reason!, /bar evaluations/);
    });
});

describe('in-sample / out-of-sample split', () => {
    it('holds back the tail, never the head', () => {
        // the point is testing on data that comes after what the parameters were
        // chosen on - the other ordering resembles nothing
        assert.equal(splitIndex(1000, 0.3), 700);
    });

    it('declines a split that would leave either side too small to mean anything', () => {
        assert.equal(splitIndex(50, 0.3), null, 'too few bars overall');
        assert.equal(splitIndex(120, 0.01), null, 'out-of-sample would be one bar');
        assert.equal(splitIndex(120, 0.95), null, 'in-sample would be nothing');
    });

    it('is null when no split was asked for', () => {
        assert.equal(splitIndex(1000, undefined), null);
        assert.equal(splitIndex(1000, 0), null);
    });
});
