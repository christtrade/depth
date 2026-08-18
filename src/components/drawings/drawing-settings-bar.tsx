'use client';

import { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'react';
import { cn } from '../../lib/utils';
import {
    Trash2,
    Lock,
    Unlock,
    MoreHorizontal,
    Copy,
    GripVertical,
    Settings,
    Ticket,
    type LucideIcon,
} from 'lucide-react';
import { DrawingSettingsDialog } from './drawing-settings-dialog';
import type { Drawing, DrawingTool } from '../../lib/types/drawing-types';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { ColorPicker } from '../ui/color-picker';

const DASH_PRESETS: { label: string; dash: number[] }[] = [
    { label: '─────', dash: [] },
    { label: '----', dash: [6, 3] },
    { label: '····', dash: [2, 3] },
    { label: '─·─', dash: [8, 3, 2, 3] },
];

const LINE_WIDTHS = [1, 2, 3, 4];

const DEFAULT_POS = { x: 16, y: 16 };
const VIEWPORT_PADDING = 12;

let _rememberedPos: { x: number; y: number } | null = null;

type BarField =
    | { type: 'color'; patchKey: string; label: string }
    | { type: 'borderColor'; patchKey: string; label?: string }
    | { type: 'fillColor'; patchKey: string; label?: string }
    | { type: 'lineWidth'; patchKey: string; label?: string }
    | { type: 'dash'; patchKey: string; label?: string }
    | { type: 'fibColor' }
    | { type: 'fibBgToggle'; enableKey: string }
    | { type: 'fibBgColor'; patchKey: string; gateKey: string; label?: string }
    | { type: 'sep' }
    | { type: 'fvpMode' }
    | {
          type: 'button';
          onClick: (drawing: Drawing, actions: BarActions) => void;
          icon: LucideIcon;
          label: string;
      };

interface BarActions {
    requestOrderTicket: (drawingId: string) => void;
}

function openPositionTicket(drawing: Drawing, { requestOrderTicket }: BarActions) {
    requestOrderTicket(drawing.id);
}


const BAR_SCHEMA: Partial<Record<DrawingTool, BarField[]>> = {
    hline: [
        { type: 'color', patchKey: 'color', label: 'Color' },
        { type: 'sep' },
        { type: 'lineWidth', patchKey: 'lineWidth' },
        { type: 'sep' },
        { type: 'dash', patchKey: 'dash' },
    ],
    vline: [
        { type: 'color', patchKey: 'color', label: 'Color' },
        { type: 'sep' },
        { type: 'lineWidth', patchKey: 'lineWidth' },
        { type: 'sep' },
        { type: 'dash', patchKey: 'dash' },
    ],
    'extended-line': [
        { type: 'color', patchKey: 'color', label: 'Color' },
        { type: 'sep' },
        { type: 'lineWidth', patchKey: 'lineWidth' },
        { type: 'sep' },
        { type: 'dash', patchKey: 'dash' },
    ],
    line: [
        { type: 'color', patchKey: 'color', label: 'Color' },
        { type: 'sep' },
        { type: 'lineWidth', patchKey: 'lineWidth' },
        { type: 'sep' },
        { type: 'dash', patchKey: 'dash' },
    ],
    'cross-line': [
        { type: 'color', patchKey: 'color', label: 'Color' },
        { type: 'sep' },
        { type: 'lineWidth', patchKey: 'lineWidth' },
        { type: 'sep' },
        { type: 'dash', patchKey: 'dash' },
    ],
    'info-line': [
        { type: 'color', patchKey: 'color', label: 'Color' },
        { type: 'sep' },
        { type: 'lineWidth', patchKey: 'lineWidth' },
        { type: 'sep' },
        { type: 'dash', patchKey: 'dash' },
    ],
    'trend-angle': [
        { type: 'color', patchKey: 'color', label: 'Color' },
        { type: 'sep' },
        { type: 'lineWidth', patchKey: 'lineWidth' },
        { type: 'sep' },
        { type: 'dash', patchKey: 'dash' },
    ],
    ray: [
        { type: 'color', patchKey: 'color', label: 'Color' },
        { type: 'sep' },
        { type: 'lineWidth', patchKey: 'lineWidth' },
        { type: 'sep' },
        { type: 'dash', patchKey: 'dash' },
    ],
    hray: [
        { type: 'color', patchKey: 'color', label: 'Color' },
        { type: 'sep' },
        { type: 'lineWidth', patchKey: 'lineWidth' },
        { type: 'sep' },
        { type: 'dash', patchKey: 'dash' },
    ],
    'parallel-channel': [
        { type: 'color', patchKey: 'color', label: 'Color' },
        { type: 'sep' },
        { type: 'lineWidth', patchKey: 'lineWidth' },
        { type: 'sep' },
        { type: 'dash', patchKey: 'dash' },
    ],
    rect: [
        { type: 'borderColor', patchKey: 'borderColor', label: 'Border Color' },
        { type: 'sep' },
        { type: 'lineWidth', patchKey: 'borderLineWidth', label: 'Border width' },
        { type: 'sep' },
        { type: 'dash', patchKey: 'borderDash', label: 'Border style' },
        { type: 'sep' },
        { type: 'fillColor', patchKey: 'fillColor', label: 'Fill color' },
    ],
    triangle: [
        { type: 'borderColor', patchKey: 'borderColor', label: 'Border Color' },
        { type: 'sep' },
        { type: 'lineWidth', patchKey: 'borderLineWidth', label: 'Border width' },
        { type: 'sep' },
        { type: 'dash', patchKey: 'borderDash', label: 'Border style' },
        { type: 'sep' },
        { type: 'fillColor', patchKey: 'fillColor', label: 'Fill color' },
    ],
    fib: [
        { type: 'fibColor' },
        { type: 'sep' },
        {
            type: 'fibBgColor',
            patchKey: 'backgroundColor',
            gateKey: 'enableBackground',
            label: 'Background color',
        },
        { type: 'sep' },
        {
            type: 'lineWidth',
            patchKey: 'lineWidth',
        },
    ],
    text: [{ type: 'color', patchKey: 'color', label: 'Color' }],
    fvp: [
        { type: 'fvpMode' },
        { type: 'sep' },
        { type: 'color', patchKey: 'buyColor', label: 'Buy color' },
        { type: 'sep' },
        { type: 'color', patchKey: 'sellColor', label: 'Sell color' },
    ],
    long: [
        { type: 'color', patchKey: 'upColor', label: 'Target Color' },
        { type: 'color', patchKey: 'downColor', label: 'Stop Color' },
        { type: 'sep' },
        {
            type: 'button',
            onClick: openPositionTicket,
            icon: Ticket,
            label: 'Create order from this drawing',
        },
    ],
    short: [
        { type: 'color', patchKey: 'downColor', label: 'Target Color' },
        { type: 'color', patchKey: 'upColor', label: 'Stop Color' },
        { type: 'sep' },
        {
            type: 'button',
            onClick: openPositionTicket,
            icon: Ticket,
            label: 'Create order from this drawing',
        },
    ],
};


interface DrawingSettingsBarProps {
    drawing: Drawing;
    containerRef: React.RefObject<HTMLElement>;
    onUpdate: (patch: Partial<Drawing>) => void;
    onDelete: () => void;
    onDuplicate: () => void;
    onClose: () => void;
    onMouseEnter?: () => void;
    onMouseLeave?: () => void;
    onRequestOrderTicket?: (drawingId: string) => void;
    openDialog?: boolean;
}

export function DrawingSettingsBar({
    drawing,
    containerRef,
    onUpdate,
    onDelete,
    onDuplicate,
    onClose,
    onMouseEnter,
    onMouseLeave,
    onRequestOrderTicket,
    openDialog: openDialogProp,
}: DrawingSettingsBarProps) {
    const barRef = useRef<HTMLDivElement>(null);
    const [showDialog, setShowDialog] = useState(false);

    const [openField, setOpenField] = useState<string | null>(null);
    const justClosedRef = useRef(false);

    const [localDrawing, setLocalDrawing] = useState<Drawing>(drawing);
    useEffect(() => {
        setLocalDrawing(drawing);
    }, [drawing.id]);

    const handleUpdate = useCallback(
        (patch: Partial<Drawing>) => {
            setLocalDrawing((prev) => ({ ...prev, ...patch }) as Drawing);
            onUpdate(patch);
        },
        [onUpdate],
    );

    const toggleField = useCallback((key: string) => {
        if (justClosedRef.current) {
            justClosedRef.current = false;
            return;
        }
        setOpenField((prev) => (prev === key ? null : key));
    }, []);
    const closeField = useCallback(() => setOpenField(null), []);

    useEffect(() => {
        if (openDialogProp) setShowDialog(true);
    }, [openDialogProp]);

    const posRef = useRef<{ x: number; y: number } | null>(_rememberedPos);
    if (posRef.current === null) {
        const rect = containerRef.current?.getBoundingClientRect();
        posRef.current = rect
            ? { x: rect.left + DEFAULT_POS.x, y: rect.top + DEFAULT_POS.y }
            : DEFAULT_POS;
    }

    useLayoutEffect(() => {
        const el = barRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const x = Math.max(
            VIEWPORT_PADDING,
            Math.min(window.innerWidth - rect.width - VIEWPORT_PADDING, posRef.current!.x),
        );
        const y = Math.max(
            VIEWPORT_PADDING,
            Math.min(window.innerHeight - rect.height - VIEWPORT_PADDING, posRef.current!.y),
        );
        if (x !== posRef.current!.x || y !== posRef.current!.y) {
            posRef.current = { x, y };
            _rememberedPos = posRef.current;
            el.style.left = `${x}px`;
            el.style.top = `${y}px`;
        }
    });
    const isDraggingRef = useRef(false);
    const [isDragging, setIsDragging] = useState(false);

    const onGrabMouseDown = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();

            setOpenField(null);

            const startMouseX = e.clientX;
            const startMouseY = e.clientY;
            const startPosX = posRef.current!.x;
            const startPosY = posRef.current!.y;

            isDraggingRef.current = true;
            setIsDragging(true);

            const onMouseMove = (ev: MouseEvent) => {
                const el = barRef.current;
                if (!el) return;

                const dx = ev.clientX - startMouseX;
                const dy = ev.clientY - startMouseY;

                let nx = startPosX + dx;
                let ny = startPosY + dy;

                const rect = el.getBoundingClientRect();

                nx = Math.max(
                    VIEWPORT_PADDING,
                    Math.min(window.innerWidth - rect.width - VIEWPORT_PADDING, nx),
                );
                ny = Math.max(
                    VIEWPORT_PADDING,
                    Math.min(window.innerHeight - rect.height - VIEWPORT_PADDING, ny),
                );

                posRef.current = { x: nx, y: ny };
                _rememberedPos = posRef.current;

                el.style.left = `${nx}px`;
                el.style.top = `${ny}px`;
            };

            const onMouseUp = () => {
                isDraggingRef.current = false;
                setIsDragging(false);
                window.removeEventListener('mousemove', onMouseMove);
                window.removeEventListener('mouseup', onMouseUp);
            };

            window.addEventListener('mousemove', onMouseMove);
            window.addEventListener('mouseup', onMouseUp);
        },
        [containerRef],
    );

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            const target = e.target as Node;
            if (barRef.current?.contains(target)) return;
            if (!containerRef.current?.contains(target)) return;
            onClose();
        };
        const t = setTimeout(() => window.addEventListener('mousedown', handler), 150);
        return () => {
            clearTimeout(t);
            window.removeEventListener('mousedown', handler);
        };
    }, [onClose, containerRef]);

    const get = (key: string) => (localDrawing as any)[key];
    //@ts-expect-error
    const locked = localDrawing.locked ?? false;

    const fibLevels: Array<{ id: string; color: string; enabled: boolean }> =
        localDrawing.tool === 'fib' ? (get('levels') ?? []) : [];
    const fibEnabledColors = fibLevels.filter((l) => l.enabled).map((l) => l.color);
    const allFibSameColor =
        fibEnabledColors.length > 0 && fibEnabledColors.every((c) => c === fibEnabledColors[0]);
    const fibUniformColor = allFibSameColor ? fibEnabledColors[0] : null;

    const schema = BAR_SCHEMA[localDrawing.tool] ?? [];
    const available = onRequestOrderTicket
        ? schema
        : schema.filter((field) => field.type !== 'button');
    const fields = available.filter(
        (field, i) =>
            field.type !== 'sep' || available.slice(i + 1).some((f) => f.type !== 'sep'),
    );

    const renderField = (field: BarField, idx: number) => {
        switch (field.type) {
            case 'sep':
                return <Sep key={`sep-${idx}`} />;

            case 'color': {
                const value = get(field.patchKey) as string | undefined;
                if (value === undefined) return null;
                const key = `color-${field.patchKey}`;
                return (
                    <div key={key} className="relative">
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <button
                                    className="flex items-center gap-1 px-1.5 py-1 rounded hover:bg-white/10 transition-colors"
                                    onClick={() => toggleField(key)}
                                >
                                    <span className="flex flex-col items-center gap-0.5">
                                        <PenIcon />
                                        <ColorBar color={value} />
                                    </span>
                                </button>
                            </TooltipTrigger>
                            <TooltipContent
                                side="bottom"
                                className="bg-background border border-border"
                            >
                                {field.label}
                            </TooltipContent>
                        </Tooltip>
                        <ColorPicker
                            onChange={(v) => {
                                handleUpdate({ [field.patchKey]: v } as any);
                            }}
                            value={value}
                            open={openField === key}
                            onOpenChange={(o) => {
                                if (!o) {
                                    justClosedRef.current = true;
                                    closeField();
                                }
                            }}
                            hideButton
                        />
                    </div>
                );
            }

            case 'borderColor': {
                const value = (get(field.patchKey) ?? get('color')) as string | undefined;
                if (value === undefined) return null;
                const key = `borderColor-${field.patchKey}`;
                return (
                    <div key={key} className="relative">
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <button
                                    className="flex items-center gap-1 px-1.5 py-1 rounded hover:bg-white/10 transition-colors"
                                    onMouseDown={(e) => {
                                        e.preventDefault();
                                        toggleField(key);
                                    }}
                                >
                                    <span className="flex flex-col items-center gap-0.5">
                                        <RectOutlineIcon />
                                        <ColorBar color={value} />
                                    </span>
                                </button>
                            </TooltipTrigger>
                            <TooltipContent
                                side="bottom"
                                className="bg-background border border-border"
                            >
                                {field.label ?? 'Border color'}
                            </TooltipContent>
                        </Tooltip>
                        <ColorPicker
                            onChange={(v) => {
                                handleUpdate({ [field.patchKey]: v } as any);
                            }}
                            value={value}
                            open={openField === key}
                            onOpenChange={(o) => {
                                if (!o) {
                                    justClosedRef.current = true;
                                    closeField();
                                }
                            }}
                            hideButton
                        />
                    </div>
                );
            }

            case 'fillColor': {
                const value = (get(field.patchKey) ?? get('color')) as string | undefined;
                if (value === undefined) return null;
                const key = `fillColor-${field.patchKey}`;
                return (
                    <div key={key} className="relative">
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <button
                                    className="flex items-center gap-1 px-1.5 py-1 rounded hover:bg-white/10 transition-colors"
                                    onClick={() => toggleField(key)}
                                >
                                    <span className="flex flex-col items-center gap-0.5">
                                        <RectFilledIcon />
                                        <ColorBar color={value} />
                                    </span>
                                </button>
                            </TooltipTrigger>
                            <TooltipContent
                                side="bottom"
                                className="bg-background border border-border"
                            >
                                {field.label ?? 'Fill color'}
                            </TooltipContent>
                        </Tooltip>
                        <ColorPicker
                            onChange={(v) => handleUpdate({ [field.patchKey]: v } as any)}
                            value={value}
                            open={openField === key}
                            onOpenChange={(o) => {
                                if (!o) {
                                    justClosedRef.current = true;
                                    closeField();
                                }
                            }}
                            hideButton
                        />
                    </div>
                );
            }

            case 'lineWidth': {
                const value = get(field.patchKey) as number | undefined;
                if (value === undefined) return null;
                const key = `lineWidth-${field.patchKey}`;
                return (
                    <div key={key} className="relative">
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <button
                                    className="flex items-center gap-1 px-1.5 py-1 rounded hover:bg-white/10 transition-colors text-muted-foreground text-[11px] font-mono"
                                    onClick={() => toggleField(key)}
                                >
                                    - {value}px
                                </button>
                            </TooltipTrigger>
                            <TooltipContent
                                side="bottom"
                                className="bg-background border border-border"
                            >
                                {field.label ?? 'Line width'}
                            </TooltipContent>
                        </Tooltip>
                        {openField === key && (
                            <div
                                className="absolute top-full mt-1 left-0 z-50 p-1.5 rounded-lg border border-border bg-[#1c1e24] shadow-xl flex flex-col gap-1 min-w-[80px]"
                                onMouseDown={(e) => e.stopPropagation()}
                            >
                                {LINE_WIDTHS.map((w) => (
                                    <button
                                        key={w}
                                        className={cn(
                                            'flex items-center gap-2 px-2 py-1 rounded text-[11px] font-mono hover:bg-white/10 transition-colors',
                                            value === w ? 'text-white' : 'text-muted-foreground',
                                        )}
                                        onClick={() => {
                                            handleUpdate({ [field.patchKey]: w } as any);
                                            closeField();
                                        }}
                                    >
                                        <div
                                            className="rounded-full bg-current"
                                            style={{ height: w, width: 28 }}
                                        />
                                        {w}px
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                );
            }

            case 'dash': {
                const value = get(field.patchKey) as number[] | undefined;
                const colorValue = get('color') ?? get('borderColor') ?? '#e0e0e0';
                if (value === undefined) return null;
                const key = `dash-${field.patchKey}`;
                return (
                    <div key={key} className="relative">
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <button
                                    className="flex items-center gap-1 px-1.5 py-1 rounded hover:bg-white/10 transition-colors"
                                    onClick={() => toggleField(key)}
                                >
                                    <DashIcon dash={value} color={colorValue} />
                                </button>
                            </TooltipTrigger>
                            <TooltipContent
                                side="bottom"
                                className="bg-background border border-border"
                            >
                                {field.label ?? 'Line style'}
                            </TooltipContent>
                        </Tooltip>
                        {openField === key && (
                            <div
                                className="absolute top-full mt-1 left-0 z-50 p-1.5 rounded-lg border border-border bg-[#1c1e24] shadow-xl flex flex-col gap-1 min-w-[120px]"
                                onMouseDown={(e) => e.stopPropagation()}
                            >
                                {DASH_PRESETS.map((preset) => (
                                    <button
                                        key={preset.label}
                                        className={cn(
                                            'flex items-center gap-2 px-2 py-1 rounded text-[11px] font-mono hover:bg-white/10 transition-colors',
                                            JSON.stringify(value) === JSON.stringify(preset.dash)
                                                ? 'text-white'
                                                : 'text-muted-foreground',
                                        )}
                                        onClick={() => {
                                            handleUpdate({ [field.patchKey]: preset.dash } as any);
                                            closeField();
                                        }}
                                    >
                                        {preset.label}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                );
            }

            case 'fibColor': {
                if (fibEnabledColors.length === 0) return null;
                const key = 'fibColor';
                return (
                    <div key={key} className="relative">
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <button
                                    className="flex items-center gap-1 px-1.5 py-1 rounded hover:bg-white/10 transition-colors"
                                    onClick={() => {
                                        toggleField(key);
                                    }}
                                >
                                    <span className="flex flex-col items-center gap-0.5">
                                        <PenIcon />
                                        {fibUniformColor ? (
                                            <ColorBar color={fibUniformColor} />
                                        ) : (
                                            <div
                                                className="h-[3px] w-[13px] rounded-full"
                                                style={{
                                                    background:
                                                        'linear-gradient(to right, #ef4444, #f97316, #eab308, #22c55e, #3b82f6, #a855f7)',
                                                }}
                                            />
                                        )}
                                    </span>
                                </button>
                            </TooltipTrigger>
                            <TooltipContent
                                side="bottom"
                                className="bg-background border border-border"
                            >
                                Levels color
                            </TooltipContent>
                        </Tooltip>
                        <ColorPicker
                            onChange={(v) => {
                                handleUpdate({
                                    levels: fibLevels.map((l) =>
                                        l.enabled ? { ...l, color: v } : l,
                                    ),
                                } as any);
                            }}
                            value={fibUniformColor}
                            open={openField === key}
                            onOpenChange={(o) => {
                                if (!o) {
                                    justClosedRef.current = true;
                                    closeField();
                                }
                            }}
                            hideButton
                        />
                    </div>
                );
            }

            case 'fibBgToggle': {
                const enabled = get(field.enableKey) ?? true;
                return (
                    <Tooltip key="fibBgToggle">
                        <TooltipTrigger asChild>
                            <button
                                className={cn(
                                    'flex items-center gap-1 px-1.5 py-1 rounded transition-colors',
                                    enabled
                                        ? 'text-blue-400 hover:bg-white/10'
                                        : 'text-muted-foreground/40 hover:bg-white/10 hover:text-muted-foreground',
                                )}
                                onClick={() => {
                                    handleUpdate({ [field.enableKey]: !enabled } as any);
                                }}
                            >
                                <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                                    <rect
                                        x="1.5"
                                        y="1.5"
                                        width="10"
                                        height="10"
                                        rx="1.5"
                                        stroke="currentColor"
                                        strokeWidth="1.3"
                                        fill={enabled ? 'currentColor' : 'none'}
                                        fillOpacity={enabled ? 0.25 : 0}
                                    />
                                </svg>
                            </button>
                        </TooltipTrigger>
                        <TooltipContent
                            side="bottom"
                            className="bg-background border border-border"
                        >
                            {enabled ? 'Hide background' : 'Show background'}
                        </TooltipContent>
                    </Tooltip>
                );
            }

            case 'fibBgColor': {
                const gateValue = get(field.gateKey) ?? true;
                if (!gateValue) return null;
                const value = (get(field.patchKey) ?? '#ffffff1a') as string;
                const key = `fibBgColor-${field.patchKey}`;
                return (
                    <div key={key} className="relative">
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <button
                                    className="flex items-center gap-1 px-1.5 py-1 rounded hover:bg-white/10 transition-colors"
                                    onClick={() => toggleField(key)}
                                >
                                    <span className="flex flex-col items-center gap-0.5">
                                        <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                                            <rect
                                                x="2"
                                                y="2"
                                                width="9"
                                                height="9"
                                                rx="1"
                                                fill="currentColor"
                                                fillOpacity="0.3"
                                                stroke="currentColor"
                                                strokeWidth="1.2"
                                            />
                                        </svg>
                                        <ColorBar color={value} />
                                    </span>
                                </button>
                            </TooltipTrigger>
                            <TooltipContent
                                side="bottom"
                                className="bg-background border border-border"
                            >
                                {field.label ?? 'Background color'}
                            </TooltipContent>
                        </Tooltip>
                        <ColorPicker
                            onChange={(v) => handleUpdate({ [field.patchKey]: v } as any)}
                            value={value}
                            open={openField === key}
                            onOpenChange={(o) => {
                                if (!o) {
                                    justClosedRef.current = true;
                                    closeField();
                                }
                            }}
                            hideButton
                        />
                    </div>
                );
            }

            case 'fvpMode': {
                const mode: string = get('profileMode') ?? 'stacked';
                const modes = [
                    { value: 'stacked', label: 'Stacked' },
                    { value: 'split', label: 'Split' },
                    { value: 'delta', label: 'Delta' },
                    { value: 'total', label: 'Total' },
                ];
                return (
                    <div key="fvpMode" className="flex gap-0.5">
                        {modes.map((m) => (
                            <button
                                key={m.value}
                                className={cn(
                                    'px-2.5 h-7 rounded text-[11px] font-medium transition-colors',
                                    mode === m.value
                                        ? 'bg-blue-500/25 text-blue-300 border border-blue-500/40'
                                        : 'text-white/40 hover:text-white/70 hover:bg-white/8 border border-transparent',
                                )}
                                onClick={() => {
                                    handleUpdate({ profileMode: m.value as any });
                                }}
                            >
                                {m.label}
                            </button>
                        ))}
                    </div>
                );
            }

            case 'button': {
                if (!onRequestOrderTicket) return null;
                const Icon = field.icon;
                return (
                    <Tooltip key="button">
                        <TooltipTrigger asChild>
                            <button
                                className="p-1 rounded hover:bg-white/10 text-muted-foreground hover:text-white transition-colors"
                                onClick={() =>
                                    field.onClick(drawing, {
                                        requestOrderTicket: onRequestOrderTicket,
                                    })
                                }
                            >
                                <Icon size={13} />
                            </button>
                        </TooltipTrigger>
                        <TooltipContent
                            side="bottom"
                            className="bg-background border border-border"
                        >
                            {field.label}
                        </TooltipContent>
                    </Tooltip>
                );
            }

            default:
                return null;
        }
    };

    return (
        <>
            <style>{`
                @keyframes dsb-in {
                    from { opacity: 0; transform: scale(0.92); }
                    to   { opacity: 1; transform: scale(1); }
                }
                .dsb-enter {
                    animation: dsb-in 140ms cubic-bezier(0.16, 1, 0.3, 1) both;
                    transform-origin: top left;
                }
            `}</style>

            {isDragging && (
                <div
                    style={{
                        position: 'fixed',
                        inset: 0,
                        zIndex: 9999,
                        cursor: 'grabbing',
                    }}
                />
            )}

            <div
                ref={barRef}
                className="dsb-enter fixed z-[150] flex items-center gap-0.5 h-9 rounded-lg border border-border bg-[#1c1e24] shadow-xl w-fit"
                style={{
                    left: posRef.current!.x,
                    top: posRef.current!.y,
                    userSelect: isDragging ? 'none' : undefined,
                }}
                onMouseDown={(e) => e.stopPropagation()}
                onMouseEnter={isDragging ? undefined : onMouseEnter}
                onMouseLeave={isDragging ? undefined : onMouseLeave}
            >
                <div
                    className="flex items-center justify-center h-full px-1 cursor-grab active:cursor-grabbing text-muted-foreground/40 hover:text-muted-foreground transition-colors shrink-0 rounded-l-lg"
                    onMouseDown={onGrabMouseDown}
                    title="Drag to move"
                >
                    <GripVertical size={13} />
                </div>

                {fields.map((field, idx) => renderField(field, idx))}

                <div className="flex-1 w-4" />

                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            className="p-1 rounded hover:bg-white/10 text-muted-foreground hover:text-foreground transition-colors"
                            onClick={() => setShowDialog(true)}
                        >
                            <Settings size={13} />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="bg-background border border-border">
                        Settings
                    </TooltipContent>
                </Tooltip>

                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            className={cn(
                                'p-1 rounded hover:bg-white/10 transition-colors',
                                locked ? 'text-yellow-400' : 'text-muted-foreground',
                            )}
                            onClick={() => handleUpdate({ locked: !locked } as any)}
                        >
                            {locked ? <Lock size={13} /> : <Unlock size={13} />}
                        </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="bg-background border border-border">
                        {locked ? 'Unlock' : 'Lock'}
                    </TooltipContent>
                </Tooltip>

                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            className="p-1 rounded hover:bg-white/10 text-muted-foreground hover:text-red-400 transition-colors"
                            onClick={onDelete}
                        >
                            <Trash2 size={13} />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="bg-background border border-border">
                        Delete
                    </TooltipContent>
                </Tooltip>

                <DropdownMenu>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <DropdownMenuTrigger asChild>
                                <button className="p-1 mr-1 rounded hover:bg-white/10 text-muted-foreground transition-colors">
                                    <MoreHorizontal size={13} />
                                </button>
                            </DropdownMenuTrigger>
                        </TooltipTrigger>
                        <TooltipContent
                            side="bottom"
                            className="bg-background border border-border"
                        >
                            More
                        </TooltipContent>
                    </Tooltip>
                    <DropdownMenuContent align="end" className="bg-[#1c1e24] border-border">
                        <DropdownMenuItem
                            onClick={onDuplicate}
                            className="gap-2 cursor-pointer text-xs"
                        >
                            <Copy size={12} /> Duplicate
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            onClick={onDelete}
                            className="gap-2 cursor-pointer text-red-400 focus:text-red-400 text-xs"
                        >
                            <Trash2 size={12} /> Delete
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>

            {showDialog && (
                <DrawingSettingsDialog
                    drawing={localDrawing}
                    onUpdate={handleUpdate}
                    onClose={() => setShowDialog(false)}
                    onMouseEnter={onMouseEnter}
                    onMouseLeave={onMouseLeave}
                />
            )}
        </>
    );
}


function Sep() {
    return <div className="w-px h-4 bg-border mx-0.5 shrink-0" />;
}

function ColorBar({ color }: { color: string }) {
    return <div className="h-[3px] w-[13px] rounded-full" style={{ background: color }} />;
}

function DashIcon({ dash, color }: { dash: number[]; color: string }) {
    return (
        <svg width="24" height="10" viewBox="0 0 24 10">
            <line
                x1="0"
                y1="5"
                x2="24"
                y2="5"
                stroke={color}
                strokeWidth="1.5"
                strokeDasharray={dash.join(' ') || 'none'}
            />
        </svg>
    );
}

function PenIcon() {
    return (
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <path
                d="M9.5 1.5L11.5 3.5L4.5 10.5L2 11L2.5 8.5L9.5 1.5Z"
                stroke="#ccc"
                strokeWidth="1.2"
                fill="none"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function RectOutlineIcon() {
    return (
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <rect
                x="2"
                y="2"
                width="9"
                height="9"
                stroke="#ccc"
                strokeWidth="1.4"
                fill="none"
                rx="1"
            />
        </svg>
    );
}

function RectFilledIcon() {
    return (
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <rect x="2" y="2" width="9" height="9" fill="#ccc" rx="1" />
        </svg>
    );
}
