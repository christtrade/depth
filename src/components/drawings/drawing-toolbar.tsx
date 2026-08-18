'use client';

import { cn } from '../../lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import type { DrawingTool } from '../../lib/types/drawing-types';
import { Puzzle, Star, ChevronUp, ChevronDown } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import type { PluginIcon } from '../../core';
import {
    DRAWING_CATEGORIES,
    findDrawingItem,
    type DrawingCategory,
    type DrawingItem,
} from './drawing-tools';
import { DrawIcons } from './drawing-icons';
import { StorageKey, onChartStorageChange, readJSON, writeJSON } from '../../lib/storage';

export { TOOL_SHORTCUTS } from './drawing-tools';


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


function useFavorites(): [Set<string>, (tool: string) => void] {
    const [favorites, setFavorites] = useState<Set<string>>(new Set());

    useEffect(() => {
        const sync = () => {
            const stored = readJSON<unknown>(StorageKey.drawingFavorites, null);
            setFavorites(new Set(Array.isArray(stored) ? stored : []));
        };
        sync();
        return onChartStorageChange(sync);
    }, []);

    const toggle = (tool: string) => {
        setFavorites((prev) => {
            const next = new Set(prev);
            next.has(tool) ? next.delete(tool) : next.add(tool);
            writeJSON(StorageKey.drawingFavorites, [...next]);
            return next;
        });
    };

    return [favorites, toggle];
}


function SlotButton({
    active,
    label,
    children,
    onClick,
}: {
    active: boolean;
    label: string;
    children: React.ReactNode;
    onClick?: () => void;
}) {
    return (
        <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
                <button
                    className={cn(
                        'w-7 h-7 min-h-7 flex items-center justify-center rounded transition-colors',
                        active
                            ? 'bg-primary/20 text-primary'
                            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                    )}
                    onClick={onClick}
                    aria-label={label}
                >
                    {children}
                </button>
            </TooltipTrigger>
            <TooltipContent
                side="right"
                className="flex items-center gap-2 bg-background border border-border"
            >
                <span>{label}</span>
            </TooltipContent>
        </Tooltip>
    );
}


function CategorySlot({
    category,
    activeTool,
    open,
    onOpenChange,
    onSelect,
    favorites,
    onToggleFavorite,
}: {
    category: DrawingCategory;
    activeTool: DrawingTool;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSelect: (tool: DrawingTool) => void;
    favorites: Set<string>;
    onToggleFavorite: (tool: string) => void;
}) {
    const hasActive = category.groups.some((g) => g.items.some((i) => i.tool === activeTool));

    return (
        <Popover open={open} onOpenChange={onOpenChange}>
            <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                    <PopoverTrigger asChild>
                        <button
                            className={cn(
                                'w-7 h-7 flex items-center justify-center rounded transition-colors min-h-7',
                                hasActive || open
                                    ? 'bg-primary/20 text-primary'
                                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                            )}
                            aria-label={category.label}
                        >
                            {category.icon}
                        </button>
                    </PopoverTrigger>
                </TooltipTrigger>
                {!open && (
                    <TooltipContent side="right" className="bg-background border border-border">
                        {category.label}
                    </TooltipContent>
                )}
            </Tooltip>

            <PopoverContent
                side="right"
                align="start"
                sideOffset={6}
                className="w-60 max-h-[70vh] overflow-y-auto p-1 bg-background border-border"
            >
                {category.groups.map((g, gi) => (
                    <div key={g.label} className={cn('flex flex-col', gi > 0 && 'mt-1.5')}>
                        <div className="flex items-center gap-2 px-2 pt-1 pb-1">
                            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                                {g.label}
                            </span>
                            <span className="h-px flex-1 bg-border/60" />
                        </div>
                        <div className="flex flex-col gap-0.5">
                            {g.items.map((item) => (
                                <DrawingRow
                                    key={item.tool}
                                    item={item}
                                    active={item.tool === activeTool}
                                    favorited={favorites.has(item.tool)}
                                    onSelect={() => {
                                        if (!item.implemented) return;
                                        onSelect(item.tool);
                                        onOpenChange(false);
                                    }}
                                    onToggleFavorite={() => onToggleFavorite(item.tool)}
                                />
                            ))}
                        </div>
                    </div>
                ))}
            </PopoverContent>
        </Popover>
    );
}

function DrawingRow({
    item,
    active,
    favorited,
    onSelect,
    onToggleFavorite,
}: {
    item: DrawingItem;
    active: boolean;
    favorited: boolean;
    onSelect: () => void;
    onToggleFavorite: () => void;
}) {
    return (
        <div
            className={cn(
                'group flex items-center gap-2 rounded pl-2 pr-1 py-1 text-xs transition-colors duration-200 hover:duration-0',
                item.implemented
                    ? cn(
                          'cursor-pointer',
                          active
                              ? 'bg-primary/15 text-primary'
                              : 'text-foreground hover:bg-muted/70',
                      )
                    : 'text-muted-foreground/50 cursor-not-allowed',
            )}
            onClick={onSelect}
        >
            <span className="shrink-0 [&>svg]:w-3.5 [&>svg]:h-3.5">{item.icon}</span>
            <span className="flex-1 truncate">{item.label}</span>

            {!item.implemented && (
                <span className="text-[9px] uppercase tracking-wide text-muted-foreground/60">
                    soon
                </span>
            )}

            {item.implemented && item.shortcut && (
                <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded bg-muted px-1 font-mono text-[10px] leading-none text-muted-foreground">
                    {item.shortcut}
                </kbd>
            )}

            {item.implemented && (
                <button
                    aria-label={favorited ? 'Unfavorite' : 'Favorite'}
                    className={cn(
                        'flex h-5 w-5 shrink-0 items-center justify-center rounded transition-opacity hover:bg-muted',
                        favorited
                            ? 'text-primary opacity-100'
                            : 'text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground',
                    )}
                    onClick={(e) => {
                        e.stopPropagation();
                        onToggleFavorite();
                    }}
                >
                    <Star size={13} fill={favorited ? 'currentColor' : 'none'} />
                </button>
            )}
        </div>
    );
}

