//  The visual language for trade-lifecycle notifications.
//
//  One card component, one tone scale, a handful of semantic helpers. Domain
//  code (the matching engine, useTradingState) calls notify*() and never touches
//  styling - so every toast in the product looks like it came from the same hand.
//
//  built on sonner's toast.custom() so we own the whole surface rather than
//  fighting the default chrome - the host Toaster's li is neutralised inline.
//
//  colour is rationed: emerald and rose are reserved for realised p&l, so opens
//  and bracket edits read as calm confirmations instead of a traffic light.
//  numerics are tabular so values line up across stacked toasts.
import type { ReactNode } from 'react';
import { toast as sonnerToast } from 'sonner';
import {
    ArrowDownRight,
    ArrowUpRight,
    CheckCircle2,
    Info,
    Minus,
    Shield,
    Target,
    TrendingDown,
    TrendingUp,
    TriangleAlert,
    type LucideIcon,
} from 'lucide-react';
import { cn } from '../utils';
import type { CloseReason, PositionSide } from '../types/trading-types';

// Tone scale
// `chip` tints the icon plate; `fg` colours the glyph and any emphasised metric.

type Tone = 'success' | 'loss' | 'info' | 'neutral';

const TONE: Record<Tone, { chip: string; fg: string }> = {
    success: { chip: 'bg-emerald-500/10', fg: 'text-emerald-600 dark:text-emerald-400' },
    loss: { chip: 'bg-rose-500/10', fg: 'text-rose-600 dark:text-rose-400' },
    info: { chip: 'bg-sky-500/10', fg: 'text-sky-600 dark:text-sky-400' },
    neutral: { chip: 'bg-muted', fg: 'text-muted-foreground' },
};

// Card
interface TradeToastCardProps {
    tone: Tone;
    icon: LucideIcon;
    title: ReactNode;
    subtitle?: ReactNode;
    /** Right-aligned emphasised figure, e.g. realised P&L. */
    metric?: string;
    /** Colour of `metric`; defaults to the card tone. */
    metricTone?: Tone;
    /** Quieter line beneath `metric`, e.g. the R multiple. */
    metricSub?: string;
}

function TradeToastCard({
    tone,
    icon: Icon,
    title,
    subtitle,
    metric,
    metricTone,
    metricSub,
}: TradeToastCardProps) {
    const t = TONE[tone];
    const m = TONE[metricTone ?? tone];
    return (
        <div
            className={cn(
                'pointer-events-auto flex w-full select-none items-center gap-3',
                'rounded-xl border border-border/70 bg-popover/95 px-3.5 py-3',
                'text-popover-foreground shadow-lg shadow-black/[0.08] ring-1 ring-black/[0.02]',
                'backdrop-blur-sm',
            )}
        >
            <span
                className={cn(
                    'grid size-9 shrink-0 place-items-center rounded-lg',
                    t.chip,
                    t.fg,
                )}
            >
                <Icon className="size-[18px]" strokeWidth={2.25} aria-hidden />
            </span>

            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-[13px] font-medium leading-tight text-foreground">
                    {title}
                </span>
                {subtitle != null && (
                    <span className="truncate text-[12px] leading-tight text-muted-foreground">
                        {subtitle}
                    </span>
                )}
            </div>

            {metric != null && (
                <div className="flex shrink-0 flex-col items-end gap-0.5 pl-1">
                    <span
                        className={cn(
                            'text-[13px] font-semibold leading-tight tabular-nums',
                            m.fg,
                        )}
                    >
                        {metric}
                    </span>
                    {metricSub != null && (
                        <span className="text-[11px] leading-tight tabular-nums text-muted-foreground">
                            {metricSub}
                        </span>
                    )}
                </div>
            )}
        </div>
    );
}

// Renderer
// Neutralise the host li inline so our card is the only chrome on screen,
// regardless of the app's global <Toaster/> classNames.

function render(props: TradeToastCardProps, duration = 4200) {
    return sonnerToast.custom(() => <TradeToastCard {...props} />, {
        duration,
        position: 'bottom-left',
        style: {
            background: 'transparent',
            border: 'none',
            boxShadow: 'none',
            padding: 0,
        },
    });
}

// Formatting
const usdFmt = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    signDisplay: 'always',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
});

function fmtUsd(n: number): string {
    return usdFmt.format(n);
}

