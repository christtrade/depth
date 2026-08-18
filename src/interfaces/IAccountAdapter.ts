// Implement this if you want to feed your own trading system's data into
// the built-in AccountManager. The adapter is a push model: your system
// calls the callbacks that AccountManager registers via `attach()`.

import type { Fill, Order, Position, PositionClose } from '../lib/types/trading-types';

export interface AccountSnapshot {
    balance: number;
    equity: number;
    realizedPnl: number;
    unrealizedPnl: number;
    openPositionCount: number;
    currency: string;
}

export interface IAccountAdapter {
    readonly id: string;

    /**
     * AccountManager calls this once on attach so the adapter can register
     * its push callbacks.
     */
    attach(callbacks: AccountAdapterCallbacks): void;

    /**
     * Called when AccountManager is destroyed or the adapter is swapped out.
     */
    detach(): void;

    destroy(): void;
}

export interface AccountAdapterCallbacks {
    onFill: (fill: Fill & { ts: bigint }) => void;
    onPositionUpdate: (position: Position & { ts: bigint }) => void;
    onPositionClose: (close: PositionClose & { ts: bigint }) => void;
    onBalanceUpdate: (balance: number, ts: bigint) => void;
    /** Optional - adapters that surface individual orders can push them here. */
    onOrderUpdate?: (order: Order & { ts: bigint }) => void;
}
