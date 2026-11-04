// the harness serving simulated l3
import { expect, test, type Page } from '@playwright/test';
import { dotRadius, refSize, columnNs } from '../src/lib/renderers/trade-dots';
import { settled, watchErrors } from './helpers';

const open = async (page: Page, url = '/?level=l3') => {
    await page.addInitScript(() => {
        const w = window as any;
        w.__text = [];
        const fillText = CanvasRenderingContext2D.prototype.fillText;
        CanvasRenderingContext2D.prototype.fillText = function (this: CanvasRenderingContext2D, s: string, x: number, y: number) {
            w.__text.push(String(s));
            return fillText.call(this, s, x, y);
        };
    });
    await page.goto(url);
    await settled(page);
    await page.evaluate(() => (window as any).__chart.setChartSettings({ chartType: 'line', showTradeDots: true }));
    await page.waitForTimeout(500);
};

// the card's rows as the chart wrote them on its next ui draw
const card = async (page: Page): Promise<Record<string, string> | null> => {
    // a set wait comes up empty under load, this waits for the draw
    const text: string[] = await page.evaluate(async () => {
        const w = window as any;
        w.__text = [];
        w.__chart.renderEngine.markDirty('ui');
        for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
        return w.__text;
    });
    const at = text.lastIndexOf('Total');
    if (at < 0) return null;
    const rows: Record<string, string> = {};
    for (let i = at; i < at + 12; i += 2) rows[text[i]] = text[i + 1];
    return rows;
};

// computed apart from the chart's own grouping, off what it's got in view
const biggest = (page: Page) =>
    page.evaluate(() => {
        const c = (window as any).__chart;
        const p = c.renderEngine.drawParams;
        const v = c.renderEngine.view;
        const box = c.renderEngine.uiCanvas.getBoundingClientRect();
        const w = p.layouts.main.w;
        const h = p.layouts.main.h;
        const want = (Number(v.tMax - v.tMin) / w) * 8;
        let colNs = 1n;
        while (Number(colNs) < want) colNs <<= 1n;
        const cols = new Map<bigint, any>();
        for (const t of p.trades) {
            if (t.ts < v.tMin || t.ts > v.tMax) continue;
            const k = t.ts / colNs;
            const d = cols.get(k) ?? { n: 0, size: 0, buy: 0, sp: 0, sx: 0, first: String(t.ts) };
            d.n++;
            d.size += t.size;
            if (t.side === 'B') d.buy += t.size;
            d.sp += t.price * t.size;
            d.sx += p.transformer.tsToX(t.ts, w) * t.size;
            cols.set(k, d);
        }
        let best: any = null;
        for (const d of cols.values()) if (!best || d.size > best.size) best = d;
        const sx = best.sx / best.size;
        const sy = p.transformer.priceToY(best.sp / best.size, h);
        // the biggest one well clear of it
        let far: any = null;
        for (const d of cols.values()) {
            if (Math.abs(d.sx / d.size - sx) > 120 && d.size !== best.size && (!far || d.size > far.size)) far = d;
        }
        return {
            other: {
                size: far.size as number,
                cx: box.left + far.sx / far.size,
                cy: box.top + p.transformer.priceToY(far.sp / far.size, h),
            },
            n: best.n as number,
            size: best.size as number,
            buy: best.buy as number,
            first: best.first as string,
            cx: box.left + sx,
            cy: box.top + sy,
            trades: p.trades.map((t: any) => ({ ts: String(t.ts), size: t.size })) as { ts: string; size: number }[],
            nsPerPx: Number(v.tMax - v.tMin) / w,
        };
    });

test('l3: a click on a bubble shows what the whole bubble holds', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page);
    const b = await biggest(page);
    expect(b.n).toBeGreaterThan(1);

    await page.mouse.click(b.cx, b.cy);
    const rows = await card(page);
    expect(rows).not.toBeNull();
    expect(rows!.Total).toBe(b.size.toLocaleString('en-US'));
    expect(rows!.Trades).toBe(String(b.n));
    const buyPct = Math.round((b.buy / b.size) * 100);
    expect(rows!.Buy).toBe(`${b.buy.toLocaleString('en-US')}  ${buyPct}%`);
    expect(rows!.Sell).toBe(`${(b.size - b.buy).toLocaleString('en-US')}  ${100 - buyPct}%`);
    expect(errors).toEqual([]);
});

test('l3: a click on the edge of a big bubble still selects it', async ({ page }) => {
    await open(page);
    const b = await biggest(page);
    const trades = b.trades.map((t) => ({ ts: BigInt(t.ts), price: 0, size: t.size, side: 'B' }));
    const r = dotRadius(b.size, refSize(trades, columnNs(b.nsPerPx)), 1);
    expect(r).toBeGreaterThan(3);

    const off = (r - 1) * Math.SQRT1_2;
    await page.mouse.click(b.cx + off, b.cy - off);
    expect((await card(page))?.Total).toBe(b.size.toLocaleString('en-US'));
});

