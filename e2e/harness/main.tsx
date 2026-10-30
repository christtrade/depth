import { useEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { useDepthChart } from '@christtrade/depth';
import { Toaster } from 'sonner';
import { HarnessAdapter } from './adapter';

const DAY_MS = 86_400_000;
const params = new URLSearchParams(location.search);
const live = params.get('live') === '1';
const budget = params.get('budget');

const win = window as any;
win.__status = [];

function App() {
    const { adapter, end } = useMemo(() => {
        const end = live ? Date.now() : Date.UTC(2026, 0, 1);
        const adapter = new HarnessAdapter(end - 400 * DAY_MS, () => (live ? Date.now() : end), live, {
            down: params.get('down') === '1',
            failRate: Number(params.get('fail') ?? 0),
            slowMs: Number(params.get('slow') ?? 0),
            code: (params.get('code') as any) ?? 'network_error',
        });
        // tests flip these while the page runs
        win.__faults = adapter.faults;
        return { adapter, end };
    }, []);

    const { chart, element } = useDepthChart({
        dataAdapter: adapter,
        symbol: 'HARNESS',
        horizon: end,
        initialLoad: { start: end - DAY_MS, end },
        timePrecision: 's',
        features: { timeframe: { timeframes: 'any', allowCustom: true } },
        ...(budget && { dataBudget: { maxBytes: Number(budget) } }),
    });

    useEffect(() => {
        win.__chart = chart;
        return chart.eventBus.on('data:status', ({ status }) => win.__status.push(status));
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
