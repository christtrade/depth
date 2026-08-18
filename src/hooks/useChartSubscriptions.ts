import { useEffect, type MutableRefObject } from 'react';
import { type ChartTypePlugin, type ChartTypeActiveContext } from '../core/PluginRegistry';
import { type AccountManager } from '../core/AccountManager';
import { type RenderEngine } from '../core/RenderEngine';
import { type TypedEventBus } from '../core/TypedEventBus';
import { type ChartPane, type Indicator } from '../lib/types/indicator-types';
import { type ChartSettings } from '../lib/types/chart-settings';
import { type TradePoint, type OhlcvBarMs, type ViewBounds } from '../lib/types';
import { type DataLevel } from '../interfaces/IDataAdapter';
import { type TickEvent } from '../interfaces/IDataAdapter';
import { isCompatible } from '../core/processing/data-level';
import { type OhlcvBar as IndicatorOhlcvBar } from '../lib/indicator-stdlib';
import { type FootprintBar } from '../lib/types/footprint';
import { type SerialTrade } from '../lib/types';
import { type TradeLineHitMap } from '../lib/renderers/drawTradeLines';
import { type Timeframe } from '../lib/timeframes';
import {
    type CrosshairSync,
    type SyncInLayout,
    type TimeRangeSync,
} from '../lib/types/layout-sync';

export interface UseChartSubscriptionsParams {
    // Props
    eventBus: TypedEventBus;
    chartId: number;
    account: AccountManager;

    // Refs
    pluginChartTypesRef: MutableRefObject<Map<string, ChartTypePlugin>>;
    activeChartTypeBottomBarIds: MutableRefObject<Set<string>>;
    hitMapRef: MutableRefObject<TradeLineHitMap>;
    indicatorsRef: MutableRefObject<Indicator[]>;
    panesRef: MutableRefObject<ChartPane[]>;
    renderEngineRef: MutableRefObject<RenderEngine | null>;
    horizonRef: MutableRefObject<bigint>;
    activeTimeframeRef: MutableRefObject<Timeframe>;
    chartSettingsRef: MutableRefObject<ChartSettings>;
    pluginChartTypeComputedRef: MutableRefObject<Map<string, unknown>>;
    dataLevelRef: MutableRefObject<DataLevel | null>;
    previewBarsRef: MutableRefObject<OhlcvBarMs[]>;
    candleCacheRef: MutableRefObject<Map<bigint, any> | null>;
    ohlcvBarsRef: MutableRefObject<{ barNs: bigint; bars: OhlcvBarMs[]; display: OhlcvBarMs[] }>;
    openBarRef: MutableRefObject<FootprintBar | null>;
    viewRef: MutableRefObject<ViewBounds | null>;
    accountSnapRef: MutableRefObject<any>;

    // Setters
    setActiveTool: (tool: any) => void;
    setActiveTimeframe: (tf: Timeframe) => void;
    handleTimeframeChange: (tf: Timeframe) => void;
    setPanes: (updater: ChartPane[] | ((prev: ChartPane[]) => ChartPane[])) => void;
    setIndicators: (inds: Indicator[]) => void;
    setPluginChartTypes: (types: ChartTypePlugin[]) => void;
    setChartSettings: (updater: ChartSettings | ((prev: ChartSettings) => ChartSettings)) => void;

    // Callbacks
    resetView: () => void;
    buildChartTypeActiveCtx: () => ChartTypeActiveContext;
    pushDrawParams: () => void;
    runIndicatorWorker: (trades: SerialTrade[], barNs: bigint) => void;
    getTradesUpToHorizon: (horizon: bigint) => TradePoint[];
    syncPixelLayouts: (panes?: ChartPane[]) => void;
    autofitIndicatorPanes: () => void;
    handleAddIndicator: (id: string) => void;
    handleRemoveIndicator: (id: string) => void;
    onSymbolChange: (symbol: string) => void;

    // Sync in layout
    /** This layout's live sync switches (a ref: the handlers outlive a render). */
    syncInLayoutRef: MutableRefObject<SyncInLayout>;
    /** Take (or drop) the crosshair another cell is broadcasting. */
    applyCrosshairSync: (sync: CrosshairSync | null) => void;
    /** Follow another cell's time axis. */
    applyTimeRangeSync: (sync: TimeRangeSync) => void;
}

