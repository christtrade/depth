/**
 * Contract for plugins that register a custom chart type (e.g. a Renko,
 * Kagi, or custom orderflow renderer). Plugins declare type: 'chart-type'
 * and require the 'chart-type:register' permission.
 *
 * Computation runs in a dedicated worker (workerInit / workerUpdate), then
 * the main thread receives the output via hydrate / appendHydrate and draws
 * it each frame via draw().
 */

import type { ChartPlugin, BottomBarHandle } from './IChartPlugin';
import type { LiveTransformer } from '../ICoordinateTransformer';
import type { TypedEventBus } from '../../core/TypedEventBus';
import type { ViewBounds } from '../../lib/types';
import type { FootprintBar } from '../../lib/types/footprint';
import type { TradePoint, PriceHistory } from '../../lib/types';
import type { Rect } from '../../lib/types/indicator-types';
import type { ChartSettings } from '../../lib/types/chart-settings';
import type { StyleField } from '../../components/drawings/drawing-settings-dialog';

// Context types
export interface ChartTypeActiveContext {
    requestRedraw(): void;
    setCursor(cursor: string): void;
    eventBus: TypedEventBus;
    registerBottomBarItem(id: string, render: () => React.ReactNode): BottomBarHandle;
}

export interface ChartTypePointerEvent {
    /** Data-space timestamp (nanoseconds). */
    ts: bigint;
    price: number;
    x: number;
    y: number;
    shiftKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    buttons: number;
    ctx: ChartTypeActiveContext;
}

export interface ChartTypeKeyEvent {
    key: string;
    code: string;
    shiftKey: boolean;
    ctrlKey: boolean;
    ctx: ChartTypeActiveContext;
}

export interface ChartTypeRenderContext {
    ctx: CanvasRenderingContext2D;
    rect: Rect;
    view: ViewBounds;
    transformer: LiveTransformer;
    footprintBars: FootprintBar[];
    trades: TradePoint[];
    priceHistory: PriceHistory[];
    barNs: bigint;
    chartSettings: ChartSettings;
    /** The hydrated computed state (whatever workerInit / appendHydrate returned). */
    computed: unknown;
}

// Chart type plugin interface
export interface ChartTypePlugin extends ChartPlugin {
    type: 'chart-type';

    /** Unique identifier registered with ChartTypeRegistry. */
    chartTypeId: string;

    /** Human-readable label shown in the chart type picker. */
    label: string;

    /** Icon shown in the chart type picker. */
    icon: React.ReactNode;

    /**
     * Fields shown in the chart settings dialog while this chart type is
     * active. Build them with the `StyleField` helpers exported alongside the
     * drawing settings dialog.
     */
    settingsSchema?: StyleField[];

    /** Starting value for every key in `settingsSchema`. */
    defaultSettings?: Record<string, unknown>;

    /**
     * The user changed a setting. Receives the full set, not just the change.
     * Values are persisted with the chart under `ChartSettings.pluginSettings`,
     * keyed by `chartTypeId`, and are also on the render context as
     * `chartSettings.pluginSettings[chartTypeId]`.
     */
    onSettingsChange?(settings: Record<string, unknown>): void;

    /**
     * Serialized pure function - runs in the chart type's dedicated worker on
     * initial load, backward seek, or timeframe change.
     *
     * Signature: ({ data, barNs, params }) => State
     *
     * Must be pure - no imports, no closures, no side effects.
     */
    workerInit?: string;

    /**
     * Serialized pure function - runs in the worker on every horizon tick.
     *
     * Signature: ({ newData, data, state, barNs, horizon, params }) => { points, state }
     *
     * Must be pure - no imports, no closures, no side effects.
     */
    workerUpdate?: string;

    /**
     * Called on the main thread after workerInit completes.
     * Receives the full computed state and should replace any stored output.
     */
    hydrate?(data: unknown, barNs: bigint): void;

    /**
     * Called on the main thread after workerUpdate completes.
     * Receives the incremental output - append it, do not replace.
     */
    appendHydrate?(points: unknown, barNs: bigint): void;

    /** Called every frame by RenderEngine to draw the chart type. Required. */
    draw(context: ChartTypeRenderContext): void;

    /** Return custom y-axis bounds, or null to use default price scaling. */
    getAutoYBounds?(
        tMin: bigint,
        tMax: bigint,
        horizon: bigint,
    ): { min: number; max: number } | null;

    /** Called when the user switches TO this chart type. */
    onActivate?(ctx: ChartTypeActiveContext): void;

    /** Called when the user switches AWAY from this chart type. */
    onDeactivate?(): void;

    onPointerDown?(event: ChartTypePointerEvent): boolean | void;
    onPointerMove?(event: ChartTypePointerEvent): boolean | void;
    onPointerUp?(event: ChartTypePointerEvent): boolean | void;
    onKeyDown?(event: ChartTypeKeyEvent): boolean | void;

    /** Called when the crosshair hovers over a bar. */
    onBarHover?(ts: bigint, price: number, barNs: bigint): void;

    /** Return a custom crosshair tooltip string, or null for the default. */
    getTooltip?(ts: bigint, price: number): string | null;
}
