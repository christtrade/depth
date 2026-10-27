import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    createL3MatchingEngine,
    feeScheduleFor,
    MICRO_FEE_SCHEDULE,
    NQ_FEE_SCHEDULE,
    type FeeSchedule,
    type PlaceOrderRequest,
} from './matchingEngine';
import { getTickValue } from './types/trading-types';

// The engine talks to trading state through a handful of setters. None of them
// matter here - these tests are about what the engine does before it has been
// walked into its data - so record the orders and no-op the rest.
function stubTradingState() {
    const orders: any[] = [];
    const positions: any[] = [];
    const target = {
        upsertOrder: (o: any) => orders.push(o),
        upsertPosition: (p: any) => positions.push(p),
    };
    const state = new Proxy(target, {
        get: (t: any, prop: string) => t[prop] ?? (() => {}),
    });
    return { state: state as any, orders, positions };
}

const SYMBOL_INFO: any = {
    symbol: 'TEST',
    priceFormat: { minTick: 0.25, precision: 2 },
    contract: { multiplier: 1 },
};

const MARKET_BUY: PlaceOrderRequest = { side: 'long', type: 'market', qty: 1, symbol: 'TEST' };

const BAR_NS = 60_000_000_000n;
const T0 = 1_700_000_000_000_000_000n;
const bars = [
    { time: Number(T0 / 1_000_000n), open: 100, high: 101, low: 99, close: 100.5, volume: 10 },
    {
        time: Number((T0 + BAR_NS) / 1_000_000n),
        open: 100.5,
        high: 102,
        low: 100,
        close: 101.5,
        volume: 12,
    },
];

describe('a book with no price yet', () => {
    it('reports NaN rather than throwing', () => {
        const { state } = stubTradingState();
        const engine = createL3MatchingEngine(state, { symbolInfo: SYMBOL_INFO });

        assert.ok(Number.isNaN(engine.getPrice()));
    });

    it('rejects an order instead of crashing on the missing tick', () => {
        const { state, orders } = stubTradingState();
        const engine = createL3MatchingEngine(state, { symbolInfo: SYMBOL_INFO });

        const id = engine.placeOrder(MARKET_BUY);

        assert.equal(typeof id, 'string');
        assert.equal(orders.length, 1);
        assert.equal(orders[0].status, 'rejected');
        assert.equal(orders[0].id, id);
    });

    it('is priced once seeked through its data - the seed the chart does on load', () => {
        const { state } = stubTradingState();
        const engine = createL3MatchingEngine(state, { symbolInfo: SYMBOL_INFO });

        engine.ingestOhlcvBars!(bars as any, BAR_NS);
        assert.ok(Number.isNaN(engine.getPrice()), 'data alone is not a price');

        engine.seekTo(T0 + BAR_NS * 2n);

        assert.equal(engine.getPrice(), 101.5);
    });
});

describe('swapping the bar period under the replay', () => {
    // the same span as `bars`, at half the period
    const HALF = BAR_NS / 2n;
    const fineBars = [0n, HALF, BAR_NS, BAR_NS + HALF].map((off, i) => ({
        time: Number((T0 + off) / 1_000_000n),
        open: 100 + i * 0.5,
        high: 101 + i * 0.5,
        low: 99 + i * 0.5,
        close: 100.5 + i * 0.5,
        volume: 5,
    }));

    // the span a limit at 99.5 fills inside, at both periods
    const fillBars = [
        { time: Number(T0 / 1_000_000n), open: 100, high: 101, low: 100, close: 100.5, volume: 10 },
        {
            time: Number((T0 + BAR_NS) / 1_000_000n),
            open: 100.5,
            high: 100.75,
            low: 98,
            close: 99,
            volume: 12,
        },
    ];
    const fillBarsFine = [0n, HALF, BAR_NS, BAR_NS + HALF].map((off, i) => ({
        time: Number((T0 + off) / 1_000_000n),
        open: [100, 100.25, 100.5, 99.5][i],
        high: [101, 100.5, 100.75, 99.6][i],
        low: [100, 100.25, 98, 98.5][i],
        close: [100.25, 100.5, 99.5, 99][i],
        volume: 6,
    }));

    it('does not fill the same resting order a second time', () => {
        const { state, orders, positions } = stubTradingState();
        const engine = createL3MatchingEngine(state, { symbolInfo: SYMBOL_INFO });

        engine.ingestOhlcvBars!(fillBars as any, BAR_NS);
        engine.seekTo(T0 + BAR_NS);
        engine.placeOrder({
            side: 'long',
            type: 'limit',
            qty: 1,
            limitPrice: 99.5,
            symbol: 'TEST',
        });
        engine.seekTo(T0 + BAR_NS * 2n);

        const filledOnce = positions.length;
        const ordersOnce = orders.length;
        assert.ok(filledOnce > 0, 'the limit has to fill for this to mean anything');

        // the switch: same span, half the period, then the same horizon again
        engine.swapOhlcvBars!(fillBarsFine as any, HALF);
        engine.seekTo(T0 + BAR_NS * 2n);

        assert.equal(positions.length, filledOnce, 'no second fill');
        assert.equal(orders.length, ordersOnce, 'and no second order event');
    });

    it('rewinds normally when the playhead goes back behind the swap', () => {
        const { state } = stubTradingState();
        const engine = createL3MatchingEngine(state, { symbolInfo: SYMBOL_INFO });

        engine.ingestOhlcvBars!(bars as any, BAR_NS);
        engine.seekTo(T0 + BAR_NS * 2n);
        engine.swapOhlcvBars!(fineBars as any, HALF);

        // scrubbing back is a rewind like any other - the finer bars replay
        engine.seekTo(T0);
        engine.seekTo(T0 + BAR_NS * 2n);

        assert.equal(engine.getPrice(), fineBars[fineBars.length - 1].close);
    });

    it('falls back to a plain ingest when there is nothing to swap', () => {
        const { state } = stubTradingState();
        const engine = createL3MatchingEngine(state, { symbolInfo: SYMBOL_INFO });

        engine.swapOhlcvBars!(bars as any, BAR_NS);
        engine.seekTo(T0 + BAR_NS * 2n);

        assert.equal(engine.getPrice(), 100.5 + 1);
    });
});

