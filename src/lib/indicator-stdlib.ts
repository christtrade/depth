// indicator helpers, with three consumers now. compiled plugins import them
// normally. scripted plugins get each one as a named property on the sandbox
// scope, so a user calls sma() or ema() inside init/update/draw as if it were a
// global - no string injection, no eval of source. and the strategy runner
// bundles STDLIB server-side, which is why the imports below matter: this module
// has to stay reachable from a non-DOM bundle.
//
// so keep every import here `import type` unless the value is genuinely needed
// at runtime (luxon is), and never import from the '../core' barrel - pulling
// the barrel in for a type drags the entire chart core into a server bundle.
// the executeDrawCommands half of this file does touch canvas, but only from
// inside function bodies that a server never calls, so it tree-shakes out.
//
// to add a helper: write it here with no imports and no module-level closures,
// add it to STDLIB at the bottom, then add a line to buildScope in the worker.

import { DateTime } from 'luxon';

import type { LiveTransformer } from '../interfaces/ICoordinateTransformer';
import type { RenderContext } from './types/indicator-types';
// Types
export interface OhlcvBar {
    ts: bigint;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

type Series = number[] | OhlcvBar[];

function resolveValues(series: Series, getValue?: (b: OhlcvBar) => number): number[] {
    if (!series.length) return [];
    if (typeof series[0] === 'number') return series as number[];
    return (series as OhlcvBar[]).map(getValue ?? ((b) => b.close));
}

// Moving averages
export function sma(series: Series, period: number, getValue?: (b: OhlcvBar) => number): number[] {
    const vals = resolveValues(series, getValue);
    const out: number[] = new Array(vals.length);
    let sum = 0;
    let count = 0;
    for (let i = 0; i < vals.length; i++) {
        const val = vals[i];
        if (!isNaN(val)) {
            sum += val;
            count++;
        }
        if (i >= period) {
            const old = vals[i - period];
            if (!isNaN(old)) {
                sum -= old;
                count--;
            }
        }
        out[i] = count >= period ? sum / period : NaN;
    }
    return out;
}
export function ema(series: Series, period: number, getValue?: (b: OhlcvBar) => number): number[] {
    const vals = resolveValues(series, getValue);
    const k = 2 / (period + 1);
    const out: number[] = new Array(vals.length);
    let prev = NaN;
    for (let i = 0; i < vals.length; i++) {
        const v = vals[i];
        prev = isNaN(prev) ? v : v * k + prev * (1 - k);
        out[i] = prev;
    }
    return out;
}

export function wma(series: Series, period: number, getValue?: (b: OhlcvBar) => number): number[] {
    const vals = resolveValues(series, getValue);
    const out: number[] = new Array(vals.length).fill(NaN);
    const denom = (period * (period + 1)) / 2;
    for (let i = period - 1; i < vals.length; i++) {
        let s = 0;
        for (let j = 0; j < period; j++) s += vals[i - j] * (period - j);
        out[i] = s / denom;
    }
    return out;
}

export function hma(series: Series, period: number, getValue?: (b: OhlcvBar) => number): number[] {
    const vals = resolveValues(series, getValue);
    const half = Math.floor(period / 2);
    const sqrtP = Math.round(Math.sqrt(period));
    const w1 = wma(vals, half);
    const w2 = wma(vals, period);
    const diff = vals.map((_, i) => 2 * w1[i] - w2[i]);
    return wma(diff, sqrtP);
}

export function rma(series: Series, period: number, getValue?: (b: OhlcvBar) => number): number[] {
    const vals = resolveValues(series, getValue);
    const out: number[] = new Array(vals.length).fill(NaN);
    let prev = NaN;
    for (let i = 0; i < vals.length; i++) {
        const v = vals[i];
        if (isNaN(prev)) {
            if (i < period - 1) continue;
            let s = 0;
            for (let j = i - period + 1; j <= i; j++) s += vals[j];
            prev = s / period;
            out[i] = prev;
        } else {
            prev = (prev * (period - 1) + v) / period;
            out[i] = prev;
        }
    }
    return out;
}

export function linreg(
    series: Series,
    period: number,
    getValue?: (b: OhlcvBar) => number,
): number[] {
    const vals = resolveValues(series, getValue);
    const out: number[] = new Array(vals.length).fill(NaN);
    for (let i = period - 1; i < vals.length; i++) {
        let sx = 0,
            sy = 0,
            sxy = 0,
            sx2 = 0;
        for (let j = 0; j < period; j++) {
            const x = j,
                y = vals[i - (period - 1 - j)];
            sx += x;
            sy += y;
            sxy += x * y;
            sx2 += x * x;
        }
        const n = period;
        const slope = (n * sxy - sx * sy) / (n * sx2 - sx * sx);
        out[i] = (sy - slope * sx) / n + slope * (period - 1);
    }
    return out;
}

// Oscillators & momentum
export function rsi(bars: OhlcvBar[], period = 14): number[] {
    const n = bars.length;
    if (n === 0) return [];
    const gains: number[] = new Array(n);
    const losses: number[] = new Array(n);
    gains[0] = 0;
    losses[0] = 0;
    for (let i = 1; i < n; i++) {
        const d = bars[i].close - bars[i - 1].close;
        gains[i] = d > 0 ? d : 0;
        losses[i] = d < 0 ? -d : 0;
    }
    const ag = rma(gains, period);
    const al = rma(losses, period);
    const out: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
        out[i] = isNaN(ag[i]) ? NaN : al[i] === 0 ? 100 : 100 - 100 / (1 + ag[i] / al[i]);
    }
    return out;
}

export function stoch(
    bars: OhlcvBar[],
    kPeriod = 14,
    dPeriod = 3,
    smooth = 3,
): { k: number[]; d: number[] } {
    function _rollingMean(series: number[], period: number): number[] {
        const out: number[] = new Array(series.length).fill(NaN);
        let sum = 0,
            count = 0;
        for (let i = 0; i < series.length; i++) {
            if (!isNaN(series[i])) {
                sum += series[i];
                count++;
            }
            if (i >= period && !isNaN(series[i - period])) {
                sum -= series[i - period];
                count--;
            }
            out[i] = count > 0 ? sum / count : NaN;
        }
        return out;
    }

    const n = bars.length;
    const his = highest(
        bars.map((b) => b.high),
        kPeriod,
    );
    const los = lowest(
        bars.map((b) => b.low),
        kPeriod,
    );
    const rawK: number[] = new Array(n).fill(NaN);
    for (let i = kPeriod - 1; i < n; i++) {
        const hi = his[i];
        const lo = los[i];
        rawK[i] = hi === lo ? 50 : ((bars[i].close - lo) / (hi - lo)) * 100;
    }
    const k = _rollingMean(rawK, smooth);
    return { k, d: _rollingMean(k, dPeriod) };
}

export function macd(
    bars: OhlcvBar[],
    fast = 12,
    slow = 26,
    signal = 9,
): { macd: number[]; signal: number[]; histogram: number[] } {
    const fe = ema(bars, fast);
    const se = ema(bars, slow);
    const n = bars.length;
    const ml: number[] = new Array(n);
    for (let i = 0; i < n; i++) ml[i] = fe[i] - se[i];
    const sl = ema(ml, signal);
    const histogram: number[] = new Array(n);
    for (let i = 0; i < n; i++) histogram[i] = ml[i] - sl[i];
    return { macd: ml, signal: sl, histogram };
}

export function atr(bars: OhlcvBar[], period = 14): number[] {
    return rma(tr(bars), period);
}

export function tr(bars: OhlcvBar[]): number[] {
    const n = bars.length;
    const out: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
        const b = bars[i];
        if (i === 0) {
            out[i] = b.high - b.low;
            continue;
        }
        const prevClose = bars[i - 1].close;
        out[i] = Math.max(
            b.high - b.low,
            Math.abs(b.high - prevClose),
            Math.abs(b.low - prevClose),
        );
    }
    return out;
}

// Cross & logic
export function crossover(a: number[], b: number[] | number): boolean[] {
    const bv = Array.isArray(b) ? b : new Array(a.length).fill(b);
    return a.map((v, i) => i > 0 && v > bv[i] && a[i - 1] <= bv[i - 1]);
}

export function crossunder(a: number[], b: number[] | number): boolean[] {
    const bv = Array.isArray(b) ? b : new Array(a.length).fill(b);
    return a.map((v, i) => i > 0 && v < bv[i] && a[i - 1] >= bv[i - 1]);
}

export function cross(a: number[], b: number[] | number): boolean[] {
    const ov = crossover(a, b),
        un = crossunder(a, b);
    return ov.map((v, i) => v || un[i]);
}

