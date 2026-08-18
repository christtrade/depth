/**
 * Contract for indicator plugins. Indicators extend ChartPlugin with
 * type: 'indicator' and a declarative rendering model mirroring ChartTypePlugin:
 * heavy computation runs in a worker (workerInit / workerUpdate), the main
 * thread receives the output via hydrate / appendHydrate, and drawBase /
 * drawUI are called every frame.
 *
 * Requires at minimum 'data:read' + 'render:overlay' permissions.
 * Pane-layout indicators additionally require 'ui:pane'.
 */

import type { ChartPlugin } from './IChartPlugin';
import type { LiveTransformer } from '../ICoordinateTransformer';
import type { Rect } from '../../lib/types/indicator-types';

// Render context
/**
 * Everything an indicator needs to draw one frame.
 * Coordinates are in LOCAL pane space - origin is the top-left of this pane.
 */
export interface IndicatorRenderContext {
    ctx: CanvasRenderingContext2D;
    /** Pane bounding rect in local coordinates. */
    rect: Rect;
    /** Visible time range (nanoseconds). */
    tMin: bigint;
    tMax: bigint;
    /** Pane price/value axis range. */
    yMin: number;
    yMax: number;
    /** Active bar duration in nanoseconds. 0n = tick/raw mode. */
    barNs: bigint;
    /**
     * Current playback horizon in nanoseconds.
     * Never draw data beyond this timestamp - doing so leaks future data.
     * 0n means live / full-history mode.
     */
    horizon: bigint;
    transformer: LiveTransformer;
}

// Crosshair
export interface IndicatorCrosshair {
    /** Canvas pixel x. */
    x: number;
    /** Canvas pixel y. */
    y: number;
}

// Indicator plugin interface
export interface IndicatorPlugin extends ChartPlugin {
    type: 'indicator';

    /** Where the indicator renders. */
    layout: 'overlay' | 'pane';

    /**
     * Pane id to render in when layout === 'pane'.
     * If omitted, a new pane is created automatically.
     */
    paneId?: string;

    /**
     * Serialized pure function - runs in the indicator worker on initial load,
     * backward seek, or timeframe change.
     *
     * Signature:
     *   (input: { trades: SerialTrade[], ohlcv: OhlcvBar[], barNs: bigint, params?: unknown }) => State
     *
     * Must be pure - no imports, no closures, no side effects.
     */
    workerInit?: string;

    /**
     * Serialized pure function - runs in the worker on every horizon tick.
     *
     * Signature:
     *   (input: { newTrades: SerialTrade[], state: State, barNs: bigint, horizon: bigint, params?: unknown }) => { points: Points, state: State }
     *
     * Must be pure - no imports, no closures, no side effects.
     */
    workerUpdate?: string;

    /**
     * Called on the main thread after workerInit completes.
     * Receives the full computed state - replace all stored output.
     */
    hydrate?(data: unknown, barNs: bigint): void;

    /**
     * Called on the main thread after workerUpdate completes.
     * Receives incremental output - append, do not replace.
     */
    appendHydrate?(points: unknown, barNs: bigint): void;

    /**
     * Draw the indicator lines / fills / bars.
     * Called every frame after the base chart layer.
     */
    drawBase?(ctx: IndicatorRenderContext): void;

    /**
     * Draw crosshair-aware UI: value labels, legend markers, tooltip overlays.
     * Called every frame when the crosshair is visible.
     */
    drawUI?(ctx: IndicatorRenderContext, crosshair: IndicatorCrosshair | null): void;

    /** Return custom y-axis bounds for this pane, or null to use auto-scaling. */
    getAutoYBounds?(
        tMin: bigint,
        tMax: bigint,
        horizon: bigint,
    ): { min: number; max: number } | null;
}
