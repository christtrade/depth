
import { TypedEventBus } from './TypedEventBus';
import { drawBaseLayer, drawUILayer, X_AXIS_HEIGHT } from '../lib/renderers/renderer';
import { drawDrawingsLayer } from '../lib/renderers/drawings-renderer';
import type { ChartPane, Rect } from '../lib/types/indicator-types';
import type { Indicator } from '../lib/types/indicator-types';
import type { TradePoint, PriceHistory, ViewBounds } from '../lib/types';
import type { FootprintBar } from '../lib/types/footprint';
import type { ChartSettings } from '../lib/types/chart-settings';
import type { Crosshair } from '../lib/renderers/renderer';
import type { Drawing, DraftDrawing, DrawingAnchorId, ActiveDrawingTool } from '../lib/types/drawing-types';
import type { TradeLine } from '../lib/types';
import { LiveTransformer } from '../interfaces/ICoordinateTransformer';
import { ChartTypePlugin } from './PluginRegistry';
import { getEffectiveDpr } from '../lib/dpr';
import { PriceTransition } from '../lib/priceTransition';
import { SessionMapper } from './SessionMapper';
import { AccountSnapshot, DataLevel, SymbolInfo } from '.';
import type { CrosshairSync } from '../lib/types/layout-sync';

export type DrawHook = (
    ctx: CanvasRenderingContext2D,
    view: ViewBounds,
    transformer: LiveTransformer,
) => void;

// the ChristTrade mark. inlined as base64 so the asset compiles into the engine
// and theres no external file to drop or repath. decoded once into an img and
// cached, and the first draw after it loads asks for a base repaint.
const BANNER_ASPECT = 1640 / 407;
const BANNER_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAABmgAAAGXCAMAAACAxC+oAAAAAXNSR0IB2cksfwAAAAlwSFlzAAALEwAACxMBAJqcGAAAAwBQTFRFAAAA////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////Bz0LCAAAAQB0Uk5TADDmvyXL/9sJLId/8MNDgD6+dve0NfFqMZpsqvoF5zMnaGmcqcjr9C8jdE+3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';
let bannerImg: HTMLImageElement | null = null;
let bannerReady = false;
function getBanner(onReady: () => void): HTMLImageElement | null {
    if (bannerReady) return bannerImg;
    if (bannerImg) return null; // decode already in flight
    if (typeof Image === 'undefined') return null;
    bannerImg = new Image();
    bannerImg.onload = () => {
        bannerReady = true;
        onReady();
    };
    bannerImg.src = BANNER_DATA_URI;
    return null;
}

export interface DrawParams {
    panes: ChartPane[];
    layouts: Record<string, Rect>;
    indicators: Indicator[];
    trades: TradePoint[];
    priceHistory: PriceHistory[];
    footprintBars: FootprintBar[];
    heatmapBitmap: ImageBitmap | null;
    bitmapOffsets: { x: number; y: number; w: number; h: number };
    barNs: bigint;
    chartSettings: ChartSettings;
    horizon: bigint;
    candleCache: Map<bigint, any> | null;
    openBar: FootprintBar | null;
    /** Bars to render as candles - OHLCV adapter data or loading-preview bars. */
    ohlcvBars: {
        time: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
    }[];
    // UI layer specific
    crosshair: Crosshair | null;
    drawings: Drawing[];
    draft: DraftDrawing | null;
    tradeLines: TradeLine[];
    hoveredDividerIdx: number;
    hoveringLegend: boolean;
    showTooltip: boolean;
    selectedTrade: TradePoint | null;
    activeTool: ActiveDrawingTool;
    draggingAnchor: any;
    isHoldingCtrl: boolean;
    isHoldingShift: boolean;
    showShiftInfo: boolean;
    shiftInfoAnchor: { ts: bigint; price: number; x: number; y: number };
    shiftInfoAnchor2: { ts: bigint; price: number; x: number; y: number } | null;
    //drawings
    tradeLineInteraction: any;
    selectedDrawingId: string;
    hoveredDrawingId: string;
    hotAnchor: DrawingAnchorId;
    editingTextId: string;
    transformer: LiveTransformer;
    sessionMapper: SessionMapper;

