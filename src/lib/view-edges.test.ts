import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TypedEventBus } from '../core/TypedEventBus';
import { followsEdge, hasHole, panEnd, requestPastEdges } from './view-edges';

const SEC = 1_000_000_000n;
const BAR = 60n * SEC;
const END = 1_000_000n * BAR;
const YEAR = 365n * 24n * 3600n * SEC;

describe('hasHole', () => {
    it('is a hole only past a bar short of the horizon', () => {
        assert.equal(hasHole(END, END, BAR), false);
        // a live horizon sits inside the forming bar
        assert.equal(hasHole(END, END + BAR, BAR), false);
        assert.equal(hasHole(END, END + BAR + 1n, BAR), true);
        assert.equal(hasHole(END, END + YEAR, BAR), true);
    });
});

describe('panEnd', () => {
    it('stops at the data on a live chart', () => {
        assert.equal(panEnd(END, END + BAR / 2n, BAR), END);
    });

    it('stops at the playhead in playback', () => {
        assert.equal(panEnd(END, END - 10n * BAR, BAR), END - 10n * BAR);
    });

    it('lets a pan into a hole reach the horizon', () => {
        assert.equal(panEnd(END, END + YEAR, BAR), END + YEAR);
    });

    it('falls back to the data without a horizon', () => {
        assert.equal(panEnd(END, 0n, BAR), END);
    });
});

describe('requestPastEdges', () => {
    const asks = (view: { tMin: bigint; tMax: bigint }, horizon: bigint) => {
        const bus = new TypedEventBus();
        const seen: string[] = [];
        bus.on('data:request-backward', ({ viewMin }) => seen.push(`back ${viewMin === view.tMin}`));
        bus.on('data:request-forward', ({ viewMax }) => seen.push(`fwd ${viewMax === view.tMax}`));
        requestPastEdges(
            bus,
            { ...view, pMin: 0, pMax: 0, pRef: 0 } as never,
            { start: END - 1000n * BAR, end: END, horizon, barNs: BAR },
            'NQ',
        );
        return seen;
    };

    it('asks for history past the left edge', () => {
        assert.deepEqual(asks({ tMin: END - 2000n * BAR, tMax: END - 1500n * BAR }, END), ['back true']);
    });

    it('asks forward past the right edge only into a hole', () => {
        const view = { tMin: END - 100n * BAR, tMax: END + 50n * BAR };
        assert.deepEqual(asks(view, END + YEAR), ['fwd true']);
        assert.deepEqual(asks(view, END), [], 'a live chart has nothing past its data');
    });

    it('asks nothing inside the data', () => {
        assert.deepEqual(asks({ tMin: END - 500n * BAR, tMax: END - 100n * BAR }, END + YEAR), []);
    });
});

describe('followsEdge', () => {
    const at = (horizon: bigint, newEnd: bigint, playing = false) =>
        followsEdge({ horizon, oldEnd: END, newEnd, barNs: BAR, playing });

    it('follows a live bar', () => {
        assert.equal(at(END, END + BAR), true);
        assert.equal(at(END + BAR / 2n, END + BAR), true, 'horizon inside the forming bar');
    });

    it('leaves the playhead alone in playback', () => {
        assert.equal(at(END, END + BAR, true), false);
    });

    it('leaves a horizon behind the data alone', () => {
        assert.equal(at(END - 10n * BAR, END + BAR), false);
    });

    it('keeps a horizon across a hole while pages fill it', () => {
        assert.equal(at(END + YEAR, END + 3600n * SEC), false);
    });

    it('follows once the pages reach the horizon', () => {
        assert.equal(at(END + YEAR, END + YEAR), true);
    });

    it('keeps it when an eviction leaves the end where it was', () => {
        assert.equal(at(END + YEAR, END), false);
    });
});
