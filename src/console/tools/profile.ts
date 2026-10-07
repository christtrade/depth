import type { DepthChart } from '../../core/DepthChart';
import { scriptStats } from '../../core/ScriptedPlugin';
import type { CommandDef } from '../Console';
import { ansi, parseDuration } from '../values';
import { heapInfo } from './top';
import { bar, bytes, count, heat, ms, padEnd, padStart, sleep } from './tui';

const BUCKETS: [string, number][] = [
    ['< 8ms', 8],
    ['8-17', 17],
    ['17-25', 25],
    ['25-33', 33],
    ['33-50', 50],
    ['50-100', 100],
    ['100+', Infinity],
];

const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);

export function profileCommand(chart: DepthChart): CommandDef {
    return {
        name: 'profile',
        help: 'profile [duration] - record frames, paints, long tasks, plugins and events for a while (5s), then report. ctrl+c stops early',
        run: async ({ argv, print, signal }) => {
            const d = parseDuration(argv[0] ?? '5s');
            if (d === null) throw new Error('profile how long? e.g. profile 10s');
            const span = Math.max(500, Math.min(120_000, Number(d / 1_000_000n)));

            const frames: number[] = [];
            const paints: number[] = [];
            const longTasks: number[] = [];
            const startCounts = new Map(chart.eventBus.emitCounts);
            const startScripts = new Map([...scriptStats].map(([k, s]) => [k, { computes: s.computes, totalMs: s.totalMs, maxMs: s.maxMs }]));
            const heapBefore = heapInfo()?.usedJSHeapSize;
            const engine = chart.renderEngine;
            let lastPaints = engine?.paintStats.frames ?? 0;

            let raf = 0;
            let last = 0;
            const hasRaf = typeof requestAnimationFrame === 'function';
            const loop = (t: number) => {
                if (last) frames.push(t - last);
                last = t;

                const p = engine?.paintStats;
                if (p && p.frames !== lastPaints) {
                    paints.push(p.lastMs);
                    lastPaints = p.frames;
                }
                raf = requestAnimationFrame(loop);
            };

            if (hasRaf) raf = requestAnimationFrame(loop);

            // main thread stall over 50ms chromium only
            let observer: PerformanceObserver | null = null;
            try {
                observer = new PerformanceObserver((l) => l.getEntries().forEach((e) => longTasks.push(e.duration)));
                observer.observe({ type: 'longtask', buffered: false });
            } catch {
                observer = null;
            }

            print(ansi.dim(`profiling for ${ms(span)}… ctrl+c stops early`));
            const started = performance.now();
            await sleep(span, signal);
            const took = performance.now() - started;

            if (hasRaf) cancelAnimationFrame(raf);
            observer?.disconnect();

            const secs = took / 1000;
            const sorted = [...frames].sort((a, b) => a - b);
            const out: string[] = [];
            out.push(`${ansi.bold('profile')}  ${(secs).toFixed(1)}s  ${count(frames.length)} frames  ${(frames.length / secs).toFixed(1)} fps${signal.aborted ? ansi.yellow('  (stopped early)') : ''}`);

            if (frames.length) {
                const jank = frames.filter((f) => f > 33).length;
                out.push(
                    `${padEnd(ansi.dim('frames'), 12)} p50 ${ms(pct(sorted, 0.5))}  p95 ${heat(pct(sorted, 0.95), 18, 33)(ms(pct(sorted, 0.95)))}  p99 ${heat(pct(sorted, 0.99), 25, 50)(ms(pct(sorted, 0.99)))}  max ${heat(sorted[sorted.length - 1], 33, 100)(ms(sorted[sorted.length - 1]))}  ${jank ? ansi.red(`${jank} janky (>33ms)`) : ansi.green('no jank')}`,
                );

                let lo = 0;
                const most = Math.max(1, ...BUCKETS.map(([, hi], i) => frames.filter((f) => f >= (i ? BUCKETS[i - 1][1] : 0) && f < hi).length));

                for (const [label, hi] of BUCKETS) {
                    const n = frames.filter((f) => f >= lo && f < hi).length;
                    lo = hi;
                    if (!n) continue;

                    const color = hi <= 17 ? ansi.green : hi <= 33 ? ansi.yellow : ansi.red;
                    out.push(`${' '.repeat(12)}${padStart(label, 7)} ${bar(n / most, 30, color)} ${count(n)}`);
                }
            } else out.push(ansi.dim('frames      no frames seen - is the page in the background?'));

            if (paints.length) {
                const total = paints.reduce((a, b) => a + b, 0);
                out.push(
                    `${padEnd(ansi.dim('paint'), 12)} ${count(paints.length)} paints  ${ms(total / paints.length)} avg  ${ms(Math.max(...paints))} max  = ${ms(total)}, ${((total / took) * 100).toFixed(1)}% of the time`,
                );
            }

            if (observer) {
                const total = longTasks.reduce((a, b) => a + b, 0);
                out.push(
                    `${padEnd(ansi.dim('long tasks'), 12)} ${longTasks.length ? ansi.red(`${longTasks.length} stalls, ${ms(total)} blocked, longest ${ms(Math.max(...longTasks))}`) : ansi.green('none - the main thread never froze for 50ms')}`,
                );
            }

            const scripts = [...scriptStats]
                .map(([id, s]) => {
                    const b = startScripts.get(id) ?? { computes: 0, totalMs: 0, maxMs: 0 };
                    return { name: s.name || id, runs: s.computes - b.computes, ms: s.totalMs - b.totalMs };
                })
                .filter((s) => s.runs > 0)
                .sort((a, b) => b.ms - a.ms);
            if (scripts.length) {
                out.push(ansi.dim('scripts') + ansi.dim('     in their workers - off the main thread'));
                for (const s of scripts.slice(0, 6)) {
                    out.push(`${' '.repeat(12)}${padEnd(s.name.slice(0, 24), 25)}${padStart(count(s.runs), 6)} runs  ${padStart(ms(s.ms), 9)}  ${ms(s.ms / s.runs)} each`);
                }
            }

            const events = [...chart.eventBus.emitCounts]
                .map(([e, n]) => [e, n - (startCounts.get(e) ?? 0)] as [string, number])
                .filter(([, n]) => n > 0)
                .sort((a, b) => b[1] - a[1]);
            if (events.length) {
                const total = events.reduce((a, [, n]) => a + n, 0);
                out.push(`${padEnd(ansi.dim('events'), 12)} ${count(total)} total, ${Math.round(total / secs)}/s`);
                for (const [e, n] of events.slice(0, 6)) out.push(`${' '.repeat(12)}${padEnd(ansi.cyan(e), 36)}${padStart(count(n), 8)}  ${ansi.dim(`${Math.round(n / secs)}/s`)}`);
            }

            const heapAfter = heapInfo()?.usedJSHeapSize;
            if (heapBefore !== undefined && heapAfter !== undefined) {
                const delta = heapAfter - heapBefore;
                out.push(`${padEnd(ansi.dim('heap'), 12)} ${delta >= 0 ? '+' : '-'}${bytes(Math.abs(delta))}  ${ansi.dim(`now ${bytes(heapAfter)}`)}`);
            }
            for (const line of out) print(line);
        },
    };
}
