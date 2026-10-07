import type { CommandDef } from '../Console';
import { ansi, stripAnsi } from '../values';
import { bytes, clip, count, liveScreen, ms, padEnd, padStart } from './tui';

type Req = PerformanceResourceTiming & { responseStatus?: number; deliveryType?: string };

const MAX = 3000;

// uses the browsers own record of every request the page made
export function netRecorder(): { requests: Req[]; clear(): void } {
    const requests: Req[] = [];
    const take = (list: PerformanceEntryList) => {
        for (const e of list) if (e.entryType === 'resource') requests.push(e as Req);
        if (requests.length > MAX) requests.splice(0, requests.length - MAX);
    };
    const perf = globalThis.performance as Performance & { setResourceTimingBufferSize?: (n: number) => void };
    if (typeof PerformanceObserver === 'function') {
        try {
            perf.setResourceTimingBufferSize?.(MAX);
            new PerformanceObserver((l) => take(l.getEntries())).observe({ type: 'resource', buffered: true });
        } catch {
            take(perf.getEntriesByType?.('resource') ?? []);
        }
    }
    return { requests, clear: () => (requests.length = 0) };
}

const cached = (r: Req) => r.deliveryType === 'cache' || (r.transferSize === 0 && r.decodedBodySize > 0);
// cross origin without timing-allow-origin reports 0s for everything but duration
const opaque = (r: Req) => r.transferSize === 0 && r.decodedBodySize === 0 && r.responseStart === 0;

function shortUrl(url: string): string {
    try {
        const u = new URL(url, globalThis.location?.href);
        const same = globalThis.location && u.origin === globalThis.location.origin;
        return (same ? '' : u.host) + u.pathname + u.search;
    } catch {
        return url;
    }
}

const span = (a: number, b: number) => (a > 0 && b >= a ? b - a : NaN);

