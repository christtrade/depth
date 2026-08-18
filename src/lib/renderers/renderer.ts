import { ChartPane, Indicator, Rect, RenderContext } from '../types/indicator-types';
import { BookSnapshot, PriceHistory, TradePoint } from '../types';
import { MIN_DOT_RADIUS, MAX_DOT_RADIUS } from '../constants';
import type { ChartType, TradeLine, ViewBounds } from '../types';

import type { FootprintBar } from '../types/footprint';
import { ChartSettings } from '../types/chart-settings';
import { drawFootprintChart } from './drawFootprintChart';
import { drawTradeLines } from './drawTradeLines';
import { ActiveDrawingTool, DraftDrawing, Drawing, DrawingAnchorId } from '../types/drawing-types';
import { AccountSnapshot, DataLevel, LiveTransformer, OhlcvBar, SymbolInfo } from '../../core';
import { DateTime } from 'luxon';
import { SessionMapper } from '../../core/SessionMapper';
import { snapTsToBarGrid } from '../bar-grid';
import { getEffectiveDpr, snapToDevicePx } from '../dpr';
import { formatPrice, resolveTickSize } from '../priceFormat';
import { PriceTransition } from '../priceTransition';
import {
    PricePoint,
    OrdinalModel,
    OrdinalKind,
    autoThreshold,
    buildOrdinalModel,
} from '../series/japaneseCharts';
import type { CrosshairSync } from '../types/layout-sync';

const LABEL_H = 20;

type Candle = {
    ts: bigint;
    open: number;
    high: number;
    low: number;
    close: number;
    hasTrades: boolean;
};

export type CandleCache = Map<bigint, { open: number; high: number; low: number; close: number }>;

export type Crosshair = { x: number; y: number } | null;

export const Y_AXIS_WIDTH = 65;
export const X_AXIS_HEIGHT = 30;

export const TRADE_SNAP_RADIUS = 12;

export const COLORS = {
    background: '#16181d', //0c0d11
    buyLine: '#00e676',
    sellLine: '#ff1744',
    grid: '#282a2e',
    label: '#888888',
    axisBg: '#16181d',
    crosshair: '#aaaaaa',
    crosshairBg: '#23272f',
    crosshairText: '#FFFFFF',
};

/** Font used for the price-axis tick labels. */
const PRICE_AXIS_FONT = '11px "Inter"';

/** Left gap (label is drawn at axisX + 6) + right margin so text never touches the edge. */
const PRICE_AXIS_LABEL_PAD = 6 + 8;
/** Floor so a near-empty axis still has a sensible width. */
const MIN_RIGHT_SCALE_WIDTH = 50;

/**
 * Width (css px) the right price axis needs to fit its widest label without
 * clipping. Derived from the symbol's price precision and the visible price
 * range (pMin/pMax) - the extremes carry the most integer digits and the
 * minus sign, so they bound every intermediate tick label. Returns 0 when the
 * scale is hidden. Pass a 2d context to measure exactly; without one a generous
 * per-glyph estimate is used (only relevant before the first paint).
 */
// widest digit glyph per font. a constant, but only knowable by measuring.
const _widestDigitByFont = new Map<string, string>();

export function computeRightScaleWidth(
    bounds: ViewBounds,
    symbolInfo: SymbolInfo | undefined,
    chartSettings: ChartSettings,
    hidePriceScale?: boolean,
    ctx?: CanvasRenderingContext2D | null,
): number {
    if (hidePriceScale) return 0;

    const precision = symbolInfo?.priceFormat?.precision ?? 2;
    const isPercent = chartSettings.priceScaleMode === 'percent' && !!bounds.pRef;
    const fmt = (p: number) =>
        isPercent
            ? `${(((p - bounds.pRef!) / bounds.pRef!) * 100).toFixed(precision)}%`
            : p.toFixed(precision);

    const labels = [fmt(bounds.pMin), fmt(bounds.pMax)];

    let textW: number;
    if (ctx) {
        const prevFont = ctx.font;
        ctx.font = PRICE_AXIS_FONT;

        // Inter renders proportional figures - '1' is narrower than '8' - so
        // measuring the literal labels makes the axis twitch wider and narrower
        // as digits change during a scroll, even when the digit count is the
        // same. normalise every digit to the widest one before measuring, so the
        // width only moves when the label actually gains/loses a character
        // (magnitude, precision or sign change).
        // memoised per font - this runs on every pointer move and the widest
        // glyph in a font never changes
        let widestDigit = _widestDigitByFont.get(PRICE_AXIS_FONT);
        if (widestDigit === undefined) {
            widestDigit = '0';
            let widestDigitW = 0;
            for (let d = 0; d <= 9; d++) {
                const dw = ctx.measureText(String(d)).width;
                if (dw > widestDigitW) {
                    widestDigitW = dw;
                    widestDigit = String(d);
                }
            }
            _widestDigitByFont.set(PRICE_AXIS_FONT, widestDigit);
        }

        textW = Math.max(
            ...labels.map((l) => ctx.measureText(l.replace(/[0-9]/g, widestDigit)).width),
        );
        ctx.font = prevFont;
    } else {
        // ~6.4px per glyph at 11px Inter, generous on purpose so nothing clips
        textW = Math.max(...labels.map((l) => l.length)) * 6.4;
    }

    return Math.max(MIN_RIGHT_SCALE_WIDTH, Math.ceil(textW + PRICE_AXIS_LABEL_PAD));
}

/**
 * Pixel-snapping for crisp candles at any device-pixel ratio.
 *
 * The canvas is scaled by `dpr` (ctx.setTransform(dpr,0,0,dpr,0,0)), so a CSS
 * coordinate `c` lands on device pixel `c * dpr`. A *filled* edge looks sharp
 * only when it falls on a whole device pixel; a *stroked* centerline looks sharp
 * only when an odd-width line is centered on a half device pixel (and an
 * even-width line on a whole one). Snapping in CSS space (floor(x)+0.5) only
 * happens to be correct at dpr === 1, and even there only for odd body widths -
 * which is why bodies blur at some zooms and on scaled displays. These helpers
 * snap in device space and convert the result back to CSS coordinates.
 */
function snapEdge(cssCoord: number, dpr: number): number {
    return Math.round(cssCoord * dpr) / dpr;
}

/**
 * Snap a stroke centerline so a `lineWidthCss`-wide line covers whole device
 * pixels. Returns the snapped CSS coordinate; pair it with a line width of
 * `deviceLineWidth(lineWidthCss, dpr)` so the on-screen width is an exact pixel
 * count.
 */
function snapStroke(cssCoord: number, lineWidthCss: number, dpr: number): number {
    const wDev = Math.max(1, Math.round(lineWidthCss * dpr));
    const cDev = cssCoord * dpr;
    const snapped = wDev % 2 === 1 ? Math.round(cDev - 0.5) + 0.5 : Math.round(cDev);
    return snapped / dpr;
}

/** CSS line width whose device width is an exact (>=1) whole-pixel count. */
function deviceLineWidth(lineWidthCss: number, dpr: number): number {
    return Math.max(1, Math.round(lineWidthCss * dpr)) / dpr;
}

function buildCandles(trades: TradePoint[], barNs: bigint): Candle[] {
    if (barNs === 0n) return [];
    const map = new Map<bigint, Candle>();

    for (const t of trades) {
        const barTs = (t.ts / barNs) * barNs;
        const c = map.get(barTs);
        if (!c) {
            map.set(barTs, {
                ts: barTs,
                open: t.price,
                high: t.price,
                low: t.price,
                close: t.price,
                hasTrades: true,
            });
        } else {
            if (t.price > c.high) c.high = t.price;
            if (t.price < c.low) c.low = t.price;
            c.close = t.price;
        }
    }

    return Array.from(map.values()).sort((a, b) => (a.ts < b.ts ? -1 : 1));
}

export function drawBaseLayer(
    canvas: HTMLCanvasElement,
    panes: ChartPane[],
    layouts: Record<string, Rect>,
    indicators: Indicator[],
    trades: TradePoint[],
    priceHistory: PriceHistory[],
    snapshots: BookSnapshot[],
    bounds: ViewBounds,
    footprintBars: FootprintBar[] = [],
    heatmapBitmap: ImageBitmap | null,
    bitmapOffsetX: number = 0,
    bitmapOffsetY: number = 0,
    bitmapOffsetW: number = 0,
    bitmapOffsetH: number = 0,
    barNs: bigint = 0n,
    chartSettings: ChartSettings,
    horizon: bigint = 0n,
    candleCache: CandleCache | null = null,
    /** Live incrementally-built open bar - overrides the cache for the current bucket. */
    openBar: { ts: bigint; open: number; high: number; low: number; close: number } | null = null,
    ohlcvBars: {
        time: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
    }[],
    transformer: LiveTransformer,
    isPluginChartType = false,
    sessionMapper?: SessionMapper,
    dataLevel?: DataLevel,
    hidePriceScale?: boolean,
    hideTimeScale?: boolean,
    symbolInfo?: SymbolInfo,
    rightScaleWidth?: number,
) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    transformer.setBarNs(barNs);

    const dpr = getEffectiveDpr();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cssW = canvas.width / dpr;
    const cssH = canvas.height / dpr;

    // no getBoundingClientRect here - nothing read it, and it forced a sync
    // layout on every base paint, so on every pan frame, per chart

    // the time axis owns this band - every layout and hit-test site keys it off
    // hideTimeScale, so keying it off hidePriceScale here put the renderer's idea
    // of the chart area out of step with everyone else's
    const xAxisHeight = hideTimeScale ? 0 : X_AXIS_HEIGHT;

    drawBackground(ctx, cssW, cssH, chartSettings);

    const rsWidth =
        rightScaleWidth ??
        computeRightScaleWidth(bounds, symbolInfo, chartSettings, hidePriceScale, ctx);
    const chartW = cssW - rsWidth;


    panes.forEach((pane) => {
        const rect = layouts[pane.id];
        if (!rect || rect.h < 2) return;
        const isMain = pane.isMain;
        const yMin = isMain ? bounds.pMin : pane.yMin;
        const yMax = isMain ? bounds.pMax : pane.yMax;

        ctx.save();
        ctx.beginPath();
        ctx.rect(rect.x, rect.y, rect.w, rect.h);
        ctx.clip();
        ctx.translate(rect.x, rect.y);

        const _transformer = new LiveTransformer();
        _transformer.update({ ...bounds, pMax: yMax, pMin: yMin });
        if (sessionMapper) _transformer.setSessionMapper(sessionMapper);

        const renderCtx: RenderContext = {
            ctx,
            rect: { ...rect, x: 0, y: 0 },
            tMin: bounds.tMin,
            tMax: bounds.tMax,
            yMin,
            yMax,
            barNs,
            horizon,
            transformer: _transformer,
        };

        if (isMain) {
            // Grid uses main price bounds
            drawPaneGrid(
                ctx,
                bounds,
                yMin,
                yMax,
                chartW,
                rect.h,
                barNs,
                chartSettings,
                transformer,
                transformer.getScaleMode() === 'log',
                symbolInfo
            );

            ctx.save();
            try {
                ctx.beginPath();
                ctx.rect(0, 0, chartW, rect.h);
                ctx.clip();

                if (chartSettings.showHeatmap && heatmapBitmap) {
                    ctx.drawImage(
                        heatmapBitmap,
                        Math.round(bitmapOffsetX),
                        Math.round(bitmapOffsetY),
                        Math.round(bitmapOffsetW),
                        Math.round(bitmapOffsetH),
                    );
                }
                if (!isPluginChartType)
                    drawPriceChart(
                        ctx,
                        trades,
                        priceHistory,
                        bounds,
                        chartW,
                        rect.h,
                        chartSettings.chartType,
                        barNs,
                        chartSettings.showBidLine,
                        chartSettings.showAskLine,
                        chartSettings.showMidLine,
                        chartSettings.showLastTradeLine,
                        footprintBars,
                        chartSettings,
                        horizon,
                        candleCache,
                        openBar,
                        ohlcvBars,
                        transformer,
                        dataLevel,
                        symbolInfo,
                    );

                if (chartSettings.showTradeDots)
                    drawTrades(
                        ctx,
                        trades,
                        bounds,
                        chartW,
                        rect.h,
                        barNs,
                        chartSettings,
                        horizon,
                        transformer,
                    );
            } finally {
                ctx.restore();
            }
        } else {
            // Sub-pane: dark background + time-aligned vertical grid lines
            ctx.fillStyle = COLORS.background;
            ctx.fillRect(0, 0, chartW, rect.h);
            drawPaneGrid(
                ctx,
                bounds,
                yMin,
                yMax,
                chartW,
                rect.h,
                barNs,
                chartSettings,
                transformer,
                transformer.getScaleMode() === 'log',
                symbolInfo
            );
        }

        // Overlay + pane indicators
        indicators
            .filter(
                (ind) =>
                    ind.visible && (ind.paneId === pane.id || (ind.layout === 'overlay' && isMain)),
            )
            .forEach((ind) => {
                try {
                    ctx.save();

                    if (ind.drawBase) ind.drawBase(renderCtx);
                    ctx.restore();
                } catch (e) {
                    console.error(e);
                }
            });

        ctx.restore();
    });

    if (chartSettings.showBreaks)
        drawBreaks(ctx, bounds, chartW, cssH - xAxisHeight, chartSettings, transformer, barNs);

    // background only - drawUILayer draws every label, so the labels and the grid
    // lines always come off the same bounds snapshot
    drawAxesBackgrounds(ctx, cssW, cssH, chartW, cssH - xAxisHeight, chartSettings);
    drawPaneYAxisLabels(ctx, canvas, panes, layouts, bounds, chartW);
    drawPaneDividers(ctx, panes, layouts, chartW);
}

export function drawUILayer(
    canvas: HTMLCanvasElement,
    priceHistory: PriceHistory[],
    trades: TradePoint[],
    bounds: ViewBounds,
    crosshair: Crosshair,
    showTooltip: boolean,
    selectedTrade: TradePoint | null,
    panes: ChartPane[] = [],
    layouts: Record<string, Rect> = {},
    indicators: Indicator[] = [],
    hoveredDividerIdx: number = -1,
    hoveringLegend: boolean = false,
    barNs: bigint = 0n,
    chartSettings: ChartSettings,
    horizon: bigint = 0n,
    candleCache: CandleCache | null = null,
    ohlcvBars: {
        time: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
    }[],
    openBar: OhlcvBar,
    tradeLines: TradeLine[],
    tradeLineInteraction: any,
    hoveredLineId?: string | null,
    draggingLineId?: string | null,
    activeTool?: ActiveDrawingTool | null,
    draggingAnchor?: { drawingId: string; anchor: DrawingAnchorId } | null,
    holdingCtrl?: boolean | null,
    holdingShift?: boolean | null,
    footprintBars?: FootprintBar[] | null,
    drawings?: Drawing[] | null,
    draft?: DraftDrawing | null,
    transformer?: LiveTransformer,
    showShiftInfo?: boolean,
    shiftInfoAnchor?: { ts: bigint; price: number; x: number; y: number },
    shiftInfoAnchor2?: { ts: bigint; price: number; x: number; y: number } | null,
    dataLevel?: DataLevel,
    accountSnapshot?: AccountSnapshot,
    symbolInfo?: SymbolInfo,
    hidePriceScale?: boolean,
    hideTimeScale?: boolean,
    rightScaleWidth?: number,
    priceTransition?: PriceTransition,
    syncCrosshair?: CrosshairSync | null,
) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // drop in-flight price tweens on a symbol change, no cross-symbol glide
    priceTransition?.setSymbol(symbolInfo?.symbol);
    const now = performance.now();

    if (transformer) transformer.setBarNs(barNs);

    const dpr = getEffectiveDpr();

    // the time axis owns this band - every layout and hit-test site keys it off
    // hideTimeScale, so keying it off hidePriceScale here put the renderer's idea
    // of the chart area out of step with everyone else's
    const xAxisHeight = hideTimeScale ? 0 : X_AXIS_HEIGHT;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cssW = canvas.width / dpr;
    const cssH = canvas.height / dpr;

    const rsWidth =
        rightScaleWidth ??
        computeRightScaleWidth(bounds, symbolInfo, chartSettings, hidePriceScale, ctx);
    const chartW = cssW - rsWidth;
    const chartH = cssH - xAxisHeight;

    ctx.clearRect(0, 0, cssW, cssH);
    drawAxesBackgrounds(ctx, cssW, cssH, chartW, chartH, chartSettings);

    const mainRect = layouts['main'] || { x: 0, y: 0, w: chartW, h: chartH };
    const mainPaneH = mainRect.h;
    const mainPaneY = mainRect.y;

    if (mainPaneH >= 2) {
        drawDynamicLabels(
            ctx,
            canvas,
            bounds,
            chartW,
            chartH,
            chartSettings,
            mainPaneH,
            barNs,
            [],
            mainPaneY,
            transformer,
            dataLevel,
            hidePriceScale,
            hideTimeScale,
            symbolInfo,
        );

        if (!hidePriceScale) {
            drawPriceLabel(
                ctx,
                canvas,
                priceHistory,
                trades,
                bounds,
                chartW,
                mainPaneH,
                chartSettings,
                barNs,
                horizon,
                candleCache,
                ohlcvBars,
                openBar,
                mainPaneY,
                transformer,
                dataLevel,
                symbolInfo,
                rsWidth,
                priceTransition,
                now,
            );
        }
    }

    !hidePriceScale && drawPaneYAxisLabels(ctx, canvas, panes, layouts, bounds, chartW);

    if (chartSettings.showFills) {
        drawTradeArrows(
            ctx,
            canvas,
            bounds,
            chartW,
            chartH,
            chartSettings,
            mainPaneH,
            mainPaneY,
            barNs,
            horizon,
            crosshair,
            transformer,
            accountSnapshot,
            ohlcvBars,
            openBar,
            symbolInfo.symbol
        );
    }

    const {hitMap, suspendCrosshair} = drawTradeLines(
        ctx,
        canvas,
        bounds,
        chartW,
        chartH,
        chartSettings,
        tradeLines,
        mainPaneH,
        mainPaneY,
        hoveredLineId,
        draggingLineId, // <- pass through
        tradeLineInteraction,
        resolveTickSize(symbolInfo),
        transformer,
        rsWidth,
        symbolInfo,
        crosshair ?? {x: 0, y: 0}
    );

    // 3. crosshair. the pointer is either over this chart, or over another cell
    // of a synced layout - in which case the mirrored position gets projected
    // onto this chart's own axes here, never precomputed by the sender, so
    // panning this cell keeps it on the right bar.
    const ownsPointer =
        !!crosshair &&
        crosshair.x < chartW &&
        crosshair.y < chartH &&
        hoveredDividerIdx === -1 &&
        !hoveringLegend;

    // our own pointer wins over a mirrored one even when its parked on the price
    // scale or the legend - two crosshairs at once makes no sense
    const mirrored =
        !crosshair && syncCrosshair
            ? projectSyncCrosshair(syncCrosshair, panes, layouts, chartW, transformer, symbolInfo)
            : null;

    const paintedCrosshair = ownsPointer ? crosshair : mirrored?.point;

    if (paintedCrosshair && hoveredDividerIdx === -1 && !suspendCrosshair) {
        drawCrosshair(
            ctx,
            canvas,
            bounds,
            paintedCrosshair,
            chartW,
            chartH,
            panes,
            layouts,
            barNs,
            horizon,
            chartSettings,
            activeTool,
            draggingAnchor,
            holdingCtrl,
            holdingShift,
            barNs,
            footprintBars,
            priceHistory,
            ohlcvBars,
            drawings,
            draft,
            transformer,
            dataLevel,
            hidePriceScale,
            hideTimeScale,
            xAxisHeight,
            symbolInfo,
            rsWidth,
            !ownsPointer,
            !ownsPointer && !mirrored?.full,
        );
    }

    // 3b. Divider hover highlight (replaces crosshair when over a divider)
    if (hoveredDividerIdx !== -1) {
        drawDividerHighlight(ctx, panes, layouts, canvas.width, hoveredDividerIdx);
    }

    // 4. Draw Tooltips
    if (crosshair && showTooltip) {
        drawTooltip(ctx, crosshair, priceHistory, bounds, chartW, chartH, transformer, symbolInfo);
    }

    // Indicator UI hooks
    if (crosshair && panes.length > 0) {
        panes.forEach((pane) => {
            const rect = layouts[pane.id];
            if (!rect || rect.h < 2) return;
            const renderCtx: RenderContext = {
                ctx,
                rect,
                tMin: bounds.tMin,
                tMax: bounds.tMax,
                yMin: pane.isMain ? bounds.pMin : pane.yMin,
                yMax: pane.isMain ? bounds.pMax : pane.yMax,
                barNs,
                horizon,
                transformer,
            };
            indicators
                .filter(
                    (ind) =>
                        ind.visible &&
                        (ind.paneId === pane.id || (ind.layout === 'overlay' && pane.isMain)),
                )
                .forEach((ind) => {
                    if (ind.drawUI) ind.drawUI(renderCtx, crosshair);
                });
        });
    }

    if (showShiftInfo) {
        try {
            drawShiftInfo(
                ctx,
                canvas,
                panes,
                layouts,
                bounds,
                barNs,
                chartW,
                chartH,
                transformer,
                shiftInfoAnchor,
                shiftInfoAnchor2,
                crosshair,
                symbolInfo,
            );
        } catch {}
    }

    if (selectedTrade) {
        drawTradeSelectionRing(
            ctx,
            selectedTrade,
            bounds,
            chartW,
            mainPaneH,
            chartSettings,
            transformer,
        );
        drawTradeDetail(
            ctx,
            selectedTrade,
            bounds,
            chartW,
            mainPaneH,
            chartSettings,
            transformer,
            symbolInfo,
        );
    }

    return hitMap;
}

