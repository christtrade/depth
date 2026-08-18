// the controller. one instance owns a chart's engines, state, panes, plugins and
// account, and is the whole public API. React is a view on top of it -
// useDepthChart() builds one and hands back its element.

import { DataEngine, type DataEngineConfig } from './DataEngine';
import type { IDataAdapter, OhlcvBar, SymbolInfo } from '../interfaces/IDataAdapter';
import type { IExecutionAdapter } from '../interfaces/IExecutionAdapter';
import type { IAccountAdapter } from '../interfaces/IAccountAdapter';
import type { ActiveDrawingTool, Drawing } from '../lib/types/drawing-types';
import { CURSOR_TOOL, toolFromDrawing } from '../lib/types/drawing-types';
import { parseCustomTimeframe, PRESET_TIMEFRAMES, type Timeframe } from '../lib/timeframes';
import type { ChartSettings } from '../lib/types/chart-settings';
import type { FootprintBar, FootprintOptions } from '../lib/types/footprint';
import { PRESETS, type DepthProps } from '../ChartOuter';
import { ExecutionEngine } from './ExecutionEngine';
import type { FillSearchOptions } from '../lib/matchingEngine';
import { LiveTransformer } from '../interfaces/ICoordinateTransformer';
import {
    BottomBarHandle,
    BottomBarItem,
    ChartPlugin,
    InstalledPlugin,
    PaneOptions,
    PluginContext,
    PluginRegistry,
    PluginStorage,
    PluginType,
    ToolbarItem,
} from './PluginRegistry';
import { RenderEngine, type DrawHook } from './RenderEngine';
import {
    ChartEvents,
    TypedEventBus,
    type InterceptableEvent,
    type Interceptor,
} from './TypedEventBus';
import { ChartState } from './ChartState';
import type { SyncInLayout } from '../lib/types/layout-sync';
import { ChartModel, type ChartPaneState } from './ChartModel';
import { DrawingStore } from './DrawingStore';
import type { DataLevel } from '../interfaces/IDataAdapter';
import { ChartPane, Indicator } from '../lib/types/indicator-types';
import {
    AccountManager,
    LedgerAdjustment,
    LedgerFill,
    LedgerOrder,
    LedgerPosition,
    type AccountSaveState,
} from './AccountManager';
import { createScriptedPlugin } from './ScriptedPlugin';
import { PlaybackController } from './Playback';
import { DrawingRegistry } from './DrawingRegistry';
import { nanoid } from 'nanoid';
import { globalChartBus } from './GlobalChartBus';
import { DataSourceRegistry, type PluginDataSource } from './DataSourceRegistry';
import { PlaybackStateRegistry } from './PlaybackStateRegistry';
import { PluginScheduleImpl } from './PluginSchedule';
import { toast } from 'sonner';
import type { NotifyOptions, PluginExecutionSurface, PluginStateSnapshot } from './PluginRegistry';
import { PlaybackMode, type PrefetchOptions } from '../hooks/usePlaybackEngine';
import {
    pluginSettingsKey,
    pluginStorageKey,
    pluginStoragePrefix,
    readJSON,
    removeStored,
    removeStoredByPrefix,
    restoreChartPreferences,
    serializeChartPreferences,
    writeJSON,
    type ChartPreferences,
} from '../lib/storage';
import { importTradingViewSettings } from '../lib/tradingview-import';
import {
    ptrace,
    readPluginStartup,
    writePluginStartup,
    type PluginCatalogEntry,
    type PluginStartupEntry,
    type PluginStartupRecord,
} from './plugin-startup';
import { BUILTIN_INDICATORS } from '../plugins';

export interface FeaturesOptions {
    contextMenu?: boolean;
    plugins?:
        | boolean
        | {
              enabled?: boolean;
              indicators?: boolean;
              charts?: boolean;
              extensions?: boolean;
              drawings?: boolean;
          };
    timeframe?: {
        timeframes?: string[] | 'any';
        allowCustom?: boolean;
    };
}

const DEFAULT_FEATURES: FeaturesOptions = {
    contextMenu: true,
    plugins: {
        enabled: true,
        indicators: true,
        charts: true,
        extensions: true,
        drawings: true,
    },
};

export type TimePrecision = 's' | 'ms' | 'us' | 'ns';

export type PlaybackOptions = {
    /**
     * Tunes forward prefetch during continuous playback. Optional - the engine
     * measures real load latency and sizes the lead on its own.
     */
    prefetch?: PrefetchOptions;
};

export type AccountOptions = {
    initialBalance?: number;
    /** Settlement currency for the balance. Display only. Default: 'USD' */
    currency?: string;
    adapter?: IAccountAdapter;
    adjustments?: LedgerAdjustment[];
    fills?: LedgerFill[];
    positions?: LedgerPosition[];
    orders?: LedgerOrder[];
    /**
     * Tunes how skipped spans (from far jumps) are settled for fills. Accuracy
     * by default. Also adjustable at runtime via `chart.account.setFillSearch`.
     */
    fillSearch?: Partial<FillSearchOptions>;
};

export interface ChartOptions {
    dataAdapter: IDataAdapter;
    initialLoad: { start: string | number; end: string | number };
    playback?: PlaybackOptions;
    horizon: string | number;
    symbol: string;
    timePrecision?: TimePrecision;
    barNs?: bigint;
    fpOptions?: FootprintOptions;
    initialWindowNs?: bigint;
    prefetchWindowNs?: bigint;
    executionAdapter?: IExecutionAdapter;

    hideToolbar?: boolean;
    hideBottomToolbar?: boolean;
    hideDrawingToolbar?: boolean;
    hidePriceScale?: boolean;
    hideTimeScale?: boolean;
    hideStatusBar?: boolean;
    hideLegend?: boolean;

    timeframe?: string;
    debug?: {
        showDataStatusInBottomRightCorner?: boolean;
    };

    features?: FeaturesOptions;

    /**
     * Seed a first-run session from the user's TradingView preferences, if their
     * charting library left any in localStorage on this origin. Defaults to true.
     *
     * Only fills in settings that are currently unset, runs at most once per
     * device, and is skipped entirely when `restore` is supplied.
     */
    importTradingViewSettings?: boolean;

    account?: AccountOptions;

    /**
     * Saved state to restore on construction.
     * Obtain via chart.serialize(), pass back here on next mount.
     */
    restore?: ChartSaveState;

    toolbar?: (chart: DepthChart) => React.ReactNode[];
}

/** Bump when the save document shape changes incompatibly; handled in migrate(). */
export const SAVE_VERSION = 1;

