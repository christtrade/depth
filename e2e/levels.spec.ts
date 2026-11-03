// tick and l3, historical and live
import { expect, test, type Page } from '@playwright/test';
import { chartBox, drag, drawsSomething, footprints, pickTimeframe, settled, watchErrors, wheel } from './helpers';

const appends = (page: Page) => page.evaluate(() => (window as any).__appends as number);
const rebuilding = (page: Page) => page.evaluate(() => (window as any).__rebuilding ?? false);

async function open(page: Page, url: string) {
    await page.addInitScript(() => {
        const w = window as any;
        w.__appends = 0;
        const hook = setInterval(() => {
            if (!w.__chart) return;
            clearInterval(hook);
            w.__chart.on('data:append', () => w.__appends++);
            w.__chart.on('heatmap:status', (s: any) => (w.__rebuilding = s.recalculating));
        }, 10);
    });
    await page.goto(url);
    await settled(page);
}

test('the public simulated adapter at l3: live, heatmap and all', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, '/?sim=1&level=l3');
    const before = await appends(page);
    await expect.poll(() => appends(page), { message: 'live chunks land', timeout: 10_000 }).toBeGreaterThan(before + 4);
    await expect.poll(() => page.evaluate(() => (window as any).__heatmaps as number)).toBeGreaterThan(0);
    expect(await drawsSomething(page)).toBe(true);
    for (const from of ['pane', 'engine'] as const) expect((await footprints(page, from)).unordered).toBe(0);
    await page.screenshot({ path: 'test-results/sim-l3.png' });
    expect(errors).toEqual([]);
});

// a slow pc: each render comes back after the next live chunk askedfor a new one
test('l3 live: the heatmap keeps drawing when renders take longer than a chunk', async ({ page }) => {
    await page.addInitScript(() => {
        const d = Object.getOwnPropertyDescriptor(Worker.prototype, 'onmessage')!;
        Object.defineProperty(Worker.prototype, 'onmessage', {
            get() {
                return d.get!.call(this);
            },
            set(fn) {
                d.set!.call(this, (e: MessageEvent) => (e.data?.bitmap ? setTimeout(() => fn(e), 600) : fn(e)));
            },
        });
    });
    await open(page, '/?sim=1&level=l3');
    const heatmaps = () => page.evaluate(() => (window as any).__heatmaps as number);
    await page.waitForTimeout(2000);
    const before = await heatmaps();
    const chunks = await appends(page);
    await page.waitForTimeout(5000);
    expect(await appends(page), 'live chunks land').toBeGreaterThan(chunks + 10);
    expect(await heatmaps(), 'heatmaps drawn').toBeGreaterThan(before + 3);
});

test('l3 live: the heatmap at the playhead stays up while each chunk rebuilds it', async ({ page }) => {
    // a slow machine, tiles land 100ms after they're asked for
    await page.addInitScript(() => {
        const d = Object.getOwnPropertyDescriptor(Worker.prototype, 'onmessage')!;
        Object.defineProperty(Worker.prototype, 'onmessage', {
            get() {
                return d.get!.call(this);
            },
            set(fn) {
                d.set!.call(this, (e: MessageEvent) => (e.data?.type === 'tile' ? setTimeout(() => fn(e), 100) : fn(e)));
            },
        });
    });
    await open(page, '/?sim=1&level=l3');
    await pickTimeframe(page, 'None');
    await page.evaluate(() => (window as any).__chart.eventBus.emit('chart:reset-view', undefined));
    await wheel(page, 400, 12);
    await page.waitForTimeout(2000);
    // tiles each base layer draw put on screen, over 4s of live
    const counts: number[] = await page.evaluate(
        () =>
            new Promise((done) => {
                const counts: number[] = [];
                let last: unknown = null;
                const until = performance.now() + 4000;
                const tick = () => {
                    const drawn = (window as any).__chart.renderEngine.drawParams.heatmap.drawn;
                    if (drawn !== last) counts.push((last = drawn).length);
                    if (performance.now() < until) requestAnimationFrame(tick);
                    else done(counts);
                };
                requestAnimationFrame(tick);
            }),
    );
    expect(counts.length, 'redrawn as chunks land').toBeGreaterThan(8);
    expect(Math.min(...counts), 'never a frame without the tile').toBeGreaterThan(0);
});