export function rising(series: number[], lookback = 1): boolean[] {
    return series.map((_, i) => {
        if (i < lookback) return false;
        for (let j = 1; j <= lookback; j++) if (series[i - j + 1] <= series[i - j]) return false;
        return true;
    });
}

export function falling(series: number[], lookback = 1): boolean[] {
    return series.map((_, i) => {
        if (i < lookback) return false;
        for (let j = 1; j <= lookback; j++) if (series[i - j + 1] >= series[i - j]) return false;
        return true;
    });
}

export function change(series: number[], length = 1): number[] {
    return series.map((v, i) => (i < length ? NaN : v - series[i - length]));
}

export function barssince(condition: boolean[]): number[] {
    let last = NaN;
    return condition.map((c, i) => {
        if (c) {
            last = i;
            return 0;
        }
        return isNaN(last) ? NaN : i - last;
    });
}

export function valuewhen(condition: boolean[], series: number[], occurrence = 0): number[] {
    const hits: number[] = [];
    return condition.map((c, i) => {
        if (c) hits.push(i);
        const idx = hits.length - 1 - occurrence;
        return idx >= 0 ? series[hits[idx]] : NaN;
    });
}

// High / low
// Monotonic-deque window extremes: each index is pushed and popped at most
// once, so these are O(n) rather than O(n * length). NaNs never enter the
// deque, which keeps them out of the result unless the whole window is NaN.
function _windowExtreme(series: number[], length: number, wantMax: boolean): number[] {
    const n = series.length;
    const out: number[] = new Array(n).fill(NaN);
    const deque: number[] = new Array(n);
    let head = 0;
    let tail = 0;
    for (let i = 0; i < n; i++) {
        const v = series[i];
        if (!isNaN(v)) {
            while (tail > head) {
                const back = series[deque[tail - 1]];
                if (wantMax ? back <= v : back >= v) tail--;
                else break;
            }
            deque[tail++] = i;
        }
        while (tail > head && deque[head] <= i - length) head++;
        if (i >= length - 1) {
            out[i] = tail > head ? series[deque[head]] : wantMax ? -Infinity : Infinity;
        }
    }
    return out;
}

export function highest(series: number[], length: number): number[] {
    return _windowExtreme(series, length, true);
}

export function lowest(series: number[], length: number): number[] {
    return _windowExtreme(series, length, false);
}

export function pivotHigh(bars: OhlcvBar[], left = 5, right = 5): number[] {
    const n = bars.length,
        out: number[] = new Array(n).fill(NaN);
    for (let i = left; i < n - right; i++) {
        const v = bars[i].high;
        let ok = true;
        for (let j = i - left; j <= i + right; j++)
            if (j !== i && bars[j].high >= v) {
                ok = false;
                break;
            }
        if (ok) out[i] = v;
    }
    return out;
}

export function pivotLow(bars: OhlcvBar[], left = 5, right = 5): number[] {
    const n = bars.length,
        out: number[] = new Array(n).fill(NaN);
    for (let i = left; i < n - right; i++) {
        const v = bars[i].low;
        let ok = true;
        for (let j = i - left; j <= i + right; j++)
            if (j !== i && bars[j].low <= v) {
                ok = false;
                break;
            }
        if (ok) out[i] = v;
    }
    return out;
}

// Volatility & channels
export function bb(
    bars: OhlcvBar[],
    period = 20,
    mult = 2,
    getValue: (b: OhlcvBar) => number = (b) => b.close,
): { upper: number[]; mid: number[]; lower: number[] } {
    const n = bars.length;
    const mid: number[] = new Array(n).fill(NaN);
    const upper: number[] = new Array(n).fill(NaN);
    const lower: number[] = new Array(n).fill(NaN);
    const vals: number[] = new Array(n);
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
        const v = getValue(bars[i]);
        vals[i] = v;
        sum += v;
        sumSq += v * v;
        if (i >= period) {
            const old = vals[i - period];
            sum -= old;
            sumSq -= old * old;
        }
        if (i >= period - 1) {
            const m = sum / period;
            const sd = Math.sqrt(Math.max(0, sumSq / period - m * m));
            mid[i] = m;
            upper[i] = m + mult * sd;
            lower[i] = m - mult * sd;
        }
    }
    return { upper, mid, lower };
}

export function bbw(bars: OhlcvBar[], period = 20, mult = 2): number[] {
    const { upper, mid, lower } = bb(bars, period, mult);
    return mid.map((m, i) => (isNaN(m) || m === 0 ? NaN : (upper[i] - lower[i]) / m));
}

export function donchian(
    bars: OhlcvBar[],
    period = 20,
): { upper: number[]; mid: number[]; lower: number[] } {
    const upper = highest(
        bars.map((b) => b.high),
        period,
    );
    const lower = lowest(
        bars.map((b) => b.low),
        period,
    );
    return { upper, mid: upper.map((u, i) => (u + lower[i]) / 2), lower };
}

export function keltner(
    bars: OhlcvBar[],
    emaPeriod = 20,
    atrPeriod = 10,
    mult = 1.5,
): { upper: number[]; mid: number[]; lower: number[] } {
    const mid = ema(bars, emaPeriod);
    const a = atr(bars, atrPeriod);
    return {
        upper: mid.map((m, i) => m + mult * a[i]),
        mid,
        lower: mid.map((m, i) => m - mult * a[i]),
    };
}

export function vwap(bars: OhlcvBar[], sessionStartHour = 0): number[] {
    const out: number[] = new Array(bars.length).fill(NaN);
    const DAY_MS = 86_400_000;
    let cumPV = 0,
        cumV = 0,
        lastDay = NaN;
    for (let i = 0; i < bars.length; i++) {
        const ms = Number(bars[i].ts / 1_000_000n);
        const day = Math.floor((ms - sessionStartHour * 3_600_000) / DAY_MS);
        if (day !== lastDay) {
            cumPV = 0;
            cumV = 0;
            lastDay = day;
        }
        const tp = (bars[i].high + bars[i].low + bars[i].close) / 3;
        cumPV += tp * bars[i].volume;
        cumV += bars[i].volume;
        out[i] = cumV === 0 ? NaN : cumPV / cumV;
    }
    return out;
}

export function alligator(bars: OhlcvBar[]): { jaw: number[]; teeth: number[]; lips: number[] } {
    const hl2 = bars.map((b) => (b.high + b.low) / 2);
    return { jaw: sma(hl2, 13), teeth: sma(hl2, 8), lips: sma(hl2, 5) };
}

// Statistical
export function stdev(
    series: Series,
    period: number,
    getValue?: (b: OhlcvBar) => number,
): number[] {
    const vals = resolveValues(series, getValue);
    const n = vals.length;
    const out: number[] = new Array(n).fill(NaN);
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
        sum += vals[i];
        sumSq += vals[i] * vals[i];
        if (i >= period) {
            sum -= vals[i - period];
            sumSq -= vals[i - period] * vals[i - period];
        }
        if (i >= period - 1) {
            const mean = sum / period;
            out[i] = Math.sqrt(Math.max(0, sumSq / period - mean * mean));
        }
    }
    return out;
}

export function variance(
    series: Series,
    period: number,
    getValue?: (b: OhlcvBar) => number,
): number[] {
    return stdev(series, period, getValue).map((v) => v * v);
}

export function dev(series: number[], period: number): number[] {
    function _rollingMean(series: number[], period: number): number[] {
        const out: number[] = new Array(series.length).fill(NaN);
        let sum = 0,
            count = 0;
        for (let i = 0; i < series.length; i++) {
            if (!isNaN(series[i])) {
                sum += series[i];
                count++;
            }
            if (i >= period && !isNaN(series[i - period])) {
                sum -= series[i - period];
                count--;
            }
            out[i] = count > 0 ? sum / count : NaN;
        }
        return out;
    }

    const means = _rollingMean(series, period);
    return series.map((v, i) => Math.abs(v - means[i]));
}

export function correlation(a: number[], b: number[], period: number): number[] {
    const out: number[] = new Array(a.length).fill(NaN);
    let sa = 0;
    let sb = 0;
    for (let i = 0; i < a.length; i++) {
        sa += a[i];
        sb += b[i];
        if (i >= period) {
            sa -= a[i - period];
            sb -= b[i - period];
        }
        if (i < period - 1) continue;
        const ma = sa / period;
        const mb = sb / period;
        let num = 0,
            da2 = 0,
            db2 = 0;
        for (let j = i - period + 1; j <= i; j++) {
            const da = a[j] - ma,
                db = b[j] - mb;
            num += da * db;
            da2 += da * da;
            db2 += db * db;
        }
        const denom = Math.sqrt(da2 * db2);
        out[i] = denom === 0 ? 0 : num / denom;
    }
    return out;
}

