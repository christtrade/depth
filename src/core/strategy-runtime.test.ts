import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { StrategyEngine, type StrategyBar } from './strategy-runtime';

const MIN = 60_000_000_000n;

function bar(i: number, o: number, h: number, l: number, c: number): StrategyBar {
    return { ts: BigInt(i) * MIN, open: o, high: h, low: l, close: c, volume: 100 };
}

/**
 * Drives the engine the way the worker does: brackets and queued orders resolve
 * against the bar, then the script acts, then the bar is marked to market.
 */
function run(
    bars: StrategyBar[],
    onBar: (b: StrategyBar, i: number, broker: ReturnType<StrategyEngine['api']>) => void,
    cfg: ConstructorParameters<typeof StrategyEngine>[0] = {},
) {
    const engine = new StrategyEngine({ initialCapital: 10_000, tickSize: 1, ...cfg });
    engine.setBarNs(MIN);
    const broker = engine.api();

    bars.forEach((b, i) => {
        engine.beginBar(b, i);
        onBar(b, i, broker);
        engine.endBar(b);
    });
    engine.finish(bars[bars.length - 1]);

    return engine.result;
}

describe('strategy fill model', () => {
    it('fills a market order at the next bar open, never the bar it was placed on', () => {
        const bars = [bar(0, 100, 101, 99, 100), bar(1, 105, 106, 104, 105), bar(2, 110, 111, 109, 110)];

        const result = run(bars, (_b, i, broker) => {
            if (i === 0) broker.buy(1);
        });

        // entered at bar 1's open (105), not bar 0's close (100)
        assert.equal(result.trades.length, 1);
        assert.equal(result.trades[0].entryPrice, 105);
    });

    it('applies slippage against the trader on both sides of a market fill', () => {
        const bars = [bar(0, 100, 101, 99, 100), bar(1, 100, 101, 99, 100), bar(2, 100, 101, 99, 100)];

        const long = run(
            bars,
            (_b, i, broker) => {
                if (i === 0) broker.buy(1);
                if (i === 1) broker.close();
            },
            { slippageTicks: 2, tickSize: 0.5 },
        );

        // bought 1 point above the open, sold 1 point below it
        assert.equal(long.trades[0].entryPrice, 101);
        assert.equal(long.trades[0].exitPrice, 99);
        assert.ok(long.trades[0].pnl < 0, 'slippage alone should make a flat round trip lose');
    });

    it('fills a limit only when the bar trades through it, and never better than the limit', () => {
        const missed = run([bar(0, 100, 101, 99, 100), bar(1, 100, 101, 98.5, 100)], (_b, i, broker) => {
            if (i === 0) broker.buy(1, { limit: 98 });
        });
        assert.equal(missed.trades.length, 0, 'bar low 98.5 never reached the 98 limit');
        assert.equal(missed.openOrders.length, 1, 'the order should still be resting');

        const hit = run(
            [bar(0, 100, 101, 99, 100), bar(1, 100, 101, 97, 100), bar(2, 100, 101, 99, 100)],
            (_b, i, broker) => {
                if (i === 0) broker.buy(1, { limit: 98 });
            },
        );
        assert.equal(hit.trades[0].entryPrice, 98, 'filled at the limit, not at the 97 low');
    });

    it('fills a stop at the open when the bar gaps through it', () => {
        const result = run(
            [bar(0, 100, 101, 99, 100), bar(1, 110, 112, 109, 111), bar(2, 110, 111, 109, 110)],
            (_b, i, broker) => {
                if (i === 0) broker.buy(1, { stop: 105 });
            },
        );

        // the bar opened at 110, above the 105 stop - there was no 105 to be had
        assert.equal(result.trades[0].entryPrice, 110);
    });

    it('takes the stop when one bar contains both the stop and the target', () => {
        const bars = [
            bar(0, 100, 101, 99, 100),
            bar(1, 100, 100.5, 99.5, 100),
            bar(2, 100, 110, 90, 100), // reaches the 110 target and the 95 stop
            bar(3, 100, 101, 99, 100),
        ];

        const result = run(bars, (_b, i, broker) => {
            if (i === 0) broker.buy(1, { sl: 95, tp: 110 });
        });

        assert.equal(result.trades.length, 1);
        assert.equal(result.trades[0].reason, 'stop');
        assert.equal(result.trades[0].exitPrice, 95);
    });
});