// mirrors MAX in hooks/useCellBridges. not imported - that module pulls in
// ../core and would close a cycle
const MAX_PANE_CELLS = 8;

export interface LayoutDescriptor {
    id: string;
    label: string;
    count: number;
    cols: number;
    rows: number;
    areas: string;
}

export interface ChartSaveState {
    /** Schema version. Absent = legacy/pre-versioning. */
    version?: number;
    /** Grid layout descriptor (which preset, how many cells). */
    layout?: LayoutDescriptor;
    /** Which properties the layout's cells share (crosshair, symbol, ...). */
    syncInLayout?: SyncInLayout;
    /** Column/row divider sizes (fr) and the focused pane index. */
    gridColSizes?: number[];
    gridRowSizes?: number[];
    focusedPane?: number;
    /** Trading account. Controller-level - one account across every pane. */
    account?: AccountSaveState;
    /** Shared plugin pool: each plugin's id + code, stored once. Restored under
     *  the same id so a host re-installing it manually dedups. Pane plugin refs
     *  point at these ids. */
    plugins?: InstalledPlugin[];
    /** Drawings keyed by symbol - drawings follow the symbol, not the pane. */
    drawings?: Record<string, Drawing[]>;
    /** Per-pane state: independent symbol / timeframe / settings / plugin refs. */
    charts?: ChartPaneState[];
    /**
     * Device-level preferences that aren't per-pane: custom and favorite
     * timeframes, favorite drawings, drawing style templates, color swatches, and
     * each plugin's settings and KV store. Keyed by storage key.
     */
    preferences?: ChartPreferences;
}

// a save doc holds BigInts (drawing timestamp anchors) which JSON.stringify
// cant handle, so these tag/untag them to round-trip through a string
const BIGINT_TAG = '$bigint';

/** Serialize a save document to a JSON string, encoding BigInts losslessly. */
export function stringifyChartSave(state: ChartSaveState): string {
    return JSON.stringify(state, (_key, value) =>
        typeof value === 'bigint' ? { [BIGINT_TAG]: value.toString() } : value,
    );
}

/** Parse a JSON string produced by stringifyChartSave back into a save document. */
export function parseChartSave(json: string): ChartSaveState {
    return JSON.parse(json, (_key, value) =>
        value && typeof value === 'object' && typeof value[BIGINT_TAG] === 'string'
            ? BigInt(value[BIGINT_TAG])
            : value,
    );
}

// brings an older save doc up to SAVE_VERSION. basically a no-op today since v0
// is shape-compatible with v1, but the seam is here so a future shape change can
// transform old docs instead of breaking restore
function migrateSaveState(state: ChartSaveState): ChartSaveState {
    // the legacy pool format was string[] - code only, no id. cant be re-keyed to
    // dedup against a host's manual installs so just drop it; the host re-installs
    // on construction and the per-pane refs resolve against those
    if (Array.isArray(state.plugins) && state.plugins.some((p) => typeof p === 'string')) {
        return { ...state, plugins: [] };
    }
    return state;
}

function resolveTimeframe(label: string): Timeframe {
    const preset = PRESET_TIMEFRAMES.find((t) => t.label.toLowerCase() === label.toLowerCase());
    if (preset) return preset;
    const custom = parseCustomTimeframe(label);
    if (custom) return custom;
    throw new Error(`[ChristTrade] Unknown timeframe: "${label}"`);
}

type PlaybackAPI<T> = {
    play: () => T;
    pause: () => T;
    playing: boolean;
    stepSize: string;
    speed: number;
    mode: PlaybackMode;
    stepSnap: boolean;
    setStepSize: (step: string) => T;
    setSpeed: (speed: number) => T;
    stepBack: () => T;
    stepForward: () => T;
    setMode: (mode: PlaybackMode) => T;
    setStepSnap: (snap: boolean) => T;
    /** Current playhead position, epoch ns. */
    time: bigint;
    /** Jump the playhead. Accepts ns (bigint), epoch ms, a Date, or an ISO string. */
    goTo: (t: bigint | number | Date | string) => T;
    /**
     * Refuse every move that would put the playhead behind where it has already
     * been. Refused moves emit `playback:blocked` rather than failing silently.
     */
    lockForward: (on?: boolean) => T;
    /** Earliest time the playhead may move to, or null when it may move freely. */
    floor: bigint | null;
    allows: (tNs: bigint) => boolean;
};

export class DepthChart {
    readonly id: string;
    readonly eventBus: TypedEventBus;
    readonly executionEngine: ExecutionEngine;
    private readonly dataEngine: DataEngine;
    readonly transformer: LiveTransformer;
    private features: FeaturesOptions;
    private readonly pluginRegistry: PluginRegistry;
    private _renderEngine: RenderEngine | null = null;
    private _panelRegistry = new Map<
        string,
        { element: React.ReactNode; title: string; visible: boolean }
    >();
    private _toolbarRegistry = new Map<string, ToolbarItem>();
    private _bottomBarRegistry = new Map<string, BottomBarItem>();
    // keyed by cell id - every pane builds its own forming bar
    private _openBarProviders = new Map<number, () => FootprintBar | null>();
    //TODO: horizon becomes bigint for ns support
    private _horizon: number = 0;
    private readonly dataSources: DataSourceRegistry;
    private readonly drawingRegistry: DrawingRegistry;
    private destroyed = false;
    private registeredPlugins = new Map();
    private _pluginStateListeners = new Set<() => void>();
    private _pluginCatalog: (() => PluginCatalogEntry[]) | null = null;
    private playbackController: PlaybackController;
    private readonly playbackStateRegistry: PlaybackStateRegistry;
    private readonly pluginSchedules = new Map<string, PluginScheduleImpl>();

    readonly state: ChartState;

    // per-pane state owners, created lazily per cell index in getChart, plus the
    // controller-level per-symbol drawing store. these are the source of truth
    // being migrated to; consumers move onto them slice by slice, and until then
    // `state` stays authoritative for the focused pane
    private readonly _panes = new Map<number, ChartModel>();
    readonly drawingStore: DrawingStore;

    readonly account: AccountManager | null;

    public playback: PlaybackAPI<DepthChart>;

    private timePrecision: TimePrecision = 'ms';

