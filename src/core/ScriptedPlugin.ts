
import { nanoid } from 'nanoid';
import type {
    ChartPlugin,
    ChartTypePlugin,
    ChartTypeActiveContext,
    ChartTypePointerEvent,
    ChartTypeKeyEvent,
    ChartTypeRenderContext,
    PluginContext,
    PluginType,
    Permission,
} from './PluginRegistry';
import type { DataLevel } from '../interfaces/IDataAdapter';
import type { Indicator, RenderContext } from '../lib/types/indicator-types';
import { executeDrawCommands, type DrawCommand } from '../lib/indicator-stdlib';
import type { OhlcvBar } from '../lib/indicator-stdlib';
import { makeScopedCompiler } from './script-scope';
import type { IndicatorSettingField } from '../components/indicators/indicators-settings-dialog';
import type { StyleField } from '../components/drawings/drawing-settings-dialog';
import type { SerialTrade } from '../lib/types';
import type { DrawingAnchorId } from '../lib/types/drawing-types';
import {
    drawingRegistry,
    type PluginDrawingHitContext,
    PluginToolActiveContext,
} from './DrawingRegistry';
import React from 'react';

// single-key param types map one name to one settings key. compound ones map a
// name to several keys using a prefix:
//
//   dualColor        foo -> foo_a, foo_b
//   dualOpacity      foo -> foo_a, foo_b
//   colorGradient    foo -> foo_start, foo_end
//   colorWithOpacity foo -> foo_color, foo_opacity
//   toggledColor     foo -> foo_on, foo_color
//   toggledInput     foo -> foo_on, foo_val
//   inlineFields         -> each sub-field carries its own flat key
//
export type ParamDef =
    // Single-key
    | {
          label: string;
          type: 'number';
          default: number;
          min?: number;
          max?: number;
          step?: number;
          unit?: string;
      }
    | {
          label: string;
          type: 'stepperInt';
          default: number;
          min?: number;
          max?: number;
          step?: number;
      }
    | {
          label: string;
          type: 'slider';
          default: number;
          min: number;
          max: number;
          step?: number;
          suffix?: string;
      }
    | {
          label: string;
          type: 'rangeWithSteps';
          default: number;
          min: number;
          max: number;
          steps: { value: number; label: string }[];
      }
    | { label: string; type: 'opacity'; default: number }
    | { label: string; type: 'fontSize'; default: number }
    | { label: string; type: 'color'; default: string }
    | { label: string; type: 'text'; default: string; placeholder?: string; maxLength?: number }
    | {
          label: string;
          type: 'select';
          default: string;
          options: string[] | { value: string; label: string }[];
      }
    | {
          label: string;
          type: 'buttonGroup';
          default: string;
          options: { value: string; label: string }[];
      }
    | { label: string; type: 'boolean'; default: boolean }
    | { label: string; type: 'checkbox'; default: boolean; description?: string }
    // Compound (multi-key)
    | {
          label: string;
          type: 'dualColor';
          labelA: string;
          defaultA: string;
          labelB: string;
          defaultB: string;
      }
    | {
          label: string;
          type: 'dualOpacity';
          labelA: string;
          defaultA: number;
          labelB: string;
          defaultB: number;
      }
    | { label: string; type: 'colorGradient'; defaultStart: string; defaultEnd: string }
    | { label: string; type: 'colorWithOpacity'; defaultColor: string; defaultOpacity: number }
    | { label: string; type: 'toggledColor'; defaultToggle: boolean; defaultColor: string }
    | {
          label: string;
          type: 'toggledInput';
          toggleLabel: string;
          inputLabel: string;
          defaultToggle: boolean;
          defaultInput: number;
          min?: number;
          max?: number;
          step?: number;
          unit?: string;
      }
    | {
          label: string;
          type: 'inlineFields';
          fields: Array<
              | {
                    type: 'stepperInt';
                    key: string;
                    label: string;
                    default: number;
                    min?: number;
                    max?: number;
                    step?: number;
                }
              | {
                    type: 'buttonGroup';
                    key: string;
                    label: string;
                    default: string;
                    options: { value: string; label: string }[];
                }
              | { type: 'checkbox'; key: string; label: string; default: boolean }
          >;
      };

// every settings key a param definition owns
function getParamKeys(key: string, def: ParamDef): string[] {
    switch (def.type) {
        case 'dualColor':
        case 'dualOpacity':
            return [`${key}_a`, `${key}_b`];
        case 'colorGradient':
            return [`${key}_start`, `${key}_end`];
        case 'colorWithOpacity':
            return [`${key}_color`, `${key}_opacity`];
        case 'toggledColor':
            return [`${key}_on`, `${key}_color`];
        case 'toggledInput':
            return [`${key}_on`, `${key}_val`];
        case 'inlineFields':
            return def.fields.map((f) => f.key);
        default:
            return [key];
    }
}

// writes a param's default value(s) into the record
function initParamDefaults(key: string, def: ParamDef, out: Record<string, unknown>): void {
    switch (def.type) {
        case 'dualColor':
            out[`${key}_a`] = def.defaultA;
            out[`${key}_b`] = def.defaultB;
            break;
        case 'dualOpacity':
            out[`${key}_a`] = def.defaultA;
            out[`${key}_b`] = def.defaultB;
            break;
        case 'colorGradient':
            out[`${key}_start`] = def.defaultStart;
            out[`${key}_end`] = def.defaultEnd;
            break;
        case 'colorWithOpacity':
            out[`${key}_color`] = def.defaultColor;
            out[`${key}_opacity`] = def.defaultOpacity;
            break;
        case 'toggledColor':
            out[`${key}_on`] = def.defaultToggle;
            out[`${key}_color`] = def.defaultColor;
            break;
        case 'toggledInput':
            out[`${key}_on`] = def.defaultToggle;
            out[`${key}_val`] = def.defaultInput;
            break;
        case 'inlineFields':
            for (const f of def.fields) out[f.key] = f.default;
            break;
        default:
            out[key] = (def as any).default;
            break;
    }
}

