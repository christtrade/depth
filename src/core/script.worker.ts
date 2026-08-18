// one worker per scripted plugin. the whole user script is eval'd once into a
// single shared closure, so top-level consts and helper functions are visible to
// init(), update() and draw() the same way they would be in a module.
//
// draw() returns plain serializable DrawCommands which the main thread runs on
// canvas, so pan/zoom redraws never round-trip through here.
//
// protocol, main -> worker:
//   parse     { script }                         -> { plugins: [...] }
//   run-init  { pluginIndex, data, barNs, params } -> { points, state, drawCommands }
//   update    { pluginIndex, data, newData, barNs, horizon, params }
//                                                -> { points, state, drawCommands }
//   destroy                                      -> self.close()
//
// parse evals the script and reports what each plugin declared. run-init then
// calls init() and draw() without re-evaluating, so the closure survives.
//
// a plugin that sets p.wasm runs a compiled module in place of its init/update
// (see WasmPluginHost). that makes handling a message async, so everything but
// destroy goes through one promise chain - otherwise an update could overtake
// the run-init it depends on.

import { STDLIB } from '../lib/indicator-stdlib';
import { PluginType, DataLevel, Layout } from './script-dsl';
import { evictWasmModule, instantiateWasmPlugin, type WasmPlugin } from './WasmPluginHost';

// were in a worker so theres no DOM to escape to, but shadow the network APIs to
// stop exfiltration. dont freeze it, the user needs mutable top-level vars.

function buildScope(pluginDecl: (d: unknown) => void): Record<string, unknown> {
    const scope: Record<string, unknown> = {
        PluginType,
        DataLevel,
        Layout,
        Math,
        console,
        plugin: pluginDecl,
        // worker-side code never fetches - network goes through ctx.fetch on the
        // main thread, which is gated on the manifest's declared origins. leaving
        // the global reachable here routes straight around that gate.
        fetch: undefined,
        XMLHttpRequest: undefined,
        WebSocket: undefined,
        importScripts: undefined,
    };
    for (const [k, v] of Object.entries(STDLIB)) scope[k] = v;
    return scope;
}

interface PluginEntry {
    decl: any;
    // run in the worker
    init: ((input: any) => unknown) | null;
    update: ((input: any) => { points: unknown; state: unknown }) | null;
    draw: ((state: unknown) => unknown[]) | null;
    drawUISrc: string | null;
    onInstallSrc: string | null;
    extensionDrawSrc: string | null;
    wasmUrl: string | null;
    wasm: Promise<WasmPlugin> | null;
    /** Everything the module has produced so far, when nothing in JS owns it. */
    wasmSeries: Float64Array | null;
    state: unknown;
    // main-thread side, serialized across as src strings
    drawDirectSrc: string | null;
    onRenderSrc: string | null;
    onHitTestSrc: string | null;
    onPreviewSrc: string | null;
    onMoveSrc: string | null;
    onPointerDownSrc: string | null;
    onPointerMoveSrc: string | null;
    onPointerUpSrc: string | null;
    onKeyDownSrc: string | null;
    onActivateSrc: string | null;
    onDeactivateSrc: string | null;
    // chart-type specific
    onDrawSrc: string | null;
    onGetAutoYBoundsSrc: string | null;
    onChartPointerDownSrc: string | null;
    onChartPointerMoveSrc: string | null;
    onChartPointerUpSrc: string | null;
    onChartKeyDownSrc: string | null;
    onChartActivateSrc: string | null;
    onChartDeactivateSrc: string | null;
    onBarHoverSrc: string | null;
    getTooltipSrc: string | null;
}