test('l3: a selected bubble regroups when a zoom changes its column', async ({ page }) => {
    await open(page);
    const b = await biggest(page);
    await page.mouse.click(b.cx, b.cy);
    const before = await card(page);
    expect(before).not.toBeNull();

    await page.mouse.move(b.cx, b.cy);
    for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, 300);
        await page.waitForTimeout(16);
    }
    await page.waitForTimeout(400);
    const after = await card(page);
    expect(after).not.toBeNull();
    const total = (r: Record<string, string>) => Number(r.Total.replace(/,/g, ''));
    expect(total(after!)).toBeGreaterThan(total(before!));
});

test('l3: the card goes when the bubble is panned off, clicked away or turned off', async ({ page }) => {
    await open(page);
    const b = await biggest(page);
    await page.mouse.click(b.cx, b.cy);
    expect(await card(page)).not.toBeNull();

    await page.evaluate(() => (window as any).__chart.setChartSettings({ showTradeDots: false }));
    await page.waitForTimeout(150);
    expect(await card(page)).toBeNull();
    await page.evaluate(() => (window as any).__chart.setChartSettings({ showTradeDots: true }));
    await page.waitForTimeout(150);
    expect(await card(page)).not.toBeNull();

    // pan it off the left edge, from a spot with no bubble under the press
    const y = b.cy - 200;
    await page.mouse.move(b.cx + 300, y);
    await page.mouse.down();
    await page.mouse.move(b.cx - 200, y, { steps: 8 });
    await page.mouse.move(b.cx - 700, y, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const gone = await page.evaluate((first) => BigInt(first) < (window as any).__chart.renderEngine.view.tMin, b.first);
    expect(gone).toBe(true);
    expect(await card(page)).toBeNull();
});

test('l3: hovering a bubble shows its card, moving off drops it', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page);
    const b = await biggest(page);
    await page.mouse.move(b.cx, b.cy);
    expect((await card(page))?.Total).toBe(b.size.toLocaleString('en-US'));
    await page.mouse.move(b.cx, b.cy + 220);
    expect(await card(page)).toBeNull();
    expect(errors).toEqual([]);
});

test('l3: hovering another bubble swaps the card, a pinned one comes back after', async ({ page }) => {
    await open(page);
    const b = await biggest(page);
    await page.mouse.click(b.cx, b.cy);
    await page.mouse.move(b.cx, b.cy + 220);
    expect((await card(page))?.Total).toBe(b.size.toLocaleString('en-US'));
    await page.mouse.move(b.other.cx, b.other.cy);
    expect((await card(page))?.Total).toBe(b.other.size.toLocaleString('en-US'));
    await page.mouse.move(b.cx, b.cy + 220);
    expect((await card(page))?.Total).toBe(b.size.toLocaleString('en-US'));
});

test('l3: a pan over the bubbles shows no hover card', async ({ page }) => {
    await open(page);
    const b = await biggest(page);
    await page.mouse.move(b.cx, b.cy);
    await page.mouse.down();
    await page.mouse.move(b.cx + 6, b.cy, { steps: 3 });
    expect(await card(page)).toBeNull();
    await page.mouse.up();
});

test('l3: a hover follows a zoom without a mouse move', async ({ page }) => {
    await open(page);
    const b = await biggest(page);
    await page.mouse.move(b.cx, b.cy);
    const before = await card(page);
    expect(before).not.toBeNull();
    for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, 300);
        await page.waitForTimeout(16);
    }
    await page.waitForTimeout(400);
    const after = await card(page);
    expect(after?.Total).not.toBe(before!.Total);
});

test('l3 live: hover and a pinned bubble hold up as chunks land', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, '/?sim=1&level=l3');
    await page.waitForTimeout(1500);
    // the view steps a whole bar each minute, one landing right here moves the bubble out from under the click
    let b = await biggest(page);
    await expect
        .poll(async () => {
            b = await biggest(page);
            await page.mouse.click(b.cx, b.cy);
            await page.waitForTimeout(50);
            // the pin, the card would show for the hover alone
            return page.evaluate(() => (window as any).__chart.renderEngine.drawParams.selectedDotTs !== null);
        })
        .toBe(true);
    await page.mouse.move(b.other.cx, b.other.cy);
    expect((await card(page))?.Trades, 'moved to another bubble').toBeTruthy();
    await page.waitForTimeout(1000);
    expect((await card(page))?.Trades, 'a second of chunks later').toBeTruthy();
    await page.mouse.move(b.cx, b.cy + 220);
    expect((await card(page))?.Trades, 'off every bubble, the pin').toBeTruthy();
    expect(errors).toEqual([]);
});

