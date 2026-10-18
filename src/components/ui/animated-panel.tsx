'use client';

import { useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils';

interface AnimatedPanelProps extends HTMLAttributes<HTMLDivElement> {
    open: boolean;
    side?: 'top' | 'bottom';
    align?: 'left' | 'right';
    offset?: number;
    maxHeight?: number;
    matchWidth?: boolean;
}

const EDGE = 8;

const owners = new WeakMap<Element, Element>();

export function containsWithPanels(root: Element | null, target: EventTarget | null): boolean {
    if (!root) return false;
    let node = target as Node | null;
    while (node) {
        if (root.contains(node)) return true;
        let p: Node | null = node;
        while (p && !(p instanceof Element && owners.has(p))) p = p.parentNode;
        if (!p) return false;
        node = owners.get(p as Element)!;
    }
    return false;
}

export function AnimatedPanel({
    open,
    side = 'bottom',
    align = 'left',
    offset = 6,
    maxHeight,
    matchWidth,
    className,
    style,
    onAnimationEnd,
    ...props
}: AnimatedPanelProps) {
    const [mounted, setMounted] = useState(open);
    const [placedSide, setPlacedSide] = useState(side);
    const markerRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (open) setMounted(true);
    }, [open]);

    const visible = open || mounted;

    useLayoutEffect(() => {
        if (!visible) return;
        const anchor = markerRef.current?.parentElement;
        const el = panelRef.current;
        if (!anchor || !el) return;
        owners.set(el, anchor);

        const place = () => {
            const a = anchor.getBoundingClientRect();
            const vw = document.documentElement.clientWidth;
            const vh = window.innerHeight;

            el.style.maxWidth = `${vw - EDGE * 2}px`;
            el.style.maxHeight = maxHeight ? `${maxHeight}px` : '';
            if (matchWidth) el.style.width = `${a.width}px`;
            const w = el.offsetWidth;
            const h = el.offsetHeight;

            const below = vh - a.bottom - offset - EDGE;
            const above = a.top - offset - EDGE;
            const preferred = side === 'bottom' ? below : above;
            const other = side === 'bottom' ? above : below;
            const s = h > preferred && other > preferred ? (side === 'bottom' ? 'top' : 'bottom') : side;
            const room = Math.max(0, s === 'bottom' ? below : above);
            const fitH = Math.min(h, room);

            const left = align === 'left' ? a.left : a.right - w;
            el.style.left = `${Math.max(EDGE, Math.min(left, vw - w - EDGE))}px`;
            el.style.top = `${s === 'bottom' ? a.bottom + offset : a.top - offset - fitH}px`;
            el.style.maxHeight = `${Math.min(room, maxHeight ?? Infinity)}px`;
            setPlacedSide(s);
        };

        place();
        const onScroll = (e: Event) => {
            if (!el.contains(e.target as Node)) place();
        };
        const ro = new ResizeObserver(place);
        ro.observe(anchor);
        ro.observe(el);
        window.addEventListener('resize', place);
        window.addEventListener('scroll', onScroll, true);
        return () => {
            ro.disconnect();
            window.removeEventListener('resize', place);
            window.removeEventListener('scroll', onScroll, true);
        };
    }, [visible, side, align, offset, maxHeight, matchWidth]);

    if (!visible || typeof document === 'undefined') return null;

    const below = placedSide === 'bottom';
    return (
        <>
            <span ref={markerRef} hidden />
            {createPortal(
                <div
                    {...props}
                    ref={panelRef}
                    data-state={open ? 'open' : 'closed'}
                    onAnimationEnd={(e) => {
                        if (e.target === e.currentTarget && !open) setMounted(false);
                        onAnimationEnd?.(e);
                    }}
                    style={{ ...style, position: 'fixed' }}
                    className={cn(
                        'depth-root fill-mode-forwards motion-reduce:animate-none',
                        below
                            ? align === 'left' ? 'origin-top-left' : 'origin-top-right'
                            : align === 'left' ? 'origin-bottom-left' : 'origin-bottom-right',
                        // 95% on a big panel is a 24px pop. fast start and a soft landing in,
                        // quicker out so closing never feels like waiting. an arbitrary ease value is
                        // ambiguous with tailwindcss-animate and silently generates nothing
                        open
                            ? ['animate-in fade-in-0 zoom-in-[0.97] duration-200 [animation-timing-function:cubic-bezier(0.16,1,0.3,1)]', below ? 'slide-in-from-top-1' : 'slide-in-from-bottom-1']
                            : ['animate-out fade-out-0 zoom-out-[0.97] duration-150 [animation-timing-function:cubic-bezier(0.4,0,1,1)] pointer-events-none', below ? 'slide-out-to-top-1' : 'slide-out-to-bottom-1'],
                        className,
                    )}
                />,
                document.body,
            )}
        </>
    );
}
