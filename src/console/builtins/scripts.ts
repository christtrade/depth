import type { CommandDef, Console } from '../Console';
import { ansi, highlightJs, inspect } from '../values';
import { editText } from './editor';
import { describeError, evaluate } from './js';

export function scriptCommands(con: Console): CommandDef[] {
    const names = (i: number) => (i === 0 ? con.scriptNames() : []);
    return [
        {
            name: 'jsedit',
            dev: true,
            help: 'jsedit <name> - write a js script full screen, saved with your setup. run <name> runs it',
            complete: names,
            run: async (ctx) => {
                const name = ctx.argv[0];
                if (!name) throw new Error('jsedit which script? a new name makes one');
                await editText(ctx, {
                    title: `jsedit  ${name}`,
                    name,
                    text: con.script(name),
                    highlight: highlightJs,
                    save: (text) => con.setScript(name, text),
                    fresh: `new script - same scope as js, plus args. run ${name} when it's saved`,
                });
            },
        },
        {
            name: 'run',
            dev: true,
            help: 'run <name> [args...] - run a saved script. args holds the words after its name',
            complete: names,
            run: async ({ argv, print, error }) => {
                const [name, ...args] = argv;
                const source = name ? con.script(name) : undefined;
                if (source === undefined) throw new Error(name ? `no script "${name}" - scripts lists them` : 'run which script?');

                try {
                    const { value, shown } = await evaluate(con, source, print, { args });
                    if (shown && value !== undefined) print(inspect(value, { timezone: 'UTC' }));
                } catch (err) {
                    error(`${name}: ${describeError(err)}`);
                }
            },
        },
        {
            name: 'scripts',
            help: 'scripts [name] - your saved scripts, or one of them',
            complete: names,
            run: ({ argv, print }) => {
                if (argv[0]) {
                    const source = con.script(argv[0]);

                    if (source === undefined) throw new Error(`no script "${argv[0]}"`);
                    source.split('\n').forEach((l, i) => print(`${ansi.dim(String(i + 1).padStart(4))}  ${highlightJs(l)}`));
                    return;
                }

                const all = con.scriptNames();
                if (!all.length) return print(ansi.dim('no scripts yet - jsedit <name> writes one'));

                for (const n of all) {
                    const src = con.script(n)!;
                    const first = src.split('\n').find((l) => l.trim())?.trim() ?? '';
                    print(`  ${ansi.cyan(n.padEnd(16))} ${ansi.dim(`${src.split('\n').length} lines`)}  ${ansi.dim(first.slice(0, 60))}`);
                }
            },
        },
        {
            name: 'jsdel',
            dev: true,
            help: 'jsdel <name> - delete a saved script',
            complete: names,
            run: ({ argv }) => {
                if (con.script(argv[0]) === undefined) throw new Error(`no script "${argv[0]}"`);
                con.setScript(argv[0], null);
            },
        },
    ];
}