interface ScriptDeclaration {
    id?: string;
    name: string;
    type: 'indicator' | 'drawing' | 'chart-type' | 'data-source' | 'extension';
    require?: DataLevel;
    version?: string;
    layout?: 'overlay' | 'pane';
    /**
     * Groups the plugin in the indicators picker. A script may declare its own;
     * otherwise the host-supplied fallback (see createScriptedPlugin) is used.
     */
    category?: string;
    /** Ticker-style abbreviation shown next to the name in the picker. */
    shortName?: string;
    /** One-line blurb shown in the picker row. */
    description?: string;
    /**
     * Warmup bars this plugin needs before its output is valid.
     *
     * Scripted plugins have to use a plain number - the declaration is structure-
     * cloned back from the worker, and a function on it throws DataCloneError at
     * parse time. The callable form only works for main-thread plugins.
     */
    lookback?: number | ((params: Record<string, unknown>) => number);
    params?: Record<string, ParamDef>;
    // drawing tool specific
    anchorCount?: number | 'dynamic';
    cursor?: string;
    icon?: string;
    permissions?: Permission[];
    /** Origins ctx.fetch may reach. Anything else throws. */
    origins?: string[];
}

interface WorkerInitMsg {
    plugins: Array<{
        index: number;
        decl: any;
        initialState: unknown;
        drawCommands: DrawCommand[];
        drawUISrc: string | null;
        drawDirectSrc: string | null;
        onRenderSrc: string | null;
        onHitTestSrc: string | null;
        onPreviewSrc: string | null;
        onMoveSrc: string | null;
        onPointerDownSrc: string | null;
        onPointerMoveSrc: string | null;
        onPointerUpSrc: string | null;
        onKeyDownSrc: string | null;
        onActivateSrc: string | null;
        onDeactivateSrc: string | null;
        // chart-type specific
        onDrawSrc: string | null;
        onGetAutoYBoundsSrc: string | null;
        onChartPointerDownSrc: string | null;
        onChartPointerMoveSrc: string | null;
        onChartPointerUpSrc: string | null;
        onChartKeyDownSrc: string | null;
        onChartActivateSrc: string | null;
        onChartDeactivateSrc: string | null;
        onBarHoverSrc: string | null;
        getTooltipSrc: string | null;
    }>;
}

// WorkerUpdateMsg carries pluginIndex:
interface WorkerUpdateMsg {
    pluginIndex: number;
    points: unknown;
    state: unknown;
    drawCommands: DrawCommand[];
}

// Shared helpers
function buildDataForLevel(
    level: DataLevel,
    ohlcv: OhlcvBar[],
    trades: SerialTrade[],
    ticks: unknown[],
    snapshots: unknown[],
): Record<string, unknown> {
    return {
        ohlcv: level === 'ohlcv' || level === 'tick' || level === 'l3' ? ohlcv : [],
        trades: level === 'l3' ? trades : [],
        ticks: level === 'tick' || level === 'l3' ? ticks : [],
        snapshots: level === 'l2' || level === 'l3' ? snapshots : [],
    };
}

function mergeBars(existing: OhlcvBar[], incoming: OhlcvBar[]): OhlcvBar[] {
    if (!incoming.length) return existing;
    const merged = existing.slice();
    for (const bar of incoming) {
        const barTs = BigInt(bar.ts);
        const last = merged[merged.length - 1];
        if (last && BigInt(last.ts) === barTs) {
            merged[merged.length - 1] = {
                ...last,
                high: Math.max(bar.high, last.high),
                low: Math.min(bar.low, last.low),
                close: bar.close,
                volume: last.volume + bar.volume,
            };
        } else {
            let found = false;
            for (let i = merged.length - 2; i >= 0; i--) {
                if (BigInt(merged[i].ts) === barTs) {
                    merged[i] = {
                        ...merged[i],
                        high: Math.max(bar.high, merged[i].high),
                        low: Math.min(bar.low, merged[i].low),
                        close: bar.close,
                        volume: merged[i].volume + bar.volume,
                    };
                    found = true;
                    break;
                }
            }
            if (!found) merged.push(bar);
        }
    }
    return merged;
}

export function hasFunctionDecl(script: string, name: string): boolean {
    return new RegExp(`\\bfunction\\s+${name}\\s*\\(`).test(script);
}

function strHash(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return h;
}


const SCRIPTED_SENTINEL = '__scripted__';

// each handler gets the worker, the declaration, the plugin id and its context,
// wires up whatever it needs and returns a teardown.
//
// to add a capability: write a handler below, add it to CAPABILITY_HANDLERS.
// nothing else changes.

type CapabilityTeardown = (opts?: { hotReload?: boolean }) => void;

type CapabilityHandler = (
    worker: Worker,
    pluginMsg: WorkerInitMsg['plugins'][0], // already has decl + all srcs
    entryId: string, // unique per entry, e.g. "scripted:abc123:0"
    pluginIndex: number,
    ctx: PluginContext,
    onWorkerUpdate: (cb: (msg: WorkerUpdateMsg) => void) => void,
    emitError: (error: string, line?: number) => void,
    getScript: () => string,
) => CapabilityTeardown;