describe('strategy position accounting', () => {
    it('closes and reopens on a reversal, logging one trade for the closed leg', () => {
        const bars = [
            bar(0, 100, 101, 99, 100),
            bar(1, 100, 101, 99, 100),
            bar(2, 120, 121, 119, 120),
            bar(3, 120, 121, 119, 120),
        ];

        const result = run(bars, (_b, i, broker) => {
            if (i === 0) broker.buy(1);
            if (i === 1) broker.sell(2); // close the long, open a short of 1
        });

        assert.equal(result.trades.length, 2, 'the reversal leg plus the end-of-data close');
        assert.equal(result.trades[0].reason, 'reverse');
        assert.equal(result.trades[0].side, 'long');
        assert.equal(result.trades[1].side, 'short');
    });

    it('ignores a second same-side entry by default', () => {
        const bars = [
            bar(0, 100, 101, 99, 100),
            bar(1, 100, 101, 99, 100),
            bar(2, 200, 201, 199, 200),
            bar(3, 200, 201, 199, 200),
        ];

        const result = run(bars, (_b, i, broker) => {
            if (i === 0) broker.buy(1);
            if (i === 1) broker.buy(1);
        });

        // pyramiding defaults to 1. An entry condition that stays true across
        // twenty bars is one trade, not twenty - without this the position ends
        // up twenty times the size the script appears to take, and every
        // per-trade statistic describes something nobody wrote.
        assert.equal(result.trades.length, 1);
        assert.equal(result.trades[0].qty, 1);
        assert.equal(result.trades[0].entryPrice, 100, 'the second buy was dropped');
    });

    it('averages the entry when pyramiding allows the add', () => {
        const bars = [
            bar(0, 100, 101, 99, 100),
            bar(1, 100, 101, 99, 100),
            bar(2, 200, 201, 199, 200),
            bar(3, 200, 201, 199, 200),
        ];

        const result = run(
            bars,
            (_b, i, broker) => {
                if (i === 0) broker.buy(1);
                if (i === 1) broker.buy(1);
            },
            { pyramiding: 2 },
        );

        // one at 100, one at 200
        assert.equal(result.trades[0].entryPrice, 150);
        assert.equal(result.trades[0].qty, 2);
    });

    it('stops adding once the pyramiding limit is reached', () => {
        const bars = [
            bar(0, 100, 100, 100, 100),
            bar(1, 100, 100, 100, 100),
            bar(2, 100, 100, 100, 100),
            bar(3, 100, 100, 100, 100),
            bar(4, 100, 100, 100, 100),
            bar(5, 100, 100, 100, 100),
        ];

        const result = run(
            bars,
            (_b, i, broker) => {
                if (i < 4) broker.buy(1);
            },
            { pyramiding: 3 },
        );

        assert.equal(result.trades[0].qty, 3, 'the fourth entry was refused');
    });

    it('can be told an opposite order may only flatten, never flip', () => {
        const bars = [
            bar(0, 100, 101, 99, 100),
            bar(1, 100, 101, 99, 100),
            bar(2, 120, 121, 119, 120),
            bar(3, 120, 121, 119, 120),
        ];

        const result = run(
            bars,
            (_b, i, broker) => {
                if (i === 0) broker.buy(1);
                if (i === 1) broker.sell(2);
            },
            { allowReverse: false },
        );

        // the long closes, and the leftover quantity does not open a short
        assert.equal(result.trades.length, 1);
        assert.equal(result.trades[0].side, 'long');
        assert.equal(result.trades[0].reason, 'signal');
        assert.equal(result.position, null);
    });

    it('floors an order to the instrument\'s quantity step', () => {
        const bars = [
            bar(0, 100, 101, 99, 100),
            bar(1, 100, 101, 99, 100),
            bar(2, 100, 101, 99, 100),
        ];

        const result = run(
            bars,
            (_b, i, broker) => {
                if (i === 0) broker.buy(0.37);
                if (i === 1) broker.close();
            },
            { qtyStep: 0.1, contractSize: 1 },
        );

        // floored to 0.3, not rounded up to 0.4 - rounding up hands the strategy
        // size the venue would have refused
        assert.equal(result.trades[0].qty, 0.3);
    });

    it('charges commission per contract on both sides', () => {
        const bars = [bar(0, 100, 101, 99, 100), bar(1, 100, 101, 99, 100), bar(2, 100, 101, 99, 100)];

        const result = run(
            bars,
            (_b, i, broker) => {
                if (i === 0) broker.buy(2);
                if (i === 1) broker.close();
            },
            { commission: 2.5 },
        );

        // 2 contracts x 2.5 x two sides, on an otherwise flat round trip
        assert.equal(result.trades[0].pnl, -10);
    });

    it('closes an open position at the last bar so the log balances', () => {
        const result = run([bar(0, 100, 101, 99, 100), bar(1, 110, 111, 109, 110)], (_b, i, broker) => {
            if (i === 0) broker.buy(1);
        });

        assert.equal(result.position, null);
        assert.equal(result.trades.length, 1);
        assert.equal(result.trades[0].reason, 'end-of-data');
    });

    it('refuses to let a script rewrite its own trade log', () => {
        const engine = new StrategyEngine();
        const broker = engine.api();
        assert.equal((broker as unknown as Record<string, unknown>).trades, undefined);
        assert.equal(typeof broker.position, 'object');
    });
});

