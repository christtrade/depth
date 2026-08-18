// the processed chunk each data-level processor produces. only l3 carries a
// compact binary buffer, tick and ohlcv stay in plain typed arrays.

import type { OhlcvBar } from '../../interfaces/IDataAdapter';
import type { SerialTrade } from '../../lib/types';
import type { PriceHistory } from '../../lib/types';
import type { FootprintBar } from '../../lib/types/footprint';

// Per-level chunk types
export interface L3DataChunk {
    kind: 'l3';
    /** 20-byte compact encoding of all MBO events. L3-only. */
    compactBuf: ArrayBuffer;
    trades: SerialTrade[];
    priceHistory: PriceHistory[];
    footprintBars: FootprintBar[];
    dataStart: number;
    dataEnd: number;
}

export interface TickDataChunk {
    kind: 'tick';
    trades: SerialTrade[];
    priceHistory: PriceHistory[];
    footprintBars: FootprintBar[];
    dataStart: number;
    dataEnd: number;
}

export interface OhlcvDataChunk {
    kind: 'ohlcv';
    ohlcvBars: OhlcvBar[];
    dataStart: number;
    dataEnd: number;
}

export interface L2DataChunk {
    kind: 'l2';
    priceHistory: PriceHistory[];
    dataStart: number;
    dataEnd: number;
}

export type DataChunk = L3DataChunk | TickDataChunk | OhlcvDataChunk | L2DataChunk;

// Helpers
export function isEmptyChunk(chunk: DataChunk): boolean {
    switch (chunk.kind) {
        case 'l3':   return chunk.compactBuf.byteLength === 0;
        case 'tick': return chunk.trades.length === 0;
        case 'ohlcv':return chunk.ohlcvBars.length === 0;
        case 'l2':   return chunk.priceHistory.length === 0;
    }
}

export function mergeChunks(a: DataChunk, b: DataChunk): DataChunk {
    if (a.kind !== b.kind) {
        throw new Error(`[DataChunk] Cannot merge ${a.kind} with ${b.kind}`);
    }
    switch (a.kind) {
        case 'l3': {
            const bL3 = b as L3DataChunk;
            const total = a.compactBuf.byteLength + bL3.compactBuf.byteLength;
            const merged = new Uint8Array(total);
            merged.set(new Uint8Array(a.compactBuf), 0);
            merged.set(new Uint8Array(bL3.compactBuf), a.compactBuf.byteLength);
            return {
                kind: 'l3',
                compactBuf: merged.buffer,
                trades: a.trades.concat(bL3.trades),
                priceHistory: a.priceHistory.concat(bL3.priceHistory),
                footprintBars: a.footprintBars.concat(bL3.footprintBars),
                dataStart: a.dataStart || bL3.dataStart,
                dataEnd: bL3.dataEnd || a.dataEnd,
            };
        }
        case 'tick': {
            const bTick = b as TickDataChunk;
            return {
                kind: 'tick',
                trades: a.trades.concat(bTick.trades),
                priceHistory: a.priceHistory.concat(bTick.priceHistory),
                footprintBars: a.footprintBars.concat(bTick.footprintBars),
                dataStart: a.dataStart || bTick.dataStart,
                dataEnd: bTick.dataEnd || a.dataEnd,
            };
        }
        case 'ohlcv': {
            const bOhlcv = b as OhlcvDataChunk;
            return {
                kind: 'ohlcv',
                ohlcvBars: a.ohlcvBars.concat(bOhlcv.ohlcvBars),
                dataStart: a.dataStart || bOhlcv.dataStart,
                dataEnd: bOhlcv.dataEnd || a.dataEnd,
            };
        }
        case 'l2': {
            const bL2 = b as L2DataChunk;
            return {
                kind: 'l2',
                priceHistory: a.priceHistory.concat(bL2.priceHistory),
                dataStart: a.dataStart || bL2.dataStart,
                dataEnd: bL2.dataEnd || a.dataEnd,
            };
        }
    }
}
