import type { DepthChart } from '../../core/DepthChart';
import type { CommandDef, Console } from '../Console';
import { ansi, formatTime, formatValue, inspect, stripAnsi } from '../values';
import { clip, liveScreen, padEnd } from './tui';

type Entry = { at: number; perf: number; event: string; data: unknown; kept: boolean };
type Change = { at: number; key: string; value: unknown; owner?: string; stack: string[] };

const HEAVY = /^(data:(load|append|prepend|refine|open-bar-provider)|status:compute|plugin:(scripted-|register-|add-indicator)|render-engine:ready|hitmap:update)/;

const globRe = (glob: string) =>
    new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');

// "at fn (webpack-internal:///./src/ChartOuter.tsx:820:13)" -> "fn  ChartOuter.tsx:820"
function frames(stack: string | undefined): string[] {
    return (stack ?? '')
        .split('\n')
        .slice(1)
        .map((l) => l.trim())
        .filter((l) => l && !/TypedEventBus|console\/tools\/trace|node_modules|react-dom|scheduler|<anonymous>/.test(l))
        .map((l) => {
            const m = /^at (?:async )?(.*?) ?\(?([^()\s]+?):(\d+):\d+\)?$/.exec(l) ?? /^(.*?)@(.+?):(\d+):\d+$/.exec(l);
            if (!m) return l;
            const file = m[2].split(/[/\\]/).pop()?.split('?')[0] ?? m[2];
            return `${m[1] || 'anonymous'}  ${file}:${m[3]}`;
        })
        .slice(0, 5);
}