test('l3: an order placed on load is taken, not refused for having no price', async ({ page }) => {
    await open(page, '/?level=l3');
    const placed = await page.evaluate(() => {
        const c = (window as any).__chart;
        const blocked: string[] = [];
        c.on('trading:order-blocked', (e: any) => blocked.push(e.reason));
        const id = c.executionEngine.placeOrder({ side: 'long', type: 'market', qty: 1, symbol: c.getSymbol() });
        return { id: typeof id, blocked };
    });
    expect(placed).toEqual({ id: 'string', blocked: [] });
});

// l3 lines fit to the bid/ask, which a trade can poke past between samples
test('tick: the price axis fits the trades on screen', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, '/?level=tick');
    for (const chartType of ['candles', 'line']) {
        await page.evaluate((t) => (window as any).__chart.setChartSettings({ chartType: t }), chartType);
        await page.waitForTimeout(300);
        const fit = await page.evaluate(() => {
            const c = (window as any).__chart;
            const v = c.renderEngine.view;
            const prices = (c.getData().trades as any[])
                .filter((t) => t.ts >= v.tMin && t.ts < v.tMax)
                .map((t) => t.price);
            return { pMin: v.pMin, pMax: v.pMax, lo: Math.min(...prices), hi: Math.max(...prices) };
        });
        expect(fit.pMin, chartType).toBeLessThanOrEqual(fit.lo);
        expect(fit.pMax, chartType).toBeGreaterThanOrEqual(fit.hi);
        expect(fit.pMax - fit.pMin, chartType).toBeLessThan((fit.hi - fit.lo) * 3);
    }
    expect(errors).toEqual([]);
});

// a series is saturated colour, the grid, axes and watermark are grey.
// `fromRight` counts only that many css px off the right edge, the price scale
const colouredPixels = (page: Page, fromRight = 0) =>
    page.locator('canvas').evaluateAll((els, fromRight) => {
        let n = 0;
        for (const el of els) {
            const c = el as HTMLCanvasElement;
            const ctx = c.getContext('2d');
            if (!ctx || !c.width || !c.height) continue;
            const x0 = fromRight ? Math.max(0, c.width - Math.round(fromRight * devicePixelRatio)) : 0;
            const { data } = ctx.getImageData(x0, 0, c.width - x0, c.height);
            for (let i = 0; i < data.length; i += 4) {
                const r = data[i], g = data[i + 1], b = data[i + 2];
                if (data[i + 3] > 0 && Math.max(r, g, b) - Math.min(r, g, b) > 60) n++;
            }
        }
        return n;
    }, fromRight);

// every candle the chart holds against the trades up to the playhead
const candlesVsTrades = (page: Page) =>
    page.evaluate(() => {
        const c = (window as any).__chart;
        const dp = c.renderEngine.drawParams;
        const h = BigInt(c.horizon()) * 1_000_000n;
        const barNs = dp.barNs as bigint;
        const want = new Map<bigint, { high: number; low: number; close: number; volume: number }>();
        for (const t of c.getData().trades as any[]) {
            if (t.ts > h) break;
            const k = (t.ts / barNs) * barNs;
            const b = want.get(k);
            if (!b) want.set(k, { high: t.price, low: t.price, close: t.price, volume: t.size });
            else {
                b.high = Math.max(b.high, t.price);
                b.low = Math.min(b.low, t.price);
                b.close = t.price;
                b.volume += t.size;
            }
        }
        const cache: Map<bigint, any> = dp.candleCache ?? new Map();
        const wrong: string[] = [];
        for (const [k, v] of want) {
            const got = k === dp.openBar?.ts ? dp.openBar : cache.get(k);
            if (!got || got.close !== v.close || got.high !== v.high || got.low !== v.low) wrong.push(String(k));
        }
        const past = [...cache.keys()].filter((k) => k > h).length;
        const fps = new Map((dp.footprintBars as any[]).map((b) => [b.ts, b]));
        const fpWrong: string[] = [];
        for (const [k, v] of want) {
            const got = fps.get(k);
            // footprint prices snap to the tick size, volumes don't
            if (!got || got.totalVol !== v.volume) fpWrong.push(String(k));
        }
        const fpPast = [...fps.keys()].filter((k) => k > h).length;
        return { wrong, past, fpWrong, fpPast };
    });

