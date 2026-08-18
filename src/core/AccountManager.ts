// time-aware account state tracker. three rules hold it together:
//
// balance is always derived, never stored. balance(t) = initial + deposits(t) +
// realized pnl of everything closed by t, so rewinding is automatic and theres
// no separate balance event to forget to update.
//
// one ledger entry per position/order, updated in place and keyed by id.
// open/update/close all mutate the same LedgerPosition.
//
// timestamps come from the playhead, so every event is stamped when it arrives
// and seekTo can filter out what hasnt happened yet.
//
// events reach here either from the trading bridge over the bus, or from a
// custom IAccountAdapter's callbacks.

import type { TypedEventBus } from './TypedEventBus';
import type { Fill, Order, Position } from '../lib/types/trading-types';
import type {
    IAccountAdapter,
    AccountAdapterCallbacks,
    AccountSnapshot,
} from '../interfaces/IAccountAdapter';
import type { ExecutionEngine } from './ExecutionEngine';
import type { FillSearchOptions } from '../lib/matchingEngine';

// Internal ledger types
export interface LedgerFill extends Fill {
    /** Playhead timestamp (ns bigint) used for ledger ordering. Separate from Fill.ts. */
    playheadTs: bigint;
}

export interface LedgerOrder {
    id: string;
    order: Order;
    /** Playhead timestamp when the order was first placed (ns). */
    placedAt: bigint;
    /** Playhead timestamp of the most recent status update (ns). */
    updatedAt: bigint;
}

export interface LedgerPosition {
    id: string;
    position: Position;
    /** Playhead timestamp when this position was first opened (ns). */
    openedAt: bigint;
    /** Playhead timestamp when this position was closed (ns). Undefined = still open. */
    closedAt?: bigint;
    /** Realized P&L booked at close, in cash. Only set when closedAt is. */
    realizedPnlAtClose?: number;
}

export interface LedgerAdjustment {
    /** Positive = deposit, negative = withdrawal. */
    amount: number;
    ts: bigint;
    note?: string;
}

/** One equity snapshot - recorded after every position close and balance adjustment. */
export interface EquityPoint {
    ts: bigint;
    balance: number;
    equity: number;
    realizedPnl: number;
}

/** Performance stats derived from the visible closed-position set. */
export interface AccountStats {
    /** Positions closed with realizedPnlAtClose > 0. */
    winCount: number;
    /** Positions closed with realizedPnlAtClose <= 0. */
    lossCount: number;
    /** winCount / (winCount + lossCount). NaN when no closed positions. */
    winRate: number;
    /** Sum of winning P&L / |sum of losing P&L|. Infinity when no losers. */
    profitFactor: number;
    /** Mean realized risk-reward ratio across closed positions. */
    avgRR: number;
    /** Largest single-position winning P&L. */
    largestWin: number;
    /** Largest single-position losing P&L (negative number). */
    largestLoss: number;
    /** Average hold duration in nanoseconds for closed positions. */
    avgHoldTimeNs: bigint;
    /** Total exchange + clearing fees across all fills. */
    totalFees: number;
    /** Total broker commissions across all fills. */
    totalCommission: number;
    /** Number of orders currently in a terminal state (filled). */
    filledOrderCount: number;
    /** Number of orders cancelled or rejected. */
    cancelledOrderCount: number;
}

export interface AccountOptions {
    eventBus: TypedEventBus;
    /** Execution engine, so the account can expose fill-search controls. */
    executionEngine?: ExecutionEngine;
    /** Starting cash balance. Default: 100_000 */
    initialBalance?: number;
    /**
     * Settlement currency the balance is denominated in. Display only - contract
     * details live on SymbolInfo, and nothing here converts between currencies.
     * Default: 'USD'
     */
    currency?: string;
    /** Custom adapter (e.g. live broker). If omitted, uses eventBus trading events. */
    adapter?: IAccountAdapter;
    adjustments?: LedgerAdjustment[];
    fills?: LedgerFill[];
    positions?: LedgerPosition[];
    orders?: LedgerOrder[];
}

export class AccountManager {
    private readonly eventBus: TypedEventBus;
    readonly currency: string;
    private initialBalance: number;

    // fills and adjustments are sorted arrays, positions and orders are maps
    // keyed by id so upsert is O(1)

    private fills: LedgerFill[] = [];
    private orders = new Map<string, LedgerOrder>();
    /** Keyed by position id for O(1) upsert. */
    private positionMap = new Map<string, LedgerPosition>();
    /** Manual deposits / withdrawals - sorted by ts. */
    private adjustments: LedgerAdjustment[] = [];

    // current playhead in ns. null = no restriction, show everything
    private horizonNs: bigint | null = null;

