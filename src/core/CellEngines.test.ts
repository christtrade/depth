import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CellEngines } from './CellEngines';
import type { DrawHook, DrawPhase } from './RenderEngine';

function fakeEngine(cellId: number) {
    const hooks = new Set<DrawHook>();
    return {
        cellId,
        hooks,
        focused: false,
        addDrawHook(_phase: DrawPhase, hook: DrawHook) {
            hooks.add(hook);
            return () => hooks.delete(hook);
        },
        setFocused(f: boolean) {
            this.focused = f;
        },
    };
}

const hook: DrawHook = () => {};

describe('CellEngines', () => {
    it('one chart to two: the overlay stays on cell 0 and lands on cell 1', () => {
        const cells = new CellEngines<ReturnType<typeof fakeEngine>>();
        const a = fakeEngine(0);
        cells.attach(a);
        cells.addOverlay('after-background', hook);

        const b = fakeEngine(1);
        cells.attach(b);

        assert.ok(a.hooks.has(hook));
        assert.ok(b.hooks.has(hook));
    });

    it('a remounted cell gets the overlay and the old engine lets go of it', () => {
        const cells = new CellEngines<ReturnType<typeof fakeEngine>>();
        const old = fakeEngine(0);
        cells.attach(old);
        cells.addOverlay('after-base', hook);

        const fresh = fakeEngine(0);
        cells.attach(fresh);

        assert.ok(!old.hooks.has(hook));
        assert.ok(fresh.hooks.has(hook));
        assert.equal(cells.all.get(0), fresh);
    });

    it('a late destroy of the replaced engine leaves the new one alone', () => {
        const cells = new CellEngines<ReturnType<typeof fakeEngine>>();
        const old = fakeEngine(0);
        cells.attach(old);
        const fresh = fakeEngine(0);
        cells.attach(fresh);
        cells.addOverlay('after-base', hook);

        // react can unmount the old cell after the new one mounted
        cells.detach(old);

        assert.equal(cells.all.get(0), fresh);
        assert.ok(fresh.hooks.has(hook));
    });

    it('remove takes the overlay off every cell, and later cells never get it', () => {
        const cells = new CellEngines<ReturnType<typeof fakeEngine>>();
        const a = fakeEngine(0);
        const b = fakeEngine(1);
        cells.attach(a);
        cells.attach(b);
        const remove = cells.addOverlay('after-ui', hook);

        remove();
        const c = fakeEngine(2);
        cells.attach(c);

        assert.equal(a.hooks.size + b.hooks.size + c.hooks.size, 0);
    });

    it('focus follows the focused cell, including cells that mount after', () => {
        const cells = new CellEngines<ReturnType<typeof fakeEngine>>();
        const a = fakeEngine(0);
        cells.attach(a);
        cells.focus(1);
        const b = fakeEngine(1);
        cells.attach(b);

        assert.equal(a.focused, false);
        assert.equal(b.focused, true);
        assert.equal(cells.focused, b);
    });

    it('focused falls back to any cell when the focused one has not mounted', () => {
        const cells = new CellEngines<ReturnType<typeof fakeEngine>>();
        const b = fakeEngine(1);
        cells.attach(b);

        assert.equal(cells.focused, b);
    });
});
