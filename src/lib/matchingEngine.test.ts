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
import { BarStore } from '../core/BarStore';
import { appendEvents, BYTES_PER_EVENT, createCompactBuffer } from './compact-buffer';
import { isoToNs } from './sampler';
import type { MboEvent } from './types';

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

describe("reading the chart's store", () => {
    const at = (k: bigint, low: number, close: number) => ({
        time: Number((T0 + k * BAR_NS) / 1_000_000n),
        open: 100,
        high: 101,
        low,
        close,
        volume: 10,
    });

    it('reads it in place instead of copying', () => {
        const { state } = stubTradingState();
        const engine = createL3MatchingEngine(state, { symbolInfo: SYMBOL_INFO });
        const store = BarStore.from([at(0n, 99, 100)]);

        engine.ingestOhlcvBars!(store, BAR_NS);
        store.append([at(1n, 99, 103)]);
        engine.seekTo(T0 + BAR_NS * 2n);

        assert.equal(engine.getPrice(), 103);
    });

    it('does not replay settled bars after history is paged in at the front', () => {
        const { state, positions } = stubTradingState();
        const engine = createL3MatchingEngine(state, { symbolInfo: SYMBOL_INFO });
        const store = BarStore.from([at(0n, 100, 100), at(1n, 98, 99)]);

        engine.ingestOhlcvBars!(store, BAR_NS);
        engine.seekTo(T0 + BAR_NS * 2n);
        // below the market now, but the bar already replayed went through it
        engine.placeOrder({ side: 'long', type: 'limit', qty: 1, limitPrice: 98.5, symbol: 'TEST' });

        store.prepend([at(-2n, 100, 100), at(-1n, 100, 100)]);
        engine.seekTo(T0 + BAR_NS * 2n);

        assert.equal(positions.length, 0);
    });

    it('leaves the store alone on an append it already holds', () => {
        const { state } = stubTradingState();
        const engine = createL3MatchingEngine(state, { symbolInfo: SYMBOL_INFO });
        const store = BarStore.from([at(0n, 99, 100)]);

        engine.ingestOhlcvBars!(store, BAR_NS);
        store.append([at(1n, 99, 101)]);
        engine.appendOhlcvBars!([at(1n, 99, 101)], BAR_NS);

        assert.equal(store.length, 2);
    });

    it('copies before taking an append the store lacks', () => {
        const { state } = stubTradingState();
        const engine = createL3MatchingEngine(state, { symbolInfo: SYMBOL_INFO });
        const store = BarStore.from([at(0n, 99, 100)]);

        engine.ingestOhlcvBars!(store, BAR_NS);
        engine.appendOhlcvBars!([at(1n, 99, 104)], BAR_NS);
        engine.seekTo(T0 + BAR_NS * 2n);

        assert.equal(store.length, 1, 'not written to');
        assert.equal(engine.getPrice(), 104);
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

describe('tick trades handed over again', () => {
    const SEC = 1_000_000_000n;
    const tr = (k: bigint, price: number) => ({ ts: T0 + k * SEC, price, size: 1, side: 'A' as const });
    const held = [tr(0n, 100), tr(1n, 99), tr(2n, 100)];
    const limit: PlaceOrderRequest = { side: 'long', type: 'limit', qty: 1, limitPrice: 99, symbol: 'TEST' };

    function placedAfterReplay() {
        const s = stubTradingState();
        const engine = createL3MatchingEngine(s.state, { symbolInfo: SYMBOL_INFO });
        engine.ingestTicks!(held);
        engine.seekTo(T0 + 3n * SEC);

        // 99 already traded, before the order existed
        engine.placeOrder(limit);
        return { engine, ...s };
    }

    it('does not settle the history again after a page back', () => {
        const { engine, positions } = placedAfterReplay();
        engine.appendTicks!([tr(-2n, 98), tr(-1n, 100), ...held]);
        engine.seekTo(T0 + 3n * SEC);
        assert.equal(positions.length, 0);
    });

    it('still fills on what comes after', () => {
        const { engine, positions } = placedAfterReplay();
        engine.appendTicks!([tr(-1n, 100), ...held, tr(4n, 99)]);
        engine.seekTo(T0 + 5n * SEC);
        assert.equal(positions.length > 0, true);
    });
});

describe('l3 events handed over again', () => {
    const SEC = 1_000_000_000n;
    const ev = (k: bigint, action: string, side: string, price: number, id: number): MboEvent => ({
        ts_event: new Date(Number((T0 + k * SEC) / 1_000_000n)).toISOString(),
        action: action as MboEvent['action'],
        side: side as MboEvent['side'],
        price,
        size: 1,
        order_id: String(id),
        sequence: 0,
        flags: 0,
    });
    const bufOf = (events: MboEvent[]) => {
        const cb = createCompactBuffer();
        appendEvents(cb, events, isoToNs);
        return cb._buf.slice(0, cb.length * BYTES_PER_EVENT);
    };
    // a sell sweeps through 98 before the order exists
    const held = [ev(0n, 'A', 'B', 100, 1), ev(0n, 'A', 'A', 101, 2), ev(1n, 'T', 'A', 98, 9)];
    const limit: PlaceOrderRequest = { side: 'long', type: 'limit', qty: 1, limitPrice: 99, symbol: 'TEST' };

    function placedAfterReplay() {
        const s = stubTradingState();
        const engine = createL3MatchingEngine(s.state, { symbolInfo: SYMBOL_INFO });
        engine.ingestCompactBuf!(bufOf(held));
        engine.seekTo(T0 + 2n * SEC);
        engine.placeOrder(limit);
        return { engine, ...s };
    }

    it('does not settle the history again after a page back', () => {
        const { engine, positions } = placedAfterReplay();
        engine.appendCompactBuf!(bufOf([ev(-2n, 'A', 'B', 99.5, 3), ...held]));
        engine.seekTo(T0 + 2n * SEC);
        assert.equal(positions.length, 0);
        assert.deepEqual(
            engine.getDepth!(5).bids.map((l) => l.price),
            [100, 99.5],
            'and the book has the page in it',
        );
    });

    it('still fills on what comes after', () => {
        const { engine, positions } = placedAfterReplay();
        engine.appendCompactBuf!(bufOf([ev(-2n, 'A', 'B', 99.5, 3), ...held, ev(3n, 'T', 'A', 98, 9)]));
        engine.seekTo(T0 + 4n * SEC);
        assert.equal(positions.length > 0, true);
    });

    it('triggers a stop the ask crosses and comes back from within one seek', () => {
        const { engine, positions } = placedAfterReplay();
        engine.placeOrder({ side: 'long', type: 'stop', qty: 1, stopPrice: 102, symbol: 'TEST' });
        engine.appendCompactBuf!(
            bufOf([
                ...held,
                ev(3n, 'A', 'A', 102.5, 3),
                ev(3n, 'C', 'A', 101, 2),
                ev(4n, 'A', 'A', 101, 4),
            ]),
        );
        engine.seekTo(T0 + 5n * SEC);
        assert.equal(positions.length > 0, true);
    });

    it('a page back builds the same book as replaying everything', () => {
        let seed = 7;
        const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
        for (let run = 0; run < 40; run++) {
            const events: MboEvent[] = [];
            const live = new Map<number, { side: string; price: number }>();
            let nextId = 1;
            for (let k = 0; k < 600; k++) {
                const r = rnd();
                const ids = [...live.keys()];
                const pick = ids[Math.floor(rnd() * ids.length)];
                const at = (k: number, a: string, s: string, p: number, id: number) =>
                    events.push({ ...ev(BigInt(k), a, s, p, id), size: 1 + Math.floor(rnd() * 5) });
                if (r < 0.005) {
                    at(k, 'R', 'N', 0, 0);
                    live.clear();
                } else if (r < 0.45 || pick === undefined) {
                    const side = rnd() < 0.5 ? 'B' : 'A';
                    const price = side === 'B' ? 95 + Math.floor(rnd() * 5) : 101 + Math.floor(rnd() * 5);
                    live.set(nextId, { side, price });
                    at(k, 'A', side, price, nextId++);
                } else if (r < 0.7) {
                    at(k, 'C', live.get(pick)!.side, 0, pick);
                    live.delete(pick);
                } else if (r < 0.85) {
                    const o = live.get(pick)!;
                    o.price = o.side === 'B' ? 95 + Math.floor(rnd() * 5) : 101 + Math.floor(rnd() * 5);
                    at(k, 'M', o.side, rnd() < 0.2 ? 0 : o.price, pick);
                } else {
                    at(k, 'T', live.get(pick)!.side === 'B' ? 'A' : 'B', live.get(pick)!.price, pick);
                    live.delete(pick);
                }
            }
            const cut1 = 50 + Math.floor(rnd() * 250);
            const cut2 = cut1 + 1 + Math.floor(rnd() * 250);
            const seek = T0 + BigInt(cut2 + Math.floor(rnd() * (600 - cut2))) * SEC;
            const later = T0 + 600n * SEC;
            const book = (e: ReturnType<typeof createL3MatchingEngine>) => JSON.stringify(e.getDepth!(50));

            const whole = createL3MatchingEngine(stubTradingState().state, { symbolInfo: SYMBOL_INFO });
            whole.ingestCompactBuf!(bufOf(events));
            whole.seekTo(seek);

            const paged = createL3MatchingEngine(stubTradingState().state, { symbolInfo: SYMBOL_INFO });
            paged.ingestCompactBuf!(bufOf(events.slice(cut2)));
            paged.seekTo(seek);
            paged.appendCompactBuf!(bufOf(events.slice(cut1)));
            paged.appendCompactBuf!(bufOf(events));
            assert.equal(book(paged), book(whole), `run ${run}`);

            whole.seekTo(later);
            paged.seekTo(later);
            assert.equal(book(paged), book(whole), `run ${run}, played on`);
        }
    });

    it('starts a new window on an empty book', () => {
        const { state } = stubTradingState();
        const engine = createL3MatchingEngine(state, { symbolInfo: SYMBOL_INFO });
        engine.ingestCompactBuf!(bufOf(held));
        engine.seekTo(T0 + 2n * SEC);

        engine.ingestCompactBuf!(bufOf([ev(5n, 'A', 'B', 90, 5), ev(5n, 'A', 'A', 91, 6)]));
        engine.seekTo(T0 + 6n * SEC);
        assert.deepEqual(
            engine.getDepth!(5).bids.map((l) => l.price),
            [90],
        );
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

    it('leaves a restored tick stop alone on the trades it predates', () => {
        const { state, positions } = stubTradingState();
        const engine = createL3MatchingEngine(state, { symbolInfo: SYMBOL_INFO });
        const SEC = 1_000_000_000n;
        engine.ingestTicks!([
            { ts: T0, price: 100, size: 1, side: 'B' },
            { ts: T0 + SEC, price: 98, size: 1, side: 'A' },
            { ts: T0 + 2n * SEC, price: 100, size: 1, side: 'B' },
        ]);
        engine.syncOrder({
            id: 'restored-stop',
            symbol: 'TEST',
            side: 'short',
            type: 'stop',
            status: 'working',
            quantity: 1,
            filledQuantity: 0,
            price: 0,
            stopPrice: 99,
            bracket: { takeProfits: [], stopLosses: [] },
        } as any);

        engine.seekTo(T0 + 3n * SEC);

        assert.equal(positions.length, 0);
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
