// The wasm half of a scripted plugin. Setting `p.wasm = url` in a script swaps
// the worker's JS init/update for a compiled module's, so the number crunching
// runs as machine code while draw() stays in JS. This runs inside that plugin's
// own script worker - one instance per plugin, so a module's globals are its
// state and nothing has to be threaded back in.
//
// The module has to export:
//
//   memory
//   alloc(bytes) -> ptr                  8-aligned
//   dealloc(ptr, bytes)
//   init(bars, barRows, trades, tradeRows, barMs) -> ptr
//   update(bars, barRows, trades, tradeRows, barMs) -> ptr    optional
//   set_params(ptr, bytes)                                    optional, utf8 json
//
// A bar row is 6 doubles - ts(ms), open, high, low, close, volume. A trade row
// is 4 - ts(ms), price, size, side (0 buy, 1 sell). Whichever the plugin doesnt
// care about arrives as a null pointer and a zero count.
//
// A returned pointer is an i32 count, 4 bytes of padding so the doubles land
// 8-aligned, then that many doubles. 0 means it produced nothing.
//
// See src/docs/plugin-wasm.txt for the guest side, and examples/wasm/sma.c for a
// module that implements all of it in 120 lines.

const BAR_STRIDE = 6;
const TRADE_STRIDE = 4;
const FLOAT64_BYTES = 8;
/** i32 count + 4 bytes of padding, so the payload is 8-aligned. */
const RESULT_HEADER_BYTES = 8;

export interface WasmPluginExports {
    memory: WebAssembly.Memory;
    alloc(bytes: number): number;
    dealloc(ptr: number, bytes: number): void;
    init(
        barsPtr: number,
        barRows: number,
        tradesPtr: number,
        tradeRows: number,
        barMs: number,
    ): number;
    update?(
        barsPtr: number,
        barRows: number,
        tradesPtr: number,
        tradeRows: number,
        barMs: number,
    ): number;
    set_params?(ptr: number, bytes: number): void;
}

export interface WasmBar {
    ts: bigint | number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export interface WasmTrade {
    ts: bigint | number;
    price: number;
    size: number;
    side: string;
}

// plugins are handed nanoseconds, but ms is what crosses the boundary: it stays
// exact in a double for another 285,000 years, where ns starts rounding the
// moment it passes 2^53
function toMs(ts: bigint | number): number {
    return typeof ts === 'bigint' ? Number(ts / 1_000_000n) : Math.floor(ts / 1e6);
}

export class WasmPlugin {
    constructor(
        private readonly exports: WasmPluginExports,
        private readonly pluginId: string,
    ) {}

    /** Without one, every horizon tick re-runs init over the full window. */
    get hasUpdate(): boolean {
        return typeof this.exports.update === 'function';
    }

    /** Hands the plugin's declared params over as JSON. No-op if it takes none. */
    setParams(params: Record<string, unknown>): void {
        const setParams = this.exports.set_params;
        if (!setParams) return;
        const bytes = new TextEncoder().encode(JSON.stringify(params ?? {}));
        if (!bytes.length) return;
        const ptr = this.alloc(bytes.length);
        new Uint8Array(this.exports.memory.buffer, ptr, bytes.length).set(bytes);
        setParams(ptr, bytes.length);
        this.exports.dealloc(ptr, bytes.length);
    }

    init(bars: WasmBar[], trades: WasmTrade[], barNs: bigint): Float64Array | null {
        return this.call(this.exports.init, bars, trades, barNs);
    }

    update(bars: WasmBar[], trades: WasmTrade[], barNs: bigint): Float64Array | null {
        const update = this.exports.update;
        if (!update) return null;
        return this.call(update, bars, trades, barNs);
    }

    private alloc(bytes: number): number {
        const ptr = this.exports.alloc(bytes);
        if (!ptr) throw new Error(`[wasm:${this.pluginId}] alloc(${bytes}) returned null`);
        return ptr;
    }

