import { LiveTransformer } from '../interfaces/ICoordinateTransformer';
import { ChartSettings } from '../lib/types/chart-settings';
import { type SessionStatus } from './SessionUtils';
import {
    BarPreviewResponse,
    OhlcvBar,
    SymbolInfo,
    SymbolSearchMode,
    SymbolSearchRequest,
    TradingSession,
} from '../interfaces/IDataAdapter';
import { DataLevel } from '../interfaces/IDataAdapter';
import { IExecutionAdapter } from '../interfaces/IExecutionAdapter';
import { ActiveDrawingTool, Anchor, Drawing } from '../lib/types/drawing-types';
import { TradeLineHitMap } from '../lib/renderers/drawTradeLines';
import type { TradeLine } from '../lib/types';
import { FootprintBar } from '../lib/types/footprint';
import { ChartPane, Indicator } from '../lib/types/indicator-types';
import { SerialTrade } from '../lib/types';
import { Timeframe } from '../lib/timeframes';
import { Fill, Order, Position, PositionClose, TradingEvent } from '../lib/types/trading-types';
import { PriceHistory, TradePoint, type ViewBounds } from '../lib/types';
import { BottomBarItem, ChartTypePlugin, ToolbarItem } from './PluginRegistry';
import { RenderEngine } from './RenderEngine';
import { PlaybackMode } from '../hooks/usePlaybackEngine';
import type { CrosshairSync, TimeRangeSync } from '../lib/types/layout-sync';
import type { PlaceOrderRequest } from '../lib/matchingEngine';

export interface ChartEvents {
    // View
    'view:change': ViewBounds;
    'crosshair:move': { x: number; y: number } | null;

    'chart:ready': void;
    'chart:reset-view': void;
    'chart:set-tool': { tool: ActiveDrawingTool };
    'chart:set-timeframe': { tf: Timeframe };
    'chart:add-indicator': { id: string };
    'chart:add-plugin-indicator': { pluginId: string };
    /** Take every live instance of a pool plugin off the panes. Instances are
     *  keyed `${pluginId}:${index}`. */
    'chart:remove-plugin-indicator': { pluginId: string };
    'chart:remove-indicator': { id: string };
    'chart:apply-settings': { patch: Partial<ChartSettings> };
    'chart:set-symbol': { symbol: string; id: number };
    'chart:set-symbol-focused': { symbol: string };
    'chart:open-symbol-select': {};
    'chart:set-type': { old: string; new: string };
    'theme:change': 'light' | 'dark';
    'chart:focused': { id: number };
    'chart:blurred': void;
    'chart:change-layout': {
        preset: {
            id: string;
            label: string;
            count: number;
            cols: number;
            rows: number;
            areas: string;
        };
    };

    // Layout sync. broadcast by the cell being acted on, never echoed back -
    // every other cell decides for itself whether its matching switch is on
    /** Hovered cell's crosshair, in data space. null = pointer left the chart. */
    'layout:crosshair': CrosshairSync | null;
    /** Scrolled/zoomed cell's visible time range. */
    'layout:time-range': TimeRangeSync;
    /** A cell changed its own timeframe (chart keypad, selector, API). */
    'layout:timeframe': { id: number; tf: Timeframe };

    'timeframe:change': { tf: Timeframe };
    /** Runtime entitlement change (see `chart.allowTimeframes`). The UI re-reads
     *  `features` so locks and gates reflect what is allowed now. */
    'features:change': void;
    'timeframe:add-failed': {
        message: string;
        code: 'NO_CUSTOM_TIMEFRAMES' | 'TIMEFRAME_NOT_ALLOWED';
        /** The timeframe the user typed, e.g. "7m". Hosts use it in their upsell copy. */
        label?: string;
    };

    'status:compute': {
        /** Cell id of the chart that produced this event (multi-chart routing) */
        cellId: number;
        x: number;
        priceHistory: PriceHistory[];
        trades: TradePoint[];
        bounds: ViewBounds;
        chartW: number;
        barNs: bigint;
        candleCache: Map<
            bigint,
            {
                open: number;
                high: number;
                low: number;
                close: number;
                volume: number;
                delta: number;
            }
        > | null;
        bars: {
            time: number;
            open: number;
            high: number;
            low: number;
            close: number;
            volume: number;
        }[];
        openBar: FootprintBar;
        horizon: bigint;
        dataLevel: DataLevel;
        transformer: LiveTransformer;
    };

    /** The playback horizon advanced (tick / step / scrub). Refreshes the status
     *  bar while the cursor sits on the forming bar and isnt moving to drive
     *  status:compute. */
    'status:refresh': void;

