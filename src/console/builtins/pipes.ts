import type { CommandContext, CommandDef, Console } from '../Console';
import { quote } from '../lex';
import { ansi, stripAnsi } from '../values';
import { clip, liveScreen } from '../tools/tui';

function needInput(ctx: CommandContext, name: string, example: string): string[] {
    if (ctx.input === null) throw new Error(`${name} reads from a pipe: ${example}`);
    return ctx.input;
}

// leading -x -y flags then the rest
function flags(argv: string[]): { on: Set<string>; rest: string[] } {
    const on = new Set<string>();
    let i = 0;
    for (; i < argv.length && /^-[a-z]+$/i.test(argv[i]); i++) for (const f of argv[i].slice(1)) on.add(f);
    return { on, rest: argv.slice(i) };
}

function pattern(src: string, insensitive: boolean): RegExp {
    try {
        return new RegExp(src, insensitive ? 'gi' : 'g');
    } catch {
        return new RegExp(src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), insensitive ? 'gi' : 'g');
    }
}

const firstNumber = (s: string) => Number(/-?\d+(\.\d+)?/.exec(stripAnsi(s))?.[0] ?? NaN);

export function pipeCommands(con: Console): CommandDef[] {
    return [
        {
            name: 'grep',
            help: 'grep [-v] [-i] [-c] <pattern> - keep the lines that match. cvarlist | grep foot',
            run: (ctx) => {
                const lines = needInput(ctx, 'grep', 'cvarlist | grep foot');
                const { on, rest } = flags(ctx.argv);

                if (!rest.length) throw new Error('grep what?');

                const re = pattern(rest.join(' '), on.has('i'));
                const hits = lines.filter((l) => {
                    re.lastIndex = 0;
                    return re.test(stripAnsi(l)) !== on.has('v');
                });

                if (on.has('c')) return ctx.print(String(hits.length));

                for (const l of hits) {
                    // colored lines keep their colors and plain ones get the match lit up
                    ctx.print(l.includes('\x1b[') || on.has('v') ? l : l.replace(re, (m) => ansi.bold(ansi.red(m))));
                }
            },
        },
        {
            name: 'head',
            help: 'head [n] - the first n lines, 10 by default',
            run: (ctx) => needInput(ctx, 'head', 'history 100 | head 5').slice(0, Number(ctx.argv[0]) || 10).forEach((l) => ctx.print(l)),
        },
        {
            name: 'tail',
            help: 'tail [n] - the last n lines, 10 by default',
            run: (ctx) => needInput(ctx, 'tail', 'cmdlist | tail').slice(-(Number(ctx.argv[0]) || 10)).forEach((l) => ctx.print(l)),
        },
        {
            name: 'count',
            help: 'count - how many lines came in',
            run: (ctx) => ctx.print(String(needInput(ctx, 'count', 'cmdlist playback:* | count').length)),
        },
        {
            name: 'sort',
            help: 'sort [-r] [-n] - sort lines, -n by the first number in each',
            run: (ctx) => {
                const { on } = flags(ctx.argv);
                const lines = [...needInput(ctx, 'sort', 'cvarlist | sort')];
                lines.sort(on.has('n') ? (a, b) => firstNumber(a) - firstNumber(b) : (a, b) => stripAnsi(a).localeCompare(stripAnsi(b)));

                if (on.has('r')) lines.reverse();
                lines.forEach((l) => ctx.print(l));
            },
        },
        {
            name: 'uniq',
            help: 'uniq [-c] - drop repeated lines, -c counts them',
            run: (ctx) => {
                const { on } = flags(ctx.argv);
                const seen = new Map<string, number>();
                for (const l of needInput(ctx, 'uniq', 'history 500 | sort | uniq -c')) seen.set(l, (seen.get(l) ?? 0) + 1);
                for (const [l, n] of seen) ctx.print(on.has('c') ? `${ansi.dim(String(n).padStart(5))} ${l}` : l);
            },
        },
        {
            name: 'less',
            help: 'less [command] - scroll through output. cvarlist | less, or less cvarlist. / searches, q quits',
            run: async (ctx) => {
                const lines = (ctx.input ?? (await con.capture(ctx.argv.map(quote).join(' '), ctx.signal))).flatMap((l) => l.split('\n'));
                if (!lines.length) return;

                const screen = ctx.screen();
                let top = 0;
                let search = '';
                let typing: string | null = null;
                let note = '';

                const view = () => Math.max(1, screen.rows - 1);
                const maxTop = () => Math.max(0, lines.length - view());

                const find = (from: number, dir: 1 | -1) => {
                    if (!search) return;

                    const re = pattern(search, true);
                    for (let i = from; i >= 0 && i < lines.length; i += dir) {
                        re.lastIndex = 0;
                        if (re.test(stripAnsi(lines[i]))) return void (top = Math.min(i, maxTop()));
                    }

                    note = `no more "${search}"`;
                };

                let redraw: () => void = () => {};
                screen.onData((d) => {
                    note = '';
                    if (typing !== null) {
                        if (d === '\r') {
                            search = typing;
                            typing = null;
                            find(top, 1);
                        } else if (d === '\x7f') typing = typing.slice(0, -1);
                        else if (d === '\x1b') typing = null;
                        else if (!d.startsWith('\x1b')) typing += d;
                        return redraw();
                    }

                    const page = view();
                    const moves: Record<string, () => void> = {
                        q: () => screen.close(),
                        j: () => (top += 1),
                        '\x1b[B': () => (top += 1),
                        '\r': () => (top += 1),
                        k: () => (top -= 1),
                        '\x1b[A': () => (top -= 1),
                        ' ': () => (top += page),
                        '\x1b[6~': () => (top += page),
                        b: () => (top -= page),
                        '\x1b[5~': () => (top -= page),
                        g: () => (top = 0),
                        '\x1b[H': () => (top = 0),
                        G: () => (top = maxTop()),
                        '\x1b[F': () => (top = maxTop()),
                        '/': () => (typing = ''),
                        n: () => find(top + 1, 1),
                        N: () => find(top - 1, -1),
                    };
                    moves[d]?.();
                    top = Math.max(0, Math.min(top, maxTop()));
                    redraw();
                });
                await liveScreen(screen, 60_000, () => {
                    const re = search ? pattern(search, true) : null;
                    const body = lines.slice(top, top + view()).map((l) => (re && !l.includes('\x1b[') ? l.replace(re, (m) => `\x1b[7m${m}\x1b[27m`) : l));

                    while (body.length < view()) body.push(ansi.dim('~'));

                    const pos = `${top + 1}-${Math.min(lines.length, top + view())} of ${lines.length}`;
                    const status =
                        typing !== null
                            ? `/${typing}\x1b[?25h`
                            : `\x1b[7m ${note || pos} \x1b[27m ${ansi.dim('space/b page  / search  n/N next  g/G ends  q quit')}`;

                    return [...body, clip(status, screen.cols)];
                }, (r) => (redraw = r));
            },
        },
    ];
}
