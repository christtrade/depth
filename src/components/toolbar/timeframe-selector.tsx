'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { cn } from '../../lib/utils';
import { X, Plus, ChevronDown, Star, Lock } from 'lucide-react';
import {
    PRESET_TIMEFRAMES,
    parseCustomTimeframe,
    loadFavoriteTimeframes,
    saveFavoriteTimeframes,
    type Timeframe,
} from '../../lib/timeframes';
import type { FeaturesOptions } from '../../core/DepthChart';
import type { TypedEventBus } from '../../core/TypedEventBus';

const PRESET_GROUPS = [
    {
        label: 'Seconds',
        tfs: PRESET_TIMEFRAMES.filter(
            (t) => t.barNs >= 1_000_000_000n && t.barNs < 60_000_000_000n,
        ),
    },
    {
        label: 'Minutes',
        tfs: PRESET_TIMEFRAMES.filter(
            (t) => t.barNs >= 60_000_000_000n && t.barNs < 3_600_000_000_000n,
        ),
    },
    {
        label: 'Hours',
        tfs: PRESET_TIMEFRAMES.filter(
            (t) => t.barNs >= 3_600_000_000_000n && t.barNs < 86_400_000_000_000n,
        ),
    },
    {
        label: 'Days',
        tfs: PRESET_TIMEFRAMES.filter(
            (t) => t.barNs >= 86_400_000_000_000n && t.barNs < 604_800_000_000_000n,
        ),
    },
    {
        label: 'Weeks',
        tfs: PRESET_TIMEFRAMES.filter((t) => t.barNs >= 604_800_000_000_000n),
    },
];

interface TimeframeSelectorProps {
    eventBus: TypedEventBus,
    value: Timeframe;
    customTimeframes: Timeframe[];
    features: FeaturesOptions,
    onChange: (tf: Timeframe) => void;
    onAddCustom: (tf: Timeframe) => void;
    onRemoveCustom: (label: string) => void;
    onOpenChange?: (open: boolean) => void;
}