    constructor(private readonly options: ChartOptions) {
        this.id = `chart:${nanoid(6)}`;
        this.eventBus = new TypedEventBus();
        this.transformer = new LiveTransformer();
        this.executionEngine = new ExecutionEngine();
        this.executionEngine.setEventBus(this.eventBus);
        this.features = DEFAULT_FEATURES;
        this._horizon =
            typeof options.horizon === 'number'
                ? options.horizon
                : new Date(options.horizon).getTime();

        for (const key in options?.features ?? {}) {
            this.features[key] = options.features[key];
        }

        if (options.executionAdapter) {
            this.executionEngine.setCustomAdapter(options.executionAdapter);
        }

        const timeframeOpts: { timeframes: 'any' | string[]; allowCustom: boolean } = {
            timeframes: 'any',
            allowCustom: true,
        };

        if (options?.features?.timeframe?.timeframes) {
            if (
                Array.isArray(options.features.timeframe.timeframes) ||
                options.features.timeframe.timeframes === 'any'
            ) {
                timeframeOpts.timeframes = options.features.timeframe.timeframes;
            }
        }
        if (typeof options?.features?.timeframe?.allowCustom === 'boolean') {
            timeframeOpts.allowCustom = options.features.timeframe.allowCustom;
        }

        this.features.timeframe = timeframeOpts;

        const pluginOpts = {
            enabled: true,
            indicators: true,
            drawings: true,
            charts: true,
            extensions: true,
        };

        if (options?.features?.plugins || typeof options?.features?.plugins === 'boolean') {
            const opts = options.features.plugins;

            if (typeof opts === 'boolean') pluginOpts.enabled = opts;
            else if (typeof opts === 'object') {
                for (const key in opts) {
                    pluginOpts[key] = opts[key];
                }
            } else {
                console.warn('[ChristTrade] Invalid plugin options, skipping');
            }
        }

        this.pluginRegistry = new PluginRegistry();
        this.pluginRegistry.setOptions(pluginOpts);
        this.pluginRegistry.setEventBus(this.eventBus);

        this.drawingRegistry = new DrawingRegistry();

        this.eventBus.on('render-engine:ready', ({ engine }) => {
            this.attachRenderEngine(engine);
        });

        this.eventBus.on('data:open-bar-provider', ({ cellId, get }) => {
            if (get) this._openBarProviders.set(cellId, get);
            else this._openBarProviders.delete(cellId);
        });

        this.eventBus.on(
            'plugin:register-indicator',
            ({ indicator, activeByDefault, pane, lookback }) => {
                this.registeredPlugins.set(indicator.id, {
                    indicator,
                    activeByDefault,
                    pane,
                    lookback: lookback ?? 0,
                });

                this.dataEngine.setLookback(this.getMaxLookbackBars());
            },
        );

        // a torn-down plugin's capability defs must not outlive it or the
        // indicators dropdown keeps offering one whose worker is gone
        this.eventBus.on('plugin:uninstalled', ({ id }) => {
            let changed = false;
            for (const key of [...this.registeredPlugins.keys()]) {
                if (key === id || key.startsWith(`${id}:`)) {
                    this.registeredPlugins.delete(key);
                    changed = true;
                }
            }
            if (changed) this.dataEngine.setLookback(this.getMaxLookbackBars());
            this._notifyPluginState();
        });

        this.eventBus.on('plugin:installed', () => this._notifyPluginState());

        this.eventBus.on('playback:seek', ({ tNs }) => {
            this._horizon = Number(tNs / 1_000_000n);
        });

        const timeframe = options?.timeframe
            ? resolveTimeframe(options.timeframe)
            : PRESET_TIMEFRAMES.find((t) => t.label === '1m')!;

        if (options?.timePrecision) {
            this.timePrecision = options.timePrecision;
        }

        const horizon = new Date(options.horizon).toISOString();
        const initialLoad = {
            start: new Date(options.initialLoad.start).toISOString(),
            end: new Date(options.initialLoad.end).toISOString(),
        };

        this.state = new ChartState({
            activeTool: CURSOR_TOOL,
            selectedDrawingId: null,
            symbol: options.symbol,
            fpOptions: options.fpOptions ?? {},
            isPlaying: false,
            horizonIso: horizon,
            timeframe,
            layout: PRESETS[0],
        });

        this.drawingStore = new DrawingStore();
        this.dataSources = new DataSourceRegistry();

        const dataConfig: DataEngineConfig = {
            initialLoad: initialLoad,
            horizon: horizon,
            fpOptions: options.fpOptions,
            initialWindowNs: options.initialWindowNs,
            timeframe,
            symbol: options.symbol,
            plugins: this.dataSources,
        };

        this.dataEngine = new DataEngine(this.eventBus, this.state, dataConfig);
        this.dataEngine.setAdapter(options.dataAdapter);
        this.dataEngine.attachExecutionEngine(this.executionEngine);

        this.playbackController = new PlaybackController(
            this.eventBus,
            BigInt(Math.round(this._horizon)) * 1_000_000n,
        );
        const controller = this.playbackController;

        this.playback = {
            play: () => {
                controller.play();
                return this;
            },
            pause: () => {
                controller.pause();
                return this;
            },
            get playing() {
                return controller.playing();
            },
            get stepSize() {
                return controller.stepSize();
            },
            get speed() {
                return controller.speed();
            },
            get mode() {
                return controller.mode();
            },
            get stepSnap() {
                return controller.stepSnap();
            },
            setStepSize: (step: string) => {
                controller.setStepSize(step);
                return this;
            },
            setSpeed: (speed: number) => {
                controller.setSpeed(speed);
                return this;
            },
            stepBack: () => {
                controller.stepBack();
                return this;
            },
            stepForward: () => {
                controller.stepForward();
                return this;
            },
            setMode: (mode: PlaybackMode) => {
                controller.setMode(mode);
                return this;
            },
            setStepSnap: (snap: boolean) => {
                controller.setStepSnap(snap);
                return this;
            },
            get time() {
                return controller.time();
            },
            goTo: (t: bigint | number | Date | string) => {
                controller.goTo(t);
                return this;
            },
            lockForward: (on = true) => {
                controller.lockForward(on);
                return this;
            },
            get floor() {
                return controller.floor();
            },
            allows: (tNs: bigint) => controller.allows(tNs),
        };

        if (options.account) {
            // seed it here so engines attached later inherit it
            if (options.account.fillSearch) {
                this.executionEngine.setFillSearch(options.account.fillSearch);
            }
            this.account = new AccountManager({
                eventBus: this.eventBus,
                executionEngine: this.executionEngine,
                initialBalance: options.account.initialBalance,
                currency: options.account.currency,
                adapter: options.account.adapter,
                fills: options.account.fills,
                orders: options.account.orders,
                positions: options.account.positions,
                adjustments: options.account.adjustments,
            });
        } else {
            this.account = null;
        }

        this.playbackStateRegistry = new PlaybackStateRegistry(this.eventBus);
        this._wireDataRouting();
        this._wireSymbolMirror();

        // installed after the plugin:register-indicator listener above so their
        // defs land in registeredPlugins. third arg is the picker category, only
        // a fallback - a script declaring its own wins
        for (const [code, id, category] of BUILTIN_INDICATORS) {
            this.use(createScriptedPlugin(code, id, category));
        }

        // before restore and before panes mount, so the imported settings blob is
        // what useChartSettings reads on init. a save doc is a stronger signal of
        // intent than TradingView leftovers, so having one skips this entirely
        if (!options.restore && options.importTradingViewSettings !== false) {
            importTradingViewSettings();
        }

        // after all owners exist, and seeds the pane models before they mount so
        // they read their restored symbol/timeframe/settings/plugins on init
        if (options.restore) this.restore(options.restore);

        globalChartBus.registerChart(this);
    }

