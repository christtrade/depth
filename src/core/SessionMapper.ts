// converts between real UTC nanoseconds and "market nanoseconds" - a compressed
// timeline with the closed-session windows taken out.
//
// built once over a time range (the loaded dataset plus a buffer) and rebuilt
// when the session or the data range changes.
//
// tsToMarket -> position in market-ns space, monotonically increasing
// marketToTs -> back to real UTC ns
// tsToX / xToTs -> pixel helpers wrapping those

import type { TradingSession } from '../interfaces/IDataAdapter';
import { isMarketOpenFromWC, wallClock } from './SessionUtils';

const NS_PER_MIN = 60_000_000_000n;

export interface SessionSegment {
    /** Real UTC ns start of this open window */
    realStart: bigint;
    /** Real UTC ns end (exclusive) */
    realEnd: bigint;
    /** Market-ns offset at realStart */
    marketStart: bigint;
    /** Duration of this open window in market-ns (= realEnd - realStart) */
    duration: bigint;
}

export class SessionMapper {
    public segments: SessionSegment[] = [];
    private totalMarketNs: bigint = 0n;
    /** Real ns range this mapper covers */
    rangeFrom: bigint = 0n;
    rangeTo: bigint = 0n;
    /** Bumped on every mutation, so LiveTransformer can spot a stale cache. */
    version: number = 0;

    // inner segment-building loop. uses a Number minute counter so the hot path
    // is integer math - BigInt only comes out when a segment object is created,
    // which happens about twice a trading day rather than every minute.
    private _buildSegments(
        session: TradingSession,
        from: bigint,
        to: bigint,
        marketOffset: bigint,
    ): { segments: SessionSegment[]; totalNs: bigint } {
        const fromMin = Number(from / NS_PER_MIN);
        const toMin = Number(to / NS_PER_MIN) + 1; // +1 so the closing edge gets checked

        let wc = wallClock(BigInt(fromMin) * NS_PER_MIN, session.timezone);
        let localMin = wc.minuteOfDay;
        let localDow = wc.dayOfWeek;
        let localIso = wc.isoDate;

        let inOpen = false;
        let windowStartMin = 0;
        const segments: SessionSegment[] = [];
        let offset = marketOffset;

        for (let m = fromMin; m <= toMin; m++) {
            const open = isMarketOpenFromWC(session, localMin, localDow, localIso);
            if (open && !inOpen) {
                windowStartMin = m < fromMin ? fromMin : m;
                inOpen = true;
            } else if (!open && inOpen) {
                const realStart = windowStartMin === fromMin ? from : BigInt(windowStartMin) * NS_PER_MIN;
                const realEnd = BigInt(m) * NS_PER_MIN;
                const dur = realEnd - realStart;
                segments.push({ realStart, realEnd, marketStart: offset, duration: dur });
                offset += dur;
                inOpen = false;
            }
            // advance the wall clock, only resyncing through Intl once an hour
            localMin++;
            if (localMin % 60 === 0) {
                wc = wallClock(BigInt(m + 1) * NS_PER_MIN, session.timezone);
                localMin = wc.minuteOfDay;
                localDow = wc.dayOfWeek;
                localIso = wc.isoDate;
            }
        }

        if (inOpen) {
            const realStart = windowStartMin === fromMin ? from : BigInt(windowStartMin) * NS_PER_MIN;
            const dur = to - realStart;
            if (dur > 0n) {
                segments.push({ realStart, realEnd: to, marketStart: offset, duration: dur });
                offset += dur;
            }
        }

        return { segments, totalNs: offset - marketOffset };
    }

    /** Build the mapper over a real-time range. Resolved to the minute. */
    build(session: TradingSession | null, from: bigint, to: bigint): void {
        this.rangeFrom = from;
        this.rangeTo = to;
        this.segments = [];
        this.totalMarketNs = 0n;
        this.version++;

        if (!session || session.hours === '24/7' || session.hours === 'always') {
            this.segments.push({
                realStart: from,
                realEnd: to,
                marketStart: 0n,
                duration: to - from,
            });
            this.totalMarketNs = to - from;
            return;
        }

        const { segments, totalNs } = this._buildSegments(session, from, to, 0n);
        this.segments = segments;
        this.totalMarketNs = totalNs;
    }

    /**
     * Extend the mapper backward to cover `newFrom` up to the current start.
     * Only walks the new range, and shifts every existing segment's marketStart
     * to account for the history prepended in front of it.
     */
    extendBackward(session: TradingSession | null, newFrom: bigint): void {
        if (newFrom >= this.rangeFrom) return;
        this.version++;

        if (!session || session.hours === '24/7' || session.hours === 'always') {
            const additionalDuration = this.rangeFrom - newFrom;
            if (this.segments.length === 1) {
                // extend the one segment and shift its marketStart
                const seg = this.segments[0];
                this.segments[0] = {
                    realStart: newFrom,
                    realEnd: seg.realEnd,
                    marketStart: 0n,
                    duration: seg.duration + additionalDuration,
                };
            } else {
                for (const seg of this.segments) seg.marketStart += additionalDuration;
                this.segments.unshift({
                    realStart: newFrom,
                    realEnd: this.rangeFrom,
                    marketStart: 0n,
                    duration: additionalDuration,
                });
            }
            this.totalMarketNs += additionalDuration;
            this.rangeFrom = newFrom;
            return;
        }

        const { segments: newSegs, totalNs } = this._buildSegments(session, newFrom, this.rangeFrom, 0n);

        // shift every existing marketStart by the new range's market time
        for (const seg of this.segments) seg.marketStart += totalNs;

        this.segments = [...newSegs, ...this.segments];
        this.totalMarketNs += totalNs;
        this.rangeFrom = newFrom;
    }

