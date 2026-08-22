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
//   audit-run { pluginIndex, data, barNs, params, range } -> { result: AuditResult }
//                                                or { error }
//   destroy                                      -> self.close()
//
// parse evals the script and reports what each plugin declared. run-init then
// calls init() and draw() without re-evaluating, so the closure survives.
//
// a plugin that sets p.wasm runs a compiled module in place of its init/update.
// that makes handling a message async, so everything but destroy goes through
// one promise chain - otherwise an update could overtake the run-init it depends on.

import { buildScriptScope, defaultStrategyDraw } from './script-runtime';
import { StrategyEngine, type StrategyBar, type StrategyConfig } from './strategy-runtime';
import { checkSweepBudget, splitIndex } from './strategy-sweep';
import { clipRange, emptyRangeReason, hasRange, type StrategyRange } from './strategy-range';
import { planWalkForward } from './strategy-walkforward';
import { evictWasmModule, instantiateWasmPlugin, type WasmPlugin } from './WasmPluginHost';
import {
    AuditRecorder,
    finishAudit,
    instrumentScript,
    profHandle,
    timeOwnCode,
    timedStdlib,
    type AuditResult,
} from './script-audit';

// no DOM to escape to here, but shadow the network APIs anyway to stop
// exfiltration; not frozen, the user needs mutable top-level vars. Scope
// itself is built in script-runtime.ts, shared with the main-thread compiler
// and the server runner.