export function TimeframeSelector({
    eventBus,
    value,
    customTimeframes,
    features,
    onChange,
    onAddCustom,
    onRemoveCustom,
    onOpenChange,
}: TimeframeSelectorProps) {
    const [open, setOpen] = useState(false);
    const [customInput, setCustomInput] = useState('');
    const [inputError, setInputError] = useState('');
    const [favorites, setFavorites] = useState<string[]>(() => loadFavoriteTimeframes());

    const popoverRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    const setOpenWithCallback = (next: boolean | ((prev: boolean) => boolean)) => {
        setOpen((prev) => {
            const resolved = typeof next === 'function' ? next(prev) : next;
            onOpenChange?.(resolved);
            return resolved;
        });
    };

    const allTfs = useMemo(
        () => [...PRESET_TIMEFRAMES, ...customTimeframes],
        [customTimeframes],
    );

    // entitlement, not visibility: gated timeframes still render, wearing a lock.
    // features is optional on the public API, so an embed that passes none
    // gets no gate at all.
    const allowedTfs = features?.timeframe?.timeframes ?? 'any';
    const allowCustom = features?.timeframe?.allowCustom ?? true;
    const isLocked = useCallback(
        (label: string) => allowedTfs !== 'any' && !allowedTfs.includes(label),
        [allowedTfs],
    );

    // resolve favorites to definitions, drop dangling labels, sort ascending
    const favoriteTfs = useMemo(() => {
        const set = new Set(favorites);
        return allTfs
            .filter((t) => set.has(t.label))
            .sort((a, b) => (a.barNs < b.barNs ? -1 : a.barNs > b.barNs ? 1 : 0));
    }, [allTfs, favorites]);

    const activeIsPinned = favoriteTfs.some((t) => t.label === value.label);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
                setOpenWithCallback(false);
            }
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpenWithCallback(false);
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    useEffect(() => {
        if (open) setTimeout(() => inputRef.current?.focus(), 50);
    }, [open]);

    const handleSelect = useCallback(
        (tf: Timeframe) => {
            if (isLocked(tf.label)) {
                // the host owns the explanation - close and report, so the chart
                // never lands on a timeframe it can't get data for
                eventBus?.emit('timeframe:add-failed', {
                    message: 'Timeframe not allowed',
                    code: 'TIMEFRAME_NOT_ALLOWED',
                    label: tf.label,
                });
                setOpenWithCallback(false);
                return;
            }
            onChange(tf);
            setOpenWithCallback(false);
        },
        [onChange, isLocked, eventBus],
    );

    const toggleFavorite = useCallback((label: string) => {
        setFavorites((prev) => {
            const next = prev.includes(label)
                ? prev.filter((l) => l !== label)
                : [...prev, label];
            saveFavoriteTimeframes(next);
            return next;
        });
    }, []);

    const handleAddCustom = useCallback(() => {
        const parsed = parseCustomTimeframe(customInput);
        if (!parsed) {
            setInputError('e.g. 213m, 2h, 45s');
            return;
        }
        if (allTfs.some((t) => t.label === parsed.label)) {
            setInputError('Already exists');
            return;
        }

        if (!allowCustom) {
            eventBus?.emit('timeframe:add-failed', {
                message: 'Adding custom timeframes not allowed',
                code: 'NO_CUSTOM_TIMEFRAMES',
                label: parsed.label,
            });
            setOpenWithCallback(false);
            return;
        }

        if (isLocked(parsed.label)) {
            eventBus?.emit('timeframe:add-failed', {
                message: 'Timeframe not allowed',
                code: 'TIMEFRAME_NOT_ALLOWED',
                label: parsed.label,
            });
            setOpenWithCallback(false);
            return;
        }

        onAddCustom(parsed);
        setCustomInput('');
        setInputError('');
        onChange(parsed);
        setOpenWithCallback(false);
    }, [customInput, allTfs, onAddCustom, onChange, allowCustom, isLocked, eventBus]);

    const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        setInputError('');
        if (e.key === 'Enter') handleAddCustom();
        if (e.key === 'Escape') setOpenWithCallback(false);
    };

    return (
        <div className="relative flex items-center gap-0.5" ref={popoverRef}>
            {favoriteTfs.map((tf) => (
                <QuickPick
                    key={tf.label}
                    tf={tf}
                    active={value.label === tf.label}
                    locked={isLocked(tf.label)}
                    onSelect={handleSelect}
                />
            ))}

            {!activeIsPinned && <QuickPick tf={value} active onSelect={handleSelect} />}

            <button
                onClick={() => setOpenWithCallback((p) => !p)}
                aria-label="All timeframes"
                className={cn(
                    'h-7 w-7 flex items-center justify-center rounded-md border transition-all duration-150 select-none',
                    open
                        ? 'border-border bg-muted text-slate-200'
                        : 'border-transparent text-slate-500 hover:text-slate-200 hover:bg-[#1a1d23] hover:border-border',
                )}
            >
                <ChevronDown
                    size={12}
                    className={cn('transition-transform duration-150', open && 'rotate-180')}
                />
            </button>

            {open && (
                <div className="absolute left-0 top-full mt-1.5 z-50 w-[244px] rounded-lg border border-[#1e2128] bg-[#16181d] shadow-2xl overflow-hidden">
                    <div className="p-2.5 space-y-3 max-h-[22rem] overflow-y-auto">
                        {PRESET_GROUPS.filter((g) => g.tfs.length > 0).map((group) => (
                            <div key={group.label}>
                                <SectionLabel>{group.label}</SectionLabel>
                                <div className="flex flex-wrap gap-1">
                                    {group.tfs.map((tf) => (
                                        <TfChip
                                            key={tf.label}
                                            tf={tf}
                                            active={value.label === tf.label}
                                            pinned={favorites.includes(tf.label)}
                                            locked={isLocked(tf.label)}
                                            onSelect={handleSelect}
                                            onTogglePin={() => toggleFavorite(tf.label)}
                                        />
                                    ))}
                                </div>
                            </div>
                        ))}

                        {customTimeframes.length > 0 && (
                            <div>
                                <SectionLabel>Custom</SectionLabel>
                                <div className="flex flex-wrap gap-1">
                                    {customTimeframes.map((tf) => (
                                        <TfChip
                                            key={tf.label}
                                            tf={tf}
                                            active={value.label === tf.label}
                                            pinned={favorites.includes(tf.label)}
                                            locked={isLocked(tf.label)}
                                            onSelect={handleSelect}
                                            onTogglePin={() => toggleFavorite(tf.label)}
                                            onRemove={() => {
                                                onRemoveCustom(tf.label);
                                                if (favorites.includes(tf.label))
                                                    toggleFavorite(tf.label);
                                            }}
                                        />
                                    ))}
                                </div>
                            </div>
                        )}

                            <div className="pt-2 border-t border-[#1e2128]">
                                <SectionLabel>
                                    <span className="inline-flex items-center gap-1">
                                        Add custom
                                        {!allowCustom && <Lock size={8} className="text-slate-600" />}
                                    </span>
                                </SectionLabel>
                                <div className="flex gap-1.5 items-center">
                                    <input
                                        ref={inputRef}
                                        value={customInput}
                                        onChange={(e) => {
                                            setCustomInput(e.target.value);
                                            setInputError('');
                                        }}
                                        onKeyDown={handleInputKeyDown}
                                        placeholder="e.g. 7m"
                                        className={cn(
                                            'w-full h-7 px-2 rounded-md text-xs bg-[#0e1014] font-[500] border outline-none transition-colors',
                                            'placeholder:text-slate-700 text-slate-200',
                                            inputError
                                                ? 'border-red-500/50 focus:border-red-500/80'
                                                : 'border-[#1e2128] focus:border-border',
                                        )}
                                    />
                                    <button
                                        onClick={handleAddCustom}
                                        className="h-6 w-6 flex items-center justify-center rounded-md bg-muted border border-border hover:bg-muted/50 text-muted-foreground transition-all shrink-0"
                                    >
                                        <Plus size={11} />
                                    </button>
                                </div>
                                {inputError && (
                                    <div className="text-[10px] text-red-400/80 mt-1 px-0.5">
                                        {inputError}
                                    </div>
                                )}
                                <div className="text-[9px] text-slate-700 mt-1.5 px-0.5">
                                    Click the star to pin a timeframe to the toolbar.
                                </div>
                            </div>
                    </div>
                </div>
            )}
        </div>
    );
}

