// one instance per bundle, shared by every DepthChart. plugins reach it through
// ctx.global.

import type { DepthChart } from './DepthChart';

export type GlobalEventMap = {
    'global:chart-registered': { id: string; chart: DepthChart };
    'global:chart-unregistered': { id: string };
    'global:focus-changed': { chartId: string | null };
    [key: string]: unknown; // plugins define their own cross-chart events
};

export type GlobalHandler<T = unknown> = (data: T) => void;

export class GlobalChartBus {
    private readonly handlers = new Map<string, Set<Function>>();
    private readonly charts = new Map<string, DepthChart>();
    private focusedChartId: string | null = null;

    // Chart registry
    registerChart(chart: DepthChart): void {
        this.charts.set(chart.id, chart);
        this.emit('global:chart-registered', { id: chart.id, chart });
    }

    unregisterChart(id: string): void {
        this.charts.delete(id);
        if (this.focusedChartId === id) {
            this.focusedChartId = null;
            this.emit('global:focus-changed', { chartId: null });
        }
        this.emit('global:chart-unregistered', { id });
    }

    setFocus(chartId: string): void {
        if (this.focusedChartId === chartId) return;
        this.focusedChartId = chartId;
        this.emit('global:focus-changed', { chartId });
    }

    getChart(id: string): DepthChart | null {
        return this.charts.get(id) ?? null;
    }

    getCharts(): ReadonlyMap<string, DepthChart> {
        return this.charts;
    }

    getFocusedChartId(): string | null {
        return this.focusedChartId;
    }

    // Pub/sub
    on<K extends keyof GlobalEventMap>(
        event: K,
        handler: GlobalHandler<GlobalEventMap[K]>,
    ): () => void {
        if (!this.handlers.has(event as string)) this.handlers.set(event as string, new Set());
        this.handlers.get(event as string)!.add(handler);
        return () => this.handlers.get(event as string)?.delete(handler);
    }

    emit<K extends keyof GlobalEventMap>(event: K, data: GlobalEventMap[K]): void {
        this.handlers.get(event as string)?.forEach((h) => h(data));
    }

    once<K extends keyof GlobalEventMap>(
        event: K,
        handler: GlobalHandler<GlobalEventMap[K]>,
    ): () => void {
        const off = this.on(event, (data) => {
            off();
            handler(data);
        });
        return off;
    }

    // push onto one chart's bus from up here
    broadcastTo<K extends keyof import('./TypedEventBus').ChartEvents>(
        chartId: string,
        event: K,
        data: import('./TypedEventBus').ChartEvents[K],
    ): void {
        this.charts.get(chartId)?.eventBus.emit(event, data);
    }

    // or onto every chart's
    broadcastAll<K extends keyof import('./TypedEventBus').ChartEvents>(
        event: K,
        data: import('./TypedEventBus').ChartEvents[K],
    ): void {
        for (const chart of this.charts.values()) {
            chart.eventBus.emit(event, data);
        }
    }
}

// Singleton
export const globalChartBus = new GlobalChartBus();
