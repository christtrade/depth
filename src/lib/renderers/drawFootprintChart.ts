// the footprint renderer. signals it draws:
//
//   stacked imbalance    translucent zone overlays, buy cyan / sell magenta
//   absorption           pulsing amber halo behind the cell
//   unfinished auction   dashed arrow at the bar high/low
//   diagonal imbalance   slash marks on the bid-ask cells
//   POC                  gold outline ring
//   vertical imbalance   coloured numbers
//
// all of it is gated on pixel density so the chart stays clean zoomed out.
import type { FootprintBar, FootprintMode } from '../types/footprint';
import type { ViewBounds } from '../types';
import type { ChartSettings } from '../types/chart-settings';
import { LiveTransformer } from '../../core';

// Colour tokens
const C = {
    // Candle
    bullBody: '#00e676',
    bearBody: '#ff1744',
    bullWick: 'rgba(0,230,118,0.50)',
    bearWick: 'rgba(255,23,68,0.50)',

    // Cell backgrounds
    cellBg: 'rgba(42,45,55,0.85)',

    // Bid/ask fills
    askFill: (alpha: number) => `rgba(0,200,100,${alpha.toFixed(2)})`,
    bidFill: (alpha: number) => `rgba(220,30,60,${alpha.toFixed(2)})`,

    // POC
    poc: 'rgba(255,215,0,0.95)',

    // Stacked imbalance zones
    stackBuy: 'rgba(0,180,255,0.12)',
    stackBuyBorder: 'rgba(0,200,255,0.55)',
    stackSell: 'rgba(255,40,120,0.12)',
    stackSellBorder: 'rgba(255,60,140,0.55)',

    // Absorption halo
    absorption: 'rgba(255,180,0,0.18)',
    absorptionBorder: 'rgba(255,200,40,0.70)',

    // Unfinished auction
    unfTop: 'rgba(0,200,255,0.85)',
    unfBottom: 'rgba(255,80,140,0.85)',

    // Diagonal imbalance slash
    diagAsk: 'rgba(0,230,200,0.65)',
    diagBid: 'rgba(255,60,120,0.65)',

    // Text
    textNormal: 'rgba(210,210,220,0.90)',
    textDim: 'rgba(120,120,130,0.50)',

    // Diagonal imbalance highlight colours (text)
    diagAskText: '#00e8c0',
    diagBidText: '#ff4488',

    // Vertical imbalance highlight colours (text)
    askImbalText4x: '#00b4ff',
    askImbalText2x: '#66ffb2',
    bidImbalText4x: '#ff40c0',
    bidImbalText2x: '#cc88ff',
};

