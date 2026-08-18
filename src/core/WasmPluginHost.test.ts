import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, before, after } from 'node:test';

import {
    WasmPlugin,
    evictWasmModule,
    instantiateWasmPlugin,
    type WasmPluginExports,
} from './WasmPluginHost';

// examples/wasm/sma.c, built with the command in its header. it implements the
// whole ABI, so the host is checked against a real module rather than a mock.
const WASM_PATH = fileURLToPath(new URL('../../examples/wasm/sma.wasm', import.meta.url));
const WASM_URL = 'https://example.test/sma.wasm';

const MINUTE_NS = 60_000_000_000n;

function bars(closes: number[]) {
    return closes.map((close, i) => ({
        ts: BigInt(i) * MINUTE_NS,
        open: close,
        high: close,
        low: close,
        close,
        volume: 1,
    }));
}

async function loadDirect(): Promise<WasmPlugin> {
    const module = await WebAssembly.compile(readFileSync(WASM_PATH));
    const instance = await WebAssembly.instantiate(module, {
        env: { log: () => {}, abort: () => { throw new Error('abort'); } },
    });
    return new WasmPlugin(instance.exports as unknown as WasmPluginExports, 'test');
}

// sma.c emits two interleaved doubles per bar: the value, then its timestamp
function values(out: Float64Array): number[] {
    return Array.from(out).filter((_, i) => i % 2 === 0);
}

function timestamps(out: Float64Array): number[] {
    return Array.from(out).filter((_, i) => i % 2 === 1);
}

describe('wasm plugin host', () => {
    it('runs a full compute and reads the doubles back out', async () => {
        const plugin = await loadDirect();
        plugin.setParams({ period: 3 });

        const out = plugin.init(bars([1, 2, 3, 4, 5]), [], MINUTE_NS);
        assert.ok(out);
        assert.equal(out.length, 10);

        const sma = values(out);
        // the first two are NaN - the window isn't full yet
        assert.ok(Number.isNaN(sma[0]) && Number.isNaN(sma[1]));
        assert.deepEqual(sma.slice(2), [2, 3, 4]);
        // ms on this side of the boundary, not the ns the plugin was handed
        assert.deepEqual(timestamps(out), [0, 60_000, 120_000, 180_000, 240_000]);
    });

    it('picks the params up before init, not after', async () => {
        const plugin = await loadDirect();
        plugin.setParams({ period: 2 });
        const out = plugin.init(bars([10, 20, 30]), [], MINUTE_NS)!;
        assert.deepEqual(values(out).slice(1), [15, 25]);
    });

    it('carries state across an incremental update', async () => {
        const plugin = await loadDirect();
        plugin.setParams({ period: 3 });
        plugin.init(bars([1, 2, 3, 4, 5]), [], MINUTE_NS);

        // the module gets only the new bars and answers with only the new values
        const next = plugin.update(bars([6, 7]), [], MINUTE_NS);
        assert.ok(next);
        assert.deepEqual(values(next), [5, 6]);
    });

    it('reports an update export', async () => {
        assert.equal((await loadDirect()).hasUpdate, true);
    });

    it('hands back an empty block rather than null when there is nothing', async () => {
        const plugin = await loadDirect();
        plugin.init(bars([1, 2, 3]), [], MINUTE_NS);
        const next = plugin.update([], [], MINUTE_NS);
        assert.ok(next);
        assert.equal(next.length, 0);
    });

    it('survives more rows than one memory page holds', async () => {
        const plugin = await loadDirect();
        plugin.setParams({ period: 10 });
        const closes = Array.from({ length: 20000 }, (_, i) => i + 1);
        const out = plugin.init(bars(closes), [], MINUTE_NS)!;
        assert.equal(out.length, 40000);
        // sma of 10 consecutive integers ending at n is n - 4.5
        assert.equal(values(out)[19999], 20000 - 4.5);
    });
});

describe('wasm module loading', () => {
    const realFetch = globalThis.fetch;
    let requests = 0;

    before(() => {
        globalThis.fetch = (async (url: string) => {
            requests++;
            if (!String(url).endsWith('sma.wasm')) {
                return { ok: false, status: 404, statusText: 'Not Found' } as Response;
            }
            const bytes = readFileSync(WASM_PATH);
            return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } as Response;
        }) as typeof fetch;
    });

    after(() => {
        globalThis.fetch = realFetch;
    });

    it('compiles once and hands every plugin its own instance', async () => {
        evictWasmModule(WASM_URL);
        requests = 0;

        const [a, b] = await Promise.all([
            instantiateWasmPlugin(WASM_URL, 'a'),
            instantiateWasmPlugin(WASM_URL, 'b'),
        ]);
        assert.equal(requests, 1, 'two plugins on one url should share the compile');

        // separate memories, so one plugin's state cannot leak into the other's
        a.setParams({ period: 2 });
        b.setParams({ period: 4 });
        const outA = a.init(bars([1, 2, 3, 4]), [], MINUTE_NS)!;
        const outB = b.init(bars([1, 2, 3, 4]), [], MINUTE_NS)!;
        assert.equal(values(outA)[3], 3.5);
        assert.equal(values(outB)[3], 2.5);
    });

    it('does not cache a failed fetch', async () => {
        const bad = 'https://example.test/missing.wasm';
        await assert.rejects(() => instantiateWasmPlugin(bad, 'x'), /could not load/);
        await assert.rejects(() => instantiateWasmPlugin(bad, 'x'), /could not load/);
        assert.ok(requests >= 2, 'the second attempt should refetch');
    });
});
