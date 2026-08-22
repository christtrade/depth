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

const runInit = (data: unknown, range?: unknown, expect = 'update') =>
    send(
        { type: 'run-init', pluginIndex: 0, data, barNs: MINUTE_NS, params: {}, range },
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

// counts the bars it was handed, and records the first and last it saw
const COUNTER = `
const s = plugin({ name: "Counter", type: PluginType.strategy })
s.init = () => ({ n: 0, first: null, last: null })
s.update = ({ bar, state }) => {
    if (state.first === null) state.first = String(bar.ts)
    state.last = String(bar.ts)
    state.n++
    return state
}
`;

const TEN = () => ({ ohlcv: bars([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), trades: [] });

describe('run range in the worker', () => {
    it('runs over everything when no range is given', async () => {
        await parse(COUNTER);
        const result = await runInit(TEN());

        assert.equal(result.state.user.n, 10);
        assert.equal(result.state.range.clipped, false);
        assert.equal(result.state.range.bars, 10);
        assert.equal(result.state.range.totalBars, 10);
    });

    it('runs only the bars inside the range', async () => {
        await parse(COUNTER);
        const result = await runInit(TEN(), { fromNs: 3n * MINUTE_NS, toNs: 6n * MINUTE_NS });

        assert.equal(result.state.user.n, 4);
        assert.equal(result.state.user.first, String(3n * MINUTE_NS));
        assert.equal(result.state.user.last, String(6n * MINUTE_NS));
    });

    it('reports the bars it actually covered, not the range it was asked for', async () => {
        await parse(COUNTER);
        // asks for far more than exists on both sides
        const result = await runInit(TEN(), { fromNs: -50n * MINUTE_NS, toNs: 900n * MINUTE_NS });

        assert.equal(result.state.range.fromNs, 0n);
        assert.equal(result.state.range.toNs, 9n * MINUTE_NS);
        assert.equal(result.state.range.bars, 10);
        assert.equal(result.state.range.clipped, false);
    });

    it('marks a run as clipped when the range excluded bars', async () => {
        await parse(COUNTER);
        const result = await runInit(TEN(), { fromNs: 5n * MINUTE_NS });

        assert.equal(result.state.range.clipped, true);
        assert.equal(result.state.range.bars, 5);
        assert.equal(result.state.range.totalBars, 10);
    });

    it('accepts a range whose bounds arrived as strings', async () => {
        // a rehydrated chart went through JSON, where bigint does not survive
        await parse(COUNTER);
        const result = await runInit(TEN(), {
            fromNs: String(3n * MINUTE_NS),
            toNs: String(6n * MINUTE_NS),
        });

        assert.equal(result.state.user.n, 4);
    });

    it('refuses a range holding no bars instead of reporting an empty run', async () => {
        await parse(COUNTER);
        const rejected = await runInit(
            TEN(),
            { fromNs: 500n * MINUTE_NS },
            'strategy-rejected',
        );

        // a strategy that took no trades and one given no bars look identical in
        // a results panel, and only one of them is the user's fault
        assert.match(rejected.reason, /No bars fall inside the selected range/);
        assert.equal(rejected.bars, 0);
    });

    it('names the inversion when the range is backwards', async () => {
        await parse(COUNTER);
        const rejected = await runInit(
            TEN(),
            { fromNs: 8n * MINUTE_NS, toNs: 2n * MINUTE_NS },
            'strategy-rejected',
        );

        assert.match(rejected.reason, /after its end/);
    });

    it('ignores a range object with neither end set', async () => {
        await parse(COUNTER);
        const result = await runInit(TEN(), {});

        assert.equal(result.state.user.n, 10);
        assert.equal(result.state.range.clipped, false);
    });
});

describe('run range in a sweep', () => {
    const SWEEPABLE = `
        const s = plugin({
            name: "Sweepable",
            type: PluginType.strategy,
            params: { n: { label: "N", type: "stepperInt", default: 1, min: 1, max: 5 } },
        })
        s.init = () => ({ seen: 0 })
        s.update = ({ state }) => { state.seen++; return state }
    `;

    it('bounds every combination to the same range', async () => {
        await parse(SWEEPABLE);

        const done = await send(
            {
                type: 'sweep',
                pluginIndex: 0,
                data: TEN(),
                barNs: MINUTE_NS,
                params: { n: 1 },
                grid: [{ n: 1 }, { n: 2 }],
                range: { fromNs: 6n * MINUTE_NS },
            },
            'sweep-done',
        );

        assert.equal(done.results.length, 2);
        // four bars each, so neither combination silently saw more data
        for (const r of done.results) {
            assert.ok(!r.error, `combination errored: ${r.error}`);
            assert.equal(r.stats.totalBars, 4);
        }
    });

    it('refuses a sweep whose range holds no bars', async () => {
        await parse(SWEEPABLE);

        const rejected = await send(
            {
                type: 'sweep',
                pluginIndex: 0,
                data: TEN(),
                barNs: MINUTE_NS,
                params: { n: 1 },
                grid: [{ n: 1 }],
                range: { fromNs: 900n * MINUTE_NS },
            },
            'sweep-rejected',
        );

        assert.match(rejected.reason, /No bars fall inside the selected range/);
    });
});
