//  Data model for chart drawings.
//
//  All coordinates are stored in *data space* (ts in nanoseconds, price as
//  number) so they remain correct after panning / zooming.
import { nanoid } from 'nanoid';

import { StorageKey, readJSON, writeJSON } from '../storage';

export type DrawingTool =
    | 'cursor'
    | 'hline'
    | 'vline'
    | 'extended-line'
    | 'line'
    | 'cross-line'
    | 'info-line'
    | 'trend-angle'
    | 'ray'
    | 'hray'
    | 'parallel-channel'
    | 'rect'
    | 'triangle'
    | 'fib'
    | 'text'
    | 'fvp'
    | 'long'
    | 'short'
    | 'flat-channel'
    | 'disjoint-channel'
    | 'regression-trend'
    | 'pitchfork'
    | 'schiff-pitchfork'
    | 'modified-schiff-pitchfork'
    | 'inside-pitchfork'
    | 'fib-extension'
    | 'fib-trend-extension'
    | 'fib-channel'
    | 'fib-time-zone'
    | 'fib-speed-fan'
    | 'fib-circles'
    | 'fib-spiral'
    | 'fib-wedge'
    | 'gann-box'
    | 'gann-square'
    | 'gann-fan'
    | 'xabcd'
    | 'cypher'
    | 'abcd'
    | 'three-drives'
    | 'head-shoulders'
    | 'triangle-pattern'
    | 'elliott-impulse'
    | 'elliott-correction'
    | 'elliott-triangle'
    | 'elliott-double-combo'
    | 'elliott-triple-combo'
    | 'rotated-rect'
    | 'ellipse'
    | 'circle'
    | 'polygon'
    | 'arc'
    | 'curve'
    | 'double-curve'
    | 'polyline'
    | 'path'
    | 'anchored-text'
    | 'note'
    | 'callout'
    | 'comment'
    | 'price-label'
    | 'signpost'
    | 'flag'
    | 'pin'
    | 'table'
    | 'arrow'
    | 'arrow-marker'
    | 'arrow-up'
    | 'arrow-down'
    | 'brush'
    | 'highlighter'
    | 'forecast'
    | 'projection'
    | 'bars-pattern'
    | 'ghost-feed'
    | 'price-range'
    | 'date-range'
    | 'date-price-range'
    | 'anchored-volume-profile'
    | 'fixed-range-volume'
    | 'anchored-vwap'
    | 'ruler';

// Every key of every drawing shape, each optional and typed as the union of the
// types it has across the shapes that declare it. Both helpers distribute over
// a *naked* type parameter - that is what makes them walk the union member by
// member instead of collapsing to the keys all members happen to share.
type AllKeys<T> = T extends any ? keyof T : never;
type ValueOfKey<T, K extends PropertyKey> = T extends any
    ? K extends keyof T
        ? T[K]
        : never
    : never;

/** A drawing of unknown tool: read any field, get `undefined` if absent. */
export type AnyDrawing = {
    [K in AllKeys<Drawing>]?: ValueOfKey<Drawing, K>;
};

/**
 * What the chart is currently armed with, or what is currently selected.
 *
 * - `name`  - the tool, `'cursor'` when nothing is armed.
 * - `id`    - identity of the drawing: the selected one, or the id the next
 *             committed drawing will carry.
 * - `state` - its fields. For an armed tool that is the style it will be
 *             created with; for a selection it is the live drawing.
 */
export type ActiveDrawingTool = {
    name: DrawingTool;
    id: string;
    state: AnyDrawing;
};

/** The idle tool. Shared so every "back to cursor" site agrees on the shape. */
export const CURSOR_TOOL: ActiveDrawingTool = { name: 'cursor', id: '', state: {} };

export type Anchor = { ts: bigint; price: number };

export type TextAlign = 'left' | 'center' | 'right';
export type VerticalAlign = 'top' | 'middle' | 'bottom';

