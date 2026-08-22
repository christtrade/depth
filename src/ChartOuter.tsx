'use client';

// the multi-chart layout shell. one toolbar, one drawing toolbar and one set of
// playback controls, all driving the focused chart, plus a synced horizon - the
// focused chart broadcasts and every other one seeks to it.
//
// charts are lazy-mounted, created the first time their cell is shown, and stay
// alive from then on.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Chart, { type ChartHandle } from './ChartInner';
import { DrawingToolbar } from './components/drawings/drawing-toolbar';
import { IndicatorsButton } from './components/indicators/indicators-dialog';
import { TimeframeSelector } from './components/toolbar/timeframe-selector';
import { ChartTypeSelector } from './components/toolbar/chart-type-selector';
import { loadCustomTimeframes, saveCustomTimeframes, type Timeframe } from './lib/timeframes';
import {
    ChartSettings,
    ChartSettingsDialog,
    DEFAULT_CHART_SETTINGS,
} from './components/chart/chart-settings-dialog';
import { Separator } from './components/ui/separator';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './components/ui/tooltip';
import { cn } from './lib/utils';
import { Lock, LockOpen, Grid3X3, Magnet, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { armTool, CURSOR_TOOL, type ActiveDrawingTool } from './lib/types/drawing-types';
import { Button } from './components/ui/button';
import { usePlaybackEngine, type PrefetchOptions } from './hooks/usePlaybackEngine';
import { toast } from 'sonner';
import { TypedEventBus, type ChartEvents } from './core/TypedEventBus';
import {
    DepthChart,
    DataLevel,
    ExecutionEngine,
    LiveTransformer,
    incompatibleReason,
    isCompatible,
} from './core';
import { ChartState, ChartStateShape } from './core/ChartState';
import type { ChartTypePlugin } from './interfaces/plugins/IChartTypePlugin';
import { ChartPane, Indicator } from './lib/types/indicator-types';
import SymbolSwitcher from './components/toolbar/SymbolSwitcher';
import { globalChartBus } from './core/GlobalChartBus';
import { FeaturesOptions, TimePrecision } from './core/DepthChart';
import { MAX, useCellBridges, useTradingBridge } from './hooks/useCellBridges';
import { LETTERS, PRESETS, LayoutPicker, type Preset } from './components/multi-chart/LayoutPicker';
import { DEFAULT_SYNC_IN_LAYOUT, type SyncInLayout } from './lib/types/layout-sync';
import { Dividers, resizeSizesAbsolute, toFr } from './components/multi-chart/GridDividers';
import { PluginFixedPanelHost } from './components/plugin-panels/PluginFixedPanelHost';
import { PluginToolbarHost } from './components/plugin-panels/PluginToolbarHost';
import { BottomBarPluginHost } from './components/plugin-panels/BottomBarPluginHost';
import { PluginWindowsDropdown } from './components/plugin-panels/PluginWindowsDropdown';
import { PluginManagerButton } from './components/plugins/plugin-manager-dialog';

// Exports
export { useTradingBridge, PRESETS };
export type { Preset };

export interface DepthProps {
    chart: DepthChart;
    eventBus: TypedEventBus;
    executionEngine: ExecutionEngine;
    transformer: LiveTransformer;
    hideToolbar: boolean;
    hideDrawingToolbar: boolean;
    hideBottomToolbar: boolean;
    hidePriceScale: boolean;
    hideTimeScale: boolean;
    hideStatusBar: boolean;
    hideLegend: boolean;
    prefetch: PrefetchOptions;
    state: ChartState;
    showDataStatusInBottomRightCorner: boolean;
    toolbar: React.ReactNode[];
    plugins: any[];
    features: FeaturesOptions;
    timePrecision: TimePrecision;
}

// Helpers
function getUtcOffset(tz: string, horizon: bigint): string {
    try {
        const date = new Date(Number(horizon / 1_000_000n));
        const parts = new Intl.DateTimeFormat('en', {
            timeZone: tz,
            timeZoneName: 'shortOffset',
        }).formatToParts(date);
        const off = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
        return off.replace('GMT', '') || 'UTC';
    } catch {
        return '';
    }
}

function setText(el: HTMLElement | null, str: string): void {
    if (!el) return;
    const first = el.firstChild;
    if (first && first.nodeType === 3 && el.childNodes.length === 1) {
        if (first.nodeValue !== str) first.nodeValue = str;
    } else {
        el.textContent = str;
    }
}

// Main component
export default function Depth({
    chart: _chart,
    eventBus: externalEventBus,
    executionEngine: externalExecutionEngine,
    transformer: externalTransformer,
    hideToolbar: _hideToolbar,
    hideDrawingToolbar: _hideDrawingToolbar,
    hideBottomToolbar: _hideBottomToolbar,
    hidePriceScale: _hidePriceScale,
    hideTimeScale: _hideTimeScale,
    hideStatusBar: _hideStatusBar,
    hideLegend: _hideLegend,
    prefetch: _prefetch,
    showDataStatusInBottomRightCorner,
    state: _state,
    toolbar,
    plugins,
    features,
    timePrecision,
}: DepthProps) {
    const eventBusRef = useRef(externalEventBus ?? new TypedEventBus());
    const eventBus = eventBusRef.current;

    useEffect(() => {
        return eventBus.on('error', ({ message }) => {
            toast.error(message);
        });
    }, [eventBus]);

    // The only place a data level refusal is said out loud. Every gate (plugin
    // install, indicator activation, chart type switch) ends up here, because a
    // silently missing indicator or a blank chart reads as a bug.
    useEffect(() => {
        return eventBus.on('plugin:incompatible', ({ id, name, kind, required, actual }) => {
            const what =
                kind === 'chart-type'
                    ? 'Chart type'
                    : kind === 'indicator'
                      ? 'Indicator'
                      : 'Plugin';
            toast.warning(`${what} "${name ?? id}" is unavailable here`, {
                description: incompatibleReason(required, actual),
            });
        });
    }, [eventBus]);

    // Initialize the grid from state (set by restore() before mount), so a restored
    // layout / divider sizes / focused pane come back; fall back to defaults.
    const [preset, setPreset] = useState<Preset>(() => _state.get('layout') as Preset);
    const presetRef = useRef(preset);
    useEffect(() => {
        presetRef.current = preset;
    }, [preset]);

    // Sync in layout
    // Which properties the cells share. Cells read this through their props (and
    // a ref, for handlers that outlive a render); the fan-out for symbol and
    // interval lives here, because only the layout knows what the other cells are.
    const [syncInLayout, setSyncInLayout] = useState<SyncInLayout>(
        () => _state.get('syncInLayout') ?? DEFAULT_SYNC_IN_LAYOUT,
    );
    const syncInLayoutRef = useRef(syncInLayout);
    useEffect(() => {
        syncInLayoutRef.current = syncInLayout;
        _state.set('syncInLayout', syncInLayout);
    }, [_state, syncInLayout]);
    const [focused, setFocused] = useState(() => {
        const f = _state.get('focusedPane') ?? 0;
        return f < _state.get('layout').count ? f : 0;
    });
    const [colSizes, setColSizes] = useState<number[]>(() => {
        const saved = _state.get('gridColSizes');
        const cols = _state.get('layout').cols;
        return saved && saved.length === cols ? saved : Array(cols).fill(1);
    });
    const [rowSizes, setRowSizes] = useState<number[]>(() => {
        const saved = _state.get('gridRowSizes');
        const rows = _state.get('layout').rows;
        return saved && saved.length === rows ? saved : Array(rows).fill(1);
    });

    // Sync grid view state back so serialize() captures it.
    useEffect(() => {
        _state.set('gridColSizes', colSizes);
    }, [_state, colSizes]);
    useEffect(() => {
        _state.set('gridRowSizes', rowSizes);
    }, [_state, rowSizes]);
    useEffect(() => {
        _state.set('focusedPane', focused);
    }, [_state, focused]);
    const gridRef = useRef<HTMLDivElement>(null);

    const [hasFixedPanels, setHasFixedPanels] = useState(false);
    const [showFixedWindowsSidebarOverride, setShowFixedWindowsSidebarOverride] = useState(true);

    const chartRefs = useRef<(ChartHandle | null)[]>(Array(MAX).fill(null));

    const [dataLevel, setDataLevel] = useState<DataLevel>('ohlcv');
    const dataLevelRef = useRef(dataLevel);
    dataLevelRef.current = dataLevel;

    const currentTimeRef = useRef<HTMLSpanElement>(null);
    const timeFormatterRef = useRef<Intl.DateTimeFormat | null>(null);
    const dateFormatterRef = useRef<Intl.DateTimeFormat | null>(null);
    const lastFormatterTzRef = useRef<string>('');

    const [everActive, setEverActive] = useState<boolean[]>(() => {
        const a = Array(MAX).fill(false);
        // Mount every cell active in the current layout (matches changePreset). On
        // restore the layout already has N panes, so cells 1..N-1 must mount too -
        // otherwise they render as blank placeholders.
        for (let i = 0; i < Math.max(1, _state.get('layout').count); i++) a[i] = true;
        return a;
    });

    // Shared toolbar state
    const [activeTimeframe, setActiveTimeframe] = useState<Timeframe>(_state.get('timeframe'));
    const [customTimeframes, setCustomTimeframes] = useState<Timeframe[]>(() =>
        loadCustomTimeframes(),
    );
    // The toolbar/dialog show and edit the FOCUSED pane's settings. This state is
    // a display mirror kept in sync with the focused pane's ChartModel (which
    // ChartInner mirrors its live settings into), re-tracking on focus change.
    const [chartSettings, setChartSettings] = useState<ChartSettings>(DEFAULT_CHART_SETTINGS);
    const [indicators, setIndicators] = useState<any[]>([]);
    const [activeTool, setActiveTool] = useState<ActiveDrawingTool>(CURSOR_TOOL);
    const [chartSettingsOpen, setChartSettingsOpen] = useState(false);

    // Track the focused pane's settings into the display mirror on focus change.
    // We deliberately do NOT subscribe to live model changes here: <Chart> is not
    // memoized, so re-rendering ChartOuter re-renders every pane, and settings
    // churn per-frame during axis drags. Toolbar edits update this optimistically;
    // pane-internal changes surface on the next focus switch (parity with before).
    useEffect(() => {
        setChartSettings(_chart.getChart(focused).settings as ChartSettings);
    }, [_chart, focused]);

    const panningChartRef = useRef<number | null>(null);

    // Plugin defs
    const [pluginChartTypeDefs, setPluginChartTypeDefs] = useState([]);
    const pluginChartTypeDefsRef = useRef(pluginChartTypeDefs);
    useEffect(() => {
        pluginChartTypeDefsRef.current = pluginChartTypeDefs;
    }, [pluginChartTypeDefs]);

    // the chart settings dialog gives whichever plugin chart type is active a
    // tab of its own, so it needs the plugin itself and not just its id
    const activePluginChartType: ChartTypePlugin | null =
        (pluginChartTypeDefs as ChartTypePlugin[]).find(
            (p) => p.chartTypeId === chartSettings.chartType,
        ) ?? null;

    const [pluginDrawingDefs, setPluginDrawingDefs] = useState([]);
    const pluginDrawingDefsRef = useRef(pluginDrawingDefs);
    useEffect(() => {
        pluginDrawingDefsRef.current = pluginDrawingDefs;
    }, [pluginDrawingDefs]);

    const [pluginIndicatorDefs, setPluginIndicatorDefs] = useState<
        Array<{ indicator: Indicator; pane: ChartPane; activeByDefault: boolean }>
    >([]);
    const pluginIndicatorDefsRef = useRef<typeof pluginIndicatorDefs>([]);
    const pendingPluginActivationsRef = useRef<Set<string>>(new Set());

    useEffect(() => {
        const existing = [..._chart.getRegisteredPlugins().values()];
        if (existing.length > 0) {
            pluginIndicatorDefsRef.current = existing;
            setPluginIndicatorDefs(existing);
        }
    }, []);

    useEffect(() => {
        pluginIndicatorDefsRef.current = pluginIndicatorDefs;
    }, [pluginIndicatorDefs]);

    // Per-cell symbol
    // Source of truth is now the per-pane ChartModel (chart.getChart(i)). cellSymbols
    // is a derived snapshot mirrored into React state via the model subscriptions
    // below, so every existing read (cellSymbols[i], the bridges, <Chart symbol>)
    // is unchanged while the model owns the value.
    const defaultSymbol = _state.get('symbol');
    const readCellSymbols = useCallback(
        () => Array.from({ length: MAX }, (_, i) => _chart.getChart(i).symbol),
        [_chart],
    );
    const [cellSymbols, setCellSymbols] = useState<string[]>(readCellSymbols);
    const cellSymbolsRef = useRef(cellSymbols);
    useEffect(() => {
        cellSymbolsRef.current = cellSymbols;
    }, [cellSymbols]);

    // Keep the snapshot in sync with the models. Models also notify on non-symbol
    // changes (e.g. settings), so only re-render when the symbols actually differ.
    useEffect(() => {
        const sync = () =>
            setCellSymbols((prev) => {
                const next = readCellSymbols();
                return next.length === prev.length && next.every((s, i) => s === prev[i])
                    ? prev
                    : next;
            });
        const unsubs = Array.from({ length: MAX }, (_, i) => _chart.getChart(i).subscribe(sync));
        sync();
        return () => unsubs.forEach((u) => u());
    }, [_chart, readCellSymbols]);

    const [, setFeaturesVersion] = useState(0);

    const setSymbolForCell = useCallback(
        (idx: number, symbol: string) => {
            _chart.getChart(idx).setSymbol(symbol);
        },
        [_chart],
    );

    // Trading bridges (one per symbol)
    // cellBridges is indexed by cell for convenience, but two cells on the same
    // instrument resolve to the SAME bridge - that shared engine is what nets
    // their trades and puts one set of position lines on both charts.
    //
    // Every bridge registers its book with ONE ExecutionEngine: the controller's,
    // which is also the engine plugins place orders through and the one the
    // DataEngine settles jump gaps against. Give each bridge a private wrapper
    // instead and those two are left holding an empty engine - silently, since
    // every call on it is a no-op that returns undefined.
    const execEngine = externalExecutionEngine ?? _chart.executionEngine;
    const { byCell: cellBridges, bySymbol: symbolBridges } = useCellBridges(
        cellSymbols,
        eventBus,
        _chart,
        execEngine,
    );

    // Calls that don't name an instrument (a plugin's placeOrder, say) go to the
    // chart the user is looking at.
    useEffect(() => {
        execEngine.setActiveSymbol(cellSymbols[focused] ?? '');
    }, [execEngine, cellSymbols, focused]);

    // Read by bus handlers and the playback tick, which are registered once and
    // would otherwise fan data into whichever bridges existed at mount.
    const symbolBridgesRef = useRef(symbolBridges);
    symbolBridgesRef.current = symbolBridges;
    const execEngineRef = useRef(execEngine);
    execEngineRef.current = execEngine;

    // The toolbar mirror has to refuse the same chart types the panes do, or it
    // sits there naming a type the pane never switched to. The refusal is said
    // here rather than in the pane, because a refusal caught here means the pane
    // is never asked.
    const chartTypeRefused = (id: string): boolean => {
        const plugin = pluginChartTypeDefsRef.current.find((p) => p.chartTypeId === id);
        if (!plugin) return false;
        const required = plugin.require ?? 'ohlcv';
        const actual = dataLevelRef.current;
        if (isCompatible(required, actual)) return false;
        eventBus.emit('plugin:incompatible', {
            id,
            name: plugin.label ?? plugin.name,
            kind: 'chart-type',
            required,
            actual,
        });
        return true;
    };

    const focusedBridge = cellBridges[focused] ?? cellBridges[0];

    const focusedBridgeRef = useRef(focusedBridge);
    useEffect(() => {
        focusedBridgeRef.current = focusedBridge;
    }, [focusedBridge]);

    // The adapter replaces the whole broker, so it goes on the one engine every
    // pane routes through - not on the focused pane's, which used to leave the
    // rest of the layout trading against the built-in simulator.
    useEffect(() => {
        return eventBus.on('execution:setAdapter', ({ adapter }) => {
            execEngine.setCustomAdapter(adapter);
        });
    }, [execEngine]);

    // Rehydrate newly-activated chart slots
    const everActiveRef = useRef<boolean[]>(Array(MAX).fill(false));
    useEffect(() => {
        everActive.forEach((active, i) => {
            if (active && !everActiveRef.current[i]) {
                everActiveRef.current[i] = true;
                requestAnimationFrame(() => {
                    eventBus.emit('data:rehydrate', undefined);
                });
            }
        });
    }, [everActive]);

    // Active grid letters
    const activeLetters = useMemo(() => {
        const seen = new Set<string>();
        for (const ch of preset.areas.replace(/"/g, '')) if (ch >= 'a' && ch <= 'h') seen.add(ch);
        return [...seen].sort();
    }, [preset]);

    // Sync in layout: fan-out
    // Symbol and interval are per-cell, so "synced" means: whichever cell the
    // user changed tells the layout, and the layout hands the change to the
    // others. Followers are marked as such and never announce it back, so one
    // user action produces exactly one round of updates.

    /** Cell indices currently on screen. */
    const activeCellIndices = useCallback(() => {
        const count = Math.max(1, presetRef.current.count);
        return Array.from({ length: Math.min(count, MAX) }, (_, i) => i);
    }, []);

    /** Guards the fan-out against re-entering itself through its own events. */
    const fanningOutRef = useRef(false);

    const fanOutSymbol = useCallback(
        (symbol: string, sourceId: number) => {
            if (fanningOutRef.current) return;
            fanningOutRef.current = true;
            try {
                for (const i of activeCellIndices()) {
                    if (i === sourceId) continue;
                    if (cellSymbolsRef.current[i] === symbol) continue;
                    eventBus.emit('chart:set-symbol', { symbol, id: i });
                }
            } finally {
                fanningOutRef.current = false;
            }
        },
        [activeCellIndices, eventBus],
    );

    const fanOutTimeframe = useCallback(
        (tf: Timeframe, sourceId: number) => {
            if (fanningOutRef.current) return;
            fanningOutRef.current = true;
            try {
                for (const i of activeCellIndices()) {
                    if (i === sourceId) continue;
                    chartRefs.current[i]?.handleTimeframeChange(tf, true);
                }
            } finally {
                fanningOutRef.current = false;
            }
        },
        [activeCellIndices],
    );

    /**
     * Flip a sync switch. Turning one ON conforms the layout to the focused cell
     * straight away - waiting for the next symbol change / scroll to line the
     * charts up would leave the switch looking like it did nothing.
     */
    const changeSyncInLayout = useCallback(
        (next: SyncInLayout) => {
            const prev = syncInLayoutRef.current;
            // Handlers read the ref, and the fan-outs below fire before React has
            // re-rendered, so update it here rather than waiting for the effect.
            syncInLayoutRef.current = next;
            setSyncInLayout(next);

            const focusedId = focusedRef.current;

            if (next.symbol && !prev.symbol) {
                const symbol = cellSymbolsRef.current[focusedId];
                if (symbol) fanOutSymbol(symbol, focusedId);
            }
            if (next.interval && !prev.interval) {
                const tf = chartRefs.current[focusedId]?.getActiveTimeframe();
                if (tf) fanOutTimeframe(tf, focusedId);
            }
            if ((next.time && !prev.time) || (next.dateRange && !prev.dateRange)) {
                const range = chartRefs.current[focusedId]?.getVisibleRange();
                if (range) eventBus.emit('layout:time-range', { id: focusedId, ...range });
            }
        },
        [eventBus, fanOutSymbol, fanOutTimeframe],
    );

    const callFocused = useCallback(
        (method: keyof ChartHandle, ...args: any[]) => {
            const h = chartRefs.current[focused];
            if (h && typeof h[method] === 'function') (h[method] as Function)(...args);
        },
        [focused],
    );

    const handleRequestMore = useCallback(
        (spanNs?: bigint) => {
            eventBus.emit('data:prefetch', { spanNs });
        },
        [eventBus],
    );

    /**
     * Feed a data payload to the matching engine for its instrument.
     *
     * Ingested once per payload, into the book for the symbol the payload names.
     * The old code ran this per cell showing that symbol, which was only
     * harmless while every cell owned a private engine; against a shared one it
     * would replay the same bars through the fill logic once per pane. Naming
     * the symbol matters just as much - the shared engine's default target is
     * the focused pane's instrument, and a background symbol's bars must not
     * land there.
     *
     * `mode` is the difference between "here is the dataset" and "here is more
     * of it". Only the OHLCV path distinguishes them: its append carries just
     * the new chunk, and ingesting a chunk through the reset path would throw
     * away the history behind it. The other levels always ship the full master.
     */
    const ingestForExecution = useCallback(
        (
            payload: ChartEvents['data:load'] | ChartEvents['data:append'],
            mode: 'load' | 'append',
        ) => {
            const eng = execEngineRef.current;
            const sym = payload.symbol;
            if (!symbolBridgesRef.current.some((b) => b.symbol === sym)) return;

            switch (payload.dataLevel) {
                case 'l3': {
                    const buf = (payload.compactBuf as ArrayBuffer).slice(0);
                    if (mode === 'append') eng.appendCompactBuf(buf, sym);
                    else eng.ingestCompactBuf(buf, sym);
                    break;
                }
                case 'ohlcv': {
                    // barNs lets the engine tell a completed bar from the forming
                    // one, so it never settles against the part of the current bar
                    // that is still in the future.
                    const bars = payload.ohlcvBars ?? [];
                    if (mode === 'append') eng.appendOhlcvBars(bars, payload.barNs, sym);
                    else eng.ingestOhlcvBars(bars, payload.barNs, sym);

                    const suppSets = (payload as any).supplemental as
                        | Array<{
                              resolution: bigint;
                              bars: Array<{
                                  time: number;
                                  open: number;
                                  high: number;
                                  low: number;
                                  close: number;
                                  volume: number;
                              }>;
                          }>
                        | null
                        | undefined;
                    if (suppSets?.length) {
                        const finest = suppSets.reduce((f, s) =>
                            !f || s.resolution < f.resolution ? s : f,
                        );
                        if (finest.bars.length) {
                            // Sub-bars come as the whole master set either way, but
                            // an append must not rewind the sub-bar cursor - that
                            // is what re-walks the forming bar every extension.
                            if (mode === 'append') eng.appendSupplementalBars(finest.bars, sym);
                            else eng.ingestSupplementalBars(finest.bars, sym);
                        }
                    }
                    break;
                }
                case 'tick':
                    if (mode === 'append') eng.appendTicks(payload.trades ?? [], sym);
                    else eng.ingestTicks(payload.trades ?? [], sym);
                    break;
                case 'l2':
                    if (mode === 'append') eng.appendPriceHistory(payload.priceHistory ?? [], sym);
                    else eng.ingestPriceHistory(payload.priceHistory ?? [], sym);
                    break;
            }

            // Walk a book that has never been priced up to the playhead.
            //
            // A book only gets a price by being seeked through its data, and the
            // only thing that seeks is a playback tick - so between mount and the
            // first tick the engine held a full dataset and no price at all.
            // Anything trading in that window (a hotkey, a plugin, a restored
            // bracket) was asking a book that had never been told what time it is.
            //
            // Keyed on the book having no price rather than on `mode`, because a
            // pane that mounts onto an already-loaded symbol gets its window as a
            // rehydrate *append*, and the engine behind it may be a fresh one
            // (useCellBridges rebuilds a book when its symbolInfo resolves). A
            // book already at the playhead is skipped, so nothing gets replayed.
            if (!eng.hasPrice(sym)) {
                const tNs = playheadRef.current || sharedHorizonRef.current;
                if (tNs > 0n) eng.seekTo(tNs, sym);
            }
        },
        [],
    );

    // Playback
    // Seeded from the chart's horizon rather than left at 0n until the first
    // data:bounds: it is the playhead every book is seeded to above, and the
    // chart mounts at its horizon, not at the start of the dataset.
    const sharedHorizonRef = useRef<bigint>(BigInt(Math.round(_chart.horizon())) * 1_000_000n);
    const playheadRef = useRef<bigint>(BigInt(Math.round(_chart.horizon())) * 1_000_000n);

    const handlePlaybackTick = useCallback(
        (tNs: bigint) => {
            playheadRef.current = tNs;
            // One call, every book. Symbol-less on purpose: the playhead moves
            // for all instruments at once, including those whose pane isn't
            // focused (or isn't on screen) but whose stop still has to trigger.
            execEngineRef.current.seekTo(tNs);

            const tz = chartSettings.timezone ?? 'UTC';
            if (!timeFormatterRef.current || lastFormatterTzRef.current !== tz) {
                timeFormatterRef.current = new Intl.DateTimeFormat('sv-SE', {
                    timeZone: tz,
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: false,
                });
                lastFormatterTzRef.current = tz;
            }
            const millis = Number(tNs / 1_000_000n);
            const micros = Math.floor(Number((tNs / 1_000n) % 1_000_000n) / 1000);
            const msStr = micros < 10 ? '00' + micros : micros < 100 ? '0' + micros : '' + micros;
            setText(
                currentTimeRef.current,
                timePrecision === 'ms'
                    ? timeFormatterRef.current.format(millis) + '.' + msStr
                    : timeFormatterRef.current.format(millis),
            );

            eventBus.emit('playback:seek', { tNs });
        },
        [chartSettings],
    );

    const pb = usePlaybackEngine({
        chartRefs,
        sharedHorizonRef,
        onRequestMore: handleRequestMore,
        onTick: handlePlaybackTick,
        eventBus,
        prefetch: _prefetch,
        clockSymbol: () => cellSymbolsRef.current[focusedRef.current],
    });

    useEffect(() => {
        return eventBus.on('data:bounds', ({ start, end, symbol }) => {
            // One bus, many panes. The playback clock follows the focused pane,
            // so only that pane's symbol may gate it - another instrument's edges
            // would stall the clock behind data nobody is watching, and right
            // after a jump they're the *pre-jump* edges, which reads as "the
            // playhead is miles past the end" and sends the engine re-seeking on
            // every frame. (Undefined symbol = chart-wide, take it.)
            if (symbol !== undefined && symbol !== cellSymbolsRef.current[focusedRef.current])
                return;
            pb.notifyDataBounds(start, end);
        });
    }, []);

    // Event bus handlers
    useEffect(() => {
        const unsubs = [
            eventBus.on('plugin:register-indicator', ({ indicator, pane, activeByDefault }) => {
                const existingIdx = pluginIndicatorDefsRef.current.findIndex(
                    (d) => d.indicator.id === indicator.id,
                );

                if (existingIdx !== -1) {
                    pluginIndicatorDefsRef.current = pluginIndicatorDefsRef.current.map((d, i) =>
                        i === existingIdx ? { indicator, pane, activeByDefault } : d,
                    );
                    setPluginIndicatorDefs(pluginIndicatorDefsRef.current);
                    for (let i = 0; i < chartRefs.current.length; i++) {
                        chartRefs.current[i]?.replacePluginIndicator(indicator);
                    }
                    return;
                }

                if (pluginIndicatorDefsRef.current.some((d) => d.indicator.id === indicator.id))
                    return;

                pluginIndicatorDefsRef.current = [
                    ...pluginIndicatorDefsRef.current,
                    { indicator, pane, activeByDefault },
                ];
                setPluginIndicatorDefs(pluginIndicatorDefsRef.current);

                const basePluginId = indicator.id.replace(/:(\d+)$/, '');
                const isPending = pendingPluginActivationsRef.current.has(basePluginId);
                if (activeByDefault || isPending) {
                    if (isPending) pendingPluginActivationsRef.current.delete(basePluginId);
                    for (let i = 0; i < chartRefs.current.length; i++) {
                        chartRefs.current[i]?.activatePluginIndicator(indicator, pane);
                    }
                }
            }),
            eventBus.on('chart:add-plugin-indicator', ({ pluginId }) => {
                const def = pluginIndicatorDefsRef.current.find(
                    (d) => d.indicator.id === pluginId || d.indicator.id.startsWith(`${pluginId}:`),
                );
                if (!def) {
                    pendingPluginActivationsRef.current.add(pluginId);
                    return;
                }
                for (let i = 0; i < chartRefs.current.length; i++) {
                    chartRefs.current[i]?.activatePluginIndicator(def.indicator, def.pane);
                }
            }),
            eventBus.on('plugin:uninstalled', ({ id }) => {
                // Drop the torn-down plugin's defs, or the Indicators dropdown
                // keeps offering an indicator backed by a dead worker. A later
                // re-install re-registers under the same id.
                pendingPluginActivationsRef.current.delete(id);
                const next = pluginIndicatorDefsRef.current.filter(
                    (d) => d.indicator.id !== id && !d.indicator.id.startsWith(`${id}:`),
                );
                if (next.length === pluginIndicatorDefsRef.current.length) return;
                pluginIndicatorDefsRef.current = next;
                setPluginIndicatorDefs(next);
            }),
            eventBus.on('plugin:register-chart-type', ({ plugin }) => {
                // a hot reload re-registers under the same id, and the old
                // object is a dead capability by then - replace, dont skip
                pluginChartTypeDefsRef.current = [
                    ...pluginChartTypeDefsRef.current.filter((c) => c.id !== plugin.id),
                    plugin,
                ];
                setPluginChartTypeDefs(pluginChartTypeDefsRef.current);
                // a saved chart is restored long before its plugins finish
                // installing, so hand back anything already stored under this id
                const saved = (_chart.getChart(focusedRef.current).settings as ChartSettings)
                    .pluginSettings?.[plugin.chartTypeId];
                if (saved) plugin.onSettingsChange?.(saved);
            }),
            eventBus.on('plugin:unregister-chart-type', ({ id, hotReload }) => {
                // on a hot reload the register right behind this one replaces it
                if (hotReload) return;
                pluginChartTypeDefsRef.current = pluginChartTypeDefsRef.current.filter(
                    (c) => c.chartTypeId !== id,
                );
                setPluginChartTypeDefs(pluginChartTypeDefsRef.current);
            }),
            eventBus.on('plugin:register-drawing', (payload) => {
                const { id, name, icon } = payload;
                if (pluginDrawingDefsRef.current.some((c) => c.id === id)) return;
                pluginDrawingDefsRef.current = [
                    ...pluginDrawingDefsRef.current,
                    { id, name, icon },
                ];
                setPluginDrawingDefs(pluginDrawingDefsRef.current);
            }),
            eventBus.on('plugin:unregister-drawing', (payload) => {
                const { id } = payload;
                if (!pluginDrawingDefsRef.current.some(c => c.id.includes(id))) return;
                pluginDrawingDefsRef.current = pluginDrawingDefsRef.current.filter(c => !c.id.includes(id));
                setPluginDrawingDefs(pluginDrawingDefsRef.current);
            }),
            eventBus.on('trading:buy-market', ({ amount }) => {
                focusedBridgeRef.current?.executionEngine?.placeOrder({
                    qty: amount,
                    side: 'long',
                    type: 'market',
                    symbol: focusedBridgeRef.current.symbol,
                });
            }),
            eventBus.on('trading:sell-market', ({ amount }) => {
                focusedBridgeRef.current?.executionEngine?.placeOrder({
                    qty: amount,
                    side: 'short',
                    type: 'market',
                    symbol: focusedBridgeRef.current.symbol,
                });
            }),
            // Flatten is account-wide, unlike buy/sell above: "get me out" means
            // out of everything, not out of whatever pane happens to be focused.
            // Snapshot each bridge's positions first - closing one deletes it
            // from the very map being walked.
            eventBus.on('trading:flatten', () => {
                for (const bridge of symbolBridgesRef.current) {
                    if (!bridge?.symbol) continue;
                    for (const position of [...bridge.trading.positions.values()]) {
                        if (position.remainingQuantity <= 0) continue;
                        bridge.executionEngine?.closePosition(position.id);
                    }
                }
            }),
            eventBus.on('chart:set-timeframe', ({ tf }) => {
                setActiveTimeframe(tf);
                // Timeframe is per-pane: apply to the focused ChartInner only. Its
                // indicator sub-panes share it (handleTimeframeChange re-aggregates
                // the whole pane); other ChartInner cells keep their own timeframe.
                // With interval sync on, that pane's own layout:timeframe fans the
                // change out to the rest.
                chartRefs.current[focusedRef.current]?.handleTimeframeChange(tf);
            }),
            // A pane changed its timeframe - through the selector above, the API,
            // or by typing one straight onto the chart.
            eventBus.on('layout:timeframe', ({ id, tf }) => {
                if (id === focusedRef.current) {
                    setActiveTimeframe(tf);
                    // Mirror into shared state, silently. `_state.set` short-circuits
                    // on an unchanged value, so leaving it stale makes the toolbar
                    // refuse to switch *to* whatever it still believes is current -
                    // and DataEngine reads this same field to size its fetches.
                    // No eventBus: the pane is already on `tf`, and re-emitting
                    // would bounce straight back into it.
                    _state.set('timeframe', tf);
                }
                if (syncInLayoutRef.current.interval) fanOutTimeframe(tf, id);
            }),
            eventBus.on('chart:apply-settings', ({ patch }) => {
                if (patch.chartType && chartTypeRefused(patch.chartType)) {
                    const { chartType: _refused, ...rest } = patch;
                    patch = rest;
                }
                setChartSettings((prev) => ({ ...prev, ...patch }));
                chartRefs.current[focusedRef.current]?.applySettings(patch);
            }),
            eventBus.on('chart:set-symbol', ({ symbol, id }) => {
                setSymbolForCell(id, symbol);
                // Covers every route a symbol can change by - toolbar, watchlist,
                // API - except the mount-time restore pass, which sets each pane's
                // own saved symbol and must not make them all agree.
                if (syncInLayoutRef.current.symbol && !restoringSymbolsRef.current) {
                    fanOutSymbol(symbol, id);
                }
            }),
            // `features` is mutated in place by chart.allowTimeframes, so nothing
            // re-renders on its own. Bump a counter to re-read it, or a timeframe
            // that just became available would keep its lock icon until something
            // else happened to re-render.
            eventBus.on('features:change', () => setFeaturesVersion((v) => v + 1)),
            eventBus.on('chart:set-symbol-focused', ({ symbol }) => {
                eventBus.emit('chart:set-symbol', { symbol, id: focusedRef.current });
            }),
            eventBus.on('data:load', (payload) => {
                setDataLevel(payload.dataLevel);
                // A rehydrate is the same window handed over again (a pane
                // mounting, or moving onto a symbol another pane already has).
                // Treated as a load it would rewind the engine to the start of
                // that window and re-settle every bar in it, which can fill a
                // live working order somewhere back in the past.
                ingestForExecution(payload, payload.rehydrate ? 'append' : 'load');
            }),
            // Bars streamed in ahead of the playhead. These have to reach the
            // engine too: it fills from the bars it holds, so without this it
            // goes blind the moment the playhead leaves the initially loaded
            // window - stops don't trigger, limits don't fill, and the mark
            // price sticks at the old edge. Which branch a goto happens to take
            // (jump-load vs stream-append) is what decided whether fills worked.
            eventBus.on('data:append', (payload) => ingestForExecution(payload, 'append')),
            eventBus.on('playback:play', () => pb.play()),
            eventBus.on('playback:pause', () => pb.pause()),
            eventBus.on('playback:set-speed', (payload) => pb.setSpeed(payload.speed)),
            eventBus.on('playback:set-step-size', (payload) => pb.setStepSize(payload.step)),
            // The controller already refuses these, but the bus is public: a
            // plugin emitting the command directly has to hit the same wall.
            eventBus.on('playback:step-back', () => {
                if (_chart.playback.floor === null) pb.stepBack();
            }),
            eventBus.on('playback:step-forward', () => pb.stepForward()),
            eventBus.on('playback:goto', ({ tNs }) => {
                if (_chart.playback.allows(tNs)) pb.scrub(tNs);
            }),
            eventBus.on('playback:set-mode', (payload) => pb.setMode(payload.mode)),
            eventBus.on('playback:set-step-snap', (payload) => pb.setStepSnap(payload.snap)),
        ];

        return () => unsubs.forEach((fn) => fn());
    }, [eventBus]);

    useEffect(() => {
        eventBus.emit('chart:focused', { id: focused });
    }, [focused]);

    // Timezone display
    const tzRef = useRef<HTMLSpanElement | null>(null);
    const prevTzRef = useRef(null);
    useEffect(() => {
        if (!tzRef.current) return;
        const utcOffset = getUtcOffset(chartSettings.timezone, sharedHorizonRef.current);
        const str = utcOffset === 'UTC' ? utcOffset : 'UTC' + utcOffset;
        if (prevTzRef.current === str) return;
        prevTzRef.current = str;
        tzRef.current.textContent = str;

        const tz = chartSettings.timezone ?? 'UTC';
        if (!timeFormatterRef.current || lastFormatterTzRef.current !== tz) {
            timeFormatterRef.current = new Intl.DateTimeFormat('sv-SE', {
                timeZone: tz,
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false,
            });
            lastFormatterTzRef.current = tz;
        }
        const millis = Number(playheadRef.current / 1_000_000n);
        const micros = Math.floor(Number((playheadRef.current / 1_000n) % 1_000_000n) / 1000);
        const msStr = micros < 10 ? '00' + micros : micros < 100 ? '0' + micros : '' + micros;
        if (timePrecision === 'ms') {
            setText(
                currentTimeRef.current,
                timePrecision === 'ms'
                    ? timeFormatterRef.current.format(millis) + '.' + msStr
                    : timeFormatterRef.current.format(millis),
            );
        } else {
            currentTimeRef.current.textContent = timeFormatterRef.current.format(millis);
        }
    }, [chartSettings]);

    // Focused chart ref + toolbar sync
    const focusedRef = useRef(focused);
    useEffect(() => {
        focusedRef.current = focused;
    }, [focused]);

    const everActiveRef2 = useRef(everActive);
    useEffect(() => {
        everActiveRef2.current = everActive;
    }, [everActive]);

    // On mount, ensure each active pane's symbol is loaded. The single DataEngine
    // loads a symbol when it sees chart:set-symbol; on restore the pane symbols are
    // set on the models (no selector event fires), so without this only cell 0's
    // symbol ever loads and the other panes stay dataless. Distinct symbols only;
    // the focused pane's symbol goes last so it stays the active (paginating) one.
    // A no-op in the common case where every pane shares the initial symbol.
    const restoringSymbolsRef = useRef(false);
    useEffect(() => {
        const raf = requestAnimationFrame(() => {
            const count = Math.max(1, _state.get('layout').count);
            const order: number[] = [];
            for (let i = 0; i < count; i++) if (i !== focusedRef.current) order.push(i);
            order.push(focusedRef.current);
            const seen = new Set<string>();
            restoringSymbolsRef.current = true;
            try {
                for (const i of order) {
                    const sym = _chart.getChart(i).symbol;
                    if (!sym || seen.has(sym)) continue;
                    seen.add(sym);
                    eventBus.emit('chart:set-symbol', { symbol: sym, id: i });
                }
            } finally {
                restoringSymbolsRef.current = false;
            }
        });
        return () => cancelAnimationFrame(raf);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Reconstruct each pane's saved indicators (model.plugins) from the registered
    // plugin defs. Runs as defs register (async) and as panes mount; idempotent -
    // it skips indicators already active, so it's a no-op in normal use and only
    // does work on restore. Settings/visibility/placement come from the saved ref.
    const reconcilePaneIndicators = useCallback(() => {
        const count = Math.max(1, _state.get('layout').count);
        for (let i = 0; i < count; i++) {
            const handle = chartRefs.current[i];
            if (!handle?.activatePluginIndicator || !handle.getIndicators) continue;
            const model = _chart.getChart(i);
            const refs = model.restoredPlugins;
            if (!refs.length) continue;
            const active = new Set((handle.getIndicators() ?? []).map((ind: Indicator) => ind.id));
            for (const ref of refs) {
                // The indicator's instance id IS the registered def's id (scripted
                // indicators are keyed `${pluginId}:${index}`, e.g. "verse:0").
                // ref.id is just the pool plugin id ("verse") and must NOT be used here.
                const def = pluginIndicatorDefsRef.current.find(
                    (d) => d.indicator.id === ref.instanceId,
                );
                if (!def) continue; // def not registered yet - retried when it is
                if (!active.has(ref.instanceId)) {
                    const cfg = (ref.config ?? {}) as {
                        settings?: unknown;
                        visible?: boolean;
                        layout?: Indicator['layout'];
                        paneId?: string;
                    };
                    const instance: Indicator = {
                        ...def.indicator,
                        id: ref.instanceId,
                        settings: cfg.settings ?? def.indicator.settings,
                        visible: cfg.visible ?? true,
                        layout: cfg.layout ?? def.indicator.layout,
                        paneId: cfg.paneId ?? def.indicator.paneId,
                    };
                    handle.activatePluginIndicator(instance, def.pane);
                }
                // Reconstructed (or already present) - consume so a later removal
                // by the user isn't undone by a subsequent reconcile pass.
                model.consumeRestoredPlugin(ref.instanceId);
            }
        }
    }, [_chart, _state]);

    useEffect(() => {
        reconcilePaneIndicators();
    }, [pluginIndicatorDefs, everActive, reconcilePaneIndicators]);

    const syncRafRef = useRef<number>(0);
    const lastToolbarSyncRef = useRef(0);
    const containerRef = useRef<HTMLDivElement | null>(null);

    const syncToolbarFromFocused = () => {
        const h = chartRefs.current[focusedRef.current];
        if (!h) return;
        const tf = h.getActiveTimeframe?.();
        if (tf) {
            setActiveTimeframe(tf);
            // The catch-all for the same invariant. A restored pane mounts on its
            // saved timeframe without ever announcing it, so on refresh this is
            // the only thing that tells shared state the chart is not on the
            // constructor's default.
            _state.set('timeframe', tf);
        }
        const inds = h.getIndicators?.();
        const tool = h.getActiveTool?.();
        if (tool !== undefined) setActiveTool(tool);
        if (inds)
            setIndicators((prev) => {
                if (
                    prev.length === inds.length &&
                    prev.every((p, i) => p.id === inds[i]?.id && p.visible === inds[i]?.visible)
                )
                    return prev;
                return [...inds];
            });
        const settings = h.getChartSettings?.();
        if (settings) {
            setChartSettings((prev) => {
                if (JSON.stringify(prev) === JSON.stringify(settings)) return prev;
                return settings;
            });
        }
    };

    useEffect(() => {
        const loop = () => {
            const focusedIdx = focusedRef.current;
            const focusedChart = chartRefs.current[focusedIdx];

            if (focusedChart) {
                const newHorizon = focusedChart.getHorizon?.() ?? 0n;

                if (newHorizon > 0n && newHorizon !== sharedHorizonRef.current) {
                    sharedHorizonRef.current = newHorizon;
                    // The pane moved the playhead on its own - a jump-load landing
                    // on its target, or the initial load. Playback's own ticks have
                    // already announced themselves (driveAllCharts syncs the shared
                    // ref before onTick, so this branch doesn't double-emit), but
                    // nothing else tells the outside world the playhead moved.
                    eventBus.emit('playback:seek', { tNs: newHorizon });
                    if (currentTimeRef.current && newHorizon > 0n) {
                        const tz = chartSettings.timezone ?? 'UTC';
                        if (
                            !timeFormatterRef.current ||
                            !dateFormatterRef.current ||
                            lastFormatterTzRef.current !== tz
                        ) {
                            dateFormatterRef.current = new Intl.DateTimeFormat('sv-SE', {
                                timeZone: tz,
                                year: 'numeric',
                                month: '2-digit',
                                day: '2-digit',
                            });
                            timeFormatterRef.current = new Intl.DateTimeFormat('sv-SE', {
                                timeZone: tz,
                                hour: '2-digit',
                                minute: '2-digit',
                                second: '2-digit',
                                hour12: false,
                            });
                            lastFormatterTzRef.current = tz;
                        }
                        const millis = Number(newHorizon / 1_000_000n);
                        const micros = Math.floor(
                            Number((newHorizon / 1_000n) % 1_000_000n) / 1000,
                        );
                        const msStr =
                            micros < 10 ? '00' + micros : micros < 100 ? '0' + micros : '' + micros;
                        setText(
                            currentTimeRef.current,
                            timePrecision === 'ms'
                                ? timeFormatterRef.current.format(millis) + '.' + msStr
                                : timeFormatterRef.current.format(millis),
                        );
                    }

                    if (panningChartRef.current === null) {
                        const ea = everActiveRef2.current;
                        chartRefs.current.forEach((h, i) => {
                            if (i === focusedIdx || !h || !ea[i]) return;
                            h.seekHorizon(newHorizon);
                        });
                    }
                }

                const now = performance.now();
                if (now - lastToolbarSyncRef.current >= 200) {
                    lastToolbarSyncRef.current = now;
                    syncToolbarFromFocused();
                }
            }

            syncRafRef.current = requestAnimationFrame(loop);
        };

        syncRafRef.current = requestAnimationFrame(loop);
        return () => cancelAnimationFrame(syncRafRef.current);
    }, []);

    useEffect(() => {
        focusedRef.current = focused;
        syncToolbarFromFocused();
        const h = chartRefs.current[focused];
        if (h && sharedHorizonRef.current > 0n) {
            h.seekHorizon(sharedHorizonRef.current);
        }
        // The clock now follows this pane, and data:bounds only reaches it from
        // this pane's symbol - so hand over the new pane's edges directly rather
        // than running on the old symbol's until something happens to reload.
        const bounds = h?.getDataBounds?.();
        if (bounds && bounds.end > 0n) pb.notifyDataBounds(bounds.start, bounds.end);
    }, [focused]);

    const [, forceUpdate] = useState(0);
    useEffect(() => {
        const onUp = () => {
            if (panningChartRef.current !== null) {
                panningChartRef.current = null;
                forceUpdate((n) => n + 1);
            }
        };
        window.addEventListener('mouseup', onUp);
        return () => window.removeEventListener('mouseup', onUp);
    }, []);

    // Layout / grid
    const changePreset = useCallback((p: Preset) => {
        eventBus.emit('chart:change-layout', { preset: p });
        _state.set('layout', p);
        setPreset(p);
        setColSizes(Array(p.cols).fill(1));
        setRowSizes(Array(p.rows).fill(1));
        setFocused((f) => (f < p.count ? f : 0));
        setEverActive((prev) => {
            const next = [...prev];
            for (let i = 0; i < p.count; i++) next[i] = true;
            return next;
        });
    }, []);

    const colDrag = useCallback((i: number, targetPx: number) => {
        const el = gridRef.current;
        if (!el) return;
        setColSizes((s) => resizeSizesAbsolute(s, i, targetPx, el.clientWidth));
    }, []);

    const rowDrag = useCallback((i: number, targetPx: number) => {
        const el = gridRef.current;
        if (!el) return;
        setRowSizes((s) => resizeSizesAbsolute(s, i, targetPx, el.clientHeight));
    }, []);

    const handleSetStatePatch = (key: keyof ChartStateShape, value: any) => {
        _state.set(key, value);
        if (key === 'selectedDrawingId') {
            eventBus.emit('drawing:selected', { id: (value as string | null) ?? null });
        }
    };

    // Render
    return (
        // Root-level provider: the toolbars below have their own, but the
        // drawing toolbar, chart grid and ChartInner render Tooltips too, and
        // Radix throws without an ancestor provider. Consuming apps must not be
        // required to supply one.
        <TooltipProvider delayDuration={400}>
            <div
                className="depth-root w-full h-full flex flex-col bg-background text-foreground overflow-hidden outline-none min-h-[340px]"
                ref={containerRef}
                tabIndex={0}
            >
                {!_hideToolbar && (
                    <TooltipProvider delayDuration={400}>
                        <div className="flex items-center h-9 px-2 border-b shrink-0 gap-0.5">
                            {/*111d30*/}
                            <div className="absolute left-0 top-0 w-[15rem] h-[2.2rem] bg-gradient-to-r from-[#0286f9]/10 to-background" />
                            <SymbolSwitcher
                                eventBus={eventBus}
                                symbol={cellSymbols[focused] ?? defaultSymbol}
                                onSymbolChange={(symbol) => {
                                    setSymbolForCell(focused, symbol);
                                    eventBus.emit('chart:set-symbol', { symbol, id: focused });
                                }}
                            />
                            <div className="w-px h-4 bg-border mx-1" />
                            <TimeframeSelector
                                eventBus={eventBus}
                                value={activeTimeframe}
                                customTimeframes={customTimeframes}
                                features={features}
                                onChange={(tf) => {
                                    setActiveTimeframe(tf);
                                    _state.set('timeframe', tf, eventBus);
                                }}
                                onAddCustom={(tf) => {
                                    setCustomTimeframes((prev) => {
                                        const next = [...prev, tf];
                                        saveCustomTimeframes(next);
                                        return next;
                                    });
                                }}
                                onRemoveCustom={(label) => {
                                    setCustomTimeframes((prev) => {
                                        const next = prev.filter((t) => t.label !== label);
                                        saveCustomTimeframes(next);
                                        return next;
                                    });
                                }}
                            />
                            <div className="w-px h-4 bg-border mx-1" />
                            <ChartTypeSelector
                                value={chartSettings.chartType}
                                pluginChartTypes={pluginChartTypeDefs}
                                dataLevel={dataLevel}
                                onChange={(t) => {
                                    if (chartTypeRefused(t)) return;
                                    eventBus.emit('chart:set-type', {
                                        old: chartSettings.chartType,
                                        new: t,
                                    });
                                    setChartSettings((p) => ({ ...p, chartType: t }));
                                    callFocused('applySettings', { chartType: t });
                                }}
                            />

                            <Separator orientation="vertical" className="h-4 mx-1" />

                            <IndicatorsButton
                                indicators={indicators}
                                dataLevel={dataLevel}
                                pluginIndicators={pluginIndicatorDefs}
                                onActivatePlugin={(def) =>
                                    callFocused('activatePluginIndicator', def.indicator, def.pane)
                                }
                                onAdd={(id) => callFocused('handleAddIndicator', id)}
                                onToggle={(id) => callFocused('handleToggleIndicator', id)}
                                onRemove={(id) => callFocused('handleRemoveIndicator', id)}
                            />

                            {toolbar?.map((element, i) => (
                                <React.Fragment key={i}>{element}</React.Fragment>
                            ))}
                            <PluginToolbarHost eventBus={eventBus} chart={_chart} />

                            <div className="flex-1" />
                            <div className="flex items-center gap-3">
                                <LayoutPicker
                                    current={preset}
                                    onChange={changePreset}
                                    syncInLayout={syncInLayout}
                                    setSyncInLayout={changeSyncInLayout}
                                />
                                <PluginManagerButton eventBus={eventBus} chart={_chart} />
                                <PluginWindowsDropdown eventBus={eventBus} chart={_chart} />
                                <Tooltip delayDuration={700}>
                                    <TooltipTrigger asChild>
                                        <Button
                                            onClick={() =>
                                                setShowFixedWindowsSidebarOverride((prev) => !prev)
                                            }
                                            variant="outline"
                                            className="h-8 w-8 border-none text-muted-foreground hover:text-white hover:bg-muted"
                                        >
                                            {showFixedWindowsSidebarOverride ? (
                                                <PanelLeftClose className="w-4" />
                                            ) : (
                                                <PanelLeftOpen className="w-4" />
                                            )}
                                        </Button>
                                    </TooltipTrigger>
                                    <TooltipContent className="bg-background border border-border">
                                        {showFixedWindowsSidebarOverride ? 'Show' : 'Hide'} fixed
                                        panels
                                    </TooltipContent>
                                </Tooltip>
                            </div>
                        </div>
                    </TooltipProvider>
                )}

                {/* Body: drawing toolbar + chart grid + plugin sidebar */}
                <div className="flex flex-1 min-h-0">
                    <div className="flex flex-row flex-1 min-h-0">
                        {!_hideDrawingToolbar && (
                            <DrawingToolbar
                                activeTool={activeTool.name}
                                onToolChange={(t) => {
                                    const next = t === 'cursor' ? CURSOR_TOOL : armTool(t);
                                    setActiveTool(next);
                                    chartRefs.current.forEach((h) => h?.setActiveTool(next));
                                }}
                                pluginDrawings={pluginDrawingDefs}
                            />
                        )}
                        <div
                            ref={gridRef}
                            style={{
                                flex: 1,
                                display: 'grid',
                                gridTemplateColumns: toFr(colSizes),
                                gridTemplateRows: toFr(rowSizes),
                                gridTemplateAreas: preset.areas,
                                gap: 0,
                                background: 'rgba(255,255,255,.04)',
                                position: 'relative',
                                overflow: 'hidden',
                                minHeight: 0,
                            }}
                        >
                            {LETTERS.map((letter, i) => {
                                const isActive = i < activeLetters.length;
                                const isFocused = focused === i;
                                const mounted = everActive[i];
                                return (
                                    <div
                                        key={letter}
                                        style={{
                                            gridArea: letter,
                                            position: 'relative',
                                            overflow: 'hidden',
                                            minWidth: 0,
                                            minHeight: 0,
                                            visibility: isActive ? 'visible' : 'hidden',
                                            pointerEvents: isActive ? 'auto' : 'none',
                                            border: '0.5px solid #2b323c',
                                        }}
                                        onMouseDownCapture={() => {
                                            if (isActive && !isFocused) {
                                                setFocused(i);
                                                chartRefs.current[i]?.setActiveTool(activeTool);
                                                globalChartBus.setFocus(_chart.id);
                                            }
                                            if (isActive) panningChartRef.current = i;
                                        }}
                                    >
                                        {mounted && (
                                            <Chart
                                                key={`${letter}-chart`}
                                                ref={(el) => {
                                                    chartRefs.current[i] = el;
                                                }}
                                                managed
                                                hideToolbar
                                                hideDrawingToolbar
                                                hideBottomToolbar
                                                hidePriceScale={_hidePriceScale}
                                                hideTimeScale={_hideTimeScale}
                                                hideStatusBar={_hideStatusBar}
                                                hideLegend={_hideLegend}
                                                hideSettingsDialog
                                                onOpenSettings={() => setChartSettingsOpen(true)}
                                                onHorizonUpdate={(h) => {
                                                    sharedHorizonRef.current = h;
                                                }}
                                                onHorizonTick={isFocused ? () => {} : undefined}
                                                domPanelRef={undefined}
                                                onRequestMore={handleRequestMore}
                                                tradeLines={cellBridges[i].trading.tradeLines}
                                                onCreateOrder={(req) =>
                                                    cellBridges[i].executionEngine?.placeOrder({
                                                        qty: 1,
                                                        ...req,
                                                        // This pane's instrument, not
                                                        // the focused pane's: dragging
                                                        // an order onto a background
                                                        // chart must trade what that
                                                        // chart shows.
                                                        symbol: req.symbol ?? cellSymbols[i],
                                                    })
                                                }
                                                onGhostMove={cellBridges[i].trading.handleGhostMove}
                                                linesRef={cellBridges[i].trading.linesRef}
                                                draggingLineIdRef={
                                                    cellBridges[i].trading.draggingLineIdRef
                                                }
                                                redrawTrading={() =>
                                                    cellBridges[i].redrawFnRef.current?.()
                                                }
                                                eventBus={eventBus}
                                                transformer={externalTransformer}
                                                showDataStatusInBottomRightCorner={
                                                    showDataStatusInBottomRightCorner
                                                }
                                                initialState={{
                                                    timeframe: _chart.getChart(i).timeframe,
                                                }}
                                                id={i}
                                                symbol={cellSymbols[i]}
                                                features={features}
                                                account={_chart.account}
                                                drawingStore={_chart.drawingStore}
                                                model={_chart.getChart(i)}
                                                syncInLayout={syncInLayout}
                                                setStatePatch={handleSetStatePatch}
                                            />
                                        )}

                                        {isActive && isFocused && activeLetters.length > 1 && (
                                            <div
                                                key={`${letter}-overlay`}
                                                className="w-full h-full bg-transparent pointer-events-none z-10 absolute top-0 left-0 border-2 border-blue-500/70"
                                            />
                                        )}
                                    </div>
                                );
                            })}

                            {gridRef.current && (
                                <>
                                    <Dividers
                                        dir="col"
                                        sizes={colSizes}
                                        containerRef={gridRef}
                                        onDrag={colDrag}
                                    />
                                    <Dividers
                                        dir="row"
                                        sizes={rowSizes}
                                        containerRef={gridRef}
                                        onDrag={rowDrag}
                                        areas={preset.areas}
                                        colSizes={colSizes}
                                    />
                                </>
                            )}
                        </div>

                        {/* Fixed/pinned plugin sidebar */}
                        <PluginFixedPanelHost
                            eventBus={eventBus}
                            chart={_chart}
                            onFixedPanelsChange={setHasFixedPanels}
                            override={showFixedWindowsSidebarOverride}
                        />
                    </div>
                </div>

                {/* Bottom bar */}
                {!_hideBottomToolbar && (
                    <TooltipProvider delayDuration={400}>
                        <div className="flex items-center h-8 px-3 border-t border-border/50 bg-background shrink-0 select-none">
                            {/* Scale mode: N / L / % */}
                            <div className="flex items-center gap-0.5">
                                {(['normal', 'percent'] as const).map((mode) => (
                                    <Tooltip key={mode}>
                                        <TooltipTrigger asChild>
                                            <button
                                                onClick={() => {
                                                    const patch = { priceScaleMode: mode };
                                                    setChartSettings((p) => ({ ...p, ...patch }));
                                                    chartRefs.current[
                                                        focusedRef.current
                                                    ]?.applySettings(patch);
                                                }}
                                                className={cn(
                                                    'h-5 px-1.5 text-xs font-semibold rounded leading-none transition-colors',
                                                    chartSettings.priceScaleMode === mode
                                                        ? 'text-foreground/75'
                                                        : 'text-foreground/25 hover:text-foreground/55',
                                                )}
                                            >
                                                {mode === 'normal' ? 'N' : '%'}
                                            </button>
                                        </TooltipTrigger>
                                        <TooltipContent
                                            side="top"
                                            className="text-xs border border-border bg-background"
                                        >
                                            {mode === 'normal' ? 'Normal scale' : 'Percent scale'}
                                        </TooltipContent>
                                    </Tooltip>
                                ))}

                                <div className="w-px h-3 bg-border/50 mx-1 shrink-0" />

                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <button
                                            onClick={() => {
                                                const patch = {
                                                    autoScale: !chartSettings.autoScale,
                                                };
                                                setChartSettings((p) => ({ ...p, ...patch }));
                                                chartRefs.current[
                                                    focusedRef.current
                                                ]?.applySettings(patch);
                                            }}
                                            className={cn(
                                                'h-5 w-5 flex items-center justify-center rounded transition-colors',
                                                chartSettings.autoScale
                                                    ? 'text-foreground/70 hover:text-foreground/90'
                                                    : 'text-foreground/25 hover:text-foreground/55',
                                            )}
                                        >
                                            {chartSettings.autoScale ? (
                                                <LockOpen size={11} />
                                            ) : (
                                                <Lock size={11} />
                                            )}
                                        </button>
                                    </TooltipTrigger>
                                    <TooltipContent
                                        side="top"
                                        className="text-xs border border-border bg-background"
                                    >
                                        {chartSettings.autoScale
                                            ? 'Auto-scale on - click to lock'
                                            : 'Scale locked - click to auto-fit'}
                                    </TooltipContent>
                                </Tooltip>

                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <button
                                            onClick={() => {
                                                const patch = { showGrid: !chartSettings.showGrid };
                                                setChartSettings((p) => ({ ...p, ...patch }));
                                                chartRefs.current[
                                                    focusedRef.current
                                                ]?.applySettings(patch);
                                            }}
                                            className={cn(
                                                'h-5 w-5 flex items-center justify-center rounded transition-colors',
                                                chartSettings.showGrid
                                                    ? 'text-foreground/70 hover:text-foreground/90'
                                                    : 'text-foreground/25 hover:text-foreground/55',
                                            )}
                                        >
                                            <Grid3X3 size={11} />
                                        </button>
                                    </TooltipTrigger>
                                    <TooltipContent
                                        side="top"
                                        className="text-xs border border-border bg-background"
                                    >
                                        {chartSettings.showGrid ? 'Hide grid' : 'Show grid'}
                                    </TooltipContent>
                                </Tooltip>

                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <button
                                            onClick={() => {
                                                const next =
                                                    chartSettings.crosshairMode === 'magnet'
                                                        ? ('normal' as const)
                                                        : ('magnet' as const);
                                                const patch = { crosshairMode: next };
                                                setChartSettings((p) => ({ ...p, ...patch }));
                                                chartRefs.current[
                                                    focusedRef.current
                                                ]?.applySettings(patch);
                                            }}
                                            className={cn(
                                                'h-5 w-5 flex items-center justify-center rounded transition-colors',
                                                chartSettings.crosshairMode === 'magnet'
                                                    ? 'text-foreground/70 hover:text-foreground/90'
                                                    : 'text-foreground/25 hover:text-foreground/55',
                                            )}
                                        >
                                            <Magnet size={11} />
                                        </button>
                                    </TooltipTrigger>
                                    <TooltipContent
                                        side="top"
                                        className="text-xs border border-border bg-background"
                                    >
                                        {chartSettings.crosshairMode === 'magnet'
                                            ? 'Magnet on'
                                            : 'Magnet off'}
                                    </TooltipContent>
                                </Tooltip>
                            </div>

                            {/* Plugin / chart-type bottom bar content */}
                            <BottomBarPluginHost eventBus={eventBus} chart={_chart} />

                            {/* Timezone + timestamp */}
                            <div className="ml-auto flex items-center gap-2">
                                {chartSettings.showTimezoneLabel && (
                                    <span
                                        ref={tzRef}
                                        className="text-xs text-foreground/30 tabular-nums leading-none"
                                    />
                                )}
                                <span
                                    ref={currentTimeRef}
                                    className="text-xs text-foreground/50 tabular-nums leading-none"
                                />
                            </div>
                        </div>
                    </TooltipProvider>
                )}

                {chartSettingsOpen && (
                    <ChartSettingsDialog
                        settings={chartSettings}
                        horizon={sharedHorizonRef.current}
                        pluginChartType={activePluginChartType}
                        onUpdate={(patch) => {
                            setChartSettings((prev) => ({ ...prev, ...patch }));
                            chartRefs.current[focusedRef.current]?.applySettings(patch);
                            // the plugin holds its own copy: draw() reads it every
                            // frame and its worker needs it to recompute
                            if (patch.pluginSettings && activePluginChartType) {
                                activePluginChartType.onSettingsChange?.(
                                    patch.pluginSettings[activePluginChartType.chartTypeId] ?? {},
                                );
                            }
                        }}
                        onClose={() => setChartSettingsOpen(false)}
                    />
                )}
            </div>
        </TooltipProvider>
    );
}
