'use client';

import React, { useEffect, useState } from 'react';
import { cn } from '../../lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { TypedEventBus } from '../../core/TypedEventBus';
import { DepthChart } from '../../core';
import type { ToolbarItem } from '../../core/PluginRegistry';

export function PluginToolbarHost({
    eventBus,
    chart,
}: {
    eventBus: TypedEventBus;
    chart: DepthChart;
}) {
    const [items, setItems] = useState<ToolbarItem[]>(() => [
        ...chart.getToolbarRegistry().values(),
    ]);

    useEffect(() => {
        const unsubs = [
            eventBus.on('plugin:toolbar-item-added', ({ item }) =>
                setItems((prev) => {
                    const idx = prev.findIndex((i) => i.id === item.id);
                    if (idx !== -1) {
                        const next = [...prev];
                        next[idx] = item;
                        return next;
                    }
                    return [...prev, item];
                }),
            ),
            eventBus.on('plugin:toolbar-item-removed', ({ id }) =>
                setItems((prev) => prev.filter((i) => i.id !== id)),
            ),
            eventBus.on('plugin:toolbar-item-updated', ({ item }) =>
                setItems((prev) => prev.map((i) => (i.id === item.id ? item : i))),
            ),
        ];
        return () => unsubs.forEach((fn) => fn());
    }, [eventBus, chart]);

    if (items.length === 0) return null;

    return (
        <>
            <div className="w-px h-4 bg-border mx-1 shrink-0" />
            {items.map((item) => (
                <Tooltip key={item.id}>
                    <TooltipTrigger asChild>
                        <button
                            onClick={item.onClick}
                            disabled={item.disabled}
                            className={cn(
                                'flex items-center justify-center w-7 h-7 rounded transition-colors shrink-0',
                                'text-muted-foreground hover:text-foreground hover:bg-accent',
                                'disabled:opacity-40 disabled:pointer-events-none',
                                item.active && 'bg-accent text-foreground',
                            )}
                        >
                            {item.icon}
                        </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="bg-background border border-border">
                        {item.title}
                    </TooltipContent>
                </Tooltip>
            ))}
        </>
    );
}
