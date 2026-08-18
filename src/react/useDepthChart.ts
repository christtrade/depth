'use client';

import React, { useEffect, useRef } from 'react';
import { DepthChart, type ChartOptions } from '../core/DepthChart';
import Depth from '../ChartOuter';

export function useDepthChart(options: ChartOptions) {
    const chartRef = useRef<DepthChart | null>(null);
    const teardownRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    
    // Construct synchronously on first render (not in useeffect) so the element is available
    // immediately for the first render
    if (!chartRef.current) {
        chartRef.current = new DepthChart(options);
        // fire and forget - DataEngine emits data:status events for loading/error ui
        chartRef.current.load(options.symbol);
    }

    useEffect(() => {
        // Deferred teardown, for react strictmode and fast refresh
        // both unmount and immediate remount. destroying the chart in that window is unrecoverable as
        // ChartOuter captures the event bus in a ref on first mount and never rebinds, so a replacement
        // chart emits on a dead bus and the ui sits on "getting market data" forever. rebuilding the chart
        // here can't fix that
        //
        // So schedule the teardown instead of doing it inline. a remount lands before the timer fires
        // and cancels it, keep the live chart; a real unmount lets it through
        if (teardownRef.current) {
            clearTimeout(teardownRef.current);
            teardownRef.current = null;
        }
        return () => {
            teardownRef.current = setTimeout(() => {
                teardownRef.current = null;
                chartRef.current?.destroy();
                chartRef.current = null;
            }, 0);
        };
    }, []);

    const chart = chartRef.current;
    const element = React.createElement(Depth, chart.getProps());

    return { chart, element };
}
