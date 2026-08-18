import { IExecutionAdapter } from '../interfaces/IExecutionAdapter';
import type {
    PlaceOrderRequest,
    FillSearchOptions,
    FillAmbiguity,
} from '../lib/matchingEngine';
import { L3MatchingEngine, DEFAULT_FILL_SEARCH } from '../lib/matchingEngine';
import type { TypedEventBus } from './TypedEventBus';
import type { BracketAmendment, Order, Position } from '../lib/types/trading-types';
import type { MboEvent, PriceHistory } from '../lib/types';
import type { OhlcvBar } from '../interfaces/IDataAdapter';
import type { SerialTrade } from '../lib/types';

// wraps either the built-in L3MatchingEngines or a custom IExecutionAdapter.
//
// theres one built-in engine per instrument, so every call has to reach the
// right book. three rules, by what the caller knows:
//
// - knows the symbol (bar ingest, gap settlement, placing orders, syncing
//   positions): routed by it. ingest is the one that bites if you get it wrong,
//   since feeding BTC bars to the ETH book fills ETH orders at BTC prices.
//   callers that omit it fall back to the active symbol.
// - knows only an id (cancel, amend, close, reverse): handed to every book.
//   exactly one owns the id and the rest miss-check and return, so theyre
//   no-ops. way harder to get wrong than making every caller carry a symbol.
// - knows nothing (seekTo, account totals): applies to all of them. the playhead
//   moves for every instrument at once and fees paid is an account-level number.
//
// a custom adapter always wins - its the whole broker and does its own routing.

/**
 * Vetoes an order before it reaches a book. Return a reason to refuse it, or
 * null to let it through. Pre-trade risk lives here rather than in the caller,
 * since every order route lands on placeOrder and there are several.
 */
export type OrderGuard = (req: PlaceOrderRequest) => string | null;

export class ExecutionEngine {
    private builtIns = new Map<string, L3MatchingEngine>();
    private activeSymbol = '';
    private custom: IExecutionAdapter | null = null;
    private destroyed = false;
    private guard: OrderGuard | null = null;
    private eventBus: TypedEventBus | null = null;
    // source of truth for the fill-search config, so engines attached later (on a
    // symbol switch) inherit the latest settings
    private fillSearch: FillSearchOptions = DEFAULT_FILL_SEARCH;

    // called by useTradingBridge when it creates an engine for a symbol
    attachBuiltIn(engine: L3MatchingEngine, symbol: string): void {
        engine.setFillSearch(this.fillSearch);
        this.builtIns.set(symbol, engine);
        // activate if theres no active symbol yet, or this is already it
        if (!this.activeSymbol || this.activeSymbol === symbol) {
            this.activeSymbol = symbol;
        }
    }

    // Fill search (jump gap settlement)
    setFillSearch(patch: Partial<FillSearchOptions>): void {
        this.fillSearch = { ...this.fillSearch, ...patch };
        for (const engine of this.builtIns.values()) engine.setFillSearch(this.fillSearch);
    }

    getFillSearch(): FillSearchOptions {
        return this.fillSearch;
    }

    // cheap gate: has this symbol's engine got anything that could fill? the
    // symbol matters, since this gates the gap-settlement fetch - ask the wrong
    // book and you either skip a fetch a resting stop needed or pay for one
    // nothing was waiting on
    hasPendingTriggers(symbol?: string): boolean {
        if (this.custom) return false;
        return this.builtInFor(symbol)?.hasPendingTriggers() ?? false;
    }

    // settle fills over a skipped span's bars on this symbol's engine
    settleGapBars(
        bars: Array<{ tsNs: bigint; open: number; high: number; low: number; close: number }>,
        ambiguity?: FillAmbiguity,
        symbol?: string,
    ): void {
        if (this.custom) return;
        this.builtInFor(symbol)?.settleGapBars(bars, ambiguity);
    }

    detachBuiltIn(symbol: string): void {
        this.builtIns.get(symbol)?.destroy?.();
        this.builtIns.delete(symbol);
        if (this.activeSymbol === symbol) {
            // fall back to whatever remains, or nothing
            this.activeSymbol = this.builtIns.keys().next().value ?? '';
        }
    }