export const max = highest;
export const min = lowest;

export function median(series: number[], period: number): number[] {
    const out: number[] = new Array(series.length).fill(NaN);
    for (let i = period - 1; i < series.length; i++) {
        const s = series.slice(i - period + 1, i + 1).sort((a, b) => a - b);
        const m = Math.floor(period / 2);
        out[i] = period % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
    }
    return out;
}

// Series utilities
/**
 * toPoints(bars, values)
 *
 * Zips a bar array with a computed number[] into plot-ready { t, price } points.
 * Automatically filters NaN/Infinity. This is what draw() iterates over.
 *
 *   const pts = toPoints(data.ohlcv, sma(data.ohlcv, 20))
 */
export function toPoints(
    timestamps: bigint[],
    values: number[],
): Array<{ t: bigint; price: number }> {
    const out: Array<{ t: bigint; price: number }> = [];
    for (let i = 0; i < timestamps.length && i < values.length; i++) {
        if (!isNaN(values[i]) && isFinite(values[i]))
            out.push({ t: timestamps[i], price: values[i] });
    }
    return out;
}

export function last<T>(arr: T[]): T | undefined {
    return arr[arr.length - 1];
}

/** nz(value, replacement) - replace NaN/undefined/null with replacement (default 0). */
export function nz(value: number | undefined | null, replacement = 0): number {
    return value == null || isNaN(value as number) ? replacement : (value as number);
}

// Draw command types
//
// draw() runs in the script worker and returns an array of these plain objects.
// The main thread executor (executeDrawCommands in ScriptedPlugin.ts) converts
// them to actual canvas operations using the live transformer.
//
// Timestamps (t, x) are stored as bigint for precision. The executor converts
// them to pixels at paint time, so pan/zoom redraws are instant - no worker
// round-trip needed.

export type DrawCommand =
    | {
          type: 'line';
          pts: Array<{ t: bigint; price: number }>;
          /** Uniform color string, or one color per point (segment i uses color[i]). */
          color: string | string[];
          width: number;
          dash?: number[];
          connect?: boolean;
      }
    | {
          type: 'hline';
          price: number;
          color: string;
          width: number;
          dash?: number[];
      }
    | {
          type: 'histogram';
          pts: Array<{ t: bigint; price: number }>;
          /** Uniform color string, or one color per bar. */
          color: string | string[];
          base?: number;
          gap?: number;
      }
    | {
          type: 'label';
          text: string;
          /** bigint timestamp when anchored to price space, number when anchored to screen */
          x: bigint | number;
          y: number;
          color: string;
          fontSize?: number;
          bold?: boolean;
          horzAlign?: 'left' | 'right' | 'center';
          vertAlign?: 'bottom' | 'middle' | 'top';
          /** true = x/y are raw screen pixels, false = x is ts, y is price */
          anchored?: boolean;
          maxWidth?: number;
      }
    | {
          type: 'fill';
          pts1: Array<{ t: bigint; price: number }> | number;
          pts2: Array<{ t: bigint; price: number }> | number;
          opts: FillBetweenOpts;
      }
    | {
          /** Axis-aligned price-space rectangle anchored to two timestamps + two prices */
          type: 'rect';
          t1: bigint;
          t2: bigint;
          price1: number;
          price2: number;
          fillColor?: string;
          borderColor?: string;
          borderWidth?: number;
          dash?: number[];
          radius?: number;
      }
    | {
          /** Circle drawn at a price/time point */
          type: 'circle';
          t: bigint;
          price: number;
          radius: number;
          fillColor?: string;
          borderColor?: string;
          borderWidth?: number;
      }
    | {
          /** Vertical line at a fixed timestamp spanning the full pane height */
          type: 'vline';
          t: bigint;
          color: string;
          width: number;
          dash?: number[];
      }
    | {
          /** Arrow / marker pointing up or down at a price/time point */
          type: 'arrow';
          t: bigint;
          price: number;
          direction: 'up' | 'down';
          color: string;
          size?: number;
          label?: string;
          labelColor?: string;
      }
    | {
          /** Trend line between two price/time anchors - infinite extension optional */
          type: 'trendline';
          t1: bigint;
          price1: number;
          t2: bigint;
          price2: number;
          color: string;
          width?: number;
          dash?: number[];
          extend?: 'none' | 'right' | 'both';
      }
    | {
          /** Horizontal band between two prices - like fillBetween but dead simple */
          type: 'band';
          priceHigh: number;
          priceLow: number;
          fillColor: string;
          borderColor?: string;
          borderWidth?: number;
      }
    | {
          /** Multi-point polygon in price/time space, filled and/or stroked */
          type: 'polygon';
          pts: Array<{ t: bigint; price: number }>;
          fillColor?: string;
          borderColor?: string;
          borderWidth?: number;
          dash?: number[];
      }
    | {
          /** Dotted/painted series - individual dots at each point */
          type: 'dots';
          pts: Array<{ t: bigint; price: number }>;
          /** Uniform color string, or one color per dot. */
          color: string | string[];
          radius?: number;
      }
    | {
          /** Text box with background pill - like a label but with a background */
          type: 'badge';
          t: bigint;
          price: number;
          text: string;
          textColor: string;
          bgColor: string;
          fontSize?: number;
          padding?: number;
          radius?: number;
          anchored?: boolean;
      };

// Draw command builders
// Called by the user inside draw(state). Return plain objects - no canvas touch.

/**
 * drawLine(pts, color, width, dash?, connect?)
 *
 * Draws a line connecting { t: bigint, price: number } points.
 * Gaps in the line are inserted automatically at bar boundaries unless connect=true.
 */
export function drawLine(
    pts: Array<{ t: bigint; price: number }>,
    color: string | string[],
    width: number,
    dash: number[] = [],
    connect = false,
): DrawCommand {
    return { type: 'line', pts, color, width, dash, connect };
}

/**
 * drawHLine(price, color, width, dash?)
 *
 * Draws a horizontal line at a fixed price level spanning the full pane width.
 */
export function drawHLine(
    price: number,
    color: string,
    width: number,
    dash: number[] = [],
): DrawCommand {
    return { type: 'hline', price, color, width, dash };
}

/**
 * drawHistogram(pts, color, base?, gap?)
 *
 * Draws a bar histogram. Each point { t, price } is one bar.
 * base = the zero line price (default 0).
 * gap = fraction of bar width left as spacing (default 0.2).
 */
export function drawHistogram(
    pts: Array<{ t: bigint; price: number }>,
    color: string | string[],
    base = 0,
    gap = 0.2,
): DrawCommand {
    return { type: 'histogram', pts, color, base, gap };
}

/**
 * drawLabel(text, x, y, color, fontSize?, bold?, horzAlign?, vertAlign?, anchored?, maxWidth?)
 *
 * anchored=false (default): x is a bigint timestamp, y is a price value.
 * anchored=true:            x and y are raw screen pixel coordinates.
 */
export function drawLabel(
    text: string,
    x: bigint | number,
    y: number,
    color: string,
    fontSize = 12,
    bold = false,
    horzAlign: 'left' | 'right' | 'center' = 'left',
    vertAlign: 'bottom' | 'middle' | 'top' = 'middle',
    anchored = false,
    maxWidth = 99999,
): DrawCommand {
    return {
        type: 'label',
        text,
        x,
        y,
        color,
        fontSize,
        bold,
        horzAlign,
        vertAlign,
        anchored,
        maxWidth,
    };
}

export type FillBetweenOpts =
    | { mode: 'solid'; color: string }
    | { mode: 'screen'; stops: Array<{ offset: number; color: string }> }
    | { mode: 'vertical'; stops: Array<{ price: number; color: string }> }
    | { mode: 'data'; stops: Array<{ offset: number; color: string }> };

/**
 * fillBetween(pts1, pts2, opts)
 *
 * Fills the region between two price series (or between a series and a flat price).
 * pts1 / pts2 can each be Array<{t,price}> or a plain number (flat level).
 * opts.mode: 'solid' | 'screen' | 'vertical' | 'data'  (same API as before)
 */
export function fillBetween(
    pts1: Array<{ t: bigint; price: number }> | number,
    pts2: Array<{ t: bigint; price: number }> | number,
    opts: FillBetweenOpts,
): DrawCommand {
    return { type: 'fill', pts1, pts2, opts };
}

/**
 * drawRect(t1, price1, t2, price2, opts?)
 *
 * Draws a rectangle anchored to two timestamps and two price levels.
 * Useful for highlighting ranges, supply/demand zones, etc.
 */
