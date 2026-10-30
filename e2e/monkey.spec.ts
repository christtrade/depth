// random, impatient, human (ish) input
//   MONKEY_SEEDS=10 MONKEY_MS=60000 npm run e2e   more and longer
//   MONKEY_SEED=1234 npx playwright test monkey   replay one
// replays pick the same actions in the same order. timing still differs a bit, since loads are async
import { expect, test, type Page } from '@playwright/test';
import { chartBox, drawsSomething, inside, settled, watchErrors } from './helpers';

const SEEDS = process.env.MONKEY_SEED
    ? [Number(process.env.MONKEY_SEED)]
    : Array.from({ length: Number(process.env.MONKEY_SEEDS ?? 3) }, (_, i) => 1000 + i);
const RUN_MS = Number(process.env.MONKEY_MS ?? 15_000);

const URLS = ['/', '/?live=1', '/?live=1&budget=4000000'];
const TIMEFRAMES = ['1s', '5s', '30s', '1m', '5m', '15m', '1h', '4h', '1d'];
const SIZES = [
    { width: 1280, height: 800 },
    { width: 375, height: 812 },
    { width: 820, height: 600 },
    { width: 1920, height: 1080 },
];

function mulberry32(seed: number) {
    return () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

type Rand = ReturnType<typeof mulberry32>;
const int = (r: Rand, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T,>(r: Rand, xs: readonly T[]) => xs[Math.floor(r() * xs.length)];

async function somewhereOnChart(page: Page, r: Rand) {
    const box = await chartBox(page);
    return { x: box.x + box.width * (0.1 + r() * 0.8), y: box.y + box.height * (0.15 + r() * 0.7) };
}

// impatient picking a timeframe (dont wait for the last one to finish loading)
async function clickTimeframe(page: Page, label: string) {
    const pill = page.getByRole('button', { name: label, exact: true }).first();
    if (await pill.isVisible()) return pill.click({ timeout: 2000 });
    await page.getByRole('button', { name: 'All timeframes' }).click({ timeout: 2000 });
    await page.getByRole('button', { name: label, exact: true }).first().click({ timeout: 2000 });
}

const ACTIONS: { name: string; weight: number; run: (page: Page, r: Rand) => Promise<string> }[] = [
    {
        name: 'drag',
        weight: 6,
        run: async (page, r) => {
            const { y } = await somewhereOnChart(page, r);
            const [x0, x1] = inside(await chartBox(page), int(r, -1500, 1500));
            const dy = int(r, -80, 80);
            const steps = int(r, 2, 40);
            await page.mouse.move(x0, y);
            await page.mouse.down();
            await page.mouse.move(x1, y + dy, { steps });
            await page.mouse.up();
            return `drag ${Math.round(x1 - x0)},${dy} in ${steps}`;
        },
    },
    {
        name: 'fling',
        weight: 2,
        run: async (page, r) => {
            const { y } = await somewhereOnChart(page, r);
            const [x0, x1] = inside(await chartBox(page), int(r, -600, 600));
            await page.mouse.move(x0, y);
            await page.mouse.down();
            await page.mouse.move(x1, y, { steps: 2 });
            await page.mouse.up();
            return `fling ${Math.round(x1 - x0)}`;
        },
    },
    {
        name: 'wheel',
        weight: 4,
        run: async (page, r) => {
            const at = await somewhereOnChart(page, r);
            const n = int(r, 1, 15);
            const dy = (r() < 0.5 ? -1 : 1) * int(r, 20, 400);
            await page.mouse.move(at.x, at.y);
            for (let i = 0; i < n; i++) await page.mouse.wheel(r() < 0.2 ? dy : 0, r() < 0.2 ? 0 : dy);
            return `wheel ${n}x${dy}`;
        },
    },
    {
        name: 'timeframe',
        weight: 3,
        run: async (page, r) => {
            const tf = pick(r, TIMEFRAMES);
            await clickTimeframe(page, tf);
            return `timeframe ${tf}`;
        },
    },
    {
        name: 'timeframe mid-drag',
        weight: 1,
        run: async (page, r) => {
            const { y } = await somewhereOnChart(page, r);
            const [x0, x1] = inside(await chartBox(page), 400);
            const tf = pick(r, TIMEFRAMES);
            await page.mouse.move(x0, y);
            await page.mouse.down();
            await page.mouse.move((x0 + x1) / 2, y, { steps: 5 });

            await page.evaluate((label) => {
                (window as any).__chart.setTimeframe(label);
            }, tf);
            await page.mouse.move(x1, y, { steps: 5 });
            await page.mouse.up();
            return `timeframe ${tf} mid-drag`;
        },
    },
    {
        name: 'play/pause',
        weight: 2,
        run: async (page, r) => {
            const n = int(r, 1, 6);
            const log: string[] = [];
            for (let i = 0; i < n; i++) {
                const which = r() < 0.5 ? 'Play' : 'Pause';
                await page.getByRole('button', { name: which, exact: true }).click({ timeout: 2000 });
                await page.waitForTimeout(int(r, 0, 300));
                log.push(which);
            }
            return log.join(' ');
        },
    },
    {
        name: 'resize',
        weight: 1,
        run: async (page, r) => {
            const size = pick(r, SIZES);
            await page.setViewportSize(size);
            return `resize ${size.width}x${size.height}`;
        },
    },
    {
        name: 'clicks',
        weight: 1,
        run: async (page, r) => {
            const at = await somewhereOnChart(page, r);
            const kind = pick(r, ['click', 'dblclick', 'right'] as const);
            if (kind === 'dblclick') await page.mouse.dblclick(at.x, at.y);
            else await page.mouse.click(at.x, at.y, { button: kind === 'right' ? 'right' : 'left' });
            if (kind === 'right') await page.keyboard.press('Escape');
            return kind;
        },
    },
    {
        name: 'keys',
        weight: 1,
        run: async (page, r) => {
            const key = pick(r, ['Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-', 'Delete']);
            await page.keyboard.press(key);
            return `key ${key}`;
        },
    },
    {
        name: 'wait',
        weight: 2,
        run: async (page, r) => {
            const ms = int(r, 50, 1500);
            await page.waitForTimeout(ms);
            return `wait ${ms}`;
        },
    },
];

const TOTAL = ACTIONS.reduce((s, a) => s + a.weight, 0);
function nextAction(r: Rand) {
    let x = r() * TOTAL;
    for (const a of ACTIONS) if ((x -= a.weight) < 0) return a;
    return ACTIONS[0];
}

for (const seed of SEEDS) {
    test(`monkey seed ${seed}`, async ({ page }) => {
        const r = mulberry32(seed);
        const url = pick(r, URLS);
        const errors = watchErrors(page);
        const log: string[] = [`goto ${url}`];
        const fail = (why: string) =>
            `${why}\nseed ${seed}, replay with MONKEY_SEED=${seed}\nlast actions:\n  ${log.slice(-25).join('\n  ')}`;

        await page.goto(url);
        await settled(page);

        const until = Date.now() + RUN_MS;
        for (let step = 0; Date.now() < until; step++) {
            const action = nextAction(r);
            try {
                log.push(await action.run(page, r));
            } catch (err) {
                // a control thats off screen at phone size and the like
                log.push(`${action.name} skipped: ${(err as Error).message.split('\n')[0]}`);
            }
            expect(errors, fail('errors')).toEqual([]);
            if (step % 10 === 0) {
                const text = await page.locator('body').innerText();
                expect(text.includes('NaN'), fail('NaN on the page')).toBe(false);
            }
        }

        // whatever it did, the chart has to come back
        await page.getByRole('button', { name: 'Pause', exact: true }).click();
        await settled(page, 40_000).catch(() => {
            throw new Error(fail('never finished loading'));
        });
        expect(await drawsSomething(page), fail('blank chart at the end')).toBe(true);
        expect(errors, fail('errors')).toEqual([]);
    });
}