    isPluginChartType: boolean;
    chartPlugin?: ChartTypePlugin;
    pluginComputed?: unknown;

    dataLevel: DataLevel;
    accountSnapshot: AccountSnapshot;

    symbolInfo: SymbolInfo;

    /**
     * Width (css px) of the right price axis. Derived from the symbol's price
     * precision and the visible range, not a user setting.
     */
    priceScaleWidth: number;

    hidePriceScale: boolean;
    hideTimeScale: boolean;

    /**
     * Crosshair mirrored from another cell of the layout, in data space.
     * Projected onto this chart's own axes at paint time, so pan and zoom keep it
     * on the right bar with no extra traffic. Null when this chart owns the
     * pointer, or nothing is being mirrored.
     */
    syncCrosshair: CrosshairSync | null;
}

export class RenderEngine {
    // three stacked canvases, the caller positions them
    private readonly baseCanvas: HTMLCanvasElement; // grid + data
    private readonly drawingsCanvas: HTMLCanvasElement; // drawings
    private readonly uiCanvas: HTMLCanvasElement; // crosshair + interactive

    private readonly eventBus: TypedEventBus;

    // which cell this engine paints. stamped on the events it puts on the
    // layout-wide bus so other cells can ignore them.
    private readonly chartId: number;

    // runs forever, only paints dirty layers
    private rafId = 0;
    private dirty = { base: true, drawings: true, ui: true };

    // called inside the raf loop, around the data layer
    private beforeBaseDraw: Set<DrawHook> = new Set();
    private afterBaseDraw: Set<DrawHook> = new Set();
    private afterUIDraw: Set<DrawHook> = new Set();

    // the data snapshot the draw functions read
    private drawParams: DrawParams | null = null;
    private view: ViewBounds | null = null;

    // Eases the live price line / pills toward new values (opt-in, see drawUILayer).
    private readonly priceTransition = new PriceTransition();

    private resizeObserver: ResizeObserver;
    private destroyed = false;

    constructor(
        baseCanvas: HTMLCanvasElement,
        drawingsCanvas: HTMLCanvasElement,
        uiCanvas: HTMLCanvasElement,
        eventBus: TypedEventBus,
        chartId = 0,
    ) {
        this.baseCanvas = baseCanvas;
        this.drawingsCanvas = drawingsCanvas;
        this.uiCanvas = uiCanvas;
        this.eventBus = eventBus;
        this.chartId = chartId;

        this.resizeObserver = new ResizeObserver((entries) => this.handleResize(entries[0]));
        // parent, not canvas - the canvases are absolutely positioned inside it,
        // so the parent is what actually changes size. device-pixel-content-box
        // is what lands the bitmap on exact device pixels, and observe() throws
        // on browsers that dont know the box type, hence the fallback.
        try {
            this.resizeObserver.observe(this.baseCanvas.parentElement!, {
                box: 'device-pixel-content-box',
            });
        } catch {
            this.resizeObserver.observe(this.baseCanvas.parentElement!);
        }
        this.startLoop();
    }

    // only paints layers marked dirty, so it costs about nothing when idle