// Indicator capability
function buildParamSchema(paramDefs: Record<string, ParamDef>): IndicatorSettingField[] {
    const fields: IndicatorSettingField[] = [];
    for (const [key, def] of Object.entries(paramDefs)) {
        const tab = 'params' as const;
        const base = { key, label: def.label, tab };
        switch (def.type) {
            // Single-key
            case 'number':
                fields.push({
                    ...base,
                    type: 'numberInput',
                    min: def.min,
                    max: def.max,
                    step: def.step ?? 1,
                    unit: def.unit,
                });
                break;
            case 'stepperInt':
                fields.push({
                    ...base,
                    type: 'stepperInt',
                    min: def.min,
                    max: def.max,
                    step: def.step ?? 1,
                });
                break;
            case 'slider':
                fields.push({
                    ...base,
                    type: 'slider',
                    min: def.min,
                    max: def.max,
                    step: def.step ?? 1,
                    suffix: def.suffix,
                });
                break;
            case 'rangeWithSteps':
                fields.push({
                    ...base,
                    type: 'rangeWithSteps',
                    min: def.min,
                    max: def.max,
                    steps: def.steps,
                });
                break;
            case 'opacity':
                fields.push({ ...base, type: 'opacity' });
                break;
            case 'fontSize':
                fields.push({ ...base, type: 'fontSize' });
                break;
            case 'color':
                fields.push({ ...base, type: 'color' });
                break;
            case 'text':
                fields.push({
                    ...base,
                    type: 'textInput',
                    placeholder: def.placeholder,
                    maxLength: def.maxLength,
                });
                break;
            case 'select': {
                const opts = (def.options ?? []).map((v) =>
                    typeof v === 'string' ? { value: v, label: v } : v,
                );
                fields.push({ ...base, type: 'select', options: opts });
                break;
            }
            case 'buttonGroup':
                fields.push({ ...base, type: 'buttonGroup', options: def.options });
                break;
            case 'boolean':
                fields.push({ ...base, type: 'toggle' });
                break;
            case 'checkbox':
                fields.push({ ...base, type: 'checkbox', description: def.description });
                break;
            // Compound (multi-key)
            case 'dualColor':
                fields.push({
                    tab,
                    label: def.label,
                    type: 'dualColor',
                    keyA: `${key}_a`,
                    labelA: def.labelA,
                    keyB: `${key}_b`,
                    labelB: def.labelB,
                });
                break;
            case 'dualOpacity':
                fields.push({
                    tab,
                    label: def.label,
                    type: 'dualOpacity',
                    keyA: `${key}_a`,
                    labelA: def.labelA,
                    keyB: `${key}_b`,
                    labelB: def.labelB,
                });
                break;
            case 'colorGradient':
                fields.push({
                    tab,
                    label: def.label,
                    type: 'colorGradient',
                    keyStart: `${key}_start`,
                    keyEnd: `${key}_end`,
                });
                break;
            case 'colorWithOpacity':
                fields.push({
                    tab,
                    label: def.label,
                    type: 'colorWithOpacity',
                    colorKey: `${key}_color`,
                    opacityKey: `${key}_opacity`,
                });
                break;
            case 'toggledColor':
                fields.push({
                    tab,
                    label: def.label,
                    type: 'toggledColor',
                    toggleKey: `${key}_on`,
                    colorKey: `${key}_color`,
                });
                break;
            case 'toggledInput':
                fields.push({
                    tab,
                    type: 'toggledInput',
                    toggleKey: `${key}_on`,
                    toggleLabel: def.toggleLabel,
                    inputKey: `${key}_val`,
                    inputLabel: def.inputLabel,
                    min: def.min,
                    max: def.max,
                    step: def.step,
                    unit: def.unit,
                });
                break;
            case 'inlineFields':
                fields.push({
                    tab,
                    label: def.label,
                    type: 'inlineFields',
                    fields: def.fields.map((f) => {
                        if (f.type === 'stepperInt')
                            return {
                                type: 'stepperInt' as const,
                                key: f.key,
                                label: f.label,
                                min: f.min,
                                max: f.max,
                                step: f.step,
                            };
                        if (f.type === 'buttonGroup')
                            return { type: 'buttonGroup' as const, key: f.key, options: f.options };
                        return { type: 'checkbox' as const, key: f.key, label: f.label };
                    }),
                });
                break;
        }
    }
    return fields;
}

// drawings and chart types show the same params, just in a dialog built on
// StyleField instead of IndicatorSettingField. the two unions line up except
// for the tab key, slider (needs its three tick labels spelled out) and section
// (no equivalent).
export function buildStyleSchema(paramDefs: Record<string, ParamDef>): StyleField[] {
    const out: StyleField[] = [];
    for (const field of buildParamSchema(paramDefs)) {
        const { tab: _tab, ...rest } = field as IndicatorSettingField & { tab?: string };
        if (rest.type === 'section') continue;
        if (rest.type === 'slider') {
            const suffix = rest.suffix ?? '';
            const mid = rest.min + (rest.max - rest.min) / 2;
            out.push({
                ...rest,
                step1: `${rest.min}${suffix}`,
                step2: `${Math.round(mid * 100) / 100}${suffix}`,
                step3: `${rest.max}${suffix}`,
            });
            continue;
        }
        out.push(rest as StyleField);
    }
    return out;
}

// defaults for every key a param set owns, ready to drop on a new drawing or
// seed a chart type's settings with
export function buildParamDefaults(paramDefs: Record<string, ParamDef>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, def] of Object.entries(paramDefs)) initParamDefaults(key, def, out);
    return out;
}