const drawShiftInfo = (
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    panes: ChartPane[],
    layouts: Record<string, Rect>,
    bounds: ViewBounds,
    barNs: bigint,
    chartW: number,
    chartH: number,
    transformer: LiveTransformer,
    shiftInfoAnchor: { ts: bigint; price: number; x: number; y: number },
    shiftInfoAnchor2: { ts: bigint; price: number; x: number; y: number } | null,
    crosshair: Crosshair,
    symbolInfo: SymbolInfo,
) => {
    function roundToNearest(value: bigint, step: bigint): bigint {
        const q = value / step;
        const r = value % step;
        return r * 2n >= step ? (q + 1n) * step : q * step;
    }

    const x1 = Math.min(
        transformer.tsToX(roundToNearest(shiftInfoAnchor.ts, barNs), chartW),
        chartW,
    );
    const y1 = Math.min(transformer.priceToY(shiftInfoAnchor.price, chartH), chartH);
    const x2 = Math.min(
        shiftInfoAnchor2
            ? transformer.tsToX(roundToNearest(shiftInfoAnchor2.ts, barNs), chartW)
            : transformer.tsToX(
                  roundToNearest(transformer.xToTs(crosshair.x, chartW), barNs),
                  chartW,
              ),
        chartW,
    );
    const y2 = Math.min(
        shiftInfoAnchor2 ? transformer.priceToY(shiftInfoAnchor2.price, chartH) : crosshair.y,
        chartH,
    );

    const left = Math.min(x1, x2);
    const right = Math.max(x1, x2);
    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;
    const isUp =
        Math.min(y1, y2) < 45
            ? false
            : Math.max(y1, y2) > chartH - 45
              ? true
              : y2 < y1
                ? true
                : false;
    const isRight = x2 > x1 ? true : false;

    ctx.fillStyle = '#3b58971D';
    ctx.fillRect(left, Math.min(y1, y2), right - left, Math.abs(y2 - y1));

    ctx.strokeStyle = '#3b5897';
    ctx.setLineDash([]);

    // y line
    ctx.beginPath();
    ctx.moveTo(midX, y1);
    ctx.lineTo(midX, y2);
    // y arrow
    if (Math.abs(y2 - y1) > 6) {
        ctx.lineTo(midX - 5, y2 - (y2 < y1 ? -5 : 5));
        ctx.moveTo(midX, y2);
        ctx.lineTo(midX + 5, y2 - (y2 < y1 ? -5 : 5));
    }
    ctx.stroke();

    // x line
    ctx.beginPath();
    ctx.moveTo(x1, midY);
    ctx.lineTo(x2, midY);
    // x arrow
    if (Math.abs(x2 - x1) > 6) {
        ctx.lineTo(x2 + (isRight ? -5 : 5), midY - 5);
        ctx.moveTo(x2, midY);
        ctx.lineTo(x2 + (isRight ? -5 : 5), midY + 5);
    }
    ctx.stroke();

    const bars = Math.abs(
        Math.round(
            Math.max(
                Number(
                    (roundToNearest(shiftInfoAnchor.ts, barNs) -
                        (shiftInfoAnchor2
                            ? roundToNearest(shiftInfoAnchor2.ts, barNs)
                            : roundToNearest(
                                  transformer.xToTs(Math.min(crosshair.x, chartW), chartW),
                                  barNs,
                              ))) /
                        barNs,
                ),
            ),
        ),
    );
    let timeframe = 'ms';
    let timeframeNs = 1_000_000n;
    if (barNs >= 1_000_000_000) {
        timeframe = 'second';
        timeframeNs = 1_000_000_000n;
    }
    if (barNs >= 60 * 1_000_000_000) {
        timeframe = 'minute';
        timeframeNs = 60n * 1_000_000_000n;
    }
    if (barNs >= 60 * 60 * 1_000_000_000) {
        timeframe = 'hour';
        timeframeNs = 60n * 60n * 1_000_000_000n;
    }

    const TICK = symbolInfo?.priceFormat?.minTick ?? 0.01;

    const priceDifference = formatPrice(
        Math.round(
            ((shiftInfoAnchor2
                ? shiftInfoAnchor2.price
                : transformer.yToPrice(Math.min(crosshair.y, chartH), chartH)) -
                shiftInfoAnchor.price) /
                TICK,
        ) * TICK,
        symbolInfo,
    );
    const percentage = (
        ((shiftInfoAnchor2
            ? shiftInfoAnchor2.price
            : transformer.yToPrice(Math.min(crosshair.y, chartH), chartH)) /
            shiftInfoAnchor.price -
            1) *
        100
    ).toFixed(2);
    const textTop = `${priceDifference} ${percentage}% ${Math.round(Math.abs(Number(priceDifference)) / TICK)}t`;

    const time = bars * Number(barNs / timeframeNs);
    const textBottom = `${bars} ${bars === 1 ? 'bar' : 'bars'}, ${time} ${time === 1 ? timeframe : timeframe + 's'}`;

    const width = Math.max(ctx.measureText(textBottom).width, ctx.measureText(textTop).width);
    const height = 40;
    const my = 5;
    const px = 20;
    const round = 7;

    ctx.fillStyle = '#3b5897';
    roundRect(
        ctx,
        midX - width / 2 - px / 2,
        isUp ? Math.min(y1, y2) - height - my : Math.max(y1, y2) + my,
        width + px,
        height,
        round,
    );
    ctx.fill();

    ctx.fillStyle = '#FFFFFF';

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.fillText(
        textTop,
        midX,
        isUp
            ? Math.min(y1, y2) - height / 2 - height / 5 - my
            : Math.max(y1, y2) + height / 2 - height / 5 + my,
    );
    ctx.fillText(
        textBottom,
        midX,
        isUp
            ? Math.min(y1, y2) - height / 2 + height / 5 - my
            : Math.max(y1, y2) + height / 2 + height / 5 + my,
    );
};

export function applyHeatmapContrast(
    src: ImageBitmap,
    chartW: number,
    chartH: number,
    threshold: number, // 0..1
): ImageData {
    const scratch = new OffscreenCanvas(chartW, chartH);
    const ctx = scratch.getContext('2d') as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(src, 0, 0);
    const imageData = ctx.getImageData(0, 0, chartW, chartH);
    const data = imageData.data;

    const cutoff = (threshold * 210 + 0.5) | 0; // raw alpha below this -> invisible
    const scale = cutoff >= 210 ? 0 : 210 / (210 - cutoff); // rescale remainder to 0-210

    for (let i = 3; i < data.length; i += 4) {
        const a = data[i];
        if (a === 0) continue;
        if (a <= cutoff) {
            data[i] = 0;
        } else {
            data[i] = Math.min(210, ((a - cutoff) * scale + 0.5) | 0);
        }
    }
    return imageData;
}

export function drawHeatmap(
    ctx: CanvasRenderingContext2D,
    snapshots: BookSnapshot[],
    bounds: ViewBounds,
    chartW: number,
    chartH: number,
    contrastThreshold: number = 0, // 0 = show everything, 1 = show nothing
): void {
    // the snapshots overlapping the visible window. both searches return -1 when
    // the bound falls outside the data, so clamp. always include the last
    // snapshot and paint it forward to the right edge.
    let first = binarySearchFloor(snapshots, bounds.tMin);
    let last = binarySearchCeil(snapshots, bounds.tMax);
    if (first === -1) first = 0;
    if (last === -1) last = snapshots.length - 1;

    // One snapshot of padding on each side avoids hard clipping at the edges
    first = Math.max(0, first - 1);
    last = Math.min(snapshots.length - 1, last + 1);

    if (first > last) return;

    const tRange = Number(bounds.tMax - bounds.tMin);
    const pRange = bounds.pMax - bounds.pMin;
    if (tRange === 0 || pRange === 0) return;

    // zoomed out, many snapshots land on the same pixel column. bucket them by
    // column first and merge with Math.max, which keeps the brightest level per
    // column and caps the work at chartW x priceLevels whatever the zoom.
    const snapshotCount = last - first + 1;
    const needsDownsample = snapshotCount > chartW;

    // buckets[col] = merged {bids, asks} for that pixel column
    type Bucket = { bids: Map<number, number>; asks: Map<number, number> };
    let columns: Array<{
        xStart: number;
        xEnd: number;
        bids: Map<number, number>;
        asks: Map<number, number>;
    }>;

    if (needsDownsample) {
        const buckets = new Array<Bucket | null>(chartW).fill(null);

        for (let i = first; i <= last; i++) {
            const snap = snapshots[i];
            const col = Math.min(
                chartW - 1,
                Math.max(0, Math.round((Number(snap.ts - bounds.tMin) / tRange) * chartW)),
            );

            if (!buckets[col]) {
                buckets[col] = { bids: new Map(), asks: new Map() };
            }
            const b = buckets[col]!;
            // Merge: take max size per price level so walls stay visible
            for (const [price, size] of snap.bids) {
                const cur = b.bids.get(price);
                if (cur === undefined || size > cur) b.bids.set(price, size);
            }
            for (const [price, size] of snap.asks) {
                const cur = b.asks.get(price);
                if (cur === undefined || size > cur) b.asks.set(price, size);
            }
        }

        // Forward-fill empty columns from the previous bucket so there are no gaps
        let lastBucket: Bucket | null = null;
        columns = [];
        for (let col = 0; col < chartW; col++) {
            const bucket = buckets[col] ?? lastBucket;
            if (bucket) {
                lastBucket = bucket;
                columns.push({ xStart: col, xEnd: col, ...bucket });
            }
        }
    } else {
        // Zoomed in: compute all xStarts first, then set xEnd = next xStart - 1
        // so columns are guaranteed pixel-contiguous with no rounding gaps.
        const rawColumns: {
            xStart: number;
            bids: Map<number, number>;
            asks: Map<number, number>;
        }[] = [];
        for (let i = first; i <= last; i++) {
            const snap = snapshots[i];
            const xStart = Math.round((Number(snap.ts - bounds.tMin) / tRange) * chartW);
            if (xStart >= chartW) continue;
            rawColumns.push({ xStart, bids: snap.bids, asks: snap.asks });
        }

        columns = [];
        for (let i = 0; i < rawColumns.length; i++) {
            const { xStart, bids, asks } = rawColumns[i];
            // xEnd is exactly where the next column starts minus 1 - no gaps, no overlap
            const xEnd = i === rawColumns.length - 1 ? chartW - 1 : rawColumns[i + 1].xStart - 1;
            if (xEnd < 0 || xStart >= chartW) continue;
            columns.push({ xStart: Math.max(0, xStart), xEnd, bids, asks });
        }
    }

    // the global max size across every column about to be painted
    let maxSize = 1;
    for (const col of columns) {
        for (const size of col.bids.values()) if (size > maxSize) maxSize = size;
        for (const size of col.asks.values()) if (size > maxSize) maxSize = size;
    }
    const logMax = Math.log1p(maxSize);

    // Pixel writes
    const imageData = ctx.createImageData(chartW, chartH);
    const data = imageData.data;

    for (const col of columns) {
        const { xStart, xEnd, bids, asks } = col;
        const x0 = Math.max(0, xStart);
        const x1 = Math.min(chartW - 1, xEnd);
        if (x0 > x1) continue;

        // sort bids high->low and asks low->high so entries adjacent in the array
        // are adjacent on screen, then fill each level from its own pixel row
        // down to (not including) the next level's row, which leaves no gaps
        const paintSide = (entries: [number, number][], isBid: boolean) => {
            // Sort so prices are in screen order: bids high->low (y increases downward),
            // asks low->high (same direction on screen).
            entries.sort((a, b) => (isBid ? b[0] - a[0] : a[0] - b[0]));

            for (let i = 0; i < entries.length; i++) {
                const [price, size] = entries[i];

                const raw = Math.log1p(size) / logMax;
                if (raw < contrastThreshold) continue;
                const intensity =
                    contrastThreshold >= 1
                        ? 1
                        : (raw - contrastThreshold) / (1 - contrastThreshold);

                const alpha = Math.floor(intensity * 210);
                let r: number, g: number, b: number;
                if (isBid) {
                    r = Math.floor(intensity * 20);
                    g = Math.floor(60 + intensity * 160);
                    b = Math.floor(intensity * 80);
                } else {
                    r = Math.floor(160 + intensity * 95);
                    g = Math.floor(intensity * 30);
                    b = Math.floor(intensity * 50);
                }

                // This level's pixel row
                const yThis = Math.round(chartH - ((price - bounds.pMin) / pRange) * chartH);

                // Next level's pixel row - fill up to (not including) that row
                // so levels tile exactly. If this is the last level, fill to the
                // canvas edge in that direction.
                let yNext: number;
                if (i + 1 < entries.length) {
                    const nextPrice = entries[i + 1][0];
                    yNext = Math.round(chartH - ((nextPrice - bounds.pMin) / pRange) * chartH);
                } else {
                    yNext = isBid ? chartH : 0; // bids fill downward, asks fill upward
                }

                // yFrom is the topmost row, yTo is the bottommost (inclusive)
                const yFrom = Math.max(0, Math.min(yThis, yNext));
                const yTo = Math.min(chartH - 1, Math.max(yThis, yNext) - 1);

                for (let y = yFrom; y <= yTo; y++) {
                    for (let x = x0; x <= x1; x++) {
                        const idx = (y * chartW + x) * 4;
                        if (data[idx + 3] < alpha) {
                            data[idx] = r;
                            data[idx + 1] = g;
                            data[idx + 2] = b;
                            data[idx + 3] = alpha;
                        }
                    }
                }
            }
        };

        paintSide(Array.from(bids.entries()), true);
        paintSide(Array.from(asks.entries()), false);
    }

    ctx.putImageData(imageData, 0, 0);
}

function binarySearchFloor(snapshots: BookSnapshot[], target: bigint): number {
    let lo = 0,
        hi = snapshots.length - 1,
        result = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (snapshots[mid].ts <= target) {
            result = mid;
            lo = mid + 1;
        } else hi = mid - 1;
    }
    return result;
}

function binarySearchCeil(snapshots: BookSnapshot[], target: bigint): number {
    let lo = 0,
        hi = snapshots.length - 1,
        result = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (snapshots[mid].ts >= target) {
            result = mid;
            hi = mid - 1;
        } else lo = mid + 1;
    }
    return result;
}

function getNiceStep(range: number, maxTicks: number): number {
    const exactStep = range / maxTicks;
    const mag = Math.pow(10, Math.floor(Math.log10(exactStep)));
    const residual = exactStep / mag;
    if (residual > 5) return 10 * mag;
    if (residual > 2) return 5 * mag;
    if (residual > 1) return 2 * mag;
    return mag;
}

// the shared price-axis tick generator. returns each tick's value and its pixel
// y, so the grid and the labels always land on the same rows. in log mode the
// ticks come off a 1-2-...-9 lattice and get thinned so adjacent rows stay
// MIN_TICK_GAP_PX apart - thats what gives a clean log axis, denser where it has
// room, instead of linearly spaced values bunching up at the top.
const MIN_TICK_GAP_PX = 32;

function computePriceTicks(
    min: number,
    max: number,
    h: number,
    isLog: boolean,
    tick: number
): { value: number; y: number }[] {
    const span = max - min;
    if (span <= 0 || h <= 0) return [];

    if (isLog && min > 0 && max > 0) {
        const logMin = Math.log(min);
        const logMax = Math.log(max);
        const denom = logMax - logMin || 1;
        const yOf = (p: number) => (1 - (Math.log(p) - logMin) / denom) * h;

        // two sources, merged. the 1-2-...-9 lattice gives round numbers and
        // guarantees every visible decade has ticks, which handles wide
        // multi-decade ranges. the linear nice-step fill is finer, so a
        // sub-decade range like 88k-112k - where the lattice only holds 90k and
        // 100k - still gets enough rows; over a span that narrow log is near
        // enough linear that they read evenly anyway.
        const seen = new Set<number>();
        const candidates: { value: number; y: number }[] = [];
        const add = (v: number) => {
            if (v >= min && v <= max && !seen.has(v)) {
                seen.add(v);
                candidates.push({ value: v, y: yOf(v) });
            }
        };

        const startExp = Math.floor(Math.log10(min));
        const endExp = Math.ceil(Math.log10(max));
        for (let e = startExp; e <= endExp; e++) {
            const base = Math.pow(10, e);
            for (let m = 1; m <= 9; m++) add(m * base);
        }

        const step = getNiceStep(max - min, Math.max(3, Math.round(h / 30)));
        for (let v = Math.ceil(min / step) * step; v <= max; v += step) {
            add(Number(v.toFixed(10))); // tame fp drift so dedupe works
        }

        // walk top to bottom and greedily thin so neighbouring rows never
        // collide. lattice points go in first, so on a near-tie the rounder wins.
        candidates.sort((a, b) => a.y - b.y);
        const out: { value: number; y: number }[] = [];
        let lastY = -Infinity;
        for (const tick of candidates) {
            if (tick.y - lastY >= MIN_TICK_GAP_PX) {
                out.push(tick);
                lastY = tick.y;
            }
        }
        return out;
    }

    // linear, also used for percent since the geometry is the same
    const step = Math.max(tick, getNiceStep(span, Math.max(3, Math.round(h / 30))));
    const first = Math.ceil(min / step) * step;
    const out: { value: number; y: number }[] = [];
    for (let v = first; v <= max; v += step) {
        out.push({ value: v, y: h - ((v - min) / span) * h });
    }
    return out;
}

function nsToDate(ns: bigint): Date {
    return new Date(Number(ns / 1_000_000n));
}

// caches for the time-axis label formatter.
//
// formatTsTime runs once per tick label and the axis redraws every frame while
// panning, so an Intl.DateTimeFormat - one of the most expensive allocations
// going - was being built fresh about twenty times a frame at 60fps. it only
// depends on the timezone, the clock format and whether seconds show, so there
// are a handful of distinct ones in a session.
//
// the view-bounds DateTimes were worse: they dont depend on ts at all, so every
// label in a frame built the same two Luxon objects and threw them away. keyed
// on the bounds, a frame builds them once.
//
// the bounds cache is one slot rather than a Map, since it only ever needs the
// current frame's and a Map would grow with every pixel panned.
const _tsFormatters = new Map<string, Intl.DateTimeFormat>();

function getTsFormatter(timezone: string, use24Hour: boolean, withSeconds: boolean) {
    const key = `${timezone}|${use24Hour}|${withSeconds}`;
    let fmt = _tsFormatters.get(key);
    if (!fmt) {
        const opts: Intl.DateTimeFormatOptions = {
            timeZone: timezone,
            hour: '2-digit',
            minute: '2-digit',
            hour12: !use24Hour,
        };
        if (withSeconds) opts.second = '2-digit';
        fmt = new Intl.DateTimeFormat('en-GB', opts);
        _tsFormatters.set(key, fmt);
    }
    return fmt;
}

let _boundsCache: {
    tMin: bigint;
    tMax: bigint;
    timezone: string;
    spansDays: boolean;
} | null = null;

/** Whether the visible range crosses a day boundary, computed once per frame. */
function viewSpansDays(bounds: ViewBounds, timezone: string): boolean {
    const c = _boundsCache;
    if (c && c.tMin === bounds.tMin && c.tMax === bounds.tMax && c.timezone === timezone) {
        return c.spansDays;
    }

    const min = DateTime.fromMillis(Number(bounds.tMin / 1_000_000n), { zone: timezone });
    const max = DateTime.fromMillis(Number(bounds.tMax / 1_000_000n), { zone: timezone });

    // Compared field by field rather than by concatenating day+month+year into
    // strings. That also fixes a real collision in the old test: 1/11 and 11/1
    // both flattened to "1112026", so a view spanning those dates reported that
    // it stayed inside one day and the axis dropped its date markers. Twelve
    // such day/month pairs collide in any given year.
    const spansDays = min.day !== max.day || min.month !== max.month || min.year !== max.year;

    _boundsCache = { tMin: bounds.tMin, tMax: bounds.tMax, timezone, spansDays };
    return spansDays;
}

function formatTsTime(
    ts: bigint,
    barNs: bigint,
    timezone: string,
    use24Hour: boolean,
    bounds: ViewBounds,
    crosshair: boolean = false,
    isSessionStart: boolean = false,
): { bold: boolean; text: string } {
    const ONE_MIN = 60_000_000_000n;
    const ONE_SEC = 1_000_000_000n;
    const date = nsToDate(ts);
    let base = getTsFormatter(timezone, use24Hour, barNs < ONE_MIN).format(date);

    const timezonedDate = DateTime.fromMillis(Number(ts / 1_000_000n), { zone: timezone });

    let isBold = false;

    if (!crosshair) {
        if (viewSpansDays(bounds, timezone)) {
            // Session-start ticks act as day-boundary markers (session open = start of trading day).
            // Non-session ticks only get a date label at local midnight.
            if (isSessionStart || (timezonedDate.hour === 0 && timezonedDate.minute === 0)) {
                base = String(timezonedDate.day);
                isBold = true;
            }
        } else {
            if (timezonedDate.minute === 0) isBold = true;
        }
    }

    if (barNs < ONE_SEC) {
        return { bold: isBold, text: `${base}.${String(date.getMilliseconds()).padStart(3, '0')}` };
    }
    return { bold: isBold, text: base };
}

