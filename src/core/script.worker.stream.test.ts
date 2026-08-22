import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';

const MINUTE_NS = 60_000_000_000n;

interface FakeSelf {
    onmessage: ((e: { data: unknown }) => void) | null;
    postMessage(msg: unknown, transfer?: unknown[]): void;
    close(): void;
}

const posted: any[] = [];
let fakeSelf: FakeSelf;

function bars(closes: number[], startIndex = 0) {
    return closes.map((close, i) => ({
        ts: BigInt(startIndex + i) * MINUTE_NS,
        open: close,
        high: close + 1,
        low: close - 1,
        close,
        volume: 1,
    }));
}

async function send(msg: unknown, expect: string) {
    posted.length = 0;
    fakeSelf.onmessage!({ data: msg });
    const deadline = Date.now() + 5000;
    while (!posted.some((m) => m.type === expect)) {
        if (Date.now() > deadline) {
            throw new Error(
                `no '${expect}' after 5s, got ${JSON.stringify(posted.map((m) => m.type))}`,
            );
        }
        await new Promise((r) => setTimeout(r, 1));
    }
    return posted.find((m) => m.type === expect);
}

const parse = (script: string) => send({ type: 'parse', script }, 'parsed');

before(async () => {
    fakeSelf = {
        onmessage: null,
        postMessage: (msg: unknown) => posted.push(msg),
        close: () => {},
    };
    (globalThis as any).self = fakeSelf;
    await import('./script.worker');
});

// buys once near the start and holds, so the result depends on bars from more
// than one chunk having reached the same engine
const BUY_AND_HOLD = `
const s = plugin({ name: "Buy and hold", type: PluginType.strategy })
s.init = () => ({ seen: 0, firstTs: null, lastTs: null })
s.update = ({ index, bar, state, broker }) => {
    if (state.firstTs === null) state.firstTs = String(bar.ts)
    state.lastTs = String(bar.ts)
    state.seen++
    if (index === 0) broker.buy(1)
    return state
}
`;

/** The whole series, as one run and as `n` streamed chunks. */
const CLOSES = Array.from({ length: 600 }, (_, i) => 100 + Math.sin(i / 31) * 10);

async function runStreamed(chunkSize: number) {
    await parse(BUY_AND_HOLD);

    posted.length = 0;
    fakeSelf.onmessage!({
        data: {
            type: 'strategy-begin',
            pluginIndex: 0,
            params: {},
            barNs: MINUTE_NS,
            symbolInfo: null,
        },
    });

    for (let i = 0; i < CLOSES.length; i += chunkSize) {
        const slice = CLOSES.slice(i, i + chunkSize);
        await send(
            { type: 'strategy-chunk', pluginIndex: 0, bars: bars(slice, i) },
            'strategy-chunk-done',
        );
    }

    return send({ type: 'strategy-end', pluginIndex: 0 }, 'update');
}

async function runWhole() {
    await parse(BUY_AND_HOLD);
    return send(
        {
            type: 'run-init',
            pluginIndex: 0,
            data: { ohlcv: bars(CLOSES), trades: [] },
            barNs: MINUTE_NS,
            params: {},
        },
        'update',
    );
}

