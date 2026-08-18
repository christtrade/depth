// an OhlcvDataChunk from adapter-supplied bars. no synthetic trades,
// priceHistory or footprint stubs - the bars go straight to the renderer rather
// than fabricating l3-shaped data that doesnt exist.

import type { OhlcvBar, SupplementalBarSet } from '../../interfaces/IDataAdapter';

export interface OhlcvDataChunk {
    kind: 'ohlcv';
    ohlcvBars: OhlcvBar[];
    /** Unix ms timestamps */
    dataStart: number;
    dataEnd: number;
    supplemental?: Array<{ resolution: bigint; bars: OhlcvBar[] }>;
}

export function processOhlcvChunk(bars: OhlcvBar[], _barNs: bigint): OhlcvDataChunk {
    if (bars.length === 0) {
        return { kind: 'ohlcv', ohlcvBars: [], dataStart: 0, dataEnd: 0 };
    }
    return {
        kind: 'ohlcv',
        ohlcvBars: bars,
        dataStart: bars[0].time,
        dataEnd: bars[bars.length - 1].time,
    };
}

export function processOhlcvWithSupplemental(
    primaryBars: OhlcvBar[],
    _supplemental: SupplementalBarSet[],
    barNs: bigint,
): OhlcvDataChunk {
    const chunk = processOhlcvChunk(primaryBars, barNs);
    const supplemental = _supplemental.map((sup) => ({
        resolution: sup.resolution,
        bars: sup.bars,
    }));
    return { ...chunk, supplemental };
}