function fmtR(r: number): string {
    return `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`;
}

function decimalsFor(tickSize?: number): number {
    if (!tickSize || tickSize <= 0) return 2;
    const s = tickSize.toString();
    const dot = s.indexOf('.');
    return dot === -1 ? 0 : s.length - dot - 1;
}

function fmtPrice(price: number, tickSize?: number): string {
    const d = decimalsFor(tickSize);
    return price.toLocaleString('en-US', {
        minimumFractionDigits: d,
        maximumFractionDigits: d,
    });
}

function sideLabel(side: PositionSide): string {
    return side === 'long' ? 'Long' : side === 'short' ? 'Short' : 'Position';
}

function closeReasonLabel(reason: CloseReason | undefined, partial: boolean): string {
    switch (reason) {
        case 'tp':
            return 'Take-profit hit';
        case 'sl':
            return 'Stop-loss hit';
        case 'manual':
            return 'Closed manually';
        case 'market':
            return 'Market order';
        case 'limit':
            return 'Limit order';
        case 'stop':
            return 'Stop order';
        default:
            return partial ? 'Partial close' : 'Position closed';
    }
}

// Public API
export function notifyPositionOpened(p: {
    side: PositionSide;
    symbol: string;
    qty: number;
    entryPrice: number;
    tickSize?: number;
}): void {
    const Side = sideLabel(p.side);
    const unit = p.qty === 1 ? 'contract' : 'contracts';
    render({
        tone: 'success',
        icon: p.side === 'short' ? ArrowDownRight : ArrowUpRight,
        title: `${Side} ${p.symbol} opened`,
        subtitle: `Filled ${p.qty} ${unit} @ ${fmtPrice(p.entryPrice, p.tickSize)}`,
    });
}

export function notifyPositionClosed(p: {
    side: PositionSide;
    symbol: string;
    pnl: number;
    rMultiple?: number;
    reason?: CloseReason;
    partial?: boolean;
}): void {
    const partial = p.partial ?? false;
    const tone: Tone = p.pnl > 0.005 ? 'success' : p.pnl < -0.005 ? 'loss' : 'neutral';
    const Side = sideLabel(p.side);

    const title = partial
        ? `Scaled out of ${Side} ${p.symbol}`
        : tone === 'success'
          ? `${Side} ${p.symbol} closed in profit`
          : tone === 'loss'
            ? p.reason === 'sl'
                ? `${Side} ${p.symbol} stopped out`
                : `${Side} ${p.symbol} closed in the red`
            : `${Side} ${p.symbol} closed at breakeven`;

    const hasR =
        p.rMultiple != null && Number.isFinite(p.rMultiple) && Math.abs(p.rMultiple) > 0.001;

    render({
        tone,
        icon: tone === 'success' ? TrendingUp : tone === 'loss' ? TrendingDown : Minus,
        title,
        subtitle: closeReasonLabel(p.reason, partial),
        metric: fmtUsd(p.pnl),
        metricTone: tone,
        metricSub: hasR ? fmtR(p.rMultiple!) : undefined,
    });
}

/** Generic, non-domain message - keeps ad-hoc toasts on the same design system. */
export function notifyMessage(
    title: string,
    opts?: { description?: string; tone?: Tone },
): void {
    const tone = opts?.tone ?? 'neutral';
    const icon =
        tone === 'success'
            ? CheckCircle2
            : tone === 'loss'
              ? TriangleAlert
              : tone === 'info'
                ? Info
                : Info;
    render({ tone, icon, title, subtitle: opts?.description });
}

export function notifyBracketMoved(p: {
    kind: 'tp' | 'sl' | 'be';
    symbol: string;
    price: number;
    tickSize?: number;
    /** True when the level was just created rather than dragged to a new price. */
    created?: boolean;
}): void {
    const spec =
        p.kind === 'tp'
            ? { icon: Target, noun: 'Take-profit' }
            : p.kind === 'sl'
              ? { icon: Shield, noun: 'Stop-loss' }
              : { icon: Minus, noun: 'Break-even' };

    const verb = p.kind === 'be' ? 'set' : p.created ? 'set' : 'moved';

    render(
        {
            tone: 'success',
            icon: spec.icon,
            title: `${spec.noun} ${verb}`,
            subtitle: `${p.symbol} @ ${fmtPrice(p.price, p.tickSize)}`,
        },
        2800,
    );
}
