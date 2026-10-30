import { expect, type Page } from '@playwright/test';

// everything the page throws or logs as an error collected for the test to assert empty
export function watchErrors(page: Page): string[] {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`throw: ${err.message}`));
    page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
    });
    return errors;
}

// bars in the store and nothing loading
export async function settled(page: Page, timeout = 20_000): Promise<void> {
    await page.waitForFunction(
        () => {
            const w = window as any;
            const last = w.__status[w.__status.length - 1];
            return w.__chart?.getData().bars.length > 0 && last !== 'loading';
        },
        undefined,
        { timeout },
    );
    // a frame or two for the redraw
    await page.waitForTimeout(200);
}

// the charts drawing area, the biggest canvas on the page
export async function chartBox(page: Page) {
    const boxes = await page.locator('canvas').evaluateAll((els) =>
        els.map((el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
        }),
    );
    const box = boxes.sort((a, b) => b.width * b.height - a.width * a.height)[0];
    expect(box, 'a chart canvas').toBeTruthy();
    return box;
}

// a natural drag of press, move in steps, let go
// positive dx pans back in time
export async function drag(page: Page, dx: number, dy = 0, steps = 20): Promise<void> {
    const box = await chartBox(page);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps });
    await page.mouse.up();
}

export async function wheel(page: Page, dy: number, times = 1): Promise<void> {
    const box = await chartBox(page);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < times; i++) {
        await page.mouse.wheel(0, dy);
        await page.waitForTimeout(16);
    }
}

// pick a tf naturally using the pinned pill or the full list
export async function pickTimeframe(page: Page, label: string): Promise<void> {
    const pill = page.getByRole('button', { name: label, exact: true });
    if (await pill.first().isVisible()) {
        await pill.first().click();
    } else {
        await page.getByRole('button', { name: 'All timeframes' }).click();
        // the chips in the full list are divs, not buttons
        await page.getByText(label, { exact: true }).first().click();
    }
    await expect.poll(() => page.evaluate(() => (window as any).__chart.getTimeframe())).toBe(label);
}

// something on the chart besides the bg
export async function drawsSomething(page: Page): Promise<boolean> {
    return page.locator('canvas').evaluateAll((els) =>
        els.some((el) => {
            const c = el as HTMLCanvasElement;
            const ctx = c.getContext('2d');
            if (!ctx || !c.width || !c.height) return false;
            const { data } = ctx.getImageData(0, 0, c.width, c.height);
            const seen = new Set<number>();
            for (let i = 0; i < data.length; i += 4 * 97) {
                seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
                if (seen.size > 4) return true;
            }
            return false;
        }),
    );
}
