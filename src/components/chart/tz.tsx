'use client';

import { useState, useRef, useEffect, useCallback, useMemo, KeyboardEvent } from 'react';
import { Check, ChevronDown, Search, Globe, X } from 'lucide-react';
import { cn } from '../../lib/utils';

interface TimezoneEntry {
    value: string;
    label: string;
    region: string;
    aliases?: string[];
}

const TIMEZONE_LIST: TimezoneEntry[] = [
    {
        value: 'America/New_York',
        label: 'New York',
        region: 'Americas',
        aliases: ['ET', 'EST', 'EDT', 'Eastern'],
    },
    {
        value: 'America/Chicago',
        label: 'Chicago',
        region: 'Americas',
        aliases: ['CT', 'CST', 'CDT', 'Central'],
    },
    {
        value: 'America/Denver',
        label: 'Denver',
        region: 'Americas',
        aliases: ['MT', 'MST', 'MDT', 'Mountain'],
    },
    {
        value: 'America/Los_Angeles',
        label: 'Los Angeles',
        region: 'Americas',
        aliases: ['PT', 'PST', 'PDT', 'Pacific'],
    },
    { value: 'America/Anchorage', label: 'Anchorage', region: 'Americas', aliases: ['AKT'] },
    {
        value: 'America/Honolulu',
        label: 'Honolulu',
        region: 'Americas',
        aliases: ['HST', 'Hawaii'],
    },
    { value: 'America/Toronto', label: 'Toronto', region: 'Americas', aliases: ['ET', 'Eastern'] },
    {
        value: 'America/Vancouver',
        label: 'Vancouver',
        region: 'Americas',
        aliases: ['PT', 'Pacific'],
    },
    {
        value: 'America/Sao_Paulo',
        label: 'São Paulo',
        region: 'Americas',
        aliases: ['BRT', 'Brazil'],
    },
    { value: 'America/Mexico_City', label: 'Mexico City', region: 'Americas', aliases: ['CST'] },
    {
        value: 'America/Buenos_Aires',
        label: 'Buenos Aires',
        region: 'Americas',
        aliases: ['ART', 'Argentina'],
    },

    { value: 'UTC', label: 'UTC', region: 'Other', aliases: ['GMT', 'Universal'] },
    { value: 'Europe/London', label: 'London', region: 'Europe', aliases: ['GMT', 'BST'] },
    {
        value: 'Europe/Stockholm',
        label: 'Stockholm',
        region: 'Europe',
        aliases: ['CET', 'CEST', 'Sweden'],
    },
    { value: 'Europe/Paris', label: 'Paris', region: 'Europe', aliases: ['CET', 'CEST'] },
    {
        value: 'Europe/Frankfurt',
        label: 'Frankfurt',
        region: 'Europe',
        aliases: ['CET', 'CEST', 'Germany'],
    },
    { value: 'Europe/Amsterdam', label: 'Amsterdam', region: 'Europe', aliases: ['CET'] },
    { value: 'Europe/Zurich', label: 'Zurich', region: 'Europe', aliases: ['CET', 'Switzerland'] },
    { value: 'Europe/Moscow', label: 'Moscow', region: 'Europe', aliases: ['MSK', 'Russia'] },
    { value: 'Europe/Istanbul', label: 'Istanbul', region: 'Europe', aliases: ['TRT', 'Turkey'] },
    {
        value: 'Europe/Helsinki',
        label: 'Helsinki',
        region: 'Europe',
        aliases: ['EET', 'EEST', 'Finland'],
    },
    { value: 'Europe/Warsaw', label: 'Warsaw', region: 'Europe', aliases: ['CET', 'Poland'] },
    { value: 'Europe/Madrid', label: 'Madrid', region: 'Europe', aliases: ['CET', 'Spain'] },
    { value: 'Europe/Rome', label: 'Rome', region: 'Europe', aliases: ['CET', 'Italy'] },

    { value: 'Asia/Dubai', label: 'Dubai', region: 'Asia-Pacific', aliases: ['GST', 'UAE'] },
    { value: 'Asia/Kolkata', label: 'Mumbai', region: 'Asia-Pacific', aliases: ['IST', 'India'] },
    { value: 'Asia/Singapore', label: 'Singapore', region: 'Asia-Pacific', aliases: ['SGT'] },
    { value: 'Asia/Hong_Kong', label: 'Hong Kong', region: 'Asia-Pacific', aliases: ['HKT'] },
    {
        value: 'Asia/Shanghai',
        label: 'Shanghai',
        region: 'Asia-Pacific',
        aliases: ['CST', 'China', 'Beijing'],
    },
    { value: 'Asia/Tokyo', label: 'Tokyo', region: 'Asia-Pacific', aliases: ['JST', 'Japan'] },
    { value: 'Asia/Seoul', label: 'Seoul', region: 'Asia-Pacific', aliases: ['KST', 'Korea'] },
    { value: 'Asia/Taipei', label: 'Taipei', region: 'Asia-Pacific', aliases: ['CST', 'Taiwan'] },
    {
        value: 'Australia/Sydney',
        label: 'Sydney',
        region: 'Asia-Pacific',
        aliases: ['AEST', 'AEDT', 'Australia'],
    },
    {
        value: 'Australia/Melbourne',
        label: 'Melbourne',
        region: 'Asia-Pacific',
        aliases: ['AEST', 'AEDT'],
    },
    {
        value: 'Pacific/Auckland',
        label: 'Auckland',
        region: 'Asia-Pacific',
        aliases: ['NZST', 'New Zealand'],
    },
];