/** Same story as getTsFormatter - one per timezone, not one per call. */
const _tsDateFormatters = new Map<string, Intl.DateTimeFormat>();

function formatTsDate(ts: bigint, timezone: string): string {
    const date = nsToDate(ts);

    let fmt = _tsDateFormatters.get(timezone);
    if (!fmt) {
        fmt = new Intl.DateTimeFormat('en-GB', {
            timeZone: timezone,
            weekday: 'short',
            day: '2-digit',
            month: 'short',
            year: '2-digit',
        });
        _tsDateFormatters.set(timezone, fmt);
    }

    const parts = fmt.formatToParts(date);
    const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return `${g('weekday')} ${g('day')} ${g('month')} '${g('year')}`;
}

/**
 * Tick intervals a human reads without thinking: whole seconds, minutes that
 * divide an hour, hours that divide a day, then days and weeks. Finest first.
 */
const NICE_TICK_INTERVALS: bigint[] = [
    1_000_000_000n, // 1 s
    2_000_000_000n,
    5_000_000_000n,
    10_000_000_000n,
    15_000_000_000n,
    30_000_000_000n,
    60_000_000_000n, // 1 min
    120_000_000_000n,
    300_000_000_000n, // 5 min
    600_000_000_000n,
    900_000_000_000n, // 15 min
    1_800_000_000_000n, // 30 min
    3_600_000_000_000n, // 1 hr
    7_200_000_000_000n,
    10_800_000_000_000n, // 3 hr
    14_400_000_000_000n,
    21_600_000_000_000n, // 6 hr
    28_800_000_000_000n,
    43_200_000_000_000n, // 12 hr
    86_400_000_000_000n, // 1 day
    172_800_000_000_000n,
    604_800_000_000_000n, // 1 week
    1_209_600_000_000_000n,
    2_592_000_000_000_000n, // 30 days
    7_776_000_000_000_000n, // 90 days
    31_536_000_000_000_000n, // 365 days
];

/**
 * The spacing between time ticks: the finest interval that both reads as a
 * round clock duration and lands on bar boundaries, while keeping the tick
 * count under `maxTicks`.
 *
 * The bar-multiple requirement is what keeps grid lines off the middle of a
 * candle. Taking it as the *only* requirement - stepping barNs by 1, 2, 3, 5,
 * 10, 15… as this used to - is where axes like 20:45 / 23:15 / 01:45 came from:
 * on a 15m chart the third multiplier is 45 minutes. Clock-friendly first, with
 * the old ladder kept as the fallback for bar sizes (7m, 3h) that have no round
 * multiple at all.
 */
function chooseTickInterval(spreadNs: bigint, barNs: bigint, maxTicks: number): bigint {
    if (spreadNs <= 0n) return barNs > 0n ? barNs : NICE_TICK_INTERVALS[0];
    for (const interval of NICE_TICK_INTERVALS) {
        if (barNs > 0n && (interval < barNs || interval % barNs !== 0n)) continue;
        if (spreadNs / interval <= BigInt(maxTicks)) return interval;
    }
    return getBarAlignedStep(spreadNs, barNs, maxTicks);
}

function getBarAlignedStep(tSpreadNs: bigint, barNs: bigint, maxTicks: number): bigint {
    if (barNs <= 0n) return BigInt(Math.round(getNiceStep(Number(tSpreadNs), maxTicks)));

    const multipliers = [1, 2, 3, 5, 10, 15, 20, 30, 60, 120, 240, 360, 720];
    for (const m of multipliers) {
        const step = barNs * BigInt(m);
        if (tSpreadNs / step <= BigInt(maxTicks)) return step;
    }
    // Fallback: just use a power-of-10 multiple of barNs
    let step = barNs;
    while (tSpreadNs / step > BigInt(maxTicks)) step *= 10n;
    return step;
}

function makeOpaque(hex) {
    //remove #
    let h = hex.replace(/^#/, '');

    // expoand short forms
    if (h.length === 3 || h.length === 4) {
        h = h
            .split('')
            .map((c) => c + c)
            .join('');
    }

    // remove alpha if present
    if (h.length === 8) {
        h = h.slice(0, 6);
    }

    return `#${h}`;
}

type GridTick = { ts: bigint; isSessionStart: boolean };

function getGridTicks(
    bounds: ViewBounds,
    barNs: bigint,
    maxTicks: number,
    sessionMapper?: SessionMapper,
    transformer?: LiveTransformer,
): GridTick[] {
    // Ordinal (column) axis: place ticks at a nice column-index step and label
    // each with the real timestamp of that column, so the axis still shows dates
    // even though spacing is by index, not time.
    const ordinal = transformer?.getOrdinal();
    if (ordinal && transformer) {
        const idxMin = transformer.tsToFracIndex(bounds.tMin);
        const idxMax = transformer.tsToFracIndex(bounds.tMax);
        const range = idxMax - idxMin;
        if (range <= 0) return [];
        const step = Math.max(1, Math.round(getNiceStep(range, maxTicks)));
        const ticks: GridTick[] = [];
        let col = Math.ceil(idxMin / step) * step;
        if (col < 0) col = 0;
        for (; col <= idxMax && col < ordinal.length; col += step) {
            ticks.push({ ts: transformer.indexToTs(col), isSessionStart: false });
        }
        return ticks;
    }
    if (!sessionMapper || !sessionMapper.hasSession) {
        const tSpreadNs = bounds.tMax - bounds.tMin;
        const tStep = chooseTickInterval(tSpreadNs, barNs, maxTicks);
        // Epoch (0) is always a multiple of barNs, so this anchor matches buildCandles.
        const epochAligned = (bounds.tMin / tStep) * tStep;
        let t = epochAligned;
        if (t < bounds.tMin) t += tStep;
        const ticks: GridTick[] = [];
        while (t <= bounds.tMax) {
            ticks.push({ ts: t, isSessionStart: false });
            t += tStep;
        }
        return ticks;
    }

    const mMin = sessionMapper.tsToMarket(bounds.tMin);
    const mMax = sessionMapper.tsToMarket(bounds.tMax);
    const mSpread = mMax - mMin;

    // Canonical real-time intervals, finer -> coarser
    const RT_INTERVALS: bigint[] = [
        1_000_000n, // 1 ms
        10_000_000n, // 10 ms
        100_000_000n, // 100 ms
        1_000_000_000n, // 1 s
        5_000_000_000n, // 5 s
        15_000_000_000n, // 15 s
        30_000_000_000n, // 30 s
        60_000_000_000n, // 1 min
        300_000_000_000n, // 5 min
        900_000_000_000n, // 15 min
        1_800_000_000_000n, // 30 min
        3_600_000_000_000n, // 1 hr
        7_200_000_000_000n, // 2 hr
        14_400_000_000_000n, // 4 hr
        21_600_000_000_000n, // 6 hr
        43_200_000_000_000n, // 12 hr
        86_400_000_000_000n, // 1 day
        604_800_000_000_000n, // 1 week
        2_592_000_000_000_000n, // ~30 days
    ];
    // Spacing is measured in MARKET time: that is what the axis is uniform in,
    // so a closed session must not count toward the gap between two ticks.
    let interval: bigint;
    if (barNs > 0n) {
        interval = chooseTickInterval(mSpread, barNs, maxTicks);
    } else {
        interval = RT_INTERVALS[RT_INTERVALS.length - 1];
        for (const iv of RT_INTERVALS) {
            if (mSpread / iv <= BigInt(maxTicks)) {
                interval = iv;
                break;
            }
        }
    }

    const TWELVE_HR = 43_200_000_000_000n;
    const segs = sessionMapper.segments;

    // Multi-day view: for each UTC-epoch-aligned period bucket, emit the first
    // session start that falls inside it.  Anchoring periods to the epoch (not
    // the viewport) means ticks never shift while panning.
    if (interval >= TWELVE_HR) {
        const periodStart0 = (bounds.tMin / interval) * interval;
        const ticks: GridTick[] = [];

        for (let period = periodStart0; period < bounds.tMax; period += interval) {
            const searchFrom = period < bounds.tMin ? bounds.tMin : period;
            const searchTo = period + interval;
            // Binary search: first segment with realStart >= searchFrom
            let lo = 0,
                hi = segs.length - 1,
                found = -1;
            while (lo <= hi) {
                const mid = (lo + hi) >>> 1;
                if (segs[mid].realStart >= searchFrom) {
                    found = mid;
                    hi = mid - 1;
                } else {
                    lo = mid + 1;
                }
            }
            if (
                found >= 0 &&
                segs[found].realStart < searchTo &&
                segs[found].realStart < bounds.tMax
            ) {
                ticks.push({ ts: segs[found].realStart, isSessionStart: true });
            }
        }
        return ticks;
    }

    // Intraday: anchor each segment to its own open so ticks always start at
    // session open + k*interval instead of drifting from the Unix epoch - the
    // same anchoring the bars themselves use.
    //
    // A session almost never divides evenly by the interval, so its last tick
    // lands some remainder short of the close. Next to it sits the next
    // session's open, and in market time - which is what the axis is spaced in
    // - the closed hours between them don't exist. On NQ's 23-hour session at a
    // 2h30 interval that put 16:30 half an hour from 18:00 and drew both
    // labels on top of each other. `minGap` is the fix: when two ticks fall
    // closer than that, only one survives.
    type Candidate = GridTick & { marketTs: bigint };
    const candidates: Candidate[] = [];

    for (const seg of segs) {
        if (seg.realEnd <= bounds.tMin) continue;
        if (seg.realStart > bounds.tMax) break;

        // First tick at or after the left edge, without stepping there one
        // interval at a time.
        let k = 0n;
        if (seg.realStart < bounds.tMin) {
            k = (bounds.tMin - seg.realStart + interval - 1n) / interval;
        }
        for (let t = seg.realStart + k * interval; t < seg.realEnd && t <= bounds.tMax; ) {
            candidates.push({
                ts: t,
                // The open is the trading day's boundary - formatTsTime gives it
                // the date label that a calendar midnight would get on a 24/7
                // symbol. Nothing else in the session is a day boundary.
                isSessionStart: t === seg.realStart,
                marketTs: seg.marketStart + (t - seg.realStart),
            });
            t += interval;
        }
    }

    // 55%: close enough to read as "these two are the same tick" without
    // thinning out a legitimately tight-but-even axis.
    const minGap = (interval * 55n) / 100n;
    const kept: Candidate[] = [];
    for (const candidate of candidates) {
        const prev = kept[kept.length - 1];
        if (prev && candidate.marketTs - prev.marketTs < minGap) {
            // The session open wins: it carries the date and is where the
            // trading day actually starts. Otherwise keep the earlier tick.
            if (!candidate.isSessionStart) continue;
            kept.pop();
        }
        kept.push(candidate);
    }
    return kept;
}
function floorIndex(priceHistory: PriceHistory[], target: bigint): number {
    let lo = 0;
    let hi = priceHistory.length - 1;
    let result = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (priceHistory[mid].ts <= target) {
            result = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return result;
}

export function nearestIndex(priceHistory: PriceHistory[], target: bigint): number {
    if (priceHistory.length === 0) return -1;
    let lo = 0;
    let hi = priceHistory.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (priceHistory[mid].ts < target) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    if (lo > 0) {
        const distLo = target - priceHistory[lo - 1].ts;
        const distHi = priceHistory[lo].ts - target;
        if (distLo < distHi) return lo - 1;
    }
    return lo;
}
export function nearestTradeIndex(trades: TradePoint[], target: bigint): number {
    if (trades.length === 0) return -1;
    let lo = 0;
    let hi = trades.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (trades[mid].ts < target) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    if (lo > 0) {
        const distLo = target - trades[lo - 1].ts;
        const distHi = trades[lo].ts - target;
        if (distLo < distHi) return lo - 1;
    }
    return lo;
}

export function findNearestTrade(
    clickX: number,
    clickY: number,
    trades: TradePoint[],
    bounds: ViewBounds,
    chartW: number,
    chartH: number,
    chartSettings: ChartSettings,
    horizon: bigint,
    transformer: LiveTransformer,
): TradePoint | null {
    let bestTrade: TradePoint | null = null;
    let bestDist = TRADE_SNAP_RADIUS;
    const cutTs = horizon > 0n ? horizon : bounds.tMax;

    for (const trade of trades) {
        if (trade.ts > cutTs) break;
        if (trade.ts < bounds.tMin || trade.ts > bounds.tMax) continue;

        const x = transformer.tsToX(trade.ts, chartW);
        const y = transformer.priceToY(trade.price, chartH);
        const dist = Math.sqrt((x - clickX) ** 2 + (y - clickY) ** 2);

        if (dist < bestDist) {
            bestDist = dist;
            bestTrade = trade;
        }
    }

    return bestTrade;
}

function roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

function drawPaneGrid(
    ctx: CanvasRenderingContext2D,
    bounds: ViewBounds,
    yMin: number,
    yMax: number,
    w: number,
    h: number,
    barNs: bigint = 0n,
    chartSettings: ChartSettings,
    transformer: LiveTransformer,
    isLog: boolean = false,
    symbolInfo: SymbolInfo
) {
    if (!chartSettings.showGrid) return;
    const hColor = chartSettings.gridHorizontalColor;
    const vColor = chartSettings.gridVerticalColor;

    ctx.strokeStyle = hColor;
    ctx.lineWidth = 1;

    // Horizontal price / value lines. Shares its tick rows with the price-axis
    // labels (see drawDynamicLabels) so grid and labels never drift apart.
    ctx.beginPath();
    for (const { y } of computePriceTicks(yMin, yMax, h, isLog, symbolInfo.priceFormat.minTick)) {
        const snapped = Math.round(y) + 0.5;
        ctx.moveTo(0, snapped);
        ctx.lineTo(w, snapped);
    }
    ctx.stroke();

    ctx.strokeStyle = vColor;

    // Vertical time lines
    ctx.beginPath();
    for (const { ts } of getGridTicks(
        bounds,
        barNs,
        12,
        transformer.getSessionMapper(),
        transformer,
    )) {
        const x = Math.round(transformer.tsToX(ts, w)) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
    }
    ctx.stroke();
}

function drawPaneYAxisLabels(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    panes: ChartPane[],
    layouts: Record<string, Rect>,
    bounds: ViewBounds,
    chartW: number,
) {
    ctx.font = '11px "Inter"';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.label;

    for (const pane of panes) {
        if (pane.isMain) continue;
        const rect = layouts[pane.id];
        if (!rect || rect.h < 2) continue;
        const { yMin, yMax } = pane;
        const span = yMax - yMin;
        if (span === 0) continue;
        const step = getNiceStep(span, Math.max(3, Math.round(rect.h / 30)));
        const first = Math.ceil(yMin / step) * step;
        for (let v = first; v <= yMax; v += step) {
            const y = rect.y + rect.h - ((v - yMin) / span) * rect.h;
            const label = Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0);
            ctx.fillText(label, chartW + 6, snapToDevicePx(y));
        }
    }
}

type ArrowGeom = { x: number; y: number; hw: number; arrowH: number };
type ArrowHoverTarget = {
    x: number;
    yTop: number;
    yBottom: number;
    hw: number;
    priceY: number;
    color: string;
    quantity: unknown;
};
type ArrowGeomCache = {
    boundsKey: string;
    fillsRef: unknown;
    barsRef: unknown;
    openBarRef: unknown;
    barNs: bigint;
    horizon: bigint;
    w: number;
    h: number;
    longGeom: ArrowGeom[];
    shortGeom: ArrowGeom[];
    hoverTargets: ArrowHoverTarget[];
};
// Per-canvas cache - geometry only changes with bounds/data, not crosshair.
const _arrowCaches = new WeakMap<HTMLCanvasElement, ArrowGeomCache>();

/**
 * This pane's symbol's fills, as a STABLE array.
 *
 * The geometry cache below compares its inputs by identity, and the fills it is
 * given are a per-symbol subset of the account's. Filtering inline handed it a
 * brand-new array every call, so the cache never once validated: every UI paint
 * - every pan frame, every crosshair move - rebuilt a Map over every loaded bar
 * on the chart. Filtering once per (snapshot fills, symbol) pair restores the
 * identity the cache is checking for.
 */
const _fillsBySymbol = new WeakMap<object, Map<string, AccountFill[]>>();
type AccountFill = { symbol: string; ts: number; side: string; price: number; quantity: number };

function fillsForSymbol(allFills: AccountFill[], symbol: string): AccountFill[] {
    let bySymbol = _fillsBySymbol.get(allFills);
    if (!bySymbol) {
        bySymbol = new Map();
        _fillsBySymbol.set(allFills, bySymbol);
    }
    let cached = bySymbol.get(symbol);
    if (!cached) {
        cached = allFills.filter((fill) => fill.symbol === symbol);
        bySymbol.set(symbol, cached);
    }
    return cached;
}

function drawTradeArrows(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    bounds: ViewBounds,
    w: number,
    h: number,
    chartSettings: ChartSettings,
    priceAxisH: number,
    yOffset: number = 0,
    barNs: bigint,
    horizon: bigint,
    crosshair: Crosshair,
    transformer: LiveTransformer,
    accountSnapshot: AccountSnapshot | null | undefined,
    ohlcvBars: {
        time: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
    }[],
    openBar: any,
    symbol: string
) {
    if (!accountSnapshot) return;

    const snap = accountSnapshot as any;
    if (!snap.fills?.length) return;
    const fills = fillsForSymbol(snap.fills, symbol);
    if (!fills.length) return;

    const barPx = transformer.getBarPx(w);
    const bodyW = Math.max(1, Math.floor(barPx * 0.8));
    const barMs = Number(barNs / 1_000_000n);

    // Geometry cache
    // Arrow screen positions only change when bounds/data change - not when the
    // crosshair moves. On mouse-move redraws the cache is valid and we skip all
    // recomputation; only the cheap hover scan runs.
    const boundsKey = `${bounds.tMin}|${bounds.tMax}|${String(bounds.pMin)}|${String(bounds.pMax)}`;
    let cache = _arrowCaches.get(canvas);
    const cacheValid =
        cache !== undefined &&
        cache.boundsKey === boundsKey &&
        cache.fillsRef === fills &&
        cache.barsRef === ohlcvBars &&
        cache.openBarRef === openBar &&
        cache.barNs === barNs &&
        cache.horizon === horizon &&
        cache.w === w &&
        cache.h === h;

    if (!cacheValid) {
        const tsToXFn = transformer.makeTsToXFn(w);
        const priceToYFn = transformer.makePriceToYFn(h);

        const horizonMs = Math.floor(Number(horizon / 1_000_000n) / barMs) * barMs;
        const openBarMs = openBar ? Number(openBar.ts / 1_000_000n) : -1;

        // Bars are time-sorted, so the bar a fill sits on is a binary search away.
        // This used to index every loaded bar into a Map first - an O(all bars)
        // build plus the garbage that comes with it, repeated on every pan frame
        // (the cache above keys on the view bounds, which a pan changes every
        // frame), for the sake of the handful of fills actually on screen.
        const barAt = (tsMs: number) => {
            if (tsMs === openBarMs && openBar) return openBar;
            if (tsMs >= horizonMs) return undefined;
            let lo = 0;
            let hi = ohlcvBars.length - 1;
            while (lo <= hi) {
                const mid = (lo + hi) >>> 1;
                const t = ohlcvBars[mid].time;
                if (t === tsMs) return ohlcvBars[mid];
                if (t < tsMs) lo = mid + 1;
                else hi = mid - 1;
            }
            return undefined;
        };

        const tMinMs = Number(bounds.tMin / 1_000_000n);
        const tMaxMs = Number(bounds.tMax / 1_000_000n);

        let startIdx = fills.length;
        {
            let lo = 0,
                hi = fills.length - 1;
            while (lo <= hi) {
                const mid = (lo + hi) >>> 1;
                if (fills[mid].ts / 1_000_000 < tMinMs) lo = mid + 1;
                else {
                    startIdx = mid;
                    hi = mid - 1;
                }
            }
        }

        const longGeom: ArrowGeom[] = [];
        const shortGeom: ArrowGeom[] = [];
        const hoverTargets: ArrowHoverTarget[] = [];

        let offsetLong = 0,
            offsetShort = 0;
        let lastTimeLong = 0,
            lastTimeShort = 0;

        for (let i = startIdx; i < fills.length; i++) {
            const fill = fills[i];
            const fillMs = fill.ts / 1_000_000;
            if (fillMs > tMaxMs) break;

            const t = Math.floor(fillMs / barMs) * barMs;
            const isLong = fill.side === 'long';

            if (isLong) lastTimeLong === t ? offsetLong++ : (offsetLong = 0);
            else lastTimeShort === t ? offsetShort++ : (offsetShort = 0);

            const bar = barAt(t);
            if (!bar) {
                isLong ? (lastTimeLong = t) : (lastTimeShort = t);
                continue;
            }

            const x = tsToXFn(BigInt(t) * 1_000_000n);
            const hw = Math.min(Math.max(0.1 * bodyW, 4), 12);
            const arrowH = hw * 3.5;

            if (isLong) {
                const y = priceToYFn(bar.low) + 5 + offsetLong * (arrowH + 7);
                longGeom.push({ x, y, hw, arrowH });
                hoverTargets.push({
                    x,
                    yTop: y,
                    yBottom: y + arrowH,
                    hw,
                    priceY: priceToYFn(fill.price),
                    color: '#12DAF2',
                    quantity: fill.quantity,
                });
                lastTimeLong = t;
            } else {
                const y = priceToYFn(bar.high) - 5 - offsetShort * (arrowH + 7);
                shortGeom.push({ x, y, hw, arrowH });
                hoverTargets.push({
                    x,
                    yTop: y - arrowH,
                    yBottom: y,
                    hw,
                    priceY: priceToYFn(fill.price),
                    color: '#F23040',
                    quantity: fill.quantity,
                });
                lastTimeShort = t;
            }
        }

        cache = {
            boundsKey,
            fillsRef: fills,
            barsRef: ohlcvBars,
            openBarRef: openBar,
            barNs,
            horizon,
            w,
            h,
            longGeom,
            shortGeom,
            hoverTargets,
        };
        _arrowCaches.set(canvas, cache);
    }

    const { longGeom, shortGeom, hoverTargets } = cache;

    // Batched draw - one beginPath/stroke per color.
    if (longGeom.length) {
        ctx.strokeStyle = '#12DAF2';
        ctx.beginPath();
        for (const g of longGeom) {
            ctx.moveTo(g.x - g.hw, g.y + g.hw);
            ctx.lineTo(g.x, g.y);
            ctx.lineTo(g.x + g.hw, g.y + g.hw);
            ctx.moveTo(g.x, g.y);
            ctx.lineTo(g.x, g.y + g.arrowH);
        }
        ctx.stroke();
    }

    if (shortGeom.length) {
        ctx.strokeStyle = '#F23040';
        ctx.beginPath();
        for (const g of shortGeom) {
            ctx.moveTo(g.x - g.hw, g.y - g.hw);
            ctx.lineTo(g.x, g.y);
            ctx.lineTo(g.x + g.hw, g.y - g.hw);
            ctx.moveTo(g.x, g.y);
            ctx.lineTo(g.x, g.y - g.arrowH);
        }
        ctx.stroke();
    }

    // Hover overlay - scan cached hit boxes, draw at most one.
    if (crosshair) {
        for (const t of hoverTargets) {
            if (
                crosshair.x > t.x - t.hw &&
                crosshair.x < t.x + t.hw &&
                crosshair.y > t.yTop &&
                crosshair.y < t.yBottom
            ) {
                ctx.strokeStyle = t.color;
                ctx.beginPath();
                ctx.moveTo(t.x - bodyW / 2, t.priceY);
                ctx.lineTo(t.x + bodyW / 2, t.priceY);
                ctx.stroke();
                ctx.fillStyle = t.color;
                ctx.font = `bold 18px, "JetBrains mono", monospace`;
                ctx.fillText(String(t.quantity), t.x + 3 + bodyW / 2, t.priceY);
                break;
            }
        }
    }
}

function drawPaneDividers(
    ctx: CanvasRenderingContext2D,
    panes: ChartPane[],
    layouts: Record<string, Rect>,
    chartW: number,
) {
    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 1;
    for (let i = 0; i < panes.length - 1; i++) {
        const rect = layouts[panes[i].id];
        if (!rect || rect.h < 2) continue;
        const divY = Math.round(rect.y + rect.h) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, divY);
        ctx.lineTo(chartW + 65, divY); // extend across Y axis strip too
        ctx.stroke();
    }
}