    private adapter: IAccountAdapter | null = null;
    private executionEngine: ExecutionEngine | null = null;
    private unsubs: (() => void)[] = [];
    private destroyed = false;

    constructor(options: AccountOptions) {
        this.eventBus = options.eventBus;
        this.executionEngine = options.executionEngine ?? null;
        this.initialBalance = options.initialBalance ?? 100_000;
        this.currency = options.currency ?? 'USD';

        this._subscribeEventBus();

        if (options.adapter) {
            this.setAdapter(options.adapter);
        }
    }

    // how skipped spans from far jumps get settled for fills

    setFillSearch(patch: Partial<FillSearchOptions>): void {
        this.executionEngine?.setFillSearch(patch);
    }

    getFillSearch(): FillSearchOptions | null {
        return this.executionEngine?.getFillSearch() ?? null;
    }

    // Adapter
    setAdapter(adapter: IAccountAdapter | null): void {
        this.adapter?.detach();
        this.adapter = adapter;
        if (!adapter) return;

        const callbacks: AccountAdapterCallbacks = {
            onFill: (fill) => {
                this._ingestFill({ ...fill, playheadTs: this.horizonNs ?? BigInt(fill.ts) });
            },
            onOrderUpdate: (order) => {
                this._ingestOrder(order, this.horizonNs ?? BigInt(order.updatedAt));
            },
            onPositionUpdate: (pos) => {
                this._ingestPositionUpdate(pos, pos.ts);
            },
            onPositionClose: (close) => {
                this._ingestPositionClose(
                    (close as any).positionId ?? '',
                    (close as any).realizedPnl ?? 0,
                    close.ts,
                );
            },
            onBalanceUpdate: (amount, ts) => {
                // treat a broker balance push as an adjustment off the current one
                const current = this._deriveBalance(ts);
                this._ingestAdjustment(amount - current, ts);
            },
        };

        adapter.attach(callbacks);
    }

    // note rides along on the ledger entry, so a scripted adjustment stays
    // distinguishable from a user topping the account up
    deposit(amount: number, ts?: bigint, note?: string): void {
        this._ingestAdjustment(amount, ts ?? this.horizonNs ?? 0n, note);
        this._emit();
    }

    withdraw(amount: number, ts?: bigint, note?: string): void {
        this._ingestAdjustment(-amount, ts ?? this.horizonNs ?? 0n, note);
        this._emit();
    }

    reset(): void {
        this.fills = [];
        this.orders.clear();
        this.positionMap.clear();
        this.adjustments = [];
        this.horizonNs = null;
        this._emit();
        this.eventBus.emit('account:reset', undefined);
    }

    /** Move the account view to time t. Everything derived recomputes. */
    seekTo(tNs: bigint): void {
        this.horizonNs = tNs;
        this._emit();
    }

    // Read API
    getSnapshot(): AccountSnapshot & {
        fills: LedgerFill[];
        orders: LedgerOrder[];
        openPositions: LedgerPosition[];
        closedPositions: LedgerPosition[];
        stats: AccountStats;
        equityCurve: EquityPoint[];
    } {
        const t = this.horizonNs;

        // filter the ledger down to the visible window
        const visibleFills = t === null ? this.fills : this.fills.filter((f) => f.playheadTs <= t);

        const allFills = [...this.fills.values()];

        // all orders, since order history is always fully visible
        const allOrders = [...this.orders.values()];
        // time-gated subset, only used for the stats
        const visibleOrdersForStats =
            t === null ? allOrders : allOrders.filter((o) => o.placedAt <= t);

        const allPositions = [...this.positionMap.values()];

        const openPositions = allPositions.filter((p) => p.position.status !== 'closed');

        const closedPositions = allPositions.filter((p) => p.position.status === 'closed');

        // derive pnl and balance
        const { balance, equity, realizedPnl, unrealizedPnl } = this._deriveTotals();

        // one point per position close, sorted by closedAt
        const equityCurve = this._buildEquityCurve(closedPositions, t);

        // Performance stats
        const stats = this._buildStats(closedPositions, visibleFills, visibleOrdersForStats);

        return {
            balance,
            equity,
            realizedPnl,
            unrealizedPnl,
            openPositionCount: openPositions.length,
            currency: this.currency,
            fills: allFills,
            orders: allOrders,
            openPositions,
            closedPositions,
            stats,
            equityCurve,
        };
    }

    // Ingestion
    private _ingestFill(fill: LedgerFill): void {
        this.fills.splice(this._insertIdxByPlayheadTs(this.fills, fill.playheadTs), 0, fill);
        this._emit();
    }

    private _ingestOrder(order: Order, ts: bigint): void {
        const existing = this.orders.get(order.id);
        this.orders.set(order.id, {
            id: order.id,
            order,
            placedAt: existing?.placedAt ?? ts,
            updatedAt: ts,
        });
        this._emit();
    }

