//  Renders committed drawings (with optional selection state) + draft ghost.
// also exports the hit-testing, for hover and click detection
import { Crosshair, snapPrice, snapTs } from './renderer';
import { resolveTickSize, formatPrice } from '../priceFormat';
import type { SymbolInfo } from '../../core';
import type { ChartPane } from '../types/indicator-types';
import { getPaneLayouts } from '../types/indicator-types';
import type {
    Anchor,
    Drawing,
    DraftDrawing,
    HitResult,
    DrawingAnchorId,
    HLineDrawing,
    VLineDrawing,
    LineDrawing,
    RayDrawing,
    RectDrawing,
    FibDrawing,
    TextDrawing,
    LabelStyle,
    FixedVolumeProfileDrawing,
    LongDrawing,
    ShortDrawing,
    PluginDraftDrawing,
    ExtLineDrawing,
    HorzRayDrawing,
    CrossLineDrawing,
    InfoLineDrawing,
    TrendAngleDrawing,
    ParallelChannelDrawing,
    TriangleDrawing,
} from '../types/drawing-types';
import {
    HIT_TOLERANCE_PX,
    DEFAULT_FIB_LEVELS,
    DEFAULT_CHANNEL_LEVELS,
} from '../types/drawing-types';
import { ChartSettings } from '../types/chart-settings';
import { FootprintBar } from '../types/footprint';
import { PriceHistory, ViewBounds } from '../types';
import { LiveTransformer } from '../../core';
import { drawingRegistry } from '../../core/DrawingRegistry';
import type { PluginDrawing } from '../types/drawing-types';
import { getEffectiveDpr } from '../dpr';

// these have to match renderer.ts
export const Y_AXIS_WIDTH = 65;
export const X_AXIS_HEIGHT = 30;

const HANDLE_RADIUS = 5; // selected anchor circle radius
const HANDLE_RADIUS_HOVER = 5;
const SELECTION_GLOW = 'rgba(255,255,255,0.18)';

/**
 * Snap a timestamp to the nearest bar-open boundary.
 * When barNs is 0n (tick/raw mode) the value is returned unchanged.
 */
export function snapTsToBar(ts: bigint, barNs: bigint): bigint {
    if (barNs <= 0n) return ts;
    return (ts / barNs) * barNs;
}

// Geometry helpers
function ptSegDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax,
        dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function extendedEndpoints(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    w: number,
    extLeft: boolean = false,
    extRight: boolean = false,
): [number, number, number, number] {
    if (x1 === x2) return [x1, extLeft ? -99999 : y1, x2, extRight ? 99999 : y2];
    const slope = (y2 - y1) / (x2 - x1);
    let sx = x1,
        sy = y1,
        ex = x2,
        ey = y2;
    if (extLeft) {
        sx = 0;
        sy = y1 + slope * (0 - x1);
    }
    if (extRight) {
        ex = w;
        ey = y1 + slope * (w - x1);
    }
    return [sx, sy, ex, ey];
}

function applyStroke(ctx: CanvasRenderingContext2D, color: string, lw: number, dash: number[]) {
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.setLineDash(dash ?? []);
}
function hexToRgba(hex: string, alpha?: number): string {
    const h = hex.replace('#', '');

    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);

    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : (alpha ?? 1);

    return `rgba(${r},${g},${b},${a})`;
}
/** Drop any alpha suffix so a color can be used as a fully opaque stroke/fill. */
function hexSolid(hex: string): string {
    return `#${hex.replace('#', '').slice(0, 6)}`;
}
function hexToAlpha(hex: string, fallback: number = 1): number {
    const h = hex.replace('#', '');

    if (h.length === 8) {
        return parseInt(h.slice(6, 8), 16) / 255;
    }

    return fallback;
}

// Compact human duration from a nanosecond span (anchor ts are UTC market ns).
function formatInfoDuration(ns: bigint): string {
    const s = Math.abs(Number(ns)) / 1e9;
    if (s < 60) return `${Math.round(s)}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m`;
    const day = Math.floor(h / 24);
    return `${day}d ${h % 24}h`;
}

// tiny vector icons for the info box, since canvas has no reliable icon font.
// each draws centered on (cx, cy) inside a square of side s, in colour c.
type InfoIcon = (
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    s: number,
    c: string,
) => void;

const iconTriangle =
    (up: boolean): InfoIcon =>
    (ctx, cx, cy, s, c) => {
        const r = s / 2;
        ctx.beginPath();
        if (up) {
            ctx.moveTo(cx, cy - r);
            ctx.lineTo(cx + r, cy + r);
            ctx.lineTo(cx - r, cy + r);
        } else {
            ctx.moveTo(cx, cy + r);
            ctx.lineTo(cx + r, cy - r);
            ctx.lineTo(cx - r, cy - r);
        }
        ctx.closePath();
        ctx.fillStyle = c;
        ctx.fill();
    };

const iconPercent: InfoIcon = (ctx, cx, cy, s, c) => {
    const r = s / 2;
    const dot = s * 0.16;
    ctx.strokeStyle = c;
    ctx.fillStyle = c;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - r, cy + r);
    ctx.lineTo(cx + r, cy - r);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx - r + dot, cy - r + dot, dot, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx + r - dot, cy + r - dot, dot, 0, Math.PI * 2);
    ctx.fill();
};

const iconClock: InfoIcon = (ctx, cx, cy, s, c) => {
    const r = s / 2;
    ctx.strokeStyle = c;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, cy - r * 0.55); // minute hand (up)
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + r * 0.5, cy); // hour hand (right)
    ctx.stroke();
};

const iconAngle: InfoIcon = (ctx, cx, cy, s, c) => {
    const r = s / 2;
    const x0 = cx - r,
        y0 = cy + r;
    ctx.strokeStyle = c;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + s, y0); // base
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + s, y0 - s); // hypotenuse
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x0, y0, s * 0.5, -Math.PI / 4, 0); // sweep arc
    ctx.stroke();
};

const iconBars: InfoIcon = (ctx, cx, cy, s, c) => {
    const r = s / 2;
    const bw = s / 4;
    const heights = [0.45, 0.8, 0.6];
    ctx.fillStyle = c;
    heights.forEach((hf, i) => {
        const bx = cx - r + i * (bw + bw / 2);
        const bh = s * hf;
        ctx.fillRect(bx, cy + r - bh, bw, bh);
    });
};

function drawInfoLineBox(
    ctx: CanvasRenderingContext2D,
    d: InfoLineDrawing,
    bounds: ViewBounds,
    chartW: number,
    chartH: number,
    oy: number,
    transformer: LiveTransformer,
) {
    const x1 = transformer.tsToX(d.a.ts, chartW),
        y1 = transformer.priceToY(d.a.price, chartH) + oy;
    const x2 = transformer.tsToX(d.b.ts, chartW),
        y2 = transformer.priceToY(d.b.price, chartH) + oy;

    // Content
    const dPrice = d.b.price - d.a.price;
    const pct = d.a.price !== 0 ? (dPrice / d.a.price) * 100 : 0;
    const up = dPrice >= 0;
    const sign = up ? '+' : '−';
    const angleDeg = (Math.atan2(y1 - y2, x2 - x1) * 180) / Math.PI; // on-screen angle
    const accent = up ? '#26a69a' : '#ef5350';
    const muted = '#aab0bd';

    const rows: { icon: InfoIcon; text: string; color: string }[] = [
        { icon: iconTriangle(up), text: `${sign}${Math.abs(dPrice).toFixed(2)}`, color: accent },
        { icon: iconPercent, text: `${sign}${Math.abs(pct).toFixed(2)}%`, color: accent },
        { icon: iconClock, text: formatInfoDuration(d.b.ts - d.a.ts), color: muted },
        { icon: iconAngle, text: `${angleDeg.toFixed(1)}°`, color: muted },
        {
            icon: iconBars,
            text: `${d.a.price.toFixed(2)} → ${d.b.price.toFixed(2)}`,
            color: muted,
        },
    ];

    // Measure & size the box to its content
    const FS = 11;
    const PADX = 9;
    const PADY = 7;
    const LH = FS + 6;
    const ICON = 11;
    const ICON_GAP = 7;
    ctx.save();
    ctx.font = `${FS}px monospace`;
    const textW = Math.max(...rows.map((r) => ctx.measureText(r.text).width));
    const w = Math.ceil(PADX + ICON + ICON_GAP + textW + PADX);
    const h = rows.length * LH + PADY * 2;

    // Anchor + fixed gap (box tracks the midpoint, no angle dependence)
    const pointingRight = x2 > x1;
    const pointingUp = y1 > y2;
    const anchoredCorner = pointingRight ? (pointingUp ? 'tl' : 'bl') : pointingUp ? 'bl' : 'tl';
    const mx = 15;
    const my = 15;
    const boxX = (x1 + x2) / 2 + mx;
    const boxY =
        (y1 + y2) / 2 - (anchoredCorner === 'bl' ? h : 0) + (anchoredCorner === 'bl' ? -my : my);

    // Draw rounded box
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, w, h, 6);
    ctx.fillStyle = 'rgba(20, 22, 28, 0.92)';
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Rows: icon in the gutter + text
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const iconCX = boxX + PADX + ICON / 2;
    const textX = boxX + PADX + ICON + ICON_GAP;
    rows.forEach((r, i) => {
        const cy = boxY + PADY + LH * i + LH / 2;
        r.icon(ctx, iconCX, cy, ICON, r.color);
        ctx.fillStyle = r.color;
        ctx.fillText(r.text, textX, cy);
    });

    ctx.restore();
}

function drawTrendAngle(
    ctx: CanvasRenderingContext2D,
    d: { a: Anchor; b: Anchor },
    bounds: ViewBounds,
    chartW: number,
    chartH: number,
    oy: number,
    transformer: LiveTransformer,
) {
    const x1 = transformer.tsToX(d.a.ts, chartW),
        y1 = transformer.priceToY(d.a.price, chartH) + oy;
    const x2 = transformer.tsToX(d.b.ts, chartW),
        y2 = transformer.priceToY(d.b.price, chartH) + oy;

    const angleDeg = (Math.atan2(y1 - y2, x2 - x1) * 180) / Math.PI;

    ctx.save();

    ctx.font = `500 11px ui-monospace, monospace`;
    ctx.fillStyle = '#3377ff';
    ctx.strokeStyle = '#3377ff';
    ctx.setLineDash([1, 2]);
    ctx.fillText(String(angleDeg.toFixed(2)) + '°', x1 + 55, y1 + 3);

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 + 50, y1);

    ctx.arc(
        x1,
        y1,
        50,
        0,
        (angleDeg <= 0 ? 0 : Math.PI * 2) - Math.atan2(y1 - y2, x2 - x1),
        angleDeg <= 0 ? false : true,
    );
    ctx.stroke();

    // Clear the path we just built. save()/restore() restores style but NOT the
    // current path, so a caller's later stroke() would otherwise repaint this arc.
    ctx.beginPath();
    ctx.restore();
}

function drawHandle(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    color: string,
    isHot = false, // true when this specific handle is being hovered
) {
    const r = isHot ? HANDLE_RADIUS_HOVER : HANDLE_RADIUS;
    // Glow ring
    ctx.beginPath();
    ctx.arc(x, y, r + 2, 0, Math.PI * 2);
    ctx.fillStyle = SELECTION_GLOW;
    ctx.fill();
    // Filled circle
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.stroke();
}

// currently a no-op. the anchor handles already show selection, so the outline
// is off - kept because every drawing calls it and it may come back.
function selectionStroke(ctx: CanvasRenderingContext2D, lw: number) {}

function labelFont(ls: LabelStyle): string {
    const style = ls.labelItalic ? 'italic ' : '';
    const weight = ls.labelBold ? '700 ' : '400 ';
    const size = ls.labelFontSize ?? 11;
    return `${style}${weight}${size}px "Inter", monospace`;
}

/**
 * Draw the label for a horizontal line.
 *
 * vAlign:
 *   top    - text sits above the line (default)
 *   bottom - text sits below the line
 *   middle - text sits ON the line; the line is broken behind the text
 *
 * hAlign positions the text along the chart width.
 *
 * When vAlign === 'middle', this function also DRAWS the gap.  The caller
 * must therefore call this AFTER the line stroke so the gap erases the line.
 */
function drawHLineLabel(
    ctx: CanvasRenderingContext2D,
    ls: LabelStyle,
    lineColor: string,
    lineY: number,
    w: number,
    // extra stroke params needed to redraw line segments around the gap
    lineWidth: number,
    dash: number[],
) {
    if (!ls.label) return;
    const font = labelFont(ls);
    ctx.font = font;
    ctx.setLineDash([]);

    const hAlign = ls.labelHorizontalAlign ?? 'left';
    const vAlign = ls.labelVerticalAlign ?? 'top';
    const size = ls.labelFontSize ?? 11;
    const PAD = 6;
    const GAP = 8; // extra padding each side of the text gap

    // Measure text width
    const textW = ctx.measureText(ls.label).width;

    // Horizontal anchor point for the text
    let tx: number;
    let canvasAlign: CanvasTextAlign;
    if (hAlign === 'left') {
        canvasAlign = 'left';
        tx = PAD;
    } else if (hAlign === 'right') {
        canvasAlign = 'right';
        tx = w - PAD;
    } else {
        canvasAlign = 'center';
        tx = w / 2;
    }
    ctx.textAlign = canvasAlign;

    // Text left/right edges (for gap calculation)
    let gapL: number, gapR: number;
    if (canvasAlign === 'left') {
        gapL = tx - GAP;
        gapR = tx + textW + GAP;
    } else if (canvasAlign === 'right') {
        gapL = tx - textW - GAP;
        gapR = tx + GAP;
    } else {
        gapL = tx - textW / 2 - GAP;
        gapR = tx + textW / 2 + GAP;
    }
    gapL = Math.max(0, gapL);
    gapR = Math.min(w, gapR);

    // Vertical position
    let ty: number;
    if (vAlign === 'top') {
        ty = lineY - 4;
    } else if (vAlign === 'bottom') {
        ty = lineY + size + 2;
    } else {
        // middle: text sits on the line
        ty = lineY + size * 0.35;
    }

    // Draw the line here, with the gap baked in if text overlaps it
    // drawHLineLabel owns the stroke entirely when a label is present, so
    // renderHLine must skip its own full-width stroke (see call site).
    const textTop = ty - size;
    const textBot = ty + size * 0.3;
    const lineOverlapsText = lineY >= textTop && lineY <= textBot;

    applyStroke(ctx, lineColor, lineWidth, dash);
    if (lineOverlapsText) {
        if (gapL > 0) {
            ctx.beginPath();
            ctx.moveTo(0, lineY);
            ctx.lineTo(gapL, lineY);
            ctx.stroke();
        }
        if (gapR < w) {
            ctx.beginPath();
            ctx.moveTo(gapR, lineY);
            ctx.lineTo(w, lineY);
            ctx.stroke();
        }
    } else {
        ctx.beginPath();
        ctx.moveTo(0, lineY);
        ctx.lineTo(w, lineY);
        ctx.stroke();
    }
    ctx.setLineDash([]);

    ctx.fillStyle = ls.labelColor ?? lineColor;
    ctx.fillText(ls.label, tx, ty);
}

/**
 * Draw the label for a vertical line.
 *
 * labelTextOrientation (from LabelStyle):
 *   'horizontal' (default) - text is drawn horizontally to the left or right
 *   'vertical'             - text is rotated 90° and runs along the line
 *
 * For vertical orientation with vAlign === 'middle', the line is gapped.
 */