    /** A cell is rebuilding its heatmap. Keyed by cell, not symbol - two panes on
     *  one instrument at different timeframes rebuild independently. */
    'heatmap:status': { recalculating: boolean; cellId?: number };
    /** Whether the market is open at the playhead, for `symbol`. Every cell
     *  announces its own, since instruments keep different hours. */
    'session:status': SessionStatus & { symbol?: string };

    // Data
    'data:preview': BarPreviewResponse;
    /** The loaded data edges for one symbol, announced by the cell that ingested
     *  it. These gate panning and backward fetches, so `symbol` scopes it. */
    'data:bounds': {
        start: bigint;
        end: bigint;
        session: TradingSession | null;
        symbol?: string;
    };
    'data:status': {
        status: 'loading' | 'ready' | 'error';
        error?: { code: string; message: string };
        /** Symbol the status belongs to; a cell only reacts when it matches what
         *  it is displaying. Omitted = chart-wide, every cell reacts. */
        symbol?: string;
    };
    'data:rehydrate': void;

    'data:load': {
        symbol: string;
        dataLevel: DataLevel;
        compactBuf: ArrayBuffer;
        trades: SerialTrade[];
        priceHistory: PriceHistory[];
        footprintBars: FootprintBar[];
        ohlcvBars: OhlcvBar[];
        barNs: bigint;
        dataStart: number;
        dataEnd: number;
        session: TradingSession | null;
        playFromIso?: string;
        error?: string;
        errorMessage?: string;
        supplemental?: Array<{
            resolution: bigint;
            bars: Array<{
                time: number;
                open: number;
                high: number;
                low: number;
                close: number;
                volume: number;
            }>;
        }> | null;
        /**
         * A re-hand-over of a window the consumer may already have, rather than
         * a new one - a pane mounting, or switching onto a symbol another pane
         * already loaded. Nothing behind the playhead changed, so consumers
         * holding replay state (the matching engine) keep their position instead
         * of rewinding and settling the window again.
         */
        rehydrate?: boolean;
        /** Pre-bucketed ingest result from DataEngine (non-ohlcv data levels only). */
        ingestOhlcvBuf?: ArrayBuffer;
        ingestBucketedPhBuf?: ArrayBuffer;
        ingestTradesBuf?: ArrayBuffer;
        ingestPhBuf?: ArrayBuffer;
    };
    'data:append': {
        symbol: string;
        dataLevel: DataLevel;
        compactBuf: ArrayBuffer;
        trades: SerialTrade[];
        priceHistory: PriceHistory[];
        footprintBars: FootprintBar[];
        ohlcvBars: OhlcvBar[];
        barNs: bigint;
        dataStart: number;
        dataEnd: number;
        session: TradingSession | null;
        supplemental?: Array<{
            resolution: bigint;
            bars: Array<{
                time: number;
                open: number;
                high: number;
                low: number;
                close: number;
                volume: number;
            }>;
        }> | null;
        ingestOhlcvBuf?: ArrayBuffer;
        ingestBucketedPhBuf?: ArrayBuffer;
        ingestTradesBuf?: ArrayBuffer;
        ingestPhBuf?: ArrayBuffer;
    };
    // symbol scopes these to the requesting pane. the DataEngine only serves its
    // active symbol, so a synced-horizon pan doesnt make every pane reload
    'data:request-forward': { symbol?: string };
    'data:request-backward': { viewMin: bigint; symbol?: string };
    /**
     * Jump-load: re-fetch a fresh window centered on `tNs` and reinitialize
     * there, instead of streaming everything between the loaded edge and the
     * target. `fromNs` is the playhead before the jump, used to settle fills over
     * the skipped span. Costs one window regardless of jump distance.
     */
    'data:seek-load': { tNs: bigint; fromNs: bigint };
    'data:prepend': {
        symbol: string;
        dataLevel: DataLevel;
        compactBuf: ArrayBuffer;
        trades: SerialTrade[];
        priceHistory: PriceHistory[];
        footprintBars: FootprintBar[];
        ohlcvBars: OhlcvBar[];
        barNs: bigint;
        dataStart: number;
        viewMin: bigint;
        session: TradingSession | null;
        ingestOhlcvBuf?: ArrayBuffer;
        ingestBucketedPhBuf?: ArrayBuffer;
        ingestTradesBuf?: ArrayBuffer;
        ingestPhBuf?: ArrayBuffer;
    };
    /** Backward pagination is exhausted for this symbol. */
    'data:no-more-history': { symbol?: string };
    /**
     * Forward pagination is exhausted - no more data past this symbol's loaded
     * edge. The playback engine pauses on it, so `symbol` matters: one pane
     * running out must not stop the clock the focused pane is driving.
     */
    'data:no-more-forward': { symbol?: string };
    /**
     * Request a forward chunk. `spanNs` is the desired data-time span, sized by
     * the playback engine to the current consumption rate so fast playback
     * fetches bigger chunks. Falls back to the fixed scroll window.
     */
    'data:prefetch': { spanNs?: bigint; symbol?: string };
    'data:prefetch-done': void;
    'data:rebuild-footprint': { barNs: bigint; fpOptions: unknown };
    /**
     * Ask the engine for symbols. `requestId` correlates the answer: the picker
     * fires one per keystroke and ignores anything that isnt its latest, so "AA"
     * landing after "AAPL" cant overwrite it.
     */
    'data:search-symbols': { requestId: string; request: SymbolSearchRequest };
    'data:search-symbols-response': {
        requestId: string;
        symbols: SymbolInfo[];
        hasMore: boolean;
        cursor?: string;
        /** Who did the matching. */
        mode: SymbolSearchMode;
        /** How long to wait after a keystroke before searching again, in ms. */
        debounceMs: number;
    };
    'data:search-symbols-error': { requestId: string; code: string; message: string };
    /** Abandon a search (the picker closed). Carries its own requestId so one
     *  picker cant cancel another's when they share a bus. */
    'data:search-symbols-cancel': { requestId: string };
    /** The requested span was entirely outside this symbol's trading hours, so
     *  nothing was fetched. */
    'data:session-gap': { from: bigint; to: bigint; symbol?: string };
    'data:symbol-resolved': { symbolInfo: SymbolInfo };
    /**
     * Ask the engine to re-announce a symbol's resolved info as
     * `data:symbol-resolved`. That event is one-shot and fires mid-load, which
     * can finish before a pane has subscribed - chart.load() runs during
     * construction, panes mount after. A pane replays it with this on mount.
     * No-op if the symbol hasnt resolved yet, the live event is still coming.
     */
    'data:request-symbol-resolved': { symbol: string };

