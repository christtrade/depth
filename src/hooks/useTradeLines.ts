// hover, drag, click and right-click for every TradeLine on the chart, ghost
// tp/sl pills included.
//
// ghost drag state lives in a plain ref rather than React state, so dragging a
// pill never re-renders - it calls redraw() and the canvas repaints with no
// component tree involved. state is only set on mouseup, once the drag is
// committed, so the entry line can re-render with the new numGhosts.
'use client';

import { useCallback, useRef, useState } from 'react';
import type { TradeLine, ViewBounds } from '../lib/types';
import {
    hitTestTradeLines,
    type TradeLineHitMap,
    type GhostInteractionState,
    type GhostSlotState,
} from '../lib/renderers/drawTradeLines';
import type { ChartSettings } from '../lib/types/chart-settings';
import { LiveTransformer, type SymbolInfo } from '../core';
import { resolveTickSize } from '../lib/priceFormat';
import { Rect } from '../lib/types/indicator-types';

// Types
type CursorStyle = 'default' | 'ns-resize' | 'pointer' | 'grab' | 'grabbing' | 'not-allowed';

interface UseTradeLines {
    tradeLines: TradeLine[];
    onLinesChange: (lines: TradeLine[]) => void;
    onSyncLines: (lines: TradeLine[]) => void;
    onLineDelete: (line: TradeLine) => void;
    hitMapRef: React.MutableRefObject<TradeLineHitMap>;
    chartWRef: React.MutableRefObject<number>;
    chartHRef: React.MutableRefObject<number>;
    /** Y offset (CSS px) of the main chart pane from the top of the canvas. Non-zero when indicator panes sit above the main area. */
    chartOYRef?: React.MutableRefObject<number>;
    getLayouts: () => Record<string, Rect>;
    boundsRef: React.MutableRefObject<ViewBounds>;
    chartSettingsRef: React.MutableRefObject<ChartSettings>;
    redraw: () => void;
    /** Resolved symbol info - the instrument tick size for price snapping is derived from it. */
    symbolInfoRef?: React.MutableRefObject<SymbolInfo | null>;
    /**
     * Optional ref to the canonical lines map from useTradingState.
     * When provided, line price updates during drag are written directly into
     * this map (no React state update) so the canvas sees fresh values on
     * every animation frame without triggering re-renders.
     */
    linesRef?: React.MutableRefObject<Map<string, TradeLine>>;
    /** Live lookup for lines that bypass React state. See `findLine`. */
    resolveLine?: (id: string) => TradeLine | undefined;

    /**
     * Shared with useTradingState. We write the active line id here on drag
     * start and clear it on drag end, so line rebuilds (e.g. from playback
     * ticks) know to preserve the line currently under the cursor.
     */
    draggingLineIdRef?: React.MutableRefObject<string | null>;

    transformer: LiveTransformer;

    /**
     * Called when the user finishes dragging a ghost TP/SL pill (mouseup).
     * lineId  - the entry line this ghost belongs to (e.g. "position:abc123")
     * kind    - 'tp' | 'sl'
     * index   - 0-based slot index
     * price   - final price (snapped to tickSize)
     */
    onGhostMove?: (lineId: string, kind: 'tp' | 'sl', index: number, price: number) => void;
}

interface UseTradeLinesReturn {
    hoveredLineId: string | null;
    draggingLineId: string | null;
    /** Last computed cursor. One render behind - for rendering, not for reading
     *  inside a pointer handler; use `cursorRef` there. */
    cursor: CursorStyle;
    /**
     * The same value, written synchronously.
     *
     * The chart's own mousemove handler runs `onMouseMove` and then decides, in
     * that same tick, whether the trade lines have claimed the cursor. Reading
     * React state there is always one event stale, which is worst exactly when
     * it matters: move onto a line and stop, and the state set by that last
     * event has no following event to apply it - the pointer keeps the chart's
     * crosshair until you jiggle the mouse.
     */
    cursorRef: React.MutableRefObject<CursorStyle>;
    /**
     * Returns the current ghost interaction state.
     * Call this inside your redraw callback - it reads from the ref so it is
     * always up-to-date without needing React state.
     */
    getGhostState: () => GhostInteractionState;
    onMouseMove: (e: React.MouseEvent<HTMLCanvasElement>) => void;
    onMouseDown: (e: React.MouseEvent<HTMLCanvasElement>) => void;
    onMouseUp: (e: React.MouseEvent<HTMLCanvasElement>) => void;
    onMouseLeave: (e: React.MouseEvent<HTMLCanvasElement>) => void;
    onContextMenu: (e: React.MouseEvent<HTMLCanvasElement>) => void;
    onDoubleClick: (e: React.MouseEvent<HTMLCanvasElement>) => void;
    onClick: (e: React.MouseEvent<HTMLCanvasElement>) => void;
}

