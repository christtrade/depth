import type { DepthChart } from '../../core/DepthChart';
import type { RenderEngine } from '../../core/RenderEngine';
import { scriptStats } from '../../core/ScriptedPlugin';
import type { Console } from '../Console';
import { heapInfo } from './top';

type Corner = 'tl' | 'tr' | 'bl' | 'br';
const SAMPLES = 180;
const W = 270;
const FONT = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

// net_graph is a small hud over the chart (separate canvas so never makes the chart repaint)
// 1 bar per browser frame
class Hud {
    private canvas: HTMLCanvasElement | null = null;
    private raf = 0;
    private last = 0;
    private frameMs = new Float32Array(SAMPLES);
    private paintMs = new Float32Array(SAMPLES);
    private head = 0;
    private lastPaints = 0;
    private text: string[] = [];
    private textAt = 0;
    private lastCounts = 0;
    private lastScriptMs = 0;
    private frames = 0;

    constructor(
        private readonly chart: DepthChart,
        private level: number,
        private corner: Corner,
    ) {}

    set(level: number, corner: Corner): void {
        this.level = level;
        this.corner = corner;

        if (level > 0) this.attach(this.chart.renderEngine);
        else this.detach();
    }

    attach(engine: RenderEngine | null): void {
        if (this.level <= 0 || !engine?.container || typeof document === 'undefined') return;

        const host = engine.container;
        if (this.canvas?.parentElement !== host) {
            this.canvas?.remove();
            this.canvas = host.ownerDocument.createElement('canvas');
            this.canvas.style.cssText = 'position:absolute;pointer-events:none;z-index:30;border-radius:6px';
            if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
            host.appendChild(this.canvas);
        }

        this.place();
        if (!this.raf) this.raf = requestAnimationFrame((t) => this.tick(t));
    }

    detach(): void {
        cancelAnimationFrame(this.raf);
        this.raf = 0;
        this.canvas?.remove();
        this.canvas = null;
    }

    private place(): void {
        const s = this.canvas!.style;
        const [v, h] = [this.corner[0], this.corner[1]];

        s.top = v === 't' ? '36px' : '';
        s.bottom = v === 'b' ? '36px' : '';
        s.left = h === 'l' ? '8px' : '';
        s.right = h === 'r' ? '72px' : '';
    }

    private tick(now: number): void {
        this.raf = 0;
        if (!this.canvas) return;
        if (!this.canvas.isConnected) return this.detach();

        const dt = this.last ? now - this.last : 16.7;
        this.last = now;

        const paint = this.chart.renderEngine?.paintStats;
        const painted = paint && paint.frames !== this.lastPaints ? paint.lastMs : 0;

        this.lastPaints = paint?.frames ?? 0;
        this.frameMs[this.head] = dt;
        this.paintMs[this.head] = painted;
        this.head = (this.head + 1) % SAMPLES;
        this.frames++;

        if (now - this.textAt >= 250) this.updateText(now);

        this.draw();
        this.raf = requestAnimationFrame((t) => this.tick(t));
    }

    private updateText(now: number): void {
        const secs = this.textAt ? (now - this.textAt) / 1000 : 1;
        this.textAt = now;

        const counts = [...this.chart.eventBus.emitCounts.values()].reduce((a, b) => a + b, 0);
        const scriptMs = [...scriptStats.values()].reduce((a, s) => a + s.totalMs, 0);
        const evRate = (counts - this.lastCounts) / secs;
        const jsRate = (scriptMs - this.lastScriptMs) / secs;

        this.lastCounts = counts;
        this.lastScriptMs = scriptMs;
        const fps = this.frames / secs;
        this.frames = 0;

        let sum = 0;
        let worst = 0;
        let paintSum = 0;
        for (let i = 0; i < SAMPLES; i++) {
            sum += this.frameMs[i];
            worst = Math.max(worst, this.frameMs[i]);
            paintSum += this.paintMs[i];
        }

        const heap = heapInfo();
        this.text = [
            `${Math.round(fps).toString().padStart(3)} fps  ${(sum / SAMPLES).toFixed(1)}ms  worst ${worst.toFixed(0)}ms`,
            `paint ${(paintSum / SAMPLES).toFixed(2)}ms/frame   ${Math.round(evRate)} ev/s`,
            `scripts ${jsRate.toFixed(1)}ms/s${heap ? `   heap ${Math.round(heap.usedJSHeapSize / 1048576)}MB` : ''}`,
        ];

        if (this.level >= 2) {
            const busiest = [...scriptStats.values()].sort((a, b) => b.lastMs - a.lastMs).slice(0, 2);
            for (const s of busiest) this.text.push(`  ${s.name.slice(0, 20).padEnd(20)} ${s.lastMs.toFixed(2)}ms`);
            this.text.push(`${this.chart.getSymbol()} ${this.chart.getTimeframe()}  ${this.chart.playback.playing ? `▶ ${this.chart.playback.speed}x` : '❚❚'}`);
        }
    }

