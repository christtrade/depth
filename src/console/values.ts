import { DateTime } from 'luxon';
import type { ArgType } from './types';

export const ansi = {
    red: (s: string) => `\x1b[31m${s}\x1b[0m`,
    green: (s: string) => `\x1b[32m${s}\x1b[0m`,
    yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
    blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
    magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
    cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
    dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
    bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

export function stripAnsi(s: string): string {
    return s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
}

// clickable text, the terminal decies what clicking does
export function link(text: string, uri: string): string {
    return `\x1b]8;;${uri}\x1b\\${text}\x1b]8;;\x1b\\`;
}

export const gotoLink = (text: string, ns: bigint) => link(text, `ct:goto/${ns}`);
export const helpLink = (text: string, name: string) => link(text, `ct:help/${encodeURIComponent(name)}`);
export const fillLink = (text: string, line: string) => link(text, `ct:fill/${encodeURIComponent(line)}`);

/** Turns console txt into a value for a named type, ex "5m" into `Timeframe` */
export interface TypeParser {
    parse(text: string): unknown;
    /** candidates for tab completion */
    complete?(): string[];
}

export type ParseEnv = {
    timezone: string;
    playheadNs: () => bigint;
    types: ReadonlyMap<string, TypeParser>;
};

const NS_PER: Record<string, bigint> = {
    ns: 1n,
    us: 1_000n,
    ms: 1_000_000n,
    s: 1_000_000_000n,
    m: 60_000_000_000n,
    h: 3_600_000_000_000n,
    d: 86_400_000_000_000n,
    w: 604_800_000_000_000n,
};

// "1h30m"/"250ms"/"2d" to ns
export function parseDuration(text: string): bigint | null {
    const t = text.trim().toLowerCase();
    if (!t || !/^(\d+(\.\d+)?(ns|us|ms|s|m|h|d|w))+$/.test(t)) return null;
    let total = 0n;

    for (const [, num, , unit] of t.matchAll(/(\d+(\.\d+)?)(ns|us|ms|s|m|h|d|w)/g)) {
        const [whole, frac = ''] = num.split('.');
        const scale = 10n ** BigInt(frac.length);

        total += (BigInt(whole + frac) * NS_PER[unit]) / scale;
    }
    return total;
}

export function parseTime(text: string, env: ParseEnv): bigint {
    const t = text.trim();
    if (t === 'now') return BigInt(Date.now()) * 1_000_000n;

    // "+5m"/"-1h"
    const rel = /^([+-])(.+)$/.exec(t);
    if (rel) {
        const d = parseDuration(rel[2]);
        if (d === null) throw new Error(`bad offset "${t}" - try -1h or +30m`);

        return rel[1] === '+' ? env.playheadNs() + d : env.playheadNs() - d;
    }
    //fallback to epoch ts
    if (/^\d+$/.test(t)) {
        if (t.length <= 10) return BigInt(t) * 1_000_000_000n;
        if (t.length <= 13) return BigInt(t) * 1_000_000n;

        return BigInt(t);
    }

    //then iso
    const iso = t.replace(' ', 'T');
    const dt = DateTime.fromISO(iso, { zone: env.timezone });
    if (!dt.isValid) throw new Error(`can't read "${t}" as a time - try 2024-01-05T09:30, -1h or now`);

    return BigInt(dt.toMillis()) * 1_000_000n;
}

export const isDurationArg = (name: string) => /^(span|bar|step)\w*Ns$/.test(name);
export const isTimeArg = (name: string) => /(Ns|^ts)$/.test(name) && !isDurationArg(name);

const BOOLS: Record<string, boolean> = { 1: true, 0: false, true: true, false: false, on: true, off: false, yes: true, no: false };
const COLOR = /^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(rgba?|hsla?)\([^)]*\)|transparent)$/i;

