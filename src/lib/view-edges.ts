import type { TypedEventBus } from '../core/TypedEventBus';
import type { ViewBounds } from './types';

// data stopping more than a bar short of the horizon is a hole, left by a switch
// that only loaded around the view. pans may go into it and page forward
export function hasHole(dataEnd: bigint, horizon: bigint, barNs: bigint): boolean {
    return horizon > dataEnd + barNs;
}

// whether new data whose end moved from oldEnd to newEnd takes the horizon along.
// only when idle at the live edge, and a page into a hole only once it reaches it
export function followsEdge(e: {
    horizon: bigint;
    oldEnd: bigint;
    newEnd: bigint;
    barNs: bigint;
    playing: boolean;
}): boolean {
    if (e.playing || e.horizon < e.oldEnd) return false;
    return !hasHole(e.oldEnd, e.horizon, e.barNs) || e.newEnd >= e.horizon;
}

// keep track of the horizon
export function loadedHorizon(e: {
    replaced: boolean;
    follows: boolean;
    horizon: bigint;
    newEnd: bigint;
    playFrom: bigint | null;
}): bigint {
    if (e.replaced) return e.follows && e.newEnd > e.horizon ? e.newEnd : e.horizon;
    return e.playFrom ?? e.newEnd;
}

// newest time a pan may reach
export function panEnd(dataEnd: bigint, horizon: bigint, barNs: bigint): bigint {
    if (horizon <= 0n) return dataEnd;
    if (horizon < dataEnd || hasHole(dataEnd, horizon, barNs)) return horizon;
    return dataEnd;
}

// ask the engine for data past either side of the view
export function requestPastEdges(
    eventBus: TypedEventBus,
    view: ViewBounds,
    data: { start: bigint; end: bigint; horizon: bigint; barNs: bigint },
    symbol?: string,
): void {
    if (view.tMin < data.start) {
        eventBus.emit('data:request-backward', { viewMin: view.tMin, symbol });
    }
    if (view.tMax > data.end && hasHole(data.end, data.horizon, data.barNs)) {
        eventBus.emit('data:request-forward', { viewMax: view.tMax, symbol });
    }
}
