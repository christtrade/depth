// per-pane state owner, one per chart pane in a layout. it owns whatever is
// independent between panes: symbol, timeframe, visual settings, active tool,
// footprint options, and which shared-pool plugins the pane uses.
//
// it deliberately doesnt own drawings, which belong to the symbol so they follow
// the instrument when a pane swaps, or the view, since pan/zoom is ephemeral and
// panes auto-fit on a symbol switch anyway.
//
// pure state container - it never emits on the bus. global engine events are
// focus-dependent, so the wiring layer decides when to emit for the focused
// pane; a model emitting blindly would mis-route changes from the others.
import { nanoid } from 'nanoid';
import { resolveTimeframe, type Timeframe } from '../lib/timeframes';
import type { DrawingTool } from '../lib/types/drawing-types';
import type { FootprintOptions } from '../lib/types/footprint';
import type { ChartSettings } from '../lib/types/chart-settings';
import {
    DEFAULT_CHART_SETTINGS,
    diffChartSettings,
    mergeChartSettings,
} from '../lib/types/chart-settings';

/**
 * A pane's reference to a plugin from the shared pool. The plugin's code lives
 * once in the pool; the pane only stores which one it uses and how.
 */
export interface ChartPluginRef {
    /** Plugin id in the shared pool. */
    id: string;
    /** Unique per activation, so the same plugin can be added more than once. */
    instanceId: string;
    /** User inputs for this instance (e.g. an indicator's `settings`). */
    config?: Record<string, unknown>;
    /**
     * State the plugin explicitly persisted through its storage. Never derived
     * series - those recompute from price action on restore.
     */
    state?: Record<string, unknown>;
}

export interface ChartModelInit {
    id?: string;
    symbol: string;
    timeframe: Timeframe;
    settings?: ChartSettings;
    activeTool?: DrawingTool;
    fpOptions?: FootprintOptions;
    plugins?: ChartPluginRef[];
}

/**
 * Serializable snapshot of one pane. Drawings aren't here - they belong to the
 * symbol, see DrawingStore. `settings` is a diff against
 * DEFAULT_CHART_SETTINGS, and `timeframe` is the label, re-resolved on restore.
 */
export interface ChartPaneState {
    id: string;
    symbol: string;
    timeframe: string;
    settings: Partial<ChartSettings>;
    plugins: ChartPluginRef[];
}

type Listener = (model: ChartModel) => void;

export class ChartModel {
    readonly id: string;

    private _symbol: string;
    private _timeframe: Timeframe;
    private _settings: ChartSettings;
    private _activeTool: DrawingTool;
    private _fpOptions: FootprintOptions;
    private _plugins: ChartPluginRef[];

    // refs from a restore still waiting to be rebuilt into live indicators. kept
    // apart from _plugins because the pane mirrors its empty initial indicator
    // list over that on mount, which would wipe the restore before reconciliation
    // ever reads it. each ref is consumed once its indicator is re-activated.
    private _restoredPlugins: ChartPluginRef[] = [];

    private listeners = new Set<Listener>();

    constructor(init: ChartModelInit) {
        this.id = init.id ?? `pane:${nanoid(6)}`;
        this._symbol = init.symbol;
        this._timeframe = init.timeframe;
        this._settings = init.settings ?? { ...DEFAULT_CHART_SETTINGS };
        this._activeTool = init.activeTool ?? 'cursor';
        this._fpOptions = init.fpOptions ?? {};
        this._plugins = init.plugins ? [...init.plugins] : [];
    }

    // Symbol
    get symbol(): string {
        return this._symbol;
    }
    setSymbol(symbol: string): void {
        if (symbol === this._symbol) return;
        this._symbol = symbol;
        this._notify();
    }

    // Timeframe
    get timeframe(): Timeframe {
        return this._timeframe;
    }
    setTimeframe(tf: Timeframe): void {
        if (tf === this._timeframe) return;
        this._timeframe = tf;
        this._notify();
    }

    // Active tool
    get activeTool(): DrawingTool {
        return this._activeTool;
    }
    setActiveTool(tool: DrawingTool): void {
        if (tool === this._activeTool) return;
        this._activeTool = tool;
        this._notify();
    }

    // Footprint options
    get fpOptions(): FootprintOptions {
        return this._fpOptions;
    }
    setFpOptions(fpOptions: FootprintOptions): void {
        this._fpOptions = fpOptions;
        this._notify();
    }

    // Settings
    get settings(): Readonly<ChartSettings> {
        return this._settings;
    }
    /** Merge a patch into this pane's settings. Independent per pane. */
    setSettings(patch: Partial<ChartSettings>): void {
        this._settings = { ...this._settings, ...patch };
        this._notify();
    }

    // Plugin refs
    get plugins(): readonly ChartPluginRef[] {
        return this._plugins;
    }
    /** Activate a pool plugin on this pane, or replace an existing instance. */
    use(ref: ChartPluginRef): void {
        const idx = this._plugins.findIndex((p) => p.instanceId === ref.instanceId);
        if (idx === -1) this._plugins = [...this._plugins, ref];
        else this._plugins = this._plugins.map((p, i) => (i === idx ? ref : p));
        this._notify();
    }
    unuse(instanceId: string): void {
        const next = this._plugins.filter((p) => p.instanceId !== instanceId);
        if (next.length === this._plugins.length) return;
        this._plugins = next;
        this._notify();
    }
    /** Replace the whole set of refs, e.g. mirrored from a pane's live list. */
    setPlugins(refs: ChartPluginRef[]): void {
        this._plugins = [...refs];
        this._notify();
    }

    /** Plugin refs from a restore awaiting reconstruction into live indicators. */
    get restoredPlugins(): readonly ChartPluginRef[] {
        return this._restoredPlugins;
    }
    /** Drop a restored ref once its indicator is back, so removing it later
     *  doesn't re-add it. */
    consumeRestoredPlugin(instanceId: string): void {
        this._restoredPlugins = this._restoredPlugins.filter((p) => p.instanceId !== instanceId);
    }

    // (De)serialization
    serialize(): ChartPaneState {
        return {
            id: this.id,
            symbol: this._symbol,
            timeframe: this._timeframe.label,
            settings: diffChartSettings(this._settings),
            plugins: this._plugins.map((p) => ({ ...p })),
        };
    }

    /** Apply a saved pane snapshot. Panes read this on init, and the live owner
     *  mirrors it back out from then on. */
    restore(state: ChartPaneState): void {
        this._symbol = state.symbol;
        this._timeframe = resolveTimeframe(state.timeframe);
        this._settings = mergeChartSettings(state.settings);
        this._plugins = state.plugins ? [...state.plugins] : [];
        // queued for reconstruction, survives the empty-list mirror on mount
        this._restoredPlugins = state.plugins ? [...state.plugins] : [];
        this._notify();
    }

    // Subscriptions
    subscribe(fn: Listener): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    private _notify(): void {
        for (const fn of this.listeners) fn(this);
    }
}
