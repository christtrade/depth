import { useEffect, useId, useState, type ReactNode } from 'react';
import {
    FileQuestion,
    Lock,
    RefreshCw,
    SearchX,
    ServerCrash,
    Timer,
    TriangleAlert,
    WifiOff,
} from 'lucide-react';
import { cn } from '../../lib/utils';

function Spinner({ size = 20 }: { size?: number }) {
    const id = useId();
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            className="animate-spin [animation-duration:200ms]"
            aria-hidden
        >
            <defs>
                <linearGradient id={id} x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#16c4b0" />
                    <stop offset="100%" stopColor="#06b6d4" />
                </linearGradient>
            </defs>
            <circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeWidth="2" opacity={0.12} />
            <path
                d="M21.5 12A9.5 9.5 0 0 0 12 2.5"
                stroke={`url(#${id})`}
                strokeWidth="2"
                strokeLinecap="round"
            />
        </svg>
    );
}

function useDelayedReveal(delayMs: number): { mounted: boolean; visible: boolean } {
    const [mounted, setMounted] = useState(delayMs <= 0);
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        if (mounted) return;
        const t = setTimeout(() => setMounted(true), delayMs);
        return () => clearTimeout(t);
    }, [delayMs, mounted]);

    useEffect(() => {
        if (!mounted) return;
        const raf = requestAnimationFrame(() => setVisible(true));
        return () => cancelAnimationFrame(raf);
    }, [mounted]);

    return { mounted, visible };
}

export interface ChartLoadingOverlayProps {
    symbol?: string | null;
    timeframe?: string | null;
    delayMs?: number;
}

export function ChartLoadingOverlay({
    symbol,
    timeframe,
    delayMs = 220,
}: ChartLoadingOverlayProps) {
    const { mounted, visible } = useDelayedReveal(delayMs);
    if (!mounted) return null;

    const context = [symbol, timeframe].filter(Boolean).join('  ·  ');

    return (
        <div
            className={cn(
                'absolute inset-0 z-10 flex items-center justify-center',
                'bg-background/75 backdrop-blur-[2px]',
                'transition-opacity duration-200',
                visible ? 'opacity-100' : 'opacity-0',
            )}
        >
            <div className="flex flex-col items-center gap-2.5 px-6 text-center">
                <Spinner />
                <div className="flex flex-col gap-0.5">
                    <span className="text-[13px] leading-none text-white/80">
                        Loading market data
                    </span>
                    {context && (
                        <span className="text-[11px] leading-none text-muted-foreground tabular-nums">
                            {context}
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
}

export type DataErrorTier = 'empty' | 'notice' | 'error';

export interface DataErrorPresentation {
    tier: DataErrorTier;
    title: string;
    body: string;
    icon: ReactNode;
    canRetry: boolean;
}

export function describeDataError(
    code: string,
    message?: string | null,
    symbol?: string | null,
): DataErrorPresentation {
    const what = symbol ? `for ${symbol}` : 'here';

    switch (code) {
        case 'no_data':
            return {
                tier: 'empty',
                title: 'No data here',
                body: `Nothing came back ${what} in this range. Try a wider range or another interval.`,
                icon: <SearchX size={18} />,
                canRetry: false,
            };
        case 'not_found':
            return {
                tier: 'empty',
                title: 'Symbol not found',
                body: symbol
                    ? `The data source doesn't know ${symbol}.`
                    : "The data source doesn't have this symbol.",
                icon: <FileQuestion size={18} />,
                canRetry: false,
            };
        case 'unauthenticated':
            return {
                tier: 'notice',
                title: 'Session expired',
                body: 'Sign in again to keep loading market data.',
                icon: <Lock size={18} />,
                canRetry: false,
            };
        case 'forbidden':
            return {
                tier: 'notice',
                title: 'No access to this data',
                body: symbol
                    ? `This account can't load ${symbol}.`
                    : "This account can't load this data.",
                icon: <Lock size={18} />,
                canRetry: false,
            };
        case 'rate_limited':
            return {
                tier: 'notice',
                title: 'Rate limited',
                body: 'The data source is throttling requests. Give it a moment.',
                icon: <Timer size={18} />,
                canRetry: true,
            };
        case 'network_error':
            return {
                tier: 'notice',
                title: "Can't reach the data source",
                body: 'Check your connection and try again.',
                icon: <WifiOff size={18} />,
                canRetry: true,
            };
        case 'server_error':
            return {
                tier: 'notice',
                title: 'The data source is having trouble',
                body: 'Nothing wrong on your end. Try again in a moment.',
                icon: <ServerCrash size={18} />,
                canRetry: true,
            };
        case 'decode_error':
            return {
                tier: 'error',
                title: "Couldn't read the response",
                body: "The data came back in a shape this chart can't read.",
                icon: <TriangleAlert size={18} />,
                canRetry: true,
            };
        default:
            return {
                tier: 'error',
                title: "Couldn't load data",
                body: message?.trim() || 'Something went wrong while loading this chart.',
                icon: <TriangleAlert size={18} />,
                canRetry: true,
            };
    }
}

export interface ChartErrorOverlayProps {
    code: string;
    message?: string | null;
    symbol?: string | null;
    timeframe?: string | null;
    onRetry?: () => void;
}

export function ChartErrorOverlay({
    code,
    message,
    symbol,
    timeframe,
    onRetry,
}: ChartErrorOverlayProps) {
    const [showDetails, setShowDetails] = useState(false);
    const { tier, title, body, icon, canRetry } = describeDataError(code, message, symbol);

    return (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background">
            <div className="flex max-w-[19rem] flex-col items-center gap-3 px-6 text-center">
                <div
                    className={cn(
                        'flex items-center justify-center',
                        tier === 'empty'
                            ? 'text-muted-foreground/70'
                            : tier === 'notice'
                              ? 'h-10 w-10 rounded-full bg-amber-400/10 text-amber-400/90'
                              : 'h-10 w-10 rounded-full bg-destructive/10 text-destructive',
                    )}
                >
                    {icon}
                </div>

                <div className="flex flex-col gap-1">
                    <span className="text-[13px] font-semibold leading-snug text-white/90">
                        {title}
                    </span>
                    <span className="text-[11.5px] leading-relaxed text-muted-foreground">
                        {body}
                    </span>
                    {(symbol || timeframe) && tier === 'empty' && (
                        <span className="mt-0.5 text-[11px] leading-none text-muted-foreground/60 tabular-nums">
                            {[symbol, timeframe].filter(Boolean).join('  ·  ')}
                        </span>
                    )}
                </div>

                {canRetry && onRetry && (
                    <button
                        onClick={onRetry}
                        className={cn(
                            'inline-flex items-center gap-1.5 rounded-md border border-border',
                            'bg-muted/40 px-2.5 py-1 text-[11.5px] font-medium text-white/80',
                            'transition-colors hover:bg-muted hover:text-white',
                        )}
                    >
                        <RefreshCw size={11} />
                        Try again
                    </button>
                )}

                {(code || message) && (
                    <div className="flex flex-col items-center gap-1">
                        <button
                            onClick={() => setShowDetails((v) => !v)}
                            className="text-[10.5px] text-muted-foreground/50 underline-offset-2 transition-colors hover:text-muted-foreground hover:underline"
                        >
                            {showDetails ? 'Hide details' : 'Details'}
                        </button>
                        {showDetails && (
                            <div className="flex flex-col gap-0.5 text-[10.5px] leading-relaxed text-muted-foreground/60">
                                <span className="font-mono tabular-nums">{code || 'unknown'}</span>
                                {message && <span className="break-words">{message}</span>}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
