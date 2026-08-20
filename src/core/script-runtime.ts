// the half of the scripted-plugin runtime that has no DOM in it, published as
// its own entry point (`@christtrade/depth/script-runtime`).
//
// why it exists: a scripted plugin's compute half - the stdlib, the DSL enums,
// the scope its code is evaluated into - is pure JavaScript over numbers. The
// strategy runner needs exactly that half on a server, where there is no canvas,
// no React and no window, and where importing the '../core' barrel would drag
// the entire chart in. So the server imports this file and nothing else from
// depth.
//
// what it must NOT import: anything that reaches the barrel, the renderers, or a
// DOM global at module scope. `indicator-stdlib` is fine - its canvas half
// (executeDrawCommands) touches CanvasRenderingContext2D and Path2D only inside
// function bodies a server never calls, so a bundler drops it. Check with
// `node build/probe-script-runtime.mjs` after changing an import here.
//
// the scope builder is shared rather than copied on purpose. There are three
// places a user script gets evaluated - this file's consumers (the server
// runner), script.worker.ts (the browser worker) and script-scope.ts (main
// thread, for the draw/hit-test handlers) - and a script that parses in one and
// throws in another is the single worst bug this system can have. One builder,
// three call sites, differences expressed as options.

import { STDLIB } from '../lib/indicator-stdlib';
import { PluginType, DataLevel, Layout, ExitReason, SCRIPT_DSL } from './script-dsl';

export { STDLIB, SCRIPT_DSL, PluginType, DataLevel, Layout, ExitReason };
export type { OhlcvBar, DrawCommand } from '../lib/indicator-stdlib';

export { StrategyEngine, DEFAULT_STRATEGY_CONFIG } from './strategy-runtime';
export { axisValues, checkSweepBudget, expandGrid, splitIndex } from './strategy-sweep';
export type { SweepAxis, SweepSpec, SweepResult, SweepBudget } from './strategy-sweep';
export {
    planWalkForward,
    walkForwardEfficiency,
    parameterStability,
    pickBest,
} from './strategy-walkforward';
export type {
    WalkForwardSpec,
    WalkForwardWindow,
    WalkForwardWindowResult,
    ParameterStability,
} from './strategy-walkforward';
export type {
    BrokerApi,
    StrategyEquityPoint,
    OrderOpts,
    Side,
    StrategyBar,
    StrategyConfig,
    StrategyOrder,
    StrategyPosition,
    StrategyResult,
    StrategyStats,
    StrategyTrade,
} from './strategy-runtime';

export interface ScriptScopeOptions {
    /** What the script's `plugin({...})` call resolves to. */
    plugin: (decl: unknown) => unknown;
    /**
     * Shadow fetch/XMLHttpRequest/WebSocket/importScripts to undefined.
     *
     * True for the worker and the server, where script code has no business
     * reaching the network - it goes through ctx.fetch on the main thread, which
     * is gated on the manifest's declared origins. False on the main thread,
     * where those globals are the page's own and blanking them would break the
     * handlers that legitimately hold a ctx.
     *
     * This is a guardrail, not a sandbox: shadowing a scope variable does not
     * stop `globalThis.fetch` or `Function("return this")()`. The security
     * boundary is the isolate the script runs in - a dedicated worker in the
     * browser, and a dedicated isolate (or container) on the server. Never rely
     * on this flag to contain code you do not trust.
     */
    shadowNetwork?: boolean;
    /** Extra bindings for the calling host, e.g. a strategy runner's `broker`. */
    extra?: Record<string, unknown>;
}

/**
 * The globals a user script sees, as a plain object. Callers turn it into a
 * scope by splatting the keys into a `new Function(...keys, src)(...values)`.
 */
export function buildScriptScope(opts: ScriptScopeOptions): Record<string, unknown> {
    const scope: Record<string, unknown> = {
        ...SCRIPT_DSL,
        Math,
        console,
        plugin: opts.plugin,
    };

    for (const [k, v] of Object.entries(STDLIB)) scope[k] = v;

    if (opts.shadowNetwork) {
        scope.fetch = undefined;
        scope.XMLHttpRequest = undefined;
        scope.WebSocket = undefined;
        scope.importScripts = undefined;
    }

    // last, so a host binding wins over a stdlib name it collides with - the
    // alternative is a host silently losing its own API to a helper rename
    if (opts.extra) for (const [k, v] of Object.entries(opts.extra)) scope[k] = v;

    return scope;
}

/**
 * Evaluates a user script against a scope built from `opts`.
 *
 * The whole script goes into one function body, so its top-level consts and
 * helper declarations stay visible to init/update/draw the way they would in a
 * module. Registration happens as a side effect of the `plugin()` calls the
 * script makes while evaluating.
 */
export function evalScriptInScope(src: string, opts: ScriptScopeOptions): void {
    const scope = buildScriptScope(opts);
    const keys = Object.keys(scope);
    // eslint-disable-next-line no-new-func
    new Function(...keys, `"use strict";\n${src}`)(...keys.map((k) => scope[k]));
}

export function defaultStrategyDraw(state: unknown, layout: 'overlay' | 'pane'): unknown[] {
    const s = state as {
        trades?: Array<{
            side: 'long' | 'short';
            entryTs: bigint;
            entryPrice: number;
            exitTs: bigint;
            exitPrice: number;
            pnl: number;
            reason: string;
        }>;
        equity?: Array<{ ts: bigint; equity: number }>;
    } | null;

    if (!s) return [];

    if (layout === 'pane') {
        const pts = (s.equity ?? []).map((p) => ({ t: p.ts, price: p.equity }));
        return pts.length ? [STDLIB.drawLine(pts, '#38bdf8', 1.5, [], true)] : [];
    }

    const commands: unknown[] = [];
    const trades = s.trades ?? [];

    for (const t of trades) {
        const long = t.side === 'long';
        // entry points the way the trade was taken, exit is coloured by outcome
        // rather than direction - at a glance you want winners and losers, not a
        // second copy of the side you can already read from the entry
        commands.push(
            STDLIB.drawArrow(
                t.entryTs,
                t.entryPrice,
                long ? 'up' : 'down',
                long ? '#22c55e' : '#ef4444',
                9,
            ),
        );
        commands.push(
            STDLIB.drawArrow(
                t.exitTs,
                t.exitPrice,
                long ? 'down' : 'up',
                t.pnl >= 0 ? '#22c55e' : '#ef4444',
                7,
            ),
        );
    }

    return commands;
}

/**
 * Identifies the stdlib surface this build exposes, for a client and a server
 * runner to agree they are talking about the same one.
 *
 * It hashes the sorted helper *names*, which survive minification (esbuild does
 * not rename object literal keys), so a minified client and an unminified server
 * built from the same version agree. It therefore catches the failure that
 * actually bites - a server missing a helper the client's editor offered,
 * surfacing as a ReferenceError from inside user code - and does not catch a
 * changed implementation of a helper that kept its name. Pin the package version
 * for that; this is a guard against deploy skew, not a substitute for the pin.
 */
export const STDLIB_SIGNATURE: string = (() => {
    const names = Object.keys(STDLIB).sort().join(',');
    // FNV-1a, so the signature costs nothing at import time and needs no crypto
    let h = 0x811c9dc5;
    for (let i = 0; i < names.length; i++) {
        h ^= names.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
})();