    // Data

    setDataAdapter(adapter: IDataAdapter): this {
        this.dataEngine.setAdapter(adapter);
        return this;
    }

    load(symbol: string): Promise<void> {
        return this.dataEngine.load(symbol);
    }

    /**
     * Re-fetch the charted symbol's window without moving the playhead. For when
     * the data source's answer changes rather than the question - the host grants
     * access to a resolution that was refused before, a feed gets backfilled.
     *
     * Switching timeframe is not a substitute: that refines bars from what is
     * already loaded, so anything the first fetch didn't return never arrives.
     */
    reloadData(): Promise<void> {
        return this.dataEngine.reload(BigInt(Math.round(this._horizon)) * 1_000_000n);
    }

    getSymbolInfo(symbol: string): SymbolInfo | null {
        return (
            this.dataEngine.getResolvedSymbolInfo(symbol) ?? this.dataSources.getResolved(symbol)
        );
    }

    /**
     * The bar still being built at the playback horizon, on the focused pane, or
     * `null` before any data has arrived.
     *
     * Unlike the tail of `getData().ohlcvBars` - which is the last bar that was
     * *loaded*, at the fetch resolution and possibly past the horizon - this is
     * the candle the chart is actually drawing on the right edge.
     */
    openBar(): OhlcvBar | null {
        const focused = (this.state.get('focusedPane') as number) ?? 0;
        const get =
            this._openBarProviders.get(focused) ?? this._openBarProviders.values().next().value;
        const bar = get?.();
        if (!bar) return null;
        return {
            time: Number(bar.ts / 1_000_000n),
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: bar.totalVol,
        };
    }

    getMaxLookbackBars(): number {
        let max = 0;
        for (const [, entry] of this.registeredPlugins) {
            if ((entry.lookback ?? 0) > max) max = entry.lookback;
        }
        return max;
    }

    horizon(): number {
        return this._horizon;
    }

    // View

    fitToData(): this {
        this.eventBus.emit('chart:reset-view', undefined);
        return this;
    }

    setActiveTool(tool: ActiveDrawingTool): this {
        this.state.set('activeTool', tool, this.eventBus);
        return this;
    }

    /**
     * Set the active timeframe by label, e.g. "1m", "5m", "1h", "4h", "1d".
     * Custom labels like "213m" or "2h" are accepted too.
     */
    setTimeframe(label: string): this {
        const tf =
            PRESET_TIMEFRAMES.find((t) => t.label.toLowerCase() === label.toLowerCase()) ??
            parseCustomTimeframe(label);
        if (!tf) {
            console.warn(`[ChristTrade] Unknown timeframe: "${label}"`);
            return this;
        }
        this.state.set('timeframe', tf, this.eventBus);
        return this;
    }

    /**
     * The per-pane model for a layout cell index, created on first access. New
     * panes inherit the chart's current symbol / timeframe / footprint options.
     */
    getChart(index: number): ChartModel {
        let model = this._panes.get(index);
        if (!model) {
            model = new ChartModel({
                symbol: this.state.get('symbol'),
                timeframe: this.state.get('timeframe'),
                fpOptions: this.state.get('fpOptions'),
            });
            this._panes.set(index, model);
        }
        return model;
    }

    /** All instantiated pane models, ordered by cell index. */
    get charts(): ChartModel[] {
        return [...this._panes.entries()].sort((a, b) => a[0] - b[0]).map(([, m]) => m);
    }

    // TODO: real focus-index tracking. resolves to cell 0 until the layout
    // migration lands
    get focusedChart(): ChartModel {
        return this.getChart(0);
    }

    /**
     * Is this timeframe allowed by the current feature set? The one source of
     * truth for the gate - every timeframe switch is enforced against it.
     */
    isTimeframeAllowed(label: string): boolean {
        const allowed = this.features?.timeframe?.timeframes ?? 'any';
        return allowed === 'any' || allowed.includes(label);
    }

    /**
     * Widen what's allowed at runtime, e.g. after the host grants a trial of a
     * paid timeframe. Mutates the same `features` object the UI holds so
     * call-time checks see it immediately, then emits `features:change` so the
     * rendered locks catch up.
     *
     * Presentation only. Anything worth money has to be enforced by whatever
     * serves the data, since a client can always be patched.
     */
    allowTimeframes(labels: string[] | 'any'): this {
        if (!this.features.timeframe) this.features.timeframe = {};
        const current = this.features.timeframe.timeframes ?? 'any';

        if (labels === 'any' || current === 'any') {
            this.features.timeframe.timeframes = labels === 'any' ? 'any' : current;
        } else {
            const merged = new Set([...current, ...labels]);
            this.features.timeframe.timeframes = [...merged];
        }

        this.eventBus.emit('features:change', undefined);
        return this;
    }

    /** Returns the label of the currently active timeframe, e.g. "1m". */
    getTimeframe(): string {
        return this.state.get('timeframe').label;
    }

    /**
     * The currently charted symbol. Reads the focused pane, which is the real
     * truth - pane models update on every switch, whereas `state.symbol` is only
     * a mirror (see _wireSymbolMirror) and as good as the events it has seen.
     */
    getSymbol(): string {
        return this.focusedChart?.symbol ?? this.state.get('symbol');
    }

    /**
     * The tool armed for drawing - `{ name: 'cursor' }` when the chart is idle.
     * What the toolbar highlights, not what is selected on the canvas. For that
     * see `getSelectedDrawing`.
     */
    getActiveTool(): ActiveDrawingTool {
        return this.state.get('activeTool');
    }

    /**
     * The drawing the user has selected, in the same `{ name, id, state }` shape
     * as an armed tool, or null when nothing is.
     *
     * `state` is read live out of the drawing store, so it reflects a box that is
     * still being dragged.
     */
    getSelectedDrawing(): ActiveDrawingTool | null {
        const id = this.state.get('selectedDrawingId');
        if (!id) return null;
        return this.getDrawing(id);
    }

