// the bridge between a trading engine or broker adapter and the chart. it holds
// the canonical orders and positions, turns them into the TradeLines the chart
// draws, keeps pnl live off the ticks pushed in, and emits TradingEvents.
//
// it never talks to a broker, decides a fill price, or does any matching - the
// engine owns all of that:
//
//   const trading = useTradingState();
//   trading.upsertOrder(order);
//   trading.applyFill(fill);
//   trading.tick({ symbol: 'NQ', bid: 19980, ask: 19981, ts });
//
// a position's takeProfits/stopLosses each get their own draggable line.
// dragging one creates a new level if the ghost slot hasnt been committed yet,
// or updates the existing level if it has.
'use client';

import { useCallback, useRef, useState } from 'react';
import { nanoid } from 'nanoid';
import {
    notifyBracketMoved,
    notifyMessage,
    notifyPositionOpened,
} from '../lib/notifications/tradeToast';
import type { TradeLine, TradeLineKind, TradeLineSide } from '../lib/types';
import {
    type Order,
    type Fill,
    type Position,
    type BracketLevel,
    type BracketAmendment,
    type OrderSide,
    type PositionSide,
    type PriceTick,
    type TradingEvent,
    calcUnrealizedPnl,
    calcUnrealizedPnlPct,
    formatPnl,
    getTickValue,
} from '../lib/types/trading-types';

// Options
export interface UseTradingStateOptions {
    /**
     * Subscribe to all trading lifecycle events.
     * Stable reference - wrap in useCallback if defined inline.
     */
    onEvent?: (event: TradingEvent) => void;

    /**
     * Override the PnL label shown in position line pills.
     * Default: "+$420.00 - +2.10%"
     */
    formatPnlLabel?: (pnl: number, pct: number) => string;

    /**
     * Minimum tick size - used to snap bracket order line prices on drag.
     */
    tickSize?: number;

    /**
     * Dollar value per 1 price-unit move per contract.
     * Sourced from SymbolInfo.contract.multiplier when available.
     * Falls back to per-symbol string matching when omitted.
     */
    tickValue?: number;

    /**
     * Which price to use for unrealized PnL mark.
     *
     * 'conservative' (default) - bid for long positions, ask for short.
     *   This is the exchange-standard mark-to-market convention: it reflects
     *   the price you would actually receive if you exited right now.
     *   A long exits by selling -> filled at bid.
     *   A short exits by buying -> filled at ask.
     *
     * 'mid'  - midpoint of bid/ask. Overstates PnL by half the spread on
     *   both sides. Useful for display purposes only.
     *
     * 'last' - last trade price. Natural for replay/backtest scenarios.
     *   Falls back to mid if no last price is available.
     *
     * 'bid'  - always bid regardless of side.
     * 'ask'  - always ask regardless of side.
     */
    markMode?: 'conservative' | 'bid' | 'ask' | 'mid' | 'last';

    /**
     * If true, bracket TP/SL lines are only shown when the parent position
     * line is hovered. Default: false (always visible).
     */
    bracketLinesOnHoverOnly?: boolean;

    onUpdatePosition?: (position: Position) => void;
    onUpdateOrder?: (order: Order) => void;

    /**
     * Called when the user drags a working order line to a new price.
     * You should send the amend request to your broker here.
     */
    onAmendOrder?: (orderId: string, newPrice: number) => void;

    /**
     * Called when the user drags a TP or SL bracket line to a new price.
     * Receives a full BracketAmendment so your broker adapter has everything
     * it needs: position id, which side, the array index, the level id (if
     * you assigned one), the new price and the qty of that level.
     */
    onAmendBracket?: (amendment: BracketAmendment) => void;

    /**
     * Called when the user clicks the x button on an order line.
     */
    onCancelOrder?: (orderId: string) => void;

    /**
     * Called when the user clicks the x button on a position line.
     */
    onClosePosition?: (positionId: string) => void;

    /**
     * Called when the user clicks the ↕ (reverse) button on a position line.
     */
    onReversePosition?: (positionId: string) => void;

    /**
     * Called when user right-clicks any trade line.
     */
    onContextMenu?: (kind: 'order' | 'position', id: string, price: number, y: number) => void;
}

// State snapshots (what you get back)
export interface TradingState {
    orders: Map<string, Order>;
    positions: Map<string, Position>;
    fills: Fill[];
    tradeLines: TradeLine[];
}

// Return type
export interface UseTradingStateReturn extends TradingState {
    upsertOrder: (order: Order) => void;
    removeOrder: (orderId: string) => void;
    applyFill: (fill: Fill) => void;
    upsertPosition: (position: Position) => void;
    toast: (
        title: string,
        options?: { description?: string; tone?: 'profit' | 'loss' | 'neutral' },
    ) => void;
    removePosition: (positionId: string) => void;
    tick: (priceTick: PriceTick) => void;
    syncOrders: (orders: Order[]) => void;
    syncPositions: (positions: Position[]) => void;
    reset: () => void;

    /**
     * The canonical lines map. Pass as `linesRef` to useTradeLines so drag
     * price updates bypass React state during the drag and go straight to the
     * canvas via redraw().
     */
    linesRef: React.MutableRefObject<Map<string, TradeLine>>;

    /**
     * Id of the bracket line currently being dragged. Pass to useTradeLines so
     * it can flag the active drag; while set, line rebuilds (e.g. from playback
     * ticks) preserve that line's live price instead of reverting it.
     */
    draggingLineIdRef: React.MutableRefObject<string | null>;