    /**
     * Switch the active symbol - the default target for calls that don't name
     * one. In a layout this follows the focused pane, so a plugin calling
     * `placeOrder` with no symbol lands on the chart the user is looking at.
     */
    setActiveSymbol(symbol: string): void {
        this.activeSymbol = symbol;
    }

    /** The instrument symbol-less calls currently resolve to. */
    getActiveSymbol(): string {
        return this.activeSymbol;
    }

    /**
     * Last traded price for a symbol. NaN when the book has no price yet - no
     * such instrument, or its data hasn't landed. Callers that act on the number
     * must check `Number.isFinite` first.
     */
    getCurrentPrice(symbol: string): number {
        return this.builtInFor(symbol)?.getPrice() ?? NaN;
    }

    /** Whether a book can price an order right now. */
    hasPrice(symbol?: string): boolean {
        if (this.custom) return true; // a custom adapter owns its own readiness
        return Number.isFinite(this.builtInFor(symbol)?.getPrice() ?? NaN);
    }

    // called by DepthChart when the consumer passes an executionAdapter
    setCustomAdapter(adapter: IExecutionAdapter | null): void {
        this.custom = adapter;
    }

    // Routing helpers
    // the built-in engine for a symbol, falling back to the active one
    private builtInFor(symbol?: string): L3MatchingEngine | null {
        return this.builtIns.get(symbol ?? this.activeSymbol) ?? null;
    }

    // symbol-routed target, for data the caller knows the instrument for
    private targetFor(symbol?: string): L3MatchingEngine | IExecutionAdapter | null {
        return this.custom ?? this.builtInFor(symbol);
    }

    // every book, for calls keyed by an id rather than an instrument
    private eachBuiltIn(fn: (engine: L3MatchingEngine) => void): void {
        for (const engine of this.builtIns.values()) fn(engine);
    }

    // Data pipeline hooks
    ingestCompactBuf(buf: ArrayBuffer, symbol?: string): void {
        this.targetFor(symbol)?.ingestCompactBuf(buf);
    }

    ingestOhlcvBars(bars: OhlcvBar[], barNs?: bigint, symbol?: string): void {
        this.targetFor(symbol)?.ingestOhlcvBars?.(bars, barNs);
    }

    // extend an instrument's bars forward as the feed streams them. different
    // from ingestOhlcvBars, which resets replay to the start of the dataset -
    // streaming through that path makes the engine re-walk its whole history on
    // every extension, and skipping the call entirely leaves it blind past the
    // initially loaded window, so nothing fills and the mark freezes at the edge
    appendOhlcvBars(bars: OhlcvBar[], barNs?: bigint, symbol?: string): void {
        const target = this.targetFor(symbol);
        if (!target) return;
        if (target.appendOhlcvBars) target.appendOhlcvBars(bars, barNs);
        else target.ingestOhlcvBars?.(bars, barNs);
    }

    ingestSupplementalBars(
        bars: Array<{
            time: number;
            open: number;
            high: number;
            low: number;
            close: number;
            volume: number;
        }>,
        symbol?: string,
    ): void {
        this.targetFor(symbol)?.ingestSupplementalBars?.(bars);
    }

    appendSupplementalBars(
        bars: Array<{
            time: number;
            open: number;
            high: number;
            low: number;
            close: number;
            volume: number;
        }>,
        symbol?: string,
    ): void {
        const target = this.targetFor(symbol);
        if (!target) return;
        if (target.appendSupplementalBars) target.appendSupplementalBars(bars);
        else target.ingestSupplementalBars?.(bars);
    }

    ingestTicks(trades: SerialTrade[], symbol?: string): void {
        this.targetFor(symbol)?.ingestTicks?.(trades);
    }

    ingestPriceHistory(history: PriceHistory[], symbol?: string): void {
        this.targetFor(symbol)?.ingestPriceHistory?.(history);
    }

    appendTicks(trades: SerialTrade[], symbol?: string): void {
        const target = this.targetFor(symbol);
        if (!target) return;
        if (target.appendTicks) target.appendTicks(trades);
        else target.ingestTicks?.(trades);
    }

    appendPriceHistory(history: PriceHistory[], symbol?: string): void {
        const target = this.targetFor(symbol);
        if (!target) return;
        if (target.appendPriceHistory) target.appendPriceHistory(history);
        else target.ingestPriceHistory?.(history);
    }

