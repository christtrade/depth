import type { CommandDef, Console } from '../Console';
import { splitStatements } from '../lex';
import { ansi, formatValue, inspect } from '../values';

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    ...args: string[]
) => (...values: unknown[]) => Promise<unknown>;

const IDENT = /^[A-Za-z_$][\w$]*$/;

// own and inherited keys minus object.prototype's
function propsOf(obj: unknown): string[] {
    const out = new Set<string>();
    let o: unknown = obj;
    while (o !== null && o !== undefined && o !== Object.prototype && o !== Function.prototype) {
        for (const k of Object.getOwnPropertyNames(o)) if (IDENT.test(k) && k !== 'constructor') out.add(k);
        o = Object.getPrototypeOf(o);
    }
    return [...out];
}

const lastResult = new WeakMap<Console, unknown>();

export function jsScope(con: Console, print: (t: string) => void, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        ...con.scope,
        con,
        $_: lastResult.get(con),
        print: (...vals: unknown[]) =>
            print(vals.map((v) => (typeof v === 'string' ? v : formatValue(v, { timezone: 'UTC' }))).join(' ')),
        sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
        ...extra,
    };
}

// run code the way a repl would
// the value of the whole thing if its one expression, else of its last statement if thats one
export async function evaluate(
    con: Console,
    raw: string,
    print: (t: string) => void,
    extra?: Record<string, unknown>,
): Promise<{ value: unknown; shown: boolean }> {
    const names = jsScope(con, print, extra);
    const keys = Object.keys(names).filter((k) => IDENT.test(k));
    const values = keys.map((k) => names[k]);
    const parts = splitStatements(raw).map((s) => s.text);

    while (parts.length > 1 && !parts[parts.length - 1].trim()) parts.pop();

    const head = parts.slice(0, -1).join(';');
    const tail = parts[parts.length - 1];
    const attempts = [`return (\n${raw}\n);`, `${head};\nreturn (\n${tail}\n);`, raw];
    let fn: ((...v: unknown[]) => Promise<unknown>) | null = null;

    let isExpr = true;
    let lastErr: unknown;

    for (const [i, body] of attempts.entries()) {
        if (i === 1 && parts.length < 2) continue;
        try {
            fn = new AsyncFunction(...keys, body);
            isExpr = i === 0;
            break;
        } catch (err) {
            lastErr = err;
        }
    }

    if (!fn) throw lastErr;

    const value = await fn(...values);
    const shown = isExpr || value !== undefined;

    if (shown) lastResult.set(con, value);

    return { value, shown };
}

export const describeError = (err: unknown) =>
    err instanceof Error ? `${err.name}: ${err.message}` : `thrown: ${formatValue(err, { timezone: 'UTC' })}`;

// tab completion for a dotted path through the js scope, so like chart.playback.pl -> chart.playback.play
export function completePath(con: Console, current: string): string[] {
    //cant decide if I hate regex or love it...?
    const m = /^((?:[A-Za-z_$][\w$]*\.)*)([\w$]*)$/.exec(current);
    if (!m) return [];

    const path = m[1].split('.').filter(Boolean);
    const names = jsScope(con, () => {});
    if (!path.length) return Object.keys(names);

    let obj: unknown = names[path[0]];

    for (const seg of path.slice(1)) {
        if (obj === null || obj === undefined) return [];
        try {
            obj = (obj as Record<string, unknown>)[seg];
        } catch {
            return [];
        }
    }
    return propsOf(obj).map((k) => m[1] + k);
}

export function jsCommand(con: Console): CommandDef {
    return {
        name: 'js',
        dev: true,
        rest: true,
        help: 'js <code> - run JavaScript with the chart in scope. js alone lists what is in scope; $_ is the last result',
        complete: (_i, _argv, current) => completePath(con, current),
        run: async ({ raw, print, error }) => {
            if (!raw) {
                for (const [k, v] of Object.entries(jsScope(con, print))) {
                    const kind = typeof v === 'function' ? 'ƒ' : v?.constructor?.name ?? typeof v;
                    print(`  ${ansi.cyan(k.padEnd(10))} ${ansi.dim(kind)}`);
                }
                return;
            }
            try {
                const { value, shown } = await evaluate(con, raw, print);
                if (shown) print(inspect(value, { timezone: 'UTC' }));
            } catch (err) {
                error(describeError(err));
            }
        },
    };
}