export function drawRect(
    t1: bigint,
    price1: number,
    t2: bigint,
    price2: number,
    opts: {
        fillColor?: string;
        borderColor?: string;
        borderWidth?: number;
        dash?: number[];
        radius?: number;
    } = {},
): DrawCommand {
    return { type: 'rect', t1, t2, price1, price2, ...opts };
}

/**
 * drawCircle(t, price, radius, opts?)
 *
 * Draws a circle at a price/time point. radius is in pixels.
 */
export function drawCircle(
    t: bigint,
    price: number,
    radius: number,
    opts: { fillColor?: string; borderColor?: string; borderWidth?: number } = {},
): DrawCommand {
    return { type: 'circle', t, price, radius, ...opts };
}

/**
 * drawVLine(t, color, width, dash?)
 *
 * Draws a vertical line at a fixed timestamp spanning the full pane height.
 * Great for marking events, session opens, etc.
 */
export function drawVLine(t: bigint, color: string, width = 1, dash: number[] = []): DrawCommand {
    return { type: 'vline', t, color, width, dash };
}

/**
 * drawArrow(t, price, direction, color, size?, label?, labelColor?)
 *
 * Draws an up or down arrow marker at a price/time point.
 * Optionally attach a text label above/below the arrow.
 */
export function drawArrow(
    t: bigint,
    price: number,
    direction: 'up' | 'down',
    color: string,
    size = 10,
    label = '',
    labelColor = '',
): DrawCommand {
    return {
        type: 'arrow',
        t,
        price,
        direction,
        color,
        size,
        label,
        labelColor: labelColor || color,
    };
}

/**
 * drawTrendLine(t1, price1, t2, price2, color, width?, dash?, extend?)
 *
 * Draws a line between two anchors. extend='right' continues to the right edge,
 * extend='both' extends in both directions.
 */
export function drawTrendLine(
    t1: bigint,
    price1: number,
    t2: bigint,
    price2: number,
    color: string,
    width = 1,
    dash: number[] = [],
    extend: 'none' | 'right' | 'both' = 'none',
): DrawCommand {
    return { type: 'trendline', t1, price1, t2, price2, color, width, dash, extend };
}

/**
 * drawBand(priceHigh, priceLow, fillColor, borderColor?, borderWidth?)
 *
 * Draws a horizontal price band across the full pane width.
 * Simpler than fillBetween - just two price levels.
 */
export function drawBand(
    priceHigh: number,
    priceLow: number,
    fillColor: string,
    borderColor = '',
    borderWidth = 1,
): DrawCommand {
    return { type: 'band', priceHigh, priceLow, fillColor, borderColor, borderWidth };
}

/**
 * drawPolygon(pts, opts?)
 *
 * Draws a closed polygon through a series of price/time points.
 */
export function drawPolygon(
    pts: Array<{ t: bigint; price: number }>,
    opts: {
        fillColor?: string;
        borderColor?: string;
        borderWidth?: number;
        dash?: number[];
    } = {},
): DrawCommand {
    return { type: 'polygon', pts, ...opts };
}

/**
 * drawDots(pts, color, radius?)
 *
 * Draws a filled circle at each point in the series.
 * Good for scatter plots, signal markers, etc.
 */
export function drawDots(
    pts: Array<{ t: bigint; price: number }>,
    color: string | string[],
    radius = 3,
): DrawCommand {
    return { type: 'dots', pts, color, radius };
}

/**
 * drawBadge(t, price, text, textColor, bgColor, opts?)
 *
 * Draws a pill-shaped text badge anchored to a price/time point.
 * Great for labeling signals, patterns, indicator values etc.
 */
export function drawBadge(
    t: bigint,
    price: number,
    text: string,
    textColor: string,
    bgColor: string,
    opts: { fontSize?: number; padding?: number; radius?: number; anchored?: boolean } = {},
): DrawCommand {
    return { type: 'badge', t, price, text, textColor, bgColor, ...opts };
}

// Draw command executor
//
// Runs on the main thread inside ScriptedPlugin's drawBase().
// Translates DrawCommand[] -> actual canvas calls using the live transformer.
// This is the only place that touches CanvasRenderingContext2D.

export function executeDrawCommands(commands: DrawCommand[], renderCtx: RenderContext): void {
    const { ctx: canvas, rect, tMin, tMax, barNs, transformer } = renderCtx;

    for (const cmd of commands) {
        switch (cmd.type) {
            case 'line':
                _execLine(cmd, canvas, rect, tMin, tMax, barNs, transformer);
                break;
            case 'hline':
                _execHLine(cmd, canvas, rect, transformer);
                break;
            case 'histogram':
                _execHistogram(cmd, canvas, rect, tMin, tMax, barNs, transformer);
                break;
            case 'label':
                _execLabel(cmd, canvas, rect, transformer);
                break;
            case 'fill':
                _execFill(cmd, canvas, rect, tMin, tMax, barNs, transformer);
                break;
            case 'rect':
                _execRect(cmd, canvas, rect, transformer);
                break;
            case 'circle':
                _execCircle(cmd, canvas, rect, transformer);
                break;
            case 'vline':
                _execVLine(cmd, canvas, rect, transformer);
                break;
            case 'arrow':
                _execArrow(cmd, canvas, rect, transformer);
                break;
            case 'trendline':
                _execTrendLine(cmd, canvas, rect, tMin, tMax, transformer);
                break;
            case 'band':
                _execBand(cmd, canvas, rect, transformer);
                break;
            case 'polygon':
                _execPolygon(cmd, canvas, rect, transformer);
                break;
            case 'dots':
                _execDots(cmd, canvas, rect, tMin, tMax, transformer);
                break;
            case 'badge':
                _execBadge(cmd, canvas, rect, transformer);
                break;
        }
    }
}

// Executors
function _execLine(
    cmd: Extract<DrawCommand, { type: 'line' }>,
    canvas: CanvasRenderingContext2D,
    rect: { x: number; y: number; w: number; h: number },
    tMin: bigint,
    tMax: bigint,
    barNs: bigint,
    transformer: LiveTransformer,
): void {
    const { pts, color, width, dash = [], connect = false } = cmd;
    if (pts.length === 0) return;

    const tsToX = transformer.makeTsToXFn(rect.w);
    const priceToY = transformer.makePriceToYFn(rect.h);

    let startIdx = 0;
    {
        let lo = 0,
            hi = pts.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            if (pts[mid].t < tMin) lo = mid + 1;
            else hi = mid - 1;
        }
        startIdx = lo > 0 ? lo - 1 : 0;
    }

    canvas.save();
    canvas.lineWidth = width;
    canvas.setLineDash(dash);
    canvas.lineJoin = 'round';

    const perPoint = Array.isArray(color);
    let currentColor: string = perPoint ? '' : (color as string);
    if (!perPoint) canvas.strokeStyle = currentColor;

    canvas.beginPath();
    let inPath = false;
    let prevX = 0,
        prevY = 0,
        hasPrev = false;

    for (let i = startIdx; i < pts.length; i++) {
        const t = pts[i].t;
        if (t > tMax) break;
        const price = pts[i].price;

        // NaN gap - break the path
        if (isNaN(price) && !connect) {
            if (inPath) {
                canvas.stroke();
                canvas.beginPath();
                inPath = false;
            }
            hasPrev = false;
            continue;
        }

        const x = tsToX(t);
        const y = priceToY(price);
        const c = perPoint
            ? (color as string[])[Math.min(i, (color as string[]).length - 1)]
            : currentColor;
        const isBarGap =
            !connect &&
            barNs > 0n &&
            i < pts.length - 1 &&
            t % barNs === 0n &&
            pts[i + 1].t > t + barNs;

        if (perPoint && c !== currentColor) {
            // Color changed: stroke current path, restart.
            // Overlap by one point so the join between color runs is seamless.
            if (inPath) {
                canvas.stroke();
                canvas.beginPath();
            }
            canvas.strokeStyle = c;
            currentColor = c;
            if (hasPrev && !isBarGap) {
                canvas.moveTo(prevX, prevY);
                canvas.lineTo(x, y);
            } else {
                canvas.moveTo(x, y);
            }
            inPath = true;
        } else if (isBarGap) {
            // Bar gap: end current run, position at this point for next segment
            if (inPath) {
                canvas.stroke();
                canvas.beginPath();
            }
            canvas.moveTo(x, y);
            inPath = true;
        } else if (!inPath) {
            canvas.moveTo(x, y);
            inPath = true;
        } else {
            canvas.lineTo(x, y);
        }

        prevX = x;
        prevY = y;
        hasPrev = true;
    }

    if (inPath) canvas.stroke();
    canvas.restore();
}