function evalScript(src: string): PluginEntry[] {
    const entries: PluginEntry[] = [];

    function pluginFn(decl: unknown) {
        const entry: PluginEntry = {
            decl,
            state: {},
            init: null,
            update: null,
            draw: null,
            wasmUrl: null,
            wasm: null,
            wasmSeries: null,
            drawUISrc: null,
            onInstallSrc: null,
            extensionDrawSrc: null,
            drawDirectSrc: null,
            onRenderSrc: null,
            onHitTestSrc: null,
            onPreviewSrc: null,
            onMoveSrc: null,
            onPointerDownSrc: null,
            onPointerMoveSrc: null,
            onPointerUpSrc: null,
            onKeyDownSrc: null,
            onActivateSrc: null,
            onDeactivateSrc: null,
            onDrawSrc: null,
            onGetAutoYBoundsSrc: null,
            onChartPointerDownSrc: null,
            onChartPointerMoveSrc: null,
            onChartPointerUpSrc: null,
            onChartKeyDownSrc: null,
            onChartActivateSrc: null,
            onChartDeactivateSrc: null,
            onBarHoverSrc: null,
            getTooltipSrc: null,
        };
        entries.push(entry);

        // a proxy-ish object so the user can do p.onRender = fn - we capture the
        // assignment and store it on the entry. shared names like onPointerDown
        // write to both the drawing and chart-type fields, and the capability
        // handler on the main thread reads only its own.
        const builder = {
            set init(fn: Function) {
                entry.init = fn as any;
            },
            set update(fn: Function) {
                entry.update = fn as any;
            },
            set draw(fn: Function) {
                entry.draw = fn as any;
                entry.onDrawSrc = fn.toString();
            },
            set drawUI(fn: Function) {
                entry.drawUISrc = fn.toString();
            },
            set wasm(url: string) {
                entry.wasmUrl = url;
            },
            set onInstall(fn: Function) {
                entry.onInstallSrc = fn.toString();
            },
            set panel(fn: Function) {
                entry.extensionDrawSrc = fn.toString();
            },
            set drawDirect(fn: Function) {
                entry.drawDirectSrc = fn.toString();
            },
            // drawing-specific
            set onRender(fn: Function) {
                entry.onRenderSrc = fn.toString();
            },
            set onHitTest(fn: Function) {
                entry.onHitTestSrc = fn.toString();
            },
            set onPreview(fn: Function) {
                entry.onPreviewSrc = fn.toString();
            },
            set onMove(fn: Function) {
                entry.onMoveSrc = fn.toString();
            },
            // shared, stored in both fields, each capability reads its own
            set onPointerDown(fn: Function) {
                entry.onPointerDownSrc = fn.toString();
                entry.onChartPointerDownSrc = fn.toString();
            },
            set onPointerMove(fn: Function) {
                entry.onPointerMoveSrc = fn.toString();
                entry.onChartPointerMoveSrc = fn.toString();
            },
            set onPointerUp(fn: Function) {
                entry.onPointerUpSrc = fn.toString();
                entry.onChartPointerUpSrc = fn.toString();
            },
            set onKeyDown(fn: Function) {
                entry.onKeyDownSrc = fn.toString();
                entry.onChartKeyDownSrc = fn.toString();
            },
            set onActivate(fn: Function) {
                entry.onActivateSrc = fn.toString();
                entry.onChartActivateSrc = fn.toString();
            },
            set onDeactivate(fn: Function) {
                entry.onDeactivateSrc = fn.toString();
                entry.onChartDeactivateSrc = fn.toString();
            },
            // chart-type exclusive
            set getAutoYBounds(fn: Function) {
                entry.onGetAutoYBoundsSrc = fn.toString();
            },
            set onBarHover(fn: Function) {
                entry.onBarHoverSrc = fn.toString();
            },
            set getTooltip(fn: Function) {
                entry.getTooltipSrc = fn.toString();
            },
        };
        return builder;
    }

    const scope = buildScope(pluginFn);
    const keys = Object.keys(scope);
    const values = keys.map((k) => scope[k]);
    new Function(...keys, `"use strict";\n${src}`)(...values);

    // the init -> update shorthand, per entry. params have to be forwarded or a
    // plugin that only defines init() silently loses its settings on the first
    // horizon tick and falls back to whatever its init hardcoded.
    for (const e of entries) {
        if (!e.update && e.init) {
            const initFn = e.init;
            e.update = ({ data, barNs, params }) => {
                const state = initFn({ data, barNs, params });
                return { points: state, state };
            };
        }
    }

    return entries;
}

