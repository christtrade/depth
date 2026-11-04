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
