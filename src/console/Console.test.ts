// genuinely could not bother creating a test myself so this is like 90% made by claude lmao
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TypedEventBus } from '../core/TypedEventBus';
import { DEFAULT_CHART_SETTINGS, type ChartSettings } from '../lib/types/chart-settings';
import { Console, keyName, type ConsoleStorage } from './Console';
import { splitPipes, splitStatements, tokenize } from './lex';
import { ansi, parseDuration, parseTime, stripAnsi } from './values';

const PLAYHEAD = 1_700_000_000_000_000_000n;

function setup() {
    const bus = new TypedEventBus();
    let settings: ChartSettings = { ...DEFAULT_CHART_SETTINGS, timezone: 'UTC' };
    bus.on('chart:apply-settings', ({ patch }) => (settings = { ...settings, ...patch }));
    const emitted: [string, unknown][] = [];
    const store = new Map<string, unknown>();
    const storage: ConsoleStorage = {
        read: (k, fb) => (store.has(k) ? structuredClone(store.get(k)) : fb) as any,
        write: (k, v) => store.set(k, structuredClone(v)),
    };
    const con = new Console(
        {
            on: (e, fn) => bus.on(e, fn),
            emit: (e, d) => {
                emitted.push([e, d]);
                bus.emit(e, d);
            },
            settings: () => settings,
            focusedCell: () => 2,
            playheadNs: () => PLAYHEAD,
            status: () => ({ symbol: 'ES', playheadNs: PLAYHEAD }),
        },
        storage,
    );
    const out: string[] = [];
    con.onOutput((t) => out.push(stripAnsi(t)));
    return { con, bus, out, emitted, store, storage, settings: () => settings };
}

describe('lex', () => {
    it('splits on ; outside quotes and json', () => {
        const parts = splitStatements('a 1; alias x "b; c"; emit e {"a":";"}').map((s) => s.text.trim());
        assert.deepEqual(parts, ['a 1', 'alias x "b; c"', 'emit e {"a":";"}']);
    });

    it('keeps quoted strings, json blobs and name="x y" whole', () => {
        const t = tokenize(`bind k "toggle showGrid" {"a": [1, 2]} note="hello there" // comment`).map((x) => x.text);
        assert.deepEqual(t, ['bind', 'k', 'toggle showGrid', '{"a": [1, 2]}', 'note=hello there']);
    });
});

describe('values', () => {
    it('reads durations', () => {
        assert.equal(parseDuration('1h30m'), 5_400_000_000_000n);
        assert.equal(parseDuration('1.5s'), 1_500_000_000n);
        assert.equal(parseDuration('5x'), null);
    });

    it('reads times relative to the playhead and in the chart timezone', () => {
        const env = { timezone: 'America/New_York', playheadNs: () => PLAYHEAD, types: new Map() };
        assert.equal(parseTime('-1h', env), PLAYHEAD - 3_600_000_000_000n);
        assert.equal(parseTime('1700000000', env), PLAYHEAD);
        assert.equal(parseTime('2024-01-05T09:30', env), BigInt(Date.UTC(2024, 0, 5, 14, 30)) * 1_000_000n);
    });
});

