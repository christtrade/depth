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

// the bars on screen, fitted with 10% margins either way
const expectedFit = (page: Page) =>
    page.evaluate(() => {
        const c = (window as any).__chart;
        const v = c.renderEngine.view;
        const bars = c.getData().bars;
        let lo = Infinity;
        let hi = -Infinity;
        const from = Number(v.tMin / 1_000_000n);
        const to = Number(v.tMax / 1_000_000n);
        for (let i = bars.lowerBound(from); i < bars.length && bars.time[i] < to; i++) {
            lo = Math.min(lo, bars.low[i]);
            hi = Math.max(hi, bars.high[i]);
        }
        const s = Math.log(hi) - Math.log(lo);
        return {
            log: [Math.exp(Math.log(lo) - s * 0.1), Math.exp(Math.log(hi) + s * 0.1)],
            linear: [lo - (hi - lo) * 0.1, hi + (hi - lo) * 0.1],
            now: [v.pMin as number, v.pMax as number],
        };
    });

const closeTo = (a: number[], b: number[]) => a.every((x, i) => Math.abs(x - b[i]) / b[i] < 0.03);

test('log: switching the mode fits the axis again, and back', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 600 });
    await page.goto('/?wide=1');
    await settled(page);
    await page.evaluate(() => (window as any).__chart.setChartSettings({ chartType: 'candles', priceScaleMode: 'log' }));
    await expect.poll(async () => {
        const f = await expectedFit(page);
        return closeTo(f.now, f.log);
    }).toBe(true);
    await page.evaluate(() => (window as any).__chart.setChartSettings({ priceScaleMode: 'normal' }));
    await expect.poll(async () => {
        const f = await expectedFit(page);
        return closeTo(f.now, f.linear);
    }).toBe(true);
});

test('log: a set price range under 0 gets fitted, log has nothing there', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 600 });
    await page.goto('/?wide=1');
    await settled(page);
    await page.evaluate(() => {
        const c = (window as any).__chart;
        c.setChartSettings({ chartType: 'candles', autoScale: false });
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => {
        const c = (window as any).__chart;
        c.renderEngine.view.pMin = -50;
        c.setChartSettings({ priceScaleMode: 'log' });
    });
    await expect.poll(() => page.evaluate(() => (window as any).__chart.renderEngine.view.pMin as number)).toBeGreaterThan(0);
});

test('log: a set price range above 0 stays put', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 600 });
    await page.goto('/?wide=1');
    await settled(page);
    await page.evaluate(() => (window as any).__chart.setChartSettings({ chartType: 'candles', autoScale: false }));
    await page.waitForTimeout(100);
    const view = () =>
        page.evaluate(() => {
            const v = (window as any).__chart.renderEngine.view;
            return [v.pMin, v.pMax] as number[];
        });
    const before = await view();
    await page.evaluate(() => (window as any).__chart.setChartSettings({ priceScaleMode: 'log' }));
    await page.waitForTimeout(200);
    expect(await view()).toEqual(before);
});

test('log: renko margins are in log too, a linear one takes the axis under 0', async ({ page }) => {
    await openLog(page, { chartType: 'renko', scaleMarginBottom: 0.5 });
    await page.waitForTimeout(500);
    const pMin = await page.evaluate(() => (window as any).__chart.renderEngine.view.pMin as number);
    expect(pMin).toBeGreaterThan(0);
});

test('log: trade arrows move with the mode even when the price range stays', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 600 });
    await page.goto('/?wide=1&account=1');
    await settled(page);
    await page.evaluate(() => {
        const c = (window as any).__chart;
        c.setChartSettings({ chartType: 'candles', autoScale: false });
        for (let i = 0; i < 40; i++) c.playback.stepBack();
    });
    await page.waitForTimeout(400);
    await page.evaluate(() => {
        const c = (window as any).__chart;
        c.executionEngine.placeOrder({ side: 'long', type: 'market', qty: 1, symbol: c.getSymbol() });
        for (let i = 0; i < 10; i++) c.playback.stepForward();
    });
    await page.waitForTimeout(600);
    // the shaft of a long arrow, moveTo(x, y) with the long color on
    await page.evaluate(() => {
        const w = window as any;
        w.__arrow = [];
        const proto = CanvasRenderingContext2D.prototype as any;
        const moveTo = proto.moveTo;
        proto.moveTo = function (x: number, y: number) {
            if (String(this.strokeStyle).toLowerCase() === '#12daf2') w.__arrow.push(y);
            return moveTo.call(this, x, y);
        };
    });
    const arrow = async () => {
        await page.evaluate(() => {
            const w = window as any;
            w.__arrow = [];
            w.__chart.renderEngine.markDirty('ui');
        });
        await page.waitForTimeout(150);
        return page.evaluate(() => {
            const w = window as any;
            return w.__arrow.length ? (w.__arrow.at(-1) as number) : null;
        });
    };
    const linear = await arrow();
    expect(linear, 'an arrow on screen').not.toBeNull();
    await page.evaluate(() => (window as any).__chart.setChartSettings({ priceScaleMode: 'log' }));
    await page.waitForTimeout(300);
    const log = await arrow();
    expect(Math.abs(log! - linear!), `${linear} then ${log}`).toBeGreaterThan(5);
});

