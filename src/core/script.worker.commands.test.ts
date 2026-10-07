import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';

const posted: any[] = [];
let onmessage: (e: { data: unknown }) => void;

async function send(msg: unknown, expect: string) {
    posted.length = 0;
    onmessage({ data: msg });
    const deadline = Date.now() + 5000;
    while (!posted.some((m) => m.type === expect)) {
        if (Date.now() > deadline) throw new Error(`no '${expect}', got ${JSON.stringify(posted.map((m) => m.type))}`);
        await new Promise((r) => setTimeout(r, 1));
    }
    return posted.find((m) => m.type === expect);
}

before(async () => {
    const fakeSelf: any = { postMessage: (m: unknown) => posted.push(m), close() {} };
    (globalThis as any).self = fakeSelf;
    await import('./script.worker');
    onmessage = fakeSelf.onmessage;
});

const SCRIPT = `
const p = plugin({
    name: 'MA Cross',
    type: PluginType.indicator,
    params: { fast: { label: 'Fast', type: 'number', default: 10 } },
    commands: {
        hello: { help: 'say hi', args: { who: 'string' }, run: ({ args, print }) => print('hi', args.who) },
    },
})
p.init = ({ params }) => ({ fast: params.fast, hits: 0 })
p.command('poke', {
    args: { n: 'number', side: ['buy', 'sell'] },
    run: ({ args, params, state, recompute }) => {
        state.hits += args.n
        recompute()
        return { side: args.side, fast: params.fast, hits: state.hits }
    },
})
p.command('boom', () => { throw new Error('nope') })
`;

describe('script commands', () => {
    it('lists commands off the decl, without the functions', async () => {
        const parsed = await send({ type: 'parse', script: SCRIPT }, 'parsed');
        const plugin = parsed.plugins[0];
        assert.equal(plugin.decl.commands, undefined);
        assert.deepEqual(
            plugin.commands.map((c: any) => c.name),
            ['hello', 'poke', 'boom'],
        );
        assert.deepEqual(plugin.commands[1].args, { n: 'number', side: ['buy', 'sell'] });
        assert.equal(plugin.commands[0].help, 'say hi');
    });

    it('runs a command with the last params and the live state', async () => {
        await send({ type: 'run-init', pluginIndex: 0, data: { ohlcv: [], trades: [] }, barNs: 1n, params: { fast: 7 } }, 'update');
        const res = await send({ type: 'command', pluginIndex: 0, name: 'poke', args: { n: 2, side: 'buy' }, reqId: 1 }, 'command-result');
        assert.equal(res.reqId, 1);
        assert.equal(res.recompute, true);
        assert.deepEqual(res.value, { side: 'buy', fast: 7, hits: 2 });
    });

    it('collects prints and reports throws', async () => {
        const hi = await send({ type: 'command', pluginIndex: 0, name: 'hello', args: { who: 'there' }, reqId: 2 }, 'command-result');
        assert.deepEqual(hi.lines, ['hi there']);
        const boom = await send({ type: 'command', pluginIndex: 0, name: 'boom', args: {}, reqId: 3 }, 'command-result');
        assert.equal(boom.error, 'nope');
        const missing = await send({ type: 'command', pluginIndex: 0, name: 'nah', args: {}, reqId: 4 }, 'command-result');
        assert.match(missing.error, /no command "nah"/);
    });
});
