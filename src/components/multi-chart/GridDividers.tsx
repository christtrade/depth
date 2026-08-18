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

function rowDividerRange(
    rowIndex: number,
    areas: string,
    colSizes: number[],
): { left: number; right: number }[] {
    const rows = (areas.match(/"([^"]+)"/g) ?? []).map((r) =>
        r.replace(/"/g, '').trim().split(/\s+/),
    );
    if (rowIndex >= rows.length - 1) return [];
    const above = rows[rowIndex];
    const below = rows[rowIndex + 1];
    const numCols = above.length;

    const sum = colSizes.reduce((a, b) => a + b, 0);
    const colFrac: number[] = [];
    let acc = 0;
    for (const s of colSizes) {
        colFrac.push(acc / sum);
        acc += s;
    }
    colFrac.push(1);

    const segments: { left: number; right: number }[] = [];
    let spanStart: number | null = null;
    for (let c = 0; c < numCols; c++) {
        const bridges = above[c] === below[c];
        if (!bridges) {
            if (spanStart === null) spanStart = c;
        } else {
            if (spanStart !== null) {
                segments.push({ left: colFrac[spanStart], right: colFrac[c] });
                spanStart = null;
            }
        }
    }
    if (spanStart !== null) {
        segments.push({ left: colFrac[spanStart], right: colFrac[numCols] });
    }
    return segments;
}

export function Dividers({
    dir,
    sizes,
    containerRef,
    onDrag,
    areas,
    colSizes: colSizesProp,
}: {
    dir: 'col' | 'row';
    sizes: number[];
    containerRef: React.RefObject<HTMLDivElement>;
    onDrag: (i: number, targetPx: number) => void;
    areas?: string;
    colSizes?: number[];
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
                    !isCol && areas && colSizesProp
                        ? rowDividerRange(i, areas, colSizesProp)
                        : null;

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

                if (isCol) {
                    return (
                        <div
                            key={i}
                            style={{
                                position: 'absolute',
                                left: p - 7,
                                top: 1,
                                width: 12,
                                bottom: 3,
                                cursor: 'col-resize',
                                zIndex: 40,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                            }}
                            onMouseDown={makeMouseDown}
                            className='hover:bg-muted-foreground/15 active:bg-muted-foreground/15'
                        >
                        </div>
                    );
                }

                return (
                    <React.Fragment key={i}>
                        {(segments ?? [{ left: 0, right: 1 }]).map((seg, si) => {
                            const leftPx = seg.left * containerSize.w;
                            const rightPx = (1 - seg.right) * containerSize.w;
                            return (
                                <div
                                    key={si}
                                    style={{
                                        position: 'absolute',
                                        top: p - 7,
                                        left: leftPx,
                                        right: rightPx+3,
                                        height: 12,
                                        cursor: 'row-resize',
                                        zIndex: 40,
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                    }}
                                    onMouseDown={makeMouseDown}
                                    className='hover:bg-muted-foreground/15 active:bg-muted-foreground/15'
                                >
                                </div>
                            );
                        })}
                    </React.Fragment>
                );
            })}
        </>
    );
}