describe('strategy excursion tracking', () => {
    it('records how far a trade went against and in favour before closing', () => {
        const bars = [
            bar(0, 100, 101, 99, 100),
            bar(1, 100, 100, 100, 100), // entry here, at the open
            bar(2, 100, 100, 90, 95), // down to 90 - 10 against
            bar(3, 95, 130, 95, 120), // up to 130 - 30 in favour
            bar(4, 120, 121, 119, 110),
            bar(5, 110, 111, 109, 110),
        ];

        const result = run(bars, (_b, i, broker) => {
            if (i === 0) broker.buy(1);
            if (i === 4) broker.close();
        });

        const t = result.trades[0];
        assert.equal(t.entryPrice, 100);
        assert.equal(t.maeAbs, 10, 'worst was the 90 low');
        assert.equal(t.mfeAbs, 30, 'best was the 130 high');
        assert.equal(t.maePnl, 10);
        assert.equal(t.mfePnl, 30);
    });

    it('mirrors the excursion for a short', () => {
        const bars = [
            bar(0, 100, 101, 99, 100),
            bar(1, 100, 100, 100, 100),
            bar(2, 100, 115, 100, 110), // 15 against a short
            bar(3, 110, 110, 80, 85), // 20 in favour
            bar(4, 85, 86, 84, 85),
            bar(5, 85, 86, 84, 85),
        ];

        const result = run(bars, (_b, i, broker) => {
            if (i === 0) broker.sell(1);
            if (i === 4) broker.close();
        });

        const t = result.trades[0];
        assert.equal(t.maeAbs, 15);
        assert.equal(t.mfeAbs, 20);
    });

    it('reports R multiples only for trades that carried a stop', () => {
        const bars = [
            bar(0, 100, 101, 99, 100),
            bar(1, 100, 100, 100, 100),
            bar(2, 100, 120, 100, 120), // +20 on a 10-point risk = 2R
            bar(3, 120, 121, 119, 120),
        ];

        const withStop = run(bars, (_b, i, broker) => {
            if (i === 0) broker.buy(1, { sl: 90 });
            if (i === 2) broker.close();
        });

        const t = withStop.trades[0];
        assert.equal(t.initialRiskPerUnit, 10);
        assert.equal(t.initialRiskTotal, 10);
        assert.equal(t.realizedR, 2, 'closed +20 against 10 of risk');
        assert.equal(t.maxFavorableR, 2);

        const noStop = run(bars, (_b, i, broker) => {
            if (i === 0) broker.buy(1);
            if (i === 2) broker.close();
        });

        // undefined, not 0 - the trade has no R, which is different from zero R
        assert.equal(noStop.trades[0].realizedR, undefined);
        assert.equal(noStop.trades[0].initialRiskPerUnit, undefined);
        assert.equal(noStop.stats.tradesWithRisk, 0);
    });

    it('scores exit efficiency against the move that was available', () => {
        const bars = [
            bar(0, 100, 101, 99, 100),
            bar(1, 100, 100, 100, 100),
            bar(2, 100, 140, 100, 120), // 40 available, price back to 120
            bar(3, 120, 120, 120, 120), // exits here at the open
            bar(4, 120, 121, 119, 120),
        ];

        const result = run(bars, (_b, i, broker) => {
            if (i === 0) broker.buy(1);
            if (i === 2) broker.close();
        });

        const t = result.trades[0];
        assert.equal(t.mfeAbs, 40);
        // captured 20 of the 40 that were there
        assert.equal(t.efficiency, 0.5);
    });

    it('leaves efficiency undefined when the trade never went in favour', () => {
        const bars = [
            bar(0, 100, 100, 100, 100),
            bar(1, 100, 100, 100, 100),
            bar(2, 90, 90, 80, 85),
            bar(3, 85, 86, 84, 85),
        ];

        const result = run(bars, (_b, i, broker) => {
            if (i === 0) broker.buy(1);
            if (i === 2) broker.close();
        });

        // there was nothing to capture, which is not the same as capturing none
        assert.equal(result.trades[0].mfeAbs, 0);
        assert.equal(result.trades[0].efficiency, undefined);
    });
});

