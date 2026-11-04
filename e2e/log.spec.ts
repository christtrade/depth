import { expect, test, type Page } from '@playwright/test';
import { settled, watchErrors } from './helpers';

const openLog = async (page: Page, settings: Record<string, unknown> = {}) => {
    await page.setViewportSize({ width: 1000, height: 600 });
    await page.goto('/?wide=1');
    await settled(page);
    await page.evaluate((s) => (window as any).__chart.setChartSettings({ ...s, priceScaleMode: 'log' }), settings);
};

const closeLine = (name: string, color: string, extra = '') => `
    const p = plugin({ name: "${name}", shortName: "${name}", type: PluginType.indicator, require: DataLevel.ohlcv, ${extra} version: "1.0.0" })
    p.init = function({ data }) {
        const bars = data.ohlcv
        return { pts: toPoints(bars.map(b => b.ts), bars.map(b => b.close)) }
    }
    p.draw = function(s) { return [drawLine(s.pts, '${color}', 2)] }`;

const addCloseLine = (page: Page, id: string, color: string, extra = '') =>
    page.evaluate(
        ({ id, script }) => {
            const w = window as any;
            w.__chart.use(w.__createScriptedPlugin(script, id));
            w.__chart.add(id);
        },
        { id, script: closeLine(id, color, extra) },
    );

// how far the line is from where the mapping says, in css px, at a few bars across the view
const worstMiss = (page: Page, pane: 'main' | 'sub', rgb: number[], scale: 'log' | 'linear') =>
    page.evaluate(
        ({ pane, rgb, scale }) => {
            const c = (window as any).__chart;
            const p = c.renderEngine.drawParams;
            const v = c.renderEngine.view;
            const canvas: HTMLCanvasElement = c.renderEngine.baseCanvas;
            const dpr = canvas.width / canvas.getBoundingClientRect().width;
            const entry = pane === 'main' ? null : p.panes.find((x: any) => !x.isMain);
            const rect = p.layouts[entry ? entry.id : 'main'];
            const yMin = entry ? entry.yMin : v.pMin;
            const yMax = entry ? entry.yMax : v.pMax;
            const toY =
                scale === 'log'
                    ? (price: number) => (1 - (Math.log(price) - Math.log(yMin)) / (Math.log(yMax) - Math.log(yMin))) * rect.h
                    : (price: number) => (1 - (price - yMin) / (yMax - yMin)) * rect.h;
            const bars = c.getData().bars;
            const ctx = canvas.getContext('2d')!;
            const span = Number(v.tMax - v.tMin);
            let worst = 0;
            let checked = 0;
            for (const f of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7]) {
                const ms = Number(v.tMin / 1_000_000n) + (f * span) / 1e6;
                const i = bars.lowerBound(ms);
                if (i >= bars.length) continue;
                const x = ((Number(BigInt(bars.time[i]) * 1_000_000n - v.tMin) / span) * rect.w + rect.x) * dpr;
                const want = toY(bars.close[i]);
                const col = ctx.getImageData(Math.round(x), Math.round(rect.y * dpr), 1, Math.round(rect.h * dpr)).data;
                let nearest = Infinity;
                for (let row = 0; row * 4 < col.length; row++) {
                    const hit =
                        Math.abs(col[row * 4] - rgb[0]) < 40 && Math.abs(col[row * 4 + 1] - rgb[1]) < 40 && Math.abs(col[row * 4 + 2] - rgb[2]) < 40;
                    if (hit) nearest = Math.min(nearest, Math.abs(row / dpr - want));
                }
                worst = Math.max(worst, nearest);
                checked++;
            }
            return { worst, checked };
        },
        { pane, rgb, scale },
    );

test('log: an overlay indicator sits on the candles, a pane one keeps its own linear scale', async ({ page }) => {
    const errors = watchErrors(page);
    await openLog(page);
    await addCloseLine(page, 'over', '#ff00ff');
    await addCloseLine(page, 'sub', '#00ffff', 'layout: Layout.pane,');
    const miss = (pane: 'main' | 'sub', rgb: number[], scale: 'log' | 'linear') => async () => {
        const m = await worstMiss(page, pane, rgb, scale);
        expect(m.checked).toBe(6);
        return m.worst;
    };
    await expect.poll(miss('main', [255, 0, 255], 'log'), { timeout: 10_000 }).toBeLessThan(5);
    await expect.poll(miss('sub', [0, 255, 255], 'linear'), { timeout: 10_000 }).toBeLessThan(5);
    expect(errors).toEqual([]);
});

const geometry = (page: Page) =>
    page.evaluate(() => {
        const c = (window as any).__chart;
        const p = c.renderEngine.drawParams;
        const box = c.renderEngine.baseCanvas.getBoundingClientRect();
        const sub = p.panes.find((x: any) => !x.isMain);
        return {
            x: box.x,
            y: box.y,
            main: p.layouts.main,
            pMin: c.renderEngine.view.pMin as number,
            pMax: c.renderEngine.view.pMax as number,
            sub: sub ? { ...p.layouts[sub.id], yMin: sub.yMin as number, yMax: sub.yMax as number } : null,
        };
    });

const logPriceAt = (localY: number, g: { main: { h: number }; pMin: number; pMax: number }) =>
    Math.exp(Math.log(g.pMin) + (1 - localY / g.main.h) * (Math.log(g.pMax) - Math.log(g.pMin)));

