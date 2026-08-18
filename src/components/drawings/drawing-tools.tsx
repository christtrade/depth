import type { DrawingTool } from '../../lib/types/drawing-types';
import { DrawIcons } from './drawing-icons';
import React from 'react';

export type DrawingItem = {
    tool: DrawingTool;
    label: string;
    icon: React.ReactNode;
    shortcut?: string;
    implemented?: boolean;
};

export type DrawingGroup = {
    label: string;
    items: DrawingItem[];
};

export type DrawingCategory = {
    id: string;
    label: string;
    icon: React.ReactNode;
    groups: DrawingGroup[];
};

const item = (
    tool: DrawingTool,
    label: string,
    opts?: { shortcut?: string; implemented?: boolean },
): DrawingItem => ({
    tool,
    label,
    icon: DrawIcons[tool],
    shortcut: opts?.shortcut,
    implemented: opts?.implemented,
});

const live = (tool: DrawingTool, label: string, shortcut?: string): DrawingItem =>
    item(tool, label, { shortcut, implemented: true });

const group = (label: string, items: DrawingItem[]): DrawingGroup => ({ label, items });

export const DRAWING_CATEGORIES: DrawingCategory[] = [
    {
        id: 'lines',
        label: 'Lines',
        icon: DrawIcons.cat_lines,
        groups: [
            group('Trend Lines', [
                live('line', 'Trend Line', 'L'),
                live('ray', 'Ray', 'R'),
                live('hline', 'Horizontal Line', 'H'),
                live('vline', 'Vertical Line', 'V'),
                live('extended-line', 'Extended Line'),
                live('hray', 'Horizontal Ray'),
                live('cross-line', 'Cross Line'),
                live('info-line', 'Info Line'),
                live('trend-angle', 'Trend Angle'),
            ]),
            group('Channels', [
                live('parallel-channel', 'Parallel Channel'),
                item('flat-channel', 'Flat Channel'),
                item('disjoint-channel', 'Disjoint Channel'),
                item('regression-trend', 'Regression Trend'),
            ]),
            group('Pitchforks', [
                item('pitchfork', 'Andrews Pitchfork'),
                item('schiff-pitchfork', 'Schiff Pitchfork'),
                item('modified-schiff-pitchfork', 'Modified Schiff Pitchfork'),
                item('inside-pitchfork', 'Inside Pitchfork'),
            ]),
        ],
    },
    {
        id: 'fib',
        label: 'Fibonacci & Gann',
        icon: DrawIcons.cat_fib,
        groups: [
            group('Fibonacci', [
                live('fib', 'Fib Retracement', 'F'),
                item('fib-extension', 'Fib Extension'),
                item('fib-trend-extension', 'Trend-Based Fib Extension'),
                item('fib-channel', 'Fib Channel'),
                item('fib-time-zone', 'Fib Time Zone'),
                item('fib-speed-fan', 'Fib Speed/Resistance Fan'),
                item('fib-circles', 'Fib Circles'),
                item('fib-spiral', 'Fib Spiral'),
                item('fib-wedge', 'Fib Wedge'),
            ]),
            group('Gann', [
                item('gann-box', 'Gann Box'),
                item('gann-square', 'Gann Square'),
                item('gann-fan', 'Gann Fan'),
            ]),
        ],
    },
    {
        id: 'patterns',
        label: 'Patterns',
        icon: DrawIcons.cat_patterns,
        groups: [
            group('Harmonic', [
                item('xabcd', 'XABCD Pattern'),
                item('cypher', 'Cypher Pattern'),
                item('abcd', 'ABCD Pattern'),
                item('three-drives', 'Three Drives Pattern'),
            ]),
            group('Chart Patterns', [
                item('head-shoulders', 'Head and Shoulders'),
                item('triangle-pattern', 'Triangle Pattern'),
            ]),
            group('Elliott Waves', [
                item('elliott-impulse', 'Impulse Wave (12345)'),
                item('elliott-correction', 'Correction Wave (ABC)'),
                item('elliott-triangle', 'Triangle Wave (ABCDE)'),
                item('elliott-double-combo', 'Double Combo (WXY)'),
                item('elliott-triple-combo', 'Triple Combo (WXYXZ)'),
            ]),
        ],
    },
    {
        id: 'shapes',
        label: 'Shapes',
        icon: DrawIcons.cat_shapes,
        groups: [
            group('Geometric', [
                live('rect', 'Rectangle', 'R'),
                item('rotated-rect', 'Rotated Rectangle'),
                item('ellipse', 'Ellipse'),
                item('circle', 'Circle'),
                live('triangle', 'Triangle'),
                item('polygon', 'Polygon'),
                item('arc', 'Arc'),
            ]),
            group('Freehand', [
                item('curve', 'Curve'),
                item('double-curve', 'Double Curve'),
                item('polyline', 'Polyline'),
                item('path', 'Path'),
            ]),
        ],
    },
    {
        id: 'annotations',
        label: 'Annotations',
        icon: DrawIcons.cat_annotations,
        groups: [
            group('Text', [
                live('text', 'Text', 'T'),
                item('anchored-text', 'Anchored Text'),
                item('note', 'Note'),
                item('callout', 'Callout'),
                item('comment', 'Comment'),
            ]),
            group('Labels', [
                item('price-label', 'Price Label'),
                item('signpost', 'Signpost'),
                item('flag', 'Flag Mark'),
                item('pin', 'Pin'),
                item('table', 'Table'),
            ]),
        ],
    },
    {
        id: 'arrows',
        label: 'Arrows & Brushes',
        icon: DrawIcons.cat_arrows,
        groups: [
            group('Arrows', [
                item('arrow', 'Arrow'),
                item('arrow-marker', 'Arrow Marker'),
                item('arrow-up', 'Arrow Mark Up'),
                item('arrow-down', 'Arrow Mark Down'),
            ]),
            group('Brushes', [
                item('brush', 'Brush'),
                item('highlighter', 'Highlighter'),
            ]),
        ],
    },
    {
        id: 'forecast',
        label: 'Forecast & Positions',
        icon: DrawIcons.cat_forecast,
        groups: [
            group('Positions', [
                live('long', 'Long Position', 'U'),
                live('short', 'Short Position', 'I'),
            ]),
            group('Forecasting', [
                item('forecast', 'Forecast'),
                item('projection', 'Projection'),
                item('bars-pattern', 'Bars Pattern'),
                item('ghost-feed', 'Ghost Feed'),
            ]),
            group('Ranges', [
                item('price-range', 'Price Range'),
                item('date-range', 'Date Range'),
                item('date-price-range', 'Date and Price Range'),
            ]),
        ],
    },
    {
        id: 'measure',
        label: 'Volume & Measure',
        icon: DrawIcons.cat_measure,
        groups: [
            group('Volume Profile', [
                live('fvp', 'Fixed Volume Profile', 'P'),
                item('anchored-volume-profile', 'Anchored Volume Profile'),
                item('fixed-range-volume', 'Fixed Range Volume Profile'),
            ]),
            group('Tools', [
                item('anchored-vwap', 'Anchored VWAP'),
                item('ruler', 'Measure'),
            ]),
        ],
    },
];

export const ALL_DRAWING_ITEMS: DrawingItem[] = DRAWING_CATEGORIES.flatMap((c) =>
    c.groups.flatMap((g) => g.items),
);

export function findDrawingItem(tool: string): DrawingItem | undefined {
    return ALL_DRAWING_ITEMS.find((i) => i.tool === tool);
}

export const TOOL_SHORTCUTS: Record<string, DrawingTool> = (() => {
    const map: Record<string, DrawingTool> = { Escape: 'cursor' };
    for (const it of ALL_DRAWING_ITEMS) {
        if (!it.implemented || !it.shortcut) continue;
        const k = it.shortcut.toLowerCase();
        map[k] = it.tool;
        map[k.toUpperCase()] = it.tool;
    }
    return map;
})();
