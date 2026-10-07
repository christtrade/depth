import type { DepthChart } from '../../core/DepthChart';
import type { CommandDef } from '../Console';
import { ansi, formatTime } from '../values';

const FLASH_MS = 1400;

function flash(chart: DepthChart, at: bigint, label: string): void {
    const engine = chart.renderEngine;
    if (!engine || typeof requestAnimationFrame !== 'function') return;
    const started = performance.now();

    const off = engine.addDrawHook('after-ui', (ctx, _view, transformer) => {
        const t = (performance.now() - started) / FLASH_MS;
        if (t >= 1) return;

        const { width, height } = engine.plotSize;
        const x = Math.round(transformer.tsToX(at, width)) + 0.5;
        if (x < 0 || x > width) return;

        // full for the first 1/3 then fade
        const alpha = t < 0.33 ? 1 : 1 - (t - 0.33) / 0.67;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
        ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
        const w = ctx.measureText(label).width + 10;
        const left = Math.min(Math.max(0, x - w / 2), width - w);
        ctx.fillStyle = '#f59e0b';
        ctx.fillRect(left, 4, w, 16);
        ctx.fillStyle = '#111827';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, left + 5, 12);
        ctx.restore();
    });
    const tick = () => {
        engine.markDirty('ui');
        if (performance.now() - started < FLASH_MS) requestAnimationFrame(tick);
        else {
            off();
            engine.markDirty('ui');
        }
    };
    requestAnimationFrame(tick);
}

export function lookCommand(chart: DepthChart): CommandDef {
    return {
        name: 'look',
        help: 'look <time> - center the chart on a moment and flash a line there, without moving the playhead',
        args: [{ name: 'at', type: { kind: 'time' }, doc: 'now, -1h, 2024-01-05T09:30, or epoch s/ms/ns' }],
        run: ({ args, print }) => {
            const at = args.at as bigint;
            // past the horizon the chart hasnt revealed anything yet
            if (at > chart.playback.time) {
                print(ansi.yellow("that's in your future - the chart hasn't shown it yet. playback:goto (or ctrl+click) takes you there"));
                return;
            }
            chart.eventBus.emit('chart:goto-range', { fromNs: at });
            flash(chart, at, formatTime(at, chart.getChart(0).settings.timezone).slice(11, 19));
        },
    };
}
