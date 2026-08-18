import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import type { TypedEventBus } from '../../core/TypedEventBus';
import { cn } from '../../lib/utils';

function StatusChip({
    icon,
    label,
    visible,
    className,
    style
}: {
    icon: ReactNode;
    label: string;
    visible: boolean;
    className?: string;
    style?: any
}) {
    return (
        <div
            className={cn(
                'pointer-events-none absolute flex items-center gap-1.5 rounded-full',
                'border border-border/60 bg-background/80 px-2 py-[3px] backdrop-blur-[2px]',
                'text-[10.5px] leading-none text-muted-foreground',
                'transition-opacity duration-300',
                visible ? 'opacity-80' : 'opacity-0',
                className,
            )}
            style={style ?? {}}
        >
            {icon}
            {label}
        </div>
    );
}

function MiniSpinner() {
    return (
        <svg
            width={9}
            height={9}
            viewBox="0 0 24 24"
            fill="none"
            className="animate-spin [animation-duration:900ms]"
            aria-hidden
        >
            <circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeWidth="3" opacity={0.2} />
            <path
                d="M21.5 12A9.5 9.5 0 0 0 12 2.5"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
            />
        </svg>
    );
}

export function HeatmapSpinner({
    eventBus,
    cellId,
}: {
    eventBus: TypedEventBus;
    cellId?: number;
}) {
    const [active, setActive] = useState(false);

    useEffect(() => {
        return eventBus.on('heatmap:status', (s) => {
            if (s.cellId !== undefined && cellId !== undefined && s.cellId !== cellId) return;
            setActive(s.recalculating);
        });
    }, [eventBus, cellId]);

    return (
        <StatusChip
            icon={<MiniSpinner />}
            label="Rebuilding heatmap"
            visible={active}
            className="bottom-9 left-2"
        />
    );
}

export function DataStatus({
    eventBus,
    symbol,
    priceScaleWidth,
}: {
    eventBus: TypedEventBus;
    symbol?: string;
    priceScaleWidth: number;
}) {
    const [status, setStatus] = useState<'loading' | 'preview' | 'done' | ''>('');
    const timeoutRef = useRef<number | null>(null);

    useEffect(() => {
        const clearTimer = () => {
            if (timeoutRef.current !== null) {
                clearTimeout(timeoutRef.current);
                timeoutRef.current = null;
            }
        };

        const setDoneThenClear = () => {
            clearTimer();
            setStatus('done');
            timeoutRef.current = window.setTimeout(() => {
                setStatus('');
                timeoutRef.current = null;
            }, 1200);
        };

        const mine = (s?: string) => symbol === undefined || s === undefined || s === symbol;

        const unsubs = [
            eventBus.on('data:status', (p) => {
                if (p.status !== 'loading' || !mine(p.symbol)) return;
                clearTimer();
                setStatus('loading');
            }),
            eventBus.on('data:preview', (p) => {
                if (!mine(p.symbol)) return;
                clearTimer();
                setStatus('preview');
            }),
            eventBus.on('data:load', (p) => mine(p.symbol) && setDoneThenClear()),
            eventBus.on('data:prepend', (p) => mine(p.symbol) && setDoneThenClear()),
        ];
        return () => {
            clearTimer();
            unsubs.forEach((fn) => fn());
        };
    }, [eventBus, symbol]);

    const icon =
        status === 'done' ? <Check size={9} strokeWidth={3} /> : <MiniSpinner />;
    const label =
        status === 'preview' ? 'Preview data' : status === 'done' ? 'Up to date' : 'Loading data';

    if(status){
        return (
            <StatusChip
                icon={icon}
                label={label}
                visible={true}
                className="bottom-9"
                style={{right: priceScaleWidth + 8}}
            />
        );
    }
}
