import { ChartSettings } from '../types/chart-settings';
import { LiveTransformer, SymbolInfo } from '../../core';
import { useTradeLines } from '../../hooks/useTradeLines';
import { ViewBounds } from '../types';
import { TradeLine } from '../types';
import { formatPrice } from '../priceFormat';
import { Crosshair } from './renderer';

/**
 * Mix a colour toward the chart's ground.
 *
 * Darkening rather than fading, because transparency on a trade line shows the
 * line through its own pill and leaves the axis tag looking unfinished. This
 * keeps every fill opaque and simply sits the colour further back.
 */
function towardGround(hex: string, amount: number): string {
    const parsed = hex.replace('#', '');
    const full =
        parsed.length === 3
            ? parsed
                  .split('')
                  .map((c) => c + c)
                  .join('')
            : parsed;
    const to = (offset: number) => parseInt(full.slice(offset, offset + 2), 16);
    // #191919 is the pill ground these sit against.
    const mix = (channel: number) => Math.round(channel * (1 - amount) + 0x19 * amount);
    return `rgb(${mix(to(0))}, ${mix(to(2))}, ${mix(to(4))})`;
}

// Draw helpers
function roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
    lr?: number,
    rr?: number,
) {
    const tl = lr ?? r; // top-left
    const tr = rr ?? r; // top-right
    const br = rr ?? r; // bottom-right
    const bl = lr ?? r; // bottom-left

    ctx.beginPath();
    ctx.moveTo(x + tl, y); // top edge start
    ctx.lineTo(x + w - tr, y); // top edge end
    ctx.quadraticCurveTo(x + w, y, x + w, y + tr); // top-right corner
    ctx.lineTo(x + w, y + h - br); // right edge
    ctx.quadraticCurveTo(x + w, y + h, x + w - br, y + h); // bottom-right corner
    ctx.lineTo(x + bl, y + h); // bottom edge
    ctx.quadraticCurveTo(x, y + h, x, y + h - bl); // bottom-left corner
    ctx.lineTo(x, y + tl); // left edge
    ctx.quadraticCurveTo(x, y, x + tl, y); // top-left corner
    ctx.closePath();
}

const GHOST_TP_COLOR = '#00e676'; // green
const GHOST_SL_COLOR = '#ff1744'; // red

// Sizes
const VIZ_PILL_H = 22; // height of the floating price pill
const VIZ_PILL_PAD_X = 10; // horizontal padding inside the pill
const VIZ_PILL_R = 4; // corner radius

/**
 * Draws the full visualizer for one ghost pill being dragged.
 *
 * Call once per active drag - i.e. for each slot where
 *   gs.draggingGhost === `${kind}_${index}`
 *
 * @param ctx        Canvas 2D context
 * @param w          Chart width (same as drawTradeLines `w` param)
 * @param pH         Chart height (priceAxisH)
 * @param entryPrice The entry-line's price (used to compute distance)
 * @param dragPrice  The current ghost price (snapped)
 * @param kind       'tp' | 'sl'
 * @param yOffset    Same yOffset used in drawTradeLines
 * @param bounds     ViewBounds
 * @param chartSettings ChartSettings
 * @param tickSize   Optional - used to show distance in ticks
 */