    /**
     * Register the chart's redraw callback. Call this once after the chart
     * mounts, e.g. in a useEffect. Enables handle.setLabel / handle.setPrice
     * to repaint the canvas without a React re-render.
     *
     *   useEffect(() => {
     *     trading.registerRedraw(redraw);
     *   }, [redraw]);
     */
    registerRedraw: (fn: () => void) => void;

    /**
     * Pass this directly to useTradeLines as the `onGhostMove` prop.
     *
     * When the user drags a ghost TP/SL pill:
     *   - If a real level already exists at that slot index, its price is updated.
     *   - If the slot is new (index === existing levels length), a new level is
     *     appended with qty defaulting to the full remaining position qty minus
     *     the qty already committed to other levels of the same kind.
     *   - onAmendBracket is called with the full BracketAmendment.
     *
     * lineId format expected: "position:<positionId>"
     */
    handleGhostMove: (lineId: string, kind: 'tp' | 'sl', index: number, price: number) => void;
}

// Line ID conventions
// Deterministic IDs so we can update lines in-place without scanning.

const lineId = {
    order: (id: string) => `order:${id}`,
    position: (id: string) => `position:${id}`,
    /** TP level at array index i */
    tp: (posId: string, i: number) => `tp:${posId}:${i}`,
    /** SL level at array index i */
    sl: (posId: string, i: number) => `sl:${posId}:${i}`,
    be: (posId: string) => `be:${posId}`,
    /** Pending bracket TP on a working order (not yet a position) */
    orderTp: (orderId: string, i: number) => `order-tp:${orderId}:${i}`,
    /** Pending bracket SL on a working order (not yet a position) */
    orderSl: (orderId: string, i: number) => `order-sl:${orderId}:${i}`,
};

// Helpers
/**
 * Sum the qty of all bracket levels of one kind.
 */
function totalBracketQty(levels: BracketLevel[]): number {
    return levels.reduce((acc, l) => acc + l.qty, 0);
}

/**
 * Given a position and a bracket kind, return the "remaining" qty that a new
 * level can safely target (position.remainingQuantity minus qty already committed).
 * Always at least 1 so the user can always add another level.
 */
function remainingQty(position: Position, kind: 'tp' | 'sl'): number {
    const levels = kind === 'tp' ? position.takeProfits : position.stopLosses;
    const committed = totalBracketQty(levels ?? []);
    return Math.max(1, position.remainingQuantity - committed);
}

/** The same, for the pending brackets riding on a working order. */
function remainingOrderQty(order: Order, kind: 'tp' | 'sl'): number {
    const levels = kind === 'tp' ? order.bracket?.takeProfits : order.bracket?.stopLosses;
    const committed = totalBracketQty(levels ?? []);
    return Math.max(1, order.quantity - committed);
}

/**
 * The price a working order would fill at - the reference an unfilled order's
 * brackets measure their PnL against, the way a position's brackets measure
 * against entryPrice. Mirrors buildOrderLine's side selection: a stop-limit
 * that has triggered rests as a limit, so it prices off `price`, not `stopPrice`.
 */
function orderRefPrice(order: Order): number {
    const isLimitSide =
        order.type === 'limit' || (order.type === 'stop_limit' && order.triggered);
    return (isLimitSide ? order.price : order.stopPrice) || order.price || order.stopPrice || 0;
}

/**
 * Account currency per 1.0 of price move. The host normally supplies this from
 * the contract multiplier; fall back to the symbol's known value rather than 0,
 * so a missing option shows a wrong-ish number instead of a confident "$0.00".
 */
function tickValueFor(option: number | undefined, symbol: string): number {
    return option ?? getTickValue(symbol);
}

/** Signed PnL of closing `qty` at `exit` against `entry`, in account currency. */
function bracketPnl(
    side: OrderSide | PositionSide,
    entry: number,
    exit: number,
    qty: number,
    tickValue: number,
): number {
    return tickValue * qty * (side === 'short' ? entry - exit : exit - entry);
}

/** "+$420.00" / "-$120.50" - the money figure shown on a bracket line's pill. */
function formatBracketPnl(pnl: number): string {
    return (pnl >= 0 ? '+$' : '-$') + Math.abs(pnl).toFixed(2);
}