function _execHLine(
    cmd: Extract<DrawCommand, { type: 'hline' }>,
    canvas: CanvasRenderingContext2D,
    rect: { w: number; h: number },
    transformer: LiveTransformer,
): void {
    const { price, color, width, dash = [] } = cmd;
    const y = transformer.priceToY(price, rect.h);
    canvas.save();
    canvas.strokeStyle = color;
    canvas.lineWidth = width;
    canvas.setLineDash(dash);
    canvas.lineJoin = 'round';
    canvas.beginPath();
    canvas.moveTo(0, y);
    canvas.lineTo(rect.w, y);
    canvas.stroke();
    canvas.restore();
}

function _execHistogram(
    cmd: Extract<DrawCommand, { type: 'histogram' }>,
    canvas: CanvasRenderingContext2D,
    rect: { w: number; h: number },
    tMin: bigint,
    tMax: bigint,
    barNs: bigint,
    transformer: LiveTransformer,
): void {
    const { pts, color, base = 0, gap = 0.2 } = cmd;
    const tRange = Number(tMax - tMin);
    const barPx = barNs > 0n ? (Number(barNs) / tRange) * rect.w : 4;
    const bodyW = Math.max(1, Math.floor(barPx * (1 - gap)));
    const halfBody = bodyW / 2;
    const tsToX = transformer.makeTsToXFn(rect.w);
    const priceToY = transformer.makePriceToYFn(rect.h);
    const yBase = priceToY(base);
    const perPoint = Array.isArray(color);

    // Seek to the visible slice instead of walking the whole series. Skipping
    // off-screen points with `continue` still costs two BigInt compares each, so
    // the old loop scaled with history length rather than with what's on screen -
    // a 1s chart holds ~60x the points of a 1m one for the same wall-clock span,
    // which is what turned panning into a slideshow. `idx` stays absolute so
    // per-point colors keep lining up.
    const [startIdx] = _visibleRange(pts, tMin, tMax);

    canvas.save();
    if (!perPoint) canvas.fillStyle = color as string;
    for (let idx = startIdx; idx < pts.length; idx++) {
        const pt = pts[idx];
        const t = pt.t;
        if (t > tMax) break;
        if (t < tMin) continue;
        if (perPoint)
            canvas.fillStyle = (color as string[])[Math.min(idx, (color as string[]).length - 1)];
        const x = tsToX(t);
        const yPrice = priceToY(pt.price);
        const yTop = Math.min(yBase, yPrice);
        const h = Math.abs(yPrice - yBase);
        canvas.fillRect(x - halfBody, yTop, bodyW, h);
    }
    canvas.restore();
}

function _execLabel(
    cmd: Extract<DrawCommand, { type: 'label' }>,
    canvas: CanvasRenderingContext2D,
    rect: { w: number; h: number },
    transformer: LiveTransformer,
): void {
    const {
        text,
        x,
        y,
        color,
        fontSize = 12,
        bold = false,
        horzAlign = 'left',
        vertAlign = 'middle',
        anchored = false,
        maxWidth = 99999,
    } = cmd;
    canvas.save();
    canvas.fillStyle = color;
    canvas.font = `${bold ? 'bold ' : ''}${fontSize}px "Inter", system-ui, sans-serif`;
    canvas.textBaseline = vertAlign;
    canvas.textAlign = horzAlign;
    if (anchored) {
        canvas.fillText(text, x as number, y, maxWidth);
    } else {
        canvas.fillText(
            text,
            transformer.tsToX(BigInt(x), rect.w),
            transformer.priceToY(y, rect.h),
            maxWidth,
        );
    }
    canvas.restore();
}

// fillBetween executor
function _execFill(
    cmd: Extract<DrawCommand, { type: 'fill' }>,
    canvas: CanvasRenderingContext2D,
    rect: { w: number; h: number },
    tMin: bigint,
    tMax: bigint,
    barNs: bigint,
    transformer: LiveTransformer,
): void {
    let { pts1, pts2, opts } = cmd;
    const fo = opts as FillBetweenOpts;

    // Expand flat-level shorthand
    if (typeof pts1 === 'number') pts1 = _flatSeries(pts1, tMin, tMax, barNs);
    if (typeof pts2 === 'number') pts2 = _flatSeries(pts2, tMin, tMax, barNs);
    if ((pts1 as any[]).length < 2 || (pts2 as any[]).length < 2) return;

    // Project both edges to screen space once - the path needs them, and so does
    // the 'data' gradient.
    const edge1 = _projectSlice(
        pts1 as Array<{ t: bigint; price: number }>,
        rect,
        transformer,
        tMin,
        tMax,
    );
    const edge2 = _projectSlice(
        pts2 as Array<{ t: bigint; price: number }>,
        rect,
        transformer,
        tMin,
        tMax,
    );

    // 'data' paints the band strip by strip and needs no path at all - building
    // one would be pure waste on the hot path.
    if (fo.mode === 'data') {
        _fillDataGradient(canvas, edge1, edge2, rect, fo.stops);
        return;
    }

    const path = _buildFillPath(edge1, edge2);

    canvas.save();

    if (fo.mode === 'solid') {
        canvas.fillStyle = fo.color;
        canvas.fill(path);
    } else if (fo.mode === 'screen') {
        const g = canvas.createLinearGradient(0, 0, 0, rect.h);
        for (const s of fo.stops) g.addColorStop(s.offset, s.color);
        canvas.fillStyle = g;
        canvas.fill(path);
    } else if (fo.mode === 'vertical') {
        const prices = fo.stops.map((s) => s.price);
        const pMax = Math.max(...prices),
            pMin = Math.min(...prices);
        const yTop = transformer.priceToY(pMax, rect.h);
        const yBot = transformer.priceToY(pMin, rect.h);
        const g = canvas.createLinearGradient(0, yTop, 0, yBot);
        const span = pMax - pMin;
        for (const s of fo.stops) {
            // All stops on one price collapses the span - keep the ramp legal
            // rather than letting addColorStop throw on a NaN offset.
            const offset = span > 0 ? (s.price - pMin) / span : 0;
            g.addColorStop(_clamp01(1 - offset), s.color);
        }
        canvas.fillStyle = g;
        canvas.fill(path);
    }

    canvas.restore();
}

function _execRect(
    cmd: Extract<DrawCommand, { type: 'rect' }>,
    canvas: CanvasRenderingContext2D,
    rect: { w: number; h: number },
    transformer: LiveTransformer,
): void {
    const {
        t1,
        t2,
        price1,
        price2,
        fillColor,
        borderColor,
        borderWidth = 1,
        dash = [],
        radius = 0,
    } = cmd;
    const x1 = transformer.tsToX(t1, rect.w);
    const x2 = transformer.tsToX(t2, rect.w);
    const y1 = transformer.priceToY(price1, rect.h);
    const y2 = transformer.priceToY(price2, rect.h);
    const rx = Math.min(x1, x2),
        ry = Math.min(y1, y2);
    const rw = Math.abs(x2 - x1),
        rh = Math.abs(y2 - y1);

    canvas.save();
    if (radius > 0) {
        const r = Math.min(radius, rw / 2, rh / 2);
        const path = new Path2D();
        path.roundRect(rx, ry, rw, rh, r);
        if (fillColor) {
            canvas.fillStyle = fillColor;
            canvas.fill(path);
        }
        if (borderColor) {
            canvas.strokeStyle = borderColor;
            canvas.lineWidth = borderWidth;
            canvas.setLineDash(dash);
            canvas.stroke(path);
        }
    } else {
        if (fillColor) {
            canvas.fillStyle = fillColor;
            canvas.fillRect(rx, ry, rw, rh);
        }
        if (borderColor) {
            canvas.strokeStyle = borderColor;
            canvas.lineWidth = borderWidth;
            canvas.setLineDash(dash);
            canvas.strokeRect(rx, ry, rw, rh);
        }
    }
    canvas.restore();
}

function _execCircle(
    cmd: Extract<DrawCommand, { type: 'circle' }>,
    canvas: CanvasRenderingContext2D,
    rect: { w: number; h: number },
    transformer: LiveTransformer,
): void {
    const { t, price, radius, fillColor, borderColor, borderWidth = 1 } = cmd;
    const x = transformer.tsToX(t, rect.w);
    const y = transformer.priceToY(price, rect.h);
    canvas.save();
    canvas.beginPath();
    canvas.arc(x, y, radius, 0, Math.PI * 2);
    if (fillColor) {
        canvas.fillStyle = fillColor;
        canvas.fill();
    }
    if (borderColor) {
        canvas.strokeStyle = borderColor;
        canvas.lineWidth = borderWidth;
        canvas.stroke();
    }
    canvas.restore();
}

