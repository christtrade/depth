import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';

const MINUTE_NS = 60_000_000_000n;

interface FakeSelf {
    onmessage: ((e: { data: unknown }) => void) | null;
    postMessage(msg: unknown, transfer?: unknown[]): void;
    close(): void;
}

const posted: any[] = [];
let fakeSelf: FakeSelf;

function bars(closes: number[]) {
    return closes.map((close, i) => ({
        ts: BigInt(i) * MINUTE_NS,
        open: close,
        high: close + 1,
        low: close - 1,
        close,
        volume: 1,
    }));
}

async function send(msg: unknown, expect: string) {
    posted.length = 0;
    fakeSelf.onmessage!({ data: msg });
    const deadline = Date.now() + 5000;
    while (!posted.some((m) => m.type === expect)) {
        if (Date.now() > deadline) {
            throw new Error(
                `no '${expect}' after 5s, got ${JSON.stringify(posted.map((m) => m.type))}`,
            );
        }
        await new Promise((r) => setTimeout(r, 1));
    }
    return posted.find((m) => m.type === expect);
}

const parse = (script: string) => send({ type: 'parse', script }, 'parsed');

const runInit = (
    data: unknown,
    params: Record<string, unknown> = {},
    expect = 'update',
    symbolInfo: unknown = null,
) =>
    send(
        { type: 'run-init', pluginIndex: 0, data, barNs: MINUTE_NS, params, symbolInfo },
        expect,
    );

before(async () => {
    fakeSelf = {
        onmessage: null,
        postMessage: (msg: unknown) => posted.push(msg),
        close: () => {},
    };
    (globalThis as any).self = fakeSelf;
    await import('./script.worker');
});

// buys the first bar and holds - the simplest thing that produces a trade
const BUY_AND_HOLD = `
const s = plugin({ name: "Buy and hold", type: PluginType.strategy })
s.update = ({ index, broker }) => {
    if (index === 0) broker.buy(1)
}
`;