    private draw(): void {
        const c = this.canvas!;
        const dpr = globalThis.devicePixelRatio || 1;
        const graphH = 44;
        const lineH = 14;
        const h = 8 + this.text.length * lineH + 6 + graphH + 6;

        if (c.width !== W * dpr || c.height !== h * dpr) {
            c.width = W * dpr;
            c.height = h * dpr;
            c.style.width = `${W}px`;
            c.style.height = `${h}px`;
        }

        const g = c.getContext('2d')!;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, W, h);
        g.fillStyle = 'rgba(10, 12, 16, 0.72)';
        g.fillRect(0, 0, W, h);

        g.font = FONT;
        g.textBaseline = 'top';
        this.text.forEach((line, i) => {
            g.fillStyle = i === 0 ? '#e5e7eb' : '#9ca3af';
            g.fillText(line, 8, 8 + i * lineH);
        });

        // frame time bars: 16.7ms is the line, >33ms is red. paint cost on top in blue
        const top = 8 + this.text.length * lineH + 6;
        const scale = graphH / 50;
        const barW = (W - 16) / SAMPLES;

        for (let i = 0; i < SAMPLES; i++) {
            const k = (this.head + i) % SAMPLES;
            const f = Math.min(50, this.frameMs[k]);
            const x = 8 + i * barW;

            g.fillStyle = f > 33 ? '#ef4444' : f > 18 ? '#eab308' : '#22c55e';
            g.fillRect(x, top + graphH - f * scale, Math.max(1, barW - 0.2), f * scale);

            const p = Math.min(50, this.paintMs[k]);
            if (p > 0) {
                g.fillStyle = 'rgba(96, 165, 250, 0.9)';
                g.fillRect(x, top + graphH - p * scale, Math.max(1, barW - 0.2), p * scale);
            }
        }

        g.strokeStyle = 'rgba(255,255,255,0.25)';
        g.beginPath();
        g.moveTo(8, top + graphH - 16.7 * scale + 0.5);
        g.lineTo(W - 8, top + graphH - 16.7 * scale + 0.5);
        g.stroke();
    }
}

export function registerNetGraph(chart: DepthChart, con: Console): void {
    const hud = new Hud(chart, 0, 'bl');
    let level = 0;
    let corner: Corner = 'bl';

    chart.on('render-engine:ready', ({ engine }) => hud.attach(engine));
    con.registerSavedCvar({
        name: 'net_graph',
        type: { kind: 'number' },
        help: 'net_graph 1 - fps, frame and paint time, events and script cost over the chart. 2 adds more, 0 hides',
        group: 'console',
        default: 0,
        onChange: (v) => hud.set((level = Math.max(0, Math.min(2, Number(v) || 0))), corner),
    });
    con.registerSavedCvar({
        name: 'net_graph_pos',
        type: { kind: 'enum', values: ['bl', 'br', 'tl', 'tr'] },
        help: 'which corner net_graph sits in',
        group: 'console',
        default: 'bl',
        onChange: (v) => hud.set(level, (corner = v as Corner)),
    });
}
