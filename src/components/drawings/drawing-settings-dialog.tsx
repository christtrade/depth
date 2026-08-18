'use client';

import { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import { cn } from '../../lib/utils';
import {
    X,
    Palette,
    MapPin,
    Type,
    Eye,
    BookMarked,
    Trash2,
    Check,
    AlignLeft,
    AlignCenter,
    AlignRight,
    AlignStartVertical,
    AlignCenterVertical,
    AlignEndVertical,
    RotateCcw,
    Save,
    Lock,
    Bold,
    Italic,
    EyeOff,
    ChevronDown,
} from 'lucide-react';
import { Switch } from '../ui/switch';
import type {
    Drawing,
    DrawingTool,
    TextAlign,
    VerticalAlign,
    DrawingStyleTemplate,
    FibLevel,
    ChannelLevel,
} from '../../lib/types/drawing-types';
import {
    defaultStyleForTool,
    loadTemplates,
    saveTemplate,
    deleteTemplate,
    DEFAULT_CHANNEL_LEVELS,
} from '../../lib/types/drawing-types';
import { nanoid } from 'nanoid';
import { drawingRegistry } from '../../core/DrawingRegistry';
import { ColorPicker as ColorPickerReact } from '../ui/color-picker';
import { Slider } from '../ui/slider';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Button } from '../ui/button';

export type StyleField =
    | { type: 'color'; key: string; label: string; disabledWhenFalse?: string }
    | { type: 'lineWidth'; key: string; label: string }
    | { type: 'dash'; key: string; label: string }
    | { type: 'opacity'; key: string; label: string }
    | { type: 'fontSize'; key: string; label: string }
    | {
          type: 'slider';
          key: string;
          label: string;
          max: number;
          min: number;
          step: number;
          step1: string;
          step2: string;
          step3: string;
          prefix?: string;
          suffix?: string;
      }
    | { type: 'extend'; leftKey: string; rightKey: string; label: string }
    | { type: 'toggle'; key: string; label: string }
    | { type: 'customLevels'; label: string }
    | { type: 'channelLevels'; label: string }
    | {
          type: 'numberInput';
          key: string;
          label: string;
          min?: number;
          max?: number;
          step?: number;
          unit?: string;
      }
    | { type: 'textInput'; key: string; label: string; placeholder?: string; maxLength?: number }
    | { type: 'select'; key: string; label: string; options: { value: string; label: string }[] }
    | {
          type: 'buttonGroup';
          key: string;
          label: string;
          options: { value: string; label: string; icon?: React.ReactNode }[];
      }
    | { type: 'stepperInt'; key: string; label: string; min?: number; max?: number; step?: number }
    | {
          type: 'rangeWithSteps';
          key: string;
          label: string;
          min: number;
          max: number;
          steps: { value: number; label: string }[];
      }
    | {
          type: 'dualColor';
          keyA: string;
          labelA: string;
          keyB: string;
          labelB: string;
          label: string;
      }
    | {
          type: 'dualOpacity';
          keyA: string;
          labelA: string;
          keyB: string;
          labelB: string;
          label: string;
      }
    | { type: 'colorGradient'; keyStart: string; keyEnd: string; label: string }
    | {
          type: 'marginInput';
          keys: { top: string; right: string; bottom: string; left: string };
          label: string;
          unit?: string;
      }
    | { type: 'anchorAlign'; key: string; label: string }
    | { type: 'capStyle'; key: string; label: string }
    | { type: 'joinStyle'; key: string; label: string }
    | { type: 'arrowHead'; startKey: string; endKey: string; label: string }
    | { type: 'checkbox'; key: string; label: string; description?: string }
    | {
          type: 'toggledInput';
          toggleKey: string;
          toggleLabel: string;
          inputKey: string;
          inputLabel: string;
          min?: number;
          max?: number;
          step?: number;
          unit?: string;
      }
    | {
          type: 'colorWithOpacity';
          colorKey: string;
          opacityKey: string;
          label: string;
      }
    | {
          type: 'toggledColor';
          toggleKey: string;
          colorKey: string;
          label: string;
      }
    | {
          type: 'inlineFields';
          label: string;
          fields: //@ts-ignore
              | Array
              | {
                    type: 'stepperInt';
                    key: string;
                    label: string;
                    min?: number;
                    max?: number;
                    step?: number;
                }
              | {
                    type: 'buttonGroup';
                    key: string;
                    options: { value: string; label: string; icon?: React.ReactNode }[];
                }
              | { type: 'checkbox'; key: string; label: string };
      };

// one builder per StyleField variant, so a schema below reads as a list of
// fields rather than object literals. exported because theyre the vocabulary for
// writing one - not every variant is used by the built-in drawings, and thats
// fine, dont prune them.

export const color = (key: string, label = 'Color', disabledWhenFalse?: string): StyleField => ({
    type: 'color',
    key,
    label,
    ...(disabledWhenFalse ? { disabledWhenFalse } : {}),
});
export const lineWidth = (key: string, label = 'Line width'): StyleField => ({
    type: 'lineWidth',
    key,
    label,
});
export const dash = (key: string, label = 'Line style'): StyleField => ({ type: 'dash', key, label });
export const opacity = (key: string, label: string): StyleField => ({ type: 'opacity', key, label });
export const fontSize = (key: string, label: string): StyleField => ({ type: 'fontSize', key, label });
export const slider = (
    key: string,
    label: string,
    max: number,
    min: number,
    step: number,
    step1: string,
    step2: string,
    step3: string,
    prefix?: string,
    suffix?: string,
): StyleField => ({
    type: 'slider',
    key,
    label,
    max,
    min,
    step,
    step1,
    step2,
    step3,
    prefix,
    suffix,
});
export const extend = (leftKey: string, rightKey: string, label = 'Extend'): StyleField => ({
    type: 'extend',
    leftKey,
    rightKey,
    label,
});
export const toggle = (key: string, label: string): StyleField => ({ type: 'toggle', key, label });

export const numberInput = (
    key: string,
    label: string,
    opts?: { min?: number; max?: number; step?: number; unit?: string },
): StyleField => ({ type: 'numberInput', key, label, ...opts });
export const textInput = (
    key: string,
    label: string,
    opts?: { placeholder?: string; maxLength?: number },
): StyleField => ({ type: 'textInput', key, label, ...opts });
export const select = (
    key: string,
    label: string,
    options: { value: string; label: string }[],
): StyleField => ({ type: 'select', key, label, options });
export const buttonGroup = (
    key: string,
    label: string,
    options: { value: string; label: string; icon?: React.ReactNode }[],
): StyleField => ({ type: 'buttonGroup', key, label, options });
export const stepperInt = (
    key: string,
    label: string,
    opts?: { min?: number; max?: number; step?: number },
): StyleField => ({ type: 'stepperInt', key, label, ...opts });
export const rangeWithSteps = (
    key: string,
    label: string,
    min: number,
    max: number,
    steps: { value: number; label: string }[],
): StyleField => ({ type: 'rangeWithSteps', key, label, min, max, steps });
export const dualColor = (
    keyA: string,
    labelA: string,
    keyB: string,
    labelB: string,
    label: string,
): StyleField => ({ type: 'dualColor', keyA, labelA, keyB, labelB, label });
export const dualOpacity = (
    keyA: string,
    labelA: string,
    keyB: string,
    labelB: string,
    label: string,
): StyleField => ({ type: 'dualOpacity', keyA, labelA, keyB, labelB, label });
export const colorGradient = (keyStart: string, keyEnd: string, label: string): StyleField => ({
    type: 'colorGradient',
    keyStart,
    keyEnd,
    label,
});
export const marginInput = (
    keys: { top: string; right: string; bottom: string; left: string },
    label: string,
    unit?: string,
): StyleField => ({ type: 'marginInput', keys, label, unit });
export const anchorAlign = (key: string, label = 'Anchor'): StyleField => ({
    type: 'anchorAlign',
    key,
    label,
});
export const capStyle = (key: string, label = 'Line cap'): StyleField => ({
    type: 'capStyle',
    key,
    label,
});
export const joinStyle = (key: string, label = 'Line join'): StyleField => ({
    type: 'joinStyle',
    key,
    label,
});
export const arrowHead = (startKey: string, endKey: string, label = 'Arrow heads'): StyleField => ({
    type: 'arrowHead',
    startKey,
    endKey,
    label,
});
export const checkbox = (key: string, label: string, description?: string): StyleField => ({
    type: 'checkbox',
    key,
    label,
    description,
});
export const toggledInput = (
    toggleKey: string,
    toggleLabel: string,
    inputKey: string,
    inputLabel: string,
    opts?: { min?: number; max?: number; step?: number; unit?: string },
): StyleField => ({ type: 'toggledInput', toggleKey, toggleLabel, inputKey, inputLabel, ...opts });

export const colorWithOpacity = (colorKey: string, opacityKey: string, label: string): StyleField => ({
    type: 'colorWithOpacity',
    colorKey,
    opacityKey,
    label,
});

export const toggledColor = (toggleKey: string, colorKey: string, label: string): StyleField => ({
    type: 'toggledColor',
    toggleKey,
    colorKey,
    label,
});

export const inlineFields = (
    label: string,
    fields: Extract<StyleField, { type: 'inlineFields' }>['fields'],
): StyleField => ({ type: 'inlineFields', label, fields });

function snapToStep(v: number, step: number): number {
    const decimals = (String(step).split('.')[1] ?? '').length;
    return decimals === 0 ? Math.round(v) : Number(v.toFixed(decimals));
}

// only some variants carry a plain `key`; the compound ones name their halves
// instead, so fall back through those before giving up on the index
export function fieldKey(field: StyleField, i: number): string {
    const f = field as Record<string, string | undefined>;
    return (
        f.key ??
        f.keyA ??
        f.keyStart ??
        f.colorKey ??
        f.toggleKey ??
        f.leftKey ??
        f.startKey ??
        `${field.type}-${i}`
    );
}