function drawVLineLabel(
    ctx: CanvasRenderingContext2D,
    ls: LabelStyle,
    lineColor: string,
    lineX: number,
    totalH: number,
    lineWidth: number,
    dash: number[],
) {
    if (!ls.label) return;
    ctx.font = labelFont(ls);
    ctx.fillStyle = ls.labelColor ?? lineColor;
    ctx.setLineDash([]);

    const hAlign = ls.labelHorizontalAlign ?? 'right'; // left/right of the vline
    const vAlign = ls.labelVerticalAlign ?? 'top';
    const isVertical = (ls as any).labelTextOrientation === 'vertical';
    const size = ls.labelFontSize ?? 11;
    const PAD = 6;
    const GAP = 6;

    if (!isVertical) {
        // Horizontal text
        let ty: number;
        if (vAlign === 'top') {
            ty = PAD + size;
        } else if (vAlign === 'bottom') {
            ty = totalH - PAD;
        } else {
            ty = totalH / 2 + size * 0.35;
        }

        // Check whether the line passes through the text bounding box.
        // Text spans horizontally around lineX depending on alignment; vertically [ty-size, ty+0.3*size].
        const textW = ctx.measureText(ls.label).width;
        const textTop = ty - size;
        const textBot = ty + size * 0.3;
        let textLeft: number, textRight: number;
        if (hAlign === 'left') {
            // text is to the LEFT of the line (textAlign='right', ends at lineX-PAD)
            textLeft = lineX - PAD - textW;
            textRight = lineX - PAD;
        } else if (hAlign === 'right') {
            // text is to the RIGHT of the line (textAlign='left', starts at lineX+PAD)
            textLeft = lineX + PAD;
            textRight = lineX + PAD + textW;
        } else {
            // center: text straddles the line
            textLeft = lineX - textW / 2;
            textRight = lineX + textW / 2;
        }
        // the line spans the full height, so its vertical span always intersects
        // the text - overlapping on x is the whole test
        const textOverlapsLine = lineX >= textLeft && lineX <= textRight;
        const gapTop2 = textTop - GAP;
        const gapBot2 = textBot + GAP;

        // Own the stroke: draw with gap if text overlaps the line, otherwise full stroke.
        applyStroke(ctx, lineColor, lineWidth, dash);
        if (textOverlapsLine) {
            if (gapTop2 > 0) {
                ctx.beginPath();
                ctx.moveTo(lineX, 0);
                ctx.lineTo(lineX, gapTop2);
                ctx.stroke();
            }
            if (gapBot2 < totalH) {
                ctx.beginPath();
                ctx.moveTo(lineX, gapBot2);
                ctx.lineTo(lineX, totalH);
                ctx.stroke();
            }
        } else {
            ctx.beginPath();
            ctx.moveTo(lineX, 0);
            ctx.lineTo(lineX, totalH);
            ctx.stroke();
        }
        ctx.setLineDash([]);

        ctx.save();
        if (hAlign === 'left') {
            ctx.textAlign = 'right';
            ctx.fillText(ls.label, lineX - PAD, ty);
        } else if (hAlign === 'right') {
            ctx.textAlign = 'left';
            ctx.fillText(ls.label, lineX + PAD, ty);
        } else {
            ctx.textAlign = 'center';
            ctx.fillText(ls.label, lineX, ty);
        }
        ctx.restore();
        return;
    }

    // Vertical text (rotated -90°, reads bottom-to-top)
    const textW = ctx.measureText(ls.label).width;
    const GAP_EXTRA = 8;

    // Vertical position of the text midpoint along the line
    let textMidY: number;
    if (vAlign === 'top') {
        textMidY = PAD + textW / 2;
    } else if (vAlign === 'bottom') {
        textMidY = totalH - PAD - textW / 2;
    } else {
        textMidY = totalH / 2;
    }

    // Gap in the line behind the text - always, regardless of vAlign
    const gapTop = textMidY - textW / 2 - GAP_EXTRA;
    const gapBot = textMidY + textW / 2 + GAP_EXTRA;

    // Own the stroke here (renderVLine skips its own stroke when a label exists)
    applyStroke(ctx, lineColor, lineWidth, dash);
    if (gapTop > 0) {
        ctx.beginPath();
        ctx.moveTo(lineX, 0);
        ctx.lineTo(lineX, gapTop);
        ctx.stroke();
    }
    if (gapBot < totalH) {
        ctx.beginPath();
        ctx.moveTo(lineX, gapBot);
        ctx.lineTo(lineX, totalH);
        ctx.stroke();
    }
    ctx.setLineDash([]);

    // Horizontal offset - which side of the line the rotated text sits on.
    // 'left'   -> text to the left  of the line
    // 'right'  -> text to the right of the line
    // 'center' -> text centred on the line itself
    let tx: number;
    if (hAlign === 'left') {
        tx = lineX - GAP - size / 2;
    } else if (hAlign === 'right') {
        tx = lineX + GAP + size / 2;
    } else {
        // center: sit the text directly on the line
        tx = lineX;
    }

    ctx.save();
    ctx.translate(tx, textMidY);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillStyle = ls.labelColor ?? lineColor;
    ctx.fillText(ls.label, 0, size * 0.35);
    ctx.restore();
}

/**
 * Draw the label for a two-anchor drawing (line / ray / rect).
 *
 * LINE / RAY:
 *   The text is rotated to match the drawing's angle so it runs alongside
 *   the line.  The angle is always normalised to (-90°, +90°] so text is
 *   never upside-down; when the line points left the coordinate frame is
 *   flipped, which also automatically swaps the meaning of hAlign (so
 *   'left' always means "towards anchor a" in screen space).
 *
 *   hAlign - along the line: left = towards a, center = midpoint, right = towards b
 *   vAlign - perpendicular:  top = above line, middle = ON line (gapped), bottom = below
 *
 * RECT:
 *   Axis-aligned placement inside the bounding box.
 */
function drawAnchoredLabel(
    ctx: CanvasRenderingContext2D,
    ls: LabelStyle,
    lineColor: string,
    kind: 'line' | 'rect',
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    lineWidth?: number,
    dash?: number[],
    // drawn extents for extended lines/rays (defaults to x1/y1..x2/y2)
    drawnX1?: number,
    drawnY1?: number,
    drawnX2?: number,
    drawnY2?: number,
) {
    if (!ls.label) return;
    ctx.font = labelFont(ls);
    ctx.setLineDash([]);

    const size = ls.labelFontSize ?? 11;
    const PAD = 6;
    const GAP = 8;

    if (kind === 'rect') {
        // Axis-aligned placement inside the bounding box
        const rx = Math.min(x1, x2);
        const ry = Math.min(y1, y2);
        const rw = Math.abs(x2 - x1);
        const rh = Math.abs(y2 - y1);

        const hAlign = ls.labelHorizontalAlign ?? 'left';
        const vAlign = ls.labelVerticalAlign ?? 'top';

        let tx: number;
        if (hAlign === 'left') {
            ctx.textAlign = 'left';
            tx = rx + PAD;
        } else if (hAlign === 'right') {
            ctx.textAlign = 'right';
            tx = rx + rw - PAD;
        } else {
            ctx.textAlign = 'center';
            tx = rx + rw / 2;
        }

        let ty: number;
        if (vAlign === 'top') {
            ty = ry + PAD + size;
        } else if (vAlign === 'bottom') {
            ty = ry + rh - PAD;
        } else {
            ty = ry + rh / 2 + size * 0.35;
        }

        ctx.fillStyle = ls.labelColor ?? lineColor;
        ctx.fillText(ls.label, tx, ty);
        return;
    }

    // Rotated label for line / ray
    const hAlign = ls.labelHorizontalAlign ?? 'center';
    const vAlign = ls.labelVerticalAlign ?? 'top';

    // Raw angle of the a->b vector (canvas coords: y increases downward)
    let angle = Math.atan2(y2 - y1, x2 - x1);

    // Track whether we need to flip the frame to keep text right-side-up.
    const flipped = angle > Math.PI / 2 || angle <= -Math.PI / 2;
    if (flipped) {
        angle += angle > 0 ? -Math.PI : Math.PI;
    }

    // After normalisation the rotated frame's +x axis always points roughly
    // rightward on screen.  Choose the origin by *screen* position so that
    // 'left' = leftmost end on screen, 'right' = rightmost end on screen.
    // We use the x-coordinate to decide which physical point is left/right.
    // (For a nearly-vertical line we fall back to y: higher y = more "right"
    //  after rotation, but screen-x is the dominant axis here.)
    const aIsLeft = x1 <= x2; // true when A is the left end on screen
    let originX: number, originY: number;

    if (hAlign === 'center') {
        originX = (x1 + x2) / 2;
        originY = (y1 + y2) / 2;
    } else if (hAlign === 'left') {
        // Visually leftmost end
        originX = aIsLeft ? x1 : x2;
        originY = aIsLeft ? y1 : y2;
    } else {
        // hAlign === 'right': visually rightmost end
        originX = aIsLeft ? x2 : x1;
        originY = aIsLeft ? y2 : y1;
    }

    // textAlign pins the matching edge of the text to the origin:
    // 'left' origin  -> left  edge flush with the left  end -> text grows rightward (inward) ✓
    // 'right' origin -> right edge flush with the right end -> text grows leftward  (inward) ✓
    // Flip does not change this - the visual edge-pinning is what the user expects.
    let canvasAlign: CanvasTextAlign;
    if (hAlign === 'center') {
        canvasAlign = 'center';
    } else if (hAlign === 'left') {
        canvasAlign = 'left';
    } else {
        canvasAlign = 'right';
    }

    // Along-line nudge: push text inward from the endpoint.
    // The nudge direction in the rotated frame reverses when flipped.
    const padSign = flipped ? -1 : 1;
    const alongPad = hAlign === 'left' ? PAD * padSign : hAlign === 'right' ? -PAD * padSign : 0;

    // Measure text to compute the gap when vAlign === 'middle'
    const textW = ctx.measureText(ls.label).width;

    // Perpendicular offset (positive = above the line in screen space after rotation)
    let perpOffset: number;
    if (vAlign === 'top') {
        perpOffset = -(size + 4); // above
    } else if (vAlign === 'bottom') {
        perpOffset = size + 2; // below
    } else {
        perpOffset = size * 0.35; // on the line
    }

    // Own the stroke: draw with gap whenever the text overlaps the line
    // perpOffset is the text baseline's distance from the line in the rotated
    // frame (positive = below, negative = above).  The text body occupies
    // roughly [perpOffset - size, perpOffset + size*0.3] perpendicularly.
    // Gap whenever that band straddles 0 (i.e. the line itself).
    if (lineWidth !== undefined && dash !== undefined) {
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const perpTop = perpOffset - size; // top of text (above baseline)
        const perpBot = perpOffset + size * 0.3; // bottom of text (descenders)
        const textOnLine = perpTop <= 0 && perpBot >= 0;

        // Project the full drawn line extents onto the line axis from originX/Y
        const dot = (px: number, py: number) => (px - originX) * cos + (py - originY) * sin;
        const ex1 = drawnX1 ?? x1,
            ey1 = drawnY1 ?? y1;
        const ex2 = drawnX2 ?? x2,
            ey2 = drawnY2 ?? y2;
        const t1 = dot(ex1, ey1);
        const t2 = dot(ex2, ey2);
        const tMin = Math.min(t1, t2);
        const tMax = Math.max(t1, t2);

        applyStroke(ctx, lineColor, lineWidth, dash);
        if (textOnLine) {
            // Gap bounds must account for alongPad (the inward nudge from the endpoint)
            // and canvasAlign (which edge of the text is pinned to the origin).
            // All values are in the rotated frame (t along the line from originX/Y).
            let tGapL: number, tGapR: number;
            if (canvasAlign === 'center') {
                tGapL = alongPad - textW / 2 - GAP;
                tGapR = alongPad + textW / 2 + GAP;
            } else if (canvasAlign === 'left') {
                // left edge of text is at alongPad; text grows rightward
                tGapL = alongPad - GAP;
                tGapR = alongPad + textW + GAP;
            } else {
                // right edge of text is at alongPad; text grows leftward
                tGapL = alongPad - textW - GAP;
                tGapR = alongPad + GAP;
            }
            if (tMin < tGapL) {
                ctx.beginPath();
                ctx.moveTo(originX + cos * tMin, originY + sin * tMin);
                ctx.lineTo(originX + cos * tGapL, originY + sin * tGapL);
                ctx.stroke();
            }
            if (tMax > tGapR) {
                ctx.beginPath();
                ctx.moveTo(originX + cos * tGapR, originY + sin * tGapR);
                ctx.lineTo(originX + cos * tMax, originY + sin * tMax);
                ctx.stroke();
            }
        } else {
            ctx.beginPath();
            ctx.moveTo(originX + cos * tMin, originY + sin * tMin);
            ctx.lineTo(originX + cos * tMax, originY + sin * tMax);
            ctx.stroke();
        }
        ctx.setLineDash([]);
    }

    // Draw the text in the rotated frame
    ctx.save();
    ctx.translate(originX, originY);
    ctx.rotate(angle);
    ctx.textAlign = canvasAlign;
    ctx.fillStyle = ls.labelColor ?? lineColor;
    ctx.fillText(ls.label, alongPad, perpOffset);
    ctx.restore();
}

// Per-type draw functions
function renderHLine(
    ctx: CanvasRenderingContext2D,
    d: HLineDrawing,
    bounds: ViewBounds,
    w: number,
    h: number,
    oy: number,
    selected: boolean,
    hovered: boolean,
    hotAnchor: DrawingAnchorId | null,
    transformer: LiveTransformer,
) {
    const y = transformer.priceToY(d.price, h) + oy;
    if (y < oy || y > oy + h) return;

    if (selected) {
        selectionStroke(ctx, d.lineWidth);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
    }
    if (d.label) {
        // drawHLineLabel owns the stroke when a label is present so it can
        // bake the gap in from the start rather than trying to erase over it.
        drawHLineLabel(ctx, d, d.color, y, w, d.lineWidth, d.dash);
    } else {
        applyStroke(ctx, d.color, d.lineWidth, d.dash);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
    }

    if (selected || hovered) drawHandle(ctx, w / 2, y, d.color, hotAnchor === 'body');
}

function renderVLine(
    ctx: CanvasRenderingContext2D,
    d: VLineDrawing,
    bounds: ViewBounds,
    w: number,
    totalH: number,
    selected: boolean,
    hovered: boolean,
    hotAnchor: DrawingAnchorId | null,
    transformer: LiveTransformer,
) {
    const x = transformer.tsToX(d.ts, w);
    if (x < 0 || x > w) return;

    if (selected) {
        selectionStroke(ctx, d.lineWidth);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, totalH);
        ctx.stroke();
    }
    if (d.label) {
        // drawVLineLabel owns the stroke when a label is present
        drawVLineLabel(ctx, d, d.color, x, totalH, d.lineWidth, d.dash);
    } else {
        applyStroke(ctx, d.color, d.lineWidth, d.dash);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, totalH);
        ctx.stroke();
    }

    if (selected || hovered) drawHandle(ctx, x, totalH / 2, d.color, hotAnchor === 'body');
}

function renderExtLine(
    ctx: CanvasRenderingContext2D,
    d: ExtLineDrawing,
    bounds: ViewBounds,
    w: number,
    h: number,
    oy: number,
    selected: boolean,
    hovered: boolean,
    hotAnchor: DrawingAnchorId | null,
    transformer: LiveTransformer,
) {
    const x1 = transformer.tsToX(d.a.ts, w),
        y1 = transformer.priceToY(d.a.price, h) + oy;
    const x2 = transformer.tsToX(d.b.ts, w),
        y2 = transformer.priceToY(d.b.price, h) + oy;
    const [sx, sy, ex, ey] = extendedEndpoints(x1, y1, x2, y2, w, d.extendLeft, d.extendRight);

    if (selected) {
        selectionStroke(ctx, d.lineWidth);
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
    }
    if (d.label) {
        // drawAnchoredLabel owns the stroke when a label is present
        drawAnchoredLabel(
            ctx,
            d,
            d.color,
            'line',
            x1,
            y1,
            x2,
            y2,
            d.lineWidth,
            d.dash,
            sx,
            sy,
            ex,
            ey,
        );
    } else {
        applyStroke(ctx, d.color, d.lineWidth, d.dash);
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
    }

    if (selected || hovered) {
        drawHandle(ctx, x1, y1, d.color, hotAnchor === 'a');
        drawHandle(ctx, x2, y2, d.color, hotAnchor === 'b');
    }
}

function renderLine(
    ctx: CanvasRenderingContext2D,
    d: LineDrawing,
    bounds: ViewBounds,
    w: number,
    h: number,
    oy: number,
    selected: boolean,
    hovered: boolean,
    hotAnchor: DrawingAnchorId | null,
    transformer: LiveTransformer,
) {
    const x1 = transformer.tsToX(d.a.ts, w),
        y1 = transformer.priceToY(d.a.price, h) + oy;
    const x2 = transformer.tsToX(d.b.ts, w),
        y2 = transformer.priceToY(d.b.price, h) + oy;
    const [sx, sy, ex, ey] = extendedEndpoints(x1, y1, x2, y2, w, d.extendLeft, d.extendRight);

    if (selected) {
        selectionStroke(ctx, d.lineWidth);
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
    }
    if (d.label) {
        // drawAnchoredLabel owns the stroke when a label is present
        drawAnchoredLabel(
            ctx,
            d,
            d.color,
            'line',
            x1,
            y1,
            x2,
            y2,
            d.lineWidth,
            d.dash,
            sx,
            sy,
            ex,
            ey,
        );
    } else {
        applyStroke(ctx, d.color, d.lineWidth, d.dash);
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
    }

    if (selected || hovered) {
        drawHandle(ctx, x1, y1, d.color, hotAnchor === 'a');
        drawHandle(ctx, x2, y2, d.color, hotAnchor === 'b');
    }
}

function renderCrossLine(
    ctx: CanvasRenderingContext2D,
    d: CrossLineDrawing,
    bounds: ViewBounds,
    w: number,
    h: number,
    oy: number,
    selected: boolean,
    hovered: boolean,
    hotAnchor: DrawingAnchorId | null,
    transformer: LiveTransformer,
) {
    const y = transformer.priceToY(d.price, h) + oy;
    const x = transformer.tsToX(d.ts, w);
    if ((y < oy && x < 0) || (y > oy + h && x > w)) return;

    if (selected) {
        selectionStroke(ctx, d.lineWidth);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.moveTo(x, oy);
        ctx.lineTo(x, h);
        ctx.stroke();
    }
    if (d.label) {
        // drawHLineLabel owns the stroke when a label is present so it can
        // bake the gap in from the start rather than trying to erase over it.
        drawHLineLabel(ctx, d, d.color, y, w, d.lineWidth, d.dash);
    } else {
        applyStroke(ctx, d.color, d.lineWidth, d.dash);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.moveTo(x, oy);
        ctx.lineTo(x, h);
        ctx.stroke();
    }

    if (selected || hovered) drawHandle(ctx, x, y, d.color, hotAnchor === 'body');
}

function renderInfoLine(
    ctx: CanvasRenderingContext2D,
    d: InfoLineDrawing,
    bounds: ViewBounds,
    w: number,
    h: number,
    oy: number,
    selected: boolean,
    hovered: boolean,
    hotAnchor: DrawingAnchorId | null,
    transformer: LiveTransformer,
) {
    const x1 = transformer.tsToX(d.a.ts, w),
        y1 = transformer.priceToY(d.a.price, h) + oy;
    const x2 = transformer.tsToX(d.b.ts, w),
        y2 = transformer.priceToY(d.b.price, h) + oy;
    const [sx, sy, ex, ey] = extendedEndpoints(x1, y1, x2, y2, w, d.extendLeft, d.extendRight);

    if (selected) {
        selectionStroke(ctx, d.lineWidth);
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
    }
    if (d.label) {
        // drawAnchoredLabel owns the stroke when a label is present
        drawAnchoredLabel(
            ctx,
            d,
            d.color,
            'line',
            x1,
            y1,
            x2,
            y2,
            d.lineWidth,
            d.dash,
            sx,
            sy,
            ex,
            ey,
        );
    } else {
        applyStroke(ctx, d.color, d.lineWidth, d.dash);
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
    }

    drawInfoLineBox(ctx, d, bounds, w, h, oy, transformer);

    if (selected || hovered) {
        drawHandle(ctx, x1, y1, d.color, hotAnchor === 'a');
        drawHandle(ctx, x2, y2, d.color, hotAnchor === 'b');
    }
}