// Main renderer
export function drawFootprintChart(
    ctx: CanvasRenderingContext2D,
    bars: FootprintBar[],
    bounds: ViewBounds,
    w: number,
    h: number,
    barNs: bigint,
    mode: FootprintMode,
    tickSize: number = 0.25,
    footprintVolume: 'none' | 'split' | 'total' = 'split',
    chartSettings: ChartSettings,
    horizon: bigint = 0n,
    transformer: LiveTransformer,
): void {
    if (barNs === 0n || bars.length === 0) return;
    const cutTs = horizon > 0n ? horizon : bounds.tMax;

    const tRange = Number(bounds.tMax - bounds.tMin);
    const barPx = (Number(barNs) / tRange) * w;

    const pRange = bounds.pMax - bounds.pMin;
    const tickPx = pRange > 0 ? (tickSize / pRange) * h : 0;

    // Text & detail gating
    const showText = barPx >= 44;
    const showSignals = barPx >= 20; // signals need at least 20px per bar
    const showDiag = barPx >= 36 && chartSettings.footprintShowDiagonalImbalance; // diagonal slashes need more room

    ctx.save();
    ctx.textBaseline = 'middle';

    // LOD: pick smallest bucket that gives >= MIN_ROW_PX
    const MIN_ROW_PX = 30;
    const LOD_STEPS = [1, 2, 4, 8, 16, 32, 64, 128];
    let lodTicks = 1;
    for (const s of LOD_STEPS) {
        lodTicks = s;
        if (tickPx * s >= MIN_ROW_PX) break;
    }
    const lodPrice = tickSize * lodTicks;
    const rowPx = tickPx * lodTicks;

    for (const bar of bars) {
        if (bar.ts > cutTs) break;
        if (bar.ts + barNs < bounds.tMin || bar.ts > bounds.tMax) continue;

        const xCandle = transformer.tsToX(bar.ts, w);
        const xBarEnd = transformer.tsToX(bar.ts + barNs, w);

        const candleBodyW = Math.max(2, Math.floor(barPx * 0.16));
        const halfCandleW = candleBodyW / 2;

        const CELL_GAP = 15;
        const cellsLeft = xCandle + halfCandleW + CELL_GAP;
        const cellsRight = xBarEnd - Math.max(4, barPx * 0.2);
        const cellsWidth = Math.max(0, cellsRight - cellsLeft);

        // Candle
        const color = bar.isBullish ? chartSettings.upBodyColor : chartSettings.downBodyColor;
        const wickClr = bar.isBullish
            ? chartSettings.wickColorMatchesBody
                ? color
                : chartSettings.upWickColor
            : chartSettings.wickColorMatchesBody
              ? color
              : chartSettings.downWickColor;

        const yOpen = transformer.priceToY(bar.open, h);
        const yClose = transformer.priceToY(bar.close, h);
        const yHigh = transformer.priceToY(bar.high, h);
        const yLow = transformer.priceToY(bar.low, h);

        if (bar.high !== bar.low) {
            ctx.strokeStyle = wickClr;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(xCandle, yHigh);
            ctx.lineTo(xCandle, yLow);
            ctx.stroke();
        }
        const bodyTop = Math.min(yOpen, yClose);
        const bodyH = Math.max(2, Math.abs(yClose - yOpen));
        ctx.fillStyle = color;
        ctx.fillRect(xCandle - halfCandleW, bodyTop, candleBodyW, bodyH);

        if (cellsWidth < 4) continue;

        // Aggregate bar levels into LOD buckets
        type Bucket = {
            bid: number;
            ask: number;
            total: number;
            delta: number;
            poc: boolean;
            absorption: boolean;
            bidImbalance: boolean;
            askImbalance: boolean;
            diagAskImbalance: boolean;
            diagBidImbalance: boolean;
        };
        const bucketMap = new Map<number, Bucket>();

        for (const level of bar.levels) {
            const key = Math.floor(Math.round(level.price / tickSize) / lodTicks);
            let b = bucketMap.get(key);
            if (!b) {
                b = {
                    bid: 0,
                    ask: 0,
                    total: 0,
                    delta: 0,
                    poc: false,
                    absorption: false,
                    bidImbalance: false,
                    askImbalance: false,
                    diagAskImbalance: false,
                    diagBidImbalance: false,
                };
                bucketMap.set(key, b);
            }
            b.bid += level.bidVol;
            b.ask += level.askVol;
            b.total += level.totalVol;
            b.delta += level.delta;
            if (level.price === bar.poc) b.poc = true;
            if (level.absorption) b.absorption = true;
            if (level.bidImbalance) b.bidImbalance = true;
            if (level.askImbalance) b.askImbalance = true;
            if (level.diagAskImbalance) b.diagAskImbalance = true;
            if (level.diagBidImbalance) b.diagBidImbalance = true;
        }

        let bucketMax = 1;
        for (const b of bucketMap.values()) bucketMax = Math.max(bucketMax, b.total);

        // Fill gaps
        const keyLow = Math.floor(Math.round(bar.low / tickSize) / lodTicks);
        const keyHigh = Math.floor(Math.round(bar.high / tickSize) / lodTicks);
        for (let k = keyLow; k <= keyHigh; k++) {
            if (!bucketMap.has(k)) {
                bucketMap.set(k, {
                    bid: 0,
                    ask: 0,
                    total: 0,
                    delta: 0,
                    poc: false,
                    absorption: false,
                    bidImbalance: false,
                    askImbalance: false,
                    diagAskImbalance: false,
                    diagBidImbalance: false,
                });
            }
        }

        const rowShowText = showText && rowPx >= 9;
        const fontSize = Math.max(9, Math.min(13, Math.floor(rowPx * 0.45)));
        ctx.font = `${fontSize}px "JetBrains Mono", monospace`;

        // Per-row rendering
        for (const [key, b] of bucketMap) {
            const bucketBasePrice = key * lodPrice;
            const bucketMidPrice = bucketBasePrice + lodPrice / 2;
            const yCenter = transformer.priceToY(bucketMidPrice, h);
            const cellH = Math.max(1, rowPx - 1);
            const yCell = yCenter - cellH / 2;

            // SIGNAL LAYER 2: Absorption halo
            if (showSignals && chartSettings.footprintShowAbsorption && b.absorption) {
                ctx.fillStyle = C.absorption;
                ctx.fillRect(cellsLeft - 2, yCell - 1, cellsWidth + 4, cellH + 2);
                ctx.strokeStyle = C.absorptionBorder;
                ctx.lineWidth = 1;
                ctx.setLineDash([3, 2]);
                ctx.strokeRect(cellsLeft - 1.5, yCell - 0.5, cellsWidth + 3, cellH + 1);
                ctx.setLineDash([]);
            }

            // Main cell
            switch (mode) {
                case 'bid-ask':
                    _drawBidAskCell(
                        ctx,
                        b,
                        bucketMax,
                        cellsLeft,
                        yCell,
                        cellH,
                        cellsWidth,
                        rowShowText,
                        yCenter,
                        fontSize,
                        footprintVolume,
                        showDiag,
                    );
                    break;
                case 'profile':
                    _drawProfileCell(
                        ctx,
                        b,
                        bucketMax,
                        cellsLeft,
                        yCell,
                        cellH,
                        cellsWidth,
                        rowShowText,
                        yCenter,
                        fontSize,
                    );
                    break;
                case 'delta':
                    _drawDeltaCell(
                        ctx,
                        b,
                        bucketMax,
                        cellsLeft,
                        yCell,
                        cellH,
                        cellsWidth,
                        rowShowText,
                        yCenter,
                        fontSize,
                    );
                    break;
                case 'total':
                    _drawTotalCell(
                        ctx,
                        b,
                        bucketMax,
                        cellsLeft,
                        yCell,
                        cellH,
                        cellsWidth,
                        rowShowText,
                        yCenter,
                        fontSize,
                    );
                    break;
            }

            // POC outline
            if (b.poc && cellH >= 2) {
                ctx.strokeStyle = C.poc;
                ctx.lineWidth = 1.5;
                ctx.strokeRect(cellsLeft + 0.5, yCell + 0.5, cellsWidth - 2, cellH - 1);
            }
        }

        // SIGNAL LAYER 1: Stacked imbalance zone overlays
        if (showSignals && chartSettings.footprintShowStackedImbalance) {
            _drawStackedZones(
                ctx,
                bar.stackedBuyZones,
                'buy',
                cellsLeft,
                cellsWidth,
                bounds,
                h,
                tickSize,
                chartSettings,
                transformer,
            );
            _drawStackedZones(
                ctx,
                bar.stackedSellZones,
                'sell',
                cellsLeft,
                cellsWidth,
                bounds,
                h,
                tickSize,
                chartSettings,
                transformer,
            );
        }

        // SIGNAL LAYER 3: Unfinished auction markers
        if (showSignals && chartSettings.footprintShowUnfinishedAuction) {
            if (bar.unfinishedTop) {
                _drawUnfinishedMarker(ctx, 'top', xCandle, yHigh, barPx);
            }
            if (bar.unfinishedBottom) {
                _drawUnfinishedMarker(ctx, 'bottom', xCandle, yLow, barPx);
            }
        }

        // Bar delta label
        if (showText && barPx >= 50) {
            const sign = bar.totalDelta >= 0 ? '+' : '';
            ctx.textAlign = 'center';
            ctx.font = `bold ${fontSize}px "JetBrains Mono", monospace`;
            ctx.fillStyle = bar.totalDelta >= 0 ? 'rgba(0,230,118,0.85)' : 'rgba(255,23,68,0.85)';
            ctx.fillText(`${sign}${bar.totalDelta}`, xCandle, yLow + 14);
            ctx.font = `${fontSize}px "JetBrains Mono", monospace`;
        }

        // Diagonal imbalance bar badge (mini label at bar top)
        if (
            showSignals &&
            chartSettings.footprintShowDiagonalImbalance &&
            barPx >= 60 &&
            bar.diagDominant !== 'none'
        ) {
            const label = bar.diagDominant === 'buy' ? '↗ DIAG' : '↘ DIAG';
            ctx.font = `bold 9px "JetBrains Mono", monospace`;
            ctx.textAlign = 'center';
            ctx.fillStyle = bar.diagDominant === 'buy' ? C.diagAskText : C.diagBidText;
            ctx.fillText(label, xCandle, yHigh - 6);
            ctx.font = `${fontSize}px "JetBrains Mono", monospace`;
        }
    }

    ctx.restore();
}

