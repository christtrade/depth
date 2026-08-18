// public SDK surface.
//
// the controller is DepthChart, the React view is Depth, and useDepthChart()
// wires the two together.

// Controller
export { DepthChart } from './DepthChart';
export type { ChartOptions } from './DepthChart';
export { useDepthChart } from '../react/useDepthChart';
export { default as Depth } from '../ChartOuter';
export type { DepthProps } from '../ChartOuter';

// Core engines
export { ExecutionEngine } from './ExecutionEngine';
export { DataEngine } from './DataEngine';
export type { DataEngineConfig, ChartDataSnapshot } from './DataEngine';
export { TypedEventBus } from './TypedEventBus';
export type { ChartEvents } from './TypedEventBus';
export { RenderEngine } from './RenderEngine';
export type { DrawParams } from './RenderEngine';

// Data adapter
export type {
    IDataAdapter,
    DataLevel,
    TickEvent,
    OhlcvBar,
    L2Snapshot,
    MboEvent,
} from '../interfaces/IDataAdapter';

// Execution adapter
export type { IExecutionAdapter } from '../interfaces/IExecutionAdapter';

// Coordinate transformer
export { LiveTransformer } from '../interfaces/ICoordinateTransformer';
export type {
    ICoordinateTransformer,
    PriceScaleMode,
    TransformedDrawHook,
} from '../interfaces/ICoordinateTransformer';

// Plugins
export { PluginRegistry } from './PluginRegistry';
export type { PluginIcon, InstalledPlugin } from './PluginRegistry';
export type {
    PluginCatalogEntry,
    PluginStartupEntry,
    PluginStartupRecord,
} from './plugin-startup';

// settings fields, for plugins that declare a drawing or chart type of their own
export type { StyleField } from '../components/drawings/drawing-settings-dialog';
export type { PluginDrawingToolDef } from './DrawingRegistry';
// for plugins that serve their own symbols
export type { PluginDataSource } from './DataSourceRegistry';

export { ChartModel } from './ChartModel';
export type { ChartModelInit, ChartPluginRef, ChartPaneState } from './ChartModel';
export { DrawingStore } from './DrawingStore';
export type {
    ChartPlugin,
    PluginType,
    Permission,
    PluginManifest,
    PluginContext,
    PluginDataSnapshot,
    DrawingPlugin,
    ChartTypePlugin,
    ChartTypeRenderContext,
    DataSourcePlugin,
    IndicatorPlugin,
    IndicatorRenderContext,
} from '../interfaces/plugins';

// Scripted plugin system
export { createScriptedPlugin } from './ScriptedPlugin';

// Data level utilities
export { isCompatible, DATA_LEVEL_LABELS, incompatibleReason } from './processing/data-level';

// Processors, for adapter authors
export { processL3Chunk, mergeL3Chunks } from './processing/l3-processor';
export type { ProcessedL3Chunk, L3DataChunk } from './processing/l3-processor';
export { processOhlcvChunk, processOhlcvWithSupplemental } from './processing/ohlcv-processor';
export type { OhlcvDataChunk } from './processing/ohlcv-processor';
export { processTickChunk } from './processing/tick-processor';
export type { TickDataChunk } from './processing/tick-processor';
export { processL2Chunk } from './processing/l2-processor';
export type { L2DataChunk } from './processing/l2-processor';
export type { DataChunk } from './processing/data-chunk';
export { isEmptyChunk } from './processing/data-chunk';

// Shared domain types
export type { TradePoint, PriceHistory, ViewBounds, OhlcvBarMs } from '../lib/types';
export type { Timeframe } from '../lib/timeframes';
export type { DrawingTool } from '../lib/types/drawing-types';
export type { FootprintBar, FootprintOptions } from '../lib/types/footprint';
export type { ChartSettings } from '../lib/types/chart-settings';
export { DEFAULT_CHART_SETTINGS } from '../lib/types/chart-settings';

