// what u see when the data source doesnt behave
import { expect, test, type Page } from '@playwright/test';
import { drag, drawsSomething, pickTimeframe, settled, watchErrors, wheel } from './helpers';

// the chart logs fetch failures on purpose here. only a throw nobody caught is a bug
const thrown = (errors: string[]) => errors.filter((e) => e.startsWith('throw:'));

const faults = (page: Page, f: Record<string, unknown>) =>
    page.evaluate((f) => {
        Object.assign((window as any).__faults, f);
    }, f);

// the biggest jump between neighbouring bars in bar periods. 1 means no holes
const widestGap = (page: Page) =>
    page.evaluate(() => {
        const d = (window as any).__chart.getData();
        const t = d.bars.time;
        const period = Number(d.barNs / 1_000_000n);
        let widest = 0;
        for (let i = 1; i < t.length; i++) widest = Math.max(widest, (t[i] - t[i - 1]) / period);
        return widest;
    });

// the full screen error, as opposed to a toast saying the same thing
const overlay = (page: Page) => page.getByRole('button', { name: 'Try again' });

test('down from the start: says why, and Try again recovers', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/?down=1');
    await expect(page.getByText("Can't reach the data source")).toBeVisible();

    await faults(page, { down: false });
    await page.getByRole('button', { name: 'Try again' }).click();
    await settled(page);
    await expect(overlay(page)).toHaveCount(0);
    expect(await drawsSomething(page)).toBe(true);
    expect(thrown(errors)).toEqual([]);
});

test('rate limited says so', async ({ page }) => {
    await page.goto('/?down=1&code=rate_limited');
    await expect(page.getByText('Rate limited')).toBeVisible();
});

test('a failed page mid-session leaves the chart up', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/');
    await settled(page);
    await pickTimeframe(page, '1h');
    await settled(page);
    await wheel(page, 400, 12);
    await settled(page);

    const failedPages: string[] = [];
    page.on('console', (m) => m.text().includes('backward fetch failed') && failedPages.push(m.text()));
    await faults(page, { down: true });
    for (let i = 0; i < 12; i++) await drag(page, 900, 0, 10);
    await page.waitForTimeout(500);
    expect(failedPages.length, 'a page into history actually failed').toBeGreaterThan(0);
    await expect(overlay(page), 'a failed page is no reason to hide the chart').toHaveCount(0);
    expect(await drawsSomething(page)).toBe(true);

    // the source comes back. panning further pages in what failed, without a hole
    const firstBefore = await page.evaluate(() => (window as any).__chart.getData().bars.time[0] as number);
    await faults(page, { down: false });
    for (let i = 0; i < 12; i++) await drag(page, 900, 0, 10);
    await settled(page);
    const firstAfter = await page.evaluate(() => (window as any).__chart.getData().bars.time[0] as number);
    expect(firstAfter, 'paged in history once the source was back').toBeLessThan(firstBefore);
    expect(await widestGap(page), 'no hole where the page failed').toBeLessThanOrEqual(1);
    expect(thrown(errors)).toEqual([]);
});

test('a timeframe switch that fails keeps the bars on screen', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/');
    await settled(page);

    await faults(page, { down: true });
    await pickTimeframe(page, '1s').catch(() => {});
    await expect(page.getByText("Can't reach the data source"), 'says so, once').toHaveCount(1);
    await expect(overlay(page)).toHaveCount(0);
    expect(await drawsSomething(page)).toBe(true);
    expect(thrown(errors)).toEqual([]);
});

test('a slow source and an impatient visitor', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/?slow=1500');
    await settled(page, 30_000);

    // three switches and some panning before the first one lands
    await page.getByRole('button', { name: '1h', exact: true }).click();
    await drag(page, 400);
    await page.getByRole('button', { name: '5m', exact: true }).click();
    await wheel(page, 300, 4);
    await page.getByRole('button', { name: '15m', exact: true }).click();

    await settled(page, 60_000);
    await page.waitForTimeout(2500);
    expect(await page.evaluate(() => (window as any).__chart.getTimeframe())).toBe('15m');
    await expect(page.getByText('Loading data'), 'the spinner went away').toHaveCount(0);
    expect(await drawsSomething(page)).toBe(true);
    expect(errors).toEqual([]);
});