    // updates in place if it already exists, preserving openedAt
    private _ingestPositionUpdate(position: Position, ts: bigint): void {
        const existing = this.positionMap.get(position.id);
        if (existing) {
            existing.position = position;
        } else {
            this.positionMap.set(position.id, {
                id: position.id,
                position,
                openedAt: ts,
            });
        }
        this._emit();
    }

    private _ingestPositionClose(positionId: string, realizedPnl: number, ts: bigint): void {
        const entry = this.positionMap.get(positionId);
        if (!entry) {
            console.warn(
                `[AccountManager] position:closed for unknown id "${positionId}" - creating stub`,
            );
            this.positionMap.set(positionId, {
                id: positionId,
                position: { id: positionId } as Position,
                openedAt: ts,
                closedAt: ts,
                realizedPnlAtClose: realizedPnl,
            });
        } else {
            entry.closedAt = ts;
            entry.realizedPnlAtClose = realizedPnl;
        }
        this._emit();
    }

    private _ingestAdjustment(amount: number, ts: bigint, note?: string): void {
        this.adjustments.splice(
            this._insertIdxByTs(this.adjustments, ts),
            0,
            note ? { amount, ts, note } : { amount, ts },
        );
    }

    // the headline numbers in one pass, allocating nothing. shared with _emit on
    // purpose: these six are the whole account:update payload, which fires on
    // every ingest - every replayed tick during playback. deriving them here
    // instead of off a full snapshot keeps the hot path off the equity curve,
    // the stats and the ledger copies, and stops the published figures drifting
    // away from the snapshot's.
    private _deriveTotals(): {
        balance: number;
        equity: number;
        realizedPnl: number;
        unrealizedPnl: number;
        openPositionCount: number;
    } {
        let realizedPnl = 0;
        let unrealizedPnl = 0;
        let openPositionCount = 0;

        for (const entry of this.positionMap.values()) {
            realizedPnl += entry.position.realizedPnl ?? 0;
            unrealizedPnl += entry.position.unrealizedPnl ?? 0;
            if (entry.position.status !== 'closed') openPositionCount++;
        }

        const balance = this._deriveBalance(this.horizonNs) + realizedPnl;
        return {
            balance,
            equity: balance + unrealizedPnl,
            realizedPnl,
            unrealizedPnl,
            openPositionCount,
        };
    }

    private _deriveBalance(t: bigint | null): number {
        let balance = this.initialBalance;
        for (const adj of this.adjustments) {
            if (t !== null && adj.ts > t) break;
            balance += adj.amount;
        }
        return balance;
    }

    // Equity curve
    private _buildEquityCurve(closedPositions: LedgerPosition[], t: bigint | null): EquityPoint[] {
        const sorted = [...closedPositions]
            .filter((p) => p.closedAt !== undefined)
            .sort((a, b) => (a.closedAt! < b.closedAt! ? -1 : a.closedAt! > b.closedAt! ? 1 : 0));

        const curve: EquityPoint[] = [];
        let runningRealizedPnl = 0;

        for (const pos of sorted) {
            runningRealizedPnl += pos.realizedPnlAtClose ?? 0;
            const bal = this._deriveBalance(pos.closedAt!) + runningRealizedPnl;
            curve.push({
                ts: pos.closedAt!,
                balance: bal,
                equity: bal, // unrealized is 0 for this position at close
                realizedPnl: runningRealizedPnl,
            });
        }

        return curve;
    }

