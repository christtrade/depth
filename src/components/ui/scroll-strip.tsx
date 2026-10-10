'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils';

export function ScrollStrip({
    className,
    innerClassName,
    children,
}: {
    className?: string;
    innerClassName?: string;
    children: ReactNode;
}) {
    const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
    const [canScrollLeft, setCanScrollLeft] = useState(false);
    const [canScrollRight, setCanScrollRight] = useState(false);
    const glideRef = useRef<((delta: number) => void) | null>(null);

    useEffect(() => {
        if (!scrollEl) return;
        const update = () => {
            setCanScrollLeft(scrollEl.scrollLeft > 0);
            setCanScrollRight(
                scrollEl.scrollLeft + scrollEl.clientWidth < scrollEl.scrollWidth - 1,
            );
        };

        // the native smooth scrollBy doesnt work well
        let target: number | null = null;
        let raf = 0;
        const max = () => scrollEl.scrollWidth - scrollEl.clientWidth;
        const step = () => {
            if (target === null) return;
            const diff = target - scrollEl.scrollLeft;
            if (Math.abs(diff) < 1) {
                scrollEl.scrollLeft = target;
                target = null;
                return;
            }
            const before = scrollEl.scrollLeft;

            // min 1 px, scrollLeft rounds to whole pxs in some browsers
            scrollEl.scrollLeft += Math.sign(diff) * Math.max(1, Math.abs(diff) * 0.1);
            if (scrollEl.scrollLeft === before) {
                target = null;
                return;
            }
            raf = requestAnimationFrame(step);
        };
        const glideBy = (delta: number) => {
            target = Math.min(max(), Math.max(0, (target ?? scrollEl.scrollLeft) + delta));
            cancelAnimationFrame(raf);
            raf = requestAnimationFrame(step);
        };
        glideRef.current = glideBy;

        const onWheel = (e: WheelEvent) => {
            if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
            if (max() <= 0) return;
            const at = target ?? scrollEl.scrollLeft;
            if ((e.deltaY < 0 && at <= 0) || (e.deltaY > 0 && at >= max() - 1)) return;
            e.preventDefault();
            glideBy(e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY);
        };
        const stop = () => {
            cancelAnimationFrame(raf);
            target = null;
        };
        update();
        scrollEl.addEventListener('scroll', update, { passive: true });
        scrollEl.addEventListener('wheel', onWheel, { passive: false });
        scrollEl.addEventListener('touchstart', stop, { passive: true });
        const ro = new ResizeObserver(update);
        ro.observe(scrollEl);
        if (scrollEl.firstElementChild) ro.observe(scrollEl.firstElementChild);
        return () => {
            stop();
            glideRef.current = null;
            scrollEl.removeEventListener('scroll', update);
            scrollEl.removeEventListener('wheel', onWheel);
            scrollEl.removeEventListener('touchstart', stop);
            ro.disconnect();
        };
    }, [scrollEl]);

    const scroll = (dir: 'left' | 'right') => {
        if (!scrollEl) return;
        glideRef.current?.((dir === 'left' ? -1 : 1) * scrollEl.clientWidth * 0.6);
    };

    return (
        <div className={cn('relative', className)}>
            <div
                ref={setScrollEl}
                className="h-full overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
                <div className={cn('h-full w-max min-w-full whitespace-nowrap', innerClassName)}>
                    {children}
                </div>
            </div>
            {(['left', 'right'] as const).map((dir) => {
                const show = dir === 'left' ? canScrollLeft : canScrollRight;
                const Icon = dir === 'left' ? ChevronLeft : ChevronRight;
                return (
                    <div
                        key={dir}
                        className={cn(
                            'pointer-events-none absolute inset-y-0 flex items-center from-background from-60% to-transparent transition-opacity',
                            dir === 'left'
                                ? 'left-0 pr-6 bg-gradient-to-r'
                                : 'right-0 pl-6 bg-gradient-to-l',
                            !show && 'opacity-0 [&>button]:pointer-events-none',
                        )}
                    >
                        <button
                            type="button"
                            tabIndex={-1}
                            onClick={() => scroll(dir)}
                            className="pointer-events-auto flex h-full w-6 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                            <Icon className="h-4 w-4" />
                        </button>
                    </div>
                );
            })}
        </div>
    );
}
