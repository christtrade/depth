// the harness serving simulated l3
import { expect, test, type Page } from '@playwright/test';
import { drag, drawsSomething, pickTimeframe, settled, watchErrors, wheel } from './helpers';

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

test('l3: None opens on half a minute', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/?sim=1&level=l3');
    await settled(page);
    await page.evaluate(() => (window as any).__chart.setTimeframe('None'));
    // the switch takes over 5 s in webkit on a slow runner
    await expect.poll(() => page.evaluate(() => (window as any).__chart.getTimeframe()), { timeout: 20_000 }).toBe('None');
    // getTimeframe already says None while the switch is landing
    const spanMs = () =>
        page.evaluate(() => {
            const v = (window as any).__chart.renderEngine.view;
            return Number(v.tMax - v.tMin) / 1e6;
        });
    await expect.poll(spanMs).toBe(30_000);
    expect(errors).toEqual([]);
});

test('l3 live: switching to None keeps the horizon on screen', async ({ page }) => {
    await page.goto('/?sim=1&level=l3');
    await settled(page);
    await page.evaluate(() => (window as any).__chart.setTimeframe('None'));
    const spot = () =>
        page.evaluate(() => {
            const c = (window as any).__chart;
            const v = c.renderEngine.view;
            return {
                span: Number(v.tMax - v.tMin) / 1e6,
                at: Number(BigInt(c.horizon()) * 1_000_000n - v.tMin) / Number(v.tMax - v.tMin),
            };
        });
    await expect.poll(async () => (await spot()).span, { timeout: 20_000 }).toBe(30_000);
    const { at } = await spot();
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(1);
});

test('l3: None zoomed in draws its bid and ask from the replay', async ({ page }) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 1400, height: 800 });
    await page.goto('/?sim=1&level=l3');
    await settled(page);
    await page.evaluate(() => (window as any).__chart.setTimeframe('None'));
    const fine = () =>
        page.evaluate(() => {
            const p = (window as any).__chart.renderEngine.drawParams;
            const v = (window as any).__chart.renderEngine.view;
            const inView = (a: any[]) =>
                a.filter((x) => x.ts >= v.tMin && x.ts < p.heatmap.bbo.held?.to && x.ts <= v.tMax).map((x) => `${x.ts}:${x.bestBid}:${x.bestAsk}`);
            return Number(v.tMax - v.tMin) / 1e6 === 30_000 && p.heatmap?.bbo.held
                ? { fine: inView(p.heatmap.bbo.held.points), history: inView(p.priceHistory) }
                : null;
        });
    await expect.poll(async () => (await fine())?.fine.length ?? 0, { timeout: 20_000 }).toBeGreaterThan(20);
    // the sim stamps events 100ms apart, sampling every 50ms lost nothing, so the two have to agree
    const { fine: exact, history } = (await fine())!;
    expect(exact).toEqual(history);
    expect(errors).toEqual([]);
});

async function noneOnTheHorizon(page: Page) {
    await page.setViewportSize({ width: 1400, height: 800 });
    await page.goto('/?sim=1&level=l3');
    await settled(page);
    await page.evaluate(() => {
        const c = (window as any).__chart;
        c.setChartSettings({ chartType: 'line', showTradeDots: false });
        c.setTimeframe('None');
    });
    await expect
        .poll(() => page.evaluate(() => {
            const v = (window as any).__chart.renderEngine.view;
            return Number(v.tMax - v.tMin) / 1e6;
        }), { timeout: 20_000 })
        .toBe(30_000);
    await page.locator('button:has(svg.lucide-rotate-ccw)').first().click();
    await page.waitForTimeout(500);
}

const AXIS_PX = 64;

