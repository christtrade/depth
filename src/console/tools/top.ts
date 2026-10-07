import type { DepthChart } from '../../core/DepthChart';
import { scriptStats } from '../../core/ScriptedPlugin';
import type { CommandDef } from '../Console';
import { ansi, formatTime } from '../values';
import { bar, bytes, count, heat, liveScreen, ms, padEnd, padStart } from './tui';

type Heap = { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
export const heapInfo = (): Heap | null => (globalThis.performance as unknown as { memory?: Heap })?.memory ?? null;

function uptime(ms: number): string {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${String(m).padStart(2, '0')}` : `${m}m${String(s % 60).padStart(2, '0')}s`;
}

export function topCommand(chart: DepthChart): CommandDef {
    return {
        name: 'top',
        help: 'top - live view of fps, paint cost, plugin compute time, memory and the busiest events. q quits',
        run: async (ctx) => {
            const screen = ctx.screen();
            const started = performance.now();

            // the browsers own frame rate
            // measured while top is open
            let rafFrames = 0;
            let rafId = 0;
            const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
            const loop = () => {
                rafFrames++;
                rafId = raf!(loop);
            };
            if (raf) rafId = raf(loop);

            let lastAt = performance.now();
            let lastRaf = 0;
            let lastPaints = chart.renderEngine?.paintStats.frames ?? 0;
            let lastCounts = new Map(chart.eventBus.emitCounts);
            let lastComputes = new Map([...scriptStats].map(([k, s]) => [k, s.computes]));
            let fps = 0;
            let paintsPerSec = 0;
            let rates: [string, number, number][] = [];
            let computeRates = new Map<string, number>();

            await liveScreen(screen, 1000, () => {
                const now = performance.now();
                const dt = Math.max(0.001, (now - lastAt) / 1000);

                lastAt = now;
                fps = (rafFrames - lastRaf) / dt;
                lastRaf = rafFrames;

                const paint = chart.renderEngine?.paintStats;
                paintsPerSec = paint ? (paint.frames - lastPaints) / dt : 0;
                lastPaints = paint?.frames ?? 0;

                const counts = chart.eventBus.emitCounts;
                rates = [...counts]
                    .map(([e, n]) => [e, (n - (lastCounts.get(e) ?? 0)) / dt, n] as [string, number, number])
                    .sort((a, b) => b[1] - a[1] || b[2] - a[2]);
                lastCounts = new Map(counts);
                computeRates = new Map([...scriptStats].map(([k, s]) => [k, (s.computes - (lastComputes.get(k) ?? 0)) / dt]));
                lastComputes = new Map([...scriptStats].map(([k, s]) => [k, s.computes]));

                const w = screen.cols;
                const settings = chart.getChart(0).settings;
                const pb = chart.playback;
                const out: string[] = [];

                const clock = new Date().toLocaleTimeString();
                const state = pb.playing ? ansi.green(`▶ ${pb.speed}x`) : ansi.dim('❚❚ paused');
                out.push(
                    `${ansi.bold('top')} - ${clock} up ${uptime(now - started)}   ${ansi.cyan(chart.getSymbol())} ${chart.getTimeframe()} ${settings.chartType}   ${state}   ${ansi.dim(formatTime(pb.time, settings.timezone))}`,
                );

                const avg = paint && paint.frames ? paint.totalMs / paint.frames : 0;
                out.push(
                    `${ansi.dim('render')}  fps ${heat(60 - fps, 10, 30)(String(Math.round(fps)).padStart(3))}   paints/s ${String(Math.round(paintsPerSec)).padStart(3)}   paint ${heat(avg, 4, 12)(ms(avg))} avg  ${heat(paint?.maxMs ?? 0, 16, 50)(ms(paint?.maxMs ?? 0))} max   ${ansi.dim(`${count(paint?.frames ?? 0)} frames`)}`,
                );

                const heap = heapInfo();
                if (heap) {
                    const frac = heap.usedJSHeapSize / heap.jsHeapSizeLimit;
                    out.push(
                        `${ansi.dim('memory')}  heap ${bar(frac, 20, heat(frac, 0.6, 0.85))} ${bytes(heap.usedJSHeapSize)} / ${bytes(heap.jsHeapSizeLimit)}`,
                    );
                } else out.push(`${ansi.dim('memory')}  ${ansi.dim('heap size not exposed by this browser - free shows the rest')}`);

                const data = chart.getData();
                out.push(
                    `${ansi.dim('data')}    ${data.dataLevel}  bars ${count(data.ohlcvBars.length)}  trades ${count(data.trades.length)}  footprint ${count(data.footprintBars.length)}`,
                );
                out.push('');

                // plugins, slowest first
                const header = `${padEnd('PLUGIN', 28)}${padEnd('TYPE', 11)}${padStart('/s', 6)}${padStart('RUNS', 8)}${padStart('LAST', 10)}${padStart('AVG', 10)}${padStart('MAX', 10)}`;
                out.push(ansi.bold(header));
                const plugins = [...scriptStats].sort(([, a], [, b]) => b.totalMs / b.computes - a.totalMs / a.computes);
                const pluginRows = Math.max(1, Math.min(plugins.length, Math.floor((screen.rows - 9) / 2)));
                for (const [id, s] of plugins.slice(0, pluginRows)) {
                    const a = s.totalMs / Math.max(1, s.computes);
                    out.push(
                        `${padEnd(s.name || id, 28).slice(0, 27)} ${padEnd(s.type, 10)}${padStart((computeRates.get(id) ?? 0).toFixed(1), 6)}${padStart(count(s.computes), 8)}${padStart(heat(s.lastMs, 8, 30)(ms(s.lastMs)), 10)}${padStart(heat(a, 8, 30)(ms(a)), 10)}${padStart(heat(s.maxMs, 16, 100)(ms(s.maxMs)), 10)}`,
                    );
                }
                if (!plugins.length) out.push(ansi.dim('  no scripted plugins have computed yet'));
                out.push('');

                // events, busiest first
                out.push(ansi.bold(`${padEnd('EVENT', 36)}${padStart('/s', 8)}${padStart('TOTAL', 12)}`));
                const room = Math.max(0, screen.rows - out.length - 1);
                const peak = Math.max(1, ...rates.slice(0, room).map((r) => r[1]));
                for (const [event, rate, total] of rates.slice(0, room)) {
                    const barW = Math.max(0, w - 58);
                    out.push(
                        `${padEnd(ansi.cyan(event), 36)}${padStart(rate >= 10 ? Math.round(rate).toString() : rate.toFixed(1), 8)}${padStart(count(total), 12)}  ${barW ? bar(rate / peak, barW, ansi.blue) : ''}`,
                    );
                }
                return out;
            });

            if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
        },
    };
}
