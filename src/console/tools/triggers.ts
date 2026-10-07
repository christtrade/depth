import type { DepthChart } from '../../core/DepthChart';
import type { ChartEvents } from '../../core/TypedEventBus';
import type { CommandDef, Console } from '../Console';
import { EVENTS } from '../manifest.gen';
import { ansi, parseTime } from '../values';

type Op = '=' | '!=' | '>' | '<' | '>=' | '<=' | '~';
type Cond = { field: string; op: Op; raw: string };
type Trigger = {
    id: number;
    kind: 'on' | 'when';
    spec: string;
    command: string;
    fired: number;
    off: () => void;
};

const COND = /^([\w.$]+)(!=|>=|<=|=|>|<|~)(.*)$/;
const RATE_LIMIT = 20;

const globRe = (glob: string) =>
    new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');

function get(obj: unknown, path: string): unknown {
    let o = obj;
    for (const k of path.split('.')) {
        if (o === null || typeof o !== 'object') return undefined;
        o = (o as Record<string, unknown>)[k];
    }
    return o;
}

// numbers compare as numbers (bigint ns included), everything else as text
function test(value: unknown, op: Op, raw: string, asTime?: (s: string) => bigint): boolean {
    if (value === undefined) return false;

    if (typeof value === 'bigint') {
        let rhs: bigint;
        try {
            rhs = asTime ? asTime(raw) : BigInt(raw);
        } catch {
            return false;
        }
        // ehhh....
        return op === '=' ? value === rhs : op === '!=' ? value !== rhs : op === '>' ? value > rhs : op === '<' ? value < rhs : op === '>=' ? value >= rhs : op === '<=' ? value <= rhs : String(value).includes(raw);
    }

    const n = Number(raw);
    if (typeof value === 'number' && Number.isFinite(n) && op !== '~') {
        return op === '=' ? value === n : op === '!=' ? value !== n : op === '>' ? value > n : op === '<' ? value < n : op === '>=' ? value >= n : value <= n;
    }

    const a = String(value).toLowerCase();
    const b = raw.toLowerCase();
    return op === '=' ? a === b : op === '!=' ? a !== b : op === '~' ? a.includes(b) : op === '>' ? a > b : op === '<' ? a < b : op === '>=' ? a >= b : a <= b;
}

// "$price" and "${order.side}" from the payload
// ns stays digits so "playback:goto $tNs" works
function fill(command: string, data: unknown): string {
    return command.replace(/\$\{([\w.]+)\}|\$([A-Za-z_][\w.]*)/g, (m, a, b) => {
        const v = get(data, a ?? b);
        return v === undefined ? m : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
    });
}

// "price > 4800 and side=buy" -> conditions
// accepts spaced or packed forms
function parseConds(words: string[]): Cond[] {
    const out: Cond[] = [];
    for (let i = 0; i < words.length; i++) {
        const w = words[i];
        if (w.toLowerCase() === 'and') continue;

        const packed = COND.exec(w);
        if (packed && packed[3] !== '') {
            out.push({ field: packed[1], op: packed[2] as Op, raw: packed[3] });
            continue;
        }

        const op = (packed?.[2] ?? words[i + 1]) as Op;
        const field = packed?.[1] ?? w;
        const raw = packed ? words[i + 1] : words[i + 2];
        if (!['=', '!=', '>', '<', '>=', '<=', '~'].includes(op) || raw === undefined) {
            throw new Error(`can't read the condition at "${w}" - try price>4800 or side = buy`);
        }

        out.push({ field, op, raw });
        i += packed ? 1 : 2;
    }
    return out;
}

