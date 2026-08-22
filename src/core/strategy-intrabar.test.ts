import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { StrategyEngine, reconcileIntrabar, type StrategyBar } from './strategy-runtime';

const MIN = 60_000_000_000n;
const SEC = 1_000_000_000n;

function bar(i: number, o: number, h: number, l: number, c: number): StrategyBar {
    return { ts: BigInt(i) * MIN, open: o, high: h, low: l, close: c, volume: 100 };
}

/** One second inside chart bar `i`, `s` seconds in. */
function sub(i: number, s: number, o: number, h: number, l: number, c: number): StrategyBar {
    return { ts: BigInt(i) * MIN + BigInt(s) * SEC, open: o, high: h, low: l, close: c, volume: 1 };
}

/**
 * Drives the engine the way the worker does, with an optional finer series per
 * chart bar. Mirrors `run` in strategy-runtime.test.ts, plus the third argument.
 */
function run(
    bars: StrategyBar[],
    subs: Record<number, StrategyBar[]>,
    onBar: (b: StrategyBar, i: number, broker: ReturnType<StrategyEngine['api']>) => void,
    cfg: ConstructorParameters<typeof StrategyEngine>[0] = {},
) {
    const engine = new StrategyEngine({ initialCapital: 10_000, tickSize: 1, ...cfg });
    engine.setBarNs(MIN);
    const broker = engine.api();

    bars.forEach((b, i) => {
        engine.beginBar(b, i, subs[i]);
        onBar(b, i, broker);
        engine.endBar(b);
    });
    engine.finish(bars[bars.length - 1]);

    return engine.result;
}

// A bar that touches both 90 and 110, so a position with sl 95 / tp 105 has both
// levels inside it. Which one fills depends entirely on the order inside the bar,
// which is the thing the aggregate cannot say and the sub-bars can.
const AMBIGUOUS = bar(1, 100, 110, 90, 100);

/** Target first, then the stop. */
const TARGET_FIRST = [
    sub(1, 0, 100, 110, 100, 108), // up to 110 - target
    sub(1, 1, 108, 108, 90, 95), //   then down to 90 - stop
    sub(1, 2, 95, 100, 95, 100),
];

/** Stop first, then the target. */
const STOP_FIRST = [
    sub(1, 0, 100, 100, 90, 92), //   down to 90 - stop
    sub(1, 1, 92, 110, 92, 108), //   then up to 110 - target
    sub(1, 2, 108, 110, 100, 100),
];

describe('reconcileIntrabar', () => {
    const parent = bar(0, 100, 110, 90, 105);

    it('accepts a subdivision that reproduces the parent bar', () => {
        const ok = [sub(0, 0, 100, 110, 100, 108), sub(0, 1, 108, 108, 90, 105)];
        assert.equal(reconcileIntrabar(parent, ok, 0.5), true);
    });

    it('rejects a subdivision that never reaches the parent high', () => {
        // the second holding the 110 print is missing from the feed
        const holed = [sub(0, 0, 100, 104, 100, 103), sub(0, 1, 103, 103, 90, 105)];
        assert.equal(reconcileIntrabar(parent, holed, 0.5), false);
    });

    it('rejects a subdivision that never reaches the parent low', () => {
        const holed = [sub(0, 0, 100, 110, 100, 108), sub(0, 1, 108, 108, 99, 105)];
        assert.equal(reconcileIntrabar(parent, holed, 0.5), false);
    });

    it('rejects a subdivision that opens or closes somewhere else', () => {
        const badOpen = [sub(0, 0, 101, 110, 100, 108), sub(0, 1, 108, 108, 90, 105)];
        const badClose = [sub(0, 0, 100, 110, 100, 108), sub(0, 1, 108, 108, 90, 104)];
        assert.equal(reconcileIntrabar(parent, badOpen, 0.5), false);
        assert.equal(reconcileIntrabar(parent, badClose, 0.5), false);
    });

    it('rejects out-of-order or duplicated timestamps', () => {
        const reversed = [sub(0, 1, 100, 110, 100, 108), sub(0, 0, 108, 108, 90, 105)];
        const duped = [sub(0, 0, 100, 110, 100, 108), sub(0, 0, 108, 108, 90, 105)];
        assert.equal(reconcileIntrabar(parent, reversed, 0.5), false);
        assert.equal(reconcileIntrabar(parent, duped, 0.5), false);
    });

    it('tolerates disagreement below half a tick', () => {
        const rounded = [sub(0, 0, 100.2, 110.2, 100, 108), sub(0, 1, 108, 108, 89.8, 104.8)];
        assert.equal(reconcileIntrabar(parent, rounded, 0.5), true);
        assert.equal(reconcileIntrabar(parent, rounded, 0.01), false);
    });

    it('is false for no subdivision at all', () => {
        assert.equal(reconcileIntrabar(parent, undefined, 0.5), false);
        assert.equal(reconcileIntrabar(parent, [], 0.5), false);
    });
});

