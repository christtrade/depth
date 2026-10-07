import type { ChartEvents } from '../core/TypedEventBus';
import { DEFAULT_CHART_SETTINGS, type ChartSettings } from '../lib/types/chart-settings';
import { StorageKey, readJSON, writeJSON } from '../lib/storage';
import { CVARS, EVENTS } from './manifest.gen';
import { quote, splitPipes, splitStatements, tokenize } from './lex';
import { cfgEditCommand } from './builtins/cfgedit';
import { jsCommand } from './builtins/js';
import { pipeCommands } from './builtins/pipes';
import { plotCommand } from './builtins/plot';
import { scriptCommands } from './builtins/scripts';
import { watchCommand } from './builtins/watch';
import type { ArgSpec, ArgType, EventSpec } from './types';
import {
    ansi,
    completeValue,
    formatTime,
    formatValue,
    helpLink,
    highlightJs,
    parseValue,
    typeLabel,
    type ParseEnv,
    type TypeParser,
} from './values';

/** What the console needs from a chart. `chart.console` wires this up for you */
export interface ConsoleHost {
    on<K extends keyof ChartEvents>(event: K, fn: (data: ChartEvents[K]) => void): () => void;
    emit<K extends keyof ChartEvents>(event: K, data: ChartEvents[K]): void;
    settings(): Readonly<ChartSettings>;
    focusedCell(): number;
    playheadNs(): bigint;
    status(): Record<string, unknown>;
}

export interface ConsoleStorage {
    read<T>(key: string, fallback: T): T;
    write(key: string, value: unknown): void;
}

export type ScreenKey = {
    type: 'down' | 'up';
    key: string;
    code: string;
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
    meta: boolean;
    repeat: boolean;
};

export interface ScreenOptions {
    /** Cover the whole page instead of just the terminal panel */
    maximize?: boolean;
}

export interface Screen {
    readonly cols: number;
    readonly rows: number;
    /** Pixel size of one cell. */
    readonly cell: { width: number; height: number };
    /** Resolves once the terminal has drawn it */
    write(data: string): Promise<void>;
    /** Typed text as terminal sequences (arrows arrive as \x1b[A ...) */
    onData(fn: (data: string) => void): () => void;
    onKey(fn: (key: ScreenKey) => void): () => void;
    onResize(fn: (cols: number, rows: number) => void): () => void;
    /** Aborted when the screen closes */
    readonly closed: AbortSignal;
    close(): void;
}

/** What a terminal ui gives the console so commands can draw full screen */
export interface ConsoleDisplay {
    readonly cols: number;
    openScreen(opts: ScreenOptions): Screen;
}

export interface CommandContext {
    /** Parsed against the command's `args`. Empty when it declares none. */
    args: Record<string, unknown>;
    /** Raw words after the command name. */
    argv: string[];
    /** The text after the command name. */
    raw: string;
    /** Lines from the command before a `|`, or null when nothing was piped in. */
    input: string[] | null;
    print(text: string): void;
    error(text: string): void;
    signal: AbortSignal;
    console: Console;
    /** Take over the terminal. */
    screen(opts?: ScreenOptions): Screen;
}

export interface CommandDef {
    name: string;
    help?: string;
    /** Declared args are parsed, checked, and tab completed. */
    args?: ArgSpec[];
    /** Hidden and refused unless `developer 1`. */
    dev?: boolean;
    /** Runs, but never listed, completed or found */
    hidden?: boolean;
    /** Takes the rest of the line as-is, `;` included for commands whose input is code. */
    rest?: boolean;
    run(ctx: CommandContext): void | Promise<void>;
    /** `argv` is the words before the one being completed, `current` that word so far. */
    complete?(argIndex: number, argv: string[], current: string): string[];
}

export interface CvarDef {
    name: string;
    type: ArgType;
    nullable?: boolean;
    help?: string;
    group?: string;
    dev?: boolean;
    default: unknown;
    get(): unknown;
    set(value: unknown): void;
}

type Persisted = {
    aliases: Record<string, string>;
    binds: Record<string, string>;
    cfgs: Record<string, string>;
    scripts: Record<string, string>;
    vars: Record<string, unknown>;
};

const MAX_ALIAS_DEPTH = 32;
const MAX_HISTORY = 500;

const CONTEXT_DEFAULTS: Record<string, (h: ConsoleHost) => unknown> = {
    '*.requestId': () => Math.random().toString(36).slice(2),
    'chart:set-symbol.id': (h) => h.focusedCell(),
    'chart:set-type.old': (h) => h.settings().chartType,
    'account:deposit.ts': (h) => h.playheadNs(),
    'account:withdraw.ts': (h) => h.playheadNs(),
    'trading:ticket-requested.drawingId': () => null,
};

const contextDefault = (event: string, arg: string) =>
    CONTEXT_DEFAULTS[`${event}.${arg}`] ?? CONTEXT_DEFAULTS[`*.${arg}`];

const sameValue = (a: unknown, b: unknown) =>
    JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)) ===
    JSON.stringify(b, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));

function cvarText(v: unknown): string {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean') return v ? '1' : '0';
    if (Array.isArray(v)) return v.join(',');
    return String(v);
}

const globToRegex = (glob: string) =>
    new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');

function wrapList(label: string, items: string[], indent: number, width: number): string {
    const lines: string[] = [];
    let line = '';
    for (const item of items) {
        if (line && indent + line.length + 1 + item.length > width) {
            lines.push(line);
            line = item;
        } else line = line ? `${line} ${item}` : item;
    }
    lines.push(line);
    return lines.map((l, i) => (i === 0 ? label : ' '.repeat(indent)) + l).join('\n');
}

const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        const t = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
    });

export function keyName(e: { key: string; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean }): string {
    const key = e.key === ' ' ? 'space' : e.key.toLowerCase();
    const mods = [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.metaKey && 'meta', e.shiftKey && key.length > 1 && 'shift'];
    return [...mods.filter(Boolean), key].join('+');
}