const indicatorCapability: CapabilityHandler = (
    worker,
    pluginMsg,
    entryId,
    pluginIndex,
    ctx,
    onWorkerUpdate,
    emitError,
    getScript,
) => {
    const decl = pluginMsg.decl as ScriptDeclaration;
    const dataLevel: DataLevel = decl.require ?? 'ohlcv';
    const layout: 'overlay' | 'pane' = decl.layout ?? 'overlay';
    let drawCommands: DrawCommand[] = pluginMsg.drawCommands ?? [];
    const compile = makeScopedCompiler(getScript(), {}, emitError);
    let drawDirectFn: ((state: unknown, ctx: RenderContext) => void) | null = compile(
        pluginMsg.drawDirectSrc,
    );
    let drawUIFn: ((state: unknown, ctx: RenderContext, crosshair: any) => void) | null = compile(
        (pluginMsg as any).drawUISrc,
    );
    let lastState: unknown = pluginMsg.initialState;
    let fullBars: OhlcvBar[] = [];

    // Params
    const paramDefs: Record<string, ParamDef> = (decl.params as Record<string, ParamDef>) ?? {};
    const currentParams: Record<string, unknown> = {};
    for (const [key, def] of Object.entries(paramDefs)) {
        initParamDefaults(key, def, currentParams);
    }

    function evalLookback(): number {
        const lb = decl.lookback;
        if (typeof lb === 'function') return lb(currentParams);
        return lb ?? 0;
    }

    // cached from the last full compute, to recompute on a param change
    let lastComputeData: Record<string, unknown> | null = null;
    let lastComputeBarNs: bigint = 0n;

    // Indicator object
    const indicator: Indicator = {
        id: entryId,
        name: decl.name,
        visible: true,
        layout,
        paneId: layout === 'overlay' ? 'main' : entryId,
        // the picker groups on the indicator, not the plugin. createScriptedPlugin
        // has already resolved decl.category to the host fallback if it was unset.
        category: decl.category,
        shortName: decl.shortName,
        description: decl.description,
        require: dataLevel,
        settings: { ...currentParams },
        workerInit: SCRIPTED_SENTINEL,
        workerUpdate: SCRIPTED_SENTINEL,

        hydrate(_data, _barNs) {},
        appendHydrate(_points, _barNs) {},

        drawBase(renderCtx) {
            if (drawCommands.length) {
                try {
                    executeDrawCommands(drawCommands, renderCtx);
                } catch (e) {
                    emitError(`draw error: ${e}`);
                }
            }
            if (drawDirectFn) {
                try {
                    drawDirectFn(lastState, renderCtx);
                } catch (e) {
                    emitError(`drawDirect error: ${e}`);
                }
            }
        },

        drawUI(renderCtx, crosshair) {
            if (drawUIFn) {
                try {
                    drawUIFn(lastState, renderCtx, crosshair);
                } catch (e) {
                    emitError(`drawUI error: ${e}`);
                }
            }
        },

        getAutoYBounds(tMin, tMax, horizon) {
            let lo = Infinity,
                hi = -Infinity;
            for (const cmd of drawCommands) {
                if (cmd.type !== 'line' && cmd.type !== 'histogram') continue;
                const pts = cmd.pts;
                let startIdx = 0;
                {
                    let blo = 0,
                        bhi = pts.length - 1;
                    while (blo <= bhi) {
                        const mid = (blo + bhi) >>> 1;
                        if (pts[mid].t < tMin) blo = mid + 1;
                        else bhi = mid - 1;
                    }
                    startIdx = blo;
                }
                for (let i = startIdx; i < pts.length; i++) {
                    const t = pts[i].t;
                    if (t > tMax) break;
                    if (horizon !== 0n && t > horizon) break;
                    const price = pts[i].price;
                    if (!isNaN(price)) {
                        if (price < lo) lo = price;
                        if (price > hi) hi = price;
                    }
                }
            }
            if (!isFinite(lo) || !isFinite(hi)) return null;
            const pad = (hi - lo) * 0.1 || 1;
            return { min: lo - pad, max: hi + pad };
        },
    };

    // schema + param metadata for the settings dialog
    if (Object.keys(paramDefs).length > 0) {
        (indicator as any).settingsSchema = buildParamSchema(paramDefs);
    }
    // every settings key owned by a param, so onUpdate can route to a worker
    // recompute or just a canvas redraw
    const allParamKeys = new Set<string>();
    for (const [key, def] of Object.entries(paramDefs)) {
        for (const k of getParamKeys(key, def)) allParamKeys.add(k);
    }
    (indicator as any).__paramKeys = allParamKeys;
    // called when a param field changes
    (indicator as any).__onParamsChanged = (patch: Record<string, unknown>) => {
        Object.assign(currentParams, patch);
        if (lastComputeData !== null) {
            worker.postMessage({
                type: 'run-init',
                pluginIndex,
                data: lastComputeData,
                barNs: lastComputeBarNs,
                params: { ...currentParams },
            });
        }
        // re-register with the new lookback if it depends on a param
        if (typeof decl.lookback === 'function') {
            ctx.eventBus.emit('plugin:register-indicator', {
                indicator,
                activeByDefault: false,
                pane: paneConfig,
                lookback: evalLookback(),
            });
        }
    };

    onWorkerUpdate((msg) => {
        drawCommands = msg.drawCommands ?? [];
        lastState = msg.state ?? lastState;
        indicator.appendHydrate(msg.points, 0n);
        // announce first - ctx.renderEngine is the chart's one engine reference,
        // which in a layout is whichever cell mounted last. every pane holding
        // this indicator has to repaint its own engine, not that one.
        ctx.eventBus.emit('plugin:indicator-updated', { id: entryId });
        try {
            ctx.renderEngine.markDirty('base');
        } catch {
            // engine not attached yet, the next dirty event picks the commands up
        }
    });

    // a plugin that set p.wasm goes down the same two messages - the worker is
    // what decides whether the module or the script does the computing
    const offCompute = ctx.eventBus.on(
        'plugin:scripted-compute' as any,
        ({ id, ohlcv, trades, ticks, snapshots, barNs }: any) => {
            if (id !== entryId) return;
            fullBars = ohlcv;
            const data = buildDataForLevel(dataLevel, ohlcv, trades, ticks, snapshots);
            lastComputeData = data;
            lastComputeBarNs = barNs;

            worker.postMessage({
                type: 'run-init',
                pluginIndex,
                data,
                barNs,
                params: { ...currentParams },
            });
        },
    );

    const offAdvance = ctx.eventBus.on(
        'plugin:scripted-advance' as any,
        ({ id, newOhlcv, newTrades, newTicks, newSnapshots, barNs, horizon }: any) => {
            if (id !== entryId) return;
            fullBars = mergeBars(fullBars, newOhlcv);
            const data = buildDataForLevel(dataLevel, fullBars, newTrades, newTicks, newSnapshots);
            const newData = buildDataForLevel(
                dataLevel,
                newOhlcv,
                newTrades,
                newTicks,
                newSnapshots,
            );

            worker.postMessage({
                type: 'update',
                pluginIndex,
                data,
                newData,
                barNs,
                horizon,
                params: { ...currentParams },
            });
        },
    );

    const paneConfig =
        layout === 'pane'
            ? {
                  id: entryId,
                  isMain: false,
                  heightRatio: 0.8,
                  yMin: 0,
                  yMax: 0,
                  yAxisAuto: true,
                  collapsed: false,
              }
            : undefined;

    ctx.eventBus.emit('plugin:register-indicator', {
        indicator,
        activeByDefault: false,
        pane: paneConfig,
        lookback: evalLookback(),
    });

    return () => {
        offCompute();
        offAdvance();
        if (layout === 'pane') ctx.eventBus.emit('plugin:remove-pane', { id: entryId });
    };
};