function renderTrendAngle(
    ctx: CanvasRenderingContext2D,
    d: TrendAngleDrawing,
    bounds: ViewBounds,
    w: number,
    h: number,
    oy: number,
    selected: boolean,
    hovered: boolean,
    hotAnchor: DrawingAnchorId | null,
    transformer: LiveTransformer,
) {
    const x1 = transformer.tsToX(d.a.ts, w),
        y1 = transformer.priceToY(d.a.price, h) + oy;
    const x2 = transformer.tsToX(d.b.ts, w),
        y2 = transformer.priceToY(d.b.price, h) + oy;
    const [sx, sy, ex, ey] = extendedEndpoints(x1, y1, x2, y2, w, d.extendLeft, d.extendRight);

    if (selected) {
        selectionStroke(ctx, d.lineWidth);
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
    }
    if (d.label) {
        // drawAnchoredLabel owns the stroke when a label is present
        drawAnchoredLabel(
            ctx,
            d,
            d.color,
            'line',
            x1,
            y1,
            x2,
            y2,
            d.lineWidth,
            d.dash,
            sx,
            sy,
            ex,
            ey,
        );
    } else {
        applyStroke(ctx, d.color, d.lineWidth, d.dash);
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
    }

    drawTrendAngle(ctx, d, bounds, w, h, oy, transformer);

    if (selected || hovered) {
        drawHandle(ctx, x1, y1, d.color, hotAnchor === 'a');
        drawHandle(ctx, x2, y2, d.color, hotAnchor === 'b');
    }
}

function renderRay(
    ctx: CanvasRenderingContext2D,
    d: RayDrawing,
    bounds: ViewBounds,
    w: number,
    h: number,
    oy: number,
    selected: boolean,
    hovered: boolean,
    hotAnchor: DrawingAnchorId | null,
    transformer: LiveTransformer,
) {
    const x1 = transformer.tsToX(d.a.ts, w),
        y1 = transformer.priceToY(d.a.price, h) + oy;
    const x2 = transformer.tsToX(d.b.ts, w),
        y2 = transformer.priceToY(d.b.price, h) + oy;
    // Ray extends from a through b - direction is determined by a->b.
    // If b is right of a: extend right; otherwise extend left.
    const extendsRight = x2 >= x1;
    const [sx, sy, ex, ey] = extendedEndpoints(x1, y1, x2, y2, w, !extendsRight, extendsRight);
    // When pointing left sx/sy is the far (left-edge) point; ex/ey stays at x2/y2.
    // We always draw from the origin (x1,y1) toward the extended far point.
    const farX = extendsRight ? ex : sx;
    const farY = extendsRight ? ey : sy;

    if (selected) {
        selectionStroke(ctx, d.lineWidth);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(farX, farY);
        ctx.stroke();
    }
    if (d.label) {
        // drawAnchoredLabel owns the stroke when a label is present
        drawAnchoredLabel(
            ctx,
            d,
            d.color,
            'line',
            x1,
            y1,
            x2,
            y2,
            d.lineWidth,
            d.dash,
            x1,
            y1,
            farX,
            farY,
        );
    } else {
        applyStroke(ctx, d.color, d.lineWidth, d.dash);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(farX, farY);
        ctx.stroke();
    }

    if (selected || hovered) {
        drawHandle(ctx, x1, y1, d.color, hotAnchor === 'a');
        drawHandle(ctx, x2, y2, d.color, hotAnchor === 'b');
    }
}

function renderHRay(
    ctx: CanvasRenderingContext2D,
    d: HorzRayDrawing,
    bounds: ViewBounds,
    w: number,
    h: number,
    oy: number,
    selected: boolean,
    hovered: boolean,
    hotAnchor: DrawingAnchorId | null,
    transformer: LiveTransformer,
) {
    if (d.ts > bounds.tMax) return;
    const y = transformer.priceToY(d.price, h) + oy;
    if (y < oy || y > oy + h) return;
    const x = transformer.tsToX(d.ts, w);

    if (selected) {
        selectionStroke(ctx, d.lineWidth);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(w, y);
        ctx.stroke();
    }
    if (d.label) {
        // drawHLineLabel owns the stroke when a label is present so it can
        // bake the gap in from the start rather than trying to erase over it.
        drawHLineLabel(ctx, d, d.color, y, w, d.lineWidth, d.dash);
    } else {
        applyStroke(ctx, d.color, d.lineWidth, d.dash);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(w, y);
        ctx.stroke();
    }

    if (selected || hovered) drawHandle(ctx, x, y, d.color, hotAnchor === 'body');
}

function renderParallelChannel(
    ctx: CanvasRenderingContext2D,
    d: ParallelChannelDrawing,
    bounds: ViewBounds,
    w: number,
    h: number,
    oy: number,
    selected: boolean,
    hovered: boolean,
    hotAnchor: DrawingAnchorId | null,
    transformer: LiveTransformer,
) {
    const x1 = transformer.tsToX(d.a.ts, w),
        y1 = transformer.priceToY(d.a.price, h) + oy;
    const x2 = transformer.tsToX(d.b.ts, w),
        y2 = transformer.priceToY(d.b.price, h) + oy;
    // The parallel ("top") line is the base offset by `height` in PRICE units, so the
    // channel stays pinned to prices across zoom/scroll.
    const yT1 = transformer.priceToY(d.a.price + d.height, h) + oy;
    const yT2 = transformer.priceToY(d.b.price + d.height, h) + oy;
    const extL = d.extendLeft ?? false;
    const extR = d.extendRight ?? false;

    // Endpoints of the line parallel to the base, offset by `frac` of the channel
    // height (in price), extended to the chart edges when requested.
    const levelEndpoints = (frac: number) => {
        const ly1 = transformer.priceToY(d.a.price + frac * d.height, h) + oy;
        const ly2 = transformer.priceToY(d.b.price + frac * d.height, h) + oy;
        return extendedEndpoints(x1, ly1, x2, ly2, w, extL, extR);
    };

    // Background band between level 0 (base) and level 1 (parallel line).
    if (d.enableBackground) {
        const [bsx, bsy, bex, bey] = levelEndpoints(0);
        const [tsx, tsy, tex, tey] = levelEndpoints(1);
        ctx.beginPath();
        ctx.moveTo(bsx, bsy);
        ctx.lineTo(bex, bey);
        ctx.lineTo(tex, tey);
        ctx.lineTo(tsx, tsy);
        ctx.closePath();
        ctx.fillStyle = d.backgroundColor;
        ctx.fill();
    }

    // Each level is an independently styled line parallel to the base.
    for (const lvl of d.levels ?? DEFAULT_CHANNEL_LEVELS) {
        if (!lvl.enabled) continue;
        const [lsx, lsy, lex, ley] = levelEndpoints(Number(lvl.value));
        applyStroke(ctx, lvl.color, lvl.lineWidth, lvl.dash);
        ctx.beginPath();
        ctx.moveTo(lsx, lsy);
        ctx.lineTo(lex, ley);
        ctx.stroke();
    }
    ctx.setLineDash([]);

    if (selected || hovered) {
        // The channel has no single line colour (styling is per-level); use the base
        // level's colour for the anchor handles.
        const handleColor = (d.levels ?? DEFAULT_CHANNEL_LEVELS)[0]?.color ?? '#3377ff';
        const mxp = (x1 + x2) / 2;
        // base line: endpoints a / b + midpoint mt
        drawHandle(ctx, x1, y1, handleColor, hotAnchor === 'a');
        drawHandle(ctx, x2, y2, handleColor, hotAnchor === 'b');
        drawHandle(ctx, mxp, (y1 + y2) / 2, handleColor, hotAnchor === 'mt');
        // parallel line: endpoints a2 / a3 + midpoint mb
        drawHandle(ctx, x1, yT1, handleColor, hotAnchor === 'a2');
        drawHandle(ctx, x2, yT2, handleColor, hotAnchor === 'a3');
        drawHandle(ctx, mxp, (yT1 + yT2) / 2, handleColor, hotAnchor === 'mb');
    }
}

function renderRect(
    ctx: CanvasRenderingContext2D,
    d: RectDrawing,
    bounds: ViewBounds,
    w: number,
    h: number,
    oy: number,
    selected: boolean,
    hovered: boolean,
    hotAnchor: DrawingAnchorId | null,
    transformer: LiveTransformer,
) {
    const x1 = transformer.tsToX(d.a.ts, w),
        y1 = transformer.priceToY(d.a.price, h) + oy;
    const x2 = transformer.tsToX(d.b.ts, w),
        y2 = transformer.priceToY(d.b.price, h) + oy;
    const rx = Math.min(x1, x2),
        ry = Math.min(y1, y2);
    const rw = Math.abs(x2 - x1),
        rh = Math.abs(y2 - y1);

    if (selected) {
        ctx.strokeStyle = 'rgba(255,255,255,0.2)';
        ctx.lineWidth = 7;
        ctx.setLineDash([]);
        ctx.strokeRect(rx, ry, rw, rh);
    }
    const fillColor = d.fillColor ?? d.color;
    const borderColor = d.borderColor ?? d.color;
    const borderLineWidth = d.borderLineWidth ?? 1;
    const borderDash = d.borderDash ?? [];
    ctx.fillStyle = hexToRgba(fillColor, d.fillOpacity);
    ctx.fillRect(rx, ry, rw, rh);
    applyStroke(ctx, borderColor, borderLineWidth, borderDash);
    ctx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1);

    drawAnchoredLabel(ctx, d, borderColor, 'rect', x1, y1, x2, y2);

    if (selected || hovered) {
        const hc = d.borderColor ?? d.color;
        // corners
        drawHandle(ctx, rx, ry, hc, hotAnchor === 'tl');
        drawHandle(ctx, rx + rw, ry, hc, hotAnchor === 'tr');
        drawHandle(ctx, rx, ry + rh, hc, hotAnchor === 'bl');
        drawHandle(ctx, rx + rw, ry + rh, hc, hotAnchor === 'br');
        // edge midpoints
        drawHandle(ctx, rx + rw / 2, ry, hc, hotAnchor === 'mt');
        drawHandle(ctx, rx + rw / 2, ry + rh, hc, hotAnchor === 'mb');
        drawHandle(ctx, rx, ry + rh / 2, hc, hotAnchor === 'ml');
        drawHandle(ctx, rx + rw, ry + rh / 2, hc, hotAnchor === 'mr');
    }
}

function renderTriangle(
    ctx: CanvasRenderingContext2D,
    d: TriangleDrawing,
    bounds: ViewBounds,
    w: number,
    h: number,
    oy: number,
    selected: boolean,
    hovered: boolean,
    hotAnchor: DrawingAnchorId | null,
    transformer: LiveTransformer,
) {
    const x1 = transformer.tsToX(d.a.ts, w),
        y1 = transformer.priceToY(d.a.price, h) + oy;
    const x2 = transformer.tsToX(d.b.ts, w),
        y2 = transformer.priceToY(d.b.price, h) + oy;
    const x3 = transformer.tsToX(d.c.ts, w),
        y3 = transformer.priceToY(d.c.price, h) + oy;

    const tracePath = () => {
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.lineTo(x3, y3);
        ctx.closePath();
    };

    if (selected) {
        // Halo behind the border, matching the rect selection treatment.
        ctx.strokeStyle = 'rgba(255,255,255,0.2)';
        ctx.lineWidth = 7;
        ctx.setLineDash([]);
        tracePath();
        ctx.stroke();
    }

    const fillColor = d.fillColor ?? d.color;
    const borderColor = d.borderColor ?? d.color;
    const borderLineWidth = d.borderLineWidth ?? 1;
    const borderDash = d.borderDash ?? [];

    // Fill first, then stroke on top so the border stays crisp.
    tracePath();
    ctx.fillStyle = hexToRgba(fillColor, d.fillOpacity);
    ctx.fill();
    applyStroke(ctx, borderColor, borderLineWidth, borderDash);
    tracePath();
    ctx.stroke();

    // Label is placed within the bounding box of all three vertices.
    const minX = Math.min(x1, x2, x3),
        maxX = Math.max(x1, x2, x3);
    const minY = Math.min(y1, y2, y3),
        maxY = Math.max(y1, y2, y3);
    drawAnchoredLabel(ctx, d, borderColor, 'rect', minX, minY, maxX, maxY);

    if (selected || hovered) {
        const hc = borderColor;
        drawHandle(ctx, x1, y1, hc, hotAnchor === 'a');
        drawHandle(ctx, x2, y2, hc, hotAnchor === 'b');
        drawHandle(ctx, x3, y3, hc, hotAnchor === 'c');
    }
}

function renderFib(
    ctx: CanvasRenderingContext2D,
    d: FibDrawing,
    bounds: ViewBounds,
    w: number,
    h: number,
    oy: number,
    selected: boolean,
    hovered: boolean,
    hotAnchor: DrawingAnchorId | null,
    transformer: LiveTransformer,
) {
    const priceA = d.a.price,
        priceB = d.b.price;
    const diff = priceA - priceB;
    const fibFontSize = d.labelFontSize ?? 10;
    const fibBold = d.labelBold ? '700 ' : '400 ';
    const fibAlign: 'left' | 'right' = d.labelAlign === 'right' ? 'right' : 'left';
    ctx.font = `${fibBold}${fibFontSize}px "Inter", monospace`;
    ctx.textAlign = 'left';

    const xA = transformer.tsToX(d.a.ts, w);
    const xB = transformer.tsToX(d.b.ts, w);
    const yA = transformer.priceToY(d.a.price, h) + oy;
    const yB = transformer.priceToY(d.b.price, h) + oy;

    let lineL = Math.min(xA, xB);
    let lineR = Math.max(xA, xB);
    // yTop = smaller canvas Y = higher price

    // Background fill spanning ALL enabled level lines
    if (d.enableBackground && d.backgroundColor) {
        // Collect Y positions for every enabled level so the fill covers the
        // full drawn extent (including levels outside the 0-1 anchor range,
        // e.g. 1.618, -0.272, etc.).
        const enabledYs: number[] = d.levels
            .filter((lv) => lv.enabled)
            .map((lv) => {
                const lp = priceB + diff * parseFloat(lv.value);
                return transformer.priceToY(lp, h) + oy;
            });
        // Always include the anchor lines (levels 0 and 1) even if not listed.
        enabledYs.push(yA, yB);
        const bgTop = Math.min(...enabledYs);
        const bgBot = Math.max(...enabledYs);
        ctx.fillStyle = d.backgroundColor;
        ctx.fillRect(lineL, bgTop, lineR - lineL, bgBot - bgTop);
    }
    for (const level of d.levels) {
        if (!level.enabled) continue;
        const l = parseFloat(level.value);
        const lp = priceB + diff * l;
        const y = transformer.priceToY(lp, h) + oy;
        if (y < oy || y > oy + h) continue;
        const lc = level.color ?? '#FFFFFF';
        const labelText =
            `${d.showLevels ? l + '  ' : ''}${d.showPrices ? lp.toFixed(2) : ''}`.trim();
        const textW = labelText ? ctx.measureText(labelText).width : 0;
        const GAP = 6;

        const levelDash = d.dash ?? [];
        const levelLineWidth = d.lineWidth ?? 1;

        // Compute draw extents for this level (extend flags may widen from anchor bounds)
        let drawL = lineL;
        let drawR = lineR;
        if (d.extendLeft) drawL = labelText && fibAlign === 'left' ? textW + GAP * 2 : 0;
        if (d.extendRight) drawR = w;

        applyStroke(ctx, lc, levelLineWidth, levelDash);
        ctx.beginPath();
        ctx.moveTo(drawL, y);
        ctx.lineTo(drawR, y);
        ctx.stroke();

        if (labelText) {
            ctx.fillStyle = lc;
            if (fibAlign === 'right') {
                // Label on right side of the drawing
                ctx.fillText(labelText, drawR + GAP, y + fibFontSize * 0.35);
            } else {
                // Label on left side (default)
                ctx.fillText(labelText, drawL - textW - GAP, y + fibFontSize * 0.35);
            }
        }
    }

    const ax = transformer.tsToX(d.a.ts, w),
        ay = transformer.priceToY(d.a.price, h) + oy;
    const bx = transformer.tsToX(d.b.ts, w),
        by = transformer.priceToY(d.b.price, h) + oy;
    if (selected || hovered) {
        drawHandle(ctx, ax, ay, '#3d81f6', hotAnchor === 'a');
        drawHandle(ctx, bx, by, '#3d81f6', hotAnchor === 'b');
    }
}

function renderText(
    ctx: CanvasRenderingContext2D,
    d: TextDrawing,
    bounds: ViewBounds,
    w: number,
    h: number,
    oy: number,
    selected: boolean,
    hovered: boolean,
    hotAnchor: DrawingAnchorId | null,
    transformer: LiveTransformer,
) {
    // When screen-anchored, use stored pixel coords directly.
    // Fall back to data-space conversion if screenX/screenY haven't been set yet.
    let x: number;
    let y: number;
    if (d.screenAnchored && d.screenX !== undefined && d.screenY !== undefined) {
        x = d.screenX;
        y = d.screenY;
    } else {
        x = transformer.tsToX(d.anchor.ts, w);
        y = transformer.priceToY(d.anchor.price, h) + oy;
    }

    const italic = d.italic ? 'italic ' : '';
    const weight = d.bold ? '700 ' : '400 ';
    ctx.font = `${italic}${weight}${d.fontSize}px "Inter", monospace`;
    ctx.fillStyle = d.color;
    ctx.setLineDash([]);

    const align: CanvasTextAlign =
        d.textAlign === 'center' ? 'center' : d.textAlign === 'right' ? 'right' : 'left';
    ctx.textAlign = align;

    const tx = align === 'left' ? x + 4 : align === 'right' ? x - 4 : x;
    const lines = d.text.split('\n');
    const lineH = d.fontSize * 1.4;
    lines.forEach((line, i) => {
        ctx.fillText(line, tx, y - 4 + i * lineH);
    });

    if (selected || hovered) drawHandle(ctx, x, y, d.color, hotAnchor === 'anchor');
}