function _execVLine(
    cmd: Extract<DrawCommand, { type: 'vline' }>,
    canvas: CanvasRenderingContext2D,
    rect: { w: number; h: number },
    transformer: LiveTransformer,
): void {
    const { t, color, width, dash = [] } = cmd;
    const x = transformer.tsToX(t, rect.w);
    canvas.save();
    canvas.strokeStyle = color;
    canvas.lineWidth = width;
    canvas.setLineDash(dash);
    canvas.beginPath();
    canvas.moveTo(x, 0);
    canvas.lineTo(x, rect.h);
    canvas.stroke();
    canvas.restore();
}

function _execArrow(
    cmd: Extract<DrawCommand, { type: 'arrow' }>,
    canvas: CanvasRenderingContext2D,
    rect: { w: number; h: number },
    transformer: LiveTransformer,
): void {
    const { t, price, direction, color, size = 10, label = '', labelColor } = cmd;
    const x = transformer.tsToX(t, rect.w);
    const y = transformer.priceToY(price, rect.h);
    const tip = direction === 'up' ? y - size * 0.5 : y + size * 0.5;
    const base = direction === 'up' ? y + size * 0.3 : y - size * 0.3;
    const half = size * 0.5;

    canvas.save();
    canvas.fillStyle = color;
    canvas.beginPath();
    if (direction === 'up') {
        canvas.moveTo(x, tip);
        canvas.lineTo(x - half, base);
        canvas.lineTo(x + half, base);
    } else {
        canvas.moveTo(x, tip);
        canvas.lineTo(x - half, base);
        canvas.lineTo(x + half, base);
    }
    canvas.closePath();
    canvas.fill();

    if (label) {
        canvas.fillStyle = labelColor ?? color;
        canvas.font = `bold ${Math.round(size * 0.9)}px "Inter", system-ui, sans-serif`;
        canvas.textAlign = 'center';
        canvas.textBaseline = direction === 'up' ? 'bottom' : 'top';
        const labelY = direction === 'up' ? tip - 3 : tip + 3;
        canvas.fillText(label, x, labelY);
    }
    canvas.restore();
}

function _execTrendLine(
    cmd: Extract<DrawCommand, { type: 'trendline' }>,
    canvas: CanvasRenderingContext2D,
    rect: { w: number; h: number },
    tMin: bigint,
    tMax: bigint,
    transformer: LiveTransformer,
): void {
    const { t1, price1, t2, price2, color, width = 1, dash = [], extend = 'none' } = cmd;
    let x1 = transformer.tsToX(t1, rect.w);
    let y1 = transformer.priceToY(price1, rect.h);
    let x2 = transformer.tsToX(t2, rect.w);
    let y2 = transformer.priceToY(price2, rect.h);

    if (extend !== 'none' && x2 !== x1) {
        const slope = (y2 - y1) / (x2 - x1);
        if (extend === 'right' || extend === 'both') {
            y2 = y1 + slope * (rect.w - x1);
            x2 = rect.w;
        }
        if (extend === 'both') {
            y1 = y1 + slope * (0 - x1);
            x1 = 0;
        }
    }

    canvas.save();
    canvas.strokeStyle = color;
    canvas.lineWidth = width;
    canvas.setLineDash(dash);
    canvas.lineJoin = 'round';
    canvas.beginPath();
    canvas.moveTo(x1, y1);
    canvas.lineTo(x2, y2);
    canvas.stroke();
    canvas.restore();
}

function _execBand(
    cmd: Extract<DrawCommand, { type: 'band' }>,
    canvas: CanvasRenderingContext2D,
    rect: { w: number; h: number },
    transformer: LiveTransformer,
): void {
    const { priceHigh, priceLow, fillColor, borderColor = '', borderWidth = 1 } = cmd;
    const yTop = transformer.priceToY(priceHigh, rect.h);
    const yBot = transformer.priceToY(priceLow, rect.h);
    canvas.save();
    if (fillColor) {
        canvas.fillStyle = fillColor;
        canvas.fillRect(0, yTop, rect.w, yBot - yTop);
    }
    if (borderColor) {
        canvas.strokeStyle = borderColor;
        canvas.lineWidth = borderWidth;
        canvas.beginPath();
        canvas.moveTo(0, yTop);
        canvas.lineTo(rect.w, yTop);
        canvas.moveTo(0, yBot);
        canvas.lineTo(rect.w, yBot);
        canvas.stroke();
    }
    canvas.restore();
}

function _execPolygon(
    cmd: Extract<DrawCommand, { type: 'polygon' }>,
    canvas: CanvasRenderingContext2D,
    rect: { w: number; h: number },
    transformer: LiveTransformer,
): void {
    const { pts, fillColor, borderColor, borderWidth = 1, dash = [] } = cmd;
    if (pts.length < 2) return;
    canvas.save();
    canvas.beginPath();
    canvas.moveTo(transformer.tsToX(pts[0].t, rect.w), transformer.priceToY(pts[0].price, rect.h));
    for (let i = 1; i < pts.length; i++) {
        canvas.lineTo(
            transformer.tsToX(pts[i].t, rect.w),
            transformer.priceToY(pts[i].price, rect.h),
        );
    }
    canvas.closePath();
    if (fillColor) {
        canvas.fillStyle = fillColor;
        canvas.fill();
    }
    if (borderColor) {
        canvas.strokeStyle = borderColor;
        canvas.lineWidth = borderWidth;
        canvas.setLineDash(dash);
        canvas.stroke();
    }
    canvas.restore();
}

function _execDots(
    cmd: Extract<DrawCommand, { type: 'dots' }>,
    canvas: CanvasRenderingContext2D,
    rect: { w: number; h: number },
    tMin: bigint,
    tMax: bigint,
    transformer: LiveTransformer,
): void {
    const { pts, color, radius = 3 } = cmd;
    if (pts.length === 0) return;
    const perPoint = Array.isArray(color);

    // Same fix as _execHistogram, and it mattered more here: the old loop ran
    // `BigInt(pt.t)` on every point in the series, allocating for points it was
    // about to discard.
    const [startIdx] = _visibleRange(pts as Array<{ t: bigint; price: number }>, tMin, tMax);

    const tsToX = transformer.makeTsToXFn(rect.w);
    const priceToY = transformer.makePriceToYFn(rect.h);

    canvas.save();
    if (!perPoint) canvas.fillStyle = color as string;
    for (let idx = startIdx; idx < pts.length; idx++) {
        const pt = pts[idx];
        const t = BigInt(pt.t);
        if (t > tMax) break;
        if (t < tMin || isNaN(pt.price)) continue;
        if (perPoint)
            canvas.fillStyle = (color as string[])[Math.min(idx, (color as string[]).length - 1)];
        const x = tsToX(t);
        const y = priceToY(pt.price);
        canvas.beginPath();
        canvas.arc(x, y, radius, 0, Math.PI * 2);
        canvas.fill();
    }
    canvas.restore();
}

function _execBadge(
    cmd: Extract<DrawCommand, { type: 'badge' }>,
    canvas: CanvasRenderingContext2D,
    rect: { w: number; h: number },
    transformer: LiveTransformer,
): void {
    const {
        t,
        price,
        text,
        textColor,
        bgColor,
        fontSize = 11,
        padding = 5,
        radius = 4,
        anchored = false,
    } = cmd;
    const x = anchored ? Number(t) : transformer.tsToX(t, rect.w);
    const y = anchored ? price : transformer.priceToY(price, rect.h);

    canvas.save();
    canvas.font = `bold ${fontSize}px "Inter", system-ui, sans-serif`;
    const tw = canvas.measureText(text).width;
    const bw = tw + padding * 2;
    const bh = fontSize + padding * 2;
    const bx = x - bw / 2;
    const by = y - bh / 2;

    const path = new Path2D();
    path.roundRect(bx, by, bw, bh, radius);
    canvas.fillStyle = bgColor;
    canvas.fill(path);

    canvas.fillStyle = textColor;
    canvas.textAlign = 'center';
    canvas.textBaseline = 'middle';
    canvas.fillText(text, x, y);
    canvas.restore();
}

function _flatSeries(
    price: number,
    tMin: bigint,
    tMax: bigint,
    barNs: bigint,
): Array<{ t: bigint; price: number }> {
    const step = barNs > 0n ? barNs : (tMax - tMin) / 100n;
    const pts: Array<{ t: bigint; price: number }> = [];
    for (let t = tMin; t <= tMax; t += step) pts.push({ t, price });
    return pts;
}

