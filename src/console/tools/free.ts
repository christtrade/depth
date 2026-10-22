import type { DepthChart } from '../../core/DepthChart';
import { StorageKey, chartStorageKeys, chartStorageSize, readStored } from '../../lib/storage';
import type { CommandDef } from '../Console';
import { ansi } from '../values';
import { heapInfo } from './top';
import { bar, bytes, count, heat, padEnd, padStart } from './tui';

// rough size of an array of flat records (a header + slot per field)
// good to within a factor of 2 which is really what it only needs 
function estimate(rows: readonly unknown[]): number {
    if (!rows.length) return 0;
    const first = rows[0];
    const fields = first && typeof first === 'object' ? Object.keys(first).length : 1;
    return rows.length * (16 + fields * 12);
}

export function freeCommand(chart: DepthChart): CommandDef {
    return {
        name: 'free',
        help: 'free - memory: the js heap, what the chart holds, what is saved. watch 1s free for live',
        run: async ({ print }) => {
            const heap = heapInfo();
            const row = (label: string, ...cols: string[]) =>
                print(`${padEnd(label, 16)}${cols.map((c) => padStart(c, 12)).join('')}`);

            print(ansi.bold(`${padEnd('', 16)}${['total', 'used', 'free'].map((c) => padStart(c, 12)).join('')}`));
            if (heap) {
                const frac = heap.usedJSHeapSize / heap.jsHeapSizeLimit;
                row('heap', bytes(heap.jsHeapSizeLimit), bytes(heap.usedJSHeapSize), bytes(heap.jsHeapSizeLimit - heap.usedJSHeapSize));
                row('  allocated', bytes(heap.totalJSHeapSize), '', '');
                print(`${padEnd('', 16)}${bar(frac, 36, heat(frac, 0.6, 0.85))} ${Math.round(frac * 100)}%`);
            } else print(ansi.dim('heap            not exposed by this browser (chromium only)'));

            // the whole page workers included, needs cross origin isolation
            const measure = (performance as unknown as { measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }> })
                .measureUserAgentSpecificMemory;
            if (measure && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated) {
                try {
                    row('page + workers', '', bytes((await measure.call(performance)).bytes), '');
                } catch {
                    /* refused, not worth a line */
                }
            }

            print('');
            const data = chart.getData();
            print(ansi.bold(`${padEnd('chart data', 16)}${padStart('rows', 12)}${padStart('≈ size', 12)}`));
            const sets: [string, number, number][] = [
                ['trades', data.trades.length, estimate(data.trades)],
                ['bars', data.bars.length, data.bars.bytes],
                ['footprint', data.footprintBars.length, estimate(data.footprintBars)],
                ['price history', data.priceHistory.length, estimate(data.priceHistory)],
                ['ticks', data.ticks.length, estimate(data.ticks)],
            ];

            let total = 0;
            for (const [name, n, size] of sets) {
                total += size;
                if (n) row(`  ${name}`, count(n), bytes(size));
            }
            row('  total', '', bytes(total));
            print(ansi.dim(`  ${data.dataLevel} data, active symbol only - each pane on another symbol holds its own`));

            print('');
            const keys = chartStorageKeys();
            const consoleBytes = [StorageKey.console, StorageKey.consoleHistory]
                .map((k) => (readStored(k) ?? '').length)
                .reduce((a, b) => a + b, 0);
            print(ansi.bold('saved'));
            row('  chart storage', `${count(keys.length)} keys`, bytes(chartStorageSize()));
            row('  console', '', bytes(consoleBytes));
        },
    };
}