// Cell helpers
function _drawBidAskCell(
    ctx: CanvasRenderingContext2D,
    b: {
        bid: number;
        ask: number;
        total: number;
        delta: number;
        poc: boolean;
        absorption: boolean;
        bidImbalance: boolean;
        askImbalance: boolean;
        diagAskImbalance: boolean;
        diagBidImbalance: boolean;
    },
    bucketMax: number,
    cellsLeft: number,
    yCell: number,
    cellH: number,
    cellsWidth: number,
    rowShowText: boolean,
    yCenter: number,
    fontSize: number,
    footprintVolume: 'none' | 'split' | 'total',
    showDiag: boolean,
) {
    const half = cellsWidth / 2;
    const GAP = 1;

    // Text colour logic (vertical imbalance)
    let askTextColor = C.textNormal;
    let bidTextColor = C.textNormal;

    if (b.ask > 0 && b.bid > 0) {
        const askRatio = b.ask / b.bid;
        if (askRatio >= 4) askTextColor = C.askImbalText4x;
        else if (askRatio >= 2) askTextColor = C.askImbalText2x;
        const bidRatio = b.bid / b.ask;
        if (bidRatio >= 4) bidTextColor = C.bidImbalText4x;
        else if (bidRatio >= 2) bidTextColor = C.bidImbalText2x;
    } else if (b.ask > 0 && b.bid === 0) {
        askTextColor = C.askImbalText4x;
    } else if (b.bid > 0 && b.ask === 0) {
        bidTextColor = C.bidImbalText4x;
    }

    // Override with diagonal imbalance colour (takes precedence)
    if (showDiag) {
        if (b.diagAskImbalance) askTextColor = C.diagAskText;
        if (b.diagBidImbalance) bidTextColor = C.diagBidText;
    }

    if (footprintVolume === 'none') {
        // Background encodes delta direction
        const delta = b.delta;
        const absDelta = Math.abs(delta);
        const absFrac = bucketMax > 0 ? Math.min(1, absDelta / bucketMax) : 0;

        let bidBg: string, askBg: string;
        if (delta > 0) {
            askBg = C.askFill(0.2 + 0.35 * absFrac);
            bidBg = C.cellBg;
        } else if (delta < 0) {
            bidBg = C.bidFill(0.2 + 0.35 * absFrac);
            askBg = C.cellBg;
        } else {
            bidBg = askBg = C.cellBg;
        }
        ctx.fillStyle = bidBg;
        ctx.fillRect(cellsLeft, yCell, half - GAP, cellH);
        ctx.fillStyle = askBg;
        ctx.fillRect(cellsLeft + half, yCell, half - 1, cellH);
    } else if (footprintVolume === 'split') {
        ctx.fillStyle = C.cellBg;
        ctx.fillRect(cellsLeft, yCell, half - GAP, cellH);
        ctx.fillRect(cellsLeft + half, yCell, half - 1, cellH);

        const bidFrac = Math.min(1, b.bid / bucketMax);
        const askFrac = Math.min(1, b.ask / bucketMax);
        if (bidFrac > 0) {
            ctx.fillStyle = C.bidFill(0.45);
            ctx.fillRect(cellsLeft, yCell, bidFrac * (half - GAP), cellH);
        }
        if (askFrac > 0) {
            ctx.fillStyle = C.askFill(0.45);
            ctx.fillRect(cellsLeft + half, yCell, askFrac * (half - 1), cellH);
        }
    } else {
        // total volume bar, split-coloured
        const totalFrac = Math.min(1, b.total / bucketMax);
        ctx.fillStyle = C.cellBg;
        ctx.fillRect(cellsLeft, yCell, half - GAP, cellH);
        ctx.fillRect(cellsLeft + half, yCell, half - 1, cellH);

        const barW = totalFrac * cellsWidth;
        const bidProp = b.total > 0 ? b.bid / b.total : 0.5;
        const bidBarW = barW * bidProp;
        const askBarW = barW * (1 - bidProp);
        if (bidBarW > 0) {
            ctx.fillStyle = C.bidFill(0.45);
            ctx.fillRect(cellsLeft, yCell, bidBarW, cellH);
        }
        if (askBarW > 0) {
            ctx.fillStyle = C.askFill(0.45);

            ctx.fillRect(cellsLeft + bidBarW, yCell, askBarW, cellH);
        }
    }

    // DIAGONAL IMBALANCE: slash marks
    // Rendered as a subtle diagonal line overlaid on the relevant half-cell.
    if (showDiag) {
        if (b.diagAskImbalance && cellH >= 4) {
            // Ask half (right side): bottom-left -> top-right slash
            const x0 = cellsLeft + half + 2,
                x1 = cellsLeft + cellsWidth - 3;
            const y0 = yCell + cellH - 2,
                y1 = yCell + 2;
            ctx.strokeStyle = C.diagAsk;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(x0, y0);
            ctx.lineTo(x1, y1);
            ctx.stroke();
        }
        if (b.diagBidImbalance && cellH >= 4) {
            // Bid half (left side): top-left -> bottom-right slash
            const x0 = cellsLeft + 2,
                x1 = cellsLeft + half - GAP - 3;
            const y0 = yCell + 2,
                y1 = yCell + cellH - 2;
            ctx.strokeStyle = C.diagBid;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(x0, y0);
            ctx.lineTo(x1, y1);
            ctx.stroke();
        }
    }

    // Text
    if (rowShowText) {
        ctx.textAlign = 'right';
        ctx.font =
            bidTextColor === C.bidImbalText4x || bidTextColor === C.diagBidText
                ? `bold ${fontSize}px "JetBrains Mono", monospace`
                : `${fontSize}px "JetBrains Mono", monospace`;
        ctx.fillStyle = b.bid === 0 ? C.textDim : bidTextColor;
        ctx.fillText(String(b.bid), cellsLeft + half - GAP - 2, yCenter);

        ctx.textAlign = 'left';
        ctx.font =
            askTextColor === C.askImbalText4x || askTextColor === C.diagAskText
                ? `bold ${fontSize}px "JetBrains Mono", monospace`
                : `${fontSize}px "JetBrains Mono", monospace`;
        ctx.fillStyle = b.ask === 0 ? C.textDim : askTextColor;
        ctx.fillText(String(b.ask), cellsLeft + half + 2, yCenter);

        ctx.font = `${fontSize}px "JetBrains Mono", monospace`;
    }
}

