import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_CHART_SETTINGS } from '../lib/types/chart-settings';
import type { CommandContext, CommandDef, Screen } from './Console';
import { scriptStats } from '../core/ScriptedPlugin';
import { stripAnsi } from './values';
import { bookCommand } from './tools/book';
import { freeCommand } from './tools/free';
import { tapeCommand } from './tools/tape';
import { topCommand } from './tools/top';
import { tickOf, upperBound } from './tools/market';
import { bar, clip } from './tools/tui';
import { paramCvars, scriptArgSpecs, slugOf } from './plugin-console';
import { traceTools } from './tools/trace';
import { netCommand } from './tools/net';
import { triggerTools } from './tools/triggers';
import { profileCommand } from './tools/profile';
import { lookCommand } from './tools/look';
import { Console } from './Console';
import { TypedEventBus } from '../core/TypedEventBus';

const S = 1_000_000_000n;
const T0 = 1_700_000_000n * S;

function fakeChart(opts: { trades?: boolean; book?: boolean } = {}) {
    const trades = opts.trades
        ? Array.from({ length: 400 }, (_, i) => ({
              ts: T0 + BigInt(i) * S,
              price: 100 + ((i * 7) % 9) * 0.25,
              size: i % 50 === 0 ? 40 : 1 + (i % 5),
              side: (i % 3 ? 'B' : 'A') as 'B' | 'A',
          }))
        : [];
    return {
        getData: () => ({ dataLevel: opts.trades ? 'l3' : 'ohlcv', trades, ohlcvBars: [{ ts: 0n }], footprintBars: [], priceHistory: [], ticks: [] }),
        getSymbol: () => 'ES',
        getTimeframe: () => '1m',
        getChart: () => ({ settings: { ...DEFAULT_CHART_SETTINGS, timezone: 'UTC' } }),
        getSymbolInfo: () => ({ priceFormat: { minTick: 0.25 } }),
        playback: { playing: true, speed: 4, time: T0 + 300n * S },
        renderEngine: { paintStats: { frames: 10, totalMs: 20, lastMs: 2, maxMs: 9 } },
        eventBus: { emitCounts: new Map([['price:update', 120], ['playback:tick', 30]]) },
        executionEngine: {
            getDepth: () =>
                opts.book
                    ? { bids: [{ price: 100.5, size: 12, orders: 3 }, { price: 100.25, size: 30, orders: 5 }], asks: [{ price: 100.75, size: 8, orders: 2 }] }
                    : { bids: [], asks: [] },
        },
        on: (_e: string, fn: (d: unknown) => void) => (fn({ bid: 100.5, ask: 100.75, last: 100.5, spread: 0.25 }), () => {}),
    } as never;
}

// a screen 100x30 that closes itself after frames writes
function fakeScreen(frames = 2) {
    const writes: string[] = [];
    const ctl = new AbortController();
    const screen: Screen = {
        cols: 100,
        rows: 30,
        cell: { width: 8, height: 16 },
        write: async (d) => {
            writes.push(d);
            if (writes.length >= frames) ctl.abort();
        },
        onData: () => () => {},
        onKey: () => () => {},
        onResize: () => () => {},
        closed: ctl.signal,
        close: () => ctl.abort(),
    };
    return { screen, writes };
}

async function run(cmd: CommandDef, argv: string[] = [], frames = 2) {
    const { screen, writes } = fakeScreen(frames);
    const printed: string[] = [];
    const ctx: CommandContext = {
        args: {},
        argv,
        raw: argv.join(' '),
        input: null,
        print: (t) => printed.push(stripAnsi(t)),
        error: (t) => printed.push(stripAnsi(t)),
        signal: new AbortController().signal,
        console: null as never,
        screen: () => screen,
    };
    await cmd.run(ctx);
    return { frames: writes.map(stripAnsi), printed };
}