// everything drawn to a canvas from now on, in css px
const spyOnDrawing = (page: Page) =>
    page.evaluate(() => {
        const w = window as any;
        w.__texts = [];
        w.__moves = [];
        const proto = CanvasRenderingContext2D.prototype as any;
        const fillText = proto.fillText;
        const moveTo = proto.moveTo;
        const css = (ctx: CanvasRenderingContext2D, x: number, y: number) => {
            const t = ctx.getTransform();
            return { x: (t.a * x + t.e) / t.a, y: (t.d * y + t.f) / t.d };
        };
        proto.fillText = function (text: string, x: number, y: number, ...rest: unknown[]) {
            w.__texts.push({ text, ...css(this, x, y) });
            return fillText.call(this, text, x, y, ...rest);
        };
        proto.moveTo = function (x: number, y: number) {
            w.__moves.push(css(this, x, y));
            return moveTo.call(this, x, y);
        };
    });

test('log: the crosshair pill reads the price under the cursor, in a sub pane its own scale', async ({ page }) => {
    await openLog(page);
    await addCloseLine(page, 'sub', '#00ffff', 'layout: Layout.pane,');
    await page.waitForTimeout(800);
    await spyOnDrawing(page);
    const g = await geometry(page);
    const pill = async (cssY: number) => {
        await page.evaluate(() => ((window as any).__texts = []));
        await page.mouse.move(g.x + g.main.x + 300, g.y + cssY);
        await page.waitForTimeout(200);
        const texts = await page.evaluate(() => (window as any).__texts as { text: string; x: number; y: number }[]);
        const hit = texts.filter((t) => Math.abs(t.x - (g.main.w + 6)) < 2 && Math.abs(t.y - cssY) < 2).at(-1);
        expect(hit, `a pill at ${cssY}`).toBeTruthy();
        return Number(hit!.text.replace(/,/g, ''));
    };

    for (const y of [60, 180, 300]) {
        const want = logPriceAt(y - g.main.y, g);
        const got = await pill(y);
        expect(Math.abs(got - want) / want, `${got} against ${want}`).toBeLessThan(0.01);
    }

    const sub = g.sub!;
    const y = sub.y + sub.h / 2;
    const want = (sub.yMin + sub.yMax) / 2;
    const got = await pill(Math.round(y));
    expect(Math.abs(got - want) / (sub.yMax - sub.yMin)).toBeLessThan(0.02);
});

test('log: the shift measure anchors on the price under the cursor', async ({ page }) => {
    await openLog(page, { autoScale: false });
    await page.waitForTimeout(300);
    const g = await geometry(page);
    const anchors = () =>
        page.evaluate(() => {
            const p = (window as any).__chart.renderEngine.drawParams;
            return { a: p.shiftInfoAnchor?.price as number | undefined, b: p.shiftInfoAnchor2?.price as number | undefined };
        });
    const y1 = g.main.y + g.main.h * 0.8;
    const y2 = g.main.y + g.main.h * 0.4;
    await page.keyboard.down('Shift');
    await page.mouse.move(g.x + g.main.x + 300, g.y + y1);
    await page.mouse.down();
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await expect.poll(async () => (await anchors()).a).toBeTruthy();
    const wantA = logPriceAt(y1 - g.main.y, g);
    expect(Math.abs((await anchors()).a! - wantA) / wantA).toBeLessThan(0.01);

    await page.mouse.move(g.x + g.main.x + 500, g.y + y2);
    await page.mouse.down();
    await page.mouse.up();
    await expect.poll(async () => (await anchors()).b).toBeTruthy();
    const wantB = logPriceAt(y2 - g.main.y, g);
    expect(Math.abs((await anchors()).b! - wantB) / wantB).toBeLessThan(0.01);
});

test('log: a sub pane grid lines up with its labels, its scale is linear', async ({ page }) => {
    await openLog(page);
    await addCloseLine(page, 'sub', '#00ffff', 'layout: Layout.pane,');
    await page.waitForTimeout(800);
    await spyOnDrawing(page);
    await page.evaluate(() => {
        const w = window as any;
        w.__texts = [];
        w.__moves = [];
        w.__chart.renderEngine.markDirty('base');
    });
    await page.waitForTimeout(300);
    const g = await geometry(page);
    const sub = g.sub!;
    const { texts, moves } = await page.evaluate(() => ({
        texts: (window as any).__texts as { text: string; x: number; y: number }[],
        moves: (window as any).__moves as { x: number; y: number }[],
    }));
    const inPane = (y: number) => y > sub.y && y < sub.y + sub.h;
    const labels = texts.filter((t) => Math.abs(t.x - (g.main.w + 6)) < 2 && inPane(t.y)).map((t) => t.y);
    const lines = moves.filter((m) => Math.abs(m.x) < 1 && inPane(m.y)).map((m) => m.y);
    expect(labels.length).toBeGreaterThan(0);
    expect(lines.length).toBeGreaterThan(0);
    for (const y of labels) {
        const nearest = Math.min(...lines.map((l) => Math.abs(l - y)));
        expect(nearest, `a line by the label at ${y}, lines ${lines}`).toBeLessThan(2);
    }
});