describe('strategy plugins in the worker', () => {
    it('registers as a strategy and reports trades, equity and stats', async () => {
        const parsed = await parse(BUY_AND_HOLD);
        assert.equal(parsed.plugins[0].decl.type, 'strategy');

        const result = await runInit({ ohlcv: bars([100, 110, 120, 130]), trades: [] });
        const state = result.state;

        assert.equal(state.trades.length, 1, 'the open position closes at the last bar');
        assert.equal(state.equity.length, 4, 'one equity point per bar');
        assert.equal(state.stats.totalTrades, 1);
        assert.ok(state.stats.netPnl > 0, `expected a profit, got ${state.stats.netPnl}`);
        assert.equal(state.position, null);
    });

    it('drives update() once per bar, not once per window', async () => {
        await parse(`
            const s = plugin({ name: "Counter", type: PluginType.strategy })
            s.init = () => ({ calls: 0 })
            s.update = ({ state }) => ({ calls: state.calls + 1 })
        `);

        const result = await runInit({ ohlcv: bars([1, 2, 3, 4, 5]), trades: [] });
        assert.equal(result.state.user.calls, 5);
    });

    it('hands update() a trailing window it cannot see past', async () => {
        await parse(`
            const s = plugin({ name: "Window", type: PluginType.strategy, lookback: 3 })
            s.init = () => ({ sizes: [], lastCloses: [] })
            s.update = ({ history, bar, state }) => {
                state.sizes.push(history.length)
                state.lastCloses.push(history[history.length - 1].close === bar.close)
                return state
            }
        `);

        const result = await runInit({ ohlcv: bars([1, 2, 3, 4, 5]), trades: [] });
        const user = result.state.user;

        // grows to the declared lookback and then stops
        assert.deepEqual(user.sizes, [1, 2, 3, 3, 3]);
        // the last element is always the bar under evaluation - never a future one
        assert.ok(user.lastCloses.every(Boolean));
    });

    it('gives the stdlib the same window, so sma() over history lines up', async () => {
        await parse(`
            const s = plugin({ name: "Stdlib", type: PluginType.strategy, lookback: 3 })
            s.init = () => ({ last: null })
            s.update = ({ history, state }) => {
                const ma = sma(history, 3)
                state.last = ma[ma.length - 1]
                return state
            }
        `);

        const result = await runInit({ ohlcv: bars([10, 20, 30, 40, 50]), trades: [] });
        // the last window is [30,40,50]
        assert.equal(result.state.user.last, 40);
    });

    it('reads account settings from the declaration', async () => {
        await parse(`
            const s = plugin({
                name: "Funded",
                type: PluginType.strategy,
                strategy: { initialCapital: 50000, commission: 1 },
            })
            s.update = ({ index, broker }) => { if (index === 0) broker.buy(1) }
        `);

        const result = await runInit({ ohlcv: bars([100, 100, 100]), trades: [] });
        // flat price, so the only movement is the two commissions
        assert.equal(result.state.stats.finalEquity, 50_000 - 2);
    });

    it('lets a param override what the declaration set', async () => {
        const script = `
            const s = plugin({
                name: "Tunable",
                type: PluginType.strategy,
                strategy: { initialCapital: 50000, commission: 1 },
                params: { commission: { label: 'Commission', type: 'number', default: 1 } },
            })
            s.update = ({ index, broker }) => { if (index === 0) broker.buy(1) }
        `;
        await parse(script);

        const result = await runInit({ ohlcv: bars([100, 100, 100]), trades: [] }, { commission: 5 });
        assert.equal(result.state.stats.finalEquity, 50_000 - 10);
    });

    it('draws entry and exit markers without the script defining draw()', async () => {
        await parse(BUY_AND_HOLD);
        const result = await runInit({ ohlcv: bars([100, 110, 120]), trades: [] });

        const arrows = result.drawCommands.filter((c: any) => c.type === 'arrow');
        assert.equal(arrows.length, 2, 'one marker for the entry, one for the exit');
        assert.equal(arrows[0].direction, 'up');
        assert.equal(arrows[1].direction, 'down');
    });

    it('plots the equity curve instead when the strategy asks for a pane', async () => {
        await parse(`
            const s = plugin({ name: "Paned", type: PluginType.strategy, layout: Layout.pane })
            s.update = ({ index, broker }) => { if (index === 0) broker.buy(1) }
        `);
        const result = await runInit({ ohlcv: bars([100, 110, 120]), trades: [] });

        assert.equal(result.drawCommands.length, 1);
        assert.equal(result.drawCommands[0].type, 'line');
        assert.equal(result.drawCommands[0].pts.length, 3);
    });

    it('still lets a strategy define its own draw()', async () => {
        await parse(`
            const s = plugin({ name: "Custom", type: PluginType.strategy })
            s.update = ({ index, broker }) => { if (index === 0) broker.buy(1) }
            s.draw = (state) => [drawHLine(state.stats.finalEquity, "#fff", 1)]
        `);
        const result = await runInit({ ohlcv: bars([100, 110]), trades: [] });

        assert.equal(result.drawCommands.length, 1);
        assert.equal(result.drawCommands[0].type, 'hline');
    });

    it('takes the point value and tick size from the instrument', async () => {
        // no `strategy` block at all - the script says nothing about contracts
        await parse(BUY_AND_HOLD);

        const flat = await runInit({ ohlcv: bars([100, 100, 110]), trades: [] });
        // without an instrument, a point is worth 1
        assert.equal(flat.state.stats.netPnl, 10);

        const nq = await runInit(
            { ohlcv: bars([100, 100, 110]), trades: [] },
            {},
            'update',
            { symbol: 'NQ', contract: { multiplier: 20, tickSize: 0.25, qtyStep: 1 } },
        );
        // the same 10-point move on a $20/pt contract
        assert.equal(nq.state.stats.netPnl, 200);
    });

    it('derives the multiplier from tickValue when no multiplier is published', async () => {
        await parse(BUY_AND_HOLD);

        const es = await runInit(
            { ohlcv: bars([100, 100, 110]), trades: [] },
            {},
            'update',
            // $12.50 a tick at 0.25 a tick is $50 a point
            { symbol: 'ES', contract: { tickValue: 12.5, tickSize: 0.25 } },
        );
        assert.equal(es.state.stats.netPnl, 500);
    });

    it('lets the script override what the instrument says', async () => {
        await parse(`
            const s = plugin({
                name: "Fixed multiplier",
                type: PluginType.strategy,
                strategy: { contractSize: 2 },
            })
            s.update = ({ index, broker }) => { if (index === 0) broker.buy(1) }
        `);

        const result = await runInit(
            { ohlcv: bars([100, 100, 110]), trades: [] },
            {},
            'update',
            { symbol: 'NQ', contract: { multiplier: 20 } },
        );
        // a script that hardcoded its multiplier keeps reasoning in its own terms
        assert.equal(result.state.stats.netPnl, 20);
    });

    it('exposes the run settings as params so the dialog can drive them', async () => {
        // the merge happens in the capability, not the worker, so this checks the
        // worker end: a param named like a config field has to reach the engine
        await parse(BUY_AND_HOLD);

        const result = await runInit({ ohlcv: bars([100, 100, 110]), trades: [] }, {
            initialCapital: 25_000,
            commission: 3,
        });

        assert.equal(result.state.stats.finalEquity, 25_000 + 10 - 6);
    });

    it('sweeps a parameter grid without re-parsing the script', async () => {
        await parse(`
            const s = plugin({
                name: "Threshold",
                type: PluginType.strategy,
                params: { level: { label: 'Level', type: 'number', default: 100 } },
            })
            s.update = ({ bar, index, params, broker }) => {
                if (index === 0 && bar.close < params.level) broker.buy(1)
            }
        `);

        const done = await send(
            {
                type: 'sweep',
                pluginIndex: 0,
                data: { ohlcv: bars([100, 100, 120]), trades: [] },
                barNs: MINUTE_NS,
                params: {},
                grid: [{ level: 50 }, { level: 150 }],
            },
            'sweep-done',
        );

        assert.equal(done.results.length, 2);
        // level 50: close of 100 is not below it, so no trade
        assert.equal(done.results[0].params.level, 50);
        assert.equal(done.results[0].stats.totalTrades, 0);
        // level 150: it is, so one trade for the +20 move
        assert.equal(done.results[1].params.level, 150);
        assert.equal(done.results[1].stats.totalTrades, 1);
        assert.equal(done.results[1].stats.netPnl, 20);
    });

    it('reports progress as it goes', async () => {
        await parse(BUY_AND_HOLD);

        await send(
            {
                type: 'sweep',
                pluginIndex: 0,
                data: { ohlcv: bars([100, 100, 110]), trades: [] },
                barNs: MINUTE_NS,
                params: {},
                grid: Array.from({ length: 60 }, (_, i) => ({ commission: i })),
            },
            'sweep-done',
        );

        const progress = posted.filter((m) => m.type === 'sweep-progress');
        assert.ok(progress.length >= 2, `expected batched progress, got ${progress.length}`);
        assert.equal(progress[progress.length - 1].done, 60);
        assert.equal(progress[progress.length - 1].total, 60);
    });

    it('splits in-sample from out-of-sample when asked', async () => {
        await parse(BUY_AND_HOLD);

        // 200 bars: a rise across the first half, a fall across the second. A
        // buy-and-hold looks good in-sample and bad out-of-sample, which is the
        // whole thing the split exists to reveal.
        const closes = [
            ...Array.from({ length: 100 }, (_, i) => 100 + i),
            ...Array.from({ length: 100 }, (_, i) => 200 - i),
        ];

        const done = await send(
            {
                type: 'sweep',
                pluginIndex: 0,
                data: { ohlcv: bars(closes), trades: [] },
                barNs: MINUTE_NS,
                params: {},
                grid: [{}],
                oosFraction: 0.5,
            },
            'sweep-done',
        );

        const r = done.results[0];
        assert.ok(r.inSample, 'in-sample stats missing');
        assert.ok(r.outOfSample, 'out-of-sample stats missing');
        assert.ok(r.inSample.netPnl > 0, `expected an in-sample profit, got ${r.inSample.netPnl}`);
        assert.ok(
            r.outOfSample.netPnl < 0,
            `expected an out-of-sample loss, got ${r.outOfSample.netPnl}`,
        );
    });

    it('omits the split rather than reporting a meaningless one', async () => {
        await parse(BUY_AND_HOLD);

        const done = await send(
            {
                type: 'sweep',
                pluginIndex: 0,
                data: { ohlcv: bars([100, 100, 110]), trades: [] },
                barNs: MINUTE_NS,
                params: {},
                grid: [{}],
                oosFraction: 0.3,
            },
            'sweep-done',
        );

        // three bars cannot be split into two halves worth reporting
        assert.equal(done.results[0].inSample, undefined);
        assert.equal(done.results[0].outOfSample, undefined);
    });

    it('records a combination that throws as a hole, and finishes the rest', async () => {
        await parse(`
            const s = plugin({
                name: "Fragile",
                type: PluginType.strategy,
                params: { level: { label: 'Level', type: 'number', default: 1 } },
            })
            s.update = ({ params }) => {
                if (params.level === 2) throw new Error("bad combination")
            }
        `);

        const done = await send(
            {
                type: 'sweep',
                pluginIndex: 0,
                data: { ohlcv: bars([100, 110, 120]), trades: [] },
                barNs: MINUTE_NS,
                params: {},
                grid: [{ level: 1 }, { level: 2 }, { level: 3 }],
            },
            'sweep-done',
        );

        assert.equal(done.results.length, 3, 'one bad combination must not lose the others');
        assert.match(done.results[1].error, /bad combination/);
        assert.ok(done.results[2].stats, 'the run after the failure still scored');
    });

    it('refuses a grid past the budget instead of hanging', async () => {
        await parse(BUY_AND_HOLD);

        const rejected = await send(
            {
                type: 'sweep',
                pluginIndex: 0,
                // the array only has to report a length - the budget check runs
                // before anything iterates it
                data: { ohlcv: { length: 500_000 } as any, trades: [] },
                barNs: MINUTE_NS,
                params: {},
                grid: Array.from({ length: 1000 }, (_, i) => ({ commission: i })),
            },
            'sweep-rejected',
        );

        assert.equal(rejected.ok, false);
        assert.match(rejected.reason, /bar evaluations/);
    });

    it('walks forward, choosing on each window and testing on the next', async () => {
        // A strategy whose only parameter picks which direction to trade. The
        // first half of the series rises and the second half falls, so the
        // optimiser should choose long early and be punished for it later - which
        // is exactly the situation walk-forward exists to expose.
        await parse(`
            const s = plugin({
                name: "Directional",
                type: PluginType.strategy,
                params: { dir: { label: 'Direction', type: 'number', default: 1 } },
            })
            s.update = ({ index, params, broker }) => {
                if (index === 0) {
                    if (params.dir > 0) broker.buy(1)
                    else broker.sell(1)
                }
            }
        `);

        const closes = [
            ...Array.from({ length: 800 }, (_, i) => 100 + i * 0.5),
            ...Array.from({ length: 800 }, (_, i) => 500 - i * 0.5),
        ];

        const done = await send(
            {
                type: 'walk-forward',
                pluginIndex: 0,
                data: { ohlcv: bars(closes), trades: [] },
                barNs: MINUTE_NS,
                params: {},
                grid: [{ dir: 1 }, { dir: -1 }],
                windows: 3,
                isMultiple: 3,
            },
            'walkforward-done',
        );

        assert.equal(done.results.length, 3);

        for (const r of done.results) {
            assert.ok(r.params, 'every window should have chosen something');
            assert.ok(r.inSample, 'in-sample stats missing');
            assert.ok(r.outOfSample, 'out-of-sample stats missing');
            assert.ok(r.outOfSampleEquity?.length, 'out-of-sample equity curve missing');
            // the guarantee the whole method rests on
            assert.ok(
                r.window.oosFrom >= r.window.isTo,
                `window ${r.window.index} was tested on data it trained on`,
            );
        }

        // the first window trains and tests entirely inside the rise, so it picks
        // long and is right; a later one trains across the turn and is not
        assert.equal(done.results[0].params.dir, 1);
        assert.ok(
            done.results.some((r: any) => r.outOfSample.netPnl < 0),
            'a rise-then-fall series must punish at least one window',
        );
    });

    it('reports walk-forward progress per window', async () => {
        await parse(BUY_AND_HOLD);
        const closes = Array.from({ length: 1200 }, (_, i) => 100 + i * 0.1);

        await send(
            {
                type: 'walk-forward',
                pluginIndex: 0,
                data: { ohlcv: bars(closes), trades: [] },
                barNs: MINUTE_NS,
                params: {},
                grid: [{}],
                windows: 3,
                isMultiple: 3,
            },
            'walkforward-done',
        );

        const progress = posted.filter((m) => m.type === 'walkforward-progress');
        assert.equal(progress.length, 3);
        assert.equal(progress[2].done, 3);
        assert.equal(progress[2].total, 3);
    });

    it('refuses a series too short to schedule, rather than inventing windows', async () => {
        await parse(BUY_AND_HOLD);

        const rejected = await send(
            {
                type: 'walk-forward',
                pluginIndex: 0,
                data: { ohlcv: bars([100, 110, 120]), trades: [] },
                barNs: MINUTE_NS,
                params: {},
                grid: [{}],
                windows: 4,
                isMultiple: 3,
            },
            'walkforward-rejected',
        );

        assert.match(rejected.reason, /cannot be split/);
    });

    it('refuses a window too long to run here, and says so as its own message', async () => {
        await parse(BUY_AND_HOLD);

        // one past the worker's ceiling. Building 2M real bar objects would cost
        // more than the test is worth, so the array reports the length without
        // materialising anything - runStrategy checks .length before it iterates.
        const huge = { length: 2_000_001 } as unknown as ReturnType<typeof bars>;

        const rejected = await send(
            { type: 'run-init', pluginIndex: 0, data: { ohlcv: huge, trades: [] }, barNs: MINUTE_NS, params: {} },
            'strategy-rejected',
        );

        assert.equal(rejected.pluginIndex, 0);
        assert.equal(rejected.maxBars, 2_000_000);
        assert.equal(rejected.bars, 2_000_001);
        assert.match(rejected.reason, /2,000,001 bars/);
        // and not as a script error - nothing is wrong with the script
        assert.equal(
            posted.some((m) => m.type === 'error'),
            false,
        );
    });

    it('reports an error from inside a strategy without taking the worker down', async () => {
        await parse(`
            const s = plugin({ name: "Broken", type: PluginType.strategy })
            s.update = () => { throw new Error("boom") }
        `);

        const err = await runInit({ ohlcv: bars([1, 2]), trades: [] }, {}, 'error');
        assert.match(err.error, /boom/);

        // and the worker still answers afterwards
        await parse(BUY_AND_HOLD);
        const ok = await runInit({ ohlcv: bars([100, 110]), trades: [] });
        assert.equal(ok.state.stats.totalTrades, 1);
    });
});