export function traceTools(chart: DepthChart, con: Console): CommandDef[] {
    const ring: Entry[] = [];
    let cap = 5000;
    let recording = false;
    let total = 0;
    const changes: Change[] = [];

    chart.eventBus.tap((event, data) => {
        if (event === 'chart:apply-settings' || event === 'plugin:apply-params') {
            const stack = frames(new Error().stack);
            const patch = (event === 'chart:apply-settings' ? (data as { patch: object }).patch : (data as { params: object }).params) ?? {};
            const owner = event === 'plugin:apply-params' ? (data as { id: string }).id : undefined;

            for (const [key, value] of Object.entries(patch)) changes.push({ at: Date.now(), key, value, owner, stack });
            if (changes.length > 2000) changes.splice(0, changes.length - 2000);
        }
        if (!recording) return;

        const kept = !HEAVY.test(event);
        ring.push({ at: Date.now(), perf: performance.now(), event, data: kept ? data : summarize(data), kept });
        total++;

        if (ring.length > cap) ring.splice(0, ring.length - cap);
    });

    con.registerCvar({
        name: 'trace_size',
        type: { kind: 'number' },
        help: 'events trace keeps before dropping the oldest',
        default: 5000,
        get: () => cap,
        set: (v) => (cap = Math.max(100, Math.floor(Number(v)))),
    });

    const tz = () => chart.getChart(0).settings.timezone;
    const clock = (at: number) => formatTime(BigInt(at) * 1_000_000n, tz()).slice(11);

    const trace: CommandDef = {
        name: 'trace',
        help: 'trace [on|off|clear] - record every bus event, then browse them. trace alone opens the viewer',
        complete: (i) => (i === 0 ? ['on', 'off', 'clear'] : []),
        run: async (ctx) => {
            const sub = ctx.argv[0];
            if (sub === 'on') return void ((recording = true), ctx.print(ansi.dim('recording every event - trace to browse, trace off to stop')));
            if (sub === 'off') return void ((recording = false), ctx.print(ansi.dim(`stopped, ${ring.length} events kept`)));
            if (sub === 'clear') return void ((ring.length = 0), (total = 0));
            if (sub) throw new Error('trace on | off | clear, or nothing to browse');

            if (!recording && !ring.length) {
                recording = true;
                ctx.print(ansi.dim('nothing recorded yet - recording now. come back once something happened.'));
                return;
            }

            const screen = ctx.screen({ maximize: true });
            let sel = ring.length - 1;
            let follow = true;
            let detail = false;
            let filter = '';
            let typing: string | null = null;
            let redraw: () => void = () => {};
            const shown = () => (filter ? ring.filter((e) => globRe(filter).test(e.event)) : ring);

            screen.onData((d) => {
                const list = shown();
                if (typing !== null) {
                    if (d === '\r') ((filter = typing), (typing = null), (sel = shown().length - 1), (follow = true));
                    else if (d === '\x7f') typing = typing.slice(0, -1);
                    else if (d === '\x1b') typing = null;
                    else if (!d.startsWith('\x1b')) typing += d;
                    return redraw();
                }

                const page = Math.max(1, screen.rows - 4);
                const keys: Record<string, () => void> = {
                    q: () => screen.close(),
                    '\x1b[A': () => ((sel -= 1), (follow = false)),
                    k: () => ((sel -= 1), (follow = false)),
                    '\x1b[B': () => (sel += 1),
                    j: () => (sel += 1),
                    '\x1b[5~': () => ((sel -= page), (follow = false)),
                    '\x1b[6~': () => (sel += page),
                    g: () => ((sel = 0), (follow = false)),
                    G: () => ((sel = list.length - 1), (follow = true)),
                    '\r': () => (detail = !detail),
                    '/': () => (typing = filter),
                    f: () => (typing = filter),
                    ' ': () => (recording = !recording),
                    c: () => ((ring.length = 0), (sel = 0)),
                };

                keys[d]?.();
                if (sel >= list.length - 1) follow = true;
                redraw();
            });

            await liveScreen(
                screen,
                200,
                () => {
                    const list = shown();
                    if (follow) sel = list.length - 1;

                    sel = Math.max(0, Math.min(sel, list.length - 1));
                    const w = screen.cols;
                    const out: string[] = [];

                    out.push(
                        `${ansi.bold('trace')}  ${list.length.toLocaleString()} shown · ${total.toLocaleString()} seen   ${recording ? ansi.red('● recording') : ansi.dim('❚❚ paused')}   ${filter ? `filter ${ansi.cyan(filter)}` : ansi.dim('no filter')}`,
                    );

                    const pick = list[sel];
                    const detailLines = detail && pick ? inspect(pick.data, { timezone: tz() }, 3).split('\n') : [];
                    const detailH = detail ? Math.min(detailLines.length + 1, Math.floor((screen.rows - 3) / 2)) : 0;
                    const listH = Math.max(1, screen.rows - 2 - detailH);
                    const top = Math.max(0, Math.min(sel - listH + 1 + Math.floor(listH / 3), list.length - listH));

                    for (let i = top; i < Math.min(list.length, top + listH); i++) {
                        const e = list[i];
                        const prev = list[i - 1];
                        const gap = prev ? e.perf - prev.perf : 0;
                        const gapText = gap >= 1000 ? `+${(gap / 1000).toFixed(1)}s` : `+${gap.toFixed(gap < 10 ? 1 : 0)}ms`;
                        const body = e.data === undefined ? '' : e.kept ? formatValue(e.data, { timezone: tz() }) : ansi.dim(String(e.data));
                        let row = `${ansi.dim(clock(e.at))} ${ansi.dim(gapText.padStart(8))} ${padEnd(ansi.cyan(e.event), 34)} ${body}`;

                        if (i === sel) row = `\x1b[7m${clip(stripAnsi(row), w)}${' '.repeat(Math.max(0, w - stripAnsi(row).length))}\x1b[27m`;
                        out.push(row);
                    }

                    while (out.length < listH + 1) out.push('');

                    if (detail) {
                        out.push(ansi.dim('─'.repeat(w)));
                        out.push(...detailLines.slice(0, detailH - 1));
                    }

                    out.length = Math.min(out.length, screen.rows - 1);
                    while (out.length < screen.rows - 1) out.push('');
                    out.push(
                        typing !== null
                            ? `filter (glob): ${typing}\x1b[?25h`
                            : ansi.dim('↑↓ move  enter payload  / filter  space pause  c clear  G follow  q quit'),
                    );
                    return out;
                },
                (r) => (redraw = r),
            );
        },
    };

    const why: CommandDef = {
        name: 'why',
        help: 'why [setting] - what changed it, when, and from where. why alone lists the latest changes',
        complete: (i) => (i === 0 ? [...new Set(changes.map((c) => c.key))] : []),
        run: ({ argv, print }) => {
            if (!argv[0]) {
                const recent = changes.slice(-12).reverse();
                if (!recent.length) return print(ansi.dim('no setting has changed since the chart loaded'));

                for (const c of recent) {
                    print(`  ${ansi.dim(clock(c.at))}  ${padEnd(c.key, 26)} ${formatValue(c.value, { timezone: tz() }, c.key)}  ${ansi.dim(c.stack[0] ?? '')}`);
                }
                return;
            }

            const key = argv[0].includes('.') ? argv[0].slice(argv[0].lastIndexOf('.') + 1) : argv[0];
            const hits = changes.filter((c) => c.key.toLowerCase() === key.toLowerCase()).reverse();
            if (!hits.length) {
                print(`${argv[0]} hasn't changed since the chart loaded - it's whatever was saved, or the default`);
                return;
            }

            hits.slice(0, 5).forEach((c, i) => {
                print(`${i === 0 ? ansi.bold(argv[0]) : ansi.dim(argv[0])} = ${formatValue(c.value, { timezone: tz() }, c.key)}  ${ansi.dim(`at ${clock(c.at)}${c.owner ? ` on ${c.owner}` : ''}`)}`);
                for (const f of c.stack) print(ansi.dim(`    ${f}`));
            });

            if (hits.length > 5) print(ansi.dim(`  … ${hits.length - 5} older changes`));
        },
    };

    return [trace, why];
}

function summarize(data: unknown): string {
    if (!data || typeof data !== 'object') return String(data);
    const keys = Object.keys(data);
    return `{ ${keys.slice(0, 6).join(', ')}${keys.length > 6 ? ', …' : ''} } (not kept)`;
}
