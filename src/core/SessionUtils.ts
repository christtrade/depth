// pure session math, no i/o or side effects. everything is in nanoseconds
// unless noted.

import type { TradingSession, DayOfWeek, SessionCorrection } from '../interfaces/IDataAdapter';

// Constants
const NS_PER_MS = 1_000_000n;
const NS_PER_MIN = 60_000_000_000n;
const NS_PER_DAY = 86_400_000_000_000n;

const DEFAULT_DAYS: DayOfWeek[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

// Formatter cache
const _fmtCache = new Map<string, Intl.DateTimeFormat>();
const _dowCache = new Map<string, Intl.DateTimeFormat>();

function getDateFmt(tz: string): Intl.DateTimeFormat {
    let f = _fmtCache.get(tz);
    if (!f) {
        f = new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        });
        _fmtCache.set(tz, f);
    }
    return f;
}

function getDowFmt(tz: string): Intl.DateTimeFormat {
    let f = _dowCache.get(tz);
    if (!f) {
        f = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
        _dowCache.set(tz, f);
    }
    return f;
}

// Internal helpers
// 'HHMM' -> minutes since midnight
function parseHHMM(s: string): number {
    const h = parseInt(s.slice(0, 2), 10);
    const m = parseInt(s.slice(2, 4), 10);
    return h * 60 + m;
}

// 'HHMM-HHMM' -> { openMin, closeMin, overnight }
function parseRange(hours: string): { openMin: number; closeMin: number; overnight: boolean } {
    const [openStr, closeStr] = hours.split('-');
    const openMin = parseHHMM(openStr);
    const closeMin = parseHHMM(closeStr);
    return { openMin, closeMin, overnight: closeMin <= openMin };
}

/**
 * The wall-clock date/time a UTC ns timestamp lands on in an IANA timezone.
 * Month is 1-based, dayOfWeek is 0=Sun.
 */
export function wallClock(ns: bigint, tz: string) {
    const ms = Number(ns / NS_PER_MS);
    const fmt = getDateFmt(tz);
    const parts = Object.fromEntries(fmt.formatToParts(ms).map((p) => [p.type, p.value]));
    const hour = parseInt(parts.hour, 10) % 24;
    const minute = parseInt(parts.minute, 10);
    const dowStr = getDowFmt(tz).format(ms);
    const dowMap: Record<string, number> = {
        Sun: 0,
        Mon: 1,
        Tue: 2,
        Wed: 3,
        Thu: 4,
        Fri: 5,
        Sat: 6,
    };
    return {
        year: parseInt(parts.year, 10),
        month: parseInt(parts.month, 10),
        day: parseInt(parts.day, 10),
        dayOfWeek: dowMap[dowStr] ?? 0,
        minuteOfDay: hour * 60 + minute,
        isoDate: `${parts.year}-${parts.month}-${parts.day}`,
    };
}

