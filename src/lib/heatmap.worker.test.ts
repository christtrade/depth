import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { appendEvents, BYTES_PER_EVENT, createCompactBuffer } from './compact-buffer';
import { isoToNs } from './sampler';
import type { MboEvent } from './types';
import type { HeatmapReply } from './types/heatmap-types';

const replies: HeatmapReply[] = [];
const worker: any = { postMessage: (r: HeatmapReply) => replies.push(r) };
(globalThis as any).self = worker;

const SEC = 1_000_000_000n;
const ev = (s: number, action: string, side: string, price: number, size: number, id: number): MboEvent => ({
    ts_event: new Date(s * 1000).toISOString(),
    action: action as MboEvent['action'],
    side: side as MboEvent['side'],
    price,
    size,
    order_id: String(id),
    sequence: 0,
    flags: 0,
});
// 100 lots either side for a minute, then 1 lots for a minute
const events = [
    ev(0, 'A', 'B', 99.9, 100, 1),
    ev(0, 'A', 'A', 100.1, 100, 2),
    ev(60, 'C', 'B', 99.9, 100, 1),
    ev(60, 'C', 'A', 100.1, 100, 2),
    ev(60, 'A', 'B', 99.9, 1, 3),
    ev(60, 'A', 'A', 100.1, 1, 4),
    ev(120, 'A', 'B', 99.8, 1, 5),
];
const cfg = { column: 0, tickSize: 0.01, ticks: 1, contrast: 0, palette: 'heat' };
const send = (msg: unknown) => worker.onmessage({ data: msg });
const until = async (ok: () => boolean) => {
    for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
};

describe('the heatmap worker once a view settles', () => {
    it('switches brightness to a quiet view and says so, once', async () => {
        await import('./heatmap.worker');
        const cb = createCompactBuffer();
        appendEvents(cb, events, isoToNs);
        send({ type: 'init', buf: cb._buf.slice(0, cb.length * BYTES_PER_EVENT), length: cb.length });
        await until(() => replies.some((r) => r.type === 'data'));

        const quiet = { type: 'settle', from: (60n * SEC).toString(), to: (120n * SEC).toString(), ...cfg };
        send(quiet);
        assert.deepEqual(
            replies.filter((r) => r.type === 'norm'),
            [{ type: 'norm', normKey: '0:0.01:1' }],
        );
        send(quiet);
        assert.equal(replies.filter((r) => r.type === 'norm').length, 1, 'the same view again changes nothing');
    });
});