describe('intrabar fill resolution', () => {
    const enterThenBracket = (_b: StrategyBar, i: number, broker: any) => {
        if (i === 0) broker.buy(1, { sl: 95, tp: 105 });
    };

    it('without intrabar data a bar holding both levels takes the stop', () => {
        const bars = [bar(0, 100, 101, 99, 100), AMBIGUOUS, bar(2, 100, 101, 99, 100)];
        const result = run(bars, {}, enterThenBracket);

        assert.equal(result.trades.length, 1);
        assert.equal(result.trades[0].reason, 'stop');
        assert.equal(result.trades[0].ambiguousExit, true);
        assert.equal(result.stats.ambiguousExits, 1);
    });

    it('takes the target when the sub-bars show the target came first', () => {
        const bars = [bar(0, 100, 101, 99, 100), AMBIGUOUS, bar(2, 100, 101, 99, 100)];
        const result = run(bars, { 1: TARGET_FIRST }, enterThenBracket);

        assert.equal(result.trades.length, 1);
        assert.equal(result.trades[0].reason, 'target');
        assert.equal(result.trades[0].exitPrice, 105);
        // observed, not assumed - no sub-bar held both levels
        assert.equal(result.trades[0].ambiguousExit, undefined);
        assert.equal(result.stats.ambiguousExits, 0);
    });

    it('still takes the stop when the sub-bars show the stop came first', () => {
        const bars = [bar(0, 100, 101, 99, 100), AMBIGUOUS, bar(2, 100, 101, 99, 100)];
        const result = run(bars, { 1: STOP_FIRST }, enterThenBracket);

        assert.equal(result.trades.length, 1);
        assert.equal(result.trades[0].reason, 'stop');
        assert.equal(result.stats.ambiguousExits, 0);
    });

    it('the two orderings give different results from identical chart bars', () => {
        const bars = [bar(0, 100, 101, 99, 100), AMBIGUOUS, bar(2, 100, 101, 99, 100)];

        const target = run(bars, { 1: TARGET_FIRST }, enterThenBracket);
        const stop = run(bars, { 1: STOP_FIRST }, enterThenBracket);

        // the whole point: same aggregate, opposite outcome
        assert.ok(target.stats.netPnl > 0);
        assert.ok(stop.stats.netPnl < 0);
    });

    it('remains ambiguous when both levels are inside a single sub-bar', () => {
        const bars = [bar(0, 100, 101, 99, 100), AMBIGUOUS, bar(2, 100, 101, 99, 100)];
        // one second that spans the whole range - finer data, same problem
        const oneSecond = [sub(1, 0, 100, 110, 90, 100)];

        const result = run(bars, { 1: oneSecond }, enterThenBracket);

        assert.equal(result.trades[0].reason, 'stop');
        assert.equal(result.trades[0].ambiguousExit, true);
        assert.equal(result.stats.ambiguousExits, 1);
    });
});

describe('intrabar accounting', () => {
    it('counts the bars it resolved finer', () => {
        const bars = [bar(0, 100, 101, 99, 100), AMBIGUOUS, bar(2, 100, 101, 99, 100)];
        const result = run(bars, { 1: TARGET_FIRST }, (_b, i, broker) => {
            if (i === 0) broker.buy(1, { sl: 95, tp: 105 });
        });

        assert.equal(result.stats.intrabarBars, 1);
        assert.equal(result.stats.intrabarFallbacks, 0);
    });

    it('falls back to the aggregate when the subdivision does not reconcile', () => {
        const bars = [bar(0, 100, 101, 99, 100), AMBIGUOUS, bar(2, 100, 101, 99, 100)];
        // the second holding the 110 print is missing, so this cannot be trusted
        // to say the target came first
        const holed = [sub(1, 0, 100, 104, 100, 103), sub(1, 1, 103, 103, 90, 100)];

        const result = run(bars, { 1: holed }, (_b, i, broker) => {
            if (i === 0) broker.buy(1, { sl: 95, tp: 105 });
        });

        assert.equal(result.stats.intrabarBars, 0);
        assert.equal(result.stats.intrabarFallbacks, 1);
        // aggregate rules apply again, so the stop wins and it is flagged
        assert.equal(result.trades[0].reason, 'stop');
        assert.equal(result.trades[0].ambiguousExit, true);
    });

    it('reports zero for a run given no intrabar data at all', () => {
        const bars = [bar(0, 100, 101, 99, 100), bar(1, 100, 101, 99, 100)];
        const result = run(bars, {}, () => {});

        assert.equal(result.stats.intrabarBars, 0);
        assert.equal(result.stats.intrabarFallbacks, 0);
    });
});

