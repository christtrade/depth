import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
    ArrowDown,
    ArrowUp,
    ChevronsDownUp,
    ChevronsUpDown,
    Dot,
    Eye,
    EyeOff,
    Maximize2,
    Minimize2,
    Settings2,
    Trash2,
    X,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { cn } from '../../lib/utils';
import type { ChartPane, Indicator } from '../../lib/types/indicator-types';
import type { TypedEventBus } from '../../core/TypedEventBus';
import type { SymbolInfo, TradingSession } from '../../interfaces/IDataAdapter';
import type { SessionStatus } from '../../core/SessionUtils';
import { SessionStatusBadge } from './session-status-badge';
import { SymbolIcon } from './symbol-icon';

export interface PaneLegendProps {
    pane: ChartPane;
    indicators: Indicator[];
    onToggleIndicator: (indicatorId: string) => void;
    onRemoveIndicator: (indicatorId: string) => void;
    onOpenSettings: (id: string) => void;
    onOpenTfSelect: () => void;
    eventBus: TypedEventBus;
    session: TradingSession | null;
    horizon: bigint;
    sessionStatus: SessionStatus | null;
    statusBar?: ReactNode;
    symbolInfo: SymbolInfo;
}

export function PaneLegend({
    pane,
    indicators,
    onToggleIndicator,
    onRemoveIndicator,
    onOpenSettings,
    onOpenTfSelect,
    eventBus,
    session,
    horizon,
    sessionStatus,
    statusBar,
    symbolInfo
}: PaneLegendProps) {
    const [nameHovered, setNameHovered] = useState<string | null>(null);
    const [tapOpened, setTapOpened] = useState<string | null>(null);
    const pointerTypeRef = useRef('mouse');
    useEffect(() => {
        if (!tapOpened) return;
        const close = (e: PointerEvent) => {
            const row = (e.target as Element).closest?.('[data-indicator-row]');
            if (row?.getAttribute('data-indicator-row') !== tapOpened) setTapOpened(null);
        };
        document.addEventListener('pointerdown', close, true);
        return () => document.removeEventListener('pointerdown', close, true);
    }, [tapOpened]);

    const rowRef = useRef<HTMLDivElement>(null);
    const itemRef = useRef<HTMLDivElement>(null);
    const nameRef = useRef<HTMLSpanElement>(null);
    const tfExMeasureRef = useRef<HTMLSpanElement>(null);
    const [tfExHidden, setTfExHidden] = useState(false);
    useLayoutEffect(() => {
        const row = rowRef.current;
        if (!row) return;
        const fit = () => {
            const name = nameRef.current;
            const item = itemRef.current;
            const measure = tfExMeasureRef.current;
            if (!name || !item || !measure) return;
            const truncated = name.scrollWidth > name.clientWidth;
            if (!tfExHidden) {
                if (truncated) setTfExHidden(true);
                return;
            }
            // +1 to avoid flicker
            const fullWidth =
                item.getBoundingClientRect().width + measure.getBoundingClientRect().width + 1;
            if (!truncated && fullWidth <= row.clientWidth) setTfExHidden(false);
        };
        fit();
        const ro = new ResizeObserver(fit);
        ro.observe(row);
        return () => ro.disconnect();
    }, [tfExHidden, pane.isMain, pane.tf, pane.exchange, pane.symbol, symbolInfo?.longName]);

    const tfEx = (
        <>
            <Dot className="text-muted-foreground w-2" />
            <span className="text-[1rem] text-white/90 select-none cursor-default [@media(hover:hover)]:hover:bg-muted px-1.5 rounded-sm -mx-1" onClick={onOpenTfSelect}>
                {pane.tf}
            </span>
            <Dot className="text-muted-foreground w-2 -ml-px" />
            <span className="text-[1rem] text-white/90 select-none cursor-default ml-px">
                {pane.exchange}
            </span>
        </>
    );

    const paneIndicators = indicators.filter(
        (ind) => ind.paneId === pane.id || (ind.layout === 'overlay' && pane.isMain),
    );

    return (
        <div
            className="flex items-center justify-between px-2 h-7 z-10 w-full min-w-0"
            style={{ pointerEvents: 'none' }}
        >
            <div className="flex gap-1 min-w-0 flex-col pt-1 h-full w-full">
                {pane.isMain && (
                    <div ref={rowRef} className="flex flex-row items-center flex-wrap gap-x-2 gap-y-0.5 min-w-0">
                        <div
                            ref={itemRef}
                            className="relative flex items-center gap-0.5 min-w-0 max-w-full [@media(hover:hover)]:hover:bg-card rounded-sm border border-transparent [@media(hover:hover)]:hover:border-border [&>*]:shrink-0"
                            style={{ pointerEvents: 'auto' }}
                            onPointerEnter={(e) => e.pointerType === 'mouse' && setNameHovered(pane.id)}
                            onPointerLeave={(e) => e.pointerType === 'mouse' && setNameHovered(null)}
                            onMouseDown={(e) => {
                                if (e.button === 1) onRemoveIndicator(pane.id);
                            }}
                        >
                            <span className="text-[1rem] text-white/90 flex items-center gap-0.5 select-none cursor-default [@media(hover:hover)]:hover:bg-muted px-1.5 rounded-sm -mr-1 min-w-0 !shrink" onClick={() => eventBus.emit('chart:open-symbol-select', ({}))}>
                                {(symbolInfo?.legendIcon ?? symbolInfo?.icon) && (
                                    <span className='pr-1 shrink-0'>
                                        <SymbolIcon icon={symbolInfo?.legendIcon ?? symbolInfo?.icon} size={18} />
                                    </span>
                                )}
                                <span ref={nameRef} className="truncate">{symbolInfo?.longName ?? pane.symbol}</span>
                            </span>
                            {!tfExHidden && tfEx}
                            <span
                                ref={tfExMeasureRef}
                                aria-hidden
                                className="absolute left-0 top-0 invisible pointer-events-none flex items-center gap-0.5 pl-0.5 whitespace-nowrap"
                            >
                                {tfEx}
                            </span>
                            {sessionStatus && (
                                <SessionStatusBadge
                                    eventBus={eventBus}
                                    session={session}
                                    horizon={horizon}
                                    sessionStatus={sessionStatus}
                                    symbol={symbolInfo?.symbol}
                                />
                            )}
                        </div>
                        {statusBar}
                    </div>
                )}
                <div className="flex flex-col gap-0 -ml-1 min-w-0">
                    {paneIndicators.map((ind) => (
                        <div
                            key={ind.id}
                            // :hover sticks after a tap, so touch gets its highlight from tapOpened instead
                            className={cn(
                                'flex items-center gap-0.5 self-start max-w-full min-w-0 py-0.5 rounded-sm px-1 duration-100 border border-transparent [@media(hover:hover)]:hover:bg-card [@media(hover:hover)]:hover:duration-0 [@media(hover:hover)]:hover:border-border',
                                tapOpened === ind.id && 'bg-card border-border',
                            )}
                            style={{ pointerEvents: 'auto' }}
                            data-indicator-row={ind.id}
                            // pointer instead of mouse (tap fakes a mouseenter that never leaves)
                            onPointerEnter={(e) => e.pointerType === 'mouse' && setNameHovered(ind.id)}
                            onPointerLeave={(e) => e.pointerType === 'mouse' && setNameHovered(null)}
                            onPointerDown={(e) => {
                                pointerTypeRef.current = e.pointerType;
                            }}
                            onClick={(e) => {
                                if (pointerTypeRef.current === 'mouse') return;
                                if ((e.target as Element).closest('button')) return;
                                setTapOpened((open) => (open === ind.id ? null : ind.id));
                            }}
                            onMouseDown={(e) => {
                                if (e.button === 1) onRemoveIndicator(ind.id);
                            }}
                            onDoubleClick={() => {onOpenSettings(ind.id)}}
                        >
                            <span
                                className={cn(
                                    'text-[13px] text-muted-foreground select-none mr-1 cursor-default truncate min-w-0',
                                    !ind.visible && 'opacity-50',
                                )}
                            >
                                {ind.name}
                            </span>
                            <div
                                className={cn(
                                    'flex items-center gap-0.5 shrink-0 transition-opacity duration-100',
                                    nameHovered === ind.id || tapOpened === ind.id
                                        ? 'opacity-100'
                                        : 'opacity-0 pointer-events-none',
                                )}
                            >
                                <Tooltip delayDuration={700}>
                                    <TooltipTrigger asChild>
                                        <button
                                            className="p-0.5 px-1 [@media(pointer:coarse)]:p-1.5 rounded [@media(hover:hover)]:hover:bg-white/10 text-muted-foreground [@media(hover:hover)]:hover:text-foreground transition-colors"
                                            onClick={() => onToggleIndicator(ind.id)}
                                        >
                                            {ind.visible ? <Eye size={13} /> : <EyeOff size={13} />}
                                        </button>
                                    </TooltipTrigger>
                                    <TooltipContent className="bg-background border border-border">
                                        {ind.visible ? 'Hide indicator' : 'Show indicator'}
                                    </TooltipContent>
                                </Tooltip>
                                <Tooltip delayDuration={700}>
                                    <TooltipTrigger asChild>
                                        <button
                                            className="p-0.5 px-1 [@media(pointer:coarse)]:p-1.5 rounded [@media(hover:hover)]:hover:bg-white/10 text-muted-foreground [@media(hover:hover)]:hover:text-foreground transition-colors"
                                            onClick={() => onOpenSettings(ind.id)}
                                        >
                                            <Settings2 size={13} />
                                        </button>
                                    </TooltipTrigger>
                                    <TooltipContent className="bg-background border border-border">
                                        Settings
                                    </TooltipContent>
                                </Tooltip>
                                <Tooltip delayDuration={700}>
                                    <TooltipTrigger asChild>
                                        <button
                                            className="p-0.5 px-1 [@media(pointer:coarse)]:p-1.5 rounded [@media(hover:hover)]:hover:bg-white/10 text-muted-foreground [@media(hover:hover)]:hover:text-red-400 transition-colors"
                                            onClick={() => onRemoveIndicator(ind.id)}
                                        >
                                            <Trash2 size={13} />
                                        </button>
                                    </TooltipTrigger>
                                    <TooltipContent className="bg-background border border-border">
                                        Remove indicator
                                    </TooltipContent>
                                </Tooltip>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

export interface PaneLegendScaleProps {
    pane: ChartPane;
    paneIndex: number;
    totalPanes: number;
    onMoveUp: (paneId: string) => void;
    onMoveDown: (paneId: string) => void;
    onRemovePane: (paneId: string) => void;
    onCollapse: (paneId: string) => void;
    onExpand: (paneId: string) => void;
    onMaximize: (paneId: string) => void;
    isMaximized: boolean;
    isCollapsed: boolean;
    onEnter: () => void;
    onLeave: () => void;
    eventBus: TypedEventBus;
}

export function PaneLegendScale({
    pane,
    paneIndex,
    totalPanes,
    onMoveUp,
    onMoveDown,
    onRemovePane,
    onCollapse,
    onMaximize,
    isMaximized,
    isCollapsed,
    onEnter,
    onLeave,
    eventBus,
}: PaneLegendScaleProps) {
    const [hoveredId, setHoveredId] = useState<string | null>(null);

    useEffect(() => {
        return eventBus.on('pane:hovered', (payload) => payload && (setHoveredId(payload.id)));
    }, [eventBus]);

    return (
        <div
            className={cn(
                'flex items-center gap-0.5 transition-opacity duration-100 shrink-0',
                hoveredId === pane.id ? 'opacity-100' : 'opacity-0',
            )}
            style={{ pointerEvents: hoveredId === pane.id ? 'auto' : 'none' }}
            onMouseEnter={onEnter}
            onMouseLeave={onLeave}
        >
            {paneIndex > 0 && (
                <Tooltip delayDuration={700}>
                    <TooltipTrigger asChild>
                        <button
                            className="p-0.5 rounded hover:bg-white/10 text-muted-foreground hover:text-foreground transition-colors"
                            onClick={() => onMoveUp(pane.id)}
                        >
                            <ArrowUp size={12} />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent className="bg-background border border-border">
                        Move pane up
                    </TooltipContent>
                </Tooltip>
            )}
            {paneIndex < totalPanes - 1 && (
                <Tooltip delayDuration={700}>
                    <TooltipTrigger asChild>
                        <button
                            className="p-0.5 rounded hover:bg-white/10 text-muted-foreground hover:text-foreground transition-colors"
                            onClick={() => onMoveDown(pane.id)}
                        >
                            <ArrowDown size={12} />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent className="bg-background border border-border">
                        Move pane down
                    </TooltipContent>
                </Tooltip>
            )}
            {!pane.isMain && (
                <>
                    <Tooltip delayDuration={700}>
                        <TooltipTrigger asChild>
                            <button
                                className="p-0.5 rounded hover:bg-white/10 text-muted-foreground hover:text-red-400 transition-colors"
                                onClick={() => onRemovePane(pane.id)}
                            >
                                <X size={12} />
                            </button>
                        </TooltipTrigger>
                        <TooltipContent className="bg-background border border-border">
                            Remove pane
                        </TooltipContent>
                    </Tooltip>
                    <Tooltip delayDuration={700}>
                        <TooltipTrigger asChild>
                            <button
                                className={cn(
                                    'p-0.5 rounded hover:bg-white/10 text-muted-foreground hover:text-foreground transition-colors',
                                    isCollapsed && 'bg-muted text-white',
                                )}
                                onClick={() => onCollapse(pane.id)}
                            >
                                {isCollapsed ? (
                                    <ChevronsUpDown size={12} />
                                ) : (
                                    <ChevronsDownUp size={12} />
                                )}
                            </button>
                        </TooltipTrigger>
                        <TooltipContent className="bg-background border border-border">
                            Collapse pane
                        </TooltipContent>
                    </Tooltip>
                </>
            )}
            {pane.isMain && totalPanes > 1 && (
                <Tooltip delayDuration={700}>
                    <TooltipTrigger asChild>
                        <button
                            className={cn(
                                'p-0.5 rounded hover:bg-white/10 text-muted-foreground hover:text-foreground transition-colors',
                                isMaximized && 'bg-muted text-white',
                            )}
                            onClick={() => onMaximize(pane.id)}
                        >
                            {isMaximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                        </button>
                    </TooltipTrigger>
                    <TooltipContent className="bg-background border border-border">
                        {isMaximized ? 'Restore panes' : 'Maximize pane'}
                    </TooltipContent>
                </Tooltip>
            )}
        </div>
    );
}