// Drawing tool capability
const drawingCapability: CapabilityHandler = (
    worker,
    pluginMsg,
    entryId,
    pluginIndex,
    ctx,
    onWorkerUpdate,
    emitError,
    getScript,
) => {
    const decl = pluginMsg.decl as ScriptDeclaration;
    const toolState: Record<string, unknown> = {};

    // a drawing's params live in its own data, so each one on the chart can be
    // styled separately. a drawing placed before a param existed has no value
    // for it - and after a hot reload thats every drawing on screen - so the
    // defaults go underneath whatever it stored.
    const paramDefs: Record<string, ParamDef> = (decl.params as Record<string, ParamDef>) ?? {};
    const defaultData = buildParamDefaults(paramDefs);
    const withDefaults = (data: unknown): unknown =>
        data && typeof data === 'object' ? { ...defaultData, ...(data as object) } : defaultData;

    const compile = makeScopedCompiler(getScript(), {}, emitError);
    const onRenderFn = compile(pluginMsg.onRenderSrc);
    const onHitTestFn = compile(pluginMsg.onHitTestSrc);
    const onPreviewFn = compile(pluginMsg.onPreviewSrc);
    const onMoveFn = compile(pluginMsg.onMoveSrc);
    const onPointerDownFn = compile<(e: any) => boolean | void>(pluginMsg.onPointerDownSrc);
    const onPointerMoveFn = compile<(e: any) => boolean | void>(pluginMsg.onPointerMoveSrc);
    const onPointerUpFn = compile<(e: any) => boolean | void>(pluginMsg.onPointerUpSrc);
    const onKeyDownFn = compile<(e: any) => boolean | void>(pluginMsg.onKeyDownSrc);
    const onActivateFn = compile<(ctx: any) => void>(pluginMsg.onActivateSrc);
    const onDeactivateFn = compile<() => void>(pluginMsg.onDeactivateSrc);

    if (!onRenderFn) {
        emitError('Drawing plugin must define an onRender function.');
        return () => {};
    }

    function wrapToolCtx(tool: PluginToolActiveContext): PluginToolActiveContext {
        return {
            ...tool,
            setDraft(draft: any) {
                tool.setDraft({ pluginToolId: entryId, ...draft });
            },
            commitDrawing(drawing: any) {
                tool.commitDrawing({ pluginToolId: entryId, ...drawing });
            },
        };
    }

    const unregister = drawingRegistry.register({
        id: entryId,
        name: decl.name,
        icon: decl.icon,
        cursor: decl.cursor ?? 'crosshair',
        anchorCount: decl.anchorCount ?? 2,

        render(rctx) {
            try {
                onRenderFn!({ ...rctx, data: withDefaults(rctx.data), state: toolState });
            } catch (e) {
                emitError(`onRender error: ${e}`);
            }
        },

        hitTest(hctx) {
            const withData = { ...hctx, data: withDefaults(hctx.data), state: toolState };
            if (!onHitTestFn) return defaultHitTest(withData as any);
            try {
                return onHitTestFn(withData as any);
            } catch (e) {
                emitError(`onHitTest error: ${e}`);
                return false;
            }
        },

        onMove: onMoveFn
            ? (ctx) => {
                  try {
                      return onMoveFn!({ ...ctx, data: withDefaults(ctx.data) });
                  } catch (e) {
                      emitError(`onMove error: ${e}`);
                      return ctx.data; // unchanged on error
                  }
              }
            : undefined,

        preview:
            (onPreviewFn ?? onRenderFn)
                ? (rctx) => {
                      const fn = onPreviewFn ?? onRenderFn;
                      try {
                          fn!({ ...rctx, data: withDefaults(rctx.data), state: toolState });
                      } catch (e) {
                          emitError(`onPreview error: ${e}`);
                      }
                  }
                : undefined,

        onPointerDown: onPointerDownFn
            ? (e) => {
                  try {
                      return onPointerDownFn({
                          ...e,
                          tool: wrapToolCtx(e.tool),
                          state: toolState,
                      });
                  } catch (err) {
                      emitError(`onPointerDown error: ${err}`);
                  }
              }
            : undefined,

        onPointerMove: onPointerMoveFn
            ? (e) => {
                  try {
                      return onPointerMoveFn({
                          ...e,
                          tool: wrapToolCtx(e.tool),
                          state: toolState,
                      });
                  } catch (err) {
                      emitError(`onPointerMove error: ${err}`);
                  }
              }
            : undefined,

        onPointerUp: onPointerUpFn
            ? (e) => {
                  try {
                      return onPointerUpFn({
                          ...e,
                          tool: wrapToolCtx(e.tool),
                          state: toolState,
                      });
                  } catch (err) {
                      emitError(`onPointerUp error: ${err}`);
                  }
              }
            : undefined,

        onKeyDown: onKeyDownFn
            ? (e) => {
                  try {
                      return onKeyDownFn({ ...e, tool: wrapToolCtx(e.tool), state: toolState });
                  } catch (err) {
                      emitError(`onKeyDown error: ${err}`);
                  }
              }
            : undefined,

        onActivate: onActivateFn
            ? (ctx) => {
                  try {
                      onActivateFn({ ...ctx, state: toolState });
                  } catch (err) {
                      emitError(`onActivate error: ${err}`);
                  }
              }
            : undefined,

        onDeactivate: onDeactivateFn
            ? () => {
                  try {
                      onDeactivateFn();
                  } catch (err) {
                      emitError(`onDeactivate error: ${err}`);
                  }
              }
            : undefined,

        settingsSchema: buildStyleSchema(paramDefs),
        defaultData,
    });

    ctx.eventBus.emit('plugin:register-drawing', { id: entryId, name: decl.name, icon: decl.icon });

    return () => {
        unregister();
        ctx.eventBus.emit('plugin:unregister-drawing', { id: entryId });
    };
};
// default hit test when a tool doesnt define onHitTest: each anchor is a 7px
// circle, and the body is the bounding box of all of them
function defaultHitTest(hctx: PluginDrawingHitContext): DrawingAnchorId | 'body' | false {
    const { mx, my, anchors, w, h, oy, transformer } = hctx;
    const T = 7;
    for (let i = 0; i < anchors.length; i++) {
        const px = transformer.tsToX(anchors[i].ts, w);
        const py = transformer.priceToY(anchors[i].price, h) + oy;
        if (Math.hypot(mx - px, my - py) <= T) return `a${i}` as DrawingAnchorId;
    }
    if (anchors.length >= 2) {
        const xs = anchors.map((a) => transformer.tsToX(a.ts, w));
        const ys = anchors.map((a) => transformer.priceToY(a.price, h) + oy);
        const minX = Math.min(...xs),
            maxX = Math.max(...xs);
        const minY = Math.min(...ys),
            maxY = Math.max(...ys);
        if (mx >= minX - T && mx <= maxX + T && my >= minY - T && my <= maxY + T) return 'body';
    }
    return false;
}

