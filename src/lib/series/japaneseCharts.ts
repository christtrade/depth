//  Price-driven Japanese chart series: Renko, Kagi and Three Line Break.
//
//  Unlike candles these are NOT time-bucketed - a brick/line forms only when
//  price moves by a threshold, regardless of how long that takes. Each emitted
//  element carries the timestamp at which it formed so the renderer can anchor
//  it on the existing time axis (rapid moves stack at one x; quiet periods
//  spread out). Construction is path-dependent from the start of the series, so
//  always feed the FULL close series, not just the visible window.
export type PricePoint = { ts: bigint; price: number };

/** One Renko brick spanning [yLow, yHigh] (a single brick-size band). */
export type RenkoBrick = { ts: bigint; yLow: number; yHigh: number; dir: 1 | -1 };

/**
 * A Kagi line segment. Endpoints are given as Kagi *column indices* (`i1`/`i2`)
 * - one column per turning point - so duplicate turning-point timestamps never
 * collapse onto the same x. `yang` = thick bullish line.
 */
export type KagiSegment = { i1: number; y1: number; i2: number; y2: number; yang: boolean };

/** Turning points + index-referenced segments for a Kagi line. */
export type KagiResult = { columns: PricePoint[]; segments: KagiSegment[] };

/** One Three-Line-Break block from `open` to `close`. */
export type LineBreakBox = { ts: bigint; open: number; close: number; dir: 1 | -1 };

/** The three price-driven (ordinal-axis) chart kinds. */
export type OrdinalKind = 'renko' | 'kagi' | 'line-break';

/**
 * Shared model consumed by the transformer (column timestamps), the renderer
 * (draw by column index) and autoscale (price extent over an index range).
 * `columnTs` is non-decreasing with one entry per drawn column; `pLow`/`pHigh`
 * are the per-column price extents. The matching render data is carried too so
 * everything derives from one build.
 */
export type OrdinalModel = {
    kind: OrdinalKind;
    columnTs: BigInt64Array;
    pLow: Float64Array;
    pHigh: Float64Array;
    bricks?: RenkoBrick[];
    boxes?: LineBreakBox[];
    kagiSegments?: KagiSegment[];
};

/**
 * A "nice" rounded number near `x` (1/2/5 x 10ⁿ) - used to derive a readable
 * default brick size / reversal amount from the data when the user hasn't set
 * one explicitly.
 */
export function niceNumber(x: number): number {
    if (!(x > 0)) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(x)));
    const r = x / mag;
    if (r < 1.5) return mag;
    if (r < 3.5) return 2 * mag;
    if (r < 7.5) return 5 * mag;
    return 10 * mag;
}

/** Default brick / reversal magnitude: ~1/40 of the series' price range. */
export function autoThreshold(series: PricePoint[]): number {
    if (series.length === 0) return 1;
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of series) {
        if (p.price < lo) lo = p.price;
        if (p.price > hi) hi = p.price;
    }
    const range = hi - lo;
    return range > 0 ? niceNumber(range / 40) : niceNumber(Math.abs(hi) / 100 || 1);
}

/**
 * Build Renko bricks from a close series. A brick forms in the trend direction
 * once price advances a full `brick`; reversing direction requires two bricks
 * of movement (the canonical Renko reversal), so the bands always tile cleanly.
 */
export function buildRenko(series: PricePoint[], brick: number): RenkoBrick[] {
    const out: RenkoBrick[] = [];
    if (series.length === 0 || !(brick > 0)) return out;

    // `ref` is the leading edge of the latest brick (top in an uptrend, bottom
    // in a downtrend). Anchor it to the brick grid so levels are stable.
    let ref = Math.round(series[0].price / brick) * brick;
    let dir: 0 | 1 | -1 = 0;

    for (const { ts, price: p } of series) {
        if (dir === 0) {
            if (p >= ref + brick) dir = 1;
            else if (p <= ref - brick) dir = -1;
        }

        if (dir === 1) {
            while (p >= ref + brick) {
                out.push({ ts, yLow: ref, yHigh: ref + brick, dir: 1 });
                ref += brick;
            }
            if (p <= ref - 2 * brick) {
                dir = -1;
                ref -= brick; // skip the reversal gap brick
                while (p <= ref - brick) {
                    out.push({ ts, yLow: ref - brick, yHigh: ref, dir: -1 });
                    ref -= brick;
                }
            }
        } else if (dir === -1) {
            while (p <= ref - brick) {
                out.push({ ts, yLow: ref - brick, yHigh: ref, dir: -1 });
                ref -= brick;
            }
            if (p >= ref + 2 * brick) {
                dir = 1;
                ref += brick;
                while (p >= ref + brick) {
                    out.push({ ts, yLow: ref, yHigh: ref + brick, dir: 1 });
                    ref += brick;
                }
            }
        }
    }

    return out;
}

/**
 * Build a Kagi line from a close series. The line extends with the trend and
 * jogs to a new column only when price reverses by `reversal`. Each vertical
 * leg is split into a thin "yin" portion and a thick "yang" portion at the
 * previous shoulder (last peak) / waist (last trough) - Kagi's defining trait.
 */