function _visibleRange(
    pts: Array<{ t: bigint; price: number }>,
    tMin: bigint,
    tMax: bigint,
): [number, number] {
    // Binary search for first index >= tMin (include one prior for edge continuity)
    let lo = 0,
        hi = pts.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (pts[mid].t < tMin) lo = mid + 1;
        else hi = mid - 1;
    }
    const start = lo > 0 ? lo - 1 : 0;
    // Binary search for last index <= tMax (include one after for edge continuity)
    lo = 0;
    hi = pts.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (pts[mid].t <= tMax) lo = mid + 1;
        else hi = mid - 1;
    }
    const end = lo < pts.length ? lo : pts.length - 1;
    return [start, end];
}

function _clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}

/** One edge of a fill band, already in screen space. */
type FillEdge = { xs: Float64Array; ys: Float64Array };

/**
 * Projects the visible slice of a series to screen space. `_visibleRange`
 * already pads by one point on each side, so the edge stays continuous where it
 * runs off the pane.
 */
function _projectSlice(
    pts: Array<{ t: bigint; price: number }>,
    rect: { w: number; h: number },
    transformer: LiveTransformer,
    tMin: bigint,
    tMax: bigint,
): FillEdge {
    const [s, e] = _visibleRange(pts, tMin, tMax);
    const n = Math.max(0, e - s + 1);
    const tsToX = transformer.makeTsToXFn(rect.w);
    const priceToY = transformer.makePriceToYFn(rect.h);
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        xs[i] = tsToX(pts[s + i].t);
        ys[i] = priceToY(pts[s + i].price);
    }
    return { xs, ys };
}

function _buildFillPath(edge1: FillEdge, edge2: FillEdge): Path2D {
    const path = new Path2D();

    // Forward pass - edge1
    path.moveTo(edge1.xs[0], edge1.ys[0]);
    for (let i = 1; i < edge1.xs.length; i++) path.lineTo(edge1.xs[i], edge1.ys[i]);

    // Backward pass - edge2
    for (let i = edge2.xs.length - 1; i >= 0; i--) path.lineTo(edge2.xs[i], edge2.ys[i]);

    path.closePath();
    return path;
}

/**
 * Returns y at a given x by linear interpolation along the edge, holding the end
 * value beyond either end. The cursor is kept between calls, so this is O(1) per
 * call as long as x never goes backwards.
 */
function _makeYSampler(edge: FillEdge): (x: number) => number {
    const { xs, ys } = edge;
    const n = xs.length;
    let i = 0;
    return (x: number): number => {
        if (n === 0) return NaN;
        if (n === 1 || x <= xs[0]) return ys[0];
        if (x >= xs[n - 1]) return ys[n - 1];
        while (i < n - 2 && xs[i + 1] < x) i++;
        while (i > 0 && xs[i] > x) i--;
        const dx = xs[i + 1] - xs[i];
        return dx > 0 ? ys[i] + ((ys[i + 1] - ys[i]) * (x - xs[i])) / dx : ys[i + 1];
    };
}

/**
 * mode: 'data' - the ramp runs across the band itself, offset 0 sitting on edge1
 * and offset 1 on edge2.
 *
 * A canvas gradient only runs along one straight axis, but "edge1 -> edge2" is
 * not one axis: the gap between the two series changes height at every x, and
 * flips over entirely wherever they cross. So the band is painted as a row of
 * vertical strips, each carrying the ramp from its own edge1 y to its own edge2
 * y. Crossings then read correctly - each series keeps its colour on its side,
 * and the ramp inverts along with them.
 *
 * Three things keep that off the hot path, all of them measured:
 *
 *  - No clip. `ctx.clip()` on a path with a vertex per bar was over half the
 *    cost of the whole fill. Each strip is instead sized to exactly the band it
 *    covers, so there is nothing spilling out that would need trimming.
 *  - One gradient, not one per strip. The ramp is built once in unit space
 *    (v = 0 on edge1, v = 1 on edge2) and each strip reaches it through the
 *    CTM, so the loop allocates nothing.
 *  - Runs, not columns. Consecutive columns are merged into a single strip for
 *    as long as both edges stay inside a sub-device-pixel band, which on real
 *    indicator output (gentle slopes) collapses most of the width into a
 *    handful of fills.
 */
function _fillDataGradient(
    canvas: CanvasRenderingContext2D,
    edge1: FillEdge,
    edge2: FillEdge,
    rect: { w: number; h: number },
    stops: Array<{ offset: number; color: string }>,
): void {
    const n1 = edge1.xs.length,
        n2 = edge2.xs.length;
    if (n1 === 0 || n2 === 0 || stops.length === 0) return;

    // Only the band's own x extent needs painting, clamped to the pane. Whole
    // pixels: the strips are usually translucent, so a fractional vertical edge
    // would antialias and every seam would composite twice.
    const xStart = Math.max(0, Math.floor(Math.min(edge1.xs[0], edge2.xs[0])));
    const xEnd = Math.min(rect.w, Math.ceil(Math.max(edge1.xs[n1 - 1], edge2.xs[n2 - 1])));
    if (!(xEnd > xStart)) return;

    const sample1 = _makeYSampler(edge1);
    const sample2 = _makeYSampler(edge2);

    canvas.save();

    const ramp = canvas.createLinearGradient(0, 0, 0, 1);
    for (const s of stops) ramp.addColorStop(_clamp01(s.offset), s.color);
    canvas.fillStyle = ramp;

    // The pane arrives with a DPR scale and its own translate already on the
    // context, so every strip has to compose onto that - setTransform alone
    // would drop the pane offset and draw the band at the top of the chart.
    const base = canvas.getTransform();
    const A = base.a,
        B = base.b,
        C = base.c,
        D = base.d,
        E = base.e,
        F = base.f;

    // Half a device pixel of slack per run, so the worst edge error is a
    // quarter of a device pixel however the display is scaled.
    const tol = 0.5 / Math.max(1, Math.abs(D) || 1);

    let runX = xStart;
    let y1Lo = Infinity,
        y1Hi = -Infinity,
        y2Lo = Infinity,
        y2Hi = -Infinity;

    const emit = (runEnd: number): void => {
        if (runEnd <= runX) return;
        if (Math.max(y1Hi, y2Hi) < 0 || Math.min(y1Lo, y2Lo) > rect.h) return;

        const y1 = (y1Lo + y1Hi) / 2;
        let h = (y2Lo + y2Hi) / 2 - y1;
        // A zero-height strip paints nothing, which would punch transparent
        // holes exactly where the two series touch. Give it a hair of height,
        // leaning the way the band already leans so the ramp keeps its sense.
        if (Math.abs(h) < 0.5) h = h < 0 ? -0.5 : 0.5;

        // unit square -> this strip: u across the run, v from edge1 to edge2.
        const w = runEnd - runX;
        canvas.setTransform(
            A * w,
            B * w,
            C * h,
            D * h,
            A * runX + C * y1 + E,
            B * runX + D * y1 + F,
        );
        canvas.fillRect(0, 0, 1, 1);
    };

    for (let x = xStart; x <= xEnd; x++) {
        const y1 = sample1(x),
            y2 = sample2(x);
        const lo1 = y1 < y1Lo ? y1 : y1Lo,
            hi1 = y1 > y1Hi ? y1 : y1Hi;
        const lo2 = y2 < y2Lo ? y2 : y2Lo,
            hi2 = y2 > y2Hi ? y2 : y2Hi;

        if (x > runX && (hi1 - lo1 > tol || hi2 - lo2 > tol)) {
            emit(x);
            runX = x;
            y1Lo = y1Hi = y1;
            y2Lo = y2Hi = y2;
        } else {
            y1Lo = lo1;
            y1Hi = hi1;
            y2Lo = lo2;
            y2Hi = hi2;
        }
    }
    emit(xEnd);

    canvas.restore();
}

// Volume-based indicators
export function obv(bars: OhlcvBar[]): number[] {
    const out: number[] = new Array(bars.length).fill(0);
    for (let i = 1; i < bars.length; i++) {
        const delta =
            bars[i].close > bars[i - 1].close
                ? bars[i].volume
                : bars[i].close < bars[i - 1].close
                  ? -bars[i].volume
                  : 0;
        out[i] = out[i - 1] + delta;
    }
    return out;
}

