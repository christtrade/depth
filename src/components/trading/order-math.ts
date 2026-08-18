import type { ContractSpec, SymbolInfo } from '../../interfaces/IDataAdapter';
import type { OrderSide, OrderType } from '../../lib/types/trading-types';

export const tickSizeOf = (spec: ContractSpec): number =>
    spec.tickSize && spec.tickSize > 0 ? spec.tickSize : 0.01;

export function tickValueOf(spec: ContractSpec): number {
    if (spec.tickValue && spec.tickValue > 0) return spec.tickValue;
    const derived = tickSizeOf(spec) * (spec.multiplier ?? 1);
    return derived > 0 ? derived : 1;
}

export function specForSymbol(
    info: SymbolInfo | null | undefined,
): ContractSpec {
    const contract = info?.contract;
    const tickSize = info?.priceFormat?.minTick ?? info?.tickSize ?? contract?.tickSize;

    return {
        ...contract,
        ...(tickSize && tickSize > 0 ? { tickSize } : {}),
        ...(contract?.tickValue && contract.tickValue > 0
            ? { tickValue: contract.tickValue }
            : tickSize && tickSize > 0
              ? { tickValue: tickSize * (contract?.multiplier ?? 1) }
              : {}),
    };
}

export const qtyStepOf = (spec: ContractSpec): number =>
    spec.qtyStep && spec.qtyStep > 0 ? spec.qtyStep : 1;

export const minQtyOf = (spec: ContractSpec): number =>
    spec.minQty && spec.minQty > 0 ? spec.minQty : qtyStepOf(spec);

function stepDecimals(step: number): number {
    if (!Number.isFinite(step) || step <= 0) return 0;
    for (let decimals = 0; decimals <= 10; decimals++) {
        const scaled = step * 10 ** decimals;
        if (Math.abs(scaled - Math.round(scaled)) < 1e-9) return decimals;
    }
    return 10;
}

export const qtyDecimals = (spec: ContractSpec): number => stepDecimals(qtyStepOf(spec));

// floors rather than rounds: rounding up would breach the risk that was set.
// the epsilon absorbs float error, so 0.3 / 0.1 doesn't floor to two steps.
export function roundQty(qty: number, spec: ContractSpec): number {
    if (!Number.isFinite(qty) || qty <= 0) return 0;
    const step = qtyStepOf(spec);
    return Number((Math.floor(qty / step + 1e-9) * step).toFixed(stepDecimals(step)));
}

// what the tick needs to be written exactly, not -log10(tick): that says one
// decimal for a quarter-point tick, which rounds 21449.75 off the grid.
export function priceDecimals(spec: ContractSpec): number {
    const tick = tickSizeOf(spec);
    if (!Number.isFinite(tick) || tick <= 0) return 2;
    for (let decimals = 0; decimals <= 10; decimals++) {
        const scaled = tick * 10 ** decimals;
        if (Math.abs(scaled - Math.round(scaled)) < 1e-9) return decimals;
    }
    return 10;
}

export function roundToTick(price: number, spec: ContractSpec): number {
    const tick = tickSizeOf(spec);
    if (!Number.isFinite(price)) return 0;
    // re-round after dividing, or float leaves 21449.999999999996
    return Number((Math.round(price / tick) * tick).toFixed(priceDecimals(spec)));
}

export const ticksBetween = (from: number, to: number, spec: ContractSpec): number =>
    Math.round((to - from) / tickSizeOf(spec));

export const moneyPerTick = (qty: number, spec: ContractSpec): number =>
    tickValueOf(spec) * Math.max(0, qty);

// notional exposure, not margin - nothing here models a margin requirement
export const contractValue = (price: number, qty: number, spec: ContractSpec): number =>
    Math.max(0, price) * (spec.multiplier ?? 1) * Math.max(0, qty);

// tp/sl ticks are quoted as a positive distance in the direction that level
// protects or profits, so a 40-tick stop reads "40" on both sides of the market
const away = (side: OrderSide, kind: 'tp' | 'sl'): number =>
    (side === 'long' ? 1 : -1) * (kind === 'tp' ? 1 : -1);

export function levelPrice(
    kind: 'tp' | 'sl',
    entry: number,
    ticks: number,
    side: OrderSide,
    spec: ContractSpec,
): number {
    return roundToTick(entry + away(side, kind) * Math.abs(ticks) * tickSizeOf(spec), spec);
}