export function drawGhostDragVisualizer(
    ctx: CanvasRenderingContext2D,
    w: number,
    pH: number,
    entryPrice: number,
    dragPrice: number,
    kind: 'tp' | 'sl',
    yOffset: number,
    bounds: ViewBounds,
    chartSettings: ChartSettings,
    tickSize?: number,
    transformer?: LiveTransformer,
    symbolInfo?: SymbolInfo,
): void {
    const color = kind === 'tp' ? GHOST_TP_COLOR : GHOST_SL_COLOR;
    const label = kind === 'tp' ? 'TP' : 'SL';

    const dragY = transformer.priceToY(dragPrice, pH) + yOffset;
    const entryY = transformer.priceToY(entryPrice, pH) + yOffset;

    // Don't render if way off-screen
    if (dragY < -40 || dragY > pH + 40) return;

    // 1. Filled band (entry ↔ ghost)
    const bandTop = Math.min(dragY, entryY);
    const bandBottom = Math.max(dragY, entryY);
    const bandH = bandBottom - bandTop;

    ctx.save();
    ctx.globalAlpha = 0.02;
    ctx.fillStyle = color;
    ctx.fillRect(0, bandTop, w, bandH);
    ctx.restore();

    // Subtle edge gradient on the band
    ctx.save();
    const grad = ctx.createLinearGradient(0, bandTop, 0, bandBottom);
    grad.addColorStop(0, hexToRgba(color, kind === 'tp' ? 0.0 : 0.08));
    grad.addColorStop(1, hexToRgba(color, kind === 'tp' ? 0.08 : 0.0));
    ctx.globalAlpha = 1;
    ctx.fillStyle = grad;
    ctx.fillRect(0, bandTop, w, bandH);
    ctx.restore();

    // 2. Full-width dashed line at drag price
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.9;
    ctx.setLineDash([4, 4]);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, dragY);
    ctx.lineTo(w, dragY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // 3. Distance arrow line (entry -> ghost)
    const arrowX = w - 32;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.5;
    ctx.setLineDash([3, 4]);

    // Vertical span line on the left edge
    ctx.beginPath();
    ctx.moveTo(arrowX, entryY);
    ctx.lineTo(arrowX, dragY - (dragY > entryY ? 15 : -15));
    ctx.stroke();
    ctx.setLineDash([]);

    // Arrowhead at drag end
    const arrowDir = dragY < entryY ? 1 : -1; // 1 = pointing down (toward entry), -1 = up
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    ctx.moveTo(arrowX, dragY - (dragY > entryY ? 15 : -15));
    ctx.lineTo(arrowX - 5, dragY - (dragY > entryY ? 15 : -15) + arrowDir * 8);
    ctx.lineTo(arrowX + 5, dragY - (dragY > entryY ? 15 : -15) + arrowDir * 8);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();

    // 4. Floating price pill (right side, at dragY)
    ctx.save();
    ctx.font = '600 11px "Inter", system-ui, sans-serif';

    const priceStr = formatPrice(dragPrice, symbolInfo);
    const distRaw = Math.abs(dragPrice - entryPrice);
    const distTicks = tickSize && tickSize > 0 ? `${Math.round(distRaw / tickSize)} ticks` : null;
    const distPct = ((distRaw / entryPrice) * 100).toFixed(2) + '%';
    const distStr = distTicks ?? distPct;
    const pillText = `${label}  ${priceStr}  (${distStr})`;

    const textW = ctx.measureText(pillText).width;
    const pillW = textW + VIZ_PILL_PAD_X * 2;
    const pillX = w - pillW - 4; // hug the right edge
    const pillY = dragY - VIZ_PILL_H / 2;

    // Pill shadow
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 2;

    // Pill background
    roundRect(ctx, pillX, pillY, pillW, VIZ_PILL_H, VIZ_PILL_R);
    ctx.fillStyle = color;
    ctx.fill();

    // Pill text
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillStyle = '#000000';
    ctx.globalAlpha = 0.85;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(pillText, pillX + VIZ_PILL_PAD_X, dragY);

    ctx.restore();

    // 5. Thin horizontal glow at the drag line
    //    (a second wider stroke with low alpha for a soft "glow" look)
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 8;
    ctx.globalAlpha = 0.06;
    ctx.beginPath();
    ctx.moveTo(0, dragY);
    ctx.lineTo(w, dragY);
    ctx.stroke();
    ctx.restore();
}

// Main draw function
/**
 * Draws all trade lines onto the UI canvas layer.
 *
 * Returns a hit-test map so chart.tsx can wire up mouse interactions without
 * re-computing geometry.  See TradeLineHitMap below.
 */