// book only l2, the panes closed candles against the engines mid bars
const candlesVsMid = (page: Page) =>
    page.evaluate(() => {
        const c = (window as any).__chart;
        const dp = c.renderEngine.drawParams;
        const h = BigInt(c.horizon()) * 1_000_000n;
        const barNs = dp.barNs as bigint;
        const bars = c.getData().bars;
        // the engine can hold a finer source than the pane draws, 1m under 5m
        const want = new Map<bigint, { open: number; high: number; low: number; close: number }>();
        for (let i = 0; i < bars.length; i++) {
            const k = ((BigInt(bars.time[i]) * 1_000_000n) / barNs) * barNs;
            const b = want.get(k);
            if (!b) want.set(k, { open: bars.open[i], high: bars.high[i], low: bars.low[i], close: bars.close[i] });
            else {
                b.high = Math.max(b.high, bars.high[i]);
                b.low = Math.min(b.low, bars.low[i]);
                b.close = bars.close[i];
            }
        }
        const cache: Map<bigint, any> = dp.candleCache ?? new Map();
        const wrong: string[] = [];
        let checked = 0;
        const off = (a: number, b: number) => a !== b;
        for (const [k, w] of want) {
            if (k + barNs > h) continue;
            checked++;
            const got = cache.get(k);
            if (!got || off(got.open, w.open) || off(got.high, w.high) || off(got.low, w.low) || off(got.close, w.close))
                wrong.push(String(k));
        }
        const past = [...cache.keys()].filter((k) => k > h).length;
        return { checked, wrong: wrong.length, past };
    });

test('l2 without trades: the candles are the engines mid bars, at any timeframe and after a page back', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, '/?level=l2&trades=0');
    await page.evaluate(() => (window as any).__chart.setChartSettings({ chartType: 'candles', showHeatmap: false }));
    const check = async (tag: string) => {
        const r = await candlesVsMid(page);
        expect(r.checked, tag).toBeGreaterThan(5);
        expect(r.wrong, tag).toBe(0);
        expect(r.past, tag).toBe(0);
        expect(await colouredPixels(page), tag).toBeGreaterThan(500);
    };
    await check('1m');
    await drag(page, 600);
    await settled(page);
    await check('1m paged back');
    for (const tf of ['5m', '1s']) {
        await pickTimeframe(page, tf);
        await settled(page);
        await page.waitForTimeout(300);
        await check(tf);
    }
    expect(errors).toEqual([]);
});

test('l2 without trades: the candles follow the playhead both ways, and live', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, '/?level=l2&trades=0');
    await page.evaluate(() => (window as any).__chart.setChartSettings({ chartType: 'candles', showHeatmap: false }));
    const ok = async (tag: string) => {
        const r = await candlesVsMid(page);
        expect(r.checked, tag).toBeGreaterThan(5);
        expect({ wrong: r.wrong, past: r.past }, tag).toEqual({ wrong: 0, past: 0 });
    };
    await page.evaluate(() => {
        for (let i = 0; i < 20; i++) (window as any).__chart.playback.stepBack();
    });
    await settled(page);
    await ok('after a step back');
    await page.evaluate(() => {
        for (let i = 0; i < 5; i++) (window as any).__chart.playback.stepForward();
    });
    await settled(page);
    await ok('and forward');

    await open(page, '/?sim=1&level=l2&trades=0');
    await page.evaluate(() => (window as any).__chart.setChartSettings({ chartType: 'candles', showHeatmap: false }));
    const before = await appends(page);
    await expect.poll(() => appends(page), { message: 'live chunks land', timeout: 10_000 }).toBeGreaterThan(before + 4);
    await ok('live');
    expect(errors).toEqual([]);
});

test('l2 without trades: orders fill off the book the chart holds, after a page back too', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, '/?level=l2&trades=0');
    const book = () =>
        page.evaluate(() => {
            const d = (window as any).__chart.executionEngine.getDepth(5);
            return { bids: d?.bids.map((l: any) => l.price) ?? [], asks: d?.asks.map((l: any) => l.price) ?? [] };
        });
    expect((await book()).bids.length, 'the engine has the whole book, not only the best bid').toBeGreaterThan(1);

    await page.evaluate(() => {
        for (let i = 0; i < 20; i++) (window as any).__chart.playback.stepBack();
    });
    await settled(page);
    const { bids } = await book();
    expect(bids.length).toBeGreaterThan(1);

    // one level under the best bid, so it rests until the book comes down onto it
    await page.evaluate((limitPrice) => {
        const c = (window as any).__chart;
        c.executionEngine.placeOrder({ side: 'long', type: 'limit', qty: 1, limitPrice, symbol: c.getSymbol() });
    }, bids[1]);
    expect(await page.evaluate(() => (window as any).__chart.executionEngine.hasPendingTriggers())).toBe(true);
    await expect
        .poll(
            () =>
                page.evaluate(() => {
                    const c = (window as any).__chart;
                    c.playback.stepForward();
                    return c.executionEngine.hasPendingTriggers();
                }),
            { message: 'the limit fills', timeout: 20_000, intervals: [50] },
        )
        .toBe(false);
    expect(errors).toEqual([]);
});

