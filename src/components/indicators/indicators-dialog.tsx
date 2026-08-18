'use client';
import { useState, useMemo, useRef, useEffect, useLayoutEffect } from 'react';
import {
    Plus,
    Search,
    TrendingUp,
    BarChart2,
    Activity,
    Eye,
    EyeOff,
    Trash2,
    FlaskConical,
    Gauge,
    Waves,
    Circle,
    Puzzle,
    ChevronDown,
    SquareFunction,
    LayoutGrid,
    Lock,
    Sparkle,
    ChartNoAxesCombined,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import type { ChartPane, Indicator } from '../../lib/types/indicator-types';
import type { DataLevel } from '../../interfaces/IDataAdapter';
import {
    isCompatible,
    incompatibleReason,
    DATA_LEVEL_LABELS,
} from '../../core/processing/data-level';

export interface PluginIndicatorDef {
    indicator: Indicator;
    pane?: ChartPane;
    activeByDefault?: boolean;
}

export type BuiltinCategory =
    | 'volume'
    | 'orderflow'
    | 'momentum'
    | 'trend'
    | 'volatility'
    | 'experimental'
    | 'other';

type FilterKey = 'all' | 'active' | 'custom' | BuiltinCategory;

const BUILTIN_CATEGORY_META: Record<
    BuiltinCategory,
    { label: string; icon: React.ReactNode; dot: string; text: string }
> = {
    volume: {
        label: 'Volume',
        icon: <BarChart2 size={11} />,
        dot: 'bg-blue-400',
        text: 'text-blue-400',
    },
    orderflow: {
        label: 'Order Flow',
        icon: <Activity size={11} />,
        dot: 'bg-emerald-400',
        text: 'text-emerald-400',
    },
    momentum: {
        label: 'Momentum',
        icon: <Gauge size={11} />,
        dot: 'bg-violet-400',
        text: 'text-violet-400',
    },
    trend: {
        label: 'Trend',
        icon: <TrendingUp size={11} />,
        dot: 'bg-amber-400',
        text: 'text-amber-400',
    },
    volatility: {
        label: 'Volatility',
        icon: <Waves size={11} />,
        dot: 'bg-orange-400',
        text: 'text-orange-400',
    },
    experimental: {
        label: 'Experimental',
        icon: <FlaskConical size={11} />,
        dot: 'bg-pink-400',
        text: 'text-pink-400',
    },
    other: {
        label: 'Other',
        icon: <Circle size={11} />,
        dot: 'bg-slate-500',
        text: 'text-slate-400',
    },
};

const BUILTIN_CATEGORY_ORDER: BuiltinCategory[] = [
    'volume',
    'orderflow',
    'momentum',
    'trend',
    'volatility',
    'experimental',
    'other',
];

function isBuiltin(def: PluginIndicatorDef): boolean {
    return def.indicator.id.startsWith('builtin:') || def.indicator.id.startsWith('builtin-');
}

function getBuiltinCategory(def: PluginIndicatorDef): BuiltinCategory {
    const raw = def.indicator.category?.trim().toLowerCase() ?? '';
    if (!raw) return 'other';
    const valid = BUILTIN_CATEGORY_ORDER.filter((c) => c !== 'other');
    return valid.find((c) => c === raw) ?? valid.find((c) => raw.includes(c)) ?? ('other' as const);
}

function matches(ind: Indicator, q: string): boolean {
    return (
        ind.name.toLowerCase().includes(q) ||
        (ind.shortName ?? '').toLowerCase().includes(q) ||
        (ind.description ?? '').toLowerCase().includes(q)
    );
}

type Row = {
    def: PluginIndicatorDef;
    isCustom: boolean;
    category: BuiltinCategory;
    section: FilterKey;
};

interface IndicatorsButtonProps {
    indicators: Indicator[];
    dataLevel: DataLevel;
    onAdd: (defId: string) => void;
    onToggle: (indicatorId: string) => void;
    onRemove: (indicatorId: string) => void;
    onOpenChange?: (open: boolean) => void;
    pluginIndicators?: PluginIndicatorDef[];
    onActivatePlugin?: (def: PluginIndicatorDef) => void;
}

function refusalFor(indicator: Indicator, dataLevel: DataLevel): string | undefined {
    const required = indicator.require ?? 'ohlcv';
    if (isCompatible(required, dataLevel)) return undefined;
    return incompatibleReason(required, dataLevel);
}

function Tag({ children, cyan }: { children: React.ReactNode; cyan?: boolean }) {
    return (
        <span
            className={cn(
                'text-[9px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded border shrink-0 leading-none',
                cyan
                    ? 'border-[#08b3de]/30 text-[#08b3de]/80 bg-[#08b3de]/5'
                    : 'border-[#1e2128] text-slate-500 bg-[#0e1014]',
            )}
        >
            {children}
        </span>
    );
}

function FilterChip({
    icon,
    label,
    count,
    active,
    onClick,
}: {
    icon: React.ReactNode;
    label: string;
    count: number;
    active: boolean;
    onClick: () => void;
}) {
    return (
        <button
            onClick={onClick}
            className={cn(
                'flex items-center gap-1.5 h-6 pl-1.5 pr-2 rounded-md text-[10px] font-medium whitespace-nowrap shrink-0 border transition-colors duration-150 select-none',
                active
                    ? 'bg-[#08b3de]/10 border-[#08b3de]/30 text-[#08b3de]'
                    : 'bg-[#0e1014] border-[#1e2128] text-slate-400 hover:text-slate-200 hover:border-slate-600',
            )}
        >
            <span className={cn('shrink-0', active ? 'text-[#08b3de]' : 'text-slate-500')}>
                {icon}
            </span>
            {label}
            <span
                className={cn(
                    'tabular-nums text-[9px] px-1 rounded-full leading-[13px]',
                    active ? 'bg-[#08b3de]/15 text-[#08b3de]' : 'bg-white/5 text-slate-500',
                )}
            >
                {count}
            </span>
        </button>
    );
}

function IndicatorRow({
    row,
    isActive,
    isVisible,
    highlighted,
    refusal,
    onActivate,
    onToggle,
    onRemove,
    onHover,
    rowRef,
}: {
    row: Row;
    isActive: boolean;
    isVisible: boolean;
    highlighted: boolean;
    refusal?: string;
    onActivate: () => void;
    onToggle: () => void;
    onRemove: () => void;
    onHover: () => void;
    rowRef?: (el: HTMLDivElement | null) => void;
}) {
    const { indicator } = row.def;
    const isPane = indicator.layout === 'pane';

    return (
        <div
            ref={rowRef}
            onMouseEnter={onHover}
            onClick={() => {
                if (!isActive) onActivate();
            }}
            title={refusal}
            className={cn(
                'group relative w-full flex items-center gap-2.5 pl-3 pr-1.5 h-9 cursor-pointer transition-colors',
                highlighted ? 'bg-[#1a1d23]' : isActive ? 'bg-[#15181e]' : 'hover:bg-[#1a1d23]',
                refusal && 'opacity-45',
            )}
        >
            {highlighted && (
                <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-[#08b3de]" />
            )}

            <span
                className={cn(
                    'text-[12px] font-medium tracking-tight shrink-0 truncate max-w-[11rem]',
                    isActive ? 'text-white' : 'text-slate-300 group-hover:text-slate-200',
                )}
            >
                {indicator.name}
            </span>

            <span className="text-[11px] text-slate-600 truncate flex-1 group-hover:text-slate-500">
                {indicator.description ?? (row.isCustom ? 'Installed via plugin' : '')}
            </span>

            {refusal && (
                <Tag>
                    <Lock size={8} className="inline mb-px mr-1" />
                    {DATA_LEVEL_LABELS[row.def.indicator.require ?? 'ohlcv']}
                </Tag>
            )}
            {row.isCustom && <Tag cyan>custom</Tag>}
            {isPane && <Tag>pane</Tag>}

            <div className="w-[3.25rem] flex items-center justify-end gap-0.5 shrink-0">
                {isActive ? (
                    <>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onToggle();
                            }}
                            title={isVisible ? 'Hide' : 'Show'}
                            className="w-6 h-6 flex items-center justify-center rounded text-slate-500 hover:text-slate-200 hover:bg-[#1e2128] transition-colors"
                        >
                            {isVisible ? <Eye size={13} /> : <EyeOff size={13} />}
                        </button>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onRemove();
                            }}
                            title="Remove"
                            className="w-6 h-6 flex items-center justify-center rounded text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                        >
                            <Trash2 size={13} />
                        </button>
                    </>
                ) : (
                    <span
                        className={cn(
                            'flex items-center gap-1 text-[11px] text-slate-400 pr-1.5 transition-opacity',
                            highlighted ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                        )}
                    >
                        {refusal ? (
                            'Locked'
                        ) : (
                            <>
                                <Plus size={12} />
                                Add
                            </>
                        )}
                    </span>
                )}
            </div>
        </div>
    );
}

