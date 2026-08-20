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

import { buildScriptScope, defaultStrategyDraw } from './script-runtime';
import { StrategyEngine, type StrategyBar, type StrategyConfig } from './strategy-runtime';
import { checkSweepBudget, splitIndex } from './strategy-sweep';
import { planWalkForward } from './strategy-walkforward';
import { evictWasmModule, instantiateWasmPlugin, type WasmPlugin } from './WasmPluginHost';

// were in a worker so theres no DOM to escape to, but shadow the network APIs to
// stop exfiltration. dont freeze it, the user needs mutable top-level vars.
//
// the scope itself is built in script-runtime.ts, shared with the main-thread
// compiler and the server-side strategy runner - a script that parses in one and
// throws in another is the worst bug this system can have, so there is one
// builder and the hosts differ only by its options.

function buildScope(pluginDecl: (d: unknown) => void): Record<string, unknown> {
    return buildScriptScope({ plugin: pluginDecl, shadowNetwork: true });
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
        // a strategy's update() is per-bar and takes a broker, so the indicator
        // shorthand would call it with the wrong shape entirely
        if (e.decl?.type === 'strategy') continue;
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

// Strategy execution
const DEFAULT_STRATEGY_LOOKBACK = 200;
const MAX_LOCAL_STRATEGY_BARS = 2_000_000;

let sweepCancelled = false;

async function runSweep(
    entry: PluginEntry,
    pluginIndex: number,
    msg: any,
): Promise<void> {
    const bars: StrategyBar[] = msg.data?.ohlcv ?? [];
    const grid: Array<Record<string, unknown>> = msg.grid ?? [];
    const base: Record<string, unknown> = msg.params ?? {};
    const barNs: bigint = msg.barNs ?? 0n;

    const budget = checkSweepBudget(grid.length, bars.length);
    if (!budget.ok) {
        self.postMessage({
            type: 'sweep-rejected',
            pluginIndex,
            name: entry.decl?.name ?? 'Strategy',
            ...budget,
        });
        return;
    }

    const cut = splitIndex(bars.length, msg.oosFraction);
    const inSampleBars = cut === null ? null : bars.slice(0, cut);
    const outOfSampleBars = cut === null ? null : bars.slice(cut);

    const results: unknown[] = [];
    sweepCancelled = false;

    for (let i = 0; i < grid.length; i++) {
        if (sweepCancelled) {
            self.postMessage({ type: 'sweep-cancelled', pluginIndex, done: i });
            return;
        }

        const params = { ...base, ...grid[i] };

        try {
            const full = scoreOnce(entry, bars, barNs, params, msg.symbolInfo);
            const result: Record<string, unknown> = { params: grid[i], stats: full };

            if (inSampleBars && outOfSampleBars) {
                result.inSample = scoreOnce(entry, inSampleBars, barNs, params, msg.symbolInfo);
                result.outOfSample = scoreOnce(
                    entry,
                    outOfSampleBars,
                    barNs,
                    params,
                    msg.symbolInfo,
                );
            }

            results.push(result);
        } catch (err) {
            // one bad combination must not lose the other 999 - record it as a
            // hole and carry on
            results.push({
                params: grid[i],
                error: err instanceof Error ? err.message : String(err),
            });
        }

        // every 10, and always on the last one
        if (i % 10 === 9 || i === grid.length - 1) {
            self.postMessage({
                type: 'sweep-progress',
                pluginIndex,
                done: i + 1,
                total: grid.length,
            });
            // hand the event loop back so a cancel can be delivered
            await new Promise((r) => setTimeout(r, 0));
        }
    }

    self.postMessage({ type: 'sweep-done', pluginIndex, results });
}

async function runWalkForward(entry: PluginEntry, pluginIndex: number, msg: any): Promise<void> {
    const bars: StrategyBar[] = msg.data?.ohlcv ?? [];
    const grid: Array<Record<string, unknown>> = msg.grid ?? [];
    const base: Record<string, unknown> = msg.params ?? {};
    const barNs: bigint = msg.barNs ?? 0n;
    const objective: string = msg.objective ?? 'netPnl';
    const higherIsBetter: boolean = msg.higherIsBetter ?? true;

    const plan = planWalkForward(bars.length, {
        windows: msg.windows ?? 4,
        isMultiple: msg.isMultiple ?? 3,
        anchored: !!msg.anchored,
    });

    if (!plan.length) {
        self.postMessage({
            type: 'walkforward-rejected',
            pluginIndex,
            name: entry.decl?.name ?? 'Strategy',
            reason:
                `${bars.length.toLocaleString()} bars cannot be split into ${msg.windows ?? 4} ` +
                `windows with enough in each to mean anything. Load a longer range, or ask for ` +
                `fewer windows.`,
        });
        return;
    }

    // every window optimises over the whole grid, so the real cost is the
    // schedule's total in-sample bars, not the series length
    const totalIsBars = plan.reduce((n, w) => n + (w.isTo - w.isFrom), 0);
    const budget = checkSweepBudget(grid.length, totalIsBars);
    if (!budget.ok) {
        self.postMessage({
            type: 'walkforward-rejected',
            pluginIndex,
            name: entry.decl?.name ?? 'Strategy',
            reason: budget.reason,
        });
        return;
    }

    sweepCancelled = false;
    const results: unknown[] = [];

    for (const w of plan) {
        if (sweepCancelled) {
            self.postMessage({ type: 'walkforward-cancelled', pluginIndex, done: w.index });
            return;
        }

        const isBars = bars.slice(w.isFrom, w.isTo);
        const oosBars = bars.slice(w.oosFrom, w.oosTo);

        // optimise
        let best: { params: Record<string, unknown>; stats: any } | null = null;
        let bestValue = higherIsBetter ? -Infinity : Infinity;

        for (const patch of grid) {
            if (sweepCancelled) break;
            const params = { ...base, ...patch };
            try {
                const stats: any = scoreOnce(entry, isBars, barNs, params, msg.symbolInfo);
                const v = stats?.[objective];
                // a non-finite objective is skipped rather than winning: profit
                // factor is Infinity for a window with no losing trade, which on
                // a thin in-sample stretch is noise dressed as perfection
                if (typeof v !== 'number' || !Number.isFinite(v)) continue;
                if (higherIsBetter ? v > bestValue : v < bestValue) {
                    bestValue = v;
                    best = { params: patch, stats };
                }
            } catch {
                // a combination that throws is simply not a candidate
            }
        }

        if (!best) {
            results.push({ window: w, error: 'no combination produced a usable result' });
        } else {
            // test: the chosen parameters, on data the optimiser never saw
            const oos = scoreWithEquity(
                entry,
                oosBars,
                barNs,
                { ...base, ...best.params },
                msg.symbolInfo,
            );
            results.push({
                window: w,
                params: best.params,
                inSample: best.stats,
                outOfSample: oos.stats,
                outOfSampleEquity: oos.equity,
            });
        }

        self.postMessage({
            type: 'walkforward-progress',
            pluginIndex,
            done: w.index + 1,
            total: plan.length,
        });
        await new Promise((r) => setTimeout(r, 0));
    }

    self.postMessage({ type: 'walkforward-done', pluginIndex, results });
}

function scoreOnce(
    entry: PluginEntry,
    bars: StrategyBar[],
    barNs: bigint,
    params: Record<string, unknown>,
    symbolInfo: unknown,
): unknown {
    const engine = new StrategyEngine(strategyConfig(entry.decl, params, symbolInfo));
    engine.setBarNs(barNs);
    const broker = engine.api();

    const declaredLookback = entry.decl?.lookback;
    const lookback =
        typeof declaredLookback === 'number' && declaredLookback > 0
            ? declaredLookback
            : DEFAULT_STRATEGY_LOOKBACK;

    let userState: unknown = entry.init ? entry.init({ params, barNs }) : {};
    const history: StrategyBar[] = [];

    for (let i = 0; i < bars.length; i++) {
        const bar = bars[i];
        history.push(bar);
        if (history.length > lookback) history.shift();

        engine.beginBar(bar, i);
        if (entry.update) {
            const next = entry.update({
                bar,
                index: i,
                history,
                state: userState,
                params,
                broker,
                barNs,
            } as any);
            if (next !== undefined) userState = next;
        }
        engine.endBar(bar);
    }

    engine.finish(bars[bars.length - 1]);
    return engine.result.stats;
}

function scoreWithEquity(
    entry: PluginEntry,
    bars: StrategyBar[],
    barNs: bigint,
    params: Record<string, unknown>,
    symbolInfo: unknown,
): { stats: unknown; equity: unknown } {
    const engine = new StrategyEngine(strategyConfig(entry.decl, params, symbolInfo));
    engine.setBarNs(barNs);
    const broker = engine.api();

    const declaredLookback = entry.decl?.lookback;
    const lookback =
        typeof declaredLookback === 'number' && declaredLookback > 0
            ? declaredLookback
            : DEFAULT_STRATEGY_LOOKBACK;

    let userState: unknown = entry.init ? entry.init({ params, barNs }) : {};
    const history: StrategyBar[] = [];

    for (let i = 0; i < bars.length; i++) {
        const bar = bars[i];
        history.push(bar);
        if (history.length > lookback) history.shift();

        engine.beginBar(bar, i);
        if (entry.update) {
            const next = entry.update({
                bar,
                index: i,
                history,
                state: userState,
                params,
                broker,
                barNs,
            } as any);
            if (next !== undefined) userState = next;
        }
        engine.endBar(bar);
    }

    engine.finish(bars[bars.length - 1]);
    const result = engine.result;
    return { stats: result.stats, equity: result.equity };
}

function drawStrategyFallback(entry: PluginEntry): unknown[] {
    if (entry.decl?.type !== 'strategy') return [];
    return defaultStrategyDraw(entry.state, entry.decl?.layout === 'pane' ? 'pane' : 'overlay');
}

// resolves the account and contract settings for a run.
// Precedence: DEFAULT_STRATEGY_CONFIG → the instrument's own ContractSpec → decl.strategy → params
function strategyConfig(
    decl: any,
    params: Record<string, unknown>,
    symbolInfo: any,
): Partial<StrategyConfig> {
    const declared = (decl?.strategy ?? {}) as Record<string, unknown>;
    const contract = (symbolInfo?.contract ?? {}) as Record<string, unknown>;

    const num = (v: unknown): number | undefined =>
        typeof v === 'number' && isFinite(v) && v > 0 ? v : undefined;

    // what the instrument says, where it says anything
    const fromSymbol: Partial<StrategyConfig> = {};
    const tickSize = num(contract.tickSize) ?? num(symbolInfo?.priceFormat?.minTick) ?? num(symbolInfo?.tickSize);
    if (tickSize !== undefined) fromSymbol.tickSize = tickSize;

    // multiplier is points-to-currency directly; tickValue/tickSize is the same
    // number the long way round, for adapters that only publish the tick's worth
    const multiplier =
        num(contract.multiplier) ??
        (num(contract.tickValue) && tickSize ? (contract.tickValue as number) / tickSize : undefined);
    if (multiplier !== undefined) fromSymbol.contractSize = multiplier;

    const qtyStep = num(contract.qtyStep);
    if (qtyStep !== undefined) fromSymbol.qtyStep = qtyStep;

    const cfg: Partial<StrategyConfig> = { ...fromSymbol };

    for (const key of [
        'initialCapital',
        'commission',
        'slippageTicks',
        'tickSize',
        'contractSize',
        'pyramiding',
        'qtyStep',
    ] as const) {
        // commission and slippage are legitimately 0, so `>= 0` rather than the
        // truthiness check the other fields can afford
        const v = params[key] ?? declared[key];
        if (typeof v === 'number' && isFinite(v) && v >= 0) cfg[key] = v;
    }

    const allowReverse = params.allowReverse ?? declared.allowReverse;
    if (typeof allowReverse === 'boolean') cfg.allowReverse = allowReverse;

    return cfg;
}

// null when the run was refused - the caller posts nothing further
function runStrategy(
    entry: PluginEntry,
    pluginIndex: number,
    data: any,
    barNs: bigint,
    params: Record<string, unknown>,
    symbolInfo: any,
): unknown | null {
    const bars: StrategyBar[] = data?.ohlcv ?? [];

    if (bars.length > MAX_LOCAL_STRATEGY_BARS) {
        self.postMessage({
            type: 'strategy-rejected',
            pluginIndex,
            name: entry.decl?.name ?? 'Strategy',
            bars: bars.length,
            maxBars: MAX_LOCAL_STRATEGY_BARS,
            reason:
                `${bars.length.toLocaleString()} bars is past what this browser will run a ` +
                `strategy over (${MAX_LOCAL_STRATEGY_BARS.toLocaleString()}). Shorten the range, ` +
                `or use a coarser timeframe.`,
        });
        return null;
    }

    const engine = new StrategyEngine(strategyConfig(entry.decl, params, symbolInfo));
    engine.setBarNs(barNs);
    const broker = engine.api();

    const declaredLookback = entry.decl?.lookback;
    const lookback =
        typeof declaredLookback === 'number' && declaredLookback > 0
            ? declaredLookback
            : DEFAULT_STRATEGY_LOOKBACK;

    let userState: unknown = entry.init ? entry.init({ params, barNs }) : {};
    const history: StrategyBar[] = [];

    for (let i = 0; i < bars.length; i++) {
        const bar = bars[i];

        history.push(bar);
        if (history.length > lookback) history.shift();

        engine.beginBar(bar, i);
        if (entry.update) {
            const next = entry.update({
                bar,
                index: i,
                history,
                state: userState,
                params,
                broker,
                barNs,
            } as any);
            // unlike an indicator's update, returning nothing is the normal case -
            // most strategies mutate their state object in place
            if (next !== undefined) userState = next;
        }
        engine.endBar(bar);
    }

    engine.finish(bars[bars.length - 1]);

    const result = engine.result;
    return {
        trades: result.trades,
        equity: result.equity,
        stats: result.stats,
        position: result.position,
        // What this run actually used. Echoed back because the settings live in
        // the indicator capability and a sweep ui needs the current values to
        // patch its grid over - reading them off the result is the only place
        // they are already known to be the ones that produced these numbers.
        params: { ...params },
        // the script's own state lives under its own key so a strategy can keep
        // whatever it likes without colliding with the engine's results
        user: userState,
    };
}

function appendSeries(prev: Float64Array | null, next: Float64Array | null): Float64Array {
    if (!prev?.length) return next ?? new Float64Array(0);
    if (!next?.length) return prev;
    const out = new Float64Array(prev.length + next.length);
    out.set(prev, 0);
    out.set(next, prev.length);
    return out;
}

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

    if (msg.type === 'sweep-cancel') {
        // Deliberately not queued behind chain. The sweep it is cancelling is
        // *in* that chain, so waiting its turn would mean waiting for the very
        // loop it was sent to stop
        sweepCancelled = true;
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

    if (msg.type === 'sweep' || msg.type === 'walk-forward') {
        const entry = entries[msg.pluginIndex];
        if (!entry || entry.decl?.type !== 'strategy') return;
        try {
            await (msg.type === 'sweep'
                ? runSweep(entry, msg.pluginIndex, msg)
                : runWalkForward(entry, msg.pluginIndex, msg));
        } catch (err) {
            postError(err);
        }
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

            if (entry.decl?.type === 'strategy') {
                const state = runStrategy(
                    entry,
                    msg.pluginIndex,
                    msg.data,
                    msg.barNs ?? 0n,
                    params,
                    msg.symbolInfo,
                );
                if (state === null) return; // refused, and already reported
                entry.state = state;
            } else if (entry.wasmUrl) {
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
                    : drawStrategyFallback(entry);
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
        // a strategy with no update() trades nothing, but it still has an equity
        // line to report - dropping the message would leave the pane blank with
        // no hint why
        if (!entry.update && !entry.wasmUrl && entry.decl?.type !== 'strategy') return;
        try {
            const params = msg.params ?? {};
            let result: { points: unknown; state: unknown };

            if (entry.decl?.type === 'strategy') {
                // a strategy re-runs the whole window rather than advancing.
                // Resuming mid-run means restoring the engine's position, pending
                // orders and equity peak from a serialized checkpoint - which is
                // exactly what the server runner will need for chunked seconds,
                // and is not worth carrying here where the window is minutes and
                // a full pass costs milliseconds.
                const state = runStrategy(
                    entry,
                    msg.pluginIndex,
                    msg.data,
                    msg.barNs ?? 0n,
                    params,
                    msg.symbolInfo,
                );
                if (state === null) return; // refused, and already reported
                entry.state = state;
                result = { points: state, state };
            } else if (entry.wasmUrl) {
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
                    : drawStrategyFallback(entry);

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