const STYLE_SCHEMA: Partial<Record<DrawingTool, StyleField[]>> = {
    hline: [color('color'), lineWidth('lineWidth'), dash('dash')],
    vline: [color('color'), lineWidth('lineWidth'), dash('dash')],
    'extended-line': [
        color('color'),
        lineWidth('lineWidth'),
        dash('dash'),
        extend('extendLeft', 'extendRight'),
    ],
    line: [
        color('color'),
        lineWidth('lineWidth'),
        dash('dash'),
        extend('extendLeft', 'extendRight'),
    ],
    'cross-line': [color('color'), lineWidth('lineWidth'), dash('dash')],
    'info-line': [color('color'), lineWidth('lineWidth'), dash('dash')],
    'trend-angle': [color('color'), lineWidth('lineWidth'), dash('dash')],
    ray: [color('color'), lineWidth('lineWidth'), dash('dash')],
    hray: [color('color'), lineWidth('lineWidth'), dash('dash')],
    'parallel-channel': [
        { type: 'channelLevels', label: 'Levels' } as StyleField,
        extend('extendLeft', 'extendRight'),
        toggledColor('enableBackground', 'backgroundColor', 'Background'),
    ],
    rect: [
        color('borderColor', 'Border color'),
        lineWidth('borderLineWidth', 'Border width'),
        dash('borderDash', 'Border style'),
        color('fillColor', 'Fill color'),
    ],
    triangle: [
        color('borderColor', 'Border color'),
        lineWidth('borderLineWidth', 'Border width'),
        dash('borderDash', 'Border style'),
        color('fillColor', 'Fill color'),
    ],
    fib: [
        lineWidth('lineWidth'),
        dash('dash'),
        extend('extendLeft', 'extendRight'),
        toggle('showLevels', 'Show Level Values'),
        toggle('showPrices', 'Show Prices'),
        fontSize('labelFontSize', 'Label font size'),
        buttonGroup('labelAlign', 'Label position', [
            { value: 'left', label: 'Left' },
            { value: 'right', label: 'Right' },
        ]),
        toggle('labelBold', 'Bold labels'),
        { type: 'customLevels', label: 'Levels' } as StyleField,
        toggledColor('enableBackground', 'backgroundColor', 'Background'),
    ],
    text: [
        color('color'),
        fontSize('fontSize', 'Font size'),
        toggle('screenAnchored', 'Pin to screen'),
    ],
    fvp: [
        buttonGroup('profileMode', 'Profile Mode', [
            { value: 'stacked', label: 'Stacked' },
            { value: 'split', label: 'Split' },
            { value: 'delta', label: 'Delta' },
            { value: 'total', label: 'Total' },
        ]),
        slider('barsWidth', 'Bar Width', 100, 0, 1, '0%', '50%', '100%', '', '%'),
        slider('barOpacity', 'Bar Opacity', 100, 0, 1, '0%', '50%', '100%', '', '%'),
        dualColor('buyColor', 'Buy', 'sellColor', 'Sell', 'Buy / Sell Colors'),
        dualColor('totalColor', 'Positive', 'deltaNegColor', 'Negative', 'Total / Delta Colors'),
        toggle('barGap', 'Bar row gap'),
        toggle('splitCenterLine', 'Split center axis'),
        toggle('showVolNumbers', 'Show Volume Numbers'),
        slider('volNumbersFontSize', 'Numbers Size', 16, 7, 1, '7', '11', '16', '', 'px'),

        color('pocColor', 'POC Color'),
        toggle('showPoc', 'Show POC Line'),
        toggle('showPocLabel', 'Show POC Label'),
        toggledInput(
            'highlightPocBar',
            'Highlight POC Bar',
            'pocBarLineWidth',
            'Accent line width',
            { min: 1, max: 4, step: 1, unit: 'px' },
        ),
        extend('pocExtendLeft', 'pocExtendRight', 'Extend POC'),

        toggle('showValueArea', 'Show Value Area'),
        slider('valueAreaPct', 'Value Area %', 100, 0, 1, '0%', '70%', '100%', '', '%'),
        color('valueAreaFillColor', 'VA Fill'),
        toggledInput('vaBarDimming', 'Dim bars outside VA', 'vaOutsideDimFrac', 'Outside opacity', {
            min: 0,
            max: 1,
            step: 0.05,
            unit: 'x',
        }),
        toggle('showVaHLines', 'Show VAH / VAL Lines'),
        color('vaLineColor', 'VAH/VAL Color'),
        extend('vaLineExtendLeft', 'vaLineExtendRight', 'Extend VA Lines'),

        toggle('labelPills', 'Label pill backgrounds'),

        toggle('showDevPoc', 'Developing POC'),
        color('devPocColor', 'Dev POC Color'),
        toggle('showDevVa', 'Developing VA'),
        color('devVaColor', 'Dev VA Color'),

        toggledColor('enableBg', 'bgColor', 'Background'),
        toggledColor('enableBorder', 'borderColor', 'Border'),
        dash('borderDash', 'Border Style'),
    ],
    long: [
        color('upColor', 'Target Color'),
        color('downColor', 'Stop Color'),
        color('entryColor', 'Entry Color'),
        numberInput('qty', 'Quantity', { min: 0, step: 1 }),
        toggle('drawInfo', 'Show Info'),
        fontSize('fontSize', 'Text Size'),
        color('textColor', 'Text Color'),
    ],
    short: [
        color('downColor', 'Target Color'),
        color('upColor', 'Stop Color'),
        color('entryColor', 'Entry Color'),
        numberInput('qty', 'Quantity', { min: 0, step: 1 }),
        toggle('drawInfo', 'Show Info'),
        fontSize('fontSize', 'Text Size'),
        color('textColor', 'Text Color'),
    ],
};


const DIALOG_W = 480;
const VIEWPORT_PADDING = 12;

const PRESET_COLORS = [
    '#e0e0e0',
    '#ef4444',
    '#f97316',
    '#eab308',
    '#22c55e',
    '#3b82f6',
    '#a855f7',
    '#ec4899',
    '#00e676',
    '#ff1744',
    '#facc15',
    '#38bdf8',
    '#84cc16',
    '#f43f5e',
    '#06b6d4',
    '#8b5cf6',
];

const DASH_PRESETS: { label: string; value: string; dash: number[] }[] = [
    { label: 'Solid', value: 'solid', dash: [] },
    { label: 'Dashed', value: 'dashed', dash: [6, 3] },
    { label: 'Dotted', value: 'dotted', dash: [2, 3] },
    { label: 'Dash-dot', value: 'dashdot', dash: [8, 3, 2, 3] },
];

const TOOL_LABELS: Record<DrawingTool, string> = {
    cursor: 'Cursor',
    hline: 'Horizontal Line',
    vline: 'Vertical Line',
    'extended-line': 'Extended Line',
    line: 'Line Segment',
    'cross-line': 'Cross Line',
    'info-line': 'Info Line',
    'trend-angle': 'Trend Angle',
    ray: 'Ray',
    hray: 'Horizontal Ray',
    'parallel-channel': 'Parallel Channel',
    rect: 'Rectangle',
    triangle: 'Triangle',
    fib: 'Fibonacci',
    text: 'Text Label',
    fvp: 'Fixed Volume Profile',
    long: 'Long Position',
    short: 'Short Position',
    'flat-channel': 'flat-channel',
    'disjoint-channel': 'disjoint-channel',
    'regression-trend': 'regression-trend',
    'pitchfork': 'pitchfork',
    'schiff-pitchfork': 'schiff-pitchfork',
    'modified-schiff-pitchfork': 'modified-schiff-pitchfork',
    'inside-pitchfork': 'inside-pitchfork',
    'fib-extension': 'fib-extension',
    'fib-trend-extension': 'fib-trend-extension',
    'fib-channel': 'fib-channel',
    'fib-time-zone': 'fib-time-zone',
    'fib-speed-fan': 'fib-speed-fan',
    'fib-circles': 'fib-circles',
    'fib-spiral': 'fib-spiral',
    'fib-wedge': 'fib-wedge',
    'gann-box': 'gann-box',
    'gann-square': 'gann-square',
    'gann-fan': 'gann-fan',
    'xabcd': 'xabcd',
    'cypher': 'cypher',
    'abcd': 'abcd',
    'three-drives': 'three-drives',
    'head-shoulders': 'head-shoulders',
    'triangle-pattern': 'triangle-pattern',
    'elliott-impulse': 'elliott-impulse',
    'elliott-correction': 'elliott-correction',
    'elliott-triangle': 'elliott-triangle',
    'elliott-double-combo': 'elliott-double-combo',
    'elliott-triple-combo': 'elliott-triple-combo',
    'rotated-rect': 'rotated-rect',
    'ellipse': 'ellipse',
    'circle': 'circle',
    'polygon': 'polygon',
    'arc': 'arc',
    'curve': 'curve',
    'double-curve': 'double-curve',
    'polyline': 'polyline',
    'path': 'path',
    'anchored-text': 'anchored-text',
    'note': 'note',
    'callout': 'callout',
    'comment': 'comment',
    'price-label': 'price-label',
    'signpost': 'signpost',
    'flag': 'flag',
    'pin': 'pin',
    'table': 'table',
    'arrow': 'arrow',
    'arrow-marker': 'arrow-marker',
    'arrow-up': 'arrow-up',
    'arrow-down': 'arrow-down',
    'brush': 'brush',
    'highlighter': 'highlighter',
    'forecast': 'forecast',
    'projection': 'projection',
    'bars-pattern': 'bars-pattern',
    'ghost-feed': 'ghost-feed',
    'price-range': 'price-range',
    'date-range': 'date-range',
    'date-price-range': 'date-price-range',
    'anchored-volume-profile': 'anchored-volume-profile',
    'fixed-range-volume': 'fixed-range-volume',
    'anchored-vwap': 'anchored-vwap',
    'ruler': 'ruler'
};

let _rememberedPos: { x: number; y: number } | null = null;

function defaultPos(): { x: number; y: number } {
    return {
        x: Math.round((window.innerWidth - DIALOG_W) / 2),
        y: Math.round(window.innerHeight * 0.1),
    };
}

function clampTop(y: number, h: number): number {
    const maxY = window.innerHeight - h - VIEWPORT_PADDING;
    return Math.min(Math.max(VIEWPORT_PADDING, y), Math.max(VIEWPORT_PADDING, maxY));
}
function clampLeft(x: number): number {
    return Math.max(VIEWPORT_PADDING, Math.min(window.innerWidth - DIALOG_W - VIEWPORT_PADDING, x));
}


function formatTs(ts: bigint): string {
    const ms = Number(ts / 1_000_000n);
    if (!isFinite(ms) || ms <= 0) return ts.toString();
    try {
        return new Date(ms).toISOString().replace('T', ' ').slice(0, 23);
    } catch {
        return ts.toString();
    }
}

function parseTs(str: string): bigint | null {
    const s = str.trim();

    const normalized = s.includes('Z') || s.includes('+') ? s : s.replace(' ', 'T') + 'Z';

    const ms = Date.parse(normalized);

    if (!isNaN(ms)) return BigInt(ms) * 1_000_000n;

    try {
        return BigInt(s);
    } catch {
        return null;
    }
}

type Tab = 'style' | 'coordinates' | 'text' | 'visibility' | 'templates';

interface DrawingSettingsDialogProps {
    drawing: Drawing;
    onUpdate: (patch: Partial<Drawing>) => void;
    onClose: () => void;
    onMouseEnter?: () => void;
    onMouseLeave?: () => void;
}


