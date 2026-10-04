'use client';

import { useEffect, useState, type HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

interface AnimatedPanelProps extends HTMLAttributes<HTMLDivElement> {
    open: boolean;
    side?: 'top' | 'bottom';
    align?: 'left' | 'right';
}

export function AnimatedPanel({
    open,
    side = 'bottom',
    align = 'left',
    className,
    onAnimationEnd,
    ...props
}: AnimatedPanelProps) {
    const [mounted, setMounted] = useState(open);

    useEffect(() => {
        if (open) setMounted(true);
    }, [open]);

    if (!open && !mounted) return null;

    const below = side === 'bottom';
    return (
        <div
            {...props}
            data-state={open ? 'open' : 'closed'}
            onAnimationEnd={(e) => {
                if (e.target === e.currentTarget && !open) setMounted(false);
                onAnimationEnd?.(e);
            }}
            className={cn(
                'duration-150 fill-mode-forwards',
                below
                    ? align === 'left' ? 'origin-top-left' : 'origin-top-right'
                    : align === 'left' ? 'origin-bottom-left' : 'origin-bottom-right',
                open
                    ? ['animate-in fade-in-0 zoom-in-95', below ? 'slide-in-from-top-2' : 'slide-in-from-bottom-2']
                    : ['animate-out fade-out-0 zoom-out-95 pointer-events-none', below ? 'slide-out-to-top-2' : 'slide-out-to-bottom-2'],
                className,
            )}
        />
    );
}