    /**
     * Any drawing on the active symbol by id, same shape as
     * `getSelectedDrawing`. Null once it has been deleted.
     *
     * The counterpart to selection: a host latched onto a drawing needs to keep
     * reading it after the user selects something else, and needs the null to
     * know when it is gone.
     */
    getDrawing(id: string): ActiveDrawingTool | null {
        const drawing = this.drawingStore.find(this.getSymbol(), id);
        return drawing ? toolFromDrawing(drawing) : null;
    }

    /**
     * Fires whenever the active symbol's drawings change - added, edited,
     * dragged or deleted. Returns an unsubscribe.
     *
     * Bound to whichever symbol is active when you call it, since drawings are
     * stored per symbol. Re-subscribe on `chart:set-symbol` to follow the chart
     * across instruments.
     */
    onDrawingsChanged(fn: () => void): () => void {
        return this.drawingStore.subscribe(this.getSymbol(), fn);
    }

    /**
     * Patch chart visual settings (scale mode, grid, crosshair, etc.).
     * Equivalent to using the settings dialog in the UI.
     */
    setChartSettings(patch: Partial<ChartSettings>): this {
        this.eventBus.emit('chart:apply-settings', { patch });
        return this;
    }

    /**
     * Switch the active symbol on this chart instance only. Emits
     * `chart:set-symbol`; the data engine, panes and trading bridge all react
     * through their own subscriptions.
     */
    setSymbol(symbol: string): this {
        if (this.state.get('symbol') === symbol) return this;
        this.state.set('symbol', symbol, this.eventBus);
        for (const [id] of this.registeredPlugins) {
            this.eventBus.emit('plugin:recompute-indicator', { id });
        }
        return this;
    }

    addIndicator(id: string): this {
        this.eventBus.emit('chart:add-indicator', { id });
        return this;
    }

    removeIndicator(id: string): this {
        this.eventBus.emit('chart:remove-indicator', { id });
        return this;
    }

    // Account

    /**
     * Swap the account adapter at runtime. Pass null to revert to the built-in
     * eventBus-driven mode.
     */
    setAccountAdapter(adapter: IAccountAdapter | null): this {
        if (!this.account) {
            console.warn('[ChristTrade] account manager is not enabled (pass `account` option)');
            return this;
        }
        this.account.setAdapter(adapter);
        return this;
    }

    // Persistence

    /**
     * Collect serializable state from every module. Store the result and pass it
     * as `restore` on the next chart construction.
     */
    serialize(): ChartSaveState {
        return {
            version: SAVE_VERSION,
            layout: { ...this.state.get('layout') },
            syncInLayout: this.state.get('syncInLayout'),
            gridColSizes: this.state.get('gridColSizes'),
            gridRowSizes: this.state.get('gridRowSizes'),
            focusedPane: this.state.get('focusedPane'),
            account: this.account?.serialize(),
            // shared pool - code stored once, panes reference by id
            plugins: this.pluginRegistry.serialize(),
            drawings: this.drawingStore.serialize(),
            // only the panes active in the current layout, cells 0..N-1
            charts: Array.from({ length: this._activePaneCount() }, (_, i) =>
                this.getChart(i).serialize(),
            ),
            // device-level stuff. per-pane settings ride in charts above
            preferences: serializeChartPreferences(),
        };
    }

    // distinct cell letters in the grid's areas. mirrors ChartOuter's
    // activeLetters count
    private _activePaneCount(): number {
        const seen = new Set<string>();
        for (const ch of this.state.get('layout').areas) {
            if (ch >= 'a' && ch <= 'h') seen.add(ch);
        }
        return Math.max(1, seen.size);
    }

    /**
     * Distribute a saved document to every owner. Called from the constructor
     * when `restore` is passed, and callable later for a "load session" action.
     *
     * Order matters: preferences first so a plugin's `getSettings()` sees its
     * restored values during install, then the plugin pool so per-pane refs
     * resolve against it, then account, layout, drawings, and the pane models.
     *
     * Preferences are merged, not replaced - a save document adds its timeframes
     * and templates to whatever the device already has instead of wiping them.
     */
    restore(state: ChartSaveState): this {
        const s = migrateSaveState(state);

        restoreChartPreferences(s.preferences);

        s.plugins?.forEach(({ id, code }) => {
            try {
                // re-install under the saved id so a host that also installs this
                // manually with chart.use dedups instead of duplicating it
                this.use(createScriptedPlugin(code, id));
            } catch (err) {
                console.warn('[ChristTrade] failed to restore plugin', err);
            }
        });

        if (s.account && this.account) this.account.restore(s.account);

        if (s.layout) this.state.set('layout', s.layout, this.eventBus);
        if (s.syncInLayout) this.state.set('syncInLayout', s.syncInLayout);
        if (s.gridColSizes) this.state.set('gridColSizes', s.gridColSizes);
        if (s.gridRowSizes) this.state.set('gridRowSizes', s.gridRowSizes);
        if (s.focusedPane != null) this.state.set('focusedPane', s.focusedPane);

        if (s.drawings) this.drawingStore.restore(s.drawings);

        s.charts?.forEach((paneState, i) => this.getChart(i).restore(paneState));

        // panes own their timeframe, but shared state is what DataEngine sizes
        // fetches with and what setTimeframe dedupes against. leaving it on the
        // constructor default means a chart restored onto 5m loads as if it were
        // 1m, and the toolbar then refuses to switch back. set silently since
        // this runs before panes mount, nothing to notify
        const focused = this._panes.get(this.state.get('focusedPane') ?? 0);
        if (focused) this.state.set('timeframe', focused.timeframe);

        return this;
    }

    // Props

    getProps(): DepthProps {
        return {
            chart: this,
            eventBus: this.eventBus,
            executionEngine: this.executionEngine,
            transformer: this.transformer,
            hideToolbar: this.options.hideToolbar,
            hideDrawingToolbar: this.options.hideDrawingToolbar,
            hideBottomToolbar: this.options.hideBottomToolbar,
            hidePriceScale: this.options.hidePriceScale,
            hideTimeScale: this.options.hideTimeScale,
            hideStatusBar: this.options.hideStatusBar,
            hideLegend: this.options.hideLegend,
            prefetch: this.options?.playback?.prefetch,
            showDataStatusInBottomRightCorner:
                this.options?.debug?.showDataStatusInBottomRightCorner ?? false,
            state: this.state,
            toolbar: this.options.toolbar?.(this) ?? [],
            plugins: [...this.registeredPlugins.values()],
            features: this.features,
            timePrecision: this.timePrecision,
        };
    }

    // Events

