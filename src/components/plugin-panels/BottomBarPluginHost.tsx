'use client';

import React, { useEffect, useReducer, useState } from 'react';
import { TypedEventBus } from '../../core/TypedEventBus';
import { DepthChart } from '../../core';
import type { BottomBarItem } from '../../core/PluginRegistry';
import { ScrollStrip } from '../ui/scroll-strip';

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

    return (
        <>
            <div className="w-px h-3 bg-border/50 mx-1 shrink-0" />
            <ScrollStrip
                className="self-stretch min-w-0 flex-1"
                innerClassName="flex items-center justify-center gap-0.5"
            >
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
            </ScrollStrip>
            <div className="w-px h-3 bg-border/50 mx-1 shrink-0" />
        </>
    );
}
