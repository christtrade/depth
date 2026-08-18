//  All shared data shapes for the L3 visualiser
// A raw event coming from the data feed (Market-By-Order)
export type MboEvent = {
    ts_event: string; // ISO timestamp string e.g. "2026-03-02T15:40:00.123Z"
    action:
        | 'A' // Add order
        | 'C' // Cancel order
        | 'M' // Modify order size
        | 'T' // Trade (aggressive fill)
        | 'F' // Fill (partial trade)
        | 'R'; // Reset (clear whole book)
    side: 'B' | 'A' | 'N'; // Bid, Ask, or Neutral
    price: number | null;
    size: number;
    order_id: string;
    sequence: number;
    flags: number;
};

// A single resting order in the book (used internally by book.ts)
export type Order = {
    price: number;
    size: number;
};

// The full order book at any moment in time (used internally by book.ts)
export type BookState = {
    bids: Map<string, Order>; // keyed by order_id
    asks: Map<string, Order>; // keyed by order_id
    /** Cached best bid price - maintained incrementally by applyEvent(). O(1) read. */
    bestBid: number | null;
    /** Cached best ask price - maintained incrementally by applyEvent(). O(1) read. */
    bestAsk: number | null;
};

// A single aggressive trade that took place
// This is what we plot on the price chart - not passive resting orders
export type TradePoint = {
    ts: bigint;
    price: number;
    size: number;
    side: 'B' | 'A'; // B = aggressive buy (lifted the ask), A = aggressive sell (hit the bid)
};

export type PriceHistory = {
    ts: bigint;
    bestAsk: number;
    bestBid: number;
};

// A snapshot of resting depth at a single point in time.
// price (rounded to tick) -> total resting size at that level.
export type BookSnapshot = {
    ts: bigint;
    bids: Map<number, number>; // price -> aggregated size
    asks: Map<number, number>; // price -> aggregated size
};

export type ChartType =
    | 'line'
    | 'area'
    | 'step'
    | 'candles'
    | 'hollow'
    | 'heikin-ashi'
    | 'bars'
    | 'baseline'
    | 'renko'
    | 'kagi'
    | 'line-break'
    | 'footprint'
    | (string & {});

export type DataResponse = {
    requestId: string;
    events: any;
};

export type DataRequest = {
    requestId: string;
    event: string;
};
export type TradeLineKind =
    | 'entry' // position entry - solid line, position colour
    | 'sl' // stop loss - dashed red
    | 'tp' // take profit - dashed green
    | 'be' // break-even - dashed mid colour
    | 'limit' // working limit order line
    | 'stop' // working stop (stop-market) order line
    | 'stop_limit' // working stop-limit order line
    | 'alert' // price alert - dotted neutral
    | 'custom'; // fully custom

export type TradeLineSide = 'long' | 'short' | 'neutral';

export type TradeLine = {
    // Identity
    id?: string; // unique id (nanoid / uuid)
    kind: TradeLineKind;
    side?: TradeLineSide; // drives default colour when kind='entry'

    // Price
    price: number;
    /** If set the line snaps to the nearest tick multiple on drag */
    tickSize?: number;

    // Display
    label?: string; // e.g. "LONG", "TP2", "Alert"
    qty?: number; // contracts / shares shown in pill
    pnl?: number; // live PnL shown in pill (positive = green)
    pnlPct?: number; // % PnL shown in pill
    pnlLabel?: string; // override text, e.g. "+$420" or "+2.1R"
    entryPrice?: number; // reference for PnL calculation

    // Styling
    color?: string; // line + pill accent colour
    lineWidth?: number; // default 1
    lineDash?: number[]; // e.g. [4,4] for dashes, [2,6] for dots
    opacity?: number; // 0-1, default 1
    /** Show a subtle filled band between this line and `bandToPrice` */
    bandToPrice?: number;
    bandOpacity?: number; // default 0.07
    /**
     * When true on an `entry` line: renders two small draggable mini-pills
     * (TP and SL) to the left of the main pill.
     * Drag them vertically to set a take-profit or stop-loss price.
     * The band from entry->TP/SL is drawn while dragging.
     * Multiple TP/SL pairs are supported - use `onGhostMove` in useTradeLines
     * to persist prices. Ghost state is managed by useTradeLines.
     * `numGhosts` controls how many TP/SL pairs to show (default 1).
     */
    ghosts?: boolean;
    /** Number of TP/SL ghost pill pairs to render (default 1). */
    numGhosts?: number;

    // Label pill
    align?: 'left' | 'right';
    /** Margin from the aligned edge in px or % */
    margin?: number;
    marginType?: 'px' | 'percent';
    showPricePill?: boolean; // right-side axis price pill, default true
    showLinePill?: boolean; // the inline pill on the line itself, default true
    showPnlPill?: boolean; // show PnL pill attached to line
    /** Extra badges shown in the inline pill, e.g. ["2 NQ", "+$420", "1.3R"] */
    badges?: string[];

    /**
     * An order that hasn't been placed - drawn where it would land.
     *
     * Styling only, and deliberately separate from `locked`: a proposal is
     * still something you grab and move. It draws dotted and darkened so it
     * reads as intent rather than as a position you actually hold.
     */
    preview?: boolean;

    // Interactions
    movable?: boolean; // can be dragged vertically
    locked?: boolean; // overrides movable - prevents all interaction
    /** Called when user finishes dragging (mouseup). New price passed in. */
    onMove?: (newPrice: number) => void;
    afterMove?: (newPrice: number) => void;
    /** Called when user clicks the x button */
    onClose?: () => void;
    /** Called when user clicks the reverse/flip button */
    onReverse?: () => void;
    /** Called when user right-clicks the line */
    onContextMenu?: (price: number, y: number) => void;
    /** Called when user double-clicks the line */
    onDoubleClick?: (price: number) => void;
    onClick?: (price: number) => void;

    // Visibility
    visible?: boolean; // default true
    /** Hide below this chart height in px */
    minChartHeightToShow?: number;
};

export type CreateOrderEvent = {
    side: TradeLineSide;
    price: number;
    type: 'market' | 'limit' | 'stop' | 'stop_limit';
    qty: number;
    stop?: number;
};

export type ViewBounds = {
    tMin: bigint;
    tMax: bigint;
    pMin: number;
    pMax: number;
    pRef?: number;
};
//  SerialTrade - compact wire format used by data processors, workers, and the
//  matching engine. Moved here from indicator-worker.ts as it is a core data
//  type with no indicator-specific semantics.
export type SerialTrade = {
    ts: bigint;
    price: number;
    size: number;
    side: 'B' | 'A';
};

export type OhlcvBarMs = {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
};

export interface DomPanelHandle {
    update(state: BookState): void;
}