    on<K extends keyof ChartEvents>(event: K, handler: (data: ChartEvents[K]) => void): () => void {
        return this.eventBus.on(event, handler);
    }

    off<K extends keyof ChartEvents>(event: K, handler: (data: ChartEvents[K]) => void): void {
        this.eventBus.off(event, handler);
    }

    // Plugins

    use(plugin: ChartPlugin): this {
        ptrace('use', plugin.id, plugin.type, new Error().stack?.split('\n')[2]?.trim());
        this.pluginRegistry.register(plugin, this._buildPluginContext(plugin.id));
        return this;
    }

    /**
     * Apply an installed plugin to the panes. Safe to call before the plugin's
     * worker has registered its capabilities - the activation is queued and runs
     * as soon as the def lands.
     */
    add(pluginOrId: string | ChartPlugin): this {
        const pluginId = typeof pluginOrId === 'string' ? pluginOrId : pluginOrId.id;
        this.eventBus.emit('chart:add-plugin-indicator', { pluginId });
        return this;
    }

    /**
     * Take a plugin's live instances off the panes without uninstalling it. It
     * stays loaded, so hot reload keeps working and `add()` re-applies it
     * instantly. To tear it down entirely use `unuse()`.
     */
    remove(pluginOrId: string | ChartPlugin): this {
        const pluginId = typeof pluginOrId === 'string' ? pluginOrId : pluginOrId.id;
        this.eventBus.emit('chart:remove-plugin-indicator', { pluginId });
        return this;
    }

    /** Uninstall a plugin: kills its worker and removes everything it registered. */
    unuse(id: string): this {
        this.pluginRegistry.unregister(id);
        const sched = this.pluginSchedules?.get(id);
        if (sched) {
            sched.destroy();
            this.pluginSchedules?.delete(id);
        }
        return this;
    }

    /** Is this plugin id currently loaded (installed or queued for install)? */
    isPluginInstalled(id: string): boolean {
        return this.pluginRegistry.has(id);
    }

    /**
     * Pool plugin ids a restored session still expects but nothing has installed.
     * A host that keeps plugin code in its own store rather than the save
     * document (so `serialize().plugins` is stripped) installs these on mount,
     * and the panes then rebuild their indicators with the saved settings.
     */
    getPendingPluginIds(): string[] {
        const ids = new Set<string>();
        for (let i = 0; i < this._activePaneCount(); i++) {
            for (const ref of this.getChart(i).restoredPlugins) {
                if (!this.pluginRegistry.has(ref.id)) ids.add(ref.id);
            }
        }
        return [...ids];
    }

    /**
     * Tell the chart where the host keeps its plugin code. The provider is called
     * on demand, so a host whose list changes (a script editor, a store) just
     * returns the current one rather than re-registering.
     *
     * Setting it applies startup plugins straight away - the plugins a restored
     * session references, plus anything the user left switched on - so a host that
     * strips `plugins` out of its save document doesn't have to reinstall them by
     * hand.
     */
    setPluginCatalog(provider: () => PluginCatalogEntry[]): this {
        this._pluginCatalog = provider;
        this.applyStartupPlugins();
        return this;
    }

    /** Every plugin the host has code for, loaded or not. */
    getPluginCatalog(): PluginCatalogEntry[] {
        try {
            return this._pluginCatalog?.() ?? [];
        } catch (err) {
            console.warn('[ChristTrade] plugin catalog provider threw', err);
            return [];
        }
    }

    /**
     * Install a plugin from the catalog, optionally putting it on the chart.
     * Returns false when the catalog has no code for that id.
     */
    loadPlugin(id: string, opts: { activate?: boolean } = {}): boolean {
        const entry = this.getPluginCatalog().find((e) => e.id === id);
        if (!entry) return false;
        try {
            if (!this.pluginRegistry.has(id)) this.use(createScriptedPlugin(entry.code, id));
            if (opts.activate) this.add(id);
        } catch (err) {
            console.warn('[ChristTrade] failed to load plugin', id, err);
            return false;
        }
        this.setPluginStartup(id, { autostart: true, activate: !!opts.activate });
        return true;
    }

    /**
     * Uninstall a plugin and stop loading it at startup. The counterpart to
     * `loadPlugin` - `unuse()` on its own leaves the startup record alone, which
     * is what a restart wants.
     */
    unloadPlugin(id: string): this {
        this.unuse(id);
        this.setPluginStartup(id, { autostart: false, activate: false });
        return this;
    }

    /** What every plugin the user has an opinion about should do at startup. */
    getPluginStartup(): PluginStartupRecord {
        return readPluginStartup();
    }

    /**
     * Record what a plugin should do when the chart opens. Merges into any
     * existing entry; `null` forgets the plugin, which lets a restored save
     * document decide again.
     */
    setPluginStartup(id: string, entry: Partial<PluginStartupEntry> | null): this {
        writePluginStartup(id, entry);
        this._notifyPluginState();
        return this;
    }

    /**
     * Install what this session should open with: every plugin a restored pane
     * references, plus every plugin marked autostart. Idempotent - already-loaded
     * ids are skipped, so it is safe to call again after the catalog changes.
     */
    applyStartupPlugins(): this {
        const catalog = new Map(this.getPluginCatalog().map((e) => [e.id, e]));
        ptrace('applyStartupPlugins: catalog', [...catalog.keys()]);
        if (catalog.size === 0) return this;

        const startup = this.getPluginStartup();
        ptrace('applyStartupPlugins: record', JSON.stringify(startup));

        // ids the restored panes hold indicator refs for. those panes rebuild
        // their own instances once the def lands, so these must not be activated
        // again on top
        const referenced = new Set<string>();
        for (let i = 0; i < this._activePaneCount(); i++) {
            for (const ref of this.getChart(i).restoredPlugins) referenced.add(ref.id);
        }

        const targets = new Map<string, boolean>();
        const adopt: string[] = [];
        for (const id of referenced) {
            // an explicit off is the user's, and outranks a save document that
            // was written before they switched the plugin off
            if (startup[id] && !startup[id].autostart) continue;
            // no entry at all means this plugin predates the startup record. it
            // has to load or the pane cant rebuild its indicators, but leaving it
            // unrecorded makes every switch in the manager a lie - it would read
            // "off" while the plugin is plainly running, and turning it off would
            // do nothing next reload. so adopt it: on, but not auto-placed, since
            // this device's other sessions never asked for it
            if (!startup[id]) adopt.push(id);
            targets.set(id, false);
        }
        for (const [id, entry] of Object.entries(startup)) {
            if (!entry.autostart || targets.has(id)) continue;
            targets.set(id, !!entry.activate);
        }

        ptrace(
            'applyStartupPlugins: referenced',
            [...referenced],
            'targets',
            [...targets.entries()],
            'adopt',
            adopt,
        );

        for (const [id, activate] of targets) {
            if (this.pluginRegistry.has(id)) continue;
            const entry = catalog.get(id);
            if (!entry) continue;
            try {
                this.use(createScriptedPlugin(entry.code, id));
                if (activate) this.add(id);
            } catch (err) {
                console.warn('[ChristTrade] failed to start plugin', id, err);
            }
        }

        for (const id of adopt) {
            if (catalog.has(id)) writePluginStartup(id, { autostart: true, activate: false });
        }
        return this;
    }