    /**
     * A pane announcing which instrument it is showing and at what bar period,
     * on mount and whenever either changes. Lets the engine fetch at the finest
     * resolution anyone on screen needs rather than the focused pane's.
     */
    'data:pane-resolution': { id: number; symbol: string; barNs: bigint };

    /** A loaded time segment was re-fetched at a finer resolution after a
     *  timeframe scale-down. Consumers replace their stale bars with these. */
    'data:refine': {
        symbol: string;
        dataLevel: DataLevel;
        ohlcvBars: OhlcvBar[];
        /** The fetch resolution of the new bars. */
        barNs: bigint;
        /** ISO - inclusive start of the replaced time range. */
        from: string;
        /** ISO - inclusive end of the replaced time range. */
        to: string;
    };

    'render-engine:ready': { engine: RenderEngine };

    /**
     * A cell handing over its forming-bar getter. The bar mutates in place, so
     * this is a getter and not a value - read it, dont keep it. `get: null`
     * means the cell is going away.
     */
    'data:open-bar-provider': {
        cellId: number;
        get: (() => FootprintBar | null) | null;
    };

    // Market
    'price:update': { bid: number; ask: number; ts: bigint };
    trade: TradePoint;
    'book:update': { bestBid: number | null; bestAsk: number | null };

    // Execution
    'order:placed': { orderId: string; order: Order };
    'order:fill': Fill;
    'order:cancel': { orderId: string };
    'position:update': Position;
    'position:close': PositionClose;
    'trading:event': TradingEvent;
    /** An order was refused by the execution engine's guard, before any book saw it. */
    'trading:order-blocked': { req: PlaceOrderRequest; reason: string };
    /**
     * Ghost lines for an order that hasnt been placed - what the ticket
     * describes, drawn where it would land. An empty array clears it. Ordinary
     * TradeLines, and should be sent `locked`: they are a readout, not a
     * control, so they must never take a click a drawing could have had.
     */
    'trading:preview': { lines: TradeLine[]; symbol?: string };
    /**
     * Command: open the order ticket, following `drawingId` if one is given.
     *
     * Sticky, since the panel that answers it usually isnt mounted yet - the
     * host opens the ticket in response and the ticket reads the request on the
     * way up. `requestId` is what keeps that honest: the ticket remembers the
     * last request it acted on, so opening it by hand later replays the request
     * without re-linking to a box the user has moved on from.
     */
    'trading:ticket-requested': { drawingId: string | null; requestId: string };
    'trading:buy-market': { amount: number };
    'trading:sell-market': { amount: number };
    /** Go flat: close every open position at market. Account-wide, not pane-wide. */
    'trading:flatten': void;