export function netCommand(rec: { requests: Req[]; clear(): void }): CommandDef {
    return {
        name: 'net',
        help: 'net [filter] - every request the page made: status, size, cache, timing. / filters, enter for detail, q quits',
        run: async (ctx) => {
            const screen = ctx.screen({ maximize: true });
            let filter = ctx.argv.join(' ');
            let typing: string | null = null;
            let sel = -1;
            let follow = true;
            let detail = false;
            let redraw: () => void = () => {};
            const shown = () => (filter ? rec.requests.filter((r) => r.name.toLowerCase().includes(filter.toLowerCase()) || r.initiatorType === filter) : rec.requests);

            screen.onData((d) => {
                if (typing !== null) {
                    if (d === '\r') ((filter = typing), (typing = null), (follow = true));
                    else if (d === '\x7f') typing = typing.slice(0, -1);
                    else if (d === '\x1b') typing = null;
                    else if (!d.startsWith('\x1b')) typing += d;
                    return redraw();
                }

                const n = shown().length;
                const keys: Record<string, () => void> = {
                    q: () => screen.close(),
                    '\x1b[A': () => ((sel -= 1), (follow = false)),
                    '\x1b[B': () => (sel += 1),
                    '\x1b[5~': () => ((sel -= 10), (follow = false)),
                    '\x1b[6~': () => (sel += 10),
                    G: () => (follow = true),
                    '\r': () => (detail = !detail),
                    '/': () => (typing = filter),
                    c: () => (rec.clear(), (sel = 0)),
                };

                keys[d]?.();
                if (sel >= n - 1) follow = true;
                redraw();
            });

            await liveScreen(
                screen,
                500,
                () => {
                    const list = shown();
                    if (follow) sel = list.length - 1;
                    sel = Math.max(0, Math.min(sel, list.length - 1));

                    const now = performance.now();
                    const recent = rec.requests.filter((r) => now - r.responseEnd < 10_000);
                    const inBytes = rec.requests.reduce((s, r) => s + (r.transferSize || 0), 0);
                    const hits = rec.requests.filter(cached).length;
                    const out: string[] = [];

                    out.push(
                        `${ansi.bold('net')}  ${count(rec.requests.length)} requests  ${bytes(inBytes)} over the wire  cache ${rec.requests.length ? Math.round((hits / rec.requests.length) * 100) : 0}%   ${ansi.dim(`last 10s: ${recent.length} req, ${bytes(recent.reduce((s, r) => s + (r.transferSize || 0), 0))}`)}${filter ? `   filter ${ansi.cyan(filter)}` : ''}`,
                    );
                    out.push(ansi.bold(`${padEnd('AGO', 8)}${padStart('STATUS', 7)} ${padEnd('TYPE', 8)}${padStart('SIZE', 9)}${padStart('TIME', 9)}  ${padEnd('', 16)} URL`));

                    const pick = list[sel];
                    const detailRows = detail && pick ? 9 : 0;
                    const listH = Math.max(1, screen.rows - 3 - detailRows);
                    const top = Math.max(0, Math.min(sel - listH + 1 + Math.floor(listH / 3), list.length - listH));
                    const visible = list.slice(top, top + listH);
                    const slowest = Math.max(1, ...visible.map((r) => r.duration));

                    visible.forEach((r, i) => {
                        const ago = (now - r.responseEnd) / 1000;
                        const agoText = ago < 60 ? `${ago.toFixed(ago < 10 ? 1 : 0)}s` : `${Math.floor(ago / 60)}m`;
                        const status = r.responseStatus ? String(r.responseStatus) : '-';
                        const statusText = r.responseStatus >= 400 ? ansi.red(status) : r.responseStatus >= 300 ? ansi.yellow(status) : status;
                        const size = cached(r) ? ansi.green('cache') : opaque(r) ? ansi.dim('?') : bytes(r.transferSize);

                        const ttfb = span(r.requestStart || r.startTime, r.responseStart);
                        const w = Math.max(1, Math.round((r.duration / slowest) * 16));
                        const waitW = Number.isFinite(ttfb) ? Math.min(w, Math.round((ttfb / slowest) * 16)) : 0;
                        const bar = ansi.dim('█'.repeat(waitW)) + ansi.blue('█'.repeat(w - waitW));

                        let row = `${padEnd(ansi.dim(agoText), 8)}${padStart(statusText, 7)} ${padEnd(r.initiatorType, 8)}${padStart(size, 9)}${padStart(ms(r.duration), 9)}  ${padEnd(bar, 16)} ${shortUrl(r.name)}`;
                        if (top + i === sel) row = `\x1b[7m${clip(stripAnsi(row), screen.cols)}${' '.repeat(Math.max(0, screen.cols - stripAnsi(row).length))}\x1b[27m`;
                        out.push(row);
                    });

                    if (!list.length) out.push(ansi.dim(filter ? `  nothing matches "${filter}"` : '  no requests seen yet'));
                    while (out.length < listH + 2) out.push('');

                    if (detail && pick) {
                        const t = (label: string, v: number) => `${label} ${Number.isFinite(v) ? ms(v) : '-'}`;
                        out.push(ansi.dim('─'.repeat(screen.cols)));
                        out.push(pick.name);
                        out.push(`${pick.initiatorType}  ${pick.nextHopProtocol || ''}  status ${pick.responseStatus || '-'}  ${cached(pick) ? ansi.green('from cache') : ''}${opaque(pick) ? ansi.dim('cross-origin, the server shares no timing') : ''}`);
                        out.push(
                            [
                                t('dns', span(pick.domainLookupStart, pick.domainLookupEnd)),
                                t('connect', span(pick.connectStart, pick.connectEnd)),
                                t('tls', span(pick.secureConnectionStart, pick.connectEnd)),
                                t('wait', span(pick.requestStart, pick.responseStart)),
                                t('download', span(pick.responseStart, pick.responseEnd)),
                                t('total', pick.duration),
                            ].join('   '),
                        );
                        out.push(`wire ${bytes(pick.transferSize)}   compressed ${bytes(pick.encodedBodySize)}   body ${bytes(pick.decodedBodySize)}`);
                    }
                    out.length = Math.min(out.length, screen.rows - 1);
                    while (out.length < screen.rows - 1) out.push('');
                    out.push(typing !== null ? `filter: ${typing}\x1b[?25h` : ansi.dim('↑↓ move  enter detail  / filter  c clear  G follow  q quit'));
                    return out;
                },
                (r) => (redraw = r),
            );
        },
    };
}
