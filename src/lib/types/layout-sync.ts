// "Sync in layout" - the per-controller switches that tie the cells of a
// multi-chart layout together, plus the wire payloads they broadcast on the
// shared event bus.
//
// Each switch is independent and each has exactly one broadcaster: the cell the
// user is acting on. Receivers never echo a change back, so a layout can never
// get into a feedback loop.

/** Which properties are shared between the cells of a layout. */
export type SyncInLayout = {
    /** Changing a cell's symbol changes every cell's symbol. */
    symbol: boolean;
    /** Changing a cell's timeframe changes every cell's timeframe. */
    interval: boolean;
    /** The hovered cell's crosshair is mirrored (by time/price) onto the others. */
    crosshair: boolean;
    /** Scrolling a cell scrolls the others to the same right edge - each keeps its own zoom. */
    time: boolean;
    /** Panning/zooming a cell gives the others the exact same visible range. */
    dateRange: boolean;
};

export const DEFAULT_SYNC_IN_LAYOUT: SyncInLayout = {
    symbol: false,
    interval: false,
    crosshair: true,
    time: false,
    dateRange: false,
};

/**
 * A crosshair position expressed in *data* space so any other cell can place it
 * on its own axes, whatever it is showing or however it is zoomed.
 *
 * Sent once per pointer move by the hovered cell - never per frame. Receivers
 * keep the payload and re-project it every time they paint, so panning or
 * zooming a follower keeps the mirrored crosshair pinned to the same bar
 * without another message.
 */
export type CrosshairSync = {
    /** Cell that owns the pointer. Receivers ignore their own id. */
    id: number;
    /** Time under the cursor (ns). Drives the mirrored vertical line. */
    ts: bigint;
    /** Value under the cursor, in the source pane's own scale. */
    price: number;
    /** Pane the cursor is in ('main' or an indicator pane id). */
    paneId: string;
    /** Cursor position inside that pane, 0 (top) -> 1 (bottom). */
    yFrac: number;
    /** Source symbol - the price only carries over to cells showing the same one. */
    symbol: string | null;
};

/** The visible time range of the cell the user is scrolling/zooming. */
export type TimeRangeSync = {
    id: number;
    tMin: bigint;
    tMax: bigint;
};