    'execution:setAdapter': { adapter: IExecutionAdapter };

    // Indicators
    'indicator:computed': { id: string; barNs: bigint };
    'plugin:add-indicator': { indicator: Indicator; pane?: ChartPane };
    'plugin:redraw-indicators': void;

    'plugin:register-indicator': {
        indicator: Indicator;
        activeByDefault?: boolean;
        pane?: ChartPane;
        lookback?: number;
    };

    /** A plugin finished installing - its worker is live and capabilities are
     *  registering. Fired by PluginRegistry, not chart.use(), since install is async. */
    'plugin:installed': { id: string };
    /** A plugin was torn down via chart.unuse(). Everything it registered
     *  (indicator instances, panes, drawing tools, chart types) is being removed. */
    'plugin:uninstalled': { id: string };

    'plugin:register-drawing': { id: string; name: string; icon: any };
    'plugin:unregister-drawing': { id: string };

    // Plugin pane lifecycle
    'plugin:register-pane': {
        id: string;
        heightRatio: number;
    };
    'plugin:remove-pane': { id: string };

    // Plugin panel (DOM) lifecycle
    'plugin:panel-added': { id: string; title: string; visible: boolean };
    'plugin:panel-removed': { id: string };
    'plugin:panel-toggle-visibility': { id: string; visible: boolean };

    'plugin:register-chart-type': { plugin: ChartTypePlugin };
    'plugin:unregister-chart-type': { id: string; hotReload?: boolean };

    // Plugin compatibility / script errors
    /**
     * Something needs richer data than the charted symbol serves. Emitted when a
     * plugin is skipped at install, and when an indicator or chart type is
     * refused at activation. `name` and `kind` are what the host puts in front of
     * the user - an id is no use to them.
     */
    'plugin:incompatible': {
        id: string;
        required: DataLevel;
        actual: DataLevel;
        name?: string;
        kind?: 'plugin' | 'indicator' | 'chart-type';
    };
    'plugin:script-error': {
        id: string;
        error: string;
        line?: number;
    };
    /** Open the plugin manager. For hosts that want their own way in. */
    'plugin:open-manager': Record<string, never>;

    'plugin:scripted-compute': {
        id: string;
        ohlcv: OhlcvBar[];
        trades: SerialTrade[];
        ticks: unknown[];
        snapshots: unknown[];
        barNs: bigint;
    };

    'plugin:scripted-advance': {
        id: string;
        newOhlcv: OhlcvBar[];
        newTrades: SerialTrade[];
        newTicks: unknown[];
        newSnapshots: unknown[];
        barNs: bigint;
        horizon: bigint;
    };
    'plugin:chart-type-updated': { id: string };

    /**
     * A scripted indicator's worker returned fresh draw output. Panes holding it
     * re-snapshot and repaint their own render engine - the plugin cant, since
     * the chart holds one render engine reference (the last cell to mount) while
     * every cell has its own.
     */
    'plugin:indicator-updated': { id: string };

    'plugin:update-code': { id: string; code: string };
    'plugin:recompute-indicator': { id: string };
    'plugin:remove-indicator': { id: string };
    'plugin:add-indicator:id': { id: string };
    'plugin:toolbar-item-added': { item: ToolbarItem };
    'plugin:toolbar-item-removed': { id: string };
    'plugin:toolbar-item-updated': { item: ToolbarItem };
    'plugin:bottom-bar-item-added': { item: BottomBarItem };
    'plugin:bottom-bar-item-removed': { id: string };
    'plugin:bottom-bar-item-updated': { item: BottomBarItem };
    'plugin:bottom-bar-item-rerender': { id: string };

    // Drawings
    'drawing:add': Drawing;
    'drawing:move': { id: string; anchor: Anchor };
    'drawing:remove': { id: string };
    /**
     * Selection changed; `id` is null when nothing is selected. Carries only the
     * id - read the drawing with `chart.getSelectedDrawing()`, which is live, so
     * a box still being dragged reads as it currently stands.
     */
    'drawing:selected': { id: string | null };

    'pane:hovered': { id: string };

    /**
     * The trade-line hit regions a UI repaint just produced. Canvas-space rects,
     * meaningless anywhere but the cell that painted them, so listeners must
     * drop every id but their own - otherwise the last cell to repaint each
     * frame decides where every other cell thinks its lines are.
     */
    'hitmap:update': { id: number; hitMap: TradeLineHitMap };