// Shared label style carried by hline / vline / line / ray / rect
// All fields are optional so existing drawings without them keep working.
export type LabelStyle = {
    label?: string;
    labelColor?: string; // defaults to drawing color when absent
    labelFontSize?: number; // px; default 11
    labelBold?: boolean;
    labelItalic?: boolean;
    labelHorizontalAlign?: TextAlign; // within hline/rect: left | center | right
    labelVerticalAlign?: VerticalAlign; // top | middle | bottom of the shape
    labelTextOrientation?: 'horizontal' | 'vertical'; // vline only; default 'horizontal'
};

// Which handle on a drawing is being interacted with.
// 'body' = move the whole thing; 'a'/'b'/'anchor' = individual point.
// Triangle vertices: 'a' | 'b' | 'c'
// Rect corners: 'tl' | 'tr' | 'bl' | 'br'
// Rect edge midpoints: 'mt' | 'mb' | 'ml' | 'mr'
export type DrawingAnchorId =
    | 'a'
    | 'b'
    | 'c'
    | 'anchor'
    | 'body'
    | 'tl'
    | 'tr'
    | 'bl'
    | 'br'
    | 'mt'
    | 'mb'
    | 'ml'
    | 'mr'
    | 'all'
    | `a${number}`; // <- plugin anchor by index

// Return value from hitTestDrawings()
export type HitResult = {
    drawingId: string;
    anchor: DrawingAnchorId;
} | null;

// Per-tool shapes
export type HLineDrawing = {
    id: string;
    tool: 'hline';
    price: number;
    color: string;
    lineWidth: number;
    dash: number[];
    locked?: boolean;
    visible?: boolean;
} & LabelStyle;

export type VLineDrawing = {
    id: string;
    tool: 'vline';
    ts: bigint;
    color: string;
    lineWidth: number;
    dash: number[];
    locked?: boolean;
    visible?: boolean;
} & LabelStyle;

export type ExtLineDrawing = {
    id: string;
    tool: 'extended-line';
    a: Anchor;
    b: Anchor;
    color: string;
    lineWidth: number;
    dash: number[];
    extendLeft: boolean;
    extendRight: boolean;
    locked?: boolean;
    visible?: boolean;
} & LabelStyle;

export type LineDrawing = {
    id: string;
    tool: 'line';
    a: Anchor;
    b: Anchor;
    color: string;
    lineWidth: number;
    dash: number[];
    extendLeft: boolean;
    extendRight: boolean;
    locked?: boolean;
    visible?: boolean;
} & LabelStyle;

export type CrossLineDrawing = {
    id: string;
    tool: 'cross-line';
    price: number;
    ts: bigint;
    color: string;
    lineWidth: number;
    dash: number[];
    locked?: boolean;
    visible?: boolean;
} & LabelStyle;

export type InfoLineDrawing = {
    id: string;
    tool: 'info-line';
    a: Anchor;
    b: Anchor;
    color: string;
    lineWidth: number;
    dash: number[];
    extendLeft?: boolean;
    extendRight?: boolean;
    locked?: boolean;
    visible?: boolean;
} & LabelStyle;

export type TrendAngleDrawing = {
    id: string;
    tool: 'trend-angle';
    a: Anchor;
    b: Anchor;
    color: string;
    lineWidth: number;
    dash: number[];
    extendLeft?: boolean;
    extendRight?: boolean;
    locked?: boolean;
    visible?: boolean;
} & LabelStyle;

export type RayDrawing = {
    id: string;
    tool: 'ray';
    a: Anchor;
    b: Anchor;
    color: string;
    lineWidth: number;
    dash: number[];
    locked?: boolean;
    visible?: boolean;
} & LabelStyle;

export type HorzRayDrawing = {
    id: string;
    tool: 'hray';
    price: number;
    ts: bigint;
    color: string;
    lineWidth: number;
    dash: number[];
    locked?: boolean;
    visible?: boolean;
} & LabelStyle;

// One line within a parallel channel, drawn parallel to the base line and offset
// by `value` x the channel height (in price). 0 = base line, 1 = parallel line,
// 0.5 = median; values outside [0,1] extrapolate beyond the channel.
export interface ChannelLevel {
    id: string;
    value: number | string;
    color: string;
    lineWidth: number;
    dash: number[];
    enabled: boolean;
}