function drawDividerHighlight(
    ctx: CanvasRenderingContext2D,
    panes: ChartPane[],
    layouts: Record<string, Rect>,
    canvasW: number,
    dividerIdx: number,
) {
    const pane = panes[dividerIdx];
    if (!pane) return;
    const rect = layouts[pane.id];
    if (!rect) return;
    const divY = Math.round(rect.y + rect.h) + 0.5;

    // Glow effect: wide semi-transparent band
    ctx.strokeStyle = 'rgba(120, 120, 140, 0.25)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(0, divY);
    ctx.lineTo(canvasW, divY);
    ctx.stroke();

    // Crisp bright line on top
    ctx.strokeStyle = 'rgba(160, 160, 180, 0.7)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, divY);
    ctx.lineTo(canvasW, divY);
    ctx.stroke();
}

function drawBackground(
    ctx: CanvasRenderingContext2D,
    cssW: number,
    cssH: number,
    chartSettings: ChartSettings,
) {
    ctx.fillStyle = chartSettings.backgroundColor ?? COLORS.background;
    ctx.fillRect(0, 0, cssW, cssH);
}

function drawAxesBackgrounds(
    ctx: CanvasRenderingContext2D,
    cssW: number,
    cssH: number,
    w: number, // chartW - the axis band is everything right of this
    h: number, // chartH (cssH - X_AXIS_HEIGHT) - and everything below this
    chartSettings: ChartSettings,
) {
    // Snapped: these are chrome, not data. Landing the seam between the chart and
    // the axis bands on a whole device pixel keeps it a hard line instead of a
    // two-pixel smear (cssH/chartH are fractional whenever the canvas is).
    const sw = snapToDevicePx(w);
    const sh = snapToDevicePx(h);

    ctx.fillStyle = chartSettings.axisBackgroundColor ?? COLORS.axisBg;
    ctx.fillRect(sw, 0, cssW - sw, cssH);
    ctx.fillRect(0, sh, cssW, cssH - sh);
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(sw, 0);
    ctx.lineTo(sw, sh);
    ctx.stroke();
    ctx.moveTo(0, sh);
    ctx.lineTo(sw, sh);
    ctx.stroke();
    ctx.closePath();
}

function drawDynamicLabels(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    bounds: ViewBounds,
    w: number,
    h: number,
    chartSettings: ChartSettings,
    priceAxisH?: number,
    barNs: bigint = 0n,
    pinnedYs: number[] = [],
    yOffset: number = 0,
    transformer?: LiveTransformer,
    dataLevel?: DataLevel,
    hidePriceScale?: boolean,
    hideTimeScale?: boolean,
    symbolInfo?: SymbolInfo,
) {
    const pH = priceAxisH ?? h;
    ctx.save();
    ctx.fillStyle = COLORS.label;
    ctx.font = '11px "Inter"';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    if (!hidePriceScale) {
        // Same tick rows as the grid (see computePriceTicks) so labels and grid
        // lines stay locked together in every scale mode.
        const isLog = transformer?.getScaleMode() === 'log';
        for (const { value: p } of computePriceTicks(bounds.pMin, bounds.pMax, pH, isLog, symbolInfo.priceFormat.minTick)) {
            let y = transformer.priceToY(p, pH);
            if (y < 0 || y > pH) continue;
            y += yOffset;

            // Skip this tick if it would overlap a pinned label (bid/ask/close pill)
            if (
                !chartSettings.allowLabelOverlap &&
                pinnedYs.some((py) => Math.abs(py - y) < LABEL_H)
            )
                continue;

            const precision = symbolInfo.priceFormat.precision;

            const label =
                chartSettings.priceScaleMode === 'percent' && bounds.pRef
                    ? `${(((p - bounds.pRef) / bounds.pRef) * 100).toFixed(precision)}%`
                    : p.toFixed(precision);
            ctx.fillText(label, w + 6, snapToDevicePx(y));
        }
    }

    if (!hideTimeScale) {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const tz = chartSettings.timezone ?? 'UTC';
        const use24 = chartSettings.use24HourClock ?? true;
        for (const { ts, isSessionStart } of getGridTicks(
            bounds,
            barNs,
            12,
            transformer.getSessionMapper(),
            transformer,
        )) {
            const x = snapToDevicePx(transformer.tsToX(ts, w));
            const { bold, text } = formatTsTime(
                ts,
                barNs,
                tz,
                use24,
                bounds,
                false,
                isSessionStart,
            );
            ctx.font = `${bold ? 'bold' : ''} 11px "Inter"`;
            ctx.fillText(text, x, snapToDevicePx(h + 8));
        }
    }
    ctx.restore();
}

function drawTradeLine(
    ctx: CanvasRenderingContext2D,
    priceHistory: PriceHistory[],
    bounds: ViewBounds,
    w: number,
    h: number,
    color: string,
    side: 'bid' | 'ask' | 'price',
    chartSettings: ChartSettings,
    horizon: bigint = 0n,
    barNs: bigint,
    transformer: LiveTransformer,
    ohlcvBars?: {
        time: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
    }[],
    openBar?: any,
) {
    const tsToXFn = transformer.makeTsToXFn(w);
    const priceToYFn = transformer.makePriceToYFn(h);

    if (side === 'price') {
        if (!ohlcvBars.length) return;
        const cutTs = Number(((horizon / barNs) * barNs) / 1_000_000n);
        const target = Number(bounds.tMin / 1_000_000n);

        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.lineJoin = 'miter';

        let lo = 0;
        let hi = ohlcvBars.length - 1;
        let result = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            if (ohlcvBars[mid].time <= target) {
                result = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        const startIdx = result;
        let isFirstPoint = true;
        let idx = startIdx;

        for (let i = startIdx; i < ohlcvBars.length; i++) {
            if (ohlcvBars[i].time >= cutTs) break;
            const val = ohlcvBars[i].close;
            if (val === 0) continue;

            const x = tsToXFn(BigInt(ohlcvBars[i].time * 1_000_000));
            const y = priceToYFn(val);

            if (isFirstPoint) {
                ctx.moveTo(x, y);
                isFirstPoint = false;
            } else {
                const prevVal = ohlcvBars[i - 1].close;
                const prevY = priceToYFn(prevVal !== 0 ? prevVal : val);
                ctx.lineTo(x, prevY);
                ctx.lineTo(x, y);
                idx = i;
            }

            if (x > w + 100) break;
        }
        ctx.lineTo(tsToXFn(openBar.ts), priceToYFn(ohlcvBars[idx].close));
        ctx.lineTo(tsToXFn(openBar.ts), priceToYFn(openBar.close));
        ctx.stroke();
    } else {
        if (priceHistory.length === 0) return;
        const cutTs = horizon > 0n ? horizon : bounds.tMax;

        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.lineJoin = 'miter';

        const startIdx = Math.max(0, floorIndex(priceHistory, bounds.tMin));
        let isFirstPoint = true;

        for (let i = startIdx; i < priceHistory.length; i++) {
            if (priceHistory[i].ts > cutTs) break;
            const val = side === 'ask' ? priceHistory[i].bestAsk : priceHistory[i].bestBid;
            if (val === 0) continue;

            const x = tsToXFn(priceHistory[i].ts);
            const y = priceToYFn(val);

            if (isFirstPoint) {
                ctx.moveTo(x, y);
                isFirstPoint = false;
            } else {
                const prevVal =
                    side === 'ask' ? priceHistory[i - 1].bestAsk : priceHistory[i - 1].bestBid;
                const prevY = priceToYFn(prevVal !== 0 ? prevVal : val);
                ctx.lineTo(x, prevY);
                ctx.lineTo(x, y);
            }

            if (x > w + 100) break;
        }
        ctx.stroke();
    }
}

function drawMidLine(
    ctx: CanvasRenderingContext2D,
    priceHistory: PriceHistory[],
    bounds: ViewBounds,
    w: number,
    h: number,
    chartSettings: ChartSettings,
    horizon: bigint = 0n,
    transformer: LiveTransformer,
) {
    if (priceHistory.length === 0) return;
    const tsToXFn = transformer.makeTsToXFn(w);
    const priceToYFn = transformer.makePriceToYFn(h);
    const cutTs = horizon > 0n ? horizon : bounds.tMax;
    const startIdx = Math.max(0, floorIndex(priceHistory, bounds.tMin));
    ctx.beginPath();
    ctx.strokeStyle = '#b0b0b0';
    ctx.lineWidth = 1;
    ctx.lineJoin = 'round';
    ctx.setLineDash([3, 3]);
    let first = true;
    for (let i = startIdx; i < priceHistory.length; i++) {
        if (priceHistory[i].ts > cutTs) break;
        const { bestBid, bestAsk } = priceHistory[i];
        if (bestBid === 0 || bestAsk === 0) continue;
        const mid = (bestBid + bestAsk) / 2;
        const x = tsToXFn(priceHistory[i].ts);
        const y = priceToYFn(mid);
        if (first) {
            ctx.moveTo(x, y);
            first = false;
        } else ctx.lineTo(x, y);
        if (x > w + 100) break;
    }
    ctx.stroke();
    ctx.setLineDash([]);
}

function drawLastTradeLine(
    ctx: CanvasRenderingContext2D,
    trades: TradePoint[],
    bounds: ViewBounds,
    w: number,
    h: number,
    chartSettings: ChartSettings,
    horizon: bigint = 0n,
    transformer: LiveTransformer,
) {
    if (trades.length === 0) return;
    const tsToXFn = transformer.makeTsToXFn(w);
    const priceToYFn = transformer.makePriceToYFn(h);
    const cutTs = horizon > 0n ? horizon : bounds.tMax;
    const startIdx = Math.max(
        0,
        (() => {
            let lo = 0,
                hi = trades.length - 1,
                r = 0;
            while (lo <= hi) {
                const mid = (lo + hi) >>> 1;
                if (trades[mid].ts <= bounds.tMin) {
                    r = mid;
                    lo = mid + 1;
                } else hi = mid - 1;
            }
            return r;
        })(),
    );
    ctx.beginPath();
    ctx.strokeStyle = '#ffffff99';
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    let first = true;
    for (let i = startIdx; i < trades.length; i++) {
        if (trades[i].ts > cutTs) break;
        if (trades[i].ts > bounds.tMax) break;
        const x = tsToXFn(trades[i].ts);
        const y = priceToYFn(trades[i].price);
        if (first) {
            ctx.moveTo(x, y);
            first = false;
        } else ctx.lineTo(x, y);
    }
    ctx.stroke();
}

function drawBreaks(
    ctx: CanvasRenderingContext2D,
    bounds: ViewBounds,
    w: number,
    h: number,
    chartSettings: ChartSettings,
    transformer: LiveTransformer,
    barNs: bigint,
) {
    const sessionMapper = transformer.getSessionMapper();

    const barPx = transformer.getBarPx(w);
    const bodyW = Math.max(1, Math.floor(barPx));
    const halfBody = bodyW / 2;

    ctx.save();
    ctx.strokeStyle = chartSettings.breaksColor;
    ctx.setLineDash(chartSettings.breaksDash);
    ctx.lineWidth = chartSettings.breaksWidth;
    for (const sessionBreak of sessionMapper.getBreaks()) {
        if (sessionBreak.ts <= bounds.tMin) continue;
        if (sessionBreak.ts >= bounds.tMax) break;

        const x = transformer.tsToX(sessionBreak.ts, w) - halfBody;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
    }
    ctx.restore();
}

function drawTrades(
    ctx: CanvasRenderingContext2D,
    trades: TradePoint[],
    bounds: ViewBounds,
    w: number,
    h: number,
    barNs: bigint = 0n,
    chartSettings: ChartSettings,
    horizon: bigint = 0n,
    transformer: LiveTransformer,
) {
    if (trades.length === 0) return;
    const tsToXFn = transformer.makeTsToXFn(w);
    const priceToYFn = transformer.makePriceToYFn(h);
    const cutTs = horizon > 0n ? horizon : bounds.tMax;

    // Compute per-bar max size for scaling
    // We bucket by bar purely to find how large the biggest trade cluster is
    // within each bar - this gives stable radius scaling as you pan.
    // X position always uses the real trade timestamp, never the bar boundary.
    const barMax = new Map<bigint, number>();
    for (const trade of trades) {
        if (trade.ts > cutTs) break;
        if (trade.ts < bounds.tMin || trade.ts > bounds.tMax) continue;
        const barTs = barNs > 0n ? (trade.ts / barNs) * barNs : 0n;
        const cur = barMax.get(barTs) ?? 0;
        if (trade.size > cur) barMax.set(barTs, trade.size);
    }
    // Global max across all visible bars for normalization
    let maxSize = 1;
    for (const v of barMax.values()) if (v > maxSize) maxSize = v;

    const PI2 = Math.PI * 2;

    for (const trade of trades) {
        if (trade.ts > cutTs) break;
        if (trade.ts < bounds.tMin || trade.ts > bounds.tMax) continue;

        const x = tsToXFn(trade.ts);
        const y = priceToYFn(trade.price);

        // Radius scaled by sqrt for perceptual area scaling, then multiplied by user size pref
        const t = Math.sqrt(trade.size / maxSize);
        const sizeScale = (chartSettings.tradeDotsSizeMult ?? 3) / 3;
        const radius = (MIN_DOT_RADIUS + t * (MAX_DOT_RADIUS - MIN_DOT_RADIUS)) * sizeScale;

        ctx.beginPath();
        ctx.arc(x, y, radius, 0, PI2);
        ctx.fillStyle = trade.side === 'B' ? '#00e676cc' : '#ff1744cc';
        ctx.fill();
    }
}

function drawTradeSelectionRing(
    ctx: CanvasRenderingContext2D,
    trade: TradePoint,
    bounds: ViewBounds,
    w: number,
    h: number,
    chartSettings: ChartSettings,
    transformer: LiveTransformer,
) {
    const x = transformer.tsToX(trade.ts, w);
    const y = transformer.priceToY(trade.price, h);
    const color = trade.side === 'B' ? '#00e676' : '#ff1744';

    // Outer soft glow
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.strokeStyle = color + '50';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Inner crisp ring
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
}

function drawTradeDetail(
    ctx: CanvasRenderingContext2D,
    trade: TradePoint,
    bounds: ViewBounds,
    chartW: number,
    chartH: number,
    chartSettings: ChartSettings,
    transformer: LiveTransformer,
    symbolInfo?: SymbolInfo,
) {
    const dotX = transformer.tsToX(trade.ts, chartW);
    const dotY = transformer.priceToY(trade.price, chartH);

    const isBuy = trade.side === 'B';
    const accentColor = isBuy ? '#00e676' : '#ff1744';

    const timeStr = nsToDate(trade.ts).toISOString().slice(11, 23); // HH:MM:SS.mmm
    const rows: [string, string][] = [
        ['Side', isBuy ? 'BUY' : 'SELL'],
        ['Price', formatPrice(trade.price, symbolInfo)],
        ['Size', trade.size.toString()],
        ['Time', timeStr],
    ];

    ctx.font = '11px "Inter"';

    // Size the card to fit the content exactly
    const labelColumnW = ctx.measureText('Price').width;
    const maxValueW = Math.max(...rows.map(([, v]) => ctx.measureText(v).width));
    const boxW = labelColumnW + maxValueW + 36; // 12 left pad + gap + 12 right pad
    const rowH = 18;
    const boxH = rows.length * rowH + 20; // 10 top + 10 bottom padding

    // Default position: top-right of the dot
    const gap = 14;
    let boxX = dotX + gap;
    let boxY = dotY - boxH - gap;

    // Nudge the card inward if it clips any chart edge
    if (boxX + boxW > chartW - 4) boxX = dotX - boxW - gap;
    if (boxX < 4) boxX = 4;
    if (boxY < 4) boxY = dotY + gap;
    if (boxY + boxH > chartH - 4) boxY = chartH - boxH - 4;

    // Background
    ctx.fillStyle = 'rgba(12, 13, 17, 0.95)';
    ctx.fillRect(boxX, boxY, boxW, boxH);

    // Colored left-edge accent bar
    ctx.fillStyle = accentColor;
    ctx.fillRect(boxX, boxY, 3, boxH);

    // Outer border
    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 1;
    ctx.strokeRect(boxX, boxY, boxW, boxH);

    // Row text
    ctx.textBaseline = 'middle';
    rows.forEach(([label, value], i) => {
        const rowY = boxY + 10 + i * rowH + rowH / 2;

        ctx.fillStyle = COLORS.label;
        ctx.textAlign = 'left';
        ctx.fillText(label, boxX + 10, rowY);

        // Side row gets the accent color, all others get near-white
        ctx.fillStyle = i === 0 ? accentColor : '#e0e0e0';
        ctx.textAlign = 'right';
        ctx.fillText(value, boxX + boxW - 10, rowY);
    });
}

export const snapTs = (ts: bigint, tf: bigint, sessionMapper?: SessionMapper | null): bigint =>
    snapTsToBarGrid(ts, tf, sessionMapper);

export const snapPrice = (
    snappedTs: bigint,
    rawPrice: number,
    chartSettings: ChartSettings,
    footprintBars: FootprintBar[],
    priceHistory: PriceHistory[],
    ohlcvBars: {
        time: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
    }[],
    dataLevel: DataLevel,
    horizon: bigint,
): number => {
    if (snappedTs > horizon) return rawPrice;
    const chartType = chartSettings.chartType;

    if (dataLevel === 'ohlcv') {
        // Binary search, not `.find`: this runs on every pointer move while a
        // drawing tool is armed, and the array it was scanning end-to-end is the
        // whole loaded history.
        const targetMs = Number(snappedTs / 1_000_000n);
        let bar: (typeof ohlcvBars)[number] | undefined;
        {
            let lo = 0;
            let hi = ohlcvBars.length - 1;
            while (lo <= hi) {
                const mid = (lo + hi) >>> 1;
                const t = ohlcvBars[mid].time;
                if (t === targetMs) {
                    bar = ohlcvBars[mid];
                    break;
                }
                if (t < targetMs) lo = mid + 1;
                else hi = mid - 1;
            }
        }
        if (!bar) return rawPrice;
        const distances = [
            Math.abs(bar.open - rawPrice),
            Math.abs(bar.high - rawPrice),
            Math.abs(bar.low - rawPrice),
            Math.abs(bar.close - rawPrice),
        ];
        const minDist = Math.min(...distances);
        const map = ['open', 'high', 'low', 'close'];
        let point = null;
        for (let i = 0; i < distances.length; i++) {
            if (distances[i] === minDist) {
                point = map[i];
            }
        }

        if (point) {
            return bar[point];
        } else {
            return rawPrice;
        }
    } else {
        if (
            chartType === 'candles' ||
            chartType === 'footprint' ||
            chartType === 'hollow' ||
            chartType === 'bars'
        ) {
            const bars = footprintBars;
            if (bars.length === 0) return rawPrice;
            let lo = 0,
                hi = bars.length - 1,
                best = 0;
            while (lo <= hi) {
                const mid = (lo + hi) >>> 1;
                if (bars[mid].ts <= snappedTs) {
                    best = mid;
                    lo = mid + 1;
                } else hi = mid - 1;
            }
            const bar = bars[best];
            const candidates = [bar.open, bar.high, bar.low, bar.close];
            return candidates.reduce((a, b) =>
                Math.abs(b - rawPrice) < Math.abs(a - rawPrice) ? b : a,
            );
        }

        const history = priceHistory;
        if (history.length === 0) return rawPrice;
        let lo = 0,
            hi = history.length - 1,
            best = 0;
        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            if (history[mid].ts <= snappedTs) {
                best = mid;
                lo = mid + 1;
            } else hi = mid - 1;
        }
        const pt = history[best];
        const candidates = [pt.bestBid, pt.bestAsk];
        return candidates.reduce((a, b) =>
            Math.abs(b - rawPrice) < Math.abs(a - rawPrice) ? b : a,
        );
    }
};