    private call(
        fn: WasmPluginExports['init'],
        bars: WasmBar[],
        trades: WasmTrade[],
        barNs: bigint,
    ): Float64Array | null {
        const barBytes = bars.length * BAR_STRIDE * FLOAT64_BYTES;
        const tradeBytes = trades.length * TRADE_STRIDE * FLOAT64_BYTES;

        // both allocations first: growing memory detaches every view we hold, so
        // nothing may be written until the last alloc is done
        const barsPtr = barBytes ? this.alloc(barBytes) : 0;
        const tradesPtr = tradeBytes ? this.alloc(tradeBytes) : 0;

        if (barsPtr) {
            const mem = new Float64Array(
                this.exports.memory.buffer,
                barsPtr,
                bars.length * BAR_STRIDE,
            );
            for (let i = 0; i < bars.length; i++) {
                const bar = bars[i];
                const at = i * BAR_STRIDE;
                mem[at] = toMs(bar.ts);
                mem[at + 1] = bar.open;
                mem[at + 2] = bar.high;
                mem[at + 3] = bar.low;
                mem[at + 4] = bar.close;
                mem[at + 5] = bar.volume;
            }
        }

        if (tradesPtr) {
            const mem = new Float64Array(
                this.exports.memory.buffer,
                tradesPtr,
                trades.length * TRADE_STRIDE,
            );
            for (let i = 0; i < trades.length; i++) {
                const trade = trades[i];
                const at = i * TRADE_STRIDE;
                mem[at] = toMs(trade.ts);
                mem[at + 1] = trade.price;
                mem[at + 2] = trade.size;
                mem[at + 3] = trade.side === 'B' ? 0 : 1;
            }
        }

        const resultPtr = fn(barsPtr, bars.length, tradesPtr, trades.length, Number(barNs) / 1e6);
        const result = this.readResult(resultPtr);

        // reverse order, so a bump allocator gets its space back
        if (tradesPtr) this.exports.dealloc(tradesPtr, tradeBytes);
        if (barsPtr) this.exports.dealloc(barsPtr, barBytes);

        return result;
    }

    private readResult(ptr: number): Float64Array | null {
        if (!ptr) return null;
        const buffer = this.exports.memory.buffer;
        const count = new DataView(buffer).getUint32(ptr, true);
        if (!count) return new Float64Array(0);

        const end = ptr + RESULT_HEADER_BYTES + count * FLOAT64_BYTES;
        if (end > buffer.byteLength) {
            throw new Error(
                `[wasm:${this.pluginId}] result claims ${count} doubles, which runs past the end of memory`,
            );
        }
        // a copy: the next call into the module is free to reuse that buffer
        return new Float64Array(buffer, ptr + RESULT_HEADER_BYTES, count).slice();
    }
}

// Compiling costs 50-200ms, so modules are cached by url and plugins sharing a
// .wasm only pay it once. The promise is what's cached, or two plugins starting
// together would both fetch. Each still gets its own instance, with its own
// memory and its own state.
const compiled = new Map<string, Promise<WebAssembly.Module>>();

export async function instantiateWasmPlugin(
    wasmUrl: string,
    pluginId: string,
): Promise<WasmPlugin> {
    let pending = compiled.get(wasmUrl);
    if (!pending) {
        pending = fetch(wasmUrl).then(async (res) => {
            if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
            return WebAssembly.compile(await res.arrayBuffer());
        });
        compiled.set(wasmUrl, pending);
    }

    let module: WebAssembly.Module;
    try {
        module = await pending;
    } catch (err) {
        // dont let one bad fetch poison the url for the rest of the session
        compiled.delete(wasmUrl);
        throw new Error(`[wasm:${pluginId}] could not load ${wasmUrl}: ${err}`);
    }

    // filled in below - log_str needs the memory it is about to be given
    let instance: WebAssembly.Instance | null = null;
    const imports: WebAssembly.Imports = {
        env: {
            log(ptr: number, len: number) {
                const memory = (instance!.exports as { memory: WebAssembly.Memory }).memory;
                const bytes = new Uint8Array(memory.buffer, ptr, len);
                console.log(`[wasm:${pluginId}]`, new TextDecoder().decode(bytes));
            },
            abort() {
                throw new Error(`[wasm:${pluginId}] called abort()`);
            },
        },
    };

    instance = await WebAssembly.instantiate(module, imports);
    const exports = instance.exports as unknown as WasmPluginExports;

    for (const required of ['memory', 'alloc', 'dealloc', 'init'] as const) {
        if (!exports[required]) {
            throw new Error(`[wasm:${pluginId}] ${wasmUrl} does not export '${required}'`);
        }
    }

    return new WasmPlugin(exports, pluginId);
}

/** Drops a module from the compile cache, so the next load refetches it. */
export function evictWasmModule(wasmUrl: string): void {
    compiled.delete(wasmUrl);
}