export function DrawingSettingsDialog({
    drawing,
    onUpdate,
    onClose,
    onMouseEnter,
    onMouseLeave,
}: DrawingSettingsDialogProps) {
    const [tab, setTab] = useState<Tab>('style');
    const tabsRef = useRef<HTMLDivElement | null>(null);
    const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
    const [templates, setTemplates] = useState<DrawingStyleTemplate[]>(() =>
        loadTemplates().filter((t) => t.tool === drawing.tool),
    );
    const [newTplName, setNewTplName] = useState('');
    const [savedFlash, setSavedFlash] = useState(false);
    const dialogRef = useRef<HTMLDivElement>(null);

    const posRef = useRef<{ x: number; y: number }>(
        _rememberedPos ?? (typeof window !== 'undefined' ? defaultPos() : { x: 80, y: 80 }),
    );
    const [, forceRender] = useState(0);

    useLayoutEffect(() => {
        const el = dialogRef.current;
        if (!el) return;
        const clamped = clampTop(posRef.current.y, el.offsetHeight);
        if (clamped !== posRef.current.y) {
            posRef.current = { ...posRef.current, y: clamped };
            _rememberedPos = posRef.current;
            forceRender((n) => n + 1);
        }
    });

    const onHeaderMouseDown = useCallback((e: React.MouseEvent) => {
        if ((e.target as HTMLElement).closest('button')) return;
        e.preventDefault();
        e.stopPropagation();
        const sx = e.clientX,
            sy = e.clientY;
        const ox = posRef.current.x,
            oy = posRef.current.y;
        const onMove = (ev: MouseEvent) => {
            const h = dialogRef.current?.offsetHeight ?? 0;
            posRef.current = {
                x: clampLeft(ox + ev.clientX - sx),
                y: clampTop(oy + ev.clientY - sy, h),
            };
            _rememberedPos = posRef.current;
            forceRender((n) => n + 1);
        };
        const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, []);

    const handleClose = useCallback(() => {
        onMouseLeave?.();
        onClose();
    }, [onClose, onMouseLeave]);

    useEffect(() => {
        const h = (e: KeyboardEvent) => {
            if (e.key === 'Escape') handleClose();
        };
        window.addEventListener('keydown', h);
        return () => window.removeEventListener('keydown', h);
    }, [handleClose]);

    const flashSaved = () => {
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 1200);
    };

    const d = drawing as any;
    const locked: boolean = d.locked ?? false;

    // a plugin drawing keeps its settings in its own `data` rather than flat on
    // the drawing, and only has the keys its tool declared back when it was
    // placed - so the tool's defaults go underneath
    const pluginTool = drawingRegistry.get(drawing.tool);
    const pluginDefaults = (pluginTool?.defaultData ?? {}) as Record<string, unknown>;
    const pluginData: Record<string, unknown> = { ...pluginDefaults, ...(d.data ?? {}) };
    const updatePluginData = (patch: Record<string, unknown>) =>
        onUpdate({ data: { ...pluginData, ...patch } } as Partial<Drawing>);

    const isTextTool = drawing.tool === 'text';
    const textContent: string = d.text ?? '';
    const textAlign: TextAlign = d.textAlign ?? 'left';
    const textFontSize: number = d.fontSize ?? 12;
    const textBold: boolean = d.bold ?? false;
    const textItalic: boolean = d.italic ?? false;

    const supportsLabel =
        !isTextTool &&
        drawing.tool !== 'fib' &&
        drawing.tool !== 'fvp' &&
        drawing.tool !== 'cursor';
    const label: string = d.label ?? '';
    const labelColor: string = d.labelColor ?? '#e0e0e0';
    const labelFontSize: number = d.labelFontSize ?? 11;
    const labelBold: boolean = d.labelBold ?? false;
    const labelItalic: boolean = d.labelItalic ?? false;
    const labelHorizontalAlign: TextAlign = d.labelHorizontalAlign ?? 'left';
    const labelVerticalAlign: VerticalAlign = d.labelVerticalAlign ?? 'top';
    const labelTextOrientation: 'horizontal' | 'vertical' = d.labelTextOrientation ?? 'horizontal';

    const hasAnchors = ['line', 'ray', 'rect', 'fib', 'fvp'].includes(drawing.tool);
    const hasSingleAnchor = drawing.tool === 'text';

    const handleSaveTemplate = () => {
        if (!newTplName.trim()) return;
        const keys = [
            'color',
            'lineWidth',
            'dash',
            'fillOpacity',
            'fontSize',
            'extendLeft',
            'extendRight',
            'levels',
            'labelColor',
            'labelFontSize',
            'labelBold',
            'labelItalic',
            'labelHorizontalAlign',
            'labelVerticalAlign',
            'labelTextOrientation',
            'bold',
            'italic',
        ];
        const style: any = {};
        for (const k of keys) if (d[k] !== undefined) style[k] = d[k];
        saveTemplate({
            id: nanoid(8),
            name: newTplName.trim(),
            tool: drawing.tool as DrawingTool,
            style,
            createdAt: Date.now(),
        });
        setTemplates(loadTemplates().filter((t) => t.tool === drawing.tool));
        setNewTplName('');
        flashSaved();
    };
    const handleDeleteTemplate = (id: string) => {
        deleteTemplate(id);
        setTemplates(loadTemplates().filter((t) => t.tool === drawing.tool));
    };
    const handleApplyTemplate = (tpl: DrawingStyleTemplate) => {
        onUpdate(tpl.style as Partial<Drawing>);
        flashSaved();
    };
    const handleResetStyle = () =>
        pluginTool
            ? onUpdate({ data: { ...pluginDefaults } } as Partial<Drawing>)
            : onUpdate(defaultStyleForTool(drawing.tool as DrawingTool) as Partial<Drawing>);

    const allTabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
        { id: 'style', label: 'Style', icon: <Palette size={13} /> },
        { id: 'coordinates', label: 'Coordinates', icon: <MapPin size={13} /> },
        { id: 'text', label: 'Text', icon: <Type size={13} /> },
        { id: 'visibility', label: 'Visibility', icon: <Eye size={13} /> },
        { id: 'templates', label: 'Templates', icon: <BookMarked size={13} /> },
    ];
    // coordinates, text and templates are all keyed off built-in drawing fields
    // a plugin drawing doesnt have
    const tabs = pluginTool
        ? allTabs.filter((t) => t.id === 'style' || t.id === 'visibility')
        : allTabs;
    const activeIdx = Math.max(
        0,
        tabs.findIndex((t) => t.id === tab),
    );
    const activeTabEl = tabRefs.current[activeIdx];

    return (
        <>
            <style>{`
                @keyframes dlg-in { from{opacity:0;transform:scale(0.94)} to{opacity:1;transform:scale(1)} }
                .dlg-enter { animation: dlg-in 160ms cubic-bezier(0.16,1,0.3,1) both; transform-origin: top left; }
            `}</style>

            <div
                ref={dialogRef}
                className="dlg-enter fixed z-[200] flex flex-col rounded-xl border border-white/10  bg-[#14161b]/90 backdrop-blur-lg shadow-2xl overflow-hidden"
                style={{
                    left: posRef.current.x,
                    top: posRef.current.y,
                    width: DIALOG_W,
                    maxHeight: `calc(100vh - ${posRef.current.y + VIEWPORT_PADDING}px)`,
                }}
                onMouseDown={(e) => e.stopPropagation()}
                onMouseEnter={onMouseEnter}
                onMouseLeave={onMouseLeave}
            >
                <div
                    className="flex items-center gap-2 px-4 pt-4 pb-3 border-b border-white/6 shrink-0 cursor-grab active:cursor-grabbing select-none"
                    onMouseDown={onHeaderMouseDown}
                >
                    <div className="flex-1 min-w-0">
                        <h2 className="text-sm font-semibold text-white tracking-tight">
                            {TOOL_LABELS[drawing.tool] ?? pluginTool?.name ?? 'Drawing'}
                        </h2>
                        <p className="text-[11px] text-white/40 mt-0.5">Drawing settings</p>
                    </div>
                    <button
                        className="p-1.5 rounded-lg hover:bg-white/10 text-white/40 hover:text-white transition-colors shrink-0 cursor-pointer"
                        onClick={handleClose}
                    >
                        <X size={14} />
                    </button>
                </div>

                <div
                    className="flex gap-0.5 px-4 pt-2 pb-0 shrink-0 border-b border-white/6 relative"
                    ref={tabsRef}
                >
                    {tabs.map((t, i) => (
                        <button
                            key={t.id}
                            //@ts-ignore
                            ref={(el) => (tabRefs.current[i] = el)}
                            onClick={() => setTab(t.id)}
                            className={cn(
                                'flex items-center gap-1.5 px-3 py-2 text-[11px] font-medium rounded-t transition-colors border-b-2 -mb-px',
                                tab === t.id
                                    ? 'text-white bg-white/5'
                                    : 'text-white/40 border-transparent hover:text-white/70 hover:bg-white/5',
                            )}
                        >
                            {t.icon}
                            {t.label}
                        </button>
                    ))}
                    <div
                        className="absolute bottom-0 left-0 border-b-2 border-blue-500 transition-all duration-200"
                        style={{
                            width: activeTabEl?.clientWidth ?? 0,
                            transform: `translateX(${activeTabEl?.offsetLeft ?? 0}px)`,
                        }}
                    />
                </div>

                <div className="flex-1 overflow-y-auto px-5 py-4 min-h-0">
                    {tab === 'style' && (
                        <div className="flex flex-col gap-5">
                            {pluginTool
                                ? (pluginTool.settingsSchema ?? []).map((field, i) => (
                                      <StyleFieldControl
                                          key={fieldKey(field, i)}
                                          field={field}
                                          drawing={pluginData}
                                          onUpdate={updatePluginData}
                                      />
                                  ))
                                : (STYLE_SCHEMA[drawing.tool] ?? []).map((field, i) => (
                                      <StyleFieldControl
                                          key={fieldKey(field, i)}
                                          field={field}
                                          drawing={d}
                                          onUpdate={onUpdate}
                                      />
                                  ))}
                            {pluginTool && !pluginTool.settingsSchema?.length && (
                                <div className="flex flex-col items-center gap-2 py-6 text-white/25">
                                    <Palette size={22} strokeWidth={1.2} />
                                    <p className="text-[11px] text-center">
                                        {pluginTool.name} doesn&apos;t have any settings.
                                    </p>
                                </div>
                            )}
                            {(!pluginTool || !!pluginTool.settingsSchema?.length) && (
                                <button
                                    className="flex items-center gap-2 text-[11px] text-white/30 hover:text-white/60 transition-colors mt-1"
                                    onClick={handleResetStyle}
                                >
                                    <RotateCcw size={11} /> Reset to defaults
                                </button>
                            )}
                        </div>
                    )}

                    {tab === 'coordinates' && (
                        <div className="flex flex-col gap-4">
                            {drawing.tool === 'hline' && (
                                <CoordRow label="Price">
                                    <PriceInput
                                        value={(drawing as any).price}
                                        onChange={(v) => onUpdate({ price: v } as any)}
                                    />
                                </CoordRow>
                            )}
                            {drawing.tool === 'vline' && (
                                <CoordRow label="Time">
                                    <TsInput
                                        value={(drawing as any).ts}
                                        onChange={(v) => onUpdate({ ts: v } as any)}
                                    />
                                </CoordRow>
                            )}
                            {hasAnchors && (
                                <>
                                    <AnchorSection
                                        label="Point A"
                                        anchor={(drawing as any).a}
                                        onChange={(a) => onUpdate({ a } as any)}
                                    />
                                    <AnchorSection
                                        label="Point B"
                                        anchor={(drawing as any).b}
                                        onChange={(b) => onUpdate({ b } as any)}
                                    />
                                </>
                            )}
                            {hasSingleAnchor && (
                                <AnchorSection
                                    label="Anchor"
                                    anchor={(drawing as any).anchor}
                                    onChange={(anchor) => onUpdate({ anchor } as any)}
                                />
                            )}
                            <p className="text-[10px] text-white/25 mt-1">
                                Timestamps are in UTC. Enter as ISO date or raw nanoseconds.
                            </p>
                        </div>
                    )}

                    {tab === 'text' && (
                        <div className="flex flex-col gap-5">
                            {isTextTool && (
                                <>
                                    <Section label="Content">
                                        <textarea
                                            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[12px] text-white focus:outline-none focus:border-blue-500/60 resize-none placeholder:text-white/20"
                                            rows={3}
                                            value={textContent}
                                            onChange={(e) =>
                                                onUpdate({ text: e.target.value } as any)
                                            }
                                            placeholder="Enter text…"
                                            onKeyDown={(e) => e.stopPropagation()}
                                        />
                                    </Section>

                                    <Section label="Formatting">
                                        <div className="flex gap-2">
                                            <ToggleChip
                                                active={textBold}
                                                onClick={() => onUpdate({ bold: !textBold } as any)}
                                            >
                                                <Bold size={12} />
                                                Bold
                                            </ToggleChip>
                                            <ToggleChip
                                                active={textItalic}
                                                onClick={() =>
                                                    onUpdate({ italic: !textItalic } as any)
                                                }
                                            >
                                                <Italic size={12} />
                                                Italic
                                            </ToggleChip>
                                        </div>
                                    </Section>

                                    <Section label={`Font size - ${textFontSize}px`}>
                                        <Slider
                                            value={[textFontSize]}
                                            onValueChange={([value]) =>
                                                onUpdate({
                                                    fontSize: value,
                                                } as any)
                                            }
                                            max={48}
                                            min={8}
                                            step={1}
                                            className="w-full accent-blue-500"
                                        />
                                        <div className="flex justify-between text-[10px] text-white/30 font-mono mt-1">
                                            <span>8px</span>
                                            <span>28px</span>
                                            <span>48px</span>
                                        </div>
                                    </Section>

                                    <Section label="Text alignment">
                                        <HAlignButtons
                                            value={textAlign}
                                            onChange={(v) => onUpdate({ textAlign: v } as any)}
                                        />
                                    </Section>

                                    <Section label="Color">
                                        <ColorPicker
                                            value={d.color ?? '#e0e0e0'}
                                            onChange={(c) => onUpdate({ color: c } as any)}
                                        />
                                    </Section>
                                </>
                            )}

                            {supportsLabel && (
                                <>
                                    <Section label="Label text">
                                        <input
                                            type="text"
                                            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[12px] text-white focus:outline-none focus:border-blue-500/60 placeholder:text-white/20"
                                            value={label}
                                            onChange={(e) =>
                                                onUpdate({ label: e.target.value } as any)
                                            }
                                            placeholder="Optional label…"
                                            onKeyDown={(e) => e.stopPropagation()}
                                        />
                                    </Section>

                                    <Section label="Formatting">
                                        <div className="flex gap-2">
                                            <ToggleChip
                                                active={labelBold}
                                                onClick={() =>
                                                    onUpdate({ labelBold: !labelBold } as any)
                                                }
                                            >
                                                <Bold size={12} />
                                                Bold
                                            </ToggleChip>
                                            <ToggleChip
                                                active={labelItalic}
                                                onClick={() =>
                                                    onUpdate({ labelItalic: !labelItalic } as any)
                                                }
                                            >
                                                <Italic size={12} />
                                                Italic
                                            </ToggleChip>
                                        </div>
                                    </Section>

                                    <Section label={`Font size - ${labelFontSize}px`}>
                                        <Slider
                                            value={[labelFontSize]}
                                            onValueChange={([value]) => {
                                                onUpdate({
                                                    labelFontSize: value,
                                                } as any);
                                            }}
                                            max={48}
                                            min={8}
                                            step={1}
                                            className="w-full accent-blue-500"
                                        />
                                        <div className="flex justify-between text-[10px] text-white/30 font-mono mt-1">
                                            <span>8px</span>
                                            <span>22px</span>
                                            <span>36px</span>
                                        </div>
                                    </Section>

                                    {drawing.tool === 'vline' && (
                                        <Section label="Text orientation">
                                            <div className="flex gap-2">
                                                <ToggleChip
                                                    active={labelTextOrientation === 'horizontal'}
                                                    onClick={() =>
                                                        onUpdate({
                                                            labelTextOrientation: 'horizontal',
                                                        } as any)
                                                    }
                                                >
                                                    <span className="font-mono text-[11px]">A</span>
                                                    Horizontal
                                                </ToggleChip>
                                                <ToggleChip
                                                    active={labelTextOrientation === 'vertical'}
                                                    onClick={() =>
                                                        onUpdate({
                                                            labelTextOrientation: 'vertical',
                                                        } as any)
                                                    }
                                                >
                                                    <span className="font-mono text-[11px] rotate-90 inline-block">
                                                        A
                                                    </span>
                                                    Vertical
                                                </ToggleChip>
                                            </div>
                                        </Section>
                                    )}

                                    <Section label="Horizontal alignment">
                                        <HAlignButtons
                                            value={labelHorizontalAlign}
                                            onChange={(v) =>
                                                onUpdate({ labelHorizontalAlign: v } as any)
                                            }
                                        />
                                    </Section>

                                    <Section label="Vertical alignment">
                                        <VAlignButtons
                                            value={labelVerticalAlign}
                                            onChange={(v) =>
                                                onUpdate({ labelVerticalAlign: v } as any)
                                            }
                                        />
                                    </Section>

                                    <Section label="Label color">
                                        <ColorPicker
                                            value={labelColor}
                                            onChange={(c) => onUpdate({ labelColor: c } as any)}
                                        />
                                        <button
                                            className="mt-2 flex items-center gap-1.5 text-[11px] text-white/30 hover:text-white/60 transition-colors"
                                            onClick={() => onUpdate({ labelColor: color } as any)}
                                        >
                                            <RotateCcw size={10} />
                                            Reset to line color
                                        </button>
                                    </Section>
                                </>
                            )}

                            {drawing.tool === 'fib' && (
                                <div className="flex flex-col items-center gap-2 py-6 text-white/25">
                                    <Type size={22} strokeWidth={1.2} />
                                    <p className="text-[11px] text-center">
                                        Fibonacci levels use their own built-in labels.
                                    </p>
                                </div>
                            )}
                            {drawing.tool === 'fvp' && (
                                <div className="flex flex-col items-center gap-2 py-6 text-white/25">
                                    <Type size={22} strokeWidth={1.2} />
                                    <p className="text-[11px] text-center">
                                        Currently text isn't supported for fixed volume profile
                                        drawings.
                                    </p>
                                </div>
                            )}
                        </div>
                    )}

                    {tab === 'visibility' && (
                        <div className="flex flex-col gap-1">
                            <VisibilityRow
                                icon={<Lock size={14} />}
                                label="Locked"
                                description="Prevent accidental moves or edits"
                                checked={locked}
                                activeColor="text-yellow-400"
                                onCheckedChange={(v) => onUpdate({ locked: v } as any)}
                            />
                        </div>
                    )}

                    {tab === 'templates' && (
                        <div className="flex flex-col gap-5">
                            <Section label="Save current style as template">
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-[12px] text-white focus:outline-none focus:border-blue-500/60 placeholder:text-white/20"
                                        value={newTplName}
                                        onChange={(e) => setNewTplName(e.target.value)}
                                        onKeyDown={(e) => {
                                            e.stopPropagation();
                                            if (e.key === 'Enter') handleSaveTemplate();
                                        }}
                                        placeholder="Template name…"
                                    />
                                    <button
                                        className={cn(
                                            'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium transition-colors',
                                            savedFlash
                                                ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                                                : 'bg-blue-500/20 text-blue-400 border border-blue-500/30 hover:bg-blue-500/30',
                                        )}
                                        onClick={handleSaveTemplate}
                                    >
                                        {savedFlash ? <Check size={12} /> : <Save size={12} />}
                                        {savedFlash ? 'Saved!' : 'Save'}
                                    </button>
                                </div>
                            </Section>
                            <Section label={`Saved templates for ${TOOL_LABELS[drawing.tool]}`}>
                                {templates.length === 0 ? (
                                    <div className="flex flex-col items-center gap-2 py-6 text-white/25">
                                        <BookMarked size={22} strokeWidth={1.2} />
                                        <p className="text-[11px]">No templates yet</p>
                                    </div>
                                ) : (
                                    <div className="flex flex-col gap-1.5">
                                        {templates
                                            .slice()
                                            .sort((a, b) => b.createdAt - a.createdAt)
                                            .map((tpl) => (
                                                <div
                                                    key={tpl.id}
                                                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/3 border border-white/6 group"
                                                >
                                                    <div className="flex-1 min-w-0">
                                                        <p className="text-[12px] text-white truncate">
                                                            {tpl.name}
                                                        </p>
                                                        <p className="text-[10px] text-white/30 mt-0.5">
                                                            {new Date(
                                                                tpl.createdAt,
                                                            ).toLocaleDateString()}
                                                        </p>
                                                    </div>
                                                    <button
                                                        className="px-2.5 py-1 text-[10px] rounded bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 transition-colors border border-blue-500/20"
                                                        onClick={() => handleApplyTemplate(tpl)}
                                                    >
                                                        Apply
                                                    </button>
                                                    <button
                                                        className="p-1 rounded text-white/20 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                                                        onClick={() => handleDeleteTemplate(tpl.id)}
                                                    >
                                                        <Trash2 size={11} />
                                                    </button>
                                                </div>
                                            ))}
                                    </div>
                                )}
                            </Section>
                        </div>
                    )}
                </div>

                <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-white/6 shrink-0 bg-white/2">
                    <button
                        className="px-4 py-1.5 rounded-lg text-[12px] font-medium text-white/60 hover:text-white hover:bg-white/10 transition-colors"
                        onClick={handleClose}
                    >
                        Close
                    </button>
                </div>
            </div>
        </>
    );
}

