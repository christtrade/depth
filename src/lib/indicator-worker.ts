//  Incremental indicator computation worker.
//
//  Three message types (msg.type):
//
//    'compute'              Full recompute via workerInit. Sent on: initial load,
//                           backward seek, timeframe change. Replaces all state.
//
//    'register-update-fns'  Register workerUpdate source strings for each
//                           indicator. Sent once right after 'compute'. Avoids
//                           re-sending source strings on every tick.
//
//    'horizon:advance'      Incremental update via workerUpdate. Sent on every
//                           horizon tick (hot path). Only processes new trades.
//
//  State lifecycle:
//    compute         -> indicatorStates[id] = workerInit(allTrades)
//    horizon:advance -> indicatorStates[id] = workerUpdate(newTrades, state).state
//    compute         -> indicatorStates[id] replaced (backward seek / TF change)
import { SerialTrade } from './types';

export type { SerialTrade };

// Wire types
/**
 * Full recompute. Sent on load / backward seek / timeframe change.
 * workerInit is called with ALL trades up to horizon.
 * The return value of workerInit is both stored as state AND returned as
 * the hydrate() payload so ChartInner can replace all existing output data.
 */
export interface ComputeRequest {
    type: 'compute';
    requestId: string;
    trades: SerialTrade[];
    barNs: bigint;
    horizon: bigint;
    ohlcv?: any[];
    ticks?: any[];
    snapshots?: any[];
    indicators: Array<{
        id: string;
        workerInit: string;
        params?: unknown;
    }>;
}

/**
 * Register workerUpdate functions. Sent once after each 'compute'.
 * Separating this from 'compute' means we never re-parse source strings on
 * the hot path (horizon:advance sends only indicatorIds, no source).
 */
export interface RegisterUpdateFnsRequest {
    type: 'register-update-fns';
    indicators: Array<{
        id: string;
        /** Serialized pure fn: ({ newTrades, state, barNs, horizon, params }) => { points, state } */
        workerUpdate: string;
    }>;
}

/**
 * Incremental update. Hot path - called every horizon tick.
 * workerUpdate receives only new trades since the last call.
 * Returns new output points for appendHydrate().
 */
export interface HorizonAdvanceRequest {
    type: 'horizon:advance';
    requestId: string;
    newTrades: SerialTrade[];
    horizon: bigint;
    barNs: bigint;
    indicatorIds: Array<{
        id: string;
        params?: unknown;
        workerInit?: string;
    }>;
}

export interface ComputeResponse {
    type: 'compute';
    requestId: string;
    results: Record<string, unknown>;
    errors: Record<string, string>;
}

export interface HorizonAdvanceResponse {
    type: 'horizon:advance';
    requestId: string;
    points: Record<string, unknown>;
    errors: Record<string, string>;
}

// Worker-side stores
// compiledInits is keyed by SOURCE STRING, not by indicator id.
// This means a hot-reloaded workerInit with new source always recompiles -
// the old cached compile for the same id is never reused.
const compiledInits = new Map<string, Function>();
const compiledUpdates = new Map<string, Function>();
const indicatorStates = new Map<string, unknown>();

function getOrCompileInit(src: string): Function {
    let fn = compiledInits.get(src);
    if (!fn) {
        fn = new Function(`return (${src})`)();
        compiledInits.set(src, fn);
    }
    return fn;
}

// Message handler
self.onmessage = (e: MessageEvent) => {
    const msg = e.data;

    if (msg.type === 'compute') {
        const { requestId, trades, barNs, indicators, ohlcv = [] as any[], ticks = [] as any[], snapshots = [] as any[] } = msg as ComputeRequest;
        const results: Record<string, unknown> = {};
        const errors: Record<string, string> = {};

        for (const ind of indicators) {
            try {
                const fn = getOrCompileInit(ind.workerInit);
                const state = fn({ trades, ohlcv, ticks, snapshots, barNs, params: ind.params });
                indicatorStates.set(ind.id, state);
                results[ind.id] = state;
            } catch (err) {
                errors[ind.id] = String(err);
                indicatorStates.delete(ind.id);
            }
        }

        self.postMessage({ type: 'compute', requestId, results, errors });
        return;
    }

    if (msg.type === 'register-update-fns') {
        const { indicators } = msg as RegisterUpdateFnsRequest;
        for (const { id, workerUpdate } of indicators) {
            try {
                const fn = new Function(`return (${workerUpdate})`)();
                compiledUpdates.set(id, fn);
            } catch (err) {
                console.error(
                    `[indicator-worker] Failed to compile workerUpdate for '${id}':`,
                    err,
                );
            }
        }
        return;
    }

    if (msg.type === 'horizon:advance') {
        const { requestId, newTrades, horizon, barNs, indicatorIds } = msg as HorizonAdvanceRequest;
        const points: Record<string, unknown> = {};
        const errors: Record<string, string> = {};

        for (const { id, params } of indicatorIds) {
            const updateFn = compiledUpdates.get(id);
            if (!updateFn) continue; // not registered yet
            const state = indicatorStates.get(id);
            if (state === undefined) continue; // workerInit hasn't run
            try {
                const ohlcv: unknown[] = (msg as any).ohlcv ?? [];
                const ticks: unknown[] = (msg as any).ticks ?? [];
                const snapshots: unknown[] = (msg as any).snapshots ?? [];
                const result = updateFn({
                    newTrades,
                    ohlcv,
                    ticks,
                    snapshots,
                    state,
                    barNs,
                    horizon,
                    params,
                }) as {
                    points: unknown;
                    state: unknown;
                };
                indicatorStates.set(id, result.state);
                points[id] = result.points;
            } catch (err) {
                errors[id] = String(err);
            }
        }

        self.postMessage({ type: 'horizon:advance', requestId, points, errors });
        return;
    }
};
