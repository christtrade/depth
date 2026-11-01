// tick and l3, historical and live
import { expect, test, type Page } from '@playwright/test';
import { chartBox, drag, drawsSomething, footprints, pickTimeframe, settled, watchErrors } from './helpers';

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

test('l3 live at None: a new step lands on the end of the line, not behind it', async ({ page }) => {
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
        // ms from a newly shown point to the end, the frame it shows
        const landed: number[] = [];
        let lastShown: bigint | null = null;
        let prevEnd = 0n;
        let ends = 0;
        let backwards = 0;
        const t0 = performance.now();
        while (performance.now() - t0 < 3000) {
            await new Promise((r) => requestAnimationFrame(r));
            const edge = re.liveEdge;
            if (!edge) continue;
            const ph = re.paintedData().priceHistory as { ts: bigint }[];
            let i = ph.length - 1;
            while (i >= 0 && ph[i].ts > edge.to) i--;
            if (i < 0) continue;
            if (lastShown !== null && ph[i].ts !== lastShown) landed.push(Number(edge.to - ph[i].ts) / 1e6);
            lastShown = ph[i].ts;
            if (edge.to !== prevEnd) ends++;
            if (edge.to < prevEnd) backwards++;
            prevEnd = edge.to;
        }
        return { landed, ends, backwards };
    });
    expect(s.landed.length, 'new steps came in').toBeGreaterThan(5);
    expect(Math.max(...s.landed), `within a frame of the end, ${s.landed.map(Math.round)}`).toBeLessThan(25);
    expect(s.ends, 'the end moves most frames').toBeGreaterThan(100);
    expect(s.backwards, 'the end never steps back').toBe(0);
    expect(errors).toEqual([]);
});

for (const level of ['tick', 'l3'] as const) {
    test(`${level} live at None: the view moves with the clock, every frame`, async ({ page }) => {
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
