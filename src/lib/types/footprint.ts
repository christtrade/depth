// builds the per-bar, per-price-level bid/ask volume maps from raw MBO trades,
// and the orderflow signals off them:
//
//   imbalance            ask/bid ratio >= threshold at one level
//   stacked imbalance    n consecutive imbalanced levels
//   absorption           large volume printing against the prevailing delta
//   unfinished auction   bid or ask side at the bar high/low is 0
//   diagonal imbalance   ask[n] vs bid[n-1] and bid[n] vs ask[n+1], the
//                        cross-level comparison Sierra and Bookmap use
import type { MboEvent } from '.';

// Types
/** Volume at a single price level inside one bar. */
export type FootprintLevel = {
    price: number;
    bidVol: number; // aggressive sells hitting the bid  (T event, side === 'A')
    askVol: number; // aggressive buys  lifting the ask  (T event, side === 'B')
    delta: number; // askVol - bidVol
    totalVol: number;

    // Per-level orderflow flags
    /** Bid volume significantly exceeds ask at this level (sell imbalance). */
    bidImbalance: boolean;
    /** Ask volume significantly exceeds bid at this level (buy imbalance). */
    askImbalance: boolean;

    /**
     * DIAGONAL IMBALANCE
     * Sierra Chart / Bookmap definition: compares the ASK at this level
     * against the BID one tick BELOW, and the BID at this level against the
     * ASK one tick ABOVE.  This surfaces diagonal pressure in the tape.
     *
     * diagAskImbalance: ask[n] >= threshold x bid[n-1]   -> upward diagonal pressure
     * diagBidImbalance: bid[n] >= threshold x ask[n+1]   -> downward diagonal pressure
     */
    diagAskImbalance: boolean;
    diagBidImbalance: boolean;

    /**
     * ABSORPTION
     * Large volume that didn't move price - the market "absorbed" the flow.
     * Detected when totalVol >= absorptionThreshold AND the level is inside
     * the bar body (between open and close), AND the delta is small relative
     * to the volume (i.e. both sides traded heavily).
     */
    absorption: boolean;
};

/** All price levels for a single candle bar. */
export type FootprintBar = {
    /** Bar open timestamp (nanoseconds, floored to barNs boundary). */
    ts: bigint;
    open: number;
    high: number;
    low: number;
    close: number;
    totalVol: number;
    totalDelta: number;
    maxLevelVol: number;
    maxAbsDelta: number;
    /** Sorted high->low. */
    levels: FootprintLevel[];
    isBullish: boolean;
    poc: number;

    // Per-bar orderflow signals
    /**
     * STACKED IMBALANCE (buy side)
     * Price range [stackedBuyLow, stackedBuyHigh] where >= stackMinCount
     * consecutive levels all have askImbalance === true.
     * Can be multiple non-overlapping stacks per bar.
     */
    stackedBuyZones: PriceRange[];

    /**
     * STACKED IMBALANCE (sell side)
     * Price range where >= stackMinCount consecutive levels all have bidImbalance.
     */
    stackedSellZones: PriceRange[];

    /**
     * UNFINISHED AUCTION (high)
     * The bar high has zero (or near-zero) ask volume - buyers ran out of
     * sellers at the top, price "unfinished" - likely to revisit.
     */
    unfinishedTop: boolean;

    /**
     * UNFINISHED AUCTION (low)
     * The bar low has zero (or near-zero) bid volume - sellers ran out of
     * buyers at the bottom.
     */
    unfinishedBottom: boolean;

    /** Number of levels with absorption signal in this bar. */
    absorptionCount: number;

    /** Dominant diagonal imbalance direction for the bar ('buy'|'sell'|'none'). */
    diagDominant: 'buy' | 'sell' | 'none';
};

export type PriceRange = { low: number; high: number };

/**
 * Display mode for footprint cells.
 *
 * 'bid-ask'  - two columns per level: sell vol (left) | buy vol (right)
 * 'profile'  - single bar, width = total vol, green/red by dominant side
 * 'delta'    - bar width = |delta|, coloured by direction
 * 'total'    - bar width = total vol, neutral grey
 */
export type FootprintMode = 'bid-ask' | 'profile' | 'delta' | 'total';

// Config (overridable via buildFootprint options)
export type FootprintOptions = {
    tickSize?: number;
    /** Ratio threshold for a level to be considered imbalanced (default 3.0 = 300%). */
    imbalanceRatio?: number;
    /**
     * Minimum consecutive imbalanced levels to form a stacked imbalance zone
     * (default 3).
     */
    stackMinCount?: number;
    /**
     * Volume threshold multiplier for absorption detection.
     * A level is "absorbed" when totalVol >= absorptionMult x bar average level vol
     * AND |delta / totalVol| <= absorptionDeltaFrac (default 0.25).
     */
    absorptionMult?: number;
    absorptionDeltaFrac?: number;
    /**
     * How many ticks from the bar extreme to look for unfinished auction.
     * Default 1 = only the exact high/low tick.
     */
    unfinishedTicks?: number;
    /**
     * Diagonal imbalance ratio threshold.
     * ask[n] / bid[n-1] >= diagRatio  -> diagAskImbalance
     * Default: same as imbalanceRatio.
     */
    diagRatio?: number;
};