test('tick: a step after going finer scrolls one new bar, not the old bar', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, '/?level=tick');
    await page.evaluate(() => (window as any).__chart.setChartSettings({ horizonScrollEasing: 'none' }));
    await page.evaluate(() => (window as any).__chart.setTimeframe('1m'));
    await settled(page);
    await expect
        .poll(() => page.evaluate(() => String((window as any).__chart.renderEngine.drawParams.barNs)))
        .toBe('60000000000');
    // off the data end, a 1m bar followed, then 30s into it
    await page.evaluate(() => {
        const pb = (window as any).__chart.playback;
        for (let i = 0; i < 3; i++) pb.stepBack();
        pb.stepForward();
        pb.setStepSize('1s');
        for (let i = 0; i < 30; i++) pb.stepForward();
    });
    await settled(page);
    await page.evaluate(() => (window as any).__chart.setTimeframe('1s'));
    await settled(page);
    await expect
        .poll(() => page.evaluate(() => String((window as any).__chart.renderEngine.drawParams.barNs)))
        .toBe('1000000000');
    const moved = await page.evaluate(async () => {
        const c = (window as any).__chart;
        const v = c.renderEngine.view;
        const span = (v.tMax as bigint) - (v.tMin as bigint);
        v.tMax = BigInt(c.horizon()) * 1_000_000n + span / 4n;
        v.tMin = v.tMax - span;
        const from = v.tMax as bigint;
        const h0 = c.horizon();
        c.playback.stepForward();
        await new Promise((r) => requestAnimationFrame(r));
        return { view: Number(((v.tMax as bigint) - from) / 1_000_000n), playhead: c.horizon() - h0, at: h0 % 60_000 };
    });
    expect(moved.playhead).toBeGreaterThan(0);
    expect(moved.view, JSON.stringify(moved)).toBe(moved.playhead);
    expect(errors).toEqual([]);
});

test('tick: candles follow the playhead both ways', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, '/?level=tick');
    await page.evaluate(() => {
        for (let i = 0; i < 20; i++) (window as any).__chart.playback.stepBack();
    });
    await settled(page);
    expect(await candlesVsTrades(page), 'after a step back').toEqual({ wrong: [], past: 0, fpWrong: [], fpPast: 0 });
    await page.evaluate(() => {
        for (let i = 0; i < 5; i++) (window as any).__chart.playback.stepForward();
    });
    await settled(page);
    expect(await candlesVsTrades(page), 'and forward').toEqual({ wrong: [], past: 0, fpWrong: [], fpPast: 0 });
    expect(errors).toEqual([]);
});

test('tick: a scripted indicator gets the bars', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, '/?level=tick');
    await page.evaluate(() => {
        const w = window as any;
        w.__fed = [];
        w.__chart.eventBus.tap((ev: string, p: any) => {
            if (ev === 'plugin:scripted-compute') w.__fed.push(p.ohlcv.length);
        });
        const plugin = w.__createScriptedPlugin(
            `const p = plugin({ name: "Count", type: PluginType.indicator })
            p.init = ({ data }) => ({ n: data.ohlcv.length })`,
            'count',
        );
        w.__chart.use(plugin);
        w.__chart.add('count');
    });
    await expect
        .poll(() => page.evaluate(() => Math.max(0, ...((window as any).__fed as number[]))), { timeout: 10_000 })
        .toBeGreaterThan(20);
    expect(errors).toEqual([]);
});

test('tick: the last price has its pill', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, '/?level=tick');
    expect(await colouredPixels(page, 50)).toBeGreaterThan(200);
    expect(errors).toEqual([]);
});

test('tick: line, area and baseline draw', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, '/?level=tick');
    for (const chartType of ['line', 'area', 'baseline']) {
        await page.evaluate((t) => (window as any).__chart.setChartSettings({ chartType: t }), chartType);
        await page.waitForTimeout(300);
        expect(await colouredPixels(page), chartType).toBeGreaterThan(500);
    }
    expect(errors).toEqual([]);
});

