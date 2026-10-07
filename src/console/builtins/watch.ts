import type { CommandDef, Console } from '../Console';
import { quote } from '../lex';
import { ansi, formatDuration, parseDuration } from '../values';

const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        const t = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
    });

export function watchCommand(con: Console): CommandDef {
    return {
        name: 'watch',
        help: 'watch [interval] <command> - rerun it full screen, e.g. watch 500ms status. ctrl+c stops',
        run: async (ctx) => {
            const d = parseDuration(ctx.argv[0] ?? '');
            const words = d === null ? ctx.argv : ctx.argv.slice(1);

            const line = words.map(quote).join(' ');
            if (!line) throw new Error('usage: watch [interval] <command>');

            const ms = Math.max(100, d === null ? 2000 : Number(d / 1_000_000n));
            const screen = ctx.screen();

            while (!screen.closed.aborted) {
                const started = Date.now();
                const out = await con.capture(line, screen.closed);
                if (screen.closed.aborted) break;

                const clock = new Date().toLocaleTimeString();
                const title = `${ansi.dim(`every ${formatDuration(BigInt(ms) * 1_000_000n)}:`)} ${line}`;
                const gap = Math.max(1, screen.cols - title.replace(/\x1b\[[0-9;]*m/g, '').length - clock.length);
                const body = out.join('\n').split('\n').slice(0, Math.max(0, screen.rows - 2));

                // overwrite in place and then clear the tails, clearing first causes flickers
                const frame = [`${title}${' '.repeat(gap)}${ansi.dim(clock)}`, '', ...body].map((l) => `${l}\x1b[K`).join('\r\n');
                await screen.write(`\x1b[H${frame}\x1b[J`);
                await sleep(ms - (Date.now() - started), screen.closed);
            }
        },
    };
}
