import type { DepthChart } from '../../core/DepthChart';
import type { CommandDef } from '../Console';
import { ansi } from '../values';
import { decimalsOf, tickOf, upperBound } from './market';
import { bar, barLeft, count, liveScreen, padEnd, padStart } from './tui';

const WINDOW_NS = 5n * 60_000_000_000n;

export function bookCommand(chart: DepthChart): CommandDef {
    return {
        name: 'book',
        help: 'book - live price ladder: resting depth on l3 data, traded volume (last 5m) on everything. q quits',
        run: async (ctx) => {
            const screen = ctx.screen();
            let quote = { bid: NaN, ask: NaN, last: NaN };
            const off = chart.on('playback:tick', (t) => (quote = t));

            await liveScreen(screen, 100, () => {
                const data = chart.getData();
                const symbol = chart.getSymbol();
                const playhead = chart.playback.time;

                const end = upperBound(data.trades, playhead);
                const start = upperBound(data.trades, playhead - WINDOW_NS);
                const recent = data.trades.slice(start, end);
                const tick = tickOf(chart.getSymbolInfo(symbol), recent.slice(-200).map((t) => t.price));

                const key = (p: number) => Math.round(p / tick);
                const bought = new Map<number, number>();
                const sold = new Map<number, number>();

                for (const t of recent) {
                    const m = t.side === 'B' ? bought : sold;
                    m.set(key(t.price), (m.get(key(t.price)) ?? 0) + t.size);
                }

                const last = Number.isFinite(quote.last) && quote.last ? quote.last : recent[recent.length - 1]?.price ?? NaN;

                const rows = Math.max(3, screen.rows - 4);
                const depth = chart.executionEngine.getDepth(Math.ceil(rows / 2) + 2);
                const bids = new Map((depth?.bids ?? []).map((l) => [key(l.price), l.size]));
                const asks = new Map((depth?.asks ?? []).map((l) => [key(l.price), l.size]));
                const hasBook = bids.size + asks.size > 0;

                const bestBid = depth?.bids[0]?.price ?? quote.bid;
                const bestAsk = depth?.asks[0]?.price ?? quote.ask;
                const mid = Number.isFinite(bestBid) && Number.isFinite(bestAsk) ? (bestBid + bestAsk) / 2 : last;

                const dec = decimalsOf(tick);
                const fmt = (p: number) => (Number.isFinite(p) ? p.toFixed(dec) : '-');
                const out: string[] = [];

                const spread = Number.isFinite(bestAsk - bestBid) ? Math.round((bestAsk - bestBid) / tick) : NaN;
                out.push(
                    `${ansi.bold('book')} ${ansi.cyan(symbol)}   bid ${ansi.green(fmt(bestBid))}   ask ${ansi.red(fmt(bestAsk))}   spread ${Number.isFinite(spread) ? `${spread} tick${spread === 1 ? '' : 's'}` : '-'}   last ${fmt(last)}`,
                );
                out.push(
                    ansi.dim(
                        hasBook
                            ? `resting depth from the order-by-order feed · traded volume over the last 5m`
                            : `${data.dataLevel} data carries no resting book - traded volume over the last 5m only`,
                    ),
                );
                if (!Number.isFinite(mid)) {
                    out.push('', ansi.dim('  nothing traded yet at the playhead'));
                    return out;
                }

                const sizeW = 9;
                const priceW = Math.max(10, fmt(mid).length + 4);
                const rest = Math.max(12, screen.cols - priceW - sizeW * 2 - 6);
                const depthW = hasBook ? Math.floor(rest * 0.3) : 0;
                const volW = rest - depthW * 2;
                out.push(
                    ansi.bold(
                        `${padStart('BIDS', depthW + sizeW)} ${padStart('PRICE', priceW)} ${padEnd('ASKS', depthW + sizeW)}  ${padEnd('TRADED  buy/sell', volW)}`,
                    ),
                );

                const center = key(mid);
                const top = center + Math.floor(rows / 2);
                const prices = Array.from({ length: rows }, (_, i) => top - i);
                const maxDepth = Math.max(1, ...prices.map((p) => Math.max(bids.get(p) ?? 0, asks.get(p) ?? 0)));
                const maxVol = Math.max(1, ...prices.map((p) => (bought.get(p) ?? 0) + (sold.get(p) ?? 0)));

                for (const p of prices) {
                    const b = bids.get(p) ?? 0;
                    const a = asks.get(p) ?? 0;
                    const buy = bought.get(p) ?? 0;
                    const sell = sold.get(p) ?? 0;
                    const price = p * tick;

                    const isLast = Number.isFinite(last) && key(last) === p;
                    let label = padStart(fmt(price), priceW);

                    if (key(bestBid) === p) label = ansi.green(ansi.bold(label));
                    else if (key(bestAsk) === p) label = ansi.red(ansi.bold(label));
                    else if (p > center) label = ansi.dim(label);

                    const bidCol = hasBook ? `${barLeft(b / maxDepth, depthW, ansi.green)}${padStart(b ? count(b) : '', sizeW)}` : '';
                    const askCol = hasBook ? `${padEnd(a ? count(a) : '', sizeW)}${bar(a / maxDepth, depthW, ansi.red)}` : padEnd('', sizeW);
                    const total = buy + sell;

                    const len = Math.round(Math.max(0, volW - 12) * (total / maxVol));
                    const buyLen = total ? Math.round((len * buy) / total) : 0;
                    const volBar = ansi.green('█'.repeat(buyLen)) + ansi.red('█'.repeat(len - buyLen));
                    const volText = total ? ansi.dim(` ${count(total)}`) : '';
                    out.push(`${hasBook ? bidCol : padStart('', sizeW)} ${label}${isLast ? ansi.yellow('◀') : ' '}${askCol}  ${volBar}${volText}`);
                }
                return out;
            });
            off();
        },
    };
}
