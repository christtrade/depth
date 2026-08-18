import { useCallback, useEffect, useRef, useState } from 'react';
import { TypedEventBus } from '../core';

// Config
export const BASE_REDRAW_INTERVAL_MS = 100;

const UNIT_NS: Record<string, bigint> = {
    ms: 1_000_000n,
    s: 1_000_000_000n,
    m: 60_000_000_000n,
    h: 3_600_000_000_000n,
};

// '<count><unit>', e.g. '100ms', '5s', '1m', '2h'. 'ms' is listed first so it
// wins over 's'/'m' when matching.
const STEP_SIZE_RE = /^(\d+)(ms|s|m|h)$/;

export const DEFAULT_STEP_NS = 5_000_000_000n; // 5s

/** Parse a step-size token into nanoseconds. Unknown tokens fall back to 5s. */
export function stepSizeToNs(stepSize: string): bigint {
    const match = STEP_SIZE_RE.exec(stepSize);
    if (!match) return DEFAULT_STEP_NS;
    return BigInt(match[1]) * UNIT_NS[match[2]];
}

// Types
export type PlaybackStatus = 'paused' | 'playing';
export type PlaybackMode = 'step' | 'realtime';

export type PlaybackState = {
    mode: PlaybackMode;
    status: PlaybackStatus;
    /** Step mode only: snap the horizon to step-size boundaries when advancing. */
    stepSnap: boolean;
    speed: number;
    stepSize: string;
    wallStart: number;
    dataStart: bigint;
    datasetStart: bigint;
    /** Left edge of the *currently loaded* window (moves when we jump-load). */
    loadedStart: bigint;
    dataEnd: bigint;
    rafHandle: number;
    lastBaseRedrawWall: number;
    _stallStart: number | undefined;
    _lastRafTime: number | undefined;
};

export type PlaybackUi = {
    mode: PlaybackMode;
    status: PlaybackStatus;
    stepSnap: boolean;
    speed: number;
    stepSize: string;
    datasetStart: bigint;
    datasetEnd: bigint;
};

export type PlaybackChartHandle = {
    /**
     * `recenter` = this move was asked for (Go to, a step past the view edge),
     * so the pane should bring its view along. Playback's per-tick follow is the
     * pane's own business and doesn't set it.
     */
    seekHorizon: (t: bigint, recenter?: boolean) => void;
};

// Helpers
function createPlaybackState(datasetStart: bigint, dataEnd: bigint): PlaybackState {
    return {
        mode: 'realtime',
        status: 'paused',
        stepSnap: false,
        speed: 1,
        stepSize: '5s',
        wallStart: 0,
        dataStart: 0n,
        datasetStart,
        loadedStart: datasetStart,
        dataEnd,
        rafHandle: 0,
        lastBaseRedrawWall: 0,
        _stallStart: undefined,
        _lastRafTime: undefined,
    };
}

function getPlayheadTime(state: PlaybackState): bigint {
    const elapsedMs = Date.now() - state.wallStart;

    if (state.mode === 'step') {
        // Step mode: advance the horizon by exactly `stepSize` in data-time,
        // `speed` times per wall-clock second. The result is quantised to whole
        // steps so the chart jumps bar-by-bar rather than sliding continuously.
        const stepNs = stepSizeToNs(state.stepSize);
        const steps = Math.max(0, Math.floor((elapsedMs * state.speed) / 1000));
        if (state.stepSnap) {
            // Snap to the step grid: the first step lands on the next boundary
            // (e.g. 14:43:35 -> 14:45:00 for a 5m step), then advances by whole
            // steps along the grid. Stay put until the first step elapses.
            if (steps === 0) return state.dataStart;
            const gridFloor = (state.dataStart / stepNs) * stepNs;
            return gridFloor + BigInt(steps) * stepNs;
        }
        return state.dataStart + BigInt(steps) * stepNs;
    }

    // Realtime mode: `speed` is a wall-clock time multiplier.
    const elapsedNs = BigInt(Math.max(0, Math.round(elapsedMs * state.speed))) * 1_000_000n;
    return state.dataStart + elapsedNs;
}