const onHorizon = (page: Page) =>
    page.evaluate((axis) => {
        const c = (window as any).__chart;
        const v = c.renderEngine.view;
        const canvas = c.renderEngine.baseCanvas;
        const w = canvas.width - axis;
        const span = Number(v.tMax - v.tMin);
        const r = canvas.getBoundingClientRect();
        const hx = (Number(BigInt(c.horizon()) * 1_000_000n - v.tMin) / span) * w;
        return { msPerPx: span / w / 1e6, x: r.x + Math.max(60, Math.min(w - 150, hx - 80)), y: r.y + 300 };
    }, AXIS_PX);

// strips of the chart that go blank from one frame to the next, inside the data. nothing's there before it
const watchBlanks = (page: Page, loadedOnly = false) =>
    page.evaluate(({ axis, loadedOnly }) => {
        const win = window as any;
        const c = win.__chart;
        const canvas: HTMLCanvasElement = c.renderEngine.baseCanvas;
        const ctx = canvas.getContext('2d')!;
        const W = canvas.width;
        const w = W - axis;
        const h = Math.floor(canvas.height * 0.85);
        const blank = () => {
            const d = ctx.getImageData(0, 40, W, h).data;
            const out = new Uint8Array(w);
            for (let x = 0; x < w; x++) {
                let n = 0;
                for (let y = 0; y < h; y += 3) if (d[(y * W + x) * 4 + 3] < 30) n++;
                out[x] = n / Math.ceil(h / 3) > 0.97 ? 1 : 0;
            }
            return out;
        };
        const seen = (win.__blanks = { on: true, count: 0 });
        let prev = blank();
        const frame = () => {
            if (!seen.on) return;
            const cur = blank();
            const v = c.renderEngine.view;
            const p = c.renderEngine.drawParams;
            const first = (loadedOnly ? p.heatmap?.range?.start : p.priceHistory[0]?.ts) ?? v.tMin;
            const startX = Math.ceil((Number(first - v.tMin) / Number(v.tMax - v.tMin)) * w) + 3;
            let run = 0;
            for (let x = Math.max(0, startX); x <= w; x++) {
                if (x < w && cur[x] && !prev[x]) run++;
                else {
                    if (run >= 2) seen.count++;
                    run = 0;
                }
            }
            prev = cur;
            requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
    }, { axis: AXIS_PX, loadedOnly });

const blanksSeen = (page: Page) =>
    page.evaluate(() => {
        const seen = (window as any).__blanks;
        seen.on = false;
        return seen.count as number;
    });

test('l3 live: no blank strip at the horizon when a chunk lands', async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', 'frames too slow to see one frame');
    await noneOnTheHorizon(page);
    // a chunk is 250ms, ~6px at this zoom
    for (let i = 0; i < 80; i++) {
        const z = await onHorizon(page);
        if (z.msPerPx < 45) break;
        await page.mouse.move(z.x, z.y);
        await page.mouse.wheel(0, z.msPerPx > 90 ? -300 : -100);
        await page.waitForTimeout(40);
    }
    await page.waitForTimeout(1500);
    await watchBlanks(page);
    await page.waitForTimeout(4000);
    expect(await blanksSeen(page)).toBe(0);
});

test('l3 live: zooming doesnt blank the heatmap, either side of the horizon', async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', 'frames too slow to see one frame');
    await noneOnTheHorizon(page);
    await page.waitForTimeout(1000);
    await watchBlanks(page);
    // a wheel notch. flicked much harder a strip no tile has yet can still show for a few frames
    for (let round = 0; round < 3; round++) {
        for (const dy of [-120, 120]) {
            for (let i = 0; i < 14; i++) {
                const z = await onHorizon(page);
                await page.mouse.move(z.x, z.y);
                await page.mouse.wheel(0, dy);
                await page.waitForTimeout(50);
            }
        }
    }
    expect(await blanksSeen(page)).toBe(0);
});