describe('strategy statistics', () => {
    it('reports win rate, profit factor and net P&L over a mixed run', () => {
        // +10 then -5, one contract each
        const bars = [
            bar(0, 100, 101, 99, 100),
            bar(1, 100, 101, 99, 100),
            bar(2, 110, 111, 109, 110),
            bar(3, 110, 111, 109, 110),
            bar(4, 105, 106, 104, 105),
            bar(5, 105, 106, 104, 105),
        ];

        const result = run(bars, (_b, i, broker) => {
            if (i === 0) broker.buy(1);
            if (i === 1) broker.close();
            if (i === 2) broker.buy(1);
            if (i === 3) broker.close();
        });

        const s = result.stats;
        assert.equal(s.totalTrades, 2);
        assert.equal(s.wins, 1);
        assert.equal(s.losses, 1);
        assert.equal(s.winRate, 0.5);
        assert.equal(s.grossProfit, 10);
        assert.equal(s.grossLoss, -5);
        assert.equal(s.profitFactor, 2);
        assert.equal(s.netPnl, 5);
        assert.equal(s.finalEquity, 10_005);
    });

    it('tracks max drawdown off the running equity peak', () => {
        const bars = [
            bar(0, 100, 101, 99, 100),
            bar(1, 100, 101, 99, 100),
            bar(2, 200, 201, 199, 200), // +100 open
            bar(3, 150, 151, 149, 150), // gave back 50
            bar(4, 150, 151, 149, 150),
        ];

        const result = run(bars, (_b, i, broker) => {
            if (i === 0) broker.buy(1);
        });

        // peak equity 10,100 at bar 2, down to 10,050 at bar 3
        assert.equal(result.stats.maxDrawdown, 50);
        assert.ok(Math.abs(result.stats.maxDrawdownPct - 50 / 10_100) < 1e-9);
    });

    it('leaves Sharpe at zero rather than reporting an unscaled number', () => {
        const engine = new StrategyEngine();
        // no setBarNs, so there is no period to annualise from
        const bars = [bar(0, 100, 101, 99, 100), bar(1, 110, 111, 109, 110), bar(2, 120, 121, 119, 120)];
        bars.forEach((b, i) => {
            engine.beginBar(b, i);
            engine.endBar(b);
        });
        assert.equal(engine.result.stats.sharpe, 0);
    });

    it('records an equity point per bar', () => {
        const bars = [bar(0, 100, 101, 99, 100), bar(1, 100, 101, 99, 100), bar(2, 100, 101, 99, 100)];
        const result = run(bars, () => {});
        assert.equal(result.equity.length, 3);
        assert.equal(result.equity[0].equity, 10_000);
    });
});
