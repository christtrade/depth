import type { MboEvent } from '.';
import type { ViewBounds } from '.';

export type SerializedBounds = {
    tMin: string;
    tMax: string;
    pMin: number;
    pMax: number;
};

export type WorkerInitMessage = {
    type: 'init';
    events: MboEvent[];
};

// pan/zoom just sends view bounds - worker handles everything else internally
export type HeatmapRequest = {
    type: 'render';
    requestId: number;
    bounds: SerializedBounds;
    chartW: number;
    chartH: number;
    /** Optional playback horizon (nanoseconds as string). When set, the worker
     *  stops adding new snapshot columns at this timestamp but forward-fills the
     *  last column to the right edge of the canvas - showing the last known book
     *  state held flat into the future, matching trades/bid-ask line behaviour. */
    horizonNs?: string;
};

export type HeatmapResponse = {
    requestId: number;
    bitmap: ImageBitmap;
    bounds: SerializedBounds;
};

export function serializeBounds(b: ViewBounds): SerializedBounds {
    return { tMin: b.tMin.toString(), tMax: b.tMax.toString(), pMin: b.pMin, pMax: b.pMax };
}