const defaultStorage: ConsoleStorage = { read: readJSON, write: writeJSON };

/**
 * A console over the chart. Every command in `ChartEvents`
 * and every field of `ChartSettings` is available without registering it;
 * plugins and hosts add their own with `register` / `registerCvar`.
 */
export class Console {
    private readonly commands = new Map<string, CommandDef>();
    private readonly cvars = new Map<string, CvarDef>();
    private readonly types = new Map<string, TypeParser>();
    private readonly outputs = new Set<(text: string) => void>();
    private readonly clears = new Set<() => void>();
    private readonly listening = new Map<string, () => void>();
    private readonly listenPatterns: string[] = [];
    private readonly rates = new Map<string, { sec: number; n: number; dropped: number }>();
    private abortCtl = new AbortController();
    private display: ConsoleDisplay | null = null;
    private screenOpen: Screen | null = null;
    private readonly builtins = new Set<string>();
    private readonly state: Persisted;
    readonly history: string[];

    constructor(
        private readonly host: ConsoleHost,
        private readonly storage: ConsoleStorage = defaultStorage,
    ) {
        const saved = storage.read<Partial<Persisted>>(StorageKey.console, {});
        this.state = { aliases: {}, binds: {}, cfgs: {}, scripts: {}, vars: {}, ...saved };
        this.history = storage.read<string[]>(StorageKey.consoleHistory, []);
        this.registerBuiltins();
        for (const c of this.commands.keys()) this.builtins.add(c);
        for (const e of EVENTS) if (e.kind === 'command') this.register(this.eventCommand(e));
        for (const c of CVARS) {
            this.registerCvar({
                name: c.name,
                type: c.type,
                nullable: c.nullable,
                help: c.doc,
                group: c.group,
                default: DEFAULT_CHART_SETTINGS[c.name],
                get: () => this.host.settings()[c.name],
                set: (value) => this.host.emit('chart:apply-settings', { patch: { [c.name]: value } }),
            });
        }
    }

    // Registration

    register(def: CommandDef): () => void {
        const key = def.name.toLowerCase();
        this.commands.set(key, def);
        return () => this.commands.get(key) === def && this.commands.delete(key);
    }

    registerCvar(def: CvarDef): () => void {
        const key = def.name.toLowerCase();
        this.cvars.set(key, def);
        return () => this.cvars.get(key) === def && this.cvars.delete(key);
    }

    registerSavedCvar(def: Omit<CvarDef, 'get' | 'set'> & { onChange?: (value: unknown) => void }): () => void {
        const { onChange, ...rest } = def;
        const off = this.registerCvar({
            ...rest,
            get: () => this.state.vars[def.name] ?? def.default,
            set: (value) => {
                this.state.vars[def.name] = value;
                this.save();
                onChange?.(value);
            },
        });
        if (this.state.vars[def.name] !== undefined) onChange?.(this.state.vars[def.name]);
        return off;
    }

    /** teach the console to read a named type from text, so like `Timeframe` from "5m" */
    registerType(name: string, parser: TypeParser): () => void {
        this.types.set(name, parser);
        return () => this.types.get(name) === parser && this.types.delete(name);
    }

    /** The terminal's width, default 100 */
    get cols(): number {
        return this.display?.cols ?? 100;
    }

    /** Attach the terminal that full-screen commands draw on. Returns a detach. */
    setDisplay(display: ConsoleDisplay): () => void {
        this.display = display;
        return () => {
            if (this.display !== display) return;
            this.display = null;
            this.screenOpen?.close();
        };
    }

    private openScreen(opts: ScreenOptions = {}, signal: AbortSignal): Screen {
        if (!this.display) throw new Error('needs the terminal open');
        if (this.screenOpen && !this.screenOpen.closed.aborted) throw new Error('something already has the screen');
        const screen = this.display.openScreen(opts);
        this.screenOpen = screen;
        const onAbort = () => screen.close();
        signal.addEventListener('abort', onAbort, { once: true });
        screen.closed.addEventListener('abort', () => {
            signal.removeEventListener('abort', onAbort);
            if (this.screenOpen === screen) this.screenOpen = null;
        });
        return screen;
    }

    // Output

    onOutput(fn: (text: string) => void): () => void {
        this.outputs.add(fn);
        return () => this.outputs.delete(fn);
    }

    onClear(fn: () => void): () => void {
        this.clears.add(fn);
        return () => this.clears.delete(fn);
    }

    print(text: string): void {
        const capture = this.captures[this.captures.length - 1];
        if (capture) capture.push(text);
        else for (const fn of this.outputs) fn(text);
    }

    private readonly captures: string[][] = [];

    /** Run a line and hand back what it printed instead of printing it. */
    async capture(line: string, signal = this.abortCtl.signal): Promise<string[]> {
        return this.captured(() => this.exec(line, 0, signal));
    }

    /** Extra names `js` can see. Hosts add their own. */
    readonly scope: Record<string, unknown> = {};

    scriptNames(): string[] {
        return Object.keys(this.state.scripts);
    }

    script(name: string): string | undefined {
        return this.state.scripts[name];
    }

    /** Save a `js` script, or delete it with null. */
    setScript(name: string, source: string | null): void {
        if (source === null) delete this.state.scripts[name];
        else this.state.scripts[name] = source;
        this.save();
    }

    cfgNames(): string[] {
        return Object.keys(this.state.cfgs);
    }

    cfg(name: string): string | undefined {
        return this.state.cfgs[name];
    }

    /** Save a cfg, or delete it with null. */
    setCfg(name: string, text: string | null): void {
        if (text === null) delete this.state.cfgs[name];
        else this.state.cfgs[name] = text;
        this.save();
    }

    error(text: string): void {
        this.print(ansi.red(text));
    }