    private startLoop(): void {
        const tick = () => {
            if (this.destroyed) return;

            if (this.dirty.base) {
                const ctx = this.baseCanvas.getContext('2d');
                if (ctx) {
                    for (const hook of this.beforeBaseDraw)
                        hook(ctx, this.view!, this.drawParams.transformer);
                    this.doBaseRedraw();
                    for (const hook of this.afterBaseDraw)
                        hook(ctx, this.view!, this.drawParams.transformer);
                }
                this.dirty.base = false;
                // the ui layer holds the axis labels and price pills for the
                // bounds base was just painted at, so it always follows a base
                // paint. flagging it here rather than painting from inside
                // doBaseRedraw is what stops a pan (which dirties both every
                // frame) painting the whole ui layer twice.
                this.dirty.ui = true;
            }

            if (this.dirty.drawings) {
                this.doDrawingsRedraw();
                this.dirty.drawings = false;
            }

            if (this.dirty.ui) {
                const ctx = this.uiCanvas.getContext('2d');
                if (ctx) {
                    this.doUIRedraw();
                    for (const hook of this.afterUIDraw)
                        hook(ctx, this.view!, this.drawParams.transformer);
                }
                this.dirty.ui = false;
            }

            // keep the ui layer repainting while a price tween is in flight,
            // whichever layer triggered this frame - the price line and pills live
            // there. a base paint dirties ui above, so a tick arriving on base
            // still advances the tween.
            if (this.priceTransition.isAnimating(performance.now())) this.dirty.ui = true;

            this.rafId = requestAnimationFrame(tick);
        };

        this.rafId = requestAnimationFrame(tick);
    }

    // the only external API for triggering a redraw
    markDirty(layer: 'base' | 'drawings' | 'ui'): void {
        this.dirty[layer] = true;
    }

    // for stuff like a theme change
    markAllDirty(): void {
        this.dirty.base = true;
        this.dirty.drawings = true;
        this.dirty.ui = true;
    }

    // called before marking dirty
    setDrawParams(params: DrawParams): void {
        this.drawParams = params;
    }

    setView(v: ViewBounds): void {
        this.view = v;
    }

    getView(): ViewBounds | null {
        return this.view;
    }

    // Draw functions

    private doBaseRedraw(): void {
        const p = this.drawParams;
        if (!p || !this.view) return;

        const canvas = this.baseCanvas;
        const view = this.view;
        const dpr = getEffectiveDpr();
        const cssW = canvas.width / dpr; // exact inverse of how we sized it
        const cssH = canvas.height / dpr;
        const chartW = cssW - p.priceScaleWidth;
        const layouts = p.layouts;
        const mainRect = layouts['main'];
        const mainH = mainRect ? mainRect.h : cssH - (p.hideTimeScale ? 0 : X_AXIS_HEIGHT);

        let bitmapOffsetX = 0,
            bitmapOffsetY = 0;
        let bitmapOffsetW = chartW,
            bitmapOffsetH = mainH;

        if (p.heatmapBitmap && p.bitmapOffsets) {
            bitmapOffsetX = p.bitmapOffsets.x;
            bitmapOffsetY = p.bitmapOffsets.y;
            bitmapOffsetW = p.bitmapOffsets.w;
            bitmapOffsetH = p.bitmapOffsets.h;
        }

        drawBaseLayer(
            canvas,
            p.panes,
            p.layouts,
            p.indicators,
            p.trades,
            p.priceHistory,
            [],
            view,
            p.footprintBars,
            p.heatmapBitmap,
            bitmapOffsetX,
            bitmapOffsetY,
            bitmapOffsetW,
            bitmapOffsetH,
            p.barNs,
            p.chartSettings,
            p.horizon,
            p.candleCache,
            p.openBar,
            p.ohlcvBars,
            p.transformer,
            p.isPluginChartType,
            p.sessionMapper,
            p.dataLevel,
            p.hidePriceScale,
            p.hideTimeScale,
            p.symbolInfo,
            p.priceScaleWidth,
        );

        if (p.isPluginChartType && p.chartPlugin) {
            const ctx2d = canvas.getContext('2d');
            const mainRect = layouts['main'];
            if (ctx2d && mainRect) {
                ctx2d.save();
                ctx2d.beginPath();
                ctx2d.rect(mainRect.x, mainRect.y, mainRect.w, mainRect.h);
                ctx2d.clip();
                ctx2d.translate(mainRect.x, mainRect.y);
                p.chartPlugin.draw({
                    ctx: ctx2d,
                    rect: { ...mainRect, x: 0, y: 0 },
                    view,
                    transformer: p.transformer,
                    footprintBars: p.footprintBars,
                    trades: p.trades,
                    priceHistory: p.priceHistory,
                    barNs: p.barNs,
                    chartSettings: p.chartSettings,
                    computed: p.pluginComputed ?? null,
                });
                ctx2d.restore();
            }
        }

        this.drawAttribution(canvas, layouts, cssH, p.hideTimeScale);
    }

