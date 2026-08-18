import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AccountManager } from './AccountManager';
import { TypedEventBus } from './TypedEventBus';

const NS = 1_000_000_000n;

const position = (id: string, closed: boolean, pnl: number) =>
    ({
        id,
        symbol: 'MNQ',
        side: 'long',
        status: closed ? 'closed' : 'open',
        quantity: 1,
        remainingQuantity: closed ? 0 : 1,
        avgEntryPrice: 100,
        realizedPnl: closed ? pnl : 0,
        unrealizedPnl: closed ? 0 : pnl,
    }) as any;

// an account with some history behind it and one position still running
function seeded(closedCount: number) {
    const bus = new TypedEventBus();
    const account = new AccountManager({ eventBus: bus, initialBalance: 50_000 } as any);

    const updates: any[] = [];
    bus.on('account:update', (payload) => updates.push(payload));

    for (let i = 0; i < closedCount; i++) {
        const pnl = i % 3 === 0 ? -40 : 55;
        bus.emit('trading:event', {
            kind: 'position:opened',
            position: position(`p${i}`, false, 0),
        } as any);
        bus.emit('trading:event', {
            kind: 'position:closed',
            position: position(`p${i}`, true, pnl),
            realizedPnl: pnl,
        } as any);
    }
    bus.emit('trading:event', {
        kind: 'position:opened',
        position: position('live', false, 125),
    } as any);

    return { bus, account, updates };
}

describe('account:update', () => {
    // the payload used to come off a full getSnapshot - equity curve, stats,
    // ledger copies, all of it - just to publish six numbers on every ingest.
    // it derives only what it publishes now, and this keeps the two agreeing.
    it('publishes exactly what the snapshot reports', () => {
        for (const closedCount of [0, 1, 25, 200]) {
            const { account, updates } = seeded(closedCount);
            account.seekTo(BigInt(closedCount + 5) * NS);

            const snapshot = account.getSnapshot();
            const published = updates.at(-1);

            assert.deepEqual(published, {
                balance: snapshot.balance,
                equity: snapshot.equity,
                realizedPnl: snapshot.realizedPnl,
                unrealizedPnl: snapshot.unrealizedPnl,
                openPositionCount: snapshot.openPositionCount,
                currency: snapshot.currency,
            });
        }
    });

    it('keeps agreeing after a deposit moves the balance', () => {
        const { account, updates } = seeded(10);
        account.seekTo(20n * NS);
        account.deposit(2_500, 15n * NS, 'prop: reset');

        const snapshot = account.getSnapshot();
        assert.equal(updates.at(-1).balance, snapshot.balance);
        assert.equal(updates.at(-1).equity, snapshot.equity);
    });

    it('counts only positions that are still open', () => {
        const { account, updates } = seeded(4);
        account.seekTo(10n * NS);
        assert.equal(updates.at(-1).openPositionCount, 1);
        assert.equal(updates.at(-1).unrealizedPnl, 125);
    });
});