    // Running

    get developer(): boolean {
        return this.state.vars.developer === true;
    }

    async submit(line: string): Promise<void> {
        this.print(ansi.dim('] ') + this.highlight(line));
        if (line.trim() && this.history[this.history.length - 1] !== line) {
            this.history.push(line);
            if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
            this.storage.write(StorageKey.consoleHistory, this.history);
        }
        await this.exec(line);
    }

    // run ; separated cmds without echoing them
    async exec(line: string, depth = 0, signal = this.abortCtl.signal): Promise<void> {
        for (const st of splitStatements(line)) {
            if (signal.aborted) return;
            const tokens = tokenize(st.text);
            if (!tokens.length) continue;
            const head = tokens[0];
            if (this.isRest(head.text)) {
                // everything after the name is the commands, later statements n pipes included
                const raw = line.slice(st.start + head.end).trim();
                await this.run([head.text, ...tokenize(raw).map((t) => t.text)], depth, signal, raw, null);
                return;
            }
            const stages = splitPipes(st.text);
            let input: string[] | null = null;
            for (const [i, stage] of stages.entries()) {
                if (signal.aborted) return;
                const stageTokens = tokenize(stage.text);
                if (!stageTokens.length) return this.error('nothing on one side of a |');
                const isLast = i === stages.length - 1;
                // a code taking cmd mid pipe gets the rest of the statement
                const raw = this.isRest(stageTokens[0].text)
                    ? st.text.slice(stage.start + stageTokens[0].end).trim()
                    : stage.text.slice(stageTokens[0].end).trim();
                const argv = this.isRest(stageTokens[0].text)
                    ? [stageTokens[0].text, ...tokenize(raw).map((t) => t.text)]
                    : stageTokens.map((t) => t.text);
                const go = () => this.run(argv, depth, signal, raw, input);
                if (isLast) await go();
                else input = (await this.captured(go)).flatMap((l) => l.split('\n'));
                if (this.isRest(stageTokens[0].text)) break;
            }
        }
    }

    private isRest(name: string): boolean {
        if (this.state.aliases[name.toLowerCase()] !== undefined) return false;
        const cmd = this.resolveCommand(name.toLowerCase());
        return !!cmd && typeof cmd !== 'string' && !!cmd.rest;
    }

    private async captured(fn: () => Promise<void>): Promise<string[]> {
        const out: string[] = [];
        this.captures.push(out);
        try {
            await fn();
        } finally {
            this.captures.splice(this.captures.lastIndexOf(out), 1);
        }
        return out;
    }

    // stop everything running
    abort(): void {
        this.abortCtl.abort();
        this.abortCtl = new AbortController();
    }

    // run whatever is bound to a key, true when something was
    handleKey(key: string): boolean {
        const cmd = this.state.binds[key.toLowerCase()];
        if (cmd === undefined) return false;
        void this.exec(cmd);
        return true;
    }

    dispose(): void {
        this.abort();
        this.unlisten();
        this.outputs.clear();
        this.clears.clear();
    }

    // run autoexec if there is one
    async start(): Promise<void> {
        if (this.state.cfgs.autoexec !== undefined) await this.exec(this.state.cfgs.autoexec);
    }

    private async run(argv: string[], depth: number, signal: AbortSignal, raw: string, input: string[] | null): Promise<void> {
        const [name, ...rest] = argv;
        const key = name.toLowerCase();

        const alias = this.state.aliases[key];
        if (alias !== undefined) {
            if (depth >= MAX_ALIAS_DEPTH) return this.error(`alias "${name}" nests deeper than ${MAX_ALIAS_DEPTH}`);
            return this.exec(alias, depth + 1, signal);
        }

        const cmd = this.resolveCommand(key);
        if (typeof cmd === 'string') return this.error(cmd);
        if (cmd) {
            if (cmd.dev && !this.developer) return this.error(`${cmd.name} needs developer 1`);
            try {
                const args = cmd.args ? this.parseArgs(cmd.args, rest, cmd.name) : {};
                await cmd.run({
                    args,
                    argv: rest,
                    raw,
                    input,
                    print: (t) => this.print(t),
                    error: (t) => this.error(t),
                    signal,
                    console: this,
                    screen: (opts) => this.openScreen(opts, signal),
                });
            } catch (err) {
                this.error(`${cmd.name}: ${err instanceof Error ? err.message : String(err)}`);
            }
            return;
        }

        const cvar = this.cvars.get(key);
        if (cvar && (!cvar.dev || this.developer)) {
            if (!rest.length) return this.showCvar(cvar);
            try {
                cvar.set(parseValue(rest.join(' '), cvar.type, { nullable: cvar.nullable, name: cvar.name }, this.env()));
            } catch (err) {
                this.error(`${cvar.name}: ${err instanceof Error ? err.message : String(err)}`);
            }
            return;
        }

        this.error(`Unknown command "${name}"`);
    }

    private listed(d: { dev?: boolean; hidden?: boolean }): boolean {
        return !d.hidden && (!d.dev || this.developer);
    }

    // 'play' finds playback:play when nothing else ends that way
    private resolveCommand(key: string): CommandDef | string | undefined {
        const exact = this.commands.get(key);
        if (exact) return exact;
        if (key.includes(':')) return undefined;
        const hits = [...this.commands.values()].filter(
            (c) => c.name.includes(':') && c.name.slice(c.name.indexOf(':') + 1).toLowerCase() === key && this.listed(c),
        );
        if (hits.length > 1) return `"${key}" could be ${hits.map((c) => c.name).join(', ')}`;
        return hits[0];
    }

    private env(): ParseEnv {
        return { timezone: this.timezone(), playheadNs: () => this.host.playheadNs(), types: this.types };
    }

    private timezone(): string {
        return this.host.settings()?.timezone ?? 'UTC';
    }