export type ParallelChannelDrawing = {
    id: string;
    tool: 'parallel-channel';
    a: Anchor;
    b: Anchor;
    height: number;
    enableBackground: boolean;
    backgroundColor: string;
    dash: number[];
    levels?: ChannelLevel[]; // defaults to DEFAULT_CHANNEL_LEVELS when absent
    extendLeft?: boolean;
    extendRight?: boolean;
    locked?: boolean;
    visible?: boolean;
} & LabelStyle;

export type RectDrawing = {
    id: string;
    tool: 'rect';
    a: Anchor;
    b: Anchor;
    // Border
    color: string; // legacy / border color
    borderColor?: string; // explicit border color (falls back to color)
    borderLineWidth?: number; // px; default 1
    borderDash?: number[]; // default []
    // Fill
    fillColor?: string; // explicit fill color (falls back to color)
    fillOpacity: number; // 0-1
    locked?: boolean;
    visible?: boolean;
} & LabelStyle;

export type TriangleDrawing = {
    id: string;
    tool: 'triangle';
    a: Anchor;
    b: Anchor;
    c: Anchor;
    // Border
    color: string; // legacy / border color
    borderColor?: string; // explicit border color (falls back to color)
    borderLineWidth?: number; // px; default 1
    borderDash?: number[]; // default []
    // Fill
    fillColor?: string; // explicit fill color (falls back to color)
    fillOpacity: number; // 0-1
    locked?: boolean;
    visible?: boolean;
} & LabelStyle;

export interface FibLevel {
    id: string;
    value: string;
    color: string;
    enabled: boolean;
}

export type FibDrawing = {
    id: string;
    tool: 'fib';
    a: Anchor;
    b: Anchor;
    color: string;
    levels: FibLevel[];
    locked?: boolean;
    visible?: boolean;
    extendLeft: boolean;
    extendRight: boolean;
    dash: number[];
    lineWidth: number;
    showPrices: boolean;
    showLevels: boolean;
    backgroundColor: string;
    enableBackground: boolean;
    labelAlign: string;
} & LabelStyle;

export type TextDrawing = {
    id: string;
    tool: 'text';
    anchor: Anchor;
    text: string;
    color: string;
    fontSize: number;
    bold?: boolean;
    italic?: boolean;
    textAlign?: TextAlign;
    locked?: boolean;
    visible?: boolean;
    // When true the drawing is positioned in screen-pixel space rather than
    // data space. screenX / screenY store the pixel coords (relative to the
    // top-left of the chart canvas area, excluding the y-axis). They are
    // initialised the first time the flag is toggled on and updated whenever
    // the drawing is dragged while the flag is on. The data-space `anchor` is
    // preserved so the drawing can be un-pinned back to where it originally was.
    screenAnchored?: boolean;
    screenX?: number;
    screenY?: number;
};

// Position tools (Long / Short)
//
// Geometry is stored side-agnostically: `a.price` is the entry, `upAmount` /
// `downAmount` are the price distances to the box edges above and below it, and
// a.ts / b.ts are the left and right edges (both carry the entry price).
// Which edge is the target and which is the stop follows from `tool` - a long
// targets up, a short targets down - so one set of box math drives both.
export type PositionDrawing = {
    id: string;
    a: Anchor;
    b: Anchor;
    /** Zone above the entry: target for a long, stop for a short. */
    upColor: string;
    /** Zone below the entry: stop for a long, target for a short. */
    downColor: string;
    /** Entry line + box border. */
    entryColor: string;
    upAmount: number;
    downAmount: number;
    /** Contracts/shares - sizes the order the settings bar can place. */
    qty: number;
    drawInfo: boolean;
    fontSize: number;
    textColor: string;
    locked?: boolean;
    visible?: boolean;
    extendLeft: boolean;
    extendRight: boolean;
};

