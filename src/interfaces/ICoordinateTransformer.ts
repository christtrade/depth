// a stateful, live coordinate transformer. the chart builds one, keeps it
// current as the view changes and hands it to the render engine. plugin draw
// hooks get the same instance, so their coordinate math is always in sync with
// whatever is on screen:
//
//   chart.renderEngine.addDrawHook('after-base', (ctx, transformer) => {
//       const x = transformer.tsToX(myTs, chartW);
//       const y = transformer.priceToY(myPrice, chartH);
//       ctx.fillRect(x - 2, y - 2, 4, 4);
//   });
//
// only 'linear' exists so far. adding log/percent is a setScaleMode call and
// every call site, internal and plugin, picks up the new math for free.

import { SessionMapper } from '../core/SessionMapper';
import { type SessionStatus, getSessionStatus } from '../core/SessionUtils';
import type { TradingSession } from './IDataAdapter';
import type { ViewBounds } from '../lib/types';

// Scale modes
export type PriceScaleMode =
    | 'linear' // default - straight proportional mapping
    | 'log' // logarithmic price axis (future)
    | 'percent'; // percent change from pRef (future)

// Stateless interface
// For consumers who want to implement their own transformer from scratch,
// or for secondary panes that need transforms against a different view.

export interface ICoordinateTransformer {
    tsToX(ts: bigint, view: ViewBounds, chartW: number): number;
    priceToY(price: number, view: ViewBounds, chartH: number): number;
    xToTs(x: number, view: ViewBounds, chartW: number): bigint;
    yToPrice(y: number, view: ViewBounds, chartH: number): number;
}

// Live transformer
// Holds the current ViewBounds and PriceScaleMode internally.
// ChartInner owns one instance and calls update() whenever the view changes.
// The same reference is handed to plugins via draw hooks.

export class LiveTransformer {
    private view: ViewBounds = { tMin: 0n, tMax: 1n, pMin: 0, pMax: 1, pRef: 0 };
    private mode: PriceScaleMode = 'linear';

    private _sessionMapper: SessionMapper | null = null;
    private _barNs: bigint = 0n;

    // Bar-aligned start offset for each session segment (in bar-aligned ns).
    // _barAlignedStarts[i] = sum of ceil(seg[j].duration / barNs) * barNs for j < i.
    // Each session occupies ceil(dur / barNs) * barNs of bar-aligned space, so
    // every adjacent bar pair - including the partial last bar of a session - is
    // exactly barNs apart in pixel space at any zoom level.
    // Cleared whenever sessionMapper or barNs changes.
    private _barAlignedStarts: bigint[] = [];
    private _sessionMapperVersion: number = -1;

    // Ordinal (equal-width column) axis
    // When set, x is driven by element *index* instead of timestamp: every
    // column is the same pixel width regardless of the wall-clock gap between
    // elements. Used by the price-driven chart types (renko/kagi/line-break)
    // whose elements are not time-bucketed. `_ordinal` holds the non-decreasing
    // timestamp of each column; null restores the normal time-based mapping.
    private _ordinal: BigInt64Array | null = null;

    setOrdinal(columnTs: BigInt64Array | null): void {
        this._ordinal = columnTs && columnTs.length > 1 ? columnTs : null;
    }

    getOrdinal(): BigInt64Array | null {
        return this._ordinal;
    }

    private _ordinalActive(): boolean {
        return this._ordinal !== null;
    }

    setSessionMapper(mapper: SessionMapper | null): void {
        // Bail on an unchanged mapper. The pan handler re-sets the same instance
        // every pointer move, and clearing unconditionally defeated the
        // `_sessionMapperVersion` check in _ensureBarAlignedStarts - the cache
        // could never survive a frame, so the offsets were rebuilt (a BigInt
        // divide per session segment) on every frame of every pan. A mutated
        // mapper still invalidates correctly: its `version` bump is what that
        // check exists for.
        if (this._sessionMapper === mapper) return;
        this._sessionMapper = mapper;
        this._barAlignedStarts = [];
    }

    getSessionMapper(): SessionMapper | null {
        return this._sessionMapper;
    }

