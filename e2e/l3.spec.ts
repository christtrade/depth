// the harness serving simulated l3
import { expect, test, type Page } from '@playwright/test';
import { drag, drawsSomething, settled, watchErrors } from './helpers';

const heatmaps = (page: Page) => page.evaluate(() => (window as any).__heatmaps as number);

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