export function drawTradeLines(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    bounds: ViewBounds,
    w: number,
    h: number,
    chartSettings: ChartSettings,
    tradeLines: TradeLine[],
    priceAxisH: number,
    yOffset: number = 0,
    hoveredLineId: string | null,
    draggingLineId: string | null,
    tradeLineInteraction: ReturnType<typeof useTradeLines>,
    tickSize: number,
    transformer: LiveTransformer,
    rightScaleWidth: number = 0,
    symbolInfo: SymbolInfo,
    crosshair: Crosshair,
): {hitMap: TradeLineHitMap, suspendCrosshair: boolean} {
    const ghostState: GhostInteractionState = tradeLineInteraction.getGhostState();
    const pH = priceAxisH ?? h;
    const hitMap: TradeLineHitMap = { lines: [], pricePills: [], ghostPills: [] };
    let suspendCrosshair = false;

    if (tradeLines.length === 0) return {hitMap, suspendCrosshair};

    const visible = tradeLines.filter((l) => l.visible !== false);
    ctx.fontKerning = 'none';

    if (ghostState) {
        for (const line of visible) {
            if (!line.ghosts) continue;
            const gs = ghostState[line.id ?? ''];
            if (!gs) continue;
            if (!gs?.draggingGhost) continue;

            if (gs.draggingGhostType === 'tp') {
                const price = gs.tpPrices[gs.draggingGhostIdx];
                if (price == null) continue;
                drawGhostDragVisualizer(
                    ctx,
                    w,
                    pH,
                    line.price, // entry price
                    price, // drag price
                    'tp',
                    yOffset,
                    bounds,
                    chartSettings,
                    tickSize,
                    transformer,
                    symbolInfo,
                );
            }

            if (gs.draggingGhostType === 'sl') {
                const price = gs.slPrices[gs.draggingGhostIdx];
                if (price == null) continue;
                drawGhostDragVisualizer(
                    ctx,
                    w,
                    pH,
                    line.price,
                    price,
                    'sl',
                    yOffset,
                    bounds,
                    chartSettings,
                    tickSize,
                    transformer,
                    symbolInfo,
                );
            }
        }
    }

    const drawTradeLineV2 = (line: TradeLine) => {
        // A proposal reads as intent, not as a holding: dotted rather than
        // solid, and every colour mixed toward the chart ground so it sits
        // behind everything real. Adjusted once, here, because the pill text and
        // the axis tag reach for these directly rather than through `accent`.
        const preview = !!line.preview;
        const shade = (hex: string) => (preview ? towardGround(hex, 0.45) : hex);

        const green = shade('#09e293');
        const red = shade('#e8146c');
        const blue = shade('#008aff');

        const rightOffset = 70;

        // Working orders (limit / stop / stop-limit) render exactly like an entry -
        // filled qty segment, same blue pill - but the middle segment shows the
        // order's side+type (e.g. "Buy Limit") in place of an entry's live PnL.
        const isOrder = line.kind === 'limit' || line.kind === 'stop' || line.kind === 'stop_limit';
        const isEntry = line.kind === 'entry';
        const isEntryLike = isEntry || isOrder;

        // Accent: entry + orders share the entry blue; tp green; sl red.
        const baseAccent = isEntryLike ? blue : line.kind === 'tp' ? green : red;

        const y = transformer.priceToY(line.price, pH) + yOffset;

        if(y >= pH){
            return;
        }
        if(isEntry){
            if(!line?.pnl){
                return;
            }
        }

        // geometry
        const pillH = 18;
        const pillY = y;
        const pad = 7; // uniform horizontal padding for every segment
        const xWidth = 7;
        const xHeight = 7;

        // Middle segment text:
        //   entry -> live PnL - order -> "Buy Limit" etc. - tp/sl -> bracket $ amount
        const pnlText = isEntry
            ? line.pnl >= 0
                ? `+${line.pnl.toFixed(2)}${line?.pnl ? ' USD' : ''}`
                : `${line.pnl.toFixed(2)}${line?.pnl ? ' USD' : ''}`
            : isOrder
              ? (line.label ?? '')
              : `${String(line.label).replace('TP ', '').replace('SL ', '')}${line?.pnl ? ' USD' : ''}`;

        // Drives the middle-segment text colour. Orders carry no PnL -> neutral.
        const pnl = isEntry
            ? line.pnl
            : isOrder
              ? 0
              : Number(
                    String(line.label)
                        .replace('TP ', '')
                        .replace('SL ', '')
                        .replace('+$', '')
                        .replace('-$', '-'),
                );

        const amountText = String(line.qty);

        const amountTextWidth = ctx.measureText(amountText).width;
        const pnlTextWidth = ctx.measureText(pnlText).width;

        const amountWidth = pad + amountTextWidth + pad;
        const pnlWidth = pad + pnlTextWidth + pad;
        const closeWidth = pad + xWidth + pad;

        const pillW = amountWidth + pnlWidth + closeWidth;
        const pillX = w - pillW - rightOffset;
        const pillTop = pillY - pillH / 2;
        const pillBottom = pillY + pillH / 2;
        const pillEnd = pillX + pillW;

        // x-coordinates of segment boundaries
        const pnlX = pillX + amountWidth;
        const closeX = pnlX + pnlWidth;
        const xStart = closeX + pad;

        // Deliberately not done with alpha: a translucent pill lets the line
        // show through its own label, and washes out the axis tag.
        const accent = baseAccent;

        ctx.save();
        ctx.setLineDash([]);
        ctx.lineWidth = 1;

        // horizontal line across chart
        ctx.beginPath();
        ctx.lineCap = preview ? 'round' : 'butt';
        ctx.setLineDash(preview ? [1, 3] : (line.lineDash ?? []));
        ctx.strokeStyle = accent;
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineCap = 'butt';

        if(crosshair.y >= pillTop+5 && crosshair.y <= pillBottom-5){
            suspendCrosshair = true;
        }

        // pill background
        ctx.beginPath();
        roundRect(ctx, pillX, pillTop, pillW, pillH, 4, 4, 4);
        ctx.fillStyle = '#191919';
        ctx.fill();
        ctx.strokeStyle = accent;
        ctx.stroke();

        // amount segment (accent fill)
        if (isEntryLike) {
            ctx.beginPath();
            roundRect(ctx, pillX, pillTop, amountWidth, pillH, 4, 4, 0);
            ctx.fillStyle = accent;
            ctx.fill();
        } else if (line.kind === 'tp' || line.kind === 'sl') {
            ctx.beginPath();
            ctx.strokeStyle = accent;
            ctx.moveTo(pillX + amountWidth, pillY - pillH / 2);
            ctx.lineTo(pillX + amountWidth, pillY + pillH / 2);
            ctx.stroke();
        }

        ctx.fillStyle = isEntryLike ? '#ffffff' : line.kind === 'tp' ? green : red;
        ctx.fillText(amountText, pillX + pad, pillY + 1.5);

        // pnl text
        ctx.fillStyle = pnl > 0 ? green : pnl === 0 ? '#b2b2b2' : red;
        ctx.fillText(pnlText, pnlX + pad, pillY + 1);

        if (!line.locked) {
            // divider before close button
            ctx.beginPath();
            ctx.strokeStyle = accent;
            ctx.moveTo(closeX, pillBottom);
            ctx.lineTo(closeX, pillTop);
            ctx.stroke();

            const hoveringClose = crosshair ? crosshair.x >= closeX && crosshair.x <= pillEnd &&
                                              crosshair.y >= pillTop && crosshair.y <= pillBottom : false
            // close (x)
            if(hoveringClose) {
                suspendCrosshair = true;
                roundRect(ctx, closeX+1, pillTop+1, pillEnd - closeX-1, pillH-1, 0, 0, 4);
                ctx.fillStyle = "#ffffff15";
                ctx.fill();
            }
            ctx.beginPath();
            ctx.strokeStyle = accent;
            ctx.moveTo(xStart, pillY + xHeight / 2);
            ctx.lineTo(xStart + xWidth, pillY - xHeight / 2);
            ctx.moveTo(xStart, pillY - xHeight / 2);
            ctx.lineTo(xStart + xWidth, pillY + xHeight / 2);
            ctx.stroke();


            hitMap.lines.push({
                id: line.id,
                y: pillY,
                top: pillTop+5,
                bottom: pillBottom-5,
                pill: { x: pillX, y: pillY - pillH/2, w: pillW, h: pillH },
                closeBtn: { x: closeX, y: pillY - pillH / 2, w: (pillX + pillW) - closeX, h: pillH },
            });
        }

        // price axis pill

        ctx.beginPath();
        roundRect(ctx, w, y - pillH / 2, rightScaleWidth, pillH, 4);
        ctx.fillStyle = line.kind === 'tp' ? green : line.kind === 'sl' ? red : blue;
        ctx.fill();
        // ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.fillText(formatPrice(line.price, symbolInfo), w + 7, y);

        if (!line.locked) {
            hitMap.pricePills.push({
                id: line.id,
                x: w,
                y: y - pillH / 2,
                w: rightScaleWidth,
                h: pillH,
            });
        }

        // TP / SL ghost pills
        // The line has to say it wants them. Drawing them for anything that
        // isn't a bracket put them on rows that have nothing to protect - a
        // breakeven marker grew a TP and an SL handle that did nothing when
        // dragged, because there was no consumer on the other end. `ghosts` is
        // the flag that decides, and drawGhostDragVisualizer already reads it.
        if (line.ghosts && !line.locked && !preview) {
            const ghostW = 30;
            const tpX = pillX - ghostW * 2.7;
            const slX = pillX - ghostW * 1.5;

            // TP
            ctx.beginPath();
            ctx.setLineDash([2, 2]);
            roundRect(ctx, tpX, pillTop, ghostW, pillH, 4, 4, 4);
            ctx.fillStyle = '#191919';
            ctx.fill();
            ctx.strokeStyle = green;
            ctx.stroke();

            ctx.fillStyle = green;
            const tpWidth = ctx.measureText('TP').width;
            ctx.fillText('TP', tpX + ghostW / 2 - tpWidth / 2, pillY + 1);

            // SL
            ctx.beginPath();
            ctx.setLineDash([2, 2]);
            roundRect(ctx, slX, pillTop, ghostW, pillH, 4, 4, 4);
            ctx.fillStyle = '#191919';
            ctx.fill();
            ctx.strokeStyle = red;
            ctx.stroke();

            ctx.fillStyle = red;
            const slWidth = ctx.measureText('SL').width;
            ctx.fillText('SL', slX + ghostW / 2 - slWidth / 2, pillY + 1);

            hitMap.ghostPills.push({
                lineId: line.id,
                ghostId: 'tp_1',
                index: 1,
                kind: 'tp',
                x: tpX,
                y: pillTop,
                w: ghostW,
                h: pillH,
                currentPrice: line.price,
            });

            hitMap.ghostPills.push({
                lineId: line.id,
                ghostId: 'sl_1',
                index: 1,
                kind: 'sl',
                x: slX,
                y: pillTop,
                w: ghostW,
                h: pillH,
                currentPrice: line.price,
            });
        }

        ctx.restore();
    };

    for (const line of visible) {
        drawTradeLineV2(line);
    }

    return {hitMap, suspendCrosshair};
}