function _drawProfileCell(
    ctx: CanvasRenderingContext2D,
    b: { bid: number; ask: number; total: number; delta: number },
    bucketMax: number,
    cellsLeft: number,
    yCell: number,
    cellH: number,
    cellsWidth: number,
    rowShowText: boolean,
    yCenter: number,
    fontSize: number,
) {
    const frac = Math.min(1, b.total / bucketMax);
    const barW = frac * cellsWidth;
    ctx.fillStyle = b.ask >= b.bid ? C.askFill(0.65) : C.bidFill(0.65);
    ctx.fillRect(cellsLeft, yCell, barW, cellH);
    if (rowShowText) {
        ctx.fillStyle = C.textNormal;
        ctx.textAlign = 'left';
        ctx.fillText(`${b.bid}×${b.ask}`, cellsLeft + 2, yCenter);
    }
}

function _drawDeltaCell(
    ctx: CanvasRenderingContext2D,
    b: { bid: number; ask: number; delta: number },
    bucketMax: number,
    cellsLeft: number,
    yCell: number,
    cellH: number,
    cellsWidth: number,
    rowShowText: boolean,
    yCenter: number,
    fontSize: number,
) {
    const absD = Math.abs(b.delta);
    const frac = bucketMax > 0 ? Math.min(1, absD / bucketMax) : 0;
    const barW = frac * cellsWidth;
    const isPos = b.delta >= 0;
    ctx.fillStyle = isPos
        ? `rgba(0,${Math.round(140 + 90 * frac)},${Math.round(80 * frac)},${0.45 + 0.45 * frac})`
        : `rgba(${Math.round(140 + 115 * frac)},0,${Math.round(40 * frac)},${0.45 + 0.45 * frac})`;
    ctx.fillRect(cellsLeft, yCell, barW, cellH);
    if (rowShowText) {
        const sign = b.delta >= 0 ? '+' : '';
        ctx.fillStyle = C.textNormal;
        ctx.textAlign = 'left';
        ctx.fillText(`${sign}${b.delta}`, cellsLeft + 2, yCenter);
    }
}

