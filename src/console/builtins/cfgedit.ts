import type { CommandDef, Console } from '../Console';
import { ansi } from '../values';
import { editText } from './editor';

// first word cyan, strings green n comments dim
function highlight(line: string): string {
    const comment = line.indexOf('//');
    const code = comment >= 0 ? line.slice(0, comment) : line;
    const rest = comment >= 0 ? ansi.dim(line.slice(comment)) : '';
    return (
        code
            .replace(/("[^"]*"?|'[^']*'?)/g, (s) => ansi.green(s))
            .replace(/^(\s*)([^\s;"']+)/, (_m, ws, w) => ws + ansi.cyan(w))
            .replace(/;\s*([^\s;"']+)/g, (m, w) => m.replace(w, ansi.cyan(w))) + rest
    );
}

export function cfgEditCommand(con: Console): CommandDef {
    return {
        name: 'cfgedit',
        help: 'cfgedit <cfg> - edit a cfg full screen. ctrl+s saves, ctrl+x leaves, ctrl+c leaves without saving',
        complete: (i) => (i === 0 ? con.cfgNames() : []),
        run: async (ctx) => {
            const name = ctx.argv[0];
            if (!name) throw new Error('cfgedit which cfg? (a new name makes one - try autoexec)');
            await editText(ctx, {
                title: `cfgedit  ${name}`,
                name,
                text: con.cfg(name),
                highlight,
                save: (text) => con.setCfg(name, text),
                fresh: 'new cfg',
            });
        },
    };
}