export function mfi(bars: OhlcvBar[], period = 14): number[] {
    const n = bars.length;
    const out: number[] = new Array(n).fill(NaN);
    const tp = bars.map((b) => (b.high + b.low + b.close) / 3);
    const pos: number[] = new Array(n).fill(0);
    const neg: number[] = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
        const mf = tp[i] * bars[i].volume;
        if (tp[i] > tp[i - 1]) pos[i] = mf;
        else if (tp[i] < tp[i - 1]) neg[i] = mf;
    }
    let posFlow = 0;
    let negFlow = 0;
    for (let i = 1; i < n; i++) {
        posFlow += pos[i];
        negFlow += neg[i];
        if (i > period) {
            posFlow -= pos[i - period];
            negFlow -= neg[i - period];
        }
        if (i >= period) out[i] = negFlow === 0 ? 100 : 100 - 100 / (1 + posFlow / negFlow);
    }
    return out;
}

export function cci(bars: OhlcvBar[], period = 20): number[] {
    const n = bars.length;
    const out: number[] = new Array(n).fill(NaN);
    const tp = bars.map((b) => (b.high + b.low + b.close) / 3);
    let sum = 0;
    for (let i = 0; i < n; i++) {
        sum += tp[i];
        if (i >= period) sum -= tp[i - period];
        if (i < period - 1) continue;
        const mean = sum / period;
        let mad = 0;
        for (let j = i - period + 1; j <= i; j++) mad += Math.abs(tp[j] - mean);
        mad /= period;
        out[i] = mad === 0 ? 0 : (tp[i] - mean) / (0.015 * mad);
    }
    return out;
}

export function williamsR(bars: OhlcvBar[], period = 14): number[] {
    const n = bars.length;
    const out: number[] = new Array(n).fill(NaN);
    const his = highest(
        bars.map((b) => b.high),
        period,
    );
    const los = lowest(
        bars.map((b) => b.low),
        period,
    );
    for (let i = period - 1; i < n; i++) {
        const hi = his[i];
        const lo = los[i];
        out[i] = hi === lo ? -50 : ((hi - bars[i].close) / (hi - lo)) * -100;
    }
    return out;
}

export function supertrend(
    bars: OhlcvBar[],
    period = 10,
    multiplier = 3,
): { trend: number[]; upper: number[]; lower: number[] } {
    const n = bars.length;
    const atrVals = atr(bars, period);
    const finalUpper: number[] = new Array(n).fill(NaN);
    const finalLower: number[] = new Array(n).fill(NaN);
    const trend: number[] = new Array(n).fill(1);
    const start = period;
    if (n <= start) return { trend, upper: finalUpper, lower: finalLower };

    finalUpper[start] = (bars[start].high + bars[start].low) / 2 + multiplier * atrVals[start];
    finalLower[start] = (bars[start].high + bars[start].low) / 2 - multiplier * atrVals[start];
    for (let i = start + 1; i < n; i++) {
        const hl2 = (bars[i].high + bars[i].low) / 2;
        const basicUpper = hl2 + multiplier * atrVals[i];
        const basicLower = hl2 - multiplier * atrVals[i];
        const prevClose = bars[i - 1].close;
        finalUpper[i] =
            basicUpper < finalUpper[i - 1] || prevClose > finalUpper[i - 1]
                ? basicUpper
                : finalUpper[i - 1];
        finalLower[i] =
            basicLower > finalLower[i - 1] || prevClose < finalLower[i - 1]
                ? basicLower
                : finalLower[i - 1];
        if (trend[i - 1] === -1 && bars[i].close > finalUpper[i - 1]) trend[i] = 1;
        else if (trend[i - 1] === 1 && bars[i].close < finalLower[i - 1]) trend[i] = -1;
        else trend[i] = trend[i - 1];
    }
    return { trend, upper: finalUpper, lower: finalLower };
}

export interface SessionDef {
    label: string;
    startHour: number;
    startMinute: number;
    endHour: number;
    endMinute: number;
    color: string;
    /**
     * IANA timezone for this session's hours (e.g. 'America/New_York',
     * 'Europe/London'). When set, startHour/endHour are interpreted in this
     * zone and Luxon handles DST automatically - no manual offset tweaking.
     * Falls back to options.tz, then 'UTC' (preserving pre-existing behaviour).
     */
    tz?: string;
}

export interface SessionBoundariesOptions {
    /**
     * Default IANA timezone for all sessions that don't carry their own `tz`.
     * Defaults to 'UTC'.
     */
    tz?: string;
}

export function sessionBoundaries(
    bars: OhlcvBar[],
    sessions: SessionDef[],
    options?: SessionBoundariesOptions,
): Array<{
    startTs: bigint;
    endTs: bigint;
    high: number;
    low: number;
    label: string;
    color: string;
}> {
    if (bars.length === 0) return [];

    const result: Array<{
        startTs: bigint;
        endTs: bigint;
        high: number;
        low: number;
        label: string;
        color: string;
    }> = [];

    const barMs: number[] = new Array(bars.length);
    for (let i = 0; i < bars.length; i++) barMs[i] = Number(bars[i].ts / 1_000_000n);

    // Bars are time-ordered, so a session window is a contiguous slice - find
    // its ends by search instead of scanning every bar for every session-day.
    const firstAtOrAfter = (ms: number): number => {
        let lo = 0,
            hi = barMs.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (barMs[mid] < ms) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };

    // Calendar days covered by the bars, per timezone. Walking day-end to
    // day-end costs one DateTime per day rather than one per bar, and Luxon
    // still resolves DST since each step is taken in the zone.
    const dayCache = new Map<string, Array<{ year: number; month: number; day: number }>>();
    const daysIn = (tz: string) => {
        let days = dayCache.get(tz);
        if (days) return days;
        days = [];
        let dayEnd = -Infinity;
        for (let i = 0; i < barMs.length; i++) {
            if (barMs[i] < dayEnd) continue;
            const dt = DateTime.fromMillis(barMs[i], { zone: tz });
            days.push({ year: dt.year, month: dt.month, day: dt.day });
            dayEnd = dt.startOf('day').plus({ days: 1 }).toMillis();
        }
        dayCache.set(tz, days);
        return days;
    };

    for (const sess of sessions) {
        const tz = sess.tz ?? options?.tz ?? 'UTC';

        for (const { year, month, day } of daysIn(tz)) {
            const sessStart = DateTime.fromObject(
                {
                    year,
                    month,
                    day,
                    hour: sess.startHour,
                    minute: sess.startMinute,
                    second: 0,
                    millisecond: 0,
                },
                { zone: tz },
            );
            let sessEnd = DateTime.fromObject(
                {
                    year,
                    month,
                    day,
                    hour: sess.endHour,
                    minute: sess.endMinute,
                    second: 0,
                    millisecond: 0,
                },
                { zone: tz },
            );
            // Sessions that cross local midnight (e.g. 22:00 -> 02:00).
            if (sessEnd <= sessStart) sessEnd = sessEnd.plus({ days: 1 });

            const startMs = sessStart.toMillis();
            const endMs = sessEnd.toMillis();

            let high = -Infinity,
                low = Infinity;
            for (let i = firstAtOrAfter(startMs); i < barMs.length && barMs[i] < endMs; i++) {
                if (bars[i].high > high) high = bars[i].high;
                if (bars[i].low < low) low = bars[i].low;
            }
            if (high === -Infinity || low === Infinity) continue;

            result.push({
                startTs: BigInt(startMs) * 1_000_000n,
                endTs: BigInt(endMs) * 1_000_000n,
                high,
                low,
                label: sess.label,
                color: sess.color,
            });
        }
    }

    result.sort((a, b) => (a.startTs < b.startTs ? -1 : a.startTs > b.startTs ? 1 : 0));
    return result;
}

// STDLIB export
export const STDLIB: Record<string, Function> = {
    sma,
    ema,
    wma,
    hma,
    rma,
    linreg,
    rsi,
    stoch,
    macd,
    atr,
    tr,
    crossover,
    crossunder,
    cross,
    rising,
    falling,
    change,
    barssince,
    valuewhen,
    highest,
    lowest,
    pivotHigh,
    pivotLow,
    bb,
    bbw,
    donchian,
    keltner,
    vwap,
    alligator,
    stdev,
    variance,
    dev,
    correlation,
    max,
    min,
    median,
    toPoints,
    last,
    nz,
    obv,
    mfi,
    cci,
    williamsR,
    supertrend,
    sessionBoundaries,
    // Draw builders - return command objects, NOT canvas calls
    drawLine,
    drawHLine,
    drawHistogram,
    drawLabel,
    fillBetween,
    drawRect,
    drawCircle,
    drawVLine,
    drawArrow,
    drawTrendLine,
    drawBand,
    drawPolygon,
    drawDots,
    drawBadge,
};