export type LongDrawing = PositionDrawing & { tool: 'long' };
export type ShortDrawing = PositionDrawing & { tool: 'short' };

export type PluginDrawing = {
    id: string;
    tool: string; // matches PluginDrawingToolDef.id
    anchors: Anchor[]; // all placed anchors, in data space
    data?: unknown; // plugin's own serialized settings/state
    locked?: boolean;
    visible?: boolean;
};

export type PluginDraftDrawing = {
    tool?: undefined;
    pluginToolId: string;
    anchors: Anchor[]; // anchors placed so far
    data?: unknown;
};

// Runtime-only VP data cache (mirrors VpData from indicator-worker.ts).
export type VpDataCache = {
    prices: Float64Array;
    buyVol: Float64Array;
    sellVol: Float64Array;
    totalVol: Float64Array;
    poc: number;
};

export type FvpProfileMode = 'stacked' | 'split' | 'delta' | 'total';

export type FixedVolumeProfileDrawing = {
    id: string;
    tool: 'fvp';
    a: Anchor;
    b: Anchor;

    // Profile bars
    profileMode: FvpProfileMode;
    barsWidth: number; // 0-100 %
    barOpacity: number; // 0-100 %
    enableBuyColor: boolean;
    buyColor: string;
    enableSellColor: boolean;
    sellColor: string;
    totalColor: string; // 'total' mode + delta positive
    deltaNegColor: string; // delta negative bars
    showVolNumbers: boolean;
    volNumbersFontSize: number; // px

    // POC
    showPoc: boolean;
    pocColor: string;
    showPocLabel: boolean;
    pocExtendLeft: boolean;
    pocExtendRight: boolean;

    // Value Area
    showValueArea: boolean;
    valueAreaPct: number; // 0-100, default 70
    valueAreaFillColor: string;
    showVaHLines: boolean;
    vaLineColor: string;
    vaLineExtendLeft: boolean;
    vaLineExtendRight: boolean;

    // Developing POC / VA
    showDevPoc: boolean;
    devPocColor: string;
    showDevVa: boolean;
    devVaColor: string;

    // Background / border
    enableBg: boolean;
    bgColor: string;
    enableBorder: boolean;
    borderColor: string;
    borderDash: number[];

    highlightPocBar: boolean; // paint POC row at 1.5x bar opacity + accent stroke
    pocBarLineWidth: number; // px; accent stroke on POC bar (default 1)
    vaBarDimming: boolean; // dim bars outside VA to vaOutsideOpacityFrac
    vaOutsideDimFrac: number; // 0-1 multiplier for bars outside VA (default 0.35)
    labelPills: boolean; // draw opaque pill backgrounds behind POC/VAH/VAL text
    splitCenterLine: boolean; // draw center axis in split mode
    barGap: boolean; // 1px gap between bar rows when barH > 3

    /** Runtime-only - never serialized. */
    vpData?: VpDataCache;
} & LabelStyle;

export type Drawing =
    | HLineDrawing
    | VLineDrawing
    | ExtLineDrawing
    | LineDrawing
    | CrossLineDrawing
    | InfoLineDrawing
    | TrendAngleDrawing
    | RayDrawing
    | HorzRayDrawing
    | ParallelChannelDrawing
    | RectDrawing
    | TriangleDrawing
    | FibDrawing
    | TextDrawing
    | FixedVolumeProfileDrawing
    | LongDrawing
    | ShortDrawing
    | PluginDrawing;

// Defaults
export const DEFAULT_FIB_LEVELS: FibLevel[] = [
    { id: 'fib-0', value: '0', color: '#FFFFFF', enabled: true },
    { id: 'fib-236', value: '0.236', color: '#FFFFFF', enabled: true },
    { id: 'fib-382', value: '0.382', color: '#FFFFFF', enabled: true },
    { id: 'fib-500', value: '0.5', color: '#FFFFFF', enabled: true },
    { id: 'fib-618', value: '0.618', color: '#FFFFFF', enabled: true },
    { id: 'fib-786', value: '0.786', color: '#FFFFFF', enabled: true },
    { id: 'fib-1', value: '1', color: '#FFFFFF', enabled: true },
    { id: 'fib-2', value: '2', color: '#FFFFFF', enabled: true },
    { id: 'fib-3', value: '3', color: '#FFFFFF', enabled: true },
    { id: 'fib-4', value: '4', color: '#FFFFFF', enabled: true },
    { id: 'fib-5', value: '5', color: '#FFFFFF', enabled: true },
];