// Ghost interaction state
//
// Keyed by entry-line id.  Managed externally (in useTradeLines / chart state).
// `tpPrices[i]` / `slPrices[i]` hold the current price for each ghost slot.
// When null/undefined the ghost pill is unset (user hasn't dragged it yet).

export interface GhostSlotState {
    /**
     * Prices for each TP ghost slot.
     * Index matches the slot shown in the ghost pill row (tp_0, tp_1, …).
     * undefined = user hasn't dragged this slot yet.
     */
    tpPrices: (number | undefined)[];
    /**
     * Prices for each SL ghost slot.
     */
    slPrices: (number | undefined)[];
    /** e.g. "tp_0", "sl_1" - which ghost pill is currently hovered */
    hoveredGhost?: string | null;
    /** e.g. "tp_0", "sl_1" - which ghost pill is currently being dragged */
    draggingGhost?: string | null;
    draggingGhostIdx?: number | null;
    draggingGhostType?: 'tp' | 'sl' | null;
    // NOTE: the old scalar `tpPrice` / `slPrice` aliases are removed.
    // All band and reference-line drawing now uses tpPrices[i] / slPrices[i].
}

/** Map from entry-line id -> ghost state */
export type GhostInteractionState = Record<string, GhostSlotState>;

// Hit-test map
export interface TradeLineHitRegion {
    id: string;
    /** Pixel Y of the actual price line */
    y: number;
    top: number;
    bottom: number;
    pill?: { x: number; y: number; w: number; h: number };
    closeBtn?: { x: number; y: number; w: number; h: number };
    reverseBtn?: { x: number; y: number; w: number; h: number };
}

