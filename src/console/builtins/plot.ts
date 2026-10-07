import type { CommandDef, Console } from '../Console';
import { ansi } from '../values';
import { completePath, describeError, evaluate } from './js';

type Series = { name: string; values: number[] };

const PREFERRED = ['close', 'value', 'equity', 'y', 'price', 'balance', 'pnl'];
const COLORS = [ansi.cyan, ansi.magenta, ansi.yellow, ansi.green, ansi.blue, ansi.red];

const num = (v: unknown) => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : NaN);

// a bar or a trade or an equity point etc just pick the field worth drawing
function fieldOf(row: Record<string, unknown>): string | undefined {
    return PREFERRED.find((k) => typeof row[k] === 'number') ?? Object.keys(row).find((k) => typeof row[k] === 'number');
}

// seriesify it
export function toSeries(v: unknown): Series[] {
    if (Array.isArray(v) && v.length) {
        if (v.every((x) => typeof x === 'number' || typeof x === 'bigint')) return [{ name: '', values: v.map(num) }];
        if (v.every((x) => Array.isArray(x))) return v.flatMap((x, i) => toSeries(x).map((s) => ({ ...s, name: s.name || `#${i}` })));
        if (v[0] && typeof v[0] === 'object') {
            const field = fieldOf(v[0] as Record<string, unknown>);

            if (field) return [{ name: field, values: v.map((r) => num((r as Record<string, unknown>)[field])) }];
        }
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
        return Object.entries(v).flatMap(([k, x]) => toSeries(x).map((s) => ({ ...s, name: s.name ? `${k}.${s.name}` : k })));
    }
    return [];
}

const DOTS = [
    [0x01, 0x08],
    [0x02, 0x10],
    [0x04, 0x20],
    [0x40, 0x80],
];

function fmt(n: number): string {
    const a = Math.abs(n);
    if (a >= 1e9) return `${(n / 1e9).toFixed(2)}b`;
    if (a >= 1e6) return `${(n / 1e6).toFixed(2)}m`;
    if (a >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
    return String(Math.round(n * 1e4) / 1e4);
}

// a nice braille line chart
// each cell is 2x4 dots, a wide series keeps its spikes
export function plotLines(series: Series[], cols: number, rows: number): string[] {
    const all = series.flatMap((s) => s.values).filter(Number.isFinite);
    if (!all.length) return [ansi.dim('nothing numeric to plot')];

    let min = Math.min(...all);
    let max = Math.max(...all);
    if (min === max) ((min -= 1), (max += 1));

    const labelW = Math.max(fmt(max).length, fmt(min).length, fmt((min + max) / 2).length) + 1;
    const W = Math.max(8, cols - labelW - 2);
    const PW = W * 2;
    const PH = rows * 4;
    const cells = Array.from({ length: rows }, () => new Uint8Array(W));
    const color = Array.from({ length: rows }, () => new Int8Array(W).fill(-1));

    const yOf = (v: number) => Math.round(((max - v) / (max - min)) * (PH - 1));
    const set = (x: number, y: number, si: number) => {
        if (x < 0 || x >= PW || y < 0 || y >= PH) return;
        const cx = x >> 1;
        const cy = y >> 2;
        cells[cy][cx] |= DOTS[y & 3][x & 1];
        color[cy][cx] = si;
    };

    series.forEach((s, si) => {
        const n = s.values.length;
        let prev: number | null = null;
        for (let x = 0; x < PW; x++) {
            // every point that lands in this column so a spike isnt lost/avgd out
            const from = Math.floor((x * n) / PW);
            const to = Math.max(from + 1, Math.floor(((x + 1) * n) / PW));

            const slice = s.values.slice(from, to).filter(Number.isFinite);
            if (!slice.length) continue;

            let lo = yOf(Math.max(...slice));
            let hi = yOf(Math.min(...slice));
            // join to the last column so a line stays a line yk
            if (prev !== null) ((lo = Math.min(lo, prev)), (hi = Math.max(hi, prev)));

            for (let y = lo; y <= hi; y++) set(x, y, si);
            prev = yOf(slice[slice.length - 1]);
        }
    });

    const out: string[] = [];
    for (let r = 0; r < rows; r++) {
        const label = r === 0 ? fmt(max) : r === rows - 1 ? fmt(min) : r === Math.floor(rows / 2) ? fmt((min + max) / 2) : '';
        let line = `${ansi.dim(label.padStart(labelW))} ${ansi.dim('┤')}`;

        for (let c = 0; c < W; c++) {
            const ch = cells[r][c] ? String.fromCharCode(0x2800 + cells[r][c]) : ' ';
            line += color[r][c] >= 0 ? COLORS[color[r][c] % COLORS.length](ch) : ch;
        }

        out.push(line);
    }
    const n = Math.max(...series.map((s) => s.values.length));

    out.push(`${' '.repeat(labelW)} ${ansi.dim('└' + '─'.repeat(W))}`);
    out.push(`${' '.repeat(labelW + 2)}${ansi.dim('0'.padEnd(W - String(n).length) + n)}`);

    if (series.length > 1 || series[0].name) {
        out.push(`${' '.repeat(labelW + 2)}${series.map((s, i) => COLORS[i % COLORS.length](`━ ${s.name}`)).join('   ')}`);
    }

    return out;
}

export function plotCommand(con: Console): CommandDef {
    return {
        name: 'plot',
        dev: true,
        rest: true,
        help: 'plot [-h rows] <js> - draw numbers as a chart: plot data.ohlcvBars, plot { a: xs, b: ys }',
        complete: (_i, _argv, current) => completePath(con, current),
        run: async ({ raw, print, error }) => {
            const m = /^-h\s+(\d+)\s+/.exec(raw);
            const rows = Math.max(4, Math.min(60, m ? Number(m[1]) : 12));
            
            const code = m ? raw.slice(m[0].length) : raw;
            if (!code.trim()) throw new Error('plot what? e.g. plot data.ohlcvBars.map(b => b.close)');

            try {
                const { value } = await evaluate(con, code, print);
                const series = toSeries(value);
                if (!series.length) throw new Error("that isn't numbers - give it an array, rows with a number in them, or { name: array }");

                for (const line of plotLines(series, con.cols, rows)) print(line);
            } catch (err) {
                error(describeError(err));
            }
        },
    };
}