    appendCompactBuf(buf: ArrayBuffer, symbol?: string): void {
        const target = this.targetFor(symbol);
        if (!target) return;
        if (target.appendCompactBuf) target.appendCompactBuf(buf);
        else target.ingestCompactBuf?.(buf);
    }

    // every instrument's book advances - a stop on a symbol whose pane isnt
    // focused still has to trigger at the right moment
    seekTo(tNs: bigint, symbol?: string): void {
        if (this.custom) {
            this.custom.seekTo(tNs);
            return;
        }
        if (symbol !== undefined) {
            this.builtIns.get(symbol)?.seekTo(tNs);
            return;
        }
        this.eachBuiltIn((engine) => engine.seekTo(tNs));
    }

    onMboEvent(event: MboEvent, tsNs: bigint, symbol?: string): void {
        this.targetFor(symbol)?.onMboEvent(event, tsNs);
    }

    // Order management
    /** Refused orders emit `trading:order-blocked` and never reach a book. */
    setOrderGuard(guard: OrderGuard | null): void {
        this.guard = guard;
    }

    // set once by the chart so a refusal can be announced
    setEventBus(eventBus: TypedEventBus | null): void {
        this.eventBus = eventBus;
    }

    placeOrder(req: PlaceOrderRequest): string | Promise<string> | undefined {
        const refusal = this.guard?.(req) ?? null;
        if (refusal !== null) {
            this.eventBus?.emit('trading:order-blocked', { req, reason: refusal });
            return undefined;
        }
        // refused, not rejected - a book with no price hasnt decided anything
        // about the order, it just cant see the market yet. same channel as a
        // guard refusal so hosts have one place to show it.
        if (!this.hasPrice(req.symbol)) {
            this.eventBus?.emit('trading:order-blocked', {
                req,
                reason: 'No market data yet for this symbol',
            });
            return undefined;
        }
        return this.targetFor(req.symbol)?.placeOrder(req);
    }

    cancelOrder(orderId: string): void {
        if (this.custom) return void this.custom.cancelOrder(orderId);
        this.eachBuiltIn((engine) => engine.cancelOrder(orderId));
    }

    amendOrder(orderId: string, newPrice: number): void {
        if (this.custom) return void this.custom.amendOrder(orderId, newPrice);
        this.eachBuiltIn((engine) => engine.amendOrder(orderId, newPrice));
    }

    amendBracket(amendment: BracketAmendment): void {
        if (this.custom) return void this.custom.amendBracket(amendment);
        this.eachBuiltIn((engine) => engine.amendBracket(amendment));
    }

    closePosition(positionId: string): void {
        if (this.custom) return void this.custom.closePosition(positionId);
        this.eachBuiltIn((engine) => engine.closePosition(positionId));
    }

    reversePosition(positionId: string): void {
        if (this.custom) return void this.custom.reversePosition?.(positionId);
        this.eachBuiltIn((engine) => engine.reversePosition(positionId));
    }

    // routed by position.symbol, never broadcast: unlike the id-keyed calls
    // above this creates what it cant find, so broadcasting would plant a copy
    // of the same position in every book on the layout
    syncPosition(position: Position): void {
        this.builtInFor(position.symbol)?.syncPosition(position);
    }

    syncOrder(order: Order): void {
        this.builtInFor(order.symbol)?.syncOrder(order);
    }

    // Metrics. account-level, summed over every instrument, since the question
    // is "what have I paid in fees" and not "on this chart"

    totalFeesPaid(): number {
        if (this.custom) return this.custom.totalFeesPaid?.() ?? 0;
        let total = 0;
        this.eachBuiltIn((engine) => (total += engine.totalFeesPaid?.() ?? 0));
        return total;
    }

    totalRealizedPnl(): number {
        if (this.custom) return this.custom.totalRealizedPnl?.() ?? 0;
        let total = 0;
        this.eachBuiltIn((engine) => (total += engine.totalRealizedPnl?.() ?? 0));
        return total;
    }

    // Lifecycle
    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        // built-ins get destroyed per symbol by useTradingBridge's cleanup
        this.custom?.destroy();
    }
}