export function triggerTools(chart: DepthChart, con: Console): CommandDef[] {
    const triggers = new Map<number, Trigger>();
    let seq = 0;
    const tz = () => chart.getChart(0).settings.timezone;
    const asTime = (s: string) => parseTime(s, { timezone: tz(), playheadNs: () => chart.playback.time, types: new Map() });

    function guarded(t: Trigger) {
        let running = false;
        let windowStart = 0;
        let inWindow = 0;
        return (command: string) => {
            if (running) return;

            const now = Date.now();
            if (now - windowStart > 1000) ((windowStart = now), (inWindow = 0));
            if (++inWindow > RATE_LIMIT) {
                t.off();
                triggers.delete(t.id);
                con.print(ansi.yellow(`trigger ${t.id} fired over ${RATE_LIMIT} times a second - turned it off`));
                return;
            }

            // anything that comes while the cmd is still running is taken as its own thing
            running = true;
            t.fired++;
            void con.exec(command).finally(() => (running = false));
        };
    }

    const state = (): Record<string, unknown> => {
        const tick = lastTick;
        const acct = chart.account?.getSnapshot();
        return {
            price: tick?.last,
            last: tick?.last,
            bid: tick?.bid,
            ask: tick?.ask,
            spread: tick?.spread,
            time: chart.playback.time,
            balance: acct?.balance,
            equity: acct?.equity,
            pnl: acct?.unrealizedPnl,
            realized: acct?.realizedPnl,
            positions: acct?.openPositionCount,
        };
    };
    let lastTick: ChartEvents['playback:tick'] | null = null;
    chart.on('playback:tick', (t) => (lastTick = t));

    const on: CommandDef = {
        name: 'on',
        help: 'on <event> [field=value...] "<command>" - run a command whenever an event fires. $field fills in from it',
        complete: (i) => (i === 0 ? EVENTS.map((e) => e.event as string) : []),
        run: ({ argv, print }) => {
            if (argv.length < 2) throw new Error('usage: on <event> [conditions] "<command>"  e.g. on order:fill side=buy "pause"');

            const [glob, ...rest] = argv;
            const command = rest.pop()!;
            const conds = parseConds(rest);
            const events = EVENTS.filter((e) => globRe(glob).test(e.event)).map((e) => e.event);
            if (!events.length) throw new Error(`no event matches "${glob}"`);

            const t: Trigger = { id: ++seq, kind: 'on', spec: [glob, ...rest].join(' '), command, fired: 0, off: () => {} };
            const fire = guarded(t);
            const offs = events.map((event) =>
                chart.on(event, (data) => {
                    if (conds.every((c) => test(get(data, c.field), c.op, c.raw, /Ns$|^ts$/.test(c.field) ? asTime : undefined))) {
                        fire(fill(command, data));
                    }
                }),
            );

            t.off = () => offs.forEach((off) => off());
            triggers.set(t.id, t);
            print(ansi.dim(`trigger ${t.id}: on ${t.spec} → ${command}`));
        },
    };

    const when: CommandDef = {
        name: 'when',
        help: 'when <price|bid|ask|spread|time|balance|equity|pnl|positions> <op> <value> [and ...] "<command>" [--every] - once, or every time it turns true',
        complete: (i) => (i === 0 ? ['price', 'bid', 'ask', 'spread', 'time', 'balance', 'equity', 'pnl', 'realized', 'positions'] : []),
        run: ({ argv, print }) => {
            const every = argv.includes('--every');
            const words = argv.filter((w) => w !== '--every');
            if (words.length < 2) throw new Error('usage: when price > 4800 "pause"');

            const command = words.pop()!;
            const conds = parseConds(words);
            const known = Object.keys(state());
            for (const c of conds) if (!known.includes(c.field)) throw new Error(`when can't see "${c.field}" - it knows ${known.join(', ')}`);

            const t: Trigger = { id: ++seq, kind: 'when', spec: words.join(' ') + (every ? ' (every time)' : ''), command, fired: 0, off: () => {} };
            const fire = guarded(t);

            let was = conds.every((c) => test(state()[c.field], c.op, c.raw, c.field === 'time' ? asTime : undefined));
            const check = () => {
                const s = state();
                const now = conds.every((c) => test(s[c.field], c.op, c.raw, c.field === 'time' ? asTime : undefined));

                if (now && !was) {
                    fire(fill(command, s));
                    if (!every) {
                        t.off();
                        triggers.delete(t.id);
                    }
                }
                was = now;
            };

            const offs = [chart.on('playback:tick', check), chart.on('account:update', check), chart.on('playback:seek', check)];
            t.off = () => offs.forEach((off) => off());
            triggers.set(t.id, t);
            print(ansi.dim(`trigger ${t.id}: when ${t.spec} → ${command}${was ? ansi.yellow('  (already true - fires next time it turns true)') : ''}`));
        },
    };

    const list: CommandDef = {
        name: 'triggers',
        help: 'triggers - what on and when are waiting for',
        run: ({ print }) => {
            if (!triggers.size) return print(ansi.dim('no triggers - on and when make them'));
            for (const t of triggers.values()) {
                print(`  ${ansi.bold(String(t.id).padStart(3))}  ${ansi.cyan(t.kind.padEnd(4))} ${t.spec}  ${ansi.dim('→')} ${t.command}  ${ansi.dim(`fired ${t.fired}×`)}`);
            }
        },
    };

    const remove: CommandDef = {
        name: 'untrigger',
        help: 'untrigger <id|all> - stop one, or all of them',
        complete: (i) => (i === 0 ? ['all', ...[...triggers.keys()].map(String)] : []),
        run: ({ argv, print }) => {
            const which = argv[0];
            if (!which) throw new Error('untrigger which? triggers lists them');

            const ids = which === 'all' ? [...triggers.keys()] : [Number(which)];
            for (const id of ids) {
                const t = triggers.get(id);
                if (!t) throw new Error(`no trigger ${which}`);

                t.off();
                triggers.delete(id);
            }
            print(ansi.dim(`removed ${ids.length}`));
        },
    };

    return [on, when, list, remove];
}
