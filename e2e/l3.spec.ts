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

test('l3: a footprint setting rebuilds the closed bars', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/?level=l3');
    await settled(page);
    const before = (await footprints(page)).imbalances;

    await page.evaluate(() => (window as any).__chart.setChartSettings({ footprintImbalanceRatio: 1.01 }));
    await expect.poll(async () => (await footprints(page)).imbalances).toBeGreaterThan(before);
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