describe('intrabar excursion', () => {
    it('does not charge a position for the part of its entry bar it missed', () => {
        // bar 1 dips to 90 in its first second, and only in the second second
        // does it trade up through the 105 stop entry. The 90 print happened
        // while the position did not exist.
        const bars = [bar(0, 100, 101, 99, 100), bar(1, 100, 110, 90, 108), bar(2, 108, 109, 107, 108)];
        const subs = {
            1: [
                sub(1, 0, 100, 100, 90, 100), // the dip, before the entry exists
                sub(1, 1, 100, 110, 100, 108), // the fill happens against this one
            ],
        };

        const enter = (_b: StrategyBar, i: number, broker: any) => {
            if (i === 0) broker.buy(1, { stop: 105 });
            if (i === 2) broker.close();
        };

        const withSubs = run(bars, subs, enter);
        const without = run(bars, {}, enter);

        assert.equal(withSubs.trades[0].entryPrice, 105);
        assert.equal(without.trades[0].entryPrice, 105);

        // the aggregate blames the whole bar's 90 low on a position that opened
        // at 105 after the dip: a 15 point adverse excursion that never happened
        assert.equal(without.trades[0].maeAbs, 15);

        // the sub-bars narrow it to the entry second's own range. Not zero, and
        // deliberately so - the fill triggered at 105 somewhere inside a second
        // that ran 100 to 110, and which of those came first is now the question
        // one level down. Intrabar data moves the boundary of what is observed;
        // it does not abolish it.
        assert.equal(withSubs.trades[0].maeAbs, 5);
    });

    it('timestamps the best excursion to the second it happened', () => {
        const bars = [bar(0, 100, 101, 99, 100), bar(1, 100, 110, 99, 101), bar(2, 101, 102, 100, 101)];
        const subs = {
            1: [
                sub(1, 0, 100, 101, 99, 100),
                sub(1, 1, 100, 110, 100, 105), // the high prints here
                sub(1, 2, 105, 105, 100, 101),
            ],
        };

        const result = run(bars, subs, (_b, i, broker) => {
            if (i === 0) broker.buy(1);
            if (i === 2) broker.close();
        });

        assert.equal(result.trades.length, 1);
        // the second, not the whole minute
        assert.equal(result.trades[0].mfeTs, BigInt(1) * MIN + BigInt(1) * SEC);
    });
});

describe('intrabar order fills', () => {
    it('fills a resting limit the aggregate would also fill, at the same price', () => {
        const bars = [bar(0, 100, 101, 99, 100), bar(1, 100, 101, 95, 100), bar(2, 100, 101, 99, 100)];
        const subs = {
            1: [sub(1, 0, 100, 101, 95, 97), sub(1, 1, 97, 101, 97, 100)],
        };

        const withSubs = run(bars, subs, (_b, i, broker) => {
            if (i === 0) broker.buy(1, { limit: 96 });
            if (i === 2) broker.close();
        });
        const without = run(bars, {}, (_b, i, broker) => {
            if (i === 0) broker.buy(1, { limit: 96 });
            if (i === 2) broker.close();
        });

        assert.equal(withSubs.trades[0].entryPrice, 96);
        assert.equal(without.trades[0].entryPrice, 96);
    });

    it('does not fill a limit that no sub-bar reaches even though the parent does not either', () => {
        const bars = [bar(0, 100, 101, 99, 100), bar(1, 100, 101, 98, 100)];
        const subs = { 1: [sub(1, 0, 100, 101, 98, 99), sub(1, 1, 99, 101, 99, 100)] };

        const result = run(bars, subs, (_b, i, broker) => {
            if (i === 0) broker.buy(1, { limit: 96 });
        });

        assert.equal(result.trades.length, 0);
        assert.equal(result.openOrders.length, 1);
    });

    it('lets a stop entry fill and then stop out inside the same chart bar', () => {
        // enters on the way up through 105, then the reversal takes out the 100
        // protective stop - one chart bar, two events, in order
        const bars = [bar(0, 100, 101, 99, 100), bar(1, 100, 110, 95, 96), bar(2, 96, 97, 95, 96)];
        const subs = {
            1: [
                sub(1, 0, 100, 110, 100, 108),
                sub(1, 1, 108, 108, 95, 96),
            ],
        };

        const result = run(bars, subs, (_b, i, broker) => {
            if (i === 0) broker.buy(1, { stop: 105, sl: 100 });
        });

        assert.equal(result.trades.length, 1);
        assert.equal(result.trades[0].reason, 'stop');
        assert.equal(result.trades[0].entryPrice, 105);
        assert.equal(result.trades[0].exitPrice, 100);
    });
});
