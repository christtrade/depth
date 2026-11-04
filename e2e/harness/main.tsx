import { useEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { createScriptedPlugin, createSimulatedAdapter, useDepthChart } from '@christtrade/depth';
import { Toaster } from 'sonner';
import { HarnessAdapter } from './adapter';

const DAY_MS = 86_400_000;
const params = new URLSearchParams(location.search);
// the public simulated adapter instead of the harness one, the way a demo uses it
const sim = params.get('sim') === '1';
const live = sim || params.get('live') === '1';
const budget = params.get('budget');
const level = (['l3', 'l2', 'tick'] as const).find((l) => l === params.get('level')) ?? 'ohlcv';
const l2Trades = params.get('trades') !== '0';
const split = params.get('layout') === '2h';

const win = window as any;
win.__status = [];
win.__createScriptedPlugin = createScriptedPlugin;
win.__heatmaps = 0;

function App() {
    const { adapter, end } = useMemo(() => {
        const end = live ? Date.now() : Date.UTC(2026, 0, 1);
        if (sim) {
            return { adapter: createSimulatedAdapter({ seed: 7, realtime: true, dataLevel: level, l2Trades }), end };
        }
        const adapter = new HarnessAdapter(end - 400 * DAY_MS, () => (live ? Date.now() : end), live, {
            down: params.get('down') === '1',
            failRate: Number(params.get('fail') ?? 0),
            slowMs: Number(params.get('slow') ?? 0),
            code: (params.get('code') as any) ?? 'network_error',
        }, level, l2Trades);
        // tests flip these while the page runs
        win.__faults = adapter.faults;
        return { adapter, end };
    }, []);

    const { chart, element } = useDepthChart({
        dataAdapter: adapter,
        symbol: sim ? 'SIM-MARKET' : 'HARNESS',
        horizon: end,
        initialLoad: { start: end - DAY_MS, end },
        timePrecision: 's',
        features: { timeframe: { timeframes: 'any', allowCustom: true } },
        ...(budget && { dataBudget: { maxBytes: Number(budget) } }),
        ...(params.get('ahead') === '0' && { loadAhead: false }),
        ...(params.get('account') === '1' && { account: { initialBalance: 100_000 } }),
        ...(split && {
            restore: { layout: { id: '2h', label: '2', count: 2, cols: 2, rows: 1, areas: '"a b"' } },
        }),
    });

    useEffect(() => {
        win.__chart = chart;
        const offs = [
            chart.eventBus.on('data:status', ({ status }) => win.__status.push(status)),
            // a heatmap bitmap made it back from the worker
            chart.eventBus.on('heatmap:status', ({ recalculating }) => {
                if (!recalculating) win.__heatmaps++;
            }),
        ];
        return () => offs.forEach((off) => off());
    }, [chart]);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
            <div style={{ display: 'flex', gap: 8, padding: 4 }}>
                <button onClick={() => chart.playback.play()}>Play</button>
                <button onClick={() => chart.playback.pause()}>Pause</button>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>{element}</div>
            <Toaster />
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<App />);
