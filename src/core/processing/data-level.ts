// data level compatibility, richest first:
//   l3    satisfies l3, tick, ohlcv, l2
//   tick  satisfies tick, ohlcv
//   ohlcv satisfies ohlcv
//   l2    satisfies l2

import type { DataLevel } from '../../interfaces/IDataAdapter';

const COMPATIBILITY: Record<DataLevel, ReadonlySet<DataLevel>> = {
    l3: new Set(['l3', 'tick', 'ohlcv', 'l2']),
    tick: new Set(['tick', 'ohlcv']),
    ohlcv: new Set(['ohlcv']),
    l2: new Set(['l2']),
};

/**
 * Does `actual` satisfy the `required` minimum level?
 *
 * @example
 * isCompatible('ohlcv', 'l3')    // true, l3 can serve ohlcv plugins
 * isCompatible('l3', 'ohlcv')    // false, ohlcv cannot serve l3 plugins
 */
export function isCompatible(required: DataLevel, actual: DataLevel): boolean {
    return COMPATIBILITY[actual].has(required);
}

/** How a data level is written for the user. Nobody outside the code says "l3". */
export const DATA_LEVEL_LABELS: Record<DataLevel, string> = {
    l3: 'order flow',
    tick: 'tick',
    ohlcv: 'candle',
    l2: 'order book',
};

/** The one line shown when something is refused for want of richer data. */
export function incompatibleReason(required: DataLevel, actual: DataLevel): string {
    return `Needs ${DATA_LEVEL_LABELS[required]} data. This symbol serves ${DATA_LEVEL_LABELS[actual]} data.`;
}