const REGION_ORDER = ['Americas', 'Europe', 'Asia-Pacific', 'Other'] as const;

function getUtcOffset(tz: string, horizon: bigint): string {
    try {
        const date = new Date(Number(horizon / 1_000_000n));

        const parts = new Intl.DateTimeFormat('en', {
            timeZone: tz,
            timeZoneName: 'shortOffset',
        }).formatToParts(date);

        const off = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
        return off.replace('GMT', '') || 'UTC';
    } catch {
        return '';
    }
}

function getSelectedLabel(tz: string, horizon: bigint): { label: string; offset: string } {
    const entry = TIMEZONE_LIST.find((t) => t.value === tz);
    const label = entry?.label ?? tz;
    const offset = getUtcOffset(tz, horizon);
    return { label, offset };
}

interface TimezoneSelectProps {
    value: string;
    onChange: (tz: string) => void;
    use24Hour?: boolean;
    onOpenChange?: (open: boolean) => void;
    compact?: boolean;
    horizon: bigint;
}

export function TimezoneSelect({
    value,
    onChange,
    use24Hour = true,
    onOpenChange,
    compact = false,
    horizon = 0n,
}: TimezoneSelectProps) {
    const [open, setOpen] = useState(false);
    useEffect(() => {
        onOpenChange?.(open);
    }, [open]);
    const [query, setQuery] = useState('');
    const [focused, setFocused] = useState<string | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            if (!containerRef.current?.contains(e.target as Node)) {
                setOpen(false);
                setQuery('');
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open]);

    useEffect(() => {
        if (open) {
            setTimeout(() => searchRef.current?.focus(), 50);
            setFocused(value);
        }
    }, [open, value]);

    const filtered = useMemo(() => {
        const q = query.toLowerCase().trim();
        if (!q) return TIMEZONE_LIST;
        return TIMEZONE_LIST.filter(
            (tz) =>
                tz.label.toLowerCase().includes(q) ||
                tz.value.toLowerCase().includes(q) ||
                tz.region.toLowerCase().includes(q) ||
                (tz.aliases ?? []).some((a) => a.toLowerCase().includes(q)),
        );
    }, [query]);

    const grouped = useMemo(() => {
        const map = new Map<string, TimezoneEntry[]>();
        for (const region of REGION_ORDER) map.set(region, []);
        for (const tz of filtered) {
            map.get(tz.region)?.push(tz);
        }
        return map;
    }, [filtered]);

    const flatList = useMemo(() => filtered, [filtered]);

    const handleKeyDown = useCallback(
        (e: KeyboardEvent<HTMLInputElement>) => {
            if (!open) return;
            const idx = flatList.findIndex((t) => t.value === focused);

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                const next = flatList[Math.min(idx + 1, flatList.length - 1)];
                if (next) {
                    setFocused(next.value);
                    scrollIntoView(next.value);
                }
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                const prev = flatList[Math.max(idx - 1, 0)];
                if (prev) {
                    setFocused(prev.value);
                    scrollIntoView(prev.value);
                }
            } else if (e.key === 'Enter') {
                if (focused) {
                    onChange(focused);
                    setOpen(false);
                    setQuery('');
                }
            } else if (e.key === 'Escape') {
                setOpen(false);
                setQuery('');
            }
        },
        [open, flatList, focused, onChange],
    );

    const scrollIntoView = (tzValue: string) => {
        const el = listRef.current?.querySelector(`[data-tz="${tzValue}"]`);
        el?.scrollIntoView({ block: 'nearest' });
    };

    const { label: selectedLabel, offset: selectedOffset } = getSelectedLabel(value, horizon);

    return (
        <div ref={containerRef} className="relative w-full select-none">
            <button
                onClick={() => setOpen((p) => !p)}
                className={cn(
                    'w-full flex items-center justify-between gap-2 rounded-lg border text-left transition-all',
                    compact ? 'h-7 px-2 text-[11px]' : 'px-3 py-2.5 text-[12px]',
                    open
                        ? 'border-blue-500/40 bg-blue-500/8 text-white ring-1 ring-blue-500/20'
                        : 'border-white/8 bg-white/3 text-white hover:border-white/15 hover:bg-white/5',
                )}
            >
                <div className="flex items-center gap-2 min-w-0">
                    <Globe size={compact ? 11 : 13} className="text-white/40 shrink-0" />
                    <span
                        className={cn(
                            'font-medium truncate',
                            compact ? 'text-[11px]' : 'text-[12px]',
                        )}
                    >
                        {selectedLabel}
                    </span>
                    <span className="text-[10px] font-mono text-white/30 shrink-0">
                        {selectedOffset || 'UTC'}
                    </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    {!compact && <LiveClock tz={value} use24Hour={use24Hour} horizon={horizon} />}
                    <ChevronDown
                        size={compact ? 11 : 13}
                        className={cn(
                            'text-white/30 transition-transform duration-150',
                            open && 'rotate-180',
                        )}
                    />
                </div>
            </button>

            {open && (
                <div
                    className={cn(
                        'absolute z-50 left-0 right-0',
                        compact ? 'bottom-full mb-1.5' : 'mt-1.5',
                        'rounded-xl border border-white/10 bg-[#1a1d23]',
                        'flex flex-col overflow-hidden',
                    )}
                    style={{ maxHeight: 320 }}
                >
                    <div className="flex items-center gap-2 px-3 py-2 border-b border-white/8 shrink-0">
                        <Search size={12} className="text-white/25 shrink-0" />
                        <input
                            ref={searchRef}
                            value={query}
                            onChange={(e) => {
                                setQuery(e.target.value);
                                setFocused(null);
                            }}
                            onKeyDown={handleKeyDown}
                            placeholder="Search timezone…"
                            className={cn(
                                'flex-1 bg-transparent text-[12px] text-white placeholder:text-white/25',
                                'outline-none border-none',
                            )}
                        />
                        {query && (
                            <button
                                onClick={() => setQuery('')}
                                className="text-white/25 hover:text-white/60 transition-colors"
                            >
                                <X size={11} />
                            </button>
                        )}
                    </div>

                    <div
                        ref={listRef}
                        className="overflow-y-auto overscroll-contain"
                        style={{ maxHeight: 268 }}
                    >
                        {flatList.length === 0 ? (
                            <div className="px-3 py-6 text-center text-[11px] text-white/25">
                                No timezones match "{query}"
                            </div>
                        ) : (
                            REGION_ORDER.map((region) => {
                                const entries = grouped.get(region) ?? [];
                                if (!entries.length) return null;
                                return (
                                    <div key={region}>
                                        <div className="sticky top-0 z-10 px-3 pt-2.5 pb-1 bg-[#1a1d23]">
                                            <span className="text-[9px] font-semibold uppercase tracking-widest text-white/20">
                                                {region}
                                            </span>
                                        </div>
                                        {entries.map((tz) => {
                                            const isSelected = tz.value === value;
                                            const isFocused = tz.value === focused;
                                            return (
                                                <button
                                                    key={tz.value}
                                                    data-tz={tz.value}
                                                    onClick={() => {
                                                        onChange(tz.value);
                                                        setOpen(false);
                                                        setQuery('');
                                                    }}
                                                    onMouseEnter={() => setFocused(tz.value)}
                                                    className={cn(
                                                        'w-full flex items-center justify-between gap-2 px-3 py-2 text-left transition-colors',
                                                        isSelected && 'text-white',
                                                        !isSelected && 'text-white/50',
                                                        isFocused &&
                                                            !isSelected &&
                                                            'bg-white/4 text-white/80',
                                                        isSelected && isFocused && 'bg-blue-500/10',
                                                        isSelected && !isFocused && 'bg-blue-500/6',
                                                    )}
                                                >
                                                    <div className="flex items-center gap-2.5 min-w-0">
                                                        <div className="w-3 shrink-0 flex justify-center">
                                                            {isSelected ? (
                                                                <Check
                                                                    size={11}
                                                                    className="text-blue-400"
                                                                />
                                                            ) : (
                                                                <span />
                                                            )}
                                                        </div>
                                                        <span className="text-[12px] truncate">
                                                            {tz.label}
                                                        </span>
                                                        <span className="text-[10px] font-mono text-white/20 shrink-0">
                                                            {getUtcOffset(tz.value, horizon) ||
                                                                'UTC'}
                                                        </span>
                                                    </div>
                                                    <LiveClock
                                                        tz={tz.value}
                                                        use24Hour={use24Hour}
                                                        dim={!isSelected && !isFocused}
                                                        horizon={horizon}
                                                    />
                                                </button>
                                            );
                                        })}
                                    </div>
                                );
                            })
                        )}
                        <div className="h-1.5" />
                    </div>
                </div>
            )}
        </div>
    );
}

function LiveClock({
    tz,
    use24Hour,
    dim,
    horizon,
}: {
    tz: string;
    use24Hour: boolean;
    dim?: boolean;
    horizon: bigint;
}) {
    const time = formatTimeFromHorizon(horizon, tz, use24Hour);

    return (
        <span
            className={cn(
                'text-[10px] font-mono tabular-nums shrink-0 transition-colors',
                dim ? 'text-white/15' : 'text-white/40',
            )}
        >
            {time}
        </span>
    );
}

function formatTimeFromHorizon(horizon: bigint, tz: string, use24Hour: boolean): string {
    try {
        const date = new Date(Number(horizon / 1_000_000n));

        return new Intl.DateTimeFormat('en-GB', {
            timeZone: tz,
            hour: '2-digit',
            minute: '2-digit',
            hour12: !use24Hour,
        }).format(date);
    } catch {
        return '--:--';
    }
}