test('tick live: the step chart draws at None and 1s', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, '/?sim=1&level=tick');
    await page.evaluate(() => (window as any).__chart.setChartSettings({ chartType: 'step' }));
    for (const tf of ['None', '1s']) {
        await pickTimeframe(page, tf);
        await settled(page);
        await page.waitForTimeout(300);
        const n = await page.locator('canvas').evaluateAll((els) => {
            let n = 0;
            for (const el of els) {
                const c = el as HTMLCanvasElement;
                const ctx = c.getContext('2d');
                if (!ctx || !c.width || !c.height) continue;
                const { data } = ctx.getImageData(0, 0, c.width, c.height);
                for (let i = 0; i < data.length; i += 4) {
                    const d = Math.abs(data[i] - 0x11) + Math.abs(data[i + 1] - 0x90) + Math.abs(data[i + 2] - 0xb0);
                    if (data[i + 3] > 0 && d < 40) n++;
                }
            }
            return n;
        });
        expect(n, tf).toBeGreaterThan(200);
    }
    expect(errors).toEqual([]);
});

test('tick: footprint can be picked and draws', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, '/?level=tick');
    await page.evaluate(() => (window as any).__chart.setChartSettings({ chartType: 'candles' }));
    await page.getByRole('button', { name: 'Candles', exact: true }).click();
    await page.getByRole('button', { name: 'Footprint', exact: true }).click({ timeout: 5000 });
    await page.waitForTimeout(300);
    await expect(page.getByRole('button', { name: 'Footprint', exact: true })).toBeVisible();
    expect(await colouredPixels(page)).toBeGreaterThan(500);
    expect(errors).toEqual([]);
});