    private parseArgs(specs: ArgSpec[], argv: string[], event?: string): Record<string, unknown> {
        const named: Record<string, string> = {};
        const positional: string[] = [];
        for (const a of argv) {
            //I hate regex....
            const kv = /^-{0,2}([A-Za-z_]\w*)=([\s\S]*)$/.exec(a);
            if (kv && specs.some((s) => s.name === kv[1])) {
                named[kv[1]] = kv[2];
                continue;
            }
            const flag = /^--([A-Za-z_]\w*)$/.exec(a);
            if (flag && specs.some((s) => s.name === flag[1] && s.type.kind === 'boolean')) {
                named[flag[1]] = '1';
                continue;
            }
            positional.push(a);
        }

        const out: Record<string, unknown> = {};
        const env = this.env();
        let p = 0;
        const filled = (s: ArgSpec) => !!(event && contextDefault(event, s.name));
        specs.forEach((spec, i) => {
            let raw = named[spec.name];
            if (raw === undefined && p < positional.length) {
                // a trailing string arg soaks up the rest so it doesnt need quotes
                const last = spec.type.kind === 'string' && specs.slice(i + 1).every(filled);
                raw = last ? positional.slice(p).join(' ') : positional[p];
                p = last ? positional.length : p + 1;
            }
            if (raw !== undefined) {
                try {
                    out[spec.name] = parseValue(raw, spec.type, spec, env);
                } catch (err) {
                    throw new Error(`${spec.name}: ${err instanceof Error ? err.message : String(err)}`);
                }
                return;
            }
            const fill = event && contextDefault(event, spec.name);
            if (fill) out[spec.name] = fill(this.host);
            else if (!spec.optional) throw new Error(`missing <${spec.name}> - usage: ${this.usage(specs)}`);
        });
        if (p < positional.length) throw new Error(`too many args - usage: ${this.usage(specs)}`);
        return out;
    }

    private usage(specs: ArgSpec[]): string {
        return specs.map((s) => (s.optional ? `[${s.name}:${typeLabel(s.type)}]` : `<${s.name}:${typeLabel(s.type)}>`)).join(' ');
    }

    private eventCommand(e: EventSpec): CommandDef {
        // required, then optional, then whatever context fills so positionals land on what you mean
        const rank = (a: ArgSpec) => (contextDefault(e.event, a.name) ? 2 : a.optional ? 1 : 0);
        const args = [...e.args]
            .sort((a, b) => rank(a) - rank(b))
            .map((a) => (rank(a) === 2 ? { ...a, optional: true } : a));
        return {
            name: e.event,
            help: e.doc,
            dev: e.dev,
            args,
            run: ({ args: parsed }) => this.host.emit(e.event, (e.spread ? parsed : parsed.value) as never),
        };
    }

    // Cvars

    private showCvar(c: CvarDef): void {
        const v = c.get();
        const changed = !sameValue(v, c.default);
        const env = { timezone: this.timezone() };
        this.print(
            `${ansi.bold(c.name)} = ${formatValue(v, env, c.name)}` +
                (changed ? ansi.dim(`  (default ${cvarText(c.default)})`) : ''),
        );
        const meta = [typeLabel(c.type) + (c.nullable ? '|null' : ''), c.group, c.help].filter(Boolean).join(' · ');
        this.print(ansi.dim(`  ${meta}`));
    }

    private findCvar(name: string): CvarDef {
        const c = this.cvars.get(name?.toLowerCase());
        if (!c || (c.dev && !this.developer)) throw new Error(`no cvar "${name}"`);
        return c;
    }

    // Listening

    private listen(pattern: string): number {
        const re = globToRegex(pattern);
        let added = 0;
        for (const e of EVENTS) {
            if (!re.test(e.event) || this.listening.has(e.event)) continue;
            this.listening.set(e.event, this.host.on(e.event, (data) => this.onListened(e.event, data)));
            added++;
        }
        if (!this.listenPatterns.includes(pattern)) this.listenPatterns.push(pattern);
        return added;
    }

    private unlisten(pattern?: string): number {
        const re = pattern ? globToRegex(pattern) : /.*/;
        let removed = 0;
        for (const [event, off] of this.listening) {
            if (!re.test(event)) continue;
            off();
            this.listening.delete(event);
            removed++;
        }
        for (let i = this.listenPatterns.length - 1; i >= 0; i--) {
            if (!pattern || this.listenPatterns[i] === pattern) this.listenPatterns.splice(i, 1);
        }
        return removed;
    }

    private onListened(event: string, data: unknown): void {
        const now = Date.now();
        const sec = Math.floor(now / 1000);
        const limit = Number(this.cvars.get('listen_rate')?.get() ?? 10);
        let r = this.rates.get(event);
        if (!r || r.sec !== sec) {
            r = { sec, n: 0, dropped: 0 };
            this.rates.set(event, r);
        }
        if (limit > 0 && r.n >= limit) {
            if (r.dropped++ === 0) {
                const bucket = r;
                setTimeout(() => this.print(ansi.dim(`  … ${bucket.dropped} more ${event}`)), 1000 - (now % 1000));
            }
            return;
        }
        r.n++;
        const time = formatTime(BigInt(now) * 1_000_000n, this.timezone()).slice(11);
        const body = data === undefined ? '' : ' ' + formatValue(data, { timezone: this.timezone() });
        this.print(`${ansi.dim(time)} ${helpLink(ansi.cyan(event), event)}${body}`);
    }

    // Persistence

    private save(): void {
        this.storage.write(StorageKey.console, this.state);
    }

    private settingsDiff(): [CvarDef, unknown][] {
        return CVARS.map((c) => this.cvars.get(c.name.toLowerCase()))
            .filter((c): c is CvarDef => !!c)
            .map((c) => [c, c.get()] as [CvarDef, unknown])
            .filter(([c, v]) => !sameValue(v, c.default));
    }