// isMarketOpen off pre-computed wall-clock fields, to keep Intl out of tight loops
export function isMarketOpenFromWC(
    session: TradingSession,
    minuteOfDay: number,
    dayOfWeek: number,
    isoDate: string,
): boolean {
    const h = session.hours;
    if (h === '24/7' || h === 'always') return true;

    if (isHoliday(isoDate, session.holidays)) return false;

    const correction = findCorrection(isoDate, session.corrections);
    const { openMin, closeMin, overnight } = parseRange(correction ? correction.hours : h);

    const days = session.days ?? DEFAULT_DAYS;
    const dayNames: DayOfWeek[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const todayName = dayNames[dayOfWeek];

    if (overnight) {
        const yesterdayName = dayNames[(dayOfWeek + 6) % 7];
        const todayActive = days.includes(todayName) && minuteOfDay >= openMin;
        const yesterdayActive = days.includes(yesterdayName) && minuteOfDay < closeMin;
        return todayActive || yesterdayActive;
    }
    return days.includes(todayName) && minuteOfDay >= openMin && minuteOfDay < closeMin;
}

// is this 'YYYY-MM-DD' a holiday in the session
function isHoliday(isoDate: string, holidays?: string[]): boolean {
    if (!holidays || holidays.length === 0) return false;
    return holidays.includes(isoDate);
}

// a correction for that ISO date, if theres one
function findCorrection(
    isoDate: string,
    corrections?: SessionCorrection[],
): SessionCorrection | null {
    return corrections?.find((c) => c.date === isoDate) ?? null;
}

// Session status
export type SessionStatus =
    | { kind: 'always' }              // 24/7 - no session concept
    | { kind: 'open' }                // main session is open
    | { kind: 'sub'; label: string }  // named subsession (pre/post market, etc.)
    | { kind: 'closed' };             // fully closed

/**
 * Market status at a UTC ns timestamp. Checks the main session first, then any
 * named subsessions (pre/post market and so on).
 */
export function getSessionStatus(
    session: TradingSession | null,
    atNs: bigint,
): SessionStatus {
    if (!session || session.hours === '24/7' || session.hours === 'always') {
        return { kind: 'always' };
    }

    const w = wallClock(atNs, session.timezone);

    if (isMarketOpenFromWC(session, w.minuteOfDay, w.dayOfWeek, w.isoDate)) {
        return { kind: 'open' };
    }

    if (session.subsessions) {
        for (const sub of session.subsessions) {
            const subSession: TradingSession = {
                hours: sub.hours,
                timezone: session.timezone,
                days: sub.days ?? session.days,
            };
            if (isMarketOpenFromWC(subSession, w.minuteOfDay, w.dayOfWeek, w.isoDate)) {
                return { kind: 'sub', label: sub.label };
            }
        }
    }

    return { kind: 'closed' };
}

// matches the shape on TypedEventBus
export interface SessionWindow {
    from: bigint;
    to: bigint;
}

/** Is the market open at this UTC ns timestamp? */
export function isMarketOpen(session: TradingSession, atNs: bigint): boolean {
    const h = session.hours;
    if (h === '24/7' || h === 'always') return true;

    const tz = session.timezone;
    const w = wallClock(atNs, tz);

    // holidays
    if (isHoliday(w.isoDate, session.holidays)) return false;

    // corrections
    const correction = findCorrection(w.isoDate, session.corrections);
    const { openMin, closeMin, overnight } = parseRange(correction ? correction.hours : h);

    const days = session.days ?? DEFAULT_DAYS;
    const dayNames: DayOfWeek[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const todayName = dayNames[w.dayOfWeek];

    if (overnight) {
        // open if today is a trading day and were past openMin, or yesterday was
        // and were still before closeMin
        const yesterdayName = dayNames[(w.dayOfWeek + 6) % 7];
        const todayActive = days.includes(todayName) && w.minuteOfDay >= openMin;
        const yesterdayActive = days.includes(yesterdayName) && w.minuteOfDay < closeMin;
        return todayActive || yesterdayActive;
    } else {
        return days.includes(todayName) && w.minuteOfDay >= openMin && w.minuteOfDay < closeMin;
    }
}

/**
 * Clip a UTC ns range into the open market windows inside it, ascending.
 * Closed windows are dropped, and a 24/7 session returns the range as one
 * window. Resolved to the minute.
 */
export function clipToSession(session: TradingSession, from: bigint, to: bigint): SessionWindow[] {
    if (session.hours === '24/7' || session.hours === 'always') {
        return [{ from, to }];
    }

    const windows: SessionWindow[] = [];
    const STEP = NS_PER_MIN;

    // snap from down to the nearest minute
    const start = (from / STEP) * STEP;
    const end = to;

    let windowStart: bigint | null = null;
    let cursor = start;

    while (cursor <= end) {
        const open = isMarketOpen(session, cursor);
        if (open && windowStart === null) {
            windowStart = cursor < from ? from : cursor;
        } else if (!open && windowStart !== null) {
            windows.push({ from: windowStart, to: cursor });
            windowStart = null;
        }
        cursor += STEP;
    }

    if (windowStart !== null) {
        windows.push({ from: windowStart, to: end });
    }

    return windows;
}

/** Next market open at or after `fromNs`, or `fromNs` if it's already open. */
export function nextOpenNs(session: TradingSession, fromNs: bigint): bigint {
    if (session.hours === '24/7' || session.hours === 'always') return fromNs;
    if (isMarketOpen(session, fromNs)) return fromNs;

    let cursor = (fromNs / NS_PER_MIN) * NS_PER_MIN + NS_PER_MIN;
    const limit = fromNs + NS_PER_DAY * 8n; // give up after 8 days
    while (cursor < limit) {
        if (isMarketOpen(session, cursor)) return cursor;
        cursor += NS_PER_MIN;
    }
    return cursor;
}

/** Most recent close before `fromNs`, or `fromNs` if the market is open. */
export function prevCloseNs(session: TradingSession, fromNs: bigint): bigint {
    if (session.hours === '24/7' || session.hours === 'always') return fromNs;
    if (!isMarketOpen(session, fromNs)) return fromNs;

    let cursor = (fromNs / NS_PER_MIN) * NS_PER_MIN;
    const limit = fromNs - NS_PER_DAY * 8n;
    while (cursor > limit) {
        if (!isMarketOpen(session, cursor)) return cursor;
        cursor -= NS_PER_MIN;
    }
    return cursor;
}

/**
 * Walk backward from `fromNs` by `targetDuration` of market-open time, skipping
 * closed windows, so the real span returned covers exactly that much trading.
 *
 * On a Sun 6pm - Fri 5pm ET session, walking back one market hour from Sunday
 * 10pm ET lands on Friday 4pm ET.
 */
export function walkBackMarketNs(
    session: TradingSession | null,
    fromNs: bigint,
    targetMarketNs: bigint,
): bigint {
    if (!session || session.hours === '24/7' || session.hours === 'always') {
        return fromNs - targetMarketNs;
    }

    // has to be positive - clamp if viewMin - lookback underflowed
    if (targetMarketNs <= 0n) return fromNs;

    let remaining = targetMarketNs;
    let cursor = (fromNs / NS_PER_MIN) * NS_PER_MIN;
    const limit = fromNs - NS_PER_DAY * 14n; // 14 days hard cap

    while (remaining > 0n && cursor > limit) {
        if (isMarketOpen(session, cursor)) {
            // how far back we can go while still open. scan forward to find the
            // block boundary, then skip the whole block at once.
            const blockEnd = cursor;
            let blockStart = cursor;
            while (blockStart > limit && isMarketOpen(session, blockStart - NS_PER_MIN)) {
                blockStart -= NS_PER_MIN;
            }
            const blockDuration = blockEnd - blockStart + NS_PER_MIN;
            if (blockDuration >= remaining) {
                // target is inside this open block
                return cursor - remaining + NS_PER_MIN;
            }
            remaining -= blockDuration;
            cursor = blockStart - NS_PER_MIN;
        } else {
            // skip back to the previous open boundary, in 60-minute chunks
            const CLOSED_SKIP = NS_PER_MIN * 30n;
            cursor -= CLOSED_SKIP;
            // then step back to the minute boundary of the next open
            while (cursor > limit && !isMarketOpen(session, cursor)) {
                cursor -= NS_PER_MIN;
            }
        }
    }

    return cursor > limit ? cursor : limit;
}