    /**
     * Draws the ChristTrade banner into the base layer, in the same pass that
     * paints the price data, so the attribution shares the chart's coordinate
     * space and DPR transform.
     *
     * Apache-2.0 does not require you to keep this. See the Attribution section
     * of the README for the ask, and NOTICE for what the trademark does cover.
     */
    private drawAttribution(
        canvas: HTMLCanvasElement,
        layouts: Record<string, Rect>,
        cssH: number,
        hideTimeScale: boolean,
    ): void {
        const banner = getBanner(() => this.markDirty('base'));
        if (!banner) return; // not decoded yet - the onReady callback will repaint

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const dpr = getEffectiveDpr();
        const main = layouts['main'];

        // anchored bottom-left of the price region, excluding the time axis so it
        // never collides with the labels. falls back to the full canvas.
        const regionLeft = main ? main.x : 0;
        const regionBottom = main
            ? main.y + main.h
            : cssH - (hideTimeScale ? 0 : X_AXIS_HEIGHT);

        const pad = 10;
        const w = 170;
        const h = w / BANNER_ASPECT;
        const x = regionLeft + pad;
        const y = regionBottom - pad - h;

        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.globalAlpha = 0.55;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(banner, x, y, w, h);
        ctx.restore();
    }

    private doDrawingsRedraw(): void {
        const p = this.drawParams;
        if (!p || !this.view) return;

        drawDrawingsLayer(
            this.drawingsCanvas,
            p.drawings,
            this.view,
            p.panes,
            p.selectedDrawingId,
            p.hoveredDrawingId,
            p.hotAnchor,
            p.draft,
            p.crosshair,
            p.editingTextId,
            p.isHoldingCtrl,
            p.isHoldingShift,
            p.barNs,
            p.chartSettings,
            p.footprintBars,
            p.priceHistory,
            p.transformer,
            p.hidePriceScale,
            p.hideTimeScale,
            p.priceScaleWidth,
            p.symbolInfo,
            p.horizon,
        );
    }

    private doUIRedraw(): void {
        const p = this.drawParams;
        if (!p || !this.view) return;

        const hitMap = drawUILayer(
            this.uiCanvas,
            p.priceHistory,
            p.trades,
            this.view,
            p.crosshair,
            p.showTooltip,
            p.selectedTrade,
            p.panes,
            p.layouts,
            p.indicators,
            p.hoveredDividerIdx,
            p.hoveringLegend,
            p.barNs,
            p.chartSettings,
            p.horizon,
            p.candleCache,
            p.ohlcvBars,
            p.openBar as any,
            p.tradeLines,
            p.tradeLineInteraction,
            p.tradeLineInteraction.hoveredLineId,
            p.tradeLineInteraction.draggingLineId,
            p.activeTool,
            p.draggingAnchor,
            p.isHoldingCtrl,
            p.isHoldingShift,
            p.footprintBars,
            p.drawings,
            p.draft,
            p.transformer,
            p.showShiftInfo,
            p.shiftInfoAnchor,
            p.shiftInfoAnchor2,
            p.dataLevel,
            p.accountSnapshot,
            p.symbolInfo,
            p.hidePriceScale,
            p.hideTimeScale,
            p.priceScaleWidth,
            this.priceTransition,
            p.syncCrosshair,
        );

        this.eventBus.emit('hitmap:update', { id: this.chartId, hitMap });
    }