/**
 * Place another cell's crosshair on this chart's canvas.
 *
 * Time always maps through this chart's own axis, so a follower stays pinned to
 * the same moment no matter its timeframe, zoom, or session gaps. The vertical
 * position depends on how comparable the two cells are:
 *
 *   - same symbol, main pane  -> the same *price*, which is what makes two views
 *                               of one instrument line up meaningfully
 *   - anything else           -> the same relative height inside the matching
 *                               pane, since a price from another instrument (or
 *                               an indicator's own scale) would be nonsense here
 *
 * A price that has been scrolled off this chart keeps the vertical (time) line
 * and drops the horizontal one, rather than lying about where the price sits -
 * `full: false` says so. Returns null when the *time* is off-screen, since then
 * there is nothing to point at at all.
 */
function projectSyncCrosshair(
    sync: CrosshairSync,
    panes: ChartPane[],
    layouts: Record<string, Rect>,
    chartW: number,
    transformer: LiveTransformer,
    symbolInfo?: SymbolInfo,
): { point: Crosshair; full: boolean } | null {
    if (!transformer) return null;

    const pane = panes.find((p) => p.id === sync.paneId) ?? panes.find((p) => p.isMain);
    const rect = pane ? layouts[pane.id] : null;
    if (!pane || !rect || rect.h < 2) return null;

    const x = transformer.tsToX(sync.ts, chartW);
    if (!Number.isFinite(x) || x < 0 || x >= chartW) return null;

    const sameSymbol = !!sync.symbol && sync.symbol === symbolInfo?.symbol;
    const y =
        pane.isMain && sameSymbol
            ? rect.y + transformer.priceToY(sync.price, rect.h)
            : rect.y + sync.yFrac * rect.h;

    const inPane = Number.isFinite(y) && y >= rect.y && y < rect.y + rect.h;

    // Keep the point inside the pane so the usual pane lookup finds it; the
    // horizontal line is suppressed separately when it was clamped.
    return {
        point: { x, y: inPane ? y : rect.y + rect.h / 2 },
        full: inPane,
    };
}

function drawCrosshair(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    bounds: ViewBounds,
    crosshair: Crosshair,
    w: number,
    totalH: number, // full chart area height (all panes)
    panes: ChartPane[],
    layouts: Record<string, Rect>,
    barNs: bigint = 0n,
    horizon: bigint,
    chartSettings: ChartSettings,
    activeTool?: ActiveDrawingTool | null,
    draggingAnchor?: { drawingId: string; anchor: DrawingAnchorId } | null,
    holdingCtrl?: boolean | null,
    holdingShift?: boolean | null,
    activeTfBarNs?: bigint | null,
    footprintBars?: FootprintBar[] | null,
    priceHistory?: PriceHistory[] | null,
    bars?:
        | {
              time: number;
              open: number;
              high: number;
              low: number;
              close: number;
              volume: number;
              bid?: number;
              ask?: number;
          }[]
        | null,
    drawings?: Drawing[] | null,
    draft?: DraftDrawing | null,
    transformer?: LiveTransformer,
    dataLevel?: DataLevel,
    hidePriceScale?: boolean,
    hideTimeScale?: boolean,
    xAxisHeight?: number,
    symbolInfo?: SymbolInfo,
    rightScaleWidth: number = 0,
    /** Mirrored from another cell: draw it plainly - magnet/shift belong to the
     *  hand actually holding the mouse, on the chart that owns it. */
    mirrored?: boolean,
    /** Mirrored price is off this chart's scale: time line only. */
    timeOnly?: boolean,
) {
    if (!crosshair) return;
    if (chartSettings.crosshairMode === 'hidden') return;

    ctx.save();

    ctx.strokeStyle = chartSettings.crosshairColor;
    ctx.lineWidth = chartSettings.crosshairWidth;
    ctx.setLineDash(chartSettings.crosshairDash);

    // Find which pane the cursor is in
    const activePaneEntry = panes.find((p) => {
        const l = layouts[p.id];
        return l && crosshair.y >= l.y && crosshair.y < l.y + l.h;
    });

    const activeRect = activePaneEntry ? layouts[activePaneEntry.id] : null;
    if (!activeRect) return;

    // Snap raw cursor time to nearest bar boundary
    const rawTs = transformer.xToTs(crosshair.x, w);
    const _snapSm = transformer.getSessionMapper();

    let snappedTs: bigint;
    if (barNs <= 0n) {
        snappedTs = rawTs;
    } else if (_snapSm && _snapSm.hasSession) {
        // Anchor snap to the session-start of whichever segment contains rawTs.
        // This ensures the crosshair lands on the same grid as the bars, which are
        // also session-start-anchored (e.g. 01:00 -> 01:07 -> 01:14 for a 7-min chart).
        const curSeg = _snapSm.segments.find((s) => rawTs >= s.realStart && rawTs < s.realEnd);
        if (curSeg) {
            const offset = rawTs - curSeg.realStart;
            snappedTs = curSeg.realStart + ((offset + barNs / 2n) / barNs) * barNs;
            if (snappedTs >= curSeg.realEnd) {
                // Rounding pushed past this segment's end - the cursor is visually on
                // the first candle of the next session, so snap there instead of
                // flooring back to the last bar of the current session.
                const nextSeg = _snapSm.segments.find((s) => s.realStart >= curSeg.realEnd);
                snappedTs = nextSeg ? nextSeg.realStart : curSeg.realEnd - barNs;
            }
        } else {
            // In a gap - will be corrected below
            snappedTs = rawTs;
        }
    } else {
        snappedTs = ((rawTs + barNs / 2n) / barNs) * barNs;
    }

    // If snappedTs landed in a session gap, snap to the nearest valid bar.
    // Only applies within the mapper's covered range - timestamps before the
    // first segment use linear backward extrapolation (no session gaps), so
    // the barNs-rounded value is already correct there.
    if (_snapSm && _snapSm.hasSession && barNs > 0n) {
        const firstSeg = _snapSm.segments[0];
        if (firstSeg && rawTs >= firstSeg.realStart) {
            const inSeg = (ts: bigint) =>
                _snapSm.segments.some((s) => ts >= s.realStart && ts < s.realEnd);
            if (!inSeg(snappedTs)) {
                const candidates: bigint[] = [];
                // Previous segment: last bar anchored to that segment's open
                const prevSeg = [..._snapSm.segments].reverse().find((s) => s.realEnd <= rawTs);
                if (prevSeg) {
                    const segLen = prevSeg.realEnd - prevSeg.realStart;
                    const lastBarOffset = (segLen / barNs) * barNs;
                    // lastBarOffset is the open of the last bar; if it equals segLen the bar
                    // starts exactly at realEnd (open-ended), so step back one bar.
                    const lastBar =
                        prevSeg.realStart + lastBarOffset < prevSeg.realEnd
                            ? prevSeg.realStart + lastBarOffset
                            : prevSeg.realStart + lastBarOffset - barNs;
                    if (lastBar >= prevSeg.realStart) candidates.push(lastBar);
                }
                // Next segment: first bar is always at the segment's open
                const nextSeg = _snapSm.segments.find((s) => s.realStart > rawTs);
                if (nextSeg) {
                    candidates.push(nextSeg.realStart);
                }
                if (candidates.length > 0) {
                    // Compare in market space - real-time distance is distorted by session gaps
                    const mRaw = _snapSm.tsToMarket(rawTs);
                    snappedTs = candidates.reduce((best, c) => {
                        const mBest = _snapSm.tsToMarket(best);
                        const mC = _snapSm.tsToMarket(c);
                        const db = mBest > mRaw ? mBest - mRaw : mRaw - mBest;
                        const dc = mC > mRaw ? mC - mRaw : mRaw - mC;
                        return dc < db ? c : best;
                    });
                }
            }
        }
    }

    const snappedX = barNs > 0n ? transformer.tsToX(snappedTs, w) : crosshair.x;

    const crosshairTick = resolveTickSize(symbolInfo);

    // Vertical line - snapped to bar boundary
    if (snappedX < w) {
        ctx.beginPath();
        ctx.moveTo(snappedX, 0);
        ctx.lineTo(snappedX, totalH);
        ctx.stroke();
    }

    let _y = crosshair.y;

    // Horizontal line - only within the active pane
    if (activeRect && !timeOnly) {
        if (!mirrored && (activeTool?.name !== 'cursor' || draggingAnchor?.anchor)) {
            const mainRect = layouts['main'];
            const mainH = mainRect?.h ?? canvas.height - xAxisHeight;
            const mainOY = mainRect?.y ?? 0;
            const drawing = drawings.find((d) => d.id === draggingAnchor?.drawingId);
            if (holdingShift && drawing?.tool !== 'fib') {
                if (draft) {
                    _y = transformer.priceToY(draft['a']?.price, mainH) + mainOY;
                } else {
                    if (drawing?.['a'] && drawing?.['b']) {
                        _y =
                            transformer.priceToY(
                                draggingAnchor.anchor === 'a'
                                    ? drawing['b'].price
                                    : drawing['a'].price,
                                mainH,
                            ) + mainOY;
                    }
                }
            } else if (
                (holdingCtrl || chartSettings.crosshairMode === 'magnet') &&
                draggingAnchor?.anchor !== 'body'
            ) {
                const ts = snapTs(rawTs, activeTfBarNs, transformer.getSessionMapper());
                const rawPrice = transformer.yToPrice(crosshair.y - mainOY, mainH);
                const price = snapPrice(
                    ts,
                    rawPrice,
                    chartSettings,
                    footprintBars,
                    priceHistory,
                    bars,
                    dataLevel,
                    horizon,
                );

                _y = transformer.priceToY(price, mainH) + mainOY;
            }
            ctx.beginPath();
            ctx.moveTo(0, _y);
            ctx.lineTo(w, _y);
            ctx.stroke();
        } else {
            ctx.beginPath();
            ctx.moveTo(0, crosshair.y);
            ctx.lineTo(w, crosshair.y);
            ctx.stroke();
        }
    }

    // Time label - precision trimmed to match barNs
    // >= 1 min  -> "HH:MM"  (or 12h variant)
    // >= 1 s    -> "HH:MM:SS"
    // < 1 s     -> "HH:MM:SS.mmm"
    //
    if (!hideTimeScale) {
        const tz = chartSettings.timezone ?? 'UTC';
        const use24 = chartSettings.use24HourClock ?? true;
        const { text: timeStr } = formatTsTime(snappedTs, barNs, tz, use24, bounds, true);
        const dateStr = formatTsDate(snappedTs, tz);

        ctx.font = `11px "Inter"`;
        const tWidth = ctx.measureText(dateStr + '   ' + timeStr).width + 16;
        ctx.fillStyle = COLORS.crosshairBg;
        // Clamp label so it never overflows left or right edge of the chart area
        const labelX = snapToDevicePx(Math.max(0, Math.min(w - tWidth, snappedX - tWidth / 2)));
        const labelY = snapToDevicePx(totalH);
        ctx.fillRect(labelX, labelY, tWidth, 20);
        ctx.fillStyle = COLORS.crosshairText;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(dateStr + '   ' + timeStr, labelX + tWidth / 2, labelY + 10);
    }

    if (!hidePriceScale && !timeOnly) {
        // Y-axis label - uses the active pane's own bounds
        if (!activeRect || !activePaneEntry) {
            ctx.restore();
            return;
        }
        const yMin = activePaneEntry.isMain ? bounds.pMin : activePaneEntry.yMin;
        const yMax = activePaneEntry.isMain ? bounds.pMax : activePaneEntry.yMax;
        const localY = _y - activeRect.y;
        const valueAtCursor = yMin + ((activeRect.h - localY) / activeRect.h) * (yMax - yMin);
        // const valueStr = activePaneEntry.isMain
        //     ? (Math.round(valueAtCursor * 4) / 4).toFixed(precision)
        //     : Math.abs(valueAtCursor) >= 1000
        //       ? `${(valueAtCursor / 1000).toFixed(1)}k`
        //       : valueAtCursor.toFixed(0);
        const valueStr = formatPrice(
            Math.round(valueAtCursor / crosshairTick) * crosshairTick,
            symbolInfo,
        );

        const pillY = snapToDevicePx(_y);
        ctx.fillStyle = COLORS.crosshairBg;
        ctx.fillRect(snapToDevicePx(w), pillY - 10, rightScaleWidth, 20);
        ctx.fillStyle = COLORS.crosshairText;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(valueStr, w + 6, pillY);
    }
    ctx.restore();
}

function drawPriceLabel(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    priceHistory: PriceHistory[],
    trades: TradePoint[],
    bounds: ViewBounds,
    w: number,
    h: number,
    chartSettings: ChartSettings,
    barNs: bigint,
    horizon: bigint = 0n,
    candleCache: CandleCache | null = null,
    bars:
        | {
              time: number;
              open: number;
              high: number;
              low: number;
              close: number;
              volume: number;
              bid?: number;
              ask?: number;
          }[]
        | null = null,
    openBar: any = null,
    yOffset: number = 0,
    transformer: LiveTransformer,
    dataLevel: DataLevel,
    symbolInfo?: SymbolInfo,
    rightScaleWidth: number = 0,
    priceTransition?: PriceTransition,
    now: number = 0,
): number[] {
    // Eased display value for a live price (last/bid/ask). Falls back to the raw
    // value when animation is off or unavailable, so positions/labels match.
    const animate = (key: string, value: number): number =>
        priceTransition
            ? priceTransition.value(key, value, now, chartSettings.animatePriceUpdates)
            : value;
    let price = null;
    let currPrice = null;

    let hasBidAsk = false;

    if (dataLevel === 'l3') {
        const idx = nearestIndex(priceHistory, bounds.tMax);
        if (idx === -1) return [];

        const hIdx = nearestIndex(priceHistory, horizon);
        if (hIdx === -1) return [];

        price = priceHistory[idx];
        currPrice = priceHistory[hIdx];
        hasBidAsk = true;
    } else if (dataLevel === 'ohlcv' && bars.length) {
        const tMaxMs = Number(bounds.tMax / 1_000_000n) - Number(barNs / 1_000_000n / 2n);
        const horizonMs = Number(horizon / 1_000_000n);
        let idx = 0;
        {
            let lo = 0,
                hi = bars.length - 1;
            while (lo <= hi) {
                const mid = (lo + hi) >>> 1;
                if (bars[mid].time < tMaxMs) lo = mid + 1;
                else hi = mid - 1;
            }
            idx = lo;
        }
        let hIdx = 0;
        {
            let lo = 0,
                hi = bars.length - 1;
            while (lo <= hi) {
                const mid = (lo + hi) >>> 1;
                if (bars[mid].time < horizonMs) lo = mid + 1;
                else hi = mid - 1;
            }
            hIdx = lo;
        }

        price = bars[Math.min(idx, bars.length - 1)];
        currPrice = bars[hIdx];

        if (bars[hIdx]?.bid && bars[hIdx]?.ask) {
            hasBidAsk = true;
        }
    }

    if (!price || !currPrice) return;

    const inPane = (y: number) => y >= yOffset && y <= yOffset + h;

    type Pill = {
        idealY: number; // The true mathematical price coordinate
        actualY: number; // The visual coordinate after dodging overlaps
        fillColor: string;
        textColor: string;
        label: string;
        filled: boolean;
    };
    const pills: Pill[] = [];

    if (hasBidAsk) {
        let ask = 0;
        let bid = 0;
        if (dataLevel === 'l3') {
            ask = currPrice.bestAsk;
            bid = currPrice.bestBid;
        } else if (dataLevel === 'ohlcv') {
            ask = currPrice?.ask;
            bid = currPrice?.bid;
        }
        const askDisp = animate('ask', ask);
        const bidDisp = animate('bid', bid);
        let askY = transformer.priceToY(askDisp, h);
        askY += yOffset;
        let bidY = transformer.priceToY(bidDisp, h);
        bidY += yOffset;

        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);

        if (inPane(askY) && chartSettings.showAskLine) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(0, yOffset, w, h);
            ctx.clip();
            ctx.beginPath();
            ctx.strokeStyle = COLORS.sellLine;
            ctx.moveTo(0, askY);
            ctx.lineTo(w, askY);
            ctx.stroke();
            ctx.restore();

            pills.push({
                idealY: askY,
                actualY: askY,
                fillColor: COLORS.sellLine,
                textColor: COLORS.crosshairBg,
                label: formatPrice(askDisp, symbolInfo),
                filled: true,
            });
        }

        if (inPane(bidY) && chartSettings.showBidLine) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(0, yOffset, w, h);
            ctx.clip();
            ctx.beginPath();
            ctx.strokeStyle = COLORS.buyLine;
            ctx.moveTo(0, bidY);
            ctx.lineTo(w, bidY);
            ctx.stroke();
            ctx.restore();

            pills.push({
                idealY: bidY,
                actualY: bidY,
                fillColor: COLORS.buyLine,
                textColor: COLORS.crosshairBg,
                label: formatPrice(bidDisp, symbolInfo),
                filled: true,
            });
        }
    }

    let lastCandle: { open: number; high: number; low: number; close: number } | null = null;
    if (barNs > 0n && chartSettings.priceLineVisible) {
        const cutTs = horizon > 0n ? horizon : bounds.tMax;
        const lastBarTs = (cutTs / barNs) * barNs;

        if (dataLevel === 'l3') {
            if (candleCache !== null) {
                for (let ts = lastBarTs; ts >= lastBarTs - barNs * 10n; ts -= barNs) {
                    const c = candleCache.get(ts);
                    if (c) {
                        lastCandle = c;
                        break;
                    }
                }
            } else if (nearestTradeIndex(trades, cutTs) >= 0) {
                const cutIdx = (() => {
                    let lo = 0,
                        hi = trades.length - 1,
                        r = trades.length;
                    while (lo <= hi) {
                        const mid = (lo + hi) >>> 1;
                        if (trades[mid].ts <= cutTs) lo = mid + 1;
                        else {
                            r = mid;
                            hi = mid - 1;
                        }
                    }
                    return r;
                })();
                const built = buildCandles(
                    cutIdx < trades.length ? trades.slice(0, cutIdx) : trades,
                    barNs,
                );
                if (built.length) lastCandle = built[built.length - 1];
            }
        } else if (dataLevel === 'ohlcv') {
            if (openBar) {
                lastCandle = {
                    open: openBar.open,
                    high: openBar.high,
                    low: openBar.low,
                    close: openBar.close,
                };
            }
        }

        if (lastCandle) {
            const closeDisp = animate('last', lastCandle.close);
            let priceY = transformer.priceToY(closeDisp, h);
            priceY += yOffset;

            if (inPane(priceY)) {
                const isUp = lastCandle.close >= lastCandle.open;
                const color = isUp
                    ? (chartSettings?.upBodyColor ?? '#00e676')
                    : (chartSettings?.downBodyColor ?? '#ff1744');

                ctx.save();
                ctx.beginPath();
                ctx.rect(0, yOffset, w, h);
                ctx.clip();
                ctx.lineWidth = 1;
                ctx.setLineDash([4, 4]);
                ctx.beginPath();
                ctx.strokeStyle = color;
                ctx.moveTo(0, priceY);
                ctx.lineTo(w, priceY);
                ctx.stroke();
                ctx.restore();

                pills.push({
                    idealY: priceY,
                    actualY: priceY,
                    fillColor: makeOpaque(color),
                    textColor: COLORS.crosshairBg,
                    label: formatPrice(closeDisp, symbolInfo),
                    filled: true,
                });
            }
        }
    }

    ctx.setLineDash([]);

    // historical prices (when scrolled back)
    if (dataLevel === 'l3') {
        if (price.ts < currPrice.ts) {
            let histAskY = transformer.priceToY(price.bestAsk, h);
            histAskY += yOffset;
            let histBidY = transformer.priceToY(price.bestBid, h);
            histBidY += yOffset;
            if (inPane(histAskY)) {
                pills.push({
                    idealY: histAskY,
                    actualY: histAskY,
                    fillColor: COLORS.sellLine,
                    textColor: COLORS.sellLine,
                    label: formatPrice(price.bestAsk, symbolInfo),
                    filled: false,
                });
            }
            if (inPane(histBidY)) {
                pills.push({
                    idealY: histBidY,
                    actualY: histBidY,
                    fillColor: COLORS.buyLine,
                    textColor: COLORS.buyLine,
                    label: formatPrice(price.bestBid, symbolInfo),
                    filled: false,
                });
            }
        }
    } else if (dataLevel === 'ohlcv') {
        if (price.time < currPrice.time) {
            if (hasBidAsk) {
                let histAskY = transformer.priceToY(price.ask, h);
                histAskY += yOffset;
                let histBidY = transformer.priceToY(price.bid, h);
                histBidY += yOffset;

                if (inPane(histAskY)) {
                    pills.push({
                        idealY: histAskY,
                        actualY: histAskY,
                        fillColor: COLORS.sellLine,
                        textColor: COLORS.sellLine,
                        label: formatPrice(price.ask, symbolInfo),
                        filled: false,
                    });
                }
                if (inPane(histBidY)) {
                    pills.push({
                        idealY: histBidY,
                        actualY: histBidY,
                        fillColor: COLORS.buyLine,
                        textColor: COLORS.buyLine,
                        label: formatPrice(price.bid, symbolInfo),
                        filled: false,
                    });
                }
            } else {
                let histPrice = transformer.priceToY(price.close, h);
                histPrice += yOffset;

                if (inPane(histPrice)) {
                    const isUp = price.close >= price.open;
                    const color = isUp
                        ? (chartSettings?.upBodyColor ?? '#00e676')
                        : (chartSettings?.downBodyColor ?? '#ff1744');
                    pills.push({
                        idealY: histPrice,
                        actualY: histPrice,
                        fillColor: makeOpaque(color),
                        textColor: makeOpaque(color),
                        label: formatPrice(price.close, symbolInfo),
                        filled: false,
                    });
                }
            }
        }
    }

    // 4. RELAXATION (1D Stack dodger)
    if (!chartSettings.allowLabelOverlap && pills.length > 1) {
        // Sort pills top-to-bottom
        pills.sort((a, b) => a.idealY - b.idealY);

        // Iterative force relaxation: run enough times so they settle smoothly
        for (let iter = 0; iter < 50; iter++) {
            for (let i = 0; i < pills.length - 1; i++) {
                const diff = pills[i + 1].actualY - pills[i].actualY;

                // If the vertical distance between them is less than the label height
                if (diff < LABEL_H) {
                    const overlap = LABEL_H - diff;
                    // Push them equally apart
                    pills[i].actualY -= overlap / 2;
                    pills[i + 1].actualY += overlap / 2;
                }
            }
        }
    }

    ctx.font = '500 11px "Inter"';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    // 5. Draw Finalised Pills
    pills.forEach((p) => {
        if (p.filled) {
            roundRect(ctx, w, p.actualY - 10, rightScaleWidth, LABEL_H, 3);
            ctx.fillStyle = p.fillColor;
            ctx.fill();
            // ctx.fillRect(w, p.actualY - 10, rightScaleWidth, LABEL_H);
        } else {
            // ctx.strokeStyle = p.fillColor;
            roundRect(ctx, w + 1, p.actualY - 10, rightScaleWidth - 2, LABEL_H, 3);
            ctx.fillStyle = chartSettings.axisBackgroundColor;
            ctx.strokeStyle = p.fillColor;
            ctx.fill();
            ctx.stroke();
            // ctx.strokeRect(w, p.actualY - 10, rightScaleWidth, LABEL_H);
        }

        ctx.fillStyle = p.textColor;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(p.label, w + 6, p.actualY);
    });

    // Return the final Y coordinates so drawDynamicLabels can dodge them
    return pills.map((p) => p.actualY);
}

