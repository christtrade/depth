// the harness serving simulated l3
import { expect, test, type Page } from '@playwright/test';
import { drag, drawsSomething, pickTimeframe, settled, watchErrors } from './helpers';

const heatmaps = (page: Page) => page.evaluate(() => (window as any).__heatmaps as number);

const view = (page: Page) =>
    page.evaluate(() => {
        const v = (window as any).__chart.renderEngine.view;
        return { center: String((v.tMin + v.tMax) / 2n), horizon: (window as any).__chart.horizon() as number };
    });

test('l3: a timeframe switch keeps the view and the horizon', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/?level=l3');
    await settled(page);

    await page.evaluate(() => {
        for (let i = 0; i < 20; i++) (window as any).__chart.playback.stepBack();
    });
    await drag(page, 300);
    await settled(page);
    const before = await view(page);

    const replaced = page.evaluate(
        () =>
            new Promise<void>((resolve) => {
                const off = (window as any).__chart.on('data:load', (p: any) => {
                    if (!p.replaced) return;
                    off();
                    resolve();
                });
            }),
    );
    await pickTimeframe(page, '1h');
    await replaced;
    await settled(page);

    expect(await view(page)).toEqual(before);
    expect(errors).toEqual([]);
});

const footprints = (page: Page) =>
    page.evaluate(() => {
        const bars: any[] = (window as any).__chart.renderEngine.drawParams.footprintBars;
        const horizonNs = BigInt((window as any).__chart.horizon()) * 1_000_000n;
        return {
            pastHorizon: bars.filter((b) => b.ts > horizonNs).length,
            lastIsOpen: bars.length > 0 && horizonNs - bars[bars.length - 1].ts < 60_000_000_000n,
            imbalances: bars.reduce(
                (n, b) => n + b.levels.filter((l: any) => l.askImbalance || l.bidImbalance).length,
                0,
            ),
        };
    });

test('l3: after a step back the footprints stop at the playhead', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/?level=l3');
    await settled(page);
    await page.evaluate(() => {
        for (let i = 0; i < 20; i++) (window as any).__chart.playback.stepBack();
    });
    await settled(page);

    const fp = await footprints(page);
    expect(fp.pastHorizon).toBe(0);
    expect(fp.lastIsOpen).toBe(true);
    expect(errors).toEqual([]);
});

test('l3: a page back in a replay keeps the footprints at the playhead', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/?level=l3');
    await settled(page);
    await page.evaluate(() => {
        const w = window as any;
        w.__prepends = 0;
        w.__chart.on('data:prepend', () => w.__prepends++);
        for (let i = 0; i < 20; i++) w.__chart.playback.stepBack();
    });
    await settled(page);

    const prepends = () => page.evaluate(() => (window as any).__prepends as number);
    for (let i = 0; i < 15 && (await prepends()) === 0; i++) await drag(page, 600);
    await expect.poll(prepends, { message: 'a page back landed' }).toBeGreaterThan(0);
    await settled(page);

    expect((await footprints(page)).pastHorizon).toBe(0);
    expect(errors).toEqual([]);
});

test('l3: stepping on after a page back keeps the bid/ask history in order', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/?level=l3');
    await settled(page);
    await page.evaluate(() => {
        const w = window as any;
        w.__prepends = 0;
        w.__chart.on('data:prepend', () => w.__prepends++);
        for (let i = 0; i < 20; i++) w.__chart.playback.stepBack();
    });
    await settled(page);

    const prepends = () => page.evaluate(() => (window as any).__prepends as number);
    for (let i = 0; i < 15 && (await prepends()) === 0; i++) await drag(page, 600);
    await expect.poll(prepends, { message: 'a page back landed' }).toBeGreaterThan(0);
    await settled(page);
    await page.evaluate(() => {
        for (let i = 0; i < 5; i++) (window as any).__chart.playback.stepForward();
    });
    await settled(page);

    const ph = await page.evaluate(() => {
        const w = window as any;
        const h: { ts: bigint }[] = w.__chart.renderEngine.drawParams.priceHistory;
        const horizonNs = BigInt(w.__chart.horizon()) * 1_000_000n;
        let backwards = 0;
        for (let i = 1; i < h.length; i++) if (h[i].ts <= h[i - 1].ts) backwards++;
        return { n: h.length, backwards, pastHorizon: h.filter((p) => p.ts > horizonNs).length };
    });
    expect(ph.n).toBeGreaterThan(0);
    expect(ph).toEqual({ n: ph.n, backwards: 0, pastHorizon: 0 });
    expect(errors).toEqual([]);
});

test('l3: a footprint setting rebuilds the closed bars', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/?level=l3');
    await settled(page);
    const before = (await footprints(page)).imbalances;

    await page.evaluate(() => (window as any).__chart.setChartSettings({ footprintImbalanceRatio: 1.01 }));
    await expect.poll(async () => (await footprints(page)).imbalances).toBeGreaterThan(before);
    expect(errors).toEqual([]);
});

test('l3: raising the heatmap contrast hides the thin levels', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/?level=l3');
    await settled(page);
    await expect.poll(() => heatmaps(page), { timeout: 15_000 }).toBeGreaterThan(0);

    // pixels the heatmap bitmap actually covers
    const lit = () =>
        page.evaluate(() => {
            const bm: ImageBitmap | null = (window as any).__chart.renderEngine.drawParams.heatmapBitmap;
            if (!bm) return 0;
            const c = new OffscreenCanvas(bm.width, bm.height);
            const ctx = c.getContext('2d')!;
            ctx.drawImage(bm, 0, 0);
            const d = ctx.getImageData(0, 0, bm.width, bm.height).data;
            let n = 0;
            for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
            return n;
        });
    const before = await lit();
    expect(before).toBeGreaterThan(0);

    await page.evaluate(() => (window as any).__chart.setChartSettings({ heatmapContrast: 0.8 }));
    await expect.poll(lit, { message: 'fewer pixels lit' }).toBeLessThan(before);
    expect(await lit()).toBeGreaterThan(0);
    expect(errors).toEqual([]);
});

test('l3: the heatmap draws, and draws again after a pan', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/?level=l3');
    await settled(page);

    await expect.poll(() => heatmaps(page), { message: 'a heatmap bitmap came back', timeout: 15_000 }).toBeGreaterThan(0);
    expect(await drawsSomething(page)).toBe(true);

    const before = await heatmaps(page);
    await drag(page, 300);
    await expect.poll(() => heatmaps(page), { message: 'and another after the pan' }).toBeGreaterThan(before);
    expect(errors).toEqual([]);
});

test('l3: picking a timeframe that needs new data switches to it, and stays', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/?level=l3');
    await settled(page);
    const tf = () => page.evaluate(() => (window as any).__chart.getTimeframe() as string);

    await page.getByRole('button', { name: '1h', exact: true }).first().click();
    await settled(page);
    await page.waitForTimeout(1000);
    expect(await tf(), 'the toolbar sync puts it back to 1m when the pane never switched').toBe('1h');
    expect(errors).toEqual([]);
});