describe('Console', () => {
    it('sets and shows chart settings as cvars', async () => {
        const { con, out, settings } = setup();
        await con.exec('wickWidth 3; priceScaleMode lo; showGrid off; crosshairDash 2,4; renkoBrickSize auto');
        assert.equal(settings().wickWidth, 3);
        assert.equal(settings().priceScaleMode, 'log');
        assert.equal(settings().showGrid, false);
        assert.deepEqual(settings().crosshairDash, [2, 4]);
        assert.equal(settings().renkoBrickSize, null);
        await con.exec('wickWidth');
        assert.match(out.join('\n'), /wickWidth = 3 {2}\(default 1\)/);
    });

    it('rejects bad values without touching the setting', async () => {
        const { con, out, settings } = setup();
        await con.exec('priceScaleMode sideways; upBodyColor banana');
        assert.equal(settings().priceScaleMode, 'normal');
        assert.equal(settings().upBodyColor, DEFAULT_CHART_SETTINGS.upBodyColor);
        assert.equal(out.length, 2);
    });

    it('runs generated commands with positional, named and context args', async () => {
        const { con, emitted } = setup();
        await con.exec('chart:set-symbol NQ; set-speed speed=4; playback:goto -1m; account:deposit 500 a note with spaces');
        assert.deepEqual(emitted[0], ['chart:set-symbol', { symbol: 'NQ', id: 2 }]);
        assert.deepEqual(emitted[1], ['playback:set-speed', { speed: 4 }]);
        assert.deepEqual(emitted[2], ['playback:goto', { tNs: PLAYHEAD - 60_000_000_000n }]);
        assert.deepEqual(emitted[3], ['account:deposit', { amount: 500, note: 'a note with spaces', ts: PLAYHEAD }]);
    });

    it('fills void and enum payloads', async () => {
        const { con, emitted } = setup();
        await con.exec('play; playback:set-mode st');
        assert.deepEqual(emitted, [
            ['playback:play', undefined],
            ['playback:set-mode', { mode: 'step' }],
        ]);
    });

    it('reports missing args and ambiguous short names', async () => {
        const { con, out, emitted } = setup();
        await con.exec('playback:set-speed; remove-indicator x; nope');
        assert.equal(emitted.length, 0);
        assert.match(out[0], /missing <speed>/);
        assert.match(out[1], /could be chart:remove-indicator, plugin:remove-indicator/);
        assert.match(out[2], /Unknown command "nope"/);
    });

    it('gates dev commands and emit behind developer', async () => {
        const { con, out, emitted } = setup();
        await con.exec('emit chart:reset-view');
        assert.match(out[0], /needs developer 1/);
        await con.exec('developer 1; emit chart:set-symbol-focused {"symbol":"CL"}; emit chart:set-symbol-focused GC');
        assert.deepEqual(emitted, [
            ['chart:set-symbol-focused', { symbol: 'CL' }],
            ['chart:set-symbol-focused', { symbol: 'GC' }],
        ]);
    });

    it('toggles, cycles, increments and reverts', async () => {
        const { con, settings } = setup();
        await con.exec('toggle showGrid');
        assert.equal(settings().showGrid, false);
        await con.exec('toggle crosshairMode; toggle crosshairMode');
        assert.equal(settings().crosshairMode, 'hidden');
        await con.exec('toggle wickWidth 1 2 3; toggle wickWidth 1 2 3');
        assert.equal(settings().wickWidth, 3);
        await con.exec('incrementvar wickWidth 1 3 1');
        assert.equal(settings().wickWidth, 1);
        await con.exec('revert *');
        assert.equal(settings().showGrid, true);
        assert.equal(settings().crosshairMode, 'normal');
    });

    it('aliases, binds and cfgs persist and run', async () => {
        const { con, storage, settings } = setup();
        await con.exec('alias grid "toggle showGrid"; bind ctrl+g grid; wickWidth 4; writecfg mine');
        const again = new Console((con as any).host, storage);
        assert.equal(again.handleKey('ctrl+g'), true);
        await new Promise((r) => setTimeout(r, 0));
        assert.equal(settings().showGrid, false);
        await again.exec('revert wickWidth; exec mine');
        assert.equal(settings().wickWidth, 4);
        assert.equal(again.handleKey('ctrl+h'), false);
    });

    it('stops runaway aliases', async () => {
        const { con, out } = setup();
        await con.exec('alias loop loop; loop');
        assert.match(out[0], /nests deeper than 32/);
    });

    it('listens with a rate limit and unlistens', async () => {
        const { con, bus, out } = setup();
        await con.exec('listen_rate 2; listen playback:*');
        out.length = 0;
        for (let i = 0; i < 5; i++) bus.emit('playback:set-speed', { speed: i });
        assert.equal(out.length, 2);
        assert.match(out[0], /playback:set-speed \{ speed: 0 \}/);
        await con.exec('unlisten');
        out.length = 0;
        bus.emit('playback:play', undefined);
        assert.equal(out.length, 0);
    });

    it('formats ns timestamps in listen output', async () => {
        const { con, bus, out } = setup();
        await con.exec('listen playback:goto');
        out.length = 0;
        bus.emit('playback:goto', { tNs: PLAYHEAD });
        assert.match(out[0], /tNs: 2023-11-14 22:13:20\.000/);
    });

    it('wait can be aborted', async () => {
        const { con } = setup();
        const started = Date.now();
        const run = con.exec('wait 5000; echo late');
        con.abort();
        await run;
        assert.ok(Date.now() - started < 1000);
    });

    it('tab completes names, short names, values and named args', () => {
        const { con } = setup();
        assert.ok(con.complete('wickW').items.includes('wickWidth'));
        assert.ok(con.complete('set-time').items.includes('chart:set-timeframe'));
        assert.deepEqual(con.complete('priceScaleMode ').items, ['log', 'normal', 'percent']);
        assert.deepEqual(con.complete('play; playback:set-mode r').items, ['realtime']);
        assert.deepEqual(con.complete('playback:set-mode mode=s'), { from: 18, items: ['mode=step'] });
        assert.ok(!con.complete('emi').items.includes('emit'));
    });

    it('help lists every visible command, by namespace', async () => {
        const { con, out } = setup();
        con.register({ name: 'doom', run: () => {} });
        await con.exec('help');
        const text = out.join('\n');
        for (const name of ['alias', 'listen', 'doom', 'play', 'set-timeframe', 'strategy-sweep', 'flatten']) {
            assert.match(text, new RegExp(`\\b${name}\\b`), name);
        }
        assert.match(text, /^console {2,}alias/m);
        assert.match(text, /^commands {2,}doom/m);
        assert.doesNotMatch(text, /\bemit\b|rehydrate/);
        out.length = 0;
        await con.exec('developer 1; help');
        assert.match(out.join('\n'), /emit\*/);
    });

    it('wraps help to the display width', async () => {
        const { con, out } = setup();
        con.setDisplay({ cols: 40, openScreen: () => assert.fail() });
        await con.exec('help');
        const lists = out.join('\n').split('\n\n')[0].split('\n');
        for (const line of lists) assert.ok(line.length <= 40, line);
    });

    it('gives commands a screen that closes on abort or detach', async () => {
        const { con, out } = setup();
        const closed: string[] = [];
        const makeScreen = () => {
            const ctl = new AbortController();
            return {
                cols: 80,
                rows: 24,
                cell: { width: 8, height: 16 },
                write: async () => {},
                onData: () => () => {},
                onKey: () => () => {},
                onResize: () => () => {},
                closed: ctl.signal,
                close: () => (closed.push('x'), ctl.abort()),
            };
        };
        let screen: any;
        con.register({
            name: 'game',
            run: async (ctx) => {
                screen = ctx.screen({ maximize: true });
                await new Promise((r) => screen.closed.addEventListener('abort', r));
                ctx.print('bye');
            },
        });
        await con.exec('game');
        assert.match(out[0], /needs the terminal open/);

        const detach = con.setDisplay({ cols: 80, openScreen: makeScreen });
        out.length = 0;
        const run = con.exec('game');
        await con.exec('game');
        assert.match(out[0], /already has the screen/);
        con.abort();
        await run;
        assert.equal(closed.length, 1);
        assert.equal(out.at(-1), 'bye');

        const run2 = con.exec('game');
        detach();
        await run2;
        assert.equal(closed.length, 2);
    });

    it('hidden commands run but never show up', async () => {
        const { con, out } = setup();
        con.register({ name: 'bottom', hidden: true, run: ({ print }) => print('found me') });
        await con.exec('help; cmdlist; find bott');
        assert.doesNotMatch(out.join('\n'), /bottom/);
        assert.ok(!con.complete('bott').items.includes('bottom'));
        out.length = 0;
        await con.exec('bottom');
        assert.deepEqual(out, ['found me']);
    });

    it('js evaluates expressions and statements with the scope, keeps $_', async () => {
        const { con, out } = setup();
        con.scope.answer = 41;
        await con.exec('js answer + 1');
        assert.match(out[0], /needs developer 1/);
        await con.exec('developer 1');
        out.length = 0;
        await con.exec('js answer + 1');
        assert.deepEqual(out, ['42']);
        await con.exec('js $_ * 2');
        assert.equal(out[1], '84');
        // ; belongs to js, not the console
        await con.exec('js let x = 2; x = x * answer; print("x is", x)');
        assert.equal(out[2], 'x is 82');
        // the last statement's value comes back, repl style
        await con.exec('js const y = answer; y + 1;');
        assert.equal(out[3], '42');
        out.splice(3, 1);
        await con.exec('js ({ a: [1, 2], m: new Map([["k", 1]]) })');
        assert.match(out[3], /a: \[\n\s+1,\n\s+2\n\s+\]/);
        assert.match(out[3], /Map\(1\)/);
        await con.exec('js await sleep(1) ?? "slept"');
        assert.equal(out[4], '"slept"');
        await con.exec('js nope.nope');
        assert.match(out[5], /ReferenceError: nope is not defined/);
        await con.exec('js ({');
        assert.match(out[6], /SyntaxError/);
    });

    it('js completes properties along a path', async () => {
        const { con } = setup();
        con.scope.thing = { alpha: { beta: 1, bravo: 2 }, also: 3 };
        await con.exec('developer 1');
        assert.deepEqual(con.complete('js thing.al').items, ['thing.alpha', 'thing.also']);
        assert.deepEqual(con.complete('js thing.alpha.b').items, ['thing.alpha.beta', 'thing.alpha.bravo']);
        assert.ok(con.complete('js thi').items.includes('thing'));
    });

    it('capture returns output instead of printing it', async () => {
        const { con, out } = setup();
        const got = await con.capture('echo one; echo two');
        assert.deepEqual(got, ['one', 'two']);
        assert.equal(out.length, 0);
    });

    it('watch reruns a command on a screen', async () => {
        const { con } = setup();
        const writes: string[] = [];
        const ctl = new AbortController();
        con.setDisplay({
            cols: 80,
            openScreen: () => ({
                cols: 80,
                rows: 10,
                cell: { width: 8, height: 16 },
                write: async (d) => {
                    writes.push(stripAnsi(d));
                    if (writes.length === 2) ctl.abort();
                },
                onData: () => () => {},
                onKey: () => () => {},
                onResize: () => () => {},
                closed: ctl.signal,
                close: () => ctl.abort(),
            }),
        });
        await con.exec('watch 100ms echo "hi there"');
        assert.equal(writes.length, 2);
        assert.match(writes[0], /every 100ms: echo "hi there"/);
        assert.match(writes[0], /\nhi there/);
    });

    it('cfgedit edits and saves a cfg', async () => {
        const { con } = setup();
        await con.exec('cfgappend mine "echo a"');
        let feed: (d: string) => void = () => {};
        const ctl = new AbortController();
        let last = '';
        con.setDisplay({
            cols: 80,
            openScreen: () => ({
                cols: 80,
                rows: 10,
                cell: { width: 8, height: 16 },
                write: async (d) => void (last = stripAnsi(d)),
                onData: (fn) => ((feed = fn), () => {}),
                onKey: () => () => {},
                onResize: () => () => {},
                closed: ctl.signal,
                close: () => ctl.abort(),
            }),
        });
        const run = con.exec('cfgedit mine');
        await new Promise((r) => setTimeout(r, 0));
        assert.match(last, /cfgedit {2}mine/);
        for (const d of ['\r', 'e', 'c', 'h', 'o', ' ', 'b', '\x1b[A', '\x7f', '\x7f', '\x7f', '\x7f', '\x7f', '\x7f']) feed(d);
        assert.match(last, /\[modified\]/);
        feed('\x18');
        assert.match(last, /unsaved changes/);
        feed('\x13');
        feed('\x18');
        await run;
        assert.equal(con.cfg('mine'), '\necho b');
    });

    it('reads time and duration args', async () => {
        const { con } = setup();
        let got: Record<string, unknown> = {};
        con.register({
            name: 'when',
            args: [
                { name: 'at', type: { kind: 'time' } },
                { name: 'span', type: { kind: 'duration' } },
            ],
            run: ({ args }) => void (got = args),
        });
        await con.exec('when -1h 1h30m');
        assert.equal(got.at, PLAYHEAD - 3_600_000_000_000n);
        assert.equal(got.span, 5_400_000_000_000n);
    });

    it('pipes output through filters', async () => {
        const { con, out } = setup();
        con.register({ name: 'nums', run: ({ print }) => ['b 3', 'a 10', 'c 2', 'a 10'].forEach((l) => print(l)) });
        await con.exec('nums | grep a');
        assert.deepEqual(out, ['a 10', 'a 10']);
        out.length = 0;
        await con.exec('nums | grep -v -c a; nums | sort -n | head 2; nums | uniq | count');
        assert.deepEqual(out, ['2', 'c 2', 'b 3', '3']);
        out.length = 0;
        await con.exec('nums | sort -r | uniq -c | tail 1');
        assert.match(out[0], /^\s+2 a 10$/);
        out.length = 0;
        await con.exec('echo "a|b" | grep "\\|"');
        assert.deepEqual(out, ['a|b']);
        out.length = 0;
        await con.exec('grep x');
        assert.match(out[0], /grep reads from a pipe/);
        out.length = 0;
        // js owns its line - that | is a bitwise or, not a pipe
        await con.exec('developer 1; js [1, 2] | 4');
        assert.equal(out[0], '4');
    });

    it('suggests from history first, then the command bank', async () => {
        const { con } = setup();
        await con.submit('wickWidth 4');
        await con.submit('playback:set-speed 8');
        assert.equal(con.suggest('wick'), 'wickWidth 4');
        assert.equal(con.suggest('playback:set-sp'), 'playback:set-speed 8');
        // nothing in history starts with it - complete the word instead
        assert.equal(con.suggest('priceScaleM'), 'priceScaleMode');
        assert.equal(con.suggest('priceScaleMode l'), 'priceScaleMode log');
        assert.equal(con.suggest('zzz'), null);
        assert.equal(con.suggest(''), null);
    });

    it('highlights without changing a single character', async () => {
        const { con } = setup();
        await con.exec('alias g "toggle showGrid"; developer 1');
        const lines = [
            'wickWidth 3; g // flip it',
            'chart:set-symbol "NQ" id=2 | grep x',
            'nope 12',
            'js const a = "x" + 1 // hi',
            'emit chart:reset-view',
            '',
        ];
        for (const l of lines) assert.equal(stripAnsi(con.highlight(l)), l);
        const h = con.highlight('wickWidth 3; nope; g');
        assert.ok(h.includes(ansi.blue('wickWidth')));
        assert.ok(h.includes(ansi.yellow('3')));
        assert.ok(h.includes(ansi.red('nope')));
        assert.ok(h.includes(ansi.magenta('g')));
        assert.ok(con.highlight('js await x').includes(ansi.magenta('await')));
    });

    it('saved cvars persist and replay onChange on the next start', async () => {
        const { con, storage } = setup();
        const seen: unknown[] = [];
        con.registerSavedCvar({ name: 'net_graph', type: { kind: 'number' }, default: 0, onChange: (v) => seen.push(v) });
        assert.deepEqual(seen, []);
        await con.exec('net_graph 2');
        assert.deepEqual(seen, [2]);
        const again = new Console((con as any).host, storage);
        const seen2: unknown[] = [];
        again.registerSavedCvar({ name: 'net_graph', type: { kind: 'number' }, default: 0, onChange: (v) => seen2.push(v) });
        assert.deepEqual(seen2, [2]);
    });

    it('links times to the playhead and names to help', async () => {
        const { con, bus, out } = setup();
        const raw: string[] = [];
        con.onOutput((t) => raw.push(t));
        await con.exec('listen playback:goto');
        bus.emit('playback:goto', { tNs: PLAYHEAD });
        const line = raw.at(-1)!;
        assert.ok(line.includes(`\x1b]8;;ct:goto/${PLAYHEAD}\x1b\\`), 'time links to goto');
        assert.ok(line.includes('\x1b]8;;ct:help/playback%3Agoto\x1b\\'), 'event links to help');
        assert.match(out.at(-1)!, /playback:goto \{ tNs: 2023-11-14 22:13:20\.000 \}/, 'links are invisible');
    });

    it('plots numbers, rows and named series', async () => {
        const { con, out } = setup();
        con.scope.bars = Array.from({ length: 50 }, (_, i) => ({ ts: BigInt(i), close: 100 + i }));
        await con.exec('developer 1');
        await con.exec('plot -h 6 bars');
        assert.equal(out.length, 6 + 3); // rows, axis, count, legend
        assert.match(out[0], /^\s*149 ┤/);
        assert.match(out[5], /^\s*100 ┤/);
        assert.ok(out.slice(0, 6).join('').match(/[⠁-⣿]/), 'draws braille');
        assert.match(out[8], /━ close/);
        out.length = 0;
        await con.exec('plot "nope"');
        assert.match(out[0], /isn't numbers/);
        // $_ is shared with js
        out.length = 0;
        await con.exec('js [3, 1, 2, 5, 4, 6, 8, 7, 9]');
        await con.exec('plot $_');
        assert.match(out[0], /Array\(9\)\s+[▁-█]+/);
        assert.ok(out.length > 4);
    });

    it('saves js scripts, runs them with args, lists and deletes them', async () => {
        const { con, out, storage } = setup();
        con.scope.base = 10;
        await con.exec('developer 1');
        let feed: (d: string) => void = () => {};
        const ctl = new AbortController();
        con.setDisplay({
            cols: 80,
            openScreen: () => ({
                cols: 80,
                rows: 10,
                cell: { width: 8, height: 16 },
                write: async () => {},
                onData: (fn) => ((feed = fn), () => {}),
                onKey: () => () => {},
                onResize: () => () => {},
                closed: ctl.signal,
                close: () => ctl.abort(),
            }),
        });
        const editing = con.exec('jsedit sum');
        await new Promise((r) => setTimeout(r, 0));
        feed('const n = args.map(Number);');
        feed('\r');
        feed('n.reduce((a, b) => a + b, base)');
        feed('\x13');
        feed('\x18');
        await editing;
        assert.equal(con.script('sum'), 'const n = args.map(Number);\nn.reduce((a, b) => a + b, base)');

        out.length = 0;
        await con.exec('run sum 1 2 3');
        assert.deepEqual(out, ['16']);
        await con.exec('scripts');
        assert.match(out[1], /sum\s+2 lines\s+const n = args/);
        // saved with the rest of the setup
        assert.equal(new Console((con as any).host, storage).script('sum')?.split('\n').length, 2);
        await con.exec('jsdel sum; run sum');
        assert.match(out.at(-1)!, /no script "sum"/);
    });

    it('splits pipes but not || or quoted bars', () => {
        assert.deepEqual(splitPipes('a | b "x|y" | c || d').map((s) => s.text.trim()), ['a', 'b "x|y"', 'c || d']);
    });

    it('names keys the way bind takes them', () => {
        assert.equal(keyName({ key: 'K', ctrlKey: true, shiftKey: true }), 'ctrl+k');
        assert.equal(keyName({ key: 'F5', shiftKey: true }), 'shift+f5');
        assert.equal(keyName({ key: ' ', altKey: true }), 'alt+space');
    });
});