function snapToTick(price: number, tickSize?: number): number {
    if (!tickSize || tickSize <= 0) return price;
    return Math.round(price / tickSize) * tickSize;
}

// Ghost state helpers
//
// These operate on a plain object (no React state) for zero-overhead updates
// during mouse drag.

function getOrCreateSlot(state: GhostInteractionState, lineId: string): GhostSlotState {
    return (
        state[lineId] ?? {
            tpPrices: [],
            slPrices: [],
            hoveredGhost: null,
            draggingGhost: null,
        }
    );
}

function setGhostSlotPrice(
    state: GhostInteractionState,
    lineId: string,
    kind: 'tp' | 'sl',
    index: number,
    price: number | undefined,
): GhostInteractionState {
    const gs = getOrCreateSlot(state, lineId);
    const arr = [...(kind === 'tp' ? gs.tpPrices : gs.slPrices)];
    while (arr.length <= index) arr.push(undefined);
    arr[index] = price;
    return {
        ...state,
        [lineId]: {
            ...gs,
            tpPrices: kind === 'tp' ? arr : gs.tpPrices,
            slPrices: kind === 'sl' ? arr : gs.slPrices,
        },
    };
}

// Hook
export function useTradeLines({
    tradeLines,
    onLinesChange,
    onSyncLines,
    onLineDelete,
    hitMapRef,
    chartWRef,
    chartHRef,
    chartOYRef,
    getLayouts,
    boundsRef,
    chartSettingsRef,
    redraw,
    symbolInfoRef,
    onGhostMove,
    linesRef,
    resolveLine,
    draggingLineIdRef,
    transformer,
}: UseTradeLines): UseTradeLinesReturn {
    const [hoveredLineId, setHoveredLineId] = useState<string | null>(null);
    const [draggingLineId, setDraggingLineId] = useState<string | null>(null);
    const [cursor, setCursorState] = useState<CursorStyle>('default');
    const cursorRef = useRef<CursorStyle>('default');
    const setCursor = useCallback((next: CursorStyle) => {
        cursorRef.current = next;
        setCursorState((prev) => (prev === next ? prev : next));
    }, []);

    const onGhostMoveRef = useRef(onGhostMove);
    onGhostMoveRef.current = onGhostMove;

    // Ghost state as a plain ref - NO React state
    //
    // During drag, we mutate this ref directly and call redraw().
    // React is never involved, so there are zero re-renders while dragging.
    // On mouseup we call onGhostMove (which calls useTradingState.handleGhostMove)
    // which in turn calls flushLines() -> setTradeLines() - that single React
    // update re-renders the chart with the new real TP/SL TradeLine.
    const ghostStateRef = useRef<GhostInteractionState>({});

    /** Stable accessor for drawTradeLines - call this inside your render loop. */
    const getGhostState = useCallback(() => ghostStateRef.current, []);

    // Drag state
    const dragRef = useRef<{
        lineId: string;
        startY: number;
        startPrice: number;
        originalPrice: number;
    } | null>(null);

    const ghostDragRef = useRef<{
        lineId: string;
        ghostId: string;
        kind: 'tp' | 'sl';
        index: number;
    } | null>(null);

    // Set to true when a ghost pill is clicked but the mouse hasn't moved yet.
    // On the first mousemove we'll create a NEW slot instead of dragging the
    // existing one, then clear this flag for the remainder of the drag.
    const ghostHitPendingRef = useRef(false);

    // Helpers
    const getCanvasXY = (e: React.MouseEvent<HTMLCanvasElement>): [number, number] => {
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        return [x, y];
    };

    /**
     * `resolveLine` first, because some lines are published straight into the
     * render array through a ref and never pass through React state - order
     * previews, which change with every keystroke and must not re-render the
     * chart to do it. Without it those lines draw but cannot be grabbed.
     */
    const findLine = useCallback(
        (id: string): TradeLine | undefined =>
            resolveLine?.(id) ?? tradeLines.find((l) => l.id === id),
        [tradeLines, resolveLine],
    );

    const updateLine = useCallback(
        (id: string, patch: Partial<TradeLine>) => {
            onLinesChange(tradeLines.map((l) => (l.id === id ? { ...l, ...patch } : l)));
        },
        [tradeLines, onLinesChange],
    );

    // onMouseMove
    const onMouseMove = useCallback(
        (e: React.MouseEvent<HTMLCanvasElement>) => {
            const [mx, my] = getCanvasXY(e);

            const _layouts = getLayouts();
            chartHRef.current = _layouts['main']?.h;
            chartOYRef.current = _layouts['main']?.y ?? 0;

            // Ghost pill drag
            if (ghostDragRef.current) {
                const { lineId, kind } = ghostDragRef.current;
                let newPrice = transformer.yToPrice(
                    my - (chartOYRef?.current ?? 0),
                    chartHRef.current,
                );
                newPrice = snapToTick(newPrice, resolveTickSize(symbolInfoRef?.current));

                // First movement after clicking a ghost -> spawn a NEW slot
                // instead of repositioning the existing one.
                if (ghostHitPendingRef.current) {
                    ghostHitPendingRef.current = false;

                    const gs = getOrCreateSlot(ghostStateRef.current, lineId);
                    const existingPrices = kind === 'tp' ? gs.tpPrices : gs.slPrices;
                    const newIndex = existingPrices.length;
                    const newGhostId = `${lineId}-${kind}-${newIndex}`;

                    // Point the drag ref at the brand-new slot
                    ghostDragRef.current = { lineId, ghostId: newGhostId, kind, index: newIndex };
                }

                const { index, ghostId } = ghostDragRef.current;

                // Mutate the ref directly - no setState, no re-render
                ghostStateRef.current = setGhostSlotPrice(
                    ghostStateRef.current,
                    lineId,
                    kind,
                    index,
                    newPrice,
                );
                // Also update the dragging marker on the slot
                const gs = ghostStateRef.current[lineId];
                if (gs) {
                    ghostStateRef.current = {
                        ...ghostStateRef.current,
                        [lineId]: {
                            ...gs,
                            draggingGhost: ghostId,
                            draggingGhostIdx: index,
                            draggingGhostType: kind,
                        },
                    };
                }

                redraw();
                return;
            }

            // Regular line drag
            if (dragRef.current) {
                const { lineId } = dragRef.current;
                const line = findLine(lineId);
                if (!line || line.locked) return;

                // const bounds = boundsRef.current;
                // const cs = chartSettingsRef.current;
                let newPrice = transformer.yToPrice(
                    my - (chartOYRef?.current ?? 0),
                    chartHRef.current,
                );
                newPrice = snapToTick(newPrice, line.tickSize ?? resolveTickSize(symbolInfoRef?.current));

                // Call onMove with the actual current drag price (not the stale
                // line.price). onMove may call handle.setLabel / handle.setPrice
                // which mutate linesRef directly - no React state update, no
                // re-render fighting the drag.
                if (line?.onMove) {
                    line.onMove(newPrice);
                }

                // Move the line live. Two plain ref writes, no setState:
                //   1. linesRef - the canonical map flushLines() reads from.
                //   2. the rendered array (via onSyncLines) - what the canvas
                //      actually draws each frame, including frames driven by the
                //      playback loop.
                // Writing the *new* price into the rendered array (rather than the
                // stale `existing`) is what makes the line follow the cursor while
                // dragging instead of snapping into place only on mouseup. Because
                // neither write triggers a React re-render, there's nothing for the
                // drag to fight.
                const existing = linesRef.current?.get(lineId);
                if (existing) {
                    linesRef.current.set(lineId, { ...existing, price: newPrice });
                    onSyncLines([...linesRef.current.values()]);
                } else {
                    // Lines not backed by linesRef (e.g. externally managed) -
                    // patch the rendered array directly with the new price.
                    updateLine(lineId, { price: newPrice });
                }

                redraw();
                return;
            }

            // Hover detection
            const hit = hitTestTradeLines(mx, my, hitMapRef.current);

            if (hit.ghostHit) {
                const { lineId, ghostId } = hit.ghostHit;
                const gs = getOrCreateSlot(ghostStateRef.current, lineId);
                if (gs.hoveredGhost !== ghostId) {
                    // Clear hover on any other line's ghost
                    const next: GhostInteractionState = {};
                    for (const [id, slot] of Object.entries(ghostStateRef.current)) {
                        next[id] =
                            id === lineId
                                ? { ...slot, hoveredGhost: ghostId }
                                : { ...slot, hoveredGhost: null };
                    }
                    if (!next[lineId]) next[lineId] = { ...gs, hoveredGhost: ghostId };
                    ghostStateRef.current = next;
                    redraw();
                }
                setHoveredLineId(null);
                setCursor('ns-resize');
                return;
            }

            // Clear any ghost hover
            let ghostHoverChanged = false;
            const nextGhostState: GhostInteractionState = {};
            for (const [id, gs] of Object.entries(ghostStateRef.current)) {
                if (gs.hoveredGhost) {
                    nextGhostState[id] = { ...gs, hoveredGhost: null };
                    ghostHoverChanged = true;
                } else {
                    nextGhostState[id] = gs;
                }
            }
            if (ghostHoverChanged) {
                ghostStateRef.current = nextGhostState;
                redraw();
            }

            if (hit.lineId !== hoveredLineId) {
                setHoveredLineId(hit.lineId);
                redraw();
            }

            if (!hit.lineId) {
                setCursor('default');
                return;
            }
            const line = findLine(hit.lineId);
            if (!line || line.locked) {
                setCursor('default');
                return;
            }
            switch (hit.part) {
                case 'close':
                case 'reverse':
                    setCursor('pointer');
                    break;
                case 'pricePill':
                    setCursor(line.movable ? 'ns-resize' : 'default');
                    break;
                case 'line':
                case 'pill':
                    setCursor(line.movable ? 'ns-resize' : 'pointer');
                    break;
                default:
                    setCursor('default');
            }
        },
        [
            hoveredLineId,
            findLine,
            updateLine,
            onSyncLines,
            chartHRef,
            boundsRef,
            chartSettingsRef,
            hitMapRef,
            redraw,
            symbolInfoRef,
            linesRef,
            transformer,
        ],
    );

    // onMouseDown
    const onMouseDown = useCallback(
        (e: React.MouseEvent<HTMLCanvasElement>) => {
            if (e.button == 2) {
                if (ghostDragRef.current) ghostDragRef.current = null;
                e.stopPropagation();
                e.preventDefault();
            }
            if (e.button !== 0) return;

            const [mx, my] = getCanvasXY(e);
            const hit = hitTestTradeLines(mx, my, hitMapRef.current);

            if (hit.ghostHit) {
                const { lineId, ghostId, kind, index } = hit.ghostHit;
                e.stopPropagation();
                e.preventDefault();
                ghostDragRef.current = { lineId, ghostId, kind, index };
                ghostHitPendingRef.current = true;

                const gs = getOrCreateSlot(ghostStateRef.current, lineId);
                ghostStateRef.current = {
                    ...ghostStateRef.current,
                    [lineId]: { ...gs, draggingGhost: ghostId },
                };

                // ns-resize, not grabbing: these only ever move on one axis, and
                // the resize cursor is the one that says which.
                setCursor('ns-resize');
                return;
            }

            if (!hit.lineId) return;
            const line = findLine(hit.lineId);
            if (!line || line.locked) return;

            if (
                line.movable &&
                (hit.part === 'line' || hit.part === 'pill' || hit.part === 'pricePill')
            ) {
                e.stopPropagation();
                e.preventDefault();
                dragRef.current = {
                    lineId: hit.lineId,
                    startY: my,
                    startPrice: line.price,
                    originalPrice: line.price,
                };
                if (draggingLineIdRef) draggingLineIdRef.current = hit.lineId;
                setDraggingLineId(hit.lineId);
                setCursor('ns-resize');
            }
        },
        [findLine, hitMapRef],
    );

    // onMouseUp
    const onMouseUp = useCallback(
        (_e: React.MouseEvent<HTMLCanvasElement>) => {
            // Ghost drag end
            if (ghostDragRef.current) {
                const { lineId, kind, index } = ghostDragRef.current;
                ghostDragRef.current = null;
                ghostHitPendingRef.current = false;

                const gs = ghostStateRef.current[lineId];
                if (gs) {
                    const price = kind === 'tp' ? gs.tpPrices?.[index] : gs.slPrices?.[index];

                    // Commit: notify consumer (this triggers the real TradeLine to be created)
                    if (price != null) {
                        onGhostMoveRef.current?.(lineId, kind, index, price);
                    }

                    // Clear the dragging marker but keep the price so the ghost
                    // still shows where it is until the real line replaces it.
                    ghostStateRef.current = {
                        ...ghostStateRef.current,
                        [lineId]: {
                            ...gs,
                            draggingGhost: null,
                            draggingGhostType: null,
                            draggingGhostIdx: null,
                        },
                    };
                }

                setCursor('ns-resize');
                redraw();
                return;
            }

            // Regular line drag end
            if (!dragRef.current) return;
            const { lineId } = dragRef.current;
            // Unpin before committing so the rebuild triggered by afterMove uses
            // the engine's canonical (amended) price.
            if (draggingLineIdRef) draggingLineIdRef.current = null;
            const line = findLine(lineId);

            // Commit the final price to React state so tradeLines snapshot
            // reflects where the line landed. The line object in linesRef
            // already has the updated price from the last onMouseMove.
            if (line) {
                // Read price from linesRef if available (most up-to-date), else
                // fall back to the stale React snapshot value.
                const canonical = linesRef?.current?.get(lineId);
                const finalPrice = canonical?.price ?? line.price;
                if (line?.afterMove) {
                    line.afterMove(finalPrice);
                }
                // Sync React state with the final position
                updateLine(lineId, { price: finalPrice });
            }

            dragRef.current = null;
            setDraggingLineId(null);
            setCursor('ns-resize');
            redraw();
        },
        [findLine, updateLine, linesRef, redraw],
    );

    // onMouseLeave
    const onMouseLeave = useCallback(
        (_e: React.MouseEvent<HTMLCanvasElement>) => {
            if (dragRef.current || ghostDragRef.current) return;
            if (hoveredLineId) {
                setHoveredLineId(null);
                redraw();
            }

            let changed = false;
            const next: GhostInteractionState = {};
            for (const [id, gs] of Object.entries(ghostStateRef.current)) {
                if (gs.hoveredGhost) {
                    next[id] = { ...gs, hoveredGhost: null };
                    changed = true;
                } else {
                    next[id] = gs;
                }
            }
            if (changed) {
                ghostStateRef.current = next;
                redraw();
            }

            setCursor('default');
        },
        [hoveredLineId, redraw],
    );

    // onContextMenu
    const onContextMenu = useCallback(
        (e: React.MouseEvent<HTMLCanvasElement>) => {
            const [mx, my] = getCanvasXY(e);
            const hit = hitTestTradeLines(mx, my, hitMapRef.current);
            if (!hit.lineId) return;

            const line = findLine(hit.lineId);
            if (!line?.onContextMenu) return;

            e.preventDefault();
            e.stopPropagation();
            line.onContextMenu(line.price, my);
        },
        [findLine, hitMapRef],
    );

    // onClick
    const onClick = useCallback(
        (e: React.MouseEvent<HTMLCanvasElement>) => {
            const [mx, my] = getCanvasXY(e);
            const hit = hitTestTradeLines(mx, my, hitMapRef.current);

            if (hit.ghostHit) return;

            if (!hit.lineId) return;
            const line = findLine(hit.lineId);
            if (!line || line.locked) return;

            if (hit.part === 'close') {
                e.stopPropagation();
                onLineDelete(line);
                line.onClose?.();
                setHoveredLineId(null);
                setCursor('default');
                return;
            }

            if (hit.part === 'reverse') {
                e.stopPropagation();
                line.onReverse?.();
                return;
            }
        },
        [findLine, hitMapRef, onLineDelete],
    );

    // onDoubleClick
    const onDoubleClick = useCallback(
        (e: React.MouseEvent<HTMLCanvasElement>) => {
            const [mx, my] = getCanvasXY(e);
            const hit = hitTestTradeLines(mx, my, hitMapRef.current);
            if (!hit.lineId) return;

            const line = findLine(hit.lineId);
            if (!line?.onDoubleClick) return;

            e.stopPropagation();
            line.onDoubleClick(line.price);
        },
        [findLine, hitMapRef],
    );

    return {
        hoveredLineId,
        draggingLineId,
        cursor,
        cursorRef,
        getGhostState,
        onMouseMove,
        onMouseDown,
        onMouseUp,
        onMouseLeave,
        onContextMenu,
        onDoubleClick,
        onClick,
    };
}