export interface GhostPillHitRegion {
    lineId: string;
    /** e.g. "tp_0", "sl_2" */
    ghostId: string;
    index: number;
    kind: 'tp' | 'sl';
    x: number;
    y: number;
    w: number;
    h: number;
    currentPrice?: number;
}

export interface TradeLineHitMap {
    lines: TradeLineHitRegion[];
    pricePills: { id: string | undefined; x: number; y: number; w: number; h: number }[];
    /** Hit regions for ghost TP/SL mini-pills */
    ghostPills: GhostPillHitRegion[];
}

/**
 * Given a mouse position, return which line (and which part of it) was hit.
 * Call this from chart.tsx on mousemove / click instead of manual hit-testing.
 */
export function hitTestTradeLines(
    mx: number,
    my: number,
    hitMap: TradeLineHitMap,
): {
    lineId: string | null;
    part: 'line' | 'pill' | 'close' | 'reverse' | 'pricePill' | null;
    ghostHit?: GhostPillHitRegion;
} {
    // Ghost pills (highest priority - they sit on top of everything)
    for (const gp of hitMap.ghostPills) {
        if (mx >= gp.x && mx <= gp.x + gp.w && my >= gp.y && my <= gp.y + gp.h) {
            return { lineId: gp.lineId, part: null, ghostHit: gp };
        }
    }

    // Check interactive buttons first (smallest targets -> highest priority)
    for (const region of hitMap.lines) {
        if (region.closeBtn) {
            const b = region.closeBtn;
            if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) {
                return { lineId: region.id, part: 'close' };
            }
        }
        if (region.reverseBtn) {
            const b = region.reverseBtn;
            if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) {
                return { lineId: region.id, part: 'reverse' };
            }
        }
    }
    // Pill body
    for (const region of hitMap.lines) {
        if (region.pill) {
            const b = region.pill;
            if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) {
                return { lineId: region.id, part: 'pill' };
            }
        }
    }
    // Price pill (axis)
    for (const p of hitMap.pricePills) {
        if (mx >= p.x && mx <= p.x + p.w && my >= p.y && my <= p.y + p.h) {
            return { lineId: p.id ?? null, part: 'pricePill' };
        }
    }
    // Line body
    for (const region of hitMap.lines) {
        if (my >= region.top && my <= region.bottom) {
            return { lineId: region.id, part: 'line' };
        }
    }
    return { lineId: null, part: null };
}

// Utility
function hexToRgba(hex: string, alpha: number): string {
    if (hex.startsWith('rgba')) {
        return hex.replace(/[\d.]+\)$/, `${alpha})`);
    }
    if (hex.startsWith('rgb(')) {
        return hex.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`);
    }
    let h = hex.replace('#', '');
    if (h.length === 3)
        h = h
            .split('')
            .map((c) => c + c)
            .join('');
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}
