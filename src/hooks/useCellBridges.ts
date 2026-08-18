//  useCellBridges - the trading bridges behind a multi-chart layout.
//
//  A bridge is one instrument's trading world: an L3 matching engine, the
//  ledger-facing ExecutionEngine wrapper, and the useTradingState that turns
//  positions and orders into the TradeLines a pane draws.
//
//  Bridges are keyed by SYMBOL, not by cell. Two panes showing BTC share one
//  bridge, which is what makes the account behave like an account:
//
//    - Netting. One matching engine per instrument means a long opened in one
//      pane and a short opened in another are the same position, and offset.
//      Give each pane its own engine and you get hedging by accident: two
//      books, each convinced it holds the only BTC position.
//    - One truth on screen. Both panes read the same tradeLines, so a position
//      opened in one is drawn - and can be dragged, bracketed and closed - in
//      the other.
//
//  Slots are stable: a symbol keeps its bridge for as long as any cell still
//  shows it, so an unrelated pane switching instruments never tears down a
//  live engine and re-seeds its positions from the ledger.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTradingState } from './useTradingState';
import { createL3MatchingEngine, feeScheduleFor } from '../lib/matchingEngine';
import { DepthChart, DataLevel, ExecutionEngine } from '../core';
import { TypedEventBus } from '../core/TypedEventBus';
import type { SymbolInfo } from '../interfaces/IDataAdapter';

export const MAX = 8;

export function useTradingBridge(
    symbol: string,
    externalEngine?: ExecutionEngine,
    eventBus?: TypedEventBus,
    chart?: DepthChart,
) {
    const executionEngine = useRef(externalEngine ?? new ExecutionEngine()).current;
    const tradingEvents = useRef<any[]>([]);

    const eventBusRef = useRef(eventBus);
    useEffect(() => {
        eventBusRef.current = eventBus;
    }, [eventBus]);

    const [symbolInfo, setSymbolInfo] = useState<SymbolInfo | null>(null);
    useEffect(() => {
        setSymbolInfo(chart?.getSymbolInfo(symbol) ?? null);
        if (!eventBus) return;
        return eventBus.on('data:symbol-resolved', ({ symbolInfo: si }) => {
            if (si.symbol !== symbol) return;
            setSymbolInfo(si);
        });
    }, [eventBus, symbol]);

    const tickSize = symbolInfo?.priceFormat?.minTick ?? 0.01;
    const tickValue = symbolInfo?.contract?.multiplier ?? 1;

    const [dataLevel, setDataLevel] = useState<DataLevel>('ohlcv');
    useEffect(() => {
        if (!eventBus) return;
        return eventBus.on('data:load', ({ symbol: sym, dataLevel: dl }) => {
            if (sym === symbol) setDataLevel(dl);
        });
    }, [eventBus, symbol]);
    const effectiveMarkMode = dataLevel === 'l3' || dataLevel === 'l2' ? 'conservative' : 'last';

    const trading = useTradingState(
        useMemo(
            () => ({
                tickSize,
                tickValue,
                markMode: effectiveMarkMode,
                onAmendOrder: (orderId: string, newPrice: number) =>
                    executionEngine.amendOrder(orderId, newPrice),
                onUpdatePosition: (position: any) => executionEngine.syncPosition(position),
                onUpdateOrder: (order: any) => executionEngine.syncOrder(order),
                onAmendBracket: (amendment: any) => executionEngine.amendBracket(amendment),
                onCancelOrder: (orderId: string) => executionEngine.cancelOrder(orderId),
                onClosePosition: (positionId: string) => executionEngine.closePosition(positionId),
                onReversePosition: (positionId: string) =>
                    executionEngine.reversePosition(positionId),
                onEvent: (event: any) => {
                    tradingEvents.current.push(event);
                    eventBusRef.current?.emit('trading:event', event);
                },
            }),
            [tickSize, tickValue, effectiveMarkMode],
        ),
    );

    useEffect(() => {
        // An empty slot has no instrument and must not register a book. Under a
        // shared ExecutionEngine the '' key would be contended by every idle
        // slot, each one's cleanup destroying another's engine.
        if (!symbol) return;

        const engine = createL3MatchingEngine(trading, {
            symbolInfo,
            // Per instrument: a micro charged its mini's commission costs more
            // in fees than the exposure it buys.
            fees: feeScheduleFor(symbolInfo),
            nettingMode: 'net',
            marketSlippageTicks: 0,
            eventBus: eventBus,
        });
        executionEngine.attachBuiltIn(engine, symbol);

        // Hand the fresh engine everything the account ledger says is still open
        // on this symbol.
        //
        // This effect runs more than once per pane: an engine is built on mount
        // with a null symbolInfo, then thrown away and rebuilt the moment the
        // symbol resolves. Seeding anywhere else (it used to live in a
        // chart-keyed effect that only ran on mount) loads the restored
        // positions into the FIRST engine and then destroys it - leaving a live
        // position on screen that no engine is managing. Brackets never trigger,
        // closePosition is a no-op, and the chart quietly lies about being in a
        // trade. Restoring a saved session hit this every time.
        const snap = chart?.account?.getSnapshot();
        if (snap) {
            // Per symbol: one ledger backs every pane, and a pane must not adopt
            // another instrument's position.
            //
            // Only what is still LIVE. `snap.orders` is the full order history -
            // the ledger keeps filled and cancelled ones for the trade list - and
            // handing a filled order back to a fresh engine puts it on the book
            // again, where the next replay past its price fills it a second time.
            const positions = snap.openPositions
                .map((lp: any) => lp.position)
                .filter(
                    (p: any) =>
                        p.symbol === symbol &&
                        p.status !== 'closed' &&
                        // Only drop a quantity that is explicitly spent. Positions
                        // rebuilt from an older save can arrive without the field,
                        // and those are still open.
                        !(p.remainingQuantity <= 0),
                );
            const orders = snap.orders
                .map((lo: any) => lo.order)
                .filter(
                    (o: any) =>
                        o.symbol === symbol &&
                        o.status !== 'filled' &&
                        o.status !== 'cancelled' &&
                        o.status !== 'rejected',
                );

            for (const position of positions) engine.syncPosition(position);
            for (const order of orders) engine.syncOrder(order);

            trading.syncPositions(positions);
            trading.syncOrders(orders);
        }

        return () => {
            engine.destroy();
            executionEngine.detachBuiltIn(symbol);
        };
    }, [symbol, symbolInfo, chart]);

    const redrawFnRef = useRef<(() => void) | null>(null);
    useEffect(() => {
        trading.registerRedraw(redrawFnRef.current);
    }, [redrawFnRef.current]);

    return { symbol, trading, executionEngine, redrawFnRef, tradingEvents };
}