export function useChartSubscriptions(p: UseChartSubscriptionsParams): void {
    const {
        eventBus,
        chartId,
        account,
        pluginChartTypesRef,
        activeChartTypeBottomBarIds,
        hitMapRef,
        indicatorsRef,
        panesRef,
        renderEngineRef,
        horizonRef,
        activeTimeframeRef,
        chartSettingsRef,
        pluginChartTypeComputedRef,
        dataLevelRef,
        previewBarsRef,
        candleCacheRef,
        ohlcvBarsRef,
        openBarRef,
        viewRef,
        accountSnapRef,
        setActiveTool,
        setPanes,
        setIndicators,
        setPluginChartTypes,
        setChartSettings,
        resetView,
        buildChartTypeActiveCtx,
        pushDrawParams,
        runIndicatorWorker,
        getTradesUpToHorizon,
        syncPixelLayouts,
        autofitIndicatorPanes,
        handleAddIndicator,
        handleRemoveIndicator,
        onSymbolChange,
        syncInLayoutRef,
        applyCrosshairSync,
        applyTimeRangeSync,
    } = p;

    useEffect(() => {
        // Every live instance of a pool plugin, off this pane. Scripted plugins
        // register their indicators as `${pluginId}:${index}`, so the plugin id
        // alone never matches an instance - match the prefix too. Routed through
        // handleRemoveIndicator so the indicator's sub-pane goes with it.
        const removePluginInstances = (pluginId: string) => {
            const doomed = indicatorsRef.current.filter(
                (i) => i.id === pluginId || i.id.startsWith(`${pluginId}:`),
            );
            for (const ind of doomed) handleRemoveIndicator(ind.id);
        };

        // The account snapshot the fill arrows are drawn from.
        //
        // Coalesced to one snapshot per frame: getSnapshot() rebuilds the whole
        // ledger view (fills, orders, positions, stats, equity curve) and a busy
        // replay fires many events inside a single frame, none of which can be
        // seen separately anyway.
        let snapRaf = 0;
        const refreshAccountSnapshot = () => {
            if (!account || snapRaf) return;
            snapRaf = requestAnimationFrame(() => {
                snapRaf = 0;
                accountSnapRef.current = account.getSnapshot();
                pushDrawParams();
                renderEngineRef.current?.markDirty('ui');
            });
        };

        const unsubs = [
            eventBus.on('chart:reset-view', () => resetView()),

            // Sync in layout
            // Both switches are read per-event from the ref, so flipping one
            // takes effect on the next pointer move / scroll with no re-subscribe.
            eventBus.on('layout:crosshair', (sync) => {
                if (sync && sync.id === chartId) return; // our own pointer
                applyCrosshairSync(sync);
            }),
            eventBus.on('layout:time-range', (sync) => {
                if (sync.id === chartId) return;
                const { time, dateRange } = syncInLayoutRef.current;
                if (!time && !dateRange) return;
                applyTimeRangeSync(sync);
            }),
            eventBus.on('chart:set-tool', ({ tool }) => setActiveTool(tool)),
            // NOTE: chart:set-timeframe is applied to the FOCUSED pane only, in
            // ChartOuter - timeframe is per-pane (independent between ChartInner
            // cells), so it must not broadcast to every pane here.
            eventBus.on('chart:set-symbol', ({ symbol, id }) => {
                if (chartId === id) {
                    onSymbolChange(symbol);
                    setPanes((prev) => prev.map((p) => (p.isMain ? { ...p, symbol } : p)));
                }
            }),
            eventBus.on('chart:add-indicator', ({ id }) => handleAddIndicator(id)),
            eventBus.on('chart:remove-indicator', ({ id }) => handleRemoveIndicator(id)),
            eventBus.on('chart:remove-plugin-indicator', ({ pluginId }) =>
                removePluginInstances(pluginId),
            ),
            // An uninstalled plugin's worker is gone - its indicators would sit
            // there frozen, so they come off with it.
            eventBus.on('plugin:uninstalled', ({ id }) => removePluginInstances(id)),
            eventBus.on('chart:set-type', ({ old, new: _new }) => {
                const prevChartType = old;
                const nextChartType = _new;
                if (prevChartType !== nextChartType) {
                    pluginChartTypesRef.current.get(prevChartType)?.onDeactivate?.();
                    for (const id of activeChartTypeBottomBarIds.current)
                        eventBus.emit('plugin:bottom-bar-item-removed', { id });
                    activeChartTypeBottomBarIds.current.clear();
                    pluginChartTypesRef.current
                        .get(nextChartType)
                        ?.onActivate?.(buildChartTypeActiveCtx());
                }
            }),
            // Only ours. Every cell of a multi-chart layout paints onto the same
            // bus, and a hit map is canvas-space: taking a neighbour's would
            // hit-test our pointer against their line positions (and their
            // canvas height), which is why dragging a TP/SL or an entry line
            // silently stopped working in every layout with more than one cell.
            eventBus.on('hitmap:update', ({ id, hitMap }) => {
                if (id !== chartId) return;
                hitMapRef.current = hitMap;
            }),
            eventBus.on('plugin:add-indicator', ({ indicator, pane }) => {
                if (indicatorsRef.current.some((i) => i.id === indicator.id)) return;

                if (pane && !panesRef.current.some((p) => p.id === pane.id)) {
                    panesRef.current = [...panesRef.current, pane];
                    setPanes(panesRef.current);
                }

                indicatorsRef.current = [...indicatorsRef.current, indicator];
                setIndicators(indicatorsRef.current);
                pushDrawParams();
                renderEngineRef.current?.markDirty('base');
                runIndicatorWorker(
                    getTradesUpToHorizon(horizonRef.current),
                    activeTimeframeRef.current.barNs,
                );
            }),
            eventBus.on('plugin:add-indicator:id', ({ id }) => {
                const indicator = indicatorsRef.current.find((i) => i.id === id);
                if (!indicator) return;
            }),
            eventBus.on('plugin:register-pane', ({ id, heightRatio }) => {
                if (panesRef.current.some((p) => p.id === id)) return;

                const newPane: ChartPane = {
                    id,
                    isMain: false,
                    heightRatio,
                    yMin: 0,
                    yMax: 0,
                    yAxisAuto: true,
                    collapsed: false,
                };

                panesRef.current = [...panesRef.current, newPane];
                setPanes(panesRef.current);
                syncPixelLayouts(panesRef.current);
                pushDrawParams();
                renderEngineRef.current?.markDirty('base');
            }),
            eventBus.on('plugin:remove-pane', ({ id }) => {
                if (!panesRef.current.some((p) => p.id === id)) return;

                panesRef.current = panesRef.current.filter((p) => p.id !== id);
                indicatorsRef.current = indicatorsRef.current.filter((ind) => ind.paneId !== id);

                setPanes(panesRef.current);
                setIndicators(indicatorsRef.current);
                syncPixelLayouts(panesRef.current);
                pushDrawParams();
                renderEngineRef.current?.markDirty('base');
            }),
            eventBus.on('plugin:register-chart-type', ({ plugin }) => {
                if (pluginChartTypesRef.current.has(plugin.chartTypeId)) return;
                pluginChartTypesRef.current.set(plugin.chartTypeId, plugin);
                setPluginChartTypes([...pluginChartTypesRef.current.values()]);

                if (chartSettingsRef.current.chartType !== plugin.chartTypeId) return;

                // A restored chart sits on this id long before the plugin
                // installs, so this is where a saved chart type meets the
                // symbol it was saved on. If the level no longer covers it,
                // activating would just paint nothing.
                const required = plugin.require ?? 'ohlcv';
                const actual = dataLevelRef.current;
                if (actual && !isCompatible(required, actual)) {
                    eventBus.emit('plugin:incompatible', {
                        id: plugin.chartTypeId,
                        name: plugin.label ?? plugin.name,
                        kind: 'chart-type',
                        required,
                        actual,
                    });
                    setChartSettings((prev) => ({ ...prev, chartType: 'candles' }));
                    return;
                }
                plugin.onActivate?.(buildChartTypeActiveCtx());
            }),
            eventBus.on('plugin:unregister-chart-type', ({ id, hotReload }) => {
                pluginChartTypesRef.current.delete(id);
                pluginChartTypeComputedRef.current.delete(id);
                setPluginChartTypes([...pluginChartTypesRef.current.values()]);

                if (!hotReload && chartSettingsRef.current.chartType === id) {
                    setChartSettings((p) => ({ ...p, chartType: 'candles' }));
                } else if (hotReload) {
                    renderEngineRef.current?.markDirty('base');
                }
            }),
            eventBus.on('plugin:recompute-indicator', ({ id }) => {
                if (!indicatorsRef.current.some((i) => i.id === id)) return;
                runIndicatorWorker(
                    getTradesUpToHorizon(horizonRef.current),
                    activeTimeframeRef.current.barNs,
                );
            }),
            eventBus.on('plugin:redraw-indicators', () => {
                runIndicatorWorker(
                    getTradesUpToHorizon(horizonRef.current),
                    activeTimeframeRef.current.barNs,
                );
            }),
            eventBus.on('plugin:scripted-recompute' as any, ({ id }: { id: string }) => {
                const SCRIPTED_SENTINEL = '__scripted__';
                const ind = indicatorsRef.current.find(
                    (i) => i.id === id && i.workerInit === SCRIPTED_SENTINEL,
                );
                const isChartTypePlugin =
                    !ind &&
                    pluginChartTypesRef.current.has(id) &&
                    (pluginChartTypesRef.current.get(id) as any)?.workerInit === SCRIPTED_SENTINEL;
                if (!ind && !isChartTypePlugin) return;

                const trades = getTradesUpToHorizon(horizonRef.current);

                // Window the data fed to the indicator to the viewport (+ a pad
                // that always covers any reasonable lookback) instead of the whole
                // loaded history. After panning back, recomputing/serialising every
                // bar to the worker each playback tick was O(total) - the freeze the
                // perf trace flagged. The window follows the view (a pan fires a
                // debounced recompute via scheduleResample), so off-screen bars are
                // never computed. Falls back to the full series if there's no view.
                let winStartMs = -Infinity;
                let winEndMs = Infinity;
                {
                    const view = viewRef.current;
                    if (view) {
                        const barNs = activeTimeframeRef.current.barNs;
                        const widthNs = view.tMax - view.tMin;
                        // Left pad: at least one screen, and at least 1000 bars so
                        // even large-lookback indicators get enough history.
                        const minLeftNs = 1000n * barNs;
                        const leftPadNs = widthNs > minLeftNs ? widthNs : minLeftNs;
                        const winStartNs = view.tMin - leftPadNs;
                        // Right edge: one screen past the view, never beyond the
                        // playhead (no future data).
                        let winEndNs = view.tMax + widthNs;
                        if (winEndNs > horizonRef.current) winEndNs = horizonRef.current;
                        winStartMs = Number(winStartNs / 1_000_000n);
                        winEndMs = Number(winEndNs / 1_000_000n);
                    }
                }

                const ohlcv: IndicatorOhlcvBar[] = [];
                function toNs(ts: number | bigint): bigint {
                    const t = typeof ts === 'bigint' ? ts : BigInt(ts);
                    if (t < 1_000_000_000_000n) return t * 1_000_000_000n;
                    else if (t < 1_000_000_000_000_000n) return t * 1_000_000n;
                    else if (t < 1_000_000_000_000_000_000n) return t * 1_000n;
                    else return t;
                }
                if (dataLevelRef.current === 'l3') {
                    for (const bar of previewBarsRef.current) {
                        ohlcv.push({
                            ts: toNs(bar.time),
                            open: bar.open,
                            high: bar.high,
                            low: bar.low,
                            close: bar.close,
                            volume: bar.volume,
                        });
                    }
                    for (const [ts, bar] of candleCacheRef.current) {
                        ohlcv.push({
                            ts: toNs(ts),
                            open: bar.open,
                            high: bar.high,
                            low: bar.low,
                            close: bar.close,
                            volume: bar.volume,
                        });
                    }
                    ohlcv.sort((a, b) => (a.ts < b.ts ? -1 : 1));
                } else if (dataLevelRef.current === 'ohlcv') {
                    const barMs = Number(activeTimeframeRef.current.barNs / 1_000_000n);
                    const formingBarMs =
                        Math.floor(Number(horizonRef.current / 1_000_000n) / barMs) * barMs;
                    const display = ohlcvBarsRef.current.display;
                    // Binary-search the first in-window bar so we skip (not scan)
                    // all the off-screen history - keeps this O(window), not O(total).
                    let lo = 0,
                        hi = display.length - 1,
                        start = display.length;
                    while (lo <= hi) {
                        const mid = (lo + hi) >>> 1;
                        if (display[mid].time >= winStartMs) {
                            start = mid;
                            hi = mid - 1;
                        } else lo = mid + 1;
                    }
                    for (let i = start; i < display.length; i++) {
                        const bar = display[i];
                        if (bar.time > winEndMs) break;
                        if (bar.time >= formingBarMs && openBarRef.current) {
                            ohlcv.push({
                                ts: openBarRef.current.ts,
                                open: openBarRef.current.open,
                                high: openBarRef.current.high,
                                low: openBarRef.current.low,
                                close: openBarRef.current.close,
                                volume: openBarRef.current.totalVol,
                            });
                            break;
                        } else {
                            ohlcv.push({
                                ts: toNs(bar.time),
                                open: bar.open,
                                high: bar.high,
                                low: bar.low,
                                close: bar.close,
                                volume: bar.volume,
                            });
                        }
                    }
                }

                const ticks: TickEvent[] = trades.map((t) => ({
                    time: Number(t.ts / 1_000_000n),
                    price: t.price,
                    size: t.size,
                    side: t.side,
                }));

                eventBus.emit('plugin:scripted-compute' as any, {
                    id,
                    ohlcv,
                    trades,
                    ticks,
                    snapshots: [],
                    barNs: activeTimeframeRef.current.barNs,
                });
            }),
            eventBus.on('plugin:chart-type-updated', ({ id }) => {
                pushDrawParams();
                renderEngineRef.current?.markDirty('base');
            }),
            // A scripted indicator recomputed. Marking dirty is enough to repaint -
            // the engine's snapshot holds the same indicator objects, and drawBase
            // reads the plugin's draw commands live - so this stays a flag flip on
            // a path that runs once per horizon tick, per indicator. Filtered so N
            // panes don't each repaint for the others' plugins.
            eventBus.on('plugin:indicator-updated', ({ id }) => {
                const ind = indicatorsRef.current.find((i) => i.id === id);
                if (!ind) return;

                // Its own pane, though, is registered at yMin === yMax === 0 and
                // can only be scaled from the plugin's draw commands - which do
                // not exist until this event. Miss this first fit and the pane
                // sits at a degenerate scale, drawing nothing, until an unrelated
                // autofit (resetting the axis, or a pan) happens to run.
                // getAutoYBounds always pads, so a fitted pane never re-enters.
                if (ind.paneId && ind.paneId !== 'main') {
                    const pane = panesRef.current.find((pn) => pn.id === ind.paneId);
                    if (pane?.yAxisAuto && pane.yMin === pane.yMax) autofitIndicatorPanes();
                }

                renderEngineRef.current?.markDirty('base');
            }),
            eventBus.on('plugin:remove-indicator', ({ id }) => {
                if (!indicatorsRef.current.some((i) => i.id === id)) return;
                indicatorsRef.current = indicatorsRef.current.filter((i) => i.id !== id);
                setIndicators(indicatorsRef.current);
                pushDrawParams();
                renderEngineRef.current?.markDirty('base');
            }),
            eventBus.on('playback:seek', ({ tNs }) => {
                renderEngineRef.current?.markDirty('ui');
            }),
            // Not 'trading:event': that only fires when something *happens*, so a
            // chart mounting onto an already-restored ledger had no snapshot at
            // all. The fills were in the account the whole time and simply went
            // undrawn until the first playback tick produced an event.
            //
            // account:update covers strictly more. The AccountManager emits it
            // after every ingest AND when the horizon moves - which matters,
            // since the snapshot is horizon-filtered - and it is sticky, so a
            // restore that landed before this subscription still reaches us.
            eventBus.on('account:update', refreshAccountSnapshot),
        ];

        // ...and for the case where nothing has emitted at all yet.
        refreshAccountSnapshot();

        return () => {
            if (snapRaf) cancelAnimationFrame(snapRaf);
            unsubs.forEach((fn) => fn());
        };
    }, [eventBus, chartId]);
}