// negative means the level is through the entry; deriveTicket turns that into
// an error rather than silently flipping it
export function levelTicks(
    kind: 'tp' | 'sl',
    entry: number,
    price: number,
    side: OrderSide,
    spec: ContractSpec,
): number {
    return away(side, kind) * ticksBetween(entry, price, spec);
}

export type AmountMode = 'contracts' | 'value' | 'balancePct' | 'riskUsd' | 'riskPct';

export const AMOUNT_MODES: { id: AmountMode; label: string; needsStop?: true }[] = [
    { id: 'contracts', label: 'Size' },
    { id: 'value', label: 'Position value' },
    { id: 'balancePct', label: '% of balance' },
    { id: 'riskUsd', label: 'Risk, cash', needsStop: true },
    { id: 'riskPct', label: 'Risk, % of balance', needsStop: true },
];

export const modeNeedsStop = (mode: AmountMode): boolean =>
    mode === 'riskUsd' || mode === 'riskPct';

export interface SizingContext {
    entry: number;
    /** Ticks from entry to the stop. 0 when no stop is set */
    stopTicks: number;
    balance: number;
    spec: ContractSpec;
}

// returns 0 when the inputs cant answer the question; deriveTicket explains why
export function qtyFromAmount(mode: AmountMode, amount: number, ctx: SizingContext): number {
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    const { entry, stopTicks, balance, spec } = ctx;

    const fromRisk = (risk: number) => {
        const perUnit = Math.abs(stopTicks) * tickValueOf(spec);
        return perUnit > 0 ? roundQty(risk / perUnit, spec) : 0;
    };
    const fromValue = (value: number) => {
        const perUnit = contractValue(entry, 1, spec);
        return perUnit > 0 ? roundQty(value / perUnit, spec) : 0;
    };

    switch (mode) {
        case 'contracts':
            return roundQty(amount, spec);
        case 'value':
            return fromValue(amount);
        case 'balancePct':
            return fromValue((balance * amount) / 100);
        case 'riskUsd':
            return fromRisk(amount);
        case 'riskPct':
            return fromRisk((balance * amount) / 100);
    }
}

// the inverse, so switching modes carries the size across instead of resetting it
export function amountFromQty(mode: AmountMode, qty: number, ctx: SizingContext): number {
    if (!Number.isFinite(qty) || qty <= 0) return 0;
    const { entry, stopTicks, balance, spec } = ctx;

    switch (mode) {
        case 'contracts':
            return qty;
        case 'value':
            return contractValue(entry, qty, spec);
        case 'balancePct':
            return balance > 0 ? (contractValue(entry, qty, spec) / balance) * 100 : 0;
        case 'riskUsd':
            return Math.abs(stopTicks) * moneyPerTick(qty, spec);
        case 'riskPct':
            return balance > 0
                ? ((Math.abs(stopTicks) * moneyPerTick(qty, spec)) / balance) * 100
                : 0;
    }
}

export interface TicketInput {
    side: OrderSide;
    type: OrderType;
    /** Ignored for market orders, which price off `mark` */
    limitPrice: number;
    stopPrice: number;
    mark: number;
    bid: number;
    ask: number;

    amountMode: AmountMode;
    amount: number;

    tpEnabled: boolean;
    tpTicks: number;
    slEnabled: boolean;
    slTicks: number;

    balance: number;
    spec: ContractSpec;
}

export interface TicketProblem {
    field: 'amount' | 'entry' | 'tp' | 'sl';
    message: string;
}

export interface Ticket {
    entry: number;
    qty: number;
    tickValue: number;
    contractValue: number;
    tpPrice: number | null;
    slPrice: number | null;
    risk: { usd: number; pct: number } | null;
    reward: { usd: number; pct: number } | null;
    /** Reward divided by risk. Null unless both sides are set */
    rr: number | null;
    spread: { ticks: number; usd: number };
    problems: TicketProblem[];
    ok: boolean;
}

// the geometry a long/short drawing carries, side-agnostically: the amounts are
// price distances to the box edges above and below entry
export interface PositionGeometry {
    entry: number;
    upAmount: number;
    downAmount: number;
    qty: number;
}

export interface CopiedTicket {
    side: OrderSide;
    type: OrderType;
    entry: number;
    target: number;
    stop: number;
    qty: number;
}