test('tick: the context menu offers orders', async ({ page }) => {
    await open(page, '/?level=tick');
    const box = (await page.locator('canvas').first().boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    await expect(page.getByText(/Buy 1\.00/).first()).toBeVisible({ timeout: 5000 });
});

test('tick: no heatmap pill, it has no heatmap', async ({ page }) => {
    await open(page, '/?level=tick');
    await drag(page, 200);
    await page.waitForTimeout(1000);
    expect(await rebuilding(page)).toBe(false);
});

for (const q of ['level=l2', 'level=l2&trades=0']) {
    test(`${q}: the bid/ask draw and the heatmap is offered`, async ({ page }) => {
        const errors = watchErrors(page);
        await open(page, `/?${q}`);
        // heatmap off, so its the lines doing the color
        await page.evaluate(() => (window as any).__chart.setChartSettings({ showHeatmap: false }));
        for (const chartType of ['line', 'area', 'baseline']) {
            await page.evaluate((t) => (window as any).__chart.setChartSettings({ chartType: t }), chartType);
            await page.waitForTimeout(300);
            expect(await colouredPixels(page), chartType).toBeGreaterThan(500);
        }
        const box = await chartBox(page);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
        await expect(page.getByText('Show Heatmap')).toBeVisible({ timeout: 5000 });
        expect(errors).toEqual([]);
    });
}

test('l2: footprint is offered with trades, not without', async ({ page }) => {
    const errors = watchErrors(page);
    for (const [q, offered] of [['level=l2', 1], ['level=l2&trades=0', 0]] as const) {
        await open(page, `/?${q}`);
        await page.evaluate(() => (window as any).__chart.setChartSettings({ chartType: 'candles' }));
        await page.getByRole('button', { name: 'Candles', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Area', exact: true }), q).toBeVisible();
        await expect(page.getByRole('button', { name: 'Footprint', exact: true }), q).toHaveCount(offered);
        if (offered) {
            await page.getByRole('button', { name: 'Footprint', exact: true }).click();
            await page.waitForTimeout(300);
            expect(await colouredPixels(page), q).toBeGreaterThan(500);
        }
    }
    expect(errors).toEqual([]);
});

async function viewOverASecond(page: Page) {
    return page.evaluate(async () => {
        const tMax = () => (window as any).__chart.renderEngine.view.tMax as bigint;
        const a = tMax();
        const t0 = performance.now();
        const seen = new Set<bigint>();
        // frames that moved more or less than the frame took
        let offClock = 0;
        let prevT = await new Promise<number>((r) => requestAnimationFrame(r));
        let prev = tMax();
        while (performance.now() - t0 < 1000) {
            const t = await new Promise<number>((r) => requestAnimationFrame(r));
            const now = tMax();
            seen.add(now);
            if (Math.abs(Number(now - prev) / 1e6 - (t - prevT)) > 2) offClock++;
            prev = now;
            prevT = t;
        }
        return {
            movedMs: Number((tMax() - a) / 1_000_000n),
            wallMs: performance.now() - t0,
            steps: seen.size,
            offClock,
        };
    });
}

async function toLiveEdge(page: Page) {
    const parked = await page.evaluate(() => {
        const c = (window as any).__chart;
        const v = c.renderEngine.view;
        const span = (v.tMax as bigint) - (v.tMin as bigint);
        v.tMax = BigInt(c.horizon()) * 1_000_000n + span / 4n;
        v.tMin = v.tMax - span;
        return String(v.tMax);
    });
    await expect.poll(() => page.evaluate(() => String((window as any).__chart.renderEngine.view.tMax))).not.toBe(parked);
}

test('tick live at 1s: the lines reach the forming bar', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, '/?sim=1&level=tick');
    await pickTimeframe(page, '1s');
    await settled(page);
    for (const t of ['step', 'line', 'area', 'baseline']) {
        await page.evaluate((t) => (window as any).__chart.setChartSettings({ chartType: t }), t);
        await toLiveEdge(page);
        await page.waitForTimeout(300);

        const r = await page.evaluate(() => {
            const re = (window as any).__chart.renderEngine;
            re.flushSync();
            const dp = re.drawParams;
            const c = re.baseCanvas as HTMLCanvasElement;
            const dpr = devicePixelRatio;
            const rect = dp.layouts[dp.panes.find((p: any) => p.isMain).id];
            const chartW = c.width / dpr - dp.priceScaleWidth;
            const img = c.getContext('2d')!.getImageData(0, Math.round(rect.y * dpr), Math.floor(chartW * dpr), Math.floor(rect.h * dpr));
            let right = -1;
            for (let i = 0; i < img.data.length; i += 4) {
                const [r, g, b, a] = [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
                // baseline's fill fades to alpha 2 on the base line, past the stroke
                if (a > 127 && Math.max(r, g, b) - Math.min(r, g, b) > 60) right = Math.max(right, ((i / 4) % img.width) / dpr);
            }
            const toX = dp.transformer.makeTsToXFn(chartW);
            const barNs = dp.barNs as bigint;
            const forming = ((dp.horizon as bigint) / barNs) * barNs;
            return { right, forming: toX(forming), prev: toX(forming - barNs), chartW };
        });
        expect(r.forming, `${t} on screen`).toBeLessThan(r.chartW - 10);
        expect(r.right, `${t} ${JSON.stringify(r)}`).toBeGreaterThan(r.forming - 2);
    }
    expect(errors).toEqual([]);
});

// every trade is a bar at the none tf
async function followsTheClock(page: Page, url: string) {
    const errors = watchErrors(page);
    await open(page, url);
    await pickTimeframe(page, 'None');
    await settled(page);
    await toLiveEdge(page);
    const s = await viewOverASecond(page);
    expect(s.steps, 'a step most frames').toBeGreaterThan(20);
    expect(s.offClock, 'each frame moves as far as the frame took').toBeLessThan(5);
    expect(s.movedMs - s.wallMs, `as far as the clock went, moved ${s.movedMs}`).toBeLessThan(150);
    expect(s.movedMs - s.wallMs).toBeGreaterThan(-150);

    const box = await chartBox(page);
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 5, y, { steps: 2 });
    const held = await viewOverASecond(page);
    await page.mouse.up();
    expect(held.movedMs).toBe(0);
    expect(errors).toEqual([]);
}

// a new bar is a minute off, so the view sits still for the whole second
test('ohlcv live at 1m: the view steps per bar, not with the clock', async ({ page }) => {
    await open(page, '/?live=1');
    await pickTimeframe(page, '1m');
    await settled(page);
    const before = await appends(page);
    await expect.poll(() => appends(page)).toBeGreaterThan(before);
    expect((await viewOverASecond(page)).movedMs).toBe(0);
});

test('historical data: the view sits still at the last bar', async ({ page }) => {
    await open(page, '/');
    await pickTimeframe(page, '1s');
    await settled(page);
    // a step lands on the last bar through the same follow code a live chunk takes
    await page.evaluate(() => {
        const pb = (window as any).__chart.playback;
        pb.stepBack();
        pb.stepForward();
    });
    // the steps own scroll
    await page.waitForTimeout(500);
    expect((await viewOverASecond(page)).movedMs).toBe(0);
});

// linux webkit draws l3 at none at ~5 fps on 2 cpus, chromium does 60 on the same box
const SLOW_FRAMES = 'linux webkit draws too few frames for a per frame check';

test('l3 live at None: a new step lands on the end of the line, not behind it', async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', SLOW_FRAMES);
    const errors = watchErrors(page);
    await open(page, '/?sim=1&level=l3');
    await pickTimeframe(page, 'None');
    await page.evaluate(() => (window as any).__chart.setChartSettings({ chartType: 'step' }));
    await settled(page);
    await toLiveEdge(page);
    // learning how late the sim is
    await page.waitForTimeout(2000);
    const s = await page.evaluate(async () => {
        const re = (window as any).__chart.renderEngine;
        // a point that came in on time lands within its frame, loaded runners have 30-40 ms ones.
        // a batch that came in already behind the end is the feed beating the lag, checked apart
        const landed: number[] = [];
        const late: string[] = [];
        const arrivedBehind = new Set<bigint>();
        let newest: bigint | null = null;
        let batches = 0;
        const batchesBehind: number[] = [];
        let lastShown: bigint | null = null;
        let prevEnd = 0n;
        let ends = 0;
        let backwards = 0;
        const t0 = performance.now();
        let prevT = t0;
        while (performance.now() - t0 < 3000) {
            const t = await new Promise<number>((r) => requestAnimationFrame(r));
            const frame = t - prevT;
            prevT = t;
            const edge = re.liveEdge;
            if (!edge) continue;
            const ph = re.paintedData().priceHistory as { ts: bigint }[];
            if (!ph.length) continue;
            if (newest !== null && ph[ph.length - 1].ts > newest) {
                batches++;
                let j = ph.length - 1;
                while (j > 0 && ph[j - 1].ts > newest) j--;
                if (ph[j].ts <= edge.to) {
                    batchesBehind.push(Math.round(Number(edge.to - ph[j].ts) / 1e6));
                    for (; j < ph.length && ph[j].ts <= edge.to; j++) arrivedBehind.add(ph[j].ts);
                }
            }
            newest = ph[ph.length - 1].ts;
            let i = ph.length - 1;
            while (i >= 0 && ph[i].ts > edge.to) i--;
            if (i < 0) continue;
            if (lastShown !== null && ph[i].ts !== lastShown) {
                const behind = Number(edge.to - ph[i].ts) / 1e6;
                landed.push(behind);
                if (!arrivedBehind.has(ph[i].ts) && behind > Math.max(25, frame + 2))
                    late.push(`${Math.round(behind)} behind, frame ${Math.round(frame)}`);
            }
            lastShown = ph[i].ts;
            if (edge.to !== prevEnd) ends++;
            if (edge.to < prevEnd) backwards++;
            prevEnd = edge.to;
        }
        return { landed, late, batches, batchesBehind, ends, backwards };
    });
    expect(s.landed.length, 'new steps came in').toBeGreaterThan(5);
    expect(s.late, 'within a frame of the end').toEqual([]);
    // a load spike lands one any distance behind. with the lag it's up to ~half of them, with none all
    expect(s.batchesBehind.length, `came in behind, ms ${s.batchesBehind} of ${s.batches} batches`).toBeLessThan(s.batches * 0.75);
    expect(s.ends, 'the end moves most frames').toBeGreaterThan(100);
    expect(s.backwards, 'the end never steps back').toBe(0);
    expect(errors).toEqual([]);
});

