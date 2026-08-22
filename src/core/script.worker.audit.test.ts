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

const auditRun = (data: unknown, expect: 'audit-result' | 'audit-error' = 'audit-result') =>
    send({ type: 'audit-run', pluginIndex: 0, data, barNs: MINUTE_NS, params: {} }, expect);

before(async () => {
    fakeSelf = {
        onmessage: null,
        postMessage: (msg: unknown) => posted.push(msg),
        close: () => {},
    };
    (globalThis as any).self = fakeSelf;
    await import('./script.worker');
});

const CLOSES = Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i / 17) * 5);

const SLOW_STRATEGY = `
const s = plugin({ name: "Slow", type: PluginType.strategy })
s.update = ({ index, history, broker }) => {
    const closes = history.map(b => b.close)
    sma(closes, 14)
    stdev(closes, 14)
    if (index === 0) broker.buy(1)
}
`;

const BANDS_INDICATOR = `
const s = plugin({ name: "Bands", type: PluginType.indicator })
s.init = ({ data }) => {
    const closes = data.map(b => b.close)
    return { bands: bb(closes, 20, 2) }
}
`;

// no trailing semicolons anywhere on purpose - ASI is exactly what a naive
// splice breaks
const EARLY_RETURN_STRATEGY = `
const s = plugin({ name: "Early return", type: PluginType.strategy })
s.init = () => ({ seen: 0 })
s.update = ({ index, state, broker }) => {
    state.seen++
    if (index === 0) {
        broker.buy(1)
        return state
    }
    const closes = [1, 2, 3]
    sma(closes, 2)
    return state
}
`;

describe('audit-run', () => {
    it('times the stdlib calls a strategy makes per bar, and its own lines', async () => {
        await parse(SLOW_STRATEGY);
        const r = await auditRun({ ohlcv: bars(CLOSES), trades: [] });

        assert.equal(r.result.lineLevel, true);
        const names = r.result.entries.map((e: any) => e.name);
        assert.ok(names.includes('sma'), `expected 'sma' in ${JSON.stringify(names)}`);
        assert.ok(names.includes('stdev'), `expected 'stdev' in ${JSON.stringify(names)}`);
        assert.equal(r.result.barsOrPoints, CLOSES.length);
        assert.ok(r.result.wallMs >= 0);

        const sma = r.result.entries.find((e: any) => e.name === 'sma');
        assert.equal(sma.calls, CLOSES.length);

        // line 4 is `const closes = history.map(b => b.close)`
        const line4 = r.result.entries.find((e: any) => e.line === 4);
        assert.ok(line4, `expected a line-4 entry in ${JSON.stringify(r.result.entries)}`);
        assert.ok(line4.text.includes('history.map'));
        assert.equal(line4.calls, CLOSES.length);

        // every entry's share of the wall clock is well-formed
        for (const e of r.result.entries) assert.ok(e.pct >= 0 && e.pct <= 100);
    });

    it('times an indicator\'s init() the same way', async () => {
        await parse(BANDS_INDICATOR);
        const r = await auditRun(bars(CLOSES));

        assert.equal(r.result.lineLevel, true);
        const names = r.result.entries.map((e: any) => e.name);
        assert.ok(names.includes('bb'));
        assert.equal(r.result.barsOrPoints, CLOSES.length);
    });

    it('still times a line that returns out of the function', async () => {
        await parse(EARLY_RETURN_STRATEGY);
        const r = await auditRun({ ohlcv: bars(CLOSES), trades: [] });

        assert.equal(r.result.lineLevel, true);
        // line 6 is `broker.buy(1)`, taken on every bar since index === 0 only
        // fires once - the interesting one is line 7, `return state`, inside
        // the branch that only runs on the first bar
        const returnLine = r.result.entries.find((e: any) => e.text === 'return state');
        assert.ok(returnLine, `expected a 'return state' entry in ${JSON.stringify(r.result.entries)}`);
    });

    it('leaves a declaration visible to the statement instrumented right after it', async () => {
        // if wrapping `const closes = [1,2,3]` in its own block ever regressed,
        // `sma(closes, 2)` on the next line would throw ReferenceError and this
        // whole audit would come back as an error instead of a result
        await parse(EARLY_RETURN_STRATEGY);
        const r = await auditRun({ ohlcv: bars(CLOSES), trades: [] });
        assert.equal(r.result.lineLevel, true);
        assert.ok(r.result.entries.some((e: any) => e.name === 'sma'));
    });

    it('does not disturb the live entry - a normal run still works after an audit', async () => {
        await parse(SLOW_STRATEGY);
        await auditRun({ ohlcv: bars(CLOSES), trades: [] });

        const r = await send(
            {
                type: 'run-init',
                pluginIndex: 0,
                data: { ohlcv: bars(CLOSES), trades: [] },
                barNs: MINUTE_NS,
                params: {},
            },
            'update',
        );
        assert.equal(r.state.range.bars, CLOSES.length);
        assert.equal(r.state.trades.length, 1);
    });

    it('reports an audit-error for a range with no bars', async () => {
        await parse(SLOW_STRATEGY);
        const r = await auditRun({ ohlcv: [], trades: [] }, 'audit-error');
        assert.match(r.error, /no bars|empty/i);
    });

    it('handles loops, switch and a helper function without breaking', async () => {
        const KITCHEN_SINK = `
function classify(n) {
    switch (true) {
        case n > 0:
            return "up"
        case n < 0:
            return "down"
        default:
            return "flat"
    }
}
const s = plugin({ name: "Kitchen sink", type: PluginType.strategy })
s.init = () => ({ ups: 0 })
s.update = ({ history, state, broker, index }) => {
    let total = 0
    for (let i = 0; i < history.length; i++) {
        total += history[i].close
    }
    if (classify(total) === "up") state.ups++
    if (index === 0) broker.buy(1)
}
`;
        await parse(KITCHEN_SINK);
        const r = await auditRun({ ohlcv: bars(CLOSES), trades: [] });

        assert.equal(r.result.lineLevel, true);
        assert.equal(r.result.barsOrPoints, CLOSES.length);
        // the loop body ran once per bar per history element - proof the for
        // loop's body was found and instrumented, not skipped
        const loopLine = r.result.entries.find((e: any) => e.text?.includes('total += history'));
        assert.ok(loopLine, `expected the loop body in ${JSON.stringify(r.result.entries)}`);
        assert.ok(loopLine.calls > CLOSES.length, 'loop body should run more than once per bar');
    });
});