let entries: PluginEntry[] = [];

// update() only ever hands back what it just produced, so for a plugin with no
// JS of its own the worker is what keeps the whole series together
function appendSeries(prev: Float64Array | null, next: Float64Array | null): Float64Array {
    if (!prev?.length) return next ?? new Float64Array(0);
    if (!next?.length) return prev;
    const out = new Float64Array(prev.length + next.length);
    out.set(prev, 0);
    out.set(next, prev.length);
    return out;
}

// a reparse is someone editing the script, which is exactly when theyd want the
// .wasm they just rebuilt, so the compile cache is dropped for it
function startWasm(entry: PluginEntry, index: number): void {
    if (!entry.wasmUrl) return;
    evictWasmModule(entry.wasmUrl);
    entry.wasm = instantiateWasmPlugin(entry.wasmUrl, entry.decl?.name ?? `plugin ${index}`);
    // the rejection is reported when a compute awaits it, but an unhandled one
    // would take the worker down first
    entry.wasm.catch(() => {});
}

async function runWasm(
    entry: PluginEntry,
    kind: 'init' | 'update',
    data: any,
    barNs: bigint,
    params: Record<string, unknown>,
): Promise<Float64Array | null> {
    const wasm = await entry.wasm!;
    const bars = data?.ohlcv ?? [];
    const trades = data?.trades ?? [];

    if (kind === 'init') {
        wasm.setParams(params);
        return wasm.init(bars, trades, barNs);
    }
    // without an update export theres no incremental path, so the whole window
    // goes through init again - correct, just slower
    if (!wasm.hasUpdate) return wasm.init(bars, trades, barNs);
    return wasm.update(bars, trades, barNs);
}

self.onmessage = (e: MessageEvent) => {
    const msg = e.data as any;

    if (msg.type === 'destroy') {
        self.close();
        return;
    }

    chain = chain.then(() => handle(msg)).catch(postError);
};

// messages arrive in order and have to be answered in order, but a wasm plugin
// cant answer without awaiting its module first
let chain: Promise<void> = Promise.resolve();