for (const level of ['tick', 'l3'] as const) {
    test(`${level} live at None: the view moves with the clock, every frame`, async ({ page, browserName }) => {
        test.skip(browserName === 'webkit', SLOW_FRAMES);
        await followsTheClock(page, `/?sim=1&level=${level}`);
    });

    test(`${level}: loads, draws, pans back and switches timeframe`, async ({ page }) => {
        const errors = watchErrors(page);
        await open(page, `/?level=${level}`);
        expect(await drawsSomething(page)).toBe(true);
        expect((await footprints(page)).count).toBeGreaterThan(0);

        await drag(page, 600);
        await settled(page);
        await pickTimeframe(page, '5m');
        await settled(page);

        const fp = await footprints(page);
        expect(fp.unordered).toBe(0);
        expect(errors).toEqual([]);
    });

    // a period the old one can't build, like None, never landed
    test(`${level} live: the timeframe stays put while a switch loads`, async ({ page }) => {
        const errors = watchErrors(page);
        await open(page, `/?level=${level}&live=1`);
        const seen = await page.evaluate(async () => {
            const c = (window as any).__chart;
            (window as any).__faults.slowMs = 1500;
            // more history than is loaded, so the pane waits on the fetch
            c.setTimeframe('1h');
            const seen = new Set<string>();
            for (let i = 0; i < 10; i++) {
                await new Promise((r) => setTimeout(r, 100));
                seen.add(c.getTimeframe());
            }
            return [...seen];
        });
        expect(seen).toEqual(['1h']);
        expect(errors).toEqual([]);
    });

    test(`${level} live: the view follows new bars`, async ({ page }) => {
        const errors = watchErrors(page);
        await open(page, `/?level=${level}&live=1`);
        const tMax = () => page.evaluate(() => Number((window as any).__chart.renderEngine.view.tMax / 1_000_000n));
        const before = await appends(page);
        await expect.poll(() => appends(page)).toBeGreaterThan(before + 1);
        expect((await tMax()) - Date.now(), 'the first chunks follow, not jump').toBeLessThan(10 * 60_000);
        await page.evaluate(() => {
            const c = (window as any).__chart;
            c.setChartSettings({ horizonScrollEasing: 'none' });
            c.setTimeframe('1s');
        });
        await settled(page);
        await expect
            .poll(() => page.evaluate(() => String((window as any).__chart.renderEngine.drawParams.barNs)))
            .toBe('1000000000');
        await page.evaluate(() => {
            const c = (window as any).__chart;
            const v = c.renderEngine.view;
            const span = (v.tMax as bigint) - (v.tMin as bigint);
            v.tMax = BigInt(c.horizon()) * 1_000_000n + span / 4n;
            v.tMin = v.tMax - span;
        });
        const from = await tMax();
        await expect.poll(tMax, { timeout: 10_000 }).toBeGreaterThan(from + 2000);
        expect((await tMax()) - Date.now(), 'by the bars it gained, not a jump').toBeLessThan(60_000);
        expect(errors).toEqual([]);
    });

    test(`${level} live: grows at the edge with one bar per minute`, async ({ page }) => {
        const errors = watchErrors(page);
        await open(page, `/?level=${level}&live=1`);

        const before = await appends(page);
        const heatmaps = () => page.evaluate(() => (window as any).__heatmaps as number);
        const drawn = await heatmaps();
        await expect.poll(() => appends(page), { message: 'live chunks land', timeout: 10_000 }).toBeGreaterThan(before + 4);
        if (level === 'l3') expect(await heatmaps(), 'the heatmap redraws as they do').toBeGreaterThan(drawn + 2);

        const data = await page.evaluate(() => (window as any).__chart.getData().dataEnd as number);
        expect(Date.now() - data, 'the data reaches the live edge').toBeLessThan(5_000);
        const horizon = await page.evaluate(() => (window as any).__chart.horizon() as number);
        expect(Date.now() - horizon, 'and the playhead follows it').toBeLessThan(5_000);

        for (const from of ['pane', 'engine'] as const) {
            const fp = await footprints(page, from);
            expect(fp.unordered, `${from}: no bar twice or out of order`).toBe(0);
            expect(fp.off, `${from}: every bar on a minute`).toBe(0);
            expect(Date.now() - fp.lastMs, `${from}: the forming bar is the current minute`).toBeLessThan(65_000);
        }
        expect(errors).toEqual([]);
    });
}

test('the toolbar offers what the focused cell can draw, not the last cell loaded', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/?layout=2h');
    await settled(page);
    await page.evaluate(() => {
        const w = window as any;
        w.__l3Loaded = false;
        w.__chart.on('data:load', (p: any) => {
            if (p.symbol === 'HARNESS-L3') w.__l3Loaded = true;
        });
        w.__chart.eventBus.emit('chart:set-symbol', { symbol: 'HARNESS-L3', id: 1 });
    });
    await expect.poll(() => page.evaluate(() => (window as any).__l3Loaded)).toBe(true);
    await settled(page);

    // cell 0 is still focused, on ohlcv
    await page.getByRole('button', { name: 'All timeframes' }).click();
    await expect(page.getByRole('button', { name: '1h', exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'None', exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
});
