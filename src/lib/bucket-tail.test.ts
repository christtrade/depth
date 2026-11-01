import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extendBucketedPh, extendCandles, extendFootprints, foldTrades, type Candle } from './bucket-tail';
import { footprintFromTrades, type FootprintBar } from './types/footprint';
import type { PriceHistory, TradePoint } from './types';

const SEC = 1_000_000_000n;
const MIN = 60n * SEC;

const trades: TradePoint[] = [];
const quotes: PriceHistory[] = [];
for (let s = 0n; s < 600n; s += 7n) {
    const p = 100 + Number(s % 13n) * 0.25;
    trades.push({ ts: s * SEC, price: p, size: 1 + Number(s % 3n), side: s % 2n ? 'A' : 'B' });
    quotes.push({ ts: s * SEC, bestBid: p - 0.25, bestAsk: p });
}
const upTo = <T extends { ts: bigint }>(arr: T[], ns: bigint) => arr.filter((x) => x.ts <= ns);
const clone = <T>(arr: T[]) => arr.map((x) => ({ ...x }));

function whole(t: TradePoint[], q: PriceHistory[], horizon: bigint) {
    const candles = new Map<bigint, Candle>();
    extendCandles(candles, t, MIN, horizon);
    const ph: PriceHistory[] = [];
    const cursor = extendBucketedPh(ph, q, MIN, horizon);
    return { candles: [...candles], ph, cursor };
}

describe('extending the buckets a chunk at a time', () => {
    it('ends up where building it whole does', () => {
        const candles = new Map<bigint, Candle>();
        const ph: PriceHistory[] = [];
        let cursor = -1;
        for (let edge = 30n * SEC; edge <= 600n * SEC; edge += 30n * SEC) {
            const t = upTo(trades, edge);
            const q = upTo(quotes, edge);
            extendCandles(candles, t, MIN, edge);
            cursor = extendBucketedPh(ph, q, MIN, edge);
        }
        assert.deepEqual({ candles: [...candles], ph, cursor }, whole(trades, quotes, 600n * SEC));
    });

    it('folds a playhead step by step, past the last trade too', () => {
        const candles = new Map<bigint, Candle>();
        for (let edge = 0n; edge <= 700n * SEC; edge += 5n * SEC) {
            foldTrades(candles, trades, MIN, edge - 5n * SEC, edge);
            assert.deepEqual([...candles], whole(trades, quotes, edge).candles);
        }
    });

    it('takes the last bucket as sent, not as held', () => {
        const candles = new Map<bigint, Candle>();
        const ph: PriceHistory[] = [];
        extendCandles(candles, upTo(trades, 290n * SEC), MIN, 290n * SEC);
        extendBucketedPh(ph, upTo(quotes, 290n * SEC), MIN, 290n * SEC);

        const t = clone(trades).filter((x) => x.ts !== 245n * SEC);
        const q = clone(quotes).filter((x) => x.ts !== 245n * SEC);
        extendCandles(candles, t, MIN, 600n * SEC);
        const cursor = extendBucketedPh(ph, q, MIN, 600n * SEC);
        assert.deepEqual({ candles: [...candles], ph, cursor }, whole(t, q, 600n * SEC));
    });

    it('footprints step forward to what building them whole gives', () => {
        const bars: FootprintBar[] = [];
        for (let edge = 30n * SEC; edge <= 600n * SEC; edge += 30n * SEC) {
            extendFootprints(bars, trades, MIN, edge);
            assert.deepEqual(bars, footprintFromTrades(upTo(trades, edge), MIN));
        }
        extendFootprints(bars, trades, MIN, 600n * SEC);
        assert.deepEqual(bars, footprintFromTrades(trades, MIN));
    });

    it('stops at the playhead', () => {
        const { candles, ph, cursor } = whole(trades, quotes, 200n * SEC);
        assert.equal(candles.at(-1)![0], 3n * MIN);
        assert.equal(ph.at(-1)!.ts, 3n * MIN);
        assert.equal(quotes[cursor].ts <= 200n * SEC && quotes[cursor + 1].ts > 200n * SEC, true);
    });
});