// Position tools (Long / Short)
//
// One box split by the entry line: the zone the trade runs toward is the target,
// the one behind it is the stop. A long targets up, a short targets down - the
// only difference between the two tools - so both share this renderer, the
// hit-test case and the drag math.

/** Zone fill alpha. Deliberately low: candles must stay readable underneath. */
const POS_FILL_ALPHA = 0.11;
/** Neutral label backing, so colour comes from the text rather than the pill. */
const POS_PILL_BG = 'rgba(11,14,20,1)';
/** Text inset from the box's left/right edges. */

/** Pick the richest label variant that fits `maxW`. Caller sets ctx.font first. */
/** Signed price move rendered as an absolute delta + tick count + percent. */
function posDeltaParts(
    amount: number,
    entry: number,
    tick: number,
    symbolInfo?: SymbolInfo,
): { price: string; ticks: string; pct: string } {
    return {
        price: formatPrice(amount, symbolInfo),
        ticks: `${Math.round(amount / tick)}T`,
        pct: entry !== 0 ? `${((amount / Math.abs(entry)) * 100).toFixed(2)}%` : '',
    };
}

/** Label typeface. The rest of the layer is monospace; positions read as UI. */
const POS_LABEL_FONT = 'Inter, system-ui, sans-serif';

/**
 * Geometry of a position box, in prices snapped to the instrument's tick.
 * Shared by the renderer and the hit-test so the handles you see are the
 * handles you grab.
 */
export function positionLevels(d: LongDrawing | ShortDrawing, tick: number) {
    const snap = (v: number) => Math.round(v / tick) * tick;
    const entry = snap(d.a.price);
    const up = snap(Math.max(d.upAmount, 0));
    const down = snap(Math.max(d.downAmount, 0));
    return { entry, up, down, top: entry + up, bottom: entry - down };
}

function renderPositionDrawing(
    ctx: CanvasRenderingContext2D,
    d: LongDrawing | ShortDrawing,
    w: number,
    h: number,
    oy: number,
    selected: boolean,
    hovered: boolean,
    hotAnchor: DrawingAnchorId | null,
    transformer: LiveTransformer,
    symbolInfo?: SymbolInfo,
) {
    const isLong = d.tool === 'long';
    const tick = resolveTickSize(symbolInfo);

    const x1 = transformer.tsToX(d.a.ts, w);
    const x2 = transformer.tsToX(d.b.ts, w);
    const rx = Math.min(x1, x2);
    const rw = Math.max(Math.abs(x2 - x1), 1);

    const { entry, up, down, top, bottom } = positionLevels(d, tick);

    const yUp = transformer.priceToY(top, h) + oy;
    const yEntry = transformer.priceToY(entry, h) + oy;
    const yDown = transformer.priceToY(bottom, h) + oy;

    const upColor = hexSolid(d.upColor);
    const downColor = hexSolid(d.downColor);
    const entryColor = hexSolid(d.entryColor ?? '#b0b6c0');

    // Target/stop roles, resolved once so the drawing code below is side-agnostic:
    // a long aims up, a short aims down, and everything else is identical.
    const target = isLong
        ? { y: yUp, price: top, amount: up, color: upColor, outward: -1 }
        : { y: yDown, price: bottom, amount: down, color: downColor, outward: 1 };
    const stop = isLong
        ? { y: yDown, price: bottom, amount: down, color: downColor, outward: 1 }
        : { y: yUp, price: top, amount: up, color: upColor, outward: -1 };


    // Zone fills
    // Deliberately translucent: the candles underneath are the point of the box.
    ctx.setLineDash([]);
    ctx.fillStyle = hexToRgba(d.upColor, POS_FILL_ALPHA);
    ctx.fillRect(rx, yUp, rw, yEntry - yUp);
    ctx.fillStyle = hexToRgba(d.downColor, POS_FILL_ALPHA);
    ctx.fillRect(rx, yEntry, rw, yDown - yEntry);

    // Edges
    // Target and stop get a solid rule in their own colour; the sides are a
    // faint box outline so the time span reads without competing with them.
    // ctx.lineWidth = 1;
    // ctx.strokeStyle = hexToRgba(entryColor, 0.35);
    // ctx.strokeRect(rx + 0.5, yTop + 0.5, rw - 1, yBot - yTop - 1);

    const rule = (y: number, color: string, lw: number, dash: number[]) => {
        applyStroke(ctx, color, lw, dash);
        ctx.beginPath();
        ctx.moveTo(rx, Math.round(y) + 0.5);
        ctx.lineTo(rx + rw, Math.round(y) + 0.5);
        ctx.stroke();
    };
    rule(yEntry, entryColor, 1, []);
    ctx.setLineDash([]);

    // Labels
    // Target above/below its own edge, stop outside the opposite one, R:R on the
    // entry - each on the side its role lives on, so a short reads like a long
    // flipped rather than like a mislabelled one.
    if (d.drawInfo && (hovered || selected)) {
        const fs = d.fontSize || 11;
        const pill = (text: string, py: number, color: string, bg: string) =>
            drawPillLabel(ctx, text, rx + rw / 2, py, color, bg, fs, 'center', 7, 4, POS_LABEL_FONT);

        ctx.font = `${fs}px ${POS_LABEL_FONT}`;

        const zoneLabel = (
            role: 'Target' | 'Stop',
            z: { y: number; price: number; amount: number; color: string; outward: number },
        ) => {
            if (z.amount <= 0) return;
            const p = posDeltaParts(z.amount, entry, tick, symbolInfo);
            const price = formatPrice(z.price, symbolInfo);
            // const text = fitLabel(
            //     ctx,
            //     [
            //         `${role} ${price}  ${p.price} - ${p.ticks} - ${p.pct}`,
            //         // `${role} ${price}  ${p.ticks} - ${p.pct}`,
            //         // `${role} ${price}`,
            //         // price,
            //     ],
            //     maxW,
            // );
            const text = `${role} ${price}  ${p.price} · ${p.ticks} · ${p.pct}`;
            if (text) pill(text, z.y + z.outward * (fs + 4), d.textColor ?? '#ffffff', z.color);
        };

        zoneLabel('Target', target);
        zoneLabel('Stop', stop);

        // R:R sits on the entry rule, and only means something with both legs.
        if (target.amount > 0 && stop.amount > 0) {
            const rr = target.amount / stop.amount;
            const side = isLong ? 'LONG' : 'SHORT';
            // const text = fitLabel(
            //     ctx,
            //     [
            //         `${side} ${d.qty ?? 1} @ ${formatPrice(entry, symbolInfo)}  R:R ${rr.toFixed(2)}`,
            //         `${side} @ ${formatPrice(entry, symbolInfo)}`,
            //         `R:R ${rr.toFixed(2)}`,
            //     ],
            //     maxW,
            // );
            const text = `${side} ${d.qty ?? 1} @ ${formatPrice(entry, symbolInfo)}  R:R ${rr.toFixed(2)}`;
            if (text) pill(text, yEntry - fs - 4, d.textColor ?? '#ffffff', POS_PILL_BG);
        }
    }

    // Handles
    // Four handles for the four degrees of freedom: target edge, stop edge,
    // entry (+ left edge) and right edge.
    if (selected || hovered) {
        drawHandle(ctx, rx, yUp, upColor, hotAnchor === 'mt');
        drawHandle(ctx, rx, yDown, downColor, hotAnchor === 'mb');
        drawHandle(ctx, rx, yEntry, entryColor, hotAnchor === 'ml');
        drawHandle(ctx, rx + rw, yEntry, entryColor, hotAnchor === 'mr');
    }
}

const FVP_MIN_BAR_H = 1;

// The minimum rendered bar-row height (px) before we start bucketing ticks.
// Below this threshold we merge adjacent tick rows so bars stay readable.
const FVP_LOD_TARGET_PX = 3;

function fvpPriceToY(price: number, yMin: number, yMax: number, h: number): number {
    const span = yMax - yMin;
    if (span === 0) return h / 2;
    return h - ((price - yMin) / span) * h;
}

/** Compute VAH/VAL indices from a sorted VpData given a target pct (0-100). */
function computeVa(
    totalVol: Float64Array,
    poc: number,
    prices: Float64Array,
    pct: number,
): { loIdx: number; hiIdx: number } {
    const n = prices.length;
    if (n === 0) return { loIdx: 0, hiIdx: 0 };
    const pocIdx = prices.findIndex((p) => p === poc);
    const target = totalVol.reduce((s, v) => s + v, 0) * (pct / 100);
    let lo = pocIdx < 0 ? 0 : pocIdx;
    let hi = lo;
    let accumulated = totalVol[lo] ?? 0;
    while (accumulated < target && (lo > 0 || hi < n - 1)) {
        const addLo = lo > 0 ? totalVol[lo - 1] : 0;
        const addHi = hi < n - 1 ? totalVol[hi + 1] : 0;
        if (addLo >= addHi && lo > 0) {
            lo--;
            accumulated += addLo;
        } else if (hi < n - 1) {
            hi++;
            accumulated += addHi;
        } else if (lo > 0) {
            lo--;
            accumulated += addLo;
        } else break;
    }
    return { loIdx: lo, hiIdx: hi };
}

// LOD bucketing
//
// When raw tick bars are shorter than FVP_LOD_TARGET_PX we merge ticks into
// buckets so every rendered row is at least that many pixels tall.
// This mirrors the heatmap LOD pyramid philosophy: never render sub-pixel rows.

type FvpBucket = {
    priceCenter: number; // representative price for this bucket
    priceLo: number; // lowest tick price in bucket
    priceHi: number; // highest tick price in bucket
    buyVol: number;
    sellVol: number;
    totalVol: number;
};

function buildLodBuckets(
    prices: Float64Array,
    buyVol: Float64Array,
    sellVol: Float64Array,
    totalVol: Float64Array,
    priceMin: number,
    priceMax: number,
    rh: number, // drawing pixel height
    tickSize: number,
): FvpBucket[] {
    const n = prices.length;
    if (n === 0) return [];

    // Raw tick height in pixels
    const rawTickH = Math.abs(
        fvpPriceToY(0, priceMin, priceMax, rh) - fvpPriceToY(tickSize, priceMin, priceMax, rh),
    );

    // How many raw ticks to merge per bucket so rendered rows are >= LOD_TARGET_PX
    const mergeCount =
        rawTickH < FVP_LOD_TARGET_PX ? Math.ceil(FVP_LOD_TARGET_PX / Math.max(rawTickH, 0.01)) : 1;

    if (mergeCount <= 1) {
        // No bucketing needed - one bucket per tick
        return Array.from({ length: n }, (_, i) => ({
            priceCenter: prices[i],
            priceLo: prices[i],
            priceHi: prices[i] + tickSize,
            buyVol: buyVol[i],
            sellVol: sellVol[i],
            totalVol: totalVol[i],
        }));
    }

    // Merge ticks bottom-to-top (prices are ascending in vpData)
    const buckets: FvpBucket[] = [];
    let i = 0;
    while (i < n) {
        const end = Math.min(i + mergeCount, n);
        let bv = 0,
            sv = 0,
            tv = 0;
        for (let j = i; j < end; j++) {
            bv += buyVol[j];
            sv += sellVol[j];
            tv += totalVol[j];
        }
        buckets.push({
            priceCenter: (prices[i] + prices[end - 1]) / 2,
            priceLo: prices[i],
            priceHi: prices[end - 1] + tickSize,
            buyVol: bv,
            sellVol: sv,
            totalVol: tv,
        });
        i = end;
    }
    return buckets;
}

// Label pill helper
//
// Draws text with an opaque rounded-rect pill background so labels are always
// readable regardless of what the bar or chart background looks like.

