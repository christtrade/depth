'use client';

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '../../lib/utils';

const DURATION_MS = 200;

/**
 * Expands to its content's height and back. Children stay mounted while
 * closing, so the close animates too.
 */
export function Collapse({
    open,
    className,
    children,
}: {
    open: boolean;
    className?: string;
    children: React.ReactNode;
}) {
    const [mounted, setMounted] = useState(open);
    const [expanded, setExpanded] = useState(open);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (open) {
            setMounted(true);
            return;
        }
        setExpanded(false);
        // a timer, not transitionend - reduced motion has no transition to end
        const id = setTimeout(() => setMounted(false), DURATION_MS);
        return () => clearTimeout(id);
    }, [open]);

    useLayoutEffect(() => {
        if (!open || !mounted || expanded) return;
        // the closed size has to be laid out once, or the browser skips straight to open
        ref.current?.getBoundingClientRect();
        setExpanded(true);
    }, [open, mounted, expanded]);

    if (!mounted) return null;

    return (
        <div
            ref={ref}
            style={{ transitionDuration: `${DURATION_MS}ms` }}
            className={cn(
                'grid transition-[grid-template-rows,opacity,transform] ease-out motion-reduce:transition-none',
                expanded
                    ? 'grid-rows-[1fr] opacity-100 translate-y-0'
                    : 'grid-rows-[0fr] opacity-0 -translate-y-1',
                className,
            )}
        >
            <div className="min-h-0 overflow-hidden">{children}</div>
        </div>
    );
}
