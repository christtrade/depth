import { useCallback, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { type RenderEngine } from '../core/RenderEngine';
import { type TypedEventBus } from '../core/TypedEventBus';
import { type ChartTypePlugin, type ChartTypeActiveContext } from '../core/PluginRegistry';
import { type ChartPane, type Indicator } from '../lib/types/indicator-types';
import { type DataLevel } from '../interfaces/IDataAdapter';
import { isCompatible } from '../core/processing/data-level';
import { type Timeframe } from '../lib/timeframes';
import { type TradePoint } from '../lib/types';

export interface UseChartPluginParams {
    renderEngineRef: MutableRefObject<RenderEngine | null>;
    uiCanvasRef: MutableRefObject<HTMLCanvasElement | null>;
    eventBus: TypedEventBus;
    indicatorsRef: MutableRefObject<Indicator[]>;
    panesRef: MutableRefObject<ChartPane[]>;
    horizonRef: MutableRefObject<bigint>;
    activeTimeframeRef: MutableRefObject<Timeframe>;
    dataLevelRef: MutableRefObject<DataLevel | null>;
    setPanes: (updater: ChartPane[] | ((prev: ChartPane[]) => ChartPane[])) => void;
    setIndicators: (inds: Indicator[]) => void;
    runIndicatorWorker: (trades: TradePoint[], barNs: bigint) => void;
    getTradesUpToHorizon: (horizon: bigint) => TradePoint[];
    pushDrawParams: () => void;
}

export interface UseChartPluginResult {
    pluginChartTypesRef: MutableRefObject<Map<string, ChartTypePlugin>>;
    activeChartTypeBottomBarIds: MutableRefObject<Set<string>>;
    pluginChartTypes: ChartTypePlugin[];
    setPluginChartTypes: (types: ChartTypePlugin[]) => void;
    pluginChartTypeComputedRef: MutableRefObject<Map<string, unknown>>;
    activatePluginIndicator: (indicator: Indicator, pane?: ChartPane) => void;
    replacePluginIndicator: (indicator: Indicator) => void;
    buildChartTypeActiveCtx: () => ChartTypeActiveContext;
}

export function useChartPlugin(p: UseChartPluginParams): UseChartPluginResult {
    const {
        renderEngineRef,
        uiCanvasRef,
        eventBus,
        indicatorsRef,
        panesRef,
        horizonRef,
        activeTimeframeRef,
        dataLevelRef,
        setPanes,
        setIndicators,
        runIndicatorWorker,
        getTradesUpToHorizon,
        pushDrawParams,
    } = p;

    const pluginChartTypesRef = useRef<Map<string, ChartTypePlugin>>(new Map());
    const activeChartTypeBottomBarIds = useRef(new Set<string>());
    const [pluginChartTypes, setPluginChartTypes] = useState<ChartTypePlugin[]>([]);
    const pluginChartTypeComputedRef = useRef<Map<string, unknown>>(new Map());

    // The chokepoint for the data level gate.
    //
    // Every route in lands here - the picker, chart.add(), a plugin's
    // activeByDefault, and the reconcile pass a restored chart runs once its
    // plugins install. An indicator that needs trades cannot be computed from
    // candles, and letting it in gives the user an empty pane with nothing to
    // explain it.
    //
    // Not checked at install: plugins are installed in the DepthChart
    // constructor, long before a symbol resolves, so ctx.dataLevel is still a
    // guess then. Activation is the first moment the answer is known.
    const activatePluginIndicator = useCallback((indicator: Indicator, pane?: ChartPane) => {
        if (indicatorsRef.current.some((i) => i.id === indicator.id)) return;

        const required = indicator.require ?? 'ohlcv';
        const actual = dataLevelRef.current;
        // null until the first load. Nothing to refuse it against yet - the
        // re-check on the level landing catches anything that shouldnt be here.
        if (actual && !isCompatible(required, actual)) {
            eventBus.emit('plugin:incompatible', {
                id: indicator.id,
                name: indicator.name,
                kind: 'indicator',
                required,
                actual,
            });
            return;
        }

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
    }, []);

    const replacePluginIndicator = useCallback((indicator: Indicator) => {
        if (!indicatorsRef.current.some((i) => i.id === indicator.id)) return;
        indicatorsRef.current = indicatorsRef.current.map((i) =>
            i.id === indicator.id ? indicator : i,
        );
        setIndicators(indicatorsRef.current);
        // .map() built a new array, so the engine's snapshot still points at the
        // old one - marking dirty without pushing repaints the previous defs.
        pushDrawParams();
        renderEngineRef.current?.markDirty('base');
    }, []);

    function buildChartTypeActiveCtx(): ChartTypeActiveContext {
        return {
            requestRedraw() {
                renderEngineRef.current?.markAllDirty();
            },
            setCursor(cursor: string) {
                if (uiCanvasRef.current) uiCanvasRef.current.style.cursor = cursor;
            },
            eventBus,
            registerBottomBarItem(id: string, render: () => ReactNode) {
                const isUpdate = activeChartTypeBottomBarIds.current.has(id);
                activeChartTypeBottomBarIds.current.add(id);
                eventBus.emit(
                    isUpdate ? 'plugin:bottom-bar-item-updated' : 'plugin:bottom-bar-item-added',
                    { item: { id, render } },
                );
                return {
                    rerender() {
                        eventBus.emit('plugin:bottom-bar-item-rerender', { id });
                    },
                    destroy() {
                        activeChartTypeBottomBarIds.current.delete(id);
                        eventBus.emit('plugin:bottom-bar-item-removed', { id });
                    },
                };
            },
        };
    }

    return {
        pluginChartTypesRef,
        activeChartTypeBottomBarIds,
        pluginChartTypes,
        setPluginChartTypes,
        pluginChartTypeComputedRef,
        activatePluginIndicator,
        replacePluginIndicator,
        buildChartTypeActiveCtx,
    };
}