export const DEFAULT_CHANNEL_LEVELS: ChannelLevel[] = [
    { id: 'ch-base', value: 0, color: '#e0e0e0', lineWidth: 1, dash: [], enabled: true },
    { id: 'ch-mid', value: 0.5, color: '#e0e0e0', lineWidth: 1, dash: [4, 4], enabled: true },
    { id: 'ch-far', value: 1, color: '#e0e0e0', lineWidth: 1, dash: [], enabled: true },
];

export function defaultStyleForTool(tool: DrawingTool): Partial<Drawing> {
    switch (tool) {
        case 'hline':
            return { color: '#e0e0e0', lineWidth: 1, dash: [] };
        case 'vline':
            return { color: '#888888', lineWidth: 1, dash: [4, 3] };
        case 'extended-line':
            return {
                color: '#e0e0e0',
                lineWidth: 1,
                dash: [],
                extendRight: true,
                extendLeft: true,
            };
        case 'line':
            return {
                color: '#e0e0e0',
                lineWidth: 1,
                dash: [],
                extendLeft: false,
                extendRight: false,
            };
        case 'cross-line':
            return {
                color: '#e0e0e0',
                lineWidth: 1,
                dash: [],
            };
        case 'info-line':
            return {
                color: '#e0e0e0',
                lineWidth: 1,
                dash: [],
            };
        case 'trend-angle':
            return {
                color: '#e0e0e0',
                lineWidth: 1,
                dash: [],
            };
        case 'ray':
            return { color: '#e0e0e0', lineWidth: 1, dash: [] };
        case 'hray':
            return { color: '#e0e0e0', lineWidth: 1, dash: [] };
        case 'parallel-channel':
            return {
                color: '#e0e0e0',
                lineWidth: 1,
                dash: [],
                extendLeft: false,
                extendRight: false,
                levels: DEFAULT_CHANNEL_LEVELS,
                enableBackground: false,
                backgroundColor: '#e0e0e01a',
            };
        case 'rect':
            return {
                color: '#3b82f6',
                borderColor: '#3b82f6',
                borderLineWidth: 1,
                borderDash: [],
                fillColor: '#3b82f61a',
                fillOpacity: 0.08,
            };
        case 'triangle':
            return {
                color: '#3b82f6',
                borderColor: '#3b82f6',
                borderLineWidth: 1,
                borderDash: [],
                fillColor: '#3b82f61a',
                fillOpacity: 0.08,
            };
        case 'fib':
            return {
                color: '#facc15',
                levels: DEFAULT_FIB_LEVELS,
                extendLeft: false,
                extendRight: false,
                showPrices: true,
                showLevels: true,
                backgroundColor: '#ffffff1a',
                enableBackground: true,
                lineWidth: 1,
            };
        case 'text':
            return { color: '#e0e0e0', fontSize: 12 };
        case 'fvp':
            return {
                profileMode: 'stacked',
                barsWidth: 32,
                barOpacity: 60,
                enableBuyColor: true,
                buyColor: '#00e676',
                enableSellColor: true,
                sellColor: '#ff1744',
                totalColor: '#5b9cf6',
                deltaNegColor: '#ff1744',
                showVolNumbers: false,
                volNumbersFontSize: 9,
                // POC
                showPoc: true,
                pocColor: '#facc15',
                showPocLabel: true,
                pocExtendLeft: false,
                pocExtendRight: false,
                // v2.0 POC bar
                highlightPocBar: true,
                pocBarLineWidth: 1,
                // Value Area
                showValueArea: true,
                valueAreaPct: 70,
                valueAreaFillColor: '#ffffff1a',
                showVaHLines: true,
                vaLineColor: '#888888',
                vaLineExtendLeft: false,
                vaLineExtendRight: false,
                // v2.0 VA dimming
                vaBarDimming: true,
                vaOutsideDimFrac: 0.35,
                // Developing
                showDevPoc: false,
                devPocColor: '#facc15',
                showDevVa: false,
                devVaColor: '#888888',
                // Background / border
                enableBg: false,
                bgColor: '#00000026',
                enableBorder: false,
                borderColor: '#6490c8',
                borderDash: [],
                // v2.0 misc
                labelPills: true,
                splitCenterLine: true,
                barGap: true,
            } as const;
        // Position tools. upColor/downColor are keyed to screen position, so the
        // two sides invert them: green is always the zone being aimed at - above
        // the entry for a long, below it for a short. Colors are 6-digit on
        // purpose; the renderer applies its own fill/stroke alphas.
        // upAmount / downAmount are only a fallback - creation sizes the box off
        // the visible price range so the default is sane on any instrument.
        case 'long':
        case 'short': {
            const target = '#08998133';
            const stop = '#f2364533';
            return {
                upColor: tool === 'long' ? target : stop,
                downColor: tool === 'long' ? stop : target,
                entryColor: '#efefef',
                extendLeft: false,
                extendRight: false,
                upAmount: 10,
                downAmount: 5,
                qty: 1,
                drawInfo: true,
                fontSize: 11,
                textColor: '#ffffff',
            };
        }
        default:
            return {};
    }
}