// Matching engine
export type { PlaceOrderRequest, L3EngineOptions, FeeSchedule } from '../lib/matchingEngine';
export {
    createL3MatchingEngine,
    feeScheduleFor,
    MICRO_FEE_SCHEDULE,
    NQ_FEE_SCHEDULE,
    ZERO_FEE_SCHEDULE,
} from '../lib/matchingEngine';

// Mock adapters, for testing
export { SimulatedMarketAdapter, createSimulatedAdapter } from '../lib/createSimulatedAdapter';

// Account manager
export { AccountManager } from './AccountManager';
export type { AccountOptions, AccountSaveState } from './AccountManager';
export type { ChartSaveState, LayoutDescriptor } from './DepthChart';
export { SAVE_VERSION, stringifyChartSave, parseChartSave } from './DepthChart';

// Account adapter
export type {
    IAccountAdapter,
    AccountAdapterCallbacks,
    AccountSnapshot,
} from '../interfaces/IAccountAdapter';

// Ready-made playback slot components
export { AccountSummary } from '../components/account/AccountSummary';
export { QuickTradingButtons } from '../components/trading/QuickTradingButtons';

// Order ticket
export { OrderPanel } from '../components/trading/OrderPanel';
export type { OrderPanelProps } from '../components/trading/OrderPanel';
// the arithmetic on its own, for hosts that want the figures without the panel
export {
    AMOUNT_MODES,
    amountFromQty,
    contractValue,
    deriveTicket,
    levelPrice,
    levelTicks,
    moneyPerTick,
    priceDecimals,
    qtyFromAmount,
    roundQty,
    roundToTick,
    specForSymbol,
    tickSizeOf,
    tickValueOf,
    ticketFromPosition,
    ticksBetween,
} from '../components/trading/order-math';
export type {
    AmountMode,
    Ticket,
    TicketInput,
    TicketProblem,
} from '../components/trading/order-math';

// Trading domain. IExecutionAdapter's signatures already traffic in these, so
// they are part of the surface whether or not they are named here.
export type {
    OrderSide,
    OrderType,
    OrderStatus,
    Order,
    Fill,
    PositionSide,
    PositionStatus,
    Position,
    PositionClose,
    PositionsSnapshot,
    CloseReason,
    TimeInForce,
    BracketLevel,
    BracketSpec,
    BracketAmendment,
    CommissionConfig,
    SlippageConfig,
    CreatePositionParams,
    ClosePositionParams,
    CreateOrderParams,
    PriceTick,
    TradingEvent,
    TradingEventKind,
} from '../lib/types/trading-types';
export {
    getTickValue,
    calcUnrealizedPnl,
    calcUnrealizedPnlPct,
    formatPnl,
    formatPnlPct,
} from '../lib/types/trading-types';

// Session utilities
export {
    isMarketOpen,
    nextOpenNs,
    prevCloseNs,
    clipToSession,
    getSessionStatus,
} from './SessionUtils';
export type { SessionWindow, SessionStatus } from './SessionUtils';

// Symbol / session types
export type {
    SymbolInfo,
    SymbolType,
    SymbolSearchMode,
    SymbolSearchRequest,
    SymbolSearchResponse,
    AdapterCapabilities,
    TradingSession,
    TradingSubsession,
    DayOfWeek,
    SessionCorrection,
    PriceFormat,
    FractionalFormat,
    ContractSpec,
} from '../interfaces/IDataAdapter';

/** The built-in matcher, so server-side adapters can rank like the picker does. */
export { searchSymbolsLocally, normalizeSymbolSearchResponse } from '../lib/symbol-search';

export { SessionMapper, createSessionMapper } from './SessionMapper';
export type { SessionSegment } from './SessionMapper';
export { walkBackMarketNs } from './SessionUtils';