// Chart type capability
const chartTypeCapability: CapabilityHandler = (
    worker,
    pluginMsg,
    entryId,
    pluginIndex,
    ctx,
    onWorkerUpdate,
    emitError,
    getScript,
) => {
    const decl = pluginMsg.decl as ScriptDeclaration;

    // one chart type is active at a time, so unlike a drawing its params are a
    // single set. the host owns the saved values and hands them back through
    // onSettingsChange.
    const paramDefs: Record<string, ParamDef> = (decl.params as Record<string, ParamDef>) ?? {};
    const currentParams = buildParamDefaults(paramDefs);

    // compile the optional src fns out of the worker message. h is in scope
    // because onActivate can claim a bottom bar slot, and that renders UI
    const compile = makeScopedCompiler(getScript(), { React, h: React.createElement }, emitError);
    const onDrawFn = compile<(state: unknown, ctx: ChartTypeRenderContext) => void>(
        pluginMsg.onDrawSrc,
    );
    const getAutoYBoundsFn = compile<
        (tMin: bigint, tMax: bigint, horizon: bigint) => { min: number; max: number } | null
    >(pluginMsg.onGetAutoYBoundsSrc);
    const onPointerDownFn = compile<(e: ChartTypePointerEvent) => boolean | void>(
        pluginMsg.onChartPointerDownSrc,
    );
    const onPointerMoveFn = compile<(e: ChartTypePointerEvent) => boolean | void>(
        pluginMsg.onChartPointerMoveSrc,
    );
    const onPointerUpFn = compile<(e: ChartTypePointerEvent) => boolean | void>(
        pluginMsg.onChartPointerUpSrc,
    );
    const onKeyDownFn = compile<(e: ChartTypeKeyEvent) => boolean | void>(
        pluginMsg.onChartKeyDownSrc,
    );
    const onActivateFn = compile<(ctx: ChartTypeActiveContext) => void>(
        pluginMsg.onChartActivateSrc,
    );
    const onDeactivateFn = compile<() => void>(pluginMsg.onChartDeactivateSrc);
    const onBarHoverFn = compile<(ts: bigint, price: number, barNs: bigint) => void>(
        pluginMsg.onBarHoverSrc,
    );
    const getTooltipFn = compile<(ts: bigint, price: number) => string | null>(
        pluginMsg.getTooltipSrc,
    );

    if (!onDrawFn) {
        emitError('Chart type plugin must define a draw function.');
        return () => {};
    }

    // its own worker, isolated from the indicator one
    const ctWorker = new Worker(new URL('./script.worker.ts', import.meta.url), {
        type: 'module',
    });

    // Computed state hydrated from the worker
    let computedState: unknown = pluginMsg.initialState ?? {};

    // kept so a settings change can re-run init without waiting for new data
    let lastComputeData: Record<string, unknown> | null = null;
    let lastComputeBarNs: bigint = 0n;

    // so incremental horizon advances update our state
    onWorkerUpdate((msg) => {
        computedState = msg.state ?? computedState;
        // Trigger a redraw via the render engine
        ctx.eventBus.emit('plugin:chart-type-updated', { id: entryId });
    });

    // the dedicated worker does both the full recompute and the incremental
    // update, on the same script.worker protocol: parse -> run-init / update
    ctWorker.onmessage = (e: MessageEvent) => {
        const msg = e.data;
        if (msg.type === 'error') {
            emitError(msg.error, msg.line);
            return;
        }
        if (msg.type === 'update') {
            // full recompute or incremental update
            if (msg.points !== undefined) {
                plugin.appendHydrate?.(msg.points, 0n);
            }
            computedState = msg.state ?? computedState;
            ctx.eventBus.emit('plugin:chart-type-updated', { id: entryId });
        }
    };

    // send the script over and parse it
    ctWorker.postMessage({ type: 'parse', script: getScript() });

    const plugin: ChartTypePlugin = {
        id: entryId,
        name: decl.name,
        version: decl.version ?? '1.0.0',
        type: 'chart-type',
        code: '',
        chartTypeId: entryId,
        label: decl.name,
        icon: (decl as any).icon ?? null,
        require: decl.require,
        settingsSchema: buildStyleSchema(paramDefs),
        defaultSettings: { ...currentParams },

        onSettingsChange(next) {
            Object.assign(currentParams, next);
            if (lastComputeData === null) return;
            ctWorker.postMessage({
                type: 'run-init',
                pluginIndex: 0,
                data: lastComputeData,
                barNs: lastComputeBarNs,
                params: { ...currentParams },
            });
        },

        workerInit: pluginMsg.onDrawSrc ? SCRIPTED_SENTINEL : undefined,
        workerUpdate: pluginMsg.onDrawSrc ? SCRIPTED_SENTINEL : undefined,

        hydrate(data: unknown, barNs: bigint) {
            computedState = data;
        },

        appendHydrate(points: unknown, _barNs: bigint) {
            // merge points into computedState if its an object. plugins can
            // override with a custom hydrate shape.
            if (
                points &&
                typeof points === 'object' &&
                computedState &&
                typeof computedState === 'object'
            ) {
                computedState = { ...(computedState as object), ...(points as object) };
            } else if (points !== undefined) {
                computedState = points;
            }
        },

        draw(renderCtx: ChartTypeRenderContext) {
            try {
                onDrawFn!(computedState, { ...renderCtx, params: currentParams } as any);
            } catch (e) {
                emitError(`draw error: ${e}`);
            }
        },

        getAutoYBounds: getAutoYBoundsFn
            ? (tMin, tMax, horizon) => {
                  try {
                      return getAutoYBoundsFn!(tMin, tMax, horizon);
                  } catch (e) {
                      emitError(`getAutoYBounds error: ${e}`);
                      return null;
                  }
              }
            : undefined,

        onActivate: onActivateFn
            ? (activeCtx) => {
                  try {
                      onActivateFn!(activeCtx);
                  } catch (e) {
                      emitError(`onActivate error: ${e}`);
                  }
              }
            : undefined,

        onDeactivate: onDeactivateFn
            ? () => {
                  try {
                      onDeactivateFn!();
                  } catch (e) {
                      emitError(`onDeactivate error: ${e}`);
                  }
              }
            : undefined,

        onPointerDown: onPointerDownFn
            ? (event) => {
                  try {
                      return onPointerDownFn!(event);
                  } catch (e) {
                      emitError(`onPointerDown error: ${e}`);
                  }
              }
            : undefined,

        onPointerMove: onPointerMoveFn
            ? (event) => {
                  try {
                      return onPointerMoveFn!(event);
                  } catch (e) {
                      emitError(`onPointerMove error: ${e}`);
                  }
              }
            : undefined,

        onPointerUp: onPointerUpFn
            ? (event) => {
                  try {
                      return onPointerUpFn!(event);
                  } catch (e) {
                      emitError(`onPointerUp error: ${e}`);
                  }
              }
            : undefined,

        onKeyDown: onKeyDownFn
            ? (event) => {
                  try {
                      return onKeyDownFn!(event);
                  } catch (e) {
                      emitError(`onKeyDown error: ${e}`);
                  }
              }
            : undefined,

        onBarHover: onBarHoverFn
            ? (ts, price, barNs) => {
                  try {
                      onBarHoverFn!(ts, price, barNs);
                  } catch (e) {
                      emitError(`onBarHover error: ${e}`);
                  }
              }
            : undefined,

        getTooltip: getTooltipFn
            ? (ts, price) => {
                  try {
                      return getTooltipFn!(ts, price);
                  } catch (e) {
                      emitError(`getTooltip error: ${e}`);
                      return null;
                  }
              }
            : undefined,

        install(installCtx) {
            // registration happens in the capability handler, not install()
            return () => {};
        },
    };

    ctx.eventBus.emit('plugin:register-chart-type', { plugin });

    // data events drive the dedicated worker
    const offCompute = ctx.eventBus.on(
        'plugin:scripted-compute' as any,
        ({ id, ohlcv, trades, ticks, snapshots, barNs }: any) => {
            if (id !== entryId) return;
            const data = buildDataForLevel(
                decl.require ?? 'ohlcv',
                ohlcv,
                trades,
                ticks,
                snapshots,
            );
            lastComputeData = data;
            lastComputeBarNs = barNs;
            ctWorker.postMessage({
                type: 'run-init',
                pluginIndex: 0,
                data,
                barNs,
                params: { ...currentParams },
            });
        },
    );

    const offAdvance = ctx.eventBus.on(
        'plugin:scripted-advance' as any,
        ({ id, newOhlcv, newTrades, newTicks, newSnapshots, barNs, horizon }: any) => {
            if (id !== entryId) return;
            const data = buildDataForLevel(
                decl.require ?? 'ohlcv',
                newOhlcv,
                newTrades,
                newTicks,
                newSnapshots,
            );
            const newData = buildDataForLevel(
                decl.require ?? 'ohlcv',
                newOhlcv,
                newTrades,
                newTicks,
                newSnapshots,
            );
            ctWorker.postMessage({
                type: 'update',
                pluginIndex: 0,
                data,
                newData,
                barNs,
                horizon,
                params: { ...currentParams },
            });
        },
    );

    return (opts) => {
        offCompute();
        offAdvance();
        ctWorker.postMessage({ type: 'destroy' });
        ctWorker.terminate();
        ctx.eventBus.emit('plugin:unregister-chart-type', {
            id: entryId,
            hotReload: opts?.hotReload,
        });
    };
};