// Hook
export function useTradingState(options: UseTradingStateOptions = {}): UseTradingStateReturn {
    const {
        onEvent,
        formatPnlLabel,
        tickSize,
        tickValue: tickValueOption,
        markMode = 'conservative',
        onUpdatePosition,
        onUpdateOrder,
        onAmendOrder,
        onAmendBracket,
        onCancelOrder,
        onClosePosition,
        onReversePosition,
        onContextMenu,
    } = options;

    // Mutable refs (avoid stale closures in callbacks)
    const ordersRef = useRef<Map<string, Order>>(new Map());
    const positionsRef = useRef<Map<string, Position>>(new Map());
    const fillsRef = useRef<Fill[]>([]);
    const linesRef = useRef<Map<string, TradeLine>>(new Map());
    const lastTickRef = useRef<Map<string, PriceTick>>(new Map());
    const flushTickRafRef = useRef<number>(0);

    // Id of the bracket line currently being dragged (set by useTradeLines).
    // While set, rebuildPositionLines preserves that line's live price/label so
    // a playback tick can't yank it back to its un-amended position mid-drag.
    const draggingLineIdRef = useRef<string | null>(null);

    // Imperative redraw
    //
    // Chart registers its redraw callback here so lines can trigger a canvas
    // repaint without touching React state (zero re-renders during drag).
    const redrawRef = useRef<(() => void) | null>(null);
    const registerRedraw = useCallback((fn: () => void) => {
        redrawRef.current = fn;
    }, []);

    // Line handle factory
    //
    // Returns a small imperative handle for a line. Callbacks built with
    // makeHandle mutate linesRef directly and call redraw() - no setTradeLines,
    // no re-render. React state is only updated at drag-end via flushLines().
    const makeHandle = useCallback(
        (id: string) => ({
            setLabel(label: string) {
                const line = linesRef.current.get(id);
                if (line) linesRef.current.set(id, { ...line, label });
                redrawRef.current?.();
            },
            setPrice(price: number) {
                const line = linesRef.current.get(id);
                if (line) linesRef.current.set(id, { ...line, price });
                redrawRef.current?.();
            },
            patch(partial: Partial<TradeLine>) {
                const line = linesRef.current.get(id);
                if (line) linesRef.current.set(id, { ...line, ...partial });
                redrawRef.current?.();
            },
        }),
        [],
    );

    // React state (only what the chart needs to see)
    const [tradeLines, setTradeLines] = useState<TradeLine[]>([]);

    // Internal helpers
    const emit = useCallback(
        (event: TradingEvent) => {
            onEvent?.(event);
        },
        [onEvent],
    );

    /**
     * Mirror the line map into React state, at most once per task.
     *
     * `linesRef` is the source of truth; this only publishes it for rendering.
     * Mark-to-market calls it once per open position per replayed tick, and one
     * playback frame can replay thousands of ticks - each one copying the whole
     * map and scheduling a render that the next tick immediately supersedes.
     *
     * A microtask rather than a frame on purpose: a replay burst runs inside a
     * single task and collapses to one flush, while a drag still publishes
     * before the next paint, so dragging a bracket line stays frame-tight.
     */
    const flushScheduled = useRef(false);
    const flushLines = useCallback(() => {
        if (flushScheduled.current) return;
        flushScheduled.current = true;
        queueMicrotask(() => {
            flushScheduled.current = false;
            setTradeLines([...linesRef.current.values()]);
        });
    }, []);

    const getMark = useCallback(
        (position: Position): number | undefined => {
            const tick = lastTickRef.current.get(position.symbol);
            if (!tick) return position.currentPrice;
            if (markMode === 'bid') return tick.bid;
            if (markMode === 'ask') return tick.ask;
            if (markMode === 'last') return tick.last ?? (tick.bid + tick.ask) / 2;
            if (markMode === 'mid') return (tick.bid + tick.ask) / 2;
            return position.side === 'long' ? tick.bid : tick.ask;
        },
        [markMode],
    );

    // Pending bracket line builders
    //
    // These produce faded, draggable lines that preview the TP/SL levels
    // attached to a working order's bracket - before the order fills and
    // the real position bracket lines take over.  Prices are editable locally;
    // there is nothing to amend on the exchange until the order fills.

    /**
     * Patch the bracket price for a working order in local state and redraw.
     * This is purely local - the bracket doesn't exist on the exchange yet,
     * so there's nothing to amend. The updated price will be picked up when
     * the order eventually fills and the position is opened.
     */
    const patchOrderBracketPrice = useCallback(
        (orderId: string, which: 'tp' | 'sl', index: number, newPrice: number) => {
            const order = ordersRef.current.get(orderId);
            if (!order) return;

            const tps = order.bracket?.takeProfits ?? [];
            const sls = order.bracket?.stopLosses ?? [];

            const updatedOrder: Order = {
                ...order,
                bracket: {
                    ...order.bracket,
                    takeProfits:
                        which === 'tp'
                            ? tps.map((lvl, i) => (i === index ? { ...lvl, price: newPrice } : lvl))
                            : tps,
                    stopLosses:
                        which === 'sl'
                            ? sls.map((lvl, i) => (i === index ? { ...lvl, price: newPrice } : lvl))
                            : sls,
                },
                updatedAt: lastTickRef.current.get(order.symbol).ts,
            };

            ordersRef.current.set(orderId, updatedOrder);

            // Update just the one line in place - avoids a full rebuild and
            // breaks the circular dep with rebuildOrderBracketLines.
            const lineKey =
                which === 'tp' ? lineId.orderTp(orderId, index) : lineId.orderSl(orderId, index);
            const existing = linesRef.current.get(lineKey);
            if (existing) {
                linesRef.current.set(lineKey, { ...existing, price: newPrice });
            }

            onUpdateOrder(updatedOrder);

            flushLines();
        },
        [flushLines],
    );

    // A working order has no entryPrice yet, so its pending brackets measure PnL
    // against the price the order would fill at. Without this they render as a
    // bare "TP"/"SL" while a filled position's brackets show the money - the
    // same level looking like two different things either side of the fill.
    const buildOrderBracketLine = useCallback(
        (
            which: 'tp' | 'sl',
            order: Order,
            price: number,
            qty: number,
            index: number,
        ): TradeLine => {
            const id =
                which === 'tp' ? lineId.orderTp(order.id, index) : lineId.orderSl(order.id, index);
            const handle = makeHandle(id);
            const levels =
                which === 'tp' ? order.bracket?.takeProfits : order.bracket?.stopLosses;
            const tag = `${which.toUpperCase()}${(levels?.length ?? 0) > 1 ? index + 1 : ''}`;
            const entry = orderRefPrice(order);
            const label = (at: number) =>
                `${tag} ${formatBracketPnl(bracketPnl(order.side, entry, at, qty, tickValueFor(tickValueOption, order.symbol)))}`;

            return {
                id,
                kind: which,
                side: order.side as TradeLineSide,
                price,
                label: label(price),
                qty,
                // Visual cues: dimmed + tighter dots to look "not active"
                opacity: 0.38,
                lineDash: [1.5,3],
                badges: ['PENDING'],
                tickSize,
                movable: true,
                locked: false,
                showPricePill: true,
                showLinePill: true,
                // Runs on every mouse-move pixel - mutates linesRef, no React state.
                onMove: (newPrice) => handle.setLabel(label(newPrice)),
                afterMove: (newPrice) => patchOrderBracketPrice(order.id, which, index, newPrice),
            };
        },
        [tickSize, tickValueOption, patchOrderBracketPrice, makeHandle],
    );

    const buildOrderBracketTpLine = useCallback(
        (order: Order, price: number, qty: number, index: number): TradeLine =>
            buildOrderBracketLine('tp', order, price, qty, index),
        [buildOrderBracketLine],
    );

    /** Build one pending-bracket SL line for a working order. */
    const buildOrderBracketSlLine = useCallback(
        (order: Order, price: number, qty: number, index: number): TradeLine =>
            buildOrderBracketLine('sl', order, price, qty, index),
        [buildOrderBracketLine],
    );

    /**
     * Upsert or prune the pending bracket TP/SL lines for an order.
     * Call whenever an order is inserted/updated/removed.
     * Pass `remove=true` to wipe all bracket lines for that order.
     */
    const rebuildOrderBracketLines = useCallback(
        (order: Order, remove: boolean = false) => {
            const prefix_tp = `order-tp:${order.id}:`;
            const prefix_sl = `order-sl:${order.id}:`;

            // Always prune stale lines first
            for (const key of linesRef.current.keys()) {
                if (key.startsWith(prefix_tp) || key.startsWith(prefix_sl)) {
                    linesRef.current.delete(key);
                }
            }

            if (remove) return;

            const tps = order.bracket?.takeProfits ?? [];
            const sls = order.bracket?.stopLosses ?? [];

            tps.forEach(({ price, qty }, i) => {
                linesRef.current.set(
                    lineId.orderTp(order.id, i),
                    buildOrderBracketTpLine(order, price, qty, i),
                );
            });

            sls.forEach(({ price, qty }, i) => {
                linesRef.current.set(
                    lineId.orderSl(order.id, i),
                    buildOrderBracketSlLine(order, price, qty, i),
                );
            });
        },
        [buildOrderBracketTpLine, buildOrderBracketSlLine],
    );

    /** Build or rebuild the TradeLine for a working order. */
    const buildOrderLine = useCallback(
        (order: Order): TradeLine => {
            // The line must sit on the SAME price field that amendOrder() writes
            // to, otherwise dragging a stop-limit amends stopPrice while the line
            // keeps rendering at the (unchanged) limit price - so it snaps back and
            // appears unmovable. orderRefPrice mirrors amendOrder's side selection;
            // the order's pending bracket lines price off the same value.
            const price = orderRefPrice(order);
            const isWorking =
                order.status === 'working' ||
                order.status === 'partial' ||
                order.status === 'pending';

            const kind: TradeLineKind =
                order.type === 'limit'
                    ? 'limit'
                    : order.type === 'stop'
                      ? 'stop'
                      : order.type === 'stop_limit'
                        ? 'stop_limit'
                        : 'alert';

            const sideLabel = order.side === 'short' ? 'Sell' : 'Buy';
            const typeLabel =
                order.type === 'limit'
                    ? 'Limit'
                    : order.type === 'stop'
                      ? 'Stop'
                      : order.type === 'stop_limit'
                        ? 'Stop Limit'
                        : 'Market';

            const badges: string[] = [`${order.filledQuantity}/${order.quantity}`];
            if (order.tif) badges.push(order.tif.toUpperCase());

            // A resting order gets the same drag-out TP/SL handles a position
            // does. The levels it collects are pending rather than live - the
            // engine turns them into real brackets when the order fills - but
            // there is no reason to make someone wait for the fill to set them.
            const pendingTp = order.bracket?.takeProfits?.length ?? 0;
            const pendingSl = order.bracket?.stopLosses?.length ?? 0;

            return {
                id: lineId.order(order.id),
                kind,
                side: order.side as TradeLineSide,
                price,
                label: `${sideLabel} ${typeLabel}`,
                qty: order.quantity,
                badges,
                ghosts: isWorking,
                numGhosts: Math.max(pendingTp, pendingSl) + 1,
                tickSize,
                movable: isWorking && !!onAmendOrder,
                locked: !isWorking,
                visible: isWorking,
                showPricePill: true,
                showLinePill: true,
                afterMove: onAmendOrder
                    ? (newPrice) => onAmendOrder(order.id, newPrice)
                    : undefined,
                onClose: onCancelOrder ? () => onCancelOrder(order.id) : undefined,
                onContextMenu: onContextMenu
                    ? (p, y) => onContextMenu('order', order.id, p, y)
                    : undefined,
            };
        },
        [tickSize, onAmendOrder, onCancelOrder, onContextMenu],
    );

    /** Build the entry TradeLine for a position. */
    const buildPositionLine = useCallback(
        (position: Position): TradeLine => {
            const mark = getMark(position);
            const tickValue = tickValueOption;
            const pnl =
                mark != null
                    ? calcUnrealizedPnl(position, mark, tickValue)
                    : position.unrealizedPnl;
            const pnlPct =
                mark != null
                    ? calcUnrealizedPnlPct(position, mark, tickValue)
                    : position.unrealizedPnlPct;

            const pnlLabel = pnl ? `${formatPnl(pnl)}` : '';

            const bandToPrice = mark;

            // How many ghost pairs to show on the entry line:
            // At least one pair (the first unset TP/SL slot), plus however many
            // levels already exist. This lets the user always drag one more.
            const existingTp = position.takeProfits?.length ?? 0;
            const existingSl = position.stopLosses?.length ?? 0;
            const numGhosts = Math.max(existingTp, existingSl) + 1;

            const sideLabel = position.side === 'long' ? 'Buy' : 'Sell';
            const typeLabel =
                position.type === 'limit'
                    ? 'Limit'
                    : position.type === 'stop'
                      ? 'Stop'
                      : position.type === 'stop_limit'
                        ? 'Stop Limit'
                        : 'Market';

            return {
                id: lineId.position(position.id),
                kind: 'entry',
                side: position.side as TradeLineSide,
                price: position.entryPrice,
                label: `${sideLabel} ${typeLabel}`,
                qty: position.remainingQuantity,
                pnl,
                pnlPct,
                pnlLabel,
                entryPrice: position.entryPrice,
                bandToPrice,
                bandOpacity: 0.06,
                ghosts: true,
                numGhosts,
                tickSize,
                movable: false,
                locked: false,
                showPricePill: true,
                showLinePill: true,
                showPnlPill: pnl != null,
                onClose: onClosePosition ? () => onClosePosition(position.id) : undefined,
                onReverse: onReversePosition ? () => onReversePosition(position.id) : undefined,
                onContextMenu: onContextMenu
                    ? (p, y) => onContextMenu('position', position.id, p, y)
                    : undefined,
            };
        },
        [
            getMark,
            formatPnlLabel,
            tickSize,
            tickValueOption,
            onClosePosition,
            onReversePosition,
            onContextMenu,
        ],
    );

    /** Build one TP TradeLine for a specific BracketLevel. */
    const buildTpLine = useCallback(
        (position: Position, level: BracketLevel, index: number): TradeLine => {
            const id = lineId.tp(position.id, index);
            const handle = makeHandle(id);
            const tick = tickValueFor(tickValueOption, position.symbol);
            const qty = Math.min(position.remainingQuantity, level.qty);
            const pnlStr = formatBracketPnl(
                bracketPnl(position.side, position.entryPrice, level.price, qty, tick),
            );
            return {
                id,
                kind: 'tp',
                side: position.side as TradeLineSide,
                price: level.price,
                label: `TP ${pnlStr}`,
                qty: level.qty,
                tickSize,
                movable: !!onAmendBracket,
                showPricePill: true,
                showLinePill: true,
                onMove: (price) => {
                    // Runs on every mouse-move pixel - must NOT touch React state.
                    // handle.setLabel mutates linesRef directly and calls redraw().
                    const dragQty = Math.min(position.remainingQuantity, level.qty);
                    handle.setLabel(
                        `TP ${formatBracketPnl(
                            bracketPnl(
                                position.side,
                                position.entryPrice,
                                price,
                                dragQty,
                                tick,
                            ),
                        )}`,
                    );
                },
                afterMove: onAmendBracket
                    ? (newPrice) => {
                          onAmendBracket({
                              positionId: position.id,
                              which: 'tp',
                              index,
                              levelId: level.id ?? String(index),
                              price: newPrice,
                              qty: level.qty,
                          });
                          notifyBracketMoved({
                              kind: 'tp',
                              symbol: position.symbol,
                              price: newPrice,
                              tickSize,
                          });
                      }
                    : undefined,
                onClose: () => removeBracketLevel(position, 'tp', index, level),
                onContextMenu: onContextMenu
                    ? (p, y) => onContextMenu('position', position.id, p, y)
                    : undefined,
            };
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [tickSize, onAmendBracket, onContextMenu, makeHandle],
    );

    /** Build one SL TradeLine for a specific BracketLevel. */
    const buildSlLine = useCallback(
        (position: Position, level: BracketLevel, index: number): TradeLine => {
            const id = lineId.sl(position.id, index);
            const handle = makeHandle(id);
            const tick = tickValueFor(tickValueOption, position.symbol);
            const qty = Math.min(position.remainingQuantity, level.qty);
            const pnlStr = formatBracketPnl(
                bracketPnl(position.side, position.entryPrice, level.price, qty, tick),
            );

            return {
                id,
                kind: 'sl',
                side: position.side as TradeLineSide,
                price: level.price,
                label: `SL ${pnlStr}`,
                qty: level.qty,
                tickSize,
                movable: !!onAmendBracket,
                showPricePill: true,
                showLinePill: true,
                onMove: (price) => {
                    // Same pattern as buildTpLine - no React state, just linesRef + redraw.
                    const dragQty = Math.min(position.remainingQuantity, level.qty);
                    handle.setLabel(
                        `SL ${formatBracketPnl(
                            bracketPnl(
                                position.side,
                                position.entryPrice,
                                price,
                                dragQty,
                                tick,
                            ),
                        )}`,
                    );
                },
                afterMove: onAmendBracket
                    ? (newPrice) => {
                          onAmendBracket({
                              positionId: position.id,
                              which: 'sl',
                              index,
                              levelId: level.id ?? String(index),
                              price: newPrice,
                              qty: level.qty,
                          });
                          notifyBracketMoved({
                              kind: 'sl',
                              symbol: position.symbol,
                              price: newPrice,
                              tickSize,
                          });
                      }
                    : undefined,
                onClose: () => removeBracketLevel(position, 'sl', index, level),
                onContextMenu: onContextMenu
                    ? (p, y) => onContextMenu('position', position.id, p, y)
                    : undefined,
            };
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [tickSize, onAmendBracket, onContextMenu, makeHandle],
    );

    /** Build BE (break-even) line for a position. */
    const buildBeLine = useCallback(
        (position: Position): TradeLine | null => {
            if (position.bePrice == null) return null;
            return {
                id: lineId.be(position.id),
                kind: 'be',
                side: position.side as TradeLineSide,
                price: position.bePrice,
                label: 'BE',
                qty: position.remainingQuantity,
                tickSize,
                movable: !!onAmendBracket,
                showPricePill: true,
                showLinePill: true,
                afterMove: onAmendBracket
                    ? (newPrice) => {
                          onAmendBracket({
                              positionId: position.id,
                              which: 'be',
                              index: 0,
                              levelId: 'be',
                              price: newPrice,
                              qty: position.remainingQuantity,
                          });
                          notifyBracketMoved({
                              kind: 'be',
                              symbol: position.symbol,
                              price: newPrice,
                              tickSize,
                          });
                      }
                    : undefined,
            };
        },
        [tickSize, onAmendBracket],
    );

    /**
     * Rebuild all lines for a position (entry + all bracket levels + be).
     *
     * Stale lines (e.g. from removed levels) are pruned by scanning for any
     * tp/sl lines for this position and removing ones whose index is now out
     * of range.
     */
    const rebuildPositionLines = useCallback(
        (position: Position) => {
            if (position.side === 'flat' || position.remainingQuantity <= 0) {
                // Remove all lines for this position
                linesRef.current.delete(lineId.position(position.id));
                linesRef.current.delete(lineId.be(position.id));
                // Remove all tp/sl levels (scan prefix)
                const prefix_tp = `tp:${position.id}:`;
                const prefix_sl = `sl:${position.id}:`;
                for (const key of linesRef.current.keys()) {
                    if (key.startsWith(prefix_tp) || key.startsWith(prefix_sl)) {
                        linesRef.current.delete(key);
                    }
                }
                return;
            }

            // Set a line, but if it's the one being dragged right now, keep its
            // live price/label rather than the freshly-built (un-amended) values -
            // otherwise a playback tick rebuild fights the drag.
            const setLine = (id: string, built: TradeLine) => {
                if (id === draggingLineIdRef.current) {
                    const cur = linesRef.current.get(id);
                    if (cur) {
                        linesRef.current.set(id, { ...built, price: cur.price, label: cur.label });
                        return;
                    }
                }
                linesRef.current.set(id, built);
            };

            // Entry line
            linesRef.current.set(lineId.position(position.id), buildPositionLine(position));

            // TP levels
            const tpLevels = position.takeProfits ?? [];
            tpLevels.forEach((level, i) => {
                setLine(lineId.tp(position.id, i), buildTpLine(position, level, i));
            });
            // Prune stale TP lines beyond current array length
            for (let i = tpLevels.length; ; i++) {
                const key = lineId.tp(position.id, i);
                if (!linesRef.current.has(key)) break;
                linesRef.current.delete(key);
            }

            // SL levels
            const slLevels = position.stopLosses ?? [];
            slLevels.forEach((level, i) => {
                setLine(lineId.sl(position.id, i), buildSlLine(position, level, i));
            });
            // Prune stale SL lines beyond current array length
            for (let i = slLevels.length; ; i++) {
                const key = lineId.sl(position.id, i);
                if (!linesRef.current.has(key)) break;
                linesRef.current.delete(key);
            }

            // BE line (single)
            if (position.bePrice == null) {
                linesRef.current.delete(lineId.be(position.id));
            } else {
                const be = buildBeLine(position);
                if (be) setLine(lineId.be(position.id), be);
            }
        },
        [buildPositionLine, buildTpLine, buildSlLine, buildBeLine],
    );

    /**
     * The x on a TP or SL line.
     *
     * Routed through onAmendBracket so whoever actually owns the position - the
     * built-in engine, or a broker adapter - drops the level and stops arming
     * it. The lines then rebuild from the authoritative position that comes
     * back, which is the whole point.
     *
     * This used to edit the local copy of the position and rebuild the lines
     * from it. Two things went wrong with that. The level stayed live in the
     * engine after vanishing from the chart; and rebuilding from a local
     * position the engine had already closed re-created the ENTRY line the user
     * had just dismissed - click x on a TP, watch the position line come back.
     *
     * Deliberately not in the builders' dependency arrays: it is declared after
     * rebuildPositionLines (which it needs) and is only ever called from a click
     * handler, long after every binding in this scope exists.
     */
    const removeBracketLevel = useCallback(
        (position: Position, which: 'tp' | 'sl', index: number, level: BracketLevel) => {
            if (onAmendBracket) {
                onAmendBracket({
                    positionId: position.id,
                    which,
                    index,
                    levelId: level.id ?? String(index),
                    price: level.price,
                    qty: level.qty,
                    remove: true,
                });
                return;
            }

            // Uncontrolled use (no execution engine wired): nothing else is
            // tracking this position, so the local copy IS the truth.
            const pos = positionsRef.current.get(position.id);
            if (!pos) return;
            const updated: Position = {
                ...pos,
                takeProfits:
                    which === 'tp'
                        ? (pos.takeProfits ?? []).filter((_, i) => i !== index)
                        : pos.takeProfits,
                stopLosses:
                    which === 'sl'
                        ? (pos.stopLosses ?? []).filter((_, i) => i !== index)
                        : pos.stopLosses,
                updatedAt: lastTickRef.current.get(pos.symbol).ts,
            };
            positionsRef.current.set(position.id, updated);
            rebuildPositionLines(updated);
            flushLines();
        },
        [onAmendBracket, rebuildPositionLines, flushLines],
    );

    // Public API
    const upsertOrder = useCallback(
        (order: Order) => {
            const prev = ordersRef.current.get(order.id);
            ordersRef.current.set(order.id, order);

            const terminal =
                order.status === 'filled' ||
                order.status === 'cancelled' ||
                order.status === 'rejected';

            if (terminal) {
                linesRef.current.delete(lineId.order(order.id));
                rebuildOrderBracketLines(order, true); // wipe pending bracket lines on fill/cancel
            } else {
                linesRef.current.set(lineId.order(order.id), buildOrderLine(order));
                rebuildOrderBracketLines(order); // show/refresh pending bracket preview
            }

            if (!prev) {
                emit({ kind: 'order:placed', order });
            } else if (terminal && order.status === 'filled') {
                // fill event comes separately via applyFill
            } else if (terminal && order.status === 'cancelled') {
                emit({ kind: 'order:cancelled', order });
            } else if (terminal && order.status === 'rejected') {
                emit({ kind: 'order:rejected', order });
            } else {
                emit({ kind: 'order:updated', order });
            }

            flushLines();
        },
        [buildOrderLine, rebuildOrderBracketLines, emit, flushLines],
    );

    const removeOrder = useCallback(
        (orderId: string) => {
            const order = ordersRef.current.get(orderId);
            ordersRef.current.delete(orderId);
            linesRef.current.delete(lineId.order(orderId));
            if (order) rebuildOrderBracketLines(order, true);
            flushLines();
        },
        [rebuildOrderBracketLines, flushLines],
    );

    const applyFill = useCallback(
        (fill: Fill) => {
            fillsRef.current.push(fill);
            const order = ordersRef.current.get(fill.orderId);
            if (order?.status === 'filled') {
                emit({ kind: 'order:filled', order, fill });
            }
            emit({ kind: 'fill:received', fill });
            flushLines();
        },
        [emit, flushLines],
    );

    const upsertPosition = useCallback(
        (position: Position) => {
            const prev = positionsRef.current.get(position.id);
            const isClosing = position.side === 'flat' || position.remainingQuantity <= 0;
            positionsRef.current.set(position.id, position);
            rebuildPositionLines(position);

            if (!prev) {
                emit({ kind: 'position:opened', position: position });
                // "First time we've seen this id" is not the same thing as "this
                // just opened". A position can reach an unseeded hook mid-life -
                // a restored session, a pane adopting a symbol another pane was
                // already trading - and announcing a trade that has been running
                // for an hour (or has already been scaled out of) as a fresh fill
                // is a lie the user has no way to check.
                const isFreshFill =
                    position.status === 'open' && (position.closes?.length ?? 0) === 0;
                if (!isClosing && isFreshFill) {
                    notifyPositionOpened({
                        side: position.side,
                        symbol: position.symbol,
                        qty: position.startingQuantity,
                        entryPrice: position.entryPrice,
                        tickSize,
                    });
                }
            } else if (isClosing) {
                emit({
                    kind: 'position:closed',
                    position: position,
                    realizedPnl: position.realizedPnl ?? 0,
                });
                positionsRef.current.delete(position.id);
            } else {
                emit({ kind: 'position:updated', position: position });
            }

            flushLines();
        },
        [rebuildPositionLines, emit, flushLines, tickSize],
    );

    const toast = useCallback(
        (
            title: string,
            options?: { description?: string; tone?: 'profit' | 'loss' | 'neutral' },
        ) => {
            const tone =
                options?.tone === 'profit'
                    ? 'success'
                    : options?.tone === 'loss'
                      ? 'loss'
                      : 'neutral';
            notifyMessage(title, { description: options?.description, tone });
        },
        [],
    );

    const removePosition = useCallback(
        (positionId: string) => {
            positionsRef.current.delete(positionId);
            linesRef.current.delete(lineId.position(positionId));
            linesRef.current.delete(lineId.be(positionId));
            const prefix_tp = `tp:${positionId}:`;
            const prefix_sl = `sl:${positionId}:`;
            for (const key of linesRef.current.keys()) {
                if (key.startsWith(prefix_tp) || key.startsWith(prefix_sl)) {
                    linesRef.current.delete(key);
                }
            }
            flushLines();
        },
        [flushLines],
    );

    const tick = useCallback(
        (priceTick: PriceTick) => {
            lastTickRef.current.set(priceTick.symbol, priceTick);

            let changed = false;
            for (const position of positionsRef.current.values()) {
                if (position.symbol !== priceTick.symbol) continue;
                if (position.side === 'flat' || position.remainingQuantity <= 0) continue;
                rebuildPositionLines(position);
                changed = true;
            }

            if (changed) {
                cancelAnimationFrame(flushTickRafRef.current);
                flushTickRafRef.current = requestAnimationFrame(() => flushLines());
            }
        },
        [rebuildPositionLines, flushLines],
    );

    const syncOrders = useCallback(
        (orders: Order[]) => {
            const newIds = new Set(orders.map((o) => o.id));
            for (const [id, order] of ordersRef.current.entries()) {
                if (!newIds.has(id)) {
                    linesRef.current.delete(lineId.order(id));
                    rebuildOrderBracketLines(order, true);
                }
            }
            ordersRef.current.clear();
            for (const order of orders) {
                ordersRef.current.set(order.id, order);
                const terminal =
                    order.status === 'filled' ||
                    order.status === 'cancelled' ||
                    order.status === 'rejected';
                if (!terminal) {
                    linesRef.current.set(lineId.order(order.id), buildOrderLine(order));
                    rebuildOrderBracketLines(order);
                }
            }
            flushLines();
        },
        [buildOrderLine, rebuildOrderBracketLines, flushLines],
    );

    const syncPositions = useCallback(
        (positions: Position[]) => {
            const newIds = new Set(positions.map((p) => p.id));
            for (const id of positionsRef.current.keys()) {
                if (!newIds.has(id)) {
                    linesRef.current.delete(lineId.position(id));
                    linesRef.current.delete(lineId.be(id));
                    const prefix_tp = `tp:${id}:`;
                    const prefix_sl = `sl:${id}:`;
                    for (const key of linesRef.current.keys()) {
                        if (key.startsWith(prefix_tp) || key.startsWith(prefix_sl)) {
                            linesRef.current.delete(key);
                        }
                    }
                }
            }
            positionsRef.current.clear();
            for (const position of positions) {
                positionsRef.current.set(position.id, position);
                rebuildPositionLines(position);
            }
            flushLines();
        },
        [rebuildPositionLines, flushLines],
    );

    const reset = useCallback(() => {
        ordersRef.current.clear();
        positionsRef.current.clear();
        fillsRef.current = [];
        linesRef.current.clear();
        lastTickRef.current.clear();
        flushLines();
    }, [flushLines]);

    /**
     * Called by useTradeLines when the user drops a ghost TP/SL pill.
     *
     * Logic:
     *   - `lineId` is "position:<positionId>"
     *   - `kind` is 'tp' or 'sl'
     *   - `index` is the 0-based slot in tpLevels / slLevels
     *   - If the level already exists at that index -> update its price.
     *   - If index === levels.length -> append a new level with qty = remaining.
     *   - Any other index is silently ignored (shouldn't happen in practice).
     */
    /**
     * Drag a TP or SL off a working order's own line.
     *
     * The level is pending, not live: there is no position to protect yet, so
     * it rides on the order and the engine turns it into a real bracket at the
     * fill. That is why this ends at the order sync rather than onAmendBracket,
     * which speaks about brackets the engine is already holding.
     */
    const appendOrderBracket = useCallback(
        (orderId: string, kind: 'tp' | 'sl', price: number) => {
            const order = ordersRef.current.get(orderId);
            if (!order) {
                console.warn('[useTradingState] handleGhostMove: order not found', orderId);
                return;
            }

            const tps = order.bracket?.takeProfits ?? [];
            const sls = order.bracket?.stopLosses ?? [];
            const level: BracketLevel = {
                id: nanoid(),
                price,
                qty: remainingOrderQty(order, kind),
                triggered: false,
                triggeredAt: 0,
            };

            const updated: Order = {
                ...order,
                bracket: {
                    ...order.bracket,
                    takeProfits: kind === 'tp' ? [...tps, level] : tps,
                    stopLosses: kind === 'sl' ? [...sls, level] : sls,
                },
                updatedAt: lastTickRef.current.get(order.symbol)?.ts ?? order.updatedAt,
            };

            ordersRef.current.set(orderId, updated);
            // The order's own line carries the ghost row, so it is rebuilt too -
            // the bracket lines alone would leave the row one slot short and the
            // next drag would land on a stale index.
            linesRef.current.set(lineId.order(orderId), buildOrderLine(updated));
            rebuildOrderBracketLines(updated);
            onUpdateOrder?.(updated);
            flushLines();

            notifyBracketMoved({ kind, symbol: order.symbol, price, tickSize, created: true });
        },
        [buildOrderLine, rebuildOrderBracketLines, flushLines, onUpdateOrder, tickSize],
    );

    const handleGhostMove = useCallback(
        (entryLineId: string, kind: 'tp' | 'sl', index: number, price: number) => {
            // A resting order is the other thing you can drag one of these off.
            // Its levels live on the order, not on a position that doesn't
            // exist yet, so they take a different route out of here.
            if (entryLineId.startsWith('order:')) {
                appendOrderBracket(entryLineId.slice('order:'.length), kind, price);
                return;
            }

            const positionId = entryLineId.replace(/^position:/, '');
            const position = positionsRef.current.get(positionId);
            if (!position) {
                console.warn('[useTradingState] handleGhostMove: position not found', positionId);
                return;
            }
            const existing =
                kind === 'tp' ? (position.takeProfits ?? []) : (position.stopLosses ?? []);
            let updatedLevels: BracketLevel[];

            // this used to reuse the level at `index` when there was one, but a
            // ghost should always become a new line, so it just appends now
            const qty = remainingQty(position, kind);
            const newId = nanoid();
            updatedLevels = [
                ...existing,
                { id: newId, price, qty, triggered: false, triggeredAt: 0 },
            ];
            const updated: Position = {
                ...position,
                takeProfits: kind === 'tp' ? updatedLevels : position.takeProfits,
                stopLosses: kind === 'sl' ? updatedLevels : position.stopLosses,
                updatedAt: lastTickRef.current.get(position.symbol).ts,
            };

            positionsRef.current.set(positionId, updated);
            rebuildPositionLines(updated);
            onUpdatePosition(updated);
            flushLines();

            // Notify broker adapter about the level we just appended. Not
            // `updatedLevels[index]`: ghost slots are numbered off whichever side
            // has more levels, so dragging the third SL ghost onto the TP side
            // hands us an index past the end of the TP array - reading qty off
            // that was a crash waiting for someone to set brackets in the wrong
            // order.
            const appendedIdx = updatedLevels.length - 1;
            onAmendBracket?.({
                positionId,
                which: kind,
                index: appendedIdx,
                levelId: newId,
                price,
                qty: updatedLevels[appendedIdx].qty,
            });

            notifyBracketMoved({ kind, symbol: position.symbol, price, tickSize, created: true });
        },
        [
            appendOrderBracket,
            rebuildPositionLines,
            flushLines,
            onAmendBracket,
            onUpdatePosition,
            tickSize,
        ],
    );

    return {
        orders: ordersRef.current,
        positions: positionsRef.current,
        fills: fillsRef.current,
        tradeLines,
        linesRef,
        registerRedraw,
        upsertOrder,
        removeOrder,
        applyFill,
        upsertPosition,
        toast,
        removePosition,
        tick,
        syncOrders,
        syncPositions,
        reset,
        handleGhostMove,
        draggingLineIdRef,
    };
}
