'use client';

import React, { useState, useLayoutEffect } from 'react';
import { pointerLock } from '../../lib/pointer-lock';

export function resizeSizes(sizes: number[], i: number, deltaPx: number, totalPx: number): number[] {
    const n = [...sizes];
    const total = n.reduce((a, b) => a + b, 0);
    const d = (deltaPx / totalPx) * total;
    const MIN = total * 0.08;
    n[i] = Math.max(MIN, n[i] + d);
    n[i + 1] = Math.max(MIN, n[i + 1] - d);
    return n;
}

// places the boundary after pane i at targetPx from the container's start,
// redistributing only between i and i+1. unlike the delta version this locks the
// divider to the cursor: clamping at MIN accumulates no drift, so the cursor
// re-engages the moment it comes back.
export function resizeSizesAbsolute(
    sizes: number[],
    i: number,
    targetPx: number,
    totalPx: number,
): number[] {
    if (totalPx <= 0) return sizes;
    const n = [...sizes];
    const total = n.reduce((a, b) => a + b, 0);
    const pairSum = n[i] + n[i + 1];
    let beforeFr = 0;
    for (let k = 0; k < i; k++) beforeFr += n[k];
    const beforePx = (beforeFr / total) * totalPx;
    const MIN = total * 0.08;
    let newI = ((targetPx - beforePx) / totalPx) * total;
    newI = Math.max(MIN, Math.min(pairSum - MIN, newI));
    n[i] = newI;
    n[i + 1] = pairSum - newI;
    return n;
}

export const toFr = (s: number[]) => s.map((v) => `${v}fr`).join(' ');

export const parseAreas = (areas: string): string[][] =>
    (areas.match(/"([^"]+)"/g) ?? []).map((r: string) => r.replace(/"/g, '').trim().split(/\s+/));

// Spans along a divider where the cells on either side differ, as 0..1 fractions.
function dividerRange(
    dir: 'col' | 'row',
    index: number,
    areas: string,
    crossSizes: number[],
): { start: number; end: number }[] {
    const grid = parseAreas(areas);
    const cellAt = (along: number, side: number) =>
        dir === 'row' ? grid[index + side]?.[along] : grid[along]?.[index + side];
    const count = dir === 'row' ? (grid[0]?.length ?? 0) : grid.length;

    const sum = crossSizes.reduce((a, b) => a + b, 0);
    const frac: number[] = [];
    let acc = 0;
    for (const s of crossSizes) {
        frac.push(acc / sum);
        acc += s;
    }
    frac.push(1);

    const segments: { start: number; end: number }[] = [];
    let spanStart: number | null = null;
    for (let k = 0; k < count; k++) {
        if (cellAt(k, 0) !== cellAt(k, 1)) {
            if (spanStart === null) spanStart = k;
        } else if (spanStart !== null) {
            segments.push({ start: frac[spanStart], end: frac[k] });
            spanStart = null;
        }
    }
    if (spanStart !== null) segments.push({ start: frac[spanStart], end: frac[count] });
    return segments;
}

export function Dividers({
    dir,
    sizes,
    containerRef,
    onDrag,
    areas,
    crossSizes,
}: {
    dir: 'col' | 'row';
    sizes: number[];
    containerRef: React.RefObject<HTMLDivElement>;
    onDrag: (i: number, targetPx: number) => void;
    areas?: string;
    crossSizes?: number[];
}) {
    const [pos, setPos] = useState<number[]>([]);
    const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
    const [dragging, setDragging] = useState(false);

    useLayoutEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const measure = () => {
            const total = dir === 'col' ? el.clientWidth : el.clientHeight;
            const sum = sizes.reduce((a, b) => a + b, 0);
            let acc = 0;
            const p: number[] = [];
            for (let i = 0; i < sizes.length - 1; i++) {
                acc += (sizes[i] / sum) * total;
                p.push(acc);
            }
            setPos(p);
            setContainerSize({ w: el.clientWidth, h: el.clientHeight });
        };
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [dir, sizes, containerRef]);

    const isCol = dir === 'col';

    return (
        <>
            {dragging && (
                <div
                    style={{
                        position: 'fixed',
                        inset: 0,
                        zIndex: 9999,
                        cursor: isCol ? 'col-resize' : 'row-resize',
                    }}
                />
            )}
            {pos.map((p, i) => {
                const segments =
                    areas && crossSizes
                        ? dividerRange(dir, i, areas, crossSizes)
                        : [{ start: 0, end: 1 }];

                const makeMouseDown = (e: React.MouseEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDragging(true);
                    // the chart's interaction handlers listen on window, so they
                    // need telling to stand down under the shield
                    pointerLock.lock();
                    // coalesced to one update per frame, or a fast drag re-lays
                    // out the panes several times per paint
                    let raf = 0;
                    let latestPx = 0;
                    const flush = () => {
                        raf = 0;
                        onDrag(i, latestPx);
                    };
                    const move = (ev: MouseEvent) => {
                        const el = containerRef.current;
                        if (!el) return;
                        const rect = el.getBoundingClientRect();
                        latestPx = isCol ? ev.clientX - rect.left : ev.clientY - rect.top;
                        if (!raf) raf = requestAnimationFrame(flush);
                    };
                    const up = () => {
                        setDragging(false);
                        pointerLock.unlock();
                        if (raf) cancelAnimationFrame(raf);
                        window.removeEventListener('mousemove', move);
                        window.removeEventListener('mouseup', up);
                    };
                    window.addEventListener('mousemove', move);
                    window.addEventListener('mouseup', up);
                };

                return (
                    <React.Fragment key={i}>
                        {segments.map((seg, si) => {
                            const span = isCol ? containerSize.h : containerSize.w;
                            const start = seg.start * span + (isCol && seg.start === 0 ? 1 : 0);
                            const end = (1 - seg.end) * span + (seg.end === 1 ? 3 : 0);
                            return (
                                <div
                                    key={si}
                                    style={{
                                        position: 'absolute',
                                        zIndex: 40,
                                        ...(isCol
                                            ? { left: p - 6.5, width: 12, top: start, bottom: end, cursor: 'col-resize' }
                                            : { top: p - 6.5, height: 12, left: start, right: end, cursor: 'row-resize' }),
                                    }}
                                    onMouseDown={makeMouseDown}
                                    className="hover:bg-muted-foreground/15 active:bg-muted-foreground/15"
                                />
                            );
                        })}
                    </React.Fragment>
                );
            })}
        </>
    );
}