for (const [tool, y1, y2, grabX] of [
    ['line', 100, 400, 350],
    // only its edges grab
    ['rect', 100, 300, 280],
] as const)
    test(`log: dragging a ${tool} moves all of it the same pixels, and keeps its prices over 0`, async ({ page }) => {
        const errors = watchErrors(page);
        await openLog(page, { chartType: 'candles', autoScale: false });
        await page.waitForTimeout(300);
        const v = await page.evaluate(() => {
            const c = (window as any).__chart;
            const box = c.renderEngine.baseCanvas.getBoundingClientRect();
            const main = c.renderEngine.drawParams.layouts.main;
            return { pMin: c.renderEngine.view.pMin, pMax: c.renderEngine.view.pMax, h: main.h, x: box.x + main.x, y: box.y + main.y };
        });
        const logY = (p: number) => (1 - (Math.log(p) - Math.log(v.pMin)) / (Math.log(v.pMax) - Math.log(v.pMin))) * v.h;
        const prices = () =>
            page.evaluate((tool) => {
                const all = Object.values((window as any).__chart.drawingStore.serialize()).flat() as any[];
                const d = all.find((x) => x.tool === tool);
                return d ? ([d.a.price, d.b.price] as number[]) : null;
            }, tool);
        await page.evaluate((name) => (window as any).__chart.setActiveTool({ name, id: '', state: {} }), tool);
        await page.mouse.move(v.x + 200, v.y + y1);
        await page.mouse.click(v.x + 200, v.y + y1);
        await page.mouse.move(v.x + 500, v.y + y2);
        await page.mouse.click(v.x + 500, v.y + y2);
        await expect.poll(prices).not.toBeNull();
        const before = (await prices())!;

        const grabY = v.y + (tool === 'rect' ? Math.min(logY(before[0]), logY(before[1])) : (logY(before[0]) + logY(before[1])) / 2);
        await page.mouse.move(v.x + grabX, grabY);
        await page.mouse.click(v.x + grabX, grabY);
        await page.mouse.move(v.x + grabX, grabY);
        await page.mouse.down();
        await page.mouse.move(v.x + grabX, grabY + 40, { steps: 6 });
        await page.mouse.up();
        await page.waitForTimeout(200);
        const after = (await prices())!;
        expect(after[0]).toBeGreaterThan(0);
        expect(after[1]).toBeGreaterThan(0);
        // a rect sorts its corners, so match each to the end it came from
        const pair = (a: number[]) => [...a].sort((x, y) => x - y);
        const moved = pair(after).map((p, i) => logY(p) - logY(pair(before)[i]));
        for (const px of moved) expect(Math.abs(px - 40), `moved ${moved}`).toBeLessThan(2);
        expect(errors).toEqual([]);
    });

