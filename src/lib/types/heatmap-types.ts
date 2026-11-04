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
    // 'heat', or the bid and ask colors as '#rrggbb,#rrggbb'
    palette: string;
};

export type HeatmapRequest =
    // the heatmap is off, let the data go
    | { type: 'drop' }
    | ({ type: 'tiles'; tiles: number[] } & TileConfig)
    // built when nothing else is wanted
    | ({ type: 'ahead'; tiles: number[] } & TileConfig)
    // the book at the playhead, painted from there to the right edge
    | ({ type: 'fill'; ts: string } & TileConfig)
    // the view stopped on [from, to), brightness follows it if it's far off
    | ({ type: 'settle'; from: string; to: string } & TileConfig)
    // every best bid and ask change in [from, to)
    | { type: 'bbo'; from: string; to: string };

export type TileReply = {
    type: 'tile';
    key: string;
    k: number;
    rowLo: number;
    rows: number;
    bitmap: ImageBitmap | null;
    // how far the data went when it was built
    until: string;
};

export type HeatmapReply =
    | TileReply
    | { type: 'fill'; key: string; ts: string; rowLo: number; rows: number; bitmap: ImageBitmap | null }
    // tiles from this time on are stale, all of them when '0'. start and end are what's loaded
    | { type: 'data'; from: string; start: string; end: string }
    // brightness changed for the configs starting with normKey
    | { type: 'norm'; normKey: string }
    | { type: 'held'; bytes: number }
    // `until` is as far as the data got
    | { type: 'bbo'; from: string; to: string; until: string; ts: BigInt64Array; bid: Float64Array; ask: Float64Array };

export const normKey = (c: TileConfig) => `${c.column}:${c.tickSize}:${c.ticks}`;

export const configKey = (c: TileConfig) => `${c.column}:${c.tickSize}:${c.ticks}:${c.contrast}:${c.palette}`;
