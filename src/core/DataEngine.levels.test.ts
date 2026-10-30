import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DataEngine } from './DataEngine';
import { ChartState, type ChartStateShape } from './ChartState';
import { TypedEventBus } from './TypedEventBus';
import type { IDataAdapter } from '../interfaces/IDataAdapter';
import { installInlineSliceWorker } from '../lib/inline-slice-worker';

installInlineSliceWorker();

const MIN = 60_000_000_000n;
const T0 = Date.UTC(2026, 0, 1);
const HOUR_MS = 3_600_000;

function nextLoad(bus: TypedEventBus): Promise<any> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no data:load')), 3000);
        const off = bus.on('data:load', (p) => {
            clearTimeout(timer);
            off();
            resolve(p);
        });
    });
}

describe('tick level', () => {
    it('loads and derives bars from the ticks', async () => {
        const bus = new TypedEventBus();
        const tf = { label: '1m', barNs: MIN, defaultBars: 100, isPreset: false };
        const state = new ChartState({ symbol: 'NQ', timeframe: tf } as unknown as ChartStateShape);
        const adapter = {
            resolveSymbol: async (symbol: string) => ({
                symbol,
                type: 'stock',
                dataLevel: 'tick',
                priceFormat: { minTick: 0.01, precision: 2 },
            }),
            getCapabilities: () => ({}),
            fetchBars: async (req: any) => {
                const from = Math.max(T0, Number(req.range.fromNs / 1_000_000n));
                const to = Math.min(T0 + HOUR_MS, Number(req.range.toNs / 1_000_000n));
                const ticks = [];
                for (let t = Math.ceil(from / 1000) * 1000; t < to; t += 1000) {
                    ticks.push({ time: t, price: 100 + Math.sin(t / 60_000), size: 1, side: t % 2000 ? 'B' : 'A' });
                }
                return { events: [], ticks, hasMore: false };
            },
            subscribeRealtime: () => () => {},
        } as unknown as IDataAdapter;

        const de = new DataEngine(bus, state, {
            initialLoad: { start: new Date(T0).toISOString(), end: new Date(T0 + HOUR_MS).toISOString() },
            horizon: new Date(T0 + HOUR_MS).toISOString(),
            timeframe: tf as never,
        });
        de.setAdapter(adapter);

        const loaded = nextLoad(bus);
        await de.load('NQ');
        const p = await loaded;

        assert.equal(p.dataLevel, 'tick');
        assert.equal(p.trades.length, 3600);
        assert.equal(p.bars.length, 60, 'one bar per minute');
        assert.ok(p.ingestOhlcvBuf.byteLength > 0, 'the slice worker bucketed the trades');
        de.destroy();
    });
});