function SectionLabel({
    icon,
    label,
    count,
}: {
    icon: React.ReactNode;
    label: string;
    count: number;
}) {
    return (
        <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1 sticky top-0 bg-[#16181d] z-[1]">
            <span className="text-[9px] font-semibold text-slate-500 uppercase tracking-widest">
                {label}
            </span>
        </div>
    );
}

export function IndicatorsButton({
    indicators,
    dataLevel,
    onAdd,
    onToggle,
    onRemove,
    onOpenChange,
    pluginIndicators = [],
    onActivatePlugin,
}: IndicatorsButtonProps) {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState('');
    const [filter, setFilter] = useState<FilterKey>('all');
    const [highlight, setHighlight] = useState(0);
    const popoverRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const highlightElRef = useRef<HTMLDivElement | null>(null);

    const setOpenWithCallback = (next: boolean | ((prev: boolean) => boolean)) => {
        setOpen((prev) => {
            const resolved = typeof next === 'function' ? next(prev) : next;
            onOpenChange?.(resolved);
            return resolved;
        });
    };

    const activeIds = useMemo(() => new Set(indicators.map((i) => i.id)), [indicators]);
    const q = search.trim().toLowerCase();

    const { builtins, customs } = useMemo(() => {
        const builtins: PluginIndicatorDef[] = [];
        const customs: PluginIndicatorDef[] = [];
        for (const def of pluginIndicators) {
            if (q && !matches(def.indicator, q)) continue;
            (isBuiltin(def) ? builtins : customs).push(def);
        }
        return { builtins, customs };
    }, [pluginIndicators, q]);

    const catCounts = useMemo(() => {
        const m = new Map<BuiltinCategory, number>();
        for (const def of builtins) {
            const c = getBuiltinCategory(def);
            m.set(c, (m.get(c) ?? 0) + 1);
        }
        return m;
    }, [builtins]);

    const activeCount = useMemo(
        () => [...builtins, ...customs].filter((d) => activeIds.has(d.indicator.id)).length,
        [builtins, customs, activeIds],
    );

    const rows = useMemo(() => {
        const out: Row[] = [];
        const wantActive = filter === 'active';

        const pushBuiltins = (cat: BuiltinCategory) => {
            for (const def of builtins) {
                if (getBuiltinCategory(def) !== cat) continue;
                if (wantActive && !activeIds.has(def.indicator.id)) continue;
                out.push({ def, isCustom: false, category: cat, section: cat });
            }
        };
        const pushCustoms = () => {
            for (const def of customs) {
                if (wantActive && !activeIds.has(def.indicator.id)) continue;
                out.push({ def, isCustom: true, category: 'other', section: 'custom' });
            }
        };

        if (filter === 'custom') {
            pushCustoms();
        } else if (filter === 'all' || filter === 'active') {
            for (const cat of BUILTIN_CATEGORY_ORDER) pushBuiltins(cat);
            pushCustoms();
        } else {
            pushBuiltins(filter);
        }
        return out;
    }, [builtins, customs, filter, activeIds]);

    useEffect(() => {
        setHighlight((h) => (rows.length === 0 ? 0 : Math.min(h, rows.length - 1)));
    }, [rows.length]);

    useLayoutEffect(() => {
        highlightElRef.current?.scrollIntoView({ block: 'nearest' });
    }, [highlight, rows]);

    const act = (row: Row) => {
        if (activeIds.has(row.def.indicator.id)) onToggle(row.def.indicator.id);
        else onActivatePlugin?.(row.def);
    };

    useEffect(() => {
        if (!open) return;
        setSearch('');
        setFilter('all');
        setHighlight(0);
        const t = setTimeout(() => searchRef.current?.focus(), 40);
        const onDown = (e: MouseEvent) => {
            if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
                setOpenWithCallback(false);
            }
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setOpenWithCallback(false);
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setHighlight((h) =>
                    rowsRef.current.length ? (h + 1) % rowsRef.current.length : 0,
                );
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setHighlight((h) =>
                    rowsRef.current.length
                        ? (h - 1 + rowsRef.current.length) % rowsRef.current.length
                        : 0,
                );
            } else if (e.key === 'Enter') {
                const row = rowsRef.current[highlightRef.current];
                if (row) {
                    e.preventDefault();
                    act(row);
                }
            }
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            clearTimeout(t);
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const rowsRef = useRef(rows);
    const highlightRef = useRef(highlight);
    rowsRef.current = rows;
    highlightRef.current = highlight;

    const total = builtins.length + customs.length;

    let prevSection: FilterKey | null = null;

    return (
        <div className="relative" ref={popoverRef}>
            <button
                onClick={() => setOpenWithCallback((p) => !p)}
                className={cn(
                    'flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[12px] font-medium',
                    'border transition-all duration-150 select-none border-transparent hover:border-border text-gray-300 hover:text-white',
                    open ? 'border-border bg-muted text-white' : '',
                )}
            >
                <ChartNoAxesCombined className='w-4 h-4' />
                <span className="mt-px">Indicators</span>
                <ChevronDown
                    size={10}
                    className={cn(
                        'opacity-50 transition-transform duration-150',
                        open && 'rotate-180',
                    )}
                />
            </button>

            {open && (
                <div className="absolute left-0 top-full mt-1.5 z-50 flex flex-col w-[30rem] max-h-[30rem] rounded-lg border border-[#1e2128] bg-[#16181d] shadow-2xl overflow-hidden">
                    <div className="flex items-center gap-2.5 px-3 h-11 border-b border-[#1e2128] shrink-0">
                        <Search size={14} className="text-slate-600 shrink-0" />
                        <input
                            ref={searchRef}
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Search indicators…"
                            className="w-full h-full bg-transparent outline-none text-[13px] text-slate-200 placeholder:text-slate-600"
                        />
                    </div>

                    <div className="flex items-center gap-1.5 px-3 py-2 border-b border-[#1e2128] shrink-0 overflow-x-auto no-scrollbar">
                        <FilterChip
                            icon={<LayoutGrid size={11} />}
                            label="All"
                            count={total}
                            active={filter === 'all'}
                            onClick={() => setFilter('all')}
                        />
                        {activeCount > 0 && (
                            <FilterChip
                                icon={<Eye size={11} />}
                                label="On chart"
                                count={activeCount}
                                active={filter === 'active'}
                                onClick={() => setFilter('active')}
                            />
                        )}
                        {BUILTIN_CATEGORY_ORDER.filter((c) => (catCounts.get(c) ?? 0) > 0).map(
                            (c) => {
                                const meta = BUILTIN_CATEGORY_META[c];
                                return (
                                    <FilterChip
                                        key={c}
                                        icon={meta.icon}
                                        label={meta.label}
                                        count={catCounts.get(c) ?? 0}
                                        active={filter === c}
                                        onClick={() => setFilter(c)}
                                    />
                                );
                            },
                        )}
                        {customs.length > 0 && (
                            <FilterChip
                                icon={<Puzzle size={11} />}
                                label="Custom"
                                count={customs.length}
                                active={filter === 'custom'}
                                onClick={() => setFilter('custom')}
                            />
                        )}
                    </div>

                    <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto py-1">
                        {rows.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-16 gap-1.5 text-slate-600">
                                <SquareFunction size={20} className="text-slate-700" />
                                <div className="text-[12px] text-slate-500">
                                    {q ? 'No indicators match' : 'Nothing here'}
                                </div>
                                {q && (
                                    <div className="text-[11px]">
                                        Nothing matches "{search.trim()}"
                                    </div>
                                )}
                            </div>
                        ) : (
                            rows.map((row, i) => {
                                const showHeader =
                                    (filter === 'all' || filter === 'active') &&
                                    row.section !== prevSection;
                                prevSection = row.section;
                                const meta =
                                    row.section === 'custom'
                                        ? { icon: <Puzzle size={11} />, label: 'Custom' }
                                        : {
                                              icon: BUILTIN_CATEGORY_META[row.category].icon,
                                              label: BUILTIN_CATEGORY_META[row.category].label,
                                          };
                                const sectionCount = rows.filter(
                                    (r) => r.section === row.section,
                                ).length;
                                const isActive = activeIds.has(row.def.indicator.id);
                                const liveInd = indicators.find(
                                    (x) => x.id === row.def.indicator.id,
                                );
                                return (
                                    <div key={row.def.indicator.id}>
                                        {showHeader && (
                                            <SectionLabel
                                                icon={meta.icon}
                                                label={meta.label}
                                                count={sectionCount}
                                            />
                                        )}
                                        <IndicatorRow
                                            row={row}
                                            isActive={isActive}
                                            isVisible={liveInd?.visible ?? true}
                                            highlighted={i === highlight}
                                            refusal={refusalFor(row.def.indicator, dataLevel)}
                                            rowRef={
                                                i === highlight
                                                    ? (el) => (highlightElRef.current = el)
                                                    : undefined
                                            }
                                            onHover={() => setHighlight(i)}
                                            onActivate={() => onActivatePlugin?.(row.def)}
                                            onToggle={() => onToggle(row.def.indicator.id)}
                                            onRemove={() => onRemove(row.def.indicator.id)}
                                        />
                                    </div>
                                );
                            })
                        )}
                    </div>

                    <div className="flex items-center justify-between h-7 px-3 border-t border-[#1e2128] shrink-0">
                        <span className="text-[10px] text-slate-700 flex items-center gap-2">
                            <kbd className="font-sans">↑↓</kbd> move
                            <kbd className="font-sans">↵</kbd> add
                        </span>
                    </div>
                </div>
            )}
        </div>
    );
}