    'playback:seek': { tNs: bigint };
    /**
     * Command: jump the playhead to `tNs`, pausing first. The counterpart to
     * playback:seek, which reports where the playhead landed - this one asks for
     * the move, and the engine loads whatever data the target needs.
     */
    'playback:goto': { tNs: bigint };
    'playback:tick': { bid: number; ask: number; last: number; spread: number };
    'playback:end': void;
    'playback:play': void;
    'playback:pause': void;
    'playback:set-step-size': { step: string };
    'playback:set-speed': { speed: number };
    'playback:step-back': void;
    'playback:step-forward': void;
    'playback:set-mode': { mode: PlaybackMode };
    'playback:set-step-snap': { snap: boolean };
    /** A move was refused because the playhead is locked forward. */
    'playback:blocked': { tNs: bigint; floorNs: bigint };

    // Account
    'account:update': {
        balance: number;
        equity: number;
        realizedPnl: number;
        unrealizedPnl: number;
        openPositionCount: number;
        currency: string;
    };
    'account:reset': void;
    'account:deposit': { amount: number; ts: bigint; note?: string };
    'account:withdraw': { amount: number; ts: bigint; note?: string };

    // Error
    error: { source: string; message: string; error?: unknown };
}

export type InterceptableEvent =
    | 'trading:buy-market'
    | 'trading:sell-market'
    | 'trading:flatten'
    | 'chart:set-timeframe'
    | 'chart:set-symbol'
    | 'chart:set-tool'
    | 'drawing:add'
    | 'drawing:remove'
    | 'order:placed'
    | 'playback:seek'
    | 'playback:goto'
    | 'playback:play'
    | 'playback:pause';

export type Interceptor<K extends keyof ChartEvents> = (
    data: ChartEvents[K],
    next: (data: ChartEvents[K]) => void,
) => void;

export class TypedEventBus {
    private readonly handlers = new Map<string, Set<Function>>();
    private readonly interceptors = new Map<string, Array<Function>>();
    private readonly emitting = new Set<string>();

    // replayed to a handler the moment it subscribes. the first two are standing
    // state rather than a happening, so a panel opening between emissions
    // shouldnt read as empty - a ticket opened on a paused chart used to show a
    // bid and ask of zero. the third is a request deliberately made before the
    // panel that answers it exists.
    private static readonly STICKY = new Set<keyof ChartEvents>([
        'account:update',
        'playback:tick',
        'trading:ticket-requested',
    ]);
    private readonly stickyCache = new Map<string, unknown>();

    on<K extends keyof ChartEvents>(event: K, handler: (data: ChartEvents[K]) => void): () => void {
        if (!this.handlers.has(event)) this.handlers.set(event, new Set());
        this.handlers.get(event)!.add(handler);
        if (TypedEventBus.STICKY.has(event) && this.stickyCache.has(event)) {
            handler(this.stickyCache.get(event) as ChartEvents[K]);
        }
        return () => this.off(event, handler);
    }

    /**
     * Is anything listening for this event? For controls that ask rather than
     * act - a button that opens the order ticket is only worth showing where a
     * ticket exists to open.
     */
    hasListeners<K extends keyof ChartEvents>(event: K): boolean {
        return (this.handlers.get(event)?.size ?? 0) > 0;
    }

    off<K extends keyof ChartEvents>(event: K, handler: Function): void {
        this.handlers.get(event)?.delete(handler);
    }

    intercept<K extends InterceptableEvent>(event: K, interceptor: Interceptor<K>): () => void {
        if (!this.interceptors.has(event)) this.interceptors.set(event, []);
        this.interceptors.get(event)!.push(interceptor);
        return () => {
            const list = this.interceptors.get(event);
            if (list) {
                const idx = list.indexOf(interceptor);
                if (idx !== -1) list.splice(idx, 1);
            }
        };
    }

    emit<K extends keyof ChartEvents>(event: K, data: ChartEvents[K]): void {
        if (TypedEventBus.STICKY.has(event)) {
            this.stickyCache.set(event, data);
        }
        const chain = this.interceptors.get(event);
        if (!chain || chain.length === 0) {
            this.handlers.get(event)?.forEach((h) => h(data));
            return;
        }

        if (this.emitting.has(event)) {
            console.error(`[TypedEventBus] Interceptor loop detected on '${event}' - blocked`);
            return;
        }

        this.emitting.add(event);
        let i = 0;
        const next = (current: ChartEvents[K]) => {
            if (i < chain.length) {
                chain[i++](current, next);
            } else {
                this.handlers.get(event)?.forEach((h) => h(current));
            }
        };
        try {
            next(data);
        } finally {
            this.emitting.delete(event);
        }
    }

    clear(): void {
        this.handlers.clear();
        this.interceptors.clear();
    }
}