const extensionCapability: CapabilityHandler = (
    _worker,
    pluginMsg,
    _entryId,
    _pluginIndex,
    ctx,
    _onWorkerUpdate,
    emitError,
    getScript,
) => {
    const onInstallSrc: string | null = (pluginMsg as any).onInstallSrc ?? null;
    const drawSrc: string | null = (pluginMsg as any).extensionDrawSrc ?? null;
    if (!onInstallSrc) return () => {};

    // React and h ride on top of the script scope, so a panel can use the jsx
    // helpers and the stdlib in one expression
    const compile = makeScopedCompiler(
        getScript(),
        { React, h: React.createElement },
        emitError,
    );

    // compile the panel render fn if there is one
    const drawFn = compile<(state: unknown, ctx: PluginContext) => React.ReactNode>(drawSrc);

    // wrapper that holds state and can be updated from outside
    let externalSetState: ((s: unknown) => void) | null = null;
    let latestState: unknown = {};

    function ExtensionPanel() {
        const [state, setState] = React.useState(latestState);
        React.useEffect(() => {
            externalSetState = setState;
            return () => {
                externalSetState = null;
            };
        }, []);
        return drawFn ? (drawFn(state, ctx) as React.ReactElement) : null;
    }

    // updates state and returns the element for the first registerPanel call
    const rerender = (newState: unknown): React.ReactElement => {
        latestState = newState;
        externalSetState?.(newState);
        return React.createElement(ExtensionPanel);
    };

    let cleanup: (() => void) | void;
    try {
        const onInstall = compile<
            (
                ctx: PluginContext,
                rerender: (state: unknown) => React.ReactElement,
            ) => (() => void) | void
        >(onInstallSrc);
        cleanup = onInstall?.(ctx, rerender);
    } catch (err) {
        emitError(`extension onInstall error: ${err}`);
    }

    return (_opts) => {
        try {
            if (typeof cleanup === 'function') cleanup();
        } catch {}
    };
};