    /** Name and type of every loaded plugin. */
    getInstalledPlugins(): Array<{ id: string; name: string; type: PluginType }> {
        return this.pluginRegistry.getInstalledPlugins();
    }

    /**
     * Show or hide a plugin's panel.
     *
     * Goes through the registry rather than straight to the event, so a consumer
     * that mounts later - the windows dropdown, a second panel host - reads the
     * state the user left rather than what the plugin registered with.
     */
    setPanelVisible(id: string, visible: boolean): this {
        const entry = this._panelRegistry.get(id);
        if (entry) entry.visible = visible;
        this.eventBus.emit('plugin:panel-toggle-visibility', { id, visible });
        return this;
    }

    /** Does this plugin have at least one live instance on a pane? */
    isPluginActive(id: string): boolean {
        return this.getPluginState().active.has(id);
    }

    /**
     * Which plugins are loaded, and which have live instances on a pane. Two
     * different states - a plugin can be installed (worker running, capabilities
     * registered) without being applied to any pane.
     */
    getPluginState(): { installed: Set<string>; active: Set<string> } {
        const active = new Set<string>();
        for (let i = 0; i < this._activePaneCount(); i++) {
            for (const ref of this.getChart(i).plugins) active.add(ref.id);
        }
        return { installed: new Set(this.pluginRegistry.getInstalledIds()), active };
    }

    /**
     * Observe install/uninstall and pane activation/removal. Only fires when the
     * set of ids actually changes - pane models notify on unrelated churn (axis
     * drags rewrite settings every frame) that callers shouldn't re-render on.
     */
    onPluginStateChange(
        cb: (state: { installed: Set<string>; active: Set<string> }) => void,
    ): () => void {
        const key = (s: { installed: Set<string>; active: Set<string> }) =>
            `${[...s.installed].sort().join(',')}|${[...s.active].sort().join(',')}`;

        let last = key(this.getPluginState());
        const listener = () => {
            const next = this.getPluginState();
            const nextKey = key(next);
            if (nextKey === last) return;
            last = nextKey;
            cb(next);
        };

        this._pluginStateListeners.add(listener);
        // pane models own the active set, so subscribe to every possible cell -
        // one that becomes active later is then already covered
        const unsubs = Array.from({ length: MAX_PANE_CELLS }, (_, i) =>
            this.getChart(i).subscribe(listener),
        );

        return () => {
            this._pluginStateListeners.delete(listener);
            unsubs.forEach((u) => u());
        };
    }

    private _notifyPluginState(): void {
        for (const l of this._pluginStateListeners) l();
    }

    getRegisteredPlugins(): Map<
        string,
        { indicator: Indicator; activeByDefault: boolean; pane: ChartPane }
    > {
        return this.registeredPlugins;
    }

    getPanelRegistry(): ReadonlyMap<
        string,
        { element: React.ReactNode; title: string; visible: boolean }
    > {
        return this._panelRegistry;
    }

    getToolbarRegistry(): ReadonlyMap<string, ToolbarItem> {
        return this._toolbarRegistry;
    }

    getBottomBarRegistry(): ReadonlyMap<string, BottomBarItem> {
        return this._bottomBarRegistry;
    }

    attachRenderEngine(engine: RenderEngine): void {
        this._renderEngine = engine;
        this.pluginRegistry.notifyRenderEngineReady(engine);
    }

    /**
     * Snapshot of the chart with every layer composited (base, drawings, UI).
     * Returns null until the render engine has attached.
     */
    screenshot(): HTMLCanvasElement | null {
        return this._renderEngine?.captureComposite() ?? null;
    }

    // cell whose symbol state.symbol tracks
    private _focusedCellId = 0;

    // keeps state.symbol in step with what is actually charted. two paths change
    // the symbol and only setSymbol ever wrote state - the UI path emits
    // chart:set-symbol directly and updates the pane models, so state.symbol used
    // to keep its initial value forever.
    // written without the eventBus on purpose: this mirrors a change already
    // broadcast, so re-emitting would loop
    private _wireSymbolMirror(): void {
        this.eventBus.on('chart:focused', ({ id }) => {
            this._focusedCellId = id;
            const symbol = this.getChart(id)?.symbol;
            if (symbol) this.state.set('symbol', symbol);
        });
        this.eventBus.on('chart:set-symbol', ({ symbol, id }) => {
            if (id === this._focusedCellId) this.state.set('symbol', symbol);
        });
    }

    // plugin symbols load, paginate and refine through DataEngine like any
    // other, so the only thing left to route is the tick bridge: a derived
    // instrument has no feed of its own to subscribe to, it builds bars out of
    // whatever the host adapter is streaming
    private _wireDataRouting(): void {
        this.eventBus.on('trade', (trade) => {
            this.dataSources.handleTick({
                ts: trade.ts,
                price: trade.price,
                size: trade.size,
                side: trade.side,
            });
        });
    }

    // Plugin context

