import type { Screen } from '../Console';
import { ansi, stripAnsi } from '../values';

export const visible = (s: string) => stripAnsi(s).length;

export function padEnd(s: string, w: number): string {
    const n = visible(s);
    return n >= w ? s : s + ' '.repeat(w - n);
}

export function padStart(s: string, w: number): string {
    const n = visible(s);
    return n >= w ? s : ' '.repeat(w - n) + s;
}

// cut to `w` visible cols keeping colors intact
export function clip(s: string, w: number): string {
    let out = '';
    let n = 0;

    // bruh
    for (const part of s.split(/(\x1b\[[0-9;?]*[A-Za-z]|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\))/)) {
        if (part.startsWith('\x1b[')) {
            out += part;
            continue;
        }
        if (n >= w) continue;

        out += part.slice(0, w - n);
        n += Math.min(part.length, w - n);
    }
    return out + '\x1b[0m';
}

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

// a horizontal bar `width` cells wide filled to `frac` with eighth cell ends
export function bar(frac: number, width: number, color: (s: string) => string = (s) => s): string {
    const f = Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0));
    const eighths = Math.round(f * width * 8);
    const full = Math.floor(eighths / 8);
    const body = '█'.repeat(full) + EIGHTHS[eighths % 8];

    return color(body) + ' '.repeat(Math.max(0, width - visible(body)));
}

// a bar that grows leftwards (for the bid side of a ladder)
export function barLeft(frac: number, width: number, color: (s: string) => string): string {
    const f = Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0));
    const full = Math.round(f * width);
    return ' '.repeat(width - full) + color('█'.repeat(full));
}

export function bytes(n: number): string {
    if (!Number.isFinite(n)) return '-';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;

    while (Math.abs(n) >= 1024 && i < units.length - 1) {
        n /= 1024;
        i++;
    }

    return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export const ms = (n: number) => (n >= 100 ? `${Math.round(n)}ms` : n >= 10 ? `${n.toFixed(1)}ms` : `${n.toFixed(2)}ms`);
export const count = (n: number) => n.toLocaleString('en-US');

// green under `warn` & yellow under bad n rest past it
export function heat(value: number, warn: number, bad: number): (s: string) => string {
    return value < warn ? ansi.green : value < bad ? ansi.yellow : ansi.red;
}

export const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        const t = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
    });

// redraw render() every interval ms until the screen closes
// make sure to overwrite the lines cause clearing first flickers
export async function liveScreen(
    screen: Screen,
    interval: number,
    render: () => string[],
    onRedraw?: (redraw: () => void) => void,
): Promise<void> {
    if (!onRedraw) {
        screen.onData((d) => {
            if (d === 'q' || d === 'Q') screen.close();
        });
    }
    let wake: (() => void) | null = null;
    onRedraw?.(() => wake?.());
    screen.onResize(() => wake?.());

    while (!screen.closed.aborted) {
        const lines = render().slice(0, screen.rows);
        const frame = lines.map((l) => clip(l, screen.cols) + '\x1b[K').join('\r\n');

        await screen.write(`\x1b[H${frame}\x1b[J`);
        await Promise.race([sleep(interval, screen.closed), new Promise<void>((r) => (wake = r))]);
    }
}