export function drawTooltip(
    ctx: CanvasRenderingContext2D,
    mouse: { x: number; y: number },
    priceHistory: PriceHistory[],
    bounds: ViewBounds,
    w: number,
    h: number,
    transformer: LiveTransformer,
    symbolInfo?: SymbolInfo,
) {
    const tsAtMouse = transformer.xToTs(mouse.x, w);
    const idx = nearestIndex(priceHistory, tsAtMouse);
    if (idx === -1) return;

    const record = priceHistory[idx];
    const spread = record.bestAsk - record.bestBid;
    const lines = [
        `Time:   ${new Date(Number(record.ts / 1000000n)).toISOString().slice(11, 23)}`,
        `Ask:    ${formatPrice(record.bestAsk, symbolInfo)}`,
        `Bid:    ${formatPrice(record.bestBid, symbolInfo)}`,
        `Spread: ${formatPrice(spread, symbolInfo)}`,
    ];

    const boxW = 164;
    const boxH = lines.length * 18 + 16;
    const x = mouse.x + 15;
    const y = mouse.y - boxH / 2;

    ctx.fillStyle = 'rgba(20, 20, 20, 0.9)';
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1;
    ctx.fillRect(x, y, boxW, boxH);
    ctx.strokeRect(x, y, boxW, boxH);

    ctx.fillStyle = '#fff';
    ctx.font = '12px "Inter"';
    ctx.textAlign = 'left';
    lines.forEach((line, i) => {
        ctx.fillText(line, x + 10, y + 20 + i * 18);
    });
}

function drawPriceChart(
    ctx: CanvasRenderingContext2D,
    trades: TradePoint[],
    priceHistory: PriceHistory[],
    bounds: ViewBounds,
    w: number,
    h: number,
    chartType: ChartType,
    barNs: bigint,
    showBid: boolean,
    showAsk: boolean,
    showMid: boolean,
    showLastTrade: boolean,
    footprintBars: FootprintBar[] = [],
    chartSettings: ChartSettings,
    horizon: bigint = 0n,
    candleCache: CandleCache | null = null,
    openBar: { ts: bigint; open: number; high: number; low: number; close: number } | null = null,
    ohlcvBars: {
        time: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
    }[],
    transformer: LiveTransformer,
    dataLevel: DataLevel,
    symbolInfo?: SymbolInfo,
) {
    const hasBidAsk = dataLevel === 'ohlcv' && (ohlcvBars?.[0] as any)?.bid ? true : false;
    if (chartType === 'footprint') {
        drawFootprintChart(
            ctx,
            footprintBars,
            bounds,
            w,
            h,
            barNs,
            chartSettings.footprintMode,
            resolveTickSize(symbolInfo),
            chartSettings.footprintVolume,
            chartSettings,
            horizon,
            transformer,
        );
        if (showMid)
            drawMidLine(ctx, priceHistory, bounds, w, h, chartSettings, horizon, transformer);
        if (showLastTrade)
            drawLastTradeLine(ctx, trades, bounds, w, h, chartSettings, horizon, transformer);
        return;
    }
    if (chartType === 'candles') {
        drawCandleChart(
            ctx,
            trades,
            priceHistory,
            bounds,
            w,
            h,
            barNs,
            chartSettings,
            horizon,
            candleCache,
            openBar,
            ohlcvBars,
            transformer,
        );
        if (showMid)
            drawMidLine(ctx, priceHistory, bounds, w, h, chartSettings, horizon, transformer);
        if (showLastTrade)
            drawLastTradeLine(ctx, trades, bounds, w, h, chartSettings, horizon, transformer);
        return;
    }
    if (chartType === 'area') {
        if (hasBidAsk || dataLevel === 'l3') {
            if (showAsk)
                drawAreaChart(
                    ctx,
                    priceHistory,
                    bounds,
                    w,
                    h,
                    'ask',
                    chartSettings,
                    horizon,
                    barNs,
                    transformer,
                );
            if (showBid)
                drawAreaChart(
                    ctx,
                    priceHistory,
                    bounds,
                    w,
                    h,
                    'bid',
                    chartSettings,
                    horizon,
                    barNs,
                    transformer,
                );
        } else {
            if (dataLevel === 'ohlcv') {
                drawAreaChart(
                    ctx,
                    priceHistory,
                    bounds,
                    w,
                    h,
                    'price',
                    chartSettings,
                    horizon,
                    barNs,
                    transformer,
                    ohlcvBars,
                    openBar,
                );
            } else {
                //implement other data levels...
            }
        }
        if (showMid)
            drawMidLine(ctx, priceHistory, bounds, w, h, chartSettings, horizon, transformer);
        if (showLastTrade)
            drawLastTradeLine(ctx, trades, bounds, w, h, chartSettings, horizon, transformer);
        return;
    }
    if (chartType === 'line') {
        if (hasBidAsk || dataLevel === 'l3') {
            if (showBid)
                drawSmoothLine(
                    ctx,
                    priceHistory,
                    bounds,
                    w,
                    h,
                    COLORS.buyLine,
                    'bid',
                    chartSettings,
                    horizon,
                    barNs,
                    transformer,
                );
            if (showAsk)
                drawSmoothLine(
                    ctx,
                    priceHistory,
                    bounds,
                    w,
                    h,
                    COLORS.sellLine,
                    'ask',
                    chartSettings,
                    horizon,
                    barNs,
                    transformer,
                );
        } else {
            if (dataLevel === 'ohlcv') {
                drawSmoothLine(
                    ctx,
                    priceHistory,
                    bounds,
                    w,
                    h,
                    '#1190b0',
                    'price',
                    chartSettings,
                    horizon,
                    barNs,
                    transformer,
                    ohlcvBars,
                    openBar,
                );
            } else {
                //implement rest ...
            }
        }
        if (showMid)
            drawMidLine(ctx, priceHistory, bounds, w, h, chartSettings, horizon, transformer);
        if (showLastTrade)
            drawLastTradeLine(ctx, trades, bounds, w, h, chartSettings, horizon, transformer);
        return;
    }
    if (chartType === 'hollow' || chartType === 'heikin-ashi' || chartType === 'bars') {
        if (barNs === 0n) {
            // OHLC types need a bar size; with none, fall back to bid/ask lines.
            if (dataLevel === 'l3' || hasBidAsk) {
                if (showBid)
                    drawTradeLine(
                        ctx,
                        priceHistory,
                        bounds,
                        w,
                        h,
                        COLORS.buyLine,
                        'bid',
                        chartSettings,
                        horizon,
                        0n,
                        transformer,
                    );
                if (showAsk)
                    drawTradeLine(
                        ctx,
                        priceHistory,
                        bounds,
                        w,
                        h,
                        COLORS.sellLine,
                        'ask',
                        chartSettings,
                        horizon,
                        0n,
                        transformer,
                    );
            }
        } else {
            let candles = aggregateCandles(
                trades,
                bounds,
                barNs,
                horizon,
                candleCache,
                openBar,
                ohlcvBars,
                transformer,
            );
            if (chartType === 'heikin-ashi') candles = toHeikinAshi(candles);
            if (chartType === 'bars') {
                drawBarChart(ctx, candles, w, h, chartSettings, transformer);
            } else {
                renderCandleGeometry(
                    ctx,
                    candles,
                    w,
                    h,
                    chartSettings,
                    transformer,
                    chartType === 'hollow',
                );
            }
        }
        if (showMid)
            drawMidLine(ctx, priceHistory, bounds, w, h, chartSettings, horizon, transformer);
        if (showLastTrade)
            drawLastTradeLine(ctx, trades, bounds, w, h, chartSettings, horizon, transformer);
        return;
    }
    if (chartType === 'baseline') {
        if (hasBidAsk || dataLevel === 'l3') {
            // Single-series chart: prefer the bid, falling back to the ask.
            const baselineSide = showBid || !showAsk ? 'bid' : 'ask';
            drawBaselineChart(
                ctx,
                priceHistory,
                bounds,
                w,
                h,
                baselineSide,
                chartSettings,
                horizon,
                barNs,
                transformer,
            );
        } else if (dataLevel === 'ohlcv') {
            drawBaselineChart(
                ctx,
                priceHistory,
                bounds,
                w,
                h,
                'price',
                chartSettings,
                horizon,
                barNs,
                transformer,
                ohlcvBars,
                openBar,
            );
        }
        if (showMid)
            drawMidLine(ctx, priceHistory, bounds, w, h, chartSettings, horizon, transformer);
        if (showLastTrade)
            drawLastTradeLine(ctx, trades, bounds, w, h, chartSettings, horizon, transformer);
        return;
    }
    if (isOrdinalChartType(chartType)) {
        const model = getOrdinalModel(
            chartType,
            chartSettings,
            ohlcvBars,
            candleCache,
            trades,
            barNs,
        );
        if (model) {
            if (chartType === 'renko')
                drawRenko(ctx, model, bounds, w, h, chartSettings, horizon, transformer);
            else if (chartType === 'kagi')
                drawKagi(ctx, model, bounds, w, h, chartSettings, horizon, transformer);
            else drawLineBreak(ctx, model, bounds, w, h, chartSettings, horizon, transformer);
        }
        if (showMid)
            drawMidLine(ctx, priceHistory, bounds, w, h, chartSettings, horizon, transformer);
        if (showLastTrade)
            drawLastTradeLine(ctx, trades, bounds, w, h, chartSettings, horizon, transformer);
        return;
    }

    //step line
    // doesnt need an if.. I could add one but why
    // it acts as a nice fallback if something strange happens
    if (dataLevel === 'l3' || hasBidAsk) {
        if (showBid) {
            drawTradeLine(
                ctx,
                priceHistory,
                bounds,
                w,
                h,
                COLORS.buyLine,
                'bid',
                chartSettings,
                horizon,
                barNs,
                transformer,
            );
        }
        if (showAsk) {
            drawTradeLine(
                ctx,
                priceHistory,
                bounds,
                w,
                h,
                COLORS.sellLine,
                'ask',
                chartSettings,
                horizon,
                barNs,
                transformer,
            );
        }
    } else {
        drawTradeLine(
            ctx,
            priceHistory,
            bounds,
            w,
            h,
            '#1190b0',
            'price',
            chartSettings,
            horizon,
            barNs,
            transformer,
            ohlcvBars,
            openBar,
        );
    }
    if (showMid) drawMidLine(ctx, priceHistory, bounds, w, h, chartSettings, horizon, transformer);
    if (showLastTrade)
        drawLastTradeLine(ctx, trades, bounds, w, h, chartSettings, horizon, transformer);
}

function drawSmoothLine(
    ctx: CanvasRenderingContext2D,
    priceHistory: PriceHistory[],
    bounds: ViewBounds,
    w: number,
    h: number,
    color: string,
    side: 'bid' | 'ask' | 'price',
    chartSettings: ChartSettings,
    horizon: bigint = 0n,
    barNs: bigint,
    transformer: LiveTransformer,
    ohlcvBars?: {
        time: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
    }[],
    openBar?: any,
) {
    const tsToXFn = transformer.makeTsToXFn(w);
    const priceToYFn = transformer.makePriceToYFn(h);

    if (side === 'price') {
        if (!ohlcvBars.length) return;
        const cutTs = Number(((horizon / barNs) * barNs) / 1_000_000n);
        const target = Number(bounds.tMin / 1_000_000n);

        let lo = 0;
        let hi = ohlcvBars.length - 1;
        let result = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            if (ohlcvBars[mid].time <= target) {
                result = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        const startIdx = result;

        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.lineJoin = 'round';
        let first = true;
        for (let i = startIdx; i < ohlcvBars.length; i++) {
            if (ohlcvBars[i].time >= cutTs) break;
            const val = ohlcvBars[i].close;
            if (val === 0) continue;
            const x = tsToXFn(BigInt(ohlcvBars[i].time * 1_000_000));
            const y = priceToYFn(val);
            if (first) {
                ctx.moveTo(x, y);
                first = false;
            } else ctx.lineTo(x, y);
            if (x > w + 100) break;
        }
        ctx.lineTo(tsToXFn(openBar.ts), priceToYFn(openBar.close));
        ctx.stroke();
    } else {
        if (priceHistory.length === 0) return;
        const cutTs = horizon > 0n ? horizon : bounds.tMax;
        const startIdx = Math.max(0, floorIndex(priceHistory, bounds.tMin));
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.lineJoin = 'round';
        let first = true;
        for (let i = startIdx; i < priceHistory.length; i++) {
            if (priceHistory[i].ts > cutTs) break;
            const val = side === 'ask' ? priceHistory[i].bestAsk : priceHistory[i].bestBid;
            if (val === 0) continue;
            const x = tsToXFn(priceHistory[i].ts);
            const y = priceToYFn(val);
            if (first) {
                ctx.moveTo(x, y);
                first = false;
            } else ctx.lineTo(x, y);
            if (x > w + 100) break;
        }
        ctx.stroke();
    }
}

function drawAreaChart(
    ctx: CanvasRenderingContext2D,
    priceHistory: PriceHistory[],
    bounds: ViewBounds,
    w: number,
    h: number,
    side: 'bid' | 'ask' | 'price',
    chartSettings: ChartSettings,
    horizon: bigint = 0n,
    barNs: bigint,
    transformer: LiveTransformer,
    ohlcvBars?: {
        time: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
    }[],
    openBar?: any,
) {
    const tsToXFn = transformer.makeTsToXFn(w);
    const priceToYFn = transformer.makePriceToYFn(h);

    if (side === 'price') {
        if (!ohlcvBars.length) return;
        const cutTs = Number(((horizon / barNs) * barNs) / 1_000_000n);
        const lineColor = '#1190b0';
        let lo = 0;
        let hi = ohlcvBars.length - 1;
        let result = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            if (ohlcvBars[mid].time <= Number(bounds.tMin / 1_000_000n)) {
                result = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        const startIdx = Math.max(0, result);

        const pts: { x: number; y: number }[] = [];
        for (let i = startIdx; i < ohlcvBars.length; i++) {
            if (ohlcvBars[i].time >= cutTs) break;
            const val = ohlcvBars[i].close;
            if (val === 0) continue;
            pts.push({
                x: tsToXFn(BigInt(ohlcvBars[i].time * 1_000_000)),
                y: priceToYFn(val),
            });
            if (pts[pts.length - 1].x > w + 100) break;
        }
        if (openBar) {
            pts.push({
                x: tsToXFn(openBar.ts),
                y: priceToYFn(openBar.close),
            });
        }
        if (pts.length < 2) return;

        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, '#1190b0' + '55');
        grad.addColorStop(1, '#1190b0' + '00');

        ctx.beginPath();
        ctx.moveTo(pts[0].x, h);
        for (const p of pts) ctx.lineTo(p.x, p.y);
        ctx.lineTo(pts[pts.length - 1].x, h);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();

        ctx.beginPath();
        ctx.strokeStyle = lineColor + 'cc';
        ctx.lineWidth = 1.5;
        ctx.lineJoin = 'round';
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
    } else {
        if (priceHistory.length === 0) return;
        const cutTs = horizon > 0n ? horizon : bounds.tMax;
        const isBid = side === 'bid';
        const lineColor = isBid ? '#00e676' : '#ff1744';
        const startIdx = Math.max(0, floorIndex(priceHistory, bounds.tMin));

        // Collect visible points
        const pts: { x: number; y: number }[] = [];
        for (let i = startIdx; i < priceHistory.length; i++) {
            if (priceHistory[i].ts > cutTs) break;
            const val = isBid ? priceHistory[i].bestBid : priceHistory[i].bestAsk;
            if (val === 0) continue;
            pts.push({
                x: tsToXFn(priceHistory[i].ts),
                y: priceToYFn(val),
            });
            if (pts[pts.length - 1].x > w + 100) break;
        }
        if (pts.length < 2) return;

        // Gradient: line color at top, transparent at bottom
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, '#1190b0' + '55');
        grad.addColorStop(1, '#1190b0' + '00');

        // Filled area
        ctx.beginPath();
        ctx.moveTo(pts[0].x, h);
        for (const p of pts) ctx.lineTo(p.x, p.y);
        ctx.lineTo(pts[pts.length - 1].x, h);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();

        // Line on top
        ctx.beginPath();
        ctx.strokeStyle = lineColor + 'cc';
        ctx.lineWidth = 1.5;
        ctx.lineJoin = 'round';
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
    }
}

