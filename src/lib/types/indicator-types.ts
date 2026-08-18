import { LiveTransformer } from '../../core';
import type { DataLevel } from '../../interfaces/IDataAdapter';
import type { Crosshair } from '../renderers/renderer';

// Geometry
/** Pixel region a pane occupies on the canvas (absolute coordinates). */
export type Rect = { x: number; y: number; w: number; h: number };

// Pane
export interface ChartPane {
    id: string;
    isMain: boolean;
    heightRatio: number;
    label?: string;
    yMin: number;
    yMax: number;
    yAxisAuto: boolean;
    collapsed: boolean;
    savedHeightRatio?: number;
    symbol?: string;
    tf?: string;
    exchange?: string;
}

// Render Context
/**
 * Everything an indicator needs to draw itself.
 * `rect` uses LOCAL coordinates (origin = top-left of this pane).
 *
 * `horizon` is the current playback horizon in nanoseconds.
 * Indicators MUST use this to clip their output - never draw data beyond
 * horizon. This is the only way to guarantee no future data leaks at
 * sub-bar precision. tMax is the rightmost visible timestamp of the view
 * and is unrelated to horizon.
 */
export interface RenderContext {
    ctx: CanvasRenderingContext2D;
    /** Local rect - origin is (0, 0) after ctx.translate has been applied. */
    rect: Rect;
    /** Shared time axis (nanoseconds). */
    tMin: bigint;
    tMax: bigint;
    /** Pane-local price / value axis. */
    yMin: number;
    yMax: number;
    /** Active bar duration in nanoseconds (0n = tick/raw mode). */
    barNs: bigint;
    /**
     * Current playback horizon in nanoseconds.
     * Clip all drawing to ts <= horizon. Do not draw anything beyond this
     * timestamp - doing so leaks future data.
     *
     * 0n means no horizon is active (live / full-history mode), in which
     * case you can draw everything.
     */
    horizon: bigint;
    transformer: LiveTransformer;
}

// Indicator
export interface Indicator {
    id: string;
    name: string;
    visible: boolean;
    layout: 'overlay' | 'pane';
    paneId?: string;
    category?: string;
    shortName?: string;
    description?: string;
    /**
     * Minimum data level this indicator can be computed from. Defaults to
     * 'ohlcv'. Activation is refused on a symbol that serves less than this -
     * the alternative is an indicator that draws nothing and looks broken.
     */
    require?: DataLevel;

    settings: any;

    /**
     * Serialized init function - runs in the indicator worker on full load
     * (initial data load, backward seek, timeframe change).
     *
     * Signature: (input: { trades: SerialTrade[], barNs: bigint, params?: unknown }) => State
     *
     * Returns the full computed state. Must be pure - no imports, no closures.
     * The returned State is stored in the worker and passed to workerUpdate
     * on every horizon tick.
     */
    workerInit: string;

    /**
     * Serialized incremental update function - runs in the indicator worker
     * on every horizon advance tick (hot path: called up to 1200 times/s at 20x).
     *
     * Signature: (input: { newTrades: SerialTrade[], state: State, barNs: bigint, horizon: bigint, params?: unknown }) => { points: OutputPoints, state: State }
     *
     * `newTrades` contains only the trades since the last horizon position.
     * `state` is whatever workerInit (or the previous workerUpdate) returned.
     * Returns new output points to append, plus the updated state.
     *
     * Must be pure - no imports, no closures.
     */
    workerUpdate: string;

    /**
     * Called on the main thread after workerInit completes (full load /
     * backward seek). Replaces all stored output data.
     *
     * `data` is whatever workerInit returned.
     */
    hydrate(data: unknown, barNs: bigint): void;

    /**
     * Called on the main thread after workerUpdate completes (horizon advance).
     * Appends the new output points to existing stored data - never replaces.
     *
     * `points` is whatever workerUpdate returned in the `points` field.
     */
    appendHydrate(points: unknown, barNs: bigint): void;

    drawBase?(ctx: RenderContext): void;
    drawUI?(ctx: RenderContext, crosshair: Crosshair): void;
    getAutoYBounds?(
        tMin: bigint,
        tMax: bigint,
        horizon: bigint,
    ): { min: number; max: number } | null;
}

// Layout helpers
export const PANE_DIVIDER_HIT = 6;
export const PANE_MIN_HEIGHT_RATIO = 0.05;

export function getPaneLayouts(
    panes: ChartPane[],
    totalH: number,
    canvasW: number,
    yAxisWidth: number,
): Record<string, Rect> {
    const cssW = canvasW;
    const totalRatio = panes.reduce((s, p) => s + p.heightRatio, 0);
    const layouts: Record<string, Rect> = {};
    let y = 0;
    for (const pane of panes) {
        const h = (pane.heightRatio / totalRatio) * totalH;
        layouts[pane.id] = { x: 0, y, w: cssW - yAxisWidth, h };
        y += h;
    }
    return layouts;
}

export function hitTestDivider(
    mouseY: number,
    panes: ChartPane[],
    layouts: Record<string, Rect>,
): number {
    for (let i = 0; i < panes.length - 1; i++) {
        const rect = layouts[panes[i].id];
        const dividerY = rect.y + rect.h;
        if (Math.abs(mouseY - dividerY) <= PANE_DIVIDER_HIT / 2) return i;
    }
    return -1;
}

export function hitTestPane(
    mouseY: number,
    panes: ChartPane[],
    layouts: Record<string, Rect>,
): ChartPane | null {
    return (
        panes.find((p) => {
            const l = layouts[p.id];
            return mouseY >= l.y && mouseY < l.y + l.h;
        }) ?? null
    );
}
