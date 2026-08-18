import { PlaybackMode } from '../hooks/usePlaybackEngine';
import { TypedEventBus } from './TypedEventBus';

// anything date-shaped to epoch ns. bigint is already ns, number and Date are
// epoch ms, and a string is whatever new Date() parses.
export function toNs(t: bigint | number | Date | string): bigint {
    if (typeof t === 'bigint') return t;
    const ms = typeof t === 'number' ? t : new Date(t).getTime();
    if (!Number.isFinite(ms)) throw new Error(`[ChristTrade] Invalid playback time: ${String(t)}`);
    return BigInt(Math.round(ms)) * 1_000_000n;
}

export class PlaybackController {
    private isPlaying = false;
    private currentStepSize: string = '5s';
    private currentSpeed: number = 1;
    private currentMode: PlaybackMode = 'realtime';
    private currentStepSnap = false;
    private currentTime: bigint;

    // floorNs only ever rises, so a pane reporting an earlier horizon during a
    // reload cant quietly hand back the ability to rewind
    private forwardOnly = false;
    private floorNs = 0n;

    private subscriptions = [];

    constructor(
        private eventBus: TypedEventBus,
        initialTimeNs: bigint = 0n,
    ) {
        // seeded from the configured horizon so time() is answerable before the
        // first tick - a chart thats only ever sat paused still has a playhead
        this.currentTime = initialTimeNs;
        this.play = this.play.bind(this);
        this.pause = this.pause.bind(this);
        this.stepBack = this.stepBack.bind(this);
        this.stepForward = this.stepForward.bind(this);
        this.goTo = this.goTo.bind(this);
        this.setSpeed = this.setSpeed.bind(this);
        this.setStepSize = this.setStepSize.bind(this);
        this.setMode = this.setMode.bind(this);
        this.setStepSnap = this.setStepSnap.bind(this);
        this.subscribeToEvents();
    }

    play() {
        if (this.isPlaying) return;
        this.isPlaying = true;

        this.eventBus.emit('playback:play', undefined);
    }

    pause() {
        if (!this.isPlaying) return;
        this.isPlaying = false;

        this.eventBus.emit('playback:pause', undefined);
    }

    playing() {
        return this.isPlaying;
    }

    stepSize() {
        return this.currentStepSize;
    }

    setStepSize(step: string) {
        this.eventBus.emit('playback:set-step-size', { step });
    }

    mode() {
        return this.currentMode;
    }

    setMode(mode: PlaybackMode) {
        this.eventBus.emit('playback:set-mode', { mode });
    }

    stepSnap() {
        return this.currentStepSnap;
    }

    setStepSnap(snap: boolean) {
        this.eventBus.emit('playback:set-step-snap', { snap });
    }

    speed() {
        return this.currentSpeed;
    }

    setSpeed(speed: number) {
        this.eventBus.emit('playback:set-speed', { speed });
    }

    /**
     * Refuse any move that would put the playhead behind where it has already
     * been. The floor starts wherever it is when the lock goes on.
     */
    lockForward(on: boolean) {
        this.forwardOnly = on;
        this.floorNs = on ? this.currentTime : 0n;
    }

    /** The earliest time the playhead may move to, or null when unlocked. */
    floor(): bigint | null {
        return this.forwardOnly ? this.floorNs : null;
    }

    allows(tNs: bigint) {
        return !this.forwardOnly || tNs >= this.floorNs;
    }

    private refuse(tNs: bigint) {
        this.eventBus.emit('playback:blocked', { tNs, floorNs: this.floorNs });
    }

    stepBack() {
        if (this.forwardOnly) {
            this.refuse(this.currentTime);
            return;
        }
        this.eventBus.emit('playback:step-back', undefined);
    }

    stepForward() {
        this.eventBus.emit('playback:step-forward', undefined);
    }

    /** Where the playhead currently is, in epoch ns. */
    time() {
        return this.currentTime;
    }

    /**
     * Jump the playhead anywhere, pausing first. The target may sit outside the
     * loaded window, in which case the engine streams or re-centers to reach it,
     * and it clamps to the last available bar if the data runs out.
     */
    goTo(t: bigint | number | Date | string) {
        const tNs = toNs(t);
        if (!this.allows(tNs)) {
            this.refuse(tNs);
            return;
        }
        this.eventBus.emit('playback:goto', { tNs });
    }

    subscribeToEvents() {
        const unsubs = [
            this.eventBus.on('playback:play', () => (this.isPlaying = true)),
            this.eventBus.on('playback:pause', () => (this.isPlaying = false)),
            this.eventBus.on(
                'playback:set-step-size',
                (payload) => (this.currentStepSize = payload.step),
            ),
            this.eventBus.on(
                'playback:set-speed',
                (payload) => (this.currentSpeed = payload.speed),
            ),
            this.eventBus.on('playback:set-mode', (payload) => (this.currentMode = payload.mode)),
            this.eventBus.on('playback:seek', (payload) => {
                this.currentTime = payload.tNs;
                if (this.forwardOnly && payload.tNs > this.floorNs) this.floorNs = payload.tNs;
            }),
            this.eventBus.on(
                'playback:set-step-snap',
                (payload) => (this.currentStepSnap = payload.snap),
            ),
        ];

        this.subscriptions = unsubs;
    }

    destroy() {
        this.subscriptions.forEach((fn) => fn());
    }
}