describe('streamed strategy runs', () => {
    it('scores a chunked run identically to the same bars in one go', async () => {
        const whole = await runWhole();
        const streamed = await runStreamed(97); // deliberately not a divisor of 600

        // the property that matters: how the data was delivered must not change
        // what the strategy is worth
        assert.deepEqual(streamed.state.stats, whole.state.stats);
        assert.equal(streamed.state.trades.length, whole.state.trades.length);
        assert.deepEqual(streamed.state.trades[0], whole.state.trades[0]);
    });

    it('is unaffected by where the chunk boundaries fall', async () => {
        const a = await runStreamed(50);
        const b = await runStreamed(313);
        const c = await runStreamed(CLOSES.length);

        assert.deepEqual(a.state.stats, b.state.stats);
        assert.deepEqual(b.state.stats, c.state.stats);
    });

    it('gives the script one continuous bar index across chunks', async () => {
        const r = await runStreamed(70);

        assert.equal(r.state.user.seen, CLOSES.length);
        assert.equal(r.state.user.firstTs, String(0n));
        assert.equal(r.state.user.lastTs, String(BigInt(CLOSES.length - 1) * MINUTE_NS));
    });

    it('reports the span it covered', async () => {
        const r = await runStreamed(120);

        assert.equal(r.state.range.bars, CLOSES.length);
        assert.equal(r.state.range.fromNs, 0n);
        assert.equal(r.state.range.toNs, BigInt(CLOSES.length - 1) * MINUTE_NS);
    });

    it('acknowledges each chunk so the driver never runs ahead of the engine', async () => {
        await parse(BUY_AND_HOLD);
        fakeSelf.onmessage!({
            data: {
                type: 'strategy-begin',
                pluginIndex: 0,
                params: {},
                barNs: MINUTE_NS,
                symbolInfo: null,
            },
        });

        const first = await send(
            { type: 'strategy-chunk', pluginIndex: 0, bars: bars(CLOSES.slice(0, 100)) },
            'strategy-chunk-done',
        );
        assert.equal(first.bars, 100);

        const second = await send(
            { type: 'strategy-chunk', pluginIndex: 0, bars: bars(CLOSES.slice(100, 250), 100) },
            'strategy-chunk-done',
        );
        // cumulative, so the driver can show progress without counting itself
        assert.equal(second.bars, 250);
    });

    it('tolerates an empty chunk from a gap in the data', async () => {
        await parse(BUY_AND_HOLD);
        fakeSelf.onmessage!({
            data: {
                type: 'strategy-begin',
                pluginIndex: 0,
                params: {},
                barNs: MINUTE_NS,
                symbolInfo: null,
            },
        });

        await send({ type: 'strategy-chunk', pluginIndex: 0, bars: bars(CLOSES.slice(0, 100)) }, 'strategy-chunk-done');
        const empty = await send({ type: 'strategy-chunk', pluginIndex: 0, bars: [] }, 'strategy-chunk-done');
        assert.equal(empty.bars, 100, 'an empty chunk must not advance the count');

        const r = await send({ type: 'strategy-end', pluginIndex: 0 }, 'update');
        assert.equal(r.state.range.bars, 100);
    });

    it('refuses a stream that produced no bars at all', async () => {
        await parse(BUY_AND_HOLD);
        fakeSelf.onmessage!({
            data: {
                type: 'strategy-begin',
                pluginIndex: 0,
                params: {},
                barNs: MINUTE_NS,
                symbolInfo: null,
            },
        });

        const rejected = await send({ type: 'strategy-end', pluginIndex: 0 }, 'strategy-rejected');
        assert.match(rejected.reason, /No bars were returned/);
    });

    it('drops the session on cancel, so late chunks cannot reach it', async () => {
        await parse(BUY_AND_HOLD);
        fakeSelf.onmessage!({
            data: {
                type: 'strategy-begin',
                pluginIndex: 0,
                params: {},
                barNs: MINUTE_NS,
                symbolInfo: null,
            },
        });
        await send({ type: 'strategy-chunk', pluginIndex: 0, bars: bars(CLOSES.slice(0, 50)) }, 'strategy-chunk-done');

        fakeSelf.onmessage!({ data: { type: 'strategy-cancel', pluginIndex: 0 } });

        // a chunk arriving after the cancel is ignored rather than starting a
        // new session or feeding the old one
        posted.length = 0;
        fakeSelf.onmessage!({
            data: { type: 'strategy-chunk', pluginIndex: 0, bars: bars(CLOSES.slice(50, 100), 50) },
        });
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(posted.length, 0, `expected silence, got ${JSON.stringify(posted)}`);
    });
});