    // Plugin hooks
    addDrawHook(phase: 'before-base' | 'after-base' | 'after-ui', hook: DrawHook): () => void {
        const set =
            phase === 'before-base'
                ? this.beforeBaseDraw
                : phase === 'after-base'
                  ? this.afterBaseDraw
                  : this.afterUIDraw;
        set.add(hook);
        return () => set.delete(hook);
    }

    // ResizeObserver
    // sizes the three canvases so one bitmap pixel is exactly one device pixel.
    // this is the whole ballgame for sharpness - a bitmap that doesnt match the
    // device-pixel box the compositor hands it gets resampled, and every candle
    // edge softens. floor(offsetWidth * dpr) got it wrong twice over: offsetWidth
    // is rounded to a whole css pixel and the floor threw away another device
    // pixel. a chart on a whole-number width never noticed, but grid cells sized
    // in fr land on fractional widths almost every time, which is why the small
    // panes were the blurry ones.
    // device-pixel-content-box reports the box already snapped the way the
    // compositor will snap it, fractional origin and all, so matching it means no
    // resampling. browsers without it get the rounded measurement, still better
    // than flooring a rounded css width.
    private handleResize(entry?: ResizeObserverEntry): void {
        const dpr = getEffectiveDpr();
        const container = this.baseCanvas.parentElement!;

        const devBox = entry?.devicePixelContentBoxSize?.[0];
        let physW: number;
        let physH: number;
        if (devBox) {
            physW = devBox.inlineSize;
            physH = devBox.blockSize;
        } else {
            const rect = container.getBoundingClientRect();
            physW = Math.round(rect.width * dpr);
            physH = Math.round(rect.height * dpr);
        }

        if (physW <= 0 || physH <= 0) return;

        for (const c of [this.baseCanvas, this.drawingsCanvas, this.uiCanvas]) {
            if (c.width !== physW || c.height !== physH) {
                c.width = physW;
                c.height = physH;
            }
        }

        // tell the React shell to recompute pane layouts - the handler calls
        // pushDrawParams so layouts reflect the new canvas size before we draw
        if (this.view) {
            this.eventBus.emit('view:change', this.view);
            this.eventBus.emit('plugin:redraw-indicators', undefined);
        }

        // ResizeObserver fires after raf in the frame cycle, so marking dirty
        // alone leaves the canvas blank for a full frame. flush synchronously
        // here so the draw happens before the paint.
        this.flushSync();
    }

    private flushSync(): void {
        if (!this.drawParams || !this.view) {
            this.markAllDirty();
            return;
        }
        this.doBaseRedraw();
        this.doDrawingsRedraw();
        this.doUIRedraw();
        this.dirty.base = false;
        this.dirty.drawings = false;
        this.dirty.ui = false;
    }

    // Snapshot export
    toDataURL(type = 'image/png'): string {
        return this.baseCanvas.toDataURL(type);
    }

    /**
     * All three layers flattened onto a fresh canvas, in paint order. Use this
     * rather than `toDataURL` when the snapshot should include the drawings and
     * the crosshair/UI layer.
     */
    captureComposite(): HTMLCanvasElement {
        const out = document.createElement('canvas');
        out.width = this.baseCanvas.width;
        out.height = this.baseCanvas.height;

        const ctx = out.getContext('2d');
        if (!ctx) throw new Error('[RenderEngine] Could not get a 2D context for the snapshot.');

        ctx.drawImage(this.baseCanvas, 0, 0);
        ctx.drawImage(this.drawingsCanvas, 0, 0);
        ctx.drawImage(this.uiCanvas, 0, 0);

        return out;
    }

    // Lifecycle
    destroy(): void {
        this.destroyed = true;
        this.resizeObserver.disconnect();
        cancelAnimationFrame(this.rafId);
    }
}
