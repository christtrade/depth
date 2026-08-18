'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/utils';
import {
    RotateCcw,
    AlignVerticalSpaceAround,
    AlignHorizontalSpaceAround,
    Copy,
    Camera,
    Trash2,
    Layers,
    Settings,
    ChevronUp,
    ChevronDown,
    ChevronsUp,
    ChevronsDown,
} from 'lucide-react';
import type { Indicator } from '../../lib/types/indicator-types';
import { ChartSettings } from '../../lib/types/chart-settings';
import { Drawing } from '../../lib/types/drawing-types';
import { PlaceOrderRequest } from '../../lib/matchingEngine';
import { DataLevel } from '../../core';

interface ChartContextMenuProps {
    x: number;
    y: number;
    target: 'chart' | 'xaxis';
    priceAtClick: number | null;
    currentAsk: number | null;
    currentBid: number | null;
    indicators: Indicator[];
    drawings: Drawing[];
    chartSettings: ChartSettings;
    dataLevel: DataLevel;
    tickSize: number;
    onClose: () => void;
    onResetView: () => void;
    onFitYAxis: () => void;
    onResetXAxis: () => void;
    onRemoveIndicators: () => void;
    onRemoveDrawings: () => void;
    onScreenshot: () => void;
    onToggleHeatmap: () => void;
    onOpenSettings: () => void;
    onCreateOrder: (opts: PlaceOrderRequest) => void;
}

function MenuLabel({ children }: { children: React.ReactNode }) {
    return (
        <div className="px-3 pt-2 pb-0.5 text-[9px] text-white/30 uppercase tracking-widest select-none first:pt-2">
            {children}
        </div>
    );
}

function MenuSep() {
    return <div className=" mx-2 h-px bg-white/6" />;
}

function MenuItem({
    icon,
    children,
    shortcut,
    onClick,
    destructive = false,
}: {
    icon?: React.ReactNode;
    children: React.ReactNode;
    shortcut?: string;
    onClick: () => void;
    destructive?: boolean;
}) {
    return (
        <button
            onClick={onClick}
            className={cn(
                'w-full flex items-center gap-2 px-2.5 py-[5px] rounded-md text-[11px] text-left transition-colors duration-100 hover:duration-0 select-none',
                destructive
                    ? 'text-red-400/70 hover:text-red-300 hover:bg-red-500/[0.10]'
                    : 'text-white/55 hover:text-white hover:bg-muted/50',
            )}
        >
            {icon && (
                <span className={cn('shrink-0', destructive ? 'text-red-400/50' : 'text-white/30')}>
                    {icon}
                </span>
            )}
            <span className="flex-1">{children}</span>
            {shortcut && <span className="text-[10px] text-white/25 ml-auto pl-3">{shortcut}</span>}
        </button>
    );
}

function getOrderOptions(price: number, bid: number, ask: number, tick: number) {
    const options = [];

    const inSpread = price >= bid && price <= ask;
    const aboveAsk = price > ask;
    const belowBid = price < bid;

    // inside spread
    if (inSpread) {
        options.push({
            side: 'long' as const,
            type: 'market' as const,
            label: 'Buy 1.00 Market',
            icon: <ChevronUp size={15} />,
        });
        options.push({
            side: 'short' as const,
            type: 'market' as const,
            label: 'Sell 1.00 Market',
            icon: <ChevronDown size={15} />,
        });
    }

    // Above ask
    if (aboveAsk) {
        // fade short
        options.push({
            side: 'short' as const,
            type: 'limit' as const,
            limitPrice: price,
            label: `Sell 1.00 @${price} Limit`,
            icon: <ChevronDown size={15} />,
        });

        // breakout long
        options.push({
            side: 'long' as const,
            type: 'stop' as const,
            stopPrice: price,
            label: `Buy 1.00 @${price} Stop`,
            icon: <ChevronUp size={15} />,
        });

        options.push({
            side: 'long' as const,
            type: 'stop_limit' as const,
            stopPrice: price,
            limitPrice: Math.round((price + tick) * 1e8)/1e8,
            label: `Buy 1.00 Stop ${price} → Limit ${Math.round((price + tick) * 1e8)/1e8}`,
            icon: <ChevronsUp size={15} />,
        });
    }

    // Below bid
    if (belowBid) {
        // pullback long
        options.push({
            side: 'long' as const,
            type: 'limit' as const,
            limitPrice: price,
            label: `Buy 1.00 @${price} Limit`,
            icon: <ChevronUp size={15} />,
        });

        // breakdown short
        options.push({
            side: 'short' as const,
            type: 'stop' as const,
            stopPrice: price,
            label: `Sell 1.00 @${price} Stop`,
            icon: <ChevronDown size={15} />,
        });

        options.push({
            side: 'short' as const,
            type: 'stop_limit' as const,
            stopPrice: price,
            limitPrice: price - tick,
            label: `Sell 1.00 Stop ${price} → Limit ${Math.round((price - tick) * 1e8) / 1e8}`,
            icon: <ChevronsDown size={15} />,
        });
    }

    return options;
}