function QuickPick({
    tf,
    active,
    locked,
    onSelect,
}: {
    tf: Timeframe;
    active: boolean;
    locked?: boolean;
    onSelect: (tf: Timeframe) => void;
}) {
    return (
        <button
            onClick={() => onSelect(tf)}
            title={locked ? `${tf.label} is a Pro timeframe` : undefined}
            className={cn(
                'relative h-7 px-2 rounded-md text-[11px] font-medium flex items-center gap-1 transition-colors duration-150 select-none',
                locked
                    ? 'text-slate-700 hover:text-cyan-300/80'
                    : active
                      ? 'text-white'
                      : 'text-slate-500 hover:text-slate-200 hover:bg-[#1a1d23]',
            )}
        >
            {tf.label}
            {locked && <Lock size={8} />}
            {active && (
                <span className="absolute inset-x-1.5 bottom-[4px] h-[1px] rounded-full bg-[#08b3de]" />
            )}
        </button>
    );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
    return (
        <div className="text-[9px] font-[600] text-muted-foreground uppercase tracking-widest mb-1.5 px-0.5">
            {children}
        </div>
    );
}

function TfChip({
    tf,
    active,
    pinned,
    locked,
    onSelect,
    onTogglePin,
    onRemove,
}: {
    tf: Timeframe;
    active: boolean;
    pinned: boolean;
    locked?: boolean;
    onSelect: (tf: Timeframe) => void;
    onTogglePin: () => void;
    onRemove?: () => void;
}) {
    return (
        <div
            title={locked ? `${tf.label} is a Pro timeframe` : undefined}
            className={cn(
                'group relative flex items-center h-6 rounded text-xs select-none cursor-pointer transition-all duration-100 font-[500] pl-2',
                onRemove ? 'pr-1' : 'pr-1.5',
                locked
                    ? 'bg-transparent text-slate-600 border border-dashed border-[#1e2128] hover:text-cyan-300/80 hover:border-cyan-400/30'
                    : active
                      ? 'bg-[#1a1d23] text-white border border-border'
                      : 'bg-[#1a1d23] text-slate-500 border border-[#1e2128] hover:text-slate-200 hover:border-slate-600 hover:bg-[#1e2229]',
            )}
            onClick={() => onSelect(tf)}
        >
            {tf.label}

            {/* a locked chip trades its pin toggle for the lock - pinning
                something you can't select just moves the dead end to the toolbar */}
            {locked ? (
                <Lock size={8} className="ml-1.5 shrink-0" />
            ) : (
                <button
                    className={cn(
                        'ml-1.5 transition-all',
                        pinned
                            ? 'text-[#08b3de]'
                            : 'text-slate-600 opacity-0 group-hover:opacity-100 hover:text-slate-300',
                    )}
                    onClick={(e) => {
                        e.stopPropagation();
                        onTogglePin();
                    }}
                    aria-label={pinned ? 'Unpin from toolbar' : 'Pin to toolbar'}
                >
                    <Star size={9} className={pinned ? 'fill-current' : ''} />
                </button>
            )}

            {onRemove && (
                <button
                    className="ml-0.5 opacity-0 group-hover:opacity-100 text-slate-600 hover:text-red-400 transition-all"
                    onClick={(e) => {
                        e.stopPropagation();
                        onRemove();
                    }}
                    aria-label="Delete timeframe"
                >
                    <X size={8} />
                </button>
            )}
        </div>
    );
}
