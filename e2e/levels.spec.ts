// tick and l3, historical and live
import { expect, test, type Page } from '@playwright/test';
import { drag, drawsSomething, pickTimeframe, settled, watchErrors } from './helpers';

const MIN_NS = 60_000_000_000n;

const appends = (page: Page) => page.evaluate(() => (window as any).__appends as number);

async function open(page: Page, url: string) {
    await page.addInitScript(() => {
        const w = window as any;
        w.__appends = 0;
        const hook = setInterval(() => {
            if (!w.__chart) return;
            clearInterval(hook);
            w.__chart.on('data:append', () => w.__appends++);
        }, 10);
    });
    await page.goto(url);
    await settled(page);
}

// the footprints the pane draws, or the engine holds, and what's off about them
const footprints = (page: Page, from: 'pane' | 'engine' = 'pane') =>
    page.evaluate(([min, from]) => {
        const c = (window as any).__chart;
        const bars: any[] = from === 'pane' ? c.renderEngine.drawParams.footprintBars : c.getData().footprintBars;
        let unordered = 0;
        for (let i = 1; i < bars.length; i++) if (bars[i].ts <= bars[i - 1].ts) unordered++;
        const off = bars.filter((b) => b.ts % BigInt(min) !== 0n).length;
        return { count: bars.length, unordered, off, lastMs: bars.length ? Number(bars.at(-1).ts / 1_000_000n) : 0 };
    }, [String(MIN_NS), from] as const);

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

// a series is saturated colour, the grid, axes and watermark are grey
const colouredPixels = (page: Page) =>
    page.locator('canvas').evaluateAll((els) => {
        let n = 0;
        for (const el of els) {
            const c = el as HTMLCanvasElement;
            const ctx = c.getContext('2d');
            if (!ctx || !c.width || !c.height) continue;
            const { data } = ctx.getImageData(0, 0, c.width, c.height);
            for (let i = 0; i < data.length; i += 4) {
                const r = data[i], g = data[i + 1], b = data[i + 2];
                if (data[i + 3] > 0 && Math.max(r, g, b) - Math.min(r, g, b) > 60) n++;
            }
        }
        return n;
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

for (const level of ['tick', 'l3'] as const) {
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
