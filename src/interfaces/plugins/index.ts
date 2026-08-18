// interfaces/plugins/index.ts - barrel export for all plugin contracts

export type {
    PluginType,
    Permission,
    ToolbarItem,
    BottomBarHandle,
    BottomBarItem,
    FloatingPanelOpts,
    ContextMenuItem,
    ThemeDef,
    SettingSchema,
    SettingSchemaType,
    PluginStorage,
    ServiceApi,
    ServiceObserver,
    PluginServices,
    PluginSchedule,
    NotifyLevel,
    NotifyOptions,
    PluginStateSnapshot,
    PluginExecutionSurface,
    PluginLifecycle,
    PaneOptions,
    PluginDataSnapshot,
    PluginContext,
    ChartPlugin,
    PluginManifest,
} from './IChartPlugin';

export type { DrawingPlugin, Point, AnchorConfig } from './IDrawingPlugin';

export type {
    ChartTypePlugin,
    ChartTypeRenderContext,
    ChartTypeActiveContext,
    ChartTypePointerEvent,
    ChartTypeKeyEvent,
} from './IChartTypePlugin';

export type { DataSourcePlugin } from './IDataSourcePlugin';

export type {
    IndicatorPlugin,
    IndicatorRenderContext,
    IndicatorCrosshair,
} from './IIndicatorPlugin';
