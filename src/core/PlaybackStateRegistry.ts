
import type { TypedEventBus } from './TypedEventBus';

export interface PluginStateSnapshot {
    serialize(): unknown;
    restore(state: unknown): void;
}

interface Checkpoint {
    horizonNs: bigint;
    states: Map<string, unknown>;
}

const DEFAULT_INTERVAL_NS = 60n * 1_000_000_000n; // 60s sim time
const MAX_CHECKPOINTS = 200;

export class PlaybackStateRegistry {
    private readonly plugins = new Map<string, PluginStateSnapshot>();
    private readonly checkpoints: Checkpoint[] = [];
    private lastCheckpointNs = 0n;
    private currentHorizonNs = 0n;
    private readonly intervalNs: bigint;
    private readonly unsubs: Array<() => void> = [];

    constructor(
        private readonly eventBus: TypedEventBus,
        opts?: { intervalNs?: bigint },
    ) {
        this.intervalNs = opts?.intervalNs ?? DEFAULT_INTERVAL_NS;
        this._wire();
    }

    register(pluginId: string, snapshot: PluginStateSnapshot): () => void {
        this.plugins.set(pluginId, snapshot);
        return () => {
            this.plugins.delete(pluginId);
            for (const cp of this.checkpoints) cp.states.delete(pluginId);
        };
    }

    // called on every horizon advance
    onHorizonAdvance(horizonNs: bigint): void {
        this.currentHorizonNs = horizonNs;
        if (this.plugins.size === 0) return;

        if (this.lastCheckpointNs === 0n) {
            this.lastCheckpointNs = horizonNs;
            this._snapshot(horizonNs);
            return;
        }

        if (horizonNs - this.lastCheckpointNs >= this.intervalNs) {
            this._snapshot(horizonNs);
            this.lastCheckpointNs = horizonNs;
        }
    }

    private _snapshot(horizonNs: bigint): void {
        const states = new Map<string, unknown>();
        for (const [id, snap] of this.plugins) {
            try {
                states.set(id, snap.serialize());
            } catch (err) {
                console.warn(`[PlaybackStateRegistry] serialize() threw for '${id}':`, err);
            }
        }
        this.checkpoints.push({ horizonNs, states });
        if (this.checkpoints.length > MAX_CHECKPOINTS) this.checkpoints.shift();
    }

    // the horizonNs we restored from, or null if theres no checkpoint
    restoreToNearest(targetNs: bigint): bigint | null {
        if (this.checkpoints.length === 0) {
            this._resetAll();
            return null;
        }

        // binary search for the rightmost checkpoint <= targetNs
        let lo = 0,
            hi = this.checkpoints.length - 1,
            best = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (this.checkpoints[mid].horizonNs <= targetNs) {
                best = mid;
                lo = mid + 1;
            } else hi = mid - 1;
        }

        if (best === -1) {
            this._resetAll();
            return null;
        }

        const cp = this.checkpoints[best];
        for (const [id, snap] of this.plugins) {
            const state = cp.states.get(id);
            if (state === undefined) continue;
            try {
                snap.restore(state);
            } catch (err) {
                console.warn(`[PlaybackStateRegistry] restore() threw for '${id}':`, err);
            }
        }

        // trim the future ones, theyre invalid now
        this.checkpoints.splice(best + 1);
        this.lastCheckpointNs = cp.horizonNs;

        return cp.horizonNs;
    }

    private _resetAll(): void {
        // nothing before the target, so emit and let plugins self-reset
        this.eventBus.emit('playback:state-reset' as any, undefined);
    }

    private _wire(): void {
        const offAppend = (this.eventBus as any).on('data:append', (payload: any) => {
            if (payload?.dataEnd) {
                const ms = BigInt(new Date(payload.dataEnd).getTime());
                this.onHorizonAdvance(ms * 1_000_000n);
            }
        });

        const offSeek = this.eventBus.on('playback:seek', ({ tNs }) => {
            if (tNs < this.currentHorizonNs) {
                const from = this.restoreToNearest(tNs);
                (this.eventBus as any).emit('playback:state-restored', {
                    checkpointNs: from,
                    targetNs: tNs,
                });
            }
        });

        this.unsubs.push(offAppend, offSeek);
    }

    getCheckpointCount(): number {
        return this.checkpoints.length;
    }

    destroy(): void {
        this.unsubs.forEach((fn) => fn());
        this.plugins.clear();
        this.checkpoints.length = 0;
    }
}