test('log: a channel is parallel on screen and its third click sits on the top line', async ({ page }) => {
    const errors = watchErrors(page);
    await openLog(page, { chartType: 'candles', autoScale: false });
    await page.waitForTimeout(300);
    const v = await page.evaluate(() => {
        const c = (window as any).__chart;
        const box = c.renderEngine.baseCanvas.getBoundingClientRect();
        const main = c.renderEngine.drawParams.layouts.main;
        return { pMin: c.renderEngine.view.pMin, pMax: c.renderEngine.view.pMax, h: main.h, x: box.x + main.x, y: box.y + main.y };
    });
    await page.evaluate(() => (window as any).__chart.setActiveTool({ name: 'parallel-channel', id: '', state: {} }));
    const click = async (x: number, y: number) => {
        await page.mouse.move(v.x + x, v.y + y);
        await page.mouse.click(v.x + x, v.y + y);
    };
    await click(200, 200);
    await click(600, 350);
    await click(600, 150);
    await page.waitForTimeout(200);

    // the lines a redraw strokes, from where they start to where they end
    await page.evaluate(() => {
        const w = window as any;
        const proto = CanvasRenderingContext2D.prototype as any;
        const moveTo = proto.moveTo;
        const lineTo = proto.lineTo;
        w.__lines = [];
        let from: number[] | null = null;
        proto.moveTo = function (x: number, y: number) {
            from = [x, y];
            return moveTo.call(this, x, y);
        };
        proto.lineTo = function (x: number, y: number) {
            if (from) w.__lines.push([...from, x, y]);
            from = null;
            return lineTo.call(this, x, y);
        };
        w.__chart.renderEngine.markDirty('drawings');
    });
    await page.waitForTimeout(300);
    const lines = await page.evaluate(() => (window as any).__lines as number[][]);
    const channel = lines.filter((l) => Math.abs(l[0] - 200) < 2 && Math.abs(l[2] - 600) < 2);
    // base, top and the default levels between
    expect(channel.length).toBeGreaterThanOrEqual(2);
    const rise = channel.map((l) => l[3] - l[1]);
    for (const r of rise) expect(Math.abs(r - 150), `rises ${rise}`).toBeLessThan(2);
    expect(channel.some((l) => Math.abs(l[3] - 150) < 2), 'through the third click').toBe(true);
    expect(errors).toEqual([]);
});

test('log: heatmap rows sit on their prices, the book around the bid and ask lines up with them', async ({ page }) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 1000, height: 600 });
    await page.goto('/?wide=1&level=l3');
    await settled(page);
    // nothing on the canvas but the heat, the lines sit on the bid and ask whatever the heat does
    await page.evaluate(() =>
        (window as any).__chart.setChartSettings({
            chartType: 'line',
            showTradeDots: false,
            showBidLine: false,
            showAskLine: false,
            showMidLine: false,
            showLastTradeLine: false,
            showGrid: false,
            priceScaleMode: 'log',
        }),
    );
    await page.waitForFunction(() => (window as any).__heatmaps > 0, undefined, { timeout: 15_000 });
    const box = await page.evaluate(() => {
        const r = (window as any).__chart.renderEngine.baseCanvas.getBoundingClientRect();
        return { x: r.x, y: r.y };
    });
    // out to a range that bends, ~4x
    for (let i = 0; i < 6; i++) {
        await page.mouse.move(box.x + 500, box.y + 250);
        await page.mouse.wheel(0, 300);
        await page.waitForTimeout(150);
    }
    await page.mouse.move(box.x + 5, box.y + 5);
    await page.waitForTimeout(3500);
    const out = await page.evaluate(() => {
        const c = (window as any).__chart;
        const p = c.renderEngine.drawParams;
        const v = c.renderEngine.view;
        const canvas: HTMLCanvasElement = c.renderEngine.baseCanvas;
        const ctx = canvas.getContext('2d')!;
        const dpr = canvas.width / canvas.getBoundingClientRect().width;
        const main = p.layouts.main;
        const span = Number(v.tMax - v.tMin);
        const toY = (price: number) => (1 - (Math.log(price) - Math.log(v.pMin)) / (Math.log(v.pMax) - Math.log(v.pMin))) * main.h;
        const misses: number[] = [];
        const hist = p.priceHistory.filter((h: any) => h.ts >= v.tMin && h.ts <= v.tMax);
        for (const f of [0.3, 0.45, 0.6, 0.75]) {
            const h = hist[Math.floor(hist.length * f)];
            const x = Math.round((Number(h.ts - v.tMin) / span) * main.w * dpr);
            const col = ctx.getImageData(x, 0, 1, Math.round(main.h * dpr)).data;
            // the heat is a solid run around the bid and ask, its middle should be about there
            let lo = Infinity;
            let hi = -Infinity;
            for (let r = 0; r * 4 < col.length; r++) {
                if (col[r * 4 + 3] > 30) {
                    lo = Math.min(lo, r / dpr);
                    hi = Math.max(hi, r / dpr);
                }
            }
            const y = toY((h.bestBid + h.bestAsk) / 2);
            misses.push(y < lo ? lo - y : y > hi ? y - hi : 0);
        }
        return { misses, span: [v.pMin, v.pMax] };
    });
    for (const m of out.misses) expect(m, `bid and ask ${m}px outside the heat, ${JSON.stringify(out)}`).toBeLessThan(2);
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