    get hasSession(): boolean {
        return (
            this.segments.length > 1 ||
            (this.segments.length === 1 && this.segments[0].realStart > this.rangeFrom)
        );
    }

    /**
     * The open window containing `ts`, or null when it lands in a closed one or
     * outside the built range.
     *
     * Exposed because bar buckets are anchored to the session open: which bar a
     * timestamp falls in is answered from the segment's start rather than an
     * epoch multiple, and several places need to answer it the same way.
     */
    segmentAt(ts: bigint): SessionSegment | null {
        let lo = 0;
        let hi = this.segments.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            const seg = this.segments[mid];
            if (ts >= seg.realEnd) lo = mid + 1;
            else if (ts < seg.realStart) hi = mid - 1;
            else return seg;
        }
        return null;
    }

    /** Real UTC ns to market ns, snapping a closed window to the nearest edge. */
    tsToMarket(ts: bigint): bigint {
        if (this.segments.length === 0) return ts;
        if (this.segments.length === 1 && !this.hasSession) return ts - this.rangeFrom;

        // binary search for the containing segment
        let lo = 0,
            hi = this.segments.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            const seg = this.segments[mid];
            if (ts >= seg.realEnd) {
                lo = mid + 1;
            } else if (ts < seg.realStart) {
                hi = mid - 1;
            } else {
                // inside this one
                return seg.marketStart + (ts - seg.realStart);
            }
        }

        // closed window, so snap to the nearest boundary
        if (lo >= this.segments.length) {
            // past the last segment, so extrapolate 1:1 and panning beyond the
            // built range still works
            const last = this.segments[this.segments.length - 1];
            return last.marketStart + last.duration + (ts - last.realEnd);
        }
        if (lo === 0) {
            const first = this.segments[0];
            return first.marketStart - (first.realStart - ts);
        }
        // between two segments, so snap to whichever boundary is closer
        const prev = this.segments[lo - 1];
        const next = this.segments[lo];
        const distPrev = ts - prev.realEnd;
        const distNext = next.realStart - ts;
        if (distPrev <= distNext) {
            return prev.marketStart + prev.duration;
        } else {
            return next.marketStart;
        }
    }

    /** Market ns back to real UTC ns. */
    marketToTs(market: bigint): bigint {
        if (this.segments.length === 0) return this.rangeFrom + market;
        if (this.segments.length === 1 && !this.hasSession) return this.rangeFrom + market;

        let lo = 0,
            hi = this.segments.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            const seg = this.segments[mid];
            const segEnd = seg.marketStart + seg.duration;
            if (market >= segEnd) {
                lo = mid + 1;
            } else if (market < seg.marketStart) {
                hi = mid - 1;
            } else {
                return seg.realStart + (market - seg.marketStart);
            }
        }

        // out of range, so extrapolate 1:1 outside the sessions
        if (lo >= this.segments.length) {
            const last = this.segments[this.segments.length - 1];
            return last.realEnd + (market - (last.marketStart + last.duration));
        }
        const first = this.segments[0];
        return first.realStart - (first.marketStart - market);
    }

    getBreaks(): { ts: bigint; type: string }[] {
        return this.segments.map((s) => ({
            ts: s.realStart,
            type: 'break ig something idk this is just a placeholder',
        }));
    }

    /** The market span a real [from, to] range covers. */
    realSpanToMarketSpan(from: bigint, to: bigint): bigint {
        return this.tsToMarket(to) - this.tsToMarket(from);
    }

    /** A real ts to a pixel x in [0, chartW]. tMin/tMax are real ns view bounds. */
    tsToX(ts: bigint, tMin: bigint, tMax: bigint, chartW: number): number {
        if (this.segments.length === 0) {
            return (Number(ts - tMin) / Number(tMax - tMin)) * chartW;
        }
        const mMin = this.tsToMarket(tMin);
        const mMax = this.tsToMarket(tMax);
        const mTs = this.tsToMarket(ts);
        const span = Number(mMax - mMin);
        if (span === 0) return 0;
        return (Number(mTs - mMin) / span) * chartW;
    }

    /** And back: a pixel x in [0, chartW] to real UTC ns. */
    xToTs(x: number, tMin: bigint, tMax: bigint, chartW: number): bigint {
        if (this.segments.length === 0) {
            return tMin + BigInt(Math.round((x / chartW) * Number(tMax - tMin)));
        }
        const mMin = this.tsToMarket(tMin);
        const mMax = this.tsToMarket(tMax);
        const span = Number(mMax - mMin);
        if (span === 0) return tMin;
        const mPos = mMin + BigInt(Math.round((x / chartW) * span));
        return this.marketToTs(mPos);
    }
}

// one per chart instance, passed down through context/props
export function createSessionMapper(): SessionMapper {
    return new SessionMapper();
}
