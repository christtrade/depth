// the harness serving simulated l3
import { expect, test, type Page } from '@playwright/test';
import { dotRadius, refSize, columnNs } from '../src/lib/renderers/trade-dots';
import { settled, watchErrors } from './helpers';

const open = async (page: Page) => {
    await page.addInitScript(() => {
        const w = window as any;
        w.__text = [];
        const fillText = CanvasRenderingContext2D.prototype.fillText;
        CanvasRenderingContext2D.prototype.fillText = function (this: CanvasRenderingContext2D, s: string, x: number, y: number) {
            w.__text.push(String(s));
            return fillText.call(this, s, x, y);
        };
    });
    await page.goto('/?level=l3');
    await settled(page);
    await page.evaluate(() => (window as any).__chart.setChartSettings({ chartType: 'line', showTradeDots: true }));
    await page.waitForTimeout(500);
};

// the card's rows as the chart wrote them on its next ui draw
const card = async (page: Page): Promise<Record<string, string> | null> => {
    await page.evaluate(() => {
        const w = window as any;
        w.__text = [];
        w.__chart.renderEngine.markDirty('ui');
    });
    await page.waitForTimeout(120);
    const text: string[] = await page.evaluate(() => (window as any).__text);
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
        return {
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

test('l3: a click on empty chart clears the card', async ({ page }) => {
    await open(page);
    const b = await biggest(page);
    await page.mouse.click(b.cx, b.cy);
    expect(await card(page)).not.toBeNull();
    await page.mouse.click(b.cx, b.cy + 220);
    expect(await card(page)).toBeNull();
});
