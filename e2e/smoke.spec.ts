// testing a path someone might take in their first min
import { expect, test, type Page } from '@playwright/test';
import { chartBox, drag, drawsSomething, pickTimeframe, settled, watchErrors, wheel } from './helpers';

const DAY_MS = 86_400_000;
const firstBar = (page: Page) => page.evaluate(() => (window as any).__chart.getData().bars.time[0] as number);

async function visit(page: Page, url: string) {
    const errors = watchErrors(page);
    await page.goto(url);
    await settled(page);
    expect(await drawsSomething(page), 'draws the first load').toBe(true);

    // look around
    await drag(page, 300);
    await drag(page, -200);
    await wheel(page, -300, 5);
    await wheel(page, 300, 5);
    await settled(page);

    // coarser, then pan back a long way
    await pickTimeframe(page, '1h');
    await settled(page);
    // the switch keeps the span on screen, a dozen hourly bars. zoom out naturally
    await wheel(page, 400, 12);
    await settled(page);
    const before = await firstBar(page);
    for (let i = 0; i < 8; i++) {
        await drag(page, 900, 0, 10);
        await page.waitForTimeout(100);
    }
    await settled(page);
    expect(before - (await firstBar(page)), 'paged history in').toBeGreaterThan(7 * DAY_MS);

    // way finer, right where we are
    await pickTimeframe(page, '1s');
    await settled(page, 40_000);
    expect(await page.evaluate(() => Number((window as any).__chart.getData().barNs))).toBe(1e9);
    if (url.includes('budget')) {
        const end = await page.evaluate(() => (window as any).__chart.getData().bars.time.at(-1) as number);
        expect(end, 'loaded at the view, a hole up to now').toBeLessThan(Date.now() - DAY_MS);
        expect(await page.evaluate(() => (window as any).__chart.isRealtime()), 'still live').toBe(true);
    }
    expect(await drawsSomething(page), 'draws after the switch').toBe(true);

    // back towards now
    for (let i = 0; i < 3; i++) await drag(page, -700, 0, 10);
    await settled(page);

    await pickTimeframe(page, '1m');
    await settled(page);

    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await settled(page);

    // a phone
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(300);
    await chartBox(page);
    await drag(page, 120);
    await settled(page);
    expect(await drawsSomething(page), 'draws on a phone').toBe(true);

    await expect(page.locator('body')).not.toContainText('NaN');
    expect(errors).toEqual([]);
}

test("depth's toasts show up, once", async ({ page }) => {
    await page.goto('/');
    await settled(page);
    await page.evaluate(() => {
        (window as any).__chart.eventBus.emit('error', { message: 'something broke' });
    });
    await expect(page.getByText('something broke')).toHaveCount(1);
    await expect(page.getByText('something broke')).toBeVisible();
});

for (const theme of ['dark', 'light', 'gruvboxlight']) {
    test(`toasts take the ${theme} theme's colours, not plain black or white`, async ({ page }) => {
        await page.goto('/');
        await settled(page);
        await page.evaluate((id) => {
            const chart = (window as any).__chart;
            chart.setTheme(id);
            chart.eventBus.emit('error', { message: `themed ${id}` });
        }, theme);
        const toast = page.locator('[data-sonner-toast]', { hasText: `themed ${theme}` });
        await expect(toast).toBeVisible();

        const [got, want] = await toast.evaluate((el) => {
            const probe = document.createElement('div');
            probe.style.background = 'hsl(var(--popover))';
            document.querySelector('.depth-root')!.appendChild(probe);
            const want = getComputedStyle(probe).backgroundColor;
            probe.remove();
            return [getComputedStyle(el).backgroundColor, want];
        });
        expect(got).toBe(want);
    });
}

test('picks a timeframe from the full list with the keyboard', async ({ page }) => {
    await page.goto('/');
    await settled(page);
    await page.getByRole('button', { name: 'All timeframes' }).click();
    await page.getByRole('button', { name: '30s', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => (window as any).__chart.getTimeframe())).toBe('30s');
});

test('a visitor on historical data', async ({ page }) => {
    await visit(page, '/');
});

test('a visitor on a live feed', async ({ page }) => {
    await visit(page, '/?live=1');
});

// small enough that the 1s switch leaves a hole up to the live edge and pans evict
test('a visitor on a live feed with a tight budget', async ({ page }) => {
    await visit(page, '/?live=1&budget=4000000');
});
