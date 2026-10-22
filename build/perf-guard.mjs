import * as esbuild from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RATIO = 5;
const MAX_BYTES_PER_BAR = 72;

const PRIVATE = {
    'renderer.ts': 'export { drawPriceChart };',
    'status-bar.tsx': 'export { computeStatusFromEvent };',
};
const expose = {
    name: 'expose',
    setup(build) {
        build.onLoad({ filter: /(renderer\.ts|status-bar\.tsx)$/ }, (args) => {
            const name = path.basename(args.path);
            if (!PRIVATE[name]) return undefined;
            return {
                contents: `${readFileSync(args.path, 'utf8')}\n${PRIVATE[name]}\n`,
                loader: name.endsWith('.tsx') ? 'tsx' : 'ts',
            };
        });
    },
};

const out = await esbuild.build({
    stdin: {
        contents: `
            export { drawPriceChart, snapPrice } from './lib/renderers/renderer';
            export { computeStatusFromEvent } from './components/chart/status-bar';
            export { autoFitPriceAxis, prependAggregatedOhlcvBars, aggregateOhlcvBars } from './hooks/useChartData';
            export { LiveTransformer } from './interfaces/ICoordinateTransformer';
            export { SessionMapper } from './core/SessionMapper';
            export { BarStore } from './core/BarStore';
            export { DEFAULT_CHART_SETTINGS } from './lib/types/chart-settings';
        `,
        resolveDir: path.join(root, 'src'),
        loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
    write: false,
    loader: { '.css': 'empty', '.woff2': 'empty', '.wasm': 'empty', '.svg': 'empty' },
    plugins: [expose],
    logLevel: 'error',
});
const M = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);

const MIN = 60_000;
const TF = 60_000_000_000n;
const W = 800;
const H = 400;
const START = Date.UTC(2026, 0, 5);

// canvas that does nothing
// so only that charts own work is timed
const ctx = new Proxy(
    { canvas: { width: W, height: H } },
    {
        get: (o, k) =>
            k in o
                ? o[k]
                : k === 'measureText'
                  ? () => ({ width: 7 })
                  : k.startsWith?.('create')
                    ? () => ({ addColorStop() {} })
                    : () => {},
        set: (o, k, v) => ((o[k] = v), true),
    },
);

function setup(n) {
    let p = 20000;
    const raw = new M.BarStore(n);
    for (let i = 0; i < n; i++) {
        const o = p;
        p += Math.sin(i / 97) * 3 + Math.cos(i / 13);
        raw.appendRow(START + i * MIN, o, Math.max(o, p) + 2, Math.min(o, p) - 2, p, 1);
    }
    const mapper = new M.SessionMapper();
    mapper.build(null, BigInt(START) * 1_000_000n, BigInt(START + n * MIN) * 1_000_000n);
    const tr = new M.LiveTransformer();
    tr.setSessionMapper(mapper);
    tr.setBarNs(TF);
    //ca 300 bars on screen
    const endMs = START + (n - 200) * MIN;
    const view = () => ({
        tMin: BigInt(endMs - 300 * MIN) * 1_000_000n,
        tMax: BigInt(endMs) * 1_000_000n,
        pMin: 19000,
        pMax: 21000,
        pRef: 20000,
    });
    tr.update(view());
    const horizon = BigInt(START + n * MIN) * 1_000_000n;
    return { raw, mapper, tr, view, horizon };
}

function time(fn, reps) {
    let best = Infinity;
    for (let r = 0; r < 7; r++) {
        const t0 = performance.now();
        for (let i = 0; i < reps; i++) fn(i);
        best = Math.min(best, (performance.now() - t0) / reps);
    }
    return best;
}

const small = setup(20_000);
const large = setup(1_000_000);
const settings = { ...M.DEFAULT_CHART_SETTINGS, chartType: 'candles' };

const cases = {
    'draw candles': (e) => () =>
        M.drawPriceChart(ctx, [], [], e.view(), W, H, 'candles', TF, false, false, false, false, [], settings, e.horizon, null, null, e.raw, e.tr, 'ohlcv'),
    'status line': (e) => (i) =>
        M.computeStatusFromEvent((i * 37) % W, [], e.raw, null, e.view(), W, TF, null, e.horizon, 'ohlcv', e.tr),
    autofit: (e) => () =>
        M.autoFitPriceAxis(e.view(), [], [], e.raw, null, settings, e.horizon, 'ohlcv'),
    'magnet snap': (e) => (i) =>
        M.snapPrice(e.view().tMin + BigInt(i % 300) * TF, 20000, settings, [], [], e.raw, 'ohlcv', e.horizon),
};

let failed = false;
for (const [name, make] of Object.entries(cases)) {
    const a = time(make(small), 200);
    const b = time(make(large), 200);
    const ratio = b / a;
    const ok = ratio < RATIO;
    failed ||= !ok;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(14)} ${(a * 1000).toFixed(1)}µs -> ${(b * 1000).toFixed(1)}µs  ${ratio.toFixed(1)}x`);
}

// a page of history coming it - shoudl cost the page and not whats already loaded
{
    const page = Array.from({ length: 5000 }, (_, i) => ({ time: START - (5000 - i) * MIN, open: 1, high: 2, low: 0, close: 1, volume: 1 }));
    const prepend = (e) => {
        const display = M.aggregateOhlcvBars(e.raw, TF, e.mapper);
        const t0 = performance.now();
        M.prependAggregatedOhlcvBars(page, display, TF, e.mapper);
        return performance.now() - t0;
    };
    let a = Infinity, b = Infinity;
    for (let r = 0; r < 5; r++) {
        a = Math.min(a, prepend(small));
        b = Math.min(b, prepend(large));
    }
    const ratio = b / a;
    const ok = ratio < RATIO;
    failed ||= !ok;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${'page prepend'.padEnd(14)} ${a.toFixed(2)}ms -> ${b.toFixed(2)}ms  ${ratio.toFixed(1)}x`);
}

// memory - 1m bars paged in the way a chart pans back
{
    const s = new M.BarStore();
    for (let end = 1_000_000; end > 0; end -= 5000) {
        const page = [];
        for (let i = end - 5000; i < end; i++) page.push({ time: START + i * MIN, open: 1, high: 2, low: 0, close: 1, volume: 1 });
        s.prepend(page);
    }
    const perBar = s.bytes / s.length;
    const ok = perBar <= MAX_BYTES_PER_BAR;
    failed ||= !ok;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${'bytes/bar'.padEnd(14)} ${perBar.toFixed(1)} at 1M, spare room included (max ${MAX_BYTES_PER_BAR})`);
}

if (failed) {
    console.error(`\nsomething got slower or bigger as history grew - over ${RATIO}x at 1M bars`);
    process.exit(1);
}