// the resting type is inferred from where the entry sits: a long below the
// market is a limit, above it a stop, and a short is the mirror
export function ticketFromPosition(
    side: OrderSide,
    box: PositionGeometry,
    mark: number,
    spec: ContractSpec,
): CopiedTicket {
    const entry = roundToTick(box.entry, spec);
    const long = side === 'long';

    return {
        side,
        type:
            mark <= 0 || entry === roundToTick(mark, spec)
                ? 'market'
                : long
                  ? entry < mark
                      ? 'limit'
                      : 'stop'
                  : entry > mark
                    ? 'limit'
                    : 'stop',
        entry,
        target: roundToTick(long ? entry + box.upAmount : entry - box.downAmount, spec),
        stop: roundToTick(long ? entry - box.downAmount : entry + box.upAmount, spec),
        qty: roundQty(box.qty, spec),
    };
}

export function deriveTicket(input: TicketInput): Ticket {
    const { spec, side, type, balance } = input;
    const problems: TicketProblem[] = [];

    const marketPrice = input.mark > 0 ? input.mark : (input.bid + input.ask) / 2;
    const entryRaw =
        type === 'market'
            ? marketPrice
            : type === 'stop'
              ? input.stopPrice
              : input.limitPrice;
    const entry = roundToTick(entryRaw, spec);

    if (type !== 'market' && !(entry > 0)) {
        problems.push({ field: 'entry', message: 'Set an entry price.' });
    } else if (type === 'limit' && marketPrice > 0) {
        if (side === 'long' && entry > marketPrice)
            problems.push({ field: 'entry', message: 'A buy limit sits at or below the market.' });
        if (side === 'short' && entry < marketPrice)
            problems.push({ field: 'entry', message: 'A sell limit sits at or above the market.' });
    } else if (type === 'stop' && marketPrice > 0) {
        if (side === 'long' && entry < marketPrice)
            problems.push({ field: 'entry', message: 'A buy stop sits at or above the market.' });
        if (side === 'short' && entry > marketPrice)
            problems.push({ field: 'entry', message: 'A sell stop sits at or below the market.' });
    }

    const slTicks = input.slEnabled ? Math.abs(input.slTicks) : 0;
    const tpTicks = input.tpEnabled ? Math.abs(input.tpTicks) : 0;

    if (input.slEnabled && slTicks === 0)
        problems.push({ field: 'sl', message: 'A stop needs a distance from entry.' });
    if (input.tpEnabled && tpTicks === 0)
        problems.push({ field: 'tp', message: 'A target needs a distance from entry.' });

    if (modeNeedsStop(input.amountMode) && slTicks === 0) {
        problems.push({
            field: 'amount',
            message: 'Sizing by risk needs a stop - that is what the risk is measured to.',
        });
    }

    const qty = qtyFromAmount(input.amountMode, input.amount, {
        entry,
        stopTicks: slTicks,
        balance,
        spec,
    });

    const minQty = minQtyOf(spec);
    if (qty <= 0) {
        problems.push({
            field: 'amount',
            message:
                input.amount > 0 && !modeNeedsStop(input.amountMode)
                    ? `Not enough for the smallest order, ${minQty}.`
                    : 'Set an amount.',
        });
    } else if (qty < minQty) {
        problems.push({
            field: 'amount',
            message: `The smallest order here is ${minQty}.`,
        });
    }

    const asMoney = (ticks: number) => {
        const usd = ticks * moneyPerTick(qty, spec);
        return { usd, pct: balance > 0 ? (usd / balance) * 100 : 0 };
    };

    const risk = slTicks > 0 && qty > 0 ? asMoney(slTicks) : null;
    const reward = tpTicks > 0 && qty > 0 ? asMoney(tpTicks) : null;
    const spreadTicks = Math.max(0, ticksBetween(input.bid, input.ask, spec));

    return {
        entry,
        qty,
        tickValue: tickValueOf(spec),
        contractValue: contractValue(entry, qty, spec),
        tpPrice: tpTicks > 0 ? levelPrice('tp', entry, tpTicks, side, spec) : null,
        slPrice: slTicks > 0 ? levelPrice('sl', entry, slTicks, side, spec) : null,
        risk,
        reward,
        rr: risk && reward && risk.usd > 0 ? reward.usd / risk.usd : null,
        spread: { ticks: spreadTicks, usd: spreadTicks * tickValueOf(spec) },
        problems,
        ok: problems.length === 0,
    };
}
