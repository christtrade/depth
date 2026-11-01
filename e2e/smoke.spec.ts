// testing a path someone might take in their first min
import { expect, test, type Page } from '@playwright/test';
import { chartBox, drag, drawsSomething, footprints, pickTimeframe, settled, watchErrors, wheel } from './helpers';

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

// the same minute at tick and l3
// adapter pages half an hour at a time
async function visitLevel(page: Page, url: string) {
    const errors = watchErrors(page);
    const firstTrade = () => page.evaluate(() => Number((window as any).__chart.getData().trades[0].ts / 1_000_000n));
    const ordered = async () => {
        for (const from of ['pane', 'engine'] as const) expect((await footprints(page, from)).unordered, from).toBe(0);
    };
    await page.goto(url);
    await settled(page);
    expect(await drawsSomething(page), 'draws the first load').toBe(true);

    await drag(page, 300);
    await drag(page, -200);
    await wheel(page, -300, 5);
    await wheel(page, 300, 5);
    await settled(page);

    // coarser, then a few pages back
    await pickTimeframe(page, '5m');
    await settled(page);
    await wheel(page, 400, 6);
    await settled(page);
    const before = await firstTrade();
    for (let i = 0; i < 6; i++) {
        await drag(page, 900, 0, 10);
        await page.waitForTimeout(150);
    }
    await settled(page);
    expect(before - (await firstTrade()), 'paged history in').toBeGreaterThan(30 * 60_000);
    await ordered();

    await pickTimeframe(page, '5s');
    await settled(page);
    await expect
        .poll(() => page.evaluate(() => String((window as any).__chart.renderEngine.drawParams.barNs)))
        .toBe('5000000000');
    expect(await drawsSomething(page), 'draws after the switch').toBe(true);

    for (let i = 0; i < 3; i++) await drag(page, -700, 0, 10);
    await settled(page);
    await pickTimeframe(page, '1m');
    await settled(page);
    await ordered();

    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await settled(page);

    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(300);
    await drag(page, 120);
    await settled(page);
    expect(await drawsSomething(page), 'draws on a phone').toBe(true);

    await ordered();
    await expect(page.locator('body')).not.toContainText('NaN');
    expect(errors).toEqual([]);
}

for (const level of ['tick', 'l3'] as const) {
    test(`a visitor at ${level}`, async ({ page }) => {
        await visitLevel(page, `/?level=${level}`);
    });

    test(`a visitor at ${level}, live with a tight budget`, async ({ page }) => {
        await visitLevel(page, `/?level=${level}&live=1&budget=3000000`);
    });
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

test('the status bar follows a wheel zoom without a mouse move', async ({ page }) => {
    await page.goto('/');
    await settled(page);
    await page.evaluate(() => {
        const w = window as any;
        w.__chart.on('status:compute', (d: any) => (w.__statusTMin = String(d.bounds.tMin)));
    });
    // the bar under the cursor changes as the left edge moves in
    const box = await chartBox(page);
    await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2);
    for (let i = 0; i < 5; i++) {
        await page.mouse.wheel(0, -200);
        await page.waitForTimeout(5);
    }
    await page.waitForTimeout(300);
    const [seen, now] = await page.evaluate(() => {
        const w = window as any;
        return [w.__statusTMin, String(w.__chart.renderEngine.view.tMin)];
    });
    expect(seen).toBe(now);
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
