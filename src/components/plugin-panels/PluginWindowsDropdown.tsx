'use client';

import React, { useEffect, useState } from 'react';
import { ChevronDown, Layers } from 'lucide-react';
import { cn } from '../../lib/utils';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { TypedEventBus } from '../../core/TypedEventBus';
import { DepthChart } from '../../core';
import { DomPortal, type PanelEntry } from './PluginFixedPanelHost';

export function PluginWindowsDropdown({
    eventBus,
    chart,
}: {
    eventBus: TypedEventBus;
    chart: DepthChart;
}) {
    const [hiddenPanels, setHiddenPanels] = useState<PanelEntry[]>([]);
    const [open, setOpen] = useState(false);

    useEffect(() => {
        const reg = chart.getPanelRegistry();
        if (reg.size > 0) {
            setHiddenPanels(
                [...reg.entries()]
                    .map(([id, { element, title, visible }]) => ({ id, title, element, visible }))
                    .filter((panel) => !panel.visible),
            );
        }

        const unsubs = [
            eventBus.on('plugin:panel-added', ({ id, title, visible }) => {
                const element = chart.getPanelRegistry().get(id)?.element;
                if (!element) return;
                setHiddenPanels((prev) => {
                    const idx = prev.findIndex((p) => p.id === id);
                    if (idx !== -1) {
                        const next = [...prev];
                        next[idx] = { id, title, element, visible };
                        return next.filter((p) => !p.visible);
                    }
                    return [...prev, { id, title, element, visible }].filter((p) => !p.visible);
                });
            }),
            eventBus.on('plugin:panel-removed', ({ id }) => {
                setHiddenPanels((prev) => prev.filter((p) => p.id !== id));
            }),
            eventBus.on('plugin:panel-toggle-visibility', ({ id, visible }) => {
                setHiddenPanels((prev) => {
                    const exists = prev.some((p) => p.id === id);
                    if (visible) return prev.filter((p) => p.id !== id);
                    if (!exists) {
                        const panel = chart.getPanelRegistry().get(id);
                        if (!panel) return prev;
                        return [...prev, { ...panel, visible, id }];
                    }
                    return prev;
                });
            }),
        ];

        return () => unsubs.forEach((fn) => fn());
    }, [eventBus, chart]);

    const showPanel = (panel: PanelEntry) => {
        setHiddenPanels((prev) => prev.filter((p) => p.id !== panel.id));
        eventBus.emit('plugin:panel-toggle-visibility', { id: panel.id, visible: true });
    };

    const count = hiddenPanels.length;

    return (
        <DropdownMenu open={open} onOpenChange={setOpen}>
            <DropdownMenuTrigger asChild>
                <button
                    className={cn(
                        'flex items-center gap-1.5 h-7 px-2 rounded-md transition-colors font-medium',
                        'text-[12px] text-gray-300 hover:text-white hover:bg-muted border border-transparent hover:border-border',
                        open && 'border-border bg-muted text-white'
                    )}
                    onClick={() => setOpen(true)}
                >
                    <Layers size={13} className="shrink-0" />
                    <span>Windows</span>
                    <ChevronDown className={cn('w-3 h-3 text-muted-foreground transition-all duration-200', open && 'rotate-180')} />
                </button>
            </DropdownMenuTrigger>

            <DropdownMenuContent
                align="end"
                sideOffset={6}
                className="p-2 w-64 border border-border bg-background rounded-xl shadow-2xl"
            >
                <p className="px-1.5 pb-2 text-[10px] font-medium text-muted-foreground/50 uppercase tracking-widest">
                    Hidden panels
                </p>

                {count === 0 ? (
                    <div className="flex flex-col items-center gap-1.5 py-6 text-center">
                        <Layers size={16} className="text-muted-foreground/30" />
                        <p className="text-xs text-muted-foreground/40">All panels visible</p>
                    </div>
                ) : (
                    <div className="flex flex-col gap-1">
                        {hiddenPanels.map((panel) => (
                            <DropdownMenuItem
                                key={panel.id}
                                onSelect={() => showPanel(panel)}
                                className="group flex flex-col gap-1.5 p-1.5 rounded-lg cursor-pointer focus:bg-transparent data-[highlighted]:bg-transparent"
                            >
                                <div className="relative w-full rounded-md border border-border bg-muted/20 overflow-hidden ring-0 group-data-[highlighted]:ring-1 group-data-[highlighted]:ring-border transition-all">
                                    <div className="absolute inset-0 z-10 cursor-pointer" />
                                    <div className="h-24 overflow-hidden">
                                        <div
                                            style={{
                                                transform: 'scale(0.75)',
                                                transformOrigin: 'top left',
                                                width: `${100 / 0.75}%`,
                                                pointerEvents: 'none',
                                            }}
                                        >
                                            <DomPortal element={panel.element} />
                                        </div>
                                    </div>
                                    <div className="absolute bottom-0 inset-x-0 h-8 bg-gradient-to-t from-background/80 to-transparent z-20 pointer-events-none" />
                                    <div className="absolute inset-0 z-30 flex items-end justify-between px-2.5 py-2 opacity-0 group-data-[highlighted]:opacity-100 transition-opacity pointer-events-none">
                                        <span className="text-xs font-medium text-foreground drop-shadow-sm">
                                            {panel.title}
                                        </span>
                                        <span className="text-[10px] text-muted-foreground">
                                            Click to show
                                        </span>
                                    </div>
                                </div>
                                <span className="px-0.5 text-xs font-medium text-foreground/70 group-data-[highlighted]:text-foreground transition-colors truncate">
                                    {panel.title}
                                </span>
                            </DropdownMenuItem>
                        ))}
                    </div>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
