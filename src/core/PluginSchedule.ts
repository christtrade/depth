
export interface PluginSchedule {
    interval(ms: number, fn: () => void): () => void;
    timeout(ms: number, fn: () => void): () => void;
    raf(fn: () => void): () => void;
}

export class PluginScheduleImpl implements PluginSchedule {
    // Using any here because timer IDs differ between browser/node
    private readonly intervals = new Set<any>();
    private readonly timeouts = new Set<any>();
    private readonly rafIds = new Set<number>();
    private destroyed = false;

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

    destroy(): void {
        this.destroyed = true;
        this.intervals.forEach((id) => clearInterval(id));
        this.timeouts.forEach((id) => clearTimeout(id));
        this.rafIds.forEach((id) => cancelAnimationFrame(id));
        this.intervals.clear();
        this.timeouts.clear();
        this.rafIds.clear();
    }
}
