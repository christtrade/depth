'use client';

import React, { useEffect, useReducer, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils';
import { TypedEventBus } from '../../core/TypedEventBus';
import { DepthChart } from '../../core';
import type { BottomBarItem } from '../../core/PluginRegistry';

function BottomBarItemView({
    id,
    render,
    eventBus,
}: {
    id: string;
    render: () => React.ReactNode;
    eventBus: TypedEventBus;
}) {
    const [, forceUpdate] = useReducer((x: number) => x + 1, 0);
    useEffect(() => {
        return eventBus.on('plugin:bottom-bar-item-rerender', ({ id: evtId }) => {
            if (evtId === id) forceUpdate();
        });
    }, [id, eventBus]);
    return <>{render()}</>;
}

export function BottomBarPluginHost({
    eventBus,
    chart,
}: {
    eventBus: TypedEventBus;
    chart: DepthChart;
}) {
    const [items, setItems] = useState<BottomBarItem[]>(() => [
        ...chart.getBottomBarRegistry().values(),
    ]);
    const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
    const [canScrollLeft, setCanScrollLeft] = useState(false);
    const [canScrollRight, setCanScrollRight] = useState(false);

    useEffect(() => {
        if (!scrollEl) return;
        const update = () => {
            setCanScrollLeft(scrollEl.scrollLeft > 0);
            setCanScrollRight(
                scrollEl.scrollLeft + scrollEl.clientWidth < scrollEl.scrollWidth - 1,
            );
        };
        update();
        scrollEl.addEventListener('scroll', update, { passive: true });
        const ro = new ResizeObserver(update);
        ro.observe(scrollEl);
        return () => {
            scrollEl.removeEventListener('scroll', update);
            ro.disconnect();
        };
    }, [scrollEl]);

    useEffect(() => {
        if (!scrollEl) return;
        requestAnimationFrame(() => {
            setCanScrollLeft(scrollEl.scrollLeft > 0);
            setCanScrollRight(
                scrollEl.scrollLeft + scrollEl.clientWidth < scrollEl.scrollWidth - 1,
            );
        });
    }, [items, scrollEl]);

    useEffect(() => {
        const unsubs = [
            eventBus.on('plugin:bottom-bar-item-added', ({ item }) =>
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
            eventBus.on('plugin:bottom-bar-item-removed', ({ id }) =>
                setItems((prev) => prev.filter((i) => i.id !== id)),
            ),
            eventBus.on('plugin:bottom-bar-item-updated', ({ item }) =>
                setItems((prev) => prev.map((i) => (i.id === item.id ? item : i))),
            ),
        ];
        return () => unsubs.forEach((fn) => fn());
    }, [eventBus, chart]);

    if (items.length === 0) return null;

    const scroll = (dir: 'left' | 'right') => {
        scrollEl?.scrollBy({ left: dir === 'left' ? -120 : 120, behavior: 'smooth' });
    };

    return (
        <>
            <div className="w-px h-3 bg-border/50 mx-1 shrink-0" />
            <button
                onClick={() => scroll('left')}
                className={cn(
                    'shrink-0 flex items-center justify-center w-4 h-4 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors',
                    !canScrollLeft && 'invisible pointer-events-none',
                )}
            >
                <ChevronLeft size={11} />
            </button>
            <div
                ref={setScrollEl}
                className="flex items-center overflow-x-auto min-w-0 flex-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
                <div className="flex items-center gap-0.5 mx-auto">
                    {items.map((item, i) => (
                        <React.Fragment key={item.id}>
                            {i > 0 && <div className="w-px h-3 bg-border/30 mx-0.5 shrink-0" />}
                            <div className="shrink-0 flex items-center">
                                <BottomBarItemView
                                    id={item.id}
                                    render={item.render}
                                    eventBus={eventBus}
                                />
                            </div>
                        </React.Fragment>
                    ))}
                </div>
            </div>
            <button
                onClick={() => scroll('right')}
                className={cn(
                    'shrink-0 flex items-center justify-center w-4 h-4 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors',
                    !canScrollRight && 'invisible pointer-events-none',
                )}
            >
                <ChevronRight size={11} />
            </button>
            <div className="w-px h-3 bg-border/50 mx-1 shrink-0" />
        </>
    );
}