function ScrollableSection({ children }: { children: React.ReactNode }) {
    const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
    const [canScrollUp, setCanScrollUp] = useState(false);
    const [canScrollDown, setCanScrollDown] = useState(false);

    useEffect(() => {
        if (!scrollEl) return;
        const update = () => {
            setCanScrollUp(scrollEl.scrollTop > 0);
            setCanScrollDown(
                scrollEl.scrollTop + scrollEl.clientHeight < scrollEl.scrollHeight - 1,
            );
        };
        update();
        scrollEl.addEventListener('scroll', update, { passive: true });
        const ro = new ResizeObserver(update);
        ro.observe(scrollEl);
        if (scrollEl.firstElementChild) ro.observe(scrollEl.firstElementChild);
        return () => {
            scrollEl.removeEventListener('scroll', update);
            ro.disconnect();
        };
    }, [scrollEl]);

    const scroll = (dir: 'up' | 'down') => {
        scrollEl?.scrollBy({ top: dir === 'up' ? -120 : 120, behavior: 'smooth' });
    };

    return (
        <div className="relative flex flex-col w-full flex-1 min-h-0">
            <div
                ref={setScrollEl}
                className="flex-1 min-h-0 w-full overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
                <div className="flex flex-col items-center gap-0.5">{children}</div>
            </div>

            <div
                className={cn(
                    'pointer-events-none absolute inset-x-0 top-0 flex justify-center pb-2 bg-gradient-to-b from-background to-transparent transition-opacity duration-150',
                    canScrollUp ? 'opacity-100' : 'opacity-0',
                )}
            >
                <button
                    onClick={() => scroll('up')}
                    aria-label="Scroll up"
                    className={cn(
                        'flex items-center justify-center w-7 h-4 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors',
                        canScrollUp ? 'pointer-events-auto' : 'pointer-events-none',
                    )}
                >
                    <ChevronUp size={12} />
                </button>
            </div>
            <div
                className={cn(
                    'pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pt-2 bg-gradient-to-t from-background to-transparent transition-opacity duration-150',
                    canScrollDown ? 'opacity-100' : 'opacity-0',
                )}
            >
                <button
                    onClick={() => scroll('down')}
                    aria-label="Scroll down"
                    className={cn(
                        'flex items-center justify-center w-7 h-4 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors',
                        canScrollDown ? 'pointer-events-auto' : 'pointer-events-none',
                    )}
                >
                    <ChevronDown size={12} />
                </button>
            </div>
        </div>
    );
}

interface DrawingToolbarProps {
    activeTool: DrawingTool;
    onToolChange: (tool: DrawingTool) => void;
    pluginDrawings: { id: DrawingTool; name: string; icon?: PluginIcon }[];
}

function Divider() {
    return <div className="w-5 border-t border-border my-1" />;
}

export function DrawingToolbar({ activeTool, onToolChange, pluginDrawings }: DrawingToolbarProps) {
    const [favorites, toggleFavorite] = useFavorites();
    const [openCategory, setOpenCategory] = useState<string | null>(null);

    const favoriteItems = [...favorites]
        .map((tool) => findDrawingItem(tool))
        .filter((i): i is DrawingItem => !!i && !!i.implemented);

    return (
        <div className="flex flex-col items-center gap-0.5 py-2 px-1 border-r border-border bg-background shrink-0 w-9 min-h-0">
            <SlotButton
                active={activeTool === 'cursor'}
                label="Cursor"
                onClick={() => onToolChange('cursor')}
            >
                {DrawIcons.cursor}
            </SlotButton>

            <Divider />

            <ScrollableSection>
                {DRAWING_CATEGORIES.map((category) => (
                    <CategorySlot
                        key={category.id}
                        category={category}
                        activeTool={activeTool}
                        open={openCategory === category.id}
                        onOpenChange={(o) => setOpenCategory(o ? category.id : null)}
                        onSelect={onToolChange}
                        favorites={favorites}
                        onToggleFavorite={toggleFavorite}
                    />
                ))}

                {pluginDrawings.length > 0 && <Divider />}
                {pluginDrawings.map((def) => (
                    <SlotButton
                        key={def.id}
                        active={activeTool === def.id}
                        label={def.name}
                        onClick={() => onToolChange(def.id)}
                    >
                        {def.icon ? <RenderIcon icon={def.icon} /> : <Puzzle className="w-4 h-4" />}
                    </SlotButton>
                ))}

                {favoriteItems.length > 0 && <Divider />}
                {favoriteItems.map((item) => (
                    <SlotButton
                        key={item.tool}
                        active={activeTool === item.tool}
                        label={item.label}
                        onClick={() => onToolChange(item.tool)}
                    >
                        {item.icon}
                    </SlotButton>
                ))}
            </ScrollableSection>
        </div>
    );
}
