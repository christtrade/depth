import { useEffect, useState, type ReactNode } from 'react';
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
                    <div className="flex flex-row items-center flex-wrap gap-x-2 gap-y-0.5 min-w-0">
                        <div
                            className="flex items-center gap-0.5 hover:bg-[#1a1d23] rounded-sm border border-transparent hover:border-border"
                            style={{ pointerEvents: 'auto' }}
                            onMouseEnter={() => setNameHovered(pane.id)}
                            onMouseLeave={() => setNameHovered(null)}
                            onMouseDown={(e) => {
                                if (e.button === 1) onRemoveIndicator(pane.id);
                            }}
                        >
                            <span className="text-[1rem] text-white/90 flex items-center gap-0.5 select-none cursor-default hover:bg-muted px-1.5 rounded-sm -mr-1" onClick={() => eventBus.emit('chart:open-symbol-select', ({}))}>
                                {(symbolInfo?.legendIcon ?? symbolInfo?.icon) && (
                                    <span className='pr-1'>
                                        <SymbolIcon icon={symbolInfo?.legendIcon ?? symbolInfo?.icon} size={18} />
                                    </span>
                                )}
                                {symbolInfo?.longName ?? pane.symbol}
                            </span>
                            <Dot className="text-muted-foreground w-2" />
                            <span className="text-[1rem] text-white/90 select-none cursor-default hover:bg-muted px-1.5 rounded-sm -mx-1" onClick={onOpenTfSelect}>
                                {pane.tf}
                            </span>
                            <Dot className="text-muted-foreground w-2 -ml-px" />
                            <span className="text-[1rem] text-white/90 select-none cursor-default ml-px">
                                {pane.exchange}
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
                <div className="flex flex-col gap-0 -ml-1">
                    {paneIndicators.map((ind) => (
                        <div
                            key={ind.id}
                            className="flex items-center gap-0.5 self-start py-0.5 hover:bg-[#1a1d23] rounded-sm px-1 duration-100 hover:duration-0 border border-transparent hover:border-border"
                            style={{ pointerEvents: 'auto' }}
                            onMouseEnter={() => setNameHovered(ind.id)}
                            onMouseLeave={() => setNameHovered(null)}
                            onMouseDown={(e) => {
                                if (e.button === 1) onRemoveIndicator(ind.id);
                            }}
                            onDoubleClick={() => {onOpenSettings(ind.id)}}
                        >
                            <span
                                className={cn(
                                    'text-[13px] text-muted-foreground select-none mr-1 cursor-default',
                                    !ind.visible && 'opacity-50',
                                )}
                            >
                                {ind.name}
                            </span>
                            <div
                                className={cn(
                                    'flex items-center gap-0.5 transition-opacity duration-100',
                                    nameHovered === ind.id ? 'opacity-100' : 'opacity-0',
                                )}
                            >
                                <Tooltip delayDuration={700}>
                                    <TooltipTrigger asChild>
                                        <button
                                            className="p-0.5 px-1 rounded hover:bg-white/10 text-muted-foreground hover:text-foreground transition-colors"
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
                                            className="p-0.5 px-1 rounded hover:bg-white/10 text-muted-foreground hover:text-foreground transition-colors"
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
                                            className="p-0.5 px-1 rounded hover:bg-white/10 text-muted-foreground hover:text-red-400 transition-colors"
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
        </div>
    );
}