test('l3: the card time follows the chart timezone and clock', async ({ page }) => {
    await open(page);
    await page.evaluate(() => (window as any).__chart.setChartSettings({ timezone: 'Asia/Tokyo', use24HourClock: true }));
    await page.waitForTimeout(200);
    const b = await biggest(page);
    await page.mouse.click(b.cx, b.cy);
    const want = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Tokyo',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3,
        hourCycle: 'h23',
    }).format(new Date(Number(BigInt(b.first) / 1_000_000n)));
    expect((await card(page))?.Time).toBe(want);

    await page.evaluate(() => (window as any).__chart.setChartSettings({ use24HourClock: false }));
    await page.waitForTimeout(200);
    expect((await card(page))?.Time).toMatch(/^\d\d:\d\d:\d\d\.\d{3} (AM|PM)$/);
});

for (const theme of ['dark', 'light', 'gruvboxlight'])
    test(`l3: the card is readable on the ${theme} theme, and looks like it`, async ({ page }) => {
        await open(page);
        await page.evaluate((id) => (window as any).__chart.setTheme(id), theme);
        await page.waitForTimeout(300);
        const b = await biggest(page);
        await page.mouse.click(b.cx, b.cy);
        // the colors behind and in front of the card's first value
        const got = await page.evaluate(async () => {
            const w = window as any;
            const proto = CanvasRenderingContext2D.prototype as any;
            const fillRect = proto.fillRect;
            const fillText = proto.fillText;
            let lastWide = '';
            let label = '';
            let value = '';
            let afterTotal = false;
            let afterBuy = false;
            let afterSell = false;
            let buy = '';
            let sell = '';
            proto.fillRect = function (x: number, y: number, rw: number, rh: number) {
                if (rw > 40 && rh > 80) lastWide = this.fillStyle;
                return fillRect.call(this, x, y, rw, rh);
            };
            proto.fillText = function (s: string, ...a: unknown[]) {
                if (s === 'Total') {
                    label = this.fillStyle;
                    afterTotal = true;
                } else if (afterTotal) {
                    value = this.fillStyle;
                    afterTotal = false;
                } else if (s === 'Buy') afterBuy = true;
                else if (s === 'Sell') afterSell = true;
                else if (afterBuy) {
                    buy = this.fillStyle;
                    afterBuy = false;
                } else if (afterSell) {
                    sell = this.fillStyle;
                    afterSell = false;
                }
                return fillText.call(this, s, ...a);
            };
            w.__chart.renderEngine.markDirty('ui');
            for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
            proto.fillRect = fillRect;
            proto.fillText = fillText;
            return {
                bg: lastWide,
                label,
                value,
                buy,
                sell,
                chartBg: w.__chart.renderEngine.drawParams.chartSettings.backgroundColor as string,
            };
        });
        const rgb = (c: string) => {
            const m = c.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
            if (m) return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
            return c.match(/[\d.]+/g)!.slice(0, 3).map(Number);
        };
        const lum = (c: string) => {
            const [r, g, bl] = rgb(c).map((v) => {
                const s = v / 255;
                return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
        };
        const contrast = (a: string, c: string) => {
            const [hi, lo] = [lum(a), lum(c)].sort((x, y) => y - x);
            return (hi + 0.05) / (lo + 0.05);
        };
        expect(contrast(got.bg, got.label), `label on card ${JSON.stringify(got)}`).toBeGreaterThan(4.5);
        expect(contrast(got.bg, got.value), `value on card ${JSON.stringify(got)}`).toBeGreaterThan(4.5);
        expect(contrast(got.bg, got.buy), `buy on card ${JSON.stringify(got)}`).toBeGreaterThan(3);
        expect(contrast(got.bg, got.sell), `sell on card ${JSON.stringify(got)}`).toBeGreaterThan(3);
        // the same family as the chart, a black card on a white chart is what this was
        const light = lum(got.chartBg) > 0.4;
        expect(lum(got.bg) > 0.2, `card ${got.bg} on chart ${got.chartBg}`).toBe(light);
    });

test('l3: a drawing tool gets no hover card', async ({ page }) => {
    await open(page);
    const b = await biggest(page);
    await page.mouse.move(b.cx, b.cy);
    expect(await card(page)).not.toBeNull();
    await page.evaluate(() => (window as any).__chart.setActiveTool({ name: 'line', id: '', state: {} }));
    await page.waitForTimeout(100);
    await page.mouse.move(b.cx + 1, b.cy);
    expect(await card(page)).toBeNull();
});

test('l3: a click on empty chart clears the card', async ({ page }) => {
    await open(page);
    const b = await biggest(page);
    await page.mouse.click(b.cx, b.cy);
    expect(await card(page)).not.toBeNull();
    await page.mouse.click(b.cx, b.cy + 220);
    expect(await card(page)).toBeNull();
});
