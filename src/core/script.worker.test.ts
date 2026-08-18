import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, before } from 'node:test';

// script.worker installs itself on `self` at import time and answers over
// postMessage, so the test stands in for the browser rather than for the
// worker: a fake `self`, a fetch that serves examples/wasm/sma.wasm, and the
// same messages ScriptedPlugin sends.

const WASM_PATH = fileURLToPath(new URL('../../examples/wasm/sma.wasm', import.meta.url));
const WASM_URL = 'https://example.test/sma.wasm';
const MINUTE_NS = 60_000_000_000n;

interface FakeSelf {
    onmessage: ((e: { data: unknown }) => void) | null;
    postMessage(msg: unknown, transfer?: unknown[]): void;
    close(): void;
}

const posted: any[] = [];
let fakeSelf: FakeSelf;

function bars(closes: number[], fromIndex = 0) {
    return closes.map((close, i) => ({
        ts: BigInt(fromIndex + i) * MINUTE_NS,
        open: close,
        high: close,
        low: close,
        close,
        volume: 1,
    }));
}

// the worker answers off a promise chain, and a wasm plugin's first message
// waits on a compile - so wait for the reply rather than guessing at a delay
async function send(msg: unknown, expect: 'parsed' | 'update' | 'error') {
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

function parse(script: string) {
    return send({ type: 'parse', script }, 'parsed');
}

function runInit(data: unknown, params: Record<string, unknown>, expect: 'update' | 'error') {
    return send({ type: 'run-init', pluginIndex: 0, data, barNs: MINUTE_NS, params }, expect);
}

before(async () => {
    fakeSelf = {
        onmessage: null,
        postMessage: (msg: unknown) => posted.push(msg),
        close: () => {},
    };
    (globalThis as any).self = fakeSelf;

    (globalThis as any).fetch = async (url: string) => {
        if (String(url) !== WASM_URL) {
            return { ok: false, status: 404, statusText: 'Not Found' } as Response;
        }
        const bytes = readFileSync(WASM_PATH);
        return {
            ok: true,
            arrayBuffer: async () =>
                bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        } as Response;
    };

    await import('./script.worker');
});

const WASM_SCRIPT = `
const p = plugin({
    name: "SMA wasm",
    type: PluginType.indicator,
    params: { period: { label: 'Period', type: 'number', default: 3 } },
})
p.wasm = ${JSON.stringify(WASM_URL)}
p.draw = (values) => [{ type: 'line', pts: Array.from(values ?? []) }]
`;

// sma.c emits two interleaved doubles per bar: the value, then its timestamp
function values(out: Float64Array): number[] {
    return Array.from(out).filter((_, i) => i % 2 === 0);
}

describe('scripted plugin, wasm backed', () => {
    it('computes through the module and draws from what it returned', async () => {
        const parsed = await parse(WASM_SCRIPT);
        assert.equal(parsed.plugins[0].wasmUrl, WASM_URL);

        const result = await runInit(
            { ohlcv: bars([1, 2, 3, 4, 5]), trades: [] },
            { period: 3 },
            'update',
        );
        const state = result.state as Float64Array;
        assert.equal(state.length, 10);
        assert.deepEqual(values(state).slice(2), [2, 3, 4]);
        // draw() still runs in JS, over whatever the module handed back
        assert.equal(result.drawCommands[0].pts.length, 10);
    });

    it('appends the update slice instead of replacing the series', async () => {
        await parse(WASM_SCRIPT);
        await runInit({ ohlcv: bars([1, 2, 3, 4, 5]), trades: [] }, { period: 3 }, 'update');

        const result = await send(
            {
                type: 'update',
                pluginIndex: 0,
                data: { ohlcv: bars([1, 2, 3, 4, 5, 6, 7]), trades: [] },
                newData: { ohlcv: bars([6, 7], 5), trades: [] },
                barNs: MINUTE_NS,
                horizon: 0n,
                params: { period: 3 },
            },
            'update',
        );

        // the module only produced the two new rows, but state has to carry all
        // seven - the worker is what keeps the whole series together
        assert.equal((result.points as Float64Array).length, 2 * 2);
        const state = result.state as Float64Array;
        assert.equal(state.length, 7 * 2);
        assert.equal(result.drawCommands[0].pts.length, 7 * 2);

        // and the rows still line up after the concatenation, which is the whole
        // reason the module interleaves rather than emitting two half-blocks
        assert.deepEqual(values(state).slice(2), [2, 3, 4, 5, 6]);
        assert.deepEqual(
            Array.from(state).filter((_, i) => i % 2 === 1),
            [0, 60_000, 120_000, 180_000, 240_000, 300_000, 360_000],
        );
    });

    it('passes the declared params through to the module', async () => {
        await parse(WASM_SCRIPT);
        const result = await runInit(
            { ohlcv: bars([10, 20, 30]), trades: [] },
            { period: 2 },
            'update',
        );
        assert.deepEqual(values(result.state as Float64Array).slice(1), [15, 25]);
    });

    it('lets a script reshape the module output in init()', async () => {
        await parse(`
            const p = plugin({ name: "Shaped", type: PluginType.indicator })
            p.wasm = ${JSON.stringify(WASM_URL)}
            p.init = ({ data, wasm }) => ({ count: wasm.length, bars: data.ohlcv.length })
            p.draw = (s) => [{ type: 'line', pts: [s.count, s.bars] }]
        `);
        const result = await runInit({ ohlcv: bars([1, 2, 3, 4]), trades: [] }, {}, 'update');
        assert.deepEqual(result.state, { count: 8, bars: 4 });
    });

    it('reports a module that will not load as a plugin error', async () => {
        await parse(`
            const p = plugin({ name: "Missing", type: PluginType.indicator })
            p.wasm = "https://example.test/nope.wasm"
        `);
        const error = await runInit({ ohlcv: bars([1, 2]), trades: [] }, {}, 'error');
        assert.match(error.error, /could not load/);
    });
});

describe('scripted plugin, plain js', () => {
    it('still runs init and draw with no wasm in sight', async () => {
        await parse(`
            const p = plugin({ name: "JS", type: PluginType.indicator })
            p.init = ({ data, params }) => ({ n: data.ohlcv.length, period: params.period })
            p.draw = (s) => [{ type: 'line', pts: [s.n, s.period] }]
        `);
        const result = await runInit({ ohlcv: bars([1, 2, 3]), trades: [] }, { period: 9 }, 'update');
        assert.deepEqual(result.state, { n: 3, period: 9 });
        assert.deepEqual(result.drawCommands[0].pts, [3, 9]);
    });

    it('falls back to re-running init when a script defines no update', async () => {
        await parse(`
            const p = plugin({ name: "JS", type: PluginType.indicator })
            p.init = ({ data }) => ({ n: data.ohlcv.length })
        `);
        const result = await send(
            {
                type: 'update',
                pluginIndex: 0,
                data: { ohlcv: bars([1, 2, 3, 4]), trades: [] },
                newData: { ohlcv: bars([4]), trades: [] },
                barNs: MINUTE_NS,
                horizon: 0n,
                params: {},
            },
            'update',
        );
        assert.deepEqual(result.state, { n: 4 });
    });
});