export function ChartContextMenu({
    x,
    y,
    target,
    priceAtClick,
    currentAsk,
    currentBid,
    indicators,
    drawings,
    chartSettings,
    dataLevel,
    tickSize,
    onClose,
    onResetView,
    onFitYAxis,
    onResetXAxis,
    onRemoveIndicators,
    onRemoveDrawings,
    onScreenshot,
    onToggleHeatmap,
    onOpenSettings,
    onCreateOrder,
}: ChartContextMenuProps) {
    const menuRef = useRef<HTMLDivElement>(null);

    const [screenWidth, setScreenWidth] = useState(1920);
    const [screenHeight, setScreenHeight] = useState(1080);

    useEffect(() => {
        const onMouseDown = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('mousedown', onMouseDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onMouseDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [onClose]);

    useEffect(() => {
        if (window) {
            setScreenWidth(window.innerWidth);
            setScreenHeight(window.innerHeight);
        }
    }, []);

    const orders = getOrderOptions(Math.round(priceAtClick*1e8)/1e8, Math.round(currentBid*1e8)/1e8, Math.round(currentAsk*1e8)/1e8, tickSize);

    const width = menuRef.current?.clientWidth ?? 260;
    const height = menuRef.current?.clientHeight ?? 500;

    return (
        <div
            ref={menuRef}
            className="fixed z-[9999] min-w-[192px] rounded-xl border border-white/10 bg-[#14161b] shadow-2xl overflow-hidden"
            style={{
                left: Math.max(8, x + width > screenWidth ? screenWidth - width : x),
                top: Math.max(8, y + height > screenHeight ? screenHeight - height : y),
            }}
            onContextMenu={(e) => e.preventDefault()}
        >
            <div className="p-1.5">
                {target === 'chart' ? (
                    <>
                        <MenuLabel>View</MenuLabel>

                        <MenuItem
                            icon={<RotateCcw size={12} />}
                            shortcut="⌘0"
                            onClick={() => {
                                onResetView();
                                onClose();
                            }}
                        >
                            Reset view
                        </MenuItem>

                        <MenuItem
                            icon={<AlignVerticalSpaceAround size={12} />}
                            onClick={() => {
                                onFitYAxis();
                                onClose();
                            }}
                        >
                            Fit Y axis
                        </MenuItem>

                        <MenuSep />
                        <MenuLabel>Trade</MenuLabel>
                        {orders.map((o, i) => (
                            <MenuItem
                                key={i}
                                onClick={() => {
                                    onCreateOrder({ qty: 1, ...o });
                                    onClose();
                                }}
                            >
                                <div className="flex flex-row items-center gap-1">
                                    {o?.icon && o.icon}
                                    {o.label}
                                </div>
                            </MenuItem>
                        ))}

                        {priceAtClick !== null && (
                            <>
                                <MenuSep />
                                <MenuLabel>Price</MenuLabel>
                                <MenuItem
                                    icon={<Copy size={12} />}
                                    onClick={() => {
                                        navigator.clipboard.writeText(priceAtClick.toFixed(2));
                                        onClose();
                                    }}
                                >
                                    Copy{' '}
                                    <span className="text-slate-200 tabular-nums ml-1">
                                        {priceAtClick.toFixed(2)}
                                    </span>
                                </MenuItem>
                            </>
                        )}

                        {indicators.length > 0 && (
                            <>
                                <MenuSep />
                                <MenuLabel>Indicators</MenuLabel>
                                <MenuItem
                                    icon={<Trash2 size={12} />}
                                    destructive
                                    onClick={() => {
                                        onRemoveIndicators();
                                        onClose();
                                    }}
                                >
                                    Remove {indicators.length}{' '}
                                    {indicators.length === 1 ? 'indicator' : 'indicators'}
                                </MenuItem>
                            </>
                        )}
                        {drawings.length > 0 && (
                            <>
                                <MenuSep />
                                <MenuLabel>Drawings</MenuLabel>
                                <MenuItem
                                    icon={<Trash2 size={12} />}
                                    destructive
                                    onClick={() => {
                                        onRemoveDrawings();
                                        onClose();
                                    }}
                                >
                                    Remove {drawings.length}{' '}
                                    {drawings.length === 1 ? 'drawing' : 'drawings'}
                                </MenuItem>
                            </>
                        )}

                        <MenuSep />

                        <MenuItem
                            icon={<Camera size={12} />}
                            onClick={() => {
                                onScreenshot();
                                onClose();
                            }}
                        >
                            Screenshot
                        </MenuItem>
                        {dataLevel === 'l3' && (
                            <MenuItem
                                icon={<Layers size={12} />}
                                onClick={() => {
                                    onToggleHeatmap();
                                    onClose();
                                }}
                            >
                                {chartSettings.showHeatmap ? 'Hide ' : 'Show '}Heatmap
                            </MenuItem>
                        )}
                        <MenuItem
                            icon={<Settings size={12} />}
                            onClick={() => {
                                onOpenSettings();
                                onClose();
                            }}
                        >
                            Settings
                        </MenuItem>
                    </>
                ) : (
                    <>
                        <MenuLabel>Time axis</MenuLabel>

                        <MenuItem
                            icon={<AlignHorizontalSpaceAround size={12} />}
                            onClick={() => {
                                onResetXAxis();
                                onClose();
                            }}
                        >
                            Reset time axis
                        </MenuItem>

                        <MenuItem
                            icon={<RotateCcw size={12} />}
                            onClick={() => {
                                onResetView();
                                onClose();
                            }}
                        >
                            Reset view
                        </MenuItem>
                    </>
                )}
            </div>
        </div>
    );
}
