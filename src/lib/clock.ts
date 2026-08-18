export type Clock = {
    wallStart: number; // Date.now() when playback began
    dataStart: bigint; // ts_event of first tick (nanoseconds)
    speed: number;
};

export function createClock(dataStart: bigint, speed: number): Clock {
    return { wallStart: Date.now(), dataStart, speed };
}

export function getCurrentDataTime(clock: Clock): bigint {
    const elapsed = BigInt(Date.now() - clock.wallStart) * BigInt(1_000_000); // ms -> ns
    return clock.dataStart + elapsed * BigInt(clock.speed);
}