async function handle(msg: any): Promise<void> {
    if (msg.type === 'parse') {
        entries = evalScript(msg.script ?? '');
        entries.forEach(startWasm);
        self.postMessage({
            type: 'parsed', // a different type so it wont retrigger onWorkerInit
            plugins: entries.map((e, i) => ({
                index: i,
                decl: e.decl,
                drawDirectSrc: e.drawDirectSrc,
                drawUISrc: e.drawUISrc,
                wasmUrl: e.wasmUrl,
                onInstallSrc: e.onInstallSrc,
                extensionDrawSrc: e.extensionDrawSrc,
                onRenderSrc: e.onRenderSrc,
                onHitTestSrc: e.onHitTestSrc,
                onPreviewSrc: e.onPreviewSrc,
                onMoveSrc: e.onMoveSrc,
                onPointerDownSrc: e.onPointerDownSrc,
                onPointerMoveSrc: e.onPointerMoveSrc,
                onPointerUpSrc: e.onPointerUpSrc,
                onKeyDownSrc: e.onKeyDownSrc,
                onActivateSrc: e.onActivateSrc,
                onDeactivateSrc: e.onDeactivateSrc,
                onDrawSrc: e.onDrawSrc,
                onGetAutoYBoundsSrc: e.onGetAutoYBoundsSrc,
                onChartPointerDownSrc: e.onChartPointerDownSrc,
                onChartPointerMoveSrc: e.onChartPointerMoveSrc,
                onChartPointerUpSrc: e.onChartPointerUpSrc,
                onChartKeyDownSrc: e.onChartKeyDownSrc,
                onChartActivateSrc: e.onChartActivateSrc,
                onChartDeactivateSrc: e.onChartDeactivateSrc,
                onBarHoverSrc: e.onBarHoverSrc,
                getTooltipSrc: e.getTooltipSrc,
            })),
        });
        return;
    }

    if (msg.type === 'run-init') {
        // calls init() on entries that are already parsed, without re-evaluating.
        // used after a parse completes so re-running evalScript doesnt throw away
        // the closure we just built.
        try {
            const entry = entries[msg.pluginIndex];
            if (!entry) return;
            const params = msg.params ?? {};

            if (entry.wasmUrl) {
                const out = await runWasm(entry, 'init', msg.data, msg.barNs, params);
                entry.wasmSeries = out;
                // a script can still define init() to shape the numbers into
                // whatever draw() wants. without one the module's output is it.
                entry.state = entry.init
                    ? entry.init({ data: msg.data, barNs: msg.barNs, params, wasm: out })
                    : out;
            } else {
                entry.state = entry.init
                    ? entry.init({ data: msg.data, barNs: msg.barNs, params })
                    : {};
            }

            const drawCommands =
                entry.draw && entry.decl?.type !== 'chart-type'
                    ? (entry.draw(entry.state) ?? [])
                    : [];
            self.postMessage({
                type: 'update',
                pluginIndex: msg.pluginIndex,
                points: entry.state,
                state: entry.state,
                drawCommands,
            });
        } catch (err) {
            postError(err);
        }
        return;
    }

    if (msg.type === 'update') {
        const entry = entries[msg.pluginIndex];
        if (!entry) return;
        if (!entry.update && !entry.wasmUrl) return;
        try {
            const params = msg.params ?? {};
            let result: { points: unknown; state: unknown };

            if (entry.wasmUrl) {
                // the module gets only what arrived since last time, unless it
                // has no update export and runWasm falls back to the full window
                const wasm = await entry.wasm!;
                const slice = await runWasm(
                    entry,
                    'update',
                    wasm.hasUpdate ? msg.newData : msg.data,
                    msg.barNs ?? 0n,
                    params,
                );
                entry.wasmSeries = wasm.hasUpdate
                    ? appendSeries(entry.wasmSeries, slice)
                    : slice;

                if (entry.update) {
                    result = entry.update({
                        data: msg.data ?? {},
                        newData: msg.newData ?? {},
                        state: entry.state,
                        barNs: msg.barNs ?? 0n,
                        horizon: msg.horizon ?? 0n,
                        params,
                        wasm: slice,
                    } as any);
                } else {
                    // draw() redraws the whole series every time, so it needs all
                    // of it - the slice on its own would erase the history
                    result = { points: slice, state: entry.wasmSeries };
                }
            } else {
                result = entry.update!({
                    data: msg.data ?? {},
                    newData: msg.newData ?? {},
                    state: entry.state,
                    barNs: msg.barNs ?? 0n,
                    horizon: msg.horizon ?? 0n,
                    params,
                });
            }

            entry.state = result.state;
            const drawCommands =
                entry.draw && entry.decl?.type !== 'chart-type'
                    ? (entry.draw(entry.state) ?? [])
                    : [];

            const transferables: Transferable[] = [];
            // a typed array is the wasm path's own output and gets structure-
            // cloned; walking its values would build a plain array per tick
            if (
                result.points &&
                typeof result.points === 'object' &&
                !ArrayBuffer.isView(result.points)
            ) {
                for (const v of Object.values(result.points as Record<string, unknown>))
                    if (v instanceof ArrayBuffer) transferables.push(v);
            }
            (self as any).postMessage(
                {
                    type: 'update',
                    pluginIndex: msg.pluginIndex,
                    points: result.points,
                    state: entry.state,
                    drawCommands,
                },
                transferables,
            );
        } catch (err) {
            postError(err);
        }
        return;
    }
}

function postError(err: unknown): void {
    const e = err instanceof Error ? err : new Error(String(err));
    const line = e.stack?.match(/<anonymous>:(\d+)/);
    self.postMessage({ type: 'error', error: e.message, line: line ? +line[1] : undefined });
}
