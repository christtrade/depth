
export interface PluginSchedule {
    interval(ms: number, fn: () => void): () => void;
    timeout(ms: number, fn: () => void): () => void;
    raf(fn: () => void): () => void;
    frames(fps: number, fn: (time: number, dt: number) => void): () => void;
}

const FRAME_SLACK_MS = 2;

export class PluginScheduleImpl implements PluginSchedule {
    // Using any here because timer IDs differ between browser/node
    private readonly intervals = new Set<any>();
    private readonly timeouts = new Set<any>();
    private readonly rafIds = new Set<number>();
    private readonly frameLoops = new Set<() => void>();
    private destroyed = false;

    private observer: IntersectionObserver | null = null;
    private readonly observed = new Set<Element>();
    private readonly visible = new Set<Element>();

    /** `getElements` - every cell the plugin draws on. Frames run while any is on screen */
    constructor(private readonly getElements: () => readonly Element[] = () => []) {}

    private get onScreen(): boolean {
        return this.observed.size === 0 || this.visible.size > 0;
    }

    interval(ms: number, fn: () => void): () => void {
        if (this.destroyed) return () => {};
        const id = setInterval(() => {
            try {
                fn();
            } catch (err) {
                console.error('[PluginSchedule] interval threw:', err);
            }
        }, ms);
        this.intervals.add(id);
        return () => {
            clearInterval(id);
            this.intervals.delete(id);
        };
    }

    timeout(ms: number, fn: () => void): () => void {
        if (this.destroyed) return () => {};
        let id: any;
        id = setTimeout(() => {
            try {
                fn();
            } catch (err) {
                console.error('[PluginSchedule] timeout threw:', err);
            } finally {
                this.timeouts.delete(id);
            }
        }, ms);
        this.timeouts.add(id);
        return () => {
            clearTimeout(id);
            this.timeouts.delete(id);
        };
    }

    raf(fn: () => void): () => void {
        if (this.destroyed) return () => {};
        let id: number;
        id = requestAnimationFrame(() => {
            try {
                fn();
            } catch (err) {
                console.error('[PluginSchedule] raf threw:', err);
            } finally {
                this.rafIds.delete(id);
            }
        });
        this.rafIds.add(id);
        return () => {
            cancelAnimationFrame(id);
            this.rafIds.delete(id);
        };
    }

    frames(fps: number, fn: (time: number, dt: number) => void): () => void {
        if (this.destroyed) return () => {};
        const interval = fps > 0 && Number.isFinite(fps) ? 1000 / fps : 0;
        let id = 0;
        let last = -1;
        let failed = false;

        const loop = (now: number) => {
            id = requestAnimationFrame(loop);
            this.watchVisibility();
            if (!this.onScreen) {
                last = -1;
                return;
            }
            if (last >= 0 && now - last + FRAME_SLACK_MS < interval) return;

            const dt = last < 0 ? interval || 1000 / 60 : now - last;
            last = now;
            try {
                fn(now, dt);
            } catch (err) {
                if (!failed) {
                    failed = true;
                    console.error('[PluginSchedule] frames threw:', err);
                }
            }
        };
        id = requestAnimationFrame(loop);

        const stop = () => {
            cancelAnimationFrame(id);
            this.frameLoops.delete(stop);
        };
        this.frameLoops.add(stop);
        return stop;
    }

    // synced every tick - cells mount and unmount with the layout, and a detached
    // element never intersects, so watching a stale one pauses frames for good
    private watchVisibility(): void {
        if (typeof IntersectionObserver === 'undefined') return;
        const els = this.getElements();
        this.observer ??= new IntersectionObserver((entries) => {
            for (const e of entries) {
                if (!this.observed.has(e.target)) continue;
                if (e.isIntersecting) this.visible.add(e.target);
                else this.visible.delete(e.target);
            }
        });
        for (const el of els) {
            if (this.observed.has(el)) continue;
            this.observed.add(el);
            // counts as visible until the observer says otherwise, its first report is async
            this.visible.add(el);
            this.observer.observe(el);
        }
        for (const el of this.observed) {
            if (els.includes(el)) continue;
            this.observer.unobserve(el);
            this.observed.delete(el);
            this.visible.delete(el);
        }
    }

    destroy(): void {
        this.destroyed = true;
        this.frameLoops.forEach((stop) => stop());
        this.observer?.disconnect();
        this.observer = null;
        this.observed.clear();
        this.visible.clear();
        this.intervals.forEach((id) => clearInterval(id));
        this.timeouts.forEach((id) => clearTimeout(id));
        this.rafIds.forEach((id) => cancelAnimationFrame(id));
        this.intervals.clear();
        this.timeouts.clear();
        this.rafIds.clear();
    }
}
