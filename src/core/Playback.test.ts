import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PlaybackController } from './Playback';
import { TypedEventBus } from './TypedEventBus';

const MS = 1_000_000n;
const AT = (ms: number) => BigInt(ms) * MS;

function harness(startMs = 1000) {
    const eventBus = new TypedEventBus();
    const controller = new PlaybackController(eventBus, AT(startMs));

    const seen: Record<string, unknown[]> = { goto: [], back: [], blocked: [] };
    eventBus.on('playback:goto', (payload) => seen.goto.push(payload));
    eventBus.on('playback:step-back', () => seen.back.push(true));
    eventBus.on('playback:blocked', (payload) => seen.blocked.push(payload));

    return { eventBus, controller, seen };
}

describe('playhead lock', () => {
    it('lets everything through while unlocked', () => {
        const { controller, seen } = harness();

        controller.goTo(500);
        controller.stepBack();

        assert.equal(seen.goto.length, 1);
        assert.equal(seen.back.length, 1);
        assert.equal(seen.blocked.length, 0);
        assert.equal(controller.floor(), null);
    });

    it('refuses a jump behind the floor and says so', () => {
        const { controller, seen } = harness(1000);
        controller.lockForward(true);

        controller.goTo(999);

        assert.equal(seen.goto.length, 0);
        assert.deepEqual(seen.blocked, [{ tNs: AT(999), floorNs: AT(1000) }]);
    });

    it('refuses every step back', () => {
        const { controller, seen } = harness(1000);
        controller.lockForward(true);

        controller.stepBack();

        assert.equal(seen.back.length, 0);
        assert.equal(seen.blocked.length, 1);
    });

    it('still allows forward moves', () => {
        const { controller, seen } = harness(1000);
        controller.lockForward(true);

        controller.goTo(2000);

        assert.deepEqual(seen.goto, [{ tNs: AT(2000) }]);
        assert.equal(seen.blocked.length, 0);
    });

    it('raises the floor as the playhead advances', () => {
        const { controller, eventBus, seen } = harness(1000);
        controller.lockForward(true);

        eventBus.emit('playback:seek', { tNs: AT(5000) });
        assert.equal(controller.floor(), AT(5000));

        controller.goTo(4999);
        assert.equal(seen.goto.length, 0);
    });

    it('never lowers the floor when a pane reports an earlier horizon', () => {
        const { controller, eventBus } = harness(1000);
        controller.lockForward(true);

        eventBus.emit('playback:seek', { tNs: AT(5000) });
        eventBus.emit('playback:seek', { tNs: AT(3000) });

        assert.equal(controller.floor(), AT(5000));
        assert.equal(controller.allows(AT(4000)), false);
    });

    it('takes the floor from wherever the playhead is when it engages', () => {
        const { controller, eventBus } = harness(1000);

        eventBus.emit('playback:seek', { tNs: AT(8000) });
        controller.lockForward(true);

        assert.equal(controller.floor(), AT(8000));
    });

    it('releases the floor when unlocked', () => {
        const { controller, seen } = harness(1000);
        controller.lockForward(true);
        controller.lockForward(false);

        controller.goTo(1);

        assert.equal(controller.floor(), null);
        assert.equal(seen.goto.length, 1);
    });
});