test('l3 live: a chunk landing draws no other zoom at the horizon, it flashed another brightness', async ({ page }) => {
    await noneOnTheHorizon(page);
    for (let i = 0; i < 80; i++) {
        const z = await onHorizon(page);
        if (z.msPerPx < 12) break;
        await page.mouse.move(z.x, z.y);
        await page.mouse.wheel(0, z.msPerPx > 24 ? -300 : -100);
        await page.waitForTimeout(40);
    }
    await page.mouse.move(100, 400);
    await page.waitForTimeout(1500);
    // a tile is ~2.6s of 10ms columns, so this crosses into a new one too
    const drawn = await page.evaluate(async () => {
        const ht = (window as any).__chart.renderEngine.drawParams.heatmap;
        const fallback = ht.fallback;
        let n = 0;
        ht.fallback = function (...args: unknown[]) {
            n++;
            return fallback.apply(this, args);
        };
        await new Promise((r) => setTimeout(r, 4000));
        ht.fallback = fallback;
        return n;
    });
    // 23-24 before, a slow frame under load can still make one
    expect(drawn).toBeLessThan(4);
});

test('l3 live: zooming out at 1m leaves no blank inside what the worker has', async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', 'frames too slow to see one frame');
    await page.setViewportSize({ width: 1400, height: 800 });
    // a page landing mid zoom moves what the worker has past what any tile could cover yet
    await page.goto('/?sim=1&level=l3&ahead=0');
    await settled(page);
    await page.evaluate(() => {
        const c = (window as any).__chart;
        c.setChartSettings({ chartType: 'line', showTradeDots: false });
        c.setTimeframe('1m');
    });
    await page.waitForTimeout(1200);
    await watchBlanks(page, true);
    for (let i = 0; i < 6; i++) {
        const z = await onHorizon(page);
        await page.mouse.move(z.x, z.y);
        await page.mouse.wheel(0, 600);
        await page.waitForTimeout(50);
    }
    await page.waitForTimeout(300);
    expect(await blanksSeen(page)).toBe(0);
});

test('l3 live: older data loads ahead at rest, so a hard zoom out finds it, and it stops by itself', async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', 'frames too slow to see one frame');
    await page.setViewportSize({ width: 1400, height: 800 });
    await page.goto('/?sim=1&level=l3');
    await settled(page);
    await page.evaluate(() => {
        const win = window as any;
        const c = win.__chart;
        win.__backward = 0;
        const a = c.dataEngine.adapter;
        const fetchBars = a.fetchBars.bind(a);
        a.fetchBars = (r: any) => {
            if (r.direction === 'backward') win.__backward++;
            return fetchBars(r);
        };
        c.setChartSettings({ chartType: 'line', showTradeDots: false });
        c.setTimeframe('1m');
    });
    const backward = () => page.evaluate(() => (window as any).__backward as number);
    await expect.poll(backward, { timeout: 10_000 }).toBeGreaterThan(0);
    // 2 pages on the sim, ~1.8s apart, then nothing
    await page.waitForTimeout(5000);
    const before = await backward();
    await page.waitForTimeout(3000);
    expect(await backward()).toBe(before);

    await watchBlanks(page);
    for (let i = 0; i < 6; i++) {
        const z = await onHorizon(page);
        await page.mouse.move(z.x, z.y);
        await page.mouse.wheel(0, 600);
        await page.waitForTimeout(50);
    }
    await page.waitForTimeout(300);
    expect(await blanksSeen(page)).toBe(0);
});

