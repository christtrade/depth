import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ContractSpec, SymbolInfo } from '../../interfaces/IDataAdapter';
import {
    amountFromQty,
    contractValue,
    deriveTicket,
    levelPrice,
    levelTicks,
    priceDecimals,
    qtyDecimals,
    qtyFromAmount,
    roundQty,
    roundToTick,
    specForSymbol,
    tickSizeOf,
    tickValueOf,
    ticketFromPosition,
    ticksBetween,
    type TicketInput,
} from './order-math';

// NQ: $20 a point; $5 a tick
const NQ: ContractSpec = { tickSize: 0.25, tickValue: 5, multiplier: 20, currency: 'USD' };
// an instrument that only declares a multiplier, the way a thin adapter might
const BARE: ContractSpec = { tickSize: 0.1, multiplier: 2 };

describe('instrument arithmetic', () => {
    it('prefers the published tick value over re-deriving one', () => {
        assert.equal(tickValueOf(NQ), 5);
    });

    it('derives a tick value from the multiplier when none is published', () => {
        assert.equal(tickValueOf(BARE), 0.2);
    });

    it('snaps prices onto the tick grid without floating-point dust', () => {
        assert.equal(roundToTick(21449.93, NQ), 21450);
        assert.equal(roundToTick(21449.8, NQ), 21449.75);
        assert.equal(priceDecimals(NQ), 2);
    });

    it('counts ticks with a sign', () => {
        assert.equal(ticksBetween(21450, 21460, NQ), 40);
        assert.equal(ticksBetween(21460, 21450, NQ), -40);
    });

    it('reports notional exposure, not margin', () => {
        assert.equal(contractValue(21450, 3, NQ), 21450 * 20 * 3);
    });
});

describe('resolving an instrument spec', () => {
    const symbol = (over: Partial<SymbolInfo>): SymbolInfo =>
        ({
            symbol: 'X',
            type: 'crypto',
            dataLevel: 'ohlcv',
            priceFormat: { precision: 2, minTick: 0.01 },
            ...over,
        }) as SymbolInfo;

    it('takes the tick from priceFormat, however fine', () => {
        const spec = specForSymbol(
            symbol({ priceFormat: { precision: 8, minTick: 0.00000001 } }),
        );
        assert.equal(tickSizeOf(spec), 0.00000001);
        assert.equal(priceDecimals(spec), 8);
        assert.equal(roundToTick(0.000123456789, spec), 0.00012346);
    });

    it('prefers a published tick value, and derives one otherwise', () => {
        const published = specForSymbol(
            symbol({
                priceFormat: { precision: 2, minTick: 0.25 },
                contract: { tickValue: 5, multiplier: 20 },
            }),
        );
        assert.equal(tickValueOf(published), 5);

        // with none published it follows from the tick and the multiplier
        const derived = specForSymbol(
            symbol({ priceFormat: { precision: 2, minTick: 0.25 }, contract: { multiplier: 20 } }),
        );
        assert.equal(tickValueOf(derived), 5);
    });

    it('carries the rest of the contract through', () => {
        const spec = specForSymbol(symbol({ contract: { currency: 'EUR', multiplier: 20 } }));
        assert.equal(spec.currency, 'EUR');
        assert.equal(spec.multiplier, 20);
    });

    it('carries the size step through', () => {
        const spec = specForSymbol(
            symbol({ contract: { qtyStep: 0.001, minQty: 0.001 } }),
        );
        assert.equal(qtyDecimals(spec), 3);
        assert.equal(roundQty(0.0128, spec), 0.012);
    });

    it('falls back to a safe tick when there is no symbol yet', () => {
        assert.equal(tickSizeOf(specForSymbol(null)), 0.01);
    });

    it('reads a resting type correctly on a finely-quoted coin', () => {
        // with a tick of 1 both prices round to 0, compare equal, and every
        // linked drawing comes back as a market order
        const spec = specForSymbol(
            symbol({ priceFormat: { precision: 8, minTick: 0.00000001 } }),
        );
        const box = { entry: 0.00012345, upAmount: 0.00001, downAmount: 0.000005, qty: 100 };

        assert.equal(ticketFromPosition('long', box, 0.0002, spec).type, 'limit');
        assert.equal(ticketFromPosition('long', box, 0.0001, spec).type, 'stop');
        assert.equal(ticketFromPosition('long', box, 0.00012345, spec).type, 'market');
    });
});

