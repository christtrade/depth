// compiles the handlers a scripted plugin runs on the main thread.
//
// onRender, onHitTest, onPreview, the chart-type draw, drawDirect/drawUI and the
// extension panel cant be posted across the worker boundary, so they travel as
// source strings and get recompiled here. doing that with a bare new Function
// stranded them in global scope, where neither the stdlib nor the script's own
// top-level helpers exist - so a drawing whose onRender called a helper it
// declared ten lines above died on ReferenceError, and so did anything reaching
// for last(). worker-side handlers never hit this since the worker evals the
// whole script into one closure, which is exactly why the same helper works from
// init() but not from onRender().
//
// so give the main thread that same closure: eval the script once into a scope
// carrying the stdlib and the DSL globals, then resolve each handler source
// inside it, where the user's declarations live. plugin() is inert here - the
// worker owns registration, and were only re-running for the declarations.

import { buildScriptScope } from './script-runtime';

/** Resolves a handler source string against a prepared script scope. */
export type ScopedCompiler = <T extends Function>(src: string | null | undefined) => T | null;

// the old behaviour: compile in global scope with nothing else visible
export function compileFromSrc<T extends Function>(src: string | null | undefined): T | null {
    if (!src) return null;
    try {
        return new Function(`return (${src})`)() as T;
    } catch {
        return null;
    }
}

export function makeScopedCompiler(
    script: string,
    extra: Record<string, unknown> = {},
    onError?: (msg: string) => void,
): ScopedCompiler {
    let resolve: ((src: string) => unknown) | null = null;

    try {
        const scope = buildScriptScope({
            // registration already happened in the worker, so swallow it here.
            // the object still has to accept the handler assignments the script
            // makes on it, which a plain object does fine.
            plugin: () => ({}),
            // main thread: fetch and friends are the page's own, and a handler
            // holding a ctx legitimately reaches them. blanking them here would
            // break onRender for no gain - the worker already owns the compute.
            shadowNetwork: false,
            extra,
        });
        const keys = Object.keys(scope);
        // direct eval, so the resolver reads the scope of the function body the
        // script was evaluated into - thats where its own consts and functions
        // now live
        resolve = new Function(
            ...keys,
            `"use strict";\n${script}\n;return function (__src) { return eval("(" + __src + ")"); };`,
        )(...keys.map((k) => scope[k])) as (src: string) => unknown;
    } catch (err) {
        // a script that cant re-evaluate here shouldnt take the whole plugin
        // down, so fall back to the bare global scope - no worse than what this
        // replaced
        onError?.(`could not build handler scope, falling back to global scope: ${err}`);
        resolve = null;
    }

    return <T extends Function>(src: string | null | undefined): T | null => {
        if (!src) return null;
        if (resolve) {
            try {
                const fn = resolve(src);
                if (typeof fn === 'function') return fn as T;
            } catch {
                /* fall through to the bare compile */
            }
        }
        return compileFromSrc<T>(src);
    };
}