// `drawing` is whatever object holds the values - a drawing for the built-in
// tools, a plugin drawing's data, or a chart type's settings
export function StyleFieldControl({
    field,
    drawing,
    onUpdate,
}: {
    field: StyleField;
    drawing: any;
    onUpdate: (patch: any) => void;
}) {
    if (field.type === 'color') {
        const value: string = drawing[field.key] ?? '#e0e0e0';
        const isDisabled = field.disabledWhenFalse
            ? drawing[field.disabledWhenFalse] === false
            : false;
        return (
            <Section label={field.label}>
                <div
                    className={cn(
                        'transition-opacity',
                        isDisabled && 'opacity-30 pointer-events-none',
                    )}
                >
                    <ColorPicker
                        value={value}
                        onChange={(c) => onUpdate({ [field.key]: c } as any)}
                    />
                </div>
            </Section>
        );
    }

    if (field.type === 'lineWidth') {
        const value: number = drawing[field.key] ?? 1;
        return (
            <Section label={field.label}>
                <div className="flex gap-2">
                    {[1, 2, 3, 4].map((w) => (
                        <button
                            key={w}
                            className={cn(
                                'flex-1 flex flex-col items-center gap-2 py-2.5 rounded-lg border transition-colors',
                                value === w
                                    ? 'border-blue-500/60 bg-blue-500/10 text-white'
                                    : 'border-white/8 bg-white/3 text-white/40 hover:border-white/20 hover:text-white/70',
                            )}
                            onClick={() => onUpdate({ [field.key]: w } as any)}
                        >
                            <div
                                className="rounded-full bg-current"
                                style={{ width: 28, height: w }}
                            />
                            <span className="text-[10px] font-mono">{w}px</span>
                        </button>
                    ))}
                </div>
            </Section>
        );
    }

    if (field.type === 'dash') {
        const value: number[] = drawing[field.key] ?? [];
        return (
            <Section label={field.label}>
                <div className="grid grid-cols-2 gap-2">
                    {DASH_PRESETS.map((preset) => {
                        const active = JSON.stringify(value) === JSON.stringify(preset.dash);
                        return (
                            <button
                                key={preset.value}
                                className={cn(
                                    'flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors',
                                    active
                                        ? 'border-blue-500/60 bg-blue-500/10 text-white'
                                        : 'border-white/8 bg-white/3 text-white/40 hover:border-white/20 hover:text-white/70',
                                )}
                                onClick={() => onUpdate({ [field.key]: preset.dash } as any)}
                            >
                                <svg width="28" height="8" viewBox="0 0 28 8">
                                    <line
                                        x1="0"
                                        y1="4"
                                        x2="28"
                                        y2="4"
                                        stroke="currentColor"
                                        strokeWidth="1.5"
                                        strokeDasharray={preset.dash.join(' ') || undefined}
                                    />
                                </svg>
                                <span className="text-[11px]">{preset.label}</span>
                            </button>
                        );
                    })}
                </div>
            </Section>
        );
    }

    if (field.type === 'opacity') {
        const value: number = drawing[field.key] ?? 0;
        return (
            <Section label={`${field.label} - ${Math.round(value * 100)}%`}>
                <Slider
                    value={[value]}
                    onValueChange={([v]) => onUpdate({ [field.key]: v } as any)}
                    max={1}
                    min={0}
                    step={0.01}
                    className="w-full accent-blue-500"
                />
                <div className="flex justify-between text-[10px] text-white/30 font-mono mt-1">
                    <span>0%</span>
                    <span>50%</span>
                    <span>100%</span>
                </div>
            </Section>
        );
    }

    if (field.type === 'fontSize') {
        const value: number = drawing[field.key] ?? 12;
        return (
            <Section label={`${field.label} - ${value}px`}>
                <Slider
                    value={[value]}
                    onValueChange={([v]) => onUpdate({ [field.key]: Math.round(v) } as any)}
                    max={48}
                    min={8}
                    step={1}
                    className="w-full accent-blue-500"
                />
                <div className="flex justify-between text-[10px] text-white/30 font-mono mt-1">
                    <span>8px</span>
                    <span>28px</span>
                    <span>48px</span>
                </div>
            </Section>
        );
    }

    if (field.type === 'slider') {
        const value: number = drawing[field.key] ?? 12;
        return (
            <Section
                label={`${field.label} - ${field.prefix ?? ''}${value}${field.suffix ?? ''}`}
            >
                <Slider
                    value={[value]}
                    onValueChange={([v]) => onUpdate({ [field.key]: snapToStep(v, field.step) } as any)}
                    max={field.max}
                    min={field.min}
                    step={field.step}
                    className="w-full accent-blue-500"
                />
                <div className="flex justify-between text-[10px] text-white/30 font-mono mt-1">
                    <span>{field.step1}</span>
                    <span>{field.step2}</span>
                    <span>{field.step3}</span>
                </div>
            </Section>
        );
    }

    if (field.type === 'extend') {
        return (
            <Section label={field.label}>
                <div className="flex gap-2">
                    <ToggleChip
                        active={drawing[field.leftKey] ?? false}
                        onClick={() =>
                            onUpdate({ [field.leftKey]: !drawing[field.leftKey] } as any)
                        }
                    >
                        ← Extend left
                    </ToggleChip>
                    <ToggleChip
                        active={drawing[field.rightKey] ?? false}
                        onClick={() =>
                            onUpdate({ [field.rightKey]: !drawing[field.rightKey] } as any)
                        }
                    >
                        Extend right →
                    </ToggleChip>
                </div>
            </Section>
        );
    }

    if (field.type === 'toggle') {
        return (
            <Section label="">
                <InlineToggleRow
                    label={field.label}
                    active={drawing[field.key] ?? false}
                    onToggle={() => onUpdate({ [field.key]: !drawing[field.key] } as any)}
                />
            </Section>
        );
    }

    if (field.type === 'customLevels') {
        return (
            <Section label={field.label}>
                <FibLevelsEditor
                    levels={drawing.levels ?? []}
                    onChange={(levels) => onUpdate({ levels } as any)}
                />
            </Section>
        );
    }

    if (field.type === 'channelLevels') {
        return (
            <Section label={field.label}>
                <ChannelLevelsEditor
                    levels={drawing.levels ?? DEFAULT_CHANNEL_LEVELS}
                    fallbackColor={drawing.color ?? '#e0e0e0'}
                    onChange={(levels) => onUpdate({ levels } as any)}
                />
            </Section>
        );
    }

    if (field.type === 'numberInput') {
        return (
            <NumberInputField
                field={field}
                value={drawing[field.key] ?? field.min ?? 0}
                onChange={(v) => onUpdate({ [field.key]: v } as any)}
            />
        );
    }

    if (field.type === 'textInput') {
        return (
            <Section label={field.label}>
                <input
                    type="text"
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[12px] text-white focus:outline-none focus:border-blue-500/60 placeholder:text-white/20"
                    value={drawing[field.key] ?? ''}
                    placeholder={field.placeholder}
                    maxLength={field.maxLength}
                    onChange={(e) => onUpdate({ [field.key]: e.target.value } as any)}
                    onKeyDown={(e) => e.stopPropagation()}
                />
            </Section>
        );
    }

    if (field.type === 'select') {
        const value: string = drawing[field.key] ?? field.options[0]?.value ?? '';
        return (
            <Section label={field.label}>
                <div className="relative">
                    <select
                        className="w-full appearance-none bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[12px] text-white focus:outline-none focus:border-blue-500/60 cursor-pointer pr-8"
                        value={value}
                        onChange={(e) => onUpdate({ [field.key]: e.target.value } as any)}
                    >
                        {field.options.map((opt) => (
                            <option key={opt.value} value={opt.value} className="bg-[#1a1d24]">
                                {opt.label}
                            </option>
                        ))}
                    </select>
                    <svg
                        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-white/30"
                        width="12"
                        height="12"
                        viewBox="0 0 12 12"
                        fill="none"
                    >
                        <path
                            d="M2.5 4.5L6 8L9.5 4.5"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                    </svg>
                </div>
            </Section>
        );
    }

    if (field.type === 'buttonGroup') {
        const value: string = drawing[field.key] ?? field.options[0]?.value ?? '';
        return (
            <Section label={field.label}>
                <div className="flex gap-1.5 flex-wrap">
                    {field.options.map((opt) => (
                        <button
                            key={opt.value}
                            className={cn(
                                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[11px] transition-colors',
                                value === opt.value
                                    ? 'border-blue-500/60 bg-blue-500/10 text-white'
                                    : 'border-white/8 bg-white/3 text-white/40 hover:border-white/20 hover:text-white/70',
                            )}
                            onClick={() => onUpdate({ [field.key]: opt.value } as any)}
                        >
                            {opt.icon}
                            {opt.label}
                        </button>
                    ))}
                </div>
            </Section>
        );
    }

    if (field.type === 'stepperInt') {
        const value: number = drawing[field.key] ?? field.min ?? 1;
        const step = field.step ?? 1;
        const min = field.min ?? -Infinity;
        const max = field.max ?? Infinity;
        return (
            <Section label={field.label}>
                <div className="flex items-center gap-2">
                    <button
                        className="w-8 h-8 flex items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/60 hover:bg-white/10 hover:text-white transition-colors text-base leading-none disabled:opacity-30 disabled:cursor-not-allowed"
                        onClick={() =>
                            onUpdate({ [field.key]: Math.max(min, value - step) } as any)
                        }
                        disabled={value <= min}
                    >
                        −
                    </button>
                    <span className="flex-1 text-center text-[13px] font-mono text-white tabular-nums">
                        {value}
                    </span>
                    <button
                        className="w-8 h-8 flex items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/60 hover:bg-white/10 hover:text-white transition-colors text-base leading-none disabled:opacity-30 disabled:cursor-not-allowed"
                        onClick={() =>
                            onUpdate({ [field.key]: Math.min(max, value + step) } as any)
                        }
                        disabled={value >= max}
                    >
                        +
                    </button>
                </div>
            </Section>
        );
    }

    if (field.type === 'rangeWithSteps') {
        const value: number = drawing[field.key] ?? field.min;
        return (
            <Section label={`${field.label} - ${value}`}>
                <Slider
                    value={[value]}
                    onValueChange={([v]) => onUpdate({ [field.key]: v } as any)}
                    min={field.min}
                    max={field.max}
                    step={(field.max - field.min) / Math.max(1, field.steps.length - 1)}
                    className="w-full"
                />
                <div className="flex justify-between mt-1">
                    {field.steps.map((s) => (
                        <button
                            key={s.value}
                            className={cn(
                                'text-[10px] font-mono transition-colors',
                                value === s.value
                                    ? 'text-blue-400'
                                    : 'text-white/25 hover:text-white/50',
                            )}
                            onClick={() => onUpdate({ [field.key]: s.value } as any)}
                        >
                            {s.label}
                        </button>
                    ))}
                </div>
            </Section>
        );
    }

    if (field.type === 'dualColor') {
        return (
            <Section label={field.label}>
                <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-2">
                        <p className="text-[10px] text-white/35 font-medium">{field.labelA}</p>
                        <ColorPicker
                            value={drawing[field.keyA] ?? '#22c55e'}
                            onChange={(c) => onUpdate({ [field.keyA]: c } as any)}
                        />
                    </div>
                    <div className="flex flex-col gap-2">
                        <p className="text-[10px] text-white/35 font-medium">{field.labelB}</p>
                        <ColorPicker
                            value={drawing[field.keyB] ?? '#ef4444'}
                            onChange={(c) => onUpdate({ [field.keyB]: c } as any)}
                        />
                    </div>
                </div>
            </Section>
        );
    }

    if (field.type === 'dualOpacity') {
        const valA: number = drawing[field.keyA] ?? 0.5;
        const valB: number = drawing[field.keyB] ?? 0.5;
        return (
            <Section label={field.label}>
                <div className="grid grid-cols-2 gap-4">
                    {(
                        [
                            { key: field.keyA, label: field.labelA, val: valA },
                            { key: field.keyB, label: field.labelB, val: valB },
                        ] as const
                    ).map(({ key, label: lbl, val }) => (
                        <div key={key} className="flex flex-col gap-2">
                            <p className="text-[10px] text-white/35 font-medium">
                                {lbl} - {Math.round(val * 100)}%
                            </p>
                            <Slider
                                value={[val]}
                                onValueChange={([v]) => onUpdate({ [key]: v } as any)}
                                min={0}
                                max={1}
                                step={0.01}
                                className="w-full"
                            />
                        </div>
                    ))}
                </div>
            </Section>
        );
    }

    if (field.type === 'colorGradient') {
        const startColor: string = drawing[field.keyStart] ?? '#3b82f6';
        const endColor: string = drawing[field.keyEnd] ?? '#8b5cf6';
        return (
            <Section label={field.label}>
                <div
                    className="w-full h-6 rounded-lg mb-3 border border-white/10"
                    style={{ background: `linear-gradient(to right, ${startColor}, ${endColor})` }}
                />
                <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-2">
                        <p className="text-[10px] text-white/35 font-medium">Start</p>
                        <ColorPicker
                            value={startColor}
                            onChange={(c) => onUpdate({ [field.keyStart]: c } as any)}
                        />
                    </div>
                    <div className="flex flex-col gap-2">
                        <p className="text-[10px] text-white/35 font-medium">End</p>
                        <ColorPicker
                            value={endColor}
                            onChange={(c) => onUpdate({ [field.keyEnd]: c } as any)}
                        />
                    </div>
                </div>
            </Section>
        );
    }

    if (field.type === 'marginInput') {
        const unit = field.unit ?? 'px';
        const sides = [
            { side: 'top' as const, label: 'T' },
            { side: 'right' as const, label: 'R' },
            { side: 'bottom' as const, label: 'B' },
            { side: 'left' as const, label: 'L' },
        ];
        return (
            <Section label={field.label}>
                <div className="grid grid-cols-4 gap-1.5">
                    {sides.map(({ side, label: lbl }) => {
                        const k = field.keys[side];
                        const val: number = drawing[k] ?? 0;
                        return (
                            <div key={side} className="flex flex-col items-center gap-1">
                                <span className="text-[9px] text-white/30 font-semibold uppercase tracking-widest">
                                    {lbl}
                                </span>
                                <input
                                    type="number"
                                    className="w-full bg-white/5 border border-white/10 rounded-md px-1.5 py-1 text-[11px] font-mono text-white text-center focus:outline-none focus:border-blue-500/60"
                                    value={val}
                                    onChange={(e) =>
                                        onUpdate({ [k]: parseFloat(e.target.value) || 0 } as any)
                                    }
                                    onKeyDown={(e) => e.stopPropagation()}
                                />
                                <span className="text-[9px] text-white/20">{unit}</span>
                            </div>
                        );
                    })}
                </div>
            </Section>
        );
    }

    if (field.type === 'anchorAlign') {
        type AnchorPos =
            | 'top-left'
            | 'top-center'
            | 'top-right'
            | 'middle-left'
            | 'middle-center'
            | 'middle-right'
            | 'bottom-left'
            | 'bottom-center'
            | 'bottom-right';
        const value: AnchorPos = drawing[field.key] ?? 'top-left';
        const positions: AnchorPos[] = [
            'top-left',
            'top-center',
            'top-right',
            'middle-left',
            'middle-center',
            'middle-right',
            'bottom-left',
            'bottom-center',
            'bottom-right',
        ];
        return (
            <Section label={field.label}>
                <div className="grid grid-cols-3 gap-1 w-24">
                    {positions.map((pos) => (
                        <button
                            key={pos}
                            title={pos}
                            className={cn(
                                'w-7 h-7 rounded flex items-center justify-center border transition-colors',
                                value === pos
                                    ? 'border-blue-500/60 bg-blue-500/20'
                                    : 'border-white/8 bg-white/3 hover:border-white/25 hover:bg-white/8',
                            )}
                            onClick={() => onUpdate({ [field.key]: pos } as any)}
                        >
                            <div
                                className={cn(
                                    'w-2 h-2 rounded-full transition-colors',
                                    value === pos ? 'bg-blue-400' : 'bg-white/25',
                                )}
                            />
                        </button>
                    ))}
                </div>
                <p className="text-[10px] text-white/30 mt-1 font-mono">{value}</p>
            </Section>
        );
    }

    if (field.type === 'capStyle') {
        type Cap = 'butt' | 'round' | 'square';
        const value: Cap = drawing[field.key] ?? 'butt';
        const caps: { val: Cap; label: string }[] = [
            { val: 'butt', label: 'Butt' },
            { val: 'round', label: 'Round' },
            { val: 'square', label: 'Square' },
        ];
        return (
            <Section label={field.label}>
                <div className="flex gap-2">
                    {caps.map(({ val, label: lbl }) => (
                        <button
                            key={val}
                            className={cn(
                                'flex-1 flex flex-col items-center gap-2 py-2.5 rounded-lg border transition-colors',
                                value === val
                                    ? 'border-blue-500/60 bg-blue-500/10 text-white'
                                    : 'border-white/8 bg-white/3 text-white/40 hover:border-white/20 hover:text-white/70',
                            )}
                            onClick={() => onUpdate({ [field.key]: val } as any)}
                        >
                            <svg width="28" height="12" viewBox="0 0 28 12">
                                <line
                                    x1={val === 'square' ? 6 : val === 'round' ? 6 : 4}
                                    y1="6"
                                    x2="22"
                                    y2="6"
                                    stroke="currentColor"
                                    strokeWidth="4"
                                    strokeLinecap={val}
                                />
                            </svg>
                            <span className="text-[10px]">{lbl}</span>
                        </button>
                    ))}
                </div>
            </Section>
        );
    }

    if (field.type === 'joinStyle') {
        type Join = 'miter' | 'round' | 'bevel';
        const value: Join = drawing[field.key] ?? 'miter';
        const joins: { val: Join; label: string }[] = [
            { val: 'miter', label: 'Miter' },
            { val: 'round', label: 'Round' },
            { val: 'bevel', label: 'Bevel' },
        ];
        const joinPath = 'M4,20 L14,4 L24,20';
        return (
            <Section label={field.label}>
                <div className="flex gap-2">
                    {joins.map(({ val, label: lbl }) => (
                        <button
                            key={val}
                            className={cn(
                                'flex-1 flex flex-col items-center gap-2 py-2.5 rounded-lg border transition-colors',
                                value === val
                                    ? 'border-blue-500/60 bg-blue-500/10 text-white'
                                    : 'border-white/8 bg-white/3 text-white/40 hover:border-white/20 hover:text-white/70',
                            )}
                            onClick={() => onUpdate({ [field.key]: val } as any)}
                        >
                            <svg width="28" height="24" viewBox="0 0 28 24" fill="none">
                                <path
                                    d={joinPath}
                                    stroke="currentColor"
                                    strokeWidth="3"
                                    fill="none"
                                    strokeLinejoin={val}
                                    strokeLinecap="round"
                                />
                            </svg>
                            <span className="text-[10px]">{lbl}</span>
                        </button>
                    ))}
                </div>
            </Section>
        );
    }

    if (field.type === 'arrowHead') {
        type ArrowStyle = 'none' | 'open' | 'filled';
        const startVal: ArrowStyle = drawing[field.startKey] ?? 'none';
        const endVal: ArrowStyle = drawing[field.endKey] ?? 'open';
        const options: { val: ArrowStyle; label: string }[] = [
            { val: 'none', label: 'None' },
            { val: 'open', label: 'Open' },
            { val: 'filled', label: 'Filled' },
        ];
        const ArrowPreview = ({ style }: { style: ArrowStyle }) => (
            <svg width="32" height="12" viewBox="0 0 32 12" fill="none">
                <line x1="2" y1="6" x2="24" y2="6" stroke="currentColor" strokeWidth="1.5" />
                {style === 'open' && (
                    <path
                        d="M18,2 L26,6 L18,10"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        fill="none"
                        strokeLinejoin="round"
                    />
                )}
                {style === 'filled' && <path d="M18,2 L26,6 L18,10 Z" fill="currentColor" />}
            </svg>
        );
        return (
            <Section label={field.label}>
                <div className="grid grid-cols-2 gap-3">
                    {(
                        [
                            { key: field.startKey, label: 'Start', val: startVal },
                            { key: field.endKey, label: 'End', val: endVal },
                        ] as const
                    ).map(({ key, label: lbl, val }) => (
                        <div key={key} className="flex flex-col gap-1.5">
                            <p className="text-[10px] text-white/35 font-medium">{lbl}</p>
                            <div className="flex flex-col gap-1">
                                {options.map((opt) => (
                                    <button
                                        key={opt.val}
                                        className={cn(
                                            'flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg border text-[11px] transition-colors',
                                            val === opt.val
                                                ? 'border-blue-500/60 bg-blue-500/10 text-white'
                                                : 'border-white/8 bg-white/3 text-white/40 hover:border-white/20 hover:text-white/70',
                                        )}
                                        onClick={() => onUpdate({ [key]: opt.val } as any)}
                                    >
                                        <ArrowPreview style={opt.val} />
                                        {opt.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            </Section>
        );
    }

    if (field.type === 'checkbox') {
        const value: boolean = drawing[field.key] ?? false;
        return (
            <button
                className={cn(
                    'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-colors',
                    value
                        ? 'border-blue-500/30 bg-blue-500/8 text-white'
                        : 'border-white/6 bg-white/3 text-white/50 hover:border-white/12 hover:bg-white/5 hover:text-white/70',
                )}
                onClick={() => onUpdate({ [field.key]: !value } as any)}
            >
                <div
                    className={cn(
                        'w-4 h-4 rounded border-[1.5px] flex items-center justify-center shrink-0 transition-colors',
                        value ? 'border-blue-500 bg-blue-500' : 'border-white/20 bg-transparent',
                    )}
                >
                    {value && <Check size={10} strokeWidth={3} className="text-white" />}
                </div>
                <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-[12px] leading-none">{field.label}</span>
                    {field.description && (
                        <span className="text-[10px] text-white/30 leading-none">
                            {field.description}
                        </span>
                    )}
                </div>
            </button>
        );
    }

    if (field.type === 'toggledInput') {
        const on: boolean = drawing[field.toggleKey] ?? false;
        const val: number = drawing[field.inputKey] ?? field.min ?? 0;
        return (
            <Section label="">
                <div className="flex items-center gap-3 px-3 py-2 rounded-lg border border-white/6 bg-white/3">
                    <Switch
                        checked={on}
                        onCheckedChange={(v) => onUpdate({ [field.toggleKey]: v } as any)}
                        className="data-[state=checked]:bg-blue-500"
                    />
                    <span
                        className={cn(
                            'text-[12px] flex-1',
                            on ? 'text-white' : 'text-white/40 select-none',
                        )}
                    >
                        {field.toggleLabel}
                    </span>
                    <div
                        className={cn(
                            'flex items-center gap-1.5 transition-opacity',
                            !on && 'opacity-30 pointer-events-none',
                        )}
                    >
                        <input
                            type="number"
                            className="w-16 bg-white/5 border border-white/10 rounded-md px-2 py-1 text-[12px] font-mono text-white text-right focus:outline-none focus:border-blue-500/60"
                            value={val}
                            min={field.min}
                            max={field.max}
                            step={field.step ?? 1}
                            onChange={(e) =>
                                onUpdate({
                                    [field.inputKey]: parseFloat(e.target.value) || 0,
                                } as any)
                            }
                            onKeyDown={(e) => e.stopPropagation()}
                            tabIndex={on ? 0 : -1}
                        />
                        {field.unit && (
                            <span className="text-[11px] text-white/35">{field.unit}</span>
                        )}
                    </div>
                </div>
            </Section>
        );
    }

    if (field.type === 'colorWithOpacity') {
        const cVal: string = drawing[field.colorKey] ?? '#e0e0e0';
        const oVal: number = drawing[field.opacityKey] ?? 1;
        return (
            <Section label={field.label}>
                <div className="flex gap-3 items-start">
                    <div className="flex-1 min-w-0">
                        <ColorPicker
                            value={cVal}
                            onChange={(c) => onUpdate({ [field.colorKey]: c } as any)}
                        />
                    </div>
                    <div className="flex flex-col gap-1 w-28 shrink-0 pt-0.5">
                        <p className="text-[10px] text-white/35 font-medium">
                            Opacity - {Math.round(oVal * 100)}%
                        </p>
                        <Slider
                            value={[oVal]}
                            onValueChange={([v]) => onUpdate({ [field.opacityKey]: v } as any)}
                            min={0}
                            max={1}
                            step={0.01}
                        />
                        <div className="flex justify-between text-[9px] text-white/25 font-mono">
                            <span>0%</span>
                            <span>100%</span>
                        </div>
                    </div>
                </div>
            </Section>
        );
    }

    if (field.type === 'toggledColor') {
        const on: boolean = drawing[field.toggleKey] ?? false;
        const cVal: string = drawing[field.colorKey] ?? '#e0e0e0';
        return (
            <Section label="">
                <div
                    className={cn(
                        'flex flex-col rounded-lg border transition-colors overflow-hidden',
                        on ? 'border-white/10 bg-white/3' : 'border-white/6 bg-white/2',
                    )}
                >
                    <div className="flex items-center gap-3 px-3 py-2.5">
                        <Switch
                            checked={on}
                            onCheckedChange={(v) => onUpdate({ [field.toggleKey]: v } as any)}
                            className="data-[state=checked]:bg-blue-500"
                        />
                        <span
                            className={cn(
                                'text-[12px] flex-1',
                                on ? 'text-white' : 'text-white/40',
                            )}
                        >
                            {field.label}
                        </span>
                        {!on && (
                            <div
                                className="w-5 h-5 rounded-full border border-white/15"
                                style={{ background: cVal }}
                            />
                        )}
                    </div>
                    {on && (
                        <div className="px-3 pb-3 border-t border-white/6">
                            <div className="pt-3">
                                <ColorPicker
                                    value={cVal}
                                    onChange={(c) => onUpdate({ [field.colorKey]: c } as any)}
                                />
                            </div>
                        </div>
                    )}
                </div>
            </Section>
        );
    }

    if (field.type === 'inlineFields') {
        return (
            <Section label={field.label}>
                <div className="flex items-center gap-2 flex-wrap">
                    {field.fields.map((f, i) => {
                        if (f.type === 'stepperInt') {
                            const val: number = drawing[f.key] ?? f.min ?? 1;
                            const step = f.step ?? 1;
                            const min = f.min ?? -Infinity;
                            const max = f.max ?? Infinity;
                            return (
                                <div
                                    key={i}
                                    className="flex items-center gap-1 bg-white/4 border border-white/8 rounded-lg px-1"
                                >
                                    <button
                                        className="w-6 h-7 flex items-center justify-center text-white/50 hover:text-white transition-colors leading-none disabled:opacity-30"
                                        onClick={() =>
                                            onUpdate({ [f.key]: Math.max(min, val - step) } as any)
                                        }
                                        disabled={val <= min}
                                    >
                                        −
                                    </button>
                                    <span className="text-[12px] font-mono text-white tabular-nums min-w-[2ch] text-center">
                                        {val}
                                    </span>
                                    <button
                                        className="w-6 h-7 flex items-center justify-center text-white/50 hover:text-white transition-colors leading-none disabled:opacity-30"
                                        onClick={() =>
                                            onUpdate({ [f.key]: Math.min(max, val + step) } as any)
                                        }
                                        disabled={val >= max}
                                    >
                                        +
                                    </button>
                                    {f.label && (
                                        <span className="text-[10px] text-white/30 pr-1.5">
                                            {f.label}
                                        </span>
                                    )}
                                </div>
                            );
                        }
                        if (f.type === 'buttonGroup') {
                            const val: string = drawing[f.key] ?? f.options[0]?.value ?? '';
                            return (
                                <div key={i} className="flex gap-1">
                                    {f.options.map((opt) => (
                                        <button
                                            key={opt.value}
                                            title={opt.label}
                                            className={cn(
                                                'w-7 h-7 flex items-center justify-center rounded-lg border text-[11px] transition-colors',
                                                val === opt.value
                                                    ? 'border-blue-500/60 bg-blue-500/10 text-white'
                                                    : 'border-white/8 bg-white/3 text-white/40 hover:border-white/20 hover:text-white/70',
                                            )}
                                            onClick={() => onUpdate({ [f.key]: opt.value } as any)}
                                        >
                                            {opt.icon ?? opt.label[0]}
                                        </button>
                                    ))}
                                </div>
                            );
                        }
                        if (f.type === 'checkbox') {
                            const val: boolean = drawing[f.key] ?? false;
                            return (
                                <button
                                    key={i}
                                    className={cn(
                                        'flex items-center gap-1.5 px-2.5 h-7 rounded-lg border text-[11px] transition-colors',
                                        val
                                            ? 'border-blue-500/60 bg-blue-500/10 text-white'
                                            : 'border-white/8 bg-white/3 text-white/40 hover:border-white/20 hover:text-white/70',
                                    )}
                                    onClick={() => onUpdate({ [f.key]: !val } as any)}
                                >
                                    {val && <Check size={10} strokeWidth={3} />}
                                    {f.label}
                                </button>
                            );
                        }
                        return null;
                    })}
                </div>
            </Section>
        );
    }

    return null;
}


function NumberInputField({
    field,
    value,
    onChange,
}: {
    field: { label: string; min?: number; max?: number; step?: number; unit?: string };
    value: number;
    onChange: (v: number) => void;
}) {
    const [local, setLocal] = useState(() => String(value));
    const focused = useRef(false);
    useEffect(() => {
        if (!focused.current) setLocal(String(value));
    }, [value]);
    const commit = () => {
        const v = parseFloat(local);
        if (!isNaN(v)) {
            const clamped = Math.min(field.max ?? Infinity, Math.max(field.min ?? -Infinity, v));
            onChange(clamped);
            setLocal(String(clamped));
        } else {
            setLocal(String(value));
        }
    };
    return (
        <Section label={field.label}>
            <div className="flex items-center gap-2">
                <input
                    type="number"
                    className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[12px] font-mono text-white focus:outline-none focus:border-blue-500/60"
                    value={local}
                    min={field.min}
                    max={field.max}
                    step={field.step ?? 1}
                    onChange={(e) => setLocal(e.target.value)}
                    onFocus={() => {
                        focused.current = true;
                    }}
                    onBlur={() => {
                        focused.current = false;
                        commit();
                    }}
                    onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') commit();
                    }}
                />
                {field.unit && (
                    <span className="text-[11px] text-white/35 shrink-0">{field.unit}</span>
                )}
            </div>
        </Section>
    );
}


function Section({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-2.5">
            <p className="text-[10px] font-semibold text-white/35 uppercase tracking-widest">
                {label}
            </p>
            {children}
        </div>
    );
}

function CoordRow({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex items-center gap-3">
            <span className="text-[11px] text-white/40 w-20 shrink-0">{label}</span>
            <div className="flex-1">{children}</div>
        </div>
    );
}

function PriceInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
    const [local, setLocal] = useState(() => value.toFixed(6));
    const focused = useRef(false);
    useEffect(() => {
        if (!focused.current) setLocal(value.toFixed(6));
    }, [value]);
    return (
        <input
            type="text"
            className="w-full bg-white/5 border border-white/10 rounded px-2.5 py-1.5 text-[11px] font-mono text-white focus:outline-none focus:border-blue-500/60"
            value={local}
            onChange={(e) => setLocal(e.target.value)}
            onFocus={() => {
                focused.current = true;
            }}
            onBlur={() => {
                focused.current = false;
                const v = parseFloat(local);
                if (!isNaN(v)) onChange(v);
                else setLocal(value.toFixed(6));
            }}
            onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
        />
    );
}

function TsInput({ value, onChange }: { value: bigint; onChange: (v: bigint) => void }) {
    const [local, setLocal] = useState(() => formatTs(value));
    const focused = useRef(false);
    useEffect(() => {
        if (!focused.current) setLocal(formatTs(value));
    }, [value]);
    return (
        <input
            type="text"
            className="w-full bg-white/5 border border-white/10 rounded px-2.5 py-1.5 text-[11px] font-mono text-white focus:outline-none focus:border-blue-500/60"
            value={local}
            onChange={(e) => setLocal(e.target.value)}
            onFocus={() => {
                focused.current = true;
            }}
            onBlur={() => {
                focused.current = false;
                const v = parseTs(local);
                if (v !== null) onChange(v);
                else setLocal(formatTs(value));
            }}
            onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
        />
    );
}

function AnchorSection({
    label,
    anchor,
    onChange,
}: {
    label: string;
    anchor: { ts: bigint; price: number };
    onChange: (a: { ts: bigint; price: number }) => void;
}) {
    return (
        <div className="rounded-lg border border-white/8 bg-white/2 px-3 py-3 flex flex-col gap-2.5">
            <p className="text-[10px] font-semibold text-white/40 uppercase tracking-widest">
                {label}
            </p>
            <CoordRow label="Time">
                <TsInput value={anchor.ts} onChange={(ts) => onChange({ ...anchor, ts })} />
            </CoordRow>
            <CoordRow label="Price">
                <PriceInput
                    value={anchor.price}
                    onChange={(price) => onChange({ ...anchor, price })}
                />
            </CoordRow>
        </div>
    );
}

function HAlignButtons({
    value,
    onChange,
}: {
    value: TextAlign;
    onChange: (v: TextAlign) => void;
}) {
    return (
        <div className="flex gap-1.5">
            {(['left', 'center', 'right'] as TextAlign[]).map((a) => {
                const Icon = a === 'left' ? AlignLeft : a === 'center' ? AlignCenter : AlignRight;
                return (
                    <button
                        key={a}
                        className={cn(
                            'flex items-center gap-1.5 px-3 py-2 rounded-lg border text-[11px] transition-colors',
                            value === a
                                ? 'border-blue-500/60 bg-blue-500/10 text-white'
                                : 'border-white/8 bg-white/3 text-white/40 hover:border-white/20 hover:text-white/70',
                        )}
                        onClick={() => onChange(a)}
                    >
                        <Icon size={12} />
                        {{ left: 'Left', center: 'Center', right: 'Right' }[a]}
                    </button>
                );
            })}
        </div>
    );
}

function VAlignButtons({
    value,
    onChange,
}: {
    value: VerticalAlign;
    onChange: (v: VerticalAlign) => void;
}) {
    const opts: { val: VerticalAlign; label: string; Icon: React.ElementType }[] = [
        { val: 'top', label: 'Top', Icon: AlignStartVertical },
        { val: 'middle', label: 'Middle', Icon: AlignCenterVertical },
        { val: 'bottom', label: 'Bottom', Icon: AlignEndVertical },
    ];
    return (
        <div className="flex gap-1.5">
            {opts.map(({ val, label, Icon }) => (
                <button
                    key={val}
                    className={cn(
                        'flex items-center gap-1.5 px-3 py-2 rounded-lg border text-[11px] transition-colors',
                        value === val
                            ? 'border-blue-500/60 bg-blue-500/10 text-white'
                            : 'border-white/8 bg-white/3 text-white/40 hover:border-white/20 hover:text-white/70',
                    )}
                    onClick={() => onChange(val)}
                >
                    <Icon size={12} />
                    {label}
                </button>
            ))}
        </div>
    );
}

function ToggleChip({
    active,
    onClick,
    children,
}: {
    active: boolean;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (
        <button
            className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[11px] transition-colors',
                active
                    ? 'border-blue-500/60 bg-blue-500/10 text-white'
                    : 'border-white/8 bg-white/3 text-white/40 hover:border-white/20 hover:text-white/70',
            )}
            onClick={onClick}
        >
            {active &&
                !['Bold', 'Italic'].some(
                    (s) =>
                        typeof children === 'object' &&
                        Array.isArray(children) &&
                        children.some((c: any) => typeof c === 'string' && c === s),
                ) && <Check size={11} strokeWidth={2.5} />}
            {children}
        </button>
    );
}

function InlineToggleRow({
    label,
    active,
    onToggle,
}: {
    label: string;
    active: boolean;
    onToggle: () => void;
}) {
    return (
        <button
            className={cn(
                'w-full flex items-center justify-between px-3 py-2.5 rounded-lg border text-left transition-colors',
                active
                    ? 'border-blue-500/30 bg-blue-500/8 text-white'
                    : 'border-white/6 bg-white/3 text-white/50 hover:border-white/12 hover:bg-white/5 hover:text-white/70',
            )}
            onClick={onToggle}
        >
            <span className="text-[12px]">{label}</span>
            <Switch
                checked={active}
                onCheckedChange={onToggle}
                className="data-[state=checked]:bg-blue-500"
            />
        </button>
    );
}

function VisibilityRow({
    icon,
    label,
    description,
    checked,
    activeColor = 'text-blue-400',
    onCheckedChange,
}: {
    icon: React.ReactNode;
    label: string;
    description: string;
    checked: boolean;
    activeColor?: string;
    onCheckedChange: (v: boolean) => void;
}) {
    return (
        <div className="flex items-center gap-3 py-2">
            <div className={cn('shrink-0', checked ? activeColor : 'text-white/30')}>{icon}</div>
            <div className="flex-1 min-w-0">
                <p className="text-[12px] text-white">{label}</p>
                <p className="text-[10px] text-white/35 mt-0.5">{description}</p>
            </div>
            <Switch
                checked={checked}
                onCheckedChange={onCheckedChange}
                className="data-[state=checked]:bg-blue-500"
            />
        </div>
    );
}

function ColorPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
    return (
        <div className="flex flex-col gap-3">
            <div className="grid grid-cols-8 gap-1.5">
                {PRESET_COLORS.map((c) => (
                    <button
                        key={c}
                        className={cn(
                            'w-7 h-7 rounded-full border-2 transition-all hover:scale-110 flex items-center justify-center',
                            value === c ? 'border-white scale-110' : 'border-white/10',
                        )}
                        style={{ background: c }}
                        onClick={() => onChange(c)}
                    >
                        {value === c && (
                            <Check size={11} className="text-black drop-shadow" strokeWidth={3} />
                        )}
                    </button>
                ))}
            </div>
            <div className="flex items-center gap-2">
                <ColorPickerReact
                    onChange={(v) => onChange(v)}
                    value={value}
                    className="w-8 h-8 rounded-md border-2 border-border/50"
                />
            </div>
        </div>
    );
}

function FibLevelsEditor({
    levels,
    onChange,
}: {
    levels: FibLevel[];
    onChange: (levels: FibLevel[]) => void;
}) {
    const [newValue, setNewValue] = useState('');
    const [newColor, setNewColor] = useState('#22c55e');

    const update = (id: string, patch: Partial<FibLevel>) =>
        onChange(levels.map((l) => (l.id === id ? { ...l, ...patch } : l)));

    const remove = (id: string) => onChange(levels.filter((l) => l.id !== id));

    const add = () => {
        if (!newValue.trim()) return;
        onChange([
            ...levels,
            { id: nanoid(8), value: newValue.trim(), color: newColor, enabled: true },
        ]);
        setNewValue('');
    };

    return (
        <div className="flex flex-col gap-1.5">
            {levels.map((level) => (
                <div
                    key={level.id}
                    className={cn(
                        'grid items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-white/6 bg-white/3 transition-opacity',
                        !level.enabled && 'opacity-40',
                    )}
                    style={{ gridTemplateColumns: '22px 1fr 24px 22px' }}
                >
                    <label
                        className="w-[22px] h-[22px] rounded-[5px] border-[1.5px] border-white/20 cursor-pointer shrink-0 hover:scale-110 transition-transform overflow-hidden block"
                        style={{ background: level.color }}
                    >
                        <ColorPickerReact
                            onChange={(v) => update(level.id, { color: v })}
                            value={level.color}
                            className="opacity-0 absolute"
                        />
                    </label>

                    <input
                        type="text"
                        className="w-full bg-white/5 border border-white/10 rounded-md px-2 py-1 text-[12px] font-mono text-white/80 focus:outline-none focus:border-blue-500/50"
                        value={level.value}
                        onChange={(e) => update(level.id, { value: e.target.value })}
                        onKeyDown={(e) => e.stopPropagation()}
                    />

                    <button
                        className={cn(
                            'w-6 h-6 flex items-center justify-center rounded-md transition-colors',
                            level.enabled
                                ? 'text-white/50 hover:text-white/80 hover:bg-white/8'
                                : 'text-white/20 hover:text-white/50 hover:bg-white/8',
                        )}
                        onClick={() => update(level.id, { enabled: !level.enabled })}
                    >
                        {level.enabled ? <Eye size={12} /> : <EyeOff size={12} />}
                    </button>

                    <button
                        className="w-[22px] h-[22px] flex items-center justify-center rounded-md text-white/20 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                        onClick={() => remove(level.id)}
                    >
                        <X size={11} />
                    </button>
                </div>
            ))}

            <div className="flex items-center gap-1.5 mt-1">
                <label
                    className="w-8 h-8 rounded-lg border-[1.5px] border-dashed border-white/18 hover:border-white/40 cursor-pointer shrink-0 overflow-hidden transition-colors block"
                    style={{ background: newColor }}
                >
                    <ColorPickerReact
                        onChange={(v) => setNewColor(v)}
                        value={newColor}
                        className="opacity-0 absolute"
                    />
                </label>
                <input
                    type="text"
                    className="flex-1 bg-white/4 border border-dashed border-white/12 rounded-lg px-2.5 py-1.5 text-[12px] font-mono text-white/60 placeholder:text-white/20 focus:outline-none focus:border-blue-500/40 focus:border-solid focus:bg-white/6"
                    placeholder="Level  e.g. 0.786"
                    value={newValue}
                    onChange={(e) => setNewValue(e.target.value)}
                    onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') add();
                    }}
                    maxLength={8}
                />
                <button
                    className="px-3 h-8 bg-blue-500/15 border border-blue-500/30 rounded-lg text-[11px] font-medium text-blue-400 hover:bg-blue-500/25 transition-colors shrink-0"
                    onClick={add}
                >
                    + Add
                </button>
            </div>
        </div>
    );
}