    // Completion

    // a fuller line to show faded after whats typed (like in a regular terminal emulator).
    // prioritizes history, if not (no history), the word is just completed regularly
    suggest(line: string): string | null {
        if (!line.trim()) return null;
        for (let i = this.history.length - 1; i >= 0; i--) {
            const h = this.history[i];
            if (h.length > line.length && h.startsWith(line)) return h;
        }
        if (/\s$/.test(line)) return null;
        const { from, items } = this.complete(line);
        const word = line.slice(from).toLowerCase();
        const hit = items.find((i) => i.length > word.length && i.toLowerCase().startsWith(word));
        return hit ? line.slice(0, from) + hit : null;
    }

    // the line with colors for what each word is
    highlight(line: string): string {
        let out = '';
        let pos = 0;
        const paint = (from: number, to: number, fn: (s: string) => string) => {
            if (from < pos || to <= from) return;
            out += line.slice(pos, from).replace(/[;|]/g, (c) => ansi.dim(c)) + fn(line.slice(from, to));
            pos = to;
        };
        for (const st of splitStatements(line)) {
            const comment = st.text.indexOf('//');
            for (const stage of splitPipes(st.text)) {
                const base = st.start + stage.start;
                const tokens = tokenize(stage.text);
                if (!tokens.length) continue;

                const [head, ...rest] = tokens;
                const name = head.text.toLowerCase();
                const cmd = this.state.aliases[name] === undefined ? this.resolveCommand(name) : undefined;
                const color =
                    this.state.aliases[name] !== undefined
                        ? ansi.magenta
                        : cmd && typeof cmd !== 'string'
                          ? cmd.dev
                              ? ansi.yellow
                              : ansi.cyan
                          : this.cvars.has(name)
                            ? ansi.blue
                            : this.names().some((n) => n.toLowerCase().startsWith(name))
                              ? (s: string) => s
                              : ansi.red;

                paint(base + head.start, base + head.end, color);
                if (cmd && typeof cmd !== 'string' && cmd.rest) {
                    paint(base + head.end, line.length, highlightJs);
                    return out + line.slice(pos);
                }
                for (const t of rest) {
                    const from = base + t.start;
                    const to = base + t.end;

                    if (t.quoted) paint(from, to, ansi.green);
                    else if (/^-?\d[\d._]*\w*$/.test(t.text)) paint(from, to, ansi.yellow);
                    else if (/^[A-Za-z_]\w*=/.test(t.text)) {
                        const eq = line.indexOf('=', from);
                        paint(from, eq + 1, ansi.dim);
                    }
                }
            }
            if (comment >= 0) paint(st.start + comment, st.start + st.text.length, ansi.dim);
        }
        return out + line.slice(pos).replace(/[;|]/g, (c) => ansi.dim(c));
    }

    // tab completion
    complete(line: string): { from: number; items: string[] } {
        const stmts = splitStatements(line);
        const last = stmts[stmts.length - 1];
        const tokens = tokenize(last.text);
        const fresh = tokens.length === 0 || /\s$/.test(last.text);
        const idx = fresh ? tokens.length : tokens.length - 1;
        const current = fresh ? '' : tokens[idx].text;
        const from = fresh ? line.length : last.start + tokens[idx].start;
        const lower = current.toLowerCase();

        let pool: string[];
        let prefix = '';
        let needle = lower;
        if (idx === 0) {
            pool = this.names();
        } else {
            const name = tokens[0].text;
            const before = tokens.slice(1, idx).map((t) => t.text);
            const cmd = this.resolveCommand(name.toLowerCase());
            const kv = cmd && typeof cmd !== 'string' && cmd.rest ? null : /^([A-Za-z_]\w*)=(.*)$/.exec(current);
            if (kv) {
                prefix = `${kv[1]}=`;
                needle = kv[2].toLowerCase();
                pool = this.completeNamedArg(name, kv[1]);
            } else {
                pool = this.completeArg(name, idx - 1, before, current);
            }
        }

        const items = pool.filter((n) => {
            const l = n.toLowerCase();
            return l.startsWith(needle) || (idx === 0 && l.includes(':') && l.slice(l.indexOf(':') + 1).startsWith(needle));
        });

        // yeah
        const raw = idx > 0 && (this.resolveCommand(tokens[0].text.toLowerCase()) as CommandDef | undefined)?.rest;
        return { from, items: [...new Set(items)].sort().slice(0, 200).map((i) => prefix + (raw ? i : quote(i))) };
    }

    private names(): string[] {
        return [
            ...[...this.commands.values()].filter((c) => this.listed(c)).map((c) => c.name),
            ...[...this.cvars.values()].filter((c) => this.listed(c)).map((c) => c.name),
            ...Object.keys(this.state.aliases),
        ];
    }

    private completeArg(name: string, i: number, before: string[], current: string): string[] {
        const cmd = this.resolveCommand(name.toLowerCase());
        if (cmd && typeof cmd !== 'string') {
            if (cmd.complete) return cmd.complete(i, before, current);
            if (cmd.args) {
                const given = new Set(before.map((b) => /^-{0,2}(\w+)=/.exec(b)?.[1]).filter(Boolean));
                const positional = cmd.args.filter((a) => !given.has(a.name));
                const spec = positional[before.filter((b) => !/^-{0,2}\w+=/.test(b)).length];
                return spec ? completeValue(spec.type, this.env()) : [];
            }
            return [];
        }
        const cvar = this.cvars.get(name.toLowerCase());
        return cvar && i === 0 ? completeValue(cvar.type, this.env()) : [];
    }

    private completeNamedArg(name: string, arg: string): string[] {
        const cmd = this.resolveCommand(name.toLowerCase());
        const spec = cmd && typeof cmd !== 'string' ? cmd.args?.find((a) => a.name === arg) : undefined;
        return spec ? completeValue(spec.type, this.env()) : [];
    }