test('None is in the timeframe list at tick, l2 and l3 only', async ({ page }) => {
    const errors = watchErrors(page);
    for (const level of ['tick', 'l3', 'l2']) {
        await page.goto(`/?sim=1&level=${level}`);
        await settled(page);
        await pickTimeframe(page, 'None');
        await settled(page);
        expect(await drawsSomething(page), level).toBe(true);
    }

    await page.goto('/');
    await settled(page);
    await page.getByRole('button', { name: 'All timeframes' }).click();
    await expect(page.getByRole('button', { name: '1h', exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'None', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.evaluate(() => (window as any).__chart.setTimeframe('None'));
    expect(await page.evaluate(() => (window as any).__chart.getTimeframe())).toBe('1m');
    expect(errors).toEqual([]);
});

test('l3: None zooms out past its own 30 s', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/?sim=1&level=l3');
    await settled(page);
    await page.evaluate(() => (window as any).__chart.setTimeframe('None'));
    // the switch takes over 5 s in webkit on a slow runner
    await expect.poll(() => page.evaluate(() => (window as any).__chart.getTimeframe()), { timeout: 20_000 }).toBe('None');
    await settled(page);
    // positive dy zooms out
    await wheel(page, 400, 20);
    await page.waitForTimeout(500);
    const spanMs = await page.evaluate(() => {
        const v = (window as any).__chart.renderEngine.view;
        return Number(v.tMax - v.tMin) / 1e6;
    });
    expect(spanMs).toBeGreaterThan(5 * 60_000);
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

test('l3: a footprint setting survives a page back', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/?level=l3');
    await settled(page);
    await page.evaluate(() => (window as any).__chart.setChartSettings({ footprintImbalanceRatio: 1.01 }));
    await page.evaluate(() => {
        const w = window as any;
        w.__prepends = 0;
        w.__chart.on('data:prepend', () => w.__prepends++);
    });
    for (let i = 0; i < 10 && !(await page.evaluate(() => (window as any).__prepends)); i++) {
        await drag(page, 600);
        await settled(page);
    }
    expect(await page.evaluate(() => (window as any).__prepends)).toBeGreaterThan(0);

    // at 1.01 nearly every level is an imbalance, at the default 3 about 1 in 10
    const share = await page.evaluate(() => {
        const bars: any[] = (window as any).__chart.renderEngine.drawParams.footprintBars;
        let lv = 0,
            imb = 0;
        for (const b of bars)
            for (const l of b.levels) {
                lv++;
                if (l.askImbalance || l.bidImbalance) imb++;
            }
        return imb / lv;
    });
    expect(share).toBeGreaterThan(0.5);
    expect(errors).toEqual([]);
});

test('l3: raising the heatmap contrast hides the thin levels', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/?level=l3');
    await settled(page);
    await expect.poll(() => heatmaps(page), { timeout: 15_000 }).toBeGreaterThan(0);

    // texels lit in the tiles the last frame drew
    const lit = () =>
        page.evaluate(() => {
            const tiles: ImageBitmap[] = (window as any).__chart.renderEngine.drawParams.heatmap?.drawn ?? [];
            let n = 0;
            for (const bm of tiles) {
                // replaced and closed since that frame
                if (!bm.width) continue;
                const c = new OffscreenCanvas(bm.width, bm.height);
                const ctx = c.getContext('2d')!;
                ctx.drawImage(bm, 0, 0);
                const d = ctx.getImageData(0, 0, bm.width, bm.height).data;
                for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
            }
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

test('l3: the heatmap off lets its copy of the data go, back on it draws again', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/?level=l3');
    await page.evaluate(() => {
        const w = window as any;
        w.__held = [];
        w.__chart.eventBus.on('data:pane-held', (e: any) => w.__held.push(e.bytes));
    });
    await settled(page);
    await expect.poll(() => heatmaps(page), { timeout: 15_000 }).toBeGreaterThan(0);
    const held = () => page.evaluate(() => (window as any).__held.at(-1) as number | undefined);

    await page.evaluate(() => (window as any).__chart.setChartSettings({ showHeatmap: false }));
    await expect.poll(held, { message: 'gave its copy up' }).toBe(0);

    const before = await heatmaps(page);
    await page.evaluate(() => (window as any).__chart.setChartSettings({ showHeatmap: true }));
    await expect.poll(held, { message: 'holds a copy again' }).toBeGreaterThan(0);
    await expect.poll(() => heatmaps(page), { message: 'and draws' }).toBeGreaterThan(before);
    expect(await drawsSomething(page)).toBe(true);
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