function dashPresetValue(dash: number[]): string {
    const match = DASH_PRESETS.find((p) => JSON.stringify(p.dash) === JSON.stringify(dash ?? []));
    return match?.value ?? 'solid';
}

function ChannelLevelsEditor({
    levels,
    fallbackColor,
    onChange,
}: {
    levels: ChannelLevel[];
    fallbackColor: string;
    onChange: (levels: ChannelLevel[]) => void;
}) {
    const [newValue, setNewValue] = useState('');

    const update = (id: string, patch: Partial<ChannelLevel>) => {
        onChange(levels.map((l) => (l.id === id ? { ...l, ...patch } : l)));
    };

    const remove = (id: string) => onChange(levels.filter((l) => l.id !== id));

    const add = () => {
        const v = parseFloat(newValue);
        if (Number.isNaN(v)) return;
        onChange(
            [
                ...levels,
                {
                    id: nanoid(8),
                    value: v,
                    color: fallbackColor,
                    lineWidth: 1,
                    dash: [],
                    enabled: true,
                },
                //@ts-ignore
            ].sort((a, b) => a.value - b.value),
        );
        setNewValue('');
    };

    return (
        <div className="flex flex-col gap-1.5">
            {levels.map((level) => (
                <div
                    key={level.id}
                    className={cn(
                        'flex flex-col gap-1.5 px-2.5 py-2 rounded-lg border border-white/6 bg-white/3 transition-opacity',
                        !level.enabled && 'opacity-40',
                    )}
                >
                    <div
                        className="grid items-center gap-1.5"
                        style={{ gridTemplateColumns: '28px 1fr 24px 22px' }}
                    >
                        <ColorPickerReact
                            onChange={(v) => update(level.id, { color: v })}
                            value={level.color}
                            className="w-7 h-7"
                        />

                        <input
                            type="number"
                            step="0.1"
                            className="w-full bg-white/5 border border-white/10 rounded-md px-2 py-1 text-[12px] font-mono text-white/80 focus:outline-none focus:border-blue-500/50"
                            value={level.value}
                            onChange={(e) => update(level.id, { value: e.target.value })}
                            onKeyDown={(e) => e.stopPropagation()}
                        />
                        <button
                            className={cn(
                                'w-6 h-6 flex items-center justify-center rounded-md transition-colors',
                                level.enabled
                                    ? 'text-white/50 hover:text-white/80 hover:bg-white/8'
                                    : 'text-white/20 hover:text-white/50 hover:bg-white/8',
                            )}
                            onClick={() => update(level.id, { enabled: !level.enabled })}
                        >
                            {level.enabled ? <Eye size={12} /> : <EyeOff size={12} />}
                        </button>
                        <button
                            className="w-[22px] h-[22px] flex items-center justify-center rounded-md text-white/20 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                            onClick={() => remove(level.id)}
                        >
                            <X size={11} />
                        </button>
                    </div>

                    <div className="flex items-center gap-1.5">
                        <div className="flex gap-1 w-1/2">
                            {[1, 2, 3, 4].map((w) => (
                                <button
                                    key={w}
                                    className={cn(
                                        'w-full h-6 rounded-md text-[10px] font-mono border transition-colors',
                                        level.lineWidth === w
                                            ? 'border-blue-500/60 bg-blue-500/10 text-white'
                                            : 'border-white/8 bg-white/3 text-white/40 hover:border-white/20 hover:text-white/70',
                                    )}
                                    onClick={() => update(level.id, { lineWidth: w })}
                                >
                                    {w}
                                </button>
                            ))}
                        </div>
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    variant="outline"
                                    className="flex flex-row justify-between p-1 px-2 h-[1.7rem] text-xs text-muted-foreground !scale-100 w-1/2"
                                >
                                    <div>
                                        {
                                            DASH_PRESETS.find(
                                                (p) => p.value === dashPresetValue(level.dash),
                                            ).label
                                        }
                                    </div>
                                    <ChevronDown className="w-4" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent className="z-[201]">
                                {DASH_PRESETS.map((p) => (
                                    <DropdownMenuItem
                                        onSelect={() => {
                                            const preset = DASH_PRESETS.find(
                                                (_p) => _p.value === p.value,
                                            );
                                            update(level.id, { dash: preset ? preset.dash : [] });
                                        }}
                                        key={p.value}
                                        className="text-xs"
                                    >
                                        {p.label}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                </div>
            ))}

            <div className="flex items-center gap-1.5 mt-1">
                <input
                    type="number"
                    step="0.1"
                    className="flex-1 bg-white/5 border border-dashed border-white/12 rounded-lg px-2.5 py-1.5 text-[12px] font-mono text-white/60 placeholder:text-white/20 focus:outline-none focus:border-blue-500/40 focus:border-solid focus:bg-white/6"
                    placeholder="Level  e.g. 0.5"
                    value={newValue}
                    onChange={(e) => setNewValue(e.target.value)}
                    onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') add();
                    }}
                />
                <button
                    className="px-3 h-8 bg-blue-500/15 border border-blue-500/30 rounded-lg active:scale-[0.98] text-[11px] font-medium text-blue-400 hover:bg-blue-500/25 transition-all shrink-0"
                    onClick={add}
                >
                    + Add
                </button>
            </div>
        </div>
    );
}