    // Index helpers (ordinal mode)
    // All timestamp arithmetic uses bigint *differences* before converting to
    // Number - raw ns timestamps (~1.7e18) exceed Number.MAX_SAFE_INTEGER, but
    // local deltas are small and exact.

    /** Fractional column index for a timestamp (monotonic; extrapolates past the ends). */
    tsToFracIndex(ts: bigint): number {
        const cols = this._ordinal;
        if (!cols || cols.length < 2) return 0;
        const n = cols.length;
        // largest k with cols[k] <= ts
        let lo = 0,
            hi = n - 1,
            k = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            if (cols[mid] <= ts) {
                k = mid;
                lo = mid + 1;
            } else hi = mid - 1;
        }
        if (k < 0) {
            const span = Number(cols[1] - cols[0]) || 1;
            return -Number(cols[0] - ts) / span;
        }
        if (k >= n - 1) {
            const span = Number(cols[n - 1] - cols[n - 2]) || 1;
            return n - 1 + Number(ts - cols[n - 1]) / span;
        }
        const span = Number(cols[k + 1] - cols[k]);
        return span <= 0 ? k : k + Number(ts - cols[k]) / span;
    }

    /** Inverse of tsToFracIndex (lerps between columns; extrapolates past the ends). */
    indexToTs(idx: number): bigint {
        const cols = this._ordinal;
        if (!cols || cols.length === 0) return this.view.tMin;
        const n = cols.length;
        if (n === 1) return cols[0];
        if (idx <= 0) {
            const span = cols[1] - cols[0];
            return cols[0] + BigInt(Math.round(idx * Number(span)));
        }
        if (idx >= n - 1) {
            const span = cols[n - 1] - cols[n - 2];
            return cols[n - 1] + BigInt(Math.round((idx - (n - 1)) * Number(span)));
        }
        const k = Math.floor(idx);
        const f = idx - k;
        return cols[k] + BigInt(Math.round(f * Number(cols[k + 1] - cols[k])));
    }

    private _idxMin(): number {
        return this.tsToFracIndex(this.view.tMin);
    }
    private _idxMax(): number {
        return this.tsToFracIndex(this.view.tMax);
    }

    /** Pixel x for a (fractional) column index under the current view. */
    indexToX(i: number, chartW: number): number {
        const idxMin = this._idxMin();
        const span = this._idxMax() - idxMin;
        return span === 0 ? 0 : ((i - idxMin) / span) * chartW;
    }

    /** Fractional column index at a pixel x under the current view. */
    xToIndex(x: number, chartW: number): number {
        if (chartW === 0) return this._idxMin();
        const idxMin = this._idxMin();
        return idxMin + (x / chartW) * (this._idxMax() - idxMin);
    }

    /** Fast (index) => x closure for the current frame (renderer hot path). */
    makeIndexToXFn(chartW: number): (i: number) => number {
        const idxMin = this._idxMin();
        const span = this._idxMax() - idxMin;
        if (span === 0) return () => 0;
        const scale = chartW / span;
        return (i: number) => (i - idxMin) * scale;
    }

    private _session: TradingSession | null = null;

    setSession(session: TradingSession | null): void {
        this._session = session;
    }

    /** Returns the market status (open/closed/pre-post/always) for any UTC ns timestamp. */
    getSessionStatus(ts: bigint): SessionStatus {
        return getSessionStatus(this._session, ts);
    }

    /**
     * Must be called whenever the active timeframe changes. Triggers a recompute
     * of the per-session bar-alignment offsets on next access.
     */
    setBarNs(barNs: bigint): void {
        if (this._barNs !== barNs) {
            this._barNs = barNs;
            this._barAlignedStarts = [];
        }
    }

    // Bar-aligned coordinate system
    private _ensureBarAlignedStarts(): void {
        const v = this._sessionMapper?.version ?? -1;
        if (this._barAlignedStarts.length > 0 && this._sessionMapperVersion === v) return;
        this._barAlignedStarts = [];
        this._sessionMapperVersion = v;
        if (!this._sessionMapper || !this._sessionMapper.hasSession || this._barNs === 0n) return;
        let offset = 0n;
        for (const seg of this._sessionMapper.segments) {
            this._barAlignedStarts.push(offset);
            const bars = (seg.duration + this._barNs - 1n) / this._barNs; // ceil
            offset += bars * this._barNs;
        }
    }

    /**
     * Map a real UTC timestamp to bar-aligned market time.
     *
     * - Inside segment i: barAlignedStarts[i] + (ts - seg.realStart)
     * - In a gap between sessions: linearly interpolated into the padding zone
     *   of the previous segment (preserves continuity during pan/zoom)
     * - Before first segment / after last segment: linear extrapolation
     */
    private _tsToBarAligned(ts: bigint): bigint {
        this._ensureBarAlignedStarts();
        const segs = this._sessionMapper!.segments;
        let lo = 0,
            hi = segs.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            const seg = segs[mid];

            if (ts >= seg.realEnd) lo = mid + 1;
            else if (ts < seg.realStart) hi = mid - 1;
            else return this._barAlignedStarts[mid] + (ts - seg.realStart);
        }
        if (lo >= segs.length) {
            // After last segment - extrapolate forward from its real end
            const last = segs[segs.length - 1];
            return this._barAlignedStarts[segs.length - 1] + last.duration + (ts - last.realEnd);
        }
        if (lo === 0) {
            // Before first segment - extrapolate backward
            return this._barAlignedStarts[0] - (segs[0].realStart - ts);
        }
        // In gap between segs[lo-1] and segs[lo]:
        // linearly map the real gap onto the padding zone of segs[lo-1].
        const prevSeg = segs[lo - 1];
        const nextSeg = segs[lo];
        const paddingStart = this._barAlignedStarts[lo - 1] + prevSeg.duration;
        const paddingEnd = this._barAlignedStarts[lo];
        const paddingDuration = paddingEnd - paddingStart;
        if (paddingDuration === 0n) return paddingEnd;
        const gapDuration = nextSeg.realStart - prevSeg.realEnd;
        if (gapDuration === 0n) return paddingEnd;
        return paddingStart + ((ts - prevSeg.realEnd) * paddingDuration) / gapDuration;
    }

    /**
     * Inverse of _tsToBarAligned.
     * - In segment i's real zone: exact real timestamp
     * - In segment i's padding zone: linearly mapped back to real gap timestamp
     * - Before/after covered range: linear extrapolation
     */
    private _barAlignedToTs(m: bigint): bigint {
        this._ensureBarAlignedStarts();
        const segs = this._sessionMapper!.segments;
        const n = segs.length;
        let lo = 0,
            hi = n - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            const zoneStart = this._barAlignedStarts[mid];
            const zoneEnd =
                mid + 1 < n
                    ? this._barAlignedStarts[mid + 1]
                    : zoneStart +
                      ((segs[mid].duration + this._barNs - 1n) / this._barNs) * this._barNs;
            if (m >= zoneEnd) lo = mid + 1;
            else if (m < zoneStart) hi = mid - 1;
            else {
                const offset = m - zoneStart;
                const seg = segs[mid];
                if (offset < seg.duration) {
                    return seg.realStart + offset;
                }
                // In padding zone - map back to real gap timestamp
                const paddingOffset = offset - seg.duration;
                const paddingDuration = zoneEnd - zoneStart - seg.duration;
                if (paddingDuration === 0n || mid + 1 >= n) return seg.realEnd;
                const nextSeg = segs[mid + 1];
                const gapDuration = nextSeg.realStart - seg.realEnd;
                return seg.realEnd + (paddingOffset * gapDuration) / paddingDuration;
            }
        }
        if (lo >= n) {
            // After last zone - extrapolate forward
            const last = segs[n - 1];
            const lastZoneEnd =
                this._barAlignedStarts[n - 1] +
                ((last.duration + this._barNs - 1n) / this._barNs) * this._barNs;
            return last.realEnd + (m - lastZoneEnd);
        }
        // Before first zone - extrapolate backward
        return segs[0].realStart - (this._barAlignedStarts[0] - m);
    }

    // State
    /** Called by ChartInner on every view change (pan, zoom, data load). */
    update(view: ViewBounds): void {
        this.view = view;
    }

    /**
     * Called by ChartInner when ChartSettings.priceScaleMode changes.
     * All subsequent priceToY / yToPrice calls use the new math automatically.
     */
    setScaleMode(mode: PriceScaleMode): void {
        this.mode = mode;
    }

    getScaleMode(): PriceScaleMode {
        return this.mode;
    }
    getView(): ViewBounds {
        return this.view;
    }

    // Primary API - stateful (uses internal view)
    tsToX(ts: bigint, chartW: number): number {
        if (this._ordinalActive()) return this.indexToX(this.tsToFracIndex(ts), chartW);
        if (!this._sessionMapper || !this._sessionMapper.hasSession) {
            const total = Number(this.view.tMax - this.view.tMin);
            return total === 0 ? 0 : (Number(ts - this.view.tMin) / total) * chartW;
        }
        if (this._barNs === 0n) {
            return this._sessionMapper.tsToX(ts, this.view.tMin, this.view.tMax, chartW);
        }
        const mMin = this._tsToBarAligned(this.view.tMin);
        const mMax = this._tsToBarAligned(this.view.tMax);
        const span = Number(mMax - mMin);
        return span === 0 ? 0 : (Number(this._tsToBarAligned(ts) - mMin) / span) * chartW;
    }

    /**
     * Returns a fast (ts: bigint) => x closure for the current view + chartW.
     * Computes mMin and scale once at call time (2 binary searches total instead
     * of 2N), then uses a per-closure segment hint so sequential point access
     * (the common case for lines and fills) is O(1) per point.
     * Call once per draw command; pass the closure to each point in the series.
     */
    makeTsToXFn(chartW: number): (ts: bigint) => number {
        if (this._ordinalActive()) {
            const idxMin = this._idxMin();
            const span = this._idxMax() - idxMin;
            if (span === 0) return () => 0;
            const scale = chartW / span;
            return (ts: bigint) => (this.tsToFracIndex(ts) - idxMin) * scale;
        }
        if (!this._sessionMapper || !this._sessionMapper.hasSession) {
            const tMin = this.view.tMin;
            const total = Number(this.view.tMax - tMin);
            if (total === 0) return () => 0;
            const scale = chartW / total;
            return (ts: bigint) => Number(ts - tMin) * scale;
        }

        if (this._barNs === 0n) {
            const segs = this._sessionMapper.segments;
            const mMin = this._sessionMapper.tsToMarket(this.view.tMin);
            const span = Number(this._sessionMapper.tsToMarket(this.view.tMax) - mMin);
            if (span === 0) return () => 0;
            const scale = chartW / span;
            let hint = 0;
            return (ts: bigint) => {
                if (hint < segs.length) {
                    const seg = segs[hint];
                    if (ts >= seg.realStart && ts < seg.realEnd)
                        return Number(seg.marketStart + (ts - seg.realStart) - mMin) * scale;
                }
                let lo = 0,
                    hi = segs.length - 1;
                while (lo <= hi) {
                    const mid = (lo + hi) >>> 1;
                    const seg = segs[mid];
                    if (ts >= seg.realEnd) lo = mid + 1;
                    else if (ts < seg.realStart) hi = mid - 1;
                    else {
                        hint = mid;
                        return Number(seg.marketStart + (ts - seg.realStart) - mMin) * scale;
                    }
                }
                if (lo >= segs.length) {
                    const last = segs[segs.length - 1];
                    return Number(last.marketStart + last.duration - mMin) * scale;
                }
                if (lo === 0)
                    return Number(segs[0].marketStart - (segs[0].realStart - ts) - mMin) * scale;
                const prev = segs[lo - 1],
                    next = segs[lo];
                return ts - prev.realEnd <= next.realStart - ts
                    ? Number(prev.marketStart + prev.duration - mMin) * scale
                    : Number(next.marketStart - mMin) * scale;
            };
        }

        // Bar-aligned path
        this._ensureBarAlignedStarts();
        const segs = this._sessionMapper.segments;
        const starts = this._barAlignedStarts;
        const mMin = this._tsToBarAligned(this.view.tMin);
        const span = Number(this._tsToBarAligned(this.view.tMax) - mMin);
        if (span === 0) return () => 0;
        const scale = chartW / span;
        let hint = 0;
        return (ts: bigint) => {
            if (hint < segs.length) {
                const seg = segs[hint];
                if (ts >= seg.realStart && ts < seg.realEnd)
                    return Number(starts[hint] + (ts - seg.realStart) - mMin) * scale;
            }
            let lo = 0,
                hi = segs.length - 1;
            while (lo <= hi) {
                const mid = (lo + hi) >>> 1;
                const seg = segs[mid];
                if (ts >= seg.realEnd) lo = mid + 1;
                else if (ts < seg.realStart) hi = mid - 1;
                else {
                    hint = mid;
                    return Number(starts[mid] + (ts - seg.realStart) - mMin) * scale;
                }
            }
            if (lo >= segs.length) {
                const last = segs[segs.length - 1];
                return (
                    Number(starts[segs.length - 1] + last.duration + (ts - last.realEnd) - mMin) *
                    scale
                );
            }
            if (lo === 0) return Number(starts[0] - (segs[0].realStart - ts) - mMin) * scale;
            const prevSeg = segs[lo - 1],
                nextSeg = segs[lo];
            const paddingStart = starts[lo - 1] + prevSeg.duration;
            const paddingEnd = starts[lo];
            const paddingDur = paddingEnd - paddingStart;
            if (paddingDur === 0n) return Number(paddingEnd - mMin) * scale;
            const gapDur = nextSeg.realStart - prevSeg.realEnd;
            if (gapDur === 0n) return Number(paddingEnd - mMin) * scale;
            return (
                Number(paddingStart + ((ts - prevSeg.realEnd) * paddingDur) / gapDur - mMin) * scale
            );
        };
    }

    /**
     * Returns a fast (price: number) => y closure for the current frame.
     * Linear path is fully pre-baked; log/percent fall back to the method.
     */
    makePriceToYFn(chartH: number): (price: number) => number {
        if (this.mode === 'linear') {
            const pMax = this.view.pMax;
            const span = pMax - this.view.pMin;
            if (span === 0) return () => 0;
            const scale = chartH / span;
            return (price: number) => (pMax - price) * scale;
        }
        return (price: number) => this.priceToY(price, chartH);
    }

    priceToY(price: number, chartH: number): number {
        switch (this.mode) {
            case 'log':
                return this._logPriceToY(price, chartH);
            case 'percent':
                return this._pctPriceToY(price, chartH);
            default:
                return this._linearPriceToY(price, chartH);
        }
    }

    xToTs(x: number, chartW: number): bigint {
        if (this._ordinalActive()) return this.indexToTs(this.xToIndex(x, chartW));
        if (!this._sessionMapper || !this._sessionMapper.hasSession) {
            const total = Number(this.view.tMax - this.view.tMin);
            return this.view.tMin + BigInt(Math.round((x / chartW) * total));
        }
        if (this._barNs === 0n) {
            return this._sessionMapper.xToTs(x, this.view.tMin, this.view.tMax, chartW);
        }
        const mMin = this._tsToBarAligned(this.view.tMin);
        const mMax = this._tsToBarAligned(this.view.tMax);
        const span = Number(mMax - mMin);
        if (span === 0) return this.view.tMin;
        const mPos = mMin + BigInt(Math.round((x / chartW) * span));
        return this._barAlignedToTs(mPos);
    }

    yToPrice(y: number, chartH: number): number {
        switch (this.mode) {
            case 'log':
                return this._logYToPrice(y, chartH);
            case 'percent':
                return this._pctYToPrice(y, chartH);
            default:
                return this._linearYToPrice(y, chartH);
        }
    }

    /**
     * Pixel width of one bar at the current view and canvas size.
     * Use in renderer instead of computing barPx from tRange manually.
     */
    getBarPx(chartW: number): number {
        if (this._ordinalActive()) {
            const span = this._idxMax() - this._idxMin();
            return span <= 0 ? 0 : chartW / span;
        }
        if (this._barNs === 0n) return 0;
        if (!this._sessionMapper || !this._sessionMapper.hasSession) {
            const total = Number(this.view.tMax - this.view.tMin);
            return total === 0 ? 0 : (Number(this._barNs) / total) * chartW;
        }
        const span = Number(
            this._tsToBarAligned(this.view.tMax) - this._tsToBarAligned(this.view.tMin),
        );
        return span === 0 ? 0 : (Number(this._barNs) / span) * chartW;
    }

    // Escape hatch - stateless (pass an explicit view)
    // For secondary panes, minimaps, or any transform against a view other than
    // the current one. Uses raw linear (no session compression, no bar alignment).

    tsToXAt(ts: bigint, view: ViewBounds, chartW: number): number {
        const span = Number(view.tMax - view.tMin);
        if (span === 0) return 0;
        return (Number(ts - view.tMin) / span) * chartW;
    }

    priceToYAt(price: number, view: ViewBounds, chartH: number): number {
        // Secondary panes always use linear - they have their own scale range.
        const span = view.pMax - view.pMin;
        if (span === 0) return 0;
        return (1 - (price - view.pMin) / span) * chartH;
    }

    xToTsAt(x: number, view: ViewBounds, chartW: number): bigint {
        if (chartW === 0) return view.tMin;
        return view.tMin + BigInt(Math.round((x / chartW) * Number(view.tMax - view.tMin)));
    }

    yToPriceAt(y: number, view: ViewBounds, chartH: number): number {
        if (chartH === 0) return view.pMin;
        return view.pMin + (1 - y / chartH) * (view.pMax - view.pMin);
    }

    // Linear
    private _linearPriceToY(price: number, chartH: number): number {
        const span = this.view.pMax - this.view.pMin;
        if (span === 0) return 0;
        return (1 - (price - this.view.pMin) / span) * chartH;
    }

    private _linearYToPrice(y: number, chartH: number): number {
        if (chartH === 0) return this.view.pMin;
        return this.view.pMin + (1 - y / chartH) * (this.view.pMax - this.view.pMin);
    }

    // Log
    // Falls back to linear if prices are non-positive (invalid for log scale).

    private _logPriceToY(price: number, chartH: number): number {
        if (price <= 0 || this.view.pMin <= 0 || this.view.pMax <= 0) {
            return this._linearPriceToY(price, chartH);
        }
        const logPrice = Math.log(price);
        const logMin = Math.log(this.view.pMin);
        const logMax = Math.log(this.view.pMax);
        const span = logMax - logMin;
        if (span === 0) return 0;
        return (1 - (logPrice - logMin) / span) * chartH;
    }

    private _logYToPrice(y: number, chartH: number): number {
        if (this.view.pMin <= 0 || this.view.pMax <= 0) {
            return this._linearYToPrice(y, chartH);
        }
        const logMin = Math.log(this.view.pMin);
        const logMax = Math.log(this.view.pMax);
        return Math.exp(logMin + (1 - y / chartH) * (logMax - logMin));
    }

    // Percent
    // Expresses prices as % change from pRef. Falls back to linear if pRef = 0.

    private _pctPriceToY(price: number, chartH: number): number {
        const ref = this.view.pRef;
        if (ref === 0) return this._linearPriceToY(price, chartH);
        const pctMin = (this.view.pMin - ref) / ref;
        const pctMax = (this.view.pMax - ref) / ref;
        const span = pctMax - pctMin;
        if (span === 0) return 0;
        return (1 - ((price - ref) / ref - pctMin) / span) * chartH;
    }

    private _pctYToPrice(y: number, chartH: number): number {
        const ref = this.view.pRef;
        if (ref === 0) return this._linearYToPrice(y, chartH);
        const pctMin = (this.view.pMin - ref) / ref;
        const pctMax = (this.view.pMax - ref) / ref;
        const pct = pctMin + (1 - y / chartH) * (pctMax - pctMin);
        return ref * (1 + pct);
    }
}

// DrawHook signature
// RenderEngine's addDrawHook passes the transformer to every hook.
// Plugin authors import this type from the SDK.

export type TransformedDrawHook = (
    ctx: CanvasRenderingContext2D,
    transformer: LiveTransformer,
) => void;
