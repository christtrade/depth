/**
 * Base contract for all DepthChart plugins. Every plugin type
 * (drawing, chart-type, indicator, data-source, extension) extends
 * ChartPlugin and is installed through PluginContext.
 */

import type { TypedEventBus, InterceptableEvent, Interceptor } from '../../core/TypedEventBus';
import type { RenderEngine, DrawHook } from '../../core/RenderEngine';
import type { ExecutionEngine } from '../../core/ExecutionEngine';
import type { GlobalChartBus } from '../../core/GlobalChartBus';
import type { LiveTransformer } from '../ICoordinateTransformer';
import type { DataLevel, OhlcvBar, SymbolInfo, TickEvent } from '../IDataAdapter';
import type { SerialTrade, PriceHistory } from '../../lib/types';
import type { FootprintBar } from '../../lib/types/footprint';
import type { BracketAmendment } from '../../lib/types/trading-types';
import type { PlaceOrderRequest } from '../../lib/matchingEngine';

// Plugin classification
export type PluginType =
    | 'indicator'
    | 'drawing'
    | 'chart-type'
    | 'data-source'
    | 'extension'
    | 'strategy';

// Permissions
export type Permission =
    | 'data:read' // read ohlcv/trades/ticks via getData()
    | 'data:write' // inject synthetic bars (custom data sources)
    | 'eventbus:emit' // emit arbitrary events (not just listen)
    | 'eventbus:intercept' // intercept + mutate events before they fire
    | 'ui:pane' // register a sub-pane below the chart
    | 'ui:panel' // register a dockable/floating panel
    | 'ui:toolbar' // add toolbar buttons
    | 'ui:context-menu' // add items to right-click menus
    | 'render:overlay' // draw on the chart canvas
    | 'render:shader' // replace the base render pipeline
    | 'drawing:register' // register a custom drawing tool
    | 'chart-type:register' // register a custom chart type
    | 'theme:register' // register a custom theme
    | 'audio' // play sounds
    | 'network' // fetch external data
    | 'storage' // persist data between sessions
    | 'intercept' // intercept and override chart event bus emissions
    | 'execution:read' // read orders/positions
    | 'execution:write'; // place/cancel orders

// Toolbar / UI surface
export interface ToolbarItem {
    id: string;
    title: string;
    icon?: React.ReactNode;
    onClick: () => void;
    active?: boolean;
    disabled?: boolean;
}

export interface BottomBarHandle {
    rerender(): void;
    destroy(): void;
}

export interface FloatingPanelOpts {
    element: React.ReactNode;
    title?: string;
    initialPosition?: { x: number; y: number };
    initialSize?: { width: number; height: number };
    resizable?: boolean;
    visible?: boolean;
}

export interface ContextMenuItem {
    id: string;
    label: string;
    icon?: React.ReactNode;
    shortcut?: string;
    disabled?: boolean;
    separator?: boolean;
    onClick: () => void;
}

// Theme
export interface ThemeDef {
    id: string;
    name: string;
    /** CSS variables to inject - keys are var names without the leading '--'. */
    vars: Record<string, string>;
}

// Settings schema
export type SettingSchemaType = 'number' | 'string' | 'boolean' | 'color' | 'select';

export interface SettingSchema {
    type: SettingSchemaType;
    label?: string;
    default?: unknown;
    min?: number;
    max?: number;
    step?: number;
    options?: Array<{ value: unknown; label: string }>;
}

// Storage
export interface PluginStorage {
    get<T>(key: string, fallback: T): T;
    set<T>(key: string, value: T): void;
    delete(key: string): void;
    /** Clears only this plugin's keys. */
    clear(): void;
}

// Services
export type ServiceApi = Record<string, (...args: any[]) => any>;

export interface ServiceObserver<T extends ServiceApi> {
    onAvailable: (api: T) => void;
    onRemoved?: () => void;
}

export interface PluginServices {
    register<T extends ServiceApi>(name: string, api: T): () => void;
    get<T extends ServiceApi>(name: string): T | null;
    on<T extends ServiceApi>(name: string, observer: ServiceObserver<T>): () => void;
}

// Scheduling
export interface PluginSchedule {
    /** Managed repeating timer - auto-cancelled on plugin teardown. */
    interval(ms: number, fn: () => void): () => void;
    /** Managed one-shot timer - auto-cancelled on plugin teardown. */
    timeout(ms: number, fn: () => void): () => void;
    /** Managed animation-frame callback - auto-cancelled on plugin teardown. */
    raf(fn: () => void): () => void;
}

// Notifications
export type NotifyLevel = 'info' | 'success' | 'warn' | 'error';

export interface NotifyOptions {
    title: string;
    body?: string;
    level?: NotifyLevel;
    /** ms. Default 4000. Pass Infinity for sticky. */
    duration?: number;
    action?: { label: string; onClick: () => void };
}

// Playback
export interface PluginStateSnapshot {
    serialize(): unknown;
    restore(state: unknown): void;
}

// Execution surface
export interface PluginExecutionSurface {
    placeOrder(req: PlaceOrderRequest): string | Promise<string> | undefined;
    cancelOrder(orderId: string): void;
    amendOrder(orderId: string, newPrice: number): void;
    amendBracket(amendment: BracketAmendment): void;
    closePosition(positionId: string): void;
    reversePosition(positionId: string): void;
    totalRealizedPnl(): number;
    totalFeesPaid(): number;
}