function _drawTotalCell(
    ctx: CanvasRenderingContext2D,
    b: { total: number },
    bucketMax: number,
    cellsLeft: number,
    yCell: number,
    cellH: number,
    cellsWidth: number,
    rowShowText: boolean,
    yCenter: number,
    fontSize: number,
) {
    const frac = Math.min(1, b.total / bucketMax);
    const barW = frac * cellsWidth;
    ctx.fillStyle = 'rgba(160,160,180,0.50)';
    ctx.fillRect(cellsLeft, yCell, barW, cellH);
    if (rowShowText) {
        ctx.fillStyle = C.textNormal;
        ctx.textAlign = 'left';
        ctx.fillText(String(b.total), cellsLeft + 2, yCenter);
    }
}

// Stacked imbalance zone overlay
function _drawStackedZones(
    ctx: CanvasRenderingContext2D,
    zones: { low: number; high: number }[],
    side: 'buy' | 'sell',
    cellsLeft: number,
    cellsWidth: number,
    bounds: ViewBounds,
    h: number,
    tickSize: number,
    cs: ChartSettings,
    transformer: LiveTransformer,
) {
    if (zones.length === 0) return;

    const fillColor = side === 'buy' ? C.stackBuy : C.stackSell;
    const borderColor = side === 'buy' ? C.stackBuyBorder : C.stackSellBorder;

    for (const zone of zones) {
        const yTop = transformer.priceToY(zone.high + tickSize, h);
        const yBot = transformer.priceToY(zone.low - tickSize, h);
        const zH = Math.max(2, yBot - yTop);

        ctx.fillStyle = fillColor;
        ctx.fillRect(cellsLeft, yTop, cellsWidth, zH);

        ctx.strokeStyle = borderColor;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(cellsLeft + 0.5, yTop + 0.5, cellsWidth - 1, zH - 1);
        ctx.setLineDash([]);

        // "SI" badge on the right edge of the zone
        ctx.font = 'bold 8px "JetBrains Mono", monospace';
        ctx.textAlign = 'right';
        ctx.fillStyle = borderColor;
        ctx.fillText(side === 'buy' ? '▲SI' : '▼SI', cellsLeft + cellsWidth - 2, yTop + zH / 2);
    }
}