describe('trace and why', () => {
    function traceSetup() {
        const bus = new TypedEventBus();
        const chart = { eventBus: bus, getChart: () => ({ settings: { ...DEFAULT_CHART_SETTINGS, timezone: 'UTC' } }) } as never;
        const con = { registerCvar: () => () => {} } as never;
        const [trace, why] = traceTools(chart, con);
        return { bus, trace, why };
    }

    it('why names the code that changed a setting', async () => {
        const { bus, why } = traceSetup();
        function flipGridFromToolbar() {
            bus.emit('chart:apply-settings', { patch: { showGrid: false } });
        }
        flipGridFromToolbar();
        const { printed } = await run(why, ['showGrid']);
        assert.match(printed[0], /showGrid = false/);
        assert.ok(printed.some((l) => /flipGridFromToolbar\s+tools\.test\.ts:\d+/.test(l)), printed.join('\n'));
        const none = await run(why, ['wickWidth']);
        assert.match(none.printed[0], /hasn't changed/);
        const list = await run(why, []);
        assert.match(list.printed[0], /showGrid\s+false/);
    });

    it('records events and browses them, heavy payloads summarized', async () => {
        const { bus, trace } = traceSetup();
        await run(trace, ['on']);
        bus.emit('playback:set-speed', { speed: 4 });
        bus.emit('data:append', { symbol: 'ES', ohlcvBars: [] } as never);
        bus.emit('playback:play', undefined);
        const { frames } = await run(trace, [], 1);
        const f = frames[0];
        assert.match(f, /3 shown · 3 seen/);
        assert.match(f, /playback:set-speed\s+\{ speed: 4 \}/);
        assert.match(f, /data:append\s+\{ symbol, ohlcvBars \} \(not kept\)/);
    });
});

describe('triggers', () => {
    function triggerSetup() {
        const bus = new TypedEventBus();
        let equity = 1000;
        const chart = {
            on: (e: never, fn: never) => bus.on(e, fn),
            getChart: () => ({ settings: { ...DEFAULT_CHART_SETTINGS, timezone: 'UTC' } }),
            playback: { time: T0 },
            account: { getSnapshot: () => ({ equity, balance: equity, unrealizedPnl: 0, realizedPnl: 0, openPositionCount: 0 }) },
        } as never;
        const store = new Map();
        const con = new Console(
            {
                on: (e, fn) => bus.on(e, fn),
                emit: (e, d) => bus.emit(e, d),
                settings: () => ({ ...DEFAULT_CHART_SETTINGS, timezone: 'UTC' }),
                focusedCell: () => 0,
                playheadNs: () => T0,
                status: () => ({}),
            },
            { read: (k, f) => store.get(k) ?? f, write: (k, v) => store.set(k, v) },
        );
        for (const c of triggerTools(chart, con)) con.register(c);
        const out: string[] = [];
        con.onOutput((t) => out.push(stripAnsi(t)));
        const tick = (last: number) => bus.emit('playback:tick', { bid: last - 0.25, ask: last, last, spread: 0.25 });
        return { bus, con, out, tick, setEquity: (v: number) => (equity = v) };
    }
    const settle = () => new Promise((r) => setTimeout(r, 0));

    it('on runs a command per matching event, filling $fields', async () => {
        const { bus, con, out } = triggerSetup();
        await con.exec('on order:fill side=buy price>=100 "echo bought $quantity at $price"');
        bus.emit('order:fill', { side: 'buy', price: 101, quantity: 2 } as never);
        bus.emit('order:fill', { side: 'sell', price: 101, quantity: 3 } as never);
        bus.emit('order:fill', { side: 'buy', price: 99, quantity: 4 } as never);
        await settle();
        assert.deepEqual(out.filter((l) => l.startsWith('bought')), ['bought 2 at 101']);
        out.length = 0;
        await con.exec('triggers');
        assert.match(out[0], /1\s+on\s+order:fill side=buy price>=100\s+→ echo bought \$quantity at \$price\s+fired 1×/);
    });

    it('when fires once on the crossing, --every on each one', async () => {
        const { con, out, tick } = triggerSetup();
        tick(4790);
        await con.exec('when price > 4800 "echo crossed at $price"');
        await con.exec('when price>4800 "echo again" --every');

        for (const p of [4801, 4805, 4795, 4802]) {
            tick(p);
            await settle();
        }
        assert.deepEqual(out.filter((l) => l.startsWith('crossed')), ['crossed at 4801']);
        assert.equal(out.filter((l) => l === 'again').length, 2);
        out.length = 0;
        await con.exec('triggers');
        assert.equal(out.length, 1, 'the one-shot removed itself');
    });

    it('when reads the account, untrigger stops it', async () => {
        const { con, out, setEquity, bus } = triggerSetup();
        await con.exec('when equity < 900 "echo margin call"');
        await con.exec('untrigger 1');
        setEquity(850);
        bus.emit('account:update', {} as never);
        await settle();
        assert.ok(!out.includes('margin call'));
        await con.exec('when equity < 900 "echo margin call"');
        bus.emit('account:update', {} as never);
        await settle();
        assert.ok(out.includes('margin call') === false, 'already true when set - waits for the next crossing');
        setEquity(950);
        bus.emit('account:update', {} as never);
        setEquity(800);
        bus.emit('account:update', {} as never);
        await settle();
        assert.ok(out.includes('margin call'));
    });

    it('turns off a runaway', async () => {
        const { bus, con, out } = triggerSetup();
        await con.exec('on playback:set-speed "echo x"');
        for (let i = 0; i < 30; i++) {
            bus.emit('playback:set-speed', { speed: i });
            await settle();
        }
        assert.ok(out.some((l) => /fired over 20 times a second - turned it off/.test(l)));
        assert.equal(out.filter((l) => l === 'x').length, 20);
    });

    it('blocks a command that re-fires its own trigger', async () => {
        const { con, out } = triggerSetup();
        await con.exec('on playback:set-speed "echo speed $speed; playback:set-speed 9"');
        await con.exec('playback:set-speed 2');
        await settle();

        assert.deepEqual(out.filter((l) => l.startsWith('speed')), ['speed 2']);
    });

    it('explains a condition it cannot read', async () => {
        const { con, out } = triggerSetup();
        await con.exec('when vibes > 3 "echo"');
        assert.match(out[0], /can't see "vibes"/);
    });
});

describe('profile', () => {
    it('reports frames, paints, scripts and events over the run', async () => {
        const g = globalThis as Record<string, unknown>;
        g.requestAnimationFrame = (fn: (t: number) => void) => setTimeout(() => fn(performance.now()), 16) as unknown as number;
        g.cancelAnimationFrame = (id: number) => clearTimeout(id);
        const bus = new TypedEventBus();
        const paintStats = { frames: 0, totalMs: 0, lastMs: 0, maxMs: 0 };
        const chart = { eventBus: bus, renderEngine: { paintStats } } as never;
        scriptStats.set('prof:0', { name: 'VWAP', type: 'indicator', computes: 10, totalMs: 10, lastMs: 1, maxMs: 1 });
        const busy = setInterval(() => {
            bus.emit('playback:set-speed', { speed: 1 });
            paintStats.frames++;
            paintStats.lastMs = 2;
            const s = scriptStats.get('prof:0')!;
            s.computes++;
            s.totalMs += 3;
        }, 30);
        try {
            const { printed } = await run(profileCommand(chart), ['600ms']);
            const text = printed.join('\n');
            assert.match(text, /profile\s+0\.6s\s+\d+ frames\s+\d+\.\d fps/);
            assert.match(text, /frames\s+p50 \d/);
            assert.match(text, /17-25|8-17/);
            assert.match(text, /paint\s+\d+ paints\s+2\.00ms avg/);
            assert.match(text, /VWAP\s+\d+ runs/);
            assert.match(text, /playback:set-speed\s+\d+/);
        } finally {
            clearInterval(busy);
            scriptStats.delete('prof:0');
            delete g.requestAnimationFrame;
            delete g.cancelAnimationFrame;
        }
    });
});

describe('look', () => {
    it('recenters without moving the playhead, refuses the future', async () => {
        const bus = new TypedEventBus();
        const ranges: unknown[] = [];
        bus.on('chart:goto-range', (r) => ranges.push(r));
        const chart = {
            eventBus: bus,
            renderEngine: null,
            playback: { time: T0 },
            getChart: () => ({ settings: { ...DEFAULT_CHART_SETTINGS, timezone: 'UTC' } }),
        } as never;
        const look = lookCommand(chart);
        const past = await run({ ...look, run: (ctx) => look.run({ ...ctx, args: { at: T0 - 60n * S } }) });
        assert.deepEqual(ranges, [{ fromNs: T0 - 60n * S }]);
        assert.equal(past.printed.length, 0);
        const future = await run({ ...look, run: (ctx) => look.run({ ...ctx, args: { at: T0 + S } }) });
        assert.match(future.printed[0], /in your future/);
        assert.equal(ranges.length, 1);
    });
});

describe('net', () => {
    const req = (name: string, over: Record<string, unknown>) =>
        ({
            name,
            entryType: 'resource',
            initiatorType: 'fetch',
            startTime: 0,
            requestStart: 10,
            responseStart: 40,
            responseEnd: performance.now() - 2000,
            duration: 80,
            transferSize: 2048,
            encodedBodySize: 2000,
            decodedBodySize: 8000,
            responseStatus: 200,
            nextHopProtocol: 'h2',
            domainLookupStart: 0,
            domainLookupEnd: 0,
            connectStart: 0,
            connectEnd: 0,
            secureConnectionStart: 0,
            ...over,
        }) as never;

    it('lists requests with status, cache and size', async () => {
        const rec = {
            requests: [
                req('https://data.example.com/bars?sym=ES', {}),
                req('https://data.example.com/symbols', { transferSize: 0, decodedBodySize: 500 }),
                req('https://cdn.example.com/font.woff2', { initiatorType: 'css', transferSize: 0, decodedBodySize: 0, responseStart: 0, responseStatus: 0 }),
                req('https://data.example.com/missing', { responseStatus: 404 }),
            ],
            clear() {},
        };
        const { frames } = await run(netCommand(rec), [], 1);
        const f = frames[0];
        assert.match(f, /4 requests/);
        assert.match(f, /cache 25%/);
        assert.match(f, /200 fetch\s+2\.0 KB\s+80\.0ms.*data\.example\.com\/bars\?sym=ES/);
        assert.match(f, /cache.*\/symbols/);
        assert.match(f, /css\s+\?.*font\.woff2/);
        assert.match(f, /404/);

        const filtered = await run(netCommand(rec), ['symbols'], 1);
        assert.match(filtered.frames[0], /filter symbols/);
        assert.doesNotMatch(filtered.frames[0], /font\.woff2/);
    });
});

describe('plugin console helpers', () => {
    it('slugs names and reads script arg specs', () => {
        assert.equal(slugOf('MA Cross (v2)'), 'ma-cross-v2');
        assert.deepEqual(scriptArgSpecs({ n: 'number', side: ['buy', 'sell'], at: { type: 'time', optional: true, help: 'when' } }), [
            { name: 'n', type: { kind: 'number' } },
            { name: 'side', type: { kind: 'enum', values: ['buy', 'sell'] } },
            { name: 'at', type: { kind: 'time' }, optional: true, doc: 'when' },
        ]);
    });

    it('turns params into typed cvars, paired params included', () => {
        const live: Record<string, unknown> = { fast: 10, mode: 'ema', on: true, col_a: '#ff0000', col_b: '#00ff00' };
        const sets: [string, unknown][] = [];
        const cvars = paramCvars({
            slug: 'ma-cross',
            paramDefs: {
                fast: { type: 'stepperInt', label: 'Fast' },
                mode: { type: 'select', label: 'Mode', options: [{ value: 'sma', label: 'SMA' }, { value: 'ema', label: 'EMA' }] },
                on: { type: 'checkbox', label: 'On' },
                col: { type: 'dualColor', label: 'Colors' },
            },
            defaults: { fast: 20, mode: 'sma', on: false, col_a: '#111111', col_b: '#222222' },
            keysOf: (k, d) => (d.type === 'dualColor' ? [`${k}_a`, `${k}_b`] : [k]),
            get: (k) => live[k],
            set: (k, v) => sets.push([k, v]),
            group: 'MA Cross',
        });
        assert.deepEqual(
            cvars.map((c) => [c.name, c.type.kind]),
            [
                ['ma-cross.fast', 'number'],
                ['ma-cross.mode', 'enum'],
                ['ma-cross.on', 'boolean'],
                ['ma-cross.col_a', 'color'],
                ['ma-cross.col_b', 'color'],
            ],
        );
        assert.deepEqual((cvars[1].type as { values: string[] }).values, ['sma', 'ema']);
        assert.equal(cvars[0].get(), 10);
        assert.equal(cvars[0].default, 20);
        cvars[0].set(15);
        assert.deepEqual(sets, [['fast', 15]]);
    });
});

describe('tui helpers', () => {
    it('draws fractional bars and clips colored text', () => {
        assert.equal(stripAnsi(bar(0.5, 4)), '██  ');
        assert.equal(stripAnsi(bar(0.0625, 2)), '▏ ');
        assert.equal(stripAnsi(clip('\x1b[31mhello\x1b[0m world', 7)), 'hello w');
    });

    it('finds the playhead in trades and the tick size', () => {
        const rows = [1n, 2n, 2n, 5n].map((ts) => ({ ts }));
        assert.equal(upperBound(rows, 2n), 3);
        assert.equal(upperBound(rows, 0n), 0);
        assert.equal(tickOf(null, [100, 100.25, 101]), 0.25);
        assert.equal(tickOf({ tickSize: 0.5 } as never, []), 0.5);
    });
});

describe('tools', () => {
    it('top shows render, plugins and the busiest events', async () => {
        scriptStats.set('p:0', { name: 'MA Cross', type: 'indicator', computes: 4, totalMs: 8, lastMs: 1, maxMs: 5 });
        const { frames } = await run(topCommand(fakeChart()));
        const f = frames.at(-1)!;
        assert.match(f, /top - .* ES 1m area/);
        assert.match(f, /paint 2\.00ms avg/);
        assert.match(f, /MA Cross\s+indicator/);
        assert.match(f, /price:update/);
        scriptStats.delete('p:0');
    });

    it('free prints data sizes and storage', async () => {
        const { printed } = await run(freeCommand(fakeChart({ trades: true })));
        const text = printed.join('\n');
        assert.match(text, /trades\s+400/);
        assert.match(text, /chart storage/);
    });

    it('book draws resting depth when the feed has a book', async () => {
        const { frames } = await run(bookCommand(fakeChart({ trades: true, book: true })));
        const f = frames.at(-1)!;
        assert.match(f, /bid 100\.50\s+ask 100\.75\s+spread 1 tick/);
        assert.match(f, /resting depth/);
        assert.match(f, /30\s+100\.25/);
    });

    it('book falls back to traded volume', async () => {
        const { frames } = await run(bookCommand(fakeChart({ trades: true })));
        assert.match(frames.at(-1)!, /no resting book - traded volume/);
    });

    it('tape lists trades before the playhead, newest first', async () => {
        const { frames } = await run(tapeCommand(fakeChart({ trades: true })));
        const lines = frames.at(-1)!.split('\r\n');
        assert.match(lines[0], /last minute: 60 trades/);
        assert.match(lines[2], /22:18:20\.000/); // playhead trade, T0 + 300s
        assert.match(lines[3], /22:18:19\.000/);
    });

    it('tape says so when there are no trades', async () => {
        const { frames } = await run(tapeCommand(fakeChart()));
        assert.match(frames.at(-1)!, /no individual trades/);
    });
});
