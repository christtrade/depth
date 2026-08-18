//  PriceTransition
//
//  Eases the *displayed* price for the live price line / axis pills toward each
//  new value instead of snapping. On symbols whose prints are sparse this turns
//  abrupt jumps into a smooth glide. Purely visual - it never touches the
//  underlying data, only the value handed to priceToY()/the pill label at draw
//  time. Disabled by default; toggled via ChartSettings.animatePriceUpdates.
const DEFAULT_DURATION_MS = 180;

interface Tween {
    from: number;
    to: number;
    start: number; // performance.now() timestamp when this tween began
}

function easeOutCubic(x: number): number {
    return 1 - Math.pow(1 - x, 3);
}

export class PriceTransition {
    private readonly tweens = new Map<string, Tween>();
    private symbolKey: string | undefined;

    constructor(private readonly durationMs: number = DEFAULT_DURATION_MS) {}

    /**
     * Forget all in-flight tweens when the symbol changes, so switching
     * instruments never animates one price across to a wildly different one.
     */
    setSymbol(key: string | undefined): void {
        if (key === this.symbolKey) return;
        this.symbolKey = key;
        this.tweens.clear();
    }

    /**
     * Value to render for `key` (e.g. 'last' / 'bid' / 'ask'), easing toward
     * `target` whenever a new target arrives. With `enabled` false (or a
     * non-finite target) it passes the target straight through and drops any
     * pending tween, so toggling the setting off snaps to the truth immediately.
     */
    value(key: string, target: number, now: number, enabled: boolean): number {
        if (!enabled || !Number.isFinite(target)) {
            this.tweens.delete(key);
            return target;
        }

        const tween = this.tweens.get(key);
        if (!tween) {
            this.tweens.set(key, { from: target, to: target, start: now });
            return target;
        }

        if (tween.to !== target) {
            // Retarget mid-flight: start the new ease from wherever we are now.
            const current = this.sample(tween, now);
            tween.from = current;
            tween.to = target;
            tween.start = now;
            return current;
        }

        return this.sample(tween, now);
    }

    /** True while any tween is still in flight - caller should request another frame. */
    isAnimating(now: number): boolean {
        for (const t of this.tweens.values()) {
            if (t.from !== t.to && now - t.start < this.durationMs) return true;
        }
        return false;
    }

    reset(): void {
        this.tweens.clear();
    }

    private sample(t: Tween, now: number): number {
        const p = this.durationMs > 0 ? Math.min(1, (now - t.start) / this.durationMs) : 1;
        return t.from + (t.to - t.from) * easeOutCubic(p);
    }
}