/**
 * Brackets can be set on an order while it is still resting - dragging a TP or
 * SL off its line does exactly that. They reach the engine through syncOrder,
 * and the fill is where they have to turn into the position's own brackets. If
 * they don't, the levels look set on the chart and protect nothing.
 */
describe('a bracket added to a resting order', () => {
    const restingBars = [
        // Opens away from the limit, so the order rests instead of filling.
        { time: Number(T0 / 1_000_000n), open: 100, high: 101, low: 100, close: 100.5, volume: 10 },
        // Trades down through it.
        {
            time: Number((T0 + BAR_NS) / 1_000_000n),
            open: 100.5,
            high: 100.75,
            low: 98,
            close: 99,
            volume: 12,
        },
    ];

    it('is carried onto the position when the order fills', () => {
        const { state, orders, positions } = stubTradingState();
        const engine = createL3MatchingEngine(state, { symbolInfo: SYMBOL_INFO });

        engine.ingestOhlcvBars!(restingBars as any, BAR_NS);
        // Through the first bar only: priced, but nothing has traded at 99.5.
        engine.seekTo(T0 + BAR_NS);

        const id = engine.placeOrder({
            side: 'long',
            type: 'limit',
            qty: 1,
            limitPrice: 99.5,
            symbol: 'TEST',
        });
        const working = orders.find((o) => o.id === id);
        assert.equal(working.status, 'working', 'the order has to rest for this to be the case');

        // What dragging a ghost TP onto a working order does: the level is
        // appended locally and the amended order is handed back to the engine.
        engine.syncOrder({
            ...working,
            bracket: {
                ...working.bracket,
                takeProfits: [
                    { id: 'tp-1', price: 105, qty: 1, triggered: false, triggeredAt: 0 },
                ],
                stopLosses: [],
            },
        });

        engine.seekTo(T0 + BAR_NS * 2n);

        const opened = positions.at(-1);
        assert.ok(opened, 'the limit should have filled');
        assert.equal(opened.takeProfits.length, 1);
        assert.equal(opened.takeProfits[0].price, 105);
    });

    it('leaves a restored order protected from the bars it predates', () => {
        const { state, positions } = stubTradingState();
        const engine = createL3MatchingEngine(state, { symbolInfo: SYMBOL_INFO });

        engine.ingestOhlcvBars!(restingBars as any, BAR_NS);

        // The restore path: an order this engine never placed, handed over
        // before the first seek. The window it is dropped into already contains
        // a print through its price, and that print is not its fill.
        engine.syncOrder({
            id: 'restored-1',
            symbol: 'TEST',
            side: 'long',
            type: 'limit',
            status: 'working',
            quantity: 1,
            filledQuantity: 0,
            price: 99.5,
            stopPrice: 0,
            bracket: { takeProfits: [], stopLosses: [] },
        } as any);

        engine.seekTo(T0 + BAR_NS * 2n);

        assert.equal(positions.length, 0, 'a restored order must not settle against the past');
    });
});

describe('a micro contract', () => {
    const mini: any = { symbol: '/NQ1', type: 'future', contract: { multiplier: 20 } };
    const micro: any = { symbol: '/MNQ1', type: 'future', contract: { multiplier: 2 } };

    const perSide = (schedule: FeeSchedule) =>
        schedule.exchangeFeePerContract +
        schedule.commissionPerContract +
        schedule.nfaFeePerContract +
        schedule.clearingFeePerContract;

    it('is not charged the fees of the mini it is a tenth of', () => {
        // Fees are per contract. On the mini's schedule, the ten micros that
        // add up to one NQ would cost ten times what that NQ costs, and sizing
        // down - the whole reason the contract exists - would be the most
        // expensive way to take the same trade.
        assert.deepEqual(feeScheduleFor(micro), MICRO_FEE_SCHEDULE);
        assert.deepEqual(feeScheduleFor(mini), NQ_FEE_SCHEDULE);
        assert.ok(perSide(feeScheduleFor(micro)) < perSide(feeScheduleFor(mini)) / 3);
    });

    it('leaves anything that is not a future on the schedule it already had', () => {
        assert.deepEqual(
            feeScheduleFor({ symbol: 'btcusdt', type: 'crypto' } as any),
            NQ_FEE_SCHEDULE,
        );
        assert.deepEqual(feeScheduleFor(null), NQ_FEE_SCHEDULE);
    });

    it('is not read as its mini when the ticker is all there is to go on', () => {
        // Every micro's ticker contains its mini's, so a substring match in
        // declaration order prices MNQ at $20 a point - ten times its size.
        assert.equal(getTickValue('MNQH6'), 2);
        assert.equal(getTickValue('NQH6'), 20);
        assert.equal(getTickValue('MESH6'), 5);
        assert.equal(getTickValue('ESH6'), 50);
    });
});