function drawCandleChart(
    ctx: CanvasRenderingContext2D,
    trades: TradePoint[],
    priceHistory: PriceHistory[],
    bounds: ViewBounds,
    w: number,
    h: number,
    barNs: bigint,
    chartSettings: ChartSettings,
    horizon: bigint = 0n,
    candleCache: CandleCache | null = null,
    openBar: { ts: bigint; open: number; high: number; low: number; close: number } | null = null,
    ohlcvBars: {
        time: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
    }[],
    transformer: LiveTransformer,
) {
    if (barNs === 0n) {
        drawTradeLine(
            ctx,
            priceHistory,
            bounds,
            w,
            h,
            COLORS.buyLine,
            'bid',
            chartSettings,
            horizon,
            0n,
            transformer,
        );
        drawTradeLine(
            ctx,
            priceHistory,
            bounds,
            w,
            h,
            COLORS.sellLine,
            'ask',
            chartSettings,
            horizon,
            0n,
            transformer,
        );
        return;
    }

    const sessionMapper = transformer.getSessionMapper();
    const barPx = transformer.getBarPx(w);
    const dpr = getEffectiveDpr();
    // Uniform body width as a whole device-pixel count, so every body edge lands
    // on a real pixel (no anti-aliased half-pixel seams) and all candles read the
    // same width regardless of zoom. `bodyWCss` is what we draw with; `halfBody`
    // is only kept for the off-screen cull below.
    const bodyWDev = Math.max(1, Math.round(barPx * 0.8 * dpr));
    const bodyWCss = bodyWDev / dpr;
    const halfBody = bodyWCss / 2;

    // Style constants (computed once)
    const upBodyColor = chartSettings?.upBodyColor ?? '#00e676';
    const downBodyColor = chartSettings?.downBodyColor ?? '#ff1744';
    const upWickColor = chartSettings?.wickColorMatchesBody
        ? upBodyColor
        : (chartSettings?.upWickColor ?? '#00e676aa');
    const downWickColor = chartSettings?.wickColorMatchesBody
        ? downBodyColor
        : (chartSettings?.downWickColor ?? '#ff1744aa');
    const borderWidth = chartSettings?.borderWidth ?? 1;
    const upBorderColor = chartSettings?.borderColorMatchesBody
        ? upBodyColor
        : (chartSettings?.upBorderColor ?? '#00e676');
    const downBorderColor = chartSettings?.borderColorMatchesBody
        ? downBodyColor
        : (chartSettings?.downBorderColor ?? '#ff1744');
    const wickWidth = chartSettings?.wickWidth ?? 1;

    // Geometry buckets (up / down)
    // "top" buckets are drawn after regular ones so the last (potentially
    // partial) bar of a session always appears on top of the first bar of the
    type Geom = {
        left: number;
        wickX: number;
        yHigh: number;
        yLow: number;
        bodyTop: number;
        bodyH: number;
        hasWick: boolean;
    };
    const upGeom: Geom[] = [];
    const downGeom: Geom[] = [];

    // Pre-bake coordinate transforms once per frame - avoids recomputing mMin/mMax/scale
    // and re-running segment binary searches for every single candle.
    const tsToXFn = transformer.makeTsToXFn(w);
    const priceToYFn = transformer.makePriceToYFn(h);

    const collectCandle = (
        c: { open: number; high: number; low: number; close: number },
        barTs: bigint,
    ) => {
        const rawX = tsToXFn(barTs);
        if (rawX < -halfBody || rawX > w + halfBody * 2) return;
        // Snap the body's left edge to a whole device pixel (crisp fill), then
        // center the wick within the snapped body on the correct sub-pixel for a
        // crisp stroke. Body top/bottom are snapped to whole pixels too.
        const leftDev = Math.round(rawX * dpr - bodyWDev / 2);
        const left = leftDev / dpr;
        const wickX = snapStroke((leftDev + bodyWDev / 2) / dpr, wickWidth, dpr);
        const yTop = snapEdge(Math.min(priceToYFn(c.open), priceToYFn(c.close)), dpr);
        const yBot = snapEdge(Math.max(priceToYFn(c.open), priceToYFn(c.close)), dpr);
        const bucket: Geom = {
            left,
            wickX,
            yHigh: priceToYFn(c.high),
            yLow: priceToYFn(c.low),
            bodyTop: yTop,
            bodyH: Math.max(1 / dpr, yBot - yTop),
            hasWick: c.high !== c.low,
        };
        (c.close >= c.open ? upGeom : downGeom).push(bucket);
    };

    // Collect: fast path (ohlcv bars or cache)
    if (ohlcvBars.length) {
        const cutTs = horizon > 0n ? (horizon / barNs) * barNs : bounds.tMax;
        const openBarTs = openBar ? openBar.ts : -1n;

        // Pre-compute thresholds in ms (Number) so the hot loop is BigInt-free.
        const cutMs = Number(cutTs / 1_000_000n);
        const openBarTsMs = openBarTs > 0n ? Number(openBarTs / 1_000_000n) : -1;

        // Pre-convert segment boundaries to ms once; all inner-loop comparisons
        // stay as Number - BigInt ops are ~10-100x slower than float ops.
        type SegMs = { startMs: number; endMs: number };
        const segsMs: SegMs[] | null =
            sessionMapper && sessionMapper.hasSession
                ? sessionMapper.segments.map((s) => ({
                      startMs: Number(s.realStart / 1_000_000n),
                      endMs: Number(s.realEnd / 1_000_000n),
                  }))
                : null;
        const barNsMs = Number(barNs / 1_000_000n);

        const segForTsMs = (tsMs: number): SegMs | undefined => {
            if (!segsMs) return undefined;
            let lo = 0,
                hi = segsMs.length - 1;
            while (lo <= hi) {
                const mid = (lo + hi) >>> 1;
                if (segsMs[mid].endMs <= tsMs) lo = mid + 1;
                else if (segsMs[mid].startMs > tsMs) hi = mid - 1;
                else return segsMs[mid];
            }
            return undefined;
        };

        // ohlcvBars may arrive at a finer resolution than barNs (e.g. 1-min bars
        // on a 7-min chart).  Aggregate on the fly into session-anchored barNs
        // buckets so every candle center lands exactly on a grid line.
        // Map key: bucket start in ms (Number) - avoids BigInt hash overhead.
        type AggBucket = { open: number; high: number; low: number; close: number; volume: number };
        const bucketMap = new Map<number, AggBucket>();
        const bucketOrderMs: number[] = [];

        // Binary search: skip bars before the visible window.
        // Include one barNs of look-back so the bucket straddling tMin gets the
        // correct open price from its first input bar.
        const tMinMs = Number((bounds.tMin > barNs ? bounds.tMin - barNs : 0n) / 1_000_000n);
        let startIdx = 0;
        {
            let lo = 0,
                hi = ohlcvBars.length - 1;
            while (lo <= hi) {
                const mid = (lo + hi) >>> 1;
                if (ohlcvBars[mid].time < tMinMs) lo = mid + 1;
                else hi = mid - 1;
            }
            startIdx = lo;
        }

        // Upper bound: tMax + one bar so the last visible bucket gets all its input bars,
        // but we never scan the entire loaded history when horizon/cutMs is in the future.
        const viewEndMs = Number((bounds.tMax + barNs) / 1_000_000n);
        const loopEndMs = Math.min(cutMs, viewEndMs);

        for (let i = startIdx; i < ohlcvBars.length; i++) {
            const bar = ohlcvBars[i];
            const tsMs = bar.time; // already Number ms - no BigInt conversion needed
            if (tsMs >= loopEndMs) break;

            let bucketMs: number;
            const seg = segForTsMs(tsMs);
            if (seg) {
                // Session-anchored bucket: floor offset from session open to barNs boundary
                bucketMs = seg.startMs + Math.floor((tsMs - seg.startMs) / barNsMs) * barNsMs;
            } else {
                // Outside session or no session - epoch-aligned fallback
                bucketMs = Math.floor(tsMs / barNsMs) * barNsMs;
            }

            const existing = bucketMap.get(bucketMs);
            if (!existing) {
                bucketMap.set(bucketMs, {
                    open: bar.open,
                    high: bar.high,
                    low: bar.low,
                    close: bar.close,
                    volume: bar.volume,
                });
                bucketOrderMs.push(bucketMs);
            } else {
                if (bar.high > existing.high) existing.high = bar.high;
                if (bar.low < existing.low) existing.low = bar.low;
                existing.close = bar.close;
                existing.volume += bar.volume;
            }
        }

        // Convert bucket ms keys back to BigInt only for the visible set (<= screen width bars)
        for (const bucketMs of bucketOrderMs) {
            const bucketTs = BigInt(bucketMs) * 1_000_000n;
            if (bucketMs === openBarTsMs && openBar) {
                collectCandle(openBar, bucketTs);
            } else {
                const b = bucketMap.get(bucketMs)!;
                collectCandle(b, bucketTs);
            }
        }

        // If openBar starts after the last ohlcvBar (e.g. first tick of a new bar)
        if (openBar && openBarTsMs !== -1) {
            const lastBucketMs =
                bucketOrderMs.length > 0 ? bucketOrderMs[bucketOrderMs.length - 1] : -1;
            if (lastBucketMs < openBarTsMs && openBarTsMs < Number(horizon / 1_000_000n)) {
                collectCandle(openBar, openBarTs);
            }
        }
    }
    if (candleCache !== null) {
        const cutTs = horizon > 0n ? horizon : bounds.tMax;
        const openBarTs = openBar ? openBar.ts : -1n;
        const firstBar = (bounds.tMin / barNs) * barNs;
        const lastBar = (cutTs / barNs) * barNs;

        if (sessionMapper && sessionMapper.hasSession) {
            for (const seg of sessionMapper['segments']) {
                if (seg.realEnd < bounds.tMin || seg.realStart >= cutTs) continue;
                // Anchor bar grid to session open so bars match grid lines and crosshair.
                const clampedStart = bounds.tMin > seg.realStart ? bounds.tMin : seg.realStart;
                const offsetInSeg = clampedStart - seg.realStart;
                const segFrom = seg.realStart + (offsetInSeg / barNs) * barNs;
                const segTo = cutTs < seg.realEnd ? cutTs : seg.realEnd;
                for (let barTs = segFrom; barTs < segTo; barTs += barNs) {
                    if (barTs + barNs === openBarTs && openBar) {
                        // collectCandle(openBar, barTs);
                    } else {
                        const c = candleCache.get(barTs);
                        if (c) collectCandle(c, barTs);
                    }
                }
            }
        } else {
            for (let barTs = firstBar; barTs <= lastBar; barTs += barNs) {
                if (barTs === openBarTs && openBar) {
                    collectCandle(openBar, barTs);
                } else {
                    const c = candleCache.get(barTs);
                    if (c) collectCandle(c, barTs);
                }
            }
        }
    } else {
        // Collect: slow path (build from trades)
        const cutTs = horizon > 0n ? horizon : bounds.tMax;
        let tradeEnd = trades.length;
        {
            let lo = 0,
                hi = trades.length - 1;
            while (lo <= hi) {
                const mid = (lo + hi) >>> 1;
                if (trades[mid].ts < cutTs) lo = mid + 1;
                else {
                    tradeEnd = mid;
                    hi = mid - 1;
                }
            }
        }
        const visibleTrades = tradeEnd < trades.length ? trades.slice(0, tradeEnd) : trades;
        const candles = buildCandles(visibleTrades, barNs);
        for (const c of candles) {
            if (c.ts + barNs < bounds.tMin || c.ts > bounds.tMax) continue;
            collectCandle(c, c.ts);
        }
    }

    // Batched draw: wicks -> bodies -> borders
    // Wicks first so bodies paint over the body-height portion of each wick.
    // "top" geoms (last bar of each session) are drawn after regular geoms so
    // they are never covered by the first bar of the next session.
    //
    for (const [geoms, color] of [
        [upGeom, upWickColor],
        [downGeom, downWickColor],
    ] as [Geom[], string][]) {
        if (!geoms.length) continue;
        ctx.strokeStyle = color;
        ctx.lineWidth = deviceLineWidth(wickWidth, dpr);
        ctx.beginPath();
        for (const g of geoms) {
            if (g.hasWick) {
                //top wick
                ctx.moveTo(g.wickX, g.yHigh);
                ctx.lineTo(g.wickX, g.bodyTop);

                ctx.moveTo(g.wickX, g.bodyTop + g.bodyH);
                ctx.lineTo(g.wickX, g.yLow);
            }
        }
        ctx.stroke();
    }

    for (const [geoms, color] of [
        [upGeom, upBodyColor],
        [downGeom, downBodyColor],
    ] as [Geom[], string][]) {
        if (!geoms.length) continue;
        ctx.fillStyle = color;
        ctx.beginPath();
        for (const g of geoms) {
            ctx.rect(g.left, g.bodyTop, bodyWCss, g.bodyH);
        }
        ctx.fill();
    }
    if (borderWidth > 0) {
        const bwCss = deviceLineWidth(borderWidth, dpr);
        for (const [geoms, color] of [
            [upGeom, upBorderColor],
            [downGeom, downBorderColor],
        ] as [Geom[], string][]) {
            if (!geoms.length) continue;
            ctx.strokeStyle = color;
            ctx.lineWidth = bwCss;
            ctx.beginPath();
            for (const g of geoms) {
                ctx.rect(
                    g.left + bwCss / 2,
                    g.bodyTop + bwCss / 2,
                    bodyWCss - bwCss,
                    g.bodyH - bwCss,
                );
            }
            ctx.stroke();
        }
    }
}

// A single aggregated OHLC bar in chronological order.
type AggCandle = { ts: bigint; open: number; high: number; low: number; close: number };

/**
 * Aggregate the visible range into session-anchored OHLC buckets, returned in
 * chronological order. Mirrors the bucketing inside drawCandleChart but yields
 * raw candles so the non-standard OHLC chart types (bars, Heikin-Ashi, hollow)
 * can share one source of truth instead of re-deriving their own buckets.
 */
function aggregateCandles(
    trades: TradePoint[],
    bounds: ViewBounds,
    barNs: bigint,
    horizon: bigint,
    candleCache: CandleCache | null,
    openBar: { ts: bigint; open: number; high: number; low: number; close: number } | null,
    ohlcvBars: {
        time: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
    }[],
    transformer: LiveTransformer,
): AggCandle[] {
    const out: AggCandle[] = [];
    if (barNs === 0n) return out;
    const sessionMapper = transformer.getSessionMapper();

    if (ohlcvBars.length) {
        const cutTs = horizon > 0n ? (horizon / barNs) * barNs : bounds.tMax;
        const openBarTs = openBar ? openBar.ts : -1n;
        const cutMs = Number(cutTs / 1_000_000n);
        const openBarTsMs = openBarTs > 0n ? Number(openBarTs / 1_000_000n) : -1;

        type SegMs = { startMs: number; endMs: number };
        const segsMs: SegMs[] | null =
            sessionMapper && sessionMapper.hasSession
                ? sessionMapper.segments.map((s) => ({
                      startMs: Number(s.realStart / 1_000_000n),
                      endMs: Number(s.realEnd / 1_000_000n),
                  }))
                : null;
        const barNsMs = Number(barNs / 1_000_000n);

        const segForTsMs = (tsMs: number): SegMs | undefined => {
            if (!segsMs) return undefined;
            let lo = 0,
                hi = segsMs.length - 1;
            while (lo <= hi) {
                const mid = (lo + hi) >>> 1;
                if (segsMs[mid].endMs <= tsMs) lo = mid + 1;
                else if (segsMs[mid].startMs > tsMs) hi = mid - 1;
                else return segsMs[mid];
            }
            return undefined;
        };

        type AggBucket = { open: number; high: number; low: number; close: number };
        const bucketMap = new Map<number, AggBucket>();
        const bucketOrderMs: number[] = [];

        const tMinMs = Number((bounds.tMin > barNs ? bounds.tMin - barNs : 0n) / 1_000_000n);
        let startIdx = 0;
        {
            let lo = 0,
                hi = ohlcvBars.length - 1;
            while (lo <= hi) {
                const mid = (lo + hi) >>> 1;
                if (ohlcvBars[mid].time < tMinMs) lo = mid + 1;
                else hi = mid - 1;
            }
            startIdx = lo;
        }

        const viewEndMs = Number((bounds.tMax + barNs) / 1_000_000n);
        const loopEndMs = Math.min(cutMs, viewEndMs);

        for (let i = startIdx; i < ohlcvBars.length; i++) {
            const bar = ohlcvBars[i];
            const tsMs = bar.time;
            if (tsMs >= loopEndMs) break;

            let bucketMs: number;
            const seg = segForTsMs(tsMs);
            if (seg) {
                bucketMs = seg.startMs + Math.floor((tsMs - seg.startMs) / barNsMs) * barNsMs;
            } else {
                bucketMs = Math.floor(tsMs / barNsMs) * barNsMs;
            }

            const existing = bucketMap.get(bucketMs);
            if (!existing) {
                bucketMap.set(bucketMs, {
                    open: bar.open,
                    high: bar.high,
                    low: bar.low,
                    close: bar.close,
                });
                bucketOrderMs.push(bucketMs);
            } else {
                if (bar.high > existing.high) existing.high = bar.high;
                if (bar.low < existing.low) existing.low = bar.low;
                existing.close = bar.close;
            }
        }

        for (const bucketMs of bucketOrderMs) {
            const bucketTs = BigInt(bucketMs) * 1_000_000n;
            if (bucketMs === openBarTsMs && openBar) {
                out.push({
                    ts: bucketTs,
                    open: openBar.open,
                    high: openBar.high,
                    low: openBar.low,
                    close: openBar.close,
                });
            } else {
                const b = bucketMap.get(bucketMs)!;
                out.push({ ts: bucketTs, open: b.open, high: b.high, low: b.low, close: b.close });
            }
        }

        if (openBar && openBarTsMs !== -1) {
            const lastBucketMs =
                bucketOrderMs.length > 0 ? bucketOrderMs[bucketOrderMs.length - 1] : -1;
            if (lastBucketMs < openBarTsMs && openBarTsMs < Number(horizon / 1_000_000n)) {
                out.push({
                    ts: openBarTs,
                    open: openBar.open,
                    high: openBar.high,
                    low: openBar.low,
                    close: openBar.close,
                });
            }
        }
    } else if (candleCache !== null) {
        const cutTs = horizon > 0n ? horizon : bounds.tMax;
        const openBarTs = openBar ? openBar.ts : -1n;
        const firstBar = (bounds.tMin / barNs) * barNs;
        const lastBar = (cutTs / barNs) * barNs;

        const push = (c: { open: number; high: number; low: number; close: number }, ts: bigint) =>
            out.push({ ts, open: c.open, high: c.high, low: c.low, close: c.close });

        if (sessionMapper && sessionMapper.hasSession) {
            for (const seg of sessionMapper.segments) {
                if (seg.realEnd < bounds.tMin || seg.realStart >= cutTs) continue;
                const clampedStart = bounds.tMin > seg.realStart ? bounds.tMin : seg.realStart;
                const offsetInSeg = clampedStart - seg.realStart;
                const segFrom = seg.realStart + (offsetInSeg / barNs) * barNs;
                const segTo = cutTs < seg.realEnd ? cutTs : seg.realEnd;
                for (let barTs = segFrom; barTs < segTo; barTs += barNs) {
                    const c = candleCache.get(barTs);
                    if (c) push(c, barTs);
                }
            }
        } else {
            for (let barTs = firstBar; barTs <= lastBar; barTs += barNs) {
                if (barTs === openBarTs && openBar) push(openBar, barTs);
                else {
                    const c = candleCache.get(barTs);
                    if (c) push(c, barTs);
                }
            }
        }
    } else {
        const cutTs = horizon > 0n ? horizon : bounds.tMax;
        let tradeEnd = trades.length;
        {
            let lo = 0,
                hi = trades.length - 1;
            while (lo <= hi) {
                const mid = (lo + hi) >>> 1;
                if (trades[mid].ts < cutTs) lo = mid + 1;
                else {
                    tradeEnd = mid;
                    hi = mid - 1;
                }
            }
        }
        const visibleTrades = tradeEnd < trades.length ? trades.slice(0, tradeEnd) : trades;
        for (const c of buildCandles(visibleTrades, barNs)) {
            if (c.ts + barNs < bounds.tMin || c.ts > bounds.tMax) continue;
            out.push({ ts: c.ts, open: c.open, high: c.high, low: c.low, close: c.close });
        }
    }

    return out;
}

/**
 * Convert raw OHLC candles to Heikin-Ashi candles. Each HA bar is derived from
 * the previous HA bar, so the input must be chronological (aggregateCandles is).
 */
function toHeikinAshi(candles: AggCandle[]): AggCandle[] {
    const out: AggCandle[] = [];
    let prevOpen = 0;
    let prevClose = 0;
    for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        const haClose = (c.open + c.high + c.low + c.close) / 4;
        const haOpen = i === 0 ? (c.open + c.close) / 2 : (prevOpen + prevClose) / 2;
        const haHigh = Math.max(c.high, haOpen, haClose);
        const haLow = Math.min(c.low, haOpen, haClose);
        out.push({ ts: c.ts, open: haOpen, high: haHigh, low: haLow, close: haClose });
        prevOpen = haOpen;
        prevClose = haClose;
    }
    return out;
}

/**
 * Draw a list of candles (wicks -> bodies -> borders). Shared by the candles,
 * Heikin-Ashi and hollow chart types. In `hollow` mode only down candles are
 * filled and every body is outlined, so up candles read as hollow rectangles.
 */