/**
 * Arm a tool for creation. The id is minted here so the tool, the draft and the
 * committed drawing all share one identity - `getActiveTool().id` names the
 * drawing that is about to exist.
 */
export function armTool(tool: DrawingTool, style?: Partial<Drawing>): ActiveDrawingTool {
    return {
        name: tool,
        id: nanoid(),
        state: { ...(defaultStyleForTool(tool) as AnyDrawing), ...(style as AnyDrawing) },
    };
}

/** Describe an existing drawing in the same shape an armed tool uses. */
export function toolFromDrawing(d: Drawing): ActiveDrawingTool {
    return { name: d.tool as DrawingTool, id: d.id, state: d as AnyDrawing };
}

export const HIT_TOLERANCE_PX = 7;

// Draft
export type DraftDrawing =
    | { tool: 'hline'; price: number }
    | { tool: 'vline'; ts: bigint }
    | { tool: 'hray' | 'cross-line'; price: number; ts: bigint }
    | {
          tool: 'line' | 'ray' | 'extended-line' | 'info-line' | 'trend-angle' | 'parallel-channel';
          a: Anchor;
          b: Anchor | null;
      }
    | { tool: 'rect' | 'fib'; a: Anchor; b: Anchor | null }
    // While placing: `a` is the first vertex, `b` the second (null until the
    // second click); the third vertex tracks the cursor until the final click.
    | { tool: 'triangle'; a: Anchor; b: Anchor | null }
    | { tool: 'text'; anchor: Anchor }
    | { tool: 'fvp'; a: Anchor; b: Anchor | null }
    | PluginDraftDrawing;

// Style templates
export type DrawingStyleTemplate = {
    id: string;
    name: string;
    tool: DrawingTool;
    style: Partial<Drawing>;
    createdAt: number;
};

export function loadTemplates(): DrawingStyleTemplate[] {
    const templates = readJSON<unknown>(StorageKey.drawingTemplates, null);
    return Array.isArray(templates) ? (templates as DrawingStyleTemplate[]) : [];
}

export function saveTemplate(tpl: DrawingStyleTemplate): void {
    const templates = loadTemplates().filter((t) => t.id !== tpl.id);
    templates.push(tpl);
    writeJSON(StorageKey.drawingTemplates, templates);
}

export function deleteTemplate(id: string): void {
    writeJSON(
        StorageKey.drawingTemplates,
        loadTemplates().filter((t) => t.id !== id),
    );
}