export type TradingBridge = ReturnType<typeof useTradingBridge>;

function useCellTrading(
    cellSymbol: string,
    eventBus: TypedEventBus,
    chart?: DepthChart,
    engine?: ExecutionEngine,
) {
    return useTradingBridge(cellSymbol, engine, eventBus, chart);
}

/**
 * Hand each distinct symbol one of the MAX bridge slots.
 *
 * Pure, and idempotent in `prev` - feeding it its own output changes nothing,
 * since the ordering is fixed by which slots are already taken and never by how
 * many times it has run. A symbol only loses its slot once no cell shows it,
 * because losing a slot means destroying that instrument's matching engine.
 *
 * A layout has at most MAX cells and a cell shows one symbol, so there are
 * never more distinct symbols than slots.
 */
function assignSymbolSlots(symbols: readonly string[], prev: readonly string[]): string[] {
    const next = Array.from({ length: MAX }, (_, k) => prev[k] ?? '');

    const wanted: string[] = [];
    for (const s of symbols.slice(0, MAX)) if (s && !wanted.includes(s)) wanted.push(s);

    // Release the slots nobody is showing any more...
    for (let k = 0; k < MAX; k++) if (next[k] && !wanted.includes(next[k])) next[k] = '';

    // ...then seat the newcomers in whatever came free.
    for (const s of wanted) {
        if (next.includes(s)) continue;
        const free = next.indexOf('');
        if (free === -1) break;
        next[free] = s;
    }

    return next;
}

export interface CellBridges {
    /**
     * Indexed by cell. Cells on the same symbol get the *same* bridge object -
     * that is the point, so don't dedupe by identity and don't assume
     * `byCell.length` distinct engines.
     */
    byCell: TradingBridge[];
    /**
     * One entry per distinct symbol on screen.
     *
     * Anything fanned out to engines - data ingest, playback seeks - must walk
     * this, not `byCell`: handing a bar stream to a shared engine once per cell
     * showing it replays the same bars through the fill logic N times.
     */
    bySymbol: TradingBridge[];
}

export function useCellBridges(
    symbols: string[],
    eventBus: TypedEventBus,
    chart?: DepthChart,
    /**
     * The one ExecutionEngine every bridge registers its book with - normally
     * `chart.executionEngine`, which is also what plugins call and what the
     * DataEngine settles jump gaps through. Leave it out and each bridge gets a
     * private wrapper, which is fine for a single chart but leaves those two
     * holding an engine with no books in it.
     */
    engine?: ExecutionEngine,
): CellBridges {
    // Derived from the symbols, but carrying its previous self so a symbol can
    // keep the slot it already has. Recomputed every render rather than memoised:
    // it is an eight-element scan, and being idempotent it survives React
    // re-running the render without ever reshuffling live engines.
    const slotsRef = useRef<string[]>(Array.from({ length: MAX }, () => ''));
    const slotSymbols = assignSymbolSlots(symbols, slotsRef.current);
    slotsRef.current = slotSymbols;

    const b0 = useCellTrading(slotSymbols[0], eventBus, chart, engine);
    const b1 = useCellTrading(slotSymbols[1], eventBus, chart, engine);
    const b2 = useCellTrading(slotSymbols[2], eventBus, chart, engine);
    const b3 = useCellTrading(slotSymbols[3], eventBus, chart, engine);
    const b4 = useCellTrading(slotSymbols[4], eventBus, chart, engine);
    const b5 = useCellTrading(slotSymbols[5], eventBus, chart, engine);
    const b6 = useCellTrading(slotSymbols[6], eventBus, chart, engine);
    const b7 = useCellTrading(slotSymbols[7], eventBus, chart, engine);
    const slots = [b0, b1, b2, b3, b4, b5, b6, b7];

    // Every cell index resolves to a bridge, including cells with no symbol yet
    // (they land on an idle slot, or on slot 0 in the degenerate case where all
    // eight are taken) - call sites index this without a null check.
    const byCell = Array.from({ length: MAX }, (_, i) => {
        const slot = slotSymbols.indexOf(symbols[i] ?? '');
        return slots[slot === -1 ? 0 : slot];
    });

    const bySymbol = slots.filter((b) => b.symbol);

    return { byCell, bySymbol };
}
