
import type { PlaceOrderRequest } from '../lib/matchingEngine';
import type {
    BracketAmendment,
    Fill,
    Order,
    Position,
    PositionClose,
    PriceTick,
} from '../lib/types/trading-types';
import type { MboEvent, OhlcvBar } from './IDataAdapter';
import type { SerialTrade } from '../lib/types';
import type { PriceHistory } from '../lib/types';

export interface IExecutionAdapter {
    readonly id: string; // 'backtest' | 'paper' | 'live-rithmic' | 'live-ib' | etc.

    /**
     * Called once per L3 event during playback or live streaming.
     * The adapter decides internally whether to process it.
     */
    onMboEvent(event: MboEvent, ts: bigint): void;

    /**
     * Called every time the best bid/ask changes.
     * The adapter uses this to check order triggers.
     */
    onTick(tick: PriceTick): void;

    placeOrder(request: PlaceOrderRequest): string | Promise<string>;
    cancelOrder(orderId: string): void | Promise<void>;
    amendOrder(orderId: string, newPrice: number): void | Promise<void>;
    amendBracket(amendment: BracketAmendment): void | Promise<void>;
    closePosition(positionId: string): void | Promise<void>;
    reversePosition?(positionId: string): void;

    getOpenPositions(): Position[];
    getWorkingOrders(): Order[];
    getClosedPositions(): PositionClose[];

    getPrice(): number;

    /** Data pipeline hooks - called by ExecutionEngine when new data arrives. */
    ingestCompactBuf?(buf: ArrayBuffer): void;
    /** `barNs` is the bar period; without it the adapter must infer it from bar spacing. */
    ingestOhlcvBars?(bars: OhlcvBar[], barNs?: bigint): void;
    /**
     * Bars streamed in ahead of the playhead, as an extension of what the
     * adapter already holds. Implement it if ingestOhlcvBars replaces state
     * rather than merging; without it, extensions fall back to ingestOhlcvBars.
     */
    appendOhlcvBars?(bars: OhlcvBar[], barNs?: bigint): void;
    ingestSupplementalBars?(
        bars: Array<{
            time: number;
            open: number;
            high: number;
            low: number;
            close: number;
            volume: number;
        }>,
    ): void;
    appendSupplementalBars?(
        bars: Array<{
            time: number;
            open: number;
            high: number;
            low: number;
            close: number;
            volume: number;
        }>,
    ): void;
    ingestTicks?(trades: SerialTrade[]): void;
    ingestPriceHistory?(history: PriceHistory[]): void;
    /** Streamed extensions; fall back to the ingest form when not implemented. */
    appendTicks?(trades: SerialTrade[]): void;
    appendPriceHistory?(history: PriceHistory[]): void;
    appendCompactBuf?(buf: ArrayBuffer): void;
    seekTo?(tNs: bigint): void;

    totalFeesPaid?(): number;
    totalRealizedPnl?(): number;

    /**
     * Subscribe to engine output events.
     * The ExecutionEngine calls this so adapters can push fills
     * back to the chart without knowing about the event bus.
     */
    onFill?: (fill: Fill) => void;
    onPositionUpdate?: (position: Position) => void;

    destroy(): void;
}
