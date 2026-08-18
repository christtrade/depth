// the constants a user script sees as globals. they live here rather than in
// script.worker.ts because the script gets evaluated in two places - the worker,
// which owns registration and the compute handlers, and the main thread, which
// resolves the ones that draw and hit-test. both scopes have to agree or a
// script parses in one and throws in the other.

export const PluginType = Object.freeze({
    indicator: 'indicator',
    drawing: 'drawing',
    chartType: 'chart-type',
    dataSource: 'data-source',
    extension: 'extension',
} as const);

export const DataLevel = Object.freeze({
    mbo: 'l3',
    l3: 'l3',
    l2: 'l2',
    ohlcv: 'ohlcv',
    tick: 'tick',
} as const);

export const Layout = Object.freeze({
    overlay: 'overlay',
    pane: 'pane',
} as const);

/** The DSL globals as one bag, for splatting into an eval scope. */
export const SCRIPT_DSL: Record<string, unknown> = { PluginType, DataLevel, Layout };
