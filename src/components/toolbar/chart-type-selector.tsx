'use client';

import { useState, useRef, useEffect } from 'react';
import { cn } from '../../lib/utils';
import { ChevronDown, Puzzle, CircleQuestionMark, Lock } from 'lucide-react';
import {
    CandlesIcon,
    HollowIcon,
    HeikinAshiIcon,
    BarsIcon,
    FootprintIcon,
    AreaIcon,
    LineIcon,
    StepIcon,
    BaselineIcon,
} from './chart-icons';
import type { ChartType } from '../../lib/types';
import type { PluginIcon } from '../../core';
import { DataLevel, isCompatible, incompatibleReason } from '../../core';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

type ChartTypeDef = {
    id: ChartType;
    label: string;
    icon: React.ReactNode;
    /** Why it cant be picked on this symbol. Undefined means it can. */
    refusal?: string;
};

function RenderIcon({ icon }: { icon: PluginIcon }) {
    return typeof icon === 'undefined' ? (
        <Puzzle className="w-4 h-4" />
    ) : (
        <svg
            viewBox={icon.viewBox}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-4 h-4"
        >
            {icon.paths.map((d, i) => (
                <path key={i} d={d} />
            ))}
        </svg>
    );
}

interface ChartTypeSelectorProps {
    value: ChartType;
    pluginChartTypes: any;
    dataLevel: DataLevel;
    onChange: (t: ChartType) => void;
    onOpenChange?: (open: boolean) => void;
}

export function ChartTypeSelector({
    value,
    pluginChartTypes = [],
    dataLevel,
    onChange,
    onOpenChange,
}: ChartTypeSelectorProps) {
    const [open, setOpen] = useState(false);
    const popoverRef = useRef<HTMLDivElement>(null);

    const CHART_TYPES: ChartTypeDef[] = [
        { id: 'candles', label: 'Candles', icon: <CandlesIcon /> },
        { id: 'hollow', label: 'Hollow', icon: <HollowIcon /> },
        { id: 'heikin-ashi', label: 'Heikin Ashi', icon: <HeikinAshiIcon /> },
        { id: 'bars', label: 'Bars', icon: <BarsIcon /> },
        { id: 'footprint', label: 'Footprint', icon: <FootprintIcon /> },
        { id: 'area', label: 'Area', icon: <AreaIcon /> },
        { id: 'line', label: 'Line', icon: <LineIcon /> },
        { id: 'step', label: 'Step', icon: <StepIcon /> },
        { id: 'baseline', label: 'Baseline', icon: <BaselineIcon /> },
    ].filter((type) => dataLevel === 'l3' || type.id !== 'footprint');

    // A plugin chart type stays listed on a symbol it cant compute from - its
    // installed, it just has nothing to work with here. Greyed out with the
    // reason beats vanishing (the user goes looking for it) or letting it through
    // (an empty chart with no explanation).
    const pluginTypes: ChartTypeDef[] = pluginChartTypes.map((p) => {
        const required = p.require ?? 'ohlcv';
        return {
            id: p.chartTypeId,
            label: p.name,
            icon: p.icon ? <RenderIcon icon={p.icon} /> : <Puzzle className="w-4 h-4" />,
            refusal: isCompatible(required, dataLevel)
                ? undefined
                : incompatibleReason(required, dataLevel),
        };
    });

    const setOpenWithCallback = (next: boolean | ((prev: boolean) => boolean)) => {
        setOpen((prev) => {
            const resolved = typeof next === 'function' ? next(prev) : next;
            onOpenChange?.(resolved);
            return resolved;
        });
    };

    const active = [...CHART_TYPES, ...pluginTypes].find((t) => t.id === value) ?? {
        id: 'unknown' as ChartType,
        label: 'Unknown',
        icon: <CircleQuestionMark className="w-4 h-4" />,
    };

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

    const select = (id: ChartType) => {
        onChange(id);
        setOpenWithCallback(false);
    };

    return (
        <div className="relative" ref={popoverRef}>
            <button
                onClick={() => setOpenWithCallback((p) => !p)}
                className={cn(
                    'flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[12px] font-medium',
                    'border transition-all duration-150 select-none',
                    open
                        ? 'border-border bg-muted text-white'
                        : 'border-transparent text-gray-300 hover:text-white hover:bg-[#1a1d23] hover:border-border',
                )}
            >
                <span className="opacity-60 shrink-0 flex items-center">{active.icon}</span>
                <div className="mt-px">{active.label}</div>
                <ChevronDown
                    size={10}
                    className={cn(
                        'opacity-50 transition-transform duration-150',
                        open && 'rotate-180',
                    )}
                />
            </button>

            {open && (
                <div className="absolute left-0 top-full mt-1.5 z-50 w-[212px] rounded-lg border border-[#1e2128] bg-[#16181d] shadow-2xl overflow-hidden">
                    <div className="p-2.5 space-y-3">
                        <div>
                            <SectionLabel>Chart type</SectionLabel>
                            <div className="grid grid-cols-3 gap-1">
                                {CHART_TYPES.map((ct) => (
                                    <TypeTile
                                        key={ct.id}
                                        def={ct}
                                        active={ct.id === value}
                                        onSelect={select}
                                    />
                                ))}
                            </div>
                        </div>

                        {pluginTypes.length > 0 && (
                            <div>
                                <SectionLabel>Plugins</SectionLabel>
                                <div className="grid grid-cols-3 gap-1">
                                    {pluginTypes.map((ct) => (
                                        <TypeTile
                                            key={ct.id}
                                            def={ct}
                                            active={ct.id === value}
                                            onSelect={select}
                                        />
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
    return (
        <div className="text-[9px] font-[600] text-muted-foreground uppercase tracking-widest mb-1.5 px-0.5">
            {children}
        </div>
    );
}

function TypeTile({
    def,
    active,
    onSelect,
}: {
    def: ChartTypeDef;
    active: boolean;
    onSelect: (id: ChartType) => void;
}) {
    const refused = !!def.refusal;

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button
                    onClick={() => {
                        if (!refused) onSelect(def.id);
                    }}
                    className={cn(
                        'group relative flex flex-col items-center justify-center gap-1.5 h-[3.75rem] rounded-md border transition-all duration-100 select-none',
                        refused
                            ? 'border-[#1e2128] text-slate-700 cursor-not-allowed'
                            : active
                              ? 'bg-[#1a1d23] border-border text-white'
                              : 'border-[#1e2128] text-slate-500 hover:text-slate-200 hover:bg-[#1a1d23] hover:border-slate-600',
                    )}
                >
                    {active && !refused && (
                        <span className="absolute top-1.5 right-1.5 w-1 h-1 rounded-full bg-[#08b3de]" />
                    )}
                    {refused && (
                        <Lock size={8} className="absolute top-1.5 right-1.5 text-slate-700" />
                    )}
                    <span
                        className={cn(
                            'shrink-0',
                            refused
                                ? 'text-slate-700'
                                : active
                                  ? 'text-slate-200'
                                  : 'text-slate-600 group-hover:text-slate-300',
                        )}
                    >
                        {def.icon}
                    </span>
                    <span className="text-[9px] font-medium leading-none max-w-full truncate px-1">
                        {def.label}
                    </span>
                </button>
            </TooltipTrigger>
            <TooltipContent className="border border-border bg-background max-w-[13rem]">
                {def.refusal ?? def.label}
            </TooltipContent>
        </Tooltip>
    );
}