describe('protective levels', () => {
    it('puts a long stop below and its target above', () => {
        assert.equal(levelPrice('sl', 21450, 40, 'long', NQ), 21440);
        assert.equal(levelPrice('tp', 21450, 40, 'long', NQ), 21460);
    });

    it('mirrors both for a short', () => {
        assert.equal(levelPrice('sl', 21450, 40, 'short', NQ), 21460);
        assert.equal(levelPrice('tp', 21450, 40, 'short', NQ), 21440);
    });

    it('round-trips a price back to the same positive distance', () => {
        for (const side of ['long', 'short'] as const) {
            for (const kind of ['tp', 'sl'] as const) {
                const price = levelPrice(kind, 21450, 40, side, NQ);
                assert.equal(levelTicks(kind, 21450, price, side, NQ), 40, `${side} ${kind}`);
            }
        }
    });

    it('reads a level on the wrong side as negative', () => {
        assert.equal(levelTicks('sl', 21450, 21460, 'long', NQ), -40);
    });
});

describe('sizing', () => {
    const ctx = { entry: 21450, stopTicks: 40, balance: 50_000, spec: NQ };

    it('sizes from risk, and never rounds the risk up', () => {
        // $600 / (40 ticks x $5) = 3 exactly
        assert.equal(qtyFromAmount('riskUsd', 600, ctx), 3);
        // $599 is 2.99 contracts; taking 3 would risk more than asked
        assert.equal(qtyFromAmount('riskUsd', 599, ctx), 2);
    });

    it('sizes from a percentage of the balance', () => {
        // 1.2% of 50,000 = $600 of risk = 3 contracts
        assert.equal(qtyFromAmount('riskPct', 1.2, ctx), 3);
    });

    it('sizes from notional value', () => {
        // one contract is 21450 x 20 = $429,000
        assert.equal(qtyFromAmount('value', 900_000, ctx), 2);
        assert.equal(qtyFromAmount('value', 400_000, ctx), 0);
    });

    it('refuses to size by risk with no stop to measure to', () => {
        assert.equal(qtyFromAmount('riskUsd', 600, { ...ctx, stopTicks: 0 }), 0);
    });

    it('carries a size across a mode switch', () => {
        for (const mode of ['contracts', 'value', 'balancePct', 'riskUsd', 'riskPct'] as const) {
            const amount = amountFromQty(mode, 3, ctx);
            assert.equal(qtyFromAmount(mode, amount, ctx), 3, mode);
        }
    });
});

describe('fractional sizes', () => {
    // spot BTC: priced to the cent, sized to a thousandth of a coin
    const BTC: ContractSpec = {
        tickSize: 0.01,
        tickValue: 0.01,
        multiplier: 1,
        qtyStep: 0.001,
        minQty: 0.001,
        currency: 'USD',
    };

    it('sizes in fractions where the venue allows them', () => {
        assert.equal(qtyFromAmount('contracts', 0.01, { entry: 60_000, stopTicks: 0, balance: 50_000, spec: BTC }), 0.01);
        assert.equal(roundQty(0.0128, BTC), 0.012);
        assert.equal(qtyDecimals(BTC), 3);
    });

    it('still rounds whole contracts for instruments that only trade whole ones', () => {
        assert.equal(roundQty(2.9, NQ), 2);
        assert.equal(qtyDecimals(NQ), 0);
    });

    it('does not lose a step to floating point', () => {
        assert.equal(roundQty(0.3, { qtyStep: 0.1 }), 0.3);
        assert.equal(roundQty(0.7, { qtyStep: 0.1 }), 0.7);
    });

    it('sizes a fractional position from a cash risk', () => {
        // a $2,000 stop is 200,000 ticks of $0.01, so one coin risks $2,000
        // and $300 of risk buys 0.15 of one
        const qty = qtyFromAmount('riskUsd', 300, {
            entry: 60_000,
            stopTicks: 200_000,
            balance: 50_000,
            spec: BTC,
        });
        assert.equal(qty, 0.15);
    });

    it('refuses an order under the venue minimum', () => {
        const ticket = deriveTicket({
            side: 'long',
            type: 'market',
            limitPrice: 0,
            stopPrice: 0,
            mark: 60_000,
            bid: 59_999.99,
            ask: 60_000,
            amountMode: 'contracts',
            amount: 0.0001,
            tpEnabled: false,
            tpTicks: 0,
            slEnabled: false,
            slTicks: 0,
            balance: 50_000,
            spec: BTC,
        });
        assert.equal(ticket.ok, false);
        assert.ok(ticket.problems.some((p) => /smallest order/i.test(p.message)));
    });
});