export function buildKagi(series: PricePoint[], reversal: number): KagiResult {
    if (series.length < 2 || !(reversal > 0)) return { columns: [], segments: [] };

    // Pass 1: reduce to alternating turning points
    const tps: PricePoint[] = [{ ts: series[0].ts, price: series[0].price }];
    let dir: 0 | 1 | -1 = 0;
    let extPrice = series[0].price;
    let extTs = series[0].ts;
    const anchor = series[0].price;

    for (let i = 1; i < series.length; i++) {
        const { ts, price: p } = series[i];
        if (dir === 0) {
            if (p >= anchor + reversal) {
                dir = 1;
                extPrice = p;
                extTs = ts;
            } else if (p <= anchor - reversal) {
                dir = -1;
                extPrice = p;
                extTs = ts;
            }
        } else if (dir === 1) {
            if (p > extPrice) {
                extPrice = p;
                extTs = ts;
            } else if (p <= extPrice - reversal) {
                tps.push({ ts: extTs, price: extPrice });
                dir = -1;
                extPrice = p;
                extTs = ts;
            }
        } else {
            if (p < extPrice) {
                extPrice = p;
                extTs = ts;
            } else if (p >= extPrice + reversal) {
                tps.push({ ts: extTs, price: extPrice });
                dir = 1;
                extPrice = p;
                extTs = ts;
            }
        }
    }
    tps.push({ ts: extTs, price: extPrice });
    if (tps.length < 2) return { columns: [], segments: [] };

    // Pass 2: staircase segments with shoulder/waist thickness
    // Endpoints reference column indices (k-1 = a's column, k = b's column).
    const segs: KagiSegment[] = [];
    let shoulder = -Infinity; // last peak price
    let waist = Infinity; // last trough price

    for (let k = 1; k < tps.length; k++) {
        const a = tps[k - 1];
        const b = tps[k];
        const up = b.price > a.price;

        // Horizontal connector into the new column, styled by the level at `a`.
        const connYang = up ? a.price >= shoulder : a.price > waist;
        segs.push({ i1: k - 1, y1: a.price, i2: k, y2: a.price, yang: connYang });

        // Vertical leg at the new column, split at the shoulder (up) / waist (down).
        if (up) {
            const sp = Math.min(Math.max(shoulder, a.price), b.price);
            if (sp > a.price) segs.push({ i1: k, y1: a.price, i2: k, y2: sp, yang: false });
            segs.push({ i1: k, y1: sp, i2: k, y2: b.price, yang: true });
            shoulder = b.price;
        } else {
            const wp = Math.max(Math.min(waist, a.price), b.price);
            if (wp < a.price) segs.push({ i1: k, y1: a.price, i2: k, y2: wp, yang: true });
            segs.push({ i1: k, y1: wp, i2: k, y2: b.price, yang: false });
            waist = b.price;
        }
    }

    return { columns: tps, segments: segs };
}

/**
 * Build Three Line Break blocks from a close series. A new block forms when
 * price closes beyond the high/low of the last `lineCount` blocks (so a
 * reversal needs to break `lineCount` blocks, while continuation only needs to
 * exceed the last block).
 */
export function buildThreeLineBreak(series: PricePoint[], lineCount = 3): LineBreakBox[] {
    const out: LineBreakBox[] = [];
    if (series.length === 0) return out;

    let prevClose = series[0].price;

    for (let i = 1; i < series.length; i++) {
        const { ts, price: p } = series[i];

        if (out.length === 0) {
            if (p > prevClose) out.push({ ts, open: prevClose, close: p, dir: 1 });
            else if (p < prevClose) out.push({ ts, open: prevClose, close: p, dir: -1 });
            if (out.length) prevClose = p;
            continue;
        }

        const recent = out.slice(-lineCount);
        let hi = -Infinity;
        let lo = Infinity;
        for (const b of recent) {
            hi = Math.max(hi, b.open, b.close);
            lo = Math.min(lo, b.open, b.close);
        }

        if (p > hi) {
            out.push({ ts, open: prevClose, close: p, dir: 1 });
            prevClose = p;
        } else if (p < lo) {
            out.push({ ts, open: prevClose, close: p, dir: -1 });
            prevClose = p;
        }
    }

    return out;
}

/**
 * Build the shared ordinal model for one of the price-driven chart kinds.
 * Columns are emitted in render order; `columnTs` feeds the transformer and
 * `pLow`/`pHigh` feed autoscale. Render data (bricks / boxes / kagi segments)
 * is carried so the renderer reuses this single build.
 */
export function buildOrdinalModel(
    kind: OrdinalKind,
    series: PricePoint[],
    param: number,
): OrdinalModel {
    if (kind === 'renko') {
        const bricks = buildRenko(series, param);
        const n = bricks.length;
        const columnTs = new BigInt64Array(n);
        const pLow = new Float64Array(n);
        const pHigh = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            columnTs[i] = bricks[i].ts;
            pLow[i] = bricks[i].yLow;
            pHigh[i] = bricks[i].yHigh;
        }
        return { kind, columnTs, pLow, pHigh, bricks };
    }

    if (kind === 'line-break') {
        const boxes = buildThreeLineBreak(series, Math.max(1, param));
        const n = boxes.length;
        const columnTs = new BigInt64Array(n);
        const pLow = new Float64Array(n);
        const pHigh = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            columnTs[i] = boxes[i].ts;
            pLow[i] = Math.min(boxes[i].open, boxes[i].close);
            pHigh[i] = Math.max(boxes[i].open, boxes[i].close);
        }
        return { kind, columnTs, pLow, pHigh, boxes };
    }

    // kagi: one column per turning point
    const { columns, segments } = buildKagi(series, param);
    const n = columns.length;
    const columnTs = new BigInt64Array(n);
    const pLow = new Float64Array(n);
    const pHigh = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        columnTs[i] = columns[i].ts;
        pLow[i] = columns[i].price;
        pHigh[i] = columns[i].price;
    }
    return { kind, columnTs, pLow, pHigh, kagiSegments: segments };
}