export function parseValue(raw: string, type: ArgType, opts: { nullable?: boolean; name?: string }, env: ParseEnv): unknown {
    if (opts.nullable && /^(null|none|auto)$/i.test(raw)) return null;

    switch (type.kind) {
        case 'string':
            return raw;
        case 'boolean': {
            const b = BOOLS[raw.toLowerCase()];
            if (b === undefined) throw new Error(`expected 0/1, got "${raw}"`);

            return b;
        }
        case 'number': {
            const n = Number(raw.replace(/_/g, ''));
            if (raw === '' || !Number.isFinite(n)) throw new Error(`expected a number, got "${raw}"`);

            return n;
        }
        case 'bigint': {
            const name = opts.name ?? '';
            if (isDurationArg(name)) {
                const d = parseDuration(raw);
                if (d !== null) return d;
            }

            if (isTimeArg(name)) return parseTime(raw, env);
            try {
                return BigInt(raw);
            } catch {
                throw new Error(`expected an integer, got "${raw}"`);
            }
        }
        case 'time':
            return parseTime(raw, env);
        case 'duration': {
            const d = parseDuration(raw);
            if (d === null) throw new Error(`expected a length like 5m or 1h30m, got "${raw}"`);

            return d;
        }
        case 'color':
            if (!COLOR.test(raw)) throw new Error(`expected a color like #ff1744, got "${raw}"`);
            return raw;
        case 'enum': {
            const lower = raw.toLowerCase();
            const exact = type.values.find((v) => v.toLowerCase() === lower);
            if (exact) return exact;

            const prefixed = type.values.filter((v) => v.toLowerCase().startsWith(lower));
            if (prefixed.length === 1) return prefixed[0];
            if (type.open) return raw;

            throw new Error(`expected one of ${type.values.join(' | ')}, got "${raw}"`);
        }
        case 'list': {
            const body = raw.replace(/^\[|\]$/g, '').trim();
            if (!body) return [];
            return body.split(/[\s,]+/).map((part) => parseValue(part, type.of, {}, env));
        }
        case 'named': {
            const parser = env.types.get(type.name);
            if (parser) return parser.parse(raw);
            return parseJson(raw, type.name);
        }
        case 'json':
            return parseJson(raw, 'json');
    }
}

function parseJson(raw: string, what: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        throw new Error(`expected ${what} as JSON, got "${raw}"`);
    }
}

export function completeValue(type: ArgType, env: ParseEnv): string[] {
    switch (type.kind) {
        case 'boolean':
            return ['0', '1'];
        case 'enum':
            return type.values;
        case 'named':
            return env.types.get(type.name)?.complete?.() ?? [];
        default:
            return [];
    }
}

export function typeLabel(type: ArgType): string {
    switch (type.kind) {
        case 'enum':
            return type.values.join('|') + (type.open ? '|…' : '');
        case 'list':
            return `${typeLabel(type.of)}[]`;
        case 'named':
            return type.name;
        default:
            return type.kind;
    }
}

export type FormatEnv = { timezone: string };

export function formatTime(ns: bigint, timezone: string): string {
    return DateTime.fromMillis(Number(ns / 1_000_000n), { zone: timezone }).toFormat('yyyy-LL-dd HH:mm:ss.SSS');
}

export function formatDuration(ns: bigint): string {
    if (ns === 0n) return '0';

    const units = ['w', 'd', 'h', 'm', 's', 'ms', 'us', 'ns'];
    let rest = ns < 0n ? -ns : ns;
    let out = '';

    for (const u of units) {
        const q = rest / NS_PER[u];
        if (q > 0n) {
            out += `${q}${u}`;
            rest -= q * NS_PER[u];
        }
    }
    return (ns < 0n ? '-' : '') + out;
}

const MAX_LINE = 600;

const JS_WORDS =
    /^(await|async|const|let|var|return|function|new|if|else|for|of|in|while|do|break|continue|try|catch|finally|throw|class|extends|true|false|null|undefined|typeof|instanceof|this|switch|case|default)$/;