// Lifecycle hooks
export interface PluginLifecycle {
    onSymbolChange(cb: (symbol: string) => void): () => void;
    onTimeframeChange(cb: (tf: string) => void): () => void;
    onThemeChange(cb: (theme: 'light' | 'dark') => void): () => void;
    onFocus(cb: (id: number) => void): () => void;
    onBlur(cb: () => void): () => void;
}

// Pane
export interface PaneOptions {
    heightRatio?: number;
    minHeightRatio?: number;
}

// Data snapshot
export interface PluginDataSnapshot {
    trades: SerialTrade[];
    footprintBars: FootprintBar[];
    priceHistory: PriceHistory[];
    /** Always present - synthesised from footprintBars when dataLevel is l3/tick. */
    ohlcvBars: OhlcvBar[];
    /** Populated when dataLevel is tick or l3. */
    ticks: TickEvent[];
    barNs: bigint;
    dataStart: number;
    dataEnd: number;
    symbolInfo: SymbolInfo | null;
    dataLevel: DataLevel;
}

// Bottom bar handle (returned by registerBottomBarItem)
export interface BottomBarItem {
    id: string;
    render: () => React.ReactNode;
}

// Plugin context
/**
 * The surface passed to every plugin's install() method. All capabilities
 * are gated by the plugin's declared permissions - calls without the required
 * permission throw at runtime.
 */
export interface PluginContext {
    global: GlobalChartBus;
    eventBus: TypedEventBus;
    renderEngine: RenderEngine;
    executionEngine: ExecutionEngine;
    transformer: LiveTransformer;
    dataLevel: DataLevel;
    horizon: () => number;

    getData(): Readonly<PluginDataSnapshot>;

    /**
     * The bar still being built at the playback horizon, or `null` before any
     * data has arrived.
     *
     * This is the one you want for "what is the price right now". The last entry
     * of `getData().ohlcvBars` is the last bar that was *loaded*, which during
     * replay is somewhere in the future and at the fetch resolution rather than
     * the charted timeframe.
     *
     * A snapshot - it is copied out of the live bar, so holding onto it gives you
     * a stale bar. Call it again.
     */
    openBar(): OhlcvBar | null;

    // Panes & panels
    registerPane(id: string, opts?: PaneOptions): () => void;
    registerPanel(
        id: string,
        element: React.ReactNode,
        title?: string,
        visible?: boolean,
    ): () => void;

    // Settings
    getSettings<T>(defaults: T): T;
    saveSettings<T>(patch: Partial<T>): void;

    // Rendering
    addOverlay(phase: 'before-base' | 'after-base' | 'after-ui', hook: DrawHook): () => void;

    // UI surface
    registerToolbarItem(item: ToolbarItem): () => void;
    registerBottomBarItem(id: string, render: () => React.ReactNode): BottomBarHandle;
    registerContextMenuItem(item: ContextMenuItem): () => void;

    // Drawing tools
    /** See PluginDrawingToolDef in core/DrawingRegistry for the full type. */
    registerDrawingTool(tool: {
        id: string;
        name: string;
        anchorCount: number | 'dynamic';
        render(ctx: any): void;
        hitTest(ctx: any): boolean | string | null;
        [key: string]: any;
    }): () => void;

    // Theme
    registerTheme(theme: ThemeDef): () => void;

    // Audio
    playSound(id: string | AudioBuffer): void;

    // Data source
    /**
     * Claim symbols and serve their data yourself - a derived instrument, or a
     * whole venue behind the user's own API key. A source is an IDataAdapter
     * with a claim on top; see PluginDataSource in core/DataSourceRegistry.
     */
    registerDataSource(source: { [key: string]: any }): () => void;

    // Storage
    storage: PluginStorage;

    // Network
    /** Sandboxed fetch - only allowed origins declared in the plugin manifest. */
    fetch(url: string, init?: RequestInit): Promise<Response>;

    // Behavior intercept
    intercept<K extends InterceptableEvent>(event: K, interceptor: Interceptor<K>): () => void;

    // Execution
    /** null when neither execution:read nor execution:write is declared. */
    execution: PluginExecutionSurface | null;

    // Lifecycle, schedule, notifications
    services: PluginServices;
    schedule: PluginSchedule;
    lifecycle: PluginLifecycle;
    notify(opts: NotifyOptions): void;

    playback: {
        registerState(snapshot: PluginStateSnapshot): () => void;
    };
}

// Base plugin interface
export interface ChartPlugin {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly type: PluginType;
    readonly permissions?: Permission[];
    /**
     * Origins `ctx.fetch` may talk to, e.g. `['https://api.massive.com']`.
     * Anything else throws. A plugin holding the user's API key can only send
     * it where it declared it would.
     */
    readonly origins?: string[];
    readonly category?: string;
    /** Source code string - used by the scripted plugin system. */
    readonly code: string;
    /**
     * Minimum data level this plugin requires. Defaults to 'ohlcv'.
     * The registry skips the plugin and emits 'plugin:incompatible' if the
     * chart's data level does not satisfy this.
     */
    readonly require?: DataLevel;

    install(ctx: PluginContext): void | (() => void) | Promise<void | (() => void)>;
    uninstall?(ctx: PluginContext): void;
}

// Plugin manifest (for scripted / remote plugins)
export interface PluginManifest {
    id: string;
    name: string;
    version: string;
    type: PluginType;
    script: string;
    permissions: Permission[];
    /** Origins `ctx.fetch` may reach. See ChartPlugin.origins. */
    origins?: string[];
    settings?: Record<string, SettingSchema>;
}
