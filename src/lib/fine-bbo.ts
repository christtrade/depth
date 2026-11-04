import type { PriceHistory, ViewBounds } from './types';
import type { HeatmapReply, HeatmapRequest } from './types/heatmap-types';

// a 50ms price history sample is 2px wide here
const MAX_NS_PER_PX = 25_000_000;

const firstAtOrAfter = (h: PriceHistory[], ts: bigint) => {
    let lo = 0;
    let hi = h.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (h[mid].ts < ts) lo = mid + 1;
        else hi = mid;
    }
    return lo;
};

export class FineBbo {
    private asked: { from: bigint; to: bigint } | null = null;
    private stale = false;
    private held: { from: bigint; to: bigint; points: PriceHistory[] } | null = null;
    private wanted = false;

    constructor(
        private post: (req: HeatmapRequest) => void,
        private changed: () => void,
        private lines: (wanted: boolean) => void = () => {},
    ) {}

    notNeeded(): void {
        if (!this.wanted) return;
        this.wanted = false;
        this.clear();
        this.lines(false);
    }

    onReply(r: Extract<HeatmapReply, { type: 'bbo' }>): void {
        const a = this.asked;
        if (!a || r.from !== a.from.toString() || r.to !== a.to.toString()) return;
        const points: PriceHistory[] = [];
        for (let i = 0; i < r.ts.length; i++) points.push({ ts: r.ts[i], bestBid: r.bid[i], bestAsk: r.ask[i] });
        this.held = { from: a.from, to: BigInt(r.until), points };
        this.changed();
    }

    dataFrom(from: bigint): void {
        if (from === 0n) this.clear();
        else if (this.asked && this.asked.to > from) this.stale = true;
    }

    clear(): void {
        this.asked = null;
        this.held = null;
        this.stale = false;
    }

    // the exact lines over the part of the view the worker answered, `history` for the rest
    over(history: PriceHistory[], view: ViewBounds, w: number): PriceHistory[] {
        const span = view.tMax - view.tMin;
        if (w <= 0 || span <= 0n || Number(span) / w >= MAX_NS_PER_PX) {
            this.clear();
            return history;
        }
        const a = this.asked;
        if (!a || this.stale || view.tMin < a.from || view.tMax > a.to) {
            const from = view.tMin > span ? view.tMin - span : 0n;
            const to = view.tMax + span;
            this.asked = { from, to };
            this.stale = false;
            this.wanted = true;
            this.lines(true);
            this.post({ type: 'bbo', from: from.toString(), to: to.toString() });
        }
        const h = this.held;
        if (!h || !h.points.length || h.to <= view.tMin || h.from >= view.tMax) return history;
        const before = h.from > view.tMin ? history.slice(Math.max(0, firstAtOrAfter(history, view.tMin) - 1), firstAtOrAfter(history, h.from)) : [];
        const after = h.to < view.tMax ? history.slice(firstAtOrAfter(history, h.to), firstAtOrAfter(history, view.tMax) + 1) : [];
        return before.length || after.length ? before.concat(h.points, after) : h.points;
    }
}