/**
 * How much data-time the playhead consumes per wall-clock millisecond, given the
 * current mode/speed/step. Used to estimate time-to-edge for prefetching, so the
 * lead auto-scales with speed instead of being a fixed number of seconds.
 *   realtime: speed x 1 data-ms/wall-ms
 *   step:     stepNs x speed-steps-per-second
 */
function consumptionNsPerMs(state: PlaybackState): number {
    if (state.mode === 'step') {
        return (Number(stepSizeToNs(state.stepSize)) * state.speed) / 1000;
    }
    return state.speed * 1_000_000;
}

// Hook
export interface PrefetchOptions {
    /**
     * Prefetch the next chunk when the estimated time to reach the loaded edge
     * drops below `measuredLoadLatency x safetyFactor`. Higher = more lead.
     * Default 2.5.
     */
    safetyFactor?: number;
    /** Always keep at least this much wall-time of lead, in ms. Default 300. */
    minLeadMs?: number;
}

interface UsePlaybackEngineOptions {
    chartRefs: React.MutableRefObject<(PlaybackChartHandle | null)[]>;
    sharedHorizonRef: React.MutableRefObject<bigint>;
    /** Request a forward chunk; `spanNs` is the desired data-time span to fetch. */
    onRequestMore?: (spanNs?: bigint) => void;
    onTick?: (tNs: bigint) => void;
    eventBus: TypedEventBus;
    prefetch?: PrefetchOptions;
    /**
     * The symbol whose data gates the clock - in a layout, the focused pane's.
     * Data events carrying any other symbol are somebody else's pane and must
     * not stop playback. Omit (or return undefined) to accept everything, which
     * is what a single-symbol host wants.
     */
    clockSymbol?: () => string | undefined;
}

// A prefetch should buy enough runway to cover several load-latencies of
// consumption, so fast playback isn't constantly re-fetching tiny chunks.
const PREFETCH_SPAN_FACTOR = 5;

// Manual forward navigation up to this far past the loaded edge streams-and-
// appends (history behind you is retained). Beyond it, we jump-load (re-center,
// which drops history) since streaming the whole gap would be wasteful.
const MAX_STREAM_SPAN_NS = 14n * 24n * 60n * 60n * 1_000_000_000n; // 14 days

