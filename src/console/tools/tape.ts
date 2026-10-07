import type { DepthChart } from '../../core/DepthChart';
import type { CommandDef } from '../Console';
import { ansi, formatTime, gotoLink } from '../values';
import { decimalsOf, tickOf, upperBound } from './market';
import { bar, count, liveScreen, padEnd, padStart } from './tui';

const MINUTE_NS = 60_000_000_000n;

export function tapeCommand(chart: DepthChart): CommandDef {
    return {
        name: 'tape',
        help: 'tape [min size] - time and sales at the playhead, newest on top. big prints stand out. q quits',
        run: async (ctx) => {
            const minSize = Number(ctx.argv[0]) || 0;
            const screen = ctx.screen();

            await liveScreen(screen, 100, () => {
                const data = chart.getData();
                const symbol = chart.getSymbol();
                const tz = chart.getChart(0).settings.timezone;
                const playhead = chart.playback.time;
                const out: string[] = [];

                if (!data.trades.length) {
                    out.push(`${ansi.bold('tape')} ${ansi.cyan(symbol)}`, '');
                    out.push(ansi.dim(`  ${data.dataLevel} data has no individual trades - tape needs tick or l3 data`));
                    return out;
                }

                const end = upperBound(data.trades, playhead);
                const minuteStart = upperBound(data.trades, playhead - MINUTE_NS);
                const minute = data.trades.slice(minuteStart, end);
                const buyVol = minute.reduce((s, t) => s + (t.side === 'B' ? t.size : 0), 0);
                const vol = minute.reduce((s, t) => s + t.size, 0);
                const buyFrac = vol ? buyVol / vol : 0.5;

                out.push(
                    `${ansi.bold('tape')} ${ansi.cyan(symbol)}   last minute: ${count(minute.length)} trades  vol ${count(vol)}   ${ansi.green(`buy ${Math.round(buyFrac * 100)}%`)} ${bar(buyFrac, 16, ansi.green)}${ansi.red(`${Math.round((1 - buyFrac) * 100)}% sell`)}${minSize ? ansi.dim(`   size ≥ ${minSize}`) : ''}`,
                );

                const rows = Math.max(1, screen.rows - 3);
                const shown: typeof data.trades = [];
                for (let i = end - 1; i >= 0 && shown.length < rows; i--) {
                    if (data.trades[i].size >= minSize) shown.push(data.trades[i]);
                }

                // a pritn is big when its in the top 5% of the last few hundred
                const sizes = data.trades.slice(Math.max(0, end - 500), end).map((t) => t.size).sort((a, b) => a - b);
                const big = sizes[Math.floor(sizes.length * 0.95)] ?? Infinity;
                const maxShown = Math.max(1, ...shown.map((t) => t.size));
                const tick = tickOf(chart.getSymbolInfo(symbol), shown.map((t) => t.price));
                const dec = decimalsOf(tick);
                const barW = Math.max(0, screen.cols - 46);

                out.push(ansi.bold(`${padEnd('TIME', 14)}${padStart('PRICE', 12)}  ${padStart('SIZE', 8)}  SIDE`));
                shown.forEach((t, i) => {
                    const prev = shown[i + 1];
                    const move = !prev ? ' ' : t.price > prev.price ? '▲' : t.price < prev.price ? '▼' : ' ';
                    const color = t.side === 'B' ? ansi.green : ansi.red;
                    const isBig = t.size >= big && sizes.length > 20;
                    const size = padStart(count(t.size), 8);
                    out.push(
                        `${gotoLink(ansi.dim(formatTime(t.ts, tz).slice(11)), t.ts)}  ${color(padStart(t.price.toFixed(dec), 11))}${color(move)}  ${isBig ? ansi.bold(ansi.yellow(size)) : size}  ${color(t.side === 'B' ? 'buy ' : 'sell')}  ${bar(t.size / maxShown, barW, color)}`,
                    );
                });
                return out;
            });
        },
    };
}