// declaration type -> handler. one entry per plugin type.

const CAPABILITY_HANDLERS: Partial<Record<ScriptDeclaration['type'], CapabilityHandler>> = {
    indicator: indicatorCapability,
    drawing: drawingCapability,
    'chart-type': chartTypeCapability,
    extension: extensionCapability,
};

/**
 * @param category Fallback picker category, used when the script doesn't declare
 *                 one itself. The built-ins pass theirs here.
 */
export function createScriptedPlugin(script: string, id?: string, category?: string): ChartPlugin {
    const pluginId = id ?? `scripted:${nanoid(8)}`;

    let pluginName = 'Plugin';
    let pluginVersion = '1.0.0';
    let pluginType = 'indicator' as PluginType;
    let pluginRequire: import('../interfaces/IDataAdapter').DataLevel | undefined = undefined;
    let pluginPermissions: Permission[] = [];
    let pluginOrigins: string[] = [];
    let pluginCategory = category ?? 'custom';

    return {
        id: pluginId,
        get name() {
            return pluginName;
        },
        get version() {
            return pluginVersion;
        },
        get type() {
            return pluginType;
        },
        code: script,
        get require() {
            return pluginRequire;
        },
        get permissions() {
            return pluginPermissions;
        },
        get origins() {
            return pluginOrigins;
        },
        get category() {
            return pluginCategory;
        },

        install(ctx: PluginContext): () => void {
            const worker = new Worker(new URL('./script.worker.ts', import.meta.url), {
                type: 'module',
            });
            let currentScript = script;
            let scriptHash = strHash(script);
            const emitError = (error: string, line?: number) =>
                ctx.eventBus.emit('plugin:script-error', { id: pluginId, error, line });

            // Per-plugin-index listeners
            const initListeners: ((pluginMsg: WorkerInitMsg['plugins'][0]) => void)[] = [];
            const initResultListeners: ((pluginMsg: WorkerInitMsg['plugins'][0]) => void)[] = [];
            const updateListeners = new Map<number, ((msg: WorkerUpdateMsg) => void)[]>();

            worker.onmessage = (e: MessageEvent) => {
                const msg = e.data;
                if (msg.type === 'error') {
                    emitError(msg.error, msg.line);
                    return;
                }
                if (msg.type === 'parsed') {
                    // fires once on parse, registers capabilities
                    for (const pluginMsg of msg.plugins) {
                        for (const cb of initListeners) cb(pluginMsg);
                    }
                    return;
                }
                if (msg.type === 'init') {
                    // fires once the user's init() has run on real data
                    for (const pluginMsg of msg.plugins) {
                        for (const cb of initResultListeners) cb(pluginMsg);
                    }
                    return;
                }
                if (msg.type === 'update') {
                    const listeners = updateListeners.get(msg.pluginIndex) ?? [];
                    for (const cb of listeners) cb(msg);
                    return;
                }
            };

            // Each capability handler registers itself for a specific pluginIndex
            const onWorkerInit = (cb: (msg: WorkerInitMsg['plugins'][0]) => void) => {
                initListeners.push(cb);
            };
            const onWorkerUpdate = (index: number, cb: (msg: WorkerUpdateMsg) => void) => {
                if (!updateListeners.has(index)) updateListeners.set(index, []);
                updateListeners.get(index)!.push(cb);
            };

            worker.postMessage({ type: 'parse', script: currentScript });

            // Hot reload
            const offUpdateCode = ctx.eventBus.on('plugin:update-code', ({ id, code }) => {
                if (id !== pluginId) return;
                const newHash = strHash(code);
                if (newHash === scriptHash) return;
                scriptHash = newHash;
                currentScript = code;
                worker.postMessage({ type: 'parse', script: currentScript });
                // recompute is emitted after the capabilities re-register
            });

            // capability handlers subscribe in the onWorkerInit callback, and get
            // called once per plugin entry in the array
            const teardowns = new Map<number, CapabilityTeardown>(); // by pluginIndex

            onWorkerInit((pluginMsg) => {
                const decl = pluginMsg.decl as ScriptDeclaration;
                const entryId = `${pluginId}:${pluginMsg.index}`;

                pluginName = decl.name;
                pluginType = decl.type;
                pluginVersion = decl?.version ?? '1.0.0';
                pluginRequire = decl?.require;
                pluginPermissions = decl?.permissions ?? [];
                pluginOrigins = decl?.origins ?? [];

                // resolve the category once here, so every capability handler
                // sees the same value on decl and none of them need the fallback
                decl.category ??= category;
                pluginCategory = decl.category ?? 'custom';

                const handler = CAPABILITY_HANDLERS[decl?.type ?? 'indicator'];
                if (!handler) {
                    emitError(`Unknown plugin type: '${decl?.type}'`);
                    return;
                }

                // tear the previous instance down before creating a new one
                const prev = teardowns.get(pluginMsg.index);
                if (prev) {
                    prev({ hotReload: true });
                }

                updateListeners.delete(pluginMsg.index);

                const teardown = handler(
                    worker,
                    pluginMsg,
                    entryId,
                    pluginMsg.index,
                    ctx,
                    (cb) => onWorkerUpdate(pluginMsg.index, cb),
                    emitError,
                    () => currentScript,
                );
                teardowns.set(pluginMsg.index, teardown); // replaces, doesnt accumulate

                ctx.eventBus.emit('plugin:scripted-recompute' as any, { id: entryId });
            });

            return () => {
                offUpdateCode();
                for (const t of teardowns.values()) t();
                worker.postMessage({ type: 'destroy' });
                worker.terminate();
            };
        },
        uninstall(_ctx) {},
    };
}