// Unfinished auction marker
function _drawUnfinishedMarker(
    ctx: CanvasRenderingContext2D,
    side: 'top' | 'bottom',
    xCandle: number,
    yExtreme: number,
    barPx: number,
) {
    const arrowSize = Math.min(8, barPx * 0.15);
    const offset = 10; // px above/below the wick tip

    ctx.save();
    ctx.strokeStyle = side === 'top' ? C.unfTop : C.unfBottom;
    ctx.fillStyle = side === 'top' ? C.unfTop : C.unfBottom;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 2]);

    // Dashed horizontal tick line
    ctx.beginPath();
    ctx.moveTo(xCandle - arrowSize * 2, yExtreme);
    ctx.lineTo(xCandle + arrowSize * 2, yExtreme);
    ctx.stroke();
    ctx.setLineDash([]);

    // Arrow pointing outward (up for top, down for bottom)
    const dir = side === 'top' ? -1 : 1;
    const arrowY = yExtreme + dir * offset;

    ctx.beginPath();
    ctx.moveTo(xCandle, arrowY);
    ctx.lineTo(xCandle - arrowSize * 0.7, arrowY - dir * arrowSize);
    ctx.lineTo(xCandle + arrowSize * 0.7, arrowY - dir * arrowSize);
    ctx.closePath();
    ctx.fill();

    // "UA" label
    if (barPx >= 40) {
        ctx.font = 'bold 8px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText('UA', xCandle, arrowY + dir * (arrowSize + 8));
    }

    ctx.restore();
}