describe('copying a position drawing', () => {
    const box = { entry: 21400, upAmount: 100, downAmount: 50, qty: 3 };

    it('reads a long: target above, stop below', () => {
        const copied = ticketFromPosition('long', box, 21450, NQ);
        assert.equal(copied.entry, 21400);
        assert.equal(copied.target, 21500);
        assert.equal(copied.stop, 21350);
        assert.equal(copied.qty, 3);
    });

    it('mirrors a short', () => {
        const copied = ticketFromPosition('short', box, 21350, NQ);
        assert.equal(copied.target, 21350);
        assert.equal(copied.stop, 21500);
    });

    it('infers the resting type from where the entry sits', () => {
        // long, entry below the market -> a limit rests there
        assert.equal(ticketFromPosition('long', box, 21450, NQ).type, 'limit');
        // above it -> only a stop gets in
        assert.equal(ticketFromPosition('long', box, 21350, NQ).type, 'stop');
        // shorts mirror both
        assert.equal(ticketFromPosition('short', box, 21350, NQ).type, 'limit');
        assert.equal(ticketFromPosition('short', box, 21450, NQ).type, 'stop');
        // drawn at the market -> just go now
        assert.equal(ticketFromPosition('long', box, 21400, NQ).type, 'market');
    });

    it('produces a ticket that passes its own validation', () => {
        const copied = ticketFromPosition('long', box, 21450, NQ);
        const ticket = deriveTicket({
            side: copied.side,
            type: copied.type,
            limitPrice: copied.entry,
            stopPrice: copied.entry,
            mark: 21450,
            bid: 21449.75,
            ask: 21450,
            amountMode: 'contracts',
            amount: copied.qty,
            tpEnabled: true,
            tpTicks: levelTicks('tp', copied.entry, copied.target, 'long', NQ),
            slEnabled: true,
            slTicks: levelTicks('sl', copied.entry, copied.stop, 'long', NQ),
            balance: 50_000,
            spec: NQ,
        });
        assert.equal(ticket.ok, true);
        assert.equal(ticket.tpPrice, 21500);
        assert.equal(ticket.slPrice, 21350);
    });
});

describe('the ticket', () => {
    const base: TicketInput = {
        side: 'long',
        type: 'market',
        limitPrice: 0,
        stopPrice: 0,
        mark: 21450,
        bid: 21449.75,
        ask: 21450,
        amountMode: 'contracts',
        amount: 3,
        tpEnabled: true,
        tpTicks: 80,
        slEnabled: true,
        slTicks: 40,
        balance: 50_000,
        spec: NQ,
    };

    it('reports the figures the panel is there to show', () => {
        const ticket = deriveTicket(base);

        assert.equal(ticket.entry, 21450);
        assert.equal(ticket.qty, 3);
        assert.equal(ticket.slPrice, 21440);
        assert.equal(ticket.tpPrice, 21470);
        assert.deepEqual(ticket.risk, { usd: 600, pct: 1.2 });
        assert.deepEqual(ticket.reward, { usd: 1200, pct: 2.4 });
        assert.equal(ticket.rr, 2);
        assert.equal(ticket.contractValue, 21450 * 20 * 3);
        assert.deepEqual(ticket.spread, { ticks: 1, usd: 5 });
        assert.equal(ticket.ok, true);
    });

    it('agrees with itself when the size came from the risk', () => {
        // ask for $600 of risk, and the risk line has to read $600 back
        const ticket = deriveTicket({ ...base, amountMode: 'riskUsd', amount: 600 });
        assert.equal(ticket.qty, 3);
        assert.equal(ticket.risk?.usd, 600);
    });

    it('holds up on the short side', () => {
        const ticket = deriveTicket({ ...base, side: 'short' });
        assert.equal(ticket.slPrice, 21460);
        assert.equal(ticket.tpPrice, 21430);
        assert.equal(ticket.risk?.usd, 600);
    });

    it('refuses a buy limit placed through the market', () => {
        const ticket = deriveTicket({ ...base, type: 'limit', limitPrice: 21460 });
        assert.equal(ticket.ok, false);
        assert.deepEqual(
            ticket.problems.map((p) => p.field),
            ['entry'],
        );

        const resting = deriveTicket({ ...base, type: 'limit', limitPrice: 21440 });
        assert.equal(resting.ok, true);
        assert.equal(resting.entry, 21440);
    });

    it('refuses a buy stop placed below the market', () => {
        assert.equal(deriveTicket({ ...base, type: 'stop', stopPrice: 21440 }).ok, false);
        assert.equal(deriveTicket({ ...base, type: 'stop', stopPrice: 21460 }).ok, true);
    });

    it('explains a risk-sized ticket with no stop instead of sizing it to zero', () => {
        const ticket = deriveTicket({
            ...base,
            amountMode: 'riskUsd',
            amount: 600,
            slEnabled: false,
        });
        assert.equal(ticket.ok, false);
        assert.equal(ticket.qty, 0);
        assert.ok(ticket.problems.some((p) => p.field === 'amount' && /stop/i.test(p.message)));
    });

    it('says when the account cannot afford the smallest order', () => {
        const ticket = deriveTicket({ ...base, amountMode: 'value', amount: 1000 });
        assert.equal(ticket.qty, 0);
        assert.ok(ticket.problems.some((p) => /smallest order/i.test(p.message)));
    });

    it('leaves risk and reward null until there is something to measure', () => {
        const bare = deriveTicket({ ...base, tpEnabled: false, slEnabled: false });
        assert.equal(bare.risk, null);
        assert.equal(bare.reward, null);
        assert.equal(bare.rr, null);
        assert.equal(bare.ok, true);
    });
});