function renderCandleGeometry(
    ctx: CanvasRenderingContext2D,
    candles: AggCandle[],
    w: number,
    h: number,
    chartSettings: ChartSettings,
    transformer: LiveTransformer,
    hollow = false,
) {
    if (!candles.length) return;

    const barPx = transformer.getBarPx(w);
    const dpr = getEffectiveDpr();
    // Uniform body width in whole device pixels so edges stay crisp at any zoom/DPR.
    const bodyWDev = Math.max(1, Math.round(barPx * 0.8 * dpr));
    const bodyWCss = bodyWDev / dpr;
    const halfBody = bodyWCss / 2;
    const tsToXFn = transformer.makeTsToXFn(w);
    const priceToYFn = transformer.makePriceToYFn(h);

    const upBodyColor = chartSettings?.upBodyColor ?? '#00e676';
    const downBodyColor = chartSettings?.downBodyColor ?? '#ff1744';
    const upWickColor = chartSettings?.wickColorMatchesBody
        ? upBodyColor
        : (chartSettings?.upWickColor ?? '#00e676aa');
    const downWickColor = chartSettings?.wickColorMatchesBody
        ? downBodyColor
        : (chartSettings?.downWickColor ?? '#ff1744aa');
    const borderWidth = chartSettings?.borderWidth ?? 1;
    const upBorderColor = chartSettings?.borderColorMatchesBody
        ? upBodyColor
        : (chartSettings?.upBorderColor ?? '#00e676');
    const downBorderColor = chartSettings?.borderColorMatchesBody
        ? downBodyColor
        : (chartSettings?.downBorderColor ?? '#ff1744');
    const wickWidth = chartSettings?.wickWidth ?? 1;

    type Geom = {
        left: number;
        wickX: number;
        yHigh: number;
        yLow: number;
        bodyTop: number;
        bodyH: number;
        hasWick: boolean;
    };
    const upGeom: Geom[] = [];
    const downGeom: Geom[] = [];

    for (const c of candles) {
        const rawX = tsToXFn(c.ts);
        if (rawX < -halfBody || rawX > w + halfBody * 2) continue;
        const leftDev = Math.round(rawX * dpr - bodyWDev / 2);
        const left = leftDev / dpr;
        const wickX = snapStroke((leftDev + bodyWDev / 2) / dpr, wickWidth, dpr);
        const yTop = snapEdge(Math.min(priceToYFn(c.open), priceToYFn(c.close)), dpr);
        const yBot = snapEdge(Math.max(priceToYFn(c.open), priceToYFn(c.close)), dpr);
        (c.close >= c.open ? upGeom : downGeom).push({
            left,
            wickX,
            yHigh: priceToYFn(c.high),
            yLow: priceToYFn(c.low),
            bodyTop: yTop,
            bodyH: Math.max(1 / dpr, yBot - yTop),
            hasWick: c.high !== c.low,
        });
    }

    // Wicks first so bodies paint over the body-height portion of each wick.
    for (const [geoms, color] of [
        [upGeom, upWickColor],
        [downGeom, downWickColor],
    ] as [Geom[], string][]) {
        if (!geoms.length) continue;
        ctx.strokeStyle = color;
        ctx.lineWidth = deviceLineWidth(wickWidth, dpr);
        ctx.beginPath();
        for (const g of geoms) {
            if (g.hasWick) {
                ctx.moveTo(g.wickX, g.yHigh);
                ctx.lineTo(g.wickX, g.bodyTop);
                ctx.moveTo(g.wickX, g.bodyTop + g.bodyH);
                ctx.lineTo(g.wickX, g.yLow);
            }
        }
        ctx.stroke();
    }

    // Bodies. Hollow charts only fill the down candles.
    const bodySets: [Geom[], string][] = hollow
        ? [[downGeom, downBodyColor]]
        : [
              [upGeom, upBodyColor],
              [downGeom, downBodyColor],
          ];
    for (const [geoms, color] of bodySets) {
        if (!geoms.length) continue;
        ctx.fillStyle = color;
        ctx.beginPath();
        for (const g of geoms) ctx.rect(g.left, g.bodyTop, bodyWCss, g.bodyH);
        ctx.fill();
    }

    // Borders. Hollow always outlines so the unfilled up candles stay visible.
    if (borderWidth > 0 || hollow) {
        const bw = deviceLineWidth(Math.max(1, borderWidth), dpr);
        for (const [geoms, color] of [
            [upGeom, upBorderColor],
            [downGeom, downBorderColor],
        ] as [Geom[], string][]) {
            if (!geoms.length) continue;
            ctx.strokeStyle = color;
            ctx.lineWidth = bw;
            ctx.beginPath();
            for (const g of geoms) {
                ctx.rect(g.left + bw / 2, g.bodyTop + bw / 2, bodyWCss - bw, g.bodyH - bw);
            }
            ctx.stroke();
        }
    }
}

/**
 * OHLC bar chart: a vertical high-low stick per bar with a left tick for the
 * open and a right tick for the close, colored by direction.
 */
function drawBarChart(
    ctx: CanvasRenderingContext2D,
    candles: AggCandle[],
    w: number,
    h: number,
    chartSettings: ChartSettings,
    transformer: LiveTransformer,
) {
    if (!candles.length) return;

    const barPx = transformer.getBarPx(w);
    const tick = Math.max(1, Math.floor(barPx * 0.4));
    const tsToXFn = transformer.makeTsToXFn(w);
    const priceToYFn = transformer.makePriceToYFn(h);
    const upColor = chartSettings?.upBodyColor ?? '#00e676';
    const downColor = chartSettings?.downBodyColor ?? '#ff1744';
    const lw = Math.max(1, chartSettings?.wickWidth ?? 1);

    const up: AggCandle[] = [];
    const down: AggCandle[] = [];
    for (const c of candles) {
        const rawX = tsToXFn(c.ts);
        if (rawX < -tick || rawX > w + tick) continue;
        (c.close >= c.open ? up : down).push(c);
    }

    for (const [set, color] of [
        [up, upColor],
        [down, downColor],
    ] as [AggCandle[], string][]) {
        if (!set.length) continue;
        ctx.strokeStyle = color;
        ctx.lineWidth = lw;
        ctx.beginPath();
        for (const c of set) {
            const x = Math.floor(tsToXFn(c.ts)) + 0.5;
            ctx.moveTo(x, priceToYFn(c.high));
            ctx.lineTo(x, priceToYFn(c.low));
            const yOpen = priceToYFn(c.open);
            ctx.moveTo(x - tick, yOpen);
            ctx.lineTo(x, yOpen);
            const yClose = priceToYFn(c.close);
            ctx.moveTo(x, yClose);
            ctx.lineTo(x + tick, yClose);
        }
        ctx.stroke();
    }
}

/**
 * Baseline chart: the series is split at a reference price, filled and stroked
 * with the up color above the baseline and the down color below it. The split
 * is exact (achieved by clipping at the baseline pixel) so colors meet cleanly
 * at every crossing.
 */
function drawBaselineChart(
    ctx: CanvasRenderingContext2D,
    priceHistory: PriceHistory[],
    bounds: ViewBounds,
    w: number,
    h: number,
    side: 'bid' | 'ask' | 'price',
    chartSettings: ChartSettings,
    horizon: bigint = 0n,
    barNs: bigint,
    transformer: LiveTransformer,
    ohlcvBars?: {
        time: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
    }[],
    openBar?: any,
) {
    const tsToXFn = transformer.makeTsToXFn(w);
    const priceToYFn = transformer.makePriceToYFn(h);

    const pts: { x: number; price: number }[] = [];
    let baselinePrice: number | null = chartSettings.baselineValue;

    if (side === 'price') {
        if (!ohlcvBars || !ohlcvBars.length || barNs === 0n) return;
        const cutTs =
            horizon > 0n
                ? Number(((horizon / barNs) * barNs) / 1_000_000n)
                : Number(bounds.tMax / 1_000_000n);

        // Default baseline: the first real price of the whole series - a stable
        // anchor that doesn't drift while panning.
        if (baselinePrice == null) {
            for (let i = 0; i < ohlcvBars.length; i++) {
                if (ohlcvBars[i].close !== 0) {
                    baselinePrice = ohlcvBars[i].close;
                    break;
                }
            }
        }

        const target = Number(bounds.tMin / 1_000_000n);
        let lo = 0,
            hi = ohlcvBars.length - 1,
            result = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            if (ohlcvBars[mid].time <= target) {
                result = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        for (let i = Math.max(0, result); i < ohlcvBars.length; i++) {
            if (ohlcvBars[i].time >= cutTs) break;
            const val = ohlcvBars[i].close;
            if (val === 0) continue;
            pts.push({ x: tsToXFn(BigInt(ohlcvBars[i].time * 1_000_000)), price: val });
            if (pts[pts.length - 1].x > w + 100) break;
        }
        if (openBar && Number(openBar.ts / 1_000_000n) < cutTs) {
            pts.push({ x: tsToXFn(openBar.ts), price: openBar.close });
        }
    } else {
        if (!priceHistory.length) return;
        const cutTs = horizon > 0n ? horizon : bounds.tMax;
        const isBid = side === 'bid';

        if (baselinePrice == null) {
            for (let i = 0; i < priceHistory.length; i++) {
                const v = isBid ? priceHistory[i].bestBid : priceHistory[i].bestAsk;
                if (v !== 0) {
                    baselinePrice = v;
                    break;
                }
            }
        }

        for (
            let i = Math.max(0, floorIndex(priceHistory, bounds.tMin));
            i < priceHistory.length;
            i++
        ) {
            if (priceHistory[i].ts > cutTs) break;
            const val = isBid ? priceHistory[i].bestBid : priceHistory[i].bestAsk;
            if (val === 0) continue;
            pts.push({ x: tsToXFn(priceHistory[i].ts), price: val });
            if (pts[pts.length - 1].x > w + 100) break;
        }
    }

    if (pts.length < 2 || baselinePrice == null) return;

    const baseY = priceToYFn(baselinePrice);
    const upColor = makeOpaque(chartSettings.upBodyColor ?? '#00e676');
    const downColor = makeOpaque(chartSettings.downBodyColor ?? '#ff1744');

    const xy = pts.map((p) => ({ x: p.x, y: priceToYFn(p.price) }));

    // Area path closes back to the baseline (not the canvas edge) so the fill
    // hugs the split line; clipping to each half picks the right color.
    const buildArea = () => {
        ctx.beginPath();
        ctx.moveTo(xy[0].x, baseY);
        for (const p of xy) ctx.lineTo(p.x, p.y);
        ctx.lineTo(xy[xy.length - 1].x, baseY);
        ctx.closePath();
    };
    const buildLine = () => {
        ctx.beginPath();
        ctx.moveTo(xy[0].x, xy[0].y);
        for (let i = 1; i < xy.length; i++) ctx.lineTo(xy[i].x, xy[i].y);
    };

    const upGrad = ctx.createLinearGradient(0, 0, 0, Math.max(baseY, 1));
    upGrad.addColorStop(0, upColor + '55');
    upGrad.addColorStop(1, upColor + '08');
    const downGrad = ctx.createLinearGradient(0, baseY, 0, h);
    downGrad.addColorStop(0, downColor + '08');
    downGrad.addColorStop(1, downColor + '55');

    const fillHalf = (top: number, height: number, grad: CanvasGradient) => {
        if (height <= 0) return;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, top, w, height);
        ctx.clip();
        buildArea();
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.restore();
    };
    fillHalf(0, baseY, upGrad);
    fillHalf(baseY, h - baseY, downGrad);

    const strokeHalf = (top: number, height: number, color: string) => {
        if (height <= 0) return;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, top, w, height);
        ctx.clip();
        ctx.lineWidth = 1.5;
        ctx.lineJoin = 'round';
        buildLine();
        ctx.strokeStyle = color;
        ctx.stroke();
        ctx.restore();
    };
    strokeHalf(0, baseY, upColor);
    strokeHalf(baseY, h - baseY, downColor);

    // Baseline reference line.
    ctx.save();
    ctx.beginPath();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#75869688';
    ctx.lineWidth = 1;
    ctx.moveTo(0, Math.round(baseY) + 0.5);
    ctx.lineTo(w, Math.round(baseY) + 0.5);
    ctx.stroke();
    ctx.restore();
}
//  Japanese price-driven charts (Renko / Kagi / Three Line Break)
//
//  These are built from the FULL close series (construction is path-dependent),
//  so both the series extraction and the per-type build are memoised by source
//  reference + a cheap signature to avoid rebuilding every frame. The live
//  forming bar is intentionally excluded - elements update when a bar closes.
type SeriesCacheEntry = { sig: string; series: PricePoint[] };
const _closeSeriesCache = new WeakMap<object, SeriesCacheEntry>();

function getCloseSeries(
    ohlcvBars: { time: number; close: number }[] | undefined,
    candleCache: CandleCache | null,
    trades: TradePoint[],
    _barNs: bigint,
): PricePoint[] {
    const memo = (src: object, sig: string, build: () => PricePoint[]): PricePoint[] => {
        const hit = _closeSeriesCache.get(src);
        if (hit && hit.sig === sig) return hit.series;
        const series = build();
        _closeSeriesCache.set(src, { sig, series });
        return series;
    };

    if (ohlcvBars && ohlcvBars.length) {
        const last = ohlcvBars[ohlcvBars.length - 1];
        return memo(ohlcvBars, `o:${ohlcvBars.length}:${last.time}`, () => {
            const s: PricePoint[] = [];
            for (const b of ohlcvBars) {
                if (b.close === 0) continue;
                s.push({ ts: BigInt(b.time * 1_000_000), price: b.close });
            }
            return s;
        });
    }
    if (candleCache && candleCache.size) {
        return memo(candleCache, `c:${candleCache.size}`, () => {
            const keys = Array.from(candleCache.keys()).sort((a, b) => (a < b ? -1 : 1));
            const s: PricePoint[] = [];
            for (const k of keys) {
                const c = candleCache.get(k)!;
                if (c.close === 0) continue;
                s.push({ ts: k, price: c.close });
            }
            return s;
        });
    }
    if (trades && trades.length) {
        const last = trades[trades.length - 1];
        return memo(trades, `t:${trades.length}:${last.ts}`, () => {
            const s: PricePoint[] = [];
            for (const t of trades) s.push({ ts: t.ts, price: t.price });
            return s;
        });
    }
    return [];
}

const _jpBuildCache = new WeakMap<object, Map<string, unknown>>();
function memoBuild<T>(series: object, key: string, build: () => T): T {
    let m = _jpBuildCache.get(series);
    if (!m) {
        m = new Map();
        _jpBuildCache.set(series, m);
    }
    const hit = m.get(key);
    if (hit !== undefined) return hit as T;
    const v = build();
    if (m.size > 6) m.clear();
    m.set(key, v);
    return v;
}

/** True for the price-driven chart types that render on an ordinal (column) x-axis. */
export function isOrdinalChartType(t: ChartType): boolean {
    return t === 'renko' || t === 'kagi' || t === 'line-break';
}

/**
 * Memoised ordinal model for the current chart type + data + params. Returns
 * null for non-ordinal types. Shared by the renderer, the transformer wiring
 * (column timestamps) and autoscale (visible price extent), so all three derive
 * from one build.
 */
export function getOrdinalModel(
    chartType: ChartType,
    chartSettings: ChartSettings,
    ohlcvBars: { time: number; close: number }[] | undefined,
    candleCache: CandleCache | null,
    trades: TradePoint[],
    barNs: bigint,
): OrdinalModel | null {
    if (!isOrdinalChartType(chartType)) return null;
    const series = getCloseSeries(ohlcvBars, candleCache, trades, barNs);
    if (series.length < 2) return null;

    let param: number;
    if (chartType === 'renko') param = chartSettings.renkoBrickSize ?? autoThreshold(series);
    else if (chartType === 'kagi') param = chartSettings.kagiReversal ?? autoThreshold(series) * 2;
    else param = Math.max(1, chartSettings.lineBreakCount || 3);

    return memoBuild(series, `model:${chartType}:${param}`, () =>
        buildOrdinalModel(chartType as OrdinalKind, series, param),
    );
}

/**
 * Price extent of the columns currently visible under the transformer's view -
 * used to auto-scale the y-axis for ordinal charts (whose prices live in the
 * model, not in the time-indexed bars autoFitPriceAxis scans). Returns null when
 * nothing is visible.
 */
export function ordinalVisiblePriceRange(
    model: OrdinalModel,
    transformer: LiveTransformer,
): { min: number; max: number } | null {
    const n = model.columnTs.length;
    if (n === 0) return null;
    const view = transformer.getView();
    const i0 = Math.max(0, Math.floor(transformer.tsToFracIndex(view.tMin)));
    const i1 = Math.min(n - 1, Math.ceil(transformer.tsToFracIndex(view.tMax)));
    if (i1 < i0) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = i0; i <= i1; i++) {
        if (model.pLow[i] < lo) lo = model.pLow[i];
        if (model.pHigh[i] > hi) hi = model.pHigh[i];
    }
    return Number.isFinite(lo) && Number.isFinite(hi) ? { min: lo, max: hi } : null;
}

/** Returns the [first, last] column index visible on screen (with 1-col padding). */
function visibleIndexRange(transformer: LiveTransformer, w: number, n: number): [number, number] {
    const lo = Math.max(0, Math.floor(transformer.xToIndex(0, w)) - 1);
    const hi = Math.min(n - 1, Math.ceil(transformer.xToIndex(w, w)) + 1);
    return [lo, hi];
}

function drawRenko(
    ctx: CanvasRenderingContext2D,
    model: OrdinalModel,
    bounds: ViewBounds,
    w: number,
    h: number,
    chartSettings: ChartSettings,
    horizon: bigint,
    transformer: LiveTransformer,
) {
    const bricks = model.bricks!;
    if (!bricks.length) return;

    const indexToXFn = transformer.makeIndexToXFn(w);
    const priceToYFn = transformer.makePriceToYFn(h);
    const bw = Math.max(2, transformer.getBarPx(w) * 0.9);
    const half = bw / 2;
    const cutTs = horizon > 0n ? horizon : bounds.tMax;
    const [i0, i1] = visibleIndexRange(transformer, w, bricks.length);

    type Box = { x: number; yTop: number; hgt: number };
    const up: Box[] = [];
    const down: Box[] = [];
    for (let i = i0; i <= i1; i++) {
        const b = bricks[i];
        if (b.ts > cutTs) break;
        const x = indexToXFn(i);
        const yTop = priceToYFn(b.yHigh);
        (b.dir > 0 ? up : down).push({ x, yTop, hgt: priceToYFn(b.yLow) - yTop });
    }

    const fill = (boxes: Box[], body: string, border: string) => {
        if (!boxes.length) return;
        ctx.fillStyle = body;
        ctx.beginPath();
        for (const b of boxes) ctx.rect(b.x - half, b.yTop, bw, b.hgt);
        ctx.fill();
        ctx.strokeStyle = border;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const b of boxes) ctx.rect(b.x - half + 0.5, b.yTop + 0.5, bw - 1, b.hgt - 1);
        ctx.stroke();
    };
    fill(up, chartSettings.upBodyColor ?? '#00e676', chartSettings.upBorderColor ?? '#00e676');
    fill(
        down,
        chartSettings.downBodyColor ?? '#ff1744',
        chartSettings.downBorderColor ?? '#ff1744',
    );
}

function drawKagi(
    ctx: CanvasRenderingContext2D,
    model: OrdinalModel,
    bounds: ViewBounds,
    w: number,
    h: number,
    chartSettings: ChartSettings,
    horizon: bigint,
    transformer: LiveTransformer,
) {
    const segs = model.kagiSegments!;
    if (!segs.length) return;
    const cols = model.columnTs;

    const indexToXFn = transformer.makeIndexToXFn(w);
    const priceToYFn = transformer.makePriceToYFn(h);
    const cutTs = horizon > 0n ? horizon : bounds.tMax;
    const upColor = chartSettings.upBodyColor ?? '#00e676';
    const downColor = chartSettings.downBodyColor ?? '#ff1744';
    const [i0, i1] = visibleIndexRange(transformer, w, cols.length);

    const stroke = (yang: boolean) => {
        ctx.strokeStyle = yang ? upColor : downColor;
        ctx.lineWidth = yang ? 2.5 : 1.25;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (const s of segs) {
            if (s.yang !== yang) continue;
            if (cols[s.i2] > cutTs) continue;
            if (s.i2 < i0 || s.i1 > i1) continue;
            ctx.moveTo(indexToXFn(s.i1), priceToYFn(s.y1));
            ctx.lineTo(indexToXFn(s.i2), priceToYFn(s.y2));
        }
        ctx.stroke();
    };
    stroke(false);
    stroke(true);
    ctx.lineCap = 'butt';
}

function drawLineBreak(
    ctx: CanvasRenderingContext2D,
    model: OrdinalModel,
    bounds: ViewBounds,
    w: number,
    h: number,
    chartSettings: ChartSettings,
    horizon: bigint,
    transformer: LiveTransformer,
) {
    const boxes = model.boxes!;
    if (!boxes.length) return;

    const indexToXFn = transformer.makeIndexToXFn(w);
    const priceToYFn = transformer.makePriceToYFn(h);
    const bw = Math.max(2, transformer.getBarPx(w) * 0.9);
    const half = bw / 2;
    const cutTs = horizon > 0n ? horizon : bounds.tMax;
    const [i0, i1] = visibleIndexRange(transformer, w, boxes.length);

    type Box = { x: number; yTop: number; hgt: number };
    const up: Box[] = [];
    const down: Box[] = [];
    for (let i = i0; i <= i1; i++) {
        const b = boxes[i];
        if (b.ts > cutTs) break;
        const x = indexToXFn(i);
        const yTop = priceToYFn(Math.max(b.open, b.close));
        const hgt = Math.max(1, priceToYFn(Math.min(b.open, b.close)) - yTop);
        (b.dir > 0 ? up : down).push({ x, yTop, hgt });
    }

    const fill = (boxesArr: Box[], body: string, border: string) => {
        if (!boxesArr.length) return;
        ctx.fillStyle = body;
        ctx.beginPath();
        for (const b of boxesArr) ctx.rect(b.x - half, b.yTop, bw, b.hgt);
        ctx.fill();
        ctx.strokeStyle = border;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const b of boxesArr) ctx.rect(b.x - half + 0.5, b.yTop + 0.5, bw - 1, b.hgt - 1);
        ctx.stroke();
    };
    fill(up, chartSettings.upBodyColor ?? '#00e676', chartSettings.upBorderColor ?? '#00e676');
    fill(
        down,
        chartSettings.downBodyColor ?? '#ff1744',
        chartSettings.downBorderColor ?? '#ff1744',
    );
}