const DEFAULTS: Required<FootprintOptions> = {
    tickSize: 0.25,
    imbalanceRatio: 3.0,
    stackMinCount: 3,
    absorptionMult: 2.5,
    absorptionDeltaFrac: 0.25,
    unfinishedTicks: 1,
    diagRatio: 3.0,
};

// Builder
export function buildFootprint(
    events: MboEvent[],
    barNs: bigint,
    options: FootprintOptions = {},
): FootprintBar[] {
    if (barNs === 0n || events.length === 0) return [];

    const cfg: Required<FootprintOptions> = { ...DEFAULTS, ...options };
    const {
        tickSize,
        imbalanceRatio,
        stackMinCount,
        absorptionMult,
        absorptionDeltaFrac,
        unfinishedTicks,
        diagRatio,
    } = cfg;

    const roundTick = (price: number) => Math.round(price / tickSize) * tickSize;

    // Pass 1: bucket trades by (barTs, roundedPrice)
    type RawLevel = { bid: number; ask: number };
    type RawBar = {
        levels: Map<number, RawLevel>;
        open: number;
        high: number;
        low: number;
        close: number;
        totalVol: number;
    };

    const barMap = new Map<bigint, RawBar>();

    for (const ev of events) {
        if (ev.action !== 'T' || ev.price === null || ev.side === 'N') continue;

        const tsNs = isoToNs(ev.ts_event);
        const barTs = (tsNs / barNs) * barNs;
        const p = roundTick(ev.price);
        const size = ev.size;
        const isAggBuy = ev.side === 'B';

        let bar = barMap.get(barTs);
        if (!bar) {
            bar = { levels: new Map(), open: p, high: p, low: p, close: p, totalVol: 0 };
            barMap.set(barTs, bar);
        }
        if (p > bar.high) bar.high = p;
        if (p < bar.low) bar.low = p;
        bar.close = p;
        bar.totalVol += size;

        let lv = bar.levels.get(p);
        if (!lv) {
            lv = { bid: 0, ask: 0 };
            bar.levels.set(p, lv);
        }
        if (isAggBuy) lv.ask += size;
        else lv.bid += size;
    }

    // Pass 2: materialise & compute analytics
    const bars: FootprintBar[] = [];

    for (const [ts, raw] of barMap) {
        // Sort levels high->low
        const sortedPrices = Array.from(raw.levels.keys()).sort((a, b) => b - a);
        const numLevels = sortedPrices.length;

        // Average vol per level (for absorption threshold)
        const avgLevelVol = numLevels > 0 ? raw.totalVol / numLevels : 1;
        const absorptionThreshold = absorptionMult * avgLevelVol;

        let maxLevelVol = 0,
            maxAbsDelta = 0;
        let pocPrice = raw.open,
            pocVol = 0;

        // Build level objects (without cross-level flags yet)
        const levelMap = new Map<number, FootprintLevel>();
        for (const price of sortedPrices) {
            const lv = raw.levels.get(price)!;
            const totalVol = lv.bid + lv.ask;
            const delta = lv.ask - lv.bid;
            if (totalVol > maxLevelVol) maxLevelVol = totalVol;
            if (Math.abs(delta) > maxAbsDelta) maxAbsDelta = Math.abs(delta);
            if (totalVol > pocVol) {
                pocVol = totalVol;
                pocPrice = price;
            }

            // Absorption: high vol + balanced delta + inside body
            const bodyTop = Math.max(raw.open, raw.close);
            const bodyBot = Math.min(raw.open, raw.close);
            const insideBody = price <= bodyTop && price >= bodyBot;
            const absorption =
                totalVol >= absorptionThreshold &&
                totalVol > 0 &&
                Math.abs(delta) / totalVol <= absorptionDeltaFrac &&
                insideBody;

            levelMap.set(price, {
                price,
                bidVol: lv.bid,
                askVol: lv.ask,
                delta,
                totalVol,
                bidImbalance: false,
                askImbalance: false,
                diagAskImbalance: false,
                diagBidImbalance: false,
                absorption,
            });
        }

        // Per-level imbalance (vertical: compare same-level ask vs bid)
        for (const [, level] of levelMap) {
            const { bidVol, askVol } = level;
            // Ask imbalance: ask overwhelms bid at this level (buying pressure)
            if (askVol > 0 && (bidVol === 0 || askVol / bidVol >= imbalanceRatio)) {
                level.askImbalance = true;
            }
            // Bid imbalance: bid overwhelms ask (selling pressure)
            if (bidVol > 0 && (askVol === 0 || bidVol / askVol >= imbalanceRatio)) {
                level.bidImbalance = true;
            }
        }

        // Diagonal imbalance
        // ask[n] vs bid[n-1]  (one tick below n)
        // bid[n] vs ask[n+1]  (one tick above n)
        for (const [price, level] of levelMap) {
            const below = levelMap.get(roundTick(price - tickSize));
            const above = levelMap.get(roundTick(price + tickSize));

            // diagAskImbalance: ask here vs bid one tick below
            if (below && level.askVol > 0) {
                if (below.bidVol === 0 || level.askVol / below.bidVol >= diagRatio) {
                    level.diagAskImbalance = true;
                }
            }
            // diagBidImbalance: bid here vs ask one tick above
            if (above && level.bidVol > 0) {
                if (above.askVol === 0 || level.bidVol / above.askVol >= diagRatio) {
                    level.diagBidImbalance = true;
                }
            }
        }

        const levels: FootprintLevel[] = Array.from(levelMap.values()).sort(
            (a, b) => b.price - a.price,
        );

        // Stacked imbalance zones
        // Walk the sorted (high->low) levels and find consecutive runs.
        const stackedBuyZones: PriceRange[] = [];
        const stackedSellZones: PriceRange[] = [];

        // Buy stacks: consecutive askImbalance levels
        _findStacks(levels, (l) => l.askImbalance, stackMinCount, stackedBuyZones);
        // Sell stacks: consecutive bidImbalance levels
        _findStacks(levels, (l) => l.bidImbalance, stackMinCount, stackedSellZones);

        // Unfinished auction
        let unfinishedTop = false;
        let unfinishedBottom = false;

        // Check unfinishedTicks levels from the extreme
        const topTick = roundTick(raw.high);
        for (let t = 0; t < unfinishedTicks; t++) {
            const p = roundTick(topTick - t * tickSize);
            const lv = levelMap.get(p);
            // Unfinished top: asks at the high are 0 (buyers hit zero sellers)
            if (!lv || lv.askVol === 0) {
                unfinishedTop = true;
                break;
            }
        }

        const bottomTick = roundTick(raw.low);
        for (let t = 0; t < unfinishedTicks; t++) {
            const p = roundTick(bottomTick + t * tickSize);
            const lv = levelMap.get(p);
            // Unfinished bottom: bids at the low are 0 (sellers hit zero buyers)
            if (!lv || lv.bidVol === 0) {
                unfinishedBottom = true;
                break;
            }
        }

        // Diagonal dominant direction
        let diagBuy = 0,
            diagSell = 0;
        for (const lv of levels) {
            if (lv.diagAskImbalance) diagBuy++;
            if (lv.diagBidImbalance) diagSell++;
        }
        const diagDominant: FootprintBar['diagDominant'] =
            diagBuy > diagSell ? 'buy' : diagSell > diagBuy ? 'sell' : 'none';

        bars.push({
            ts,
            open: raw.open,
            high: raw.high,
            low: raw.low,
            close: raw.close,
            totalVol: raw.totalVol,
            totalDelta: levels.reduce((s, l) => s + l.delta, 0),
            maxLevelVol: Math.max(1, maxLevelVol),
            maxAbsDelta: Math.max(1, maxAbsDelta),
            levels,
            isBullish: raw.close >= raw.open,
            poc: pocPrice,
            stackedBuyZones,
            stackedSellZones,
            unfinishedTop,
            unfinishedBottom,
            absorptionCount: levels.filter((l) => l.absorption).length,
            diagDominant,
        });
    }

    bars.sort((a, b) => (a.ts < b.ts ? -1 : 1));
    return bars;
}

// Helpers
function _findStacks(
    levels: FootprintLevel[],
    predicate: (l: FootprintLevel) => boolean,
    minCount: number,
    out: PriceRange[],
): void {
    let runStart = -1;
    let runLen = 0;
    for (let i = 0; i <= levels.length; i++) {
        const hit = i < levels.length && predicate(levels[i]);
        if (hit) {
            if (runLen === 0) runStart = i;
            runLen++;
        } else {
            if (runLen >= minCount) {
                out.push({
                    high: levels[runStart].price,
                    low: levels[runStart + runLen - 1].price,
                });
            }
            runLen = 0;
            runStart = -1;
        }
    }
}

/** Minimal ISO->ns (mirrors sampler.ts logic). */
function isoToNs(iso: string): bigint {
    const withoutFrac = iso.replace(/\.\d+Z$/, '.000Z');
    const base = BigInt(new Date(withoutFrac).getTime()) * 1_000_000n;
    const match = iso.match(/\.(\d+)Z$/);
    if (match) {
        const fracNs = BigInt(match[1].padEnd(9, '0').slice(0, 9));
        return base + fracNs;
    }
    return base;
}
