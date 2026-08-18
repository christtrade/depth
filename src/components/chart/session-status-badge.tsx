import { useEffect, useRef, useState } from 'react';
import { Dot } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { cn } from '../../lib/utils';
import type { TradingSession } from '../../interfaces/IDataAdapter';
import type { TypedEventBus } from '../../core/TypedEventBus';
import { getSessionStatus, nextOpenNs, wallClock, type SessionStatus } from '../../core/SessionUtils';

// formatting helpers

function parseHoursRange(hours: string): { openMin: number; closeMin: number } | null {
    const m = hours.match(/^(\d{2})(\d{2})-(\d{2})(\d{2})$/);
    if (!m) return null;
    return {
        openMin: parseInt(m[1]) * 60 + parseInt(m[2]),
        closeMin: parseInt(m[3]) * 60 + parseInt(m[4]),
    };
}

function fmtMinOfDay(min: number): string {
    const h = Math.floor(min / 60) % 24;
    const m = min % 60;
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${h12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function fmtSessionHours(hours: string): string {
    if (hours === '24/7' || hours === 'always') return '24 / 7';
    const p = parseHoursRange(hours);
    return p ? `${fmtMinOfDay(p.openMin)} – ${fmtMinOfDay(p.closeMin)}` : hours;
}

function fmtTimezone(tz: string): string {
    try {
        const abbr =
            new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
                .formatToParts(new Date())
                .find((p) => p.type === 'timeZoneName')?.value ?? '';
        const city = tz.split('/').pop()?.replace(/_/g, ' ') ?? tz;
        return abbr ? `${city} (${abbr})` : city;
    } catch {
        return tz;
    }
}

const ALL_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

function fmtDays(days: string[]): string {
    if (days.length === 7) return 'Every day';
    if (days.join(',') === WEEKDAYS.join(',')) return 'Mon – Fri';
    return days.join(', ');
}

function isAlwaysOpen(session: TradingSession | null): boolean {
    return !session || session.hours === '24/7' || session.hours === 'always';
}

function fmtDuration(ms: number): string {
    const totalMins = Math.floor(ms / 60_000);
    const h = Math.floor(totalMins / 60);
    const m = totalMins % 60;
    if (h === 0) return `${m}m`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
}


export function SessionTimeline({
    session,
    nowMs,
}: {
    session: TradingSession | null;
    nowMs: number;
}) {
    const alwaysOpen = isAlwaysOpen(session);
    const tz = session?.timezone ?? 'UTC';
    const TOTAL = 1440;

    const nowNs = BigInt(nowMs) * 1_000_000n;
    const w = wallClock(nowNs, tz);
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
    const tradingDays = session?.days ?? (alwaysOpen ? ALL_DAYS : WEEKDAYS);

    const todayName = dayNames[w.dayOfWeek];
    const isHolidayToday = session?.holidays?.includes(w.isoDate) ?? false;
    const isTradingDay = !isHolidayToday && tradingDays.includes(todayName);

    const yw = wallClock(nowNs - 86_400_000_000_000n, tz);
    const isHolidayYesterday = session?.holidays?.includes(yw.isoDate) ?? false;
    const wasYesterdayTradingDay =
        !isHolidayYesterday && tradingDays.includes(dayNames[yw.dayOfWeek]);

    const todayCorrection = session?.corrections?.find((c) => c.date === w.isoDate) ?? null;
    const effectiveHours = alwaysOpen
        ? '24/7'
        : (todayCorrection?.hours ?? session!.hours);

    let nowMin: number | null = null;
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false,
        }).formatToParts(new Date(nowMs || Date.now()));
        const h = parseInt(parts.find((x) => x.type === 'hour')?.value ?? '0');
        const m = parseInt(parts.find((x) => x.type === 'minute')?.value ?? '0');
        nowMin = (h === 24 ? 0 : h) * 60 + m;
    } catch { /* ignore */ }

    const pct = (min: number) => `${((min / TOTAL) * 100).toFixed(2)}%`;
    const renderBlock = (left: number, right: number, color: string, key: string) => (
        <div
            key={key}
            className="absolute top-0 bottom-0"
            style={{ left: pct(left), width: `${(((right - left) / TOTAL) * 100).toFixed(2)}%`, backgroundColor: color }}
        />
    );

    const mainRange = alwaysOpen ? null : parseHoursRange(effectiveHours);
    const isOvernightSession = mainRange ? mainRange.closeMin <= mainRange.openMin : false;
    const hasYesterdayBleed = isOvernightSession && wasYesterdayTradingDay && !isHolidayToday && (mainRange?.closeMin ?? 0) > 0;
    const hasAnyOpenToday = (alwaysOpen && !isHolidayToday) || isTradingDay || hasYesterdayBleed;

    const alwaysSegment =
        alwaysOpen && !isHolidayToday ? renderBlock(0, TOTAL, '#3b82f6', 'always') : null;

    const mainSegments = [];
    if (mainRange && !isHolidayToday) {
        if (isOvernightSession) {
            if (isTradingDay) mainSegments.push(renderBlock(mainRange.openMin, TOTAL, '#3b82f6', 'main-open'));
            if (hasYesterdayBleed) mainSegments.push(renderBlock(0, mainRange.closeMin, '#3b82f6', 'main-yest'));
        } else if (isTradingDay) {
            mainSegments.push(renderBlock(mainRange.openMin, mainRange.closeMin, '#3b82f6', 'main'));
        }
    }

    const subSegments = [];
    if (!isHolidayToday && session?.subsessions) {
        for (let i = 0; i < session.subsessions.length; i++) {
            const sub = session.subsessions[i];
            const p = parseHoursRange(sub.hours);
            if (!p) continue;
            const subDays = sub.days ?? tradingDays;
            const subIsOvernight = p.closeMin <= p.openMin;
            if (subIsOvernight) {
                if (subDays.includes(todayName)) subSegments.push(renderBlock(p.openMin, TOTAL, 'rgb(245 158 11)', `sub-${i}-open`));
                if (p.closeMin > 0 && subDays.includes(dayNames[yw.dayOfWeek])) subSegments.push(renderBlock(0, p.closeMin, 'rgb(245 158 11)', `sub-${i}-yest`));
            } else if (subDays.includes(todayName)) {
                subSegments.push(renderBlock(p.openMin, p.closeMin, 'rgb(245 158 11)', `sub-${i}`));
            }
        }
    }

    return (
        <div className="px-3 pt-2.5 pb-3 space-y-2">
            <div className="relative h-4">
                <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full overflow-hidden bg-muted/50">
                    {alwaysSegment}
                    {subSegments}
                    {mainSegments}
                </div>
                {nowMin !== null && (
                    <div className="absolute top-0 bottom-0 w-px rounded-full bg-foreground/50" style={{ left: pct(nowMin) }} />
                )}
            </div>

            <div className="space-y-0.5">
                {isHolidayToday ? (
                    <div className="text-[10px] font-medium text-amber-500/80">Holiday – closed</div>
                ) : alwaysOpen ? (
                    <div className="text-[10px] font-medium tabular-nums text-foreground/80">
                        Open {fmtSessionHours('24/7')}
                    </div>
                ) : !hasAnyOpenToday ? (
                    <div className="text-[10px] font-medium text-muted-foreground">No session today</div>
                ) : isTradingDay && mainRange ? (
                    <div className="text-[10px] font-medium tabular-nums text-foreground/80">
                        {fmtMinOfDay(mainRange.openMin)} – {fmtMinOfDay(mainRange.closeMin)}
                        {todayCorrection && <span className="ml-1.5 text-amber-500/80 font-normal">(modified)</span>}
                    </div>
                ) : hasYesterdayBleed && mainRange ? (
                    <div className="text-[10px] font-medium tabular-nums text-foreground/60">
                        Closes {fmtMinOfDay(mainRange.closeMin)}
                    </div>
                ) : null}
                <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                    <span>{fmtTimezone(tz)}</span>
                    <Dot className="-mx-2" />
                    <span>{fmtDays(tradingDays)}</span>
                </div>
            </div>

            {(session?.subsessions?.length ?? 0) > 0 && (
                <div className="space-y-1 pt-1.5 border-t border-border/40">
                    {session!.subsessions!.map((sub) => (
                        <div key={sub.id} className="flex items-center justify-between">
                            <div className="flex items-center gap-1.5">
                                <div className="w-1.5 h-1.5 rounded-full bg-amber-500/60 shrink-0" />
                                <span className="text-[10px] text-muted-foreground">{sub.label}</span>
                            </div>
                            <span className="text-[10px] tabular-nums text-muted-foreground/80">
                                {fmtSessionHours(sub.hours)}
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

export function SessionStatusBadge({
    eventBus,
    session,
    horizon,
    sessionStatus: statusProp,
    symbol,
}: {
    eventBus: TypedEventBus;
    session: TradingSession | null;
    horizon: bigint;
    sessionStatus: SessionStatus;
    symbol?: string;
}) {
    const [open, setOpen] = useState(false);
    const [nowMs, setNowMs] = useState(() => Number(horizon / 1_000_000n));
    const nowMsRef = useRef(horizon);
    const [status, setStatus] = useState<SessionStatus>(statusProp);

    useEffect(() => eventBus.on('playback:seek', ({ tNs }) => { nowMsRef.current = tNs; }), [eventBus]);
    useEffect(
        () =>
            eventBus.on('session:status', (s) => {
                if (s.symbol !== undefined && symbol !== undefined && s.symbol !== symbol) return;
                setStatus(s);
            }),
        [eventBus, symbol],
    );

    useEffect(() => {
        if (!session || session.hours === '24/7' || session.hours === 'always') return;
        const tick = () => {
            setNowMs(Number(nowMsRef.current / 1_000_000n));
            setStatus(getSessionStatus(session, nowMsRef.current));
        };
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
    }, [session]);

    useEffect(() => {
        if (!open) return;
        setNowMs(Number(nowMsRef.current / 1_000_000n));
        const id = setInterval(() => setNowMs(Number(nowMsRef.current / 1_000_000n)), 33);
        return () => clearInterval(id);
    }, [open]);

    if (!status) return null;

    const dotColor = status.kind === 'open' || status.kind === 'always' ? '#22c55e' : status.kind === 'sub' ? '#f59e0b' : '#6b7280';
    const label = status.kind === 'open' || status.kind === 'always' ? 'Open' : status.kind === 'sub' ? status.label : 'Closed';
    const isClosed = status.kind === 'closed';
    const isOpen = status.kind === 'open' || status.kind === 'always';
    const isSub = status.kind === 'sub';

    let timeUntilOpen: string | null = null;
    if (isClosed && session && session.hours !== '24/7' && session.hours !== 'always') {
        try {
            const nowNs = BigInt(nowMs) * 1_000_000n;
            const nextNs = nextOpenNs(session, nowNs);
            const diffMs = Number((nextNs - nowNs) / 1_000_000n);
            if (diffMs > 0) timeUntilOpen = fmtDuration(diffMs);
        } catch { /* ignore */ }
    }

    const subtitle = isClosed && timeUntilOpen
        ? `Opens in ${timeUntilOpen}`
        : isOpen ? 'Regular session'
        : isSub ? 'Extended hours'
        : null;

    return (
        <div className="flex items-center mx-2">
            <Popover open={open} onOpenChange={setOpen}>
                <PopoverTrigger asChild>
                    <button
                        className="w-2 h-2 rounded-full shrink-0 cursor-pointer focus:outline-none group relative"
                        style={{ backgroundColor: dotColor }}
                    >
                        <div
                            className={cn(
                                'absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-4 h-4 rounded-full',
                                !open && 'opacity-0 group-hover:opacity-100',
                            )}
                            style={{ backgroundColor: dotColor + '44' }}
                        />
                    </button>
                </PopoverTrigger>
                <PopoverContent className="w-72 p-0 overflow-hidden text-xs" align="start" sideOffset={8}>
                    <div className="flex items-center gap-2.5 px-3 py-2.5 border-b border-border/60">
                        <div className="w-2 h-2 rounded-full shrink-0 mt-px" style={{ backgroundColor: dotColor }} />
                        <div>
                            <div className="font-medium text-foreground leading-tight">{label}</div>
                            {subtitle && (
                                <div className="text-muted-foreground text-[10px] mt-0.5 leading-tight">{subtitle}</div>
                            )}
                        </div>
                    </div>
                    <SessionTimeline session={session} nowMs={nowMs} />
                </PopoverContent>
            </Popover>
        </div>
    );
}