function buildScope(
    pluginDecl: (d: unknown) => void,
    extra?: Record<string, unknown>,
): Record<string, unknown> {
    return buildScriptScope({ plugin: pluginDecl, shadowNetwork: true, extra });
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
    /** A streamed strategy run in progress, between begin and end. */
    session: StrategySession | null;
    sessionBars: number;
    sessionParams: Record<string, unknown> | null;
    sessionBarNs: bigint | null;
    sessionFirstTs: bigint | null;
    sessionLastTs: bigint | null;
    // engine's own pace, not the chunk delivered/total - posting to a worker
    // doesn't wait for a reply, so a heavy script's engine can lag the chunk
    // count by a lot
    sessionBarsDone: number;
    sessionEstTotalBars: number;
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

function evalScript(src: string, extraScope?: Record<string, unknown>): PluginEntry[] {
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
            session: null,
            sessionBars: 0,
            sessionParams: null,
            sessionBarNs: null,
            sessionFirstTs: null,
            sessionLastTs: null,
            sessionBarsDone: 0,
            sessionEstTotalBars: 0,
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

        // lets the user do p.onRender = fn; the setter captures it onto the entry
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

    const scope = buildScope(pluginFn, extraScope);
    const keys = Object.keys(scope);
    const values = keys.map((k) => scope[k]);
    new Function(...keys, `"use strict";\n${src}`)(...values);

    // init -> update shorthand, per entry - params must forward or a plugin
    // defining only init() loses its settings on the first horizon tick
    for (const e of entries) {
        // a strategy's update() takes a broker; the shorthand would call it
        // with the wrong shape entirely
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
// held so an audit-run can re-evaluate the same script into a second,
// throwaway entries array with timed stdlib calls
let lastScript = '';

// Strategy execution

// bigint survives structuredClone but not JSON, and this arrives from both a
// live postMessage and a rehydrated saved chart
function decodeRange(raw: any): StrategyRange | undefined {
    if (!raw) return undefined;

    const ns = (v: unknown): bigint | undefined => {
        if (v == null || v === '') return undefined;
        if (typeof v === 'bigint') return v;
        if (typeof v === 'number') return Number.isFinite(v) ? BigInt(Math.trunc(v)) : undefined;
        if (typeof v === 'string') {
            try {
                return BigInt(v);
            } catch {
                return undefined;
            }
        }
        return undefined;
    };

    const fromNs = ns(raw.fromNs);
    const toNs = ns(raw.toNs);
    if (fromNs == null && toNs == null) return undefined;
    return { fromNs, toNs };
}

// clipped before every budget check and window plan - a user narrowing the
// range to escape a rejection expects that to work
function barsForRun(data: any, rawRange: unknown) {
    const all: StrategyBar[] = data?.ohlcv ?? [];
    const range = decodeRange(rawRange);
    const clipped = clipRange(all, range);
    // slice only when it changes something - the common case has no range,
    // and copying a million-element array for nothing isn't free
    const bars = hasRange(range) ? all.slice(clipped.from, clipped.to) : all;
    return { bars, clipped, range };
}

const DEFAULT_STRATEGY_LOOKBACK = 200;
const MAX_LOCAL_STRATEGY_BARS = 2_000_000;
const RUN_PROGRESS_BATCH = 50_000;

let sweepCancelled = false;

async function runSweep(
    entry: PluginEntry,
    pluginIndex: number,
    msg: any,
): Promise<void> {
    const { bars, clipped, range } = barsForRun(msg.data, msg.range);
    const grid: Array<Record<string, unknown>> = msg.grid ?? [];
    const base: Record<string, unknown> = msg.params ?? {};
    const barNs: bigint = msg.barNs ?? 0n;

    if (!bars.length) {
        self.postMessage({
            type: 'sweep-rejected',
            pluginIndex,
            name: entry.decl?.name ?? 'Strategy',
            combos: grid.length,
            bars: 0,
            iterations: 0,
            reason: emptyRangeReason(clipped, range),
        });
        return;
    }

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
    const { bars, clipped, range } = barsForRun(msg.data, msg.range);
    const grid: Array<Record<string, unknown>> = msg.grid ?? [];
    const base: Record<string, unknown> = msg.params ?? {};
    const barNs: bigint = msg.barNs ?? 0n;
    const objective: string = msg.objective ?? 'netPnl';
    const higherIsBetter: boolean = msg.higherIsBetter ?? true;

    if (!bars.length) {
        self.postMessage({
            type: 'walkforward-rejected',
            pluginIndex,
            name: entry.decl?.name ?? 'Strategy',
            reason: emptyRangeReason(clipped, range),
        });
        return;
    }

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

// precedence: DEFAULT_STRATEGY_CONFIG -> instrument's own ContractSpec -> decl.strategy -> params
function strategyConfig(
    decl: any,
    params: Record<string, unknown>,
    symbolInfo: any,
): Partial<StrategyConfig> {
    const declared = (decl?.strategy ?? {}) as Record<string, unknown>;
    const contract = (symbolInfo?.contract ?? {}) as Record<string, unknown>;

    const num = (v: unknown): number | undefined =>
        typeof v === 'number' && isFinite(v) && v > 0 ? v : undefined;

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
    rawRange?: unknown,
): unknown | null {
    const { bars, clipped, range } = barsForRun(data, rawRange);

    if (!bars.length) {
        self.postMessage({
            type: 'strategy-rejected',
            pluginIndex,
            name: entry.decl?.name ?? 'Strategy',
            bars: 0,
            maxBars: MAX_LOCAL_STRATEGY_BARS,
            reason: emptyRangeReason(clipped, range),
        });
        return null;
    }

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

    const session = beginSession(entry, params, barNs, symbolInfo);

    // Data the chart already holds runs as one uninterrupted synchronous
    // loop - there is no network chunking to piggyback a progress event on,
    // and for a multi-year range, or a script whose update() does real work
    // per bar, that loop is the part that actually takes a while.
    if (bars.length > RUN_PROGRESS_BATCH) {
        // Fired before the first bar, not just as they pass - the caller's
        // "in flight" state reads off this message, and waiting for the
        // first report would leave the button looking unpressed for however
        // long that takes on an expensive script.
        self.postMessage({
            type: 'strategy-run-progress',
            pluginIndex,
            name: entry.decl?.name ?? 'Strategy',
            done: 0,
            total: bars.length,
        });
        let done = 0;
        feedSession(session, entry, bars, params, barNs, (n) => {
            done += n;
            self.postMessage({
                type: 'strategy-run-progress',
                pluginIndex,
                name: entry.decl?.name ?? 'Strategy',
                done,
                total: bars.length,
            });
        });
    } else {
        feedSession(session, entry, bars, params, barNs);
    }

    return endSession(session, params, clipped);
}

function runAudit(
    entry: PluginEntry,
    pluginIndex: number,
    data: any,
    barNs: bigint,
    params: Record<string, unknown>,
    symbolInfo: any,
    rawRange: unknown,
): AuditResult {
    if (entry.wasmUrl) {
        throw new Error('Profiling is not available for WebAssembly-backed plugins.');
    }

    const recorder = new AuditRecorder();

    let scriptToRun = lastScript;
    let lineLevel = true;
    try {
        scriptToRun = instrumentScript(lastScript);
    } catch {
        lineLevel = false;
    }

    const scope = { ...timedStdlib(recorder), __prof: profHandle(recorder) };
    let auditEntry: PluginEntry | undefined;
    try {
        auditEntry = evalScript(scriptToRun, scope)[pluginIndex];
    } catch (err) {
        if (!lineLevel) throw err; // already the fallback source; nothing left to try
        lineLevel = false;
        auditEntry = evalScript(lastScript, scope)[pluginIndex];
    }
    if (!auditEntry) throw new Error('Plugin not found.');

    if (!lineLevel) {
        if (auditEntry.init) auditEntry.init = timeOwnCode(recorder, '(your code - init)', auditEntry.init);
        if (auditEntry.update) {
            auditEntry.update = timeOwnCode(recorder, '(your code - update)', auditEntry.update);
        }
    }

    const t0 = performance.now();
    let barsOrPoints = 0;

    if (entry.decl?.type === 'strategy') {
        const { bars, clipped, range } = barsForRun(data, rawRange);
        if (!bars.length) throw new Error(emptyRangeReason(clipped, range));
        if (bars.length > MAX_LOCAL_STRATEGY_BARS) {
            throw new Error(
                `${bars.length.toLocaleString()} bars is past what an audit will run over ` +
                    `(${MAX_LOCAL_STRATEGY_BARS.toLocaleString()}). Shorten the range first.`,
            );
        }
        const session = beginSession(auditEntry, params, barNs, symbolInfo);
        feedSession(session, auditEntry, bars, params, barNs);
        endSession(session, params, clipped);
        barsOrPoints = bars.length;
    } else {
        const points = data?.ohlcv ?? data ?? [];
        barsOrPoints = Array.isArray(points) ? points.length : 0;
        if (auditEntry.init) {
            const state = auditEntry.init({ data, barNs, params });
            // chart-type's draw runs on the main thread against a real canvas
            // context, which this worker doesn't have - can't be timed here
            if (auditEntry.draw && entry.decl?.type !== 'chart-type') {
                (lineLevel ? auditEntry.draw : timeOwnCode(recorder, '(your code - draw)', auditEntry.draw))(
                    state,
                );
            }
        }
    }

    return finishAudit(recorder, performance.now() - t0, barsOrPoints, lastScript, lineLevel);
}

// split out from runStrategy because a chunked range needs the engine to
// survive between messages - same loop either way, so scoring doesn't depend
// on how the data was delivered
interface StrategySession {
    engine: StrategyEngine;
    broker: ReturnType<StrategyEngine['api']>;
    userState: unknown;
    /** Bounded rolling window - never the whole run. */
    history: StrategyBar[];
    lookback: number;
    /** Bar index across every chunk, not within one. */
    index: number;
    lastBar: StrategyBar | undefined;
}

function beginSession(
    entry: PluginEntry,
    params: Record<string, unknown>,
    barNs: bigint,
    symbolInfo: any,
): StrategySession {
    const engine = new StrategyEngine(strategyConfig(entry.decl, params, symbolInfo));
    engine.setBarNs(barNs);

    const declaredLookback = entry.decl?.lookback;
    const lookback =
        typeof declaredLookback === 'number' && declaredLookback > 0
            ? declaredLookback
            : DEFAULT_STRATEGY_LOOKBACK;

    return {
        engine,
        broker: engine.api(),
        userState: entry.init ? entry.init({ params, barNs }) : {},
        history: [],
        lookback,
        index: 0,
        lastBar: undefined,
    };
}

/** Bars between wall-clock checks for `onProgress` - a power of two so the
 *  check is a bitmask, not a modulo. */
const PROGRESS_CHECK_EVERY = 64;

/** Don't report faster than this - a progress bar repainting quicker than
 *  the eye integrates is wasted paint. */
const PROGRESS_MIN_INTERVAL_MS = 100;

/**
 * Run a batch of bars through the session. The batch isn't retained.
 *
 * `onProgress`, if given, gets bars processed since the last call, not a
 * running total, so the caller can hold whatever total suits it. Fires on a
 * wall-clock cadence rather than a bar count, since a script that does real
 * work per bar can take orders of magnitude longer than one that doesn't -
 * a bar-count interval tuned for one is wrong for the other.
 */
function feedSession(
    session: StrategySession,
    entry: PluginEntry,
    bars: StrategyBar[],
    params: Record<string, unknown>,
    barNs: bigint,
    onProgress?: (barsSinceLastReport: number) => void,
): void {
    const { engine, broker, history, lookback } = session;
    let sinceReport = 0;
    let lastReportAt = onProgress ? performance.now() : 0;

    for (let n = 0; n < bars.length; n++) {
        const bar = bars[n];
        const i = session.index++;

        history.push(bar);
        if (history.length > lookback) history.shift();

        engine.beginBar(bar, i);
        if (entry.update) {
            const next = entry.update({
                bar,
                index: i,
                history,
                state: session.userState,
                params,
                broker,
                barNs,
            } as any);
            // unlike an indicator's update, returning nothing is the normal case -
            // most strategies mutate their state object in place
            if (next !== undefined) session.userState = next;
        }
        engine.endBar(bar);
        session.lastBar = bar;

        if (onProgress) {
            sinceReport++;
            if ((sinceReport & (PROGRESS_CHECK_EVERY - 1)) === 0) {
                const now = performance.now();
                if (now - lastReportAt >= PROGRESS_MIN_INTERVAL_MS) {
                    onProgress(sinceReport);
                    sinceReport = 0;
                    lastReportAt = now;
                }
            }
        }
    }
    if (onProgress && sinceReport > 0) onProgress(sinceReport);
}

function endSession(
    session: StrategySession,
    params: Record<string, unknown>,
    clipped: {
        firstTs: bigint | null;
        lastTs: bigint | null;
        count: number;
        total: number;
        dataFromNs: bigint | null;
        dataToNs: bigint | null;
    },
): unknown {
    session.engine.finish(session.lastBar);

    const result = session.engine.result;
    return {
        trades: result.trades,
        equity: result.equity,
        stats: result.stats,
        position: result.position,
        // echoed back so a sweep UI can patch its grid over the values that
        // actually produced these numbers
        params: { ...params },
        // bars the run actually covered, not the requested span
        range: {
            fromNs: clipped.firstTs,
            toNs: clipped.lastTs,
            bars: clipped.count,
            totalBars: clipped.total,
            clipped: clipped.count < clipped.total,
            dataFromNs: clipped.dataFromNs,
            dataToNs: clipped.dataToNs,
        },
        // the script's own state lives under its own key so a strategy can keep
        // whatever it likes without colliding with the engine's results
        user: session.userState,
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
        lastScript = msg.script ?? '';
        entries = evalScript(lastScript);
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

    // Streamed run: begin / chunk* / end. A range wider than the chart's loaded
    // data arrives a chunk at a time so the driver can drop each one after the
    // engine's seen it. The session lives on the entry between messages.
    if (msg.type === 'strategy-begin') {
        const entry = entries[msg.pluginIndex];
        if (!entry || entry.decl?.type !== 'strategy') return;
        try {
            entry.session = beginSession(
                entry,
                msg.params ?? {},
                msg.barNs ?? 0n,
                msg.symbolInfo,
            );
            entry.sessionBars = 0;
            entry.sessionParams = msg.params ?? {};
            entry.sessionBarNs = msg.barNs ?? 0n;
            entry.sessionFirstTs = null;
            entry.sessionLastTs = null;
            entry.sessionBarsDone = 0;
            entry.sessionEstTotalBars = (msg.totalChunks ?? 0) * (msg.barsPerChunk ?? 0);
        } catch (err) {
            entry.session = null;
            postError(err);
        }
        return;
    }

    if (msg.type === 'strategy-chunk') {
        const entry = entries[msg.pluginIndex];
        if (!entry?.session) return;
        try {
            const bars: StrategyBar[] = msg.bars ?? [];
            if (bars.length) {
                if (entry.sessionFirstTs === null) entry.sessionFirstTs = bars[0].ts;
                entry.sessionLastTs = bars[bars.length - 1].ts;
                entry.sessionBars += bars.length;

                if (entry.sessionBars > MAX_LOCAL_STRATEGY_BARS) {
                    entry.session = null;
                    self.postMessage({
                        type: 'strategy-rejected',
                        pluginIndex: msg.pluginIndex,
                        name: entry.decl?.name ?? 'Strategy',
                        bars: entry.sessionBars,
                        maxBars: MAX_LOCAL_STRATEGY_BARS,
                        reason:
                            `${entry.sessionBars.toLocaleString()} bars is past what this browser ` +
                            `will run a strategy over ` +
                            `(${MAX_LOCAL_STRATEGY_BARS.toLocaleString()}). Shorten the range, ` +
                            `or use a coarser timeframe.`,
                    });
                    return;
                }

                // keeps the tail moving after the network side hits 100%
                if (entry.sessionEstTotalBars > 0) {
                    feedSession(
                        entry.session,
                        entry,
                        bars,
                        entry.sessionParams ?? {},
                        entry.sessionBarNs ?? 0n,
                        (n) => {
                            entry.sessionBarsDone += n;
                            self.postMessage({
                                type: 'strategy-chunk-progress',
                                pluginIndex: msg.pluginIndex,
                                name: entry.decl?.name ?? 'Strategy',
                                done: entry.sessionBarsDone,
                                total: entry.sessionEstTotalBars,
                            });
                        },
                    );
                } else {
                    feedSession(
                        entry.session,
                        entry,
                        bars,
                        entry.sessionParams ?? {},
                        entry.sessionBarNs ?? 0n,
                    );
                }
            }
            self.postMessage({
                type: 'strategy-chunk-done',
                pluginIndex: msg.pluginIndex,
                bars: entry.sessionBars,
            });
        } catch (err) {
            entry.session = null;
            postError(err);
        }
        return;
    }

    if (msg.type === 'strategy-end') {
        const entry = entries[msg.pluginIndex];
        if (!entry?.session) return;
        try {
            const session = entry.session;
            entry.session = null;

            if (!entry.sessionBars) {
                self.postMessage({
                    type: 'strategy-rejected',
                    pluginIndex: msg.pluginIndex,
                    name: entry.decl?.name ?? 'Strategy',
                    bars: 0,
                    maxBars: MAX_LOCAL_STRATEGY_BARS,
                    reason: 'No bars were returned for the selected range.',
                });
                return;
            }

            const state = endSession(session, entry.sessionParams ?? {}, {
                firstTs: entry.sessionFirstTs,
                lastTs: entry.sessionLastTs,
                count: entry.sessionBars,
                // a streamed run has no wider set to be a subset of: what was
                // fetched is what exists for the range that was asked for
                total: entry.sessionBars,
                dataFromNs: entry.sessionFirstTs,
                dataToNs: entry.sessionLastTs,
            });
            entry.state = state;

            const drawCommands = entry.draw
                ? (entry.draw(entry.state) ?? [])
                : drawStrategyFallback(entry);

            self.postMessage({
                type: 'update',
                pluginIndex: msg.pluginIndex,
                points: state,
                state,
                drawCommands,
            });
        } catch (err) {
            postError(err);
        }
        return;
    }

    if (msg.type === 'strategy-cancel') {
        const entry = entries[msg.pluginIndex];
        if (entry) entry.session = null;
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
                    msg.range,
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

    if (msg.type === 'audit-run') {
        const entry = entries[msg.pluginIndex];
        if (!entry) return;
        try {
            const result = runAudit(
                entry,
                msg.pluginIndex,
                msg.data,
                msg.barNs ?? 0n,
                msg.params ?? {},
                msg.symbolInfo,
                msg.range,
            );
            self.postMessage({ type: 'audit-result', pluginIndex: msg.pluginIndex, result });
        } catch (err) {
            self.postMessage({
                type: 'audit-error',
                pluginIndex: msg.pluginIndex,
                error: err instanceof Error ? err.message : String(err),
            });
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
                // Re-runs the whole window rather than advancing. Resuming
                // mid-run would mean restoring position/orders/equity peak from
                // a checkpoint - worth it server-side for chunked seconds, not
                // here where a full pass costs milliseconds.
                const state = runStrategy(
                    entry,
                    msg.pluginIndex,
                    msg.data,
                    msg.barNs ?? 0n,
                    params,
                    msg.symbolInfo,
                    msg.range,
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
