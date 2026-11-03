// a copy of the charts compact buffer. the worker decodes it itself
export type WorkerInitMessage = {
    type: 'init' | 'append';
    buf: ArrayBuffer;
    length: number;
};

export type TileConfig = {
    column: number;
    tickSize: number;
    ticks: number;
    contrast: number;
};

export type HeatmapRequest =
    | ({ type: 'tiles'; tiles: number[] } & TileConfig)
    // the book at the playhead, painted from there to the right edge
    | ({ type: 'fill'; ts: string } & TileConfig);

export type TileReply = {
    type: 'tile';
    key: string;
    k: number;
    rowLo: number;
    rows: number;
    bitmap: ImageBitmap | null;
};

export type HeatmapReply =
    | TileReply
    | { type: 'fill'; key: string; ts: string; rowLo: number; rows: number; bitmap: ImageBitmap | null }
    // tiles from this time on are stale, all of them when '0'
    | { type: 'data'; from: string };

export const configKey = (c: TileConfig) => `${c.column}:${c.tickSize}:${c.ticks}:${c.contrast}`;