// Local persistence. every chart-owned localStorage key lives under
// christtrade:chart:, and writes are gated on the user's "save settings to this
// device" preference (on by default). these also round-trip through
// chart.serialize() / chart.restore().
export {
    STORAGE_NAMESPACE,
    StorageKey,
    isPersistenceEnabled,
    setPersistenceEnabled,
    onPersistenceChange,
    onChartStorageChange,
    clearChartStorage,
    chartStorageKeys,
    chartStorageSize,
    serializeChartPreferences,
    restoreChartPreferences,
    readJSON,
    writeJSON,
    setChartStorageBackend,
} from '../lib/storage';
export type { ChartPreferences, ChartStorageBackend } from '../lib/storage';

// TradingView migration. seeds a first-run session from their own localStorage
// prefs, same origin only. runs on chart construction unless
// importTradingViewSettings: false is passed in ChartOptions.
export {
    importTradingViewSettings,
    hasTradingViewSettings,
    readTradingViewChartSettings,
    readTradingViewFavoriteDrawings,
    resetTradingViewImport,
} from '../lib/tradingview-import';
export type { TradingViewImportResult } from '../lib/tradingview-import';

// Extension-point vocabulary. everything below already appears in the signatures
// of an exported interface, event payload or class - leaving it unexported meant
// an adapter or plugin author could not name what the API demands of them.

// data adapters
export { DataAdapterError, makeTimeRange, nsToIso } from '../interfaces/IDataAdapter';
export { isoToNs } from '../lib/sampler';
export type {
    BarPreviewResponse,
    BarResponse,
    DataAdapterErrorCode,
    FetchRequest,
    PreProcessedPayload,
    SupplementalBarSet,
    SymbolIcon,
    TimeRange,
} from '../interfaces/IDataAdapter';

// plugins
export type {
    BottomBarHandle,
    BottomBarItem,
    ContextMenuItem,
    FloatingPanelOpts,
    NotifyLevel,
    NotifyOptions,
    PaneOptions,
    PluginExecutionSurface,
    PluginLifecycle,
    PluginServices,
    PluginStorage,
    ServiceApi,
    ServiceObserver,
    SettingSchema,
    SettingSchemaType,
    ThemeDef,
    ToolbarItem,
} from '../interfaces/plugins/IChartPlugin';
export type {
    ChartTypeActiveContext,
    ChartTypeKeyEvent,
    ChartTypePointerEvent,
} from '../interfaces/plugins/IChartTypePlugin';
export type { AnchorConfig, Point } from '../interfaces/plugins/IDrawingPlugin';
export type { IndicatorCrosshair } from '../interfaces/plugins/IIndicatorPlugin';
export type { PluginDrawingHitContext, PluginDrawingRenderContext } from './DrawingRegistry';
export type { PluginStateSnapshot } from './PlaybackStateRegistry';
export type { PluginSchedule } from './PluginSchedule';
export { DataSourceRegistry } from './DataSourceRegistry';
export { GlobalChartBus } from './GlobalChartBus';

// execution and accounts
export { DEFAULT_FILL_SEARCH } from '../lib/matchingEngine';
export type { FillAmbiguity, FillSearchOptions, L3MatchingEngine } from '../lib/matchingEngine';
export type { OrderGuard } from './ExecutionEngine';
export type {
    AccountStats,
    EquityPoint,
    LedgerAdjustment,
    LedgerFill,
    LedgerOrder,
    LedgerPosition,
} from './AccountManager';

// event payloads, for anyone typing a ChartEvents handler
export type { ActiveDrawingTool, Anchor, Drawing } from '../lib/types/drawing-types';
export type { SerialTrade, TradeLine } from '../lib/types';
export type { ChartPane, Indicator, Rect } from '../lib/types/indicator-types';
export type { CrosshairSync, TimeRangeSync } from '../lib/types/layout-sync';
export type { TradeLineHitMap } from '../lib/renderers/drawTradeLines';
export type { PlaybackMode } from '../hooks/usePlaybackEngine';
export type { DrawHook } from './RenderEngine';
export type { InterceptableEvent, Interceptor } from './TypedEventBus';
export { ChartState } from './ChartState';