    // Built-ins

    private registerBuiltins(): void {
        const cvarNames = () => [...this.cvars.values()].filter((c) => !c.dev || this.developer).map((c) => c.name);
        const eventNames = () => EVENTS.map((e) => e.event as string);
        const cfgNames = () => Object.keys(this.state.cfgs);
        const first = (fn: () => string[]) => (i: number) => (i === 0 ? fn() : []);

        this.registerCvar({
            name: 'developer',
            type: { kind: 'boolean' },
            help: 'show dev commands and allow emit',
            default: false,
            get: () => this.developer,
            set: (v) => {
                this.state.vars.developer = v === true;
                this.save();
            },
        });
        this.registerCvar({
            name: 'listen_rate',
            type: { kind: 'number' },
            help: 'lines per second per event before listen starts dropping; 0 = no limit',
            default: 10,
            get: () => this.state.vars.listen_rate ?? 10,
            set: (v) => {
                this.state.vars.listen_rate = v;
                this.save();
            },
        });

        this.register({
            name: 'help',
            help: 'help [command|cvar] - what something does',
            complete: first(() => this.names()),
            run: ({ argv, print }) => {
                if (!argv.length) {
                    // bus commands under their namespace by short name
                    const groups = new Map<string, string[]>();
                    for (const c of this.commands.values()) {
                        if (!this.listed(c)) continue;
                        const colon = c.name.indexOf(':');
                        const group = colon > 0 ? c.name.slice(0, colon) : this.builtins.has(c.name.toLowerCase()) ? 'console' : 'commands';
                        const label = (colon > 0 ? c.name.slice(colon + 1) : c.name) + (c.dev ? '*' : '');
                        groups.set(group, [...(groups.get(group) ?? []), label]);
                    }

                    const order = ['console', 'commands', ...[...groups.keys()].filter((g) => g !== 'console' && g !== 'commands').sort()];
                    const w = Math.max(...order.map((g) => g.length)) + 2;
                    const width = this.display?.cols ?? 100;
                    for (const g of order) {
                        const items = groups.get(g);
                        if (items) print(wrapList(ansi.bold(g.padEnd(w)), items.sort(), w, width));
                    }

                    print('');
                    print(ansi.dim(`${this.cvars.size} cvars too - cvarlist shows them, or type one's name.`));
                    print(ansi.dim('help <name> for one thing. find <text> searches. tab completes. ; chains.'));
                    if (this.developer) print(ansi.dim('* = dev only'));
                    return;
                }
                const key = argv[0].toLowerCase();
                const alias = this.state.aliases[key];
                if (alias !== undefined) return print(`${ansi.bold(argv[0])} is an alias for ${ansi.green(quote(alias))}`);

                const cmd = this.resolveCommand(key);
                if (typeof cmd === 'string') return this.error(cmd);
                if (cmd) {
                    print(`${ansi.bold(cmd.name)} ${cmd.args ? this.usage(cmd.args) : ''}${cmd.dev ? ansi.yellow('  [dev]') : ''}`);
                    if (cmd.help) print(ansi.dim(`  ${cmd.help}`));
                    for (const a of cmd.args ?? []) if (a.doc) print(ansi.dim(`  ${a.name}: ${a.doc}`));
                    return;
                }
                const cvar = this.cvars.get(key);
                if (cvar) return this.showCvar(cvar);
                this.error(`nothing called "${argv[0]}"`);
            },
        });

        this.register({
            name: 'find',
            help: 'find <text> - search command and cvar names and docs',
            run: ({ argv, print }) => {
                const q = argv.join(' ').toLowerCase();
                if (!q) throw new Error('find what?');
                const hit = (n: string, d?: string) => n.toLowerCase().includes(q) || !!d?.toLowerCase().includes(q);
                for (const c of [...this.commands.values()].sort((a, b) => a.name.localeCompare(b.name))) {
                    if (this.listed(c) && hit(c.name, c.help)) print(`  ${helpLink(ansi.cyan(c.name), c.name)}${c.help ? ansi.dim(' - ' + c.help) : ''}`);
                }
                for (const c of [...this.cvars.values()].sort((a, b) => a.name.localeCompare(b.name))) {
                    if ((!c.dev || this.developer) && hit(c.name, c.help)) print(`  ${c.name} = ${formatValue(c.get(), { timezone: this.timezone() }, c.name)}${c.help ? ansi.dim(' - ' + c.help) : ''}`);
                }
            },
        });

        this.register({
            name: 'cmdlist',
            help: 'cmdlist [glob] - every command',
            run: ({ argv, print }) => {
                const re = globToRegex(argv[0] ?? '*');
                const list = [...this.commands.values()].filter((c) => this.listed(c) && re.test(c.name));
                for (const c of list.sort((a, b) => a.name.localeCompare(b.name))) {
                    print(`  ${helpLink(ansi.cyan(c.name), c.name)} ${ansi.dim(c.args ? this.usage(c.args) : '')}${c.dev ? ansi.yellow(' [dev]') : ''}`);
                }
                print(ansi.dim(`${list.length} commands`));
            },
        });

        this.register({
            name: 'cvarlist',
            help: 'cvarlist [glob] - every cvar and its value, by group',
            run: ({ argv, print }) => {
                const re = globToRegex(argv[0] ?? '*');
                const list = [...this.cvars.values()].filter((c) => (!c.dev || this.developer) && re.test(c.name));
                let group: string | undefined = '\0';
                const env = { timezone: this.timezone() };
                for (const c of list) {
                    if (c.group !== group) print(ansi.bold(`${(group = c.group) ?? 'console'}`));
                    const changed = !sameValue(c.get(), c.default);
                    print(`  ${changed ? ansi.yellow('*') : ' '}${c.name} = ${formatValue(c.get(), env, c.name)}`);
                }
                print(ansi.dim(`${list.length} cvars, * = changed`));
            },
        });

        this.register({
            name: 'differences',
            help: 'every cvar not at its default',
            run: ({ print }) => {
                const env = { timezone: this.timezone() };
                const diff = [...this.cvars.values()].filter((c) => !sameValue(c.get(), c.default));
                for (const c of diff) print(`  ${c.name} = ${formatValue(c.get(), env, c.name)} ${ansi.dim(`(default ${cvarText(c.default)})`)}`);
                if (!diff.length) print(ansi.dim('everything is default'));
            },
        });

        this.register({
            name: 'toggle',
            help: 'toggle <cvar> [values...] - flip a bool, or cycle through values',
            complete: (i, argv) => (i === 0 ? cvarNames() : completeValue(this.cvars.get(argv[0]?.toLowerCase())?.type ?? { kind: 'json' }, this.env())),
            run: ({ argv }) => {
                const c = this.findCvar(argv[0]);
                const env = this.env();
                let cycle: unknown[] = argv.slice(1).map((v) => parseValue(v, c.type, c, env));
                if (!cycle.length) {
                    if (c.type.kind === 'boolean') cycle = [false, true];
                    else if (c.type.kind === 'enum') cycle = c.type.values;
                    else throw new Error(`give ${c.name} values to cycle through`);
                }
                const at = cycle.findIndex((v) => sameValue(v, c.get()));
                c.set(cycle[(at + 1) % cycle.length]);
            },
        });

        this.register({
            name: 'incrementvar',
            help: 'incrementvar <cvar> <min> <max> <step> - step a number, wrapping at the ends',
            complete: first(cvarNames),
            run: ({ argv }) => {
                const c = this.findCvar(argv[0]);
                const [min, max, step] = argv.slice(1).map(Number);
                if (![min, max, step].every(Number.isFinite)) throw new Error('usage: incrementvar <cvar> <min> <max> <step>');
                const next = Number(c.get()) + step;
                c.set(next > max ? min : next < min ? max : Math.round(next * 1e9) / 1e9);
            },
        });

        this.register({
            name: 'revert',
            help: 'revert <cvar|glob>... - back to default',
            complete: () => cvarNames(),
            run: ({ argv }) => {
                if (!argv.length) throw new Error('revert what? (revert * for everything)');
                const patch: Record<string, unknown> = {};
                for (const pat of argv) {
                    const re = globToRegex(pat);
                    for (const c of this.cvars.values()) {
                        if (!re.test(c.name) || (c.dev && !this.developer)) continue;

                        if (c.name in DEFAULT_CHART_SETTINGS) patch[c.name] = c.default;
                        else c.set(c.default);
                    }
                }
                if (Object.keys(patch).length) this.host.emit('chart:apply-settings', { patch });
            },
        });

        this.register({
            name: 'echo',
            help: 'echo <text>',
            run: ({ argv, print }) => print(argv.join(' ')),
        });

        this.register({
            name: 'clear',
            help: 'clear the console',
            run: () => this.clears.forEach((fn) => fn()),
        });

        this.register({
            name: 'wait',
            help: 'wait [ms] - pause a chain of commands',
            run: ({ argv, signal }) => sleep(Number(argv[0] ?? 0) || 0, signal),
        });

        this.register({
            name: 'alias',
            help: 'alias [name] ["commands"] - list, show or define',
            complete: first(() => Object.keys(this.state.aliases)),
            run: ({ argv, print }) => {
                if (!argv.length) {
                    for (const [k, v] of Object.entries(this.state.aliases)) print(`  ${k} ${ansi.green(quote(v))}`);
                    return;
                }
                const key = argv[0].toLowerCase();
                if (argv.length === 1) {
                    const v = this.state.aliases[key];
                    return v === undefined ? this.error(`no alias "${key}"`) : print(`  ${key} ${ansi.green(quote(v))}`);
                }
                this.state.aliases[key] = argv.slice(1).join(' ');
                this.save();
            },
        });

        this.register({
            name: 'unalias',
            help: 'unalias <name>',
            complete: first(() => Object.keys(this.state.aliases)),
            run: ({ argv }) => {
                if (!(argv[0]?.toLowerCase() in this.state.aliases)) throw new Error(`no alias "${argv[0]}"`);
                delete this.state.aliases[argv[0].toLowerCase()];
                this.save();
            },
        });

        this.register({
            name: 'bind',
            help: 'bind <key> ["commands"] - e.g. bind ctrl+k "toggle showGrid"',
            complete: first(() => Object.keys(this.state.binds)),
            run: ({ argv, print }) => {
                const key = argv[0]?.toLowerCase();
                if (!key) throw new Error('bind what key?');
                if (argv.length === 1) {
                    const v = this.state.binds[key];
                    return v === undefined ? print(ansi.dim(`${key} is not bound`)) : print(`  ${key} ${ansi.green(quote(v))}`);
                }
                this.state.binds[key] = argv.slice(1).join(' ');
                this.save();
            },
        });

        this.register({
            name: 'unbind',
            help: 'unbind <key>',
            complete: first(() => Object.keys(this.state.binds)),
            run: ({ argv }) => {
                delete this.state.binds[argv[0]?.toLowerCase()];
                this.save();
            },
        });

        this.register({
            name: 'bindlist',
            help: 'every key binding',
            run: ({ print }) => {
                const binds = Object.entries(this.state.binds);
                for (const [k, v] of binds) print(`  ${ansi.cyan(k.padEnd(14))} ${ansi.green(quote(v))}`);
                if (!binds.length) print(ansi.dim('nothing bound'));
            },
        });

        this.register({
            name: 'exec',
            help: 'exec <cfg> - run a saved config',
            complete: first(cfgNames),
            run: async ({ argv, signal }) => {
                const cfg = this.state.cfgs[argv[0]];
                if (cfg === undefined) throw new Error(`no cfg "${argv[0]}" - cfglist shows what's saved`);
                for (const ln of cfg.split('\n')) await this.exec(ln, 0, signal);
            },
        });

        this.register({
            name: 'writecfg',
            help: 'writecfg [name] - save aliases, binds and changed settings as a cfg (default "config")',
            complete: first(cfgNames),
            run: ({ argv, print }) => {
                const name = argv[0] ?? 'config';
                const lines = [
                    ...Object.entries(this.state.aliases).map(([k, v]) => `alias ${k} ${quote(v)}`),
                    ...Object.entries(this.state.binds).map(([k, v]) => `bind ${k} ${quote(v)}`),
                    ...this.settingsDiff().map(([c, v]) => `${c.name} ${quote(cvarText(v))}`),
                ];
                this.state.cfgs[name] = lines.join('\n');
                this.save();
                print(ansi.dim(`wrote ${lines.length} lines to ${name}`));
            },
        });

        this.register({
            name: 'cfgappend',
            help: 'cfgappend <cfg> "<line>" - add a line to a cfg, making it if needed',
            complete: first(cfgNames),
            run: ({ argv }) => {
                if (argv.length < 2) throw new Error('usage: cfgappend <cfg> "<line>"');
                const prev = this.state.cfgs[argv[0]];
                const line = argv.slice(1).join(' ');
                this.state.cfgs[argv[0]] = prev ? `${prev}\n${line}` : line;
                this.save();
            },
        });

        this.register({
            name: 'cfglist',
            help: 'saved cfgs',
            run: ({ print }) => {
                const names = cfgNames();
                for (const n of names) print(`  ${n} ${ansi.dim(`(${this.state.cfgs[n].split('\n').length} lines)`)}`);
                if (!names.length) print(ansi.dim('no cfgs - writecfg makes one, autoexec runs on start'));
            },
        });

        this.register({
            name: 'cfgshow',
            help: 'cfgshow <cfg>',
            complete: first(cfgNames),
            run: ({ argv, print }) => {
                const cfg = this.state.cfgs[argv[0]];
                if (cfg === undefined) throw new Error(`no cfg "${argv[0]}"`);
                for (const ln of cfg.split('\n')) print(`  ${ln}`);
            },
        });

        this.register({
            name: 'cfgdel',
            help: 'cfgdel <cfg>',
            complete: first(cfgNames),
            run: ({ argv }) => {
                if (!(argv[0] in this.state.cfgs)) throw new Error(`no cfg "${argv[0]}"`);
                delete this.state.cfgs[argv[0]];
                this.save();
            },
        });

        this.register({
            name: 'listen',
            help: 'listen [glob]... - print events as they fire, e.g. listen playback:* order:*',
            complete: () => eventNames(),
            run: ({ argv, print }) => {
                if (!argv.length) {
                    if (!this.listenPatterns.length) return print(ansi.dim('not listening to anything'));
                    return print(`listening: ${this.listenPatterns.join(' ')} ${ansi.dim(`(${this.listening.size} events)`)}`);
                }
                let added = 0;
                for (const p of argv) added += this.listen(p);
                print(ansi.dim(`+${added} events, ${this.listening.size} total - unlisten to stop`));
            },
        });

        this.register({
            name: 'unlisten',
            help: 'unlisten [glob] - stop listening (all when no glob)',
            complete: () => [...this.listening.keys(), ...this.listenPatterns],
            run: ({ argv, print }) => {
                const n = argv.length ? argv.reduce((s, p) => s + this.unlisten(p), 0) : this.unlisten();
                print(ansi.dim(`-${n} events`));
            },
        });

        this.register({
            name: 'emit',
            dev: true,
            help: 'emit <event> [json | args] - fire anything on the bus',
            complete: (i, argv) => {
                if (i === 0) return eventNames();
                const spec = EVENTS.find((e) => e.event === argv[0]);
                const arg = spec?.args.filter((a) => !a.optional)[i - 1];
                return arg ? completeValue(arg.type, this.env()) : [];
            },
            run: ({ argv }) => {
                const [event, ...rest] = argv;
                if (!event) throw new Error('emit what?');
                const spec = EVENTS.find((e) => e.event === event);
                let payload: unknown;
                if (rest.length === 1 && /^[{["\d-]|^(true|false|null)$/.test(rest[0])) {
                    try {
                        payload = JSON.parse(rest[0]);
                    } catch {
                        payload = undefined;
                    }
                }
                if (payload === undefined && rest.length) {
                    if (!spec) throw new Error(`unknown event "${event}" - pass the payload as JSON`);
                    const parsed = this.parseArgs(spec.args, rest, event);
                    payload = spec.spread ? parsed : parsed.value;
                }
                this.host.emit(event as keyof ChartEvents, payload as never);
            },
        });

        this.register({
            name: 'status',
            help: 'what the chart is doing right now',
            run: ({ print }) => {
                const s = this.host.status();
                const w = Math.max(...Object.keys(s).map((k) => k.length));
                const env = { timezone: this.timezone() };
                for (const [k, v] of Object.entries(s)) print(`  ${ansi.dim(k.padEnd(w))}  ${formatValue(v, env, k)}`);
            },
        });

        this.register({
            name: 'history',
            help: 'history [n] - recent commands',
            run: ({ argv, print }) => {
                const n = Number(argv[0]) || 20;
                const from = Math.max(0, this.history.length - n);
                this.history.slice(from).forEach((h, i) => print(`  ${ansi.dim(String(from + i + 1).padStart(4))}  ${h}`));
            },
        });

        for (const c of pipeCommands(this)) this.register(c);
        this.register(watchCommand(this));
        this.register(cfgEditCommand(this));
        this.register(jsCommand(this));
        this.register(plotCommand(this));
        for (const c of scriptCommands(this)) this.register(c);
    }
}