    // Performance stats
    private _buildStats(
        closedPositions: LedgerPosition[],
        visibleFills: LedgerFill[],
        visibleOrders: LedgerOrder[],
    ): AccountStats {
        let winCount = 0;
        let lossCount = 0;
        let grossWin = 0;
        let grossLoss = 0;
        let rrSum = 0;
        let rrCount = 0;
        let largestWin = 0;
        let largestLoss = 0;
        let holdTimeNsSum = 0n;
        let holdTimeCount = 0n;

        for (const entry of closedPositions) {
            const pnl = entry.realizedPnlAtClose ?? 0;
            if (pnl > 0) {
                winCount++;
                grossWin += pnl;
                if (pnl > largestWin) largestWin = pnl;
            } else {
                lossCount++;
                grossLoss += Math.abs(pnl);
                if (pnl < largestLoss) largestLoss = pnl;
            }

            const rr = entry.position?.realizedRR;
            if (rr != null && isFinite(rr) && rr !== 0) {
                rrSum += rr;
                rrCount++;
            }

            if (entry.closedAt !== undefined) {
                const hold = entry.closedAt - entry.openedAt;
                if (hold >= 0n) {
                    holdTimeNsSum += hold;
                    holdTimeCount++;
                }
            }
        }

        const total = winCount + lossCount;

        let totalFees = 0;
        let totalCommission = 0;
        for (const f of visibleFills) {
            totalFees += f.fee ?? 0;
            // Fill has no commission field, its rolled into fee. tracked
            // separately on position.commissionTotal where thats available.
        }

        // from closed positions, since Fill doesnt separate it out
        for (const entry of closedPositions) {
            totalCommission += entry.position?.commissionTotal ?? 0;
        }

        const filledOrderCount = visibleOrders.filter((o) => o.order.status === 'filled').length;
        const cancelledOrderCount = visibleOrders.filter(
            (o) => o.order.status === 'cancelled' || o.order.status === 'rejected',
        ).length;

        return {
            winCount,
            lossCount,
            winRate: total > 0 ? winCount / total : NaN,
            profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : NaN,
            avgRR: rrCount > 0 ? rrSum / rrCount : NaN,
            largestWin,
            largestLoss,
            avgHoldTimeNs: holdTimeCount > 0n ? holdTimeNsSum / holdTimeCount : 0n,
            totalFees,
            totalCommission,
            filledOrderCount,
            cancelledOrderCount,
        };
    }

    // Emit
    private _emit(): void {
        if (this.destroyed) return;
        this.eventBus.emit('account:update', {
            ...this._deriveTotals(),
            currency: this.currency,
        });
    }

    // EventBus subscriptions
    private _subscribeEventBus(): void {
        this.unsubs.push(
            // Playback rewind
            this.eventBus.on('playback:seek', ({ tNs }) => {
                this.seekTo(tNs);
            }),

            // Trading lifecycle
            this.eventBus.on('trading:event', (event) => {
                const ts = this.horizonNs ?? 0n;

                switch (event.kind) {
                    case 'order:placed':
                    case 'order:updated':
                    case 'order:cancelled':
                    case 'order:rejected':
                        this._ingestOrder(event.order, ts);
                        break;

                    case 'order:filled':
                        this._ingestOrder(event.order, ts);
                        // the fill is also recorded via fill:received
                        break;

                    case 'fill:received':
                        this._ingestFill({ ...event.fill, playheadTs: ts });
                        break;

                    case 'position:opened':
                        this._ingestPositionUpdate(event.position, ts);
                        break;

                    case 'position:updated':
                        this._ingestPositionUpdate(event.position, ts);
                        break;

                    case 'position:closed':
                        this._ingestPositionUpdate(event.position, ts);
                        this._ingestPositionClose(
                            event.position.id,
                            event.realizedPnl ?? event.position.realizedPnl ?? 0,
                            ts,
                        );
                        break;

                    default:
                        break;
                }
            }),

            // Manual balance adjustments
            this.eventBus.on('account:deposit', ({ amount, ts, note }) => {
                this._ingestAdjustment(amount, ts, note);
                this._emit();
            }),

            this.eventBus.on('account:withdraw', ({ amount, ts, note }) => {
                this._ingestAdjustment(-amount, ts, note);
                this._emit();
            }),
        );
    }

    // Sorted insert helpers
    private _insertIdxByPlayheadTs(arr: { playheadTs: bigint }[], ts: bigint): number {
        let lo = 0,
            hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            arr[mid].playheadTs <= ts ? (lo = mid + 1) : (hi = mid);
        }
        return lo;
    }

    private _insertIdxByTs(arr: { ts: bigint }[], ts: bigint): number {
        let lo = 0,
            hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            arr[mid].ts <= ts ? (lo = mid + 1) : (hi = mid);
        }
        return lo;
    }

    // Serialize / restore
    serialize(): AccountSaveState {
        return {
            initialBalance: this.initialBalance,
            fills: this.fills,
            orders: [...this.orders.values()],
            positions: [...this.positionMap.values()],
            adjustments: this.adjustments,
        };
    }

    restore(state: AccountSaveState): void {
        this.fills = state.fills ?? [];
        this.orders.clear();
        for (const entry of state.orders ?? []) {
            this.orders.set(entry.id, entry);
        }
        this.positionMap.clear();
        for (const entry of state.positions ?? []) {
            this.positionMap.set(entry.id, entry);
        }
        this.adjustments = state.adjustments ?? [];
        this.initialBalance = state.initialBalance;
        this._emit();
    }

    // Lifecycle
    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.unsubs.forEach((fn) => fn());
        this.adapter?.detach();
    }
}

export interface AccountSaveState {
    initialBalance: number;
    fills: LedgerFill[];
    orders: LedgerOrder[];
    positions: LedgerPosition[];
    adjustments: LedgerAdjustment[];
}