function drawPillLabel(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    textColor: string,
    pillColor: string, // background pill fill
    fs: number, // font size px
    align: CanvasTextAlign = 'left',
    pillPadX = 4,
    pillPadY = 2,
    fontFamily = 'monospace',
) {
    ctx.font = `${fs}px ${fontFamily}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = align;

    const tw = ctx.measureText(text).width;
    let px: number;
    if (align === 'left') px = x;
    else if (align === 'right') px = x - tw;
    else px = x - tw / 2;

    // pill rect
    const rounding = 3;
    const rx = px - pillPadX;
    const ry = y - fs / 2 - pillPadY;
    const rw = tw + pillPadX * 2;
    const rh = fs + pillPadY * 2;

    ctx.fillStyle = pillColor;
    ctx.beginPath();
    ctx.roundRect(rx, ry, rw, rh, rounding);
    ctx.fill();

    ctx.fillStyle = textColor;
    ctx.fillText(text, x, y);
}

// Main renderer
function renderFvp(
    ctx: CanvasRenderingContext2D,
    d: FixedVolumeProfileDrawing,
    bounds: ViewBounds,
    w: number,
    h: number,
    oy: number,
    selected: boolean,
    hovered: boolean,
    hotAnchor: DrawingAnchorId | null,
    transformer: LiveTransformer,
    tickSize: number,
) {
    const x1 = transformer.tsToX(d.a.ts, w);
    const y1 = transformer.priceToY(d.a.price, h) + oy;
    const x2 = transformer.tsToX(d.b.ts, w);
    const y2 = transformer.priceToY(d.b.price, h) + oy;
    const rx = Math.min(x1, x2);
    const ry = Math.min(y1, y2);
    const rw = Math.abs(x2 - x1);
    const rh = Math.abs(y2 - y1);

    // Background
    if (d.enableBg) {
        ctx.fillStyle = d.bgColor;
        ctx.fillRect(rx, ry, rw, rh);
    }

    // Border
    if (d.enableBorder) {
        ctx.strokeStyle = d.borderColor;
        ctx.lineWidth = 1;
        ctx.setLineDash(d.borderDash ?? []);
        ctx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1);
        ctx.setLineDash([]);
    }

    // Early-out when no data
    const vp = d.vpData;
    if (!vp || vp.prices.length === 0 || rw < 2 || rh < 2) {
        if (selected || hovered) {
            drawHandle(ctx, rx, ry + rh / 2, '#6490c8', hotAnchor === 'ml');
            drawHandle(ctx, rx + rw, ry + rh / 2, '#6490c8', hotAnchor === 'mr');
        }
        return;
    }

    const { prices, buyVol, sellVol, totalVol, poc } = vp;
    const priceMin = Math.min(d.a.price, d.b.price);
    const priceMax = Math.max(d.a.price, d.b.price);

    // v2.0 feature flags (default-safe for old drawings)
    const highlightPocBar = d.highlightPocBar !== false; // default true
    const pocBarLineWidth = d.pocBarLineWidth ?? 1;
    const vaBarDimming = d.vaBarDimming !== false; // default true
    const vaOutsideDimFrac = d.vaOutsideDimFrac ?? 0.35;
    const labelPills = d.labelPills !== false; // default true
    const splitCenterLine = d.splitCenterLine !== false; // default true
    const useBarGap = d.barGap !== false; // default true

    // LOD bucketing
    const buckets = buildLodBuckets(
        prices,
        buyVol,
        sellVol,
        totalVol,
        priceMin,
        priceMax,
        rh,
        tickSize,
    );
    const nb = buckets.length;
    if (nb === 0) return;

    // Max volume across buckets (for bar width scaling)
    let maxVol = 0;
    for (let i = 0; i < nb; i++) if (buckets[i].totalVol > maxVol) maxVol = buckets[i].totalVol;
    if (maxVol === 0) return;

    // Value Area bounds
    // Compute VA on the *original* tick arrays (not bucketed) for accuracy.
    const n = prices.length;
    const { loIdx: vaLoIdx, hiIdx: vaHiIdx } =
        d.showValueArea || d.showVaHLines || vaBarDimming
            ? computeVa(totalVol, poc, prices, d.valueAreaPct ?? 70)
            : { loIdx: 0, hiIdx: n - 1 };
    const vaLo = prices[vaLoIdx];
    const vaHi = prices[vaHiIdx];

    // Color / style vars
    const barAlpha = (d.barOpacity ?? 60) / 100;
    const buyColor = d.enableBuyColor ? (d.buyColor ?? '#00e676') : '#00e676';
    const sellColor = d.enableSellColor ? (d.sellColor ?? '#ff1744') : '#ff1744';
    const totalColor = d.totalColor ?? '#5b9cf6';
    const deltaNeg = d.deltaNegColor ?? '#ff1744';
    const mode = d.profileMode ?? 'stacked';
    const bwFrac = (d.barsWidth ?? 100) / 100;
    const pocColor = d.pocColor ?? '#facc15';

    // Pill background: near-opaque dark that reads on any chart background
    const PILL_BG = 'rgba(18,20,26,0.88)';

    // Clip to drawing bounds
    ctx.save();
    ctx.beginPath();
    ctx.rect(rx, ry, rw, rh);
    ctx.clip();

    // Value Area fill (drawn first, under bars)
    if (d.showValueArea && maxVol > 0) {
        const vaTop = ry + fvpPriceToY(vaHi, priceMin, priceMax, rh);
        const vaBot = ry + fvpPriceToY(vaLo, priceMin, priceMax, rh);
        ctx.fillStyle = d.valueAreaFillColor ?? '#ffffff1a';
        ctx.fillRect(rx, vaTop, rw, vaBot - vaTop);
    }

    // Bars (LOD-bucketed)
    for (let i = 0; i < nb; i++) {
        const b = buckets[i];

        // Skip buckets entirely outside the drawing's price range
        if (b.priceHi < priceMin - tickSize || b.priceLo > priceMax + tickSize) continue;

        // Pixel height of this bucket row
        const yTop = ry + fvpPriceToY(b.priceHi, priceMin, priceMax, rh);
        const yBot = ry + fvpPriceToY(b.priceLo, priceMin, priceMax, rh);
        const rowH = yBot - yTop;
        const barH = Math.max(FVP_MIN_BAR_H, rowH - (useBarGap && rowH > 3 ? 1 : 0));
        const barY = yTop;

        // Is this bucket inside or outside the value area?
        const isInVa = b.priceCenter >= vaLo && b.priceCenter <= vaHi;
        const isPoc = Math.abs(b.priceCenter - poc) < tickSize * 1.5;

        // Alpha: inside VA at full opacity; outside dimmed
        const alpha = vaBarDimming && !isInVa ? barAlpha * vaOutsideDimFrac : barAlpha;

        ctx.globalAlpha = alpha;

        const bv = b.buyVol;
        const sv = b.sellVol;
        const tv = b.totalVol;

        if (mode === 'stacked') {
            const totalW = (tv / maxVol) * rw * bwFrac;
            const sellW = totalW * (tv > 0 ? sv / tv : 0);
            const buyW = totalW - sellW;
            ctx.fillStyle = sellColor;
            ctx.fillRect(rx, barY, sellW, barH);
            ctx.fillStyle = buyColor;
            ctx.fillRect(rx + sellW, barY, buyW, barH);
        } else if (mode === 'split') {
            const half = (rw / 2) * bwFrac;
            const buyW = (bv / maxVol) * half;
            const sellW = (sv / maxVol) * half;
            const cx = rx + rw / 2;
            ctx.fillStyle = buyColor;
            ctx.fillRect(cx, barY, buyW, barH);
            ctx.fillStyle = sellColor;
            ctx.fillRect(cx - sellW, barY, sellW, barH);
        } else if (mode === 'delta') {
            const delta = bv - sv;
            const dWidth = (Math.abs(delta) / maxVol) * rw * bwFrac;
            ctx.fillStyle = delta >= 0 ? totalColor : deltaNeg;
            ctx.fillRect(rx, barY, dWidth, barH);
        } else {
            // total
            const totalW = (tv / maxVol) * rw * bwFrac;
            ctx.fillStyle = totalColor;
            ctx.fillRect(rx, barY, totalW, barH);
        }

        // POC bar accent
        // Draw over the bar at 1.5x opacity + a thin horizontal stroke,
        // giving the POC row instant visual dominance.
        if (highlightPocBar && isPoc) {
            ctx.globalAlpha = Math.min(1, alpha * 1.5);

            // Re-draw the bar at boosted opacity
            if (mode === 'stacked') {
                const totalW = (tv / maxVol) * rw * bwFrac;
                const sellW = totalW * (tv > 0 ? sv / tv : 0);
                const buyW = totalW - sellW;
                ctx.fillStyle = sellColor;
                ctx.fillRect(rx, barY, sellW, barH);
                ctx.fillStyle = buyColor;
                ctx.fillRect(rx + sellW, barY, buyW, barH);
            } else if (mode === 'split') {
                const half = (rw / 2) * bwFrac;
                const cx = rx + rw / 2;
                ctx.fillStyle = buyColor;
                ctx.fillRect(cx, barY, (bv / maxVol) * half, barH);
                ctx.fillStyle = sellColor;
                ctx.fillRect(cx - (sv / maxVol) * half, barY, (sv / maxVol) * half, barH);
            } else if (mode === 'delta') {
                const delta = bv - sv;
                ctx.fillStyle = delta >= 0 ? totalColor : deltaNeg;
                ctx.fillRect(rx, barY, (Math.abs(delta) / maxVol) * rw * bwFrac, barH);
            } else {
                ctx.fillStyle = totalColor;
                ctx.fillRect(rx, barY, (tv / maxVol) * rw * bwFrac, barH);
            }

            // Accent stroke along the full width of the row (not just the bar)
            ctx.globalAlpha = hexToAlpha(pocColor);
            ctx.strokeStyle = pocColor;
            ctx.lineWidth = pocBarLineWidth;
            ctx.setLineDash([]);
            const midY = barY + barH / 2;
            ctx.beginPath();
            ctx.moveTo(rx, midY);
            ctx.lineTo(rx + rw, midY);
            ctx.stroke();
        }
    }
    ctx.globalAlpha = 1;

    // Split mode: center axis
    if (mode === 'split' && splitCenterLine) {
        const cx = rx + rw / 2;
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(cx, ry);
        ctx.lineTo(cx, ry + rh);
        ctx.stroke();
    }

    // Volume numbers
    if (d.showVolNumbers && maxVol > 0) {
        const fs = d.volNumbersFontSize ?? 9;
        ctx.font = `${fs}px monospace`;
        ctx.textBaseline = 'middle';
        ctx.globalAlpha = 0.85;

        for (let i = 0; i < nb; i++) {
            const b = buckets[i];
            if (b.priceHi < priceMin - tickSize || b.priceLo > priceMax + tickSize) continue;

            const yTop = ry + fvpPriceToY(b.priceHi, priceMin, priceMax, rh);
            const yBot = ry + fvpPriceToY(b.priceLo, priceMin, priceMax, rh);
            const barH = Math.max(FVP_MIN_BAR_H, yBot - yTop);

            // Only draw numbers when the bar is tall enough to be readable
            if (barH < fs + 2) continue;

            const midY = yTop + (yBot - yTop) / 2;
            const bv = b.buyVol;
            const sv = b.sellVol;
            const tv = b.totalVol;

            if (mode === 'delta') {
                const delta = bv - sv;
                const dWidth = (Math.abs(delta) / maxVol) * rw * bwFrac;
                const label = delta > 0 ? `+${Math.round(delta)}` : String(Math.round(delta));
                const fits = ctx.measureText(label).width + 6 < dWidth;
                ctx.fillStyle = delta >= 0 ? totalColor : deltaNeg;
                if (fits) {
                    // Inside the bar
                    ctx.textAlign = 'right';
                    ctx.fillText(label, rx + dWidth - 3, midY);
                } else {
                    // Outside right
                    ctx.textAlign = 'left';
                    ctx.fillText(label, rx + dWidth + 3, midY);
                }
            } else if (mode === 'split') {
                const half = (rw / 2) * bwFrac;
                const buyW = (bv / maxVol) * half;
                const sellW = (sv / maxVol) * half;
                const cx = rx + rw / 2;

                const bLabel = String(Math.round(bv));
                const sLabel = String(Math.round(sv));

                ctx.fillStyle = buyColor;
                ctx.textAlign = buyW > ctx.measureText(bLabel).width + 6 ? 'right' : 'left';
                ctx.fillText(
                    bLabel,
                    buyW > ctx.measureText(bLabel).width + 6 ? cx + buyW - 3 : cx + buyW + 3,
                    midY,
                );

                ctx.fillStyle = sellColor;
                ctx.textAlign = sellW > ctx.measureText(sLabel).width + 6 ? 'left' : 'right';
                ctx.fillText(
                    sLabel,
                    sellW > ctx.measureText(sLabel).width + 6 ? cx - sellW + 3 : cx - sellW - 3,
                    midY,
                );
            } else {
                // stacked / total
                const label =
                    mode === 'total'
                        ? String(Math.round(tv))
                        : `${Math.round(bv)}×${Math.round(sv)}`;
                const totalW = (tv / maxVol) * rw * bwFrac;
                const tw = ctx.measureText(label).width;
                const fits = tw + 6 < totalW;

                ctx.fillStyle = 'rgba(255,255,255,0.80)';
                if (fits) {
                    ctx.textAlign = 'right';
                    ctx.fillText(label, rx + totalW - 3, midY);
                } else {
                    ctx.textAlign = 'left';
                    ctx.fillText(label, rx + totalW + 3, midY);
                }
            }
        }
        ctx.globalAlpha = 1;
    }

    ctx.restore(); // end clip

    // POC line (may extend outside drawing rect)
    if (d.showPoc && !isNaN(poc) && poc >= priceMin && poc <= priceMax) {
        const pocY = Math.round(transformer.priceToY(poc, h)) + oy + 0.5;
        const pocLeft = d.pocExtendLeft ? 0 : rx;
        const pocRight = d.pocExtendRight ? w : rx + rw;

        ctx.strokeStyle = pocColor;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(pocLeft, pocY);
        ctx.lineTo(pocRight, pocY);
        ctx.stroke();
        ctx.setLineDash([]);

        if (d.showPocLabel) {
            const label = `POC  ${poc.toFixed(2)}`;
            const labelX = pocRight - 4;
            if (labelPills) {
                drawPillLabel(
                    ctx,
                    label,
                    labelX,
                    pocY - 9,
                    hexToRgba(pocColor, Math.max(hexToAlpha(pocColor), 0.85)),
                    PILL_BG,
                    9,
                    'right',
                );
            } else {
                ctx.font = '9px monospace';
                ctx.textBaseline = 'middle';
                ctx.fillStyle = pocColor;
                ctx.textAlign = 'right';
                ctx.fillText(label, labelX, pocY - 7);
            }
        }
    }

    // VAH / VAL lines
    if (d.showVaHLines && maxVol > 0) {
        const vaColor = d.vaLineColor ?? '#888888';
        const vaLeft = d.vaLineExtendLeft ? 0 : rx;
        const vaRight = d.vaLineExtendRight ? w : rx + rw;

        ctx.strokeStyle = vaColor;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);

        for (const [vaPrice, vaTag] of [
            [vaHi, 'VAH'],
            [vaLo, 'VAL'],
        ] as const) {
            if (vaPrice < priceMin || vaPrice > priceMax) continue;
            const vy = Math.round(transformer.priceToY(vaPrice, h)) + oy + 0.5;

            ctx.beginPath();
            ctx.moveTo(vaLeft, vy);
            ctx.lineTo(vaRight, vy);
            ctx.stroke();

            ctx.setLineDash([]);
            const label = `${vaTag}  ${vaPrice.toFixed(2)}`;
            const labelX = vaRight - 4;
            const labelY = vy - 9;
            if (labelPills) {
                drawPillLabel(
                    ctx,
                    label,
                    labelX,
                    labelY,
                    hexToRgba(d.vaLineColor ?? '#888888', Math.max(hexToAlpha(vaColor), 0.85)),
                    PILL_BG,
                    9,
                    'right',
                );
            } else {
                ctx.font = '9px monospace';
                ctx.textBaseline = 'middle';
                ctx.fillStyle = vaColor;
                ctx.textAlign = 'right';
                ctx.fillText(label, labelX, labelY);
            }
            ctx.setLineDash([4, 3]);
        }
        ctx.setLineDash([]);
    }

    // Developing POC
    // Note: vpData only contains aggregate totals so the "developing" lines are
    // a visual approximation based on linearly scaling the aggregate - not
    // true time-sequenced playback.  They still give useful directional signal.
    if (d.showDevPoc && n > 0 && maxVol > 0) {
        ctx.strokeStyle = d.devPocColor ?? '#facc15';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();

        const SLICES = Math.min(n, 60);
        const tStart = d.a.ts < d.b.ts ? d.a.ts : d.b.ts;
        const tEnd = d.a.ts < d.b.ts ? d.b.ts : d.a.ts;

        let prevY = ry + rh / 2;
        for (let s = 1; s <= SLICES; s++) {
            const frac = s / SLICES;
            const sliceTs = tStart + BigInt(Math.round(Number(tEnd - tStart) * frac));
            const sliceX = transformer.tsToX(sliceTs, w);

            let maxSliceVol = -1,
                slicePoc = poc;
            for (let i = 0; i < n; i++) {
                const sv = totalVol[i] * frac;
                if (sv > maxSliceVol) {
                    maxSliceVol = sv;
                    slicePoc = prices[i];
                }
            }
            const sliceY = transformer.priceToY(slicePoc, h) + oy;

            if (s === 1) {
                ctx.moveTo(sliceX, sliceY);
            } else {
                ctx.lineTo(sliceX, prevY);
                ctx.lineTo(sliceX, sliceY);
            }
            prevY = sliceY;
        }
        ctx.stroke();
        ctx.setLineDash([]);
    }

    // Developing VA
    if (d.showDevVa && n > 0 && maxVol > 0) {
        ctx.strokeStyle = d.devVaColor ?? '#888888';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([2, 4]);

        const SLICES = Math.min(n, 60);
        const tStart = d.a.ts < d.b.ts ? d.a.ts : d.b.ts;
        const tEnd = d.a.ts < d.b.ts ? d.b.ts : d.a.ts;
        const vahPts: [number, number][] = [];
        const valPts: [number, number][] = [];

        for (let s = 1; s <= SLICES; s++) {
            const frac = s / SLICES;
            const sliceTs = tStart + BigInt(Math.round(Number(tEnd - tStart) * frac));
            const sliceX = transformer.tsToX(sliceTs, w);

            const scaledVol = new Float64Array(totalVol.map((v) => v * frac));
            const { loIdx, hiIdx } = computeVa(scaledVol, poc, prices, d.valueAreaPct ?? 70);
            vahPts.push([sliceX, transformer.priceToY(prices[hiIdx], h) + oy]);
            valPts.push([sliceX, transformer.priceToY(prices[loIdx], h) + oy]);
        }

        for (const pts of [vahPts, valPts]) {
            ctx.beginPath();
            for (let i = 0; i < pts.length; i++) {
                const [sx, sy] = pts[i];
                if (i === 0) {
                    ctx.moveTo(sx, sy);
                } else {
                    const [, py] = pts[i - 1];
                    ctx.lineTo(sx, py); // horizontal step
                    ctx.lineTo(sx, sy); // vertical transition
                }
            }
            ctx.stroke();
        }
        ctx.setLineDash([]);
    }

    // Handles (selected / hovered state)
    if (selected || hovered) {
        const hc = '#6490c8';
        // corner handles
        drawHandle(ctx, rx, ry, hc, hotAnchor === 'tl');
        drawHandle(ctx, rx + rw, ry + rh, hc, hotAnchor === 'br');
    }
}

// Main draw entry
export function drawDrawingsLayer(
    canvas: HTMLCanvasElement,
    drawings: Drawing[],
    bounds: ViewBounds,
    panes: ChartPane[],
    selectedId: string | null,
    hoveredId: string | null,
    hotAnchor: DrawingAnchorId | null,
    draft?: DraftDrawing | null,
    crosshair?: Crosshair,
    skipId?: string | null,
    holdingCtrl?: boolean | null,
    holdingShift?: boolean | null,
    barNs?: bigint | null,
    chartSettings?: ChartSettings,
    footprintBars?: FootprintBar[],
    priceHistory?: PriceHistory[],
    transformer?: LiveTransformer,
    hidePriceScale?: boolean,
    hideTimeScale?: boolean,
    priceScaleWidth?: number,
    symbolInfo?: SymbolInfo,
    horizon?: bigint,
) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (canvas.width === 0 || canvas.height === 0) return;

    // Draw in CSS px, like the base and UI layers (see renderer.ts). This layer
    // used to be the odd one out: no DPR transform, and its geometry derived from
    // the raw bitmap size while priceScaleWidth / X_AXIS_HEIGHT came in as CSS px.
    // On a DPR-1 screen those are the same number so nothing showed; at DPR 2 the
    // mixed units drifted every drawing away from the candles it was anchored to
    // (up to priceScaleWidth/2 horizontally), and strokes and labels came out at
    // half their intended size.
    const dpr = getEffectiveDpr();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cssW = canvas.width / dpr;
    const cssH = canvas.height / dpr;
    const chartW = cssW - (hidePriceScale ? 0 : priceScaleWidth);
    const totalH = cssH - (hideTimeScale ? 0 : X_AXIS_HEIGHT);
    const layouts = getPaneLayouts(panes, totalH, cssW, hidePriceScale ? 0 : priceScaleWidth);
    const mainRect = layouts['main'];
    const mainH = mainRect ? mainRect.h : totalH;
    const mainOffsetY = mainRect ? mainRect.y : 0;

    const draftMousePrice = crosshair?.y
        ? transformer.yToPrice(crosshair.y, mainH) + mainOffsetY
        : undefined;
    const draftMouseTs = crosshair?.x ? transformer.xToTs(crosshair.x, chartW) : undefined;

    for (const d of drawings) {
        //@ts-ignore
        if (d.visible === false && d.id !== selectedId) continue;
        if (skipId && d.id === skipId) continue;

        const isSelected = d.id === selectedId;
        const isHovered = d.id === hoveredId && !isSelected;
        const hot = isSelected || isHovered ? hotAnchor : null;

        // Plugin drawing
        const pluginTool = drawingRegistry.get(d.tool);
        if (pluginTool) {
            const pd = d as PluginDrawing;
            ctx.save();
            ctx.beginPath();
            ctx.rect(0, mainOffsetY, chartW, mainH);
            ctx.clip();
            try {
                pluginTool.render({
                    ctx,
                    anchors: pd.anchors,
                    w: chartW,
                    h: mainH,
                    oy: mainOffsetY,
                    transformer,
                    selected: isSelected,
                    hovered: isHovered,
                    hotAnchor: hot,
                    data: pd.data,
                });
            } catch (e) {
                console.error(`[DrawingRegistry] render error for '${pd.tool}':`, e);
            }
            ctx.restore();
            continue; // skip the built-in switch
        }

        // Narrow away PluginDrawing (handled above) so the switch can discriminate
        if ('anchors' in d) continue;
        ctx.save();

        switch (d.tool) {
            case 'vline':
                ctx.beginPath();
                ctx.rect(0, 0, chartW, totalH);
                ctx.clip();
                renderVLine(
                    ctx,
                    d,
                    bounds,
                    chartW,
                    totalH,
                    isSelected,
                    isHovered,
                    hot,
                    transformer,
                );
                break;
            case 'hline':
                ctx.beginPath();
                ctx.rect(0, mainOffsetY, chartW, mainH);
                ctx.clip();
                renderHLine(
                    ctx,
                    d,
                    bounds,
                    chartW,
                    mainH,
                    mainOffsetY,
                    isSelected,
                    isHovered,
                    hot,
                    transformer,
                );
                break;
            case 'extended-line':
                ctx.beginPath();
                ctx.rect(0, mainOffsetY, chartW, mainH);
                ctx.clip();
                renderExtLine(
                    ctx,
                    d,
                    bounds,
                    chartW,
                    mainH,
                    mainOffsetY,
                    isSelected,
                    isHovered,
                    hot,
                    transformer,
                );
                break;
            case 'line':
                ctx.beginPath();
                ctx.rect(0, mainOffsetY, chartW, mainH);
                ctx.clip();
                renderLine(
                    ctx,
                    d,
                    bounds,
                    chartW,
                    mainH,
                    mainOffsetY,
                    isSelected,
                    isHovered,
                    hot,
                    transformer,
                );
                break;
            case 'cross-line':
                ctx.beginPath();
                ctx.rect(0, mainOffsetY, chartW, mainH);
                ctx.clip();
                renderCrossLine(
                    ctx,
                    d,
                    bounds,
                    chartW,
                    mainH,
                    mainOffsetY,
                    isSelected,
                    isHovered,
                    hot,
                    transformer,
                );
                break;
            case 'info-line':
                ctx.beginPath();
                ctx.rect(0, mainOffsetY, chartW, mainH);
                ctx.clip();
                renderInfoLine(
                    ctx,
                    d,
                    bounds,
                    chartW,
                    mainH,
                    mainOffsetY,
                    isSelected,
                    isHovered,
                    hot,
                    transformer,
                );
                break;
            case 'trend-angle':
                ctx.beginPath();
                ctx.rect(0, mainOffsetY, chartW, mainH);
                ctx.clip();
                renderTrendAngle(
                    ctx,
                    d,
                    bounds,
                    chartW,
                    mainH,
                    mainOffsetY,
                    isSelected,
                    isHovered,
                    hot,
                    transformer,
                );
                break;
            case 'ray':
                ctx.beginPath();
                ctx.rect(0, mainOffsetY, chartW, mainH);
                ctx.clip();
                renderRay(
                    ctx,
                    d,
                    bounds,
                    chartW,
                    mainH,
                    mainOffsetY,
                    isSelected,
                    isHovered,
                    hot,
                    transformer,
                );
                break;
            case 'hray':
                ctx.beginPath();
                ctx.rect(0, mainOffsetY, chartW, mainH);
                ctx.clip();
                renderHRay(
                    ctx,
                    d,
                    bounds,
                    chartW,
                    mainH,
                    mainOffsetY,
                    isSelected,
                    isHovered,
                    hot,
                    transformer,
                );
                break;
            case 'parallel-channel':
                ctx.beginPath();
                ctx.rect(0, mainOffsetY, chartW, mainH);
                ctx.clip();
                renderParallelChannel(
                    ctx,
                    d,
                    bounds,
                    chartW,
                    mainH,
                    mainOffsetY,
                    isSelected,
                    isHovered,
                    hot,
                    transformer,
                );
                break;
            case 'rect':
                ctx.beginPath();
                ctx.rect(0, mainOffsetY, chartW, mainH);
                ctx.clip();
                renderRect(
                    ctx,
                    d,
                    bounds,
                    chartW,
                    mainH,
                    mainOffsetY,
                    isSelected,
                    isHovered,
                    hot,
                    transformer,
                );
                break;
            case 'triangle':
                ctx.beginPath();
                ctx.rect(0, mainOffsetY, chartW, mainH);
                ctx.clip();
                renderTriangle(
                    ctx,
                    d,
                    bounds,
                    chartW,
                    mainH,
                    mainOffsetY,
                    isSelected,
                    isHovered,
                    hot,
                    transformer,
                );
                break;
            case 'fib':
                ctx.beginPath();
                ctx.rect(0, mainOffsetY, chartW, mainH);
                ctx.clip();
                renderFib(
                    ctx,
                    d,
                    bounds,
                    chartW,
                    mainH,
                    mainOffsetY,
                    isSelected,
                    isHovered,
                    hot,
                    transformer,
                );
                break;
            case 'text':
                ctx.beginPath();
                ctx.rect(0, mainOffsetY, chartW, mainH);
                ctx.clip();
                renderText(
                    ctx,
                    d,
                    bounds,
                    chartW,
                    mainH,
                    mainOffsetY,
                    isSelected,
                    isHovered,
                    hot,
                    transformer,
                );
                break;
            case 'fvp':
                ctx.beginPath();
                ctx.rect(0, mainOffsetY, chartW, mainH);
                ctx.clip();
                renderFvp(
                    ctx,
                    d,
                    bounds,
                    chartW,
                    mainH,
                    mainOffsetY,
                    isSelected,
                    isHovered,
                    hot,
                    transformer,
                    resolveTickSize(symbolInfo),
                );
                break;
            case 'long':
            case 'short':
                ctx.beginPath();
                ctx.rect(0, mainOffsetY, chartW, mainH);
                ctx.clip();
                renderPositionDrawing(
                    ctx,
                    d,
                    chartW,
                    mainH,
                    mainOffsetY,
                    isSelected,
                    isHovered,
                    hot,
                    transformer,
                    symbolInfo,
                );
                break;
        }
        ctx.restore();
    }

    // Draft ghost
    if (draft && draftMousePrice !== undefined && draftMouseTs !== undefined) {
        ctx.save();
        // ctx.globalAlpha = 0.6;
        // ctx.setLineDash([4, 3]);

        if (draft && 'pluginToolId' in draft) {
            const pd = draft as PluginDraftDrawing;
            const pluginTool = drawingRegistry.get(pd.pluginToolId);
            if (
                pluginTool?.preview &&
                draftMouseTs !== undefined &&
                draftMousePrice !== undefined
            ) {
                ctx.save();
                ctx.globalAlpha = 0.6;
                ctx.beginPath();
                ctx.rect(0, mainOffsetY, chartW, mainH);
                ctx.clip();
                try {
                    pluginTool.preview({
                        ctx,
                        anchors: pd.anchors,
                        w: chartW,
                        h: mainH,
                        oy: mainOffsetY,
                        transformer,
                        selected: false,
                        hovered: false,
                        hotAnchor: null,
                        data: pd.data,
                        cursorAnchor: { ts: draftMouseTs, price: draftMousePrice },
                    });
                } catch (e) {
                    console.error(`[DrawingRegistry] preview error for '${pd.pluginToolId}':`, e);
                }
                ctx.restore();
            }
        }

        if (!('pluginToolId' in draft))
            switch (draft.tool) {
                case 'hline': {
                    const y = transformer.priceToY(draft.price, mainH) + mainOffsetY;
                    ctx.strokeStyle = '#e0e0e0';
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(0, y);
                    ctx.lineTo(chartW, y);
                    ctx.stroke();
                    break;
                }
                case 'vline': {
                    const x = transformer.tsToX(draft.ts, chartW);
                    ctx.strokeStyle = '#888888';
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(x, 0);
                    ctx.lineTo(x, totalH);
                    ctx.stroke();
                    break;
                }
                case 'extended-line':
                case 'info-line':
                case 'trend-angle':
                case 'line':
                case 'ray': {
                    const x1 = transformer.tsToX(draft.a.ts, chartW);
                    const y1 = transformer.priceToY(draft.a.price, mainH) + mainOffsetY;
                    const ts = snapTs(draftMouseTs, barNs, transformer.getSessionMapper());
                    const x2 = transformer.tsToX(ts, chartW);

                    let _y = transformer.priceToY(draftMousePrice, mainH) + mainOffsetY;

                    if (holdingShift) {
                        _y = y1;
                    } else if (holdingCtrl) {
                        const price = snapPrice(
                            ts,
                            draftMousePrice,
                            chartSettings,
                            footprintBars,
                            priceHistory,
                            [],
                            'l3',
                            horizon,
                        );
                        _y = transformer.priceToY(price, mainH) + mainOffsetY;
                    }

                    const y2 = _y;
                    ctx.strokeStyle = '#e0e0e0';
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    if (draft.tool === 'ray') {
                        const extendsRight = x2 >= x1;
                        const [sx, sy, ex, ey] = extendedEndpoints(
                            x1,
                            y1,
                            x2,
                            y2,
                            chartW,
                            !extendsRight,
                            extendsRight,
                        );
                        const farX = extendsRight ? ex : sx;
                        const farY = extendsRight ? ey : sy;
                        ctx.moveTo(x1, y1);
                        ctx.lineTo(farX, farY);
                    } else if (draft.tool === 'extended-line') {
                        const [sx, sy, ex, ey] = extendedEndpoints(
                            x1,
                            y1,
                            x2,
                            y2,
                            chartW,
                            true,
                            true,
                        );
                        ctx.moveTo(sx, sy);
                        ctx.lineTo(ex, ey);
                    } else if (draft.tool === 'trend-angle') {
                        drawTrendAngle(
                            ctx,
                            { ...draft, b: { ts, price: draftMousePrice } },
                            bounds,
                            chartW,
                            mainH,
                            mainOffsetY,
                            transformer,
                        );
                        ctx.moveTo(x1, y1);
                        ctx.lineTo(x2, y2);
                    } else {
                        ctx.moveTo(x1, y1);
                        ctx.lineTo(x2, y2);
                    }
                    ctx.stroke();
                    break;
                }
                case 'parallel-channel': {
                    const x1 = transformer.tsToX(draft.a.ts, chartW);
                    const y1 = transformer.priceToY(draft.a.price, mainH) + mainOffsetY;
                    const ts = snapTs(draftMouseTs, barNs, transformer.getSessionMapper());
                    const x2 = transformer.tsToX(ts, chartW);
                    let _y = transformer.priceToY(draftMousePrice, mainH) + mainOffsetY;

                    if (holdingShift) {
                        _y = y1;
                    } else if (holdingCtrl) {
                        const price = snapPrice(
                            ts,
                            draftMousePrice,
                            chartSettings,
                            footprintBars,
                            priceHistory,
                            [],
                            'l3',
                            horizon,
                        );
                        _y = transformer.priceToY(price, mainH) + mainOffsetY;
                    }

                    const y2 = _y;

                    ctx.beginPath();
                    if (draft?.b) {
                        renderParallelChannel(
                            ctx,
                            {
                                ...draft,
                                b: draft.b,
                                height: draftMousePrice - draft.b.price,
                            } as ParallelChannelDrawing,
                            bounds,
                            chartW,
                            mainH,
                            mainOffsetY,
                            false,
                            false,
                            null,
                            transformer,
                        );
                    } else {
                        ctx.strokeStyle = '#e0e0e0';
                        ctx.moveTo(x1, y1);
                        ctx.lineTo(x2, y2);
                    }
                    ctx.stroke();

                    break;
                }
                case 'rect':
                case 'fib': {
                    if (!draft.b) {
                        // Just a dot at a
                        const x = transformer.tsToX(draft.a.ts, chartW);
                        const y = transformer.priceToY(draft.a.price, mainH) + mainOffsetY;
                        ctx.strokeStyle = '#3b82f6';
                        ctx.lineWidth = 1;
                        ctx.strokeRect(x - 4, y - 4, 8, 8);
                    } else {
                        const x1 = transformer.tsToX(draft.a.ts, chartW);
                        const y1 = transformer.priceToY(draft.a.price, mainH) + mainOffsetY;
                        const x2 = transformer.tsToX(draft.b.ts, chartW);
                        const y2 = transformer.priceToY(draft.b.price, mainH) + mainOffsetY;
                        if (draft.tool === 'rect') {
                            ctx.strokeStyle = '#3b82f6';
                            ctx.lineWidth = 1;
                            ctx.strokeRect(
                                Math.min(x1, x2),
                                Math.min(y1, y2),
                                Math.abs(x2 - x1),
                                Math.abs(y2 - y1),
                            );
                        } else {
                            // fib ghost - just horizontal lines
                            ctx.strokeStyle = '#facc15';
                            ctx.lineWidth = 1;
                            for (const level of DEFAULT_FIB_LEVELS) {
                                const diff = draft.a.price - draft.b.price;
                                const lp = draft.b.price + diff * parseFloat(level.value);
                                const ly = transformer.priceToY(lp, mainH) + mainOffsetY;
                                ctx.beginPath();
                                ctx.moveTo(transformer.tsToX(draft.a.ts, chartW), ly);
                                ctx.lineTo(transformer.tsToX(draft.b.ts, chartW), ly);
                                ctx.stroke();
                            }
                        }
                    }
                    break;
                }
                case 'triangle': {
                    // First click placed `a`; the cursor is the in-flight vertex.
                    // Before the second click we draw a line a->cursor; after it we
                    // draw the full a->b->cursor triangle.
                    const x1 = transformer.tsToX(draft.a.ts, chartW);
                    const y1 = transformer.priceToY(draft.a.price, mainH) + mainOffsetY;

                    const ts = snapTs(draftMouseTs, barNs, transformer.getSessionMapper());
                    const x2 = transformer.tsToX(ts, chartW);

                    let _y = transformer.priceToY(draftMousePrice, mainH) + mainOffsetY;

                    if (holdingShift) {
                        _y = y1;
                    } else if (holdingCtrl) {
                        const price = snapPrice(
                            ts,
                            draftMousePrice,
                            chartSettings,
                            footprintBars,
                            priceHistory,
                            [],
                            'l3',
                            horizon,
                        );
                        _y = transformer.priceToY(price, mainH) + mainOffsetY;
                    }

                    const y2 = _y;

                    ctx.beginPath();
                    ctx.moveTo(x1, y1);
                    if (draft.b) {
                        ctx.lineTo(
                            transformer.tsToX(draft.b.ts, chartW),
                            transformer.priceToY(draft.b.price, mainH) + mainOffsetY,
                        );
                        ctx.lineTo(x2, y2);
                        ctx.closePath();
                    } else {
                        ctx.lineTo(x2, y2);
                    }
                    ctx.strokeStyle = '#3b82f6';
                    ctx.fillStyle = '#3b82f61a';
                    if (draft.b) ctx.fill();
                    ctx.stroke();

                    break;
                }
                case 'text': {
                    const x = transformer.tsToX(draft.anchor.ts, chartW);
                    const y = transformer.priceToY(draft.anchor.price, mainH) + mainOffsetY;
                    ctx.strokeStyle = '#e0e0e0';
                    ctx.lineWidth = 1;
                    ctx.strokeRect(x - 4, y - 12, 48, 16);
                    break;
                }
                case 'fvp': {
                    if (!draft.b) {
                        const x = transformer.tsToX(draft.a.ts, chartW);
                        ctx.strokeStyle = '#3b82f6';
                        ctx.lineWidth = 1;
                        ctx.beginPath();
                        ctx.moveTo(x, 0);
                        ctx.lineTo(x, totalH);
                        ctx.stroke();
                    } else {
                        const x1 = transformer.tsToX(draft.a.ts, chartW);
                        const y1 = transformer.priceToY(draft.a.price, mainH) + mainOffsetY;
                        const x2 = transformer.tsToX(draft.b.ts, chartW);
                        const y2 = transformer.priceToY(draftMousePrice, mainH) + mainOffsetY;
                        ctx.lineWidth = 1;
                        ctx.strokeStyle = '#3b82f6';
                        ctx.beginPath();
                        ctx.moveTo(x1, 0);
                        ctx.lineTo(x1, totalH);
                        ctx.stroke();

                        ctx.beginPath();
                        ctx.moveTo(x2, 0);
                        ctx.lineTo(x2, totalH);
                        ctx.stroke();

                        ctx.beginPath();
                        ctx.moveTo(x1, y1);
                        ctx.lineTo(x2, y2);
                        ctx.stroke();
                    }
                    break;
                }
            }
        ctx.restore();
    }
}

// Hit testing
/**
 * Hit-test drawings against a pointer position.
 *
 * UNITS: everything here is CSS px - `mx`/`my` come from clientX/Y minus the
 * canvas rect, and pane layouts are computed in CSS px (useChartLayout divides
 * by the DPR). Pass `canvas.width / dpr`, NOT `canvas.width`: on a DPR-2 screen
 * the bitmap is twice the CSS size, which silently doubles chartW/mainH here and
 * puts every drawing's computed screen position at ~2x - hits stop landing.
 * Note the sibling getDrawingLabelAnchor() takes the RAW bitmap size and divides
 * internally; the two do not share a convention.
 */
export function hitTestDrawings(
    mx: number,
    my: number,
    drawings: Drawing[],
    bounds: ViewBounds,
    panes: ChartPane[],
    /** canvas width in CSS px (canvas.width / dpr) */
    cssW: number,
    /** canvas height in CSS px (canvas.height / dpr) */
    cssH: number,
    transformer: LiveTransformer,
    hideTimeScale: boolean,
    priceScaleWidth: number,
    symbolInfo?: SymbolInfo,
): HitResult {
    const T = HIT_TOLERANCE_PX;
    const chartW = cssW - priceScaleWidth;
    const totalH = cssH - (hideTimeScale ? 0 : X_AXIS_HEIGHT);
    const layouts = getPaneLayouts(panes, totalH, cssW, priceScaleWidth);
    const mainRect = layouts['main'];
    const mainH = mainRect ? mainRect.h : totalH;
    const mainOY = mainRect ? mainRect.y : 0;

    // iterate back-to-front so topmost drawing wins
    for (let i = drawings.length - 1; i >= 0; i--) {
        const d = drawings[i];
        //@ts-ignore
        if (d.visible === false) continue;

        const pluginTool = drawingRegistry.get(d.tool);
        if (pluginTool) {
            const pd = d as PluginDrawing;
            try {
                const hit = pluginTool.hitTest({
                    mx,
                    my,
                    anchors: pd.anchors,
                    w: chartW,
                    h: mainH,
                    oy: mainOY,
                    transformer,
                    data: pd.data,
                });
                if (hit !== false) {
                    return { drawingId: d.id, anchor: hit === 'body' ? 'body' : hit };
                }
            } catch (e) {
                console.error(`[DrawingRegistry] hitTest error for '${pd.tool}':`, e);
            }
            continue;
        }

        // Narrow away PluginDrawing (handled above) so the switch can discriminate
        if ('anchors' in d) continue;
        switch (d.tool) {
            case 'hline': {
                const y = transformer.priceToY(d.price, mainH) + mainOY;
                if (Math.abs(my - y) <= T && mx >= 0 && mx <= chartW)
                    return { drawingId: d.id, anchor: 'body' };
                break;
            }
            case 'vline': {
                const x = transformer.tsToX(d.ts, chartW);
                if (Math.abs(mx - x) <= T && my >= 0 && my <= totalH)
                    return { drawingId: d.id, anchor: 'body' };
                break;
            }
            case 'extended-line': {
                const x1 = transformer.tsToX(d.a.ts, chartW),
                    y1 = transformer.priceToY(d.a.price, mainH) + mainOY;
                const x2 = transformer.tsToX(d.b.ts, chartW),
                    y2 = transformer.priceToY(d.b.price, mainH) + mainOY;
                const [sx, sy, ex, ey] = extendedEndpoints(
                    x1,
                    y1,
                    x2,
                    y2,
                    chartW,
                    d.extendLeft,
                    d.extendRight,
                );
                // Anchor handles take priority
                if (Math.hypot(mx - x1, my - y1) <= T + 2) return { drawingId: d.id, anchor: 'a' };
                if (Math.hypot(mx - x2, my - y2) <= T + 2) return { drawingId: d.id, anchor: 'b' };
                if (ptSegDist(mx, my, sx, sy, ex, ey) <= T)
                    return { drawingId: d.id, anchor: 'body' };
                break;
            }
            case 'info-line':
            case 'trend-angle':
            case 'line': {
                const x1 = transformer.tsToX(d.a.ts, chartW),
                    y1 = transformer.priceToY(d.a.price, mainH) + mainOY;
                const x2 = transformer.tsToX(d.b.ts, chartW),
                    y2 = transformer.priceToY(d.b.price, mainH) + mainOY;
                const [sx, sy, ex, ey] = extendedEndpoints(
                    x1,
                    y1,
                    x2,
                    y2,
                    chartW,
                    d.extendLeft,
                    d.extendRight,
                );
                // Anchor handles take priority
                if (Math.hypot(mx - x1, my - y1) <= T + 2) return { drawingId: d.id, anchor: 'a' };
                if (Math.hypot(mx - x2, my - y2) <= T + 2) return { drawingId: d.id, anchor: 'b' };
                if (ptSegDist(mx, my, sx, sy, ex, ey) <= T)
                    return { drawingId: d.id, anchor: 'body' };
                break;
            }
            case 'cross-line': {
                const y = transformer.priceToY(d.price, mainH) + mainOY;
                const x = transformer.tsToX(d.ts, chartW);

                if (Math.abs(my - y) <= T && mx >= 0 && mx <= chartW)
                    return { drawingId: d.id, anchor: 'body' };

                if (Math.abs(mx - x) <= T && my >= 0 && my <= totalH)
                    return { drawingId: d.id, anchor: 'body' };

                break;
            }
            case 'ray': {
                const x1 = transformer.tsToX(d.a.ts, chartW),
                    y1 = transformer.priceToY(d.a.price, mainH) + mainOY;
                const x2 = transformer.tsToX(d.b.ts, chartW),
                    y2 = transformer.priceToY(d.b.price, mainH) + mainOY;
                const extendsRight = x2 >= x1;
                const [sx, sy, ex, ey] = extendedEndpoints(
                    x1,
                    y1,
                    x2,
                    y2,
                    chartW,
                    !extendsRight,
                    extendsRight,
                );
                const farX = extendsRight ? ex : sx;
                const farY = extendsRight ? ey : sy;
                if (Math.hypot(mx - x1, my - y1) <= T + 2) return { drawingId: d.id, anchor: 'a' };
                if (Math.hypot(mx - x2, my - y2) <= T + 2) return { drawingId: d.id, anchor: 'b' };
                if (ptSegDist(mx, my, x1, y1, farX, farY) <= T)
                    return { drawingId: d.id, anchor: 'body' };
                break;
            }
            case 'hray': {
                const y = transformer.priceToY(d.price, mainH) + mainOY;
                const x = transformer.tsToX(d.ts, chartW);
                if (Math.abs(my - y) <= T && mx >= x && mx <= chartW)
                    return { drawingId: d.id, anchor: 'body' };
                break;
            }
            case 'parallel-channel': {
                // ctx.beginPath();
                //         ctx.moveTo(x1, y1);
                //         ctx.lineTo(x2, y2);
                //         ctx.moveTo(x1, y1 - d.height);
                //         ctx.lineTo(x2, y2 - d.height);
                //         ctx.stroke();

                //         ctx.beginPath();
                //         ctx.setLineDash([4, 4]);

                //         ctx.moveTo(x1, y1 - d.height / 2);
                //         ctx.lineTo(x2, y2 - d.height / 2);
                // ctx.stroke();
                const x1 = transformer.tsToX(d.a.ts, chartW),
                    y1 = transformer.priceToY(d.a.price, mainH) + mainOY;
                const x2 = transformer.tsToX(d.b.ts, chartW),
                    y2 = transformer.priceToY(d.b.price, mainH) + mainOY;
                // Parallel line endpoints (height is a PRICE offset - convert like render).
                const yT1 = transformer.priceToY(d.a.price + d.height, mainH) + mainOY;
                const yT2 = transformer.priceToY(d.b.price + d.height, mainH) + mainOY;
                const cxp = (x1 + x2) / 2;

                // Anchor handles take priority
                if (Math.hypot(mx - x1, my - y1) <= T + 2) return { drawingId: d.id, anchor: 'a' };
                if (Math.hypot(mx - x2, my - y2) <= T + 2) return { drawingId: d.id, anchor: 'b' };
                if (Math.hypot(mx - x1, my - yT1) <= T + 2)
                    return { drawingId: d.id, anchor: 'a2' };
                if (Math.hypot(mx - x2, my - yT2) <= T + 2)
                    return { drawingId: d.id, anchor: 'a3' };
                if (Math.hypot(mx - cxp, my - (y1 + y2) / 2) <= T + 2)
                    return { drawingId: d.id, anchor: 'mt' };
                if (Math.hypot(mx - cxp, my - (yT1 + yT2) / 2) <= T + 2)
                    return { drawingId: d.id, anchor: 'mb' };

                // Body: any visible level line (honoring extend, like render).
                const extL = d.extendLeft ?? false;
                const extR = d.extendRight ?? false;
                for (const lvl of d.levels ?? DEFAULT_CHANNEL_LEVELS) {
                    if (!lvl.enabled) continue;
                    const ly1 =
                        transformer.priceToY(d.a.price + Number(lvl.value) * d.height, mainH) +
                        mainOY;
                    const ly2 =
                        transformer.priceToY(d.b.price + Number(lvl.value) * d.height, mainH) +
                        mainOY;
                    const [lsx, lsy, lex, ley] = extendedEndpoints(
                        x1,
                        ly1,
                        x2,
                        ly2,
                        chartW,
                        extL,
                        extR,
                    );
                    if (ptSegDist(mx, my, lsx, lsy, lex, ley) <= T)
                        return { drawingId: d.id, anchor: 'body' };
                }
                break;
            }
            case 'rect': {
                const x1 = transformer.tsToX(d.a.ts, chartW),
                    y1 = transformer.priceToY(d.a.price, mainH) + mainOY;
                const x2 = transformer.tsToX(d.b.ts, chartW),
                    y2 = transformer.priceToY(d.b.price, mainH) + mainOY;
                const rx = Math.min(x1, x2),
                    ry = Math.min(y1, y2);
                const rw = Math.abs(x2 - x1),
                    rh = Math.abs(y2 - y1);
                // Corners
                const corners: [number, number, DrawingAnchorId][] = [
                    [rx, ry, 'tl'],
                    [rx + rw, ry, 'tr'],
                    [rx, ry + rh, 'bl'],
                    [rx + rw, ry + rh, 'br'],
                ];
                for (const [cx, cy, id] of corners)
                    if (Math.hypot(mx - cx, my - cy) <= T + 2)
                        return { drawingId: d.id, anchor: id };
                // Edge midpoints
                const mids: [number, number, DrawingAnchorId][] = [
                    [rx + rw / 2, ry, 'mt'],
                    [rx + rw / 2, ry + rh, 'mb'],
                    [rx, ry + rh / 2, 'ml'],
                    [rx + rw, ry + rh / 2, 'mr'],
                ];
                for (const [cx, cy, id] of mids)
                    if (Math.hypot(mx - cx, my - cy) <= T + 2)
                        return { drawingId: d.id, anchor: id };
                // Edges only - interior clicks do NOT count as a body hit.
                // Moving the whole rect requires grabbing an edge (not the fill).
                if (
                    ptSegDist(mx, my, rx, ry, rx + rw, ry) <= T ||
                    ptSegDist(mx, my, rx + rw, ry, rx + rw, ry + rh) <= T ||
                    ptSegDist(mx, my, rx + rw, ry + rh, rx, ry + rh) <= T ||
                    ptSegDist(mx, my, rx, ry + rh, rx, ry) <= T
                )
                    return { drawingId: d.id, anchor: 'body' };
                break;
            }
            case 'triangle': {
                const x1 = transformer.tsToX(d.a.ts, chartW),
                    y1 = transformer.priceToY(d.a.price, mainH) + mainOY,
                    x2 = transformer.tsToX(d.b.ts, chartW),
                    y2 = transformer.priceToY(d.b.price, mainH) + mainOY,
                    x3 = transformer.tsToX(d.c.ts, chartW),
                    y3 = transformer.priceToY(d.c.price, mainH) + mainOY;

                // Vertex handles take priority over the body.
                const verts: [number, number, DrawingAnchorId][] = [
                    [x1, y1, 'a'],
                    [x2, y2, 'b'],
                    [x3, y3, 'c'],
                ];
                for (const [vx, vy, id] of verts)
                    if (Math.hypot(mx - vx, my - vy) <= T + 2)
                        return { drawingId: d.id, anchor: id };

                // Edges only - interior clicks do NOT count as a body hit, so the
                // fill stays click-through (same convention as rect).
                if (
                    ptSegDist(mx, my, x1, y1, x2, y2) <= T ||
                    ptSegDist(mx, my, x2, y2, x3, y3) <= T ||
                    ptSegDist(mx, my, x3, y3, x1, y1) <= T
                )
                    return { drawingId: d.id, anchor: 'body' };

                break;
            }
            // AFTER
            case 'fib': {
                const ax = transformer.tsToX(d.a.ts, chartW);
                const ay = transformer.priceToY(d.a.price, mainH) + mainOY;
                const bx = transformer.tsToX(d.b.ts, chartW);
                const by = transformer.priceToY(d.b.price, mainH) + mainOY;
                // Anchor handles take priority - must be checked before body
                if (Math.hypot(mx - ax, my - ay) <= T + 2) return { drawingId: d.id, anchor: 'a' };
                if (Math.hypot(mx - bx, my - by) <= T + 2) return { drawingId: d.id, anchor: 'b' };
                // Body hit: only within the drawn x range (not full chart width)
                const fibL = Math.min(ax, bx);
                const fibR = Math.max(ax, bx);
                const diff = d.a.price - d.b.price;
                for (const level of d.levels) {
                    if (!level.enabled) continue;
                    const lp = d.b.price + diff * parseFloat(level.value);
                    const ly = transformer.priceToY(lp, mainH) + mainOY;
                    if (Math.abs(my - ly) <= T && mx >= fibL && mx <= fibR)
                        return { drawingId: d.id, anchor: 'body' };
                }
                break;
            }
            case 'text': {
                const x =
                    d.screenAnchored && d.screenX !== undefined
                        ? d.screenX
                        : transformer.tsToX(d.anchor.ts, chartW);
                const y =
                    d.screenAnchored && d.screenY !== undefined
                        ? d.screenY
                        : transformer.priceToY(d.anchor.price, mainH) + mainOY;
                if (Math.hypot(mx - x, my - y) <= T + 2)
                    return { drawingId: d.id, anchor: 'anchor' };
                // rough text bounding box
                const lines = d.text.split('\n');
                const lineH = d.fontSize * 1.4;
                const totalTextH = lines.length * lineH;
                const maxLineLen = Math.max(...lines.map((l) => l.length));
                if (
                    mx >= x &&
                    mx <= x + maxLineLen * (d.fontSize * 0.6) + 8 &&
                    my >= y - d.fontSize - 4 &&
                    my <= y - 4 + totalTextH
                )
                    return { drawingId: d.id, anchor: 'body' };

                break;
            }
            case 'fvp': {
                const x1 = transformer.tsToX(d.a.ts, chartW),
                    y1 = transformer.priceToY(d.a.price, mainH) + mainOY;
                const x2 = transformer.tsToX(d.b.ts, chartW),
                    y2 = transformer.priceToY(d.b.price, mainH) + mainOY;
                const rx = Math.min(x1, x2),
                    ry = Math.min(y1, y2);
                const rw = Math.abs(x2 - x1),
                    rh = Math.abs(y2 - y1);
                const corners: [number, number, DrawingAnchorId][] = [
                    [rx, ry, 'tl'],
                    [rx + rw, ry, 'tr'],
                    [rx, ry + rh, 'bl'],
                    [rx + rw, ry + rh, 'br'],
                ];
                for (const [cx, cy, id] of corners)
                    if (Math.hypot(mx - cx, my - cy) <= T + 2)
                        return { drawingId: d.id, anchor: id };
                const mids: [number, number, DrawingAnchorId][] = [
                    [rx + rw / 2, ry, 'mt'],
                    [rx + rw / 2, ry + rh, 'mb'],
                    [rx, ry + rh / 2, 'ml'],
                    [rx + rw, ry + rh / 2, 'mr'],
                ];
                for (const [cx, cy, id] of mids)
                    if (Math.hypot(mx - cx, my - cy) <= T + 2)
                        return { drawingId: d.id, anchor: id };
                // Interior counts as body hit (VP fill is clickable)
                if (mx >= rx && mx <= rx + rw && my >= ry && my <= ry + rh)
                    return { drawingId: d.id, anchor: 'body' };
                break;
            }
            case 'long':
            case 'short': {
                const x1 = transformer.tsToX(d.a.ts, chartW);
                const x2 = transformer.tsToX(d.b.ts, chartW);
                const { entry, top, bottom } = positionLevels(d, resolveTickSize(symbolInfo));
                const yUp = transformer.priceToY(top, mainH) + mainOY;
                const yDown = transformer.priceToY(bottom, mainH) + mainOY;
                const yEntry = transformer.priceToY(entry, mainH) + mainOY;
                const rx = Math.min(x1, x2);
                const rw = Math.abs(x2 - x1);
                const handles: [number, number, DrawingAnchorId][] = [
                    [rx, yUp, 'mt'],
                    [rx, yDown, 'mb'],
                    //use some other anchor id to get the default cursor
                    [rx, yEntry, 'all'],
                    [rx + rw, yEntry, 'mr'],
                ];
                for (const [cx, cy, id] of handles)
                    if (Math.hypot(mx - cx, my - cy) <= T + 2)
                        return { drawingId: d.id, anchor: id };

                if (
                    mx >= rx &&
                    mx <= rx + rw &&
                    my >= Math.min(yUp, yDown) &&
                    my <= Math.max(yUp, yDown)
                )
                    return { drawingId: d.id, anchor: 'body' };
                break;
            }
        }
    }
    return null;
}

// Pixel position of a drawing's "label anchor" for the settings bar
// Returns {x, y} in canvas coords where the floating toolbar should appear.

/** UNITS: takes the RAW bitmap size (canvas.width/height) and converts to CSS px
 *  internally - the opposite of hitTestDrawings(), which wants CSS px already. */
export function getDrawingLabelAnchor(
    d: Drawing,
    bounds: ViewBounds,
    panes: ChartPane[],
    canvasW: number,
    canvasH: number,
    transformer: LiveTransformer,
    hideTimeScale: boolean,
    priceScaleWidth: number,
): { x: number; y: number } {
    const dpr = getEffectiveDpr();

    const cssW = canvasW / dpr;
    const cssH = canvasH / dpr;
    const chartW = cssW - priceScaleWidth;
    const totalH = cssH - (hideTimeScale ? 0 : X_AXIS_HEIGHT);
    const layouts = getPaneLayouts(panes, totalH, cssW, priceScaleWidth);
    const mainRect = layouts['main'];
    const mainH = mainRect ? mainRect.h : totalH;
    const mainOY = mainRect ? mainRect.y : 0;

    if ('anchors' in d) return { x: 0, y: 0 };
    switch (d.tool) {
        case 'hline':
            return { x: 80, y: transformer.priceToY(d.price, mainH) + mainOY };
        case 'vline':
            return { x: transformer.tsToX(d.ts, chartW) + 8, y: 20 };
        case 'cross-line':
            return {
                x: transformer.tsToX(d.ts, chartW) + 8,
                y: transformer.priceToY(d.price, mainH) + mainOY,
            };
        case 'extended-line':
        case 'info-line':
        case 'trend-angle':
        case 'line':
        case 'parallel-channel':
        case 'ray': {
            const x1 = transformer.tsToX(d.a.ts, chartW),
                y1 = transformer.priceToY(d.a.price, mainH) + mainOY;
            const x2 = transformer.tsToX(d.b.ts, chartW),
                y2 = transformer.priceToY(d.b.price, mainH) + mainOY;
            return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 28 };
        }
        case 'hray': {
            const x = transformer.tsToX(d.ts, chartW),
                y = transformer.priceToY(d.price, mainH) + mainOY;
            return { x: (x + chartW) / 2, y: (y + mainH) / 2 - 28 + mainOY };
        }
        case 'rect':
        case 'fib': {
            const x1 = transformer.tsToX(d.a.ts, chartW),
                y1 = transformer.priceToY(d.a.price, mainH) + mainOY;
            const x2 = transformer.tsToX(d.b.ts, chartW),
                y2 = transformer.priceToY(d.b.price, mainH) + mainOY;
            return { x: (x1 + x2) / 2, y: Math.min(y1, y2) - 28 };
        }
        case 'triangle': {
            const x1 = transformer.tsToX(d.a.ts, chartW),
                y1 = transformer.priceToY(d.a.price, mainH) + mainOY;
            const x2 = transformer.tsToX(d.b.ts, chartW),
                y2 = transformer.priceToY(d.b.price, mainH) + mainOY;
            const x3 = transformer.tsToX(d.c.ts, chartW),
                y3 = transformer.priceToY(d.c.price, mainH) + mainOY;
            return { x: (Math.min(x1, x2, x3) + Math.max(x1, x2, x3)) / 2, y: Math.min(y1, y2, y3) - 28 };
        }
        case 'text': {
            const x =
                d.screenAnchored && d.screenX !== undefined
                    ? d.screenX
                    : transformer.tsToX(d.anchor.ts, chartW);
            const y =
                d.screenAnchored && d.screenY !== undefined
                    ? d.screenY
                    : transformer.priceToY(d.anchor.price, mainH) + mainOY;
            return { x, y: y - 28 };
        }
        case 'fvp': {
            const x1 = transformer.tsToX(d.a.ts, chartW),
                y1 = transformer.priceToY(d.a.price, mainH) + mainOY;
            const x2 = transformer.tsToX(d.b.ts, chartW),
                y2 = transformer.priceToY(d.b.price, mainH) + mainOY;
            return { x: (x1 + x2) / 2, y: Math.min(y1, y2) - 28 };
        }
        case 'long':
        case 'short': {
            const x1 = transformer.tsToX(d.a.ts, chartW);
            const x2 = transformer.tsToX(d.b.ts, chartW);
            const yUp =
                transformer.priceToY(d.a.price + Math.max(d.upAmount, 0), mainH) + mainOY;
            const yDown =
                transformer.priceToY(d.a.price - Math.max(d.downAmount, 0), mainH) + mainOY;
            return { x: (x1 + x2) / 2, y: Math.min(yUp, yDown) - 28 };
        }
    }
}

export function moveDrawingAnchorDelta(
    d: Drawing,
    anchor: DrawingAnchorId,
    dts: bigint, // delta ts since last frame
    dprice: number, // delta price since last frame
    curTs: bigint, // absolute cursor position (for individual anchor snap)
    curPrice: number,
    holdingShift: boolean,
): { drawing: Drawing; anchor: DrawingAnchorId } {
    const ret = (drawing: Drawing, newAnchor: DrawingAnchorId = anchor) => ({
        drawing,
        anchor: newAnchor,
    });

    // Handle plugin drawings before the discriminated switch
    if ('anchors' in d) {
        const pd = d as PluginDrawing;
        const pluginTool = drawingRegistry.get(d.tool);
        if (pluginTool?.onMove) {
            const newData = pluginTool.onMove({
                data: pd.data,
                anchors: pd.anchors ?? [],
                anchor,
                dts,
                dprice,
                curTs,
                curPrice,
            });
            return ret({ ...pd, data: newData } as any);
        }
        if (!pd.anchors) return ret(d);
        if (anchor === 'body') {
            return ret({
                ...pd,
                anchors: pd.anchors.map((a) => ({ ts: a.ts + dts, price: a.price + dprice })),
            } as any);
        }
        if (typeof anchor !== 'string') return ret(d);
        const idx = parseInt(anchor.replace('a', ''), 10);
        if (!isNaN(idx) && idx < pd.anchors.length) {
            const newAnchors = pd.anchors.slice();
            newAnchors[idx] = { ts: curTs, price: curPrice };
            return ret({ ...pd, anchors: newAnchors } as any);
        }
        return ret(d);
    }

    switch (d.tool) {
        case 'hline':
            if (anchor === 'body') return ret({ ...d, price: curPrice });
            return ret({ ...d, price: curPrice }); // direct snap for handle

        case 'vline':
            if (anchor === 'body') return ret({ ...d, ts: d.ts + dts });
            return ret({ ...d, ts: curTs });

        case 'extended-line':
        case 'info-line':
        case 'trend-angle':
        case 'line':
        case 'ray':
            if (anchor === 'a')
                return ret({
                    ...d,
                    a: { ts: curTs, price: holdingShift && d?.b?.price ? d.b.price : curPrice },
                });
            if (anchor === 'b')
                return ret({ ...d, b: { ts: curTs, price: holdingShift ? d.a.price : curPrice } });
            // body - translate both anchors by delta
            return ret({
                ...d,
                a: { ts: d.a.ts + dts, price: d.a.price + dprice },
                b: {
                    ts: d.b.ts + dts,
                    price: d.b.price + dprice,
                },
            });

        case 'cross-line':
            return ret({
                ...d,
                price: d.price + dprice,
                ts: d.ts + dts,
            });

        case 'hray':
            return ret({
                ...d,
                price: d.price + dprice,
                ts: d.ts + dts,
            });

        case 'parallel-channel':
            if (anchor === 'a')
                return ret({
                    ...d,
                    a: { ts: curTs, price: holdingShift && d?.b?.price ? d.b.price : curPrice },
                });
            if (anchor === 'b')
                return ret({ ...d, b: { ts: curTs, price: holdingShift ? d.a.price : curPrice } });

            if (anchor === 'a2')
                return ret({
                    ...d,
                    a: {
                        ts: curTs,
                        price: holdingShift && d?.b?.price ? d.b.price : curPrice - d.height,
                    },
                });
            if (anchor === 'a3')
                return ret({
                    ...d,
                    b: { ts: curTs, price: holdingShift ? d.a.price : curPrice - d.height },
                });

            // Base-line midpoint: move the base boundary to the cursor and pin the
            // parallel boundary (channel resizes from the base side).
            if (anchor === 'mt') {
                const delta = curPrice - (d.a.price + d.b.price) / 2;
                return ret({
                    ...d,
                    a: { ...d.a, price: d.a.price + delta },
                    b: { ...d.b, price: d.b.price + delta },
                    height: d.height - delta,
                });
            }
            // Parallel-line midpoint: set height so that boundary follows the cursor.
            if (anchor === 'mb')
                return ret({ ...d, height: curPrice - (d.a.price + d.b.price) / 2 });

            // body - translate both anchors by delta
            return ret({
                ...d,
                a: { ts: d.a.ts + dts, price: d.a.price + dprice },
                b: {
                    ts: d.b.ts + dts,
                    price: d.b.price + dprice,
                },
            });

        case 'rect': {
            // `a` and `b` are the two defining corners; we don't care which is TL/BR -
            // we always work in terms of minTs/maxTs/minPrice/maxPrice and rebuild.
            const minTs = d.a.ts < d.b.ts ? d.a.ts : d.b.ts;
            const maxTs = d.a.ts < d.b.ts ? d.b.ts : d.a.ts;
            const minPrice = d.a.price < d.b.price ? d.a.price : d.b.price;
            const maxPrice = d.a.price < d.b.price ? d.b.price : d.a.price;

            let newMinTs = minTs,
                newMaxTs = maxTs;
            let newMinP = minPrice,
                newMaxP = maxPrice;

            switch (anchor) {
                // Corners - move one corner fully
                case 'tl':
                    newMinTs = curTs;
                    newMaxP = curPrice;
                    break;
                case 'tr':
                    newMaxTs = curTs;
                    newMaxP = curPrice;
                    break;
                case 'bl':
                    newMinTs = curTs;
                    newMinP = curPrice;
                    break;
                case 'br':
                    newMaxTs = curTs;
                    newMinP = curPrice;
                    break;
                // Edge midpoints - constrain one axis
                case 'mt':
                    newMaxP = curPrice;
                    break;
                case 'mb':
                    newMinP = curPrice;
                    break;
                case 'ml':
                    newMinTs = curTs;
                    break;
                case 'mr':
                    newMaxTs = curTs;
                    break;
                // Body / edges - translate whole rect
                default:
                    newMinTs = minTs + dts;
                    newMaxTs = maxTs + dts;
                    newMinP = minPrice + dprice;
                    newMaxP = maxPrice + dprice;
            }

            // Detect axis inversions before clamping, so we can remap the anchor.
            const tsFlipped = newMinTs > newMaxTs;
            const priceFlipped = newMinP > newMaxP;

            // Sort so crossing an edge inverts naturally
            if (tsFlipped) {
                const t = newMinTs;
                newMinTs = newMaxTs;
                newMaxTs = t;
            }
            if (priceFlipped) {
                const t = newMinP;
                newMinP = newMaxP;
                newMaxP = t;
            }

            // Remap the anchor to reflect the new geometry after an inversion.
            let newAnchor: DrawingAnchorId = anchor;
            if (tsFlipped || priceFlipped) {
                const flipTs = (a: DrawingAnchorId): DrawingAnchorId => {
                    if (a === 'ml') return 'mr';
                    if (a === 'mr') return 'ml';
                    if (a === 'tl') return 'tr';
                    if (a === 'tr') return 'tl';
                    if (a === 'bl') return 'br';
                    if (a === 'br') return 'bl';
                    return a;
                };
                const flipPrice = (a: DrawingAnchorId): DrawingAnchorId => {
                    if (a === 'mt') return 'mb';
                    if (a === 'mb') return 'mt';
                    if (a === 'tl') return 'bl';
                    if (a === 'bl') return 'tl';
                    if (a === 'tr') return 'br';
                    if (a === 'br') return 'tr';
                    return a;
                };
                if (tsFlipped) newAnchor = flipTs(newAnchor);
                if (priceFlipped) newAnchor = flipPrice(newAnchor);
            }

            // Always store a = (minTs, minPrice), b = (maxTs, maxPrice).
            return ret(
                { ...d, a: { ts: newMinTs, price: newMinP }, b: { ts: newMaxTs, price: newMaxP } },
                newAnchor,
            );
        }

        case 'triangle': {
            // Individual vertex - snap that point to the cursor.
            if(holdingShift){
                //Make it always prefer anchor 'c' (when it can)... c is just a goated letter
                if (anchor === 'a'){ return ret({ ...d, a: { ts: curTs, price: d[Math.abs(d.b.price - curPrice) < Math.abs(d.c.price - curPrice) ? 'b' : 'c'].price } }); }
                if (anchor === 'b'){ return ret({ ...d, b: { ts: curTs, price: d[Math.abs(d.a.price - curPrice) < Math.abs(d.c.price - curPrice) ? 'a' : 'c'].price } }); }
                if (anchor === 'c'){ return ret({ ...d, c: { ts: curTs, price: d[Math.abs(d.a.price - curPrice) < Math.abs(d.b.price - curPrice) ? 'a' : 'b'].price } }); }
            } else {
                if (anchor === 'a') return ret({ ...d, a: { ts: curTs, price: curPrice } });
                if (anchor === 'b') return ret({ ...d, b: { ts: curTs, price: curPrice } });
                if (anchor === 'c') return ret({ ...d, c: { ts: curTs, price: curPrice } });
            }
            // body - translate all three vertices by the frame delta.
            return ret({
                ...d,
                a: { ts: d.a.ts + dts, price: d.a.price + dprice },
                b: { ts: d.b.ts + dts, price: d.b.price + dprice },
                c: { ts: d.c.ts + dts, price: d.c.price + dprice },
            });
        }

        case 'fib':
            if (anchor === 'a') return ret({ ...d, a: { ts: curTs, price: curPrice } });
            if (anchor === 'b') return ret({ ...d, b: { ts: curTs, price: curPrice } });
            return ret({
                ...d,
                a: { ts: d.a.ts + dts, price: d.a.price + dprice },
                b: { ts: d.b.ts + dts, price: d.b.price + dprice },
            });

        case 'text':
            if (anchor === 'body' || anchor === 'anchor')
                return ret({
                    ...d,
                    anchor: { ts: d.anchor.ts + dts, price: d.anchor.price + dprice },
                });
            return ret({ ...d, anchor: { ts: curTs, price: curPrice } });

        case 'fvp': {
            // `a` and `b` are the two defining corners; we don't care which is TL/BR -
            // we always work in terms of minTs/maxTs/minPrice/maxPrice and rebuild.
            const minTs = d.a.ts < d.b.ts ? d.a.ts : d.b.ts;
            const maxTs = d.a.ts < d.b.ts ? d.b.ts : d.a.ts;
            const minPrice = d.a.price < d.b.price ? d.a.price : d.b.price;
            const maxPrice = d.a.price < d.b.price ? d.b.price : d.a.price;

            let newMinTs = minTs,
                newMaxTs = maxTs;
            let newMinP = minPrice,
                newMaxP = maxPrice;

            switch (anchor) {
                // Corners - move one corner fully
                case 'tl':
                    newMinTs = curTs;
                    newMaxP = curPrice;
                    break;
                case 'tr':
                    newMaxTs = curTs;
                    newMaxP = curPrice;
                    break;
                case 'bl':
                    newMinTs = curTs;
                    newMinP = curPrice;
                    break;
                case 'br':
                    newMaxTs = curTs;
                    newMinP = curPrice;
                    break;
                // Edge midpoints - constrain one axis
                case 'mt':
                    newMaxP = curPrice;
                    break;
                case 'mb':
                    newMinP = curPrice;
                    break;
                case 'ml':
                    newMinTs = curTs;
                    break;
                case 'mr':
                    newMaxTs = curTs;
                    break;
                // Body / edges - translate whole rect
                default:
                    newMinTs = minTs + dts;
                    newMaxTs = maxTs + dts;
                    newMinP = minPrice + dprice;
                    newMaxP = maxPrice + dprice;
            }

            // Detect axis inversions before clamping, so we can remap the anchor.
            const tsFlipped = newMinTs > newMaxTs;
            const priceFlipped = newMinP > newMaxP;

            // Sort so crossing an edge inverts naturally
            if (tsFlipped) {
                const t = newMinTs;
                newMinTs = newMaxTs;
                newMaxTs = t;
            }
            if (priceFlipped) {
                const t = newMinP;
                newMinP = newMaxP;
                newMaxP = t;
            }

            // Remap the anchor to reflect the new geometry after an inversion.
            let newAnchor: DrawingAnchorId = anchor;
            if (tsFlipped || priceFlipped) {
                const flipTs = (a: DrawingAnchorId): DrawingAnchorId => {
                    if (a === 'ml') return 'mr';
                    if (a === 'mr') return 'ml';
                    if (a === 'tl') return 'tr';
                    if (a === 'tr') return 'tl';
                    if (a === 'bl') return 'br';
                    if (a === 'br') return 'bl';
                    return a;
                };
                const flipPrice = (a: DrawingAnchorId): DrawingAnchorId => {
                    if (a === 'mt') return 'mb';
                    if (a === 'mb') return 'mt';
                    if (a === 'tl') return 'bl';
                    if (a === 'bl') return 'tl';
                    if (a === 'tr') return 'br';
                    if (a === 'br') return 'tr';
                    return a;
                };
                if (tsFlipped) newAnchor = flipTs(newAnchor);
                if (priceFlipped) newAnchor = flipPrice(newAnchor);
            }

            // Always store a = (minTs, minPrice), b = (maxTs, maxPrice).
            return ret(
                { ...d, a: { ts: newMinTs, price: newMinP }, b: { ts: newMaxTs, price: newMaxP } },
                newAnchor,
            );
        }

        case 'long':
        case 'short': {
            // Work in absolute prices (top / entry / bottom) and rebuild the
            // up/down offsets at the end, so each handle can hold the other two
            // edges still while it moves.
            const minTs = d.a.ts < d.b.ts ? d.a.ts : d.b.ts;
            const maxTs = d.a.ts < d.b.ts ? d.b.ts : d.a.ts;
            const topPrice = d.a.price + Math.max(d.upAmount, 0);
            const botPrice = d.a.price - Math.max(d.downAmount, 0);

            let newMinTs = minTs,
                newMaxTs = maxTs;
            let newTopP = topPrice,
                newEntryP = d.a.price,
                newBotP = botPrice;

            switch (anchor) {
                case 'mt':
                    newTopP = curPrice;
                    break;
                case 'mb':
                    newBotP = curPrice;
                    break;
                // Entry handle also owns the left edge; target and stop stay put
                // so dragging it re-prices the trade rather than sliding the box.
                case 'all':
                    newEntryP = curPrice;
                    newMinTs = curTs;
                    break;
                case 'mr':
                    newMaxTs = curTs;
                    break;
                // Body - translate the whole box
                default:
                    newMinTs = minTs + dts;
                    newMaxTs = maxTs + dts;
                    newTopP += dprice;
                    newEntryP += dprice;
                    newBotP += dprice;
            }

            // Sort so dragging an edge past the opposite one inverts naturally,
            // and remap the anchor to whichever edge it now is.
            let newAnchor: DrawingAnchorId = anchor;
            if (newMinTs > newMaxTs) {
                const t = newMinTs;
                newMinTs = newMaxTs;
                newMaxTs = t;
                if (newAnchor === 'ml') newAnchor = 'mr';
                else if (newAnchor === 'mr') newAnchor = 'ml';
            }

            // An edge dragged across the entry collapses to zero rather than
            // flipping sides - a target below a long's entry is not a target.
            return ret(
                {
                    ...d,
                    a: { ts: newMinTs, price: newEntryP },
                    b: { ts: newMaxTs, price: newEntryP },
                    upAmount: Math.max(newTopP - newEntryP, 0),
                    downAmount: Math.max(newEntryP - newBotP, 0),
                },
                newAnchor,
            );
        }
    }
}