    private _buildPluginContext(pluginId: string): PluginContext {
        const chart = this;

        const scheduleImpl = new PluginScheduleImpl();
        this.pluginSchedules.set(pluginId, scheduleImpl);

        // always built - the permission gates live in buildRestrictedContext
        const execution: PluginExecutionSurface = {
            placeOrder: (req) => chart.executionEngine.placeOrder(req),
            cancelOrder: (id) => chart.executionEngine.cancelOrder(id),
            amendOrder: (id, price) => chart.executionEngine.amendOrder(id, price),
            amendBracket: (a) => chart.executionEngine.amendBracket(a),
            closePosition: (id) => chart.executionEngine.closePosition(id),
            reversePosition: (id) => chart.executionEngine.reversePosition(id),
            totalRealizedPnl: () => chart.executionEngine.totalRealizedPnl(),
            totalFeesPaid: () => chart.executionEngine.totalFeesPaid(),
        };

        const notify = (opts: NotifyOptions) => {
            const { title, body, level = 'info', duration = 4000, action } = opts;
            const msg = body ? `${title}: ${body}` : title;
            const toastOpts: any = {
                duration: duration === Infinity ? Infinity : duration,
                ...(action ? { action: { label: action.label, onClick: action.onClick } } : {}),
            };
            (
                ({ info: toast, success: toast.success, warn: toast.warning, error: toast.error })[
                    level
                ] ?? toast
            )(msg, toastOpts);
        };

        const playback = {
            registerState: (snapshot: PluginStateSnapshot) =>
                chart.playbackStateRegistry.register(pluginId, snapshot),
        };

        return {
            eventBus: chart.eventBus,
            global: globalChartBus,

            horizon(): number {
                return chart.horizon();
            },

            get renderEngine(): RenderEngine {
                if (!chart._renderEngine) {
                    throw new Error(
                        `[Plugin "${pluginId}"] renderEngine accessed before RenderEngine was ready.`,
                    );
                }
                return chart._renderEngine;
            },

            executionEngine: chart.executionEngine,
            transformer: chart.transformer,
            getData: () => chart.dataEngine.getSnapshot(),
            openBar: () => chart.openBar(),

            get dataLevel(): DataLevel {
                return chart.dataEngine.getSnapshot().dataLevel;
            },

            registerPane(id: string, opts: PaneOptions = {}): () => void {
                return () => {
                    chart.eventBus.emit('plugin:remove-pane', { id });
                };
            },

            registerPanel(
                id: string,
                element: React.ReactNode,
                title = id,
                visible = true,
            ): () => void {
                chart._panelRegistry.set(id, { element, title, visible });
                chart.eventBus.emit('plugin:panel-added', { id, title, visible });
                return () => {
                    chart._panelRegistry.delete(id);
                    chart.eventBus.emit('plugin:panel-removed', { id });
                };
            },

            registerToolbarItem(item: ToolbarItem): () => void {
                const isUpdate = chart._toolbarRegistry.has(item.id);
                chart._toolbarRegistry.set(item.id, item);
                chart.eventBus.emit(
                    isUpdate ? 'plugin:toolbar-item-updated' : 'plugin:toolbar-item-added',
                    isUpdate ? { item } : { item }, // same shape, could unify the event types
                );
                return () => {
                    chart._toolbarRegistry.delete(item.id);
                    chart.eventBus.emit('plugin:toolbar-item-removed', { id: item.id });
                };
            },

            registerBottomBarItem(id: string, render: () => React.ReactNode): BottomBarHandle {
                const fullId = `${pluginId}:${id}`;
                const isUpdate = chart._bottomBarRegistry.has(fullId);
                const item: BottomBarItem = { id: fullId, render };
                chart._bottomBarRegistry.set(fullId, item);
                chart.eventBus.emit(
                    isUpdate ? 'plugin:bottom-bar-item-updated' : 'plugin:bottom-bar-item-added',
                    { item },
                );
                return {
                    rerender() {
                        chart.eventBus.emit('plugin:bottom-bar-item-rerender', { id: fullId });
                    },
                    destroy() {
                        chart._bottomBarRegistry.delete(fullId);
                        chart.eventBus.emit('plugin:bottom-bar-item-removed', { id: fullId });
                    },
                };
            },

            registerDataSource(source: { [key: string]: any }): () => void {
                const unregister = chart.dataSources.register(
                    source as unknown as PluginDataSource,
                );
                // a plugin installs after the chart has already tried to load,
                // so a restored session sitting on one of its symbols got
                // nothing from the adapter. re-ask now that someone can answer
                const symbol = chart.state.get('symbol') ?? '';
                if (symbol && chart.dataSources.sourceFor(symbol) === source) {
                    void chart.dataEngine.load(symbol);
                }
                return unregister;
            },

            playSound(src: string | AudioBuffer): void {
                if (typeof src !== 'string') return;
                try {
                    new Audio(src).play();
                } catch (err) {
                    console.warn('[plugin:audio] Failed to play sound:', err);
                }
            },

            storage: {
                get<T>(key: string, fallback: T): T {
                    return readJSON<T>(pluginStorageKey(pluginId, key), fallback);
                },
                set<T>(key: string, value: T): void {
                    writeJSON(pluginStorageKey(pluginId, key), value);
                },
                delete(key: string): void {
                    removeStored(pluginStorageKey(pluginId, key));
                },
                clear(): void {
                    removeStoredByPrefix(pluginStoragePrefix(pluginId));
                },
            } satisfies PluginStorage,

            registerDrawingTool: (def) => {
                // TODO: gate this on a drawing:register permission
                return this.drawingRegistry.register(def as any);
            },

            addOverlay(
                phase: 'before-base' | 'after-base' | 'after-ui',
                hook: DrawHook,
            ): () => void {
                if (!chart._renderEngine) {
                    console.warn(
                        `[Plugin "${pluginId}"] addOverlay called before renderEngine ready`,
                    );
                    return () => {};
                }
                return chart._renderEngine.addDrawHook(phase, hook);
            },

            fetch(url: string, init?: RequestInit): Promise<Response> {
                return globalThis.fetch(url, init);
            },

            intercept<K extends InterceptableEvent>(
                event: K,
                interceptor: Interceptor<K>,
            ): () => void {
                return chart.eventBus.intercept(event, interceptor);
            },
            services: this.pluginRegistry.buildServices(pluginId),
            lifecycle: this.pluginRegistry.buildLifecycle(this.eventBus),

            getSettings<T>(defaults: T): T {
                const stored = readJSON<Partial<T> | null>(pluginSettingsKey(pluginId), null);
                return stored ? { ...defaults, ...stored } : defaults;
            },

            saveSettings<T>(patch: Partial<T>): void {
                const key = pluginSettingsKey(pluginId);
                const prev = readJSON<Record<string, unknown>>(key, {});
                writeJSON(key, { ...prev, ...patch });
            },
            schedule: scheduleImpl,
            notify,
            playback,
            execution,

            registerContextMenuItem(_item: any): () => void {
                return () => {
                    console.warn('[Depth] registerContextMenu not yet implemented');
                };
            },

            registerTheme(_theme: any): () => void {
                return () => {
                    console.warn('[Depth] registerTheme not yet implemented');
                };
            },
        };
    }

    // Lifecycle

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        globalChartBus.unregisterChart(this.id);
        this.dataEngine.destroy();
        this.executionEngine.destroy();
        this.pluginRegistry.destroy();
        this.account?.destroy();
        this.eventBus.clear();
        this.dataSources.destroy();
        this.playbackStateRegistry.destroy();
        for (const impl of this.pluginSchedules?.values() ?? []) impl.destroy();
        this.pluginSchedules?.clear();
    }
}
