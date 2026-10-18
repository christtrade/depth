import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { PluginScheduleImpl } from './PluginSchedule';

// a hand-cranked rAF and IntersectionObserver, so frames can be stepped at exact timestamps
let queue = new Map<number, (t: number) => void>();
let nextId = 1;
let observers: { cb: (e: { isIntersecting: boolean }[]) => void }[] = [];

function step(t: number) {
    const due = queue;
    queue = new Map();
    for (const cb of due.values()) cb(t);
}

function setOnScreen(isIntersecting: boolean) {
    for (const o of observers) o.cb([{ isIntersecting }]);
}

const g = globalThis as any;

beforeEach(() => {
    queue = new Map();
    observers = [];
    g.requestAnimationFrame = (cb: (t: number) => void) => {
        const id = nextId++;
        queue.set(id, cb);
        return id;
    };
    g.cancelAnimationFrame = (id: number) => queue.delete(id);
    g.IntersectionObserver = class {
        constructor(public cb: (e: { isIntersecting: boolean }[]) => void) {
            observers.push(this);
        }
        observe() {}
        disconnect() {}
    };
});

afterEach(() => {
    delete g.requestAnimationFrame;
    delete g.cancelAnimationFrame;
    delete g.IntersectionObserver;
});

describe('PluginSchedule.frames', () => {
    it('throttles to fps on a 60hz screen without falling to 20', () => {
        const s = new PluginScheduleImpl();
        const calls: number[] = [];
        s.frames(30, (t) => calls.push(t));

        for (let i = 0; i <= 12; i++) step(i * 16.6);

        // every other frame, give or take vsync jitter
        assert.equal(calls.length, 7);
    });

    it('fps 0 runs every frame and passes dt', () => {
        const s = new PluginScheduleImpl();
        const dts: number[] = [];
        s.frames(0, (_t, dt) => dts.push(dt));

        step(0);
        step(16);
        step(40);

        assert.equal(dts.length, 3);
        assert.deepEqual(dts.slice(1), [16, 24]);
    });

    it('skips while off screen, and the first frame back gets one interval as dt', () => {
        const el = {} as Element;
        const s = new PluginScheduleImpl(() => el);
        const dts: number[] = [];
        s.frames(10, (_t, dt) => dts.push(dt));

        step(0);
        setOnScreen(false);
        step(100);
        step(5000);
        setOnScreen(true);
        step(5100);

        assert.deepEqual(dts, [100, 100]);
    });

    it('stop and destroy cancel the loop', () => {
        const s = new PluginScheduleImpl();
        let a = 0;
        let b = 0;
        const stop = s.frames(0, () => a++);
        s.frames(0, () => b++);

        step(0);
        stop();
        step(16);
        s.destroy();
        step(32);

        assert.equal(a, 1);
        assert.equal(b, 2);
        assert.equal(queue.size, 0);
    });

    it('a throwing callback keeps the loop going', () => {
        const s = new PluginScheduleImpl();
        let n = 0;
        const err = console.error;
        console.error = () => {};
        s.frames(0, () => {
            n++;
            throw new Error('boom');
        });
        step(0);
        step(16);
        console.error = err;

        assert.equal(n, 2);
    });
});
