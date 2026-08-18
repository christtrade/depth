import React from 'react';

const SZ = 15;

function I({ children }: { children: React.ReactNode }) {
    return (
        <svg
            width={SZ}
            height={SZ}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            {children}
        </svg>
    );
}

function Dot({ x, y, r = 2 }: { x: number; y: number; r?: number }) {
    return <circle cx={x} cy={y} r={r} fill="currentColor" stroke="none" />;
}

const L = (x1: number, y1: number, x2: number, y2: number, key?: string) => (
    <line key={key} x1={x1} y1={y1} x2={x2} y2={y2} />
);

export const DrawIcons: Record<string, React.ReactNode> = {
    cursor: (
        <I>
            <path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z" />
        </I>
    ),

    cat_lines: (
        <I>
            {L(4, 19, 20, 6)}
            <Dot x={4} y={19} />
            <Dot x={20} y={6} />
        </I>
    ),
    cat_fib: (
        <I>
            {L(4, 5, 20, 5)}
            {L(4, 10, 20, 10)}
            {L(4, 14, 20, 14)}
            {L(4, 19, 20, 19)}
        </I>
    ),
    cat_patterns: (
        <I>
            <path d="M4 18 L9 8 L13 15 L20 5" />
            <Dot x={9} y={8} r={1.6} />
            <Dot x={13} y={15} r={1.6} />
        </I>
    ),
    cat_shapes: (
        <I>
            <rect x={4} y={4} width={16} height={16} rx={2} />
        </I>
    ),
    cat_annotations: (
        <I>
            {L(5, 6, 19, 6)}
            {L(12, 6, 12, 19)}
        </I>
    ),
    cat_arrows: (
        <I>
            <path d="M6 18 L18 6" />
            <path d="M11 6 L18 6 L18 13" />
        </I>
    ),
    cat_forecast: (
        <I>
            <circle cx={12} cy={12} r={8} />
            {L(12, 12, 16, 9)}
            <Dot x={12} y={12} r={1.6} />
        </I>
    ),
    cat_measure: (
        <I>
            {L(5, 20, 5, 8)}
            {L(11, 20, 11, 4)}
            {L(17, 20, 17, 12)}
        </I>
    ),

    line: (
        <I>
            {L(4, 19, 20, 6)}
            <Dot x={4} y={19} />
            <Dot x={20} y={6} />
        </I>
    ),
    ray: (
        <I>
            {L(5, 19, 21, 5)}
            <Dot x={5} y={19} />
        </I>
    ),
    hline: (
        <I>
            {L(3, 12, 21, 12)}
            <Dot x={9} y={12} />
        </I>
    ),
    vline: (
        <I>
            {L(12, 3, 12, 21)}
            <Dot x={12} y={9} />
        </I>
    ),
    'extended-line': (
        <I>
            {L(3, 21, 21, 3)}
            <Dot x={9} y={15} />
            <Dot x={15} y={9} />
        </I>
    ),
    hray: (
        <I>
            {L(5, 12, 21, 12)}
            <Dot x={5} y={12} />
        </I>
    ),
    'cross-line': (
        <I>
            {L(3, 12, 21, 12)}
            {L(12, 3, 12, 21)}
            <Dot x={12} y={12} r={1.6} />
        </I>
    ),
    'info-line': (
        <I>
            {L(4, 19, 20, 6)}
            <Dot x={4} y={19} />
            <Dot x={20} y={6} />
            <rect x={9} y={10} width={6} height={4} rx={2} />
        </I>
    ),
    'trend-angle': (
        <I>
            {L(4, 19, 20, 7)}
            <path d="M4 19 H14" />
            <path d="M11 19 A7 7 0 0 0 9.5 15.5" />
            <Dot x={4} y={19} />
        </I>
    ),
    'parallel-channel': (
        <I>
            {L(4, 16, 20, 5)}
            {L(4, 19, 20, 8)}
            <Dot x={4} y={16} />
            <Dot x={20} y={5} />
        </I>
    ),
    'flat-channel': (
        <I>
            {L(4, 8, 20, 8)}
            {L(4, 16, 20, 16)}
            <Dot x={4} y={8} />
            <Dot x={20} y={16} />
        </I>
    ),
    'disjoint-channel': (
        <I>
            {L(4, 14, 20, 5)}
            {L(4, 20, 16, 12)}
            <Dot x={4} y={14} />
            <Dot x={20} y={5} />
        </I>
    ),
    'regression-trend': (
        <I>
            {L(4, 9, 20, 5)}
            {L(4, 19, 20, 15)}
            {L(4, 14, 20, 10)}
        </I>
    ),
    pitchfork: (
        <I>
            {L(4, 12, 12, 12)}
            {L(12, 5, 12, 19)}
            {L(12, 5, 20, 5)}
            {L(12, 19, 20, 19)}
            <Dot x={4} y={12} r={1.6} />
        </I>
    ),
    'schiff-pitchfork': (
        <I>
            {L(4, 14, 12, 10)}
            {L(12, 4, 12, 18)}
            {L(12, 4, 20, 4)}
            {L(12, 18, 20, 18)}
            <Dot x={4} y={14} r={1.6} />
        </I>
    ),
    'modified-schiff-pitchfork': (
        <I>
            {L(5, 15, 12, 11)}
            {L(12, 5, 12, 19)}
            {L(12, 5, 20, 6)}
            {L(12, 19, 20, 18)}
            <Dot x={5} y={15} r={1.6} />
        </I>
    ),
    'inside-pitchfork': (
        <I>
            {L(6, 12, 12, 12)}
            {L(12, 7, 12, 17)}
            {L(12, 7, 19, 7)}
            {L(12, 17, 19, 17)}
            <Dot x={6} y={12} r={1.6} />
        </I>
    ),

    fib: (
        <I>
            {L(4, 6, 20, 6)}
            {L(4, 11, 20, 11)}
            {L(4, 15, 20, 15)}
            {L(4, 19, 20, 19)}
            <Dot x={4} y={6} r={1.6} />
            <Dot x={20} y={19} r={1.6} />
        </I>
    ),
    'fib-extension': (
        <I>
            {L(4, 7, 20, 7)}
            {L(4, 11, 20, 11)}
            {L(4, 15, 14, 15)}
            {L(4, 19, 14, 19)}
            <path d="M5 18 L9 11 L13 16" />
        </I>
    ),
    'fib-trend-extension': (
        <I>
            <path d="M4 19 L9 9 L14 14" />
            {L(14, 5, 21, 5)}
            {L(14, 10, 21, 10)}
            {L(14, 15, 21, 15)}
        </I>
    ),
    'fib-channel': (
        <I>
            {L(4, 18, 20, 7)}
            {L(4, 14, 20, 3)}
            {L(4, 21, 20, 10)}
        </I>
    ),
    'fib-time-zone': (
        <I>
            {L(5, 4, 5, 20)}
            {L(9, 4, 9, 20)}
            {L(15, 4, 15, 20)}
            <path d="M21 4 L21 20" strokeDasharray="0.1 4" />
        </I>
    ),
    'fib-speed-fan': (
        <I>
            {L(4, 20, 20, 20)}
            {L(4, 20, 20, 12)}
            {L(4, 20, 20, 5)}
            <Dot x={4} y={20} r={1.6} />
        </I>
    ),
    'fib-circles': (
        <I>
            <circle cx={6} cy={18} r={4} />
            <circle cx={6} cy={18} r={8} />
            <circle cx={6} cy={18} r={12} />
            <Dot x={6} y={18} r={1.4} />
        </I>
    ),
    'fib-spiral': (
        <I>
            <path d="M12 12 a2 2 0 1 1 2 -2 a4 4 0 1 1 -4 4 a6.5 6.5 0 1 1 6.5 -6.5" />
        </I>
    ),
    'fib-wedge': (
        <I>
            {L(4, 20, 20, 4)}
            {L(4, 20, 20, 12)}
            <path d="M20 4 A16 16 0 0 1 20 12" />
            <Dot x={4} y={20} r={1.6} />
        </I>
    ),
    'gann-box': (
        <I>
            <rect x={4} y={4} width={16} height={16} rx={2} />
            {L(4, 20, 20, 4)}
            {L(4, 4, 20, 20)}
        </I>
    ),
    'gann-square': (
        <I>
            <rect x={4} y={4} width={16} height={16} rx={2} />
            {L(12, 4, 12, 20)}
            {L(4, 12, 20, 12)}
        </I>
    ),
    'gann-fan': (
        <I>
            {L(4, 20, 20, 20)}
            {L(4, 20, 20, 13)}
            {L(4, 20, 20, 4)}
            {L(4, 20, 13, 4)}
            <Dot x={4} y={20} r={1.6} />
        </I>
    ),

    xabcd: (
        <I>
            <path d="M4 16 L8 6 L13 18 L17 7 L20 15" />
        </I>
    ),
    cypher: (
        <I>
            <path d="M4 14 L8 6 L12 17 L16 9 L20 13" />
        </I>
    ),
    abcd: (
        <I>
            <path d="M5 18 L10 7 L14 14 L19 5" />
            <Dot x={10} y={7} r={1.6} />
            <Dot x={14} y={14} r={1.6} />
        </I>
    ),
    'head-shoulders': (
        <I>
            <path d="M3 17 L7 12 L9 15 L12 6 L15 15 L17 12 L21 17" />
        </I>
    ),
    'triangle-pattern': (
        <I>
            <path d="M4 6 L20 12 L4 18" />
            <Dot x={20} y={12} r={1.6} />
        </I>
    ),
    'three-drives': (
        <I>
            <path d="M4 18 L7 12 L9 16 L13 8 L15 12 L20 4" />
        </I>
    ),
    'elliott-impulse': (
        <I>
            <path d="M4 18 L8 10 L10 14 L15 5 L17 9 L20 6" />
        </I>
    ),
    'elliott-correction': (
        <I>
            <path d="M5 8 L10 16 L15 9 L19 15" />
        </I>
    ),
    'elliott-triangle': (
        <I>
            <path d="M4 6 L8 16 L12 8 L16 14 L20 10" />
        </I>
    ),
    'elliott-double-combo': (
        <I>
            <path d="M4 8 L8 15 L12 9 L16 15 L20 9" />
        </I>
    ),
    'elliott-triple-combo': (
        <I>
            <path d="M3 9 L6 15 L9 10 L12 15 L15 10 L18 15 L21 10" />
        </I>
    ),

    rect: (
        <I>
            <rect x={4} y={6} width={16} height={12} rx={2} />
        </I>
    ),
    'rotated-rect': (
        <I>
            <path d="M3 14 L10 5 L21 10 L14 19 Z" />
        </I>
    ),
    ellipse: (
        <I>
            <ellipse cx={12} cy={12} rx={9} ry={6} />
        </I>
    ),
    circle: (
        <I>
            <circle cx={12} cy={12} r={8} />
        </I>
    ),
    triangle: (
        <I>
            <path d="M12 4 L20 19 L4 19 Z" />
        </I>
    ),
    polygon: (
        <I>
            <path d="M12 3 L20 9 L17 19 L7 19 L4 9 Z" />
        </I>
    ),
    arc: (
        <I>
            <path d="M4 19 A12 12 0 0 1 20 19" />
            <Dot x={4} y={19} r={1.6} />
            <Dot x={20} y={19} r={1.6} />
        </I>
    ),
    curve: (
        <I>
            <path d="M4 18 C9 4 15 4 20 18" />
        </I>
    ),
    'double-curve': (
        <I>
            <path d="M3 14 C6 6 9 6 12 14 C15 22 18 22 21 14" />
        </I>
    ),
    polyline: (
        <I>
            <path d="M4 18 L9 8 L14 14 L20 5" />
            <Dot x={4} y={18} r={1.6} />
            <Dot x={9} y={8} r={1.6} />
            <Dot x={14} y={14} r={1.6} />
            <Dot x={20} y={5} r={1.6} />
        </I>
    ),
    path: (
        <I>
            <path d="M4 16 C8 16 7 7 12 7 C17 7 16 17 20 17" />
        </I>
    ),

    text: (
        <I>
            {L(5, 6, 19, 6)}
            {L(12, 6, 12, 19)}
        </I>
    ),
    'anchored-text': (
        <I>
            {L(7, 7, 19, 7)}
            {L(13, 7, 13, 18)}
            <Dot x={4} y={20} />
            {L(4, 20, 7, 14)}
        </I>
    ),
    note: (
        <I>
            <path d="M5 4 H19 V15 L14 20 H5 Z" />
            <path d="M19 15 H14 V20" />
        </I>
    ),
    callout: (
        <I>
            <path d="M4 5 H20 V15 H10 L6 19 V15 H4 Z" />
        </I>
    ),
    comment: (
        <I>
            <path d="M4 5 H20 V16 H13 L9 20 V16 H4 Z" />
            {L(8, 10, 16, 10)}
        </I>
    ),
    'price-label': (
        <I>
            <path d="M4 12 L8 7 H20 V17 H8 Z" />
        </I>
    ),
    signpost: (
        <I>
            {L(8, 4, 8, 20)}
            <path d="M8 6 H18 L20 9 L18 12 H8 Z" />
        </I>
    ),
    flag: (
        <I>
            {L(6, 3, 6, 21)}
            <path d="M6 4 H18 L15 8 L18 12 H6 Z" />
        </I>
    ),
    pin: (
        <I>
            <path d="M12 21 C12 21 19 14 19 9 A7 7 0 0 0 5 9 C5 14 12 21 12 21 Z" />
            <circle cx={12} cy={9} r={2.2} />
        </I>
    ),
    table: (
        <I>
            <rect x={4} y={5} width={16} height={14} rx={2} />
            {L(4, 10, 20, 10)}
            {L(12, 5, 12, 19)}
        </I>
    ),

    arrow: (
        <I>
            <path d="M5 19 L19 5" />
            <path d="M11 5 H19 V13" />
        </I>
    ),
    'arrow-marker': (
        <I>
            <path d="M4 20 L20 4" />
            <path d="M20 4 L13 6 L18 11 Z" />
        </I>
    ),
    'arrow-up': (
        <I>
            <path d="M12 20 V5" />
            <path d="M6 11 L12 5 L18 11" />
        </I>
    ),
    'arrow-down': (
        <I>
            <path d="M12 4 V19" />
            <path d="M6 13 L12 19 L18 13" />
        </I>
    ),
    brush: (
        <I>
            <path d="M4 20 C8 20 8 12 12 10 C16 8 14 4 18 4" />
        </I>
    ),
    highlighter: (
        <I>
            <path d="M4 19 L13 10 L17 14 L8 19 Z" />
            <path d="M13 10 L16 7 L20 11 L17 14" />
        </I>
    ),

    long: (
        <I>
            <rect x={4} y={12} width={16} height={6} rx={2} />
            <path d="M12 12 V4" />
            <path d="M8 8 L12 4 L16 8" />
        </I>
    ),
    short: (
        <I>
            <rect x={4} y={6} width={16} height={6} rx={2} />
            <path d="M12 12 V20" />
            <path d="M8 16 L12 20 L16 16" />
        </I>
    ),
    forecast: (
        <I>
            <path d="M4 16 L9 10 L12 13" />
            <path d="M12 13 L20 5" strokeDasharray="3 2" />
            <Dot x={4} y={16} r={1.6} />
        </I>
    ),
    projection: (
        <I>
            <rect x={4} y={5} width={7} height={14} rx={2} />
            <rect x={14} y={9} width={6} height={7} rx={2} strokeDasharray="3 2" />
        </I>
    ),
    'price-range': (
        <I>
            {L(12, 4, 12, 20)}
            <path d="M8 8 L12 4 L16 8" />
            <path d="M8 16 L12 20 L16 16" />
        </I>
    ),
    'date-range': (
        <I>
            {L(4, 12, 20, 12)}
            <path d="M8 8 L4 12 L8 16" />
            <path d="M16 8 L20 12 L16 16" />
        </I>
    ),
    'date-price-range': (
        <I>
            <rect x={5} y={6} width={14} height={12} rx={2} strokeDasharray="3 2" />
            {L(5, 18, 19, 6)}
        </I>
    ),
    'bars-pattern': (
        <I>
            {L(7, 6, 7, 18)}
            {L(5, 9, 7, 9)}
            {L(7, 14, 9, 14)}
            {L(14, 5, 14, 19)}
            {L(12, 8, 14, 8)}
            {L(14, 12, 16, 12)}
        </I>
    ),
    'ghost-feed': (
        <I>
            {L(6, 6, 6, 16)}
            {L(11, 9, 11, 19)}
            <path d="M16 6 V16" strokeDasharray="3 2" />
            <path d="M20 9 V19" strokeDasharray="3 2" />
        </I>
    ),

    fvp: (
        <I>
            {L(4, 6, 13, 6)}
            {L(4, 10, 19, 10)}
            {L(4, 14, 10, 14)}
            {L(4, 18, 16, 18)}
        </I>
    ),
    'anchored-volume-profile': (
        <I>
            {L(5, 4, 5, 20)}
            {L(7, 7, 14, 7)}
            {L(7, 11, 20, 11)}
            {L(7, 15, 12, 15)}
            <Dot x={5} y={20} r={1.6} />
        </I>
    ),
    'fixed-range-volume': (
        <I>
            {L(5, 4, 5, 20)}
            {L(19, 4, 19, 20)}
            {L(7, 9, 13, 9)}
            {L(7, 14, 16, 14)}
        </I>
    ),
    'anchored-vwap': (
        <I>
            <path d="M4 18 C9 18 9 8 14 8 C18 8 18 13 20 13" />
            <Dot x={4} y={18} />
        </I>
    ),
    ruler: (
        <I>
            <rect x={3} y={8} width={18} height={8} rx={2} transform="rotate(-20 12 12)" />
            {L(8, 7, 9, 9)}
            {L(11, 5.5, 12, 7.5)}
            {L(14, 4, 15, 6)}
        </I>
    ),
};