export function usePlaybackEngine({
    chartRefs,
    sharedHorizonRef,
    onRequestMore,
    onTick,
    eventBus,
    prefetch,
    clockSymbol,
}: UsePlaybackEngineOptions) {
    const safetyFactor = prefetch?.safetyFactor ?? 2.5;
    const minLeadMs = prefetch?.minLeadMs ?? 300;

    const clockSymbolRef = useRef(clockSymbol);
    useEffect(() => {
        clockSymbolRef.current = clockSymbol;
    });

    /** Is this symbol-tagged event about the pane the clock is following? */
    const drivesClock = useCallback((symbol?: string) => {
        if (symbol === undefined) return true; // chart-wide event
        const clock = clockSymbolRef.current?.();
        return clock === undefined || symbol === clock;
    }, []);
    const pbRef = useRef(createPlaybackState(0n, 0n));
    // True once the adapter reports it has no more data past the loaded edge.
    // While false, hitting dataEnd means "buffer underrun, wait for more"; once
    // true, hitting dataEnd means "real end of stream, pause".
    const endOfDataRef = useRef(false);

    const [ui, setUi] = useState<PlaybackUi>({
        mode: 'realtime',
        status: 'paused',
        stepSnap: false,
        speed: 1,
        stepSize: '5s',
        datasetStart: 0n,
        datasetEnd: 0n,
    });

    const onRequestMoreRef = useRef(onRequestMore);
    useEffect(() => {
        onRequestMoreRef.current = onRequestMore;
    });

    const requestingMoreRef = useRef(false);
    // True while a jump-load (data:seek-load) is awaiting its data:load, so we
    // don't fire duplicate jump-loads on rapid steps / loop frames.
    const jumpLoadInFlightRef = useRef(false);
    // The horizon a loop-driven jump-load is targeting, so we can re-anchor the
    // clock there once its window arrives (null = no loop jump pending).
    const pendingJumpTargetRef = useRef<bigint | null>(null);
    // The horizon a manual stream-append step is heading to (set by goTo); once
    // the append extends the buffer we drive there. Unlike a jump-load this
    // keeps the existing data, so history behind the playhead is retained.
    const pendingSeekTargetRef = useRef<bigint | null>(null);
    // EWMA of measured forward-load latency (ms), and the timestamp the current
    // prefetch was fired, so we can size prefetch lead to real load times.
    const loadLatencyMsRef = useRef(600);
    const prefetchFiredAtRef = useRef<number | null>(null);

    useEffect(() => {
        const unsubs = [
            eventBus.on('data:prefetch-done', () => {
                requestingMoreRef.current = false;
                if (prefetchFiredAtRef.current !== null) {
                    const latency = performance.now() - prefetchFiredAtRef.current;
                    prefetchFiredAtRef.current = null;
                    // EWMA so a single slow/fast load doesn't whipsaw the lead.
                    loadLatencyMsRef.current = loadLatencyMsRef.current * 0.7 + latency * 0.3;
                }
            }),
            // Payload read defensively: this is a public bus, and hosts emitted
            // this event with no payload at all before it carried a symbol.
            eventBus.on('data:no-more-forward', (payload) => {
                // Another pane's instrument running dry is not the end of the
                // replay - with the prefetch fanned out across every loaded
                // symbol, the shortest history would otherwise pause everyone.
                if (!drivesClock(payload?.symbol)) return;
                endOfDataRef.current = true;
                // A stream-seek that was waiting on data past the end will never
                // get it - settle at the last bar we do have instead of leaving
                // the playhead parked where the jump started.
                if (pendingSeekTargetRef.current !== null) {
                    pendingSeekTargetRef.current = null;
                    driveAllCharts(pbRef.current.dataEnd, true);
                }
            }),
            // A fresh full (re)load resets the stream: there may be more data
            // again, and any prior stall is meaningless. This also fires when a
            // jump-load completes, so clear the in-flight guard and, if a loop
            // jump was pending, re-anchor the clock to continue from the target.
            eventBus.on('data:load', () => {
                endOfDataRef.current = false;
                jumpLoadInFlightRef.current = false;
                // A jump-load (re-center) supersedes any in-flight stream-seek.
                pendingSeekTargetRef.current = null;
                pbRef.current._stallStart = undefined;
                if (pendingJumpTargetRef.current !== null) {
                    const pb = pbRef.current;
                    if (pb.status === 'playing') {
                        pb.dataStart = pendingJumpTargetRef.current;
                        pb.wallStart = Date.now();
                    }
                    pendingJumpTargetRef.current = null;
                }
            }),
        ];
        return () => unsubs.forEach((fn) => fn());
    }, [eventBus]);

    const onTickRef = useRef(onTick);
    useEffect(() => {
        onTickRef.current = onTick;
    });

    const driveAllCharts = useCallback(
        (t: bigint, recenter = false) => {
            sharedHorizonRef.current = t;
            const refs = chartRefs.current;
            for (let i = 0; i < refs.length; i++) {
                refs[i]?.seekHorizon(t, recenter);
            }
            onTickRef.current?.(t);
        },
        [chartRefs, sharedHorizonRef],
    );

    // Fire a forward prefetch (at most one in flight), timestamping it so the
    // latency EWMA can be updated when data:prefetch-done arrives. Sizes the
    // requested span to the current consumption rate so fast playback fetches
    // bigger chunks instead of choppy fixed-size ones - capped at one loaded
    // window, beyond which the loop jump-loads instead of streaming.
    const firePrefetch = useCallback((explicitSpanNs?: bigint) => {
        if (requestingMoreRef.current || endOfDataRef.current) return;
        requestingMoreRef.current = true;
        prefetchFiredAtRef.current = performance.now();

        let spanNs = explicitSpanNs;
        if (spanNs === undefined) {
            const p = pbRef.current;
            const rate = consumptionNsPerMs(p);
            spanNs =
                rate > 0
                    ? BigInt(Math.ceil(rate * loadLatencyMsRef.current * PREFETCH_SPAN_FACTOR))
                    : 0n;
            const windowNs = p.dataEnd - p.loadedStart;
            if (windowNs > 0n && spanNs > windowNs) spanNs = windowNs;
        }

        onRequestMoreRef.current?.(spanNs && spanNs > 0n ? spanNs : undefined);
    }, []);

    // Navigate to `target`:
    //  - inside the loaded window           -> seek instantly
    //  - a bit past the forward edge        -> stream-append to it (keeps history
    //                                          behind the playhead)
    //  - far ahead, or back before history  -> jump-load a fresh window centered
    //                                          on it (O(one window), but drops
    //                                          the old buffer)
    const goTo = useCallback(
        (target: bigint) => {
            const pb = pbRef.current;

            // `recenter`: goTo is explicit navigation, so the view comes along
            // rather than being left a day of bars behind for the user to pan
            // through. (The jump-load path below reframes the view on data:load.)
            if (target >= pb.loadedStart && target <= pb.dataEnd) {
                pendingSeekTargetRef.current = null;
                driveAllCharts(target, true);
                return;
            }

            if (target > pb.dataEnd && target - pb.dataEnd <= MAX_STREAM_SPAN_NS) {
                if (endOfDataRef.current) {
                    // Nothing more to load - settle at the last available bar.
                    pendingSeekTargetRef.current = null;
                    driveAllCharts(pb.dataEnd, true);
                    return;
                }
                // Extend the buffer forward to the target instead of re-centering,
                // so the data we're stepping away from stays loaded. We drive to
                // the target once the append lands (see notifyDataBounds).
                const gap = target - pb.dataEnd;
                pendingSeekTargetRef.current = target;
                firePrefetch(gap + gap / 8n);
                return;
            }

            if (jumpLoadInFlightRef.current) return;
            jumpLoadInFlightRef.current = true;
            pendingSeekTargetRef.current = null;
            eventBus.emit('data:seek-load', { tNs: target, fromNs: sharedHorizonRef.current });
        },
        [driveAllCharts, firePrefetch, eventBus, sharedHorizonRef],
    );

    const stopLoop = useCallback(() => {
        const pb = pbRef.current;
        if (pb.rafHandle) {
            cancelAnimationFrame(pb.rafHandle);
            pb.rafHandle = 0;
        }
    }, []);

    const pause = useCallback(() => {
        stopLoop();
        pbRef.current.status = 'paused';
        setUi((prev) => ({ ...prev, status: 'paused' }));
        driveAllCharts(sharedHorizonRef.current);
    }, [stopLoop, driveAllCharts, sharedHorizonRef]);

    const startLoop = useCallback(() => {
        const tick = () => {
            const p = pbRef.current;
            if (p.status !== 'playing') return;

            const newHorizon = getPlayheadTime(p);

            // Inside loaded data: advance, prefetching as the edge nears
            if (newHorizon < p.dataEnd) {
                p._stallStart = undefined;
                // Velocity-aware prefetch: trigger when the time to reach the
                // loaded edge at the current consumption rate falls below the
                // measured load latency (x safety), with a small floor. Unlike a
                // fixed seconds buffer this auto-scales with speed and step size.
                const rate = consumptionNsPerMs(p);
                if (rate > 0) {
                    const etaMs = Number(p.dataEnd - newHorizon) / rate;
                    const lead = Math.max(minLeadMs, loadLatencyMsRef.current * safetyFactor);
                    if (etaMs < lead) firePrefetch();
                }
                driveAllCharts(newHorizon);
                p.rafHandle = requestAnimationFrame(tick);
                return;
            }

            // Past the loaded edge
            if (endOfDataRef.current) {
                // No more data will ever come - this is the real end. Emit
                // playback:pause so the public controller / UI stay in sync
                // (pause() itself doesn't emit, so this can't recurse), plus
                // playback:end for end-of-run hooks.
                driveAllCharts(p.dataEnd);
                pause();
                eventBus.emit('playback:pause', undefined);
                eventBus.emit('playback:end', undefined);
                return;
            }

            // How far past the edge the playhead wants to be, vs. how big the
            // loaded window is. Streaming covers a small overshoot cheaply; a
            // large one (fast step/speed) would need many chunks, so jump-load.
            const gap = newHorizon - p.dataEnd;
            const jumpThreshold = (p.dataEnd - p.loadedStart) / 2n;

            if (jumpThreshold > 0n && gap > jumpThreshold) {
                // Far ahead -> jump-load a fresh window centered on the target and
                // hold the loop until it arrives; the data:load handler re-anchors
                // the clock to continue from there.
                if (!jumpLoadInFlightRef.current) {
                    jumpLoadInFlightRef.current = true;
                    pendingJumpTargetRef.current = newHorizon;
                    // p.dataEnd is the playhead's current position (we've been
                    // driving there while waiting), i.e. the start of the gap.
                    eventBus.emit('data:seek-load', { tNs: newHorizon, fromNs: p.dataEnd });
                }
                driveAllCharts(p.dataEnd);
                p.rafHandle = requestAnimationFrame(tick);
                return;
            }

            // Small overshoot: pin at the edge and stream forward
            // Hold time accumulation here (pin dataStart to the edge, reset
            // wallStart) so we resume smoothly once dataEnd advances rather than
            // teleporting over the gap. notifyDataBounds picks the stall back up.
            driveAllCharts(p.dataEnd);
            p.dataStart = p.dataEnd;
            p.wallStart = Date.now();
            firePrefetch();
            if (p._stallStart === undefined) p._stallStart = Date.now();
            p.rafHandle = requestAnimationFrame(tick);
        };

        pbRef.current.rafHandle = requestAnimationFrame(tick);
    }, [driveAllCharts, pause, eventBus, firePrefetch, safetyFactor, minLeadMs]);

    const notifyDataBounds = useCallback(
        (datasetStart: bigint, dataEnd: bigint) => {
            const pb = pbRef.current;

            if (pb.datasetStart === 0n) {
                pb.datasetStart = datasetStart;
                if (sharedHorizonRef.current === 0n) {
                    sharedHorizonRef.current = datasetStart;
                }
            }

            // Track the left edge of the currently loaded window. Unlike
            // datasetStart (the first-ever load, kept for jumpToStart), this
            // moves when we jump-load or prepend, so goTo() knows the live span.
            pb.loadedStart = datasetStart;

            const advanced = dataEnd > pb.dataEnd;
            pb.dataEnd = dataEnd;

            // Fresh forward data means we're no longer parked at the end.
            if (advanced) endOfDataRef.current = false;

            // If we were holding at the old edge waiting for data, resume from
            // exactly where we held instead of letting the wall-clock time spent
            // waiting teleport the playhead forward over the gap.
            if (pb._stallStart !== undefined && advanced) {
                pb._stallStart = undefined;
                pb.wallStart = Date.now();
                pb.dataStart = sharedHorizonRef.current;
            }

            // A manual stream-seek's append has landed: drive to the target now
            // that the buffer reaches it (or to the new edge if we fell short,
            // e.g. end-of-data or a closed session between here and there).
            if (pendingSeekTargetRef.current !== null && advanced) {
                const t = pendingSeekTargetRef.current;
                pendingSeekTargetRef.current = null;
                driveAllCharts(t <= pb.dataEnd ? t : pb.dataEnd, true);
            }

            setUi((prev) => ({
                ...prev,
                datasetStart: pb.datasetStart,
                datasetEnd: pb.dataEnd,
            }));
        },
        [sharedHorizonRef, driveAllCharts],
    );

    const play = useCallback(() => {
        const pb = pbRef.current;
        if (!pb.dataEnd) return;

        stopLoop();

        let playStart = sharedHorizonRef.current;

        pb.status = 'playing';
        pb.wallStart = Date.now();
        pb.dataStart = playStart;
        pb.lastBaseRedrawWall = 0;
        pb._lastRafTime = undefined;
        pb._stallStart = undefined;

        setUi((prev) => ({ ...prev, status: 'playing' }));
        startLoop();
    }, [startLoop, stopLoop, sharedHorizonRef]);

    const stepForward = useCallback(() => {
        if (pbRef.current.status === 'playing') pause();
        const pb = pbRef.current;
        const step = stepSizeToNs(pb.stepSize);
        const cur = sharedHorizonRef.current;
        // Snap (step mode only): advance to the next step-grid boundary, e.g.
        // 14:43:35 -> 14:45:00; if already on the grid, advance a full step.
        const target = pb.stepSnap && pb.mode === 'step' ? (cur / step) * step + step : cur + step;
        // Past the loaded edge -> jump-load instead of clamping (the old clamp is
        // what made big steps "refuse" once they reached dataEnd).
        goTo(target);
    }, [pause, goTo, sharedHorizonRef]);

    const stepBack = useCallback(() => {
        if (pbRef.current.status === 'playing') pause();
        const pb = pbRef.current;
        const step = stepSizeToNs(pb.stepSize);
        const cur = sharedHorizonRef.current;
        let target: bigint;
        if (pb.stepSnap && pb.mode === 'step') {
            // Snap back to the previous step-grid boundary; if already on the
            // grid, drop a full step so the playhead always moves.
            const gridFloor = (cur / step) * step;
            target = gridFloor < cur ? gridFloor : gridFloor - step;
        } else {
            target = cur - step;
        }
        goTo(target);
    }, [pause, goTo, sharedHorizonRef]);

    const jumpToStart = useCallback(() => {
        if (pbRef.current.status === 'playing') pause();
        goTo(pbRef.current.datasetStart);
    }, [pause, goTo]);

    const jumpToEnd = useCallback(() => {
        if (pbRef.current.status === 'playing') pause();
        goTo(pbRef.current.dataEnd);
    }, [pause, goTo]);

    const setSpeed = useCallback(
        (s: number) => {
            const pb = pbRef.current;
            const wasPlaying = pb.status === 'playing';
            pb.speed = s;
            setUi((prev) => ({ ...prev, speed: s }));
            if (wasPlaying) {
                pb.wallStart = Date.now();
                pb.dataStart = sharedHorizonRef.current;
            }
        },
        [sharedHorizonRef],
    );

    const setStepSize = useCallback(
        (s: string) => {
            const pb = pbRef.current;
            pb.stepSize = s;
            // Re-anchor the clock so changing step size mid-play continues from the
            // current horizon. Otherwise the accumulated step count is multiplied by
            // the new step size against a stale dataStart, jerking the horizon by
            // steps x (newStep − oldStep).
            if (pb.status === 'playing') {
                pb.wallStart = Date.now();
                pb.dataStart = sharedHorizonRef.current;
            }
            setUi((prev) => ({ ...prev, stepSize: s }));
        },
        [sharedHorizonRef],
    );

    const setMode = useCallback(
        (mode: PlaybackMode) => {
            const pb = pbRef.current;
            pb.mode = mode;
            // Re-anchor the clock so switching mode mid-play continues smoothly
            // from the current horizon instead of jumping.
            if (pb.status === 'playing') {
                pb.wallStart = Date.now();
                pb.dataStart = sharedHorizonRef.current;
            }
            setUi((prev) => ({ ...prev, mode }));
        },
        [sharedHorizonRef],
    );

    const setStepSnap = useCallback(
        (snap: boolean) => {
            const pb = pbRef.current;
            pb.stepSnap = snap;
            // Re-anchor so toggling mid-play continues from the current horizon
            // instead of recomputing steps against a stale dataStart.
            if (pb.status === 'playing') {
                pb.wallStart = Date.now();
                pb.dataStart = sharedHorizonRef.current;
            }
            setUi((prev) => ({ ...prev, stepSnap: snap }));
        },
        [sharedHorizonRef],
    );

    const scrub = useCallback(
        (t: bigint) => {
            if (pbRef.current.status === 'playing') pause();
            goTo(t);
        },
        [pause, goTo],
    );

    useEffect(() => () => stopLoop(), [stopLoop]);

    return {
        ui,
        notifyDataBounds,
        play,
        pause,
        stepForward,
        stepBack,
        jumpToStart,
        jumpToEnd,
        setSpeed,
        setStepSize,
        setMode,
        setStepSnap,
        scrub,
        pbRef,
    } as const;
}