// light js colors
export function highlightJs(code: string): string {
    return code.replace(
        // yeah
        /("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\/\/.*$)|(\b\d[\d._]*n?\b)|([A-Za-z_$][\w$]*)/g,
        (m, str, comment, num, word) =>
            str ? ansi.green(m) : comment ? ansi.dim(m) : num ? ansi.yellow(m) : word && JS_WORDS.test(word) ? ansi.magenta(m) : m,
    );
}

const SPARKS = '▁▂▃▄▅▆▇█';

// `values` squeezed into `width` block chars, each the avg of its slice
export function sparkline(values: readonly number[], width = 48): string {
    const finite = values.filter(Number.isFinite);
    if (!finite.length) return '';

    const min = Math.min(...finite);
    const max = Math.max(...finite);
    const n = Math.min(width, values.length);
    let out = '';

    for (let i = 0; i < n; i++) {
        const slice = values.slice(Math.floor((i * values.length) / n), Math.floor(((i + 1) * values.length) / n)).filter(Number.isFinite);
        if (!slice.length) {
            out += ' ';
            continue;
        }

        const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
        out += SPARKS[max === min ? 3 : Math.round(((mean - min) / (max - min)) * 7)];
    }
    return out;
}

const isNumberList = (x: unknown): x is number[] =>
    Array.isArray(x) && x.length >= 8 && x.every((v) => typeof v === 'number');

// multi line rendering for js results
export function inspect(v: unknown, env: FormatEnv, depth = 2): string {
    // a long list of numbers reads better as a shape than as its first 20 entries
    if (isNumberList(v)) {
        const finite = v.filter(Number.isFinite);
        const r = (n: number) => String(Math.round(n * 1e6) / 1e6);

        return `Array(${v.length})  ${ansi.cyan(sparkline(v))}\n${ansi.dim(
            `  min ${r(Math.min(...finite))}  max ${r(Math.max(...finite))}  first ${r(v[0])}  last ${r(v[v.length - 1])}  mean ${r(finite.reduce((a, b) => a + b, 0) / finite.length)}  - plot it for more`,
        )}`;
    }
    const seen = new WeakSet<object>();
    const pad = (n: number) => '  '.repeat(n);

    const go = (x: unknown, level: number, key: string): string => {
        if (x === null || typeof x !== 'object') {
            if (typeof x === 'function') {
                const src = Function.prototype.toString.call(x);
                const sig = /^[^{=]*?\(([^)]*)\)/.exec(src)?.[1] ?? '';

                return ansi.cyan(`ƒ ${(x as Function).name || 'anonymous'}(${sig.replace(/\s+/g, ' ').trim()})`);
            }
            return fmt(x, env, key, 0);
        }
        if (seen.has(x)) return ansi.dim('[circular]');

        seen.add(x);
        const proto = Object.getPrototypeOf(x);
        const cls = proto && proto !== Object.prototype && proto !== Array.prototype ? proto.constructor?.name ?? '' : '';
        let entries: [string, unknown][];
        let open = '{';
        let close = '}';
        let total: number;

        if (Array.isArray(x)) {
            entries = x.slice(0, 20).map((e, i) => [String(i), e]);
            [open, close, total] = ['[', ']', x.length];
        } else if (x instanceof Map) {
            entries = [...x].slice(0, 20).map(([k, e]) => [fmt(k, env, '', 1), e]);
            [open, total] = [`Map(${x.size}) {`, x.size];
        } else if (x instanceof Set) {
            entries = [...x].slice(0, 20).map((e, i) => [String(i), e]);
            [open, total] = [`Set(${x.size}) {`, x.size];
        } else if (ArrayBuffer.isView(x) || x instanceof ArrayBuffer || x instanceof Date || x instanceof Error) {
            if (x instanceof Date) return ansi.magenta(x.toISOString());
            if (x instanceof Error) return ansi.red(`${x.name}: ${x.message}`);

            return fmt(x, env, key, 0);
        } else {
            const keys = Object.keys(x);
            entries = keys.slice(0, 40).map((k) => [k, (x as Record<string, unknown>)[k]]);
            total = keys.length;

            if (cls) open = `${cls} {`;
        }

        if (!entries.length) return `${open}${close}`;
        if (level >= depth) return ansi.dim(Array.isArray(x) ? `Array(${total})` : `${cls || 'Object'} {…}`);

        const isList = Array.isArray(x) || x instanceof Set;
        const lines = entries.map(([k, e]) => `${pad(level + 1)}${isList ? '' : `${k}: `}${go(e, level + 1, k)}`);

        if (total > entries.length) lines.push(`${pad(level + 1)}${ansi.dim(`… ${total - entries.length} more`)}`);
        return `${open}\n${lines.join(',\n')}\n${pad(level)}${close}`;
    };
    return go(v, 0, '');
}

// one line, colored rendering of an event payload or cvar value
export function formatValue(v: unknown, env: FormatEnv, key = '', depth = 0): string {
    const s = fmt(v, env, key, depth);
    // too long: render again with nested objects folded
    return stripAnsi(s).length > MAX_LINE && depth === 0 ? fmt(v, env, key, 1) : s;
}

function fmt(v: unknown, env: FormatEnv, key: string, depth: number): string {
    if (v === null || v === undefined) return ansi.dim(String(v));
    switch (typeof v) {
        case 'string':
            return ansi.green(JSON.stringify(v));
        case 'number':
            return ansi.yellow(String(Math.round(v * 1e8) / 1e8));
        case 'boolean':
            return ansi.magenta(String(v));
        case 'bigint':
            if (isDurationArg(key)) return ansi.yellow(formatDuration(v));
            if (isTimeArg(key) && v > 10n ** 17n) return gotoLink(ansi.cyan(formatTime(v, env.timezone)), v);

            return ansi.yellow(`${v}n`);
        case 'function':
            return ansi.dim(`ƒ ${(v as Function).name || 'anonymous'}`);
    }
    if (Array.isArray(v)) {
        if (depth > 2 || v.length > 8) return ansi.dim(`Array(${v.length})`);

        return `[${v.map((x) => fmt(x, env, key, depth + 1)).join(', ')}]`;
    }

    if (v instanceof Map || v instanceof Set) return ansi.dim(`${v.constructor.name}(${v.size})`);
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) {
        const len = v instanceof ArrayBuffer ? v.byteLength : (v as any).length;
        return ansi.dim(`${v.constructor.name}(${len})`);
    }

    const proto = Object.getPrototypeOf(v);
    const cls = proto && proto !== Object.prototype ? proto.constructor?.name : '';

    if (depth > 1 || (cls && depth > 0)) return ansi.dim(cls ? `${cls} {…}` : '{…}');
    const entries = Object.entries(v as object).map(([k, x]) => `${k}: ${fmt(x, env, k, depth + 1)}`);

    return `${cls ? cls + ' ' : ''}{ ${entries.join(', ')} }`;
}
